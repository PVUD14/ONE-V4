/**
 * Restricted counselling notes (INST-11, ADR-036).
 *
 * A counselling note is a `COUNSELLING_NOTE` staff action, but it is not read through the unit
 * scope that other staff actions use. A note about a student is readable by:
 *   - institution owners and admins;
 *   - its author (the membership that wrote it), while the student stays inside that
 *     membership's read scope from the single INST-02 helper;
 *   - staff an owner or admin added to that student's counselling case.
 * Everyone else — a department head of the student's own department, the lecturers who teach
 * them, the placement office — sees nothing, and learns nothing about whether a case exists.
 *
 * Writes use the INST-SR-02 write scope (or case participation); a writer with no scope at all
 * gets SCOPE_REQUIRED. Every read and write is audited in the same transaction, and no audit row
 * carries a note's title or text. The relationship policy applies to every note: it is shown only
 * when it was written and last changed inside a relationship that authorised activity then.
 * Design: docs/architecture/counselling-notes-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql, resolveInstitutionStudentScope, resolveInstitutionStudentWriteScope } from '@planthepath/persistence/src/institution-scope.js';
import { hasInstitutionRelationshipAuthorizationForActivity, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_ID_GENERATOR, API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ApiIdGenerator, type ProtectedHttpRequest } from './api-security.js';

type Rows<T> = { rows: T[] };
const staffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const institutionWideRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;
const visibilities = ['STAFF_ONLY', 'SUBJECT_VISIBLE'] as const;
type Visibility = typeof visibilities[number];
/** Why the caller may read a student's notes: every note, only their own, or none. */
type Basis = 'OWNER_ADMIN' | 'PARTICIPANT' | 'AUTHOR' | 'NONE';

interface Staff {
  membershipId: string; userId: string; role: string; institutionId: string; correlationId: string;
  departmentUnitId: string | null; batchUnitId: string | null;
}
interface Subject extends Record<string, unknown> {
  student_user_id: string; full_name: string; department_unit_id: string | null; batch_unit_id: string | null;
  in_read_scope: boolean; in_write_scope: boolean; participant: boolean;
  current_relationship_id: string | null;
}
interface NoteRow extends Record<string, unknown> {
  id: string; subject_student_user_id: string; actor_membership_id: string; title: string; note: string;
  visibility: Visibility; version: number; created_at: Date; updated_at: Date; author_role: string; author_name: string;
}

function failure(status: 'BAD' | 'FORBIDDEN', code: string, correlationId: string): Error {
  const body = { error: { code, correlationId, message: code === 'SCOPE_REQUIRED'
    ? 'A department or teaching assignment is required for this change'
    : 'Request could not be completed.' } };
  return status === 'BAD' ? new BadRequestException(body) : new ForbiddenException(body);
}
function invalid(correlationId: string): Error { return failure('BAD', 'INVALID_INPUT', correlationId); }
function uuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(correlationId);
  return value.toLowerCase();
}
function text(value: unknown, limit: number, correlationId: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw invalid(correlationId);
  return value.trim();
}
function objectBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid(correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid(correlationId);
  return record;
}
function reasonCode(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !reasonCodePattern.test(value)) throw invalid(correlationId);
  return value;
}
function limitOf(value: unknown, correlationId: string): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) throw invalid(correlationId);
  const limit = Number(value);
  if (limit < 1 || limit > 200) throw invalid(correlationId);
  return limit;
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class CounsellingNotesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The caller's selected, active staff membership of this institution — the same check staff actions use. */
  private async staff(tx: PersistenceDb, request: ProtectedHttpRequest, institutionId: string): Promise<Staff> {
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
    `) as Rows<{ id: string; user_id: string; role: string; scope_department_unit_id: string | null; scope_batch_unit_id: string | null }>;
    const membership = result.rows[0];
    if (!membership || !staffRoles.includes(membership.role)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return {
      membershipId: membership.id, userId: membership.user_id, role: membership.role, institutionId: id,
      correlationId: context.correlationId, departmentUnitId: membership.scope_department_unit_id, batchUnitId: membership.scope_batch_unit_id,
    };
  }

  private scopeInput(staff: Staff) {
    return [{ role: staff.role, membershipId: staff.membershipId, departmentUnitId: staff.departmentUnitId, batchUnitId: staff.batchUnitId }];
  }
  private readScope(tx: PersistenceDb, staff: Staff): Promise<InstitutionStudentScope> {
    return resolveInstitutionStudentScope(tx, staff.institutionId, this.scopeInput(staff));
  }
  private writeScope(tx: PersistenceDb, staff: Staff): Promise<InstitutionStudentScope> {
    return resolveInstitutionStudentWriteScope(tx, staff.institutionId, this.scopeInput(staff));
  }

  /** The student's roster row with the caller's standing towards it. Null when not on this institution's roster. */
  private async subject(tx: PersistenceDb, staff: Staff, studentId: string, read: InstitutionStudentScope, write: InstitutionStudentScope): Promise<Subject | null> {
    const result = await tx.execute(sql`
      SELECT p.student_user_id, p.full_name, p.department_unit_id, p.batch_unit_id,
        ${institutionStudentScopeSql(read, 'p')} AS in_read_scope,
        ${institutionStudentScopeSql(write, 'p')} AS in_write_scope,
        EXISTS (SELECT 1 FROM counselling_case_participants c
          WHERE c.institution_id = p.institution_id AND c.student_user_id = p.student_user_id
            AND c.membership_id = ${staff.membershipId}::uuid AND c.removed_at IS NULL) AS participant,
        (SELECT r.id FROM institution_relationships r JOIN users su ON su.id = r.student_user_id AND su.state = 'ACTIVE'
          WHERE r.institution_id = p.institution_id AND r.student_user_id = p.student_user_id
            AND r.state IN ('VERIFIED', 'ACTIVE') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())
          ORDER BY r.effective_from DESC LIMIT 1) AS current_relationship_id
      FROM institution_student_profiles p
      WHERE p.institution_id = ${staff.institutionId}::uuid AND p.student_user_id = ${studentId}::uuid
      LIMIT 1
    `) as Rows<Subject>;
    return result.rows[0] ?? null;
  }

  private basis(staff: Staff, subject: Subject | null): Basis {
    if (!subject) return 'NONE';
    if (institutionWideRoles.includes(staff.role)) return 'OWNER_ADMIN';
    if (subject.participant) return 'PARTICIPANT';
    return subject.in_read_scope ? 'AUTHOR' : 'NONE';
  }

  /** True when the note was written and last changed inside a relationship that authorised activity then. */
  private async withinRelationship(tx: PersistenceDb, institutionId: string, note: Pick<NoteRow, 'subject_student_user_id' | 'created_at' | 'updated_at'>): Promise<boolean> {
    for (const at of [note.created_at, note.updated_at]) {
      if (!await hasInstitutionRelationshipAuthorizationForActivity(tx, institutionId, note.subject_student_user_id, new Date(at))) return false;
    }
    return true;
  }

  /** Cases the caller can open: every student with a note or a case for owners and admins; otherwise their own. */
  @Get('/institutions/:institutionId/counselling-cases')
  async cases(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const [read, write] = await Promise.all([this.readScope(tx, staff), this.writeScope(tx, staff)]);
      const wide = institutionWideRoles.includes(staff.role);
      const result = await tx.execute(sql`
        WITH readable AS (
          SELECT a.subject_student_user_id AS student_user_id, a.id, a.created_at, a.updated_at
          FROM staff_actions a
          JOIN institution_student_profiles p ON p.institution_id = a.institution_id AND p.student_user_id = a.subject_student_user_id
          WHERE a.institution_id = ${staff.institutionId}::uuid AND a.action_type = 'COUNSELLING_NOTE'
            AND (${wide}
              OR EXISTS (SELECT 1 FROM counselling_case_participants c WHERE c.institution_id = a.institution_id
                AND c.student_user_id = a.subject_student_user_id AND c.membership_id = ${staff.membershipId}::uuid AND c.removed_at IS NULL)
              OR (a.actor_membership_id = ${staff.membershipId}::uuid AND ${institutionStudentScopeSql(read, 'p')}))
        ), cases AS (
          SELECT student_user_id FROM readable
          UNION
          SELECT c.student_user_id FROM counselling_case_participants c
          WHERE c.institution_id = ${staff.institutionId}::uuid AND c.removed_at IS NULL
            AND (${wide} OR c.membership_id = ${staff.membershipId}::uuid)
        )
        SELECT p.student_user_id, p.full_name,
          EXISTS (SELECT 1 FROM counselling_case_participants c WHERE c.institution_id = p.institution_id
            AND c.student_user_id = p.student_user_id AND c.membership_id = ${staff.membershipId}::uuid AND c.removed_at IS NULL) AS participant,
          coalesce((SELECT json_agg(json_build_object('created_at', r.created_at, 'updated_at', r.updated_at))
            FROM readable r WHERE r.student_user_id = p.student_user_id), '[]'::json) AS notes
        FROM cases JOIN institution_student_profiles p ON p.institution_id = ${staff.institutionId}::uuid AND p.student_user_id = cases.student_user_id
        ORDER BY p.full_name, p.student_user_id
        LIMIT 200
      `) as Rows<{ student_user_id: string; full_name: string; participant: boolean; notes: { created_at: string; updated_at: string }[] }>;
      const cases = [];
      for (const row of result.rows) {
        let count = 0; let last: string | null = null;
        for (const note of row.notes) {
          if (!await this.withinRelationship(tx, staff.institutionId, { subject_student_user_id: row.student_user_id, created_at: new Date(note.created_at), updated_at: new Date(note.updated_at) })) continue;
          count += 1;
          if (!last || new Date(note.created_at) > new Date(last)) last = new Date(note.created_at).toISOString();
        }
        // A case with no visible note and no participation of the caller's own is not theirs to see.
        if (count === 0 && !wide && !row.participant) continue;
        cases.push({ studentUserId: row.student_user_id, studentName: row.full_name, notes: count, lastNoteAt: last, participant: row.participant });
      }
      // Students the caller may write a first note about: their write scope, current relationship.
      const students = await tx.execute(sql`
        SELECT p.student_user_id, p.full_name FROM institution_student_profiles p JOIN users u ON u.id = p.student_user_id
        WHERE p.institution_id = ${staff.institutionId}::uuid AND p.status = 'ACTIVE' AND u.state = 'ACTIVE'
          AND ${institutionStudentScopeSql(write, 'p')}
          AND EXISTS (SELECT 1 FROM institution_relationships r WHERE r.institution_id = p.institution_id
            AND r.student_user_id = p.student_user_id AND r.state IN ('VERIFIED', 'ACTIVE')
            AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
        ORDER BY p.full_name, p.student_user_id LIMIT 200
      `) as Rows<{ student_user_id: string; full_name: string }>;
      await this.audit(tx, staff, 'counselling_note.cases_listed', 'institution', staff.institutionId, 'SUCCESS', { returned: cases.length });
      return {
        cases,
        students: students.rows.map((row) => ({ id: row.student_user_id, name: row.full_name })),
        canManageParticipants: wide,
      };
    });
  }

  /** One student's notes the caller may read, newest first, with the case's participants for those who may see them. */
  @Get('/institutions/:institutionId/students/:studentUserId/counselling-notes')
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentUserId') studentUserId: string,
    @Query('limit') limitParam?: string, @Query('cursor') cursorParam?: string) {
    let denied: string | null = null;
    const result = await this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const studentId = uuid(studentUserId, staff.correlationId);
      const limit = limitOf(limitParam, staff.correlationId);
      const cursor = cursorParam === undefined ? null : uuid(cursorParam, staff.correlationId);
      const [read, write] = await Promise.all([this.readScope(tx, staff), this.writeScope(tx, staff)]);
      const subject = await this.subject(tx, staff, studentId, read, write);
      const basis = this.basis(staff, subject);
      if (basis === 'NONE' || !subject) {
        // Audited, then refused after the transaction commits so the refusal is on the record.
        await this.audit(tx, staff, 'counselling_note.read', 'institution_student', studentId, 'DENIED', { returned: 0 });
        denied = staff.correlationId;
        return null;
      }
      const rows = await tx.execute(sql`
        SELECT a.id, a.subject_student_user_id, a.actor_membership_id, a.title, a.note, a.visibility, a.version,
          a.created_at, a.updated_at, am.role AS author_role, au.email AS author_name
        FROM staff_actions a
        JOIN organization_memberships am ON am.id = a.actor_membership_id
        JOIN users au ON au.id = a.actor_user_id
        WHERE a.institution_id = ${staff.institutionId}::uuid AND a.action_type = 'COUNSELLING_NOTE'
          AND a.subject_student_user_id = ${studentId}::uuid
          AND (${basis !== 'AUTHOR'} OR a.actor_membership_id = ${staff.membershipId}::uuid)
          AND (${cursor}::uuid IS NULL OR (a.created_at, a.id) < (SELECT c.created_at, c.id FROM staff_actions c
            WHERE c.id = ${cursor}::uuid AND c.institution_id = ${staff.institutionId}::uuid AND c.action_type = 'COUNSELLING_NOTE'))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit + 1}
      `) as Rows<NoteRow>;
      const page = rows.rows.slice(0, limit);
      const notes = [];
      for (const row of page) {
        if (!await this.withinRelationship(tx, staff.institutionId, row)) continue;
        const own = row.actor_membership_id === staff.membershipId;
        notes.push({
          id: row.id, title: row.title, note: row.note, visibility: row.visibility, version: row.version,
          createdAt: row.created_at, authorName: row.author_name, authorRole: row.author_role, writtenByYou: own,
          canChangeVisibility: Boolean(subject.current_relationship_id) && (own || basis === 'OWNER_ADMIN'),
          canErase: basis === 'OWNER_ADMIN',
        });
      }
      // Who else reads this case is itself sensitive: only owners, admins and participants see it.
      const seesCase = basis === 'OWNER_ADMIN' || basis === 'PARTICIPANT';
      const participants = seesCase ? (await tx.execute(sql`
        SELECT c.membership_id, c.added_at, c.added_reason_code, m.role, u.email
        FROM counselling_case_participants c
        JOIN organization_memberships m ON m.id = c.membership_id JOIN users u ON u.id = m.user_id
        WHERE c.institution_id = ${staff.institutionId}::uuid AND c.student_user_id = ${studentId}::uuid AND c.removed_at IS NULL
        ORDER BY c.added_at, c.id
      `) as Rows<{ membership_id: string; added_at: Date; added_reason_code: string; role: string; email: string }>).rows : [];
      const eligibleStaff = basis === 'OWNER_ADMIN' ? (await tx.execute(sql`
        SELECT m.id, m.role, u.email FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${staff.institutionId}::uuid AND m.scope_institution_id = ${staff.institutionId}::uuid
          AND m.state = 'ACTIVE' AND u.state = 'ACTIVE'
          AND m.role IN ('PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER')
          AND NOT EXISTS (SELECT 1 FROM counselling_case_participants c WHERE c.institution_id = m.organization_id
            AND c.student_user_id = ${studentId}::uuid AND c.membership_id = m.id AND c.removed_at IS NULL)
        ORDER BY u.email, m.id LIMIT 200
      `) as Rows<{ id: string; role: string; email: string }>).rows : [];
      await this.audit(tx, staff, 'counselling_note.read', 'institution_student', studentId, 'SUCCESS', {
        returned: notes.length, noteIds: notes.map((note) => note.id), basis,
      });
      return {
        student: { id: subject.student_user_id, name: subject.full_name },
        notes,
        nextCursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
        participants: participants.map((row) => ({ membershipId: row.membership_id, name: row.email, role: row.role, addedAt: row.added_at, reasonCode: row.added_reason_code })),
        eligibleStaff: eligibleStaff.map((row) => ({ membershipId: row.id, name: row.email, role: row.role })),
        canWrite: Boolean(subject.current_relationship_id) && (subject.in_write_scope || subject.participant),
        canManageParticipants: basis === 'OWNER_ADMIN',
      };
    });
    if (denied) throw new ForbiddenException(safeError('FORBIDDEN', denied));
    return result;
  }

  @Post('/institutions/:institutionId/students/:studentUserId/counselling-notes')
  async create(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentUserId') studentUserId: string,
    @Body() body: unknown) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const studentId = uuid(studentUserId, staff.correlationId);
      const input = objectBody(body, ['title', 'note', 'shareWithStudent'], staff.correlationId);
      const title = text(input['title'], 200, staff.correlationId);
      const note = text(input['note'], 4000, staff.correlationId);
      if (input['shareWithStudent'] !== undefined && typeof input['shareWithStudent'] !== 'boolean') throw invalid(staff.correlationId);
      const visibility: Visibility = input['shareWithStudent'] === true ? 'SUBJECT_VISIBLE' : 'STAFF_ONLY';
      const [read, write] = await Promise.all([this.readScope(tx, staff), this.writeScope(tx, staff)]);
      const subject = await this.subject(tx, staff, studentId, read, write);
      if (!subject?.participant) {
        if (write.kind === 'NONE') throw failure('FORBIDDEN', 'SCOPE_REQUIRED', staff.correlationId);
        if (!subject?.in_write_scope) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      }
      if (!subject.current_relationship_id) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      const id = this.ids.uuid();
      await tx.execute(sql`
        INSERT INTO staff_actions (id, institution_id, subject_student_user_id, institution_relationship_id,
          actor_user_id, actor_membership_id, assigned_to_membership_id, department_unit_id, batch_unit_id,
          action_type, state, title, note, visibility, updated_by_user_id)
        VALUES (${id}::uuid, ${staff.institutionId}::uuid, ${studentId}::uuid, ${subject.current_relationship_id}::uuid,
          ${staff.userId}::uuid, ${staff.membershipId}::uuid, ${staff.membershipId}::uuid, ${subject.department_unit_id}::uuid, ${subject.batch_unit_id}::uuid,
          'COUNSELLING_NOTE', 'OPEN', ${title}, ${note}, ${visibility}, ${staff.userId}::uuid)
      `);
      await this.audit(tx, staff, 'counselling_note.created', 'counselling_note', id, 'SUCCESS', {
        studentUserId: studentId, visibility, titleLength: title.length, noteLength: note.length,
        basis: subject.participant ? 'PARTICIPANT' : 'WRITE_SCOPE',
      });
      return { id, visibility, version: 1 };
    });
  }

  /** Share a note with the student, or withdraw it: the author, an owner or an admin. */
  @Post('/institutions/:institutionId/counselling-notes/:noteId/visibility')
  async visibility(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('noteId') noteId: string, @Body() body: unknown) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const id = uuid(noteId, staff.correlationId);
      const input = objectBody(body, ['visibility', 'version'], staff.correlationId);
      if (!visibilities.includes(input['visibility'] as Visibility) || !Number.isSafeInteger(input['version']) || Number(input['version']) < 1) throw invalid(staff.correlationId);
      const target = input['visibility'] as Visibility;
      const note = await this.lockedNote(tx, staff, id);
      const [read, write] = await Promise.all([this.readScope(tx, staff), this.writeScope(tx, staff)]);
      const subject = await this.subject(tx, staff, note.subject_student_user_id, read, write);
      const basis = this.basis(staff, subject);
      const own = note.actor_membership_id === staff.membershipId;
      if (!subject?.current_relationship_id || !(basis === 'OWNER_ADMIN' || (basis !== 'NONE' && own))
        || !await this.withinRelationship(tx, staff.institutionId, note)) {
        throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      }
      if (input['version'] !== note.version) throw new ConflictException({ error: { code: 'STALE_VERSION', correlationId: staff.correlationId, message: 'Request could not be completed.' } });
      const updated = await tx.execute(sql`
        UPDATE staff_actions SET visibility = ${target}, version = version + 1, updated_at = now(), updated_by_user_id = ${staff.userId}::uuid
        WHERE id = ${id}::uuid AND institution_id = ${staff.institutionId}::uuid AND action_type = 'COUNSELLING_NOTE' AND version = ${note.version}
        RETURNING version
      `) as Rows<{ version: number }>;
      const version = updated.rows[0]?.version;
      if (!version) throw new ConflictException({ error: { code: 'STALE_VERSION', correlationId: staff.correlationId, message: 'Request could not be completed.' } });
      await this.audit(tx, staff, 'counselling_note.visibility_changed', 'counselling_note', id, 'SUCCESS', {
        studentUserId: note.subject_student_user_id, fromVisibility: note.visibility, toVisibility: target, fromVersion: note.version, version,
      });
      return { id, visibility: target, version };
    });
  }

  /** Erase one note (a student's correction or erasure request, honoured by the college): owners and admins, with a reason code. */
  @Post('/institutions/:institutionId/counselling-notes/:noteId/erase')
  async erase(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('noteId') noteId: string, @Body() body: unknown) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const id = uuid(noteId, staff.correlationId);
      if (!institutionWideRoles.includes(staff.role)) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      const input = objectBody(body, ['reasonCode'], staff.correlationId);
      const reason = reasonCode(input['reasonCode'], staff.correlationId);
      const note = await this.lockedNote(tx, staff, id);
      await tx.execute(sql`DELETE FROM staff_actions WHERE id = ${id}::uuid AND institution_id = ${staff.institutionId}::uuid AND action_type = 'COUNSELLING_NOTE'`);
      await this.audit(tx, staff, 'counselling_note.erased', 'counselling_note', id, 'SUCCESS', {
        studentUserId: note.subject_student_user_id, reasonCode: reason, authorMembershipId: note.actor_membership_id,
      });
      return { id, erased: true };
    });
  }

  @Post('/institutions/:institutionId/students/:studentUserId/counselling-case/participants')
  async addParticipant(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentUserId') studentUserId: string, @Body() body: unknown) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const studentId = uuid(studentUserId, staff.correlationId);
      if (!institutionWideRoles.includes(staff.role)) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      const input = objectBody(body, ['membershipId', 'reasonCode'], staff.correlationId);
      const membershipId = uuid(input['membershipId'], staff.correlationId);
      const reason = reasonCode(input['reasonCode'], staff.correlationId);
      const student = await tx.execute(sql`
        SELECT 1 FROM institution_student_profiles p
        JOIN institution_relationships r ON r.institution_id = p.institution_id AND r.student_user_id = p.student_user_id
        WHERE p.institution_id = ${staff.institutionId}::uuid AND p.student_user_id = ${studentId}::uuid
          AND r.state IN ('VERIFIED', 'ACTIVE') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())
        LIMIT 1
      `) as Rows<unknown>;
      if (!student.rows.length) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      const member = await tx.execute(sql`
        SELECT m.id FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = ${membershipId}::uuid AND m.organization_id = ${staff.institutionId}::uuid AND m.scope_institution_id = ${staff.institutionId}::uuid
          AND m.state = 'ACTIVE' AND u.state = 'ACTIVE'
          AND m.role IN ('PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER')
        FOR SHARE OF m
      `) as Rows<{ id: string }>;
      if (!member.rows.length) throw invalid(staff.correlationId);
      const id = this.ids.uuid();
      const inserted = await tx.execute(sql`
        INSERT INTO counselling_case_participants (id, institution_id, student_user_id, membership_id, added_by_user_id, added_by_membership_id, added_reason_code)
        VALUES (${id}::uuid, ${staff.institutionId}::uuid, ${studentId}::uuid, ${membershipId}::uuid, ${staff.userId}::uuid, ${staff.membershipId}::uuid, ${reason})
        ON CONFLICT (institution_id, student_user_id, membership_id) WHERE removed_at IS NULL DO NOTHING
        RETURNING id
      `) as Rows<{ id: string }>;
      if (!inserted.rows.length) throw new ConflictException({ error: { code: 'ALREADY_PARTICIPANT', correlationId: staff.correlationId, message: 'Request could not be completed.' } });
      await this.audit(tx, staff, 'counselling_case.participant_added', 'institution_student', studentId, 'SUCCESS', { participantMembershipId: membershipId, reasonCode: reason });
      return { id, membershipId };
    });
  }

  @Post('/institutions/:institutionId/students/:studentUserId/counselling-case/participants/:membershipId/remove')
  async removeParticipant(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentUserId') studentUserId: string,
    @Param('membershipId') membershipParam: string, @Body() body: unknown) {
    return this.db.transaction(async (tx) => {
      const staff = await this.staff(tx, request, institutionId);
      const studentId = uuid(studentUserId, staff.correlationId);
      const membershipId = uuid(membershipParam, staff.correlationId);
      if (!institutionWideRoles.includes(staff.role)) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
      const input = objectBody(body, ['reasonCode'], staff.correlationId);
      const reason = reasonCode(input['reasonCode'], staff.correlationId);
      const removed = await tx.execute(sql`
        UPDATE counselling_case_participants SET removed_at = now(), removed_by_user_id = ${staff.userId}::uuid, removed_reason_code = ${reason}
        WHERE institution_id = ${staff.institutionId}::uuid AND student_user_id = ${studentId}::uuid AND membership_id = ${membershipId}::uuid AND removed_at IS NULL
        RETURNING id
      `) as Rows<{ id: string }>;
      if (!removed.rows.length) throw new NotFoundException({ error: { code: 'NOT_FOUND', correlationId: staff.correlationId, message: 'Request could not be completed.' } });
      await this.audit(tx, staff, 'counselling_case.participant_removed', 'institution_student', studentId, 'SUCCESS', { participantMembershipId: membershipId, reasonCode: reason });
      return { membershipId, removed: true };
    });
  }

  /** The notes a college has shared with the student. Identity comes from the guard, never a requested id. */
  @Get('/students/me/counselling-notes')
  async forStudent(@Req() request: ProtectedHttpRequest, @Query('institutionId') institutionId: string) {
    const context = requireTrustedAuthorization(request);
    const id = uuid(institutionId, context.correlationId);
    const studentUserId = context.authorization.principal.userId;
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT a.id, a.subject_student_user_id, a.title, a.note, a.created_at, a.updated_at, am.role AS author_role
        FROM staff_actions a
        JOIN organizations o ON o.id = a.institution_id AND o.active AND o.kind = 'INSTITUTION'
        JOIN organization_memberships am ON am.id = a.actor_membership_id
        WHERE a.institution_id = ${id}::uuid AND a.subject_student_user_id = ${studentUserId}::uuid
          AND a.action_type = 'COUNSELLING_NOTE' AND a.visibility = 'SUBJECT_VISIBLE'
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 200
      `) as Rows<{ id: string; subject_student_user_id: string; title: string; note: string; created_at: Date; updated_at: Date; author_role: string }>;
      const notes = [];
      for (const row of result.rows) {
        if (!await this.withinRelationship(tx, id, row)) continue;
        notes.push({ id: row.id, title: row.title, note: row.note, createdAt: row.created_at, authorRole: row.author_role });
      }
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, 'counselling_note.student_read', 'institution_student', ${studentUserId},
          ${id}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify({ returned: notes.length })}::jsonb)
      `);
      return { notes };
    });
  }

  private async lockedNote(tx: PersistenceDb, staff: Staff, id: string): Promise<NoteRow> {
    const result = await tx.execute(sql`
      SELECT a.id, a.subject_student_user_id, a.actor_membership_id, a.visibility, a.version, a.created_at, a.updated_at
      FROM staff_actions a
      WHERE a.id = ${id}::uuid AND a.institution_id = ${staff.institutionId}::uuid AND a.action_type = 'COUNSELLING_NOTE'
      FOR UPDATE OF a
    `) as Rows<NoteRow>;
    const note = result.rows[0];
    if (!note) throw failure('FORBIDDEN', 'FORBIDDEN', staff.correlationId);
    return note;
  }

  /** No audit row carries a note's title or text (design: Audit). */
  private async audit(tx: PersistenceDb, staff: Staff, action: string, resourceType: string, resourceId: string, outcome: 'SUCCESS' | 'DENIED', context: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${staff.userId}::uuid, ${action}, ${resourceType}, ${resourceId},
        ${staff.institutionId}::uuid, ${outcome}, ${staff.correlationId}, ${JSON.stringify({ ...context, actorMembershipId: staff.membershipId })}::jsonb)
    `);
  }
}
