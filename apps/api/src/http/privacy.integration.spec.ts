import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createLocalDiskStorage } from '../storage/file-storage.js';
import { executeDueDeletions } from './privacy-deletion.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for privacy integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-privacy-test-client';
const keyId = 'privacy-test-key';
const schemaName = `privacy_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

let adminPool: Pool; let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let storageRoot: string;
let storage: ReturnType<typeof createLocalDiskStorage>;
let subjectId: string; let subjectToken: string;
let opsId: string;
let employerId: string;

const ids = { uuid: () => randomUUID() };

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'one-privacy-'));
  storage = createLocalDiskStorage(storageRoot);

  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db, fileStorage: storage, fileScanner: { engine: 'test', async scan() { return { state: 'CLEAN' as const }; } } })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const sub = `sub:${randomUUID()}`;
  subjectId = randomUUID();
  await db.insert(schema.users).values({ id: subjectId, externalSubject: sub, email: 'subject@uat.test', state: 'ACTIVE' });
  subjectToken = signAccessToken(privateKey, { sub, email: 'subject@uat.test' });

  opsId = randomUUID();
  await db.insert(schema.users).values({ id: opsId, externalSubject: `sub:${randomUUID()}`, email: 'ops@uat.test', state: 'ACTIVE' });

  employerId = randomUUID();
  await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Aster Mobility', verificationState: 'VERIFIED' });

  // Data the subject owns, and an application the employer lawfully holds.
  await pool.query(`INSERT INTO student_profiles (user_id, target_career) VALUES ($1, 'SOC Analyst')`, [subjectId]);
  await pool.query(`INSERT INTO student_document_metadata (id, student_user_id, title, document_type) VALUES ($1, $2, 'My CV', 'RESUME')`, [randomUUID(), subjectId]);
  await seedApplication();
});

async function seedApplication(): Promise<void> {
  const opportunityId = randomUUID();
  const versionId = randomUUID();
  await pool.query(`INSERT INTO opportunities (id, employer_id, created_by_user_id, reference_code, lifecycle_state) VALUES ($1,$2,$3,'REF-1','DRAFT')`, [opportunityId, employerId, opsId]);
  await pool.query(
    `INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, employment_type, work_mode, location_city, material_terms_hash, created_by_user_id)
     VALUES ($1,$2,1,'SOC Analyst Intern','INTERNSHIP','ONSITE','Bengaluru',$3,$4)`,
    [versionId, opportunityId, 'a'.repeat(64), opsId],
  );
  await pool.query(`UPDATE opportunities SET current_version_id = $1, lifecycle_state='PUBLISHED', published_at=now() WHERE id = $2`, [versionId, opportunityId]);
  await pool.query(
    `INSERT INTO applications (id, opportunity_id, employer_id, applied_version_id, student_user_id, state, consent_granted_at, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'APPLIED',now(),now())`,
    [randomUUID(), opportunityId, employerId, versionId, subjectId],
  );
}

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

const api = () => request(app.getHttpServer());
const auth = () => ({ authorization: `Bearer ${subjectToken}`, 'x-correlation-id': `privacy-test-${randomUUID()}` });

describe('data export', () => {
  let exportRequestId: string;

  it('produces a bundle containing only the subject data', async () => {
    const response = await api().post('/api/v1/students/me/privacy/exports').set(auth()).expect(201);
    exportRequestId = response.body.request.id;
    expect(response.body.request.state).toBe('READY');

    const download = await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`).set(auth()).expect(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    // Served as application/json, so supertest has already parsed it.
    const bundle = download.body as {
      subjectUserId: string;
      studentProfile: { target_career: string };
      applications: unknown[];
      documents: unknown[];
      notIncluded: string[];
    };
    expect(bundle.subjectUserId).toBe(subjectId);
    expect(bundle.studentProfile.target_career).toBe('SOC Analyst');
    expect(bundle.applications).toHaveLength(1);
    expect(bundle.documents).toHaveLength(1);
    // The bundle says what it does not contain, so silence is not mistaken for absence.
    expect(bundle.notIncluded.join(' ')).toMatch(/scorecards/i);
  });

  it('refuses a second open export rather than duplicating work', async () => {
    const response = await api().post('/api/v1/students/me/privacy/exports').set(auth()).expect(400);
    expect(response.body.error.code).toBe('EXPORT_ALREADY_REQUESTED');
  });

  it('does not serve another subject export', async () => {
    const otherSub = `sub:${randomUUID()}`;
    const otherId = randomUUID();
    await db.insert(schema.users).values({ id: otherId, externalSubject: otherSub, email: 'other@uat.test', state: 'ACTIVE' });
    const otherToken = signAccessToken(privateKey, { sub: otherSub, email: 'other@uat.test' });
    await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`)
      .set({ authorization: `Bearer ${otherToken}`, 'x-correlation-id': `p-${randomUUID()}` }).expect(403);
  });
});

describe('deletion request', () => {
  let deletionId: string;

  it('schedules deletion 30 days out and says so', async () => {
    const response = await api().post('/api/v1/students/me/privacy/deletions').set(auth()).send({ reason: 'No longer job hunting' }).expect(201);
    deletionId = response.body.request.id;
    expect(response.body.gracePeriodDays).toBe(30);
    const scheduled = new Date(response.body.request.scheduledFor).getTime() - Date.now();
    expect(Math.round(scheduled / 86_400_000)).toBe(30);
  });

  it('does nothing while the grace period is running', async () => {
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(0);
    const user = await pool.query('SELECT anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].anonymised_at).toBeNull();
  });

  it('lets the subject cancel inside the grace period', async () => {
    await api().post(`/api/v1/students/me/privacy/requests/${deletionId}/cancel`).set(auth()).expect(201);
    const row = await pool.query('SELECT state FROM privacy_requests WHERE id = $1', [deletionId]);
    expect(row.rows[0].state).toBe('CANCELLED');
    const response = await api().post(`/api/v1/students/me/privacy/requests/${deletionId}/cancel`).set(auth()).expect(400);
    expect(response.body.error.code).toBe('REQUEST_CLOSED');
  });
});

describe('deletion execution', () => {
  let dueId: string;

  it('waits while a retention hold is active', async () => {
    dueId = randomUUID();
    // A genuinely due request: asked for 31 days ago, scheduled for yesterday. The
    // schema refuses a schedule earlier than the request, so both move together.
    await pool.query(
      `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
       VALUES ($1,$2,$2,'DELETION', now() - interval '31 days', now() - interval '1 day')`, [dueId, subjectId],
    );
    await pool.query(
      `INSERT INTO data_retention_holds (id, subject_user_id, reason_code, placed_by_user_id) VALUES ($1,$2,'SAFETY_INVESTIGATION',$3)`,
      [randomUUID(), subjectId, opsId],
    );
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toEqual([expect.objectContaining({ outcome: 'HELD' })]);
    const user = await pool.query('SELECT anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].anonymised_at).toBeNull();
  });

  it('erases the person and keeps the employer record once the hold is released', async () => {
    await pool.query(`UPDATE data_retention_holds SET released_at = now(), released_by_user_id = $1 WHERE subject_user_id = $2`, [opsId, subjectId]);

    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.outcome).toBe('COMPLETED');

    // The person is gone.
    const user = await pool.query('SELECT email, external_subject, state, anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].email).toMatch(/@deleted\.invalid$/);
    expect(user.rows[0].external_subject).toBeNull();
    expect(user.rows[0].state).toBe('DELETED');
    expect(user.rows[0].anonymised_at).not.toBeNull();

    // What was only about them is gone.
    expect((await pool.query('SELECT 1 FROM student_profiles WHERE user_id = $1', [subjectId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM student_document_metadata WHERE student_user_id = $1', [subjectId])).rows).toHaveLength(0);

    // What the employer lawfully holds survives, detached from the person.
    const applications = await pool.query('SELECT state FROM applications WHERE student_user_id = $1', [subjectId]);
    expect(applications.rows).toHaveLength(1);
    expect(applications.rows[0].state).toBe('APPLIED');
  });

  it('records what it erased, anonymised and retained', async () => {
    const records = await pool.query(
      `SELECT category, disposition, basis FROM privacy_deletion_records
       WHERE request_id = $1 ORDER BY category`, [dueId],
    );
    expect(records.rows).toHaveLength(10);
    const byCategory = Object.fromEntries(records.rows.map((r) => [r.category, r]));
    expect(byCategory.AUDIT.disposition).toBe('RETAINED');
    expect(byCategory.AUDIT.basis).toBeTruthy();
    expect(byCategory.APPLICATIONS.disposition).toBe('ANONYMISED');
    expect(byCategory.STUDENT_PROFILE.disposition).toBe('ERASED');
    // Everything kept must say why.
    for (const row of records.rows) {
      if (row.disposition !== 'ERASED') expect(row.basis, `${row.category} must state a basis`).toBeTruthy();
    }
  });

  it('is safe to run again', async () => {
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(0);
    const user = await pool.query('SELECT email FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].email).toMatch(/@deleted\.invalid$/);
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
