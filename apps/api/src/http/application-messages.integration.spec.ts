/**
 * Application-bound messages (EMP-10).
 *
 * Pins the goal's acceptance — no message can be sent without a live grant, and a reported message
 * opens a trust case with the thread as evidence — plus the rules around them: an employer starts a
 * conversation only from SHORTLISTED, only the student and that employer's team read or write, the
 * employer loses the thread on the next request once the grant ends, text only with links flagged,
 * rate limits, unknown fields refused, audit on every write, notices only through the EMP-08 outbox
 * consumer (email NOT_CONFIGURED without a sink, never the message text), the student's export and
 * deletion, the 180-day retention sweep, and no report, mute or readiness field reaching an employer.
 *
 * Runs over real HTTP with a stub verifier in a throwaway schema of the local Postgres in DATABASE_URL.
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
import type { InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { eraseExpiredApplicationMessages } from '@planthepath/persistence/src/application-messages.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { TrustSafetyController } from './trust-safety.controller.js';
import { PG_POOL } from '../persistence.provider.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for application message tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Application message tests require local Postgres');
const schemaName = 'application_messages_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;

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
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [TrustSafetyController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
}, 120_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

const delivered: { toEmail: string; subject: string; textBody: string }[] = [];
const captureSink: InvitationMailSink = {
  async send(input) { delivered.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody }); return {}; },
};
beforeEach(() => { delivered.length = 0; });

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function membership(userId: string, orgId: string, role: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2)`, [id, orgId, userId, role]);
  return id;
}
async function employer() {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Acme Robotics','VERIFIED',true)", [employerId]);
  const recruiterId = await user();
  const membershipId = await membership(recruiterId, employerId, 'RECRUITER');
  const ownerId = await user();
  await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  return { employerId, recruiterId, membershipId, ownerId };
}
async function operator(): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id)
    VALUES ($1,$2,$3,'OPERATIONS_ADMIN','ACTIVE',$2)`, [randomUUID(), platformId, id]);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'emp10-' + randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const employerThread = (employerId: string, applicationId: string) => base(employerId) + '/applications/' + applicationId + '/messages';
const studentThread = (applicationId: string) => '/api/v1/students/me/applications/' + applicationId + '/messages';
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"|"band"/i);

async function publishedJob(employerId: string, recruiterId: string): Promise<string> {
  const created = await api().post(base(employerId) + '/opportunities').set(auth(recruiterId)).send({
    referenceCode: 'MSG-' + randomUUID().slice(0, 8), title: 'Robotics engineer', summary: 'Build robots.', employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: 'Pune', compensationDisclosed: false,
  }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
async function applied(options: { shortlist?: boolean } = { shortlist: true }) {
  const hiring = await employer();
  const opportunityId = await publishedJob(hiring.employerId, hiring.recruiterId);
  const studentId = await user();
  const response = await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true }).expect(201);
  const applicationId = response.body.application.id as string;
  if (options.shortlist !== false) {
    await api().post(base(hiring.employerId) + '/applications/' + applicationId + '/transition').set(auth(hiring.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
  }
  return { ...hiring, opportunityId, studentId, applicationId };
}
type Hiring = Awaited<ReturnType<typeof applied>>;
const employerSend = (p: Hiring, body: unknown, actor = p.recruiterId) => api().post(employerThread(p.employerId, p.applicationId)).set(auth(actor)).send(body as object);
const studentSend = (p: Hiring, body: unknown) => api().post(studentThread(p.applicationId)).set(auth(p.studentId)).send(body as object);
const messageCount = async (applicationId: string) => Number((await pool.query(
  'SELECT count(*)::int AS n FROM application_messages m JOIN application_message_threads t ON t.id = m.thread_id WHERE t.application_id = $1', [applicationId])).rows[0].n);

async function drain(sink: InvitationMailSink | null = null): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'emp10-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
async function feed(userId: string): Promise<{ kind: string; title: string; body: string; data: Record<string, unknown> }[]> {
  return (await api().get('/api/v1/me/notifications').set(auth(userId)).expect(200)).body.notifications;
}

describe('EMP-10: a conversation bound to one application', () => {
  it('lets the team start it from SHORTLISTED onward, the student reply, and both read it with read state', async () => {
    const early = await applied({ shortlist: false });
    expect((await employerSend(early, { body: 'Hello' }).expect(400)).body.error.code).toBe('MESSAGING_NOT_AVAILABLE');
    // The student cannot open a conversation either.
    expect((await studentSend(early, { body: 'Hello?' }).expect(400)).body.error.code).toBe('MESSAGING_NOT_AVAILABLE');
    expect(await messageCount(early.applicationId)).toBe(0);

    const p = await applied();
    const sent = await employerSend(p, { body: '  Can you join a call on Friday at 10.30?  ' }).expect(201);
    expect(sent.body.message).toMatchObject({ from: 'EMPLOYER', mine: true, body: 'Can you join a call on Friday at 10.30?', containsLink: false, readAt: null });

    const list = await api().get('/api/v1/students/me/applications').set(auth(p.studentId)).expect(200);
    expect(list.body.applications.find((item: { id: string }) => item.id === p.applicationId)).toMatchObject({ conversationStarted: true, unreadMessages: 1 });

    const seen = await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    expect(seen.body.conversation).toMatchObject({ employerName: 'Acme Robotics', title: 'Robotics engineer', started: true, muted: false, canReply: true, replyBlockedReason: null });
    expect(seen.body.conversation.messages).toEqual([expect.objectContaining({ from: 'EMPLOYER', mine: false, body: 'Can you join a call on Friday at 10.30?', reportedAt: null })]);
    // The student never learns which recruiter wrote.
    expect(JSON.stringify(seen.body)).not.toContain(p.recruiterId);
    const after = await api().get('/api/v1/students/me/applications').set(auth(p.studentId)).expect(200);
    expect(after.body.applications.find((item: { id: string }) => item.id === p.applicationId).unreadMessages).toBe(0);

    await studentSend(p, { body: 'Yes, Friday works.' }).expect(201);
    // A colleague on the same employer reads and writes the same conversation.
    const colleague = await user();
    await membership(colleague, p.employerId, 'RECRUITER');
    const employerView = await api().get(employerThread(p.employerId, p.applicationId)).set(auth(colleague)).expect(200);
    expect(employerView.body.conversation).toMatchObject({ applicationState: 'SHORTLISTED', started: true, canSend: true, sendBlockedReason: null });
    expect(employerView.body.conversation.messages.map((m: { from: string; mine: boolean }) => [m.from, m.mine])).toEqual([['EMPLOYER', false], ['STUDENT', false]]);
    expect(employerView.body.conversation.messages[0].readAt).not.toBeNull();
    expect(JSON.stringify(employerView.body)).not.toMatch(/muted|reported|trustCase|studentUserId|@example\.test/i);
    noReadiness(employerView.body);
    await employerSend(p, { body: 'Great, see you then.' }, colleague).expect(201);

    // Every write and every employer view is audited with the organisation.
    const audits = await pool.query("SELECT action, organization_id FROM audit_events WHERE resource_id = $1 AND action LIKE 'application.message%' ORDER BY occurred_at", [p.applicationId]);
    expect(audits.rows.filter((row) => row.action === 'application.message.sent')).toHaveLength(3);
    expect(audits.rows.some((row) => row.action === 'application.messages.viewed')).toBe(true);
    expect(audits.rows.every((row) => row.organization_id === p.employerId)).toBe(true);
  });

  it('keeps each conversation to its own student and its own employer', async () => {
    const p = await applied();
    await employerSend(p, { body: 'Hello' }).expect(201);
    await api().get(employerThread(p.employerId, p.applicationId)).expect(401);
    await api().post(studentThread(p.applicationId)).send({ body: 'x' }).expect(401);
    const rival = await employer();
    await api().get(employerThread(p.employerId, p.applicationId)).set(auth(rival.recruiterId)).expect(403);
    await api().get(employerThread(rival.employerId, p.applicationId)).set(auth(rival.recruiterId)).expect(403);
    await api().post(employerThread(rival.employerId, p.applicationId)).set(auth(rival.recruiterId)).send({ body: 'Hi' }).expect(403);
    const stranger = await user();
    await api().get(studentThread(p.applicationId)).set(auth(stranger)).expect(403);
    await api().post(studentThread(p.applicationId)).set(auth(stranger)).send({ body: 'Hi' }).expect(403);
    // The student cannot use the employer route, and a malformed id is refused.
    await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.studentId)).expect(403);
    await api().get(employerThread(p.employerId, 'not-a-uuid')).set(auth(p.recruiterId)).expect(403);

    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED', active = false WHERE id = $1", [p.employerId]);
    expect((await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    expect((await employerSend(p, { body: 'Still there?' }).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    // A suspended employer cannot be written to either: nobody there may read it.
    expect((await studentSend(p, { body: 'Hello?' }).expect(400)).body.error.code).toBe('MESSAGING_NOT_AVAILABLE');
    await pool.query("UPDATE organizations SET verification_state = 'PENDING', active = true WHERE id = $1", [p.employerId]);
    expect((await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    await pool.query("UPDATE organizations SET verification_state = 'VERIFIED', active = true WHERE id = $1", [p.employerId]);
    await pool.query("UPDATE organization_memberships SET state = 'ENDED' WHERE id = $1", [p.membershipId]);
    await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(403);
    await employerSend(p, { body: 'I left' }).expect(403);
    expect(await messageCount(p.applicationId)).toBe(1);
  });
});

describe('EMP-10 acceptance: no message can be sent without a live grant', () => {
  it('stops the employer on the next request after a withdrawal, and leaves the student a read-only copy', async () => {
    const p = await applied();
    await employerSend(p, { body: 'Please confirm your notice period.' }).expect(201);
    await studentSend(p, { body: 'Thirty days.' }).expect(201);
    await api().post('/api/v1/students/me/applications/' + p.applicationId + '/withdraw').set(auth(p.studentId)).send({}).expect(201);

    await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(403);
    await employerSend(p, { body: 'Are you sure?' }).expect(403);
    expect((await studentSend(p, { body: 'One more thing' }).expect(400)).body.error.code).toBe('MESSAGING_NOT_AVAILABLE');
    const inbox = await api().get(base(p.employerId) + '/message-threads').set(auth(p.recruiterId)).expect(200);
    expect(inbox.body.threads).toEqual([]);
    expect(inbox.body.withheldCount).toBe(1);

    const own = await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    expect(own.body.conversation).toMatchObject({ canReply: false, replyBlockedReason: 'ACCESS_ENDED' });
    expect(own.body.conversation.messages).toHaveLength(2);
    expect(await messageCount(p.applicationId)).toBe(2);
  });

  it('refuses both sides when the grant is revoked, expired, or the student asks to be deleted', async () => {
    const revoked = await applied();
    await employerSend(revoked, { body: 'Hello' }).expect(201);
    await pool.query('UPDATE employer_applicant_access_grants SET revoked_at = now() WHERE student_user_id = $1', [revoked.studentId]);
    await employerSend(revoked, { body: 'Hello again' }).expect(403);
    await studentSend(revoked, { body: 'Hi' }).expect(400);

    const expired = await applied();
    await employerSend(expired, { body: 'Hello' }).expect(201);
    await pool.query("UPDATE employer_applicant_access_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE student_user_id = $1", [expired.studentId]);
    await api().get(employerThread(expired.employerId, expired.applicationId)).set(auth(expired.recruiterId)).expect(403);
    await employerSend(expired, { body: 'Hello again' }).expect(403);
    await studentSend(expired, { body: 'Hi' }).expect(400);

    const deleting = await applied();
    await employerSend(deleting, { body: 'Hello' }).expect(201);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'emp10-test')`, [randomUUID(), deleting.studentId]);
    await api().get(employerThread(deleting.employerId, deleting.applicationId)).set(auth(deleting.recruiterId)).expect(403);
    await employerSend(deleting, { body: 'Hello again' }).expect(403);

    // Rejection closes the application and revokes the grant too.
    const rejected = await applied();
    await employerSend(rejected, { body: 'Hello' }).expect(201);
    await api().post(base(rejected.employerId) + '/applications/' + rejected.applicationId + '/transition').set(auth(rejected.recruiterId)).send({ toState: 'REJECTED', reasonCode: 'NOT_A_FIT' }).expect(201);
    await employerSend(rejected, { body: 'Sorry' }).expect(403);

    for (const p of [revoked, expired, deleting, rejected]) expect(await messageCount(p.applicationId)).toBe(1);
  });
});

describe('EMP-10: text only, links flagged, limits, and unknown fields refused', () => {
  it('refuses unknown fields, empty or overlong text and attachments, and writes nothing', async () => {
    const p = await applied();
    expect((await employerSend(p, { body: 'Hi', attachment: 'cv.pdf' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await employerSend(p, { body: '' }).expect(400)).body.error.code).toBe('INVALID_BODY');
    expect((await employerSend(p, { body: 'x'.repeat(2001) }).expect(400)).body.error.code).toBe('INVALID_BODY');
    expect((await employerSend(p, { text: 'Hi' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await employerSend(p, ['Hi']).expect(400)).body.error.code).toBe('INVALID_REQUEST');
    expect(await messageCount(p.applicationId)).toBe(0);
    await employerSend(p, { body: 'x'.repeat(2000) }).expect(201);
    expect((await studentSend(p, { body: 'Hi', senderSide: 'EMPLOYER' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await api().get(employerThread(p.employerId, p.applicationId) + '?limit=0').set(auth(p.recruiterId)).expect(400)).body.error.code).toBe('INVALID_LIMIT');
    expect((await api().get(employerThread(p.employerId, p.applicationId) + '?limit=201').set(auth(p.recruiterId)).expect(400)).body.error.code).toBe('INVALID_LIMIT');
    expect((await api().get(employerThread(p.employerId, p.applicationId) + '?before=nonsense').set(auth(p.recruiterId)).expect(400)).body.error.code).toBe('INVALID_CURSOR');
    expect((await api().post(studentThread(p.applicationId) + '/mute').set(auth(p.studentId)).send({ muted: 'yes' }).expect(400)).body.error.code).toBe('INVALID_MUTED');
  });

  it('flags a message that carries a link, for both sides to see', async () => {
    const p = await applied();
    const sent = await employerSend(p, { body: 'Pay the registration fee at pay-now.in to confirm.' }).expect(201);
    expect(sent.body.message.containsLink).toBe(true);
    const seen = await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    expect(seen.body.conversation.messages[0].containsLink).toBe(true);
    const stored = await pool.query('SELECT contains_link FROM application_messages WHERE id = $1', [sent.body.message.id]);
    expect(stored.rows[0].contains_link).toBe(true);
  });

  it('stops an employer after three unanswered messages and a student after ten in an hour in one conversation', async () => {
    const p = await applied();
    for (let i = 0; i < 3; i += 1) await employerSend(p, { body: 'Nudge ' + i }).expect(201);
    expect((await employerSend(p, { body: 'Nudge 4' }).expect(429)).body.error.code).toBe('MESSAGE_AWAITING_REPLY');
    await studentSend(p, { body: 'Reply 1' }).expect(201);
    await employerSend(p, { body: 'Thanks' }).expect(201);
    for (let i = 2; i <= 10; i += 1) await studentSend(p, { body: 'Reply ' + i }).expect(201);
    expect((await studentSend(p, { body: 'Reply 11' }).expect(429)).body.error.code).toBe('MESSAGE_RATE_LIMITED');
    expect(await messageCount(p.applicationId)).toBe(14);
  });

  it('pages the conversation and the inbox with bounded, keyset cursors', async () => {
    const p = await applied();
    await employerSend(p, { body: 'One' }).expect(201);
    await studentSend(p, { body: 'Two' }).expect(201);
    await employerSend(p, { body: 'Three' }).expect(201);
    const latest = await api().get(employerThread(p.employerId, p.applicationId) + '?limit=2').set(auth(p.recruiterId)).expect(200);
    expect(latest.body.conversation.messages.map((m: { body: string }) => m.body)).toEqual(['Two', 'Three']);
    expect(latest.body.conversation.hasEarlier).toBe(true);

    // A second conversation on the same employer, newer than the first.
    const other = await publishedJob(p.employerId, p.recruiterId);
    const student = await user();
    const response = await api().post('/api/v1/students/me/applications').set(auth(student)).send({ opportunityId: other, consentGranted: true }).expect(201);
    const otherApplication = response.body.application.id as string;
    await api().post(base(p.employerId) + '/applications/' + otherApplication + '/transition').set(auth(p.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
    await api().post(employerThread(p.employerId, otherApplication)).set(auth(p.recruiterId)).send({ body: 'Hello' }).expect(201);

    const page1 = await api().get(base(p.employerId) + '/message-threads?limit=1').set(auth(p.recruiterId)).expect(200);
    expect(page1.body.threads).toHaveLength(1);
    expect(page1.body.threads[0]).toMatchObject({ applicationId: otherApplication, title: 'Robotics engineer', unreadCount: 0, lastFrom: 'EMPLOYER' });
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await api().get(base(p.employerId) + '/message-threads?limit=1&cursor=' + page1.body.nextCursor).set(auth(p.recruiterId)).expect(200);
    expect(page2.body.threads.map((t: { applicationId: string }) => t.applicationId)).toEqual([p.applicationId]);
    expect(page2.body.threads[0]).toMatchObject({ messageCount: 3 });
    expect(page2.body.nextCursor).toBeNull();
    await api().get(base(p.employerId) + '/message-threads?limit=500').set(auth(p.recruiterId)).expect(400);
    noReadiness(page1.body);
  });
});

describe('EMP-10 acceptance: a reported message opens a trust case with the thread as evidence', () => {
  it('opens one case per conversation, keeps adding to it, and tells the employer nothing', async () => {
    const p = await applied();
    const first = (await employerSend(p, { body: 'Send Rs 5000 as a security deposit to proceed.' }).expect(201)).body.message.id as string;
    await studentSend(p, { body: 'Why?' }).expect(201);
    const second = (await employerSend(p, { body: 'Or message me on my personal number.' }).expect(201)).body.message.id as string;
    const own = (await studentSend(p, { body: 'No thanks.' }).expect(201)).body.message.id as string;

    const reported = await api().post(studentThread(p.applicationId) + '/' + first + '/report').set(auth(p.studentId))
      .send({ reasonCode: 'SCAM_OR_PAYMENT_REQUEST', statement: 'They asked me for a deposit.' }).expect(201);
    expect(reported.body.report).toMatchObject({ messageId: first, reportedAt: expect.any(String) });
    expect(JSON.stringify(reported.body)).not.toMatch(/case/i);

    const cases = await pool.query('SELECT id, case_type, subject_kind, subject_organization_id, organization_id, reported_by_user_id, state, severity FROM trust_cases WHERE reported_by_user_id = $1', [p.studentId]);
    expect(cases.rows).toHaveLength(1);
    expect(cases.rows[0]).toMatchObject({ case_type: 'EMPLOYER_ACCOUNTABILITY', subject_kind: 'ORGANIZATION', subject_organization_id: p.employerId,
      organization_id: p.employerId, state: 'REPORTED', severity: 'HIGH' });
    const caseId = cases.rows[0].id as string;
    const thread = (await pool.query('SELECT id FROM application_message_threads WHERE application_id = $1', [p.applicationId])).rows[0].id as string;
    const evidence = async () => (await pool.query('SELECT evidence_kind, reference_id, statement FROM trust_case_evidence WHERE case_id = $1 ORDER BY added_at, evidence_kind', [caseId])).rows;
    expect(await evidence()).toEqual(expect.arrayContaining([
      { evidence_kind: 'APPLICATION_MESSAGE_THREAD', reference_id: thread, statement: null },
      { evidence_kind: 'APPLICATION_MESSAGE', reference_id: first, statement: null },
      { evidence_kind: 'REPORTER_STATEMENT', reference_id: 'message:' + first, statement: 'They asked me for a deposit.' },
    ]));
    // A report is not a penalty: nothing was actioned and the employer is untouched.
    expect((await pool.query('SELECT count(*)::int AS n FROM trust_case_actions WHERE case_id = $1', [caseId])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT verification_state, active FROM organizations WHERE id = $1', [p.employerId])).rows[0]).toEqual({ verification_state: 'VERIFIED', active: true });

    // A second report joins the open case.
    await api().post(studentThread(p.applicationId) + '/' + second + '/report').set(auth(p.studentId)).send({ reasonCode: 'OFF_PLATFORM_PRESSURE' }).expect(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM trust_cases WHERE reported_by_user_id = $1', [p.studentId])).rows[0].n).toBe(1);
    expect((await evidence()).filter((row) => row.evidence_kind === 'APPLICATION_MESSAGE').map((row) => row.reference_id).sort()).toEqual([first, second].sort());
    expect((await evidence()).filter((row) => row.evidence_kind === 'APPLICATION_MESSAGE_THREAD')).toHaveLength(1);

    // Once per message; never the student's own; unknown fields and reasons refused.
    expect((await api().post(studentThread(p.applicationId) + '/' + first + '/report').set(auth(p.studentId)).send({ reasonCode: 'HARASSMENT' }).expect(400)).body.error.code).toBe('MESSAGE_ALREADY_REPORTED');
    expect((await api().post(studentThread(p.applicationId) + '/' + own + '/report').set(auth(p.studentId)).send({ reasonCode: 'HARASSMENT' }).expect(400)).body.error.code).toBe('MESSAGE_NOT_REPORTABLE');
    expect((await api().post(studentThread(p.applicationId) + '/' + second + '/report').set(auth(p.studentId)).send({ reasonCode: 'SPAM' }).expect(400)).body.error.code).toBe('INVALID_REASONCODE');
    expect((await api().post(studentThread(p.applicationId) + '/' + second + '/report').set(auth(p.studentId)).send({ reasonCode: 'OTHER', evidence: 'x' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    const stranger = await user();
    await api().post(studentThread(p.applicationId) + '/' + second + '/report').set(auth(stranger)).send({ reasonCode: 'OTHER' }).expect(403);

    // The student sees what they reported; the employer sees no trace of it.
    const studentView = await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    expect(studentView.body.conversation.messages.filter((m: { reportedAt: string | null }) => m.reportedAt).map((m: { id: string }) => m.id).sort()).toEqual([first, second].sort());
    const employerView = await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(200);
    expect(JSON.stringify(employerView.body)).not.toMatch(/report|trust|case/i);
    const inbox = await api().get(base(p.employerId) + '/message-threads').set(auth(p.recruiterId)).expect(200);
    expect(JSON.stringify(inbox.body)).not.toMatch(/report|trust|case|muted/i);

    // Operations read the reported conversation through the case, audited; nobody else can.
    const ops = await operator();
    const read = await api().get('/api/v1/operations/trust-safety/cases/' + caseId + '/message-threads').set(auth(ops)).expect(200);
    expect(read.body.threads).toHaveLength(1);
    expect(read.body.threads[0]).toMatchObject({ employerName: 'Acme Robotics', opportunityTitle: 'Robotics engineer' });
    expect(read.body.threads[0].messages.map((m: { from: string; body: string; reported: boolean }) => [m.from, m.body, m.reported])).toEqual([
      ['EMPLOYER', 'Send Rs 5000 as a security deposit to proceed.', true], ['STUDENT', 'Why?', false],
      ['EMPLOYER', 'Or message me on my personal number.', true], ['STUDENT', 'No thanks.', false],
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id = $1 AND action = 'trust.case.message_evidence_viewed'", [caseId])).rows[0].n).toBe(1);
    await api().get('/api/v1/operations/trust-safety/cases/' + caseId + '/message-threads').set(auth(p.recruiterId)).expect(403);
    await api().get('/api/v1/operations/trust-safety/cases/' + caseId + '/message-threads').set(auth(p.studentId)).expect(403);
    await api().get('/api/v1/operations/trust-safety/cases/' + randomUUID() + '/message-threads').set(auth(ops)).expect(404);

    const audit = await pool.query("SELECT action FROM audit_events WHERE actor_user_id = $1 AND action IN ('trust.case.opened', 'application.message.reported')", [p.studentId]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(['application.message.reported', 'application.message.reported', 'trust.case.opened']);
  });

  it('lets a student report after the employer lost access, and never lets a message be rewritten or deleted', async () => {
    const p = await applied();
    const id = (await employerSend(p, { body: 'You must pay a training fee.' }).expect(201)).body.message.id as string;
    await api().post('/api/v1/students/me/applications/' + p.applicationId + '/withdraw').set(auth(p.studentId)).send({}).expect(201);
    await api().post(studentThread(p.applicationId) + '/' + id + '/report').set(auth(p.studentId)).send({ reasonCode: 'SCAM_OR_PAYMENT_REQUEST' }).expect(201);
    await expect(pool.query("UPDATE application_messages SET body = 'edited' WHERE id = $1", [id])).rejects.toThrow(/only be erased/);
    await expect(pool.query('DELETE FROM application_messages WHERE id = $1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE application_messages SET report_reason_code = 'OTHER' WHERE id = $1", [id])).rejects.toThrow(/set once/);
  });
});

describe('EMP-10: notices go through the EMP-08 outbox path only', () => {
  it('tells the student once per unread run, never with the text, and records the email NOT_CONFIGURED with no sender', async () => {
    const p = await applied();
    await drain();
    await employerSend(p, { body: 'Secret joining code 4411' }).expect(201);
    await employerSend(p, { body: 'Also bring your ID.' }).expect(201);
    const published = await drain();
    expect(published.filter((event) => event.eventType === 'application.message.sent')).toHaveLength(2);
    // Look for the message text itself, not the bare digits: random ids in the payload can contain "4411".
    expect(published.every((event) => !/joining code|(^|[^0-9a-f])4411([^0-9a-f]|$)/i.test(JSON.stringify(event.payload)))).toBe(true);
    const notes = (await feed(p.studentId)).filter((note) => note.kind === 'EMPLOYER_MESSAGE');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Message from Acme Robotics', body: 'Acme Robotics sent you a message about Robotics engineer. Read and reply under Applications.' });
    expect(JSON.stringify(notes)).not.toMatch(/joining code|(^|[^0-9a-f])4411([^0-9a-f]|$)|bring your ID/i);
    const rows = await pool.query("SELECT recipient_user_id, recipient_kind, email_state, email_template_key FROM hiring_notification_deliveries WHERE application_id = $1 AND kind = 'EMPLOYER_MESSAGE'", [p.applicationId]);
    expect(rows.rows).toEqual([{ recipient_user_id: p.studentId, recipient_kind: 'STUDENT', email_state: 'NOT_CONFIGURED', email_template_key: 'hiring-employer-message' }]);
  });

  it('tells the members who wrote when the candidate replies, in-app only and without naming them, and honours mute', async () => {
    const p = await applied();
    await employerSend(p, { body: 'Hello' }).expect(201);
    await drain();
    await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    await studentSend(p, { body: 'Hi there' }).expect(201);
    await drain(captureSink);
    const recruiterNotes = (await feed(p.recruiterId)).filter((note) => note.kind === 'CANDIDATE_MESSAGE');
    expect(recruiterNotes).toHaveLength(1);
    expect(recruiterNotes[0]!.title).toBe('Candidate message: Robotics engineer');
    expect(JSON.stringify(recruiterNotes)).not.toMatch(/Hi there|example\.test/);
    // The owner did not write in the conversation, so is not told.
    expect((await feed(p.ownerId)).filter((note) => note.kind === 'CANDIDATE_MESSAGE')).toHaveLength(0);
    const row = await pool.query("SELECT email_state FROM hiring_notification_deliveries WHERE application_id = $1 AND kind = 'CANDIDATE_MESSAGE'", [p.applicationId]);
    expect(row.rows).toEqual([{ email_state: 'NOT_REQUESTED' }]);
    expect(delivered).toHaveLength(0);

    // Muted: the message still lands, the student is not told, and the employer never learns.
    const muted = await api().post(studentThread(p.applicationId) + '/mute').set(auth(p.studentId)).send({ muted: true }).expect(201);
    expect(muted.body.conversation.muted).toBe(true);
    await employerSend(p, { body: 'Following up' }).expect(201);
    await drain(captureSink);
    expect((await feed(p.studentId)).filter((note) => note.kind === 'EMPLOYER_MESSAGE')).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    const employerView = await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(200);
    expect(JSON.stringify(employerView.body)).not.toMatch(/mute/i);

    // Unmuted, with a sender configured: the email leaves, carrying no message text.
    await api().get(studentThread(p.applicationId)).set(auth(p.studentId)).expect(200);
    await api().post(studentThread(p.applicationId) + '/mute').set(auth(p.studentId)).send({ muted: false }).expect(201);
    await studentSend(p, { body: 'Thanks' }).expect(201);
    await employerSend(p, { body: 'Your interview code is 7788' }).expect(201);
    await drain(captureSink);
    const emails = delivered.filter((mail) => mail.toEmail === p.studentId + '@example.test');
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('Message from Acme Robotics');
    expect(emails[0]!.textBody).not.toContain('7788');
    const mutes = await pool.query("SELECT action FROM audit_events WHERE resource_id = $1 AND action LIKE 'application.messages.%muted' ORDER BY occurred_at", [p.applicationId]);
    expect(mutes.rows.map((r) => r.action)).toEqual(['application.messages.muted', 'application.messages.unmuted']);
  });

  it('sends nothing for a message whose grant ended before the notice was delivered', async () => {
    const p = await applied();
    await drain();
    await employerSend(p, { body: 'Hello' }).expect(201);
    await api().post('/api/v1/students/me/applications/' + p.applicationId + '/withdraw').set(auth(p.studentId)).send({}).expect(201);
    await drain();
    expect((await feed(p.studentId)).filter((note) => note.kind === 'EMPLOYER_MESSAGE')).toHaveLength(0);
  });
});

describe('EMP-10: export, deletion and retention', () => {
  it('puts the conversation in the student\'s export without naming the recruiter', async () => {
    const p = await applied();
    await employerSend(p, { body: 'Welcome to the process.' }).expect(201);
    await studentSend(p, { body: 'Thank you.' }).expect(201);
    const bundle = await assembleSubjectExport(db, p.studentId) as { applicationMessages: { employerName: string; title: string; messages: { from: string; text: string }[] }[] };
    expect(bundle.applicationMessages).toEqual([expect.objectContaining({ employerName: 'Acme Robotics', title: 'Robotics engineer',
      messages: [expect.objectContaining({ from: 'EMPLOYER', text: 'Welcome to the process.' }), expect.objectContaining({ from: 'YOU', text: 'Thank you.' })] })]);
    expect(JSON.stringify(bundle.applicationMessages)).not.toContain(p.recruiterId);
  });

  it('erases both sides\' text when the student\'s account is deleted, and records it', async () => {
    const p = await applied();
    await employerSend(p, { body: 'Hello' }).expect(201);
    await studentSend(p, { body: 'My number is 98765 43210' }).expect(201);
    const requestId = randomUUID();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'emp10-test')`, [requestId, p.studentId]);
    const summaries = await executeDueDeletions({ db, ids: { uuid: randomUUID } });
    expect(summaries.find((summary) => summary.subjectUserId === p.studentId)?.outcome).toBe('COMPLETED');
    const rows = await pool.query('SELECT body, erased_at, erasure_reason FROM application_messages m JOIN application_message_threads t ON t.id = m.thread_id WHERE t.application_id = $1', [p.applicationId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.body === null && row.erased_at !== null && row.erasure_reason === 'PRIVACY_DELETION')).toBe(true);
    const record = await pool.query("SELECT disposition, record_count FROM privacy_deletion_records WHERE request_id = $1 AND category = 'APPLICATION_MESSAGES'", [requestId]);
    expect(record.rows[0]).toEqual({ disposition: 'ERASED', record_count: 2 });
    await api().get(employerThread(p.employerId, p.applicationId)).set(auth(p.recruiterId)).expect(403);
  });

  it('erases text 180 days after the grant ended, but not while a report on it is open', async () => {
    const old = await applied();
    await employerSend(old, { body: 'Old news' }).expect(201);
    const recent = await applied();
    await employerSend(recent, { body: 'Recent news' }).expect(201);
    const reported = await applied();
    const reportedId = (await employerSend(reported, { body: 'Pay a fee' }).expect(201)).body.message.id as string;
    await api().post(studentThread(reported.applicationId) + '/' + reportedId + '/report').set(auth(reported.studentId)).send({ reasonCode: 'SCAM_OR_PAYMENT_REQUEST' }).expect(201);
    const live = await applied();
    await employerSend(live, { body: 'Still live' }).expect(201);

    await pool.query("UPDATE employer_applicant_access_grants SET granted_at = now() - interval '400 days', revoked_at = now() - interval '181 days' WHERE student_user_id = ANY($1::uuid[])", [[old.studentId, reported.studentId]]);
    await pool.query("UPDATE employer_applicant_access_grants SET granted_at = now() - interval '30 days', revoked_at = now() - interval '10 days' WHERE student_user_id = $1", [recent.studentId]);
    await eraseExpiredApplicationMessages(db);
    const state = async (applicationId: string) => (await pool.query(
      'SELECT m.body, m.erasure_reason FROM application_messages m JOIN application_message_threads t ON t.id = m.thread_id WHERE t.application_id = $1', [applicationId])).rows[0];
    expect(await state(old.applicationId)).toEqual({ body: null, erasure_reason: 'RETENTION_EXPIRED' });
    expect(await state(recent.applicationId)).toEqual({ body: 'Recent news', erasure_reason: null });
    expect(await state(reported.applicationId)).toEqual({ body: 'Pay a fee', erasure_reason: null });
    expect(await state(live.applicationId)).toEqual({ body: 'Still live', erasure_reason: null });

    // Once the case is dismissed, the next sweep erases it too.
    await pool.query("UPDATE trust_cases SET state = 'DISMISSED', closed_at = now() WHERE reported_by_user_id = $1", [reported.studentId]);
    await eraseExpiredApplicationMessages(db);
    expect(await state(reported.applicationId)).toEqual({ body: null, erasure_reason: 'RETENTION_EXPIRED' });
    const own = await api().get(studentThread(old.applicationId)).set(auth(old.studentId)).expect(200);
    expect(own.body.conversation.messages[0]).toMatchObject({ body: null, erased: true });
  });
});
