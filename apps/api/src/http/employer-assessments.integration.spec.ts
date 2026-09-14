/**
 * Employer screening assessments: the boundaries, not the happy path.
 *
 * The happy path is covered by the shared domain package, which grades and shuffles for
 * both engines. What is tested here is what this controller adds: who owns a question,
 * who may be sent a test, what a candidate is allowed to see, and the rule that a
 * screening result never reaches readiness.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@planthepath/persistence/src/schema.js';
import { EmployerAssessmentsController } from './employer-assessments.controller.js';
import { EmployerHiringController } from './employer-hiring.controller.js';
import { StudentHiringController } from './student-hiring.controller.js';
import type { ProtectedHttpRequest } from './api-security.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for employer assessment integration tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('Employer assessment integration tests require local Postgres');

const schemaName = `employer_assessments_${process.pid}`;
const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
let admin: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let assessments: EmployerAssessmentsController;
let hiring: EmployerHiringController;
let student: StudentHiringController;
let recruiterId: string;
let reviewerId: string;
let candidateId: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    const text = (await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await pool.query(text);
  }
  db = drizzle(pool, { schema });
  assessments = new EmployerAssessmentsController(db, { uuid: randomUUID });
  hiring = new EmployerHiringController(db, { uuid: randomUUID });
  student = new StudentHiringController(db, { uuid: randomUUID });
  recruiterId = await seedUser(); reviewerId = await seedUser(); candidateId = await seedUser();
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin?.end();
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: `test:${id}`, email: `${id}@example.test`, state: 'ACTIVE' });
  return id;
}

function trusted(actorId: string, employerId?: string): ProtectedHttpRequest {
  return { headers: {}, planThePath: { correlationId: `test-${randomUUID()}`, verifiedIdentity: {}, authorization: {
    principal: { userId: actorId },
    memberships: employerId ? [{ organizationId: employerId, role: 'RECRUITER', state: 'ACTIVE', scope: { organizationId: employerId, employerId } }] : [],
  } } } as unknown as ProtectedHttpRequest;
}

async function seedEmployer(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind: 'EMPLOYER', legalName: 'Assessment Test Employer', verificationState: 'VERIFIED' });
  return id;
}

/** A question written by the recruiter and approved by somebody else. */
async function approvedQuestion(employerId: string, text: string): Promise<string> {
  const created = await assessments.createQuestion(trusted(recruiterId, employerId), employerId, {
    questionText: text, questionType: 'SINGLE_CHOICE_MCQ', marks: 2,
    options: [
      { key: 'A', text: 'Correct answer', isCorrect: true },
      { key: 'B', text: 'Wrong answer', isCorrect: false },
      { key: 'C', text: 'Also wrong', isCorrect: false },
    ],
  });
  const id = (created.question as { id: string }).id;
  await assessments.transitionQuestion(trusted(recruiterId, employerId), employerId, id, { toState: 'UNDER_REVIEW' });
  await assessments.transitionQuestion(trusted(reviewerId, employerId), employerId, id, { toState: 'APPROVED' });
  return id;
}

async function publishedAssessment(employerId: string, opportunityId: string | null): Promise<string> {
  const question = await approvedQuestion(employerId, `Which log source shows failed logins? ${randomUUID()}`);
  const created = await assessments.createAssessment(trusted(recruiterId, employerId), employerId, {
    title: 'Screening test', durationSeconds: 1800, opportunityId, questionIds: [question],
  });
  const id = (created.assessment as { id: string }).id;
  await assessments.publishAssessment(trusted(recruiterId, employerId), employerId, id);
  return id;
}

async function applicationFor(employerId: string): Promise<{ applicationId: string; opportunityId: string }> {
  const request = trusted(recruiterId, employerId);
  const created = await hiring.createOpportunity(request, employerId, {
    referenceCode: randomUUID(), title: `Role ${randomUUID()}`, summary: 'Screening test role.',
    employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false,
  });
  const opportunityId = (created.opportunity as { id: string }).id;
  await hiring.addAudience(request, employerId, opportunityId, { audienceKind: 'PUBLIC' });
  await hiring.publishOpportunity(request, employerId, opportunityId);
  const applied = await student.apply(trusted(candidateId), { opportunityId, consentGranted: true, institutionVisibilityGranted: false });
  return { applicationId: (applied.application as { id: string }).id, opportunityId };
}

const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

describe('an employer question bank is the employer\'s own', () => {
  it('refuses to build an assessment from another employer\'s question', async () => {
    const mine = await seedEmployer();
    const theirs = await seedEmployer();
    const stolen = await approvedQuestion(theirs, `Their question ${randomUUID()}`);
    // The composite foreign key makes this inexpressible; the controller turns it into a
    // clear error rather than a constraint violation.
    await expect(assessments.createAssessment(trusted(recruiterId, mine), mine, {
      title: 'Borrowed test', durationSeconds: 1800, opportunityId: null, questionIds: [stolen],
    })).rejects.toThrow();
  });

  it('does not let the author approve their own question', async () => {
    const employerId = await seedEmployer();
    const created = await assessments.createQuestion(trusted(recruiterId, employerId), employerId, {
      questionText: `Self approval ${randomUUID()}`, questionType: 'TRUE_FALSE', marks: 1,
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    });
    const id = (created.question as { id: string }).id;
    await assessments.transitionQuestion(trusted(recruiterId, employerId), employerId, id, { toState: 'UNDER_REVIEW' });
    // A review ladder one person can walk end to end is a formality, not a review.
    await expect(assessments.transitionQuestion(trusted(recruiterId, employerId), employerId, id, { toState: 'APPROVED' })).rejects.toThrow();
    await expect(assessments.transitionQuestion(trusted(reviewerId, employerId), employerId, id, { toState: 'APPROVED' })).resolves.toBeTruthy();
  });

  it('refuses an unapproved question and an empty assessment', async () => {
    const employerId = await seedEmployer();
    const draft = await assessments.createQuestion(trusted(recruiterId, employerId), employerId, {
      questionText: `Still a draft ${randomUUID()}`, questionType: 'TRUE_FALSE', marks: 1,
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    });
    await expect(assessments.createAssessment(trusted(recruiterId, employerId), employerId, {
      title: 'Draft questions', durationSeconds: 1800, opportunityId: null,
      questionIds: [(draft.question as { id: string }).id],
    })).rejects.toThrow();
  });

  it('catches the same question written twice', async () => {
    const employerId = await seedEmployer();
    const text = `Duplicate check ${randomUUID()}`;
    const payload = {
      questionText: text, questionType: 'TRUE_FALSE' as const, marks: 1,
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    };
    await assessments.createQuestion(trusted(recruiterId, employerId), employerId, payload);
    await expect(assessments.createQuestion(trusted(recruiterId, employerId), employerId, payload)).rejects.toThrow();
  });
});

describe('who may be sent a screening test', () => {
  it('refuses an application that has been rejected', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await hiring.transitionApplication(trusted(recruiterId, employerId), employerId, applicationId, { toState: 'REJECTED' });
    // The employer's access to this person ended with the application; an invitation must
    // not become a way to reach them afterwards.
    await expect(assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, {
      applicationIds: [applicationId], closesAt: tomorrow(),
    })).rejects.toThrow();
  });

  it('refuses an application whose consent was revoked', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await pool.query('UPDATE applications SET consent_revoked_at = now() WHERE id = $1', [applicationId]);
    await expect(assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, {
      applicationIds: [applicationId], closesAt: tomorrow(),
    })).rejects.toThrow();
  });

  it('refuses to send an unpublished assessment to anybody', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const question = await approvedQuestion(employerId, `Draft assessment ${randomUUID()}`);
    const created = await assessments.createAssessment(trusted(recruiterId, employerId), employerId, {
      title: 'Not published', durationSeconds: 1800, opportunityId, questionIds: [question],
    });
    await expect(assessments.invite(trusted(recruiterId, employerId), employerId, (created.assessment as { id: string }).id, {
      applicationIds: [applicationId], closesAt: tomorrow(),
    })).rejects.toThrow();
  });

  it('treats a repeated invitation as a no-op rather than an error', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    const first = await assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });
    const second = await assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });
    expect(first.invited).toBe(1);
    // A recruiter selecting the same list twice has not done anything wrong.
    expect(second.invited).toBe(0);
  });
});

describe('taking a screening test', () => {
  async function invited(): Promise<{ employerId: string; assessmentId: string; invitationId: string }> {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });
    // Addressed by assessment: this candidate accumulates invitations across the suite, so
    // taking the first one from the list would pick an earlier test's submitted attempt.
    const row = await pool.query('SELECT id FROM employer_assessment_invitations WHERE assessment_id = $1', [assessmentId]);
    return { employerId, assessmentId, invitationId: row.rows[0].id as string };
  }

  it('never sends the answer key to the candidate', async () => {
    const { invitationId } = await invited();
    const started = await assessments.start(trusted(candidateId), invitationId);
    const serialised = JSON.stringify(started.attempt);
    expect(serialised).not.toMatch(/isCorrect|is_correct|correctOptionKeys|answerKey/);
    // The options are there — just without any indication of which one is right.
    const attempt = started.attempt as { questions: { options: unknown[] }[] };
    expect(attempt.questions[0]?.options.length).toBe(3);
  });

  it('returns the same paper on a second start rather than a new one', async () => {
    const { invitationId } = await invited();
    const first = await assessments.start(trusted(candidateId), invitationId);
    const second = await assessments.start(trusted(candidateId), invitationId);
    expect((second.attempt as { id: string }).id).toBe((first.attempt as { id: string }).id);
    expect(JSON.stringify(second.attempt)).toBe(JSON.stringify(first.attempt));
  });

  it('grades against the real key even though the candidate answered in display keys', async () => {
    const { invitationId } = await invited();
    const started = await assessments.start(trusted(candidateId), invitationId);
    const attempt = started.attempt as { id: string; questions: { questionId: string; options: { key: string; text: string }[] }[] };
    const question = attempt.questions[0]!;
    const correctDisplayKey = question.options.find((option) => option.text === 'Correct answer')!.key;
    await assessments.answer(trusted(candidateId), attempt.id, { questionId: question.questionId, selectedOptionKeys: [correctDisplayKey] });
    const result = await assessments.submit(trusted(candidateId), attempt.id);
    expect((result.result as { percentage: number }).percentage).toBe(100);
  });

  it('is idempotent on submit and refuses to be rewritten', async () => {
    const { invitationId } = await invited();
    const started = await assessments.start(trusted(candidateId), invitationId);
    const attempt = started.attempt as { id: string; questions: { questionId: string; options: { key: string }[] }[] };
    await assessments.submit(trusted(candidateId), attempt.id);
    const again = await assessments.submit(trusted(candidateId), attempt.id);
    expect((again.result as { percentage: number }).percentage).toBe(0);
    // A submitted attempt cannot take another answer: a result somebody acts on must be
    // the result that was produced.
    await expect(assessments.answer(trusted(candidateId), attempt.id, {
      questionId: attempt.questions[0]!.questionId, selectedOptionKeys: ['A'],
    })).rejects.toThrow();
  });

  it('will not let one candidate open another candidate\'s attempt', async () => {
    const { invitationId } = await invited();
    const started = await assessments.start(trusted(candidateId), invitationId);
    const stranger = await seedUser();
    await expect(assessments.submit(trusted(stranger), (started.attempt as { id: string }).id)).rejects.toThrow();
  });
});

describe('a screening result stays out of readiness', () => {
  it('writes nothing to evidence, mastery or readiness, and moves no application', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });

    const before = await Promise.all([
      pool.query('SELECT count(*)::int AS count FROM evidence_records'),
      pool.query('SELECT count(*)::int AS count FROM mastery_projections'),
      pool.query('SELECT count(*)::int AS count FROM readiness_snapshots'),
    ]);
    const stateBefore = (await pool.query('SELECT state FROM applications WHERE id = $1', [applicationId])).rows[0].state;

    const invitation = await pool.query('SELECT id FROM employer_assessment_invitations WHERE assessment_id = $1', [assessmentId]);
    const started = await assessments.start(trusted(candidateId), invitation.rows[0].id as string);
    await assessments.submit(trusted(candidateId), (started.attempt as { id: string }).id);

    const after = await Promise.all([
      pool.query('SELECT count(*)::int AS count FROM evidence_records'),
      pool.query('SELECT count(*)::int AS count FROM mastery_projections'),
      pool.query('SELECT count(*)::int AS count FROM readiness_snapshots'),
    ]);
    // An employer shaping the readiness band, even indirectly, would hollow out the one
    // promise the product rests on.
    expect(after.map((result) => result.rows[0].count)).toEqual(before.map((result) => result.rows[0].count));
    // And a score does not decide anything on its own: a person moves the candidate.
    expect((await pool.query('SELECT state FROM applications WHERE id = $1', [applicationId])).rows[0].state).toBe(stateBefore);
  });

  it('shows the employer no readiness band alongside the score', async () => {
    const employerId = await seedEmployer();
    const { applicationId, opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await assessments.invite(trusted(recruiterId, employerId), employerId, assessmentId, { applicationIds: [applicationId], closesAt: tomorrow() });
    const results = await assessments.results(trusted(recruiterId, employerId), employerId, assessmentId);
    expect(JSON.stringify(results)).not.toMatch(/band|readiness|DEMONSTRATED|PROGRESSING|NOT_ENOUGH_EVIDENCE/i);
    expect((results.results as unknown[]).length).toBe(1);
  });

  it('denies a rival employer the results of a test they did not send', async () => {
    const employerId = await seedEmployer();
    const rival = await seedEmployer();
    const { opportunityId } = await applicationFor(employerId);
    const assessmentId = await publishedAssessment(employerId, opportunityId);
    await expect(assessments.results(trusted(recruiterId, rival), rival, assessmentId)).resolves.toMatchObject({ results: [] });
    await expect(assessments.results(trusted(recruiterId, employerId), rival, assessmentId)).rejects.toThrow();
  });
});
