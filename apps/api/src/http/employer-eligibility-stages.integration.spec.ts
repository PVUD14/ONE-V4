/**
 * Eligibility, required skills and selection stages (EMP-06, defect D-5).
 *
 * The version-scoped tables for eligibility, skills and stages existed and were never written
 * or enforced: a student far below a job's stated bar could apply, and the employer had no way to
 * know which facts behind an application the institution stands behind. These specs pin the
 * editor (only through a new version), enforcement at apply from academic records, the frozen
 * flags the employer sees (outcome and basis, never figures), and the stage template.
 *
 * Runs over real HTTP with a stub verifier, like the EMP-05 spec, in a throwaway schema of the
 * local Postgres in DATABASE_URL.
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
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for eligibility tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Eligibility tests require local Postgres');
const schemaName = 'employer_eligibility_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'a'.repeat(64);
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

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Eligibility employer',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [randomUUID(), employerId, recruiterId]);
  return { employerId, recruiterId };
}
async function institution(): Promise<{ institutionId: string; departmentId: string; programId: string }> {
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute of Technology','VERIFIED',true)", [institutionId]);
  const departmentId = randomUUID();
  const programId = randomUUID();
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Computer Science')", [departmentId, institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'PROGRAM','BTech')", [programId, institutionId]);
  return { institutionId, departmentId, programId };
}
/** A student at the college, with an optional qualification and terms (value, scale, verified, backlogs). */
async function student(college: Awaited<ReturnType<typeof institution>>, terms: { value: number; scale?: string; verified: boolean; backlogs?: number }[] = []): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,program_unit_id,expected_graduation_date)
    VALUES ($1,$2,$3,$4,'Synthetic Student','ACTIVE',$5,$6,'2027-06-30')`, [randomUUID(), college.institutionId, id, 'R-' + id.slice(0, 8), college.departmentId, college.programId]);
  if (terms.length) {
    const qualificationId = randomUUID();
    await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,started_on)
      VALUES ($1,$2,$3,'BTECH','BTech Computer Science','2023-08-01')`, [qualificationId, id, college.institutionId]);
    const verifier = await user();
    for (const [index, term] of terms.entries()) {
      await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state,verified_by_user_id,verified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), qualificationId, index + 1, 'Semester ' + (index + 1), term.value, term.scale ?? 'CGPA_10', term.backlogs ?? 0,
        term.verified ? 'INSTITUTION_IMPORTED' : 'STUDENT_DECLARED', term.verified ? 'VERIFIED' : 'SELF_REPORTED', term.verified ? verifier : null, term.verified ? new Date() : null]);
    }
  }
  return id;
}
async function catalogueSkill(name: string): Promise<{ topicId: string; roleId: string }> {
  const author = await user();
  const topicId = randomUUID();
  const revision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id,entity_type,entity_id,revision,author_user_id,state,content_hash,body) VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id,kind,stable_key,version,name,description,content_revision_id) VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for EMP-06 tests',$4)`,
    [topicId, 'emp06-' + topicId.slice(0, 8), name, revision]);
  const roleId = randomUUID();
  await pool.query("INSERT INTO career_roles (id,code,title,family) VALUES ($1,$2,'Synthetic data analyst','Data')", [roleId, 'EMP06_' + roleId.slice(0, 8).toUpperCase()]);
  await pool.query("INSERT INTO career_role_requirements (id,career_role_id,topic_id,requirement_level,target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.7)", [randomUUID(), roleId, topicId]);
  return { topicId, roleId };
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';
const baseTerms = {
  title: 'Graduate analyst', summary: 'Analyse data.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
const cgpaAndBacklogs = [
  { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7 },
  { ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: 1 },
];

async function currentVersion(opportunityId: string): Promise<string> {
  return (await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [opportunityId])).rows[0].current_version_id;
}
function edit(employerId: string, recruiterId: string, opportunityId: string, versionId: string, changes: Record<string, unknown>) {
  return api().post(base(employerId) + '/' + opportunityId + '/versions').set(auth(recruiterId)).send({ ...baseTerms, ...changes, expectedCurrentVersionId: versionId });
}
/** A published job whose current version carries `requirements`, set as a draft edit before publishing. */
async function job(employerId: string, recruiterId: string, requirements: Record<string, unknown> = {}): Promise<string> {
  const created = await api().post(base(employerId)).set(auth(recruiterId)).send({ referenceCode: 'EL-' + randomUUID().slice(0, 8), ...baseTerms }).expect(201);
  const id = created.body.opportunity.id as string;
  if (Object.keys(requirements).length) await edit(employerId, recruiterId, id, created.body.opportunity.versionId, requirements).expect(201);
  await api().post(base(employerId) + '/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(employerId) + '/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
function applyAs(studentId: string, opportunityId: string) {
  return api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true });
}
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"/i);

describe('EMP-06: the editor writes requirements only as a new version', () => {
  it('sets rules, required and preferred skills and ordered stages on version 2, leaves version 1 empty, and carries them forward', async () => {
    const { employerId, recruiterId } = await employer();
    const created = await api().post(base(employerId)).set(auth(recruiterId)).send({ referenceCode: 'EL-' + randomUUID().slice(0, 8), ...baseTerms }).expect(201);
    const id = created.body.opportunity.id as string;
    const v1 = created.body.opportunity.versionId as string;
    const response = await edit(employerId, recruiterId, id, v1, {
      eligibilityRules: [...cgpaAndBacklogs, { ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Willing to relocate to Chennai' }],
      skills: [{ name: 'SQL', level: 'REQUIRED' }, { name: 'Tableau', level: 'PREFERRED' }],
      stages: [{ kind: 'SCREENING', label: 'Résumé screen' }, { kind: 'ASSESSMENT', label: 'Aptitude test' }, { kind: 'INTERVIEW', label: 'Technical interview' }, { kind: 'INTERVIEW', label: 'HR interview' }],
    }).expect(201);
    expect(response.body.version).toMatchObject({ versionNumber: 2, changedDetails: ['skills', 'stages'] });
    expect((await pool.query('SELECT count(*)::int AS n FROM opportunity_eligibility_rules WHERE opportunity_version_id=$1', [v1])).rows[0].n).toBe(0);

    const detail = await api().get(base(employerId) + '/' + id).set(auth(recruiterId)).expect(200);
    const requirements = detail.body.currentVersion.requirements;
    expect(requirements.eligibilityRules.map((rule: { ruleType: string; isBlocking: boolean }) => [rule.ruleType, rule.isBlocking]))
      .toEqual([['CUSTOM', false], ['MAX_BACKLOGS', true], ['MIN_CGPA', true]]);
    expect(requirements.skills).toEqual([
      { name: 'SQL', level: 'REQUIRED', taxonomyTopicId: null, catalogue: false },
      { name: 'Tableau', level: 'PREFERRED', taxonomyTopicId: null, catalogue: false },
    ]);
    expect(requirements.stages.map((stage: { order: number; label: string; applicationState: string }) => [stage.order, stage.label, stage.applicationState]))
      .toEqual([[1, 'Résumé screen', 'SCREENING'], [2, 'Aptitude test', 'ASSESSMENT'], [3, 'Technical interview', 'INTERVIEW'], [4, 'HR interview', 'INTERVIEW']]);
    noReadiness(detail.body);

    // A wording edit carries every requirement forward, untouched.
    const v2 = response.body.version.id as string;
    const wording = await edit(employerId, recruiterId, id, v2, { summary: 'Analyse data well.' }).expect(201);
    expect(wording.body.version).toMatchObject({ versionNumber: 3, change: 'EDITORIAL', changedDetails: [] });
    const again = await api().get(base(employerId) + '/' + id).set(auth(recruiterId)).expect(200);
    expect(again.body.currentVersion.requirements).toEqual(requirements);
    const audit = await pool.query("SELECT context, organization_id FROM audit_events WHERE action='opportunity.version_created' AND resource_id=$1 ORDER BY occurred_at", [id]);
    expect(audit.rows[0].context.changedDetails).toEqual(['skills', 'stages']);
    expect(audit.rows[0].organization_id).toBe(employerId);
  });

  it('refuses unknown fields, unknown rule types, blocking custom rules, protected attributes and stages out of order', async () => {
    const { employerId, recruiterId } = await employer();
    const created = await api().post(base(employerId)).set(auth(recruiterId)).send({ referenceCode: 'EL-' + randomUUID().slice(0, 8), ...baseTerms }).expect(201);
    const id = created.body.opportunity.id as string;
    const v1 = created.body.opportunity.versionId as string;
    const refused = async (changes: Record<string, unknown>, code: string) => {
      const response = await edit(employerId, recruiterId, id, v1, changes).expect(400);
      expect(response.body.error.code).toBe(code);
    };
    await refused({ eligibility: [] }, 'UNKNOWN_FIELD');
    await refused({ eligibilityRules: [{ ruleType: 'AGE', comparator: 'LTE', valueNumeric: 25 }] }, 'INVALID_ELIGIBILITY_RULES');
    await refused({ eligibilityRules: [{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Must relocate', isBlocking: true }] }, 'ELIGIBILITY_RULE_CANNOT_BLOCK');
    await refused({ eligibilityRules: [{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Male candidates only' }] }, 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE');
    await refused({ eligibilityRules: [{ ruleType: 'INSTITUTION', comparator: 'IN', valueText: randomUUID() }] }, 'UNKNOWN_INSTITUTION');
    await refused({ stages: [{ kind: 'INTERVIEW', label: 'Interview' }, { kind: 'SCREENING', label: 'Screen' }] }, 'STAGE_ORDER_INVALID');
    await refused({ skills: [{ taxonomyTopicId: randomUUID(), level: 'REQUIRED' }] }, 'UNKNOWN_CATALOGUE_SKILL');
    await refused({ careerRoleId: randomUUID() }, 'UNKNOWN_CAREER_ROLE');
    // Nothing was written by any refusal.
    expect((await pool.query('SELECT count(*)::int AS n FROM opportunity_versions WHERE opportunity_id=$1', [id])).rows[0].n).toBe(1);
  });

  it('a catalogue skill is named by the catalogue and the job maps to a catalogue role', async () => {
    const { employerId, recruiterId } = await employer();
    const { topicId, roleId } = await catalogueSkill('Synthetic SQL querying');
    const catalogue = await api().get('/api/v1/employers/' + employerId + '/skill-catalogue').query({ q: 'Synthetic SQL', careerRoleId: roleId }).set(auth(recruiterId)).expect(200);
    expect(catalogue.body.skills).toEqual([{ taxonomyTopicId: topicId, name: 'Synthetic SQL querying' }]);
    noReadiness(catalogue.body);
    await api().get('/api/v1/employers/' + employerId + '/skill-catalogue').query({ limit: '201' }).set(auth(recruiterId)).expect(400);

    const created = await api().post(base(employerId)).set(auth(recruiterId)).send({ referenceCode: 'EL-' + randomUUID().slice(0, 8), ...baseTerms }).expect(201);
    const id = created.body.opportunity.id as string;
    const response = await edit(employerId, recruiterId, id, created.body.opportunity.versionId, {
      skills: [{ taxonomyTopicId: topicId, level: 'REQUIRED' }], careerRoleId: roleId,
    }).expect(201);
    expect(response.body.version.changedDetails).toEqual(['skills', 'careerRole']);
    const detail = await api().get(base(employerId) + '/' + id).set(auth(recruiterId)).expect(200);
    expect(detail.body.currentVersion.requirements.skills).toEqual([{ name: 'Synthetic SQL querying', level: 'REQUIRED', taxonomyTopicId: topicId, catalogue: true }]);
    expect(detail.body.currentVersion.requirements.careerRole).toMatchObject({ id: roleId, title: 'Synthetic data analyst' });
  });

  it('changing a live job\'s eligibility needs a reason code and asks each applicant to accept it', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId, { eligibilityRules: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 6 }] });
    const applicant = await student(college, [{ value: 7.5, verified: true }]);
    const applied = await applyAs(applicant, id).expect(201);
    const tightened = { eligibilityRules: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 8 }] };
    const missing = await edit(employerId, recruiterId, id, await currentVersion(id), tightened).expect(400);
    expect(missing.body.error.code).toBe('REASON_CODE_REQUIRED');
    await edit(employerId, recruiterId, id, await currentVersion(id), { ...tightened, reasonCode: 'NOT_A_CODE' }).expect(400);
    const saved = await edit(employerId, recruiterId, id, await currentVersion(id), { ...tightened, reasonCode: 'ELIGIBILITY_TIGHTENED' }).expect(201);
    expect(saved.body.version.changedTerms).toEqual(['eligibility']);
    expect(saved.body.applicants.acknowledgementsRequired).toBe(1);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='opportunity.version_created' AND resource_id=$1 ORDER BY occurred_at DESC LIMIT 1", [id]);
    expect(audit.rows[0].context.reasonCode).toBe('ELIGIBILITY_TIGHTENED');

    // Accepting binds the applicant to rules nobody evaluated for them: evaluated and frozen now,
    // and a rule they no longer meet is a flag for a person, not a rejection.
    await api().post('/api/v1/students/me/applications/' + applied.body.application.id + '/terms-change/acknowledge').set(auth(applicant))
      .send({ toVersionId: saved.body.version.id }).expect(201);
    const evaluations = await pool.query('SELECT trigger, eligible FROM application_eligibility_evaluations WHERE application_id=$1 ORDER BY evaluated_at', [applied.body.application.id]);
    expect(evaluations.rows).toEqual([{ trigger: 'APPLY', eligible: true }, { trigger: 'TERMS_ACKNOWLEDGED', eligible: false }]);
    const state = await pool.query('SELECT state FROM applications WHERE id=$1', [applied.body.application.id]);
    expect(state.rows[0].state).toBe('APPLIED');
  });

  it('keeps §5.1: 401 without a token, 403 for another employer, a suspended employer and an unverified one editing a live job', async () => {
    const { employerId, recruiterId } = await employer();
    const id = await job(employerId, recruiterId);
    const body = { ...baseTerms, expectedCurrentVersionId: await currentVersion(id), stages: [{ kind: 'SCREENING', label: 'Screen' }] };
    await api().post(base(employerId) + '/' + id + '/versions').send(body).expect(401);
    const other = await employer();
    await api().post(base(employerId) + '/' + id + '/versions').set(auth(other.recruiterId)).send(body).expect(403);
    await api().get('/api/v1/employers/' + employerId + '/skill-catalogue').set(auth(other.recruiterId)).expect(403);
    await api().get('/api/v1/employers/' + employerId + '/skill-catalogue').expect(401);
    await pool.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [employerId]);
    const suspended = await api().post(base(employerId) + '/' + id + '/versions').set(auth(recruiterId)).send(body).expect(403);
    expect(suspended.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    await pool.query("UPDATE organizations SET verification_state='PENDING', active=true WHERE id=$1", [employerId]);
    const unverified = await api().post(base(employerId) + '/' + id + '/versions').set(auth(recruiterId)).send(body).expect(403);
    expect(unverified.body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
  });
});

describe('EMP-06: apply enforces blocking eligibility from academic records', () => {
  it('refuses a student below the CGPA and tells them which rule; nothing is written', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId, { eligibilityRules: cgpaAndBacklogs });
    const below = await student(college, [{ value: 6.4, verified: true, backlogs: 0 }]);
    const response = await applyAs(below, id).expect(400);
    expect(response.body.error.code).toBe('ELIGIBILITY_NOT_MET');
    expect(response.body.error.rules).toEqual([expect.objectContaining({ ruleType: 'MIN_CGPA', outcome: 'NOT_MET', basis: 'VERIFIED', displayValue: '7' })]);
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id=$1', [below])).rows[0].n).toBe(0);
  });

  it('refuses a student above the backlog limit and tells them which rule', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId, { eligibilityRules: cgpaAndBacklogs });
    const backlogs = await student(college, [{ value: 8, verified: true, backlogs: 1 }, { value: 8.1, verified: true, backlogs: 1 }]);
    const response = await applyAs(backlogs, id).expect(400);
    expect(response.body.error.rules.map((rule: { ruleType: string }) => rule.ruleType)).toEqual(['MAX_BACKLOGS']);
  });

  it('with no academic record, a blocking rule cannot be confirmed: refused as unknown, and the student is told', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId, { eligibilityRules: [cgpaAndBacklogs[0]] });
    const unknown = await student(college);
    const detail = await api().get('/api/v1/opportunities/' + id).set(auth(unknown)).expect(200);
    expect(detail.body.eligibility).toMatchObject({ eligible: false, blockingFailures: [], needsMoreInformation: ['MIN_CGPA'] });
    expect(detail.body.eligibility.rules[0]).toMatchObject({ outcome: 'UNKNOWN', unknownReason: 'NO_RECORD', yourValue: null });
    const response = await applyAs(unknown, id).expect(400);
    expect(response.body.error.code).toBe('ELIGIBILITY_UNKNOWN');
  });

  it('uses a self-reported record where nothing is verified, and flags it to the employer without the figure', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId, {
      eligibilityRules: [...cgpaAndBacklogs, { ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Willing to relocate to Chennai' }],
      stages: [{ kind: 'SCREENING', label: 'Résumé screen' }, { kind: 'GROUP_DISCUSSION', label: 'Group discussion' }, { kind: 'INTERVIEW', label: 'Panel interview' }, { kind: 'OFFER', label: 'Offer' }],
    });
    const declared = await student(college, [{ value: 8.37, verified: false, backlogs: 0 }]);
    const verified = await student(college, [{ value: 7.9, verified: true, backlogs: 0 }]);

    const detail = await api().get('/api/v1/opportunities/' + id).set(auth(declared)).expect(200);
    expect(detail.body.eligibility.eligible).toBe(true);
    const cgpa = detail.body.eligibility.rules.find((rule: { ruleType: string }) => rule.ruleType === 'MIN_CGPA');
    expect(cgpa).toMatchObject({ outcome: 'MET', basis: 'SELF_REPORTED', yourValue: '8.37 on a 10-point CGPA (Semester 1)' });
    expect(detail.body.opportunity.selectionStages.map((stage: { label: string }) => stage.label)).toEqual(['Résumé screen', 'Group discussion', 'Panel interview', 'Offer']);

    const declaredApp = (await applyAs(declared, id).expect(201)).body.application.id as string;
    const verifiedApp = (await applyAs(verified, id).expect(201)).body.application.id as string;
    const list = await api().get(base(employerId) + '/' + id + '/applications').set(auth(recruiterId)).expect(200);
    noReadiness(list.body);
    // The student's figure must not reach the employer. Match it as a standalone number: a timestamp's
    // milliseconds (e.g. "…:18.379Z") can contain the same digits and made this assertion flaky.
    expect(JSON.stringify(list.body)).not.toMatch(/(^|[^0-9])8\.37([^0-9]|$)/);
    const row = (applicationId: string) => list.body.applications.find((item: { id: string }) => item.id === applicationId);
    const declaredCgpa = row(declaredApp).eligibility.outcomes.find((outcome: { ruleType: string }) => outcome.ruleType === 'MIN_CGPA');
    expect(declaredCgpa).toMatchObject({ outcome: 'MET', basis: 'SELF_REPORTED', flagged: true });
    expect(declaredCgpa).not.toHaveProperty('studentValue');
    expect(row(declaredApp).eligibility).toMatchObject({ eligible: true, selfReportedCount: 2, versionNumber: 2 });
    const verifiedCgpa = row(verifiedApp).eligibility.outcomes.find((outcome: { ruleType: string }) => outcome.ruleType === 'MIN_CGPA');
    expect(verifiedCgpa).toMatchObject({ outcome: 'MET', basis: 'VERIFIED', flagged: false });
    // The custom rule never blocked anyone and is flagged for a person to judge.
    expect(row(verifiedApp).eligibility.outcomes.find((outcome: { ruleType: string }) => outcome.ruleType === 'CUSTOM')).toMatchObject({ outcome: 'NOT_EVALUATED', flagged: true });

    // Stages appear in the applicant pipeline in order.
    expect(list.body.stages.map((stage: { order: number; label: string; applicationState: string }) => [stage.order, stage.label, stage.applicationState]))
      .toEqual([[1, 'Résumé screen', 'SCREENING'], [2, 'Group discussion', 'ASSESSMENT'], [3, 'Panel interview', 'INTERVIEW'], [4, 'Offer', 'OFFER']]);

    // The evaluation is a record of what was true then: never rewritten.
    await expect(pool.query('UPDATE application_eligibility_evaluations SET eligible = false WHERE application_id=$1', [declaredApp])).rejects.toThrow(/never rewritten/);

    // Candidate data: once the student withdraws, the employer loses the flags with the person.
    await api().post('/api/v1/students/me/applications/' + declaredApp + '/withdraw').set(auth(declared)).send({}).expect(201);
    const after = await api().get(base(employerId) + '/' + id + '/applications').set(auth(recruiterId)).expect(200);
    expect(after.body.applications.find((item: { id: string }) => item.id === declaredApp).eligibility).toBeNull();
  });

  it('a job with no rules still takes applications and records nothing to flag', async () => {
    const { employerId, recruiterId } = await employer();
    const college = await institution();
    const id = await job(employerId, recruiterId);
    const anyone = await student(college);
    const applied = await applyAs(anyone, id).expect(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM application_eligibility_evaluations WHERE application_id=$1', [applied.body.application.id])).rows[0].n).toBe(0);
    const list = await api().get(base(employerId) + '/' + id + '/applications').set(auth(recruiterId)).expect(200);
    expect(list.body.applications[0].eligibility).toBeNull();
    expect(list.body.stages).toEqual([]);
  });
});
