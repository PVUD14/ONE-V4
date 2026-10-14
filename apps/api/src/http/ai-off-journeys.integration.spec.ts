/**
 * X2 (ENG-25 acceptance, ONE Program Goal): "with every AI flag off, the student, faculty and TPO journeys
 * still complete". Seeds the sandbox's fictional college (ADR-046) into a throwaway schema, proves every AI
 * switch is off, and walks each journey through the same routes the web and Android apps call: the student
 * (home, jobs, learning path, a practice step with the written hints to the end, the next step), the
 * lecturer (their students, the learning cohort, a student's plan, a plan override with a reason) and the
 * placement officer (cohort readiness by role, campus drives, the placement register). No model is reachable:
 * the global fetch is replaced by one that fails the test if anything tries to call out.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { DEMO_PERSONAS, seedSandbox, type DemoPersona } from '@planthepath/persistence/src/sandbox-seed.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for the AI-off journey tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('The AI-off journey tests require local Postgres');
const schemaName = 'ai_off_journeys_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const subjects = new Map<DemoPersona, string>(DEMO_PERSONAS.map((persona) => [persona, randomUUID()]));
const outboundCalls: unknown[] = [];
const AI_ENV = ['ONE_AI_TUTOR_AUDIENCE', 'ONE_SANDBOX', 'ONE_AI_BASE_URL', 'ONE_AI_API_KEY', 'ONE_AI_MODEL', 'ASSISTANT_ENABLED', 'ANTHROPIC_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
let app: INestApplication;
let collegeId: string;

beforeAll(async () => {
  // Every AI switch the server reads from its environment is unset.
  for (const key of AI_ENV) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  await seedSandbox(pool, { subjects });
  // Nothing may leave the process from here on (the seed has finished with any local file reads).
  vi.stubGlobal('fetch', async (...args: unknown[]) => { outboundCalls.push(args[0]); throw new Error('no outbound call may be made with AI off'); });
  const tokens = new Set(subjects.values());
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
  collegeId = ((await api().get('/api/v1/security/context').set(as('placement')).expect(200)).body as { memberships: { organizationId: string }[] }).memberships[0]!.organizationId;
}, 600_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const key of AI_ENV) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

const api = () => request(app.getHttpServer());
const as = (persona: DemoPersona) => ({ Authorization: 'Bearer ' + subjects.get(persona)!, 'X-Correlation-Id': 'x2-' + randomUUID() });

describe('X2: with every AI flag off, every journey completes', () => {
  it('every AI switch is off: no feature on, the assistant off, no college with the tutor, no tutor audience', async () => {
    expect((await pool.query('SELECT count(*)::int AS n FROM ai_feature_policies WHERE enabled')).rows[0].n).toBe(0);
    expect((await pool.query("SELECT enabled FROM feature_flags WHERE key = 'ai.assistant'")).rows[0].enabled).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_college_rollouts WHERE enabled')).rows[0].n).toBe(0);
    for (const key of AI_ENV) expect(process.env[key], key).toBeUndefined();
  });

  it('the student: home, jobs, applications, the learning path, a practice step to the end with the written hints, and the next step', async () => {
    await api().get('/api/v1/students/me').set(as('student')).expect(200);
    await api().get('/api/v1/opportunities').set(as('student')).expect(200);
    await api().get('/api/v1/students/me/applications').set(as('student')).expect(200);
    await api().get('/api/v1/students/me/learning-actions').set(as('student')).expect(200);
    const path = await api().get('/api/v1/learning/path').set(as('student')).expect(200);
    expect(path.body.path.target).not.toBeNull();
    const started = await api().post('/api/v1/learning/next-step').set(as('student')).send({}).expect(201);
    let step = started.body.step as Record<string, any>;
    const base = `/api/v1/learning/steps/${step.decisionId}`;
    let answered = 0;
    while (step.practice.status === 'IN_PROGRESS') {
      const question = step.practice.question;
      // The tutor is not offered: no AI control, and nothing about the tutor but its absence.
      expect(question.tutor).toEqual({ available: false, reason: 'OFF', remainingToday: null });
      if (question.hintsAvailable) {
        const hinted = await api().post(`${base}/hints`).set(as('student')).send({ questionId: question.id }).expect(201);
        expect(hinted.body.step.practice.question.hintDetails[0]).toMatchObject({ level: 1, source: 'LADDER', state: 'SHOWN' });
      }
      const answer = await api().post(`${base}/answers`).set(as('student')).send({ questionId: question.id, selectedOptionId: question.options[0].id }).expect(201);
      expect(typeof answer.body.feedback.correct).toBe('boolean');
      step = answer.body.step;
      answered += 1;
      expect(answered).toBeLessThanOrEqual(5);
    }
    // The sample college's published practice, answered to the end.
    expect(answered).toBeGreaterThan(0);
    expect(step.practice).toEqual({ status: 'COMPLETED', questionsAnswered: answered });
    await api().post('/api/v1/learning/next-step').set(as('student')).send({}).expect(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_hints')).rows[0].n).toBe(0);
  });

  it('the college admin assigns the lecturer a class; the lecturer: their students, the learning cohort, due reviews, a student’s plan and a plan override with a reason', async () => {
    const before = await api().get(`/api/v1/institutions/${collegeId}/my-students`).set(as('lecturer')).expect(200);
    const first = (before.body.students as { profileId: string; units: { batch: string | null } }[])[0]!;
    // The admin's half of the faculty journey: give the lecturer the student's batch to teach.
    const options = await api().get(`/api/v1/institutions/${collegeId}/teaching-assignments`).set(as('institution-admin')).expect(200);
    const lecturerEmail = (await pool.query("SELECT email FROM users WHERE external_subject = $1", [subjects.get('lecturer')])).rows[0].email as string;
    const faculty = (options.body.faculty as { membershipId: string; email: string }[]).find((entry) => entry.email === lecturerEmail);
    const unit = (options.body.units as { id: string; kind: string; name: string }[]).find((entry) => entry.kind === 'BATCH' && entry.name === first.units.batch);
    expect(faculty && unit).toBeTruthy();
    const assigned = await api().post(`/api/v1/institutions/${collegeId}/teaching-assignments`).set(as('institution-admin'))
      .send({ facultyMembershipId: faculty!.membershipId, unitId: unit!.id, subjectCode: 'X2-APT', academicTerm: '2026-27 Odd', reasonCode: 'TERM_TIMETABLE' });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    const mine = await api().get(`/api/v1/institutions/${collegeId}/my-students`).set(as('lecturer')).expect(200);
    const students = mine.body.students as { profileId: string }[];
    expect(students.map((student) => student.profileId)).toContain(first.profileId);
    await api().get(`/api/v1/institutions/${collegeId}/learning-cohort`).set(as('lecturer')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/learning-cohort/due-reviews`).set(as('lecturer')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/learning-actions`).set(as('lecturer')).expect(200);
    const plan = await api().get(`/api/v1/institutions/${collegeId}/students/${first.profileId}/learning-plan`).set(as('lecturer'));
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const resources = await api().get(`/api/v1/institutions/${collegeId}/learning-resources`).set(as('lecturer')).expect(200);
    const skill = (resources.body.resources as { kind: string; skillId: string }[]).find((resource) => resource.kind !== 'LESSON');
    expect(skill).toBeDefined();
    const override = await api().post(`/api/v1/institutions/${collegeId}/students/${first.profileId}/plan-overrides`).set(as('lecturer'))
      .send({ action: 'PRACTICE', resource: { kind: skill!.kind, skillId: skill!.skillId }, reasonCode: 'FACULTY_JUDGEMENT' });
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    expect(override.body.override).toMatchObject({ state: 'PENDING', action: 'PRACTICE', reasonCode: 'FACULTY_JUDGEMENT' });
  });

  it('the placement officer: cohort readiness by role (bands, never a number), campus drives and the placement register', async () => {
    const roles = await api().get(`/api/v1/institutions/${collegeId}/cohort-readiness/roles`).set(as('placement')).expect(200);
    const list = (roles.body.roles ?? []) as { careerRoleId?: string; id?: string }[];
    expect(list.length).toBeGreaterThan(0);
    const roleId = list[0]!.careerRoleId ?? list[0]!.id!;
    const report = await api().get(`/api/v1/institutions/${collegeId}/cohort-readiness`).query({ careerRoleId: roleId }).set(as('placement'));
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(JSON.stringify(report.body)).not.toMatch(/"(readinessScore|readiness_score|score)"\s*:/u);
    await api().get(`/api/v1/institutions/${collegeId}/preparation-sprints`).set(as('placement')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/campus-drives`).set(as('placement')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/placement-register`).set(as('placement')).expect(200);
  });

  it('nothing tried to reach a model or any other outside service', () => {
    expect(outboundCalls).toEqual([]);
  });
});
