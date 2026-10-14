/**
 * The step every content archive shares (skills, questions, lessons): record an ARCHIVE review
 * action for each PUBLISHED revision of an item, then move it to ARCHIVED.
 *
 * Why this exists: the 0004 lifecycle ends PUBLISHED → ARCHIVED, and 0090 lets a published
 * revision take exactly that change, nothing else, and only once its ARCHIVE action is recorded.
 * Every PUBLISHED revision is archived, not only the newest, so that no older one becomes "the
 * latest published". The editors (skill-map.ts, question-bank.ts, lesson-editor.ts) call this
 * inside their own locked transaction, then withdraw the item from what students are served.
 *
 * Design: docs/architecture/content-archive-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface ArchivedRevision {
  readonly id: string;
  readonly revision: number;
}

export async function archivePublishedRevisions(tx: SqlRunner, input: {
  readonly entityType: 'TOPIC' | 'QUESTION' | 'LESSON';
  readonly entityId: string;
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<readonly ArchivedRevision[]> {
  const published = ((await tx.execute(sql`
    SELECT id, revision FROM content_revisions
    WHERE entity_type = ${input.entityType} AND entity_id = ${input.entityId}::uuid AND state = 'PUBLISHED'
    ORDER BY revision
    FOR UPDATE
  `)) as { rows: { id: string; revision: number }[] }).rows;
  for (const revision of published) {
    // The action first: 0090's guard archives a published revision only once it is recorded.
    await tx.execute(sql`
      INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${input.actorUserId}::uuid, 'ARCHIVE', 'PUBLISHED', 'ARCHIVED', ${input.reasonCode}, ${input.correlationId})
    `);
    await tx.execute(sql`UPDATE content_revisions SET state = 'ARCHIVED' WHERE id = ${revision.id}::uuid`);
  }
  return published.map((row) => ({ id: row.id, revision: Number(row.revision) }));
}
