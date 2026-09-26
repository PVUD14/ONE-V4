/**
 * Employer candidate routes honour the student's applicant-access grant (EMP-SR-01, EMP-SR-02).
 *
 * The grant in employer_applicant_access_grants is what a student gives an employer by
 * applying. It ends when the student withdraws, when the application closes, when it
 * expires, and when the student's account enters deletion. These tests hold every employer
 * route that reads or changes one candidate's data to that grant at request time: with a
 * live grant the route works; once the grant ends the next request sees no person and
 * cannot act on them.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@planthepath/persistence/src/schema.js';
import { EmployerAssessmentsController } from './employer-assessments.controller.js';
import { EmployerHiringController } from './employer-hiring.controller.js';
import { StudentHiringController } from './student-hiring.controller.js';
import { executeDueDeletions } from './privacy-deletion.js';
import type { ProtectedHttpRequest } from './api-security.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for employer applicant access integration tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('Employer applicant access integration tests require local Postgres');

const schemaName = `employer_applicant_access_${process.pid}`;
const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
let admin: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let hiring: EmployerHiringController;
let assessments: EmployerAssessmentsController;
let student: StudentHiringController;
let institutionId: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    const text = (await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await pool.query(text);
  }
  db = drizzle(pool, { schema });
  hiring = new EmployerHiringController(db, { uuid: randomUUID });
  assessments = new EmployerAssessmentsController(db, { uuid: randomUUID });
  student = new StudentHiringController(db, { uuid: randomUUID });
  institutionId = randomUUID();
  await db.insert(schema.organizations).values({ id: institutionId, kind: 'INSTITUTION', legalName: 'Grant Test College', verificationState: 'VERIFIED' });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin?.end();
});

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await db.insert(schema.users).values({ id, externalSubject: `test:${id}`, email, state: 'ACTIVE' });
  return { id, email };
}

function trusted(actorId: string, employerId?: string): ProtectedHttpRequest {
  return { headers: {}, planThePath: { correlationId: `test-${randomUUID()}`, verifiedIdentity: {}, authorization: {
    principal: { userId: actorId },
    memberships: employerId ? [{ organizationId: employerId, role: 'RECRUITER', state: 'ACTIVE', scope: { organizationId: employerId, employerId } }] : [],
  } } } as unknown as ProtectedHttpRequest;
}

interface Pipeline {
  readonly employerId: string;
  readonly recruiterId: string;
  readonly candidate: { id: string; email: string; name: string; rollNumber: string };
  readonly opportunityId: string;
  readonly applicationId: string;
  readonly interviewId: string;
  readonly assessmentId: string;
  readonly request: () => ProtectedHttpRequest;
}

/**
 * A verified employer, a recruiter who is also the interview panellist, and one candidate
 * whose application has reached INTERVIEW with a scheduled interview and a screening
 * invitation — everything an employer can hold about one person, reached with a live grant.
 */
async function pipeline(): Promise<Pipeline> {
  const employerId = randomUUID();
  await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Grant Test Employer', verificationState: 'VERIFIED' });
  const recruiter = await seedUser();
  const reviewer = await seedUser();
  for (const member of [recruiter.id, reviewer.id]) {
    await pool.query(`INSERT INTO organization_memberships (id, organization_id, user_id, role, state, scope_organization_id, scope_employer_id)
      VALUES ($1, $2, $3, 'RECRUITER', 'ACTIVE', $2, $2)`, [randomUUID(), employerId, member]);
  }
  const candidateUser = await seedUser();
  const rollNumber = `GRT-${randomUUID().slice(0, 8)}`;
  const name = `Candidate ${randomUUID().slice(0, 8)}`;
  await pool.query(`INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
    VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`, [randomUUID(), institutionId, candidateUser.id, rollNumber, name]);

  const request = () => trusted(recruiter.id, employerId);
  const created = await hiring.createOpportunity(request(), employerId, {
    referenceCode: randomUUID(), title: `Role ${randomUUID()}`, summary: 'Grant test role.',
    employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false,
  });
  const opportunityId = (created.opportunity as { id: string }).id;
  await hiring.addAudience(request(), employerId, opportunityId, { audienceKind: 'PUBLIC' });
  await hiring.publishOpportunity(request(), employerId, opportunityId);
  const applied = await student.apply(trusted(candidateUser.id), { opportunityId, consentGranted: true, institutionVisibilityGranted: false });
  const applicationId = (applied.application as { id: string }).id;

  await hiring.transitionApplication(request(), employerId, applicationId, { toState: 'SHORTLISTED' });
  await hiring.transitionApplication(request(), employerId, applicationId, { toState: 'INTERVIEW' });
  const scheduled = await hiring.scheduleInterview(request(), employerId, applicationId, {
    mode: 'VIDEO', scheduledStart: '2099-01-05T09:00:00.000Z', scheduledEnd: '2099-01-05T10:00:00.000Z',
    joiningLink: 'https://meet.example.test/grant', participantUserIds: [recruiter.id], participantVisibilityAcknowledged: true,
  });
  const interviewId = (scheduled.interview as { id: string }).id;

  const question = await assessments.createQuestion(trusted(recruiter.id, employerId), employerId, {
    questionText: `Which log shows failed logins? ${randomUUID()}`, questionType: 'SINGLE_CHOICE_MCQ', marks: 2,
    options: [{ key: 'A', text: 'Auth log', isCorrect: true }, { key: 'B', text: 'Print log', isCorrect: false }],
  });
  const questionId = (question.question as { id: string }).id;
  await assessments.transitionQuestion(trusted(recruiter.id, employerId), employerId, questionId, { toState: 'UNDER_REVIEW' });
  await assessments.transitionQuestion(trusted(reviewer.id, employerId), employerId, questionId, { toState: 'APPROVED' });
  const assessment = await assessments.createAssessment(trusted(recruiter.id, employerId), employerId, {
    title: 'Screening', durationSeconds: 1800, opportunityId, questionIds: [questionId],
  });
  const assessmentId = (assessment.assessment as { id: string }).id;
  await assessments.publishAssessment(trusted(recruiter.id, employerId), employerId, assessmentId);
  await assessments.invite(trusted(recruiter.id, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });

  return {
    employerId, recruiterId: recruiter.id, candidate: { id: candidateUser.id, email: candidateUser.email, name, rollNumber },
    opportunityId, applicationId, interviewId, assessmentId, request,
  };
}

const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

async function revokeGrant(p: Pipeline): Promise<void> {
  const result = await pool.query(`UPDATE employer_applicant_access_grants SET revoked_at = now()
    WHERE employer_id = $1 AND student_user_id = $2 AND opportunity_id = $3 AND revoked_at IS NULL`, [p.employerId, p.candidate.id, p.opportunityId]);
  expect(result.rowCount).toBe(1);
}

/** The refusal is the shared safe 403 and says nothing about the person. */
async function expectRefused(p: Pipeline, call: Promise<unknown>): Promise<void> {
  const error = await call.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForbiddenException);
  const forbidden = error as ForbiddenException;
  expect(forbidden.getStatus()).toBe(403);
  // Each controller keeps its existing safe refusal: a FORBIDDEN code and a correlation id,
  // with nothing else that could describe the candidate.
  const body = forbidden.getResponse() as { error: Record<string, unknown> };
  expect(body.error.code).toBe('FORBIDDEN');
  expect(Object.keys(body.error).every((key) => ['code', 'message', 'correlationId'].includes(key))).toBe(true);
  expectNoPerson(p, body);
}

function expectNoPerson(p: Pipeline, body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain(p.candidate.email);
  expect(text).not.toContain(p.candidate.name);
  expect(text).not.toContain(p.candidate.rollNumber);
}

function expectPerson(p: Pipeline, body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).toContain(p.candidate.email);
  expect(text).toContain(p.candidate.name);
}

type Row = Record<string, unknown>;
const rowOf = (rows: unknown, key: string, id: string): Row => (rows as Row[]).find((row) => row[key] === id)!;

async function expectAllReadsWithheld(p: Pipeline): Promise<void> {
  const applicants = await hiring.listApplicants(p.request(), p.employerId, p.opportunityId);
  const applicant = rowOf(applicants.applications, 'id', p.applicationId);
  expect(applicant).toMatchObject({ candidateAccess: false, candidateName: null, candidateEmail: null, institutionStudentId: null });
  expectNoPerson(p, applicants);

  const interviews = await hiring.listInterviews(p.request(), p.employerId);
  expect(rowOf(interviews.interviews, 'id', p.interviewId)).toMatchObject({ candidateAccess: false, candidateName: null, candidateEmail: null });
  expectNoPerson(p, interviews);

  const mine = await hiring.listMyInterviews(p.request(), p.employerId);
  const own = rowOf(mine.interviews, 'id', p.interviewId);
  expect(own).toMatchObject({ candidateAccess: false, candidateName: null, candidateEmail: null, canRecordOutcome: false });
  expectNoPerson(p, mine);
  const brief = await hiring.getMyInterview(p.request(), p.employerId, p.interviewId);
  expect(brief.interview).toMatchObject({ candidateAccess: false, candidateName: null, candidateEmail: null, canRecordOutcome: false, joiningLink: null });
  expectNoPerson(p, brief);

  const offers = await hiring.listOffers(p.request(), p.employerId);
  expectNoPerson(p, offers);

  const results = await assessments.results(p.request(), p.employerId, p.assessmentId);
  expect((results.results as Row[]).some((row) => row.applicationId === p.applicationId)).toBe(false);
  expectNoPerson(p, results);
}

describe('EMP-SR-01: a live grant is required for every candidate route', () => {
  it('serves the candidate to every route while the grant is live', async () => {
    const p = await pipeline();
    expectPerson(p, await hiring.listApplicants(p.request(), p.employerId, p.opportunityId));
    expect(rowOf((await hiring.listApplicants(p.request(), p.employerId, p.opportunityId)).applications, 'id', p.applicationId).candidateAccess).toBe(true);
    expectPerson(p, await hiring.listInterviews(p.request(), p.employerId));
    expectPerson(p, await hiring.listMyInterviews(p.request(), p.employerId));
    expectPerson(p, await hiring.getMyInterview(p.request(), p.employerId, p.interviewId));
    expect(JSON.stringify(await assessments.results(p.request(), p.employerId, p.assessmentId))).toContain(p.candidate.email);

    await expect(hiring.submitOutcome(p.request(), p.employerId, p.interviewId, { recommendation: 'YES' })).resolves.toMatchObject({ ok: true });
    await expect(hiring.submitMyOutcome(p.request(), p.employerId, p.interviewId, { recommendation: 'YES' })).resolves.toMatchObject({ ok: true });
    await expect(hiring.updateInterviewState(p.request(), p.employerId, p.interviewId, {
      toState: 'RESCHEDULED', scheduledStart: '2099-01-06T09:00:00.000Z', scheduledEnd: '2099-01-06T10:00:00.000Z',
    })).resolves.toMatchObject({ interview: { state: 'RESCHEDULED' } });
    await expect(hiring.scheduleInterview(p.request(), p.employerId, p.applicationId, {
      mode: 'VIDEO', scheduledStart: '2099-01-07T09:00:00.000Z', scheduledEnd: '2099-01-07T10:00:00.000Z',
    })).resolves.toMatchObject({ interview: { roundNumber: 2 } });
    await expect(hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'OFFER' })).resolves.toMatchObject({ application: { state: 'OFFER' } });
    await expect(hiring.extendOffer(p.request(), p.employerId, p.applicationId, {
      compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-02-01T00:00:00.000Z',
    })).resolves.toMatchObject({ offer: { state: 'EXTENDED' } });
    expectPerson(p, await hiring.listOffers(p.request(), p.employerId));
  });

  it('withholds the person from every read and refuses every write on the next request after the grant is revoked', async () => {
    const p = await pipeline();
    await hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'OFFER' });
    const extended = await hiring.extendOffer(p.request(), p.employerId, p.applicationId, {
      compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-02-01T00:00:00.000Z',
    });
    const offerId = (extended.offer as { id: string }).id;
    await revokeGrant(p);

    await expectAllReadsWithheld(p);
    const offer = rowOf((await hiring.listOffers(p.request(), p.employerId)).offers, 'id', offerId);
    expect(offer).toMatchObject({ candidateAccess: false, candidateName: null, candidateEmail: null, institutionStudentId: null });

    await expectRefused(p, hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'REJECTED' }));
    await expectRefused(p, hiring.scheduleInterview(p.request(), p.employerId, p.applicationId, {
      mode: 'VIDEO', scheduledStart: '2099-01-07T09:00:00.000Z', scheduledEnd: '2099-01-07T10:00:00.000Z',
    }));
    await expectRefused(p, hiring.extendOffer(p.request(), p.employerId, p.applicationId, {
      compensationCurrency: 'INR', compensationAmount: 31000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-02-01T00:00:00.000Z',
    }));
    await expectRefused(p, hiring.submitOutcome(p.request(), p.employerId, p.interviewId, { recommendation: 'NO' }));
    await expectRefused(p, hiring.submitMyOutcome(p.request(), p.employerId, p.interviewId, { recommendation: 'NO' }));
    await expectRefused(p, hiring.updateInterviewState(p.request(), p.employerId, p.interviewId, {
      toState: 'RESCHEDULED', scheduledStart: '2099-01-08T09:00:00.000Z', scheduledEnd: '2099-01-08T10:00:00.000Z',
    }));
    await expectRefused(p, hiring.updateInterviewState(p.request(), p.employerId, p.interviewId, { toState: 'COMPLETED' }));
    await expectRefused(p, assessments.invite(p.request(), p.employerId, p.assessmentId, { applicationIds: [p.applicationId], closesAt: tomorrow() }));

    // Nothing was written by the refused calls.
    const application = await pool.query('SELECT state FROM applications WHERE id = $1', [p.applicationId]);
    expect(application.rows[0].state).toBe('OFFER');
    const outcomes = await pool.query('SELECT count(*)::int AS count FROM interview_outcomes WHERE interview_id = $1', [p.interviewId]);
    expect(outcomes.rows[0].count).toBe(0);
    const offers = await pool.query('SELECT count(*)::int AS count FROM offers WHERE application_id = $1', [p.applicationId]);
    expect(offers.rows[0].count).toBe(1);
    const interviews = await pool.query('SELECT count(*)::int AS count FROM interviews WHERE application_id = $1', [p.applicationId]);
    expect(interviews.rows[0].count).toBe(1);
  });

  it('still lets the employer stand down an interview or an offer once the grant has ended', async () => {
    const p = await pipeline();
    await hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'OFFER' });
    const extended = await hiring.extendOffer(p.request(), p.employerId, p.applicationId, {
      compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-02-01T00:00:00.000Z',
    });
    await revokeGrant(p);

    const cancelled = await hiring.updateInterviewState(p.request(), p.employerId, p.interviewId, { toState: 'CANCELLED', reason: 'Position filled' });
    expect(cancelled).toMatchObject({ interview: { state: 'CANCELLED' } });
    expectNoPerson(p, cancelled);
    const withdrawn = await hiring.withdrawOffer(p.request(), p.employerId, (extended.offer as { id: string }).id);
    expect(withdrawn).toMatchObject({ offer: { state: 'WITHDRAWN' } });
    expectNoPerson(p, withdrawn);
  });

  it('withholds the person once the employer rejects them, and still lets the employer release feedback', async () => {
    const p = await pipeline();
    await hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'REJECTED', reasonCode: 'SKILLS' });

    await expectAllReadsWithheld(p);
    await expectRefused(p, hiring.submitOutcome(p.request(), p.employerId, p.interviewId, { recommendation: 'NO' }));

    const feedback = await hiring.releaseFeedback(p.request(), p.employerId, p.applicationId, { reasonCodes: ['CORE_SKILL_GAP'] });
    expect(feedback).toMatchObject({ feedback: { applicationId: p.applicationId, reasonCodes: ['CORE_SKILL_GAP'] } });
    expectNoPerson(p, feedback);
  });

  it('treats an expired grant as no grant', async () => {
    const p = await pipeline();
    await pool.query(`UPDATE employer_applicant_access_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute'
      WHERE employer_id = $1 AND student_user_id = $2`, [p.employerId, p.candidate.id]);

    await expectAllReadsWithheld(p);
    await expectRefused(p, hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'REJECTED' }));
  });
});

describe('EMP-SR-02: an account entering deletion ends employer access', () => {
  it('withholds the person while a deletion request is open, and restores the view if the student cancels it', async () => {
    const p = await pipeline();
    const requestId = randomUUID();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'grant-test')`, [requestId, p.candidate.id]);

    await expectAllReadsWithheld(p);
    await expectRefused(p, hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'OFFER' }));

    // The grace period exists so the student can change their mind; the grant was never
    // revoked, so cancelling returns the application to where it was.
    await pool.query(`UPDATE privacy_requests SET state = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [requestId]);
    expectPerson(p, await hiring.listApplicants(p.request(), p.employerId, p.opportunityId));
  });

  it('revokes every grant when the deletion is executed', async () => {
    const p = await pipeline();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'grant-test')`, [randomUUID(), p.candidate.id]);

    const summaries = await executeDueDeletions({ db, ids: { uuid: randomUUID } });
    expect(summaries.find((summary) => summary.subjectUserId === p.candidate.id)?.outcome).toBe('COMPLETED');

    const grants = await pool.query('SELECT revoked_at FROM employer_applicant_access_grants WHERE student_user_id = $1', [p.candidate.id]);
    expect(grants.rows.length).toBeGreaterThan(0);
    expect(grants.rows.every((row) => row.revoked_at !== null)).toBe(true);
    await expectAllReadsWithheld(p);
    await expectRefused(p, hiring.transitionApplication(p.request(), p.employerId, p.applicationId, { toState: 'OFFER' }));
  });
});
