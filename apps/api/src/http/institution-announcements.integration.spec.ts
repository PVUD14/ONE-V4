/**
 * Cohort announcements (INST-06): who may address whom, send-once scheduling, cancellation, and
 * honest email delivery.
 *
 * Senders are limited to their scope (decision 10.2 #8): owners, admins and placement admins the
 * institution; department heads their department; faculty only the sections and batches of their
 * active teaching assignments. Recipients are resolved server-side when the announcement is sent,
 * through the ADR-028 local dispatcher exactly as deployed. A scheduled announcement sends once
 * however often its event is replayed; a cancelled one never sends; with no email sender (HG-7)
 * the email is recorded as not sent.
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
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { PermanentMailRejection, type InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { writeAnnouncementDispatchRequested } from '@planthepath/persistence/src/institution-announcements.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for announcement tests');
const schemaName = 'announce_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string; let sectionX: string; let sectionY: string; let batchB1: string; let foreignUnit: string;
let studentX: Person; let studentY: Person; let studentB: Person; let formerX: Person; let invitedX: Person;
let admin: Staff; let tpo: Staff; let headA: Staff; let faculty: Staff; let otherFaculty: Staff; let outsider: Staff;
const delivered: { toEmail: string; subject: string; textBody: string }[] = [];
const rejected = new Set<string>();
const unavailable = new Set<string>();
const captureSink: InvitationMailSink = {
  async send(input) {
    if (rejected.has(input.toEmail)) throw new PermanentMailRejection();
    if (unavailable.has(input.toEmail)) throw new Error('sink unavailable');
    delivered.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody });
    return { providerReference: 'capture:' + delivered.length };
  },
};

interface Person { id: string; email: string }
interface Staff { id: string; membershipId: string }

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
  await pool.query('TRUNCATE outbox_events CASCADE');
  tokens.clear(); delivered.length = 0; rejected.clear(); unavailable.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  [departmentA, departmentB, batchA1, sectionX, sectionY, batchB1, foreignUnit] = Array.from({ length: 7 }, () => randomUUID()) as [string, string, string, string, string, string, string];
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local College'), ($2,'INSTITUTION','Other College')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(sectionX, 'SECTION', 'Section X', batchA1);
  await unit(sectionY, 'SECTION', 'Section Y', batchA1);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'SECTION','Elsewhere')", [foreignUnit, otherInstitutionId]);
  studentX = await student('S-X', departmentA, batchA1, sectionX);
  studentY = await student('S-Y', departmentA, batchA1, sectionY);
  studentB = await student('S-B', departmentB, batchB1, null);
  formerX = await student('S-FX', departmentA, batchA1, sectionX, { ended: true });
  invitedX = await student('S-IX', departmentA, batchA1, sectionX, { userState: 'INVITED' });
  admin = await staff('INSTITUTION_ADMIN');
  tpo = await staff('PLACEMENT_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  faculty = await staff('FACULTY_LECTURER', departmentA);
  otherFaculty = await staff('FACULTY_LECTURER', departmentA);
  outsider = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function student(roll: string, department: string, batch: string, section: string | null, options: { ended?: boolean; userState?: string } = {}): Promise<Person> {
  const id = randomUUID(); const email = roll.toLowerCase() + '@example.test';
  tokens.add(id);
  await pool.query('INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,$3)', [id, email, options.userState ?? 'ACTIVE']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,section_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`, [randomUUID(), institutionId, id, roll, 'Student ' + roll, department, batch, section]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,now()-interval '30 days',$5)`,
  [randomUUID(), institutionId, id, options.ended ? 'GRADUATED' : 'ACTIVE', options.ended ? new Date(Date.now() - 86_400_000) : null]);
  return { id, email };
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
const base = (institution = institutionId) => '/api/v1/institutions/' + institution + '/announcements';
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });

async function assign(unitId: string, member: Staff = faculty): Promise<string> {
  const created = await api().post('/api/v1/institutions/' + institutionId + '/teaching-assignments').set(auth(admin.id))
    .send({ facultyMembershipId: member.membershipId, unitId, subjectCode: 'CS201', academicTerm: '2026-27 Odd semester', reasonCode: 'NEW_TERM' }).expect(201);
  return created.body.assignment.id as string;
}
function announce(sender: Staff, audienceUnitId: string | null, extra: Record<string, unknown> = {}) {
  return api().post(base()).set(auth(sender.id)).send({ title: 'Placement drive on Friday', body: 'Bring two copies of your resume to the seminar hall at 10:00.', audienceUnitId, ...extra });
}
/** Run the deployed worker mode (ADR-028 local dispatcher) until the outbox is drained. */
async function drain(sink: InvitationMailSink | null = null): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    // The database clock can run a few ms ahead of this process; look slightly ahead.
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'announcement-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
/** Let time pass for a scheduled announcement: move it, and its outbox event, into the past. */
async function makeDue(announcementId: string) {
  await pool.query("UPDATE institution_announcements SET scheduled_for = now() - interval '1 second' WHERE id=$1", [announcementId]);
  await pool.query("UPDATE outbox_events SET available_at = now() - interval '1 second' WHERE aggregate_id=$1", [announcementId]);
}
async function announcementsFor(person: Person) {
  const feed = await api().get('/api/v1/me/notifications').set(auth(person.id)).expect(200);
  return (feed.body.notifications as { kind: string; title: string; body: string; data: Record<string, string> }[]).filter((note) => note.kind === 'ANNOUNCEMENT');
}
async function recipients(announcementId: string): Promise<string[]> {
  const rows = await pool.query('SELECT student_user_id FROM institution_announcement_recipients WHERE announcement_id=$1 ORDER BY student_user_id', [announcementId]);
  return rows.rows.map((row) => row.student_user_id as string);
}
const sorted = (values: string[]) => [...values].sort();
async function announcementCount(): Promise<number> {
  return Number((await pool.query('SELECT count(*)::int AS n FROM institution_announcements')).rows[0].n);
}

describe('who may address whom (decision 10.2 #8)', () => {
  it('delivers a faculty announcement to the students of the assigned section only, in their notifications', async () => {
    await assign(sectionX);
    const created = await announce(faculty, sectionX).expect(201);
    expect(created.body.announcement).toMatchObject({ state: 'SCHEDULED', audience: { kind: 'SECTION', unitId: sectionX, name: 'Section X' }, channels: ['IN_APP'], senderRole: 'FACULTY_LECTURER', sentByMe: true });
    await drain();
    expect(await recipients(created.body.announcement.id)).toEqual(sorted([studentX.id, invitedX.id]));
    const [note] = await announcementsFor(studentX);
    expect(note).toMatchObject({ title: 'Placement drive on Friday', body: 'Bring two copies of your resume to the seminar hall at 10:00.' });
    expect(note!.data).toMatchObject({ institutionName: 'Local College', from: 'your faculty', audience: 'Section X' });
    expect(await announcementsFor(studentY)).toEqual([]);
    expect(await announcementsFor(studentB)).toEqual([]);
    expect(await announcementsFor(formerX)).toEqual([]);
    const list = await api().get(base()).set(auth(faculty.id)).expect(200);
    expect(list.body.announcements[0]).toMatchObject({ state: 'SENT', delivery: { recipients: 2 } });
  });

  it('refuses a faculty member any audience outside their assignments, and writes nothing', async () => {
    await assign(sectionX);
    for (const audience of [sectionY, batchA1, departmentA, batchB1, null]) {
      await announce(faculty, audience).expect(403);
    }
    expect(await announcementCount()).toBe(0);
    const list = await api().get(base()).set(auth(faculty.id)).expect(200);
    expect(list.body.audiences).toEqual([{ unitId: sectionX, kind: 'SECTION', name: 'Section X' }]);
  });

  it('lets a faculty member address a whole assigned batch', async () => {
    await assign(batchA1);
    const created = await announce(faculty, batchA1).expect(201);
    await drain();
    expect(await recipients(created.body.announcement.id)).toEqual(sorted([studentX.id, studentY.id, invitedX.id]));
  });

  it('gives faculty with no assignment nobody to address, before and after the college starts assigning', async () => {
    await announce(faculty, sectionX).expect(403);
    await announce(faculty, departmentA).expect(403);
    await assign(sectionX);
    await announce(otherFaculty, sectionX).expect(403);
    const list = await api().get(base()).set(auth(otherFaculty.id)).expect(200);
    expect(list.body).toMatchObject({ audiences: [], canSend: false, announcements: [] });
    expect(await announcementCount()).toBe(0);
  });

  it('limits a department head to their department', async () => {
    const created = await announce(headA, departmentA).expect(201);
    await announce(headA, batchB1).expect(403);
    await announce(headA, departmentB).expect(403);
    await announce(headA, null).expect(403);
    await drain();
    expect(await recipients(created.body.announcement.id)).toEqual(sorted([studentX.id, studentY.id, invitedX.id]));
  });

  it('lets owners, admins and the placement office address the whole institution, current students only', async () => {
    for (const sender of [admin, tpo]) {
      const created = await announce(sender, null).expect(201);
      expect(created.body.announcement.audience).toEqual({ kind: 'INSTITUTION', unitId: null, name: null });
      await drain();
      expect(await recipients(created.body.announcement.id)).toEqual(sorted([studentX.id, studentY.id, studentB.id, invitedX.id]));
    }
    const froms = (await announcementsFor(studentB)).map((note) => note.data);
    expect(froms).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'your college', audience: 'Local College' }),
      expect.objectContaining({ from: 'your placement office', audience: 'Local College' }),
    ]));
  });

  it('narrows a scoped placement admin to their department', async () => {
    const scopedTpo = await staff('PLACEMENT_ADMIN', departmentB);
    await announce(scopedTpo, departmentA).expect(403);
    await announce(scopedTpo, null).expect(403);
    await announce(scopedTpo, batchB1).expect(201);
  });

  it('refuses units of another college, other colleges\' staff, and students', async () => {
    await announce(admin, foreignUnit).expect(400);
    await api().post(base()).set(auth(outsider.id)).send({ title: 'Hello', body: 'Hi', audienceUnitId: null }).expect(403);
    await api().get(base()).set(auth(outsider.id)).expect(403);
    await api().post(base()).set(auth(studentX.id)).send({ title: 'Hello', body: 'Hi', audienceUnitId: null }).expect(403);
    await api().get(base()).set(auth(studentX.id)).expect(403);
    await api().get(base()).expect(401);
    expect(await announcementCount()).toBe(0);
  });
});

describe('scheduling sends once; cancelling means never', () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it('holds a scheduled announcement until it is due, then sends it exactly once however often it is replayed', async () => {
    const created = await announce(headA, sectionX, { scheduledFor: inAnHour() }).expect(201);
    const id = created.body.announcement.id as string;
    await drain();
    expect((await pool.query('SELECT state FROM institution_announcements WHERE id=$1', [id])).rows[0].state).toBe('SCHEDULED');
    expect(await announcementsFor(studentX)).toEqual([]);
    await makeDue(id);
    const published = await drain();
    expect(published).toHaveLength(1);
    expect(await announcementsFor(studentX)).toHaveLength(1);
    // Replays through the same consumer, a second consumer instance, and a fresh event for the same announcement.
    const local = createLocalIntegrationEventPublisher({ pool, db });
    for (const event of published) await local.publisher.publish(event);
    // A second dispatch event for the same announcement (e.g. an operator re-queue) sends nothing more.
    await db.transaction((tx) => writeAnnouncementDispatchRequested(tx, { eventId: randomUUID(), announcementId: id, actorUserId: headA.id, institutionId, correlationId: randomUUID() }));
    expect(await drain()).toHaveLength(1);
    expect(await announcementsFor(studentX)).toHaveLength(1);
    expect(await recipients(id)).toEqual(sorted([studentX.id, invitedX.id]));
    const audit = await pool.query("SELECT action FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at", [id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['institution.announcement.created', 'institution.announcement.sent']);
  });

  it('never sends a cancelled announcement', async () => {
    const created = await announce(headA, sectionX, { scheduledFor: inAnHour() }).expect(201);
    const id = created.body.announcement.id as string;
    const cancelled = await api().post(base() + '/' + id + '/cancel').set(auth(headA.id)).send({ reasonCode: 'DRIVE_POSTPONED' }).expect(201);
    expect(cancelled.body.announcement).toMatchObject({ state: 'CANCELLED', cancelReasonCode: 'DRIVE_POSTPONED', delivery: null });
    await makeDue(id);
    const published = await drain();
    expect(published).toHaveLength(1);
    expect(await announcementsFor(studentX)).toEqual([]);
    expect(await recipients(id)).toEqual([]);
    await api().post(base() + '/' + id + '/cancel').set(auth(headA.id)).send({ reasonCode: 'DRIVE_POSTPONED' }).expect(409);
    const audit = await pool.query("SELECT context FROM audit_events WHERE resource_id=$1 AND action='institution.announcement.cancelled'", [id]);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'DRIVE_POSTPONED' });
  });

  it('lets only the sender or an owner/admin cancel, and never after sending', async () => {
    await assign(sectionX);
    const created = await announce(faculty, sectionX, { scheduledFor: inAnHour() }).expect(201);
    const id = created.body.announcement.id as string;
    await api().post(base() + '/' + id + '/cancel').set(auth(otherFaculty.id)).send({ reasonCode: 'MISTAKE' }).expect(403);
    await api().post(base() + '/' + id + '/cancel').set(auth(headA.id)).send({ reasonCode: 'MISTAKE' }).expect(403);
    await api().post(base() + '/' + id + '/cancel').set(auth(faculty.id)).send({ reasonCode: 'bad reason' }).expect(400);
    await api().post(base() + '/' + id + '/cancel').set(auth(admin.id)).send({ reasonCode: 'MISTAKE' }).expect(201);
    const sent = await announce(faculty, sectionX).expect(201);
    await drain();
    await api().post(base() + '/' + sent.body.announcement.id + '/cancel').set(auth(faculty.id)).send({ reasonCode: 'MISTAKE' }).expect(409);
  });

  it('does not send when the sender lost the assignment before the scheduled time', async () => {
    const assignment = await assign(sectionX);
    const created = await announce(faculty, sectionX, { scheduledFor: inAnHour() }).expect(201);
    const id = created.body.announcement.id as string;
    await api().post('/api/v1/institutions/' + institutionId + '/teaching-assignments/' + assignment + '/end').set(auth(admin.id)).send({ reasonCode: 'TERM_ENDED' }).expect(201);
    await makeDue(id);
    await drain();
    expect(await announcementsFor(studentX)).toEqual([]);
    expect((await pool.query('SELECT state, cancel_reason_code FROM institution_announcements WHERE id=$1', [id])).rows[0])
      .toEqual({ state: 'CANCELLED', cancel_reason_code: 'SENDER_ACCESS_ENDED' });
  });

  it('refuses a schedule in the past or more than 90 days ahead', async () => {
    await announce(headA, sectionX, { scheduledFor: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await announce(headA, sectionX, { scheduledFor: new Date(Date.now() + 91 * 86_400_000).toISOString() }).expect(400);
    await announce(headA, sectionX, { scheduledFor: 'tomorrow' }).expect(400);
    expect(await announcementCount()).toBe(0);
  });
});

describe('email: honest delivery, never blocking', () => {
  it('records email as not sent when no sender is configured (HG-7), while in-app delivery goes ahead', async () => {
    const created = await announce(headA, sectionX, { channels: ['IN_APP', 'EMAIL'] }).expect(201);
    await drain(null);
    expect(delivered).toEqual([]);
    expect(await announcementsFor(studentX)).toHaveLength(1);
    const list = await api().get(base()).set(auth(headA.id)).expect(200);
    expect(list.body.emailConfigured).toBe(false);
    expect(list.body.announcements.find((entry: { id: string }) => entry.id === created.body.announcement.id).delivery)
      .toEqual({ recipients: 2, email: { sent: 0, notConfigured: 1, failed: 0, bounced: 0, skipped: 1, pending: 0 } });
  });

  it('emails each activated recipient once through a configured sink, and skips those not yet activated', async () => {
    const created = await announce(headA, batchA1, { channels: ['IN_APP', 'EMAIL'] }).expect(201);
    const published = await drain(captureSink);
    expect(sorted(delivered.map((entry) => entry.toEmail))).toEqual(sorted([studentX.email, studentY.email]));
    expect(delivered[0]!.subject).toBe('Announcement from Local College: Placement drive on Friday');
    expect(delivered[0]!.textBody).toContain('Bring two copies of your resume');
    const local = createLocalIntegrationEventPublisher({ pool, db, invitationMailSink: captureSink });
    for (const event of published) await local.publisher.publish(event);
    expect(delivered).toHaveLength(2);
    const states = await pool.query('SELECT student_user_id, email_state FROM institution_announcement_recipients WHERE announcement_id=$1', [created.body.announcement.id]);
    expect(Object.fromEntries(states.rows.map((row) => [row.student_user_id, row.email_state]))).toEqual({ [studentX.id]: 'SENT', [studentY.id]: 'SENT', [invitedX.id]: 'SKIPPED' });
  });

  it('records a failed or bounced email without undoing the announcement', async () => {
    rejected.add(studentX.email); unavailable.add(studentY.email);
    const created = await announce(headA, batchA1, { channels: ['IN_APP', 'EMAIL'] }).expect(201);
    await drain(captureSink);
    expect(await announcementsFor(studentX)).toHaveLength(1);
    expect(await announcementsFor(studentY)).toHaveLength(1);
    const list = await api().get(base()).set(auth(headA.id)).expect(200);
    expect(list.body.announcements.find((entry: { id: string }) => entry.id === created.body.announcement.id))
      .toMatchObject({ state: 'SENT', delivery: { recipients: 3, email: { sent: 0, bounced: 1, failed: 1, skipped: 1 } } });
  });

  it('does not email a student who turned email off', async () => {
    await pool.query('INSERT INTO notification_preferences (user_id, email_enabled) VALUES ($1, false)', [studentX.id]);
    await announce(headA, sectionX, { channels: ['IN_APP', 'EMAIL'] }).expect(201);
    await drain(captureSink);
    expect(delivered).toEqual([]);
    expect(await announcementsFor(studentX)).toHaveLength(1);
  });
});

describe('input, listing and limits', () => {
  it('rejects unknown fields, missing text, oversize text, and any channel set without in-app or with SMS', async () => {
    await announce(headA, sectionX, { priority: 'HIGH' }).expect(400);
    await api().post(base()).set(auth(headA.id)).send({ title: ' ', body: 'x', audienceUnitId: sectionX }).expect(400);
    await api().post(base()).set(auth(headA.id)).send({ title: 'x', body: 'x' }).expect(400);
    await announce(headA, sectionX, { title: 'x'.repeat(161) }).expect(400);
    await announce(headA, sectionX, { body: 'x'.repeat(501) }).expect(400);
    await announce(headA, sectionX, { channels: ['EMAIL'] }).expect(400);
    await announce(headA, sectionX, { channels: ['IN_APP', 'SMS'] }).expect(400);
    await announce(headA, sectionX, { channels: [] }).expect(400);
    await announce(headA, 'not-a-uuid').expect(400);
    expect(await announcementCount()).toBe(0);
  });

  it('limits each sender to 20 announcements a day', async () => {
    for (let index = 0; index < 20; index += 1) await announce(headA, sectionX, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }).expect(201);
    const limited = await announce(headA, sectionX).expect(429);
    expect(limited.body.error.code).toBe('ANNOUNCEMENT_RATE_LIMITED');
    await announce(admin, sectionX).expect(201);
  });

  it('shows senders their own announcements and admins all of them, newest first, in pages', async () => {
    await assign(sectionX);
    await announce(faculty, sectionX).expect(201);
    await announce(headA, departmentA).expect(201);
    await announce(admin, null).expect(201);
    expect((await api().get(base()).set(auth(faculty.id)).expect(200)).body.announcements).toHaveLength(1);
    expect((await api().get(base()).set(auth(headA.id)).expect(200)).body.announcements).toHaveLength(1);
    const first = await api().get(base() + '?limit=2').set(auth(admin.id)).expect(200);
    expect(first.body.announcements).toHaveLength(2);
    expect(first.body.announcements[0].sentByMe).toBe(true);
    const second = await api().get(base() + '?limit=2&cursor=' + first.body.nextCursor).set(auth(admin.id)).expect(200);
    expect(second.body.announcements).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    await api().get(base() + '?limit=500').set(auth(admin.id)).expect(400);
    const adminView = (await api().get(base()).set(auth(admin.id)).expect(200)).body;
    expect(adminView.audiences[0]).toEqual({ unitId: null, kind: 'INSTITUTION', name: null });
    expect(adminView.audiences).toHaveLength(7);
  });

  it('keeps every existing notification kind alongside ANNOUNCEMENT', async () => {
    for (const kind of ['EXAM_ASSIGNED', 'EXAM_REOPENED', 'RESULT_PUBLISHED', 'SYSTEM', 'ANNOUNCEMENT']) {
      await pool.query("INSERT INTO user_notifications (id,user_id,kind,title,body) VALUES ($1,$2,$3,'t','b')", [randomUUID(), studentX.id, kind]);
    }
    await expect(pool.query("INSERT INTO user_notifications (id,user_id,kind,title,body) VALUES ($1,$2,'SMS','t','b')", [randomUUID(), studentX.id])).rejects.toThrow();
  });
});
