import type { Pool } from 'pg';
import {
  LEARNER_CONTENT_TYPES,
  assertLearnerContentDraft,
  type LearnerContentDraftInput,
  type LearnerContentReviewState,
  type LearnerContentSource,
  type LearnerContentType,
} from '@planthepath/learner-content';

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
