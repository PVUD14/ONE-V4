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
    // EMP-16: an employer cannot be asked to answer nothing. When the subject is an employer, the
    // move to AWAITING_RESPONSE needs an allegation summary shared with them first.
    if (input.toState === 'AWAITING_RESPONSE') await assertAllegationSummaryShared(client, input.caseId);

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
  const [events, evidence, actions, statements] = await Promise.all([
    pool.query('SELECT * FROM trust_case_events WHERE case_id=$1 ORDER BY occurred_at', [caseId]),
    pool.query('SELECT * FROM trust_case_evidence WHERE case_id=$1 ORDER BY added_at', [caseId]),
    pool.query('SELECT * FROM trust_case_actions WHERE case_id=$1 ORDER BY applied_at', [caseId]),
    // EMP-16: what operations shared with the subject employer and what the employer answered or
    // appealed, on the operator's timeline next to the state moves they caused.
    pool.query(
      `SELECT s.id, s.kind, s.author_side AS "authorSide", s.body, s.author_user_id AS "authorUserId", u.email AS "authorEmail",
              s.created_at AS "createdAt"
       FROM trust_case_employer_statements s JOIN users u ON u.id = s.author_user_id
       WHERE s.case_id=$1 ORDER BY s.created_at, s.id`, [caseId]),
  ]);
  return {
    ...header.rows[0],
    subjectEmployerId: await subjectEmployerOf(pool, caseId),
    events: events.rows, evidence: evidence.rows, actions: actions.rows, employerStatements: statements.rows,
  };
}

// ---------------------------------------------------------------------------
// EMP-16: the subject employer's part in a case
// ---------------------------------------------------------------------------
//
// Design: docs/architecture/employer-terms-and-trust-participation-design.md, Decision 4.
//
// An employer sees a case only when it is the subject (its organisation, or a version of one of its
// jobs) and operations has either asked it to respond or decided the case. It sees what operations
// chose to share, the enforcement against it, its own words, and evidence limited to its own
// material. It never sees the reporter, the reporter's statement, severity, assignee, notes,
// operator identities, the opening time or any student data.

/** SQL: the employer a case is about, or NULL. `c` is the trust_cases alias. */
const subjectEmployerSql = `(CASE
  WHEN c.subject_kind = 'ORGANIZATION' THEN (SELECT org.id FROM organizations org WHERE org.id = c.subject_organization_id AND org.kind = 'EMPLOYER')
  WHEN c.subject_kind = 'OPPORTUNITY_VERSION' THEN (SELECT job.employer_id FROM opportunity_versions ver JOIN opportunities job ON job.id = ver.opportunity_id
    WHERE ver.id = c.subject_opportunity_version_id)
  ELSE NULL END)`;

/** SQL: operations have asked the employer to respond, or decided the case. */
const disclosedToEmployerSql = `EXISTS (SELECT 1 FROM trust_case_events disclosed
  WHERE disclosed.case_id = c.id AND disclosed.to_state IN ('AWAITING_RESPONSE', 'DECIDED'))`;

async function subjectEmployerOf(db: Queryable, caseId: string): Promise<string | null> {
  const found = await db.query<{ employer_id: string | null }>(`SELECT ${subjectEmployerSql} AS employer_id FROM trust_cases c WHERE c.id = $1`, [caseId]);
  return found.rows[0]?.employer_id ?? null;
}

async function assertAllegationSummaryShared(client: Queryable, caseId: string): Promise<void> {
  const employerId = await subjectEmployerOf(client, caseId);
  if (!employerId) return;
  const shared = await client.query(
    "SELECT 1 FROM trust_case_employer_statements WHERE case_id = $1 AND kind = 'ALLEGATION_SUMMARY' LIMIT 1", [caseId],
  );
  if (!shared.rows.length) throw new TrustSafetyError('TRUST_CASE_SUMMARY_REQUIRED');
}

export type OperatorStatementKind = 'ALLEGATION_SUMMARY' | 'DECISION_SUMMARY';
export type EmployerStatementKind = 'EMPLOYER_RESPONSE' | 'EMPLOYER_APPEAL';

async function insertStatement(client: PoolClient, input: {
  readonly caseId: string; readonly employerId: string; readonly kind: OperatorStatementKind | EmployerStatementKind;
  readonly body: string; readonly authorUserId: string; readonly correlationId: string;
}): Promise<string> {
  const id = randomUUID();
  const side = input.kind === 'EMPLOYER_RESPONSE' || input.kind === 'EMPLOYER_APPEAL' ? 'EMPLOYER' : 'OPERATIONS';
  await client.query(
    `INSERT INTO trust_case_employer_statements (id, case_id, employer_id, kind, author_side, body, author_user_id, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.caseId, input.employerId, input.kind, side, input.body, input.authorUserId, input.correlationId],
  );
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
     VALUES ($1,'trust_case',$2,'trust.case.employer_statement.recorded',1,$3::jsonb,$4,$5,$6)`,
    [randomUUID(), input.caseId, JSON.stringify({ caseId: input.caseId, employerId: input.employerId, kind: input.kind }),
      input.authorUserId, input.employerId, input.correlationId],
  );
  return id;
}

async function audit(client: PoolClient, input: {
  readonly actorUserId: string; readonly action: string; readonly caseId: string; readonly organizationId: string | null;
  readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,$3,'trust_case',$4,$5,'SUCCESS',$6,$7::jsonb)`,
    [randomUUID(), input.actorUserId, input.action, input.caseId, input.organizationId, input.correlationId, JSON.stringify(input.context)],
  );
}

async function moveCase(client: PoolClient, input: {
  readonly caseId: string; readonly from: TrustCaseState; readonly to: TrustCaseState; readonly actorUserId: string;
  readonly reasonCode: string; readonly correlationId: string;
}): Promise<void> {
  if (!trustCaseTransitions[input.from].includes(input.to)) throw new TrustSafetyError('TRUST_CASE_TRANSITION_NOT_ALLOWED');
  const terminal = input.to === 'CLOSED' || input.to === 'DISMISSED';
  await client.query(`UPDATE trust_cases SET state=$2, version=version+1, closed_at=${terminal ? 'now()' : 'NULL'} WHERE id=$1`, [input.caseId, input.to]);
  await client.query(
    `INSERT INTO trust_case_events (id, case_id, from_state, to_state, actor_user_id, reason_code, note, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)`,
    [randomUUID(), input.caseId, input.from, input.to, input.actorUserId, input.reasonCode, input.correlationId],
  );
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>, failure: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof TrustSafetyError) throw error;
    const code = error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === '23505') throw new TrustSafetyError('TRUST_CASE_ALREADY_APPEALED');
    if (error instanceof Error && /reporter of a case cannot decide it/.test(error.message)) throw new TrustSafetyError('TRUST_CASE_SELF_REVIEW_REFUSED');
    throw new TrustSafetyError(failure);
  } finally {
    client.release();
  }
}

/** Operations share a summary with the subject employer. Refused for a case that is not about an employer. */
export async function shareTrustCaseStatement(pool: Pool, input: {
  readonly caseId: string; readonly kind: OperatorStatementKind; readonly body: string;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly id: string }> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ state: TrustCaseState }>('SELECT state FROM trust_cases WHERE id=$1 FOR UPDATE', [input.caseId]);
    if (!found.rows[0]) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
    const employerId = await subjectEmployerOf(client, input.caseId);
    if (!employerId) throw new TrustSafetyError('TRUST_CASE_SUBJECT_NOT_EMPLOYER');
    const id = await insertStatement(client, { caseId: input.caseId, employerId, kind: input.kind, body: input.body,
      authorUserId: input.actorUserId, correlationId: input.correlationId });
    await audit(client, { actorUserId: input.actorUserId, action: 'trust.case.statement_shared', caseId: input.caseId, organizationId: employerId,
      correlationId: input.correlationId, context: { kind: input.kind, reasonCode: 'SHARED_WITH_SUBJECT_EMPLOYER' } });
    return { id };
  }, 'TRUST_CASE_STATEMENT_REJECTED');
}

/**
 * Operations ask the subject employer to respond: the allegation summary and the move to
 * AWAITING_RESPONSE, in one transaction, so the employer is never asked to answer nothing.
 */
export async function requestEmployerResponse(pool: Pool, input: {
  readonly caseId: string; readonly summary: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await inTransaction(pool, async (client) => {
    const found = await client.query<{ state: TrustCaseState }>('SELECT state FROM trust_cases WHERE id=$1 FOR UPDATE', [input.caseId]);
    const from = found.rows[0]?.state;
    if (!from) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
    const employerId = await subjectEmployerOf(client, input.caseId);
    if (!employerId) throw new TrustSafetyError('TRUST_CASE_SUBJECT_NOT_EMPLOYER');
    if (!trustCaseTransitions[from].includes('AWAITING_RESPONSE')) throw new TrustSafetyError('TRUST_CASE_TRANSITION_NOT_ALLOWED');
    await insertStatement(client, { caseId: input.caseId, employerId, kind: 'ALLEGATION_SUMMARY', body: input.summary,
      authorUserId: input.actorUserId, correlationId: input.correlationId });
    await moveCase(client, { caseId: input.caseId, from, to: 'AWAITING_RESPONSE', actorUserId: input.actorUserId,
      reasonCode: input.reasonCode, correlationId: input.correlationId });
    await audit(client, { actorUserId: input.actorUserId, action: 'trust.case.response_requested', caseId: input.caseId, organizationId: employerId,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode } });
  }, 'TRUST_CASE_TRANSITION_REJECTED');
}

const employerStatus: Readonly<Record<TrustCaseState, string>> = {
  REPORTED: 'UNDER_REVIEW', TRIAGED: 'UNDER_REVIEW', UNDER_INVESTIGATION: 'UNDER_REVIEW', REOPENED: 'UNDER_REVIEW',
  AWAITING_RESPONSE: 'RESPONSE_REQUESTED', DECIDED: 'DECIDED', ACTIONED: 'DECIDED',
  APPEALED: 'APPEAL_UNDER_REVIEW', CLOSED: 'CLOSED', DISMISSED: 'CLOSED_NO_ACTION',
};

interface EmployerCaseRow {
  id: string; case_type: string; state: TrustCaseState; subject_kind: string;
  job_title: string | null; job_version: number | null;
  requested_at: Date | string | null; decided_at: Date | string | null;
  has_appeal: boolean; ever_decided: boolean;
}

const employerCaseSelect = `
  SELECT c.id, c.case_type, c.state, c.subject_kind,
         ver.title AS job_title, ver.version_number AS job_version,
         (SELECT min(e.occurred_at) FROM trust_case_events e WHERE e.case_id = c.id AND e.to_state = 'AWAITING_RESPONSE') AS requested_at,
         (SELECT max(e.occurred_at) FROM trust_case_events e WHERE e.case_id = c.id AND e.to_state = 'DECIDED') AS decided_at,
         EXISTS (SELECT 1 FROM trust_case_employer_statements a WHERE a.case_id = c.id AND a.kind = 'EMPLOYER_APPEAL') AS has_appeal,
         EXISTS (SELECT 1 FROM trust_case_events e WHERE e.case_id = c.id AND e.to_state = 'DECIDED') AS ever_decided
  FROM trust_cases c
  LEFT JOIN opportunity_versions ver ON ver.id = c.subject_opportunity_version_id
  WHERE ${subjectEmployerSql} = $1::uuid AND ${disclosedToEmployerSql}`;

function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function presentEmployerCase(row: EmployerCaseRow): Record<string, unknown> {
  return {
    id: row.id,
    caseType: row.case_type,
    status: employerStatus[row.state],
    subject: row.subject_kind === 'OPPORTUNITY_VERSION'
      ? { kind: 'JOB', jobTitle: row.job_title, jobVersion: row.job_version }
      : { kind: 'ORGANIZATION' },
    responseRequestedAt: isoOrNull(row.requested_at),
    decidedAt: isoOrNull(row.decided_at),
    canRespond: row.state === 'AWAITING_RESPONSE',
    canAppeal: (row.state === 'ACTIONED' || row.state === 'CLOSED') && row.ever_decided && !row.has_appeal,
  };
}

/** The cases about this employer that operations have disclosed to it, most recent activity first. */
export async function listEmployerTrustCases(pool: Pool, employerId: string): Promise<readonly Record<string, unknown>[]> {
  const rows = await pool.query<EmployerCaseRow>(`${employerCaseSelect}
    ORDER BY (SELECT max(e.occurred_at) FROM trust_case_events e WHERE e.case_id = c.id) DESC NULLS LAST, c.id LIMIT 200`, [employerId]);
  return rows.rows.map(presentEmployerCase);
}

/** One disclosed case, as the employer may see it; null when it is not theirs or not disclosed. */
export async function getEmployerTrustCase(pool: Pool, employerId: string, caseId: string): Promise<Record<string, unknown> | null> {
  const rows = await pool.query<EmployerCaseRow>(`${employerCaseSelect} AND c.id = $2::uuid`, [employerId, caseId]);
  const row = rows.rows[0];
  if (!row) return null;
  const [statements, actions, evidence] = await Promise.all([
    pool.query<{ kind: string; body: string; created_at: Date | string }>(
      'SELECT kind, body, created_at FROM trust_case_employer_statements WHERE case_id = $1 AND employer_id = $2 ORDER BY created_at, id', [caseId, employerId]),
    pool.query<{ action: string; effective_from: Date | string; effective_to: Date | string | null; reversed_at: Date | string | null }>(
      'SELECT action, effective_from, effective_to, reversed_at FROM trust_case_actions WHERE case_id = $1 ORDER BY applied_at, id', [caseId]),
    // Evidence limited to the employer's own material: detector signals on its own job versions and
    // its own job versions. Everything else is counted, never described.
    pool.query<{ evidence_kind: string; signal_code: string | null; job_title: string | null; job_version: number | null }>(
      `SELECT e.evidence_kind,
              sig.signal_code,
              coalesce(sig_ver.title, ev_ver.title) AS job_title,
              coalesce(sig_ver.version_number, ev_ver.version_number) AS job_version
       FROM trust_case_evidence e
       LEFT JOIN opportunity_review_signals sig ON e.evidence_kind = 'REVIEW_SIGNAL' AND sig.id::text = e.reference_id AND sig.employer_id = $2::uuid
       LEFT JOIN opportunity_versions sig_ver ON sig_ver.id = sig.opportunity_version_id
       LEFT JOIN opportunity_versions ev_ver ON e.evidence_kind = 'OPPORTUNITY_VERSION' AND ev_ver.id::text = e.reference_id
         AND EXISTS (SELECT 1 FROM opportunities job WHERE job.id = ev_ver.opportunity_id AND job.employer_id = $2::uuid)
       WHERE e.case_id = $1
       ORDER BY e.added_at, e.id`, [caseId, employerId]),
  ]);
  const shared: Record<string, unknown>[] = [];
  let withheld = 0;
  for (const item of evidence.rows) {
    if (item.evidence_kind === 'REVIEW_SIGNAL' && item.signal_code) {
      shared.push({ kind: 'DETECTOR_SIGNAL', signalCode: item.signal_code, jobTitle: item.job_title, jobVersion: item.job_version });
    } else if (item.evidence_kind === 'OPPORTUNITY_VERSION' && item.job_title) {
      shared.push({ kind: 'JOB_VERSION', jobTitle: item.job_title, jobVersion: item.job_version });
    } else {
      withheld += 1;
    }
  }
  return {
    ...presentEmployerCase(row),
    statements: statements.rows.map((statement) => ({ kind: statement.kind, body: statement.body, createdAt: isoOrNull(statement.created_at) })),
    actions: actions.rows.map((action) => ({
      action: action.action, effectiveFrom: isoOrNull(action.effective_from), effectiveTo: isoOrNull(action.effective_to), reversed: action.reversed_at !== null,
    })),
    evidence: { shared, withheldCount: withheld },
  };
}

/**
 * The employer answers (AWAITING_RESPONSE → UNDER_INVESTIGATION) or appeals (ACTIONED or CLOSED →
 * APPEALED, once, only after a decision). The statement and the state move commit together, so the
 * response is on the operator's timeline the moment it exists.
 */
export async function recordEmployerTrustStatement(pool: Pool, input: {
  readonly employerId: string; readonly caseId: string; readonly kind: EmployerStatementKind; readonly body: string;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await inTransaction(pool, async (client) => {
    const found = await client.query<{ state: TrustCaseState }>('SELECT state FROM trust_cases WHERE id=$1 FOR UPDATE', [input.caseId]);
    if (!found.rows[0]) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
    // The same visibility rule as the reads: not theirs, or not disclosed, is not found.
    const visible = await client.query<EmployerCaseRow>(`${employerCaseSelect} AND c.id = $2::uuid`, [input.employerId, input.caseId]);
    const row = visible.rows[0];
    if (!row) throw new TrustSafetyError('TRUST_CASE_NOT_FOUND');
    if (input.kind === 'EMPLOYER_RESPONSE') {
      if (row.state !== 'AWAITING_RESPONSE') throw new TrustSafetyError('TRUST_CASE_RESPONSE_NOT_REQUESTED');
    } else {
      if (row.has_appeal) throw new TrustSafetyError('TRUST_CASE_ALREADY_APPEALED');
      if (!((row.state === 'ACTIONED' || row.state === 'CLOSED') && row.ever_decided)) throw new TrustSafetyError('TRUST_CASE_NOT_APPEALABLE');
    }
    await insertStatement(client, { caseId: input.caseId, employerId: input.employerId, kind: input.kind, body: input.body,
      authorUserId: input.actorUserId, correlationId: input.correlationId });
    const to: TrustCaseState = input.kind === 'EMPLOYER_RESPONSE' ? 'UNDER_INVESTIGATION' : 'APPEALED';
    const reasonCode = input.kind === 'EMPLOYER_RESPONSE' ? 'EMPLOYER_RESPONDED' : 'EMPLOYER_APPEAL';
    await moveCase(client, { caseId: input.caseId, from: row.state, to, actorUserId: input.actorUserId, reasonCode, correlationId: input.correlationId });
    await audit(client, { actorUserId: input.actorUserId, action: input.kind === 'EMPLOYER_RESPONSE' ? 'trust.case.employer_responded' : 'trust.case.employer_appealed',
      caseId: input.caseId, organizationId: input.employerId, correlationId: input.correlationId, context: { reasonCode } });
  }, 'TRUST_CASE_STATEMENT_REJECTED');
}
