/**
 * The deadline job for opportunities (EMP-05): a published job closes when its deadline passes.
 *
 * Students already stop seeing a job, and cannot apply, once its current version's deadline
 * passes; before EMP-05 the job itself stayed PUBLISHED forever, so the employer's list said
 * "live" about a job nobody could apply to. Whenever a version with a deadline becomes the
 * current version of a job that is (or becomes) published, the API writes
 * OPPORTUNITY_DEADLINE_CLOSE_REQUESTED in the same transaction, available at the deadline
 * (ADR-028: the outbox is the transport and the scheduler). The local dispatcher hands it here
 * when it is due. Under a consumer receipt and a row lock the job becomes CLOSED with reason
 * DEADLINE_PASSED, audited, with an opportunity.lifecycle.changed event.
 *
 * Idempotent and safe against every later change: a replay finds the receipt; a newer version
 * (a moved deadline) makes the event SUPERSEDED, because that version scheduled its own; a job
 * already paused-then-withdrawn, closed or reopened past a new deadline is left alone. An event
 * seen before its deadline (clock skew) throws, so the outbox retries rather than recording it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export const OPPORTUNITY_DEADLINE_CLOSE_REQUESTED = 'opportunity.deadline_close.requested';
export const OPPORTUNITY_DEADLINE_CLOSE_CONSUMER = 'opportunity-deadline-close';
export const OPPORTUNITY_DEADLINE_REASON = 'DEADLINE_PASSED';

export type OpportunityDeadlineOutcome = 'CLOSED' | 'SUPERSEDED' | 'NOT_OPEN' | 'NOT_FOUND';

/**
 * Queue the close for the current version's deadline, inside the caller's transaction. Writes
 * nothing when the version has no deadline. occurred_at and available_at are both the deadline,
 * read in SQL so the database clock decides, and so the dispatcher's maximum event age counts
 * from when the close is due rather than from when the job was edited.
 */
export async function writeOpportunityDeadlineCloseRequested(tx: Pick<PersistenceDb, 'execute'>, input: {
  readonly eventId: string; readonly opportunityId: string; readonly versionId: string;
  readonly actorUserId: string; readonly employerId: string; readonly correlationId: string;
}): Promise<boolean> {
  const payload = { opportunityId: input.opportunityId, versionId: input.versionId };
  validateOutboxWriteInput({ id: input.eventId, aggregateType: 'opportunity', aggregateId: input.opportunityId,
    eventType: OPPORTUNITY_DEADLINE_CLOSE_REQUESTED, eventVersion: 1, payload, actorUserId: input.actorUserId,
    organizationId: input.employerId, correlationId: input.correlationId });
  const written = await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id, occurred_at, available_at)
    SELECT ${input.eventId}::uuid, 'opportunity', ${input.opportunityId}, ${OPPORTUNITY_DEADLINE_CLOSE_REQUESTED}, 1,
           ${JSON.stringify(payload)}::jsonb, ${input.actorUserId}::uuid, ${input.employerId}::uuid, ${input.correlationId},
           greatest(v.application_deadline, now()), greatest(v.application_deadline, now())
    FROM opportunity_versions v
    WHERE v.id = ${input.versionId}::uuid AND v.opportunity_id = ${input.opportunityId}::uuid AND v.application_deadline IS NOT NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return written.rows.length === 1;
}

/** Outbox consumer for OPPORTUNITY_DEADLINE_CLOSE_REQUESTED. */
export async function closeOpportunityAtDeadline(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
): Promise<{ readonly executed: boolean; readonly outcome?: OpportunityDeadlineOutcome }> {
  if (event.eventType !== OPPORTUNITY_DEADLINE_CLOSE_REQUESTED || event.eventVersion !== 1) {
    throw new Error('event is outside the opportunity deadline consumer contract');
  }
  const opportunityId = typeof event.payload.opportunityId === 'string' ? event.payload.opportunityId : '';
  const versionId = typeof event.payload.versionId === 'string' ? event.payload.versionId : '';
  if (!/^[0-9a-f-]{36}$/i.test(opportunityId) || !/^[0-9a-f-]{36}$/i.test(versionId) || event.aggregateId !== opportunityId || !event.actorId) {
    throw new Error('invalid opportunity deadline event');
  }
  const actorUserId = event.actorId;
  const result = await handleEventIdempotently(db, {
    consumerName: OPPORTUNITY_DEADLINE_CLOSE_CONSUMER,
    eventId: event.eventId,
    failureClass: 'OPPORTUNITY_DEADLINE_CLOSE_FAILED',
    effect: (tx) => closeIfDue(tx, opportunityId, versionId, actorUserId, event.correlationId),
  });
  if (!result.executed || !result.result) return { executed: false };
  return { executed: true, outcome: result.result };
}

async function closeIfDue(tx: PersistenceDb, opportunityId: string, versionId: string, actorUserId: string, correlationId: string): Promise<OpportunityDeadlineOutcome> {
  // Lock the job row alone and read the version in the next statement, so an edit that
  // committed while this waited is seen.
  const found = await tx.execute(sql`
    SELECT id, employer_id, lifecycle_state, current_version_id FROM opportunities
    WHERE id = ${opportunityId}::uuid
    FOR UPDATE
  `) as QueryResult<{ id: string; employer_id: string; lifecycle_state: string; current_version_id: string }>;
  const opportunity = found.rows[0];
  if (!opportunity) return 'NOT_FOUND';
  // A newer version is the one whose deadline counts; it queued its own close.
  if (opportunity.current_version_id !== versionId) return 'SUPERSEDED';
  if (opportunity.lifecycle_state !== 'PUBLISHED' && opportunity.lifecycle_state !== 'PAUSED') return 'NOT_OPEN';
  const deadline = await tx.execute(sql`
    SELECT (application_deadline <= now()) AS due FROM opportunity_versions WHERE id = ${versionId}::uuid
  `) as QueryResult<{ due: boolean | null }>;
  if (deadline.rows[0]?.due !== true) throw new Error('opportunity deadline has not passed yet');

  await tx.execute(sql`
    UPDATE opportunities SET lifecycle_state = 'CLOSED', closed_at = greatest(now(), coalesce(published_at, now())), updated_at = now()
    WHERE id = ${opportunityId}::uuid
  `);
  // The deadline job acts for the person who set the deadline: audit_events requires an actor.
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${actorUserId}::uuid, 'opportunity.closed', 'opportunity', ${opportunityId},
      ${opportunity.employer_id}::uuid, 'SUCCESS', ${correlationId},
      ${JSON.stringify({ reasonCode: OPPORTUNITY_DEADLINE_REASON, fromState: opportunity.lifecycle_state, trigger: 'DEADLINE', versionId })}::jsonb)
  `);
  const eventId = randomUUID();
  const payload = { opportunityId, employerId: opportunity.employer_id, fromState: opportunity.lifecycle_state, toState: 'CLOSED', trigger: 'DEADLINE', reasonCode: OPPORTUNITY_DEADLINE_REASON };
  validateOutboxWriteInput({ id: eventId, aggregateType: 'opportunity', aggregateId: opportunityId, eventType: 'opportunity.lifecycle.changed',
    eventVersion: 1, payload, actorUserId, organizationId: opportunity.employer_id, correlationId });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${eventId}::uuid, 'opportunity', ${opportunityId}, 'opportunity.lifecycle.changed', 1, ${JSON.stringify(payload)}::jsonb,
      ${actorUserId}::uuid, ${opportunity.employer_id}::uuid, ${correlationId})
  `);
  return 'CLOSED';
}
