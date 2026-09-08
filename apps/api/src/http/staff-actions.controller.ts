/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { assertQuestionTransition, type QuestionStatus } from '@planthepath/assessments';
import { institutionRelationshipAuthorizesActivity, type TemporalInstitutionScope } from '@planthepath/authorization/src/index.js';
import { hasInstitutionRelationshipAuthorizationForActivity, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_ID_GENERATOR, API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ApiIdGenerator, type ProtectedHttpRequest } from './api-security.js';

type Rows<T> = { rows: T[] };
const actionTypes = ['INTERVENTION', 'ASSIGNED_TASK', 'FACULTY_NOTE', 'ACADEMIC_VERIFICATION', 'MEETING'] as const;
type ActionType = typeof actionTypes[number];
interface Filters { studentUserId?: string; state?: string; assigneeMembershipId?: string; period?: string }
function actionType(value: unknown, correlationId: string): ActionType {
  if (value === undefined) return 'INTERVENTION';
  if (typeof value !== 'string' || !actionTypes.includes(value as ActionType)) throw new BadRequestException(inputError('INVALID_INPUT', correlationId));
  return value as ActionType;
}
function dateValue(value: unknown, correlationId: string): Date | null {
  const text = textValue(value, 64, correlationId);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new BadRequestException(inputError('INVALID_INPUT', correlationId));
  }
  return new Date(text);
}
function meetingDates(type: ActionType, start: unknown, end: unknown, correlationId: string) {
  const scheduledStartAt = dateValue(start, correlationId);
  const scheduledEndAt = dateValue(end, correlationId);
  if (type === 'MEETING' ? !scheduledStartAt || !scheduledEndAt || scheduledEndAt <= scheduledStartAt : Boolean(scheduledStartAt || scheduledEndAt)) {
    throw new BadRequestException(inputError('INVALID_INPUT', correlationId));
  }
  return { scheduledStartAt, scheduledEndAt };
}
const staffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const reviewRoles = staffRoles.filter((role) => role !== 'FACULTY_LECTURER');
interface Scope {
  id: string; user_id: string; role: string; institutionId: string; correlationId: string;
  scope_department_unit_id: string | null; scope_batch_unit_id: string | null;
}
interface Relationship extends Record<string, unknown> {
  relationship_id: string; relationship_state: TemporalInstitutionScope['relationshipState'];
  effective_from: Date; effective_to: Date | null;
}
interface Student extends Relationship {
  student_user_id: string; full_name: string; department_unit_id: string | null; batch_unit_id: string | null;
}
interface Action extends Relationship {
  id: string; subject_student_user_id: string | null; institution_relationship_id: string | null;
  action_type: ActionType; visibility: string; actor_membership_id: string;
  scheduled_start_at: Date | null; scheduled_end_at: Date | null;
  author_name: string; reviewer_name: string | null; last_reviewed_at: Date | null;
  actor_user_id: string; assigned_to_membership_id: string | null;
  title: string; note: string | null; outcome_note: string | null; due_at: Date | null;
  state: string; version: number; created_at: Date; updated_at: Date;
  student_name: string; owner_name: string; profile_updated_at: Date;
}
const reviewStates = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'];
function nextStates(state: string): string[] {
  // Delegate the governed edges to the question bank's existing state machine.
  const governed = reviewStates.filter((next) => {
    try { assertQuestionTransition(state as QuestionStatus, next as QuestionStatus); return true; } catch { return false; }
  });
  if (state === 'APPROVED') governed.push('IN_PROGRESS');
  if (state === 'IN_PROGRESS') governed.push('COMPLETED');
  if (['COMPLETED', 'CANCELLED'].includes(state)) governed.push('ARCHIVED');
  if (['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'IN_PROGRESS'].includes(state)) governed.push('CANCELLED');
  return governed;
}
function canManage(scope: Scope, action: Action): boolean {
  return reviewRoles.includes(scope.role) || action.actor_user_id === scope.user_id || action.assigned_to_membership_id === scope.id;
}
function allowedStates(scope: Scope, action: Action): string[] {
  if (!canManage(scope, action)) return [];
  return nextStates(action.state).filter((state) => !['APPROVED', 'REJECTED'].includes(state) || reviewRoles.includes(scope.role));
}
function temporal(scope: Pick<Scope, 'institutionId'>, relation: Relationship, at: Date): boolean {
  return institutionRelationshipAuthorizesActivity({
    institutionId: scope.institutionId, relationshipState: relation.relationship_state,
    effectiveFrom: relation.effective_from, ...(relation.effective_to ? { effectiveTo: relation.effective_to } : {}),
  }, at);
}
function currentRelation(scope: Scope, relation: Relationship): boolean {
  return ['VERIFIED', 'ACTIVE'].includes(relation.relationship_state) && temporal(scope, relation, new Date());
}
function currentAction(scope: Scope, action: Action): boolean {
  return action.subject_student_user_id === null
    ? action.action_type === 'MEETING' && action.institution_relationship_id === null
    : currentRelation(scope, action);
}
function editable(scope: Scope, action: Action): boolean {
  return action.action_type === 'ASSIGNED_TASK' && action.state === 'DRAFT' && currentAction(scope, action) && canManage(scope, action);
}
function unitScope(scope: Scope): SQL {
  return sql`(${scope.scope_department_unit_id}::uuid IS NULL OR p.department_unit_id = ${scope.scope_department_unit_id}::uuid)
    AND (${scope.scope_batch_unit_id}::uuid IS NULL OR p.batch_unit_id = ${scope.scope_batch_unit_id}::uuid)`;
}
function inputError(code: string, correlationId: string) { return { error: { code, correlationId, message: 'Request could not be completed.' } }; }
function uuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(inputError('INVALID_INPUT', correlationId));
  }
  return value;
}
function textValue(value: unknown, limit: number, correlationId: string, required = false): string | null {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    throw new BadRequestException(inputError('INVALID_INPUT', correlationId));
  }
  return value.trim() || null;
}

/** C5 reuses C4 scope, lifecycle and audit. Visibility changes, evidence access and wider delegation remain deferred. */
@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class StaffActionsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  private async scope(tx: PersistenceDb, request: ProtectedHttpRequest, institutionId: string): Promise<Scope> {
    const context = requireTrustedAuthorization(request);
    const id = uuid(institutionId, context.correlationId);
    const authorization = context.authorization;
    const candidate = authorization.selectedMembership ?? authorization.memberships.find((membership) => membership.organizationId === id && staffRoles.includes(membership.role));
    if (!candidate || candidate.organizationId !== id) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const result = await tx.execute(sql`
      SELECT m.id, m.user_id, m.role, m.scope_department_unit_id, m.scope_batch_unit_id
      FROM organization_memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
      WHERE m.id = ${candidate.id}::uuid AND m.user_id = ${authorization.principal.userId}::uuid
        AND m.organization_id = ${id}::uuid AND m.scope_organization_id = ${id}::uuid
        AND m.scope_institution_id = ${id}::uuid AND m.state = 'ACTIVE'
        AND u.state = 'ACTIVE' AND o.active AND o.kind = 'INSTITUTION'
      FOR SHARE OF m, u, o
    `) as Rows<Omit<Scope, 'institutionId' | 'correlationId'>>;
    const membership = result.rows[0];
    if (!membership || !staffRoles.includes(membership.role)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { ...membership, institutionId: id, correlationId: context.correlationId };
  }

  private async subject(tx: PersistenceDb, scope: Scope, studentId: string, relationshipId?: string): Promise<Student> {
    const result = await tx.execute(sql`
      SELECT p.student_user_id, p.full_name, p.department_unit_id, p.batch_unit_id,
        r.id AS relationship_id, r.state AS relationship_state, r.effective_from, r.effective_to
      FROM institution_student_profiles p JOIN users u ON u.id = p.student_user_id
      JOIN institution_relationships r ON r.institution_id = p.institution_id AND r.student_user_id = p.student_user_id
      WHERE p.institution_id = ${scope.institutionId}::uuid AND p.student_user_id = ${studentId}::uuid
        AND p.status = 'ACTIVE' AND u.state = 'ACTIVE' AND r.state IN ('VERIFIED', 'ACTIVE')
        AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())
        AND (${relationshipId ?? null}::uuid IS NULL OR r.id = ${relationshipId ?? null}::uuid)
        AND ${unitScope(scope)}
      ORDER BY r.effective_from DESC LIMIT 1 FOR SHARE OF p, r, u
    `) as Rows<Student>;
    const student = result.rows[0];
    if (!student || !currentRelation(scope, student)) throw new ForbiddenException(safeError('FORBIDDEN', scope.correlationId));
    return student;
  }

  private async rows(tx: PersistenceDb, scope: Scope, type: ActionType, id?: string, lock = false): Promise<Action[]> {
    const result = await tx.execute(sql`
      SELECT a.*, p.full_name AS student_name, p.updated_at AS profile_updated_at, owner.email AS owner_name, author.email AS author_name, reviewer.email AS reviewer_name,
        r.id AS relationship_id, r.state AS relationship_state, r.effective_from, r.effective_to
      FROM staff_actions a
      JOIN institution_relationships r ON r.id = a.institution_relationship_id
        AND r.institution_id = a.institution_id AND r.student_user_id = a.subject_student_user_id
      JOIN institution_student_profiles p ON p.institution_id = a.institution_id AND p.student_user_id = a.subject_student_user_id
      JOIN organization_memberships m ON m.id = a.assigned_to_membership_id AND m.organization_id = a.institution_id
      JOIN users owner ON owner.id = m.user_id
      JOIN users author ON author.id = a.actor_user_id
      LEFT JOIN users reviewer ON reviewer.id = a.last_reviewed_by_user_id
      WHERE a.institution_id = ${scope.institutionId}::uuid AND a.action_type = ${type} AND a.visibility = 'STAFF_ONLY'
        AND (${id ?? null}::uuid IS NULL OR a.id = ${id ?? null}::uuid)
        AND ${unitScope(scope)}
        AND (${scope.scope_department_unit_id}::uuid IS NULL OR a.department_unit_id = ${scope.scope_department_unit_id}::uuid)
        AND (${scope.scope_batch_unit_id}::uuid IS NULL OR a.batch_unit_id = ${scope.scope_batch_unit_id}::uuid)
      ORDER BY a.created_at DESC, a.id ${lock ? sql`FOR UPDATE OF a` : sql`FOR SHARE OF a, r, p`}
    `) as Rows<Action>;

    if (type === 'MEETING') {
      const meetings = await tx.execute(sql`
        SELECT a.*, NULL AS student_name, owner.email AS owner_name, author.email AS author_name,
          reviewer.email AS reviewer_name
        FROM staff_actions a
        JOIN organization_memberships m ON m.id = a.assigned_to_membership_id AND m.organization_id = a.institution_id
        JOIN users owner ON owner.id = m.user_id JOIN users author ON author.id = a.actor_user_id
        LEFT JOIN users reviewer ON reviewer.id = a.last_reviewed_by_user_id
        WHERE a.institution_id = ${scope.institutionId}::uuid AND a.action_type = 'MEETING'
          AND a.subject_student_user_id IS NULL AND a.institution_relationship_id IS NULL AND a.visibility = 'STAFF_ONLY'
          AND (${id ?? null}::uuid IS NULL OR a.id = ${id ?? null}::uuid)
          AND (${scope.scope_department_unit_id}::uuid IS NULL OR a.department_unit_id = ${scope.scope_department_unit_id}::uuid)
          AND (${scope.scope_batch_unit_id}::uuid IS NULL OR a.batch_unit_id = ${scope.scope_batch_unit_id}::uuid)
        ORDER BY a.created_at DESC, a.id ${lock ? sql`FOR UPDATE OF a` : sql`FOR SHARE OF a`}
      `) as Rows<Action>;
      result.rows.push(...meetings.rows);
      result.rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || a.id.localeCompare(b.id));
    }

    // Check the latest revision as well as creation: an older row cannot disclose later activity.
    return result.rows.filter((action) => (action.subject_student_user_id === null && currentAction(scope, action)) || (temporal(scope, action, action.created_at) && temporal(scope, action, action.updated_at)
      && (!['TRANSFERRED', 'GRADUATED'].includes(action.relationship_state) || Boolean(action.effective_to && action.profile_updated_at < action.effective_to))));
  }

  @Get('/institutions/:institutionId/staff-actions')
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Query('actionType') typeParam?: string, @Query() filters: Filters = {}) {
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, request, institutionId);
      const type = actionType(typeParam, scope.correlationId);
      const studentFilter = filters.studentUserId === undefined ? null : uuid(filters.studentUserId, scope.correlationId);
      const assigneeFilter = filters.assigneeMembershipId === undefined ? null : uuid(filters.assigneeMembershipId, scope.correlationId);
      const states = [...reviewStates, 'OPEN', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'COMPLETED', 'CANCELLED'];
      if ((filters.state !== undefined && !states.includes(filters.state)) ||
        (filters.period !== undefined && (type !== 'MEETING' || !['upcoming', 'past'].includes(filters.period)))) {
        throw new BadRequestException(inputError('INVALID_INPUT', scope.correlationId));
      }
      const now = new Date();
      const actions = (await this.rows(tx, scope, type)).filter((action) =>
        (!studentFilter || action.subject_student_user_id === studentFilter) &&
        (!assigneeFilter || action.assigned_to_membership_id === assigneeFilter) &&
        (filters.state === undefined || action.state === filters.state) &&
        (filters.period === undefined || Boolean(action.scheduled_end_at &&
          (filters.period === 'past' ? new Date(action.scheduled_end_at) <= now : new Date(action.scheduled_end_at) > now))));
      const students = await tx.execute(sql`
        SELECT p.student_user_id, p.full_name FROM institution_student_profiles p
        JOIN users u ON u.id = p.student_user_id
        WHERE p.institution_id = ${scope.institutionId}::uuid AND p.status = 'ACTIVE' AND u.state = 'ACTIVE'
          AND ${unitScope(scope)}
          AND EXISTS (SELECT 1 FROM institution_relationships r WHERE r.institution_id = p.institution_id
            AND r.student_user_id = p.student_user_id AND r.state IN ('VERIFIED', 'ACTIVE')
            AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
        ORDER BY p.full_name, p.student_user_id LIMIT 200
      `) as Rows<{ student_user_id: string; full_name: string }>;
      return {
        actions: actions.map((action) => ({
          id: action.id, title: action.title, note: action.note, outcomeNote: action.outcome_note,
          studentName: action.student_name, ownerName: action.owner_name, state: action.state, version: action.version,
          dueAt: action.due_at, updatedAt: action.updated_at,
          actionType: action.action_type, visibility: action.visibility, authorName: action.author_name,
          studentUserId: action.subject_student_user_id, assignedToMembershipId: action.assigned_to_membership_id,
          scheduledStartAt: action.scheduled_start_at, scheduledEndAt: action.scheduled_end_at,
          reviewerName: action.reviewer_name, lastReviewedAt: action.last_reviewed_at,
          canEdit: editable(scope, action),
          allowedTransitions: currentAction(scope, action) ? allowedStates(scope, action) : [],
        })),
        students: students.rows.map((student) => ({ id: student.student_user_id, name: student.full_name })),
        // C4 establishes self-assignment only; wider delegation awaits policy review.
        assignees: [{ id: scope.id, name: 'You' }],
      };
    });
  }

  @Post('/institutions/:institutionId/staff-actions')
  async create(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: Record<string, unknown>, @Query('actionType') typeParam?: string) {
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, request, institutionId);
      const type = actionType(typeParam, scope.correlationId);
      if (typeParam !== undefined && ((body['visibility'] !== undefined && body['visibility'] !== 'STAFF_ONLY') ||
        body['evidenceDocumentVersionId'] != null || body['sourceExamAssignmentId'] != null ||
        (body['assignedToMembershipId'] !== undefined && body['assignedToMembershipId'] !== scope.id))) {
        throw new ForbiddenException(safeError('FORBIDDEN', scope.correlationId));
      }
      const studentId = type === 'MEETING' && body['studentUserId'] == null ? null : uuid(body['studentUserId'], scope.correlationId);
      const title = textValue(body['title'], 200, scope.correlationId, true);
      const note = textValue(body['note'], 4000, scope.correlationId, type === 'FACULTY_NOTE');
      const dueAt = dateValue(body['dueAt'], scope.correlationId);
      const dates = meetingDates(type, body['scheduledStartAt'], body['scheduledEndAt'], scope.correlationId);
      const student = studentId ? await this.subject(tx, scope, studentId) : null;
      const id = this.ids.uuid();
      await tx.execute(sql`
        INSERT INTO staff_actions (id, institution_id, subject_student_user_id, institution_relationship_id,
          actor_user_id, actor_membership_id, assigned_to_membership_id, department_unit_id, batch_unit_id,
          action_type, title, note, due_at, scheduled_start_at, scheduled_end_at, updated_by_user_id)
        VALUES (${id}::uuid, ${scope.institutionId}::uuid, ${studentId}::uuid, ${student?.relationship_id ?? null}::uuid,
          ${scope.user_id}::uuid, ${scope.id}::uuid, ${scope.id}::uuid, ${student?.department_unit_id ?? scope.scope_department_unit_id}::uuid, ${student?.batch_unit_id ?? scope.scope_batch_unit_id}::uuid,
          ${type}, ${title}, ${note}, ${dueAt}, ${dates.scheduledStartAt}, ${dates.scheduledEndAt}, ${scope.user_id}::uuid)
      `);
      await this.audit(tx, scope, id, 'staff_action.created', {
        fromState: null, toState: 'DRAFT', version: 1, actionType: type, title, note, dueAt, ...dates,
        subjectStudentUserId: studentId, relationshipId: student?.relationship_id ?? null, assignedToMembershipId: scope.id,
      });
      return { id, state: 'DRAFT', version: 1 };
    });
  }

  @Post('/institutions/:institutionId/staff-actions/:actionId/transition')
  async transition(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('actionId') actionId: string, @Body() body: Record<string, unknown>, @Query('actionType') typeParam?: string) {
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, request, institutionId);
      const id = uuid(actionId, scope.correlationId);
      const type = actionType(typeParam, scope.correlationId);
      const action = (await this.rows(tx, scope, type, id, true))[0];
      if (!action) throw new ForbiddenException(safeError('FORBIDDEN', scope.correlationId));
      if (action.subject_student_user_id) await this.subject(tx, scope, action.subject_student_user_id, action.institution_relationship_id ?? undefined);
      if (!Number.isInteger(body['version']) || Number(body['version']) < 1) throw new BadRequestException(inputError('INVALID_INPUT', scope.correlationId));
      if (body['version'] !== action.version) throw new ConflictException(inputError('STALE_VERSION', scope.correlationId));
      const toState = textValue(body['toState'], 32, scope.correlationId, true)!;
      if (!allowedStates(scope, action).includes(toState)) throw new ForbiddenException(safeError('FORBIDDEN', scope.correlationId));
      const note = textValue(body['note'], 2000, scope.correlationId, ['REJECTED', 'COMPLETED', 'CANCELLED'].includes(toState) || (type === 'ACADEMIC_VERIFICATION' && toState === 'APPROVED'));
      const reviewing = ['APPROVED', 'REJECTED'].includes(toState);
      const result = await tx.execute(sql`
        UPDATE staff_actions SET state = ${toState}, version = version + 1,
          updated_at = now(), updated_by_user_id = ${scope.user_id}::uuid,
          outcome_note = COALESCE(${note}, outcome_note),
          last_reviewed_by_user_id = CASE WHEN ${reviewing} THEN ${scope.user_id}::uuid ELSE last_reviewed_by_user_id END,
          last_reviewed_at = CASE WHEN ${reviewing} THEN now() ELSE last_reviewed_at END,
          resolved_at = CASE WHEN ${['REJECTED', 'COMPLETED', 'CANCELLED'].includes(toState)} THEN now()
            WHEN ${toState === 'DRAFT'} THEN NULL ELSE resolved_at END,
          archived_at = CASE WHEN ${toState === 'ARCHIVED'} THEN now() ELSE archived_at END
        WHERE id = ${id}::uuid AND institution_id = ${scope.institutionId}::uuid AND version = ${action.version}
        RETURNING version
      `) as Rows<{ version: number }>;
      if (result.rows.length !== 1) throw new ConflictException(inputError('STALE_VERSION', scope.correlationId));
      await this.audit(tx, scope, id, 'staff_action.transitioned', {
        actionType: type, fromState: action.state, toState, fromVersion: action.version, version: result.rows[0]!.version,
        note, previousOutcomeNote: action.outcome_note,
      });
      return { id, state: toState, version: result.rows[0]!.version };
    });
  }

  @Post('/institutions/:institutionId/staff-actions/:actionId/update')
  async update(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string,
    @Query('actionType') typeParam: string, @Param('actionId') actionId: string, @Body() body: Record<string, unknown>) {
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, request, institutionId);
      const type = actionType(typeParam, scope.correlationId);
      const id = uuid(actionId, scope.correlationId);
      const action = (await this.rows(tx, scope, type, id, true))[0];
      if (!action || !editable(scope, action)) throw new ForbiddenException(safeError('FORBIDDEN', scope.correlationId));
      await this.subject(tx, scope, action.subject_student_user_id!, action.institution_relationship_id ?? undefined);
      if (!Number.isInteger(body['version']) || Number(body['version']) < 1) throw new BadRequestException(inputError('INVALID_INPUT', scope.correlationId));
      if (body['version'] !== action.version) throw new ConflictException(inputError('STALE_VERSION', scope.correlationId));
      if (Object.keys(body).some((key) => !['version', 'title', 'note', 'dueAt'].includes(key))) {
        throw new BadRequestException(inputError('INVALID_INPUT', scope.correlationId));
      }
      const title = body['title'] === undefined ? action.title : textValue(body['title'], 200, scope.correlationId, true);
      const note = body['note'] === undefined ? action.note : textValue(body['note'], 4000, scope.correlationId);
      const dueAt = body['dueAt'] === undefined ? action.due_at : dateValue(body['dueAt'], scope.correlationId);
      const result = await tx.execute(sql`
        UPDATE staff_actions SET title = ${title}, note = ${note}, due_at = ${dueAt}, version = version + 1,
          updated_at = now(), updated_by_user_id = ${scope.user_id}::uuid
        WHERE id = ${id}::uuid AND institution_id = ${scope.institutionId}::uuid AND version = ${action.version}
        RETURNING version
      `) as Rows<{ version: number }>;
      if (result.rows.length !== 1) throw new ConflictException(inputError('STALE_VERSION', scope.correlationId));
      await this.audit(tx, scope, id, 'staff_action.updated', {
        actionType: type, fromVersion: action.version, version: result.rows[0]!.version,
        before: { title: action.title, note: action.note, dueAt: action.due_at }, after: { title, note, dueAt },
      });
      return { id, state: action.state, version: result.rows[0]!.version };
    });
  }


  /** Student read only: identity comes from the guard, never a requested student ID. */
  @Get('/students/me/staff-actions')
  async forStudent(@Req() request: ProtectedHttpRequest, @Query('institutionId') institutionId: string) {
    const context = requireTrustedAuthorization(request);
    const id = uuid(institutionId, context.correlationId);
    const studentUserId = context.authorization.principal.userId;
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT a.id, a.action_type, a.title, a.note, a.state, a.due_at, a.created_at, a.updated_at,
          r.id AS relationship_id, r.state AS relationship_state, r.effective_from, r.effective_to
        FROM staff_actions a
        JOIN users u ON u.id = a.subject_student_user_id AND u.state = 'ACTIVE'
        JOIN organizations o ON o.id = a.institution_id AND o.active AND o.kind = 'INSTITUTION'
        JOIN institution_relationships r ON r.id = a.institution_relationship_id
          AND r.institution_id = a.institution_id AND r.student_user_id = a.subject_student_user_id
        WHERE a.institution_id = ${id}::uuid AND a.subject_student_user_id = ${studentUserId}::uuid
          AND a.visibility = 'SUBJECT_VISIBLE' AND a.action_type IN ('INTERVENTION', 'ASSIGNED_TASK')
        ORDER BY a.created_at DESC, a.id
        FOR SHARE OF a, r, u, o
      `) as Rows<Relationship & {
        id: string; action_type: string; title: string; note: string | null; state: string;
        due_at: Date | null; created_at: Date; updated_at: Date;
      }>;
      const actions = result.rows.filter((row) => {
        const relation = { ...row, effective_from: new Date(row.effective_from), effective_to: row.effective_to ? new Date(row.effective_to) : null };
        return temporal({ institutionId: id }, relation, new Date(row.created_at)) &&
          temporal({ institutionId: id }, relation, new Date(row.updated_at));
      });
      return { actions: actions.map((row) => ({
        id: row.id, actionType: row.action_type, title: row.title, note: row.note, state: row.state,
        dueAt: row.due_at, createdAt: row.created_at, updatedAt: row.updated_at,
      })) };
    });
  }


  /** ADR-019/024: explicit institution consent plus current scope and canonical activity-date access. */
  @Get('/institutions/:institutionId/students/:studentUserId/applications')
  async studentApplications(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentUserId') studentUserId: string) {
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(tx, request, institutionId);
      const studentId = uuid(studentUserId, scope.correlationId);
      try {
        // Reuse current relationship and department/batch checks, holding their read locks.
        await this.subject(tx, scope, studentId);
      } catch (error) {
        if (error instanceof ForbiddenException) return { applications: [] };
        throw error;
      }
      const result = await tx.execute(sql`
        SELECT a.id, a.employer_id, employer.legal_name AS employer_name,
          v.title AS opportunity_title, a.state, a.created_at, a.submitted_at, a.updated_at, a.closed_at
        FROM applications a
        JOIN organizations employer ON employer.id = a.employer_id AND employer.kind = 'EMPLOYER'
        JOIN opportunity_versions v ON v.id = a.applied_version_id AND v.opportunity_id = a.opportunity_id
        WHERE a.student_user_id = ${studentId}::uuid
          AND a.institution_visibility_granted_at IS NOT NULL
          AND a.institution_visibility_revoked_at IS NULL
        ORDER BY a.created_at DESC, a.id
        LIMIT 100
        FOR SHARE OF a
      `) as Rows<{
        id: string; employer_id: string; employer_name: string; opportunity_title: string; state: string;
        created_at: Date; submitted_at: Date | null; updated_at: Date; closed_at: Date | null;
      }>;
      const applications = [];
      for (const row of result.rows) {
        // Creation and every disclosed revision must belong to authorized activity time.
        const activityDates = [row.created_at, row.submitted_at, row.updated_at, row.closed_at].filter((value) => value !== null);
        let authorized = true;
        for (const at of activityDates) {
          if (!await hasInstitutionRelationshipAuthorizationForActivity(tx, scope.institutionId, studentId, new Date(at))) {
            authorized = false; break;
          }
        }
        if (!authorized) continue;
        // Match the existing student offer state's vocabulary, without disclosing its terms.
        const offers = await tx.execute(sql`
          SELECT state, created_at, updated_at
          FROM offers
          WHERE application_id = ${row.id}::uuid AND employer_id = ${row.employer_id}::uuid
          ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE
        `) as Rows<{ state: string; created_at: Date; updated_at: Date }>;
        const offer = offers.rows[0];
        if (offer && (!await hasInstitutionRelationshipAuthorizationForActivity(tx, scope.institutionId, studentId, new Date(offer.created_at)) ||
          !await hasInstitutionRelationshipAuthorizationForActivity(tx, scope.institutionId, studentId, new Date(offer.updated_at)))) continue;
        applications.push({
          id: row.id, employer: { id: row.employer_id, name: row.employer_name },
          opportunityTitle: row.opportunity_title, state: row.state,
          createdAt: row.created_at, submittedAt: row.submitted_at, updatedAt: row.updated_at, closedAt: row.closed_at,
          offer: { exists: Boolean(offer), responseState: offer?.state ?? null },
        });
      }
      return { applications };
    });
  }

  private async audit(tx: PersistenceDb, scope: Scope, id: string, action: string, context: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${scope.user_id}::uuid, ${action}, 'staff_action', ${id},
        ${scope.institutionId}::uuid, 'SUCCESS', ${scope.correlationId},
        ${JSON.stringify({ ...context, actorMembershipId: scope.id })}::jsonb)
    `);
  }
}
