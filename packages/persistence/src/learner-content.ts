import type { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  LEARNER_CONTENT_REVIEW_QUEUE_STATES,
  LEARNER_CONTENT_TYPES,
  assertLearnerContentDraft,
  assertLearnerContentReviewTransition,
  type LearnerContentDraftInput,
  type LearnerContentReviewQueueState,
  type LearnerContentReviewState,
  type LearnerContentSource,
  type LearnerContentType,
} from '@planthepath/learner-content';

type DbClient = Pick<PoolClient, 'query'>;

export interface LearnerContentRecord {
  readonly id: string;
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly source: LearnerContentSource;
  readonly generatorVersion: string | null;
  readonly promptVersion: string | null;
  readonly reviewState: LearnerContentReviewState;
  readonly generatedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly createdByUserId: string;
  readonly sortOrder: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LearnerContentReviewRecord {
  readonly id: string;
  readonly contentId: string;
  readonly reviewerUserId: string;
  readonly fromState: LearnerContentReviewState;
  readonly toState: LearnerContentReviewState;
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface LearnerContentReviewTransitionInput {
  readonly reviewId: string;
  readonly contentId: string;
  readonly actorUserId: string;
  readonly toState: LearnerContentReviewState;
  readonly note?: string | null;
}

interface LearnerContentRow {
  id: string;
  content_type: LearnerContentType;
  title: string;
  summary: string | null;
  content: Record<string, unknown>;
  source: LearnerContentSource;
  generator_version: string | null;
  prompt_version: string | null;
  review_state: LearnerContentReviewState;
  generated_at: Date | null;
  published_at: Date | null;
  created_by_user_id: string;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const learnerContentColumns = `
  id, content_type, title, summary, content, source, generator_version,
  prompt_version, review_state, generated_at, published_at,
  created_by_user_id, sort_order, metadata, created_at, updated_at
`;

/**
 * Creates only a draft. Review and publication are intentionally separate
 * privileged operations that D4 will add with audit records.
 */
export async function createLearnerContentDraft(
  pool: Pool,
  input: LearnerContentDraftInput,
): Promise<LearnerContentRecord> {
  assertLearnerContentDraft(input);
  const result = await pool.query<LearnerContentRow>(
    `INSERT INTO learner_content_items
       (id, content_type, title, summary, content, source, generator_version,
        prompt_version, review_state, generated_at, created_by_user_id, sort_order, metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'DRAFT',$9,$10,$11,$12::jsonb)
     RETURNING ${learnerContentColumns}`,
    [
      input.id,
      input.contentType,
      input.title.trim(),
      input.summary?.trim() ?? null,
      JSON.stringify(input.content),
      input.source,
      input.generatorVersion ?? null,
      input.promptVersion ?? null,
      input.generatedAt ?? null,
      input.createdByUserId,
      input.sortOrder ?? 0,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return mapLearnerContentRow(requireRow(result.rows[0]));
}

/** Public/learner reads fail closed to PUBLISHED rows only. */
export async function listPublishedLearnerContent(
  pool: Pool,
  input: { readonly contentType?: LearnerContentType; readonly limit?: number } = {},
): Promise<readonly LearnerContentRecord[]> {
  if (input.contentType && !LEARNER_CONTENT_TYPES.includes(input.contentType)) {
    throw new RangeError('contentType is not supported');
  }
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('limit must be an integer from 1 to 500');
  }
  const result = await pool.query<LearnerContentRow>(
    `SELECT ${learnerContentColumns}
     FROM learner_content_items
     WHERE review_state='PUBLISHED' AND ($1::text IS NULL OR content_type=$1)
     ORDER BY sort_order, published_at DESC, id
     LIMIT $2`,
    [input.contentType ?? null, limit],
  );
  return result.rows.map(mapLearnerContentRow);
}

/** Internal review queue; terminal rows never enter this result. */
export async function listLearnerContentReviewQueue(
  pool: Pool,
  input: {
    readonly states?: readonly LearnerContentReviewQueueState[];
    readonly contentType?: LearnerContentType;
    readonly source?: LearnerContentSource;
    readonly limit?: number;
  } = {},
): Promise<readonly LearnerContentRecord[]> {
  const states = input.states ?? LEARNER_CONTENT_REVIEW_QUEUE_STATES;
  if (states.length < 1 || states.some((state) => !LEARNER_CONTENT_REVIEW_QUEUE_STATES.includes(state))) {
    throw new RangeError('review queue states must contain supported nonterminal states');
  }
  if (input.contentType && !LEARNER_CONTENT_TYPES.includes(input.contentType)) throw new RangeError('contentType is not supported');
  if (input.source && !['SEEDED', 'AUTHORED'].includes(input.source)) throw new RangeError('source is not supported');
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be an integer from 1 to 500');
  const result = await pool.query<LearnerContentRow>(
    `SELECT ${learnerContentColumns}
     FROM learner_content_items
     WHERE review_state = ANY($1::text[])
       AND ($2::text IS NULL OR content_type=$2)
       AND ($3::text IS NULL OR source=$3)
     ORDER BY created_at, id
     LIMIT $4`,
    [states, input.contentType ?? null, input.source ?? null, limit],
  );
  return result.rows.map(mapLearnerContentRow);
}

/**
 * Applies one human review action atomically and records who performed it.
 * Approval requires a reviewer other than the author; publication additionally
 * requires a publisher other than the approving reviewer.
 */
export async function transitionLearnerContentReview(
  pool: Pool,
  input: LearnerContentReviewTransitionInput,
): Promise<{ readonly content: LearnerContentRecord; readonly review: LearnerContentReviewRecord }> {
  requireUuid(input.reviewId, 'reviewId');
  requireUuid(input.contentId, 'contentId');
  requireUuid(input.actorUserId, 'actorUserId');
  const note = input.note?.trim() || null;
  if (note && note.length > 2000) throw new RangeError('review note must contain at most 2000 characters');

  return transaction(pool, async (client) => {
    const actor = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id=$1 AND state='ACTIVE'`,
      [input.actorUserId],
    );
    if (!actor.rows[0]) throw new LearnerContentReviewError('REVIEW_ACTOR_INACTIVE');

    const currentResult = await client.query<LearnerContentRow>(
      `SELECT ${learnerContentColumns}
       FROM learner_content_items WHERE id=$1 FOR UPDATE`,
      [input.contentId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new LearnerContentReviewError('CONTENT_NOT_FOUND');
    assertLearnerContentReviewTransition(current.review_state, input.toState);

    if (requiresIndependentReviewer(input.toState) && input.actorUserId === current.created_by_user_id) {
      throw new LearnerContentReviewError('AUTHOR_CANNOT_REVIEW');
    }
    if (input.toState === 'PUBLISHED') {
      const approval = await client.query<{ reviewer_user_id: string }>(
        `SELECT reviewer_user_id FROM learner_content_reviews
         WHERE content_id=$1 AND to_state='APPROVED'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [input.contentId],
      );
      if (!approval.rows[0]) throw new LearnerContentReviewError('APPROVAL_REQUIRED');
      if (approval.rows[0].reviewer_user_id === input.actorUserId) {
        throw new LearnerContentReviewError('APPROVER_CANNOT_PUBLISH');
      }
    }

    const updated = await client.query<LearnerContentRow>(
      `UPDATE learner_content_items
       SET review_state=$2,
           published_at=CASE WHEN $2='PUBLISHED' THEN now() ELSE NULL END,
           updated_at=now()
       WHERE id=$1 AND review_state=$3
       RETURNING ${learnerContentColumns}`,
      [input.contentId, input.toState, current.review_state],
    );
    const content = updated.rows[0];
    if (!content) throw new LearnerContentReviewError('REVIEW_STATE_CHANGED');
    const reviewResult = await client.query<{
      id: string; content_id: string; reviewer_user_id: string; from_state: LearnerContentReviewState;
      to_state: LearnerContentReviewState; note: string | null; created_at: Date;
    }>(
      `INSERT INTO learner_content_reviews
         (id, content_id, reviewer_user_id, from_state, to_state, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, content_id, reviewer_user_id, from_state, to_state, note, created_at`,
      [input.reviewId, input.contentId, input.actorUserId, current.review_state, input.toState, note],
    );
    const review = reviewResult.rows[0];
    if (!review) throw new Error('learner content review insert did not return a row');
    return {
      content: mapLearnerContentRow(content),
      review: {
        id: review.id,
        contentId: review.content_id,
        reviewerUserId: review.reviewer_user_id,
        fromState: review.from_state,
        toState: review.to_state,
        note: review.note,
        createdAt: toDate(review.created_at),
      },
    };
  });
}

export class LearnerContentReviewError extends Error {
  constructor(readonly code: 'CONTENT_NOT_FOUND' | 'REVIEW_ACTOR_INACTIVE' | 'AUTHOR_CANNOT_REVIEW' | 'APPROVAL_REQUIRED' | 'APPROVER_CANNOT_PUBLISH' | 'REVIEW_STATE_CHANGED') {
    super(code);
    this.name = 'LearnerContentReviewError';
  }
}

function requireRow(row: LearnerContentRow | undefined): LearnerContentRow {
  if (!row) throw new Error('learner content insert did not return a row');
  return row;
}

function mapLearnerContentRow(row: LearnerContentRow): LearnerContentRecord {
  return {
    id: row.id,
    contentType: row.content_type,
    title: row.title,
    summary: row.summary,
    content: row.content,
    source: row.source,
    generatorVersion: row.generator_version,
    promptVersion: row.prompt_version,
    reviewState: row.review_state,
    generatedAt: toNullableDate(row.generated_at),
    publishedAt: toNullableDate(row.published_at),
    createdByUserId: row.created_by_user_id,
    sortOrder: Number(row.sort_order),
    metadata: row.metadata,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toNullableDate(value: Date | string | null): Date | null {
  return value == null ? null : toDate(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requiresIndependentReviewer(toState: LearnerContentReviewState): boolean {
  return ['CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED'].includes(toState);
}

function requireUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RangeError(`${field} must be a UUID`);
  }
}

async function transaction<T>(pool: Pool, work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
