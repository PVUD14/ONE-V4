/**
 * Rostered students are invited and can activate (INST-01, defect I-1).
 *
 * A student added by an administrator, or committed through a roster import, used to be an
 * INVITED user nobody invited, so they could never sign in. These cases drive the real path:
 * the API writes the invitation and its outbox event, the ADR-028 local dispatcher delivers it
 * through a capturing mail sink, and the student accepts with a verified email. They also cover
 * reuse, expiry, email mismatch, replay idempotency for a 200-student import, the unconfigured
 * sender, resend and revocation, and that the Dashboard summary matches the list.
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
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for roster activation tests');
const schemaName = 'roster_activation_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
/** token (= external subject) -> verified email claim, if the identity carries one. */
const tokens = new Map<string, { readonly email?: string }>();
const delivered: { toEmail: string; textBody: string; invitationId: string }[] = [];
const rejected = new Set<string>();
const captureSink: InvitationMailSink = {
  async send(input) {
    if (rejected.has(input.toEmail)) throw new PermanentMailRejection();
    delivered.push({ toEmail: input.toEmail, textBody: input.textBody, invitationId: input.invitationId });
    return { providerReference: 'local-test:' + input.invitationId };
  },
};
let app: INestApplication;
let institutionId: string;
let departmentId: string;
let admin: { id: string; membershipId: string };

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
        const identity = tokens.get(token);
        if (!identity) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [],
          ...(identity.email ? { email: identity.email, emailVerified: true } : {}) };
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
  await pool.query('TRUNCATE users, outbox_events CASCADE');
  tokens.clear(); delivered.length = 0; rejected.clear();
  institutionId = randomUUID(); departmentId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution')", [institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Local department')", [departmentId, institutionId]);
  admin = await staff('INSTITUTION_ADMIN');
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function staff(role: string, org = institutionId) {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.set(id, {});
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2)`, [membershipId, org, id, role]);
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const base = () => '/api/v1/institutions/' + institutionId;
const auth = (token: string) => ({ Authorization: 'Bearer ' + token, 'X-Correlation-Id': randomUUID() });
const deliveredTo = (email: string) => delivered.filter((entry) => entry.toEmail === email);
const tokenFrom = (textBody: string) => new URL(textBody.match(/https?:\/\/\S+/)?.[0] ?? 'http://invalid').searchParams.get('token');

/** Run the deployed worker mode (ADR-028 local dispatcher) until the outbox is drained. */
async function drainOutbox(sink: InvitationMailSink | null = captureSink): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 50; round += 1) {
    // available_at is stamped by the database clock, which can run a few ms ahead of this
    // process; the real worker simply loops, a single drain looks slightly ahead instead.
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'roster-activation-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
async function addStudent(email: string, rollNumber: string, fullName = 'Rostered Student') {
  const created = await api().post(base() + '/students').set(auth(admin.id))
    .send({ institutionStudentId: rollNumber, fullName, email, departmentUnitId: departmentId }).expect(201);
  const row = (await pool.query('SELECT student_user_id FROM institution_student_profiles WHERE id=$1', [created.body.student.id])).rows[0];
  return { profileId: created.body.student.id as string, userId: row.student_user_id as string };
}
function accept(subject: string, email: string, rawToken: string | null, key = 'accept-' + subject) {
  tokens.set(subject, { email });
  return api().post('/api/v1/invitations/accept').set(auth(subject)).set('Idempotency-Key', key).send({ token: rawToken });
}
async function roster() {
  return (await api().get(base() + '/students').set(auth(admin.id)).expect(200)).body as {
    students: { studentUserId: string; activation: { state: string; deliveryState: string | null } | null }[];
    activationSummary: Record<string, number>;
  };
}
async function expectLinkedAndActive(email: string, subject: string, rosterUserId: string, fullName: string) {
  const users = (await pool.query('SELECT id, external_subject, state FROM users WHERE lower(email)=lower($1)', [email])).rows;
  expect(users).toEqual([{ id: rosterUserId, external_subject: subject, state: 'ACTIVE' }]);
  const me = await api().get('/api/v1/students/me').set(auth(subject));
  expect(me.status).toBe(200);
  expect(me.body.student).toMatchObject({ userId: rosterUserId, fullName });
  const profile = (await pool.query('SELECT status FROM institution_student_profiles WHERE student_user_id=$1', [rosterUserId])).rows[0];
  expect(profile.status).toBe('ACTIVE');
  const relationship = (await pool.query('SELECT state FROM institution_relationships WHERE student_user_id=$1', [rosterUserId])).rows;
  expect(relationship).toEqual([{ state: 'ACTIVE' }]);
  const staffView = await api().get(base() + '/staff-actions').set(auth(admin.id)).expect(200);
  expect(staffView.body.students.map((student: { id: string }) => student.id)).toContain(rosterUserId);
}

describe('issuing and accepting a student invitation', () => {
  it('invites a student added by the administrator, who activates into the rostered record', async () => {
    const email = 'rostered.student@example.test';
    const student = await addStudent(email, 'I1-001');
    expect(delivered).toHaveLength(0); // nothing is sent inside the request
    await drainOutbox();
    expect(deliveredTo(email)).toHaveLength(1);
    expect(deliveredTo(email)[0]!.textBody).toContain('Local institution');
    await accept('sub:rostered-student', email, tokenFrom(deliveredTo(email)[0]!.textBody)).expect(201);
    await expectLinkedAndActive(email, 'sub:rostered-student', student.userId, 'Rostered Student');
    const list = await roster();
    expect(list.students.find((entry) => entry.studentUserId === student.userId)?.activation?.state).toBe('ACTIVATED');
  });

  it('invites a student committed through a roster import, who activates the same way', async () => {
    const email = 'imported.student@example.test';
    const csv = ['institution_student_id,full_name,email,department,program,batch,section',
      'I1-IMP-001,Imported Student,' + email + ',Local department,,,'].join('\n');
    const preview = await api().post(base() + '/student-imports').set(auth(admin.id)).send({ filename: 'roster.csv', csv }).expect(201);
    await api().post(base() + '/student-imports/' + preview.body.import.id + '/commit').set(auth(admin.id)).expect(201);
    const rosterUserId = (await pool.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email])).rows[0].id as string;
    await drainOutbox();
    expect(deliveredTo(email)).toHaveLength(1);
    await accept('sub:imported-student', email, tokenFrom(deliveredTo(email)[0]!.textBody)).expect(201);
    await expectLinkedAndActive(email, 'sub:imported-student', rosterUserId, 'Imported Student');
  });

  it('never binds an identity to a roster row on a matching email alone', async () => {
    const email = 'unclaimed.student@example.test';
    await addStudent(email, 'I1-002', 'Unclaimed Student');
    tokens.set('sub:someone-with-that-email', { email });
    expect((await api().get('/api/v1/students/me').set(auth('sub:someone-with-that-email'))).status).toBe(403);
    const user = (await pool.query('SELECT external_subject, state FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
    expect(user).toEqual({ external_subject: null, state: 'INVITED' });
  });
});

describe('tokens that must fail safely', () => {
  it('refuses a reused token', async () => {
    const email = 'reuse.student@example.test';
    await addStudent(email, 'I1-003');
    await drainOutbox();
    const raw = tokenFrom(deliveredTo(email)[0]!.textBody);
    await accept('sub:first', email, raw).expect(201);
    const again = await accept('sub:second', email, raw);
    expect(again.status).toBe(403);
    expect(again.body.error?.code).toBe('FORBIDDEN');
    const sameIdentity = await accept('sub:first', email, raw, 'accept-again');
    expect(sameIdentity.status).toBe(403);
  });

  it('refuses an expired token and says nothing about why', async () => {
    const email = 'expired.student@example.test';
    const student = await addStudent(email, 'I1-004');
    await drainOutbox();
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE student_user_id=$1", [student.userId]);
    const expired = await accept('sub:late', email, tokenFrom(deliveredTo(email)[0]!.textBody));
    expect(expired.status).toBe(403);
    expect(JSON.stringify(expired.body)).not.toMatch(/expire|invitation|email/i);
    expect((await roster()).students.find((entry) => entry.studentUserId === student.userId)?.activation?.state).toBe('EXPIRED');
  });

  it('refuses a token presented by an identity with a different verified email, without revealing the roster', async () => {
    const email = 'mismatch.student@example.test';
    await addStudent(email, 'I1-005');
    await drainOutbox();
    const mismatch = await accept('sub:other-person', 'other.person@example.test', tokenFrom(deliveredTo(email)[0]!.textBody));
    expect(mismatch.status).toBe(403);
    expect(JSON.stringify(mismatch.body)).not.toContain(email);
    const user = (await pool.query('SELECT external_subject, state FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
    expect(user).toEqual({ external_subject: null, state: 'INVITED' });
  });
});

describe('bulk import delivery', () => {
  it('queues 200 emails for a 200-student import exactly once, even when every event is replayed', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => `BULK-${index},Bulk Student ${index},bulk.${index}@example.test,Local department,,,`);
    const csv = ['institution_student_id,full_name,email,department,program,batch,section', ...rows].join('\n');
    const preview = await api().post(base() + '/student-imports').set(auth(admin.id)).send({ filename: 'bulk.csv', csv }).expect(201);
    expect(preview.body.import.acceptedCount).toBe(200);
    await api().post(base() + '/student-imports/' + preview.body.import.id + '/commit').set(auth(admin.id)).expect(201);
    const published = await drainOutbox();
    expect(delivered).toHaveLength(200);
    expect(new Set(delivered.map((entry) => entry.toEmail)).size).toBe(200);
    const local = createLocalIntegrationEventPublisher({ pool, db, invitationMailSink: captureSink });
    for (const event of published) await local.publisher.publish(event);
    expect(delivered).toHaveLength(200);
    expect((await roster()).activationSummary).toMatchObject({ INVITED: 200, ACTIVATED: 0 });
  });
});

describe('delivery state, resend and revocation', () => {
  it('records an unconfigured sender instead of dropping the invitation, and resends once one exists', async () => {
    const email = 'unsent.student@example.test';
    const student = await addStudent(email, 'I1-006');
    await drainOutbox(null);
    expect(delivered).toHaveLength(0);
    expect((await roster()).students.find((entry) => entry.studentUserId === student.userId)?.activation)
      .toMatchObject({ state: 'INVITED', deliveryState: 'NOT_CONFIGURED' });
    await api().post(base() + '/student-invitations/resend').set(auth(admin.id))
      .send({ studentUserIds: [student.userId], reasonCode: 'NOT_RECEIVED' }).expect(201);
    await drainOutbox();
    expect(deliveredTo(email)).toHaveLength(1);
    await accept('sub:unsent', email, tokenFrom(deliveredTo(email)[0]!.textBody)).expect(201);
  });

  it('marks a permanent rejection as bounced, and a resend after correcting it invalidates the old link', async () => {
    const email = 'bounce.student@example.test';
    const student = await addStudent(email, 'I1-007');
    rejected.add(email);
    await drainOutbox();
    expect((await roster()).students.find((entry) => entry.studentUserId === student.userId)?.activation?.state).toBe('BOUNCED');
    rejected.clear();
    await api().post(base() + '/student-invitations/resend').set(auth(admin.id)).send({ all: true, reasonCode: 'EMAIL_CORRECTED' }).expect(201);
    await drainOutbox();
    expect(deliveredTo(email)).toHaveLength(1);
    await accept('sub:bounced', email, tokenFrom(deliveredTo(email)[0]!.textBody)).expect(201);
  });

  it('mints a new token on resend, so the earlier link stops working', async () => {
    const email = 'rotate.student@example.test';
    const student = await addStudent(email, 'I1-008');
    await drainOutbox();
    const first = tokenFrom(deliveredTo(email)[0]!.textBody);
    await api().post(base() + '/student-invitations/resend').set(auth(admin.id))
      .send({ studentUserIds: [student.userId], reasonCode: 'LINK_EXPIRED' }).expect(201);
    await drainOutbox();
    expect(deliveredTo(email)).toHaveLength(2);
    expect((await accept('sub:old-link', email, first)).status).toBe(403);
    await accept('sub:new-link', email, tokenFrom(deliveredTo(email)[1]!.textBody)).expect(201);
  });

  it('requires a reason code and an admin to resend, and skips students already activated', async () => {
    const email = 'reason.student@example.test';
    const student = await addStudent(email, 'I1-009');
    await drainOutbox();
    await api().post(base() + '/student-invitations/resend').set(auth(admin.id)).send({ studentUserIds: [student.userId] }).expect(400);
    await api().post(base() + '/student-invitations/resend').set(auth(admin.id)).send({ studentUserIds: [student.userId], reasonCode: 'bad code' }).expect(400);
    const faculty = await staff('FACULTY_LECTURER');
    await api().post(base() + '/student-invitations/resend').set(auth(faculty.id)).send({ all: true, reasonCode: 'NOT_RECEIVED' }).expect(403);
    await api().post(base() + '/student-invitations/resend').send({ all: true, reasonCode: 'NOT_RECEIVED' }).expect(401);
    await accept('sub:reason', email, tokenFrom(deliveredTo(email)[0]!.textBody)).expect(201);
    const skipped = await api().post(base() + '/student-invitations/resend').set(auth(admin.id))
      .send({ studentUserIds: [student.userId], reasonCode: 'STUDENT_REQUESTED' }).expect(201);
    expect(skipped.body.resend).toEqual({ queued: 0, skipped: 1 });
    const audit = (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'identity.student_invitation.%'")).rows[0].n;
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('revokes the pending invitation when the student relationship ends', async () => {
    const email = 'ended.student@example.test';
    const student = await addStudent(email, 'I1-010');
    await drainOutbox();
    await api().post(base() + '/students/' + student.profileId + '/relationship').set(auth(admin.id)).send({ state: 'ENDED' }).expect(201);
    expect((await accept('sub:ended', email, tokenFrom(deliveredTo(email)[0]!.textBody))).status).toBe(403);
  });
});

describe('activation counts', () => {
  it('reports a Dashboard summary that matches the Students list', async () => {
    const activated = 'count.activated@example.test';
    await addStudent(activated, 'C-1');
    await addStudent('count.invited@example.test', 'C-2');
    const expiring = await addStudent('count.expired@example.test', 'C-3');
    await drainOutbox();
    await accept('sub:count', activated, tokenFrom(deliveredTo(activated)[0]!.textBody)).expect(201);
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE student_user_id=$1", [expiring.userId]);
    const list = await roster();
    const counted: Record<string, number> = {};
    for (const student of list.students) {
      const state = student.activation?.state ?? 'NOT_INVITED';
      counted[state] = (counted[state] ?? 0) + 1;
    }
    expect(list.activationSummary).toEqual({ ACTIVATED: 1, INVITED: 1, EXPIRED: 1, BOUNCED: 0, NOT_INVITED: 0 });
    expect(counted).toEqual({ ACTIVATED: 1, INVITED: 1, EXPIRED: 1 });
  });
});
