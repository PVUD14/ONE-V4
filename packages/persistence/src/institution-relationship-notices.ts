/**
 * Telling a student their college ended their relationship (INST-10).
 *
 * Outbox consumer for `institution.relationship.ended`, which the per-student endpoint and the
 * year-end batch both write in the transaction that makes the change. Under a consumer receipt,
 * so a replay or a second worker writes nothing twice, it leaves one in-app notification for the
 * student: what changed, from when, what they keep and what the college now sees. It runs after
 * the change has committed, so a failure here can never block or undo it (plan §5.5). A student
 * who never activated has no one to read it and gets none. In-app only; email is a follow-up.
 * Design: docs/architecture/institution-batch-lifecycle-design.md.
 */
import { sql } from 'drizzle-orm';
import { relationshipChangeNotice } from '@planthepath/authorization/src/index.js';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export const RELATIONSHIP_ENDED = 'institution.relationship.ended';
export const RELATIONSHIP_NOTICE_CONSUMER = 'institution-relationship-notice';

export type RelationshipNoticeOutcome = 'NOTIFIED' | 'NOT_ACTIVATED' | 'NOT_ENDED' | 'NOT_FOUND';

export async function notifyStudentOfRelationshipChange(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
): Promise<{ readonly executed: boolean; readonly outcome?: RelationshipNoticeOutcome }> {
  if (event.eventType !== RELATIONSHIP_ENDED || event.eventVersion !== 1) throw new Error('event is outside the relationship notice contract');
  const relationshipId = typeof event.payload.relationshipId === 'string' ? event.payload.relationshipId : '';
  if (!/^[0-9a-f-]{36}$/i.test(relationshipId) || event.aggregateId !== relationshipId) throw new Error('invalid relationship event');
  const result = await handleEventIdempotently(db, {
    consumerName: RELATIONSHIP_NOTICE_CONSUMER,
    eventId: event.eventId,
    failureClass: 'RELATIONSHIP_NOTICE_FAILED',
    effect: (tx) => writeNotice(tx, relationshipId),
  });
  return result.executed ? { executed: true, ...(result.result ? { outcome: result.result } : {}) } : { executed: false };
}

async function writeNotice(tx: PersistenceDb, relationshipId: string): Promise<RelationshipNoticeOutcome> {
  // The relationship as it stands now: the notice describes what the college recorded.
  const found = await tx.execute(sql`
    SELECT r.student_user_id, r.institution_id, r.state::text AS state, r.effective_to, u.state::text AS user_state, o.legal_name
    FROM institution_relationships r
    JOIN users u ON u.id = r.student_user_id
    JOIN organizations o ON o.id = r.institution_id
    WHERE r.id = ${relationshipId}::uuid
  `) as QueryResult<{ student_user_id: string; institution_id: string; state: string; effective_to: Date | null; user_state: string; legal_name: string }>;
  const row = found.rows[0];
  if (!row) return 'NOT_FOUND';
  if (!row.effective_to || !['GRADUATED', 'TRANSFERRED', 'ENDED', 'REVOKED'].includes(row.state)) return 'NOT_ENDED';
  if (row.user_state !== 'ACTIVE') return 'NOT_ACTIVATED';
  const notice = relationshipChangeNotice({ institutionName: row.legal_name, state: row.state, effectiveTo: new Date(row.effective_to) });
  const data = { kind: 'INSTITUTION_RELATIONSHIP', state: row.state, institutionName: row.legal_name, effectiveTo: new Date(row.effective_to).toISOString() };
  await tx.execute(sql`
    INSERT INTO user_notifications (id, user_id, kind, title, body, data)
    VALUES (gen_random_uuid(), ${row.student_user_id}::uuid, 'SYSTEM', ${notice.title}, ${notice.body}, ${JSON.stringify(data)}::jsonb)
  `);
  return 'NOTIFIED';
}
