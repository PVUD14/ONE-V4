/**
 * Student hiring notifications and the student interview view (EMP-08, defect D-6).
 *
 * Before EMP-08 a student was never told that an employer moved their application, scheduled or
 * changed an interview, or extended or withdrew an offer, and could not see their interviews: the
 * employer's events went to the outbox with no registered schema and no consumer. These tests run
 * the hiring actions over real HTTP, then drain the outbox through the deployed worker mode
 * (ADR-028 local dispatcher), in a throwaway schema of the local Postgres in DATABASE_URL.
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
if (!connectionString) throw new Error('DATABASE_URL is required for hiring notification tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Hiring notification tests require local Postgres');
const schemaName = 'hiring_notifications_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;

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
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
}, 60_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

// A mail sink that records what it was asked to send; addresses in `rejected` bounce and
// those in `unavailable` fail, so a failed email can be proven not to undo anything.
const delivered: { toEmail: string; subject: string; textBody: string }[] = [];
const rejected = new Set<string>();
const unavailable = new Set<string>();
const captureSink: InvitationMailSink = {
  async send(input) {
    if (rejected.has(input.toEmail)) throw new PermanentMailRejection();
    if (unavailable.has(input.toEmail)) throw new Error('mail server unavailable');
    delivered.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody });
    return {};
  },
};
beforeEach(() => { delivered.length = 0; rejected.clear(); unavailable.clear(); });

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function membership(userId: string, orgId: string, role: string, state = 'ACTIVE'): Promise<void> {
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$2)`, [randomUUID(), orgId, userId, role, state]);
}
async function employer() {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Acme Robotics','VERIFIED',true)", [employerId]);
  const recruiterId = await user();
  await membership(recruiterId, employerId, 'RECRUITER');
  const ownerId = await user();
  await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  return { employerId, recruiterId, ownerId };
}
const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const employerBase = (employerId: string) => '/api/v1/employers/' + employerId;

async function publishedJob(employerId: string, recruiterId: string): Promise<string> {
  const created = await api().post(employerBase(employerId) + '/opportunities').set(auth(recruiterId)).send({
    referenceCode: 'HN-' + randomUUID().slice(0, 8), title: 'Robotics engineer', summary: 'Build robots.', employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: 'Pune', compensationDisclosed: false,
  }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(employerBase(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(employerBase(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
async function applied() {
  const hiring = await employer();
  const opportunityId = await publishedJob(hiring.employerId, hiring.recruiterId);
  const studentId = await user();
  const response = await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true }).expect(201);
  return { ...hiring, opportunityId, studentId, applicationId: response.body.application.id as string };
}
function transition(employerId: string, recruiterId: string, applicationId: string, toState: string) {
  return api().post(employerBase(employerId) + '/applications/' + applicationId + '/transition').set(auth(recruiterId)).send({ toState });
}
function schedule(employerId: string, recruiterId: string, applicationId: string, extra: Record<string, unknown> = {}) {
  return api().post(employerBase(employerId) + '/applications/' + applicationId + '/interviews').set(auth(recruiterId)).send({
    mode: 'VIDEO', scheduledStart: '2099-03-01T04:30:00.000Z', scheduledEnd: '2099-03-01T05:30:00.000Z',
    joiningLink: 'https://meet.example.test/room-1', preparationNote: 'Bring a short walkthrough of one project you built.', ...extra,
  });
}
function extendOffer(employerId: string, recruiterId: string, applicationId: string, offerExpiresAt = '2099-02-01T00:00:00.000Z') {
  return api().post(employerBase(employerId) + '/applications/' + applicationId + '/offers').set(auth(recruiterId)).send({
    compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt,
  });
}

/** Run the deployed worker mode (ADR-028 local dispatcher) until the outbox is drained. */
async function drain(sink: InvitationMailSink | null = null): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    // The database clock can run a few ms ahead of this process; look slightly ahead.
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'hiring-notification-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
interface Note { kind: string; title: string; body: string; data: Record<string, unknown> }
async function feed(userId: string): Promise<Note[]> {
  const response = await api().get('/api/v1/me/notifications').set(auth(userId)).expect(200);
  return response.body.notifications as Note[];
}
async function deliveries(applicationId: string) {
  return (await pool.query('SELECT recipient_user_id, recipient_kind, kind, email_state, email_template_key, email_template_version FROM hiring_notification_deliveries WHERE application_id=$1 ORDER BY created_at', [applicationId])).rows;
}
/** A notice may say who, what and when — never readiness, a score, a reason code or an internal id. */
function expectNothingPrivate(notes: readonly Note[], ids: readonly string[]) {
  const text = JSON.stringify(notes);
  expect(text).not.toMatch(/readiness|band|score|mastery|gap/i);
  for (const id of ids) expect(text).not.toContain(id);
  for (const note of notes) for (const value of Object.values(note.data)) expect(typeof value).toBe('string');
}

describe('EMP-08: every stage change reaches the student once', () => {
  it('writes one in-app notice and one email per event, and a replayed event writes nothing more', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'SHORTLISTED').expect(201);
    const published = await drain(captureSink);

    const notes = await feed(hiring.studentId);
    expect(notes).toEqual([expect.objectContaining({
      kind: 'APPLICATION_STAGE_CHANGED', title: 'Application update: Robotics engineer', body: 'Acme Robotics shortlisted you for Robotics engineer.',
      data: { screen: 'applications', employerName: 'Acme Robotics', opportunityTitle: 'Robotics engineer' },
    })]);
    expect(delivered).toEqual([{ toEmail: hiring.studentId + '@example.test', subject: 'Application update: Robotics engineer', textBody: expect.stringContaining('Acme Robotics shortlisted you for Robotics engineer.') }]);
    expect(await deliveries(hiring.applicationId)).toEqual([{ recipient_user_id: hiring.studentId, recipient_kind: 'STUDENT', kind: 'APPLICATION_STAGE_CHANGED',
      email_state: 'SENT', email_template_key: 'hiring-application-stage-changed', email_template_version: 1 }]);
    const template = await pool.query("SELECT version FROM notification_templates WHERE stable_key='hiring-application-stage-changed'");
    expect(template.rows).toEqual([{ version: 1 }]);

    // At-least-once delivery hands the same events over again: nothing is written or sent twice.
    const local = createLocalIntegrationEventPublisher({ pool, db, invitationMailSink: captureSink });
    for (const event of published) await local.publisher.publish(event);
    expect(await feed(hiring.studentId)).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expectNothingPrivate(notes, [hiring.applicationId, hiring.opportunityId, hiring.employerId]);
  });

  it('tells a rejected student plainly, without the private reason code or note', async () => {
    const hiring = await applied();
    await api().post(employerBase(hiring.employerId) + '/applications/' + hiring.applicationId + '/transition').set(auth(hiring.recruiterId))
      .send({ toState: 'REJECTED', reasonCode: 'SKILLS_GAP', note: 'Weak on control systems' }).expect(201);
    await drain();
    const notes = await feed(hiring.studentId);
    expect(notes.map((note) => [note.kind, note.body])).toEqual([[
      'APPLICATION_STAGE_CHANGED', 'Acme Robotics has decided not to take your application for Robotics engineer further. If they share feedback, it will appear under Applications.']]);
    expect(JSON.stringify(notes)).not.toMatch(/SKILLS_GAP|control systems/);
  });

  it('records the email NOT_CONFIGURED when no sender exists, and SKIPPED when the student turned email off', async () => {
    const first = await applied();
    await transition(first.employerId, first.recruiterId, first.applicationId, 'SCREENING').expect(201);
    await drain(null);
    expect(await feed(first.studentId)).toHaveLength(1);
    expect((await deliveries(first.applicationId)).map((row) => row.email_state)).toEqual(['NOT_CONFIGURED']);

    const second = await applied();
    await pool.query('INSERT INTO notification_preferences (user_id, email_enabled) VALUES ($1, false)', [second.studentId]);
    await transition(second.employerId, second.recruiterId, second.applicationId, 'SCREENING').expect(201);
    await drain(captureSink);
    expect(await feed(second.studentId)).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect((await deliveries(second.applicationId)).map((row) => row.email_state)).toEqual(['SKIPPED']);
  });

  it('never lets a failed email block the hiring action or undo the in-app notice', async () => {
    const hiring = await applied();
    unavailable.add(hiring.studentId + '@example.test');
    // The action answers before any notification work happens: it only wrote an outbox row.
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'SHORTLISTED').expect(201);
    await drain(captureSink);
    expect(await feed(hiring.studentId)).toHaveLength(1);
    expect((await deliveries(hiring.applicationId)).map((row) => row.email_state)).toEqual(['FAILED']);

    const bounced = await applied();
    rejected.add(bounced.studentId + '@example.test');
    await transition(bounced.employerId, bounced.recruiterId, bounced.applicationId, 'SHORTLISTED').expect(201);
    await drain(captureSink);
    expect((await deliveries(bounced.applicationId)).map((row) => row.email_state)).toEqual(['BOUNCED']);
    const state = await pool.query('SELECT state FROM applications WHERE id=$1', [bounced.applicationId]);
    expect(state.rows[0].state).toBe('SHORTLISTED');
  });

  it('asks the student to review changed terms, and says nothing about a deadline-only change', async () => {
    const hiring = await applied();
    const current = (await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [hiring.opportunityId])).rows[0].current_version_id as string;
    const terms = { title: 'Robotics engineer', summary: 'Build robots.', employmentType: 'FULL_TIME', workMode: 'ONSITE', compensationDisclosed: false };
    await api().post(employerBase(hiring.employerId) + '/opportunities/' + hiring.opportunityId + '/versions').set(auth(hiring.recruiterId))
      .send({ ...terms, locationCity: 'Mumbai', expectedCurrentVersionId: current }).expect(201);
    await drain(captureSink);
    const notes = await feed(hiring.studentId);
    expect(notes.map((note) => [note.kind, note.title])).toEqual([['APPLICATION_TERMS_CHANGED', 'The terms changed: Robotics engineer']]);
    expect(delivered).toHaveLength(1);

    const deadlineOnly = await applied();
    const version = (await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [deadlineOnly.opportunityId])).rows[0].current_version_id as string;
    await api().post(employerBase(deadlineOnly.employerId) + '/opportunities/' + deadlineOnly.opportunityId + '/versions').set(auth(deadlineOnly.recruiterId))
      .send({ ...terms, locationCity: 'Pune', applicationDeadline: '2099-01-01T00:00:00.000Z', expectedCurrentVersionId: version }).expect(201);
    const recorded = await pool.query("SELECT payload->>'acknowledgement' AS acknowledgement FROM outbox_events WHERE event_type='application.terms_change.recorded' AND aggregate_id=$1", [deadlineOnly.applicationId]);
    expect(recorded.rows).toEqual([{ acknowledgement: 'NOT_REQUIRED' }]);
    await drain(captureSink);
    expect(await feed(deadlineOnly.studentId)).toEqual([]);
  });
});

describe('EMP-08: interviews reach the student, and the student sees them', () => {
  it('announces a scheduled interview in the student timezone and lists it with how to join and what to prepare', async () => {
    const hiring = await applied();
    await pool.query("INSERT INTO notification_preferences (user_id, timezone) VALUES ($1, 'Asia/Kolkata')", [hiring.studentId]);
    const scheduled = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201);
    await drain(captureSink);

    const notes = await feed(hiring.studentId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'INTERVIEW_SCHEDULED', title: 'Interview scheduled: Robotics engineer' });
    // 04:30 UTC is 10:00 in India.
    expect(notes[0]!.body).toMatch(/^Acme Robotics scheduled round 1 \(video\) for Robotics engineer on .*1 Mar,? 2099.*10:00.*\. The location or joining link, and what to prepare, are under Applications\.$/);
    // The joining link stays in ONE: neither the notice nor the email carries it.
    expect(JSON.stringify(notes)).not.toContain('meet.example.test');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.textBody).not.toContain('meet.example.test');

    const listed = await api().get('/api/v1/students/me/interviews').set(auth(hiring.studentId)).expect(200);
    expect(listed.body.interviews).toEqual([{
      id: scheduled.body.interview.id, employerName: 'Acme Robotics', title: 'Robotics engineer', roundNumber: 1, stageLabel: null,
      applicationState: 'APPLIED', mode: 'VIDEO', state: 'SCHEDULED', upcoming: true,
      scheduledStart: '2099-03-01T04:30:00.000Z', scheduledEnd: '2099-03-01T05:30:00.000Z',
      locationDetail: null, joiningLink: 'https://meet.example.test/room-1',
      preparationNote: 'Bring a short walkthrough of one project you built.',
    }]);
    expect(JSON.stringify(listed.body)).not.toMatch(/readiness|score|participant|cancellationReason|studentUserId/i);
  });

  it('tells the student about a reschedule and a cancellation, and nothing about a completed interview', async () => {
    const hiring = await applied();
    const first = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201);
    const statePath = (id: string) => employerBase(hiring.employerId) + '/interviews/' + id + '/state';
    await api().post(statePath(first.body.interview.id)).set(auth(hiring.recruiterId))
      .send({ toState: 'RESCHEDULED', scheduledStart: '2099-03-02T04:30:00.000Z', scheduledEnd: '2099-03-02T05:30:00.000Z' }).expect(201);
    await api().post(statePath(first.body.interview.id)).set(auth(hiring.recruiterId)).send({ toState: 'CANCELLED', reason: 'Panel unavailable' }).expect(201);
    const second = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201);
    await api().post(statePath(second.body.interview.id)).set(auth(hiring.recruiterId)).send({ toState: 'COMPLETED' }).expect(201);
    await drain();

    const kinds = (await feed(hiring.studentId)).map((note) => note.title).sort();
    expect(kinds).toEqual(['Interview cancelled: Robotics engineer', 'Interview rescheduled: Robotics engineer',
      'Interview scheduled: Robotics engineer', 'Interview scheduled: Robotics engineer'].sort());
    expect(JSON.stringify(await feed(hiring.studentId))).not.toContain('Panel unavailable');
    // Each change commits with its audit row and its event.
    const events = await pool.query("SELECT payload->>'toState' AS to_state FROM outbox_events WHERE event_type='interview.state_changed' AND organization_id=$1 ORDER BY occurred_at", [hiring.employerId]);
    expect(events.rows.map((row) => row.to_state)).toEqual(['RESCHEDULED', 'CANCELLED', 'COMPLETED']);

    const listed = await api().get('/api/v1/students/me/interviews').set(auth(hiring.studentId)).expect(200);
    const byRound = Object.fromEntries((listed.body.interviews as { roundNumber: number; state: string; upcoming: boolean; joiningLink: string | null; preparationNote: string | null }[])
      .map((item) => [item.roundNumber, item]));
    // Past or cancelled: kept for the record, without the link or the note.
    expect(byRound[1]).toMatchObject({ state: 'CANCELLED', upcoming: false, joiningLink: null, preparationNote: null });
    expect(byRound[2]).toMatchObject({ state: 'COMPLETED', upcoming: false, joiningLink: null });
  });

  it('lists upcoming interviews first, soonest first, then past ones, and only the caller\'s own', async () => {
    const hiring = await applied();
    const soon = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId, { scheduledStart: '2099-01-01T04:30:00.000Z', scheduledEnd: '2099-01-01T05:30:00.000Z' }).expect(201);
    const later = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId, { scheduledStart: '2099-06-01T04:30:00.000Z', scheduledEnd: '2099-06-01T05:30:00.000Z' }).expect(201);
    const past = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201);
    await pool.query("UPDATE interviews SET scheduled_start = now() - interval '3 days', scheduled_end = now() - interval '3 days' + interval '1 hour' WHERE id=$1", [past.body.interview.id]);

    const listed = await api().get('/api/v1/students/me/interviews').set(auth(hiring.studentId)).expect(200);
    expect(listed.body.interviews.map((item: { id: string; upcoming: boolean }) => [item.id, item.upcoming])).toEqual([
      [soon.body.interview.id, true], [later.body.interview.id, true], [past.body.interview.id, false]]);
    expect(listed.body.interviews[2].joiningLink).toBeNull();

    const other = await user();
    expect((await api().get('/api/v1/students/me/interviews').set(auth(other)).expect(200)).body.interviews).toEqual([]);
    const limited = await api().get('/api/v1/students/me/interviews?limit=1').set(auth(hiring.studentId)).expect(200);
    expect(limited.body.interviews).toHaveLength(1);
  });

  it('keeps the interview route behind authentication and bounds the list', async () => {
    await api().get('/api/v1/students/me/interviews').expect(401);
    const student = await user();
    for (const limit of ['0', '201', 'abc', '-1']) {
      const response = await api().get('/api/v1/students/me/interviews?limit=' + limit).set(auth(student)).expect(400);
      expect(response.body.error.code).toBe('INVALID_LIMIT');
    }
    await api().get('/api/v1/students/me/interviews?limit=200').set(auth(student)).expect(200);
  });

  it('refuses a preparation note that could run as a spreadsheet formula', async () => {
    const hiring = await applied();
    const response = await schedule(hiring.employerId, hiring.recruiterId, hiring.applicationId, { preparationNote: '=HYPERLINK("x")' }).expect(400);
    expect(response.body.error.code).toBe('INVALID_PREPARATIONNOTE');
  });
});

describe('EMP-08: offers reach the student, and answers reach the employer', () => {
  it('announces an offer with its deadline, queues one reminder a day before it lapses, and reminds once', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const offer = await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201);
    const offerId = offer.body.offer.id as string;
    await drain(captureSink);
    expect((await feed(hiring.studentId)).map((note) => note.kind).sort()).toEqual(['APPLICATION_STAGE_CHANGED', 'OFFER_EXTENDED']);
    const extended = (await feed(hiring.studentId)).find((note) => note.kind === 'OFFER_EXTENDED')!;
    expect(extended.title).toBe('Offer from Acme Robotics');
    expect(extended.body).toMatch(/^Acme Robotics made you an offer for Robotics engineer\. Accept or decline it under Applications by .*1 Feb,? 2099.*\.$/);
    expect(JSON.stringify(extended)).not.toMatch(/30000|30,000|INR/);

    const reminder = await pool.query(`SELECT available_at = offer_expires_at - interval '24 hours' AS day_before, occurred_at = available_at AS due_counts
      FROM outbox_events e JOIN offers o ON o.id::text = e.aggregate_id WHERE e.event_type='offer.expiry_reminder.requested' AND e.aggregate_id=$1`, [offerId]);
    expect(reminder.rows).toEqual([{ day_before: true, due_counts: true }]);

    // A day before it lapses: the reminder is due.
    await pool.query("UPDATE offers SET offer_expires_at = now() + interval '20 hours' WHERE id=$1", [offerId]);
    await pool.query("UPDATE outbox_events SET available_at = now() - interval '1 second', occurred_at = now() - interval '1 second' WHERE event_type='offer.expiry_reminder.requested' AND aggregate_id=$1", [offerId]);
    delivered.length = 0;
    const published = await drain(captureSink);
    const expiring = (await feed(hiring.studentId)).filter((note) => note.kind === 'OFFER_EXPIRING');
    expect(expiring.map((note) => note.title)).toEqual(['Offer expires soon: Robotics engineer']);
    expect(delivered.map((entry) => entry.subject)).toEqual(['Offer expires soon: Robotics engineer']);
    const local = createLocalIntegrationEventPublisher({ pool, db, invitationMailSink: captureSink });
    for (const event of published) await local.publisher.publish(event);
    expect((await feed(hiring.studentId)).filter((note) => note.kind === 'OFFER_EXPIRING')).toHaveLength(1);
  });

  it('does not remind about an offer that was already answered', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const offerId = (await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201)).body.offer.id as string;
    await drain();
    await api().post('/api/v1/students/me/offers/' + offerId + '/respond').set(auth(hiring.studentId)).send({ decision: 'ACCEPT' }).expect(201);
    await pool.query("UPDATE outbox_events SET available_at = now() - interval '1 second', occurred_at = now() - interval '1 second' WHERE event_type='offer.expiry_reminder.requested' AND aggregate_id=$1", [offerId]);
    await drain();
    expect((await feed(hiring.studentId)).filter((note) => note.kind === 'OFFER_EXPIRING')).toEqual([]);
  });

  it('queues no reminder for an offer that lapses within a day', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const soon = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const offerId = (await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId, soon).expect(201)).body.offer.id as string;
    await drain();
    const reminders = await pool.query("SELECT 1 FROM outbox_events WHERE event_type='offer.expiry_reminder.requested' AND aggregate_id=$1", [offerId]);
    expect(reminders.rows).toEqual([]);
    expect((await feed(hiring.studentId)).map((note) => note.kind)).toContain('OFFER_EXTENDED');
  });

  it('tells the student an offer was withdrawn', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const offerId = (await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201)).body.offer.id as string;
    await api().post(employerBase(hiring.employerId) + '/offers/' + offerId + '/withdraw').set(auth(hiring.recruiterId)).expect(201);
    await drain(captureSink);
    const withdrawn = (await feed(hiring.studentId)).filter((note) => note.kind === 'OFFER_WITHDRAWN');
    expect(withdrawn.map((note) => [note.title, note.body])).toEqual([['Offer withdrawn: Robotics engineer', 'Acme Robotics withdrew its offer for Robotics engineer.']]);
    const audit = await pool.query("SELECT organization_id FROM audit_events WHERE action='offer.withdrawn' AND resource_id=$1", [offerId]);
    expect(audit.rows).toHaveLength(1);
  });

  it('gives the recruiter who made the offer an in-app notice of the answer, naming no candidate and sending no email', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const offerId = (await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201)).body.offer.id as string;
    await drain(captureSink);
    delivered.length = 0;
    await api().post('/api/v1/students/me/offers/' + offerId + '/respond').set(auth(hiring.studentId)).send({ decision: 'ACCEPT' }).expect(201);
    await drain(captureSink);

    const notes = await feed(hiring.recruiterId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'OFFER_RESPONDED', title: 'Offer accepted: Robotics engineer', data: { screen: 'offers', opportunityTitle: 'Robotics engineer' } });
    expect(notes[0]!.body).toMatch(/^A candidate accepted your offer for Robotics engineer \(HN-[0-9a-f]{8}\)\. Open Offers to see it and record the hire\.$/);
    expect(JSON.stringify(notes)).not.toContain(hiring.studentId);
    expect(await feed(hiring.ownerId)).toEqual([]);
    expect(delivered).toEqual([]);
    const rows = await pool.query("SELECT recipient_kind, email_state, email_template_key FROM hiring_notification_deliveries WHERE kind='OFFER_RESPONDED' AND application_id=$1", [hiring.applicationId]);
    expect(rows.rows).toEqual([{ recipient_kind: 'EMPLOYER_MEMBER', email_state: 'NOT_REQUESTED', email_template_key: null }]);
  });

  it('tells the owners instead when the recruiter who made the offer has left', async () => {
    const hiring = await applied();
    await transition(hiring.employerId, hiring.recruiterId, hiring.applicationId, 'OFFER').expect(201);
    const offerId = (await extendOffer(hiring.employerId, hiring.recruiterId, hiring.applicationId).expect(201)).body.offer.id as string;
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE user_id=$1", [hiring.recruiterId]);
    await api().post('/api/v1/students/me/offers/' + offerId + '/respond').set(auth(hiring.studentId)).send({ decision: 'DECLINE' }).expect(201);
    await drain();
    expect((await feed(hiring.ownerId)).map((note) => note.title)).toEqual(['Offer declined: Robotics engineer']);
    expect(await feed(hiring.recruiterId)).toEqual([]);
  });
});
