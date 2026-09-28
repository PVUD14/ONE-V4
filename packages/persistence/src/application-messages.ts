/**
 * Application-bound messages (EMP-10): the parts that run outside a request — erasing a person's
 * conversations when their account is deleted, erasing conversations whose employer access ended
 * more than 180 days ago, and reading a reported conversation for a trust-and-safety operator.
 *
 * The request routes live in apps/api/src/http/application-messages.controller.ts and the
 * notification in hiring-notifications.ts. Messages are append-only (0067 trigger): nothing here
 * deletes a row; erasing sets the body to NULL with a reason, so counts, pipelines and trust-case
 * references stay valid. Design: docs/architecture/application-messages-table-design.md.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

/** Decision 10.2 #7's period: message text is kept this long after the employer's access ends. */
export const MESSAGE_RETENTION_DAYS_AFTER_GRANT = 180;

/**
 * Privacy deletion: erase the text of every message in the subject's conversations — both sides,
 * because the whole conversation is about them. Returns how many messages were erased.
 */
export async function eraseApplicationMessagesForSubject(db: Executor, subjectUserId: string): Promise<number> {
  const erased = await db.execute(sql`
    WITH gone AS (
      UPDATE application_messages m SET body = NULL, erased_at = now(), erasure_reason = 'PRIVACY_DELETION'
      FROM application_message_threads t
      WHERE t.id = m.thread_id AND t.student_user_id = ${subjectUserId}::uuid AND m.erased_at IS NULL
      RETURNING 1)
    SELECT count(*)::int AS count FROM gone
  `) as QueryResult<{ count: number }>;
  return Number(erased.rows[0]?.count ?? 0);
}

/**
 * Retention: erase the text of conversations whose employer access ended more than
 * {@link MESSAGE_RETENTION_DAYS_AFTER_GRANT} days ago — no grant for that employer, job and student
 * is live, and the latest one ended (revoked or expired) before the cut-off. A conversation that is
 * evidence on an open trust case is skipped until the case closes, so waiting cannot defeat a report.
 */
export async function eraseExpiredApplicationMessages(db: Executor, retentionDays = MESSAGE_RETENTION_DAYS_AFTER_GRANT): Promise<number> {
  const erased = await db.execute(sql`
    WITH expired_threads AS (
      SELECT t.id FROM application_message_threads t
      WHERE EXISTS (SELECT 1 FROM application_messages m WHERE m.thread_id = t.id AND m.erased_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM employer_applicant_access_grants g
          WHERE g.employer_id = t.employer_id AND g.opportunity_id = t.opportunity_id AND g.student_user_id = t.student_user_id
            AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()))
        AND (
          SELECT max(least(coalesce(g.revoked_at, 'infinity'::timestamptz), coalesce(g.expires_at, 'infinity'::timestamptz)))
          FROM employer_applicant_access_grants g
          WHERE g.employer_id = t.employer_id AND g.opportunity_id = t.opportunity_id AND g.student_user_id = t.student_user_id
        ) < now() - make_interval(days => ${retentionDays}::int)
        AND NOT EXISTS (
          SELECT 1 FROM trust_case_evidence e JOIN trust_cases c ON c.id = e.case_id
          WHERE e.evidence_kind = 'APPLICATION_MESSAGE_THREAD' AND e.reference_id = t.id::text
            AND c.state NOT IN ('CLOSED', 'DISMISSED'))
      LIMIT 1000
    ), gone AS (
      UPDATE application_messages m SET body = NULL, erased_at = now(), erasure_reason = 'RETENTION_EXPIRED'
      FROM expired_threads x
      WHERE m.thread_id = x.id AND m.erased_at IS NULL
      RETURNING 1)
    SELECT count(*)::int AS count FROM gone
  `) as QueryResult<{ count: number }>;
  return Number(erased.rows[0]?.count ?? 0);
}

export interface TrustCaseMessageThread {
  readonly employerName: string;
  readonly opportunityTitle: string;
  readonly startedAt: string;
  readonly messages: readonly {
    readonly from: 'EMPLOYER' | 'STUDENT';
    readonly body: string | null;
    readonly containsLink: boolean;
    readonly sentAt: string;
    readonly erasedAt: string | null;
    readonly reported: boolean;
    readonly reportReasonCode: string | null;
  }[];
}

/**
 * The conversations that are evidence on one trust case, for an operator judging the report. Only
 * threads the case references; audited as `trust.case.message_evidence_viewed`. Operators see the
 * text regardless of the employer's grant, because deciding the report needs it. Returns null when
 * the case does not exist.
 */
export async function readTrustCaseMessageEvidence(
  pool: Pool, input: { readonly caseId: string; readonly actorUserId: string; readonly correlationId: string },
): Promise<readonly TrustCaseMessageThread[] | null> {
  const found = await pool.query<{ organization_id: string | null }>('SELECT organization_id FROM trust_cases WHERE id = $1', [input.caseId]);
  if (!found.rows[0]) return null;
  const threads = await pool.query<{ id: string; employer_name: string; title: string; started_at: Date }>(
    `SELECT t.id, org.legal_name AS employer_name, v.title, t.started_at
     FROM trust_case_evidence e
     JOIN application_message_threads t ON t.id::text = e.reference_id
     JOIN applications a ON a.id = t.application_id
     JOIN opportunity_versions v ON v.id = a.applied_version_id
     JOIN organizations org ON org.id = t.employer_id
     WHERE e.case_id = $1 AND e.evidence_kind = 'APPLICATION_MESSAGE_THREAD'
     ORDER BY t.started_at`, [input.caseId],
  );
  const result: TrustCaseMessageThread[] = [];
  for (const thread of threads.rows) {
    const messages = await pool.query<{ sender_side: 'EMPLOYER' | 'STUDENT'; body: string | null; contains_link: boolean; sent_at: Date;
      erased_at: Date | null; reported_at: Date | null; report_reason_code: string | null }>(
      `SELECT sender_side, body, contains_link, sent_at, erased_at, reported_at, report_reason_code
       FROM application_messages WHERE thread_id = $1 ORDER BY sent_at, id LIMIT 1000`, [thread.id],
    );
    result.push({
      employerName: thread.employer_name,
      opportunityTitle: thread.title,
      startedAt: new Date(thread.started_at).toISOString(),
      messages: messages.rows.map((row) => ({
        from: row.sender_side,
        body: row.body,
        containsLink: row.contains_link,
        sentAt: new Date(row.sent_at).toISOString(),
        erasedAt: row.erased_at ? new Date(row.erased_at).toISOString() : null,
        reported: row.reported_at != null,
        reportReasonCode: row.report_reason_code,
      })),
    });
  }
  await pool.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1, $2, 'trust.case.message_evidence_viewed', 'trust_case', $3, $4, 'SUCCESS', $5, $6::jsonb)`,
    [randomUUID(), input.actorUserId, input.caseId, found.rows[0].organization_id, input.correlationId, JSON.stringify({ threads: result.length })],
  );
  return result;
}
