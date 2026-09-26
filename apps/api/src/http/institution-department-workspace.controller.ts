/**
 * Department head and faculty workspaces (INST-07).
 *
 * Department-scoped versions of the admin modules: the department overview (roster,
 * activation, assessments in progress, last month's readiness bands, open interventions
 * and tasks, batches), the placement pipeline and the shared application records behind
 * "Opportunities and Offers", the department's staff, and the lecturer's class reports.
 *
 * Every student-level number comes from the single INST-02 scope helper, optionally
 * narrowed to one unit (`?unitId=`) — which is how an administrator's view "filtered to a
 * department" is the same query as the head's own, so the two always reconcile. Narrowing
 * never widens: a head who asks for another department gets nobody. Aggregates over
 * readiness and applications go through the one suppression helper (cells under 5 show
 * <5, recoverable totals withheld). Application stages come only from applications the
 * student has shared with the college, counted while the relationship authorises them
 * (ADR-019); offers are reported by existence and response only, never pay (ADR-024);
 * readiness is bands only (ADR-020). Reading application records is audited (§5.4).
 */
import { BadRequestException, Controller, ForbiddenException, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  institutionUnitDescendants,
  latestReportingMonth,
  narrowInstitutionStudentScope,
  suppressAggregateTable,
  suppressSmallCount,
  type InstitutionStudentScope,
  type InstitutionUnitNode,
} from '@planthepath/authorization/src/index.js';
import { institutionReadinessDistribution } from '@planthepath/persistence/src/career-readiness.js';
import { activeTeachingAssignmentSql, institutionStudentScopeSql, loadInstitutionUnitTree, resolveInstitutionStudentScope, withTeachingAssignments } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { loadStudentActivations, summariseActivations } from '@planthepath/persistence/src/student-invitations.js';
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

type Rows<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A Postgres timestamptz as text (the keyset cursor keeps its microseconds, which a JS Date would drop). */
const timestampPattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
/** Roles with a department workspace. Faculty have class reports instead. */
const departmentWorkspaceRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'];
const departmentStaffReaderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'DEPARTMENT_HEAD'];
const institutionStaffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
/** Staff-action states that still need someone to act (as INST-03's My Students counts them). */
const openActionStates = ['DRAFT', 'OPEN', 'IN_PROGRESS', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'];
/** Every submitted application state; each application is in exactly one, so they partition the total. */
const applicationStages = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
/** Offer states a college may learn of: an employer's unsent DRAFT is not an offer yet. */
const offerStates = ['EXTENDED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'] as const;

/** The reader's scope, optionally narrowed to one unit of the institution. */
interface ReaderScope {
  readonly institutionId: string;
  readonly correlationId: string;
  readonly actorUserId: string;
  readonly roles: readonly string[];
  /** The reader's own scope, for naming it on the screen. */
  readonly own: InstitutionStudentScope;
  /** The scope every query uses: `own`, narrowed to `unit` when one was asked for. */
  readonly scope: InstitutionStudentScope;
  readonly unit: { readonly id: string; readonly kind: string; readonly name: string } | null;
  readonly tree: readonly InstitutionUnitNode[];
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionDepartmentWorkspaceController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/institutions/:institutionId/department-overview')
  async overview(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('unitId') unitId?: string,
  ): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId, departmentWorkspaceRoles, unitId);
    const id = reader.institutionId;
    const roster = await this.db.execute(sql`
      SELECT sp.student_user_id, sp.department_unit_id, sp.program_unit_id, sp.batch_unit_id, sp.section_unit_id,
             ${currentRelationshipSql('sp')} AS current
      FROM institution_student_profiles sp
      WHERE sp.institution_id = ${id}::uuid AND ${institutionStudentScopeSql(reader.scope, 'sp')}
    `) as Rows<{ student_user_id: string; department_unit_id: string | null; program_unit_id: string | null; batch_unit_id: string | null; section_unit_id: string | null; current: boolean }>;
    const activations = await loadStudentActivations(this.db, id, roster.rows.map((row) => row.student_user_id));
    const [assessments, actions, readiness] = await Promise.all([
      this.db.execute(sql`
        WITH scoped AS (
          SELECT sp.student_user_id FROM institution_student_profiles sp
          WHERE sp.institution_id = ${id}::uuid AND ${institutionStudentScopeSql(reader.scope, 'sp')}
        ), open_definitions AS (
          SELECT d.id FROM exam_definitions d
          WHERE d.institution_id = ${id}::uuid AND d.lifecycle_state = 'PUBLISHED' AND d.starts_at <= now() AND d.ends_at > now()
        ), assigned AS (
          SELECT a.definition_id, a.student_user_id FROM exam_assignments a
          JOIN open_definitions o ON o.id = a.definition_id
          JOIN scoped s ON s.student_user_id = a.student_user_id
          WHERE a.institution_id = ${id}::uuid
        )
        SELECT (SELECT count(DISTINCT definition_id) FROM assigned)::int AS in_progress,
               (SELECT count(DISTINCT student_user_id) FROM assigned)::int AS assigned_students,
               (SELECT count(DISTINCT t.student_user_id) FROM exam_attempts t
                  JOIN assigned x ON x.definition_id = t.definition_id AND x.student_user_id = t.student_user_id
                  WHERE t.institution_id = ${id}::uuid AND t.status <> 'IN_PROGRESS')::int AS completed_students
      `) as Promise<Rows<{ in_progress: number; assigned_students: number; completed_students: number }>>,
      this.db.execute(sql`
        SELECT count(*) FILTER (WHERE a.action_type = 'INTERVENTION')::int AS interventions,
               count(*) FILTER (WHERE a.action_type = 'ASSIGNED_TASK')::int AS tasks
        FROM staff_actions a
        JOIN institution_student_profiles sp ON sp.institution_id = a.institution_id AND sp.student_user_id = a.subject_student_user_id
        WHERE a.institution_id = ${id}::uuid AND a.archived_at IS NULL
          AND a.action_type IN ('INTERVENTION', 'ASSIGNED_TASK')
          AND a.state = ANY(${textArray(openActionStates)}::text[])
          AND ${institutionStudentScopeSql(reader.scope, 'sp')}
      `) as Promise<Rows<{ interventions: number; tasks: number }>>,
      this.readinessForLastMonth(reader),
    ]);
    const batches = await this.db.execute(sql`
      SELECT b.id, b.name, parent.name AS parent_name FROM institution_units b
      LEFT JOIN institution_units parent ON parent.id = b.parent_unit_id
      WHERE b.institution_id = ${id}::uuid AND b.kind = 'BATCH'
      ORDER BY b.name, b.id
    `) as Rows<{ id: string; name: string; parent_name: string | null }>;
    const visibleBatches = batches.rows.filter((batch) => unitAddressable(reader.scope, batch.id));
    return {
      scope: await describeInstitutionStudentScope(this.db, request, id, departmentWorkspaceRoles, reader.own),
      unit: reader.unit,
      students: { onRoster: roster.rows.length, current: roster.rows.filter((row) => row.current).length },
      activation: summariseActivations([...activations.values()]),
      assessments: {
        inProgress: assessments.rows[0]?.in_progress ?? 0,
        assignedStudents: assessments.rows[0]?.assigned_students ?? 0,
        completedStudents: assessments.rows[0]?.completed_students ?? 0,
      },
      readiness,
      staffActions: { openInterventions: actions.rows[0]?.interventions ?? 0, openTasks: actions.rows[0]?.tasks ?? 0 },
      batches: visibleBatches.map((batch) => {
        const covered = new Set(institutionUnitDescendants(batch.id, reader.tree));
        const members = roster.rows.filter((row) => [row.department_unit_id, row.program_unit_id, row.batch_unit_id, row.section_unit_id]
          .some((unit) => unit !== null && covered.has(unit)));
        return {
          id: batch.id,
          name: batch.name,
          parentName: batch.parent_name,
          students: members.length,
          current: members.filter((row) => row.current).length,
          activated: members.filter((row) => activations.get(row.student_user_id)?.state === 'ACTIVATED').length,
        };
      }),
      correlationId: reader.correlationId,
    };
  }

  @Get('/institutions/:institutionId/placement-pipeline')
  async pipeline(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('unitId') unitId?: string,
  ): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId, departmentWorkspaceRoles, unitId);
    const rows = await this.db.execute(sql`
      ${sharedApplicationsCte(reader)}
      SELECT state, student_user_id, offer_state FROM shared
    `) as Rows<{ state: string; student_user_id: string; offer_state: string | null }>;
    const stageCounts = new Map<string, number>();
    const offerCounts = new Map<string, number>();
    for (const row of rows.rows) {
      stageCounts.set(row.state, (stageCounts.get(row.state) ?? 0) + 1);
      if (row.offer_state) offerCounts.set(row.offer_state, (offerCounts.get(row.offer_state) ?? 0) + 1);
    }
    return {
      scope: await describeInstitutionStudentScope(this.db, request, reader.institutionId, departmentWorkspaceRoles, reader.own),
      unit: reader.unit,
      studentsSharing: suppressSmallCount(new Set(rows.rows.map((row) => row.student_user_id)).size),
      stages: suppressAggregateTable(applicationStages.map((key) => ({ key, count: stageCounts.get(key) ?? 0 }))),
      offers: suppressAggregateTable(offerStates.map((key) => ({ key, count: offerCounts.get(key) ?? 0 }))),
      correlationId: reader.correlationId,
    };
  }

  /** The shared application records behind "Opportunities and Offers". Audited: these are application records (§5.4). */
  @Get('/institutions/:institutionId/placement-applications')
  async applications(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('unitId') unitId?: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId, departmentWorkspaceRoles, unitId);
    const limit = readLimit(limitParam, reader.correlationId);
    const cursor = readCursor(cursorParam, reader.correlationId);
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        ${sharedApplicationsCte(reader)}
        SELECT shared.id, shared.state, shared.submitted_at, shared.updated_at, shared.updated_at::text AS sort_key,
               shared.offer_state, shared.full_name, shared.institution_student_id,
               employer.legal_name AS employer_name, v.title AS opportunity_title
        FROM shared
        JOIN organizations employer ON employer.id = shared.employer_id AND employer.kind = 'EMPLOYER'
        JOIN opportunity_versions v ON v.id = shared.applied_version_id AND v.opportunity_id = shared.opportunity_id
        WHERE (${cursor?.[0] ?? null}::text IS NULL
          OR (shared.updated_at, shared.id) < (${cursor?.[0] ?? null}::timestamptz, ${cursor?.[1] ?? null}::uuid))
        ORDER BY shared.updated_at DESC, shared.id DESC
        LIMIT ${limit + 1}
      `) as Rows<{
        id: string; state: string; submitted_at: Date | string | null; updated_at: Date | string; sort_key: string; offer_state: string | null;
        full_name: string; institution_student_id: string; employer_name: string; opportunity_title: string;
      }>;
      const page = rows.rows.slice(0, limit);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${reader.actorUserId}::uuid, 'institution.placement_applications.listed', 'institution',
          ${reader.institutionId}, ${reader.institutionId}::uuid, 'SUCCESS', ${reader.correlationId},
          ${JSON.stringify({ returned: page.length, unitId: reader.unit?.id ?? null, page: cursor ? 'NEXT' : 'FIRST' })}::jsonb)
      `);
      return {
        applications: page.map((row) => ({
          id: row.id,
          student: { fullName: row.full_name, institutionStudentId: row.institution_student_id },
          employer: { name: row.employer_name },
          opportunityTitle: row.opportunity_title,
          state: row.state,
          submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
          updatedAt: new Date(row.updated_at).toISOString(),
          offer: { exists: row.offer_state !== null, responseState: row.offer_state },
        })),
        nextCursor: rows.rows.length > limit ? encodeCursor([page.at(-1)!.sort_key, page.at(-1)!.id]) : null,
        unit: reader.unit,
        correlationId: reader.correlationId,
      };
    });
  }

  /** The department's staff and who teaches in it. Owners/admins (and unscoped heads, as for reads) see every staff member. */
  @Get('/institutions/:institutionId/department-staff')
  async departmentStaff(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId, departmentStaffReaderRoles, undefined);
    const covered = scopeUnits(reader.scope);
    const everywhere = covered === 'ALL';
    const units = everywhere ? [] : [...covered];
    const staff = await this.db.execute(sql`
      SELECT m.id, u.email, m.role, m.state, dept.name AS department_name, batch.name AS batch_name
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN institution_units dept ON dept.id = m.scope_department_unit_id
      LEFT JOIN institution_units batch ON batch.id = m.scope_batch_unit_id
      WHERE m.organization_id = ${reader.institutionId}::uuid AND m.state = 'ACTIVE'
        AND m.role = ANY(${textArray(institutionStaffRoles)}::text[])
        AND (${everywhere}::boolean
          OR m.scope_department_unit_id = ANY(${uuidArray(units)}::uuid[])
          OR m.scope_batch_unit_id = ANY(${uuidArray(units)}::uuid[])
          OR EXISTS (SELECT 1 FROM faculty_teaching_assignments fta
                     WHERE fta.faculty_membership_id = m.id AND fta.institution_id = m.organization_id
                       AND fta.unit_id = ANY(${uuidArray(units)}::uuid[]) AND ${activeTeachingAssignmentSql('fta')}))
      ORDER BY m.role, lower(u.email), m.id
      LIMIT 500
    `) as Rows<{ id: string; email: string; role: string; state: string; department_name: string | null; batch_name: string | null }>;
    const assignments = await this.db.execute(sql`
      SELECT fta.faculty_membership_id, unit.name AS unit_name, coalesce(subject.name, fta.subject_code) AS subject, fta.academic_term
      FROM faculty_teaching_assignments fta
      JOIN institution_units unit ON unit.id = fta.unit_id
      LEFT JOIN exam_subjects subject ON subject.id = fta.subject_id
      WHERE fta.institution_id = ${reader.institutionId}::uuid AND ${activeTeachingAssignmentSql('fta')}
        AND fta.faculty_membership_id = ANY(${uuidArray(staff.rows.map((row) => row.id))}::uuid[])
        AND (${everywhere}::boolean OR fta.unit_id = ANY(${uuidArray(units)}::uuid[]))
      ORDER BY unit.name, fta.academic_term, fta.id
    `) as Rows<{ faculty_membership_id: string; unit_name: string; subject: string | null; academic_term: string }>;
    return {
      scope: await describeInstitutionStudentScope(this.db, request, reader.institutionId, departmentStaffReaderRoles, reader.own),
      staff: staff.rows.map((row) => ({
        email: row.email,
        role: row.role,
        department: row.department_name,
        batch: row.batch_name,
        assignments: assignments.rows.filter((entry) => entry.faculty_membership_id === row.id)
          .map((entry) => ({ unitName: entry.unit_name, subject: entry.subject, academicTerm: entry.academic_term })),
      })),
      correlationId: reader.correlationId,
    };
  }

  /** Faculty "Reports": one summary per section or batch the lecturer teaches. */
  @Get('/institutions/:institutionId/class-reports')
  async classReports(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    const memberships = institutionStaffScopeMemberships(request, id, ['FACULTY_LECTURER']);
    if (memberships.length === 0) throw forbidden(context.correlationId);
    const resolved = await withTeachingAssignments(this.db, id, memberships);
    const mode = resolved.some((membership) => Array.isArray(membership.teachingUnitIds)) ? 'ASSIGNMENTS' : 'MEMBERSHIP';
    const readScope = await resolveInstitutionStudentScope(this.db, id, memberships);
    const tree = await loadInstitutionUnitTree(this.db, id);
    const facultyIds = memberships.map((membership) => membership.membershipId as string);
    const taught = await this.db.execute(sql`
      SELECT fta.unit_id, coalesce(subject.name, fta.subject_code) AS subject
      FROM faculty_teaching_assignments fta
      LEFT JOIN exam_subjects subject ON subject.id = fta.subject_id
      WHERE fta.institution_id = ${id}::uuid AND fta.faculty_membership_id = ANY(${uuidArray(facultyIds)}::uuid[])
        AND ${activeTeachingAssignmentSql('fta')}
    `) as Rows<{ unit_id: string; subject: string | null }>;
    const classUnitIds = mode === 'ASSIGNMENTS'
      ? [...new Set(taught.rows.map((row) => row.unit_id))]
      : [...new Set(memberships.flatMap((membership) => [membership.batchUnitId ?? membership.departmentUnitId].filter((unit): unit is string => Boolean(unit))))];
    const unitRows = await this.db.execute(sql`
      SELECT id, kind::text AS kind, name FROM institution_units
      WHERE institution_id = ${id}::uuid AND id = ANY(${uuidArray(classUnitIds)}::uuid[])
      ORDER BY name, id
    `) as Rows<{ id: string; kind: string; name: string }>;
    const classes = [];
    for (const unit of unitRows.rows) {
      const scope = narrowInstitutionStudentScope(readScope, institutionUnitDescendants(unit.id, tree));
      const [students, assessments] = await Promise.all([
        this.db.execute(sql`
          SELECT count(*)::int AS students,
                 count(*) FILTER (WHERE u.state = 'ACTIVE')::int AS activated,
                 coalesce(sum((SELECT count(*) FROM staff_actions a
                   WHERE a.institution_id = sp.institution_id AND a.subject_student_user_id = sp.student_user_id
                     AND a.action_type = 'ASSIGNED_TASK' AND a.archived_at IS NULL
                     AND a.state = ANY(${textArray(openActionStates)}::text[]))), 0)::int AS open_tasks
          FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
          WHERE sp.institution_id = ${id}::uuid AND ${institutionStudentScopeSql(scope, 'sp')} AND ${currentRelationshipSql('sp')}
        `) as Promise<Rows<{ students: number; activated: number; open_tasks: number }>>,
        this.db.execute(sql`
          WITH class AS (
            SELECT sp.student_user_id FROM institution_student_profiles sp
            WHERE sp.institution_id = ${id}::uuid AND ${institutionStudentScopeSql(scope, 'sp')} AND ${currentRelationshipSql('sp')}
          )
          SELECT d.id, d.title, d.lifecycle_state, d.starts_at, d.ends_at,
                 count(DISTINCT a.student_user_id)::int AS assigned,
                 count(DISTINCT latest.student_user_id)::int AS completed,
                 avg(latest.percentage) AS average
          FROM exam_definitions d
          JOIN exam_assignments a ON a.definition_id = d.id AND a.institution_id = d.institution_id
          JOIN class c ON c.student_user_id = a.student_user_id
          LEFT JOIN LATERAL (
            SELECT t.student_user_id, r.percentage FROM exam_attempts t JOIN exam_results r ON r.attempt_id = t.id
            WHERE t.definition_id = d.id AND t.student_user_id = a.student_user_id
            ORDER BY r.created_at DESC, r.id DESC LIMIT 1
          ) latest ON true
          WHERE d.institution_id = ${id}::uuid AND d.lifecycle_state <> 'DRAFT'
          GROUP BY d.id
          ORDER BY d.starts_at DESC, d.id
          LIMIT 20
        `) as Promise<Rows<{ id: string; title: string; lifecycle_state: string; starts_at: Date | string; ends_at: Date | string; assigned: number; completed: number; average: string | null }>>,
      ]);
      classes.push({
        unit,
        subjects: [...new Set(taught.rows.filter((row) => row.unit_id === unit.id).map((row) => row.subject).filter((subject): subject is string => Boolean(subject)))].sort(),
        students: students.rows[0]?.students ?? 0,
        activated: students.rows[0]?.activated ?? 0,
        openTasks: students.rows[0]?.open_tasks ?? 0,
        assessments: assessments.rows.map((row) => {
          // An average over fewer than five students is withheld, like every other small group (§5.3).
          const publishable = !suppressSmallCount(row.completed).suppressed && row.average !== null;
          return {
            id: row.id,
            title: row.title,
            lifecycleState: row.lifecycle_state,
            startsAt: new Date(row.starts_at).toISOString(),
            endsAt: new Date(row.ends_at).toISOString(),
            assigned: row.assigned,
            completed: row.completed,
            averagePercentage: publishable ? Math.round(Number(row.average) * 100) / 100 : null,
            averageSuppressed: !publishable,
          };
        }),
      });
    }
    return { mode, classes, correlationId: context.correlationId };
  }

  /** Last ended month's readiness bands for the reader's scope — the period rule of the stored report (INST-SR-01). */
  private async readinessForLastMonth(reader: ReaderScope): Promise<Record<string, unknown>> {
    const month = latestReportingMonth(new Date().toISOString().slice(0, 10));
    if (!month) return { month: null, aggregate: null };
    const [year, monthNumber] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const aggregate = await institutionReadinessDistribution(this.db, {
      institutionId: reader.institutionId, periodStart: `${month}-01`, periodEnd: `${month}-${String(lastDay).padStart(2, '0')}`, studentScope: reader.scope,
    });
    return { month, aggregate };
  }

  private async reader(request: ProtectedHttpRequest, institutionId: string, roles: readonly string[], unitId: string | undefined): Promise<ReaderScope> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    const memberships = institutionStaffScopeMemberships(request, id, roles);
    if (memberships.length === 0) throw forbidden(context.correlationId);
    if (unitId !== undefined && unitId !== '' && !uuidPattern.test(unitId)) throw invalid('INVALID_QUERY', context.correlationId, 'unitId');
    const own = await resolveInstitutionStudentScope(this.db, id, memberships);
    const tree = await loadInstitutionUnitTree(this.db, id);
    let unit: ReaderScope['unit'] = null;
    let scope = own;
    if (unitId) {
      const found = await this.db.execute(sql`
        SELECT id, kind::text AS kind, name FROM institution_units WHERE institution_id = ${id}::uuid AND id = ${unitId.toLowerCase()}::uuid
      `) as Rows<{ id: string; kind: string; name: string }>;
      unit = found.rows[0] ?? null;
      if (!unit) throw invalid('UNIT_INVALID', context.correlationId, 'unitId');
      scope = narrowInstitutionStudentScope(own, institutionUnitDescendants(unit.id, tree));
    }
    return { institutionId: id, correlationId: context.correlationId, actorUserId: context.authorization.principal.userId, roles, own, scope, unit, tree };
  }
}

/**
 * Applications the reader may count or list (ADR-019): submitted, shared with the college
 * and not revoked, of a student in scope with a current relationship, an active profile
 * and account — the per-student applications endpoint's rule — and every disclosed date
 * (and the offer's) inside a relationship that authorised activity then. The offer is the
 * latest non-DRAFT one; its terms are never selected.
 */
function sharedApplicationsCte(reader: ReaderScope): SQL {
  const id = reader.institutionId;
  const authorisedAt = (at: SQL) => sql`(${at} IS NULL OR EXISTS (
    SELECT 1 FROM institution_relationships r
    WHERE r.institution_id = ${id}::uuid AND r.student_user_id = a.student_user_id
      AND (r.state IN ('VERIFIED', 'ACTIVE') OR (r.state IN ('TRANSFERRED', 'GRADUATED') AND r.effective_to IS NOT NULL))
      AND r.effective_from <= ${at} AND (r.effective_to IS NULL OR r.effective_to > ${at})))`;
  return sql`
    WITH scoped AS (
      SELECT sp.student_user_id, sp.full_name, sp.institution_student_id
      FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
      WHERE sp.institution_id = ${id}::uuid AND sp.status = 'ACTIVE' AND u.state = 'ACTIVE'
        AND ${currentRelationshipSql('sp')}
        AND ${institutionStudentScopeSql(reader.scope, 'sp')}
    ), shared AS (
      SELECT a.id, a.state, a.student_user_id, a.employer_id, a.opportunity_id, a.applied_version_id,
             a.submitted_at, a.updated_at, s.full_name, s.institution_student_id, o.state AS offer_state
      FROM applications a
      JOIN scoped s ON s.student_user_id = a.student_user_id
      LEFT JOIN LATERAL (
        SELECT state, created_at, updated_at FROM offers
        WHERE application_id = a.id AND employer_id = a.employer_id AND state <> 'DRAFT'
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) o ON true
      WHERE a.state <> 'DRAFT'
        AND a.institution_visibility_granted_at IS NOT NULL AND a.institution_visibility_revoked_at IS NULL
        AND ${authorisedAt(sql`a.created_at`)} AND ${authorisedAt(sql`a.submitted_at`)}
        AND ${authorisedAt(sql`a.updated_at`)} AND ${authorisedAt(sql`a.closed_at`)}
        AND ${authorisedAt(sql`o.created_at`)} AND ${authorisedAt(sql`o.updated_at`)}
    )`;
}

/** True when the profile row has a relationship with the institution that is current now. */
function currentRelationshipSql(alias: 'sp'): SQL {
  const p = sql.raw(alias);
  return sql`EXISTS (SELECT 1 FROM institution_relationships ir
    WHERE ir.institution_id = ${p}.institution_id AND ir.student_user_id = ${p}.student_user_id
      AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))`;
}

/** True when every anchor of some clause covers the unit — the unit lies inside the scope. */
function unitAddressable(scope: InstitutionStudentScope, unitId: string): boolean {
  if (scope.kind === 'INSTITUTION') return true;
  if (scope.kind === 'NONE') return false;
  return scope.clauses.some((anchors) => anchors.every((covered) => covered.includes(unitId)));
}

/** The units a scope covers (each clause's anchors intersected, clauses unioned), or ALL. */
function scopeUnits(scope: InstitutionStudentScope): Set<string> | 'ALL' {
  if (scope.kind === 'INSTITUTION') return 'ALL';
  const units = new Set<string>();
  if (scope.kind === 'NONE') return units;
  for (const anchors of scope.clauses) {
    const [first, ...rest] = anchors;
    for (const unit of first ?? []) if (rest.every((covered) => covered.includes(unit))) units.add(unit);
  }
  return units;
}

function textArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}

function uuidArray(values: readonly string[]): string {
  return `{${values.join(',')}}`;
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
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && parsed[0].length <= 64
      && timestampPattern.test(parsed[0]) && typeof parsed[1] === 'string' && uuidPattern.test(parsed[1])) return [parsed[0], parsed[1]];
  } catch { /* fall through */ }
  throw invalid('INVALID_QUERY', correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}

function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
