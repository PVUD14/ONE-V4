import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createLearnerContentDraft, listPublishedLearnerContent } from '../src/learner-content.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learner content integration tests');

const pool = new Pool({ connectionString });
const authorUserId = '32000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  await pool.query('TRUNCATE learner_content_items, users CASCADE');
  await pool.query(
    `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
    [authorUserId, 'learner-content-test:author', 'learner-content-author@example.test'],
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
});
