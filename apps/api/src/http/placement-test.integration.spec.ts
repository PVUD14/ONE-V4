/**
 * API tests for the placement test routes (ENG-14): 401 without a token; NOT_AVAILABLE — and
 * nothing written — without the adaptive-learning purpose or without 25 published, calibrated
 * aptitude items; a full sitting through the API that never returns an answer key, correctness, an
 * item parameter or an ability estimate; 400 on bad input; 409 on an answer to a question that was
 * not served; 404 on another student's sitting.
 *
 * Runs in its own schema with synthetic people and items only.
 */
import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for placement test integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-placement-test-client';
const keyId = 'placement-test-key';
const schemaName = `placement_${process.pid}`;
const CONSENT_VERSION = 'eng14-api-synthetic';
const SHA = 'f'.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
const keyOf = new Map<string, string>();

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  // adaptive-learning, live for this suite only (publishing the real definition is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = greatest(now(), effective_from) WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `placement-test-${randomUUID()}` });

async function student(options: { consent: boolean }): Promise<{ id: string; token: string }> {
  const sub = `sub:${randomUUID()}`;
  const email = `${randomUUID()}@placement.test`;
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: sub, email, state: 'ACTIVE' });
  if (options.consent) {
    await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES ($1, $2, 'adaptive-learning', $3, 'GRANTED', now() - interval '10 seconds')`, [randomUUID(), id, CONSENT_VERSION]);
  }
  return { id, token: signAccessToken(privateKey, { sub, email }) };
}

/** Publishes `count` synthetic aptitude questions over three active apt-* topics, each calibrated. */
async function publishAptitudeBank(count: number): Promise<void> {
  const author = (await student({ consent: false })).id;
  const reviewer = (await student({ consent: false })).id;
  const suffix = randomUUID().slice(0, 8);
  const [runId, packageId, sourceRecordId, manifestId, calibrationRun] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/eng-14', $3, $4, 'eng14-test', 'STAGED', $5, now())`, [runId, `eng14-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/eng-14', $4, $5, 'eng14-test', '[]', '{}', '{}')`, [packageId, runId, `eng14-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'eng14', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
  const topics: string[] = [];
  for (const prefix of ['apt-q', 'apt-l', 'apt-v']) {
    const [topicId, revision] = [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
    await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
      VALUES ($1, 'TOPIC', $2, 1, 'Synthetic aptitude skill', 'Synthetic topic for ENG-14 API tests', $3)`, [topicId, `${prefix}-eng14-${suffix}`, revision]);
    topics.push(topicId);
  }
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [manifestId, `eng14-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  const questions: { id: string; revision: string; topic: string; key: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const [id, revision] = [randomUUID(), randomUUID()];
    const key = ['a', 'b', 'c', 'd'][index % 4]!;
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
    await pool.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revision]);
    await pool.query(`INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES ($1, $2, $3, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng14-approve')`, [randomUUID(), revision, reviewer]);
    await pool.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revision]);
    await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
      [manifestId, revision, sourceRecordId, SHA]);
    questions.push({ id, revision, topic: topics[index % 3]!, key });
  }
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, reviewer]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, reviewer]);
  await pool.query(`INSERT INTO item_calibration_runs (id, source, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at)
    VALUES ($1, 'jobs/calibration', 'item-calibration-2pl-v1', 'girth==0.8.0', 200, 300, 300, $2, now(), now())`, [calibrationRun, count]);
  for (const [index, question] of questions.entries()) {
    await pool.query("UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = $2, published_at = now() WHERE id = $1", [question.revision, manifestId]);
    const options = ['a', 'b', 'c', 'd'].map((option) => ({ id: option, text: `Synthetic option ${option.toUpperCase()}` }));
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `eng14-api-q-${question.id}`, question.topic, `Synthetic placement question ${index + 1}`, JSON.stringify(options), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, $2, 'Synthetic.', $3)`,
      [question.id, question.key, SHA]);
    await pool.query(`INSERT INTO item_calibrations (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status, status_reason)
      VALUES ($1, $2, 'CAREER_READINESS_QUESTION', $3, 1, '2PL', $4, 1.3, 250, 'CALIBRATED', NULL)`,
    [randomUUID(), calibrationRun, question.id, Number((-2 + (4 * index) / (count - 1)).toFixed(4))]);
    keyOf.set(question.id, question.key);
  }
}

const LEAKS = ['correct', 'difficulty', 'discrimination', 'theta', 'standardError', 'calibration', 'readiness', 'answerKey'];

describe('placement test routes', () => {
  it('require a signed-in user', async () => {
    expect((await api().get('/api/v1/learning/placement-test')).status).toBe(401);
    expect((await api().post('/api/v1/learning/placement-test')).status).toBe(401);
  });

  it('fail closed: not available without the purpose, or with too few published calibrated items, and nothing is written', async () => {
    const withConsent = await student({ consent: true });
    const without = await student({ consent: false });
    const none = await api().post('/api/v1/learning/placement-test').set(auth(without.token));
    expect(none.status).toBe(201);
    expect(none.body.placement).toEqual({ status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' });
    const empty = await api().post('/api/v1/learning/placement-test').set(auth(withConsent.token));
    expect(empty.body.placement).toEqual({ status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' });
    const read = await api().get('/api/v1/learning/placement-test').set(auth(withConsent.token));
    expect(read.status).toBe(200);
    expect(read.body.placement).toEqual({ status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' });
    expect((await pool.query('SELECT 1 FROM placement_tests')).rowCount).toBe(0);
  });

  it('runs a sitting to its end without ever returning a key, correctness or a parameter', async () => {
    await publishAptitudeBank(30);
    const learner = await student({ consent: true });
    const other = await student({ consent: true });
    const started = await api().post('/api/v1/learning/placement-test').set(auth(learner.token));
    expect(started.status).toBe(201);
    let placement = started.body.placement;
    expect(placement.status).toBe('IN_PROGRESS');
    expect(placement.maxQuestions).toBe(25);

    // Input and ownership refusals.
    const path = `/api/v1/learning/placement-test/${placement.placementTestId}/answers`;
    expect((await api().post(path).set(auth(learner.token)).send({ questionId: 'nope', selectedOptionId: 'a' })).status).toBe(400);
    expect((await api().post(path).set(auth(learner.token)).send({ questionId: placement.question.id, selectedOptionId: 'a', extra: 1 })).status).toBe(400);
    expect((await api().post('/api/v1/learning/placement-test/not-a-uuid/answers').set(auth(learner.token)).send({ questionId: placement.question.id, selectedOptionId: 'a' })).status).toBe(400);
    const invalidOption = await api().post(path).set(auth(learner.token)).send({ questionId: placement.question.id, selectedOptionId: 'z' });
    expect(invalidOption.status).toBe(400);
    expect(invalidOption.body.error.code).toBe('INVALID_OPTION');
    const notServed = [...keyOf.keys()].find((id) => id !== placement.question.id)!;
    const conflict = await api().post(path).set(auth(learner.token)).send({ questionId: notServed, selectedOptionId: 'a' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'NOT_CURRENT_QUESTION' });
    const foreign = await api().post(path).set(auth(other.token)).send({ questionId: placement.question.id, selectedOptionId: 'a' });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(placement.placementTestId);

    let answered = 0;
    const asked = new Set<string>();
    while (placement.status === 'IN_PROGRESS') {
      for (const leak of LEAKS) expect(JSON.stringify(placement)).not.toContain(leak);
      const key = keyOf.get(placement.question.id)!;
      asked.add(placement.question.id);
      // Every third answer wrong, the rest right.
      const selectedOptionId = answered % 3 === 0 ? (key === 'a' ? 'b' : 'a') : key;
      const reply = await api().post(`/api/v1/learning/placement-test/${placement.placementTestId}/answers`).set(auth(learner.token))
        .send({ questionId: placement.question.id, selectedOptionId });
      expect(reply.status).toBe(201);
      placement = reply.body.placement;
      answered += 1;
      expect(answered).toBeLessThanOrEqual(25);
    }
    expect(placement.status).toBe('COMPLETED');
    expect(placement.questionsAnswered).toBe(answered);
    expect(Object.keys(placement).sort()).toEqual(['completedAt', 'placementLevel', 'placementTestId', 'questionsAnswered', 'status', 'stopReason']);
    for (const leak of LEAKS) expect(JSON.stringify(placement)).not.toContain(leak);
    const after = await api().get('/api/v1/learning/placement-test').set(auth(learner.token));
    expect(after.body.placement).toEqual(placement);
    const late = await api().post(`/api/v1/learning/placement-test/${placement.placementTestId}/answers`).set(auth(learner.token))
      .send({ questionId: [...keyOf.keys()].find((id) => !asked.has(id))!, selectedOptionId: 'a' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ALREADY_COMPLETED');

    const attempts = await pool.query("SELECT context FROM learning_attempt_events WHERE subject_user_id = $1", [learner.id]);
    expect(attempts.rowCount).toBe(answered);
    expect(attempts.rows.every((row: { context: string }) => row.context === 'DIAGNOSTIC')).toBe(true);
    expect((await pool.query('SELECT 1 FROM readiness_snapshots WHERE subject_user_id = $1', [learner.id])).rowCount).toBe(0);
  });
});

async function applyMigrations(targetPool: Pool): Promise<void> {
  const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationName of migrations) {
    const migration = (await readFile(new URL(migrationName, migrationDir), 'utf8'))
      .replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await targetPool.query(migration);
  }
}

function signAccessToken(signingKey: KeyObject, input: { readonly sub: string; readonly email: string }): string {
  const header = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: issuer, sub: input.sub, client_id: clientId, token_use: 'access',
    exp: Math.floor(new Date('2026-08-16T13:00:00Z').getTime() / 1000),
    iat: Math.floor(new Date('2026-08-16T11:00:00Z').getTime() / 1000),
    email: input.email, email_verified: true,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(signingKey).toString('base64url')}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function publicKeyToTrustedJwk(key: KeyObject, kid: string): TrustedJwk {
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('invalid test key');
  return { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' };
}
