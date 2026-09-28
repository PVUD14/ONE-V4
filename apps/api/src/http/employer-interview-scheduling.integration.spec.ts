/**
 * Interview scheduling essentials (EMP-09).
 *
 * Before EMP-09 a reschedule overwrote the old time with no reason and no history, nobody on the
 * panel was told, no calendar invite existed, every employer member saw the joining link, and
 * scorecards were free text two interviewers could not compare. These tests run the employer,
 * participant and student routes over real HTTP and drain the outbox through the deployed worker
 * mode (ADR-028 local dispatcher), in a throwaway schema of the local Postgres in DATABASE_URL.
 * Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
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
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for interview scheduling tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Interview scheduling tests require local Postgres');
const schemaName = 'interview_scheduling_' + randomUUID().replaceAll('-', '');
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

interface Sent { toEmail: string; subject: string; textBody: string; attachments: { filename: string; contentType: string; content: string }[] }
const delivered: Sent[] = [];
const captureSink: InvitationMailSink = {
  async send(input) {
    delivered.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody, attachments: [...(input.attachments ?? [])] });
    return {};
  },
};
beforeEach(() => { delivered.length = 0; });

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function membership(userId: string, orgId: string, role: string): Promise<void> {
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2)`, [randomUUID(), orgId, userId, role]);
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Acme Robotics',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  await membership(recruiterId, employerId, 'RECRUITER');
  const panelId = await user();
  await membership(panelId, employerId, 'RECRUITER');
  const ownerId = await user();
  await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  return { employerId, recruiterId, panelId, ownerId };
}
const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const employerBase = (employerId: string) => '/api/v1/employers/' + employerId;
const terms = { title: 'Robotics engineer', summary: 'Build robots.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Pune', compensationDisclosed: false };

async function currentVersion(opportunityId: string): Promise<string> {
  return (await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [opportunityId])).rows[0].current_version_id;
}
function editStages(employerId: string, actorId: string, opportunityId: string, versionId: string, stages: unknown[]) {
  return api().post(employerBase(employerId) + '/opportunities/' + opportunityId + '/versions').set(auth(actorId))
    .send({ ...terms, stages, reasonCode: 'STAGES_UPDATED', expectedCurrentVersionId: versionId });
}
async function publishedJob(employerId: string, recruiterId: string, stages?: unknown[]): Promise<string> {
  const created = await api().post(employerBase(employerId) + '/opportunities').set(auth(recruiterId))
    .send({ referenceCode: 'IS-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  if (stages) await editStages(employerId, recruiterId, id, created.body.opportunity.versionId, stages).expect(201);
  await api().post(employerBase(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(employerBase(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
async function applied(stages?: unknown[], hiring?: Awaited<ReturnType<typeof employer>>) {
  const team = hiring ?? await employer();
  const opportunityId = await publishedJob(team.employerId, team.recruiterId, stages);
  const studentId = await user();
  const response = await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true }).expect(201);
  return { ...team, opportunityId, studentId, applicationId: response.body.application.id as string };
}
type Hiring = Awaited<ReturnType<typeof applied>>;
function schedule(hiring: Hiring, extra: Record<string, unknown> = {}) {
  return api().post(employerBase(hiring.employerId) + '/applications/' + hiring.applicationId + '/interviews').set(auth(hiring.recruiterId)).send({
    mode: 'VIDEO', scheduledStart: '2099-03-01T04:30:00.000Z', scheduledEnd: '2099-03-01T05:30:00.000Z',
    joiningLink: 'https://meet.example.test/room-1', preparationNote: 'Bring a short walkthrough of one project you built.',
    participantUserIds: [hiring.panelId], participantVisibilityAcknowledged: true, ...extra,
  });
}
async function scheduled(hiring: Hiring, extra: Record<string, unknown> = {}): Promise<string> {
  return (await schedule(hiring, extra).expect(201)).body.interview.id as string;
}
const statePath = (hiring: { employerId: string }, interviewId: string) => employerBase(hiring.employerId) + '/interviews/' + interviewId + '/state';
function reschedule(hiring: Hiring, interviewId: string, body: Record<string, unknown> = {}, actor = hiring.recruiterId) {
  return api().post(statePath(hiring, interviewId)).set(auth(actor)).send({
    toState: 'RESCHEDULED', scheduledStart: '2099-03-02T04:30:00.000Z', scheduledEnd: '2099-03-02T05:30:00.000Z', reasonCode: 'CANDIDATE_REQUESTED', ...body,
  });
}
function cancel(hiring: Hiring, interviewId: string, body: Record<string, unknown> = {}) {
  return api().post(statePath(hiring, interviewId)).set(auth(hiring.recruiterId)).send({ toState: 'CANCELLED', reasonCode: 'POSITION_FILLED', ...body });
}

async function drain(sink: InvitationMailSink | null = null): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'interview-scheduling-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
interface Note { kind: string; title: string; body: string; data: Record<string, unknown> }
async function feed(userId: string): Promise<Note[]> {
  return (await api().get('/api/v1/me/notifications').set(auth(userId)).expect(200)).body.notifications as Note[];
}
/** RFC 5545 unfolding, then one logical line per property. */
const icsLines = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
const icsValue = (ics: string, property: string) => icsLines(ics).find((line) => line.startsWith(property + ':'))?.slice(property.length + 1);
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|average|total/i);

describe('EMP-09: reschedules and cancellations carry a reason code and keep their history', () => {
  it('refuses a reschedule or cancellation without a listed reason code, with an unknown field or into the past, and writes nothing', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    const refusals: [Record<string, unknown>, string][] = [
      [{ reasonCode: undefined }, 'REASON_CODE_REQUIRED'],
      [{ reasonCode: 'BORED' }, 'INVALID_REASONCODE'],
      [{ reasonCode: 'POSITION_FILLED' }, 'INVALID_REASONCODE'],
      [{ colour: 'red' }, 'UNKNOWN_FIELD'],
      [{ scheduledStart: '2020-01-01T04:30:00.000Z', scheduledEnd: '2020-01-01T05:30:00.000Z' }, 'SCHEDULE_IN_PAST'],
      [{ mode: 'ONSITE' }, 'LOCATION_REQUIRED'],
      [{ joiningLink: 'http://meet.example.test/plain' }, 'INVALID_JOININGLINK'],
      [{ joiningLink: 'https://someone:secret@meet.example.test/room' }, 'INVALID_JOININGLINK'],
      [{ note: '=HYPERLINK("x")' }, 'INVALID_NOTE'],
    ];
    for (const [body, code] of refusals) {
      const response = await reschedule(hiring, id, body).expect(400);
      expect({ body, code: response.body.error.code }).toEqual({ body, code });
    }
    for (const [body, code] of [[{ reasonCode: undefined }, 'REASON_CODE_REQUIRED'], [{ reasonCode: 'CANDIDATE_REQUESTED', extra: 1 }, 'UNKNOWN_FIELD'], [{ reasonCode: 'SCHEDULING_CONFLICT' }, 'INVALID_REASONCODE']] as const) {
      expect((await cancel(hiring, id, body).expect(400)).body.error.code).toBe(code);
    }
    expect((await api().post(statePath(hiring, id)).set(auth(hiring.recruiterId)).send({ toState: 'COMPLETED', reasonCode: 'POSITION_FILLED' }).expect(400)).body.error.code).toBe('INVALID_REASONCODE');
    const row = await pool.query('SELECT state, scheduled_start FROM interviews WHERE id=$1', [id]);
    expect(row.rows[0]).toMatchObject({ state: 'SCHEDULED', scheduled_start: new Date('2099-03-01T04:30:00.000Z') });
    expect((await pool.query('SELECT count(*)::int AS n FROM interview_schedule_revisions WHERE interview_id=$1', [id])).rows[0].n).toBe(1);
  });

  it('keeps every revision in order with who, when, why and the schedule it produced, and the history cannot be rewritten', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    await reschedule(hiring, id, { note: 'Candidate has an exam that morning.' }).expect(201);
    await reschedule(hiring, id, { reasonCode: 'LOGISTICS_CHANGED', mode: 'ONSITE', locationDetail: 'Acme Robotics, Gate 3', joiningLink: null,
      scheduledStart: '2099-03-03T06:00:00.000Z', scheduledEnd: '2099-03-03T07:00:00.000Z' }, hiring.ownerId).expect(201);
    await cancel(hiring, id, { reason: 'Panel unavailable', reasonCode: 'INTERVIEWER_UNAVAILABLE' }).expect(201);

    const history = await api().get(employerBase(hiring.employerId) + '/interviews/' + id + '/history').set(auth(hiring.recruiterId)).expect(200);
    expect(history.body.revisions.map((revision: Record<string, unknown>) => [revision.revisionNumber, revision.changeKind, revision.reasonCode, revision.mode, revision.scheduledStart, revision.actorLabel])).toEqual([
      [1, 'SCHEDULED', null, 'VIDEO', '2099-03-01T04:30:00.000Z', hiring.recruiterId + '@example.test'],
      [2, 'RESCHEDULED', 'CANDIDATE_REQUESTED', 'VIDEO', '2099-03-02T04:30:00.000Z', hiring.recruiterId + '@example.test'],
      [3, 'RESCHEDULED', 'LOGISTICS_CHANGED', 'ONSITE', '2099-03-03T06:00:00.000Z', hiring.ownerId + '@example.test'],
      [4, 'CANCELLED', 'INTERVIEWER_UNAVAILABLE', 'ONSITE', '2099-03-03T06:00:00.000Z', hiring.recruiterId + '@example.test'],
    ]);
    expect(history.body.revisions[1].note).toBe('Candidate has an exam that morning.');
    expect(history.body.revisions[3].note).toBe('Panel unavailable');
    expect(history.body.revisions[2]).toMatchObject({ locationDetail: 'Acme Robotics, Gate 3', joiningLink: null });
    noReadiness(history.body);

    const interview = await pool.query('SELECT state, mode, location_detail, joining_link, scheduled_start FROM interviews WHERE id=$1', [id]);
    expect(interview.rows[0]).toMatchObject({ state: 'CANCELLED', mode: 'ONSITE', location_detail: 'Acme Robotics, Gate 3', joining_link: null });

    const audit = await pool.query("SELECT action, organization_id, context FROM audit_events WHERE resource_id=$1 AND action IN ('interview.rescheduled','interview.cancelled') ORDER BY occurred_at", [id]);
    expect(audit.rows.map((row) => [row.action, row.organization_id, row.context.reasonCode, row.context.revisionNumber])).toEqual([
      ['interview.rescheduled', hiring.employerId, 'CANDIDATE_REQUESTED', 2], ['interview.rescheduled', hiring.employerId, 'LOGISTICS_CHANGED', 3],
      ['interview.cancelled', hiring.employerId, 'INTERVIEWER_UNAVAILABLE', 4]]);
    const events = await pool.query(`SELECT e.event_type, r.revision_number FROM outbox_events e JOIN interview_schedule_revisions r ON r.id = (e.payload->>'revisionId')::uuid
      WHERE e.aggregate_id=$1 ORDER BY e.occurred_at`, [id]);
    expect(events.rows.map((row) => [row.event_type, row.revision_number])).toEqual([
      ['interview.scheduled', 1], ['interview.state_changed', 2], ['interview.state_changed', 3], ['interview.state_changed', 4]]);

    await expect(pool.query("UPDATE interview_schedule_revisions SET reason_code='TECHNICAL_ISSUE' WHERE interview_id=$1", [id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM interview_schedule_revisions WHERE interview_id=$1', [id])).rejects.toThrow();
    await expect(reschedule(hiring, id).expect(400)).resolves.toMatchObject({ body: { error: { code: 'INVALID_TRANSITION' } } });
  });

  it('still lets the employer cancel once the candidate has withdrawn, with a reason code, and withholds the person from the history', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    await api().post('/api/v1/students/me/applications/' + hiring.applicationId + '/withdraw').set(auth(hiring.studentId)).send({}).expect(201);
    await reschedule(hiring, id).expect(403);
    await cancel(hiring, id, { reasonCode: 'CANDIDATE_WITHDREW' }).expect(201);
    const history = await api().get(employerBase(hiring.employerId) + '/interviews/' + id + '/history').set(auth(hiring.recruiterId)).expect(200);
    expect(history.body.revisions.map((revision: { changeKind: string }) => revision.changeKind)).toEqual(['SCHEDULED', 'CANCELLED']);
    expect(JSON.stringify(history.body)).not.toContain(hiring.studentId);
    expect(history.body.revisions.every((revision: { joiningLink: string | null }) => revision.joiningLink === null)).toBe(true);
  });
});

describe('EMP-09: everyone on the interview is told once, with a calendar invite', () => {
  it('notifies the student and each panellist once per change with an .ics, and a replayed event adds nothing', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    await reschedule(hiring, id).expect(201);
    await cancel(hiring, id).expect(201);
    const published = await drain(captureSink);

    expect((await feed(hiring.studentId)).map((note) => note.title).sort()).toEqual(
      ['Interview cancelled: Robotics engineer', 'Interview rescheduled: Robotics engineer', 'Interview scheduled: Robotics engineer'].sort());
    const panel = await feed(hiring.panelId);
    expect(panel.map((note) => [note.kind, note.title]).sort()).toEqual([
      ['INTERVIEW_CHANGED', 'Panel interview cancelled: Robotics engineer'],
      ['INTERVIEW_CHANGED', 'Panel interview moved: Robotics engineer'],
      ['INTERVIEW_SCHEDULED', 'Interview panel: Robotics engineer'],
    ].sort());
    // A panel notice names the job, never the candidate.
    expect(JSON.stringify(panel)).not.toMatch(new RegExp(hiring.studentId));
    expect(panel.every((note) => note.data.screen === 'my-interviews')).toBe(true);
    // The recruiter who is not on the panel hears nothing.
    expect(await feed(hiring.recruiterId)).toEqual([]);

    expect(delivered.map((mail) => mail.toEmail).sort()).toEqual([
      hiring.studentId, hiring.studentId, hiring.studentId, hiring.panelId, hiring.panelId, hiring.panelId].map((id) => id + '@example.test').sort());
    for (const mail of delivered) {
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments[0]).toMatchObject({ contentType: expect.stringMatching(/^text\/calendar; charset=utf-8; method=PUBLISH$/), filename: 'interview-robotics-engineer-round-1.ics' });
      // EMP-08 kept the joining link and the location out of email; an attachment is still email.
      expect(mail.attachments[0]!.content).not.toContain('meet.example.test');
      expect(mail.textBody).not.toContain('meet.example.test');
    }
    const invites = delivered.filter((mail) => mail.toEmail.startsWith(hiring.studentId)).map((mail) => mail.attachments[0]!.content)
      .sort((a, b) => Number(icsValue(a, 'SEQUENCE')) - Number(icsValue(b, 'SEQUENCE')));
    expect(invites.map((ics) => [icsValue(ics, 'SEQUENCE'), icsValue(ics, 'STATUS'), icsValue(ics, 'DTSTART')])).toEqual([
      ['0', 'CONFIRMED', '20990301T043000Z'], ['1', 'CONFIRMED', '20990302T043000Z'], ['2', 'CANCELLED', '20990302T043000Z']]);
    expect(new Set(delivered.map((mail) => icsValue(mail.attachments[0]!.content, 'UID'))).size).toBe(1);
    expect(icsValue(invites[0]!, 'UID')).not.toContain(id.slice(0, 8));

    const local = createLocalIntegrationEventPublisher({ pool, db, invitationMailSink: captureSink });
    for (const event of published) await local.publisher.publish(event);
    expect(await feed(hiring.studentId)).toHaveLength(3);
    expect(await feed(hiring.panelId)).toHaveLength(3);
    expect(delivered).toHaveLength(6);
  });

  it('tells nobody about a completed interview, and records NOT_CONFIGURED for every recipient when no sender exists', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    await api().post(statePath(hiring, id)).set(auth(hiring.recruiterId)).send({ toState: 'COMPLETED' }).expect(201);
    await drain(null);
    expect(await feed(hiring.studentId)).toHaveLength(1);
    expect(await feed(hiring.panelId)).toHaveLength(1);
    const rows = await pool.query('SELECT recipient_kind, kind, email_state FROM hiring_notification_deliveries WHERE application_id=$1 ORDER BY recipient_kind', [hiring.applicationId]);
    expect(rows.rows).toEqual([
      { recipient_kind: 'EMPLOYER_MEMBER', kind: 'INTERVIEW_SCHEDULED', email_state: 'NOT_CONFIGURED' },
      { recipient_kind: 'STUDENT', kind: 'INTERVIEW_SCHEDULED', email_state: 'NOT_CONFIGURED' },
    ]);
  });
});

describe('EMP-09: calendar downloads inside ONE', () => {
  it('gives the student their own upcoming or cancelled interview as an .ics with the link, and nothing else', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    const path = '/api/v1/students/me/interviews/' + id + '/calendar';
    const first = await api().get(path).set(auth(hiring.studentId)).expect(200);
    expect(first.headers['content-type']).toMatch(/^text\/calendar/);
    expect(first.headers['content-disposition']).toBe('attachment; filename="interview-robotics-engineer-round-1.ics"');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(icsValue(first.text, 'URL')).toBe('https://meet.example.test/room-1');
    expect(icsValue(first.text, 'SEQUENCE')).toBe('0');
    expect(first.text).toContain('Bring a short walkthrough');

    await reschedule(hiring, id).expect(201);
    const moved = await api().get(path).set(auth(hiring.studentId)).expect(200);
    expect([icsValue(moved.text, 'SEQUENCE'), icsValue(moved.text, 'DTSTART'), icsValue(moved.text, 'UID')]).toEqual(['1', '20990302T043000Z', icsValue(first.text, 'UID')]);

    await api().get(path).set(auth(await user())).expect(403);
    await api().get('/api/v1/students/me/interviews/' + randomUUID() + '/calendar').set(auth(hiring.studentId)).expect(403);
    await api().get('/api/v1/students/me/interviews/not-a-uuid/calendar').set(auth(hiring.studentId)).expect(403);

    await cancel(hiring, id).expect(201);
    const cancelled = await api().get(path).set(auth(hiring.studentId)).expect(200);
    expect(icsValue(cancelled.text, 'STATUS')).toBe('CANCELLED');
    expect(cancelled.text).not.toContain('meet.example.test');

    const past = await scheduled(hiring);
    await pool.query("UPDATE interviews SET scheduled_start = now() - interval '3 days', scheduled_end = now() - interval '3 days' + interval '1 hour' WHERE id=$1", [past]);
    expect((await api().get('/api/v1/students/me/interviews/' + past + '/calendar').set(auth(hiring.studentId)).expect(404)).body.error.code).toBe('CALENDAR_NOT_AVAILABLE');
  });

  it('gives an assigned panellist the .ics, withholds the link once the grant ends, and refuses everyone else', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    const path = employerBase(hiring.employerId) + '/my-interviews/' + id + '/calendar';
    const mine = await api().get(path).set(auth(hiring.panelId)).expect(200);
    expect(icsValue(mine.text, 'URL')).toBe('https://meet.example.test/room-1');
    await api().get(path).set(auth(hiring.ownerId)).expect(403);
    await api().get(path).set(auth(hiring.studentId)).expect(403);
    await pool.query('UPDATE employer_applicant_access_grants SET revoked_at = now() WHERE employer_id=$1 AND student_user_id=$2', [hiring.employerId, hiring.studentId]);
    const withheld = await api().get(path).set(auth(hiring.panelId)).expect(200);
    expect(withheld.text).not.toContain('meet.example.test');
  });
});

describe('EMP-09: the joining link is shown only to the people on the interview', () => {
  it('shows it to the scheduler and the panel, not to other members, and refuses a link that is not plain https', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    const linkFor = async (viewer: string) => {
      const listed = await api().get(employerBase(hiring.employerId) + '/interviews').set(auth(viewer)).expect(200);
      return (listed.body.interviews as { id: string; joiningLink: string | null; joiningLinkWithheld: boolean }[]).find((row) => row.id === id)!;
    };
    expect(await linkFor(hiring.recruiterId)).toMatchObject({ joiningLink: 'https://meet.example.test/room-1', joiningLinkWithheld: false });
    expect(await linkFor(hiring.panelId)).toMatchObject({ joiningLink: 'https://meet.example.test/room-1', joiningLinkWithheld: false });
    expect(await linkFor(hiring.ownerId)).toMatchObject({ joiningLink: null, joiningLinkWithheld: true });
    const history = await api().get(employerBase(hiring.employerId) + '/interviews/' + id + '/history').set(auth(hiring.ownerId)).expect(200);
    expect(JSON.stringify(history.body)).not.toContain('meet.example.test');

    for (const joiningLink of ['http://meet.example.test/x', 'https://a:b@meet.example.test/x', 'https://', 'meet.example.test/x']) {
      expect((await schedule(hiring, { joiningLink }).expect(400)).body.error.code).toBe('INVALID_JOININGLINK');
    }
    expect((await schedule(hiring, { flavour: 'mint' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
  });
});

describe('EMP-09: scorecards follow the stage template', () => {
  const templatesPath = (employerId: string) => employerBase(employerId) + '/scorecard-templates';
  const technical = {
    name: 'Technical round', guidance: 'Rate what you observed in this interview only.',
    criteria: [{ label: 'Problem solving', guidance: 'Breaks the problem down before coding.' }, { label: 'Communication' }, { label: 'Code quality' }],
  };
  async function template(employerId: string, actorId: string, body: Record<string, unknown> = technical) {
    const response = await api().post(templatesPath(employerId)).set(auth(actorId)).send(body).expect(201);
    return response.body.template as { id: string; name: string; criteria: { id: string; label: string; position: number }[] };
  }

  it('creates, lists and retires templates for its own employer, refuses bad input, and never edits one in place', async () => {
    const team = await employer();
    const created = await template(team.employerId, team.recruiterId);
    expect(created).toMatchObject({ name: 'Technical round', guidance: 'Rate what you observed in this interview only.', retiredAt: null });
    expect(created.criteria.map((criterion) => [criterion.position, criterion.label])).toEqual([[1, 'Problem solving'], [2, 'Communication'], [3, 'Code quality']]);
    for (const [body, code] of [
      [{ ...technical, name: 'technical ROUND' }, 'SCORECARD_TEMPLATE_NAME_TAKEN'],
      [{ ...technical, owner: 'me' }, 'INVALID_SCORECARD_TEMPLATE'],
      [{ ...technical, criteria: [] }, 'INVALID_SCORECARD_CRITERIA'],
    ] as const) {
      expect((await api().post(templatesPath(team.employerId)).set(auth(team.recruiterId)).send(body).expect(code === 'SCORECARD_TEMPLATE_NAME_TAKEN' ? 409 : 400)).body.error.code).toBe(code);
    }
    const listed = await api().get(templatesPath(team.employerId)).set(auth(team.ownerId)).expect(200);
    expect(listed.body.templates.map((item: { id: string }) => item.id)).toEqual([created.id]);
    noReadiness(listed.body);

    const rival = await employer();
    expect((await api().get(templatesPath(rival.employerId)).set(auth(rival.recruiterId)).expect(200)).body.templates).toEqual([]);
    await api().post(templatesPath(team.employerId) + '/' + created.id + '/retire').set(auth(rival.recruiterId)).send({ reasonCode: 'NO_LONGER_USED' }).expect(403);
    await api().post(templatesPath(rival.employerId) + '/' + created.id + '/retire').set(auth(rival.recruiterId)).send({ reasonCode: 'NO_LONGER_USED' }).expect(403);

    expect((await api().post(templatesPath(team.employerId) + '/' + created.id + '/retire').set(auth(team.recruiterId)).send({}).expect(400)).body.error.code).toBe('INVALID_REASONCODE');
    const retired = await api().post(templatesPath(team.employerId) + '/' + created.id + '/retire').set(auth(team.recruiterId)).send({ reasonCode: 'REPLACED' }).expect(201);
    expect(retired.body.template.retiredAt).toEqual(expect.any(String));
    await api().post(templatesPath(team.employerId) + '/' + created.id + '/retire').set(auth(team.recruiterId)).send({ reasonCode: 'REPLACED' }).expect(409);
    // A retired name is free again.
    await template(team.employerId, team.recruiterId);

    const audit = await pool.query("SELECT action, organization_id, context FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at", [created.id]);
    expect(audit.rows.map((row) => [row.action, row.organization_id, row.context.reasonCode ?? null])).toEqual([
      ['interview.scorecard_template.created', team.employerId, null], ['interview.scorecard_template.retired', team.employerId, 'REPLACED']]);
    await expect(pool.query("UPDATE interview_scorecard_templates SET name='Other' WHERE id=$1", [created.id])).rejects.toThrow();
    await expect(pool.query("UPDATE interview_scorecard_criteria SET label='Other' WHERE template_id=$1", [created.id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM interview_scorecard_criteria WHERE template_id=$1', [created.id])).rejects.toThrow();
  });

  it('binds a template to an interview stage through a new job version, copies it to the interview, and requires every criterion', async () => {
    const team = await employer();
    const scorecard = await template(team.employerId, team.recruiterId);
    const rival = await employer();
    const foreign = await template(rival.employerId, rival.recruiterId);

    const created = await api().post(employerBase(team.employerId) + '/opportunities').set(auth(team.recruiterId)).send({ referenceCode: 'SC-' + randomUUID().slice(0, 8), ...terms }).expect(201);
    const jobId = created.body.opportunity.id as string;
    const v1 = created.body.opportunity.versionId as string;
    expect((await editStages(team.employerId, team.recruiterId, jobId, v1, [{ kind: 'INTERVIEW', label: 'Technical interview', scorecardTemplateId: foreign.id }]).expect(400)).body.error.code).toBe('UNKNOWN_SCORECARD_TEMPLATE');
    expect((await editStages(team.employerId, team.recruiterId, jobId, v1, [{ kind: 'SCREENING', label: 'Screen', scorecardTemplateId: scorecard.id }]).expect(400)).body.error.code).toBe('INVALID_STAGES');
    await editStages(team.employerId, team.recruiterId, jobId, v1, [{ kind: 'SCREENING', label: 'Screen' }, { kind: 'INTERVIEW', label: 'Technical interview', scorecardTemplateId: scorecard.id }]).expect(201);
    const detail = await api().get(employerBase(team.employerId) + '/opportunities/' + jobId).set(auth(team.recruiterId)).expect(200);
    const stages = detail.body.currentVersion.requirements.stages as { id: string; label: string; scorecardTemplate: { id: string; name: string } | null }[];
    expect(stages.map((stage) => [stage.label, stage.scorecardTemplate])).toEqual([['Screen', null], ['Technical interview', { id: scorecard.id, name: 'Technical round' }]]);

    await api().post(employerBase(team.employerId) + '/opportunities/' + jobId + '/audiences').set(auth(team.recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
    await api().post(employerBase(team.employerId) + '/opportunities/' + jobId + '/publish').set(auth(team.recruiterId)).expect(201);
    const studentId = await user();
    const applicationId = (await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId: jobId, consentGranted: true }).expect(201)).body.application.id as string;
    const hiring = { ...team, opportunityId: jobId, studentId, applicationId };

    expect((await schedule(hiring, { selectionStageId: stages[0]!.id }).expect(400)).body.error.code).toBe('INVALID_SELECTIONSTAGEID');
    expect((await schedule(hiring, { selectionStageId: randomUUID() }).expect(400)).body.error.code).toBe('INVALID_SELECTIONSTAGEID');
    const id = await scheduled(hiring, { selectionStageId: stages[1]!.id });
    const plain = await scheduled(hiring);

    const brief = await api().get(employerBase(team.employerId) + '/my-interviews/' + id).set(auth(team.panelId)).expect(200);
    expect(brief.body.interview.stageLabel).toBe('Technical interview');
    expect(brief.body.interview.scorecardTemplate).toMatchObject({ id: scorecard.id, name: 'Technical round', guidance: 'Rate what you observed in this interview only.' });
    const criteria = brief.body.interview.scorecardTemplate.criteria as { id: string; label: string; guidance: string | null }[];
    expect(criteria.map((criterion) => criterion.label)).toEqual(['Problem solving', 'Communication', 'Code quality']);
    expect(criteria[0]!.guidance).toBe('Breaks the problem down before coding.');

    const outcomePath = employerBase(team.employerId) + '/my-interviews/' + id + '/outcome';
    const rate = (ratings: number[]) => ratings.map((rating, index) => ({ criterionId: criteria[index]!.id, rating }));
    expect((await api().post(outcomePath).set(auth(team.panelId)).send({ recommendation: 'YES' }).expect(400)).body.error.code).toBe('SCORECARD_CRITERIA_REQUIRED');
    expect((await api().post(outcomePath).set(auth(team.panelId)).send({ recommendation: 'YES', criteria: rate([4, 3]) }).expect(400)).body.error.code).toBe('SCORECARD_CRITERIA_MISMATCH');
    expect((await api().post(outcomePath).set(auth(team.panelId)).send({ recommendation: 'YES', criteria: [...rate([4, 3]), { criterionId: foreign.criteria[0]!.id, rating: 5 }] }).expect(400)).body.error.code).toBe('SCORECARD_CRITERIA_MISMATCH');
    await api().post(outcomePath).set(auth(team.panelId)).send({ recommendation: 'YES', strengths: 'Clear reasoning.', criteria: [...rate([4, 3, 2]).slice(0, 2), { criterionId: criteria[2]!.id, rating: 2, note: 'Skipped tests.' }] }).expect(201);
    // A correction replaces the ratings rather than adding to them.
    await api().post(outcomePath).set(auth(team.panelId)).send({ recommendation: 'STRONG_YES', criteria: rate([5, 4, 3]) }).expect(201);
    const stored = await pool.query(`SELECT o.scorecard_template_id, r.rating FROM interview_outcomes o JOIN interview_outcome_criterion_ratings r ON r.outcome_id = o.id
      JOIN interview_scorecard_criteria c ON c.id = r.criterion_id WHERE o.interview_id=$1 ORDER BY c.position`, [id]);
    expect(stored.rows).toEqual([5, 4, 3].map((rating) => ({ scorecard_template_id: scorecard.id, rating })));

    // The recruiter's own route follows the same template.
    const managerPath = employerBase(team.employerId) + '/interviews/' + id + '/outcome';
    expect((await api().post(managerPath).set(auth(team.recruiterId)).send({ recommendation: 'NO' }).expect(400)).body.error.code).toBe('SCORECARD_CRITERIA_REQUIRED');
    await api().post(managerPath).set(auth(team.recruiterId)).send({ recommendation: 'NEUTRAL', criteria: rate([3, 3, 3]) }).expect(201);
    expect((await api().post(employerBase(team.employerId) + '/interviews/' + plain + '/outcome').set(auth(team.recruiterId))
      .send({ recommendation: 'YES', criteria: rate([3, 3, 3]) }).expect(400)).body.error.code).toBe('SCORECARD_TEMPLATE_NOT_SET');
    await api().post(employerBase(team.employerId) + '/interviews/' + plain + '/outcome').set(auth(team.recruiterId)).send({ recommendation: 'YES', overallRating: 4 }).expect(201);

    const scorecards = await api().get(employerBase(team.employerId) + '/interviews/' + id + '/scorecards').set(auth(team.ownerId)).expect(200);
    expect(scorecards.body.template).toMatchObject({ id: scorecard.id, name: 'Technical round' });
    expect(scorecards.body.scorecards.map((card: { submittedBy: string; recommendation: string; ratings: { label: string; rating: number }[] }) =>
      [card.submittedBy, card.recommendation, card.ratings.map((rating) => [rating.label, rating.rating])]).sort()).toEqual([
      [team.panelId + '@example.test', 'STRONG_YES', [['Problem solving', 5], ['Communication', 4], ['Code quality', 3]]],
      [team.recruiterId + '@example.test', 'NEUTRAL', [['Problem solving', 3], ['Communication', 3], ['Code quality', 3]]],
    ].sort());
    noReadiness(scorecards.body);
    const viewed = await pool.query("SELECT organization_id FROM audit_events WHERE action='interview.scorecards.viewed' AND resource_id=$1", [id]);
    expect(viewed.rows).toEqual([{ organization_id: team.employerId }]);

    // The interview keeps its template even when the job's stage later changes.
    await editStages(team.employerId, team.recruiterId, jobId, await currentVersion(jobId), [{ kind: 'INTERVIEW', label: 'Technical interview' }]).expect(201);
    expect((await pool.query('SELECT scorecard_template_id FROM interviews WHERE id=$1', [id])).rows[0].scorecard_template_id).toBe(scorecard.id);
    await expect(pool.query('UPDATE interviews SET scorecard_template_id = NULL WHERE id=$1', [id])).rejects.toThrow();

    // Scorecards are judgements about a named person: no live grant, no scorecards.
    await pool.query('UPDATE employer_applicant_access_grants SET revoked_at = now() WHERE employer_id=$1 AND student_user_id=$2', [team.employerId, studentId]);
    await api().get(employerBase(team.employerId) + '/interviews/' + id + '/scorecards').set(auth(team.ownerId)).expect(403);
  });

  it('carries a stage template forward to the next version when the stages are not edited', async () => {
    const team = await employer();
    const scorecard = await template(team.employerId, team.recruiterId);
    const hiring = await applied([{ kind: 'INTERVIEW', label: 'Panel', scorecardTemplateId: scorecard.id }], team);
    await api().post(employerBase(team.employerId) + '/opportunities/' + hiring.opportunityId + '/versions').set(auth(team.recruiterId))
      .send({ ...terms, summary: 'Build better robots.', expectedCurrentVersionId: await currentVersion(hiring.opportunityId) }).expect(201);
    const detail = await api().get(employerBase(team.employerId) + '/opportunities/' + hiring.opportunityId).set(auth(team.recruiterId)).expect(200);
    expect(detail.body.currentVersion.requirements.stages[0].scorecardTemplate).toEqual({ id: scorecard.id, name: 'Technical round' });
  });
});

describe('EMP-09: §6.3 minimums on the new routes', () => {
  function routes(employerId: string, interviewId: string, templateId: string) {
    const base = employerBase(employerId);
    return [
      { method: 'get', path: base + '/interviews/' + interviewId + '/history' },
      { method: 'get', path: base + '/interviews/' + interviewId + '/scorecards' },
      { method: 'get', path: base + '/my-interviews/' + interviewId + '/calendar' },
      { method: 'get', path: base + '/scorecard-templates' },
      { method: 'post', path: base + '/scorecard-templates', body: { name: 'T ' + randomUUID().slice(0, 6), criteria: [{ label: 'A' }] } },
      { method: 'post', path: base + '/scorecard-templates/' + templateId + '/retire', body: { reasonCode: 'NO_LONGER_USED' } },
    ] as const;
  }
  const call = (route: ReturnType<typeof routes>[number], actor?: string) => {
    const pending = route.method === 'get' ? api().get(route.path) : api().post(route.path).send('body' in route ? route.body : {});
    return actor ? pending.set(auth(actor)) : pending;
  };

  it('needs a token, refuses another employer, and refuses a suspended employer on every route', async () => {
    const hiring = await applied();
    const id = await scheduled(hiring);
    const templateId = (await api().post(employerBase(hiring.employerId) + '/scorecard-templates').set(auth(hiring.recruiterId)).send({ name: 'Round', criteria: [{ label: 'A' }] }).expect(201)).body.template.id;
    for (const route of routes(hiring.employerId, id, templateId)) await call(route).expect(401);
    await api().get('/api/v1/students/me/interviews/' + id + '/calendar').expect(401);
    const rival = await employer();
    for (const route of routes(hiring.employerId, id, templateId)) expect({ path: route.path, status: (await call(route, rival.recruiterId)).status }).toEqual({ path: route.path, status: 403 });
    await reschedule(hiring, id, {}, rival.recruiterId).expect(403);

    await pool.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [hiring.employerId]);
    for (const route of routes(hiring.employerId, id, templateId)) {
      const response = await call(route, route.path.includes('my-interviews') ? hiring.panelId : hiring.recruiterId);
      expect({ path: route.path, status: response.status, code: response.body?.error?.code }).toEqual({ path: route.path, status: 403, code: 'EMPLOYER_ORGANISATION_INACTIVE' });
    }
    expect((await reschedule(hiring, id).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    await drain(null);
  });

  it('lets an unverified employer prepare scorecard templates but not reach a candidate', async () => {
    const team = await employer('PENDING');
    await api().post(employerBase(team.employerId) + '/scorecard-templates').set(auth(team.recruiterId)).send({ name: 'Round', criteria: [{ label: 'A' }] }).expect(201);
    await api().get(employerBase(team.employerId) + '/scorecard-templates').set(auth(team.recruiterId)).expect(200);
    const response = await api().get(employerBase(team.employerId) + '/interviews/' + randomUUID() + '/history').set(auth(team.recruiterId)).expect(403);
    expect(response.body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
  });

  it('keeps participants to their own interviews (unchanged rule)', async () => {
    const hiring = await applied();
    const mine = await scheduled(hiring);
    const other = await scheduled(hiring, { participantUserIds: [hiring.ownerId] });
    const listed = await api().get(employerBase(hiring.employerId) + '/my-interviews').set(auth(hiring.panelId)).expect(200);
    expect(listed.body.interviews.map((row: { id: string }) => row.id)).toEqual([mine]);
    await api().get(employerBase(hiring.employerId) + '/my-interviews/' + other).set(auth(hiring.panelId)).expect(403);
    await api().get(employerBase(hiring.employerId) + '/my-interviews/' + other + '/calendar').set(auth(hiring.panelId)).expect(403);
    await drain(null);
  });
});
