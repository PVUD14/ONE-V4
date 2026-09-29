/**
 * Faculty learning actions (INST-16): assign a published practice set or lesson to a class or to selected
 * students, run a group session (a MEETING staff action with attendees and linked content), and set one
 * student's next step with a reason code — plus the student's own view of what their lecturers set.
 *
 * Why it exists: the cohort view (INST-15) shows a lecturer who is stuck and who has reviews due; these are the
 * actions it links to. Each one is a constraint the learning planner honours (ENG-08) — nothing here writes
 * mastery, evidence, attempts or readiness. Design: docs/architecture/faculty-learning-actions-table-design.md.
 *
 * Rules, each enforced here or in `@planthepath/persistence/src/faculty-learning-actions.ts` and the 0082 guards:
 *   - FACULTY_LECTURER only; everyone else 403.
 *   - Writes act only on students in the lecturer's active teaching assignments — the INST-02 helper's write
 *     scope, no fallback; no write scope is SCOPE_REQUIRED. A class must be one of the lecturer's teaching units.
 *   - Only published, current content (the database guard refuses anything else too).
 *   - Overrides carry a reason code from a closed list; the student is notified (decision 10.2 #11). The
 *     decision that applies an override records it in the engine's decision audit, so it is replayable.
 *   - A student's current plan is shown to staff only while the student holds adaptive-learning consent
 *     (fails closed until HG-6 publishes the definition). Counts of people under 5 are shown as <5.
 *   - Every write and every per-student read writes an audit_events row in the same transaction; notices are
 *     best-effort after commit and never undo the action. No model is called; no number about a student leaves.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { suppressSmallCount, type InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { consentPurposeOffered, hasConsentPurpose } from '@planthepath/persistence/src/consent-purposes.js';
import {
  FACULTY_OVERRIDE_ACTIONS,
  FACULTY_OVERRIDE_REASON_CODES,
  FACULTY_WITHDRAW_REASON_CODES,
  LEARNING_CONTENT_KINDS,
  facultyAssignmentStudents,
  listFacultyAssignments,
  listFacultyOverrides,
  listFacultySessions,
  listLearningResources,
  pendingOverrideFor,
  readStudentLearningActions,
  resolveLearningResource,
  scopedStudentsByProfile,
  scopedStudentsInUnit,
  type FacultyOverrideAction,
  type LearningContentKind,
  type LearningResource,
  type LearningResourceRef,
  type ScopedStudent,
} from '@planthepath/persistence/src/faculty-learning-actions.js';
import { resolveInstitutionStudentWriteScope, withTeachingAssignments } from '@planthepath/persistence/src/institution-scope.js';
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
import { institutionStaffScopeMemberships } from './institution-student-scope.js';
import { recordNotification } from './notify.js';

type Rows<T> = { rows: T[] };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many students per assignment or session. */
export const MAX_ACTION_STUDENTS = 500;
const LIST_LIMIT = 50;

interface Lecturer {
  readonly institutionId: string;
  readonly correlationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly departmentUnitId: string | null;
  readonly batchUnitId: string | null;
  readonly mode: 'ASSIGNMENTS' | 'MEMBERSHIP';
  readonly teachingUnitIds: readonly string[];
  readonly scope: InstitutionStudentScope;
}

const ACTION_WORD: Readonly<Record<FacultyOverrideAction, string>> = { LEARN: 'Learn', PRACTICE: 'Practise', REVIEW: 'Review' };

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionLearningActionsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // --- Learning Resources: the published catalogue --------------------------------------------------

  @Get('/institutions/:institutionId/learning-resources')
  async resources(
    @Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string,
    @Query('q') q?: string, @Query('kind') kind?: string, @Query('limit') limitParam?: string, @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const lecturer = await this.lecturer(request, institutionId);
    const limit = readLimit(limitParam, lecturer.correlationId);
    if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw invalid(lecturer.correlationId, 'q');
    if (kind !== undefined && kind !== '' && !(LEARNING_CONTENT_KINDS as readonly string[]).includes(kind)) throw invalid(lecturer.correlationId, 'kind');
    const cursor = readCursor(cursorParam, lecturer.correlationId);
    const page = await listLearningResources(this.db, { q: q || null, kind: (kind || null) as LearningContentKind | null, limit, cursor });
    return { resources: page.resources.map(publicResource), nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null };
  }

  // --- The lecturer's own actions ----------------------------------------------------------------

  @Get('/institutions/:institutionId/learning-actions')
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const lecturer = await this.lecturer(request, institutionId);
    const units = lecturer.teachingUnitIds.length === 0 ? [] : ((await this.db.execute(sql`
      SELECT id::text AS id, kind, name FROM institution_units
      WHERE institution_id = ${lecturer.institutionId}::uuid AND id = ANY(${`{${lecturer.teachingUnitIds.join(',')}}`}::uuid[])
      ORDER BY name, id
    `)) as Rows<{ id: string; kind: string; name: string }>).rows;
    const assignments = await listFacultyAssignments(this.db, lecturer.institutionId, lecturer.userId, LIST_LIMIT);
    const sessions = await listFacultySessions(this.db, lecturer.institutionId, lecturer.userId, LIST_LIMIT);
    const overrides = await listFacultyOverrides(this.db, lecturer.institutionId, lecturer.userId, lecturer.scope, LIST_LIMIT);
    return {
      mode: lecturer.mode,
      canAct: lecturer.scope.kind !== 'NONE',
      targets: units.map((unit) => ({ unitId: unit.id, kind: unit.kind, name: unit.name })),
      assignments: assignments.map((assignment) => {
        const done = suppressSmallCount(assignment.done);
        return {
          id: assignment.id, resource: assignment.resource, target: assignment.target, note: assignment.note, assignedAt: assignment.assignedAt,
          withdrawn: assignment.withdrawn, students: assignment.students, done: { suppressed: done.suppressed, count: done.value },
        };
      }),
      sessions,
      overrides,
      overrideActions: FACULTY_OVERRIDE_ACTIONS,
      overrideReasonCodes: FACULTY_OVERRIDE_REASON_CODES,
      withdrawReasonCodes: FACULTY_WITHDRAW_REASON_CODES,
    };
  }

  // --- Assign a practice set or lesson ------------------------------------------------------------

  @Post('/institutions/:institutionId/learning-assignments')
  async assign(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const lecturer = await this.writer(request, institutionId);
    const input = objectBody(body, ['resource', 'unitId', 'studentProfileIds', 'note'], lecturer.correlationId);
    const ref = readResource(input.resource, lecturer.correlationId);
    const note = readText(input.note, 500, lecturer.correlationId, 'note');
    const target = readTarget(input, lecturer);
    const created = await this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const resource = await this.published(db, ref, lecturer.correlationId);
      const students = await this.students(db, lecturer, target);
      const id = this.ids.uuid();
      await db.execute(sql`
        INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id,
          lesson_version_id, target_kind, target_unit_id, note)
        VALUES (${id}::uuid, ${lecturer.institutionId}::uuid, ${lecturer.userId}::uuid, ${lecturer.membershipId}::uuid, ${resource.kind},
          ${resource.skillId}::uuid, ${resource.lessonVersionId}::uuid, ${target.unitId ? 'UNIT' : 'STUDENTS'}, ${target.unitId}::uuid, ${note})
      `);
      await db.execute(sql`
        INSERT INTO learning_assignment_students (assignment_id, student_user_id, institution_id)
        SELECT ${id}::uuid, s, ${lecturer.institutionId}::uuid FROM unnest(${`{${students.map((student) => student.studentUserId).join(',')}}`}::uuid[]) AS s
      `);
      await this.audit(db, lecturer, 'learning_assignment.created', 'learning_assignment', id, {
        resource: refOf(resource), target: target.unitId ? { kind: 'UNIT', unitId: target.unitId } : { kind: 'STUDENTS' },
        students: students.length, studentUserIds: students.map((student) => student.studentUserId),
      });
      return { id, resource, students };
    });
    await this.notify(lecturer.institutionId, created.students, 'New work from your lecturer', (college) =>
      `Your lecturer at ${college} assigned ${created.resource.kind === 'LESSON' ? 'the lesson' : 'practice on'} ${created.resource.title}. It comes up as your next step on Learning.`,
    { assignmentId: created.id });
    return { assignment: { id: created.id, resource: publicResource(created.resource), students: created.students.length } };
  }

  @Get('/institutions/:institutionId/learning-assignments/:assignmentId/students')
  async assignmentStudents(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('assignmentId') assignmentId: string): Promise<Record<string, unknown>> {
    const lecturer = await this.lecturer(request, institutionId);
    if (!uuidPattern.test(assignmentId)) throw notFound(lecturer.correlationId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      await this.ownAssignment(db, lecturer, assignmentId, false);
      const students = await facultyAssignmentStudents(db, lecturer.institutionId, lecturer.scope, assignmentId);
      await this.audit(db, lecturer, 'institution.learning_assignment.students_read', 'learning_assignment', assignmentId, {
        returned: students.length, studentUserIds: students.map((student) => student.studentUserId),
      });
      return {
        students: students.map((student) => ({ profileId: student.profileId, fullName: student.fullName, rollNumber: student.rollNumber, status: student.done ? 'DONE' : 'NOT_YET' })),
      };
    });
  }

  @Post('/institutions/:institutionId/learning-assignments/:assignmentId/withdraw')
  async withdrawAssignment(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('assignmentId') assignmentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const lecturer = await this.lecturer(request, institutionId);
    if (!uuidPattern.test(assignmentId)) throw notFound(lecturer.correlationId);
    const reasonCode = readWithdrawReason(body, lecturer.correlationId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const current = await this.ownAssignment(db, lecturer, assignmentId, true);
      if (current.withdrawn) throw conflict('ASSIGNMENT_WITHDRAWN', 'This assignment was already withdrawn.', lecturer.correlationId);
      await db.execute(sql`
        UPDATE learning_assignments SET withdrawn_at = now(), withdrawn_by_user_id = ${lecturer.userId}::uuid, withdraw_reason_code = ${reasonCode}
        WHERE id = ${assignmentId}::uuid AND withdrawn_at IS NULL
      `);
      await this.audit(db, lecturer, 'learning_assignment.withdrawn', 'learning_assignment', assignmentId, { reasonCode });
      return { assignment: { id: assignmentId.toLowerCase(), withdrawn: true } };
    });
  }

  // --- Group sessions ---------------------------------------------------------------------------

  @Post('/institutions/:institutionId/group-sessions')
  async session(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const lecturer = await this.writer(request, institutionId);
    const input = objectBody(body, ['title', 'scheduledStartAt', 'scheduledEndAt', 'resources', 'unitId', 'studentProfileIds', 'note'], lecturer.correlationId);
    const title = readText(input.title, 200, lecturer.correlationId, 'title', true)!;
    const note = readText(input.note, 2000, lecturer.correlationId, 'note');
    const start = readInstant(input.scheduledStartAt, lecturer.correlationId, 'scheduledStartAt');
    const end = readInstant(input.scheduledEndAt, lecturer.correlationId, 'scheduledEndAt');
    if (end <= start) throw invalid(lecturer.correlationId, 'scheduledEndAt');
    if (end.getTime() <= Date.now()) throw invalid(lecturer.correlationId, 'scheduledEndAt');
    if (!Array.isArray(input.resources) || input.resources.length < 1 || input.resources.length > 5) throw invalid(lecturer.correlationId, 'resources');
    const refs = input.resources.map((entry) => readResource(entry, lecturer.correlationId));
    if (new Set(refs.map((ref) => `${ref.kind}:${ref.skillId}:${ref.lessonVersionId ?? ''}`)).size !== refs.length) throw invalid(lecturer.correlationId, 'resources');
    const target = readTarget(input, lecturer);
    const created = await this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const resources: LearningResource[] = [];
      for (const ref of refs) resources.push(await this.published(db, ref, lecturer.correlationId));
      const students = await this.students(db, lecturer, target);
      const id = this.ids.uuid();
      // The same row a lecturer's meeting has always been (0020), so it is on their Calendar unchanged.
      await db.execute(sql`
        INSERT INTO staff_actions (id, institution_id, subject_student_user_id, institution_relationship_id, actor_user_id, actor_membership_id,
          assigned_to_membership_id, department_unit_id, batch_unit_id, action_type, title, note, scheduled_start_at, scheduled_end_at, updated_by_user_id)
        VALUES (${id}::uuid, ${lecturer.institutionId}::uuid, NULL, NULL, ${lecturer.userId}::uuid, ${lecturer.membershipId}::uuid,
          ${lecturer.membershipId}::uuid, ${lecturer.departmentUnitId}::uuid, ${lecturer.batchUnitId}::uuid, 'MEETING', ${title}, ${note},
          ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, ${lecturer.userId}::uuid)
      `);
      await db.execute(sql`
        INSERT INTO staff_action_attendees (staff_action_id, student_user_id, institution_id)
        SELECT ${id}::uuid, s, ${lecturer.institutionId}::uuid FROM unnest(${`{${students.map((student) => student.studentUserId).join(',')}}`}::uuid[]) AS s
      `);
      for (const [index, resource] of resources.entries()) {
        await db.execute(sql`
          INSERT INTO staff_action_content_links (staff_action_id, position, content_kind, skill_id, lesson_version_id)
          VALUES (${id}::uuid, ${index + 1}, ${resource.kind}, ${resource.skillId}::uuid, ${resource.lessonVersionId}::uuid)
        `);
      }
      await this.audit(db, lecturer, 'group_session.created', 'staff_action', id, {
        actionType: 'MEETING', toState: 'DRAFT', title, scheduledStartAt: start.toISOString(), scheduledEndAt: end.toISOString(),
        resources: resources.map(refOf), target: target.unitId ? { kind: 'UNIT', unitId: target.unitId } : { kind: 'STUDENTS' },
        attendees: students.length, studentUserIds: students.map((student) => student.studentUserId),
      });
      return { id, students };
    });
    await this.notify(lecturer.institutionId, created.students, 'Group session from your lecturer', (college) =>
      `Your lecturer at ${college} invited you to "${title}". The time and what it covers are on your Learning page.`, { sessionId: created.id });
    return { session: { id: created.id, attendees: created.students.length } };
  }

  // --- One student's plan -------------------------------------------------------------------------

  @Get('/institutions/:institutionId/students/:profileId/learning-plan')
  async plan(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('profileId') profileId: string): Promise<Record<string, unknown>> {
    const lecturer = await this.writer(request, institutionId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const student = await this.student(db, lecturer, profileId);
      const offered = await consentPurposeOffered(db, 'adaptive-learning');
      const held = offered && await hasConsentPurpose(db, student.studentUserId, 'adaptive-learning');
      // The student's plan is a product of their learning data: shown only with their consent (fails closed).
      const [latest] = held ? ((await db.execute(sql`
        SELECT d.action, tn.name AS skill_name, d.reason_codes
        FROM learning_decisions d LEFT JOIN taxonomy_nodes tn ON tn.id = d.skill_id
        WHERE d.subject_user_id = ${student.studentUserId}::uuid AND d.institution_id = ${lecturer.institutionId}::uuid
        ORDER BY d.decided_at DESC, d.id DESC LIMIT 1
      `)) as Rows<{ action: string; skill_name: string | null; reason_codes: string[] }>).rows : [];
      const pending = await pendingOverrideFor(db, lecturer.institutionId, student.studentUserId);
      await this.audit(db, lecturer, 'institution.learning_plan.read', 'institution', lecturer.institutionId, {
        studentUserId: student.studentUserId, planShown: Boolean(latest), consentHeld: held,
      });
      return {
        student: { profileId: student.profileId, fullName: student.fullName, rollNumber: student.rollNumber },
        consent: { offered, held },
        latestStep: latest ? { action: latest.action, skillName: latest.skill_name, reasonCodes: latest.reason_codes } : null,
        pendingOverride: pending ? publicOverride(pending) : null,
      };
    });
  }

  @Post('/institutions/:institutionId/students/:profileId/plan-overrides')
  async override(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('profileId') profileId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const lecturer = await this.writer(request, institutionId);
    const input = objectBody(body, ['action', 'resource', 'reasonCode', 'note'], lecturer.correlationId);
    if (typeof input.action !== 'string' || !(FACULTY_OVERRIDE_ACTIONS as readonly string[]).includes(input.action)) throw invalid(lecturer.correlationId, 'action');
    const action = input.action as FacultyOverrideAction;
    if (typeof input.reasonCode !== 'string' || !(FACULTY_OVERRIDE_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw new BadRequestException({ error: { code: 'INVALID_REASON_CODE', message: 'Choose one of the listed reasons.', correlationId: lecturer.correlationId } });
    }
    const reasonCode = input.reasonCode;
    const ref = readResource(input.resource, lecturer.correlationId);
    const note = readText(input.note, 500, lecturer.correlationId, 'note');
    const created = await this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const student = await this.student(db, lecturer, profileId);
      const resource = await this.published(db, ref, lecturer.correlationId);
      const pending = await db.execute(sql`
        SELECT id FROM learning_plan_overrides WHERE student_user_id = ${student.studentUserId}::uuid AND state = 'PENDING' FOR UPDATE
      `) as Rows<{ id: string }>;
      if (pending.rows.length > 0) throw overridePending(lecturer.correlationId);
      const id = this.ids.uuid();
      try {
        await db.execute(sql`
          INSERT INTO learning_plan_overrides (id, institution_id, student_user_id, created_by_user_id, created_by_membership_id, action,
            content_kind, skill_id, lesson_version_id, reason_code, note)
          VALUES (${id}::uuid, ${lecturer.institutionId}::uuid, ${student.studentUserId}::uuid, ${lecturer.userId}::uuid, ${lecturer.membershipId}::uuid,
            ${action}, ${resource.kind}, ${resource.skillId}::uuid, ${resource.lessonVersionId}::uuid, ${reasonCode}, ${note})
        `);
      } catch (error) {
        if (isUniqueViolation(error)) throw overridePending(lecturer.correlationId);
        throw error;
      }
      await this.audit(db, lecturer, 'learning_plan_override.created', 'learning_plan_override', id, {
        studentUserId: student.studentUserId, action, resource: refOf(resource), reasonCode,
      });
      return { id, student, resource };
    });
    await this.notify(lecturer.institutionId, [created.student], 'Your lecturer set your next step', (college) =>
      `Your lecturer at ${college} set your next step: ${ACTION_WORD[action]} ${created.resource.title}. It starts when you plan your next step on Learning.`,
    { overrideId: created.id });
    return { override: { id: created.id, state: 'PENDING', action, resource: publicResource(created.resource), reasonCode } };
  }

  @Post('/institutions/:institutionId/plan-overrides/:overrideId/withdraw')
  async withdrawOverride(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('overrideId') overrideId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const lecturer = await this.writer(request, institutionId);
    if (!uuidPattern.test(overrideId)) throw notFound(lecturer.correlationId);
    const reasonCode = readWithdrawReason(body, lecturer.correlationId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const [row] = ((await db.execute(sql`
        SELECT o.state, sp.id::text AS profile_id FROM learning_plan_overrides o
        LEFT JOIN institution_student_profiles sp ON sp.institution_id = o.institution_id AND sp.student_user_id = o.student_user_id
        WHERE o.id = ${overrideId}::uuid AND o.institution_id = ${lecturer.institutionId}::uuid
        FOR UPDATE OF o
      `)) as Rows<{ state: string; profile_id: string | null }>).rows;
      // Any lecturer whose write scope covers the student may lift a pending override; others learn nothing.
      if (!row?.profile_id || !(await scopedStudentsByProfile(db, lecturer.institutionId, lecturer.scope, [row.profile_id]))) throw notFound(lecturer.correlationId);
      if (row.state !== 'PENDING') throw conflict('OVERRIDE_NOT_PENDING', 'This next step has already been used or withdrawn.', lecturer.correlationId);
      await db.execute(sql`
        UPDATE learning_plan_overrides SET state = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by_user_id = ${lecturer.userId}::uuid, withdraw_reason_code = ${reasonCode}
        WHERE id = ${overrideId}::uuid AND state = 'PENDING'
      `);
      await this.audit(db, lecturer, 'learning_plan_override.withdrawn', 'learning_plan_override', overrideId, { reasonCode });
      return { override: { id: overrideId.toLowerCase(), state: 'WITHDRAWN' } };
    });
  }

  // --- The student's view -----------------------------------------------------------------------

  @Get('/students/me/learning-actions')
  async mine(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    return { ...(await readStudentLearningActions(this.db, context.authorization.principal.userId)) };
  }

  // --- Helpers -----------------------------------------------------------------------------------

  private async lecturer(request: ProtectedHttpRequest, institutionId: string): Promise<Lecturer> {
    const context = requireTrustedAuthorization(request);
    if (!uuidPattern.test(institutionId)) throw forbidden(context.correlationId);
    const id = institutionId.toLowerCase();
    const memberships = institutionStaffScopeMemberships(request, id, ['FACULTY_LECTURER']);
    const primary = memberships[0];
    if (!primary?.membershipId) throw forbidden(context.correlationId);
    const resolved = await withTeachingAssignments(this.db, id, memberships);
    const mode = resolved.some((membership) => Array.isArray(membership.teachingUnitIds)) ? 'ASSIGNMENTS' : 'MEMBERSHIP';
    const teachingUnitIds = [...new Set(resolved.flatMap((membership) => membership.teachingUnitIds ?? []))].map((unit) => unit.toLowerCase()).sort();
    const scope = await resolveInstitutionStudentWriteScope(this.db, id, memberships);
    return {
      institutionId: id, correlationId: context.correlationId, userId: context.authorization.principal.userId, membershipId: primary.membershipId,
      departmentUnitId: primary.departmentUnitId ?? null, batchUnitId: primary.batchUnitId ?? null, mode, teachingUnitIds, scope,
    };
  }

  /** A lecturer allowed to act on students: an active teaching assignment is required. */
  private async writer(request: ProtectedHttpRequest, institutionId: string): Promise<Lecturer> {
    const lecturer = await this.lecturer(request, institutionId);
    if (lecturer.scope.kind === 'NONE') {
      throw new ForbiddenException({ error: { code: 'SCOPE_REQUIRED', message: 'An active teaching assignment is required for this action.', correlationId: lecturer.correlationId } });
    }
    return lecturer;
  }

  private async published(db: PersistenceDb, ref: LearningResourceRef, correlationId: string): Promise<LearningResource> {
    const resource = await resolveLearningResource(db, ref);
    if (!resource) throw new BadRequestException({ error: { code: 'CONTENT_NOT_PUBLISHED', message: 'Only published ONE content can be assigned.', correlationId } });
    return resource;
  }

  private async students(db: PersistenceDb, lecturer: Lecturer, target: Target): Promise<readonly ScopedStudent[]> {
    if (target.unitId) {
      if (!lecturer.teachingUnitIds.includes(target.unitId)) {
        throw new ForbiddenException({ error: { code: 'UNIT_NOT_TAUGHT', message: 'Choose one of the classes you teach.', correlationId: lecturer.correlationId } });
      }
      const found = await scopedStudentsInUnit(db, lecturer.institutionId, lecturer.scope, target.unitId, MAX_ACTION_STUDENTS + 1);
      if (found.length > MAX_ACTION_STUDENTS) throw tooMany(lecturer.correlationId);
      if (found.length === 0) throw new BadRequestException({ error: { code: 'NO_STUDENTS', message: 'This class has no current students.', correlationId: lecturer.correlationId } });
      return found;
    }
    const found = await scopedStudentsByProfile(db, lecturer.institutionId, lecturer.scope, target.profileIds);
    if (!found) throw new ForbiddenException({ error: { code: 'STUDENT_OUT_OF_SCOPE', message: 'Choose students from the classes you teach.', correlationId: lecturer.correlationId } });
    return found;
  }

  private async student(db: PersistenceDb, lecturer: Lecturer, profileId: string): Promise<ScopedStudent> {
    const found = uuidPattern.test(profileId) ? await scopedStudentsByProfile(db, lecturer.institutionId, lecturer.scope, [profileId]) : null;
    if (!found?.[0]) throw new ForbiddenException({ error: { code: 'STUDENT_OUT_OF_SCOPE', message: 'Choose a student from the classes you teach.', correlationId: lecturer.correlationId } });
    return found[0];
  }

  private async ownAssignment(db: PersistenceDb, lecturer: Lecturer, assignmentId: string, lock: boolean): Promise<{ withdrawn: boolean }> {
    const [row] = ((await db.execute(sql`
      SELECT (withdrawn_at IS NOT NULL) AS withdrawn FROM learning_assignments
      WHERE id = ${assignmentId}::uuid AND institution_id = ${lecturer.institutionId}::uuid AND assigned_by_user_id = ${lecturer.userId}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}
    `)) as Rows<{ withdrawn: boolean }>).rows;
    if (!row) throw notFound(lecturer.correlationId);
    return { withdrawn: row.withdrawn === true };
  }

  private async audit(db: PersistenceDb, lecturer: Lecturer, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${lecturer.userId}::uuid, ${action}, ${resourceType}, ${resourceId}, ${lecturer.institutionId}::uuid,
        'SUCCESS', ${lecturer.correlationId}, ${JSON.stringify({ ...context, mode: lecturer.mode })}::jsonb)
    `);
  }

  /** Best-effort, after commit: in-app notices. Never undoes the action. */
  private async notify(institutionId: string, students: readonly ScopedStudent[], title: string, body: (college: string) => string, data: Record<string, string>): Promise<void> {
    try {
      const [org] = ((await this.db.execute(sql`SELECT legal_name FROM organizations WHERE id = ${institutionId}::uuid`)) as Rows<{ legal_name: string }>).rows;
      const text = body(org?.legal_name ?? 'your college');
      for (const student of students) await recordNotification(this.db, this.ids, { userId: student.studentUserId, kind: 'SYSTEM', title, body: text, data });
    } catch {
      // Notification failures never undo a faculty action.
    }
  }
}

interface Target { readonly unitId: string | null; readonly profileIds: readonly string[] }

function readTarget(input: Record<string, unknown>, lecturer: Lecturer): Target {
  const hasUnit = input.unitId !== undefined && input.unitId !== null;
  const hasStudents = input.studentProfileIds !== undefined && input.studentProfileIds !== null;
  if (hasUnit === hasStudents) throw invalid(lecturer.correlationId, 'target');
  if (hasUnit) {
    if (typeof input.unitId !== 'string' || !uuidPattern.test(input.unitId)) throw invalid(lecturer.correlationId, 'unitId');
    return { unitId: input.unitId.toLowerCase(), profileIds: [] };
  }
  const ids = input.studentProfileIds;
  if (!Array.isArray(ids) || ids.length < 1) throw invalid(lecturer.correlationId, 'studentProfileIds');
  if (ids.length > MAX_ACTION_STUDENTS) throw tooMany(lecturer.correlationId);
  if (ids.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) throw invalid(lecturer.correlationId, 'studentProfileIds');
  const lower = (ids as string[]).map((id) => id.toLowerCase());
  if (new Set(lower).size !== lower.length) throw invalid(lecturer.correlationId, 'studentProfileIds');
  return { unitId: null, profileIds: lower };
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

function readWithdrawReason(body: unknown, correlationId: string): string {
  const { reasonCode } = objectBody(body, ['reasonCode'], correlationId);
  if (typeof reasonCode !== 'string' || !(FACULTY_WITHDRAW_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new BadRequestException({ error: { code: 'INVALID_REASON_CODE', message: 'Choose one of the listed reasons.', correlationId } });
  }
  return reasonCode;
}

function objectBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid(correlationId, 'body');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid(correlationId, 'body');
  return record;
}

function readText(value: unknown, max: number, correlationId: string, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw invalid(correlationId, field);
    return null;
  }
  if (typeof value !== 'string') throw invalid(correlationId, field);
  const text = value.trim();
  if (text.length > max || (required && !text)) throw invalid(correlationId, field);
  return text || null;
}

function readInstant(value: unknown, correlationId: string, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid(correlationId, field);
  }
  return new Date(value);
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid(correlationId, 'limit');
  return limit;
}

function readCursor(value: string | undefined, correlationId: string): [string, string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string' && parsed[0].length <= 400
      && (LEARNING_CONTENT_KINDS as readonly string[]).includes(parsed[1] as string) && typeof parsed[2] === 'string' && uuidPattern.test(parsed[2])) {
      return [parsed[0], parsed[1] as string, parsed[2].toLowerCase()];
    }
  } catch { /* fall through */ }
  throw invalid(correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function refOf(resource: LearningResourceRef): LearningResourceRef {
  return { kind: resource.kind, skillId: resource.skillId, lessonVersionId: resource.lessonVersionId };
}

function publicResource(resource: LearningResource): Record<string, unknown> {
  return {
    kind: resource.kind, skillId: resource.skillId, lessonVersionId: resource.lessonVersionId, title: resource.title,
    skillName: resource.skillName, moduleTitle: resource.moduleTitle, questionCount: resource.questionCount,
  };
}

function publicOverride(override: NonNullable<Awaited<ReturnType<typeof pendingOverrideFor>>>): Record<string, unknown> {
  return { id: override.id, action: override.action, resource: override.resource, reasonCode: override.reasonCode, state: override.state, createdAt: override.createdAt };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

function invalid(correlationId: string, field: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be completed', correlationId, field } });
}

function tooMany(correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code: 'TOO_MANY_STUDENTS', message: `At most ${MAX_ACTION_STUDENTS} students at a time.`, correlationId } });
}

function overridePending(correlationId: string): ConflictException {
  return conflict('OVERRIDE_PENDING', 'This student already has a next step set by a lecturer. Withdraw it first.', correlationId);
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
