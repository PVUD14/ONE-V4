/**
 * Restricted counselling notes (INST-11, ADR-036).
 *
 * Who reads a note: the author (while the student stays in their INST-02 scope), institution
 * owners and admins, and staff an owner or admin added to that student's counselling case — not
 * the unit scope other staff actions use. Writes use the write scope (SCOPE_REQUIRED when the
 * writer has none). Every read and write is audited without the note's text; notes never reach a
 * generic staff-action list, an export summary, a calendar or the student unless shared; privacy
 * deletion erases them and the subject export summarises them.
 * Design: docs/architecture/counselling-notes-table-design.md.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { exportStaffActionSummary } from '@planthepath/persistence/src/institution-exports.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for counselling note tests');
const schemaName = 'counsel_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string; let batchB1: string;
let studentA: Person; let studentB: Person; let graduate: Person; let ended: Person;
let owner: Staff; let admin: Staff; let headA: Staff; let headB: Staff; let unscopedHead: Staff; let faculty: Staff;
let counsellor: Staff; let outsider: Staff; let suspended: Staff;

interface Person { id: string; email: string }
interface Staff { id: string; membershipId: string }
const SECRET = 'Disclosed a family bereavement; referred to wellbeing';

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: { async verifyAccessToken(token: string) {
        if (!tokens.has(token)) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
});
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  [departmentA, departmentB, batchA1, batchB1] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local College'), ($2,'INSTITUTION','Other College')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  studentA = await student('S-A', departmentA, batchA1);
  studentB = await student('S-B', departmentB, batchB1);
  graduate = await student('S-G', departmentA, batchA1);
  ended = await student('S-E', departmentA, batchA1);
  owner = await staff('INSTITUTION_OWNER');
  admin = await staff('INSTITUTION_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  headB = await staff('DEPARTMENT_HEAD', departmentB);
  unscopedHead = await staff('DEPARTMENT_HEAD');
  faculty = await staff('FACULTY_LECTURER', departmentA);
  counsellor = await staff('FACULTY_LECTURER', departmentB);
  outsider = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
  suspended = await staff('FACULTY_LECTURER', departmentA);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function student(roll: string, department: string, batch: string): Promise<Person> {
  const id = randomUUID(); const email = roll.toLowerCase() + '@example.test';
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email]);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7)`, [randomUUID(), institutionId, id, roll, 'Student ' + roll, department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,now()-interval '30 days',NULL)`, [randomUUID(), institutionId, id, 'ACTIVE']);
  return { id, email };
}
/** Ends a relationship now, so earlier notes were written inside it and later ones cannot be. */
async function endRelationship(person: Person, state: 'GRADUATED' | 'ENDED') {
  await pool.query(`UPDATE institution_relationships SET state = $2, effective_to = now() WHERE student_user_id = $1`, [person.id, state]);
}
async function staff(role: string, department: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, department]);
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const inst = (institution = institutionId) => '/api/v1/institutions/' + institution;
const notesOf = (person: Person, institution = institutionId) => inst(institution) + '/students/' + person.id + '/counselling-notes';
const participantsOf = (person: Person) => inst() + '/students/' + person.id + '/counselling-case/participants';
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });

async function write(author: Staff, about: Person, body: Record<string, unknown> = {}) {
  return api().post(notesOf(about)).set(auth(author.id)).send({ title: 'Session one', note: SECRET, ...body });
}
async function addParticipant(by: Staff, about: Person, member: Staff, reasonCode = 'CASE_REFERRAL') {
  return api().post(participantsOf(about)).set(auth(by.id)).send({ membershipId: member.membershipId, reasonCode });
}
async function audits(action: string) {
  return (await pool.query('SELECT actor_user_id, outcome, resource_id, context FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action])).rows as {
    actor_user_id: string; outcome: string; resource_id: string; context: Record<string, unknown>;
  }[];
}

describe('who may read a counselling note', () => {
  it('lets the author, the owner and an admin read it, and nobody else by default', async () => {
    const created = await write(faculty, studentA);
    expect(created.status).toBe(201);
    expect(created.body.visibility).toBe('STAFF_ONLY');
    for (const reader of [faculty, owner, admin]) {
      const read = await api().get(notesOf(studentA)).set(auth(reader.id));
      expect(read.status).toBe(200);
      expect(read.body.notes.map((note: { id: string }) => note.id)).toEqual([created.body.id]);
      expect(read.body.notes[0].note).toBe(SECRET);
    }
  });

  it('denies a department head of the student\'s own department who is not a case participant (acceptance)', async () => {
    const created = await write(admin, studentA);
    expect(created.status).toBe(201);
    const read = await api().get(notesOf(studentA)).set(auth(headA.id));
    expect(read.status).toBe(200);
    expect(read.body.notes).toEqual([]);
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
    // Nor does the case's existence or membership leak to a non-participant.
    expect(read.body.participants).toEqual([]);
    const cases = await api().get(inst() + '/counselling-cases').set(auth(headA.id));
    expect(cases.status).toBe(200);
    expect(cases.body.cases).toEqual([]);
  });

  it('denies other faculty in the same department, and audits the refusal of an out-of-scope head as DENIED', async () => {
    await write(admin, studentA);
    const colleague = await api().get(notesOf(studentA)).set(auth(suspended.id));
    expect(colleague.status).toBe(200);
    expect(colleague.body.notes).toEqual([]);
    const other = await api().get(notesOf(studentA)).set(auth(headB.id));
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain(SECRET);
    const denied = (await audits('counselling_note.read')).filter((row) => row.actor_user_id === headB.id);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.outcome).toBe('DENIED');
  });

  it('lets a case participant read the notes, even outside their unit scope, until removed', async () => {
    const created = await write(admin, studentA);
    expect((await api().get(notesOf(studentA)).set(auth(counsellor.id))).status).toBe(403);
    const added = await addParticipant(admin, studentA, counsellor);
    expect(added.status).toBe(201);
    const read = await api().get(notesOf(studentA)).set(auth(counsellor.id));
    expect(read.status).toBe(200);
    expect(read.body.notes.map((note: { id: string }) => note.id)).toEqual([created.body.id]);
    expect(read.body.participants.map((p: { membershipId: string }) => p.membershipId)).toEqual([counsellor.membershipId]);
    const cases = await api().get(inst() + '/counselling-cases').set(auth(counsellor.id));
    expect(cases.body.cases.map((c: { studentUserId: string }) => c.studentUserId)).toEqual([studentA.id]);
    // Participant writes too, and the note is theirs.
    expect((await write(counsellor, studentA, { title: 'Follow-up' })).status).toBe(201);

    const removed = await api().post(participantsOf(studentA) + '/' + counsellor.membershipId + '/remove').set(auth(admin.id)).send({ reasonCode: 'CASE_CLOSED' });
    expect(removed.status).toBe(201);
    expect((await api().get(notesOf(studentA)).set(auth(counsellor.id))).status).toBe(403);
    const history = await pool.query('SELECT removed_at, removed_reason_code FROM counselling_case_participants WHERE membership_id = $1', [counsellor.membershipId]);
    expect(history.rows[0].removed_reason_code).toBe('CASE_CLOSED');
    expect(history.rows[0].removed_at).not.toBeNull();
  });

  it('stops an author reading their own note once the student leaves their scope', async () => {
    await write(faculty, studentA);
    await pool.query('UPDATE organization_memberships SET scope_department_unit_id = $2 WHERE id = $1', [faculty.membershipId, departmentB]);
    expect((await api().get(notesOf(studentA)).set(auth(faculty.id))).status).toBe(403);
    // The admin still can.
    expect((await api().get(notesOf(studentA)).set(auth(admin.id))).body.notes).toHaveLength(1);
  });

  it('refuses a suspended membership, another institution, and no token', async () => {
    await write(admin, studentA);
    await addParticipant(admin, studentA, suspended);
    await pool.query("UPDATE organization_memberships SET state = 'SUSPENDED' WHERE id = $1", [suspended.membershipId]);
    expect((await api().get(notesOf(studentA)).set(auth(suspended.id))).status).toBe(403);
    expect((await api().get(notesOf(studentA)).set(auth(outsider.id))).status).toBe(403);
    expect((await api().get(notesOf(studentA, otherInstitutionId)).set(auth(outsider.id))).status).toBe(403);
    expect((await api().get(notesOf(studentA))).status).toBe(401);
  });
});

describe('relationship policy', () => {
  it('hides every note once a relationship has ended, and keeps a graduate\'s notes written before effective_to', async () => {
    await write(admin, ended);
    await write(admin, graduate);
    await endRelationship(ended, 'ENDED');
    await endRelationship(graduate, 'GRADUATED');
    expect((await api().get(notesOf(ended)).set(auth(admin.id))).body.notes).toEqual([]);
    expect((await api().get(notesOf(graduate)).set(auth(admin.id))).body.notes).toHaveLength(1);
    // Nothing new is written after the relationship ends.
    expect((await write(admin, graduate)).status).toBe(403);
  });
});

describe('writing', () => {
  it('uses the write scope: SCOPE_REQUIRED without one, FORBIDDEN outside it', async () => {
    const none = await write(unscopedHead, studentA);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('SCOPE_REQUIRED');
    const outside = await write(headB, studentA);
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe('FORBIDDEN');
    expect((await pool.query("SELECT count(*)::int AS n FROM staff_actions WHERE action_type = 'COUNSELLING_NOTE'")).rows[0].n).toBe(0);
  });

  it('validates input and rejects unknown fields and workflow columns', async () => {
    expect((await write(admin, studentA, { note: '' })).status).toBe(400);
    expect((await write(admin, studentA, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await write(admin, studentA, { note: 'x'.repeat(4001) })).status).toBe(400);
    expect((await write(admin, studentA, { dueAt: '2026-10-01T10:00:00Z' })).status).toBe(400);
    expect((await write(admin, studentA, { shareWithStudent: 'yes' })).status).toBe(400);
    expect((await api().post(inst() + '/students/not-a-uuid/counselling-notes').set(auth(admin.id)).send({ title: 't', note: 'n' })).status).toBe(400);
  });

  it('audits every write without the note text', async () => {
    const created = await write(faculty, studentA);
    await api().get(notesOf(studentA)).set(auth(faculty.id));
    const rows = [...await audits('counselling_note.created'), ...await audits('counselling_note.read')];
    expect(rows.map((row) => row.outcome)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(rows[0]!.resource_id).toBe(created.body.id);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain('Session one');
    expect(rows[1]!.context.returned).toBe(1);
  });

  it('keeps the database from giving a note a due date or another owner', async () => {
    await write(admin, studentA);
    await expect(pool.query("UPDATE staff_actions SET due_at = now() WHERE action_type = 'COUNSELLING_NOTE'")).rejects.toThrow(/counselling_shape/);
    await expect(pool.query("UPDATE staff_actions SET assigned_to_membership_id = $1 WHERE action_type = 'COUNSELLING_NOTE'", [faculty.membershipId])).rejects.toThrow(/counselling_shape/);
  });
});

describe('case participants', () => {
  it('are managed only by owners and admins, with a reason code, and only from the same institution', async () => {
    expect((await addParticipant(headA, studentA, counsellor)).status).toBe(403);
    expect((await addParticipant(admin, studentA, counsellor, 'no')).status).toBe(400);
    expect((await addParticipant(admin, studentA, outsider)).status).toBe(400);
    expect((await addParticipant(owner, studentA, counsellor)).status).toBe(201);
    expect((await addParticipant(admin, studentA, counsellor)).status).toBe(409);
    const rows = await audits('counselling_case.participant_added');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context.reasonCode).toBe('CASE_REFERRAL');
  });

  it('offers owners and admins the institution\'s active staff to add', async () => {
    const read = await api().get(notesOf(studentA)).set(auth(admin.id));
    const offered = read.body.eligibleStaff.map((s: { membershipId: string }) => s.membershipId);
    expect(offered).toEqual(expect.arrayContaining([headA.membershipId, counsellor.membershipId]));
    expect(offered).not.toContain(outsider.membershipId);
    expect((await api().get(notesOf(studentA)).set(auth(faculty.id))).body.eligibleStaff).toEqual([]);
  });
});

describe('sharing with the student', () => {
  it('is STAFF_ONLY by default; the author can share and withdraw; a participant cannot', async () => {
    const created = await write(faculty, studentA);
    const mine = () => api().get('/api/v1/students/me/counselling-notes?institutionId=' + institutionId).set(auth(studentA.id));
    expect((await mine()).body.notes).toEqual([]);
    await addParticipant(admin, studentA, counsellor);
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/visibility').set(auth(counsellor.id))
      .send({ visibility: 'SUBJECT_VISIBLE', version: 1 })).status).toBe(403);
    const shared = await api().post(inst() + '/counselling-notes/' + created.body.id + '/visibility').set(auth(faculty.id))
      .send({ visibility: 'SUBJECT_VISIBLE', version: 1 });
    expect(shared.status).toBe(201);
    expect(shared.body.version).toBe(2);
    const seen = await mine();
    expect(seen.body.notes).toEqual([expect.objectContaining({ id: created.body.id, note: SECRET })]);
    expect(seen.body.notes[0]).not.toHaveProperty('authorName');
    // Stale version.
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/visibility').set(auth(faculty.id))
      .send({ visibility: 'STAFF_ONLY', version: 1 })).status).toBe(409);
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/visibility').set(auth(admin.id))
      .send({ visibility: 'STAFF_ONLY', version: 2 })).status).toBe(201);
    expect((await mine()).body.notes).toEqual([]);
    // Another student never sees it.
    expect((await api().get('/api/v1/students/me/counselling-notes?institutionId=' + institutionId).set(auth(studentB.id))).body.notes).toEqual([]);
    expect((await audits('counselling_note.visibility_changed'))).toHaveLength(2);
    expect((await audits('counselling_note.student_read')).length).toBeGreaterThan(0);
  });
});

describe('exclusion from every other surface', () => {
  it('is refused by the generic staff-action endpoints', async () => {
    await write(admin, studentA);
    expect((await api().get(inst() + '/staff-actions?actionType=COUNSELLING_NOTE').set(auth(admin.id))).status).toBe(400);
    expect((await api().post(inst() + '/staff-actions?actionType=COUNSELLING_NOTE').set(auth(admin.id)).send({ studentUserId: studentA.id, title: 't', note: 'n' })).status).toBe(400);
    for (const type of ['FACULTY_NOTE', 'INTERVENTION', 'ASSIGNED_TASK', 'ACADEMIC_VERIFICATION', 'MEETING']) {
      const list = await api().get(inst() + '/staff-actions?actionType=' + type).set(auth(admin.id));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(SECRET);
    }
    const student = await api().get('/api/v1/students/me/staff-actions?institutionId=' + institutionId).set(auth(studentA.id));
    expect(JSON.stringify(student.body)).not.toContain(SECRET);
  });

  it('never appears in the export summary or the calendars, even when shared', async () => {
    const created = await write(admin, studentA, { shareWithStudent: true });
    expect(created.body.visibility).toBe('SUBJECT_VISIBLE');
    const month = new Date().toISOString().slice(0, 7);
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const summary = await exportStaffActionSummary(pool, { institutionId, scope: { kind: 'INSTITUTION' }, periodStart: month + '-01', periodEnd: lastDay });
    expect(summary.map((row) => row.actionType)).not.toContain('COUNSELLING_NOTE');
    expect(summary.every((row) => row.actions.suppressed && row.students.suppressed)).toBe(true);
    const counted = await pool.query(`SELECT count(*)::int AS n FROM staff_actions WHERE action_type <> 'COUNSELLING_NOTE'`);
    expect(counted.rows[0].n).toBe(0);
    for (const who of [studentA.id, admin.id]) {
      const calendar = await api().get('/api/v1/me/calendar').set(auth(who));
      expect(calendar.status).toBe(200);
      expect(JSON.stringify(calendar.body)).not.toContain(SECRET);
    }
  });
});

describe('privacy', () => {
  it('summarises notes in the subject export: shared text, staff-only count', async () => {
    await write(admin, studentA);
    await write(admin, studentA, { title: 'Shared plan', note: 'Plan agreed together', shareWithStudent: true });
    const bundle = await assembleSubjectExport(db, studentA.id) as {
      counsellingNotes: { shared: { title: string; note: string }[]; heldByCollege: { institutionName: string; staffOnlyNotes: number }[] };
    };
    expect(bundle.counsellingNotes.shared).toEqual([expect.objectContaining({ title: 'Shared plan', note: 'Plan agreed together' })]);
    expect(bundle.counsellingNotes.heldByCollege).toEqual([{ institutionName: 'Local College', staffOnlyNotes: 1 }]);
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
  });

  it('erases the subject\'s notes and case on deletion, and records it', async () => {
    await write(admin, studentA);
    await write(admin, studentB);
    await addParticipant(admin, studentA, counsellor);
    const requestId = randomUUID();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '1 day')`, [requestId, studentA.id]);
    const summaries = await executeDueDeletions({ db, ids: { uuid: () => randomUUID() } });
    expect(summaries[0]?.outcome).toBe('COMPLETED');
    const left = await pool.query(`SELECT subject_student_user_id FROM staff_actions WHERE action_type = 'COUNSELLING_NOTE'`);
    expect(left.rows.map((row) => row.subject_student_user_id)).toEqual([studentB.id]);
    expect((await pool.query('SELECT 1 FROM counselling_case_participants WHERE student_user_id = $1', [studentA.id])).rows).toHaveLength(0);
    const record = await pool.query(`SELECT disposition, record_count FROM privacy_deletion_records WHERE request_id = $1 AND category = 'COUNSELLING_NOTES'`, [requestId]);
    expect(record.rows[0]).toEqual({ disposition: 'ERASED', record_count: 2 });
  });

  it('lets an owner or admin erase one note with a reason code, audited without text', async () => {
    const created = await write(faculty, studentA);
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/erase').set(auth(faculty.id)).send({ reasonCode: 'STUDENT_REQUEST' })).status).toBe(403);
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/erase').set(auth(admin.id)).send({})).status).toBe(400);
    expect((await api().post(inst() + '/counselling-notes/' + created.body.id + '/erase').set(auth(admin.id)).send({ reasonCode: 'STUDENT_REQUEST' })).status).toBe(201);
    expect((await pool.query('SELECT 1 FROM staff_actions WHERE id = $1', [created.body.id])).rows).toHaveLength(0);
    const rows = await audits('counselling_note.erased');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context.reasonCode).toBe('STUDENT_REQUEST');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe('contract', () => {
  it('carries no compensation field and no numeric readiness', async () => {
    await write(admin, studentA);
    const bodies = [
      (await api().get(notesOf(studentA)).set(auth(admin.id))).body,
      (await api().get(inst() + '/counselling-cases').set(auth(admin.id))).body,
    ];
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(/compensation|readinessScore|readiness_score/i);
    }
  });

  it('pages notes newest first with a bounded limit', async () => {
    for (let index = 0; index < 3; index += 1) await write(admin, studentA, { title: 'Note ' + index });
    const first = await api().get(notesOf(studentA) + '?limit=2').set(auth(admin.id));
    expect(first.body.notes.map((note: { title: string }) => note.title)).toEqual(['Note 2', 'Note 1']);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await api().get(notesOf(studentA) + '?limit=2&cursor=' + first.body.nextCursor).set(auth(admin.id));
    expect(second.body.notes.map((note: { title: string }) => note.title)).toEqual(['Note 0']);
    expect(second.body.nextCursor).toBeNull();
    expect((await api().get(notesOf(studentA) + '?limit=0').set(auth(admin.id))).status).toBe(400);
    expect((await api().get(notesOf(studentA) + '?limit=201').set(auth(admin.id))).status).toBe(400);
  });
});
