/**
 * Campus drives with placement-office approval, and college placement policies (EMP-11, ADR-038).
 *
 * The employer side requests a drive for one of its jobs at one college, answers a change request,
 * and cancels or completes it. The college side — owners, admins and placement admins with an
 * institution-wide scope — approves (optionally with a confirmed schedule), rejects, asks for
 * changes, schedules, cancels and completes, and sets the placement policies enforced at apply.
 * Only the college can make a drive live. Department heads read drives; faculty do not.
 *
 * Every write names the drive revision it read, locks the drive FOR UPDATE (the employer side also
 * holds its organisation row FOR SHARE, EMP-SR-15), and writes the state history, an audit row with
 * the organisation and reason code, and a campus_drive.state_changed outbox event in the same
 * transaction; unknown fields are refused. The in-app notice to the other side is best-effort after
 * commit. The college's results view gives suppressed counts once a drive is complete, and names
 * only students who shared that application with the college, inside the reader's scope (INST-09).
 * Design: docs/architecture/campus-drives-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { HiringRuleError } from '@planthepath/hiring';
import {
  availableCampusDriveActions,
  campusDriveReasonCodes,
  campusDriveStates,
  campusDriveTarget,
  placementPolicyRetireReasonCodes,
  placementPolicyTypes,
  venueModes,
  type CampusDriveAction,
  type CampusDriveSide,
  type CampusDriveState,
} from '@planthepath/hiring/src/campus-drives.js';
import { canAddressInstitutionAudience, suppressSmallCount } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { requireActiveEmployer } from './employer-organisation-state.js';
import { assertEmployerTermsAccepted } from './employer-terms-gate.js';
import { lockEmployerForWrite } from './interview-scheduling.js';
import { institutionStaffScopeMemberships, institutionStudentScopeFor, institutionStudentWriteScopeFor } from './institution-student-scope.js';
import { isoOrNull } from './campus-drives.js';
import { recordNotification } from './notify.js';
import { loadDriveCategories } from './institution-placement-register.controller.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };
type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const cursorTimestampPattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

const employerDriveRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;
/** Who may read a college's drives and policies. Faculty have no placement role. */
const institutionDriveReaderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'] as const;
/** Who may decide drives and set policies — and only with an institution-wide scope. */
const institutionDriveDeciderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN'] as const;

/** The audit action for each move, by the state it came from and the one it produced. */
function auditAction(action: CampusDriveAction | 'REQUEST'): string {
  switch (action) {
    case 'REQUEST': return 'campus_drive.requested';
    case 'RESUBMIT': return 'campus_drive.resubmitted';
    case 'APPROVE': return 'campus_drive.approved';
    case 'REJECT': return 'campus_drive.rejected';
    case 'REQUEST_CHANGES': return 'campus_drive.changes_requested';
    case 'SCHEDULE': return 'campus_drive.scheduled';
    case 'CANCEL': return 'campus_drive.cancelled';
    case 'COMPLETE': return 'campus_drive.completed';
  }
}

const driveColumns = sql`cd.id, cd.opportunity_id, cd.employer_id, cd.institution_id, cd.requested_by_user_id, cd.state, cd.revision,
  cd.proposed_start_at, cd.proposed_end_at, cd.scheduled_start_at, cd.scheduled_end_at, cd.venue_mode, cd.employer_note,
  cd.offer_holders_eligible, cd.decided_at, cd.decision_reason_code, cd.decision_note, cd.closed_at, cd.close_reason_code,
  cd.created_at, cd.updated_at, inst.legal_name AS institution_name, emp.legal_name AS employer_name,
  o.lifecycle_state AS opportunity_state, v.title AS opportunity_title, v.application_deadline,
  EXISTS (SELECT 1 FROM organizations standing WHERE standing.id = cd.employer_id AND standing.kind = 'EMPLOYER'
    AND standing.verification_state = 'VERIFIED' AND standing.active) AS employer_in_good_standing`;
const driveFrom = sql`FROM campus_drives cd
  JOIN organizations inst ON inst.id = cd.institution_id
  JOIN organizations emp ON emp.id = cd.employer_id
  JOIN opportunities o ON o.id = cd.opportunity_id
  LEFT JOIN opportunity_versions v ON v.id = o.current_version_id`;

function mapDrive(row: Record<string, unknown>, side: CampusDriveSide, canAct: boolean): Record<string, unknown> {
  const state = String(row.state);
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    opportunityTitle: row.opportunity_title ?? null,
    opportunityState: row.opportunity_state,
    applicationDeadline: isoOrNull(row.application_deadline),
    employerName: row.employer_name,
    employerInGoodStanding: row.employer_in_good_standing === true,
    institutionName: row.institution_name,
    state,
    revision: Number(row.revision),
    proposedStartAt: isoOrNull(row.proposed_start_at),
    proposedEndAt: isoOrNull(row.proposed_end_at),
    scheduledStartAt: isoOrNull(row.scheduled_start_at),
    scheduledEndAt: isoOrNull(row.scheduled_end_at),
    venueMode: row.venue_mode ?? null,
    employerNote: row.employer_note ?? null,
    offerHoldersEligible: row.offer_holders_eligible === true,
    decision: row.decided_at ? { reasonCode: row.decision_reason_code ?? null, note: row.decision_note ?? null, decidedAt: isoOrNull(row.decided_at) } : null,
    closedAt: isoOrNull(row.closed_at),
    closeReasonCode: row.close_reason_code ?? null,
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    availableActions: canAct ? availableCampusDriveActions(side, state) : [],
    ...(side === 'EMPLOYER' ? { applicationCount: Number(row.application_count ?? 0) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function bodyRecord(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid('UNKNOWN_FIELD', correlationId);
  return record;
}
function readRevision(record: Record<string, unknown>, correlationId: string): number {
  const value = record.revision;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid('INVALID_REVISION', correlationId, 'revision');
  return value;
}
function readTimestamp(record: Record<string, unknown>, field: string, correlationId: string): string | null {
  const value = record[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isoTimestampPattern.test(value) || Number.isNaN(Date.parse(value))) throw invalid('INVALID_TIMESTAMP', correlationId, field);
  return new Date(value).toISOString();
}
function readWindow(record: Record<string, unknown>, startField: string, endField: string, correlationId: string): [string | null, string | null] {
  const start = readTimestamp(record, startField, correlationId);
  const end = readTimestamp(record, endField, correlationId);
  if (end && (!start || Date.parse(end) <= Date.parse(start))) throw invalid('INVALID_SCHEDULE', correlationId, endField);
  return [start, end];
}
function readText(record: Record<string, unknown>, field: string, max: number, correlationId: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid('INVALID_FIELD', correlationId, field);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max || /^[=+@-]/.test(trimmed)) throw invalid('INVALID_FIELD', correlationId, field);
  return trimmed;
}
function readVenue(record: Record<string, unknown>, correlationId: string): string | null {
  const value = record.venueMode;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !(venueModes as readonly string[]).includes(value)) throw invalid('INVALID_VENUE_MODE', correlationId, 'venueMode');
  return value;
}
function readBoolean(record: Record<string, unknown>, field: string, correlationId: string): boolean | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid('INVALID_FIELD', correlationId, field);
  return value;
}
function readReason(record: Record<string, unknown>, allowed: readonly string[] | null, correlationId: string): string | null {
  const value = record.reasonCode;
  if (allowed === null) {
    if (value !== undefined && value !== null) throw invalid('UNKNOWN_FIELD', correlationId);
    return null;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid('INVALID_REASON_CODE', correlationId, 'reasonCode');
  return value;
}
function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Shared write path
// ---------------------------------------------------------------------------

interface TransitionInput {
  readonly side: CampusDriveSide;
  readonly action: CampusDriveAction;
  readonly driveId: string;
  readonly ownerSql: SQL;
  readonly organizationId: string;
  readonly revision: number;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly schedule?: { readonly start: string | null; readonly end: string | null };
  readonly proposal?: { readonly start: string | null; readonly end: string | null };
  readonly venueMode?: string | null;
  readonly offerHoldersEligible?: boolean | null;
}

async function writeHistory(tx: Executor, ids: ApiIdGenerator, input: {
  driveId: string; from: CampusDriveState | null; to: CampusDriveState; actorId: string; side: CampusDriveSide; reasonCode: string | null; note: string | null;
}): Promise<void> {
  await tx.execute(sql`
    INSERT INTO campus_drive_state_history (id, campus_drive_id, from_state, to_state, actor_user_id, actor_side, reason_code, note, scheduled_start_at, scheduled_end_at)
    SELECT ${ids.uuid()}::uuid, cd.id, ${input.from}, ${input.to}, ${input.actorId}::uuid, ${input.side}, ${input.reasonCode}, ${input.note},
           cd.scheduled_start_at, cd.scheduled_end_at
    FROM campus_drives cd WHERE cd.id = ${input.driveId}::uuid
  `);
}

async function writeAuditAndEvent(tx: Executor, ids: ApiIdGenerator, context: Context, input: {
  action: CampusDriveAction | 'REQUEST'; drive: { id: string; opportunityId: string; employerId: string; institutionId: string };
  organizationId: string; side: CampusDriveSide; from: CampusDriveState | null; to: CampusDriveState; reasonCode: string | null; revision: number;
}): Promise<void> {
  const actorId = context.authorization.principal.userId;
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${ids.uuid()}::uuid, ${actorId}::uuid, ${auditAction(input.action)}, 'campus_drive', ${input.drive.id}::uuid, ${input.organizationId}::uuid,
            'SUCCESS', ${context.correlationId}, ${JSON.stringify({
              side: input.side, fromState: input.from, toState: input.to, revision: input.revision,
              opportunityId: input.drive.opportunityId, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            })}::jsonb)
  `);
  const payload: Record<string, unknown> = {
    campusDriveId: input.drive.id, opportunityId: input.drive.opportunityId, employerId: input.drive.employerId, institutionId: input.drive.institutionId,
    toState: input.to, actorSide: input.side,
    ...(input.from ? { fromState: input.from } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${ids.uuid()}::uuid, 'campus_drive', ${input.drive.id}, 'campus_drive.state_changed', ${JSON.stringify(payload)}::jsonb,
            ${actorId}::uuid, ${input.organizationId}::uuid, ${context.correlationId})
  `);
}

/** One drive move, in one transaction. Returns the drive as the caller's side sees it, plus who to tell. */
async function transitionDrive(db: PersistenceDb, ids: ApiIdGenerator, context: Context, input: TransitionInput, lockOrganisation: (tx: Executor) => Promise<void>): Promise<{ drive: Record<string, unknown>; notice: DriveNotice }> {
  const actorId = context.authorization.principal.userId;
  return db.transaction(async (tx) => {
    await lockOrganisation(tx);
    const locked = await tx.execute(sql`
      SELECT id, state, revision, opportunity_id, employer_id, institution_id, requested_by_user_id
      FROM campus_drives WHERE id = ${input.driveId}::uuid AND ${input.ownerSql}
      FOR UPDATE
    `) as QueryResult<{ id: string; state: CampusDriveState; revision: number; opportunity_id: string; employer_id: string; institution_id: string; requested_by_user_id: string }>;
    const [current] = locked.rows;
    if (!current) throw forbidden(context.correlationId);
    if (Number(current.revision) !== input.revision) throw new ConflictException(driveError('CAMPUS_DRIVE_CHANGED', context.correlationId));
    let target: CampusDriveState;
    try {
      target = campusDriveTarget(input.side, current.state, input.action, Boolean(input.schedule?.start));
    } catch (error) {
      if (error instanceof HiringRuleError) throw invalid(error.code, context.correlationId);
      throw error;
    }
    if (input.action === 'SCHEDULE' && !input.schedule?.start) throw invalid('INVALID_SCHEDULE', context.correlationId, 'scheduledStartAt');
    // The college can only put a drive in front of its students for an employer in good standing and a job that still exists.
    if (target === 'APPROVED' || target === 'SCHEDULED') {
      const checks = await tx.execute(sql`
        SELECT EXISTS (SELECT 1 FROM organizations org WHERE org.id = ${current.employer_id}::uuid AND org.kind = 'EMPLOYER'
                 AND org.verification_state = 'VERIFIED' AND org.active) AS employer_ok,
               EXISTS (SELECT 1 FROM opportunities o WHERE o.id = ${current.opportunity_id}::uuid AND o.lifecycle_state NOT IN ('WITHDRAWN', 'ARCHIVED')) AS job_ok
      `) as QueryResult<{ employer_ok: boolean; job_ok: boolean }>;
      if (!checks.rows[0]?.employer_ok) throw new ConflictException(driveError('CAMPUS_DRIVE_EMPLOYER_NOT_IN_GOOD_STANDING', context.correlationId));
      if (!checks.rows[0]?.job_ok) throw new ConflictException(driveError('CAMPUS_DRIVE_OPPORTUNITY_UNAVAILABLE', context.correlationId));
    }
    const decision = input.side === 'INSTITUTION' && ['APPROVE', 'REJECT', 'REQUEST_CHANGES', 'SCHEDULE'].includes(input.action);
    const closes = target === 'CANCELLED' || target === 'COMPLETED';
    const schedule = input.schedule;
    const proposal = input.proposal;
    await tx.execute(sql`
      UPDATE campus_drives SET
        state = ${target},
        revision = revision + 1,
        updated_at = now(),
        scheduled_start_at = ${schedule?.start ? sql`${schedule.start}::timestamptz` : sql`scheduled_start_at`},
        scheduled_end_at = ${schedule?.start ? sql`${schedule.end}::timestamptz` : sql`scheduled_end_at`},
        proposed_start_at = ${proposal ? sql`${proposal.start}::timestamptz` : sql`proposed_start_at`},
        proposed_end_at = ${proposal ? sql`${proposal.end}::timestamptz` : sql`proposed_end_at`},
        employer_note = ${input.action === 'RESUBMIT' ? sql`${input.note}` : sql`employer_note`},
        venue_mode = ${input.venueMode !== undefined && input.venueMode !== null ? sql`${input.venueMode}` : sql`venue_mode`},
        offer_holders_eligible = ${typeof input.offerHoldersEligible === 'boolean' ? sql`${input.offerHoldersEligible}` : sql`offer_holders_eligible`},
        decided_by_user_id = ${decision ? sql`${actorId}::uuid` : sql`decided_by_user_id`},
        decided_at = ${decision ? sql`now()` : sql`decided_at`},
        decision_reason_code = ${decision ? sql`${input.reasonCode}` : sql`decision_reason_code`},
        decision_note = ${decision && input.action !== 'SCHEDULE' ? sql`${input.note}` : sql`decision_note`},
        closed_by_user_id = ${closes ? sql`${actorId}::uuid` : sql`closed_by_user_id`},
        closed_at = ${closes ? sql`now()` : sql`closed_at`},
        close_reason_code = ${closes ? sql`${input.reasonCode}` : sql`close_reason_code`}
      WHERE id = ${input.driveId}::uuid
    `);
    await writeHistory(tx, ids, { driveId: input.driveId, from: current.state, to: target, actorId, side: input.side, reasonCode: input.reasonCode, note: input.note });
    const drive = { id: current.id, opportunityId: current.opportunity_id, employerId: current.employer_id, institutionId: current.institution_id };
    await writeAuditAndEvent(tx, ids, context, {
      action: input.action, drive, organizationId: input.organizationId, side: input.side, from: current.state, to: target,
      reasonCode: input.reasonCode, revision: input.revision + 1,
    });
    const row = await readDrive(tx, sql`cd.id = ${input.driveId}::uuid`, input.side === 'EMPLOYER');
    return {
      drive: mapDrive(row!, input.side, true),
      notice: { side: input.side, to: target, drive, requestedBy: current.requested_by_user_id, title: String(row?.opportunity_title ?? 'a role'),
        institutionName: String(row?.institution_name ?? 'The college'), employerName: String(row?.employer_name ?? 'An employer') },
    };
  });
}

async function readDrive(db: Executor, where: SQL, withApplicationCount: boolean): Promise<Record<string, unknown> | undefined> {
  const rows = await db.execute(sql`
    SELECT ${driveColumns}
      ${withApplicationCount ? sql`, (SELECT count(*)::int FROM campus_drive_applications l JOIN applications a ON a.id = l.application_id
          WHERE l.campus_drive_id = cd.id AND a.state <> 'DRAFT') AS application_count` : sql``}
    ${driveFrom}
    WHERE ${where}
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows[0];
}

interface DriveNotice {
  readonly side: CampusDriveSide;
  readonly to: CampusDriveState;
  readonly drive: { readonly id: string; readonly institutionId: string };
  readonly requestedBy: string;
  readonly title: string;
  readonly institutionName: string;
  readonly employerName: string;
}

const stateWords: Readonly<Record<CampusDriveState, string>> = {
  REQUESTED: 'asked for', CHANGES_REQUESTED: 'asked for changes to', APPROVED: 'approved', SCHEDULED: 'scheduled',
  REJECTED: 'declined', COMPLETED: 'completed', CANCELLED: 'cancelled',
};

/**
 * Best-effort, after commit (notify.ts): the requester hears about the college's moves; the
 * college's placement staff hear about the employer's. Never blocks or undoes the write.
 */
async function sendDriveNotice(db: PersistenceDb, ids: ApiIdGenerator, notice: DriveNotice): Promise<void> {
  try {
    if (notice.side === 'INSTITUTION') {
      await recordNotification(db, ids, {
        userId: notice.requestedBy, kind: 'SYSTEM', title: 'Campus drive update',
        body: `${notice.institutionName} ${stateWords[notice.to]} your campus drive for ${notice.title}.`,
        data: { campusDriveId: notice.drive.id },
      });
      return;
    }
    const staff = await db.execute(sql`
      SELECT DISTINCT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${notice.drive.institutionId}::uuid AND m.state = 'ACTIVE' AND u.state = 'ACTIVE'
        AND m.role IN ('INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN')
      LIMIT 50
    `) as QueryResult<{ user_id: string }>;
    for (const row of staff.rows) {
      await recordNotification(db, ids, {
        userId: row.user_id, kind: 'SYSTEM', title: 'Campus drive update',
        body: `${notice.employerName} ${stateWords[notice.to]} a campus drive for ${notice.title}.`,
        data: { campusDriveId: notice.drive.id },
      });
    }
  } catch {
    // Notification failures never undo a drive decision.
  }
}

async function readHistory(db: Executor, driveId: string): Promise<Record<string, unknown>[]> {
  const rows = await db.execute(sql`
    SELECT from_state, to_state, actor_side, reason_code, note, scheduled_start_at, scheduled_end_at, created_at
    FROM campus_drive_state_history WHERE campus_drive_id = ${driveId}::uuid ORDER BY created_at, id LIMIT 200
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.map((row) => ({
    fromState: row.from_state ?? null, toState: row.to_state, actorSide: row.actor_side, reasonCode: row.reason_code ?? null,
    note: row.note ?? null, scheduledStartAt: isoOrNull(row.scheduled_start_at), scheduledEndAt: isoOrNull(row.scheduled_end_at), at: isoOrNull(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Employer side
// ---------------------------------------------------------------------------

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class EmployerCampusDrivesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** Colleges an employer may ask: verified and active institutions, by name. No people, no counts. */
  @Get('/employers/:employerId/campus-drive-institutions')
  async institutions(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerDriveRoles);
    const search = typeof q === 'string' && q.trim() ? `%${q.trim().slice(0, 80).replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
    const rows = await this.db.execute(sql`
      SELECT org.id, org.legal_name, profile.city
      FROM organizations org LEFT JOIN organization_profiles profile ON profile.organization_id = org.id
      WHERE org.kind = 'INSTITUTION' AND org.verification_state = 'VERIFIED' AND org.active
        AND (${search}::text IS NULL OR org.legal_name ILIKE ${search})
      ORDER BY org.legal_name, org.id LIMIT 50
    `) as QueryResult<{ id: string; legal_name: string; city: string | null }>;
    return { institutions: rows.rows.map((row) => ({ id: row.id, name: row.legal_name, city: row.city ?? null })), correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/campus-drives')
  async list(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Query('opportunityId') opportunityId?: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerDriveRoles);
    if (opportunityId !== undefined && !uuidPattern.test(opportunityId)) throw invalid('INVALID_QUERY', context.correlationId, 'opportunityId');
    const rows = await this.db.execute(sql`
      SELECT ${driveColumns},
        (SELECT count(*)::int FROM campus_drive_applications l JOIN applications a ON a.id = l.application_id
          WHERE l.campus_drive_id = cd.id AND a.state <> 'DRAFT') AS application_count
      ${driveFrom}
      WHERE cd.employer_id = ${employerId}::uuid
        AND (${opportunityId ?? null}::uuid IS NULL OR cd.opportunity_id = ${opportunityId ?? null}::uuid)
      ORDER BY cd.created_at DESC, cd.id DESC LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { drives: rows.rows.map((row) => mapDrive(row, 'EMPLOYER', true)), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/campus-drives')
  async requestDrive(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.publish', employerDriveRoles);
    const jobId = requireUuid(opportunityId, context.correlationId);
    const record = bodyRecord(body, ['institutionId', 'proposedStartAt', 'proposedEndAt', 'venueMode', 'note'], context.correlationId);
    const institutionId = typeof record.institutionId === 'string' && uuidPattern.test(record.institutionId) ? record.institutionId.toLowerCase() : null;
    if (!institutionId) throw invalid('INVALID_INSTITUTION', context.correlationId, 'institutionId');
    const [start, end] = readWindow(record, 'proposedStartAt', 'proposedEndAt', context.correlationId);
    const venueMode = readVenue(record, context.correlationId);
    const note = readText(record, 'note', 1000, context.correlationId);
    const actorId = context.authorization.principal.userId;
    const driveId = this.ids.uuid();

    const result = await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.publish', context.correlationId);
      // EMP-16: a drive puts the job in front of a college's students, so it waits for an owner to
      // accept the current employer terms, as publishing does.
      await assertEmployerTermsAccepted(tx, employerId, context.correlationId);
      const job = await tx.execute(sql`
        SELECT lifecycle_state FROM opportunities WHERE id = ${jobId}::uuid AND employer_id = ${employerId}::uuid FOR SHARE
      `) as QueryResult<{ lifecycle_state: string }>;
      if (!job.rows[0]) throw forbidden(context.correlationId);
      if (!['DRAFT', 'PUBLISHED', 'PAUSED'].includes(job.rows[0].lifecycle_state)) throw invalid('CAMPUS_DRIVE_OPPORTUNITY_UNAVAILABLE', context.correlationId);
      const college = await tx.execute(sql`
        SELECT id FROM organizations WHERE id = ${institutionId}::uuid AND kind = 'INSTITUTION' AND verification_state = 'VERIFIED' AND active
      `) as QueryResult<{ id: string }>;
      if (!college.rows[0]) throw invalid('CAMPUS_DRIVE_INSTITUTION_UNAVAILABLE', context.correlationId, 'institutionId');
      const inserted = await tx.execute(sql`
        INSERT INTO campus_drives (id, employer_id, opportunity_id, institution_id, requested_by_user_id, state, proposed_start_at, proposed_end_at, venue_mode, employer_note)
        VALUES (${driveId}::uuid, ${employerId}::uuid, ${jobId}::uuid, ${institutionId}::uuid, ${actorId}::uuid, 'REQUESTED',
                ${start}::timestamptz, ${end}::timestamptz, ${venueMode}, ${note})
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (inserted.rows.length !== 1) throw new ConflictException(driveError('CAMPUS_DRIVE_ALREADY_OPEN', context.correlationId));
      await writeHistory(tx, this.ids, { driveId, from: null, to: 'REQUESTED', actorId, side: 'EMPLOYER', reasonCode: null, note });
      const drive = { id: driveId, opportunityId: jobId, employerId, institutionId };
      await writeAuditAndEvent(tx, this.ids, context, { action: 'REQUEST', drive, organizationId: employerId, side: 'EMPLOYER', from: null, to: 'REQUESTED', reasonCode: null, revision: 1 });
      const row = await readDrive(tx, sql`cd.id = ${driveId}::uuid`, true);
      return {
        drive: mapDrive(row!, 'EMPLOYER', true),
        notice: { side: 'EMPLOYER' as const, to: 'REQUESTED' as const, drive, requestedBy: actorId, title: String(row?.opportunity_title ?? 'a role'),
          institutionName: String(row?.institution_name ?? 'The college'), employerName: String(row?.employer_name ?? 'An employer') },
      };
    });
    await sendDriveNotice(this.db, this.ids, result.notice);
    return { drive: result.drive, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/campus-drives/:driveId/resubmit')
  async resubmit(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.employerMove(request, employerId, driveId, 'RESUBMIT', body, ['revision', 'proposedStartAt', 'proposedEndAt', 'venueMode', 'note']);
  }

  @Post('/employers/:employerId/campus-drives/:driveId/cancel')
  async cancel(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.employerMove(request, employerId, driveId, 'CANCEL', body, ['revision', 'reasonCode', 'note']);
  }

  @Post('/employers/:employerId/campus-drives/:driveId/complete')
  async complete(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.employerMove(request, employerId, driveId, 'COMPLETE', body, ['revision', 'note']);
  }

  @Get('/employers/:employerId/campus-drives/:driveId/history')
  async history(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('driveId') driveId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerDriveRoles);
    const id = requireUuid(driveId, context.correlationId);
    const owned = await this.db.execute(sql`SELECT 1 FROM campus_drives WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid`) as QueryResult<unknown>;
    if (owned.rows.length !== 1) throw forbidden(context.correlationId);
    return { history: await readHistory(this.db, id), correlationId: context.correlationId };
  }

  private async employerMove(request: ProtectedHttpRequest, employerId: string, driveId: string, action: CampusDriveAction, body: unknown, allowed: readonly string[]): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.publish', employerDriveRoles);
    const id = requireUuid(driveId, context.correlationId);
    const record = bodyRecord(body, allowed, context.correlationId);
    const revision = readRevision(record, context.correlationId);
    const reasonCode = readReason(record, campusDriveReasonCodes('EMPLOYER', action), context.correlationId);
    const note = readText(record, 'note', 1000, context.correlationId);
    const proposal = action === 'RESUBMIT' ? (([start, end]) => ({ start, end }))(readWindow(record, 'proposedStartAt', 'proposedEndAt', context.correlationId)) : undefined;
    const venueMode = action === 'RESUBMIT' ? readVenue(record, context.correlationId) : undefined;
    const result = await transitionDrive(this.db, this.ids, context, {
      side: 'EMPLOYER', action, driveId: id, ownerSql: sql`employer_id = ${employerId}::uuid`, organizationId: employerId,
      revision, reasonCode, note, ...(proposal ? { proposal } : {}), ...(venueMode !== undefined ? { venueMode } : {}),
    }, async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.publish', context.correlationId);
      // EMP-16: resubmitting asks the college again to put the job before its students.
      if (action === 'RESUBMIT') await assertEmployerTermsAccepted(tx, employerId, context.correlationId);
    });
    await sendDriveNotice(this.db, this.ids, result.notice);
    return { drive: result.drive, correlationId: context.correlationId };
  }
}

// ---------------------------------------------------------------------------
// College side
// ---------------------------------------------------------------------------

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionCampusDrivesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/institutions/:institutionId/campus-drives')
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string,
    @Query('state') state?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    if (state !== undefined && state !== '' && !(campusDriveStates as readonly string[]).includes(state)) throw invalid('INVALID_QUERY', context.correlationId, 'state');
    const size = readLimit(limit, context.correlationId);
    const after = readCursor(cursor, context.correlationId);
    const canDecide = await this.canDecide(request, id);
    const rows = await this.db.execute(sql`
      SELECT ${driveColumns}, cd.created_at::text AS cursor_at
      ${driveFrom}
      WHERE cd.institution_id = ${id}::uuid
        AND (${state || null}::text IS NULL OR cd.state = ${state || null})
        ${after ? sql`AND (cd.created_at, cd.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``}
      ORDER BY cd.created_at DESC, cd.id DESC
      LIMIT ${size + 1}
    `) as QueryResult<Record<string, unknown>>;
    const page = rows.rows.slice(0, size);
    const last = page.at(-1);
    // INST-12: the college's own category label, college side only (never shown to employers or students).
    const categories = await loadDriveCategories(this.db, id, page.map((row) => String(row.id)));
    return {
      drives: page.map((row) => ({ ...mapDrive(row, 'INSTITUTION', canDecide), category: categories.get(String(row.id)) ?? null })),
      canDecide,
      nextCursor: rows.rows.length > size && last ? Buffer.from(`${String(last.cursor_at)}|${String(last.id)}`).toString('base64url') : null,
      correlationId: context.correlationId,
    };
  }

  @Get('/institutions/:institutionId/campus-drives/:driveId/history')
  async history(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const owned = await this.db.execute(sql`SELECT 1 FROM campus_drives WHERE id = ${drive}::uuid AND institution_id = ${id}::uuid`) as QueryResult<unknown>;
    if (owned.rows.length !== 1) throw forbidden(context.correlationId);
    return { history: await readHistory(this.db, drive), correlationId: context.correlationId };
  }

  /**
   * Drive results for the college. Counts only once the drive is complete (a count that moves day by
   * day can be differenced to follow one student), each through the one suppression rule, and only
   * over applications the student shared with the college (EMP-15, aligned with INST-12). Named
   * rows only for applications the student shared with the college and has not revoked, of a
   * current student inside the reader's scope — stage and offer existence only, never terms.
   */
  @Get('/institutions/:institutionId/campus-drives/:driveId/results')
  async results(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const found = await this.db.execute(sql`SELECT state FROM campus_drives WHERE id = ${drive}::uuid AND institution_id = ${id}::uuid`) as QueryResult<{ state: string }>;
    if (!found.rows[0]) throw forbidden(context.correlationId);
    const scope = await institutionStudentScopeFor(this.db, request, id, institutionDriveReaderRoles);
    const completed = found.rows[0].state === 'COMPLETED';
    const counts = completed ? await this.db.execute(sql`
      SELECT count(*)::int AS applied,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM offers f WHERE f.application_id = a.id AND f.state <> 'DRAFT'))::int AS offered,
             count(*) FILTER (WHERE a.state = 'HIRED' OR EXISTS (SELECT 1 FROM offers f WHERE f.application_id = a.id AND f.state = 'ACCEPTED'))::int AS selected
      FROM campus_drive_applications l JOIN applications a ON a.id = l.application_id
      WHERE l.campus_drive_id = ${drive}::uuid AND a.state <> 'DRAFT'
        -- EMP-15, as INST-12's register recommends: the college counts only applications the
        -- student shared with it, the same consent its named rows need.
        AND a.institution_visibility_granted_at IS NOT NULL AND a.institution_visibility_revoked_at IS NULL
    `) as QueryResult<{ applied: number; offered: number; selected: number }> : null;
    const named = await this.db.execute(sql`
      SELECT sp.full_name, sp.institution_student_id, a.state AS application_state, a.updated_at, latest.state AS offer_state
      FROM campus_drive_applications l
      JOIN applications a ON a.id = l.application_id
      JOIN institution_student_profiles sp ON sp.institution_id = ${id}::uuid AND sp.student_user_id = a.student_user_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN LATERAL (
        SELECT f.state FROM offers f WHERE f.application_id = a.id AND f.state <> 'DRAFT' ORDER BY f.created_at DESC, f.id DESC LIMIT 1
      ) latest ON true
      WHERE l.campus_drive_id = ${drive}::uuid AND a.state <> 'DRAFT'
        AND a.institution_visibility_granted_at IS NOT NULL AND a.institution_visibility_revoked_at IS NULL
        AND sp.status = 'ACTIVE' AND u.state = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM institution_relationships ir
          WHERE ir.institution_id = ${id}::uuid AND ir.student_user_id = a.student_user_id AND ir.state IN ('ACTIVE', 'VERIFIED')
            AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))
        AND ${institutionStudentScopeSql(scope, 'sp')}
      ORDER BY sp.full_name, sp.institution_student_id
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    await this.db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, 'institution.campus_drive_results.read', 'campus_drive',
              ${drive}::uuid, ${id}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify({ namedCount: named.rows.length, countsShown: completed })}::jsonb)
    `);
    const count = counts?.rows[0];
    return {
      results: {
        driveState: found.rows[0].state,
        counts: count ? { applied: suppressSmallCount(count.applied), offered: suppressSmallCount(count.offered), selected: suppressSmallCount(count.selected) } : null,
        named: named.rows.map((row) => ({
          fullName: row.full_name, institutionStudentId: row.institution_student_id ?? null,
          applicationState: row.application_state, offerState: row.offer_state ?? null, updatedAt: isoOrNull(row.updated_at),
        })),
      },
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/approve')
  async approve(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'APPROVE', body, ['revision', 'scheduledStartAt', 'scheduledEndAt', 'venueMode', 'offerHoldersEligible', 'note']);
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/reject')
  async reject(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'REJECT', body, ['revision', 'reasonCode', 'note']);
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/request-changes')
  async requestChanges(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'REQUEST_CHANGES', body, ['revision', 'reasonCode', 'note']);
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/schedule')
  async schedule(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'SCHEDULE', body, ['revision', 'scheduledStartAt', 'scheduledEndAt', 'venueMode', 'offerHoldersEligible']);
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/cancel')
  async cancel(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'CANCEL', body, ['revision', 'reasonCode', 'note']);
  }

  @Post('/institutions/:institutionId/campus-drives/:driveId/complete')
  async complete(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.collegeMove(request, institutionId, driveId, 'COMPLETE', body, ['revision', 'note']);
  }

  @Get('/institutions/:institutionId/placement-policies')
  async policies(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const rows = await this.db.execute(sql`
      SELECT id, policy_type, allow_drive_exceptions, effective_from, effective_to, state, note, retired_at, retire_reason_code, created_at,
             (state = 'ACTIVE' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())) AS in_force
      FROM institution_placement_policies WHERE institution_id = ${id}::uuid
      ORDER BY (state = 'ACTIVE') DESC, created_at DESC, id DESC LIMIT 50
    `) as QueryResult<Record<string, unknown>>;
    return {
      policies: rows.rows.map((row) => ({
        id: row.id, policyType: row.policy_type, allowDriveExceptions: row.allow_drive_exceptions === true,
        effectiveFrom: isoOrNull(row.effective_from), effectiveTo: isoOrNull(row.effective_to), state: row.state, inForce: row.in_force === true,
        note: row.note ?? null, retiredAt: isoOrNull(row.retired_at), retireReasonCode: row.retire_reason_code ?? null, createdAt: isoOrNull(row.created_at),
      })),
      canManage: await this.canDecide(request, id),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/placement-policies')
  async setPolicy(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.decider(request, institutionId);
    const record = bodyRecord(body, ['policyType', 'allowDriveExceptions', 'effectiveFrom', 'effectiveTo', 'note'], context.correlationId);
    const policyType = record.policyType;
    if (typeof policyType !== 'string' || !(placementPolicyTypes as readonly string[]).includes(policyType)) throw invalid('INVALID_POLICY_TYPE', context.correlationId, 'policyType');
    const allowDriveExceptions = readBoolean(record, 'allowDriveExceptions', context.correlationId) ?? false;
    const [from, to] = readWindow(record, 'effectiveFrom', 'effectiveTo', context.correlationId);
    if (to && !from) throw invalid('INVALID_SCHEDULE', context.correlationId, 'effectiveTo');
    const note = readText(record, 'note', 500, context.correlationId);
    const policyId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO institution_placement_policies (id, institution_id, policy_type, allow_drive_exceptions, effective_from, effective_to, note, set_by_user_id)
        VALUES (${policyId}::uuid, ${id}::uuid, ${policyType}, ${allowDriveExceptions}, ${from ? sql`${from}::timestamptz` : sql`now()`},
                ${to}::timestamptz, ${note}, ${context.authorization.principal.userId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (inserted.rows.length !== 1) throw new ConflictException(driveError('PLACEMENT_POLICY_ALREADY_ACTIVE', context.correlationId));
      await this.auditPolicy(tx, context, id, policyId, 'institution.placement_policy.set', { policyType, allowDriveExceptions, effectiveFrom: from, effectiveTo: to });
    });
    return { policy: { id: policyId, policyType, allowDriveExceptions, state: 'ACTIVE' }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/placement-policies/:policyId/retire')
  async retirePolicy(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('policyId') policyId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.decider(request, institutionId);
    const policy = requireUuid(policyId, context.correlationId);
    const record = bodyRecord(body, ['reasonCode'], context.correlationId);
    const reasonCode = readReason(record, placementPolicyRetireReasonCodes, context.correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT state FROM institution_placement_policies WHERE id = ${policy}::uuid AND institution_id = ${id}::uuid FOR UPDATE
      `) as QueryResult<{ state: string }>;
      if (!found.rows[0]) throw forbidden(context.correlationId);
      if (found.rows[0].state !== 'ACTIVE') throw invalid('PLACEMENT_POLICY_NOT_ACTIVE', context.correlationId);
      await tx.execute(sql`
        UPDATE institution_placement_policies SET state = 'RETIRED', retired_at = now(),
          retired_by_user_id = ${context.authorization.principal.userId}::uuid, retire_reason_code = ${reasonCode}
        WHERE id = ${policy}::uuid
      `);
      await this.auditPolicy(tx, context, id, policy, 'institution.placement_policy.retired', { reasonCode });
    });
    return { policy: { id: policy, state: 'RETIRED' }, correlationId: context.correlationId };
  }

  private async auditPolicy(tx: Executor, context: Context, institutionId: string, policyId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, ${action}, 'institution_placement_policy', ${policyId}::uuid,
              ${institutionId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify(detail)}::jsonb)
    `);
  }

  private async collegeMove(request: ProtectedHttpRequest, institutionId: string, driveId: string, action: CampusDriveAction, body: unknown, allowed: readonly string[]): Promise<Record<string, unknown>> {
    const { context, id } = await this.decider(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const record = bodyRecord(body, allowed, context.correlationId);
    const revision = readRevision(record, context.correlationId);
    const reasonCode = readReason(record, campusDriveReasonCodes('INSTITUTION', action), context.correlationId);
    const note = readText(record, 'note', 1000, context.correlationId);
    const withSchedule = action === 'APPROVE' || action === 'SCHEDULE';
    const schedule = withSchedule ? (([start, end]) => ({ start, end }))(readWindow(record, 'scheduledStartAt', 'scheduledEndAt', context.correlationId)) : undefined;
    const venueMode = withSchedule ? readVenue(record, context.correlationId) : undefined;
    const offerHoldersEligible = withSchedule ? readBoolean(record, 'offerHoldersEligible', context.correlationId) : undefined;
    const result = await transitionDrive(this.db, this.ids, context, {
      side: 'INSTITUTION', action, driveId: drive, ownerSql: sql`institution_id = ${id}::uuid`, organizationId: id,
      revision, reasonCode, note,
      ...(schedule ? { schedule } : {}), ...(venueMode !== undefined ? { venueMode } : {}), ...(offerHoldersEligible !== undefined ? { offerHoldersEligible } : {}),
    }, async () => undefined);
    await sendDriveNotice(this.db, this.ids, result.notice);
    return { drive: result.drive, correlationId: context.correlationId };
  }

  /** A reader: an ACTIVE membership in this college in one of the reader roles. */
  private reader(request: ProtectedHttpRequest, institutionId: string): { context: Context; id: string } {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    if (institutionStaffScopeMemberships(request, id, institutionDriveReaderRoles).length === 0) throw forbidden(context.correlationId);
    return { context, id };
  }

  /**
   * A decider: an owner, admin or placement admin whose write scope covers the whole college. A
   * drive reaches every student there, so a placement admin narrowed to one campus or department
   * reads drives but cannot decide them (INST-02 / INST-SR-02).
   */
  private async decider(request: ProtectedHttpRequest, institutionId: string): Promise<{ context: Context; id: string }> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    if (institutionStaffScopeMemberships(request, id, institutionDriveDeciderRoles).length === 0) throw forbidden(context.correlationId);
    if (!await this.canDecide(request, id)) {
      throw new ForbiddenException({ error: { code: 'INSTITUTION_WIDE_SCOPE_REQUIRED', message: 'Access denied', correlationId: context.correlationId } });
    }
    return { context, id };
  }

  private async canDecide(request: ProtectedHttpRequest, institutionId: string): Promise<boolean> {
    if (institutionStaffScopeMemberships(request, institutionId, institutionDriveDeciderRoles).length === 0) return false;
    const scope = await institutionStudentWriteScopeFor(this.db, request, institutionId, institutionDriveDeciderRoles);
    return canAddressInstitutionAudience(scope, null);
  }
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw invalid('INVALID_QUERY', correlationId, 'limit');
  return Number(value);
}
function readCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [at, id] = decoded.split('|');
  if (!at || !id || !cursorTimestampPattern.test(at) || !uuidPattern.test(id)) throw invalid('INVALID_QUERY', correlationId, 'cursor');
  return [at, id];
}
function driveError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}
function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}
function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
