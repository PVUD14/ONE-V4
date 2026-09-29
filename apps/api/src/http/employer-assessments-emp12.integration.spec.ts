/**
 * EMP-12 — employer assessments: the acceptance tests.
 *
 * What EMP-12 adds to the 0036 screening tests, proven over real HTTP against a throwaway schema of the
 * local Postgres in DATABASE_URL: ownership isolation from institution question banks both ways; tests
 * sent only at the ASSESSMENT stage; windows and time limits enforced on the database clock; the brief a
 * candidate reads and acknowledges before starting; per-candidate results only through a live
 * applicant-access grant, audited and never ranked; locked, audited, reason-coded writes that refuse
 * unknown fields; students told of an invitation through the outbox; and a suspended employer's tests
 * closed to candidates. Design: docs/architecture/employer-assessment-windows-and-notices-design.md.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for employer assessment tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Employer assessment tests require local Postgres');
const schemaName = 'emp12_' + randomUUID().replaceAll('-', '');
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
}, 120_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const studentBase = '/api/v1/students/me/screening-assessments';
/** A readiness band, score or gap anywhere in an employer response is a failure (§5.3). */
const readinessKeys = /readiness|band|mastery|gap|fit|DEMONSTRATED|PROGRESSING|NOT_ENOUGH_EVIDENCE/i;

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function member(orgId: string, role: string, state = 'ACTIVE'): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$2)`, [randomUUID(), orgId, id, role, state]);
  return id;
}
interface Employer { employerId: string; recruiterId: string; reviewerId: string }
async function employer(): Promise<Employer> {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Screening Employer','VERIFIED',true)", [employerId]);
  return { employerId, recruiterId: await member(employerId, 'RECRUITER'), reviewerId: await member(employerId, 'EMPLOYER_ADMIN') };
}
async function institution(): Promise<{ institutionId: string; staffId: string; subjectId: string; examQuestionId: string }> {
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute','VERIFIED',true)", [institutionId]);
  const staffId = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,'INSTITUTION_ADMIN','ACTIVE',$2,$2)`, [randomUUID(), institutionId, staffId]);
  const subjectId = randomUUID();
  await pool.query('INSERT INTO exam_subjects (id,institution_id,name) VALUES ($1,$2,$3)', [subjectId, institutionId, 'Networks ' + subjectId.slice(0, 6)]);
  const examQuestionId = randomUUID();
  await pool.query(`INSERT INTO exam_questions (id,institution_id,subject_id,question_type,question_text,question_hash,approval_status,created_by_user_id)
    VALUES ($1,$2,$3,'SINGLE_CHOICE_MCQ','Which layer routes packets?',$4,'APPROVED',$5)`, [examQuestionId, institutionId, subjectId, 'h-' + examQuestionId, staffId]);
  await pool.query(`INSERT INTO exam_question_options (id,question_id,option_key,option_text,is_correct,position)
    VALUES ($1,$3,'A','Network',true,0), ($2,$3,'B','Session',false,1)`, [randomUUID(), randomUUID(), examQuestionId]);
  return { institutionId, staffId, subjectId, examQuestionId };
}

/** A question written by the recruiter and approved by the admin (never by its author). */
async function approvedQuestion(hiring: Employer, text = 'Which log shows failed logins? ' + randomUUID().slice(0, 8)): Promise<string> {
  const created = await api().post(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.recruiterId)).send({
    questionText: text, questionType: 'SINGLE_CHOICE_MCQ', marks: 2,
    options: [{ key: 'A', text: 'Correct answer', isCorrect: true }, { key: 'B', text: 'Wrong answer', isCorrect: false }, { key: 'C', text: 'Also wrong', isCorrect: false }],
  }).expect(201);
  const id = created.body.question.id as string;
  await api().post(base(hiring.employerId) + '/assessment-questions/' + id + '/transition').set(auth(hiring.recruiterId)).send({ toState: 'UNDER_REVIEW' }).expect(201);
  await api().post(base(hiring.employerId) + '/assessment-questions/' + id + '/transition').set(auth(hiring.reviewerId)).send({ toState: 'APPROVED' }).expect(201);
  return id;
}
async function publishedJob(hiring: Employer): Promise<string> {
  const created = await api().post(base(hiring.employerId) + '/opportunities').set(auth(hiring.recruiterId)).send({
    referenceCode: 'E12-' + randomUUID().slice(0, 8), title: 'Security analyst', summary: 'Watch the logs.', employmentType: 'FULL_TIME',
    workMode: 'REMOTE', compensationDisclosed: false,
  }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(hiring.employerId) + '/opportunities/' + id + '/audiences').set(auth(hiring.recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(hiring.employerId) + '/opportunities/' + id + '/publish').set(auth(hiring.recruiterId)).expect(201);
  return id;
}
async function applicant(hiring: Employer, opportunityId: string, stage: string | null = 'ASSESSMENT'): Promise<{ studentId: string; applicationId: string }> {
  const studentId = await user();
  const applied = await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true }).expect(201);
  const applicationId = applied.body.application.id as string;
  if (stage) await api().post(base(hiring.employerId) + '/applications/' + applicationId + '/transition').set(auth(hiring.recruiterId)).send({ toState: stage }).expect(201);
  return { studentId, applicationId };
}
async function publishedAssessment(hiring: Employer, opportunityId: string | null, durationSeconds = 1800): Promise<string> {
  const question = await approvedQuestion(hiring);
  const created = await api().post(base(hiring.employerId) + '/assessments').set(auth(hiring.recruiterId)).send({
    title: 'Log triage screen', durationSeconds, opportunityId, questionIds: [question],
  }).expect(201);
  const id = created.body.assessment.id as string;
  await api().post(base(hiring.employerId) + '/assessments/' + id + '/publish').set(auth(hiring.recruiterId)).expect(201);
  return id;
}
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
function invite(hiring: Employer, assessmentId: string, applicationIds: string[], extra: Record<string, unknown> = {}) {
  return api().post(base(hiring.employerId) + '/assessments/' + assessmentId + '/invitations').set(auth(hiring.recruiterId))
    .send({ applicationIds, closesAt: inDays(3), ...extra });
}
async function invitationFor(assessmentId: string, applicationId: string): Promise<string> {
  const row = await pool.query('SELECT id FROM employer_assessment_invitations WHERE assessment_id=$1 AND application_id=$2', [assessmentId, applicationId]);
  return row.rows[0].id as string;
}
/** A candidate with a live invitation to a one-question test, ready to start. */
async function invitedCandidate(durationSeconds = 1800) {
  const hiring = await employer();
  const opportunityId = await publishedJob(hiring);
  const assessmentId = await publishedAssessment(hiring, opportunityId, durationSeconds);
  const candidate = await applicant(hiring, opportunityId);
  await invite(hiring, assessmentId, [candidate.applicationId]).expect(201);
  return { hiring, opportunityId, assessmentId, ...candidate, invitationId: await invitationFor(assessmentId, candidate.applicationId) };
}
interface Paper { id: string; questions: { questionId: string; options: { key: string; text: string }[] }[]; remainingSeconds: number }
async function start(studentId: string, invitationId: string): Promise<Paper> {
  const started = await api().post(studentBase + '/' + invitationId + '/start').set(auth(studentId)).send({ acknowledged: true }).expect(201);
  return started.body.attempt as Paper;
}
function correctKey(paper: Paper): string {
  return paper.questions[0]!.options.find((option) => option.text === 'Correct answer')!.key;
}
async function answer(studentId: string, paper: Paper, keys: string[]) {
  return api().post('/api/v1/students/me/screening-attempts/' + paper.id + '/answers').set(auth(studentId))
    .send({ questionId: paper.questions[0]!.questionId, selectedOptionKeys: keys });
}
async function audits(action: string, resourceId?: string) {
  const rows = await pool.query('SELECT actor_user_id, organization_id, context FROM audit_events WHERE action=$1 AND ($2::text IS NULL OR resource_id=$2) ORDER BY occurred_at',
    [action, resourceId ?? null]);
  return rows.rows as { actor_user_id: string; organization_id: string | null; context: Record<string, unknown> }[];
}

describe('EMP-12: employers cannot see or reuse institution question banks, and the reverse', () => {
  it('keeps each bank to its owner at the API and in the schema', async () => {
    const hiring = await employer();
    const college = await institution();
    const employerQuestion = await approvedQuestion(hiring);

    // An employer member reaches no institution bank, not even by naming their own organisation.
    await api().get('/api/v1/institutions/' + college.institutionId + '/assessment-questions').set(auth(hiring.recruiterId)).expect(403);
    await api().get('/api/v1/institutions/' + hiring.employerId + '/assessment-questions').set(auth(hiring.recruiterId)).expect(403);
    // An institution question cannot be put into an employer test.
    const borrowed = await api().post(base(hiring.employerId) + '/assessments').set(auth(hiring.recruiterId)).send({
      title: 'Borrowed', durationSeconds: 1800, opportunityId: null, questionIds: [college.examQuestionId],
    }).expect(400);
    expect(borrowed.body.error.code).toBe('QUESTIONS_NOT_APPROVED');

    // Institution staff reach no employer bank or result.
    await api().get(base(hiring.employerId) + '/assessment-questions').set(auth(college.staffId)).expect(403);
    await api().get(base(college.institutionId) + '/assessment-questions').set(auth(college.staffId)).expect(403);
    // An employer question cannot be pooled into an institution exam.
    const pooled = await api().post('/api/v1/institutions/' + college.institutionId + '/assessments').set(auth(college.staffId)).send({
      subjectId: college.subjectId, title: 'Mid exam', assessmentKind: 'MID_EXAM', durationSeconds: 3600,
      startsAt: inDays(1), endsAt: inDays(2), totalMarks: 1,
      sections: [{ title: 'A', poolSize: 1, displayCount: 1, marksPerQuestion: 1, questionIds: [employerQuestion] }],
    }).expect(400);
    expect(pooled.body.error.code).toBe('POOL_REQUIRES_APPROVED_SUBJECT_QUESTIONS');

    // And the schema cannot express either borrowing.
    const draft = await api().post(base(hiring.employerId) + '/assessments').set(auth(hiring.recruiterId))
      .send({ title: 'Wall', durationSeconds: 1800, opportunityId: null, questionIds: [employerQuestion] }).expect(201);
    await expect(pool.query(`INSERT INTO employer_assessment_items (id,assessment_id,employer_id,question_id,sequence,marks)
      VALUES ($1,$2,$3,$4,2,1)`, [randomUUID(), draft.body.assessment.id, hiring.employerId, college.examQuestionId])).rejects.toThrow();
    const sectionId = randomUUID();
    const definitionId = randomUUID();
    await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,total_marks,duration_seconds,starts_at,ends_at,created_by_user_id)
      VALUES ($1,$2,$3,'Wall','MID_EXAM',1,3600,now(),now()+interval '1 day',$4)`, [definitionId, college.institutionId, college.subjectId, college.staffId]);
    await pool.query(`INSERT INTO exam_sections (id,institution_id,definition_id,title,pool_size,display_count,marks_per_question,position)
      VALUES ($1,$2,$3,'A',1,1,1,0)`, [sectionId, college.institutionId, definitionId]);
    await expect(pool.query('INSERT INTO exam_section_pool (section_id,question_id,institution_id,question_version) VALUES ($1,$2,$3,1)',
      [sectionId, employerQuestion, college.institutionId])).rejects.toThrow();
  });

  it('offers employers no coding question until a sandbox exists', async () => {
    const hiring = await employer();
    for (const questionType of ['CODING', 'FILL_IN_THE_BLANK', 'MATCH_THE_FOLLOWING']) {
      const refused = await api().post(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.recruiterId)).send({
        questionText: 'Write a function ' + randomUUID().slice(0, 6), questionType, marks: 1,
        options: [{ key: 'A', text: 'x', isCorrect: true }, { key: 'B', text: 'y', isCorrect: false }],
      }).expect(400);
      expect(refused.body.error.code).toBe('INVALID_QUESTIONTYPE');
    }
  });
});

describe('EMP-12: tests go to applicants at the ASSESSMENT stage, in a window set on the database clock', () => {
  it('refuses an application before the assessment stage and accepts it there, audited and announced', async () => {
    const hiring = await employer();
    const opportunityId = await publishedJob(hiring);
    const assessmentId = await publishedAssessment(hiring, opportunityId);
    const early = await applicant(hiring, opportunityId, 'SHORTLISTED');
    expect((await invite(hiring, assessmentId, [early.applicationId]).expect(400)).body.error.code).toBe('APPLICATION_NOT_INVITABLE');

    await api().post(base(hiring.employerId) + '/applications/' + early.applicationId + '/transition').set(auth(hiring.recruiterId)).send({ toState: 'ASSESSMENT' }).expect(201);
    const sent = await invite(hiring, assessmentId, [early.applicationId]).expect(201);
    expect(sent.body.invited).toBe(1);
    const invitationId = await invitationFor(assessmentId, early.applicationId);
    expect(await audits('employer.assessment_invitation.created', invitationId)).toEqual([
      expect.objectContaining({ actor_user_id: hiring.recruiterId, organization_id: hiring.employerId }),
    ]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='employer_assessment.invited' AND aggregate_id=$1", [invitationId]);
    expect(outbox.rows).toEqual([{ payload: { invitationId, applicationId: early.applicationId, assessmentId } }]);
    // Sending a test never moves the candidate: a person does that.
    expect((await pool.query('SELECT state FROM applications WHERE id=$1', [early.applicationId])).rows[0].state).toBe('ASSESSMENT');
  });

  it('refuses a window that is past, backwards, too long or has unknown fields, and writes nothing', async () => {
    const hiring = await employer();
    const opportunityId = await publishedJob(hiring);
    const assessmentId = await publishedAssessment(hiring, opportunityId);
    const { applicationId } = await applicant(hiring, opportunityId);
    const cases: [Record<string, unknown>, string][] = [
      [{ closesAt: new Date(Date.now() - 60_000).toISOString() }, 'INVALID_WINDOW'],
      [{ opensAt: inDays(2), closesAt: inDays(1) }, 'INVALID_WINDOW'],
      [{ closesAt: inDays(31) }, 'INVALID_WINDOW'],
      [{ opensAt: new Date(Date.now() - 3_600_000).toISOString() }, 'INVALID_WINDOW'],
      [{ closesAt: 'soon' }, 'INVALID_CLOSESAT'],
      [{ note: 'hello' }, 'UNKNOWN_FIELD'],
    ];
    for (const [extra, code] of cases) {
      const refused = await invite(hiring, assessmentId, [applicationId], extra).expect(400);
      expect({ extra, code: refused.body.error.code }).toEqual({ extra, code });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM employer_assessment_invitations WHERE assessment_id=$1', [assessmentId])).rows[0].n).toBe(0);
  });

  it('opens and closes the window on the server, and expires an untouched invitation', async () => {
    const { studentId, invitationId } = await invitedCandidate();
    await pool.query("UPDATE employer_assessment_invitations SET opens_at = now() + interval '1 hour' WHERE id=$1", [invitationId]);
    const early = await api().post(studentBase + '/' + invitationId + '/start').set(auth(studentId)).send({ acknowledged: true }).expect(400);
    expect(early.body.error.code).toBe('ASSESSMENT_NOT_OPEN_YET');

    await pool.query("UPDATE employer_assessment_invitations SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 second' WHERE id=$1", [invitationId]);
    const late = await api().post(studentBase + '/' + invitationId + '/start').set(auth(studentId)).send({ acknowledged: true }).expect(400);
    expect(late.body.error.code).toBe('ASSESSMENT_WINDOW_CLOSED');
    const listed = await api().get(studentBase).set(auth(studentId)).expect(200);
    expect(listed.body.invitations).toEqual([expect.objectContaining({ id: invitationId, state: 'EXPIRED', available: false })]);
    expect((await pool.query('SELECT state FROM employer_assessment_invitations WHERE id=$1', [invitationId])).rows[0].state).toBe('EXPIRED');
  });

  it('enforces the time limit: no answer after the deadline, and what was saved in time is graded', async () => {
    const { hiring, studentId, applicationId, invitationId } = await invitedCandidate(300);
    const paper = await start(studentId, invitationId);
    expect(paper.remainingSeconds).toBeGreaterThan(290);
    expect(paper.remainingSeconds).toBeLessThanOrEqual(300);
    await answer(studentId, paper, [correctKey(paper)]).expect(201);

    // Five minutes and one second later, by the database's clock.
    await pool.query("UPDATE employer_assessment_attempts SET started_at = now() - interval '301 seconds' WHERE id=$1", [paper.id]);
    const wrongKey = paper.questions[0]!.options.find((option) => option.text === 'Wrong answer')!.key;
    expect((await answer(studentId, paper, [wrongKey]).expect(400)).body.error.code).toBe('ATTEMPT_TIME_OVER');

    const attempt = await pool.query(`SELECT state, percentage::float AS percentage, submitted_at = started_at + interval '300 seconds' AS at_deadline
      FROM employer_assessment_attempts WHERE id=$1`, [paper.id]);
    expect(attempt.rows[0]).toEqual({ state: 'SUBMITTED', percentage: 100, at_deadline: true });
    const view = await api().get(base(hiring.employerId) + '/applications/' + applicationId + '/assessment-results').set(auth(hiring.recruiterId)).expect(200);
    expect(view.body.assessments).toEqual([expect.objectContaining({ invitationId, state: 'SUBMITTED', endedBy: 'TIME_LIMIT', percentage: 100 })]);
    // The submit that comes too late returns the same stored result and changes nothing.
    const again = await api().post('/api/v1/students/me/screening-attempts/' + paper.id + '/submit').set(auth(studentId)).send({}).expect(201);
    expect(again.body.result.percentage).toBe(100);
  });

  it('cuts the time short at the window\'s close, and finalises an abandoned attempt when the employer reads', async () => {
    const { hiring, assessmentId, studentId, invitationId } = await invitedCandidate();
    const paper = await start(studentId, invitationId);
    await answer(studentId, paper, [correctKey(paper)]).expect(201);
    await pool.query("UPDATE employer_assessment_invitations SET closes_at = now() - interval '1 second' WHERE id=$1", [invitationId]);

    const results = await api().get(base(hiring.employerId) + '/assessments/' + assessmentId + '/results').set(auth(hiring.recruiterId)).expect(200);
    expect(results.body.results).toEqual([expect.objectContaining({ invitationId, state: 'SUBMITTED', percentage: 100, endedBy: 'TIME_LIMIT' })]);
    const row = await pool.query(`SELECT t.submitted_at = v.closes_at AS at_close FROM employer_assessment_attempts t
      JOIN employer_assessment_invitations v ON v.id = t.invitation_id WHERE t.id=$1`, [paper.id]);
    expect(row.rows[0].at_close).toBe(true);
  });
});

describe('EMP-12: the candidate sees what they are assessed on, and agrees before starting', () => {
  it('shows the brief without any answer, and will not start without an acknowledgement', async () => {
    const { studentId, invitationId, hiring } = await invitedCandidate(1200);
    const brief = await api().get(studentBase + '/' + invitationId).set(auth(studentId)).expect(200);
    expect(brief.body.assessment).toEqual(expect.objectContaining({
      id: invitationId, title: 'Log triage screen', employerName: 'Synthetic Screening Employer', roleTitle: 'Security analyst',
      durationSeconds: 1200, questionCount: 1, totalMarks: 2, available: true,
      questionFormats: [{ questionType: 'SINGLE_CHOICE_MCQ', count: 1 }],
      rules: expect.objectContaining({ oneSitting: true, cameraOrMicrophone: false, screenCapture: false, resultGoesTo: 'EMPLOYER_FOR_THIS_APPLICATION', learningEvidence: false, readinessChanged: false }),
    }));
    expect(brief.body.assessment.minutesAvailableIfStartedNow).toBe(20);
    expect(JSON.stringify(brief.body)).not.toMatch(/isCorrect|is_correct|correctOptionKeys|answerKey|Correct answer/);
    // Another student cannot read it.
    await api().get(studentBase + '/' + invitationId).set(auth(await user())).expect(403);

    for (const body of [{}, { acknowledged: false }, { acknowledged: true, proctored: false }]) {
      const refused = await api().post(studentBase + '/' + invitationId + '/start').set(auth(studentId)).send(body).expect(400);
      expect(refused.body.error.code).toMatch(/^(ASSESSMENT_ACKNOWLEDGEMENT_REQUIRED|UNKNOWN_FIELD)$/);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM employer_assessment_attempts WHERE invitation_id=$1', [invitationId])).rows[0].n).toBe(0);
    const paper = await start(studentId, invitationId);
    const started = await audits('student.screening_assessment.started', paper.id);
    expect(started).toEqual([expect.objectContaining({ actor_user_id: studentId, organization_id: hiring.employerId, context: expect.objectContaining({ acknowledged: true }) })]);
  });
});

describe('EMP-12: results reach the employer only through a live access grant', () => {
  it('shows one candidate\'s results with a per-question breakdown, audited, and nothing about readiness', async () => {
    const { hiring, studentId, applicationId, invitationId } = await invitedCandidate();
    const paper = await start(studentId, invitationId);
    await answer(studentId, paper, [correctKey(paper)]).expect(201);
    await api().post('/api/v1/students/me/screening-attempts/' + paper.id + '/submit').set(auth(studentId)).send({}).expect(201);

    const view = await api().get(base(hiring.employerId) + '/applications/' + applicationId + '/assessment-results').set(auth(hiring.recruiterId)).expect(200);
    expect(view.body.assessments).toEqual([expect.objectContaining({
      invitationId, title: 'Log triage screen', state: 'SUBMITTED', score: 2, maxScore: 2, percentage: 100, endedBy: 'CANDIDATE',
      questions: [expect.objectContaining({ displayOrder: 1, marks: 2, marksAwarded: 2, answered: true })],
    })]);
    expect(JSON.stringify(view.body)).not.toMatch(readinessKeys);
    expect(await audits('employer.candidate_assessment_results.viewed', applicationId)).toEqual([
      expect.objectContaining({ actor_user_id: hiring.recruiterId, organization_id: hiring.employerId }),
    ]);

    // Withdrawal revokes the grant: the next read is refused and the row leaves the list.
    await api().post('/api/v1/students/me/applications/' + applicationId + '/withdraw').set(auth(studentId)).send({}).expect(201);
    await api().get(base(hiring.employerId) + '/applications/' + applicationId + '/assessment-results').set(auth(hiring.recruiterId)).expect(403);
    const listed = await api().get(base(hiring.employerId) + '/assessments/' + (await pool.query('SELECT assessment_id FROM employer_assessment_invitations WHERE id=$1', [invitationId])).rows[0].assessment_id + '/results')
      .set(auth(hiring.recruiterId)).expect(200);
    expect(listed.body.results).toEqual([]);
  });

  it('lists results in invitation order, never by score, a page at a time, and audits each read', async () => {
    const hiring = await employer();
    const opportunityId = await publishedJob(hiring);
    const assessmentId = await publishedAssessment(hiring, opportunityId);
    const first = await applicant(hiring, opportunityId);
    const second = await applicant(hiring, opportunityId);
    await invite(hiring, assessmentId, [first.applicationId]).expect(201);
    await invite(hiring, assessmentId, [second.applicationId]).expect(201);
    // The first candidate scores 0, the second 100.
    const lowPaper = await start(first.studentId, await invitationFor(assessmentId, first.applicationId));
    await api().post('/api/v1/students/me/screening-attempts/' + lowPaper.id + '/submit').set(auth(first.studentId)).send({}).expect(201);
    const highPaper = await start(second.studentId, await invitationFor(assessmentId, second.applicationId));
    await answer(second.studentId, highPaper, [correctKey(highPaper)]).expect(201);
    await api().post('/api/v1/students/me/screening-attempts/' + highPaper.id + '/submit').set(auth(second.studentId)).send({}).expect(201);

    const path = base(hiring.employerId) + '/assessments/' + assessmentId + '/results';
    const all = await api().get(path).set(auth(hiring.recruiterId)).expect(200);
    expect(all.body.results.map((row: { applicationId: string }) => row.applicationId)).toEqual([first.applicationId, second.applicationId]);
    const page = await api().get(path + '?limit=1').set(auth(hiring.recruiterId)).expect(200);
    expect(page.body.results).toHaveLength(1);
    const next = await api().get(path + '?limit=1&cursor=' + encodeURIComponent(page.body.nextCursor)).set(auth(hiring.recruiterId)).expect(200);
    expect(next.body.results[0].applicationId).toBe(second.applicationId);
    expect(next.body.nextCursor).toBeNull();
    for (const bad of ['?limit=0', '?limit=201', '?cursor=nonsense']) await api().get(path + bad).set(auth(hiring.recruiterId)).expect(400);
    expect(JSON.stringify(all.body)).not.toMatch(readinessKeys);
    expect((await audits('employer.assessment_results.viewed', assessmentId)).length).toBe(3);
  });
});

describe('EMP-12: employer writes are locked, audited, reason-coded and strict', () => {
  it('requires a listed reason to reject or archive a question and to close a test, and refuses unknown fields', async () => {
    const hiring = await employer();
    const created = await api().post(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.recruiterId)).send({
      questionText: 'Pick the odd one out ' + randomUUID().slice(0, 6), questionType: 'TRUE_FALSE', marks: 1,
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    }).expect(201);
    const questionId = created.body.question.id as string;
    expect(await audits('employer.assessment_question.created', questionId)).toEqual([expect.objectContaining({ organization_id: hiring.employerId })]);
    const path = base(hiring.employerId) + '/assessment-questions/' + questionId + '/transition';
    await api().post(path).set(auth(hiring.recruiterId)).send({ toState: 'UNDER_REVIEW' }).expect(201);
    expect((await api().post(path).set(auth(hiring.reviewerId)).send({ toState: 'REJECTED' }).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await api().post(path).set(auth(hiring.reviewerId)).send({ toState: 'REJECTED', reasonCode: 'BECAUSE' }).expect(400)).body.error.code).toBe('INVALID_REASONCODE');
    expect((await api().post(path).set(auth(hiring.reviewerId)).send({ toState: 'REJECTED', reasonCode: 'AMBIGUOUS', extra: 1 }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    await api().post(path).set(auth(hiring.reviewerId)).send({ toState: 'REJECTED', reasonCode: 'AMBIGUOUS' }).expect(201);
    expect(await audits('employer.assessment_question.rejected', questionId)).toEqual([
      expect.objectContaining({ actor_user_id: hiring.reviewerId, organization_id: hiring.employerId, context: expect.objectContaining({ reasonCode: 'AMBIGUOUS', fromState: 'UNDER_REVIEW' }) }),
    ]);
    const unknownQuestionField = await api().post(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.recruiterId)).send({
      questionText: 'Another ' + randomUUID().slice(0, 6), questionType: 'TRUE_FALSE', marks: 1, candidateGender: 'any',
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    }).expect(400);
    expect(unknownQuestionField.body.error.code).toBe('UNKNOWN_FIELD');

    const opportunityId = await publishedJob(hiring);
    const assessmentId = await publishedAssessment(hiring, opportunityId);
    expect(await audits('employer.assessment.published', assessmentId)).toHaveLength(1);
    const close = base(hiring.employerId) + '/assessments/' + assessmentId + '/close';
    expect((await api().post(close).set(auth(hiring.recruiterId)).send({}).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    await api().post(close).set(auth(hiring.recruiterId)).send({ reasonCode: 'ROLE_FILLED' }).expect(201);
    expect(await audits('employer.assessment.closed', assessmentId)).toEqual([expect.objectContaining({ context: expect.objectContaining({ reasonCode: 'ROLE_FILLED' }) })]);
    const { applicationId } = await applicant(hiring, opportunityId);
    expect((await invite(hiring, assessmentId, [applicationId]).expect(400)).body.error.code).toBe('ASSESSMENT_NOT_PUBLISHED');
    await api().post(close).set(auth(hiring.recruiterId)).send({ reasonCode: 'ROLE_FILLED' }).expect(400);
  });

  it('flags a question that names a protected attribute to its author and its reviewer', async () => {
    const hiring = await employer();
    const created = await api().post(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.recruiterId)).send({
      questionText: 'What is your religion? ' + randomUUID().slice(0, 6), questionType: 'TRUE_FALSE', marks: 1,
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    }).expect(201);
    expect(created.body.question.mentionsProtectedAttribute).toBe(true);
    const bank = await api().get(base(hiring.employerId) + '/assessment-questions').set(auth(hiring.reviewerId)).expect(200);
    expect(bank.body.questions.find((question: { id: string }) => question.id === created.body.question.id).mentionsProtectedAttribute).toBe(true);
  });

  it('meets the §6.3 minimums: 401, another employer, an ended membership', async () => {
    const { hiring, applicationId, assessmentId } = await invitedCandidate();
    const rival = await employer();
    await api().get(base(hiring.employerId) + '/applications/' + applicationId + '/assessment-results').expect(401);
    await api().get(base(hiring.employerId) + '/applications/' + applicationId + '/assessment-results').set(auth(rival.recruiterId)).expect(403);
    await api().get(base(rival.employerId) + '/applications/' + applicationId + '/assessment-results').set(auth(rival.recruiterId)).expect(403);
    await api().post(base(hiring.employerId) + '/assessments/' + assessmentId + '/close').set(auth(rival.recruiterId)).send({ reasonCode: 'ROLE_FILLED' }).expect(403);
    const ended = await member(hiring.employerId, 'RECRUITER', 'SUSPENDED');
    await api().get(base(hiring.employerId) + '/assessments/' + assessmentId + '/results').set(auth(ended)).expect(403);
    await api().get(studentBase).expect(401);
  });
});

describe('EMP-12: a suspended employer\'s tests are closed to candidates (EMP-SR-14)', () => {
  it('marks the invitation unavailable and refuses start, answer and submit', async () => {
    const { hiring, studentId, invitationId, assessmentId, applicationId } = await invitedCandidate();
    const paper = await start(studentId, invitationId);
    await pool.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [hiring.employerId]);

    const listed = await api().get(studentBase).set(auth(studentId)).expect(200);
    expect(listed.body.invitations).toEqual([expect.objectContaining({ id: invitationId, available: false })]);
    expect((await api().post(studentBase + '/' + invitationId + '/start').set(auth(studentId)).send({ acknowledged: true }).expect(403)).body.error.code).toBe('ASSESSMENT_UNAVAILABLE');
    expect((await answer(studentId, paper, [correctKey(paper)]).expect(403)).body.error.code).toBe('ASSESSMENT_UNAVAILABLE');
    await api().post('/api/v1/students/me/screening-attempts/' + paper.id + '/submit').set(auth(studentId)).send({}).expect(403);
    const refused = await invite(hiring, assessmentId, [applicationId]).expect(403);
    expect(refused.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
  });
});

describe('EMP-12: the student is told about an invitation through the outbox', () => {
  async function drain(): Promise<void> {
    const local = createLocalIntegrationEventPublisher({ pool, db });
    for (let round = 0; round < 20; round += 1) {
      const result = await publishOutboxOnce({ db, publisher: local.publisher, leaseOwner: 'emp12-test', now: new Date(Date.now() + 5_000) });
      if (result.claimed === 0) break;
    }
  }
  async function notes(userId: string) {
    const response = await api().get('/api/v1/me/notifications').set(auth(userId)).expect(200);
    return (response.body.notifications as { kind: string; title: string; body: string }[]).filter((note) => note.kind === 'ASSESSMENT_INVITED');
  }

  it('writes one in-app notice naming the employer, role and test, with no score or identifier', async () => {
    const { studentId, invitationId, applicationId } = await invitedCandidate();
    await drain();
    const received = await notes(studentId);
    expect(received).toEqual([expect.objectContaining({
      title: 'Screening test: Security analyst',
      body: expect.stringContaining('Synthetic Screening Employer sent you a screening test, Log triage screen, for Security analyst.'),
    })]);
    const text = JSON.stringify(received);
    expect(text).not.toMatch(/score|readiness|band|percentage/i);
    for (const id of [invitationId, applicationId]) expect(text).not.toContain(id);
    const delivery = await pool.query("SELECT kind, email_state FROM hiring_notification_deliveries WHERE application_id=$1 AND kind='ASSESSMENT_INVITED'", [applicationId]);
    expect(delivery.rows).toEqual([{ kind: 'ASSESSMENT_INVITED', email_state: 'NOT_CONFIGURED' }]);
    await drain();
    expect(await notes(studentId)).toHaveLength(1);
  });

  it('sends nothing once the application is no longer shared', async () => {
    const { studentId, applicationId } = await invitedCandidate();
    await api().post('/api/v1/students/me/applications/' + applicationId + '/withdraw').set(auth(studentId)).send({}).expect(201);
    await drain();
    expect(await notes(studentId)).toEqual([]);
  });
});
