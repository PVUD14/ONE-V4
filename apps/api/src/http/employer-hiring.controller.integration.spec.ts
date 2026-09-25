/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@planthepath/persistence/src/schema.js';
import { EmployerHiringController } from './employer-hiring.controller.js';
import { StudentHiringController } from './student-hiring.controller.js';
import type { ProtectedHttpRequest } from './api-security.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for hiring controller integration tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('Hiring controller integration tests require local Postgres');
const schemaName = `hiring_workflow_${process.pid}`;
const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
let admin: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let employer: EmployerHiringController;
let student: StudentHiringController;
let userId: string;
let outsiderId: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) await migrate(name);
  db = drizzle(pool, { schema });
  employer = new EmployerHiringController(db, { uuid: randomUUID });
  student = new StudentHiringController(db, { uuid: randomUUID });
  userId = await seedUser(); outsiderId = await seedUser();
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin?.end();
});

async function migrate(name: string): Promise<void> {
  const sql = (await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
  await pool.query(sql);
}
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: `test:${id}`, email: `${id}@example.test`, state: 'ACTIVE' });
  return id;
}
function trusted(actorId: string, employerId?: string): ProtectedHttpRequest {
  return { headers: {}, planThePath: { correlationId: `test-${randomUUID()}`, verifiedIdentity: {}, authorization: {
    principal: { userId: actorId }, memberships: employerId ? [{ organizationId: employerId, role: 'RECRUITER', state: 'ACTIVE', scope: { organizationId: employerId, employerId } }] : [],
  } } } as unknown as ProtectedHttpRequest;
}
async function createRole(text = 'Build reliable software.', title = `Role ${randomUUID()}`) {
  const employerId = randomUUID();
  await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Test Employer', verificationState: 'VERIFIED' });
  const request = trusted(userId, employerId);
  const created = await employer.createOpportunity(request, employerId, { referenceCode: randomUUID(), title, summary: text, employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false });
  const opportunityId = (created.opportunity as { id: string }).id;
  await employer.addAudience(request, employerId, opportunityId, { audienceKind: 'PUBLIC' });
  await employer.publishOpportunity(request, employerId, opportunityId);
  return { employerId, request, opportunityId };
}
async function apply(opportunityId: string, grant = false, actorId = userId): Promise<string> {
  const result = await student.apply(trusted(actorId), { opportunityId, consentGranted: true, institutionVisibilityGranted: grant });
  return (result.application as { id: string }).id;
}

async function seedEmployerMember(employerId: string, state = 'ACTIVE'): Promise<string> {
  const memberId = await seedUser();
  await pool.query(`INSERT INTO organization_memberships
    (id, organization_id, user_id, role, state, scope_organization_id, scope_employer_id)
    VALUES ($1, $2, $3, 'RECRUITER', $4, $2, $2)`, [randomUUID(), employerId, memberId, state]);
  return memberId;
}

async function assignedInterview() {
  const role = await createRole();
  const applicationId = await apply(role.opportunityId);
  const memberId = await seedEmployerMember(role.employerId);
  const input = { mode: 'VIDEO', scheduledStart: '2099-10-01T09:00Z', scheduledEnd: '2099-10-01T10:00Z',
    joiningLink: 'https://meet.example.test/candidate', locationDetail: 'Candidate phone arrangements',
    participantUserIds: [memberId], participantVisibilityAcknowledged: true };
  const scheduled = await employer.scheduleInterview(role.request, role.employerId, applicationId, input);
  return { ...role, applicationId, memberId, input, participantRequest: trusted(memberId, role.employerId),
    interviewId: (scheduled.interview as { id: string }).id };
}

describe('interview access follows assignment', () => {
  it('lists and reads the assigned interview, but denies another at the same employer', async () => {
    const f = await assignedInterview();
    const second = await employer.scheduleInterview(f.request, f.employerId, f.applicationId, { ...f.input, participantUserIds: [] });
    const otherId = (second.interview as { id: string }).id;
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [{ id: f.interviewId }] });
    const brief = await employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId);
    expect(brief.interview).toMatchObject({ id: f.interviewId, consentRevoked: false, canRecordOutcome: true });
    expect(JSON.stringify(brief)).not.toContain(otherId);
    await expect(employer.getMyInterview(f.participantRequest, f.employerId, otherId)).rejects.toMatchObject({ status: 403 });
    await expect(employer.submitMyOutcome(f.participantRequest, f.employerId, otherId, { recommendation: 'YES' })).rejects.toMatchObject({ status: 403 });
    const rival = await createRole();
    await expect(employer.getMyInterview(trusted(f.memberId, rival.employerId), rival.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
  });

  it('denies an active employer member who is not a participant', async () => {
    const f = await assignedInterview();
    const nonParticipant = trusted(await seedEmployerMember(f.employerId), f.employerId);
    expect(await employer.listMyInterviews(nonParticipant, f.employerId)).toMatchObject({ interviews: [] });
    await expect(employer.getMyInterview(nonParticipant, f.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
    await expect(employer.submitMyOutcome(nonParticipant, f.employerId, f.interviewId, { recommendation: 'YES' })).rejects.toMatchObject({ status: 403 });
  });

  it('checks membership suspension in the database even with a stale ACTIVE request context', async () => {
    const f = await assignedInterview();
    await pool.query("UPDATE organization_memberships SET state = 'SUSPENDED' WHERE user_id = $1", [f.memberId]);
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [] });
    await expect(employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
    await expect(employer.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'YES' })).rejects.toMatchObject({ status: 403 });
  });

  it('ends access when the participant is removed', async () => {
    const f = await assignedInterview();
    await pool.query('UPDATE interview_participants SET removed_at = now() WHERE interview_id = $1', [f.interviewId]);
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [] });
    await expect(employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
  });

  it.each(['COMPLETED', 'CANCELLED', 'NO_SHOW'])('ends read and scorecard access at %s', async (toState) => {
    const f = await assignedInterview();
    await employer.updateInterviewState(f.request, f.employerId, f.interviewId, { toState });
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [] });
    await expect(employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
    await expect(employer.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'YES' })).rejects.toMatchObject({ status: 403 });
  });

  it('expires access at the scheduled end even if completion was not recorded', async () => {
    const f = await assignedInterview();
    await pool.query("UPDATE interviews SET scheduled_start = now() - interval '2 hours', scheduled_end = now() - interval '1 hour' WHERE id = $1", [f.interviewId]);
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [] });
    await expect(employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId)).rejects.toMatchObject({ status: 403 });
  });

  it('redacts revoked identity with the same mapping as applicants and prevents further scoring', async () => {
    const f = await assignedInterview();
    await student.withdraw(trusted(userId), f.applicationId, {});
    const brief = (await employer.getMyInterview(f.participantRequest, f.employerId, f.interviewId)).interview;
    const masked = { consentRevoked: true, candidateName: null, candidateEmail: null, institutionStudentId: null };
    expect(brief).toMatchObject({ ...masked, canRecordOutcome: false, locationDetail: null, joiningLink: null });
    expect(await employer.listMyInterviews(f.participantRequest, f.employerId)).toMatchObject({ interviews: [{ id: f.interviewId, ...masked }] });
    expect(await employer.listApplicants(f.request, f.employerId, f.opportunityId)).toMatchObject({ applications: [masked] });
    expect(JSON.stringify(brief)).not.toMatch(/@example.test|Candidate phone arrangements|meet.example.test/);
    await expect(employer.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'YES' })).rejects.toMatchObject({ status: 403 });
  });

  it('upserts only the authenticated participant scorecard and audits it', async () => {
    const f = await assignedInterview();
    await employer.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'YES', notes: 'Clear reasoning.' });
    await employer.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'STRONG_YES', submittedByUserId: outsiderId });
    expect((await pool.query('SELECT submitted_by_user_id, recommendation FROM interview_outcomes WHERE interview_id = $1', [f.interviewId])).rows)
      .toEqual([{ submitted_by_user_id: f.memberId, recommendation: 'STRONG_YES' }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE resource_id = $1 AND action = 'interview.outcome_recorded'", [f.interviewId])).rows[0].count).toBe(2);
  });

  it('requires visibility acknowledgement, rejects foreign/suspended participants, and creates no partial rows', async () => {
    const f = await assignedInterview();
    const before = (await pool.query('SELECT count(*)::int AS count FROM interviews WHERE application_id = $1', [f.applicationId])).rows;
    await expect(employer.scheduleInterview(f.request, f.employerId, f.applicationId, { ...f.input, participantVisibilityAcknowledged: false })).rejects.toMatchObject({ status: 400 });
    const rival = await createRole();
    const foreignId = await seedEmployerMember(rival.employerId);
    const suspendedId = await seedEmployerMember(f.employerId, 'SUSPENDED');
    for (const id of [foreignId, suspendedId]) {
      await expect(employer.scheduleInterview(f.request, f.employerId, f.applicationId, { ...f.input, participantUserIds: [f.memberId, id] })).rejects.toMatchObject({ status: 400 });
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM interviews WHERE application_id = $1', [f.applicationId])).rows).toEqual(before);
    expect(await employer.listParticipantOptions(f.request, f.employerId)).toMatchObject({ participants: [{ userId: f.memberId }] });
    const audit = await pool.query("SELECT context FROM audit_events WHERE action = 'interview.participants_assigned' AND resource_id = $1", [f.interviewId]);
    expect(audit.rows).toEqual([{ context: { participantUserIds: [f.memberId], visibilityAcknowledged: true } }]);
    expect((await pool.query('SELECT role FROM organization_memberships WHERE user_id = $1', [f.memberId])).rows).toEqual([{ role: 'RECRUITER' }]);
  });

  it('rolls back both scheduling and scorecards when their audit cannot be recorded', async () => {
    const f = await assignedInterview();
    const auditId = (await pool.query("SELECT id FROM audit_events WHERE action = 'interview.participants_assigned' AND resource_id = $1", [f.interviewId])).rows[0].id as string;
    let calls = 0;
    const failingSchedule = new EmployerHiringController(db, { uuid: () => ++calls === 3 ? auditId : randomUUID() });
    await expect(failingSchedule.scheduleInterview(f.request, f.employerId, f.applicationId, f.input)).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM interviews WHERE application_id = $1', [f.applicationId])).rows[0].count).toBe(1);
    calls = 0;
    const failingOutcome = new EmployerHiringController(db, { uuid: () => ++calls === 2 ? auditId : randomUUID() });
    await expect(failingOutcome.submitMyOutcome(f.participantRequest, f.employerId, f.interviewId, { recommendation: 'YES' })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM interview_outcomes WHERE interview_id = $1', [f.interviewId])).rows[0].count).toBe(0);
  });
});

describe('hiring workflow persistence', () => {
  it('replays both migrations without changing existing consent or duplicating signals', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId, true);
    const before = (await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [id])).rows[0];
    await migrate('0017_application_institution_visibility.sql');
    await migrate('0017_application_institution_visibility.sql');
    await migrate('0018_opportunity_review_signals.sql');
    await migrate('0018_opportunity_review_signals.sql');
    expect((await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [id])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM opportunity_review_signals WHERE opportunity_id = $1', [role.opportunityId])).rows[0].count).toBe(1);
  });
  it('allows optional consent, rejects impossible timestamp order, and revokes independently even after closure', async () => {
    const role = await createRole();
    const unshared = await apply(role.opportunityId);
    const shared = await apply(role.opportunityId, true, outsiderId);
    expect((await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [unshared])).rows[0].institution_visibility_granted_at).toBeNull();
    await expect(pool.query('UPDATE applications SET institution_visibility_revoked_at = now() WHERE id = $1', [unshared])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE applications SET institution_visibility_revoked_at = institution_visibility_granted_at - interval '1 second' WHERE id = $1", [shared])).rejects.toMatchObject({ code: '23514' });
    await employer.transitionApplication(role.request, role.employerId, shared, { toState: 'REJECTED' });
    await student.revokeInstitutionVisibility(trusted(outsiderId), shared);
    const before = (await pool.query('SELECT state, consent_revoked_at, institution_visibility_revoked_at FROM applications WHERE id = $1', [shared])).rows[0];
    expect(before.state).toBe('REJECTED'); expect(before.consent_revoked_at).toBeNull(); expect(before.institution_visibility_revoked_at).not.toBeNull();
    await student.revokeInstitutionVisibility(trusted(outsiderId), shared);
    expect((await pool.query('SELECT state, consent_revoked_at, institution_visibility_revoked_at FROM applications WHERE id = $1', [shared])).rows[0]).toEqual(before);
    await expect(student.revokeInstitutionVisibility(trusted(userId), shared)).rejects.toThrow();
    const listed = await student.listApplications(trusted(outsiderId));
    expect((listed.applications as { id: string; institutionVisibilityRevokedAt: unknown }[]).find((item) => item.id === shared)?.institutionVisibilityRevokedAt).not.toBeNull();
  });
  it('rolls back a consent grant when its audit fails', async () => {
    const role = await createRole();
    // Force an audit failure only for this call using a duplicate audit ID.
    const auditId = randomUUID();
    await pool.query("INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id) VALUES ($1, $2, 'test', 'application', $3, 'SUCCESS', 'test-audit')", [auditId, userId, randomUUID()]);
    let calls = 0;
    const failing = new StudentHiringController(db, { uuid: () => ++calls === 4 ? auditId : randomUUID() });
    await expect(failing.apply(trusted(userId), { opportunityId: role.opportunityId, consentGranted: true, institutionVisibilityGranted: true })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM applications WHERE opportunity_id = $1', [role.opportunityId])).rows[0].count).toBe(0);
  });
  it('records payment and cross-employer duplicate signals before publishing, with no penalty', async () => {
    const title = `Duplicate ${randomUUID()}`;
    await createRole('Candidates must pay a registration fee.', title);
    const role = await createRole('Candidates must pay a registration fee.', title);
    const signals = await pool.query('SELECT signal_code, review_state FROM opportunity_review_signals WHERE opportunity_id = $1', [role.opportunityId]);
    expect(signals.rows.map((row) => row.signal_code).sort()).toEqual(['APPLICANT_PAYMENT_DEMAND', 'CROSS_EMPLOYER_DUPLICATE', 'MISSING_COMPENSATION']);
    expect(signals.rows.every((row) => row.review_state === 'PENDING')).toBe(true);
    expect((await pool.query('SELECT lifecycle_state FROM opportunities WHERE id = $1', [role.opportunityId])).rows[0].lifecycle_state).toBe('PUBLISHED');
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE resource_id = $1 AND action = 'opportunity.review_requested'", [role.opportunityId])).rows[0].count).toBe(2);
  });
  it('computes real employer aggregates, avoids skipped-stage inflation and excludes rival applications', async () => {
    const role = await createRole();
    const rival = await createRole();
    const id = await apply(role.opportunityId);
    await apply(rival.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'INTERVIEW' });
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'OFFER' });
    await employer.extendOffer(role.request, role.employerId, id, { compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-10-01T00:00Z' });
    await pool.query("UPDATE applications SET submitted_at = now() - interval '5 days' WHERE id = $1", [id]);
    const result = await employer.hiringAnalytics(role.request, role.employerId);
    const report = result.analytics as { applicationCount: number; meanTimeToOfferDays: number; stages: { stage: string; reached: number }[] };
    expect(report.applicationCount).toBe(1);
    expect(report.meanTimeToOfferDays).toBeCloseTo(5, 2);
    expect(report.stages.find((stage) => stage.stage === 'SCREENING')?.reached).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/student_user_id|candidate|compensation|@example.test/);
    await expect(employer.hiringAnalytics(role.request, rival.employerId)).rejects.toThrow();
  });
});

describe('candidate feedback release', () => {
  it('refuses feedback on a live application and accepts it once rejected', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId);
    // A live candidate must not be handed a rejection reason: it would turn the feedback
    // channel into a back channel for negotiating an outcome that has not happened.
    await expect(employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['CORE_SKILL_GAP'] })).rejects.toThrow();
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'REJECTED' });
    const released = await employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['CORE_SKILL_GAP'], note: 'Keep going.' });
    expect((released.feedback as { id: string }).id).toBeTruthy();
  });

  it('shows the release to its own student, and to nobody else', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId, false, outsiderId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'REJECTED' });
    await employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['STRONGER_APPLICANTS'] });

    const mine = await student.applicationFeedback(trusted(outsiderId), id);
    const feedback = mine.feedback as { reasons: { code: string; studentLabel: string; topics: unknown[] }[] };
    expect(feedback.reasons[0]?.code).toBe('STRONGER_APPLICANTS');
    expect(feedback.reasons[0]?.studentLabel).toMatch(/closer match/);
    // Nothing a student studies addresses losing to a stronger applicant, so the reason
    // maps to no topic and the student is offered none rather than an invented one.
    expect(feedback.reasons[0]?.topics).toEqual([]);

    // Another student reading the same application id gets nothing at all.
    expect((await student.applicationFeedback(trusted(userId), id)).feedback).toBeNull();
  });

  it('supersedes a correction instead of leaving two live releases', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'REJECTED' });
    await employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['CORE_SKILL_GAP'] });
    await employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['EXPERIENCE_LEVEL'] });

    const rows = await pool.query('SELECT superseded_at FROM application_feedback_releases WHERE application_id = $1', [id]);
    // Both rows survive -- a correction is honest, a disappearance is not.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter((row) => row.superseded_at === null)).toHaveLength(1);

    const current = (await student.applicationFeedback(trusted(userId), id)).feedback as { reasons: { code: string }[] };
    expect(current.reasons.map((reason) => reason.code)).toEqual(['EXPERIENCE_LEVEL']);
  });

  it('never surfaces what the employer wrote for their own team', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, {
      toState: 'REJECTED', reasonCode: 'INTERNAL_WEAK_COMMS', note: 'Rambled badly; would not put in front of a client.',
    });
    await employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['COMMUNICATION'] });

    const shown = JSON.stringify((await student.applicationFeedback(trusted(userId), id)).feedback);
    expect(shown).not.toMatch(/INTERNAL_WEAK_COMMS|Rambled|client/);
    // The private column is untouched by the release, and still holds what it always did.
    const stored = await pool.query('SELECT rejection_reason_code FROM applications WHERE id = $1', [id]);
    expect(stored.rows[0].rejection_reason_code).toBe('INTERNAL_WEAK_COMMS');
  });

  it('refuses a code that is not in the catalogue, writing nothing', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'REJECTED' });
    await expect(employer.releaseFeedback(role.request, role.employerId, id, { reasonCodes: ['MADE_UP_REASON'] })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM application_feedback_releases WHERE application_id = $1', [id])).rows[0].count).toBe(0);
  });

  it('denies a rival employer releasing feedback on an application that is not theirs', async () => {
    const role = await createRole();
    const other = await createRole();
    const id = await apply(role.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'REJECTED' });
    await expect(employer.releaseFeedback(other.request, other.employerId, id, { reasonCodes: ['CORE_SKILL_GAP'] })).rejects.toThrow();
  });
});
