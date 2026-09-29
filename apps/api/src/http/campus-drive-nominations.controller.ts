/**
 * Placement-office nominations with student consent (INST-14, decision 10.2 #7).
 *
 * A college's placement office may put a student forward for one of its live campus drives, but a
 * nomination is only an invitation from the college to its own student: it creates no application,
 * no snapshot and no employer grant, and no employer route reads it. The student sees who nominated
 * them, for which employer and job, and exactly what applying would share (the EMP-07 preview); only
 * if they opt in does the ordinary apply path run (StudentHiringController, with the nomination
 * attached), and the employer then sees an application whose source is "Nominated by placement office".
 *
 * College side. Writers are EMP-11's drive deciders — owner, admin or placement admin with an
 * institution-wide write scope (NONE: SCOPE_REQUIRED; narrowed: INSTITUTION_WIDE_SCOPE_REQUIRED).
 * They read the eligible list (the EMP-06 evaluator's outcome only, never figures, and nothing from
 * applications the student has not shared), nominate eligible students with a reason code, and
 * cancel a nomination the student has not accepted. Readers (deciders and department heads, within
 * their INST-02 read scope) see each nominated student as OPTED_IN, NOT_OPTED_IN, CANCELLED or CLOSED
 * — a decline is recorded but reads the same as no answer — and a suppressed summary. Faculty: 403.
 * Every write locks the drive FOR SHARE and the nomination FOR UPDATE, refuses unknown fields and
 * writes an audit row in the same transaction; the student's in-app notice is best-effort after commit.
 *
 * Student side. Their own nominations, and decline. Opt-in lives with apply in
 * student-hiring.controller.ts; withdrawing the application withdraws the consent.
 * Design: docs/architecture/campus-drive-nominations-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { canAddressInstitutionAudience, suppressAggregateTable, type SuppressedCount } from '@planthepath/authorization/src/index.js';
import { evaluateStudentEligibility } from '@planthepath/hiring/src/eligibility.js';
import { liveCampusDriveStates } from '@planthepath/hiring/src/campus-drives.js';
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
import { institutionStaffScopeMemberships, institutionStudentScopeFor, institutionStudentWriteScopeFor } from './institution-student-scope.js';
import { isoOrNull, readStudentCampusDrives } from './campus-drives.js';
import { readEligibilityRecordsFor, readVersionEligibilityRules } from './opportunity-requirements.js';
import { recordNotification } from './notify.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };
type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const liveStates = sql.raw(liveCampusDriveStates.map((state) => `'${state}'`).join(', '));

/** Why the college put a student forward. Fixed list; the note carries detail to the student. */
export const nominationReasonCodes = ['MEETS_ELIGIBILITY', 'PLACEMENT_OFFICE_SHORTLIST', 'STUDENT_EXPRESSED_INTEREST'] as const;
/** Why the college withdrew a nomination the student had not accepted. */
export const nominationCancelReasonCodes = ['NOMINATED_IN_ERROR', 'DRIVE_CHANGED', 'STUDENT_REQUESTED'] as const;

export type NominationState = 'INVITED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'CANCELLED';
/** What the college is shown: a decline, no answer yet and a withdrawal all read NOT_OPTED_IN. */
export type CollegeNominationResponse = 'OPTED_IN' | 'NOT_OPTED_IN' | 'CANCELLED' | 'CLOSED';
/** What the student is shown: their own answer, and CLOSED once the drive is no longer live. */
export type StudentNominationState = NominationState | 'CLOSED';

export function collegeNominationResponse(state: string, driveLive: boolean): CollegeNominationResponse {
  if (state === 'ACCEPTED') return 'OPTED_IN';
  if (state === 'CANCELLED') return 'CANCELLED';
  return driveLive ? 'NOT_OPTED_IN' : 'CLOSED';
}

export function studentNominationState(state: string, driveLive: boolean): StudentNominationState {
  if ((state === 'INVITED' || state === 'DECLINED') && !driveLive) return 'CLOSED';
  return state as NominationState;
}

const nominatorRoleLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'College owner', INSTITUTION_ADMIN: 'College administrator', PLACEMENT_ADMIN: 'Placement officer',
};

/** Institution-side drive readers (EMP-11) and deciders, with their seniority for the nominator's role. */
const readerRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'] as const;
const deciderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN'] as const;

// ---------------------------------------------------------------------------
// Shared with apply (student-hiring.controller.ts)
// ---------------------------------------------------------------------------

export interface OpenNomination {
  readonly id: string;
  readonly campusDriveId: string;
  readonly opportunityId: string;
  readonly institutionId: string;
  readonly state: NominationState;
}

/**
 * The student's own nomination, for opting in. Without `lock` it is the pre-check before apply;
 * with `lock` it is re-read FOR UPDATE inside the apply transaction, after the drives are held, so
 * a college cancellation either lands first (and the opt-in is refused) or waits for it.
 */
export async function readOwnNomination(db: Executor, nominationId: string, studentUserId: string, lock = false): Promise<(OpenNomination & { readonly driveLive: boolean }) | null> {
  const rows = await db.execute(sql`
    SELECT n.id, n.campus_drive_id, n.opportunity_id, n.institution_id, n.state,
           EXISTS (SELECT 1 FROM campus_drives cd WHERE cd.id = n.campus_drive_id AND cd.state IN (${liveStates})) AS drive_live
    FROM campus_drive_nominations n
    WHERE n.id = ${nominationId}::uuid AND n.student_user_id = ${studentUserId}::uuid
    ${lock ? sql`FOR UPDATE OF n` : sql``}
  `) as QueryResult<Record<string, unknown>>;
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: String(row.id), campusDriveId: String(row.campus_drive_id), opportunityId: String(row.opportunity_id),
    institutionId: String(row.institution_id), state: String(row.state) as NominationState, driveLive: row.drive_live === true,
  };
}

/**
 * Opting in: the nomination now points at the application the student just made. Same transaction
 * as apply. A student's answer never bumps `revision`: the revision counts the college's own
 * changes, so the college cannot read an answer (or a decline) from it.
 */
export async function markNominationAccepted(tx: Executor, ids: ApiIdGenerator, input: {
  readonly nomination: OpenNomination; readonly applicationId: string; readonly studentUserId: string; readonly correlationId: string;
}): Promise<void> {
  await tx.execute(sql`
    UPDATE campus_drive_nominations SET state = 'ACCEPTED', application_id = ${input.applicationId}::uuid, responded_at = now(), updated_at = now()
    WHERE id = ${input.nomination.id}::uuid
  `);
  await auditStudentNomination(tx, ids, input.studentUserId, input.nomination.id, 'campus_drive_nomination.accepted', input.correlationId,
    { fromState: input.nomination.state, applicationId: input.applicationId });
}

/** Withdrawing an application that came from a nomination withdraws the consent too. */
export async function markNominationWithdrawn(db: Executor, ids: ApiIdGenerator, input: { readonly applicationId: string; readonly studentUserId: string; readonly correlationId: string }): Promise<void> {
  const updated = await db.execute(sql`
    UPDATE campus_drive_nominations SET state = 'WITHDRAWN', responded_at = now(), updated_at = now()
    WHERE application_id = ${input.applicationId}::uuid AND student_user_id = ${input.studentUserId}::uuid AND state = 'ACCEPTED'
    RETURNING id
  `) as QueryResult<{ id: string }>;
  for (const row of updated.rows) {
    await auditStudentNomination(db, ids, input.studentUserId, row.id, 'campus_drive_nomination.withdrawn', input.correlationId, { applicationId: input.applicationId });
  }
}

/**
 * A student's answer is audited without an organisation: it is the student's own act, and no
 * college audit listing may single out who declined.
 */
async function auditStudentNomination(db: Executor, ids: ApiIdGenerator, studentUserId: string, nominationId: string, action: string, correlationId: string, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id, context)
    VALUES (${ids.uuid()}::uuid, ${studentUserId}::uuid, ${action}, 'campus_drive_nomination', ${nominationId}::uuid, 'SUCCESS', ${correlationId},
            ${JSON.stringify(detail)}::jsonb)
  `);
}

// ---------------------------------------------------------------------------
// College side
// ---------------------------------------------------------------------------

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionNominationsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /**
   * The eligible list for one live drive: current students in the caller's scope, keyset by name,
   * each with the EMP-06 outcome for the job's current version (ELIGIBLE, NOT_MET or UNKNOWN — no
   * figures) and the college's own nomination of them, if any. Nothing here comes from
   * applications, offers or the one-offer check: those are the student's unless they shared them.
   */
  @Get('/institutions/:institutionId/campus-drives/:driveId/nomination-candidates')
  async candidates(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string): Promise<Record<string, unknown>> {
    const { context, id } = await this.decider(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const size = readLimit(limit, context.correlationId);
    const after = readNameCursor(cursor, context.correlationId);
    const found = await this.driveOf(id, drive, context.correlationId);
    const scope = await institutionStudentScopeFor(this.db, request, id, deciderRoles);
    const rows = await this.db.execute(sql`
      SELECT sp.student_user_id, sp.full_name, sp.institution_student_id, dept.name AS department_name, batch.name AS batch_name,
             n.id AS nomination_id, n.state AS nomination_state, n.revision AS nomination_revision
      FROM institution_student_profiles sp
      JOIN users u ON u.id = sp.student_user_id AND u.state = 'ACTIVE'
      LEFT JOIN institution_units dept ON dept.id = sp.department_unit_id
      LEFT JOIN institution_units batch ON batch.id = sp.batch_unit_id
      LEFT JOIN campus_drive_nominations n ON n.campus_drive_id = ${drive}::uuid AND n.student_user_id = sp.student_user_id AND n.state <> 'CANCELLED'
      WHERE sp.institution_id = ${id}::uuid AND sp.status = 'ACTIVE' AND sp.student_user_id IS NOT NULL
        AND ${currentRelationshipSql(id)}
        AND ${institutionStudentScopeSql(scope, 'sp')}
        ${after ? sql`AND (sp.full_name, sp.student_user_id) > (${after[0]}, ${after[1]}::uuid)` : sql``}
      ORDER BY sp.full_name, sp.student_user_id
      LIMIT ${size + 1}
    `) as QueryResult<Record<string, unknown>>;
    const page = rows.rows.slice(0, size);
    const outcomes = await this.eligibility(found.versionId, page.map((row) => String(row.student_user_id)));
    const last = page.at(-1);
    return {
      drive: { id: drive, state: found.state, live: found.live, opportunityTitle: found.title, employerName: found.employerName },
      candidates: page.map((row) => ({
        studentUserId: row.student_user_id,
        fullName: row.full_name,
        institutionStudentId: row.institution_student_id ?? null,
        department: row.department_name ?? null,
        batch: row.batch_name ?? null,
        eligibility: outcomes.get(String(row.student_user_id)) ?? 'UNKNOWN',
        nomination: row.nomination_id ? {
          id: row.nomination_id, revision: Number(row.nomination_revision),
          response: collegeNominationResponse(String(row.nomination_state), found.live),
        } : null,
      })),
      nextCursor: rows.rows.length > size && last ? encodeNameCursor(String(last.full_name), String(last.student_user_id)) : null,
      correlationId: context.correlationId,
    };
  }

  /** The drive's nominations as the college sees them, within the reader's scope, with a suppressed summary. */
  @Get('/institutions/:institutionId/campus-drives/:driveId/nominations')
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const size = readLimit(limit, context.correlationId);
    const after = readNameCursor(cursor, context.correlationId);
    const found = await this.driveOf(id, drive, context.correlationId);
    const scope = await institutionStudentScopeFor(this.db, request, id, readerRoles);
    const canDecide = await this.canDecide(request, id);
    const inScope = sql`n.campus_drive_id = ${drive}::uuid AND n.institution_id = ${id}::uuid
      AND sp.status = 'ACTIVE' AND ${currentRelationshipSql(id)} AND ${institutionStudentScopeSql(scope, 'sp')}`;
    const rows = await this.db.execute(sql`
      SELECT n.id, n.state, n.revision, n.reason_code, n.nominated_by_role, n.created_at, n.cancelled_at, n.cancel_reason_code,
             sp.full_name, sp.institution_student_id, sp.student_user_id
      FROM campus_drive_nominations n
      JOIN institution_student_profiles sp ON sp.institution_id = n.institution_id AND sp.student_user_id = n.student_user_id
      WHERE ${inScope}
        ${after ? sql`AND (sp.full_name, n.id) > (${after[0]}, ${after[1]}::uuid)` : sql``}
      ORDER BY sp.full_name, n.id
      LIMIT ${size + 1}
    `) as QueryResult<Record<string, unknown>>;
    const counts = await this.db.execute(sql`
      SELECT count(*) FILTER (WHERE n.state = 'ACCEPTED')::int AS opted_in,
             count(*) FILTER (WHERE n.state IN ('INVITED', 'DECLINED', 'WITHDRAWN'))::int AS not_opted_in
      FROM campus_drive_nominations n
      JOIN institution_student_profiles sp ON sp.institution_id = n.institution_id AND sp.student_user_id = n.student_user_id
      WHERE ${inScope}
    `) as QueryResult<{ opted_in: number; not_opted_in: number }>;
    const table = suppressAggregateTable([
      { key: 'OPTED_IN', count: Number(counts.rows[0]?.opted_in ?? 0) },
      { key: 'NOT_OPTED_IN', count: Number(counts.rows[0]?.not_opted_in ?? 0) },
    ]);
    const cell = (key: string): SuppressedCount => {
      const found = table.cells.find((entry) => entry.key === key);
      return found && !found.suppressed && found.count !== null ? { suppressed: false, value: found.count } : { suppressed: true, value: null };
    };
    const page = rows.rows.slice(0, size);
    const last = page.at(-1);
    return {
      drive: { id: drive, state: found.state, live: found.live, opportunityTitle: found.title, employerName: found.employerName },
      canNominate: canDecide && found.live,
      summary: { nominated: table.total, optedIn: cell('OPTED_IN'), notOptedIn: cell('NOT_OPTED_IN') },
      nominations: page.map((row) => {
        const state = String(row.state);
        return {
          id: row.id,
          revision: Number(row.revision),
          studentName: row.full_name,
          institutionStudentId: row.institution_student_id ?? null,
          response: collegeNominationResponse(state, found.live),
          reasonCode: row.reason_code,
          nominatedByRole: row.nominated_by_role,
          nominatedAt: isoOrNull(row.created_at),
          cancelReasonCode: state === 'CANCELLED' ? row.cancel_reason_code ?? null : null,
          canCancel: canDecide && found.live && (state === 'INVITED' || state === 'DECLINED'),
        };
      }),
      nextCursor: rows.rows.length > size && last ? encodeNameCursor(String(last.full_name), String(last.id)) : null,
      correlationId: context.correlationId,
    };
  }

  /**
   * Nominate 1–200 students for a live drive. Each is created or skipped with a code
   * (ALREADY_NOMINATED, NOT_ELIGIBLE, NOT_IN_SCOPE); an id that is not a current student of this
   * college in scope is NOT_IN_SCOPE whatever it is. Only ELIGIBLE students are nominated.
   */
  @Post('/institutions/:institutionId/campus-drives/:driveId/nominations')
  async nominate(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id, role } = await this.decider(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const record = bodyRecord(body, ['studentUserIds', 'reasonCode', 'note'], context.correlationId);
    const studentIds = readStudentIds(record.studentUserIds, context.correlationId);
    const reasonCode = readCode(record.reasonCode, nominationReasonCodes, context.correlationId);
    const note = readNote(record.note, context.correlationId);
    const actorId = context.authorization.principal.userId;
    const scope = await institutionStudentWriteScopeFor(this.db, request, id, deciderRoles);

    const result = await this.db.transaction(async (tx) => {
      // The drive is held FOR SHARE: a cancellation (FOR UPDATE) lands before this or waits for it.
      const locked = await tx.execute(sql`
        SELECT cd.state, cd.opportunity_id, o.lifecycle_state, o.current_version_id,
               (v.application_deadline IS NOT NULL AND v.application_deadline <= now()) AS deadline_passed
        FROM campus_drives cd JOIN opportunities o ON o.id = cd.opportunity_id LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
        WHERE cd.id = ${drive}::uuid AND cd.institution_id = ${id}::uuid
        FOR SHARE OF cd
      `) as QueryResult<Record<string, unknown>>;
      const current = locked.rows[0];
      if (!current) throw forbidden(context.correlationId);
      if (!(liveCampusDriveStates as readonly string[]).includes(String(current.state))) throw invalid('NOMINATION_DRIVE_NOT_LIVE', context.correlationId);
      if (current.lifecycle_state !== 'PUBLISHED' || current.deadline_passed === true) throw invalid('NOMINATION_OPPORTUNITY_NOT_OPEN', context.correlationId);
      const opportunityId = String(current.opportunity_id);

      const students = await tx.execute(sql`
        SELECT sp.student_user_id FROM institution_student_profiles sp
        JOIN users u ON u.id = sp.student_user_id AND u.state = 'ACTIVE'
        WHERE sp.institution_id = ${id}::uuid AND sp.status = 'ACTIVE'
          AND sp.student_user_id = ANY(${`{${studentIds.join(',')}}`}::uuid[])
          AND ${currentRelationshipSql(id)}
          AND ${institutionStudentScopeSql(scope, 'sp')}
      `) as QueryResult<{ student_user_id: string }>;
      const reachable = new Set(students.rows.map((row) => String(row.student_user_id)));
      const outcomes = await this.eligibility(String(current.current_version_id), [...reachable], tx);

      const created: { studentUserId: string; nominationId: string }[] = [];
      const skipped: { studentUserId: string; code: string }[] = [];
      for (const studentUserId of studentIds) {
        if (!reachable.has(studentUserId)) { skipped.push({ studentUserId, code: 'NOT_IN_SCOPE' }); continue; }
        if (outcomes.get(studentUserId) !== 'ELIGIBLE') { skipped.push({ studentUserId, code: 'NOT_ELIGIBLE' }); continue; }
        const nominationId = this.ids.uuid();
        const inserted = await tx.execute(sql`
          INSERT INTO campus_drive_nominations (id, campus_drive_id, opportunity_id, institution_id, student_user_id, nominated_by_user_id, nominated_by_role, reason_code, note)
          VALUES (${nominationId}::uuid, ${drive}::uuid, ${opportunityId}::uuid, ${id}::uuid, ${studentUserId}::uuid, ${actorId}::uuid, ${role}, ${reasonCode}, ${note})
          ON CONFLICT (campus_drive_id, student_user_id) WHERE state <> 'CANCELLED' DO NOTHING
          RETURNING id
        `) as QueryResult<{ id: string }>;
        if (inserted.rows.length !== 1) { skipped.push({ studentUserId, code: 'ALREADY_NOMINATED' }); continue; }
        await this.audit(tx, context, id, nominationId, 'campus_drive_nomination.created', { campusDriveId: drive, studentUserId, reasonCode, withNote: note !== null });
        created.push({ studentUserId, nominationId });
      }
      return { created, skipped };
    });
    await this.noticeStudents(drive, result.created);
    return { ...result, correlationId: context.correlationId };
  }

  /** Withdraw a nomination the student has not accepted. Once they opted in, the application is theirs. */
  @Post('/institutions/:institutionId/campus-drives/:driveId/nominations/:nominationId/cancel')
  async cancel(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string,
    @Param('nominationId') nominationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.decider(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const nomination = requireUuid(nominationId, context.correlationId);
    const record = bodyRecord(body, ['revision', 'reasonCode'], context.correlationId);
    const revision = record.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw invalid('INVALID_REVISION', context.correlationId, 'revision');
    const reasonCode = readCode(record.reasonCode, nominationCancelReasonCodes, context.correlationId);
    const scope = await institutionStudentWriteScopeFor(this.db, request, id, deciderRoles);
    await this.db.transaction(async (tx) => {
      const driveRow = await tx.execute(sql`SELECT state FROM campus_drives WHERE id = ${drive}::uuid AND institution_id = ${id}::uuid FOR SHARE`) as QueryResult<{ state: string }>;
      if (!driveRow.rows[0]) throw forbidden(context.correlationId);
      const locked = await tx.execute(sql`
        SELECT n.state, n.revision FROM campus_drive_nominations n
        JOIN institution_student_profiles sp ON sp.institution_id = n.institution_id AND sp.student_user_id = n.student_user_id
        WHERE n.id = ${nomination}::uuid AND n.campus_drive_id = ${drive}::uuid AND n.institution_id = ${id}::uuid
          AND ${institutionStudentScopeSql(scope, 'sp')}
        FOR UPDATE OF n
      `) as QueryResult<{ state: string; revision: number }>;
      const current = locked.rows[0];
      if (!current) throw forbidden(context.correlationId);
      if (Number(current.revision) !== revision) throw new ConflictException(nominationError('NOMINATION_CHANGED', context.correlationId));
      if (!(liveCampusDriveStates as readonly string[]).includes(driveRow.rows[0].state)) throw invalid('NOMINATION_DRIVE_NOT_LIVE', context.correlationId);
      if (current.state !== 'INVITED' && current.state !== 'DECLINED') throw invalid('NOMINATION_NOT_CANCELLABLE', context.correlationId);
      await tx.execute(sql`
        UPDATE campus_drive_nominations SET state = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = ${context.authorization.principal.userId}::uuid,
          cancel_reason_code = ${reasonCode}, revision = revision + 1, updated_at = now()
        WHERE id = ${nomination}::uuid
      `);
      // The audit records the college's act; it does not record which answer the student had given.
      await this.audit(tx, context, id, nomination, 'campus_drive_nomination.cancelled', { campusDriveId: drive, reasonCode });
    });
    return { nomination: { id: nomination, response: 'CANCELLED' }, correlationId: context.correlationId };
  }

  private async driveOf(institutionId: string, driveId: string, correlationId: string): Promise<{ state: string; live: boolean; versionId: string; title: string | null; employerName: string }> {
    const rows = await this.db.execute(sql`
      SELECT cd.state, o.current_version_id, v.title, emp.legal_name AS employer_name,
             (cd.state IN (${liveStates}) AND o.lifecycle_state = 'PUBLISHED' AND (v.application_deadline IS NULL OR v.application_deadline > now())) AS live
      FROM campus_drives cd JOIN opportunities o ON o.id = cd.opportunity_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      JOIN organizations emp ON emp.id = cd.employer_id
      WHERE cd.id = ${driveId}::uuid AND cd.institution_id = ${institutionId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const row = rows.rows[0];
    if (!row) throw forbidden(correlationId);
    return { state: String(row.state), live: row.live === true, versionId: String(row.current_version_id), title: typeof row.title === 'string' ? row.title : null, employerName: String(row.employer_name) };
  }

  /** The EMP-06 outcome per student for a version: ELIGIBLE, NOT_MET or UNKNOWN. Outcome only. */
  private async eligibility(versionId: string, studentIds: readonly string[], db: Executor = this.db): Promise<Map<string, 'ELIGIBLE' | 'NOT_MET' | 'UNKNOWN'>> {
    const outcomes = new Map<string, 'ELIGIBLE' | 'NOT_MET' | 'UNKNOWN'>();
    if (studentIds.length === 0) return outcomes;
    const rules = await readVersionEligibilityRules(db, versionId);
    const records = await readEligibilityRecordsFor(db, studentIds);
    for (const studentId of studentIds) {
      const evaluation = evaluateStudentEligibility(rules, records.get(studentId) ?? { institution: null, qualifications: [] });
      outcomes.set(studentId, evaluation.eligible ? 'ELIGIBLE' : evaluation.blockingFailures.length ? 'NOT_MET' : 'UNKNOWN');
    }
    return outcomes;
  }

  private async audit(tx: Executor, context: Context, institutionId: string, nominationId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, ${action}, 'campus_drive_nomination', ${nominationId}::uuid,
              ${institutionId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify(detail)}::jsonb)
    `);
  }

  /** Best-effort, after commit: each nominated student hears about it in the app. Never undoes the nomination. */
  private async noticeStudents(driveId: string, created: readonly { studentUserId: string; nominationId: string }[]): Promise<void> {
    if (created.length === 0) return;
    try {
      const rows = await this.db.execute(sql`
        SELECT inst.legal_name AS institution_name, emp.legal_name AS employer_name, v.title
        FROM campus_drives cd JOIN organizations inst ON inst.id = cd.institution_id JOIN organizations emp ON emp.id = cd.employer_id
        JOIN opportunities o ON o.id = cd.opportunity_id LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
        WHERE cd.id = ${driveId}::uuid
      `) as QueryResult<Record<string, unknown>>;
      const row = rows.rows[0];
      const title = String(row?.title ?? 'a role');
      for (const entry of created) {
        await recordNotification(this.db, this.ids, {
          userId: entry.studentUserId, kind: 'SYSTEM', title: 'Your college nominated you',
          body: `${String(row?.institution_name ?? 'Your college')}'s placement office nominated you for ${title} at ${String(row?.employer_name ?? 'an employer')}. Nothing about you is shared with the employer unless you opt in.`,
          data: { nominationId: entry.nominationId },
        });
      }
    } catch {
      // Notification failures never undo a nomination.
    }
  }

  private reader(request: ProtectedHttpRequest, institutionId: string): { context: Context; id: string } {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    if (institutionStaffScopeMemberships(request, id, readerRoles).length === 0) throw forbidden(context.correlationId);
    return { context, id };
  }

  /**
   * EMP-11's decider: an owner, admin or placement admin whose write scope covers the whole
   * college. No write scope at all is SCOPE_REQUIRED; a narrowed one is INSTITUTION_WIDE_SCOPE_REQUIRED.
   * The nominator's role is the most senior deciding role the caller holds here.
   */
  private async decider(request: ProtectedHttpRequest, institutionId: string): Promise<{ context: Context; id: string; role: string }> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    const memberships = institutionStaffScopeMemberships(request, id, deciderRoles);
    if (memberships.length === 0) throw forbidden(context.correlationId);
    const scope = await institutionStudentWriteScopeFor(this.db, request, id, deciderRoles);
    if (scope.kind === 'NONE') throw scopeError('SCOPE_REQUIRED', context.correlationId);
    if (!canAddressInstitutionAudience(scope, null)) throw scopeError('INSTITUTION_WIDE_SCOPE_REQUIRED', context.correlationId);
    const role = deciderRoles.find((candidate) => memberships.some((membership) => membership.role === candidate)) ?? 'PLACEMENT_ADMIN';
    return { context, id, role };
  }

  private async canDecide(request: ProtectedHttpRequest, institutionId: string): Promise<boolean> {
    if (institutionStaffScopeMemberships(request, institutionId, deciderRoles).length === 0) return false;
    return canAddressInstitutionAudience(await institutionStudentWriteScopeFor(this.db, request, institutionId, deciderRoles), null);
  }
}

// ---------------------------------------------------------------------------
// Student side
// ---------------------------------------------------------------------------

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class StudentNominationsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /**
   * The student's own nominations: who nominated them (college and role), why, their note, for
   * which employer and job, the drive, their answer, whether they can still answer, and whether the
   * college's one-offer policy would stop them. What would be shared comes from the EMP-07 preview.
   */
  @Get('/students/me/nominations')
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const rows = await this.db.execute(sql`
      SELECT n.id, n.state, n.reason_code, n.note, n.nominated_by_role, n.created_at, n.responded_at, n.application_id, n.opportunity_id,
             inst.legal_name AS institution_name, emp.legal_name AS employer_name, v.title, v.application_deadline,
             cd.state AS drive_state, cd.scheduled_start_at, cd.scheduled_end_at, cd.venue_mode,
             (cd.state IN (${liveStates}) AND o.lifecycle_state = 'PUBLISHED' AND (v.application_deadline IS NULL OR v.application_deadline > now())) AS live,
             a.state AS application_state,
             EXISTS (SELECT 1 FROM applications other WHERE other.opportunity_id = n.opportunity_id AND other.student_user_id = n.student_user_id
               AND other.closed_at IS NULL AND other.state <> 'DRAFT' AND other.id IS DISTINCT FROM n.application_id) AS already_applied
      FROM campus_drive_nominations n
      JOIN campus_drives cd ON cd.id = n.campus_drive_id
      JOIN organizations inst ON inst.id = n.institution_id
      JOIN organizations emp ON emp.id = cd.employer_id
      JOIN opportunities o ON o.id = n.opportunity_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      LEFT JOIN applications a ON a.id = n.application_id
      WHERE n.student_user_id = ${studentUserId}::uuid
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    const nominations = [];
    for (const row of rows.rows) {
      const live = row.live === true;
      const state = studentNominationState(String(row.state), live);
      const canRespond = live && (state === 'INVITED' || state === 'DECLINED');
      // EMP-11: whether the college's one-offer policy would stop them, told before they try.
      const blocksYou = canRespond ? (await readStudentCampusDrives(this.db, studentUserId, String(row.opportunity_id))).some((drive) => drive.blocksYou) : false;
      nominations.push({
        id: row.id,
        state,
        institutionName: row.institution_name,
        nominatedBy: { role: row.nominated_by_role, label: nominatorRoleLabels[String(row.nominated_by_role)] ?? 'Placement office' },
        reasonCode: row.reason_code,
        note: row.note ?? null,
        nominatedAt: isoOrNull(row.created_at),
        respondedAt: isoOrNull(row.responded_at),
        opportunity: { id: row.opportunity_id, title: row.title ?? null, employerName: row.employer_name, applicationDeadline: isoOrNull(row.application_deadline) },
        drive: { state: row.drive_state, scheduledStartAt: isoOrNull(row.scheduled_start_at), scheduledEndAt: isoOrNull(row.scheduled_end_at), venueMode: row.venue_mode ?? null },
        applicationId: row.application_id ?? null,
        applicationState: row.application_state ?? null,
        alreadyApplied: row.already_applied === true,
        canRespond,
        blocksYou,
      });
    }
    return { nominations, correlationId: context.correlationId };
  }

  /** Decline, without penalty: recorded, shown to the student, never to the employer; the college sees "not opted in". */
  @Post('/students/me/nominations/:nominationId/decline')
  async decline(@Req() request: ProtectedHttpRequest, @Param('nominationId') nominationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(nominationId, context.correlationId);
    bodyRecord(body, [], context.correlationId);
    await this.db.transaction(async (tx) => {
      const nomination = await readOwnNomination(tx, id, studentUserId, true);
      if (!nomination) throw forbidden(context.correlationId);
      if (nomination.state === 'DECLINED') return;
      if (nomination.state !== 'INVITED') throw invalid('NOMINATION_NOT_OPEN', context.correlationId);
      await tx.execute(sql`
        UPDATE campus_drive_nominations SET state = 'DECLINED', responded_at = now(), updated_at = now()
        WHERE id = ${id}::uuid
      `);
      await auditStudentNomination(tx, this.ids, studentUserId, id, 'campus_drive_nomination.declined', context.correlationId, { fromState: 'INVITED' });
    });
    return { nomination: { id, state: 'DECLINED' }, correlationId: context.correlationId };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function currentRelationshipSql(institutionId: string) {
  return sql`EXISTS (SELECT 1 FROM institution_relationships ir
    WHERE ir.institution_id = ${institutionId}::uuid AND ir.student_user_id = sp.student_user_id AND ir.state IN ('ACTIVE', 'VERIFIED')
      AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))`;
}
function bodyRecord(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid('UNKNOWN_FIELD', correlationId);
  return record;
}
function readStudentIds(value: unknown, correlationId: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw invalid('INVALID_STUDENTS', correlationId, 'studentUserIds');
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || !uuidPattern.test(entry)) throw invalid('INVALID_STUDENTS', correlationId, 'studentUserIds');
    return entry.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw invalid('INVALID_STUDENTS', correlationId, 'studentUserIds');
  return ids;
}
function readCode(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid('INVALID_REASON_CODE', correlationId, 'reasonCode');
  return value;
}
function readNote(value: unknown, correlationId: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid('INVALID_FIELD', correlationId, 'note');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500 || /^[=+@-]/.test(trimmed)) throw invalid('INVALID_FIELD', correlationId, 'note');
  return trimmed;
}
function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw invalid('INVALID_QUERY', correlationId, 'limit');
  return Number(value);
}
function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id])).toString('base64url');
}
function readNameCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string' && uuidPattern.test(decoded[1])) {
      return [decoded[0], decoded[1]];
    }
  } catch { /* falls through to the refusal */ }
  throw invalid('INVALID_QUERY', correlationId, 'cursor');
}
function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}
function nominationError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}
function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}
function scopeError(code: string, correlationId: string): ForbiddenException {
  return new ForbiddenException({ error: { code, message: 'Access denied', correlationId } });
}
function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
