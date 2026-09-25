/**
 * Faculty teaching assignments, "My Students", and staff unit scope (INST-03).
 *
 * A teaching assignment says which faculty membership teaches which section or batch,
 * for which subject and term. Once an institution records one, faculty scope everywhere
 * comes from active assignments through the shared scope helper (packages/authorization
 * institution-scope.ts) — this controller only writes and lists them, and serves the
 * faculty "My Students" read. Admins assign anywhere; department heads only within their
 * department; faculty read their own. The staff-scope action lets an admin set or clear
 * the department/batch on an existing staff membership (the INST-02 follow-up).
 * Design: docs/architecture/faculty-teaching-assignments-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { institutionUnitDescendants, isUnitWithin, type InstitutionUnitNode } from '@planthepath/authorization/src/index.js';
import { activeTeachingAssignmentSql, institutionStudentScopeSql, loadInstitutionUnitTree, resolveInstitutionStudentScope, withTeachingAssignments } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { loadStudentActivations } from '@planthepath/persistence/src/student-invitations.js';
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
import { readStaffUnitScope, staffScopeError, validateStaffUnitScope } from './institution-staff-scope.js';

type Rows<T> = { rows: T[] };
type TrustedContext = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const formulaStart = /^[=+@-]/;
const adminRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const scopableStaffRoles = ['PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const assignmentFields = new Set(['facultyMembershipId', 'unitId', 'subjectId', 'subjectCode', 'academicTerm', 'startsOn', 'endsOn', 'reasonCode']);
/** Staff-action states that still need someone to act. */
const openTaskStates = ['DRAFT', 'OPEN', 'IN_PROGRESS', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'];

/** What the caller may do with teaching assignments in this institution. */
interface TeachingAuthority {
  readonly context: TrustedContext;
  readonly institutionId: string;
  readonly admin: boolean;
  /** Department units of the caller's DEPARTMENT_HEAD memberships that carry one. */
  readonly headDepartments: readonly string[];
  /** The caller's own FACULTY_LECTURER memberships. */
  readonly facultyMembershipIds: readonly string[];
}

interface AssignmentRow extends Record<string, unknown> {
  id: string; faculty_membership_id: string; faculty_email: string; unit_id: string; unit_kind: string; unit_name: string;
  subject_id: string | null; subject_name: string | null; subject_code_ref: string | null; subject_code: string | null;
  academic_term: string; starts_on: string; ends_on: string | null; state: string; active: boolean; reason_code: string;
  created_at: Date | string; created_key: string; ended_at: Date | string | null; end_reason_code: string | null;
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionTeachingAssignmentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/institutions/:institutionId/teaching-assignments')
  async list(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('state') state?: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const authority = teachingAuthority(request, institutionId);
    const { context, institutionId: id } = authority;
    if (!authority.admin && authority.headDepartments.length === 0 && authority.facultyMembershipIds.length === 0) throw forbidden(context.correlationId);
    const stateFilter = state === undefined || state === '' ? 'ALL' : state;
    if (!['ACTIVE', 'ENDED', 'ALL'].includes(stateFilter)) throw invalid('INVALID_QUERY', context.correlationId, 'state');
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    const tree = await loadInstitutionUnitTree(this.db, id);
    const headUnits = departmentUnits(authority.headDepartments, tree);
    const canAssign = authority.admin || authority.headDepartments.length > 0;
    const rows = await this.db.execute(sql`
      ${assignmentSelect(id)}
        AND (${authority.admin}::boolean OR fta.unit_id = ANY(${uuidArray(headUnits)}::uuid[]) OR fta.faculty_membership_id = ANY(${uuidArray(authority.facultyMembershipIds)}::uuid[]))
        AND (${stateFilter}::text = 'ALL' OR (${stateFilter}::text = 'ACTIVE' AND ${activeTeachingAssignmentSql('fta')}) OR (${stateFilter}::text = 'ENDED' AND NOT ${activeTeachingAssignmentSql('fta')}))
        AND (${cursor?.[0] ?? null}::timestamptz IS NULL OR (fta.created_at, fta.id) < (${cursor?.[0] ?? null}::timestamptz, ${cursor?.[1] ?? null}::uuid))
      ORDER BY fta.created_at DESC, fta.id DESC
      LIMIT ${limit + 1}
    `) as Rows<AssignmentRow>;
    const page = rows.rows.slice(0, limit);
    const options = canAssign ? await this.assignmentOptions(id, authority.admin ? null : headUnits) : { faculty: [], units: [], subjects: [] };
    return {
      assignments: page.map(mapAssignment),
      nextCursor: rows.rows.length > limit ? encodeCursor([page.at(-1)!.created_key, page.at(-1)!.id]) : null,
      canAssign,
      ...options,
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/teaching-assignments')
  async create(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const authority = teachingAuthority(request, institutionId);
    const { context, institutionId: id } = authority;
    if (!authority.admin && authority.headDepartments.length === 0) throw forbidden(context.correlationId);
    const input = readAssignmentInput(body, context.correlationId);
    const assignmentId = this.ids.uuid();
    try {
      await this.db.transaction(async (tx) => {
        const faculty = await tx.execute(sql`
          SELECT id FROM organization_memberships
          WHERE id = ${input.facultyMembershipId}::uuid AND organization_id = ${id}::uuid AND scope_institution_id = ${id}::uuid
            AND role = 'FACULTY_LECTURER' AND state = 'ACTIVE'
          FOR SHARE
        `) as Rows<{ id: string }>;
        if (!faculty.rows[0]) throw invalid('INVALID_FACULTY_MEMBERSHIP', context.correlationId, 'facultyMembershipId');
        const unit = await tx.execute(sql`
          SELECT id FROM institution_units WHERE id = ${input.unitId}::uuid AND institution_id = ${id}::uuid AND kind IN ('SECTION', 'BATCH')
        `) as Rows<{ id: string }>;
        if (!unit.rows[0]) throw invalid('INVALID_TEACHING_UNIT', context.correlationId, 'unitId');
        if (input.subjectId) {
          const subject = await tx.execute(sql`SELECT id FROM exam_subjects WHERE id = ${input.subjectId}::uuid AND institution_id = ${id}::uuid`) as Rows<{ id: string }>;
          if (!subject.rows[0]) throw invalid('INVALID_SUBJECT', context.correlationId, 'subjectId');
        }
        const window = await tx.execute(sql`
          SELECT (${input.endsOn}::date IS NOT NULL AND ${input.endsOn}::date < coalesce(${input.startsOn}::date, current_date)) AS inverted
        `) as Rows<{ inverted: boolean }>;
        if (window.rows[0]?.inverted) throw invalid('INVALID_TEACHING_WINDOW', context.correlationId, 'endsOn');
        if (!authority.admin && !withinAny(input.unitId, authority.headDepartments, await loadInstitutionUnitTree(tx, id))) throw forbidden(context.correlationId);
        await tx.execute(sql`
          INSERT INTO faculty_teaching_assignments
            (id, institution_id, faculty_membership_id, unit_id, subject_id, subject_code, academic_term, starts_on, ends_on, assigned_by_user_id, reason_code)
          VALUES (${assignmentId}::uuid, ${id}::uuid, ${input.facultyMembershipId}::uuid, ${input.unitId}::uuid, ${input.subjectId}::uuid, ${input.subjectCode},
                  ${input.academicTerm}, coalesce(${input.startsOn}::date, current_date), ${input.endsOn}::date, ${context.authorization.principal.userId}::uuid, ${input.reasonCode})
        `);
        await writeAudit(tx, {
          id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.teaching_assignment.created',
          resourceType: 'faculty_teaching_assignment', resourceId: assignmentId, organizationId: id, correlationId: context.correlationId,
          context: { reasonCode: input.reasonCode, facultyMembershipId: input.facultyMembershipId, unitId: input.unitId, subjectId: input.subjectId, subjectCode: input.subjectCode, academicTerm: input.academicTerm },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(errorBody('TEACHING_ASSIGNMENT_ALREADY_ACTIVE', context.correlationId));
      throw error;
    }
    return { assignment: mapAssignment(await this.loadAssignment(id, assignmentId)), correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/teaching-assignments/:assignmentId/end')
  async end(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('assignmentId') assignmentIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const authority = teachingAuthority(request, institutionId);
    const { context, institutionId: id } = authority;
    if (!authority.admin && authority.headDepartments.length === 0) throw forbidden(context.correlationId);
    const assignmentId = requireUuid(assignmentIdParam, context.correlationId);
    const source = readBody(body, new Set(['reasonCode']), context.correlationId);
    const reasonCode = readReason(source.reasonCode, context.correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT id, unit_id, state FROM faculty_teaching_assignments WHERE id = ${assignmentId}::uuid AND institution_id = ${id}::uuid FOR UPDATE
      `) as Rows<{ id: string; unit_id: string; state: string }>;
      const current = found.rows[0];
      if (!current) throw forbidden(context.correlationId);
      if (!authority.admin && !withinAny(current.unit_id, authority.headDepartments, await loadInstitutionUnitTree(tx, id))) throw forbidden(context.correlationId);
      if (current.state !== 'ACTIVE') throw new ConflictException(errorBody('TEACHING_ASSIGNMENT_ALREADY_ENDED', context.correlationId));
      await tx.execute(sql`
        UPDATE faculty_teaching_assignments
        SET state = 'ENDED', ended_at = now(), ended_by_user_id = ${context.authorization.principal.userId}::uuid, end_reason_code = ${reasonCode}, updated_at = now()
        WHERE id = ${assignmentId}::uuid
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.teaching_assignment.ended',
        resourceType: 'faculty_teaching_assignment', resourceId: assignmentId, organizationId: id, correlationId: context.correlationId,
        context: { reasonCode, unitId: current.unit_id },
      });
    });
    return { assignment: mapAssignment(await this.loadAssignment(id, assignmentId)), correlationId: context.correlationId };
  }

  /**
   * Faculty "My Students": the students in the caller's faculty scope with a current
   * relationship, with activation, recent assessment activity and open tasks. The scope
   * is the shared one, so this list and every other faculty read agree.
   */
  @Get('/institutions/:institutionId/my-students')
  async myStudents(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    const memberships = institutionStaffScopeMemberships(request, id, ['FACULTY_LECTURER']);
    if (memberships.length === 0) throw forbidden(context.correlationId);
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    const withAssignments = await withTeachingAssignments(this.db, id, memberships);
    const mode = withAssignments.some((membership) => Array.isArray(membership.teachingUnitIds)) ? 'ASSIGNMENTS' : 'MEMBERSHIP';
    const scope = await resolveInstitutionStudentScope(this.db, id, memberships);
    const facultyIds = memberships.map((membership) => membership.membershipId as string);
    const assignments = await this.db.execute(sql`
      ${assignmentSelect(id)}
        AND fta.faculty_membership_id = ANY(${uuidArray(facultyIds)}::uuid[]) AND ${activeTeachingAssignmentSql('fta')}
      ORDER BY unit.name, fta.academic_term, fta.id
      LIMIT 200
    `) as Rows<AssignmentRow>;
    const rows = await this.db.execute(sql`
      SELECT sp.id, sp.student_user_id, sp.full_name, sp.institution_student_id, lower(sp.full_name) AS sort_key,
             section.name AS section_name, batch.name AS batch_name
      FROM institution_student_profiles sp
      JOIN institution_relationships ir ON ir.institution_id = sp.institution_id AND ir.student_user_id = sp.student_user_id
        AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now())
      LEFT JOIN institution_units section ON section.id = sp.section_unit_id
      LEFT JOIN institution_units batch ON batch.id = sp.batch_unit_id
      WHERE sp.institution_id = ${id}::uuid
        AND ${institutionStudentScopeSql(scope, 'sp')}
        AND (${cursor?.[0] ?? null}::text IS NULL OR (lower(sp.full_name), sp.id) > (${cursor?.[0] ?? null}::text, ${cursor?.[1] ?? null}::uuid))
      ORDER BY lower(sp.full_name), sp.id
      LIMIT ${limit + 1}
    `) as Rows<{ id: string; student_user_id: string; full_name: string; institution_student_id: string; sort_key: string; section_name: string | null; batch_name: string | null }>;
    const page = rows.rows.slice(0, limit);
    const studentIds = page.map((row) => row.student_user_id);
    const [activations, tasks, assessments] = await Promise.all([
      loadStudentActivations(this.db, id, studentIds),
      this.db.execute(sql`
        SELECT subject_student_user_id AS student_user_id, count(*)::int AS open_tasks
        FROM staff_actions
        WHERE institution_id = ${id}::uuid AND action_type = 'ASSIGNED_TASK' AND archived_at IS NULL
          AND state = ANY(${`{${openTaskStates.join(',')}}`}::text[]) AND subject_student_user_id = ANY(${uuidArray(studentIds)}::uuid[])
        GROUP BY subject_student_user_id
      `) as Promise<Rows<{ student_user_id: string; open_tasks: number }>>,
      this.db.execute(sql`
        SELECT DISTINCT ON (a.student_user_id) a.student_user_id, d.title AS latest_title, a.submitted_at AS latest_submitted_at,
               count(*) OVER (PARTITION BY a.student_user_id)::int AS submitted
        FROM exam_attempts a JOIN exam_definitions d ON d.id = a.definition_id
        WHERE a.institution_id = ${id}::uuid AND a.submitted_at IS NOT NULL AND a.submitted_at > now() - interval '30 days'
          AND a.student_user_id = ANY(${uuidArray(studentIds)}::uuid[])
        ORDER BY a.student_user_id, a.submitted_at DESC
      `) as Promise<Rows<{ student_user_id: string; latest_title: string; latest_submitted_at: Date | string; submitted: number }>>,
    ]);
    const openTasks = new Map(tasks.rows.map((row) => [row.student_user_id, row.open_tasks]));
    const recent = new Map(assessments.rows.map((row) => [row.student_user_id, row]));
    return {
      mode,
      assignments: assignments.rows.map(mapAssignment),
      students: page.map((row) => {
        const latest = recent.get(row.student_user_id);
        return {
          profileId: row.id,
          studentUserId: row.student_user_id,
          fullName: row.full_name,
          institutionStudentId: row.institution_student_id,
          units: { section: row.section_name, batch: row.batch_name },
          activation: activations.get(row.student_user_id) ?? null,
          openTasks: openTasks.get(row.student_user_id) ?? 0,
          recentAssessments: {
            submitted: latest?.submitted ?? 0,
            latestTitle: latest?.latest_title ?? null,
            latestSubmittedAt: latest ? new Date(latest.latest_submitted_at).toISOString() : null,
          },
        };
      }),
      nextCursor: rows.rows.length > limit ? encodeCursor([page.at(-1)!.sort_key, page.at(-1)!.id]) : null,
      scope: await describeInstitutionStudentScope(this.db, request, id, ['FACULTY_LECTURER'], scope),
      correlationId: context.correlationId,
    };
  }

  /** Set or clear a staff membership's department and batch scope. Admins only; reason-coded and audited. */
  @Post('/institutions/:institutionId/staff-memberships/:membershipId/scope')
  async setStaffScope(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('membershipId') membershipIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const authority = teachingAuthority(request, institutionId);
    const { context, institutionId: id } = authority;
    if (!authority.admin) throw forbidden(context.correlationId);
    const membershipId = requireUuid(membershipIdParam, context.correlationId);
    const source = readBody(body, new Set(['departmentUnitId', 'batchUnitId', 'reasonCode']), context.correlationId);
    const reasonCode = readReason(source.reasonCode, context.correlationId);
    const scope = readStaffUnitScope(source, context.correlationId);
    try {
      await this.db.transaction(async (tx) => {
        const found = await tx.execute(sql`
          SELECT id, role, scope_department_unit_id, scope_batch_unit_id FROM organization_memberships
          WHERE id = ${membershipId}::uuid AND organization_id = ${id}::uuid AND scope_institution_id = ${id}::uuid
            AND state = 'ACTIVE' AND role = ANY(${`{${scopableStaffRoles.join(',')}}`}::text[])
          FOR UPDATE
        `) as Rows<{ id: string; role: string; scope_department_unit_id: string | null; scope_batch_unit_id: string | null }>;
        const membership = found.rows[0];
        if (!membership) throw forbidden(context.correlationId);
        await validateStaffUnitScope(tx, id, membership.role, scope, context.correlationId);
        await tx.execute(sql`
          UPDATE organization_memberships
          SET scope_department_unit_id = ${scope.departmentUnitId}::uuid, scope_batch_unit_id = ${scope.batchUnitId}::uuid, updated_at = now()
          WHERE id = ${membershipId}::uuid
        `);
        await writeAudit(tx, {
          id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.staff_membership.scope_changed',
          resourceType: 'organization_membership', resourceId: membershipId, organizationId: id, correlationId: context.correlationId,
          context: {
            reasonCode, role: membership.role,
            before: { departmentUnitId: membership.scope_department_unit_id, batchUnitId: membership.scope_batch_unit_id },
            after: { departmentUnitId: scope.departmentUnitId, batchUnitId: scope.batchUnitId },
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(errorBody('STAFF_SCOPE_ALREADY_HELD', context.correlationId));
      throw error;
    }
    return { membership: { id: membershipId, scope }, correlationId: context.correlationId };
  }

  private async loadAssignment(institutionId: string, assignmentId: string): Promise<AssignmentRow> {
    const rows = await this.db.execute(sql`${assignmentSelect(institutionId)} AND fta.id = ${assignmentId}::uuid`) as Rows<AssignmentRow>;
    return rows.rows[0]!;
  }

  /** The choices an assigning caller needs: faculty, sections and batches (a head's own department only), subjects. */
  private async assignmentOptions(institutionId: string, limitToUnits: readonly string[] | null): Promise<Record<string, unknown>> {
    const [faculty, units, subjects] = await Promise.all([
      this.db.execute(sql`
        SELECT m.id AS membership_id, u.email FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${institutionId}::uuid AND m.scope_institution_id = ${institutionId}::uuid
          AND m.role = 'FACULTY_LECTURER' AND m.state = 'ACTIVE'
        ORDER BY u.email, m.id LIMIT 500
      `) as Promise<Rows<{ membership_id: string; email: string }>>,
      this.db.execute(sql`
        SELECT id, kind::text AS kind, name, parent_unit_id FROM institution_units
        WHERE institution_id = ${institutionId}::uuid AND kind IN ('SECTION', 'BATCH')
          AND (${limitToUnits === null}::boolean OR id = ANY(${uuidArray(limitToUnits ?? [])}::uuid[]))
        ORDER BY kind, name, id
      `) as Promise<Rows<{ id: string; kind: string; name: string; parent_unit_id: string | null }>>,
      this.db.execute(sql`
        SELECT id, name, code FROM exam_subjects WHERE institution_id = ${institutionId}::uuid AND is_active ORDER BY name, id LIMIT 500
      `) as Promise<Rows<{ id: string; name: string; code: string | null }>>,
    ]);
    return {
      faculty: faculty.rows.map((row) => ({ membershipId: row.membership_id, email: row.email })),
      units: units.rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, parentUnitId: row.parent_unit_id })),
      subjects: subjects.rows.map((row) => ({ id: row.id, name: row.name, code: row.code })),
    };
  }
}

function teachingAuthority(request: ProtectedHttpRequest, institutionId: string): TeachingAuthority {
  const context = requireTrustedAuthorization(request);
  const id = requireUuid(institutionId, context.correlationId);
  const memberships = context.authorization.memberships.filter((membership) => membership.state === 'ACTIVE'
    && membership.organizationId === id && membership.scope.organizationId === id && membership.scope.institutionId === id);
  return {
    context,
    institutionId: id,
    admin: memberships.some((membership) => adminRoles.includes(membership.role)),
    headDepartments: [...new Set(memberships
      .filter((membership) => membership.role === 'DEPARTMENT_HEAD' && membership.scope.departmentId)
      .map((membership) => membership.scope.departmentId as string))],
    facultyMembershipIds: memberships.filter((membership) => membership.role === 'FACULTY_LECTURER').map((membership) => membership.id),
  };
}

function departmentUnits(departments: readonly string[], tree: readonly InstitutionUnitNode[]): readonly string[] {
  return [...new Set(departments.flatMap((department) => institutionUnitDescendants(department, tree)))];
}

function withinAny(unitId: string, departments: readonly string[], tree: readonly InstitutionUnitNode[]): boolean {
  return departments.some((department) => isUnitWithin(unitId, department, tree));
}

function assignmentSelect(institutionId: string) {
  return sql`
    SELECT fta.id, fta.faculty_membership_id, fu.email AS faculty_email, fta.unit_id, unit.kind::text AS unit_kind, unit.name AS unit_name,
           fta.subject_id, subject.name AS subject_name, subject.code AS subject_code_ref, fta.subject_code, fta.academic_term,
           fta.starts_on::text AS starts_on, fta.ends_on::text AS ends_on, fta.state, ${activeTeachingAssignmentSql('fta')} AS active,
           fta.reason_code, fta.created_at, fta.created_at::text AS created_key, fta.ended_at, fta.end_reason_code
    FROM faculty_teaching_assignments fta
    JOIN organization_memberships fm ON fm.id = fta.faculty_membership_id
    JOIN users fu ON fu.id = fm.user_id
    JOIN institution_units unit ON unit.id = fta.unit_id
    LEFT JOIN exam_subjects subject ON subject.id = fta.subject_id
    WHERE fta.institution_id = ${institutionId}::uuid`;
}

function mapAssignment(row: AssignmentRow): Record<string, unknown> {
  return {
    id: row.id,
    facultyMembershipId: row.faculty_membership_id,
    facultyEmail: row.faculty_email,
    unit: { id: row.unit_id, kind: row.unit_kind, name: row.unit_name },
    subject: row.subject_id ? { id: row.subject_id, name: row.subject_name, code: row.subject_code_ref } : null,
    subjectCode: row.subject_code,
    academicTerm: row.academic_term,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    state: row.state,
    active: row.active,
    reasonCode: row.reason_code,
    assignedAt: new Date(row.created_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    endReasonCode: row.end_reason_code,
  };
}

function readAssignmentInput(body: unknown, correlationId: string): {
  facultyMembershipId: string; unitId: string; subjectId: string | null; subjectCode: string | null;
  academicTerm: string; startsOn: string | null; endsOn: string | null; reasonCode: string;
} {
  const source = readBody(body, assignmentFields, correlationId);
  const uuid = (field: string, required: boolean): string | null => {
    const value = source[field];
    if (value === undefined || value === null || value === '') {
      if (required) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, field);
      return null;
    }
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, field);
    return value.toLowerCase();
  };
  const text = (field: string, max: number, required: boolean): string | null => {
    const value = source[field];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      if (required) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, field);
      return null;
    }
    if (typeof value !== 'string' || value.trim().length > max || formulaStart.test(value.trim())) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, field);
    return value.trim();
  };
  const date = (field: string): string | null => {
    const value = source[field];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !datePattern.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))
      || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, field);
    return value;
  };
  const input = {
    facultyMembershipId: uuid('facultyMembershipId', true) as string,
    unitId: uuid('unitId', true) as string,
    subjectId: uuid('subjectId', false),
    subjectCode: text('subjectCode', 32, false),
    academicTerm: text('academicTerm', 40, true) as string,
    startsOn: date('startsOn'),
    endsOn: date('endsOn'),
    reasonCode: readReason(source.reasonCode, correlationId),
  };
  if (!input.subjectId && !input.subjectCode) throw invalid('INVALID_TEACHING_ASSIGNMENT', correlationId, 'subjectId');
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw invalid('INVALID_TEACHING_WINDOW', correlationId, 'endsOn');
  return input;
}

function readBody(body: unknown, allowed: ReadonlySet<string>, correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  const source = body as Record<string, unknown>;
  const unknown = Object.keys(source).find((key) => !allowed.has(key));
  if (unknown) throw invalid('UNKNOWN_FIELD', correlationId, unknown);
  return source;
}

function readReason(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !reasonPattern.test(value)) throw invalid('INVALID_REASON_CODE', correlationId, 'reasonCode');
  return value;
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('INVALID_QUERY', correlationId, 'limit');
  return limit;
}

function readCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && parsed[0].length <= 200
      && typeof parsed[1] === 'string' && uuidPattern.test(parsed[1])) return [parsed[0], parsed[1]];
  } catch { /* fall through */ }
  throw invalid('INVALID_QUERY', correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function uuidArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

function errorBody(code: string, correlationId: string, field?: string) {
  return { error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } };
}

function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return code === 'INVALID_STAFF_UNIT_SCOPE' ? staffScopeError(code, correlationId, field) : new BadRequestException(errorBody(code, correlationId, field));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

async function writeAudit(db: PersistenceDb, input: { id: string; actorUserId: string; action: string; resourceType: string; resourceId: string; organizationId: string; correlationId: string; context: Record<string, unknown> }): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}
