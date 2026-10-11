import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  LearnerContentReviewError,
  createLearnerContentDraft,
  listLearnerContentReviewQueue,
  listPublishedLearnerContent,
  transitionLearnerContentReview,
} from '../src/learner-content.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learner content integration tests');

const pool = new Pool({ connectionString });
const authorUserId = '32000000-0000-4000-8000-000000000001';
const reviewerUserId = '32000000-0000-4000-8000-000000000002';
const publisherUserId = '32000000-0000-4000-8000-000000000003';
const inactiveUserId = '32000000-0000-4000-8000-000000000004';

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  await pool.query('TRUNCATE learner_content_items, users CASCADE');
  await pool.query(
    `INSERT INTO users (id, external_subject, email, state) VALUES
       ($1,'learner-content-test:author','learner-content-author@example.test','ACTIVE'),
       ($2,'learner-content-test:reviewer','learner-content-reviewer@example.test','ACTIVE'),
       ($3,'learner-content-test:publisher','learner-content-publisher@example.test','ACTIVE'),
       ($4,'learner-content-test:inactive','learner-content-inactive@example.test','SUSPENDED')`,
    [authorUserId, reviewerUserId, publisherUserId, inactiveUserId],
  );
});

afterAll(async () => pool.end());

describe('learner content migration and persistence', () => {
  it('applies migration 0024 and persists all required seeded provenance as an honest draft', async () => {
    const record = await createLearnerContentDraft(pool, {
      id: randomUUID(),
      contentType: 'COMPANY_PREP',
      title: '  Researching a company  ',
      summary: '  A preparation checklist.  ',
      content: { checklist: ['Read the role description', 'Verify the company source'] },
      source: 'SEEDED',
      generatorVersion: null,
      promptVersion: null,
      generatedAt: null,
      createdByUserId: authorUserId,
      sortOrder: 20,
      metadata: { locale: 'en-IN' },
    });

    expect(record).toMatchObject({
      contentType: 'COMPANY_PREP',
      title: 'Researching a company',
      summary: 'A preparation checklist.',
      source: 'SEEDED',
      reviewState: 'DRAFT',
      generatorVersion: null,
      promptVersion: null,
      generatedAt: null,
      publishedAt: null,
      sortOrder: 20,
      metadata: { locale: 'en-IN' },
    });
  });

  it('persists authored content without pretending it was generated', async () => {
    const record = await createLearnerContentDraft(pool, {
      id: randomUUID(),
      contentType: 'RESUME_BUILDER',
      title: 'Evidence-first resume outline',
      content: { sections: ['Summary', 'Verified projects', 'Skills'] },
      source: 'AUTHORED',
      createdByUserId: authorUserId,
    });

    expect(record).toMatchObject({
      source: 'AUTHORED',
      reviewState: 'DRAFT',
      generatorVersion: null,
      promptVersion: null,
      generatedAt: null,
    });
  });

  it('rejects invalid source and review-state values at the database boundary', async () => {
    const values = [randomUUID(), authorUserId, JSON.stringify({ body: 'invalid' })];
    await expect(pool.query(
      `INSERT INTO learner_content_items
         (id,content_type,title,content,source,review_state,created_by_user_id)
       VALUES ($1,'CAREER_TOOL','Invalid source',$3::jsonb,'GENERATED','DRAFT',$2)`,
      values,
    )).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO learner_content_items
         (id,content_type,title,content,source,review_state,created_by_user_id)
       VALUES ($1,'CAREER_TOOL','Invalid state',$3::jsonb,'AUTHORED','LIVE',$2)`,
      [randomUUID(), authorUserId, JSON.stringify({ body: 'invalid' })],
    )).rejects.toThrow();
  });

  it('returns only published rows to learner-facing reads', async () => {
    await createLearnerContentDraft(pool, {
      id: randomUUID(),
      contentType: 'SCHOLARSHIP',
      title: 'Unreviewed scholarship draft',
      content: { provider: 'Local test provider' },
      source: 'SEEDED',
      createdByUserId: authorUserId,
    });
    const publishedId = randomUUID();
    await pool.query(
      `INSERT INTO learner_content_items
         (id,content_type,title,content,source,review_state,published_at,created_by_user_id,sort_order)
       VALUES ($1,'SCHOLARSHIP','Published scholarship guide',$2::jsonb,'AUTHORED','PUBLISHED',now(),$3,1)`,
      [publishedId, JSON.stringify({ guidance: ['Check eligibility', 'Confirm the official deadline'] }), authorUserId],
    );

    const visible = await listPublishedLearnerContent(pool, { contentType: 'SCHOLARSHIP' });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: publishedId, reviewState: 'PUBLISHED' });
  });

  it.each(['SEEDED', 'AUTHORED'] as const)('reviews and publishes %s content through separate human actors', async (source) => {
    const contentId = randomUUID();
    await createLearnerContentDraft(pool, {
      id: contentId,
      contentType: 'CAREER_TOOL',
      title: `${source} interview preparation`,
      content: { checklist: ['Select verified evidence', 'Check the role requirements'] },
      source,
      createdByUserId: authorUserId,
    });

    expect(await listPublishedLearnerContent(pool, { contentType: 'CAREER_TOOL' })).toHaveLength(0);
    expect(await listLearnerContentReviewQueue(pool, { source })).toHaveLength(1);

    await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: authorUserId, toState: 'IN_REVIEW', note: 'Ready for review',
    });
    await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: reviewerUserId, toState: 'APPROVED', note: 'Sources checked',
    });
    const published = await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: publisherUserId, toState: 'PUBLISHED', note: 'Approved for learners',
    });

    expect(published.content).toMatchObject({ id: contentId, source, reviewState: 'PUBLISHED' });
    expect(published.content.publishedAt).toBeInstanceOf(Date);
    expect(await listLearnerContentReviewQueue(pool)).toHaveLength(0);
    expect(await listPublishedLearnerContent(pool, { contentType: 'CAREER_TOOL' })).toHaveLength(1);
    const reviews = await pool.query(
      `SELECT reviewer_user_id, from_state, to_state, note
       FROM learner_content_reviews WHERE content_id=$1 ORDER BY created_at, id`,
      [contentId],
    );
    expect(reviews.rows).toHaveLength(3);
    expect(reviews.rows.map((review) => review.to_state)).toEqual(['IN_REVIEW', 'APPROVED', 'PUBLISHED']);
  });

  it('enforces active actors, valid transitions, and author-reviewer-publisher separation', async () => {
    const contentId = randomUUID();
    await createLearnerContentDraft(pool, {
      id: contentId,
      contentType: 'SCHOLARSHIP',
      title: 'Governed scholarship checklist',
      content: { checklist: ['Verify the official provider'] },
      source: 'SEEDED',
      createdByUserId: authorUserId,
    });

    await expect(transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: inactiveUserId, toState: 'IN_REVIEW',
    })).rejects.toMatchObject({ code: 'REVIEW_ACTOR_INACTIVE' });
    await expect(transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: publisherUserId, toState: 'PUBLISHED',
    })).rejects.toThrow(/cannot move/);
    await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: authorUserId, toState: 'IN_REVIEW',
    });
    await expect(transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: authorUserId, toState: 'APPROVED',
    })).rejects.toBeInstanceOf(LearnerContentReviewError);
    await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: reviewerUserId, toState: 'APPROVED',
    });
    await expect(transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: reviewerUserId, toState: 'PUBLISHED',
    })).rejects.toMatchObject({ code: 'APPROVER_CANNOT_PUBLISH' });

    const current = await pool.query('SELECT review_state, published_at FROM learner_content_items WHERE id=$1', [contentId]);
    expect(current.rows[0]).toMatchObject({ review_state: 'APPROVED', published_at: null });
  });

  it('records requested changes and returns the item to the queue without publishing it', async () => {
    const contentId = randomUUID();
    await createLearnerContentDraft(pool, {
      id: contentId,
      contentType: 'RESUME_BUILDER',
      title: 'Resume evidence checklist',
      content: { sections: ['Verified projects'] },
      source: 'AUTHORED',
      createdByUserId: authorUserId,
    });
    await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: authorUserId, toState: 'IN_REVIEW',
    });
    const changed = await transitionLearnerContentReview(pool, {
      reviewId: randomUUID(), contentId, actorUserId: reviewerUserId, toState: 'CHANGES_REQUESTED', note: 'Clarify verification guidance',
    });

    expect(changed.content).toMatchObject({ reviewState: 'CHANGES_REQUESTED', publishedAt: null });
    expect(changed.review.note).toBe('Clarify verification guidance');
    expect(await listLearnerContentReviewQueue(pool, { states: ['CHANGES_REQUESTED'] })).toHaveLength(1);
    expect(await listPublishedLearnerContent(pool)).toHaveLength(0);
  });
});
