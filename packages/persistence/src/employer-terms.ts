/**
 * Employer terms (EMP-16): versions, acceptance by an owner, the publish gate, and the daily
 * expiry of applicant-access grants.
 *
 * Design: docs/architecture/employer-terms-and-trust-participation-design.md. Migration 0084.
 *
 * The rule lives here once, as SQL, so every route that puts a job in front of students asks the
 * same question: an employer has accepted current terms when no terms exist yet, or when it accepted
 * the most recent material version or any version published after it. Nothing here is retroactive —
 * a new material version pulls no job and closes no process; only the next publish waits.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

export const employerTermsLegalReviewStates = ['DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED'] as const;
export type EmployerTermsLegalReviewState = typeof employerTermsLegalReviewStates[number];

export type EmployerTermsStatus = 'NO_TERMS_PUBLISHED' | 'ACCEPTED' | 'ACCEPTANCE_REQUIRED';

/**
 * True when the employer under `employerId` (an SQL expression) has accepted current terms. Used
 * inside the guarded publish UPDATE and under the organisation lock elsewhere, so an acceptance and
 * a publish cannot race.
 */
export function employerTermsAcceptedSql(employerId: SQL): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM employer_terms_versions)
    OR EXISTS (SELECT 1 FROM employer_terms_acceptances terms_accepted
      JOIN employer_terms_versions accepted_version ON accepted_version.version = terms_accepted.terms_version
      WHERE terms_accepted.employer_id = ${employerId}
        AND accepted_version.published_at >= (SELECT max(required_version.published_at) FROM employer_terms_versions required_version
          WHERE required_version.requires_reacceptance)))`;
}

export async function employerHasAcceptedCurrentTerms(db: Executor, employerId: string): Promise<boolean> {
  const rows = await db.execute(sql`SELECT ${employerTermsAcceptedSql(sql`${employerId}::uuid`)} AS accepted`) as QueryResult<{ accepted: boolean }>;
  return rows.rows[0]?.accepted === true;
}

export interface EmployerTermsVersionView {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly legalReviewState: EmployerTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly publishedAt: string;
}

export interface EmployerTermsStatusView {
  readonly status: EmployerTermsStatus;
  /** The latest published version — the one an owner accepts today. */
  readonly current: EmployerTermsVersionView | null;
  /** The version every employer must have accepted (or a later one) before publishing. */
  readonly required: { readonly version: string; readonly publishedAt: string } | null;
  readonly latestAcceptance: { readonly version: string; readonly acceptedAt: string; readonly acceptedBy: string | null } | null;
  readonly currentVersionAccepted: boolean;
}

interface VersionRow extends Record<string, unknown> {
  version: string; title: string; body: string; body_sha256: string; legal_review_state: EmployerTermsLegalReviewState;
  legal_review_reference: string | null; requires_reacceptance: boolean; change_summary: string | null; published_at: Date | string;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapVersion(row: VersionRow): EmployerTermsVersionView {
  return {
    version: row.version, title: row.title, body: row.body, bodySha256: row.body_sha256,
    legalReviewState: row.legal_review_state, legalReviewReference: row.legal_review_reference,
    requiresReacceptance: row.requires_reacceptance, changeSummary: row.change_summary, publishedAt: iso(row.published_at),
  };
}

const versionColumns = sql`version, title, body, body_sha256, legal_review_state, legal_review_reference, requires_reacceptance, change_summary, published_at`;

export async function readEmployerTermsStatus(db: Executor, employerId: string): Promise<EmployerTermsStatusView> {
  const [current, required, acceptance, accepted] = await Promise.all([
    db.execute(sql`SELECT ${versionColumns} FROM employer_terms_versions ORDER BY published_at DESC, version DESC LIMIT 1`) as Promise<QueryResult<VersionRow>>,
    db.execute(sql`SELECT version, published_at FROM employer_terms_versions WHERE requires_reacceptance ORDER BY published_at DESC, version DESC LIMIT 1`) as Promise<QueryResult<{ version: string; published_at: Date | string }>>,
    db.execute(sql`
      SELECT a.terms_version, a.accepted_at, u.email
      FROM employer_terms_acceptances a JOIN users u ON u.id = a.accepted_by_user_id
      WHERE a.employer_id = ${employerId}::uuid
      ORDER BY a.accepted_at DESC, a.id DESC LIMIT 1
    `) as Promise<QueryResult<{ terms_version: string; accepted_at: Date | string; email: string | null }>>,
    employerHasAcceptedCurrentTerms(db, employerId),
  ]);
  const currentRow = current.rows[0];
  const requiredRow = required.rows[0];
  const latest = acceptance.rows[0];
  const currentVersionAccepted = currentRow ? (await db.execute(sql`
    SELECT 1 FROM employer_terms_acceptances WHERE employer_id = ${employerId}::uuid AND terms_version = ${currentRow.version}
  `) as QueryResult<unknown>).rows.length === 1 : false;
  return {
    status: !currentRow ? 'NO_TERMS_PUBLISHED' : accepted ? 'ACCEPTED' : 'ACCEPTANCE_REQUIRED',
    current: currentRow ? mapVersion(currentRow) : null,
    required: requiredRow ? { version: requiredRow.version, publishedAt: iso(requiredRow.published_at) } : null,
    latestAcceptance: latest ? { version: latest.terms_version, acceptedAt: iso(latest.accepted_at), acceptedBy: latest.email } : null,
    currentVersionAccepted,
  };
}

export async function listEmployerTermsVersions(db: Executor): Promise<readonly (EmployerTermsVersionView & { readonly acceptedBy: number })[]> {
  const rows = await db.execute(sql`
    SELECT ${versionColumns}, (SELECT count(*)::int FROM employer_terms_acceptances a WHERE a.terms_version = v.version) AS accepted_by
    FROM employer_terms_versions v ORDER BY published_at DESC, version DESC LIMIT 100
  `) as QueryResult<VersionRow & { accepted_by: number }>;
  return rows.rows.map((row) => ({ ...mapVersion(row), acceptedBy: Number(row.accepted_by) }));
}

export class EmployerTermsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EmployerTermsError';
  }
}

export interface PublishEmployerTermsInput {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly legalReviewState: EmployerTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/**
 * Operations publish a version. One transaction with its audit row and outbox event. A duplicate
 * version identifier is refused (the table is immutable); a first version that is not material is
 * refused by the 0084 trigger.
 */
export async function publishEmployerTermsVersion(db: PersistenceDb, input: PublishEmployerTermsInput): Promise<EmployerTermsVersionView> {
  const eventId = randomUUID();
  const versionId = randomUUID();
  const outbox = { id: eventId, aggregateType: 'employer_terms_version', aggregateId: versionId, eventType: 'employer.terms.published', eventVersion: 1,
    payload: { version: input.version, legalReviewState: input.legalReviewState, requiresReacceptance: input.requiresReacceptance ? 'YES' : 'NO' },
    actorUserId: input.actorUserId, correlationId: input.correlationId };
  validateOutboxWriteInput(outbox);
  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.execute(sql`SELECT 1 FROM employer_terms_versions WHERE version = ${input.version}`) as QueryResult<unknown>;
      if (existing.rows.length) throw new EmployerTermsError('EMPLOYER_TERMS_VERSION_EXISTS');
      const first = await tx.execute(sql`SELECT NOT EXISTS (SELECT 1 FROM employer_terms_versions) AS first`) as QueryResult<{ first: boolean }>;
      if (first.rows[0]?.first && !input.requiresReacceptance) throw new EmployerTermsError('EMPLOYER_TERMS_FIRST_VERSION_MUST_REQUIRE_ACCEPTANCE');
      const inserted = await tx.execute(sql`
        INSERT INTO employer_terms_versions (id, version, title, body, body_sha256, legal_review_state, legal_review_reference, requires_reacceptance,
          change_summary, published_by_user_id, reason_code, correlation_id)
        VALUES (${versionId}::uuid, ${input.version}, ${input.title}, ${input.body}, NULL, ${input.legalReviewState}, ${input.legalReviewReference}, ${input.requiresReacceptance},
          ${input.changeSummary}, ${input.actorUserId}::uuid, ${input.reasonCode}, ${input.correlationId})
        RETURNING ${versionColumns}
      `) as QueryResult<VersionRow>;
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${randomUUID()}::uuid, ${input.actorUserId}::uuid, 'employer.terms.published', 'employer_terms_version', ${input.version}, NULL, 'SUCCESS',
          ${input.correlationId}, ${JSON.stringify({ reasonCode: input.reasonCode, legalReviewState: input.legalReviewState, requiresReacceptance: input.requiresReacceptance })}::jsonb)
      `);
      await tx.execute(sql`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
        VALUES (${eventId}::uuid, ${outbox.aggregateType}, ${outbox.aggregateId}, ${outbox.eventType}, 1, ${JSON.stringify(outbox.payload)}::jsonb,
          ${input.actorUserId}::uuid, NULL, ${input.correlationId})
      `);
      return mapVersion(inserted.rows[0]!);
    });
  } catch (error) {
    if (error instanceof EmployerTermsError) throw error;
    if (error instanceof Error && /must require acceptance/.test(error.message)) throw new EmployerTermsError('EMPLOYER_TERMS_FIRST_VERSION_MUST_REQUIRE_ACCEPTANCE');
    throw new EmployerTermsError('EMPLOYER_TERMS_INVALID');
  }
}

/**
 * An owner accepts the current version for their employer, inside the caller's transaction (which
 * already holds the organisation row). Accepting anything but the latest version is refused, so an
 * owner can never accept text they were not shown as current. A repeat is a no-op.
 */
export async function acceptEmployerTerms(tx: Executor, input: {
  readonly employerId: string; readonly version: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly recorded: boolean }> {
  const current = await tx.execute(sql`
    SELECT version FROM employer_terms_versions ORDER BY published_at DESC, version DESC LIMIT 1
  `) as QueryResult<{ version: string }>;
  const latest = current.rows[0]?.version;
  if (!latest) throw new EmployerTermsError('EMPLOYER_TERMS_NOT_PUBLISHED');
  if (latest !== input.version) throw new EmployerTermsError('EMPLOYER_TERMS_VERSION_NOT_CURRENT');
  const inserted = await tx.execute(sql`
    INSERT INTO employer_terms_acceptances (id, employer_id, terms_version, accepted_by_user_id, accepted_role, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.employerId}::uuid, ${input.version}, ${input.actorUserId}::uuid, 'EMPLOYER_OWNER', ${input.correlationId})
    ON CONFLICT (employer_id, terms_version) DO NOTHING
    RETURNING id
  `) as QueryResult<{ id: string }>;
  if (!inserted.rows.length) return { recorded: false };
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${input.actorUserId}::uuid, 'employer.terms.accepted', 'organization', ${input.employerId}, ${input.employerId}::uuid, 'SUCCESS',
      ${input.correlationId}, ${JSON.stringify({ termsVersion: input.version, reasonCode: 'EMPLOYER_TERMS_ACCEPTED' })}::jsonb)
  `);
  const outbox = { id: randomUUID(), aggregateType: 'organization', aggregateId: input.employerId, eventType: 'employer.terms.accepted', eventVersion: 1,
    payload: { employerId: input.employerId, version: input.version }, actorUserId: input.actorUserId, organizationId: input.employerId, correlationId: input.correlationId };
  validateOutboxWriteInput(outbox);
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${outbox.id}::uuid, ${outbox.aggregateType}, ${outbox.aggregateId}, ${outbox.eventType}, 1, ${JSON.stringify(outbox.payload)}::jsonb,
      ${input.actorUserId}::uuid, ${input.employerId}::uuid, ${input.correlationId})
  `);
  return { recorded: true };
}

/**
 * Grant expiry (decision 10.2 #7), run by the daily retention worker, never by a request.
 *
 * The shared live-grant predicate already treats a grant past its `expires_at` as no grant on every
 * request. This makes the end durable: it stamps `revoked_at` on the database clock and writes one
 * actor-less `employer_applicant_access.expired` outbox event per grant, in bounded batches, so
 * operator tooling and anything keyed on `revoked_at` alone (exports) agree. Idempotent: a grant is
 * only ever revoked once. Returns how many grants it revoked.
 */
export async function revokeExpiredApplicantGrants(db: Executor, batchSize = 1_000): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 10_000);
  const revoked = await db.execute(sql`
    WITH due AS (
      SELECT id FROM employer_applicant_access_grants
      WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY expires_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), ended AS (
      UPDATE employer_applicant_access_grants g SET revoked_at = now(), updated_at = now()
      FROM due WHERE g.id = due.id AND g.revoked_at IS NULL
      RETURNING g.id, g.employer_id, g.opportunity_id, g.student_user_id
    ), recorded AS (
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
      SELECT gen_random_uuid(), 'employer_applicant_access_grant', ended.id::text, 'employer_applicant_access.expired', 1,
             jsonb_build_object('grantId', ended.id, 'employerId', ended.employer_id, 'opportunityId', ended.opportunity_id, 'reasonCode', 'GRANT_EXPIRED'),
             NULL, ended.employer_id, 'system:grant-expiry'
      FROM ended
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM recorded
  `) as QueryResult<{ count: number }>;
  return Number(revoked.rows[0]?.count ?? 0);
}
