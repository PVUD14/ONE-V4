/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Trust & Safety cases (migration 0032).
 *
 * Two rules from the design are enforced in code here rather than left to a caller:
 * opening a case never applies a penalty, and a case may place a retention hold but
 * never touches readiness.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export class TrustSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TrustSafetyError';
  }
}

export type TrustCaseState =
  | 'REPORTED' | 'TRIAGED' | 'AWAITING_RESPONSE' | 'UNDER_INVESTIGATION'
  | 'DECIDED' | 'ACTIONED' | 'CLOSED' | 'DISMISSED' | 'APPEALED' | 'REOPENED';

/**
 * The state machine, mirroring the CHECK constraint rather than widening it.
 *
 * AWAITING_RESPONSE is the employer's right of reply and is what stops this being a
 * star chamber, so triage leads there rather than straight to investigation.
 */
export const trustCaseTransitions: Readonly<Record<TrustCaseState, readonly TrustCaseState[]>> = {
  REPORTED: ['TRIAGED', 'DISMISSED'],
  TRIAGED: ['AWAITING_RESPONSE', 'UNDER_INVESTIGATION', 'DISMISSED'],
  AWAITING_RESPONSE: ['UNDER_INVESTIGATION', 'DISMISSED'],
  UNDER_INVESTIGATION: ['DECIDED', 'DISMISSED'],
  DECIDED: ['ACTIONED', 'CLOSED'],
  ACTIONED: ['CLOSED', 'APPEALED'],
  CLOSED: ['APPEALED'],
  DISMISSED: [],
  APPEALED: ['REOPENED', 'CLOSED'],
  REOPENED: ['UNDER_INVESTIGATION', 'DISMISSED'],
};

export async function listTrustCases(
  pool: Pool,
  input: { readonly includeClosed?: boolean; readonly limit?: number } = {},
): Promise<readonly Record<string, unknown>[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const result = await pool.query(
    `SELECT c.id, c.case_type AS "caseType", c.subject_kind AS "subjectKind", c.state, c.severity,
            c.organization_id AS "organizationId", o.legal_name AS "organizationName",
            c.reported_by_user_id AS "reportedByUserId", c.opened_at AS "openedAt", c.closed_at AS "closedAt",
            (SELECT count(*)::int FROM trust_case_evidence e WHERE e.case_id = c.id) AS "evidenceCount",
            (SELECT count(*)::int FROM trust_case_actions a WHERE a.case_id = c.id AND a.reversed_at IS NULL) AS "liveActions"
     FROM trust_cases c LEFT JOIN organizations o ON o.id = c.organization_id
     WHERE ($1::boolean OR c.state NOT IN ('CLOSED','DISMISSED'))
     ORDER BY CASE c.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
              c.opened_at
     LIMIT $2`, [input.includeClosed ?? false, limit],
  );
  return result.rows;
}

/** The detector output that has been accumulating with no reader. */
export async function listPendingReviewSignals(pool: Pool, limit = 100): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT s.id, s.opportunity_version_id AS "opportunityVersionId", s.signal_code AS "signalCode",
            s.detector_version AS "detectorVersion", s.first_detected_at AS "firstDetectedAt",
            s.last_detected_at AS "lastDetectedAt"
     FROM opportunity_review_signals s
     WHERE s.review_state = 'PENDING'
     ORDER BY s.first_detected_at
     LIMIT $1`, [Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows;
}

/**
 * Open a case. Deliberately does nothing else.
 *
 * Spec 38: a report creates a case, it does not penalise anybody. Nothing here
 * suspends an organisation, downgrades trust or writes an action.
 */
export async function openTrustCase(
  pool: Pool,
  input: {
    readonly caseType: string;
    readonly subjectKind: 'ORGANIZATION' | 'USER' | 'OPPORTUNITY_VERSION' | 'CONTENT_REVISION';
    readonly subjectId: string;
    readonly organizationId?: string | null;
    readonly reportedByUserId?: string | null;
    readonly severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly statement?: string | null;
    readonly signalIds?: readonly string[];
    readonly openedByUserId: string;
    readonly correlationId: string;
  },
): Promise<{ readonly id: string }> {
  const client = await pool.connect();
  const id = randomUUID();
  const column = {
    ORGANIZATION: 'subject_organization_id',
    USER: 'subject_user_id',
    OPPORTUNITY_VERSION: 'subject_opportunity_version_id',
    CONTENT_REVISION: 'subject_content_revision_id',
  }[input.subjectKind];
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO trust_cases (id, case_type, subject_kind, ${column}, organization_id, reported_by_user_id, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.caseType, input.subjectKind, input.subjectId, input.organizationId ?? null,
        input.reportedByUserId ?? null, input.severity ?? 'MEDIUM'],
    );
    if (input.statement) {
      await client.query(
        `INSERT INTO trust_case_evidence (id, case_id, evidence_kind, reference_id, statement, added_by_user_id)
         VALUES ($1,$2,'REPORTER_STATEMENT',$3,$4,$5)`,
        [randomUUID(), id, `case:${id}`, input.statement, input.openedByUserId],
      );
    }
    for (const signalId of input.signalIds ?? []) {
      await client.query(
        `INSERT INTO trust_case_evidence (id, case_id, evidence_kind, reference_id, added_by_user_id)
         VALUES ($1,$2,'REVIEW_SIGNAL',$3,$4)`,
        [randomUUID(), id, signalId, input.openedByUserId],
      );
      // Attaching a signal to a case is what finally moves it out of PENDING; the
      // detector writes it and a human disposes of it.
      await client.query(
        "UPDATE opportunity_review_signals SET review_state='REVIEWED' WHERE id=$1 AND review_state='PENDING'",
        [signalId],
      );
    }
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
       VALUES ($1,$2,'trust.case.opened','trust_case',$3,$4,'SUCCESS',$5,$6::jsonb)`,
      [randomUUID(), input.openedByUserId, id, input.organizationId ?? null, input.correlationId,
        JSON.stringify({ caseType: input.caseType, subjectKind: input.subjectKind })],
    );
    await client.query('COMMIT');
    return { id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error instanceof TrustSafetyError ? error : new TrustSafetyError('TRUST_CASE_REJECTED');
  } finally {
    client.release();
  }
}

export async function transitionTrustCase(
  pool: Pool,
  input: {
    readonly caseId: string; readonly toState: TrustCaseState; readonly actorUserId: string;
    readonly reasonCode: string; readonly note?: string | null; readonly correlationId: string;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ state: TrustCaseState; organization_id: string | null }>(
      'SELECT state, organization_id FROM trust_cases WHERE id=$1 FOR UPDATE', [input.caseId],
    );
    const from = current.rows[0]?.state;
    if (!from) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
    if (!trustCaseTransitions[from].includes(input.toState)) throw new TrustSafetyError('TRUST_CASE_TRANSITION_NOT_ALLOWED');

    const terminal = input.toState === 'CLOSED' || input.toState === 'DISMISSED';
    await client.query(
      `UPDATE trust_cases SET state=$2, version=version+1, closed_at=${terminal ? 'now()' : 'NULL'}
       WHERE id=$1`, [input.caseId, input.toState],
    );
    // The self-review trigger fires here and refuses a reporter deciding their own case.
    await client.query(
      `INSERT INTO trust_case_events (id, case_id, from_state, to_state, actor_user_id, reason_code, note, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), input.caseId, from, input.toState, input.actorUserId, input.reasonCode,
        input.note ?? null, input.correlationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof TrustSafetyError) throw error;
    if (error instanceof Error && /reporter of a case cannot decide it/.test(error.message)) {
      throw new TrustSafetyError('TRUST_CASE_SELF_REVIEW_REFUSED');
    }
    throw new TrustSafetyError('TRUST_CASE_TRANSITION_REJECTED');
  } finally {
    client.release();
  }
}

/**
 * Apply an enforcement action.
 *
 * Only from DECIDED: an action before a decision is a penalty without a finding, which
 * is the thing spec 38 forbids.
 */
export async function applyTrustCaseAction(
  pool: Pool,
  input: {
    readonly caseId: string; readonly action: string; readonly appliedByUserId: string;
    readonly effectiveTo?: string | null; readonly correlationId: string;
  },
): Promise<{ readonly id: string }> {
  const current = await pool.query<{ state: string }>('SELECT state FROM trust_cases WHERE id=$1', [input.caseId]);
  const state = current.rows[0]?.state;
  if (!state) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
  if (state !== 'DECIDED') throw new TrustSafetyError('TRUST_CASE_NOT_DECIDED');

  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO trust_case_actions (id, case_id, action, effective_to, applied_by_user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, input.caseId, input.action, input.effectiveTo ?? null, input.appliedByUserId],
    );
  } catch {
    throw new TrustSafetyError('TRUST_CASE_ACTION_REJECTED');
  }
  return { id };
}

export async function getTrustCase(pool: Pool, caseId: string): Promise<Record<string, unknown> | null> {
  const header = await pool.query('SELECT * FROM trust_cases WHERE id=$1', [caseId]);
  if (!header.rows[0]) return null;
  const [events, evidence, actions] = await Promise.all([
    pool.query('SELECT * FROM trust_case_events WHERE case_id=$1 ORDER BY occurred_at', [caseId]),
    pool.query('SELECT * FROM trust_case_evidence WHERE case_id=$1 ORDER BY added_at', [caseId]),
    pool.query('SELECT * FROM trust_case_actions WHERE case_id=$1 ORDER BY applied_at', [caseId]),
  ]);
  return { ...header.rows[0], events: events.rows, evidence: evidence.rows, actions: actions.rows };
}
