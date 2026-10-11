/**
 * Cohort readiness by career role and preparation sprints (INST-17): the placement office, an admin or a department
 * head chooses a catalogue role (or the role behind one of the college's campus drives), sees how the scoped cohort
 * stands on each essential requirement, and runs a time-boxed preparation sprint for the students with gaps.
 *
 * Why it exists: UAT J11 — "the TPO selects SOC Analyst L1 and runs a two-week preparation sprint". Design and
 * reasoning: docs/architecture/preparation-sprints-table-design.md.
 *
 * Rules, each enforced here or in `@planthepath/persistence/src/cohort-readiness.ts` and the 0085 guard:
 *   - INSTITUTION_OWNER, INSTITUTION_ADMIN, PLACEMENT_ADMIN, DEPARTMENT_HEAD only (faculty 403 — INST-15/16 serve
 *     them); reads within the INST-02 read scope, sprints within the write scope (none: SCOPE_REQUIRED).
 *   - Readiness only as bands of a requirement; no ratio, target or score leaves the server; no student is named.
 *   - Every count of people goes through aggregate-suppression.ts. The requirement tables of one view share one
 *     cohort total, published only when every table allows it.
 *   - The view covers one whole ended month (INST-SR-01); sprint progress is cut at the start of the UTC day.
 *   - A sprint is an INST-16 assignment plus a time box; nothing writes mastery, evidence or readiness.
 *   - Every write, and every read, writes an audit_events row in the same transaction; student notices are
 *     best-effort after commit. No model is called. Nothing here is reachable by an employer.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  institutionReportingMonth,
  institutionUnitDescendants,
  latestReportingMonth,
  narrowInstitutionStudentScope,
  publishedSubtotal,
  suppressAggregateTable,
  suppressSmallCount,
  type InstitutionStudentScope,
  type SuppressedAggregateTable,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';
import {
  COHORT_GAP_CELLS,
  COHORT_REQUIREMENT_CELLS,
  COHORT_UNKNOWN_CELLS,
  SPRINT_CANCEL_REASON_CODES,
  SPRINT_MAX_DAYS,
  SPRINT_MAX_STUDENTS,
  SPRINT_MIN_DAYS,
  SPRINT_PROGRESS_CELLS,
  SPRINT_REASON_CODES,
  currentScopedStudents,
  listCohortRoles,
  listDriveRoles,
  listSprints,
  loadCohortRole,
  loadSprint,
  monthEndCohort,
  requirementStatuses,
  resourcesForSkill,
  sprintStudentFacts,
  type CohortRequirementCell,
  type SprintHeader,
  type SprintProgressCell,
} from '@planthepath/persistence/src/cohort-readiness.js';
import { resolveLearningResource, LEARNING_CONTENT_KINDS, type LearningContentKind, type LearningResourceRef } from '@planthepath/persistence/src/faculty-learning-actions.js';
import { loadInstitutionUnitTree, resolveInstitutionStudentScope, resolveInstitutionStudentWriteScope } from '@planthepath/persistence/src/institution-scope.js';
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
import { describeInstitutionStudentScope, institutionStaffScopeMemberships } from './institution-student-scope.js';
import { recordNotification } from './notify.js';

type Rows<T> = { rows: T[] };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most senior first: the membership a write is recorded against. */
export const COHORT_READINESS_ROLES = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'] as const;
const CANCEL_ANY_ROLES = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const SPRINT_LIST_LIMIT = 50;

interface Reader {
  readonly institutionId: string;
  readonly correlationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly roles: readonly string[];
  readonly scope: InstitutionStudentScope;
  readonly writeScope: InstitutionStudentScope;
}

type PublicCount = { readonly suppressed: boolean; readonly count: number | null };
const publicCount = (value: SuppressedCount): PublicCount => ({ suppressed: value.suppressed, count: value.value });

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionCohortReadinessController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The roles that can be chosen: catalogue roles and the roles behind this college's live campus drives. */
  @Get('/institutions/:institutionId/cohort-readiness/roles')
  async roles(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    const roles = await listCohortRoles(this.db);
    const drives = await listDriveRoles(this.db, reader.institutionId);
    return {
      roles: roles.map((role) => ({
        id: role.id, title: role.title, catalogueCode: role.catalogueCode, catalogueTitle: role.catalogueTitle, releaseLabel: role.releaseLabel,
        essentialRequirements: role.essential, otherRequirements: role.other,
      })),
      drives,
    };
  }

  /** How the scoped cohort stood on each essential requirement of one role at the end of an ended month. */
  @Get('/institutions/:institutionId/cohort-readiness')
  async view(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string,
    @Query('careerRoleId') careerRoleId?: string, @Query('month') monthParam?: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    if (typeof careerRoleId !== 'string' || !uuidPattern.test(careerRoleId)) throw invalid(reader.correlationId, 'careerRoleId');
    const period = readMonth(monthParam, reader.correlationId);
    const role = await loadCohortRole(this.db, careerRoleId.toLowerCase());
    if (!role || !role.active) throw notFound(reader.correlationId);
    const essentials = role.requirements.filter((requirement) => requirement.level === 'ESSENTIAL');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const cohort = await monthEndCohort(db, reader.institutionId, reader.scope, period.endExclusive);
      const statuses = await requirementStatuses(db, { studentUserIds: cohort, requirements: essentials.map((entry) => entry.requirement), cutoff: period.endExclusive });
      const tables = essentials.map((essential) => suppressAggregateTable(COHORT_REQUIREMENT_CELLS.map((key) => ({
        key, count: cohort.filter((student) => statuses.get(student)?.get(essential.topicId) === key).length,
      }))));
      const shared = shareCohortTotal(tables, cohort.length);
      const requirements = [];
      for (const [index, essential] of essentials.entries()) {
        const table = shared.tables[index]!;
        requirements.push({
          topicId: essential.topicId, skillName: essential.skillName,
          cells: table.suppressed ? [] : table.cells.map((cell) => ({ key: cell.key, count: cell.count, suppressed: cell.suppressed })),
          gaps: publicCount(publishedSubtotal(table, COHORT_GAP_CELLS)),
          unknowns: publicCount(publishedSubtotal(table, COHORT_UNKNOWN_CELLS)),
          resources: await resourcesForSkill(db, essential.topicId),
        });
      }
      await this.audit(db, reader, 'institution.cohort_readiness.read', 'career_role', role.id, {
        month: period.month, requirements: essentials.length, scope: reader.scope.kind,
      });
      return {
        role: { id: role.id, title: role.title, catalogueCode: role.catalogueCode, catalogueTitle: role.catalogueTitle, releaseLabel: role.releaseLabel },
        period: { month: period.month, periodStart: period.periodStart, periodEnd: period.periodEnd },
        scope: await describeInstitutionStudentScope(db, request, reader.institutionId, COHORT_READINESS_ROLES, reader.scope),
        requirementCounts: { essential: essentials.length, other: role.requirements.length - essentials.length },
        cohort: { suppressed: shared.suppressed, total: publicCount(shared.total) },
        requirements,
        canRunSprints: reader.writeScope.kind !== 'NONE',
        sprintReasonCodes: SPRINT_REASON_CODES,
        sprintDays: { min: SPRINT_MIN_DAYS, max: SPRINT_MAX_DAYS },
      };
    });
  }

  /** The college's sprints with progress over the reader's scope, at the fixed cut-off. */
  @Get('/institutions/:institutionId/preparation-sprints')
  async sprints(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const headers = await listSprints(db, reader.institutionId, SPRINT_LIST_LIMIT);
      const sprints = [];
      for (const header of headers) sprints.push({ ...publicSprint(header, reader), progress: await this.progress(db, reader, header) });
      await this.audit(db, reader, 'institution.preparation_sprints.read', 'institution', reader.institutionId, { returned: sprints.length, scope: reader.scope.kind });
      return { sprints, cancelReasonCodes: SPRINT_CANCEL_REASON_CODES, canRunSprints: reader.writeScope.kind !== 'NONE' };
    });
  }

  @Post('/institutions/:institutionId/preparation-sprints')
  async create(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    if (reader.writeScope.kind === 'NONE') {
      throw new ForbiddenException({ error: { code: 'SCOPE_REQUIRED', message: 'Your role needs a department or unit scope before you can run a sprint.', correlationId: reader.correlationId } });
    }
    const input = objectBody(body, ['careerRoleId', 'topicId', 'resource', 'durationDays', 'includeUnknown', 'reasonCode', 'note', 'unitId', 'campusDriveId'], reader.correlationId);
    const careerRoleId = readUuid(input.careerRoleId, reader.correlationId, 'careerRoleId', true)!;
    const topicId = readUuid(input.topicId, reader.correlationId, 'topicId', true)!;
    const unitId = readUuid(input.unitId, reader.correlationId, 'unitId', false);
    const campusDriveId = readUuid(input.campusDriveId, reader.correlationId, 'campusDriveId', false);
    const ref = readResource(input.resource, reader.correlationId);
    if (ref.skillId !== topicId) throw invalid(reader.correlationId, 'resource');
    const durationDays = input.durationDays;
    if (typeof durationDays !== 'number' || !Number.isInteger(durationDays) || durationDays < SPRINT_MIN_DAYS || durationDays > SPRINT_MAX_DAYS) throw invalid(reader.correlationId, 'durationDays');
    if (typeof input.includeUnknown !== 'boolean') throw invalid(reader.correlationId, 'includeUnknown');
    const includeUnknown = input.includeUnknown;
    if (typeof input.reasonCode !== 'string' || !(SPRINT_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw new BadRequestException({ error: { code: 'INVALID_REASON_CODE', message: 'Choose one of the listed reasons.', correlationId: reader.correlationId } });
    }
    const reasonCode = input.reasonCode;
    const note = readText(input.note, 500, reader.correlationId, 'note');

    const created = await this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const role = await loadCohortRole(db, careerRoleId);
      if (!role || !role.active) throw notFound(reader.correlationId);
      const essential = role.requirements.find((requirement) => requirement.level === 'ESSENTIAL' && requirement.topicId === topicId);
      if (!essential) {
        throw new BadRequestException({ error: { code: 'NOT_AN_ESSENTIAL_REQUIREMENT', message: 'Choose one of this role’s essential requirements.', correlationId: reader.correlationId } });
      }
      const resource = await resolveLearningResource(db, ref);
      if (!resource) throw new BadRequestException({ error: { code: 'CONTENT_NOT_PUBLISHED', message: 'Only published ONE content can be assigned.', correlationId: reader.correlationId } });
      if (campusDriveId) {
        const [drive] = await listDriveRoles(db, reader.institutionId, campusDriveId);
        if (!drive || drive.careerRoleId !== careerRoleId) {
          throw new BadRequestException({ error: { code: 'DRIVE_ROLE_MISMATCH', message: 'That campus drive is not live at your college for this role.', correlationId: reader.correlationId } });
        }
      }
      let scope = reader.writeScope;
      if (unitId) {
        const units = await loadInstitutionUnitTree(db, reader.institutionId);
        if (!units.some((unit) => unit.id.toLowerCase() === unitId)) throw invalid(reader.correlationId, 'unitId');
        scope = narrowInstitutionStudentScope(scope, institutionUnitDescendants(unitId, units.map((unit) => ({ id: unit.id.toLowerCase(), parentUnitId: unit.parentUnitId?.toLowerCase() ?? null }))));
      }
      // Who has a gap now (current evidence): a sprint is about the students as they are today.
      const current = await currentScopedStudents(db, reader.institutionId, scope);
      const [now] = ((await db.execute(sql`SELECT now() AS now`)) as Rows<{ now: Date | string }>).rows;
      const statuses = await requirementStatuses(db, { studentUserIds: current, requirements: [essential.requirement], cutoff: new Date(now!.now).toISOString() });
      const wanted: readonly CohortRequirementCell[] = includeUnknown ? ['PARTIAL', 'MISSING', 'NOT_ENOUGH_EVIDENCE', 'NO_EVIDENCE'] : ['PARTIAL', 'MISSING'];
      const reached = current.filter((student) => wanted.includes(statuses.get(student)?.get(topicId) ?? 'NO_EVIDENCE')).sort();
      if (reached.length === 0) throw conflict('NO_STUDENTS_WITH_GAPS', 'No current student in your scope has a gap in this requirement.', reader.correlationId);
      if (reached.length > SPRINT_MAX_STUDENTS) {
        throw conflict('SPRINT_TOO_LARGE', `A sprint reaches at most ${SPRINT_MAX_STUDENTS} students. Choose a department, batch or section.`, reader.correlationId);
      }
      const assignmentId = this.ids.uuid();
      const sprintId = this.ids.uuid();
      await db.execute(sql`
        INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id,
          lesson_version_id, target_kind, target_unit_id, note)
        VALUES (${assignmentId}::uuid, ${reader.institutionId}::uuid, ${reader.userId}::uuid, ${reader.membershipId}::uuid, ${resource.kind},
          ${resource.skillId}::uuid, ${resource.lessonVersionId}::uuid, 'STUDENTS', NULL, ${note})
      `);
      await db.execute(sql`
        INSERT INTO learning_assignment_students (assignment_id, student_user_id, institution_id)
        SELECT ${assignmentId}::uuid, s, ${reader.institutionId}::uuid FROM unnest(${`{${reached.join(',')}}`}::uuid[]) AS s
      `);
      const [sprint] = ((await db.execute(sql`
        INSERT INTO preparation_sprints (id, institution_id, assignment_id, career_role_id, topic_id, campus_drive_id, scope_unit_id, include_unknown,
          created_by_user_id, created_by_membership_id, reason_code, note, starts_at, ends_at)
        SELECT ${sprintId}::uuid, ${reader.institutionId}::uuid, a.id, ${careerRoleId}::uuid, ${topicId}::uuid, ${campusDriveId}::uuid, ${unitId}::uuid,
          ${includeUnknown}, ${reader.userId}::uuid, ${reader.membershipId}::uuid, ${reasonCode}, ${note}, a.assigned_at,
          a.assigned_at + make_interval(days => ${durationDays}::int)
        FROM learning_assignments a WHERE a.id = ${assignmentId}::uuid
        RETURNING ends_at
      `)) as Rows<{ ends_at: Date | string }>).rows;
      const endsAt = new Date(sprint!.ends_at).toISOString();
      await this.audit(db, reader, 'preparation_sprint.created', 'preparation_sprint', sprintId, {
        careerRoleId, topicId, assignmentId, resource: { kind: resource.kind, skillId: resource.skillId, lessonVersionId: resource.lessonVersionId },
        reasonCode, durationDays, includeUnknown, unitId, campusDriveId, students: reached.length, studentUserIds: reached,
      });
      return { sprintId, reached, endsAt, resourceTitle: resource.title };
    });
    await this.notify(reader.institutionId, created.reached, 'Preparation sprint from your college', (college) =>
      `${college} started a preparation sprint for you: ${created.resourceTitle}, until ${created.endsAt.slice(0, 10)}. It comes up as your next step on Learning.`,
    { sprintId: created.sprintId });
    return { sprint: { id: created.sprintId, endsAt: created.endsAt, reached: publicCount(suppressSmallCount(created.reached.length)) } };
  }

  @Post('/institutions/:institutionId/preparation-sprints/:sprintId/cancel')
  async cancel(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('sprintId') sprintId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    if (!uuidPattern.test(sprintId)) throw notFound(reader.correlationId);
    const { reasonCode } = objectBody(body, ['reasonCode'], reader.correlationId);
    if (typeof reasonCode !== 'string' || !(SPRINT_CANCEL_REASON_CODES as readonly string[]).includes(reasonCode)) {
      throw new BadRequestException({ error: { code: 'INVALID_REASON_CODE', message: 'Choose one of the listed reasons.', correlationId: reader.correlationId } });
    }
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const sprint = await loadSprint(db, reader.institutionId, sprintId.toLowerCase(), true);
      if (!sprint) throw notFound(reader.correlationId);
      if (sprint.createdByUserId !== reader.userId && !reader.roles.some((role) => CANCEL_ANY_ROLES.includes(role))) {
        throw new ForbiddenException({ error: { code: 'NOT_SPRINT_OWNER', message: 'Only the person who started this sprint, or an administrator, can end it.', correlationId: reader.correlationId } });
      }
      if (sprint.state !== 'RUNNING') throw conflict('SPRINT_NOT_RUNNING', 'This sprint has already ended.', reader.correlationId);
      await db.execute(sql`
        UPDATE preparation_sprints SET cancelled_at = now(), cancelled_by_user_id = ${reader.userId}::uuid, cancel_reason_code = ${reasonCode}
        WHERE id = ${sprint.id}::uuid AND cancelled_at IS NULL
      `);
      await db.execute(sql`
        UPDATE learning_assignments SET withdrawn_at = now(), withdrawn_by_user_id = ${reader.userId}::uuid, withdraw_reason_code = ${reasonCode}
        WHERE id = ${sprint.assignmentId}::uuid AND withdrawn_at IS NULL
      `);
      await this.audit(db, reader, 'preparation_sprint.cancelled', 'preparation_sprint', sprint.id, { reasonCode, assignmentId: sprint.assignmentId });
      return { sprint: { id: sprint.id, state: 'CANCELLED' } };
    });
  }

  // --- Helpers -----------------------------------------------------------------------------------

  private async reader(request: ProtectedHttpRequest, institutionId: string): Promise<Reader> {
    const context = requireTrustedAuthorization(request);
    if (!uuidPattern.test(institutionId)) throw forbidden(context.correlationId);
    const id = institutionId.toLowerCase();
    const memberships = institutionStaffScopeMemberships(request, id, COHORT_READINESS_ROLES)
      .slice().sort((left, right) => COHORT_READINESS_ROLES.indexOf(left.role as never) - COHORT_READINESS_ROLES.indexOf(right.role as never));
    const primary = memberships[0];
    if (!primary?.membershipId) throw forbidden(context.correlationId);
    return {
      institutionId: id, correlationId: context.correlationId, userId: context.authorization.principal.userId.toLowerCase(),
      membershipId: primary.membershipId, roles: memberships.map((membership) => membership.role),
      scope: await resolveInstitutionStudentScope(this.db, id, memberships),
      writeScope: await resolveInstitutionStudentWriteScope(this.db, id, memberships),
    };
  }

  /** Sprint progress over the students it reached who are still current and inside the reader's scope. */
  private async progress(db: PersistenceDb, reader: Reader, sprint: SprintHeader): Promise<Record<string, unknown>> {
    const available = new Date(sprint.cutoff).getTime() > new Date(sprint.startsAt).getTime();
    if (!available) return { cutoff: null, available: false, requirementLive: true, reached: publicCount({ suppressed: true, value: null }), cells: [], workDone: publicCount({ suppressed: true, value: null }) };
    const facts = await sprintStudentFacts(db, reader.institutionId, reader.scope, sprint);
    const role = await loadCohortRole(db, sprint.careerRoleId);
    const requirement = role?.requirements.find((entry) => entry.topicId === sprint.topicId) ?? null;
    const students = facts.map((fact) => fact.studentUserId);
    const workDone = publicCount(suppressSmallCount(facts.filter((fact) => fact.done).length));
    if (!requirement) {
      const reached = suppressSmallCount(students.length);
      return { cutoff: sprint.cutoff, available: true, requirementLive: false, reached: publicCount(reached), cells: [], workDone };
    }
    const statuses = await requirementStatuses(db, { studentUserIds: students, requirements: [requirement.requirement], cutoff: sprint.cutoff });
    const cellOf = (fact: typeof facts[number]): SprintProgressCell => statuses.get(fact.studentUserId)?.get(sprint.topicId) === 'MET'
      ? 'MET' : fact.newEvidence ? 'NEW_EVIDENCE' : 'NO_NEW_EVIDENCE';
    const table = suppressAggregateTable(SPRINT_PROGRESS_CELLS.map((key) => ({ key, count: facts.filter((fact) => cellOf(fact) === key).length })));
    return {
      cutoff: sprint.cutoff, available: true, requirementLive: true, reached: publicCount(table.total),
      cells: table.suppressed ? [] : table.cells.map((cell) => ({ key: cell.key, count: cell.count, suppressed: cell.suppressed })),
      workDone: table.suppressed ? publicCount({ suppressed: true, value: null }) : workDone,
    };
  }

  private async audit(db: PersistenceDb, reader: Reader, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${reader.userId}::uuid, ${action}, ${resourceType}, ${resourceId}, ${reader.institutionId}::uuid,
        'SUCCESS', ${reader.correlationId}, ${JSON.stringify({ ...context, roles: reader.roles })}::jsonb)
    `);
  }

  /** Best-effort, after commit: in-app notices. Never undoes the sprint. */
  private async notify(institutionId: string, students: readonly string[], title: string, body: (college: string) => string, data: Record<string, string>): Promise<void> {
    try {
      const [org] = ((await this.db.execute(sql`SELECT legal_name FROM organizations WHERE id = ${institutionId}::uuid`)) as Rows<{ legal_name: string }>).rows;
      const text = body(org?.legal_name ?? 'Your college');
      for (const student of students) await recordNotification(this.db, this.ids, { userId: student, kind: 'SYSTEM', title, body: text, data });
    } catch {
      // Notification failures never undo a sprint.
    }
  }
}

/**
 * The requirement tables of one view partition the same cohort, so they share one total. A table withholds its
 * total when subtraction would give back a withheld cell; if any table must, every table withholds it (otherwise
 * the total published beside one table would be subtracted from another).
 */
export function shareCohortTotal<K extends string>(tables: readonly SuppressedAggregateTable<K>[], cohortSize: number): {
  readonly suppressed: boolean; readonly total: SuppressedCount; readonly tables: readonly SuppressedAggregateTable<K>[];
} {
  const whole = suppressSmallCount(cohortSize);
  if (whole.suppressed) {
    return { suppressed: true, total: whole, tables: tables.map(() => ({ suppressed: true, total: { suppressed: true, value: null }, cells: [] })) };
  }
  const publish = tables.every((table) => !table.total.suppressed);
  const total: SuppressedCount = publish ? whole : { suppressed: true, value: null };
  return { suppressed: false, total, tables: tables.map((table) => ({ ...table, total })) };
}

function publicSprint(sprint: SprintHeader, reader: Reader): Record<string, unknown> {
  return {
    id: sprint.id, role: { id: sprint.careerRoleId, title: sprint.roleTitle }, skillName: sprint.skillName,
    resource: { kind: sprint.contentKind, title: sprint.resourceTitle }, reasonCode: sprint.reasonCode, note: sprint.note,
    includeUnknown: sprint.includeUnknown, unitName: sprint.unitName, drive: sprint.drive, startsAt: sprint.startsAt, endsAt: sprint.endsAt,
    cancelledAt: sprint.cancelledAt, state: sprint.state, startedByYou: sprint.createdByUserId === reader.userId,
    canEnd: sprint.state === 'RUNNING' && (sprint.createdByUserId === reader.userId || reader.roles.some((role) => CANCEL_ANY_ROLES.includes(role))),
  };
}

function readMonth(value: string | undefined, correlationId: string): { month: string; periodStart: string; periodEnd: string; endExclusive: string } {
  const today = new Date().toISOString().slice(0, 10);
  const month = value === undefined || value === '' ? latestReportingMonth(today) : value;
  const match = typeof month === 'string' ? /^(\d{4})-(\d{2})$/.exec(month) : null;
  if (!match) throw periodInvalid(correlationId);
  const [year, monthNumber] = [Number(match[1]), Number(match[2])];
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const periodStart = `${match[1]}-${match[2]}-01`;
  const periodEnd = `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}`;
  const checked = institutionReportingMonth(periodStart, periodEnd, today);
  if (!checked) throw periodInvalid(correlationId);
  return { month: checked.month, periodStart, periodEnd, endExclusive: new Date(Date.UTC(year, monthNumber, 1)).toISOString() };
}

function readResource(value: unknown, correlationId: string): LearningResourceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(correlationId, 'resource');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['kind', 'skillId', 'lessonVersionId'].includes(key))) throw invalid(correlationId, 'resource');
  const { kind, skillId, lessonVersionId } = record;
  if (typeof kind !== 'string' || !(LEARNING_CONTENT_KINDS as readonly string[]).includes(kind)) throw invalid(correlationId, 'resource');
  if (typeof skillId !== 'string' || !uuidPattern.test(skillId)) throw invalid(correlationId, 'resource');
  if (kind === 'LESSON') {
    if (typeof lessonVersionId !== 'string' || !uuidPattern.test(lessonVersionId)) throw invalid(correlationId, 'resource');
    return { kind, skillId: skillId.toLowerCase(), lessonVersionId: lessonVersionId.toLowerCase() };
  }
  if (lessonVersionId !== undefined && lessonVersionId !== null) throw invalid(correlationId, 'resource');
  return { kind: kind as LearningContentKind, skillId: skillId.toLowerCase(), lessonVersionId: null };
}

function readUuid(value: unknown, correlationId: string, field: string, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw invalid(correlationId, field);
    return null;
  }
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(correlationId, field);
  return value.toLowerCase();
}

function objectBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid(correlationId, 'body');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid(correlationId, 'body');
  return record;
}

function readText(value: unknown, max: number, correlationId: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(correlationId, field);
  const text = value.trim();
  if (text.length > max) throw invalid(correlationId, field);
  return text || null;
}

function invalid(correlationId: string, field: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be completed', correlationId, field } });
}

function periodInvalid(correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code: 'REPORT_PERIOD_INVALID', message: 'Choose a whole calendar month that has ended.', correlationId } });
}

function conflict(code: string, message: string, correlationId: string): ConflictException {
  return new ConflictException({ error: { code, message, correlationId } });
}

function notFound(correlationId: string): NotFoundException {
  return new NotFoundException({ error: { code: 'NOT_FOUND', message: 'Not found.', correlationId } });
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
