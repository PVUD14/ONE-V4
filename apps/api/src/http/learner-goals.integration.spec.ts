/**
 * API tests for the student goals and onboarding routes (ENG-19): 401 without a token; a first-run
 * onboarding through HTTP ("What job do you want?" by synonym, then a topic goal); "Not sure yet" with
 * 3–5 suggestions from real catalogue rows, attempt history used only under the adaptive-learning purpose;
 * 400 on bad input, 404 on another student's goal or an unknown topic, 409 on a duplicate; and no
 * readiness value or score in any response. Onboarding needs no enrolment (graduates).
 *
 * Real Postgres in a throwaway schema; the catalogue is seeded from the real input file; synthetic people.
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
import { buildCareerCatalogueFile } from '@planthepath/persistence/src/career-catalogue-input.js';
import { seedCareerCatalogue, seedCareerCatalogueGoals } from '@planthepath/persistence/src/career-catalogue.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { LearnerGoalsController } from './learner-goals.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learner goals tests');

const schemaName = 'eng19_api_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'c'.repeat(64);
const CONSENT_VERSION = 'eng19-api-synthetic';
let app: INestApplication;
let socId: string;
let commsTopic: string;

async function learner(options: { consent?: boolean } = {}): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  if (options.consent) {
    await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES ($1, $2, 'adaptive-learning', $3, 'GRANTED', now() - interval '10 seconds')`, [randomUUID(), userId, CONSENT_VERSION]);
  }
  return userId;
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [LearnerGoalsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  const author = await learner();
  const revision = randomUUID();
  commsTopic = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, commsTopic, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1,'TOPIC','eng19-api-communication',1,'Professional communication','Synthetic topic for ENG-19 API tests',$2)`, [commsTopic, revision]);
  for (const [code, title, family] of [
    ['SOC_ANALYST', 'Security Operations Analyst', 'Cyber Security'], ['SOFTWARE_ENGINEER', 'Software Engineer', 'Engineering'],
    ['DATA_ANALYST', 'Data Analyst', 'Data'], ['BUSINESS_ANALYST', 'Business Analyst', 'Business'], ['CUSTOMER_SUCCESS', 'Customer Success Associate', 'Business'],
  ] as const) {
    await pool.query('INSERT INTO career_roles (id, code, title, family, active) VALUES ($1,$2,$3,$4,true)', [randomUUID(), code, title, family]);
  }
  socId = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE code='SOC_ANALYST'")).rows[0]!.id;
  await pool.query("INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.75)", [randomUUID(), socId, commsTopic]);
  await pool.query("INSERT INTO career_role_synonyms (id, career_role_id, synonym, normalized, reason_code) VALUES ($1,$2,'SOC analyst','soc analyst','SEARCH_TERM')", [randomUUID(), socId]);
  const file = buildCareerCatalogueFile(await readFile(new URL('../../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url), 'utf8'));
  await seedCareerCatalogue(pool, file);
  await seedCareerCatalogueGoals(pool, file);
  // adaptive-learning, live for this suite only (publishing the real definition is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = greatest(now(), effective_from) WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'eng19-' + randomUUID() });
const base = '/api/v1/students/me/goals';

describe('learner goals API', () => {
  it('401 without a token on every route', async () => {
    for (const response of [
      await api().get(base), await api().get(base + '/options'), await api().get(base + '/discovery'),
      await api().post(base).send({ goalType: 'TOPIC', topicId: commsTopic }),
      await api().post(base + '/discovery').send({ interests: ['BUILDING_SOFTWARE'], branch: 'CSE' }),
      await api().post(`${base}/${randomUUID()}/end`).send({ status: 'WITHDRAWN' }),
    ]) expect(response.status).toBe(401);
  });

  it('onboards a learner with no enrolment: role by synonym, then a topic goal, the shared skill listed once', async () => {
    const student = await learner();
    const first = await api().get(base).set(auth(student));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ onboarding: true, goals: [], catalogueOpen: false });

    const options = await api().get(base + '/options').query({ q: 'soc analyst' }).set(auth(student));
    expect(options.status).toBe(200);
    expect(options.body.roles.map((role: { id: string; matchedSynonym: string | null }) => [role.id, role.matchedSynonym])).toEqual([[socId, 'SOC analyst']]);
    expect(options.body.catalogueGoals).toEqual([]);

    const set = await api().post(base).set(auth(student)).send({ goalType: 'ROLE', careerRoleId: socId, priority: 'PRIMARY', origin: 'ONBOARDING' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body.onboarding).toBe(false);
    expect(set.body.goals[0]).toMatchObject({ goalType: 'ROLE', priority: 'PRIMARY', origin: 'ONBOARDING', role: { careerRoleId: socId, releaseLabel: null } });

    const topic = await api().post(base).set(auth(student)).send({ goalType: 'TOPIC', topicId: commsTopic });
    expect(topic.status).toBe(201);
    expect(topic.body.skills.skills).toHaveLength(1);
    expect(topic.body.skills.skills[0].goals.map((goal: { goalType: string }) => goal.goalType)).toEqual(['ROLE', 'TOPIC']);
    expect(JSON.stringify(topic.body)).not.toMatch(/readiness|score|observedMastery/i);

    const duplicate = await api().post(base).set(auth(student)).send({ goalType: 'TOPIC', topicId: commsTopic });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('GOAL_ALREADY_SET');

    const topicGoalId = (topic.body.goals as { id: string; goalType: string }[]).find((goal) => goal.goalType === 'TOPIC')!.id;
    const stranger = await learner();
    const notYours = await api().post(`${base}/${topicGoalId}/end`).set(auth(stranger)).send({ status: 'ACHIEVED' });
    expect(notYours.status).toBe(404);
    const ended = await api().post(`${base}/${topicGoalId}/end`).set(auth(student)).send({ status: 'ACHIEVED' });
    expect(ended.status).toBe(200);
    expect(ended.body.goals).toHaveLength(1);
  });

  it('400 on bad input, 404 on an unknown topic or a catalogue goal while the catalogue is closed', async () => {
    const student = await learner();
    for (const body of [
      {}, { goalType: 'DISCOVERY' }, { goalType: 'ROLE', careerRoleId: 'nope' }, { goalType: 'ROLE', careerRoleId: socId, priority: 'TOP' },
      { goalType: 'TOPIC', topicId: commsTopic, extra: 1 }, { goalType: 'EXAM', catalogueGoalCode: 'X1' }, { goalType: 'TOPIC', topicId: commsTopic, origin: 'SOMEWHERE' },
    ]) {
      const response = await api().post(base).set(auth(student)).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(response.body)).not.toMatch(/stack|sql|constraint/i);
    }
    expect((await api().post(`${base}/not-a-uuid/end`).set(auth(student)).send({ status: 'ACHIEVED' })).status).toBe(400);
    expect((await api().post(`${base}/${randomUUID()}/end`).set(auth(student)).send({ status: 'DONE' })).status).toBe(400);
    expect((await api().get(base + '/options').query({ q: 'x'.repeat(81) }).set(auth(student))).status).toBe(400);
    expect((await api().post(base).set(auth(student)).send({ goalType: 'TOPIC', topicId: randomUUID() })).status).toBe(404);
    const exam = await api().post(base).set(auth(student)).send({ goalType: 'EXAM', catalogueGoalCode: 'G03' });
    expect(exam.status).toBe(404);
    expect(exam.body.error.code).toBe('CATALOGUE_GOAL_NOT_FOUND');
  });

  it('"Not sure yet": 3–5 real catalogue suggestions with reasons; attempt history only with adaptive-learning consent', async () => {
    const withoutConsent = await learner();
    const survey = await api().get(base + '/discovery').set(auth(withoutConsent));
    expect(survey.status).toBe(200);
    expect(survey.body.discovery).toMatchObject({ algorithmId: 'career-discovery-v1', answers: null, result: null });
    expect(survey.body.discovery.survey.interests).toHaveLength(7);

    const answers = { interests: ['BUSINESS_AND_PEOPLE', 'BUILDING_SOFTWARE'], strengths: ['COMMUNICATION'], branch: 'NOT_LISTED', origin: 'ONBOARDING' };
    const plain = await api().post(base + '/discovery').set(auth(withoutConsent)).send(answers);
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    const suggestions = plain.body.discovery.result.suggestions as { role: { id: string }; reasons: { code: string }[] }[];
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(plain.body.discovery.result.usedShownSkills).toBe(false);
    const real = await pool.query("SELECT id FROM career_roles WHERE active AND origin='STARTER' AND id = ANY($1::uuid[])", [suggestions.map((entry) => entry.role.id)]);
    expect(real.rows).toHaveLength(suggestions.length);
    expect(JSON.stringify(plain.body)).not.toMatch(/score|readiness/i);

    const consenting = await learner({ consent: true });
    const personal = await api().post(base + '/discovery').set(auth(consenting)).send(answers);
    expect(personal.status).toBe(201);
    expect(personal.body.discovery.result.usedShownSkills).toBe(true);

    const invalid = await api().post(base + '/discovery').set(auth(withoutConsent)).send({ interests: ['ASTRONAUT'], branch: 'NOT_LISTED' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INTERESTS');
    expect((await api().post(base + '/discovery').set(auth(withoutConsent)).send({ ...answers, extra: true })).status).toBe(400);

    const pick = await api().post(base).set(auth(withoutConsent)).send({ goalType: 'ROLE', careerRoleId: suggestions[0]!.role.id, priority: 'PRIMARY', origin: 'DISCOVERY_SUGGESTION' });
    expect(pick.status).toBe(201);
    expect((pick.body.goals as { goalType: string }[]).map((goal) => goal.goalType)).toEqual(['ROLE']);
  });

  it('offers exam and company goals, labelled by the catalogue, only while the catalogue is open', async () => {
    const student = await learner();
    await pool.query("UPDATE feature_flags SET enabled=true WHERE key='career-catalogue.selectable-roles'");
    try {
      const options = await api().get(base + '/options').set(auth(student));
      expect(options.body.catalogueOpen).toBe(true);
      expect(options.body.catalogueGoals.map((goal: { code: string }) => goal.code)).toEqual(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G09']);
      const exam = await api().post(base).set(auth(student)).send({ goalType: 'EXAM', catalogueGoalCode: 'G03' });
      expect(exam.status).toBe(201);
      expect(exam.body.goals[0]).toMatchObject({ goalType: 'EXAM', catalogueGoal: { code: 'G03' } });
    } finally {
      await pool.query("UPDATE feature_flags SET enabled=false WHERE key='career-catalogue.selectable-roles'");
    }
  });
});
