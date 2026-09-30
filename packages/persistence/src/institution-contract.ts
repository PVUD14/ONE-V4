/**
 * A college's contract lifecycle (INST-18): data-processing terms, the exit export's rows, and the
 * offboarding steps — notice, end, cancel, and the dual-controlled purge.
 *
 * Design: docs/architecture/institution-contract-lifecycle-design.md. Migration 0088.
 *
 * Every step is one transaction with its audit rows and an outbox event. The database clock decides
 * every time (the retention period, whether it has passed); nothing is stamped in Node. The purge
 * consumes its OPS-02 approval inside its own transaction and only then sets the transaction-local
 * `one.institution_purge`, the one exception 0088 adds to the 0082 delete guards. No step touches a
 * table the design lists as the student's.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  institutionExitExportPartRows,
  institutionExitNotice,
  institutionReturnNotice,
  refuseInstitutionOffboardingStep,
  type InstitutionExitExportSection,
  type InstitutionOffboardingState,
} from '@planthepath/authorization/src/index.js';
import { consumeOperationApproval } from './operation-approvals.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

export class InstitutionContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InstitutionContractError';
  }
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function audit(tx: Executor, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string | null; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
            ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

async function outbox(tx: Executor, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly organizationId: string | null; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({
    id, aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, eventVersion: 1,
    payload: input.payload, actorUserId: input.actorUserId, correlationId: input.correlationId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.organizationId}::uuid, ${input.correlationId})
  `);
}

// ===========================================================================
// Data-processing terms
// ===========================================================================

export const institutionDataTermsLegalReviewStates = ['DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED'] as const;
export type InstitutionDataTermsLegalReviewState = typeof institutionDataTermsLegalReviewStates[number];
export type InstitutionDataTermsStatus = 'NO_TERMS_PUBLISHED' | 'ACCEPTED' | 'ACCEPTANCE_REQUIRED';

/**
 * True when the college under `institutionId` has accepted current terms: no terms exist yet, or it
 * accepted the most recent material version or any version published after it.
 */
export function institutionDataTermsAcceptedSql(institutionId: SQL): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM institution_data_terms_versions)
    OR EXISTS (SELECT 1 FROM institution_data_terms_acceptances terms_accepted
      JOIN institution_data_terms_versions accepted_version ON accepted_version.version = terms_accepted.terms_version
      WHERE terms_accepted.institution_id = ${institutionId}
        AND accepted_version.published_at >= (SELECT max(required_version.published_at) FROM institution_data_terms_versions required_version
          WHERE required_version.requires_reacceptance)))`;
}

export interface InstitutionDataTermsVersionView {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly legalReviewState: InstitutionDataTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly publishedAt: string;
}

export interface InstitutionDataTermsStatusView {
  readonly status: InstitutionDataTermsStatus;
  readonly current: InstitutionDataTermsVersionView | null;
  readonly required: { readonly version: string; readonly publishedAt: string } | null;
  readonly latestAcceptance: { readonly version: string; readonly acceptedAt: string; readonly acceptedBy: string | null } | null;
  readonly currentVersionAccepted: boolean;
}

interface VersionRow extends Record<string, unknown> {
  version: string; title: string; body: string; body_sha256: string; legal_review_state: InstitutionDataTermsLegalReviewState;
  legal_review_reference: string | null; requires_reacceptance: boolean; change_summary: string | null; published_at: Date | string;
}

const versionColumns = sql`version, title, body, body_sha256, legal_review_state, legal_review_reference, requires_reacceptance, change_summary, published_at`;

function mapVersion(row: VersionRow): InstitutionDataTermsVersionView {
  return {
    version: row.version, title: row.title, body: row.body, bodySha256: row.body_sha256,
    legalReviewState: row.legal_review_state, legalReviewReference: row.legal_review_reference,
    requiresReacceptance: row.requires_reacceptance, changeSummary: row.change_summary, publishedAt: iso(row.published_at)!,
  };
}

export async function readInstitutionDataTermsStatus(db: Executor, institutionId: string): Promise<InstitutionDataTermsStatusView> {
  const current = (await db.execute(sql`SELECT ${versionColumns} FROM institution_data_terms_versions ORDER BY published_at DESC, version DESC LIMIT 1`) as QueryResult<VersionRow>).rows[0];
  const required = (await db.execute(sql`
    SELECT version, published_at FROM institution_data_terms_versions WHERE requires_reacceptance ORDER BY published_at DESC, version DESC LIMIT 1
  `) as QueryResult<{ version: string; published_at: Date | string }>).rows[0];
  const latest = (await db.execute(sql`
    SELECT a.terms_version, a.accepted_at, u.email
    FROM institution_data_terms_acceptances a JOIN users u ON u.id = a.accepted_by_user_id
    WHERE a.institution_id = ${institutionId}::uuid
    ORDER BY a.accepted_at DESC, a.id DESC LIMIT 1
  `) as QueryResult<{ terms_version: string; accepted_at: Date | string; email: string | null }>).rows[0];
  const accepted = (await db.execute(sql`SELECT ${institutionDataTermsAcceptedSql(sql`${institutionId}::uuid`)} AS accepted`) as QueryResult<{ accepted: boolean }>).rows[0]?.accepted === true;
  const currentVersionAccepted = current ? (await db.execute(sql`
    SELECT 1 FROM institution_data_terms_acceptances WHERE institution_id = ${institutionId}::uuid AND terms_version = ${current.version}
  `) as QueryResult<unknown>).rows.length === 1 : false;
  return {
    status: !current ? 'NO_TERMS_PUBLISHED' : accepted ? 'ACCEPTED' : 'ACCEPTANCE_REQUIRED',
    current: current ? mapVersion(current) : null,
    required: required ? { version: required.version, publishedAt: iso(required.published_at)! } : null,
    latestAcceptance: latest ? { version: latest.terms_version, acceptedAt: iso(latest.accepted_at)!, acceptedBy: latest.email } : null,
    currentVersionAccepted,
  };
}

export async function listInstitutionDataTermsVersions(db: Executor): Promise<readonly (InstitutionDataTermsVersionView & { readonly acceptedBy: number })[]> {
  const rows = await db.execute(sql`
    SELECT ${versionColumns}, (SELECT count(*)::int FROM institution_data_terms_acceptances a WHERE a.terms_version = v.version) AS accepted_by
    FROM institution_data_terms_versions v ORDER BY published_at DESC, version DESC LIMIT 100
  `) as QueryResult<VersionRow & { accepted_by: number }>;
  return rows.rows.map((row) => ({ ...mapVersion(row), acceptedBy: Number(row.accepted_by) }));
}

export interface PublishInstitutionDataTermsInput {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly legalReviewState: InstitutionDataTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/** Operations publish a version: immutable, audited, announced, in one transaction. */
export async function publishInstitutionDataTermsVersion(db: PersistenceDb, input: PublishInstitutionDataTermsInput): Promise<InstitutionDataTermsVersionView> {
  const versionId = randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.execute(sql`SELECT 1 FROM institution_data_terms_versions WHERE version = ${input.version}`) as QueryResult<unknown>;
      if (existing.rows.length) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_VERSION_EXISTS');
      const first = await tx.execute(sql`SELECT NOT EXISTS (SELECT 1 FROM institution_data_terms_versions) AS first`) as QueryResult<{ first: boolean }>;
      if (first.rows[0]?.first && !input.requiresReacceptance) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_FIRST_VERSION_MUST_REQUIRE_ACCEPTANCE');
      const inserted = await tx.execute(sql`
        INSERT INTO institution_data_terms_versions (id, version, title, body, body_sha256, legal_review_state, legal_review_reference, requires_reacceptance,
          change_summary, published_by_user_id, reason_code, correlation_id)
        VALUES (${versionId}::uuid, ${input.version}, ${input.title}, ${input.body}, repeat('0', 64), ${input.legalReviewState}, ${input.legalReviewReference},
          ${input.requiresReacceptance}, ${input.changeSummary}, ${input.actorUserId}::uuid, ${input.reasonCode}, ${input.correlationId})
        RETURNING ${versionColumns}
      `) as QueryResult<VersionRow>;
      await audit(tx, {
        actorUserId: input.actorUserId, action: 'institution.data_terms.published', resourceType: 'institution_data_terms_version', resourceId: input.version,
        organizationId: null, correlationId: input.correlationId,
        context: { reasonCode: input.reasonCode, legalReviewState: input.legalReviewState, requiresReacceptance: input.requiresReacceptance },
      });
      await outbox(tx, {
        aggregateType: 'institution_data_terms_version', aggregateId: versionId, eventType: 'institution.data_terms.published',
        payload: { version: input.version, legalReviewState: input.legalReviewState, requiresReacceptance: input.requiresReacceptance ? 'YES' : 'NO' },
        actorUserId: input.actorUserId, organizationId: null, correlationId: input.correlationId,
      });
      return mapVersion(inserted.rows[0]!);
    });
  } catch (error) {
    if (error instanceof InstitutionContractError) throw error;
    if (error instanceof Error && /must require acceptance/.test(error.message)) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_FIRST_VERSION_MUST_REQUIRE_ACCEPTANCE');
    throw new InstitutionContractError('INSTITUTION_DATA_TERMS_INVALID');
  }
}

/**
 * An owner accepts the current version for their college, under the organisation row lock that
 * rostering also takes, so an acceptance and a rostering cannot race. Only the latest version may be
 * accepted; a repeat is a no-op.
 */
export async function acceptInstitutionDataTerms(db: PersistenceDb, input: {
  readonly institutionId: string; readonly version: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly recorded: boolean }> {
  return db.transaction(async (tx) => {
    await lockInstitution(tx, input.institutionId);
    const latest = (await tx.execute(sql`
      SELECT version FROM institution_data_terms_versions ORDER BY published_at DESC, version DESC LIMIT 1
    `) as QueryResult<{ version: string }>).rows[0]?.version;
    if (!latest) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_NOT_PUBLISHED');
    if (latest !== input.version) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_VERSION_NOT_CURRENT');
    const inserted = await tx.execute(sql`
      INSERT INTO institution_data_terms_acceptances (id, institution_id, terms_version, accepted_by_user_id, accepted_role, correlation_id)
      VALUES (${randomUUID()}::uuid, ${input.institutionId}::uuid, ${input.version}, ${input.actorUserId}::uuid, 'INSTITUTION_OWNER', ${input.correlationId})
      ON CONFLICT (institution_id, terms_version) DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (!inserted.rows.length) return { recorded: false };
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'institution.data_terms.accepted', resourceType: 'organization', resourceId: input.institutionId,
      organizationId: input.institutionId, correlationId: input.correlationId, context: { termsVersion: input.version, reasonCode: 'INSTITUTION_DATA_TERMS_ACCEPTED' },
    });
    await outbox(tx, {
      aggregateType: 'organization', aggregateId: input.institutionId, eventType: 'institution.data_terms.accepted',
      payload: { institutionId: input.institutionId, version: input.version }, actorUserId: input.actorUserId,
      organizationId: input.institutionId, correlationId: input.correlationId,
    });
    return { recorded: true };
  });
}

async function lockInstitution(tx: Executor, institutionId: string): Promise<{ readonly active: boolean; readonly legalName: string }> {
  const org = (await tx.execute(sql`
    SELECT active, legal_name FROM organizations WHERE id = ${institutionId}::uuid AND kind = 'INSTITUTION' FOR NO KEY UPDATE
  `) as QueryResult<{ active: boolean; legal_name: string }>).rows[0];
  if (!org) throw new InstitutionContractError('INSTITUTION_NOT_FOUND');
  return { active: org.active, legalName: org.legal_name };
}

/**
 * The gate on bringing students into ONE under a college (adding a student, committing a roster
 * import), run first inside that write's own transaction. Refuses while an exit is open, and once
 * any terms exist, until the college has accepted current terms. Never retroactive: it gates only
 * the next rostering.
 */
export async function assertInstitutionRosterIntakeAllowed(tx: Executor, institutionId: string): Promise<void> {
  await lockInstitution(tx, institutionId);
  const open = await tx.execute(sql`
    SELECT 1 FROM institution_offboardings WHERE institution_id = ${institutionId}::uuid AND state IN ('NOTICE', 'ENDED')
  `) as QueryResult<unknown>;
  if (open.rows.length) throw new InstitutionContractError('INSTITUTION_OFFBOARDING_IN_PROGRESS');
  const accepted = (await tx.execute(sql`SELECT ${institutionDataTermsAcceptedSql(sql`${institutionId}::uuid`)} AS accepted`) as QueryResult<{ accepted: boolean }>).rows[0]?.accepted === true;
  if (!accepted) throw new InstitutionContractError('INSTITUTION_DATA_TERMS_NOT_ACCEPTED');
}

// ===========================================================================
// Offboarding
// ===========================================================================

export interface InstitutionOffboardingView {
  readonly id: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly state: InstitutionOffboardingState;
  readonly noticeAt: string;
  readonly noticeReasonCode: string;
  readonly endedAt: string | null;
  readonly endReasonCode: string | null;
  readonly retentionEndsAt: string | null;
  /** The database clock's answer: the retention period has passed. */
  readonly retentionElapsed: boolean;
  readonly cancelledAt: string | null;
  readonly cancelReasonCode: string | null;
  readonly purgedAt: string | null;
  readonly purgeSummary: Record<string, number> | null;
  /** When the owner last took an exit-export file during this exit, or null. */
  readonly exitExportLastTakenAt: string | null;
  readonly changes: { readonly relationships: number; readonly memberships: number; readonly restored: number };
}

interface OffboardingRow extends Record<string, unknown> {
  id: string; institution_id: string; legal_name: string; state: InstitutionOffboardingState; notice_at: Date | string; notice_reason_code: string;
  ended_at: Date | string | null; end_reason_code: string | null; retention_ends_at: Date | string | null; retention_elapsed: boolean;
  cancelled_at: Date | string | null; cancel_reason_code: string | null; purged_at: Date | string | null; purge_summary: Record<string, number> | null;
  exit_export_at: Date | string | null; relationships: number; memberships: number; restored: number;
}

const offboardingSelect = sql`
  SELECT f.id, f.institution_id, o.legal_name, f.state, f.notice_at, f.notice_reason_code, f.ended_at, f.end_reason_code, f.retention_ends_at,
         (f.retention_ends_at IS NOT NULL AND now() >= f.retention_ends_at) AS retention_elapsed,
         f.cancelled_at, f.cancel_reason_code, f.purged_at, f.purge_summary,
         (SELECT max(e.occurred_at) FROM audit_events e
           WHERE e.organization_id = f.institution_id AND e.action LIKE 'institution.exit_export.%.exported'
             AND e.outcome = 'SUCCESS' AND e.occurred_at >= f.notice_at) AS exit_export_at,
         (SELECT count(*)::int FROM institution_offboarding_changes c WHERE c.offboarding_id = f.id AND c.target_kind = 'RELATIONSHIP') AS relationships,
         (SELECT count(*)::int FROM institution_offboarding_changes c WHERE c.offboarding_id = f.id AND c.target_kind = 'MEMBERSHIP') AS memberships,
         (SELECT count(*)::int FROM institution_offboarding_changes c WHERE c.offboarding_id = f.id AND c.restored_at IS NOT NULL) AS restored
  FROM institution_offboardings f JOIN organizations o ON o.id = f.institution_id`;

function mapOffboarding(row: OffboardingRow): InstitutionOffboardingView {
  return {
    id: row.id, institutionId: row.institution_id, institutionName: row.legal_name, state: row.state,
    noticeAt: iso(row.notice_at)!, noticeReasonCode: row.notice_reason_code,
    endedAt: iso(row.ended_at), endReasonCode: row.end_reason_code, retentionEndsAt: iso(row.retention_ends_at), retentionElapsed: row.retention_elapsed,
    cancelledAt: iso(row.cancelled_at), cancelReasonCode: row.cancel_reason_code, purgedAt: iso(row.purged_at), purgeSummary: row.purge_summary,
    exitExportLastTakenAt: iso(row.exit_export_at),
    changes: { relationships: Number(row.relationships), memberships: Number(row.memberships), restored: Number(row.restored) },
  };
}

/** Every exit, newest first (operations). */
export async function listInstitutionOffboardings(db: Executor): Promise<readonly InstitutionOffboardingView[]> {
  const rows = await db.execute(sql`${offboardingSelect} ORDER BY f.notice_at DESC, f.id DESC LIMIT 200`) as QueryResult<OffboardingRow>;
  return rows.rows.map(mapOffboarding);
}

export async function readInstitutionOffboarding(db: Executor, offboardingId: string): Promise<InstitutionOffboardingView | null> {
  const rows = await db.execute(sql`${offboardingSelect} WHERE f.id = ${offboardingId}::uuid`) as QueryResult<OffboardingRow>;
  return rows.rows[0] ? mapOffboarding(rows.rows[0]) : null;
}

/** The college's latest exit, open or closed, or null (the college's own Settings). */
export async function readLatestInstitutionOffboarding(db: Executor, institutionId: string): Promise<InstitutionOffboardingView | null> {
  const rows = await db.execute(sql`${offboardingSelect} WHERE f.institution_id = ${institutionId}::uuid ORDER BY f.notice_at DESC, f.id DESC LIMIT 1`) as QueryResult<OffboardingRow>;
  return rows.rows[0] ? mapOffboarding(rows.rows[0]) : null;
}

interface StepInput {
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/** Step 1: operations record that the college's agreement is ending. Nothing else changes. */
export async function recordInstitutionOffboardingNotice(db: PersistenceDb, input: StepInput & { readonly institutionId: string }): Promise<InstitutionOffboardingView> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await lockInstitution(tx, input.institutionId);
    const open = await tx.execute(sql`
      SELECT 1 FROM institution_offboardings WHERE institution_id = ${input.institutionId}::uuid AND state IN ('NOTICE', 'ENDED')
    `) as QueryResult<unknown>;
    if (open.rows.length) throw new InstitutionContractError('OFFBOARDING_ALREADY_OPEN');
    await tx.execute(sql`
      INSERT INTO institution_offboardings (id, institution_id, state, notice_by_user_id, notice_reason_code, correlation_id)
      VALUES (${id}::uuid, ${input.institutionId}::uuid, 'NOTICE', ${input.actorUserId}::uuid, ${input.reasonCode}, ${input.correlationId})
    `);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'institution.offboarding.notice_recorded', resourceType: 'institution_offboarding', resourceId: id,
      organizationId: input.institutionId, correlationId: input.correlationId, context: { reasonCode: input.reasonCode },
    });
    await outbox(tx, {
      aggregateType: 'institution_offboarding', aggregateId: id, eventType: 'institution.offboarding.notice_recorded',
      payload: { offboardingId: id, institutionId: input.institutionId }, actorUserId: input.actorUserId,
      organizationId: input.institutionId, correlationId: input.correlationId,
    });
  });
  return (await readInstitutionOffboarding(db, id))!;
}

async function lockOffboarding(tx: Executor, offboardingId: string): Promise<{ institutionId: string; state: InstitutionOffboardingState; retentionElapsed: boolean; wasActive: boolean | null; endedAt: Date | null }> {
  const row = (await tx.execute(sql`
    SELECT institution_id, state, (retention_ends_at IS NOT NULL AND now() >= retention_ends_at) AS retention_elapsed, was_active, ended_at
    FROM institution_offboardings WHERE id = ${offboardingId}::uuid FOR UPDATE
  `) as QueryResult<{ institution_id: string; state: InstitutionOffboardingState; retention_elapsed: boolean; was_active: boolean | null; ended_at: Date | string | null }>).rows[0];
  if (!row) throw new InstitutionContractError('OFFBOARDING_NOT_FOUND');
  return { institutionId: row.institution_id, state: row.state, retentionElapsed: row.retention_elapsed, wasActive: row.was_active, endedAt: row.ended_at ? new Date(row.ended_at) : null };
}

/**
 * Step 2: end the college's use of ONE. Current relationships end (history is untouched), staff
 * memberships end, pending invitations are revoked, the college leaves the directory; every change is
 * written to the ledger with its prior state, and each activated student is told.
 */
export async function endInstitutionOffboarding(db: PersistenceDb, input: StepInput & { readonly offboardingId: string }): Promise<InstitutionOffboardingView> {
  await db.transaction(async (tx) => {
    const offboarding = await lockOffboarding(tx, input.offboardingId);
    const refusal = refuseInstitutionOffboardingStep(offboarding.state, 'END', offboarding.retentionElapsed);
    if (refusal) throw new InstitutionContractError(refusal);
    const institutionId = offboarding.institutionId;
    const org = await lockInstitution(tx, institutionId);
    await tx.execute(sql`
      UPDATE institution_offboardings SET state = 'ENDED', ended_by_user_id = ${input.actorUserId}::uuid, end_reason_code = ${input.reasonCode},
             was_active = ${org.active}
      WHERE id = ${input.offboardingId}::uuid
    `);

    // The ledger first, with each row's state before the exit, then the changes it describes.
    await tx.execute(sql`
      INSERT INTO institution_offboarding_changes (offboarding_id, target_kind, target_id, prior_state, prior_profile_status)
      SELECT ${input.offboardingId}::uuid, 'RELATIONSHIP', r.id, r.state::text,
             (SELECT p.status::text FROM institution_student_profiles p WHERE p.institution_id = r.institution_id AND p.student_user_id = r.student_user_id)
      FROM institution_relationships r
      WHERE r.institution_id = ${institutionId}::uuid AND r.state IN ('PENDING', 'VERIFIED', 'ACTIVE') AND r.effective_to IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO institution_offboarding_changes (offboarding_id, target_kind, target_id, prior_state)
      SELECT ${input.offboardingId}::uuid, 'MEMBERSHIP', m.id, m.state::text
      FROM organization_memberships m
      WHERE m.organization_id = ${institutionId}::uuid AND m.state IN ('ACTIVE', 'SUSPENDED')
    `);
    const ended = await tx.execute(sql`
      UPDATE institution_relationships r SET state = 'ENDED', effective_to = now(), updated_at = now()
      FROM institution_offboarding_changes c
      WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP' AND r.id = c.target_id
      RETURNING r.id, r.student_user_id
    `) as QueryResult<{ id: string; student_user_id: string }>;
    await tx.execute(sql`
      UPDATE institution_student_profiles p SET status = 'ENDED', updated_at = now()
      FROM institution_offboarding_changes c JOIN institution_relationships r ON r.id = c.target_id
      WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP'
        AND p.institution_id = r.institution_id AND p.student_user_id = r.student_user_id
    `);
    const memberships = await tx.execute(sql`
      UPDATE organization_memberships m SET state = 'ENDED', updated_at = now()
      FROM institution_offboarding_changes c
      WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'MEMBERSHIP' AND m.id = c.target_id
      RETURNING m.id
    `) as QueryResult<{ id: string }>;
    const invitations = await tx.execute(sql`
      UPDATE invitations SET state = 'REVOKED', revoked_at = now(), reason_code = 'INSTITUTION_OFFBOARDED', updated_at = now()
      WHERE organization_id = ${institutionId}::uuid AND state = 'PENDING'
      RETURNING id
    `) as QueryResult<{ id: string }>;
    await tx.execute(sql`UPDATE organizations SET active = false, updated_at = now() WHERE id = ${institutionId}::uuid`);

    // Each person's trail reads the same as any other end: one audit row per relationship and membership.
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      SELECT gen_random_uuid(), ${input.actorUserId}::uuid,
             CASE c.target_kind WHEN 'RELATIONSHIP' THEN 'institution.relationship.ended' ELSE 'institution.staff_membership.ended' END,
             CASE c.target_kind WHEN 'RELATIONSHIP' THEN 'institution_relationship' ELSE 'organization_membership' END,
             c.target_id::text, ${institutionId}::uuid, 'SUCCESS', ${input.correlationId},
             jsonb_build_object('state', 'ENDED', 'priorState', c.prior_state, 'reasonCode', 'INSTITUTION_OFFBOARDED', 'offboardingId', ${input.offboardingId}::text)
      FROM institution_offboarding_changes c WHERE c.offboarding_id = ${input.offboardingId}::uuid
    `);
    const endedAt = (await tx.execute(sql`SELECT ended_at FROM institution_offboardings WHERE id = ${input.offboardingId}::uuid`) as QueryResult<{ ended_at: Date | string }>).rows[0]!.ended_at;
    const notice = institutionExitNotice({ institutionName: org.legalName, endedAt: new Date(endedAt) });
    const notified = await tx.execute(sql`
      INSERT INTO user_notifications (id, user_id, kind, title, body, data)
      SELECT gen_random_uuid(), r.student_user_id, 'SYSTEM', ${notice.title}, ${notice.body},
             jsonb_build_object('kind', 'INSTITUTION_EXIT', 'institutionName', ${org.legalName}::text, 'endedAt', ${iso(endedAt)}::text)
      FROM institution_offboarding_changes c
      JOIN institution_relationships r ON r.id = c.target_id
      JOIN users u ON u.id = r.student_user_id AND u.state = 'ACTIVE'
      WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP'
      RETURNING id
    `) as QueryResult<{ id: string }>;
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'institution.offboarding.ended', resourceType: 'institution_offboarding', resourceId: input.offboardingId,
      organizationId: institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, relationshipsEnded: ended.rows.length, membershipsEnded: memberships.rows.length,
        invitationsRevoked: invitations.rows.length, studentsNotified: notified.rows.length, wasActive: org.active },
    });
    await outbox(tx, {
      aggregateType: 'institution_offboarding', aggregateId: input.offboardingId, eventType: 'institution.offboarding.ended',
      payload: { offboardingId: input.offboardingId, institutionId }, actorUserId: input.actorUserId,
      organizationId: institutionId, correlationId: input.correlationId,
    });
  });
  return (await readInstitutionOffboarding(db, input.offboardingId))!;
}

/**
 * Step 3: cancel. From NOTICE nothing needs restoring. From ENDED (only while the retention period
 * runs) every ledger row still exactly as the exit left it is restored, the organisation's `active`
 * returns to what it was, and each activated student whose link came back is told.
 */
export async function cancelInstitutionOffboarding(db: PersistenceDb, input: StepInput & { readonly offboardingId: string }): Promise<InstitutionOffboardingView> {
  await db.transaction(async (tx) => {
    const offboarding = await lockOffboarding(tx, input.offboardingId);
    const refusal = refuseInstitutionOffboardingStep(offboarding.state, 'CANCEL', offboarding.retentionElapsed);
    if (refusal) throw new InstitutionContractError(refusal);
    const institutionId = offboarding.institutionId;
    const org = await lockInstitution(tx, institutionId);
    await tx.execute(sql`
      UPDATE institution_offboardings SET state = 'CANCELLED', cancelled_by_user_id = ${input.actorUserId}::uuid, cancel_reason_code = ${input.reasonCode}
      WHERE id = ${input.offboardingId}::uuid
    `);
    let relationshipsRestored = 0;
    let membershipsRestored = 0;
    let studentsNotified = 0;
    if (offboarding.state === 'ENDED') {
      const relationships = await tx.execute(sql`
        UPDATE institution_relationships r SET state = c.prior_state::relationship_state, effective_to = NULL, updated_at = now()
        FROM institution_offboarding_changes c
        WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP' AND r.id = c.target_id AND r.state = 'ENDED'
        RETURNING r.id
      `) as QueryResult<{ id: string }>;
      relationshipsRestored = relationships.rows.length;
      await tx.execute(sql`
        UPDATE institution_student_profiles p SET status = c.prior_profile_status::roster_student_status, updated_at = now()
        FROM institution_offboarding_changes c JOIN institution_relationships r ON r.id = c.target_id
        WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP' AND c.prior_profile_status IS NOT NULL
          AND r.state::text = c.prior_state AND r.effective_to IS NULL
          AND p.institution_id = r.institution_id AND p.student_user_id = r.student_user_id AND p.status = 'ENDED'
      `);
      const memberships = await tx.execute(sql`
        UPDATE organization_memberships m SET state = c.prior_state::membership_state, updated_at = now()
        FROM institution_offboarding_changes c
        WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'MEMBERSHIP' AND m.id = c.target_id AND m.state = 'ENDED'
        RETURNING m.id
      `) as QueryResult<{ id: string }>;
      membershipsRestored = memberships.rows.length;
      const restoredIds = [...relationships.rows, ...memberships.rows].map((row) => row.id);
      if (restoredIds.length) {
        await tx.execute(sql`
          UPDATE institution_offboarding_changes SET restored_at = now()
          WHERE offboarding_id = ${input.offboardingId}::uuid AND target_id = ANY(${`{${restoredIds.join(',')}}`}::uuid[])
        `);
        await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          SELECT gen_random_uuid(), ${input.actorUserId}::uuid,
                 CASE c.target_kind WHEN 'RELATIONSHIP' THEN 'institution.relationship.restored' ELSE 'institution.staff_membership.restored' END,
                 CASE c.target_kind WHEN 'RELATIONSHIP' THEN 'institution_relationship' ELSE 'organization_membership' END,
                 c.target_id::text, ${institutionId}::uuid, 'SUCCESS', ${input.correlationId},
                 jsonb_build_object('state', c.prior_state, 'reasonCode', ${input.reasonCode}::text, 'offboardingId', ${input.offboardingId}::text)
          FROM institution_offboarding_changes c
          WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.restored_at IS NOT NULL
        `);
      }
      await tx.execute(sql`UPDATE organizations SET active = ${offboarding.wasActive ?? true}, updated_at = now() WHERE id = ${institutionId}::uuid`);
      const notice = institutionReturnNotice({ institutionName: org.legalName });
      const notified = await tx.execute(sql`
        INSERT INTO user_notifications (id, user_id, kind, title, body, data)
        SELECT gen_random_uuid(), r.student_user_id, 'SYSTEM', ${notice.title}, ${notice.body},
               jsonb_build_object('kind', 'INSTITUTION_RETURN', 'institutionName', ${org.legalName}::text)
        FROM institution_offboarding_changes c
        JOIN institution_relationships r ON r.id = c.target_id
        JOIN users u ON u.id = r.student_user_id AND u.state = 'ACTIVE'
        WHERE c.offboarding_id = ${input.offboardingId}::uuid AND c.target_kind = 'RELATIONSHIP' AND c.restored_at IS NOT NULL
        RETURNING id
      `) as QueryResult<{ id: string }>;
      studentsNotified = notified.rows.length;
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'institution.offboarding.cancelled', resourceType: 'institution_offboarding', resourceId: input.offboardingId,
      organizationId: institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fromState: offboarding.state, relationshipsRestored, membershipsRestored, studentsNotified },
    });
    await outbox(tx, {
      aggregateType: 'institution_offboarding', aggregateId: input.offboardingId, eventType: 'institution.offboarding.cancelled',
      payload: { offboardingId: input.offboardingId, institutionId, fromState: offboarding.state }, actorUserId: input.actorUserId,
      organizationId: institutionId, correlationId: input.correlationId,
    });
  });
  return (await readInstitutionOffboarding(db, input.offboardingId))!;
}

// ---------------------------------------------------------------------------
// The purge: institution-owned rows, in foreign-key order
// ---------------------------------------------------------------------------

/**
 * Each institution-owned table the purge deletes from, in the order it deletes, with the predicate
 * that finds the college's rows. `$1` is the institution. The preview counts exactly these.
 */
export const institutionPurgePlan: readonly { readonly table: string; readonly where: string }[] = [
  { table: 'staff_action_content_links', where: 'staff_action_id IN (SELECT id FROM staff_actions WHERE institution_id = $1)' },
  { table: 'staff_action_attendees', where: 'institution_id = $1' },
  { table: 'learning_assignment_students', where: 'institution_id = $1' },
  { table: 'learning_assignments', where: 'institution_id = $1' },
  { table: 'learning_plan_overrides', where: 'institution_id = $1' },
  { table: 'counselling_case_participants', where: 'institution_id = $1' },
  { table: 'staff_actions', where: 'institution_id = $1' },
  { table: 'exam_results', where: 'attempt_id IN (SELECT id FROM exam_attempts WHERE institution_id = $1)' },
  { table: 'exam_screen_events', where: 'attempt_id IN (SELECT id FROM exam_attempts WHERE institution_id = $1)' },
  { table: 'exam_answers', where: 'attempt_id IN (SELECT id FROM exam_attempts WHERE institution_id = $1)' },
  { table: 'exam_attempt_questions', where: 'attempt_id IN (SELECT id FROM exam_attempts WHERE institution_id = $1)' },
  { table: 'exam_attempts', where: 'institution_id = $1' },
  { table: 'exam_assignments', where: 'institution_id = $1' },
  { table: 'exam_section_pool', where: 'institution_id = $1' },
  { table: 'exam_sections', where: 'institution_id = $1' },
  { table: 'exam_definition_events', where: 'definition_id IN (SELECT id FROM exam_definitions WHERE institution_id = $1)' },
  { table: 'exam_definitions', where: 'institution_id = $1' },
  { table: 'exam_question_reviews', where: 'question_id IN (SELECT id FROM exam_questions WHERE institution_id = $1)' },
  { table: 'exam_question_versions', where: 'question_id IN (SELECT id FROM exam_questions WHERE institution_id = $1)' },
  { table: 'exam_question_options', where: 'question_id IN (SELECT id FROM exam_questions WHERE institution_id = $1)' },
  { table: 'exam_questions', where: 'institution_id = $1' },
  { table: 'exam_subject_topic_links', where: 'institution_id = $1' },
  { table: 'faculty_teaching_assignments', where: 'institution_id = $1' },
  { table: 'exam_syllabus_nodes', where: 'institution_id = $1' },
  { table: 'exam_subjects', where: 'institution_id = $1' },
  { table: 'institution_announcement_recipients', where: 'announcement_id IN (SELECT id FROM institution_announcements WHERE institution_id = $1)' },
  { table: 'institution_announcements', where: 'institution_id = $1' },
  { table: 'institution_settings', where: 'institution_id = $1' },
  { table: 'institution_grading_scales', where: 'institution_id = $1' },
  { table: 'institution_academic_terms', where: 'institution_id = $1' },
  { table: 'student_roster_import_rows', where: 'import_id IN (SELECT id FROM student_roster_imports WHERE institution_id = $1)' },
  { table: 'student_roster_imports', where: 'institution_id = $1' },
  { table: 'institution_student_profiles', where: 'institution_id = $1' },
  { table: 'institution_aggregate_reports', where: 'institution_id = $1' },
];

/**
 * What the purge keeps, counted so the preview says so in numbers: the college's structure, and
 * everything that is the student's or an employer's (design: "What belongs to whom").
 */
export const institutionPurgeKept: readonly { readonly table: string; readonly where: string }[] = [
  { table: 'institution_units', where: 'institution_id = $1' },
  { table: 'institution_relationships', where: 'institution_id = $1' },
  { table: 'student_qualifications', where: 'institution_id = $1' },
  { table: 'student_academic_terms', where: 'qualification_id IN (SELECT id FROM student_qualifications WHERE institution_id = $1)' },
  { table: 'campus_drives', where: 'institution_id = $1' },
  { table: 'campus_drive_nominations', where: 'institution_id = $1' },
  { table: 'student_outcome_declarations', where: 'institution_id = $1' },
  { table: 'organization_memberships', where: 'organization_id = $1' },
];

/**
 * Tables that carry an `institution_id` but are neither deleted nor counted above, each with the
 * reason. A test holds the three lists together against the schema, so a future table with an
 * `institution_id` cannot slip past the exit without someone deciding which list it belongs in.
 */
export const institutionPurgeOutOfScope: Readonly<Record<string, string>> = {
  campus_drive_category_assignments: 'kept with the campus drives it labels (joint with employers)',
  institution_drive_categories: 'kept with the campus drives it labels (joint with employers)',
  institution_placement_policies: 'kept: the policy campus drive applications were made under',
  opportunity_audiences: "an employer's targeting of its own job",
  external_review_assignments: "AI8HT's content review record",
  institution_accounts: "AI8HT's commercial record (OPS-14)",
  institution_account_contacts: "AI8HT's record; removed through OPS-14's erasing route as a runbook step",
  institution_data_terms_acceptances: 'the contract record itself',
  institution_offboardings: 'the exit record itself',
  learner_goals: "the student's own learning record",
  learner_skill_state: "the student's own learning record",
  learning_attempt_events: "the student's own learning record",
  learning_decisions: "the student's own learning record",
  learning_sessions: "the student's own learning record",
  learning_step_items: "the student's own learning record",
  placement_tests: "the student's own learning record",
  placement_test_items: "the student's own learning record",
};

export interface InstitutionPurgePreview {
  readonly deletes: Readonly<Record<string, number>>;
  readonly keeps: Readonly<Record<string, number>>;
  /** Students of the college under an active legal hold: the purge is refused while this is above zero. */
  readonly studentsUnderHold: number;
}

async function countEach(client: { query: PoolClient['query'] }, plan: readonly { readonly table: string; readonly where: string }[], institutionId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const step of plan) {
    const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${step.table} WHERE ${step.where}`, [institutionId]);
    counts[step.table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

async function studentsUnderHold(client: { query: PoolClient['query'] }, institutionId: string): Promise<number> {
  const result = await client.query<{ n: number }>(`
    SELECT count(DISTINCT h.subject_user_id)::int AS n FROM data_retention_holds h
    WHERE h.released_at IS NULL AND h.subject_user_id IN (SELECT student_user_id FROM institution_student_profiles WHERE institution_id = $1)`, [institutionId]);
  return Number(result.rows[0]?.n ?? 0);
}

/** The runbook's dry run: exactly what the purge would delete and keep, deleting nothing. */
export async function previewInstitutionPurge(client: { query: PoolClient['query'] }, institutionId: string): Promise<InstitutionPurgePreview> {
  return {
    deletes: await countEach(client, institutionPurgePlan, institutionId),
    keeps: await countEach(client, institutionPurgeKept, institutionId),
    studentsUnderHold: await studentsUnderHold(client, institutionId),
  };
}

/**
 * Step 4: delete the college's institution-owned records. Needs the retention period to have passed
 * (database clock), no active legal hold on any of its students, and an INSTITUTION_DATA_PURGE
 * approval consumed here, in this transaction. Deletes in foreign-key order, records the count per
 * table on the exit and in the audit row, and moves the exit to PURGED.
 */
export async function purgeInstitutionRecords(client: PoolClient, input: StepInput & {
  readonly offboardingId: string;
  readonly approvalId: string;
  readonly approvalPayload: Record<string, unknown>;
}): Promise<{ readonly summary: Record<string, number>; readonly mode: 'DUAL' | 'SOLO' }> {
  const tx = drizzle(client);
  await client.query('BEGIN');
  try {
    const offboarding = await lockOffboarding(tx, input.offboardingId);
    const refusal = refuseInstitutionOffboardingStep(offboarding.state, 'PURGE', offboarding.retentionElapsed);
    if (refusal) throw new InstitutionContractError(refusal);
    const institutionId = offboarding.institutionId;
    await lockInstitution(tx, institutionId);
    if (await studentsUnderHold(client, institutionId) > 0) throw new InstitutionContractError('OFFBOARDING_PURGE_HELD');
    const consumed = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'INSTITUTION_DATA_PURGE', payload: input.approvalPayload,
      executorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    await client.query("SELECT set_config('one.institution_purge', $1, true)", [institutionId]);
    const summary: Record<string, number> = {};
    for (const step of institutionPurgePlan) {
      const result = await client.query(`DELETE FROM ${step.table} WHERE ${step.where}`, [institutionId]);
      summary[step.table] = result.rowCount ?? 0;
    }
    await client.query("SELECT set_config('one.institution_purge', '', true)");
    await client.query(
      `UPDATE institution_offboardings SET state = 'PURGED', purged_by_user_id = $2, purge_approval_id = $3, purge_summary = $4::jsonb WHERE id = $1`,
      [input.offboardingId, input.actorUserId, input.approvalId, JSON.stringify(summary)],
    );
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'institution.offboarding.purged', resourceType: 'institution_offboarding', resourceId: input.offboardingId,
      organizationId: institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, approvalId: input.approvalId, approvedByUserId: consumed.approvedByUserId, mode: consumed.mode, deleted: summary },
    });
    await outbox(tx, {
      aggregateType: 'institution_offboarding', aggregateId: input.offboardingId, eventType: 'institution.offboarding.purged',
      payload: { offboardingId: input.offboardingId, institutionId, approvalId: input.approvalId }, actorUserId: input.actorUserId,
      organizationId: institutionId, correlationId: input.correlationId,
    });
    await client.query('COMMIT');
    return { summary, mode: consumed.mode };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// ===========================================================================
// The exit export's rows
// ===========================================================================

export interface ExitExportFile {
  readonly header: readonly string[];
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
}

type Queryable = { query: PoolClient['query'] };

/**
 * Completed attempts count only where the relationship authorised them when they were taken — INST-08's
 * rule (canonicalInstitutionRelationshipPolicy), unchanged: a student's attempt is their work in the
 * college's assessment, so the college takes back what it could read, no more.
 */
const resultAuthorised = `EXISTS (SELECT 1 FROM institution_relationships ir
  WHERE ir.institution_id = $1 AND ir.student_user_id = t.student_user_id
    AND (ir.state IN ('VERIFIED', 'ACTIVE') OR (ir.state IN ('TRANSFERRED', 'GRADUATED') AND ir.effective_to IS NOT NULL))
    AND ir.effective_from <= r.created_at AND (ir.effective_to IS NULL OR ir.effective_to > r.created_at))`;

/** Each section's FROM/WHERE (for counting) and its ordered SELECT (for a part). `$1` is the institution. */
const exitSections: Readonly<Record<InstitutionExitExportSection, { readonly from: string; readonly select: string; readonly order: string; readonly header: readonly string[] }>> = {
  units: {
    from: 'FROM institution_units u LEFT JOIN institution_units parent ON parent.id = u.parent_unit_id WHERE u.institution_id = $1',
    select: "u.name, initcap(lower(u.kind::text)), parent.name, to_char(u.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')",
    order: 'u.kind, u.name, u.id',
    header: ['Unit', 'Kind', 'Parent unit', 'Created on'],
  },
  roster: {
    from: `FROM institution_student_profiles p
      JOIN users su ON su.id = p.student_user_id
      LEFT JOIN LATERAL (SELECT state::text AS state, effective_from, effective_to FROM institution_relationships
        WHERE institution_id = p.institution_id AND student_user_id = p.student_user_id ORDER BY effective_from DESC LIMIT 1) rel ON true
      LEFT JOIN institution_units dep ON dep.id = p.department_unit_id
      LEFT JOIN institution_units prog ON prog.id = p.program_unit_id
      LEFT JOIN institution_units bat ON bat.id = p.batch_unit_id
      LEFT JOIN institution_units sec ON sec.id = p.section_unit_id
      WHERE p.institution_id = $1`,
    select: `p.institution_student_id, p.full_name, su.email, dep.name, prog.name, bat.name, sec.name, p.status::text, rel.state,
      to_char(rel.effective_from AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'), to_char(rel.effective_to AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
      to_char(p.academic_start_date, 'YYYY-MM-DD'), to_char(p.expected_graduation_date, 'YYYY-MM-DD')`,
    order: 'p.institution_student_id, p.full_name, p.id',
    header: ['Student ID', 'Full name', 'Email', 'Department', 'Programme', 'Batch', 'Section', 'Roster status', 'Relationship', 'From', 'To', 'Academic start', 'Expected graduation'],
  },
  staff: {
    from: `FROM organization_memberships m JOIN users mu ON mu.id = m.user_id
      LEFT JOIN institution_units dep ON dep.id = m.scope_department_unit_id
      LEFT JOIN institution_units bat ON bat.id = m.scope_batch_unit_id
      WHERE m.organization_id = $1`,
    select: "mu.email, m.role, dep.name, bat.name, m.state::text, to_char(m.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')",
    order: 'm.role, mu.email, m.id',
    header: ['Email', 'Role', 'Department', 'Batch', 'State', 'Since'],
  },
  'teaching-assignments': {
    from: `FROM faculty_teaching_assignments a
      JOIN organization_memberships m ON m.id = a.faculty_membership_id JOIN users mu ON mu.id = m.user_id
      LEFT JOIN institution_units unit ON unit.id = a.unit_id
      LEFT JOIN exam_subjects subj ON subj.id = a.subject_id
      WHERE a.institution_id = $1`,
    select: "mu.email, unit.name, subj.name, a.subject_code, a.academic_term, to_char(a.starts_on, 'YYYY-MM-DD'), to_char(a.ends_on, 'YYYY-MM-DD'), a.state",
    order: 'mu.email, a.starts_on, a.id',
    header: ['Faculty email', 'Unit', 'Subject', 'Subject code', 'Academic term', 'Starts on', 'Ends on', 'State'],
  },
  assessments: {
    from: 'FROM exam_definitions d LEFT JOIN exam_subjects subj ON subj.id = d.subject_id WHERE d.institution_id = $1',
    select: `d.title, subj.name, d.exam_kind, d.lifecycle_state, d.total_marks::float8, round(d.duration_seconds / 60.0)::int,
      to_char(d.starts_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'), to_char(d.ends_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'),
      d.attempts_allowed, to_char(d.published_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
    order: 'd.created_at, d.id',
    header: ['Assessment', 'Subject', 'Kind', 'State', 'Total marks', 'Duration (minutes)', 'Opens', 'Closes', 'Attempts allowed', 'Published on'],
  },
  'assessment-results': {
    from: `FROM exam_results r JOIN exam_attempts t ON t.id = r.attempt_id JOIN exam_definitions d ON d.id = t.definition_id
      LEFT JOIN institution_student_profiles p ON p.institution_id = t.institution_id AND p.student_user_id = t.student_user_id
      WHERE t.institution_id = $1 AND ${resultAuthorised}`,
    select: `d.title, p.institution_student_id, p.full_name, t.attempt_number, t.status, t.auto_submitted, r.score::float8, r.max_score::float8,
      r.percentage::float8, r.correct_count, r.wrong_count, r.not_attempted_count, r.time_taken_seconds,
      to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`,
    order: 'd.title, p.institution_student_id, t.attempt_number, r.id',
    header: ['Assessment', 'Student ID', 'Full name', 'Attempt', 'Status', 'Auto-submitted', 'Score', 'Maximum score', 'Percentage', 'Correct', 'Wrong', 'Not attempted', 'Time taken (seconds)', 'Completed at'],
  },
  'staff-actions': {
    from: `FROM staff_actions a JOIN users au ON au.id = a.actor_user_id
      LEFT JOIN institution_student_profiles p ON p.institution_id = a.institution_id AND p.student_user_id = a.subject_student_user_id
      LEFT JOIN institution_units dep ON dep.id = a.department_unit_id
      LEFT JOIN institution_units bat ON bat.id = a.batch_unit_id
      WHERE a.institution_id = $1 AND a.action_type <> 'COUNSELLING_NOTE'`,
    select: `a.action_type, a.title, a.note, a.outcome_note, a.state, a.visibility, p.institution_student_id, dep.name, bat.name, au.email,
      to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'), to_char(a.due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'),
      to_char(a.resolved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'), to_char(a.archived_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`,
    order: 'a.created_at, a.id',
    header: ['Type', 'Title', 'Note', 'Outcome note', 'State', 'Visibility', 'Student ID', 'Department', 'Batch', 'Created by', 'Created at', 'Due', 'Resolved at', 'Archived at'],
  },
  'verification-decisions': {
    from: `FROM (
        SELECT q.student_user_id, 'Qualification' AS record, q.programme_name, NULL::text AS term, NULL::numeric AS result_value, NULL::text AS result_scale,
               NULL::text AS result_letter, NULL::int AS backlogs, q.verification_state, q.verified_at, q.verified_by_user_id, q.id AS record_id, 0 AS seq
        FROM student_qualifications q WHERE q.institution_id = $1 AND q.verification_state IN ('VERIFIED', 'REJECTED') AND q.verified_by_user_id IS NOT NULL
        UNION ALL
        SELECT q.student_user_id, 'Term', q.programme_name, s.label, s.result_value, s.result_scale, s.result_letter, s.backlog_count,
               s.verification_state, s.verified_at, s.verified_by_user_id, s.id, s.sequence
        FROM student_academic_terms s JOIN student_qualifications q ON q.id = s.qualification_id
        WHERE q.institution_id = $1 AND s.verification_state IN ('VERIFIED', 'REJECTED') AND s.verified_by_user_id IS NOT NULL
      ) dec
      JOIN users su ON su.id = dec.student_user_id
      JOIN users vu ON vu.id = dec.verified_by_user_id
      LEFT JOIN institution_student_profiles p ON p.institution_id = $1 AND p.student_user_id = dec.student_user_id`,
    select: `p.institution_student_id, p.full_name, su.email, dec.record, dec.programme_name, dec.term, dec.result_value::float8, dec.result_scale,
      dec.result_letter, dec.backlogs, dec.verification_state, to_char(dec.verified_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'), vu.email`,
    order: 'dec.verified_at, dec.record_id',
    header: ['Student ID', 'Full name', 'Student email', 'Record', 'Programme', 'Term', 'Result', 'Scale', 'Letter', 'Backlogs', 'Decision', 'Decided at', 'Decided by'],
  },
  'counselling-notes': {
    from: `FROM staff_actions a JOIN users au ON au.id = a.actor_user_id
      LEFT JOIN institution_student_profiles p ON p.institution_id = a.institution_id AND p.student_user_id = a.subject_student_user_id
      WHERE a.institution_id = $1 AND a.action_type = 'COUNSELLING_NOTE'`,
    select: "p.institution_student_id, p.full_name, a.title, a.note, a.state, au.email, to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')",
    order: 'a.created_at, a.id',
    header: ['Student ID', 'Full name', 'Title', 'Note', 'State', 'Written by', 'Written at'],
  },
};

/** Rows in each section, for the summary (counselling notes included only as a count). */
export async function countInstitutionExitExport(client: Queryable, institutionId: string): Promise<Readonly<Record<InstitutionExitExportSection, number>>> {
  const counts = {} as Record<InstitutionExitExportSection, number>;
  for (const [section, definition] of Object.entries(exitSections) as [InstitutionExitExportSection, (typeof exitSections)[InstitutionExitExportSection]][]) {
    const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n ${definition.from}`, [institutionId]);
    counts[section] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

/** One part (1-based) of one section: at most `institutionExitExportPartRows` rows, in a stable order. */
export async function readInstitutionExitExportPart(client: Queryable, institutionId: string, section: InstitutionExitExportSection, part: number): Promise<ExitExportFile> {
  const definition = exitSections[section];
  const result = await client.query({
    text: `SELECT ${definition.select} ${definition.from} ORDER BY ${definition.order} LIMIT $2 OFFSET $3`,
    values: [institutionId, institutionExitExportPartRows, (part - 1) * institutionExitExportPartRows],
    rowMode: 'array',
  });
  return { header: definition.header, rows: result.rows as (string | number | boolean | null)[][] };
}
