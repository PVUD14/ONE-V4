/**
 * A student cannot verify their own document (security fix, migration 0107).
 *
 * Over HTTP: VERIFIED/REJECTED from a student is a 400 on create and update; a PATCH that omits the state
 * keeps it; a verified document is frozen (PATCH and file upload answer 409) and a rejected one changes
 * only when the student explicitly asks again, which is audited. At the database: VERIFIED/REJECTED need a
 * recorded verifier who is an active member of the verifying institution and is not the owner, a
 * verification is permanent, and a decided document's substance cannot change even with the API bypassed.
 * The 0107 reset: self-asserted VERIFIED/REJECTED rows become SELF_REPORTED, nothing else changes, nothing
 * is deleted. And no employer- or institution-facing reader of the documents table reads its
 * verification state, so a self-reported document is never shown to them as checked.
 *
 * Real Postgres in a throwaway schema of the local database in DATABASE_URL, a stub verifier and scanner,
 * synthetic people and institutions.
 */
import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
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
import type { FileScanner } from '../storage/clamav.js';
import { buildSnapshotFor } from './application-snapshots.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for document verification integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'one-document-verification-test-client';
const keyId = 'document-verification-test-key';
const schemaName = `doc_verify_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});
const scanner: FileScanner = { engine: 'test-scanner', async scan() { return { state: 'CLEAN' }; } };
const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
const repositoryRoot = new URL('../../../../', import.meta.url);

let adminPool: Pool;
let pool: Pool;
let app: INestApplication;
let storageRoot: string;
let institutionId: string;
let reviewer: string;
let studentId: string;
let studentToken: string;
/** Rows inserted before 0107 ran, keyed by the state they held. */
const legacy: Record<string, string> = {};

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  const db = drizzle(pool, { schema });

  // Everything before 0107, then rows exactly as the old student routes could leave them, then 0107 on.
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  await applyMigrations(files.filter((file) => file < '0107'));
  const owner = await user();
  for (const state of ['SELF_REPORTED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED']) {
    legacy[state] = randomUUID();
    await pool.query(`INSERT INTO student_document_metadata (id,student_user_id,title,document_type,description,verification_state)
      VALUES ($1,$2,$3,'CERTIFICATE','Kept as it was',$4)`, [legacy[state], owner, `Legacy ${state}`, state]);
  }
  await applyMigrations(files.filter((file) => file >= '0107'));
  storageRoot = await mkdtemp(join(tmpdir(), 'one-doc-verify-'));

  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      verifier, identityStore, db, fileStorage: createLocalDiskStorage(storageRoot), fileScanner: scanner,
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Verification College','VERIFIED',true)", [institutionId]);
  reviewer = await user();
  await membership(institutionId, reviewer);
  const sub = `sub:${randomUUID()}`;
  studentId = await user(sub);
  studentToken = signAccessToken(privateKey, { sub, email: `${sub.slice(4, 12)}@uat.example.test` });
  await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE', now() - interval '30 days')", [randomUUID(), institutionId, studentId]);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

const api = () => request(app.getHttpServer());
const auth = () => ({ authorization: `Bearer ${studentToken}`, 'x-correlation-id': `doc-verify-${randomUUID()}` });

async function user(externalSubject: string | null = null): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1,$2,$3,'ACTIVE')", [id, `doc-verify-${id.slice(0, 8)}@uat.example.test`, externalSubject]);
  return id;
}

async function membership(organizationId: string, userId: string, state = 'ACTIVE'): Promise<void> {
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,'INSTITUTION_ADMIN',$4,$2,$2)`, [randomUUID(), organizationId, userId, state]);
}

async function createDocument(body: Record<string, unknown> = {}): Promise<string> {
  const response = await api().post('/api/v1/students/me/documents').set(auth())
    .send({ title: 'Degree certificate', documentType: 'CERTIFICATE', ...body }).expect(201);
  return String(response.body.document.id);
}

/** The fixture a staff verification route will replace: a decision with its verifier recorded. */
async function decide(documentId: string, state: 'VERIFIED' | 'REJECTED'): Promise<void> {
  await pool.query(`UPDATE student_document_metadata
    SET verification_state = $2, verified_by_user_id = $3, verified_at = now(), verification_institution_id = $4
    WHERE id = $1`, [documentId, state, reviewer, institutionId]);
}

async function row(documentId: string): Promise<Record<string, unknown>> {
  const result = await pool.query(`SELECT title, description, verification_state, verified_by_user_id, archived_at
    FROM student_document_metadata WHERE id = $1`, [documentId]);
  return result.rows[0] as Record<string, unknown>;
}

describe('a student cannot verify their own document', () => {
  it('refuses VERIFIED and REJECTED on create with a 400 and stores nothing', async () => {
    for (const verificationState of ['VERIFIED', 'REJECTED']) {
      const title = `Claimed ${verificationState} ${randomUUID().slice(0, 6)}`;
      const response = await api().post('/api/v1/students/me/documents').set(auth())
        .send({ title, documentType: 'CERTIFICATE', verificationState }).expect(400);
      expect(response.body.error.code).toBe('DOCUMENT_VERIFICATION_STATE_NOT_ALLOWED');
      const stored = await pool.query('SELECT 1 FROM student_document_metadata WHERE title = $1', [title]);
      expect(stored.rows).toHaveLength(0);
    }
  });

  it('lets a student ask for verification, and shows no decision time', async () => {
    const response = await api().post('/api/v1/students/me/documents').set(auth())
      .send({ title: 'Internship letter', documentType: 'OTHER', verificationState: 'PENDING_VERIFICATION' }).expect(201);
    expect(response.body.document).toMatchObject({ verificationState: 'PENDING_VERIFICATION', verifiedAt: null });
    const plain = await api().post('/api/v1/students/me/documents').set(auth())
      .send({ title: 'Course certificate', documentType: 'CERTIFICATE' }).expect(201);
    expect(plain.body.document).toMatchObject({ verificationState: 'SELF_REPORTED', verifiedAt: null });
  });

  it('refuses VERIFIED and REJECTED on update with a 400 and leaves the row alone', async () => {
    const id = await createDocument({ verificationState: 'PENDING_VERIFICATION' });
    for (const verificationState of ['VERIFIED', 'REJECTED']) {
      const response = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth())
        .send({ title: 'Renamed', documentType: 'CERTIFICATE', verificationState }).expect(400);
      expect(response.body.error.code).toBe('DOCUMENT_VERIFICATION_STATE_NOT_ALLOWED');
    }
    expect(await row(id)).toMatchObject({ title: 'Degree certificate', verification_state: 'PENDING_VERIFICATION', verified_by_user_id: null });
  });

  it('keeps the current state when a PATCH does not set one', async () => {
    const id = await createDocument({ verificationState: 'PENDING_VERIFICATION' });
    const response = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth())
      .send({ title: 'Degree certificate (final)', documentType: 'CERTIFICATE' }).expect(200);
    expect(response.body.document).toMatchObject({ title: 'Degree certificate (final)', verificationState: 'PENDING_VERIFICATION' });
  });

  it('freezes a verified document: PATCH and file upload answer 409, archive still works', async () => {
    const id = await createDocument({ verificationState: 'PENDING_VERIFICATION' });
    await decide(id, 'VERIFIED');
    const shown = await api().get(`/api/v1/students/me/documents/${id}`).set(auth()).expect(200);
    expect(shown.body.document.verificationState).toBe('VERIFIED');
    expect(shown.body.document.verifiedAt).not.toBeNull();
    expect(JSON.stringify(shown.body)).not.toContain(reviewer);

    for (const body of [
      { title: 'Edited after verification', documentType: 'CERTIFICATE' },
      { title: 'Degree certificate', documentType: 'CERTIFICATE', verificationState: 'SELF_REPORTED' },
      { title: 'Degree certificate', documentType: 'CERTIFICATE', verificationState: 'PENDING_VERIFICATION' },
    ]) {
      const response = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth()).send(body).expect(409);
      expect(response.body.error.code).toBe('DOCUMENT_VERIFICATION_DECIDED');
    }
    const upload = await api().post(`/api/v1/students/me/documents/${id}/file`).set(auth())
      .set('Content-Type', 'application/pdf').set('X-Filename', 'swap.pdf').send(Buffer.from('%PDF-1.7\nswap\n')).expect(409);
    expect(upload.body.error.code).toBe('DOCUMENT_VERIFICATION_DECIDED');
    expect(await row(id)).toMatchObject({ title: 'Degree certificate', verification_state: 'VERIFIED', verified_by_user_id: reviewer });

    await api().delete(`/api/v1/students/me/documents/${id}`).set(auth()).expect(200);
    expect((await row(id)).archived_at).not.toBeNull();
  });

  it('changes a rejected document only when the student asks again, and audits it', async () => {
    const id = await createDocument({ verificationState: 'PENDING_VERIFICATION' });
    await decide(id, 'REJECTED');
    const silent = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth())
      .send({ title: 'Quietly renamed', documentType: 'CERTIFICATE' }).expect(409);
    expect(silent.body.error.code).toBe('DOCUMENT_VERIFICATION_DECIDED');
    expect(await row(id)).toMatchObject({ title: 'Degree certificate', verification_state: 'REJECTED', verified_by_user_id: reviewer });

    const again = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth())
      .send({ title: 'Degree certificate (resubmitted)', documentType: 'CERTIFICATE', verificationState: 'PENDING_VERIFICATION' }).expect(200);
    expect(again.body.document).toMatchObject({ verificationState: 'PENDING_VERIFICATION', verifiedAt: null });
    expect(await row(id)).toMatchObject({ verification_state: 'PENDING_VERIFICATION', verified_by_user_id: null });
    const audit = await pool.query(`SELECT actor_user_id, context FROM audit_events
      WHERE resource_id = $1 AND action = 'student.document_metadata.updated'`, [id]);
    expect(audit.rows).toEqual([{ actor_user_id: studentId, context: { verificationState: { from: 'REJECTED', to: 'PENDING_VERIFICATION' } } }]);
  });

  it('does not reveal a decided document belonging to someone else', async () => {
    const other = await user();
    const id = randomUUID();
    await pool.query("INSERT INTO student_document_metadata (id,student_user_id,title,document_type) VALUES ($1,$2,'Not yours','OTHER')", [id, other]);
    await decide(id, 'VERIFIED');
    const response = await api().patch(`/api/v1/students/me/documents/${id}`).set(auth())
      .send({ title: 'Hijack', documentType: 'OTHER' }).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('the database refuses a verification with no verifier, even with the API bypassed', () => {
  async function plainDocument(): Promise<string> {
    const id = randomUUID();
    await pool.query("INSERT INTO student_document_metadata (id,student_user_id,title,document_type) VALUES ($1,$2,'Bypass','CERTIFICATE')", [id, studentId]);
    return id;
  }

  it('refuses VERIFIED or REJECTED without a verifier, on insert and on update', async () => {
    for (const state of ['VERIFIED', 'REJECTED']) {
      await expect(pool.query(`INSERT INTO student_document_metadata (id,student_user_id,title,document_type,verification_state)
        VALUES ($1,$2,'Self-verified','CERTIFICATE',$3)`, [randomUUID(), studentId, state])).rejects.toThrow(/student_document_decided_ck/);
      const id = await plainDocument();
      await expect(pool.query('UPDATE student_document_metadata SET verification_state = $2 WHERE id = $1', [id, state]))
        .rejects.toThrow(/student_document_decided_ck/);
    }
  });

  it('refuses a partial verifier, an undecided row carrying one, and the owner verifying', async () => {
    const id = await plainDocument();
    await expect(pool.query(`UPDATE student_document_metadata SET verification_state = 'VERIFIED', verified_by_user_id = $2 WHERE id = $1`, [id, reviewer]))
      .rejects.toThrow(/student_document_verifier_ck/);
    await expect(pool.query(`UPDATE student_document_metadata SET verified_by_user_id = $2, verified_at = now(), verification_institution_id = $3 WHERE id = $1`, [id, reviewer, institutionId]))
      .rejects.toThrow(/student_document_decided_ck/);
    await membership(institutionId, studentId);
    await expect(pool.query(`UPDATE student_document_metadata SET verification_state = 'VERIFIED', verified_by_user_id = $2, verified_at = now(), verification_institution_id = $3 WHERE id = $1`, [id, studentId, institutionId]))
      .rejects.toThrow(/student_document_not_self_verified_ck/);
  });

  it('refuses a verifier who is not an active member of an institution', async () => {
    const id = await plainDocument();
    const outsider = await user();
    await expect(pool.query(`UPDATE student_document_metadata SET verification_state = 'VERIFIED', verified_by_user_id = $2, verified_at = now(), verification_institution_id = $3 WHERE id = $1`, [id, outsider, institutionId]))
      .rejects.toThrow(/active member of the verifying institution/);
    const suspended = await user();
    await membership(institutionId, suspended, 'SUSPENDED');
    await expect(pool.query(`UPDATE student_document_metadata SET verification_state = 'VERIFIED', verified_by_user_id = $2, verified_at = now(), verification_institution_id = $3 WHERE id = $1`, [id, suspended, institutionId]))
      .rejects.toThrow(/active member of the verifying institution/);
    const employerId = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Employer','VERIFIED',true)", [employerId]);
    const employerStaff = await user();
    await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
      VALUES ($1,$2,$3,'EMPLOYER_OWNER','ACTIVE',$2,$2)`, [randomUUID(), employerId, employerStaff]);
    await expect(pool.query(`UPDATE student_document_metadata SET verification_state = 'VERIFIED', verified_by_user_id = $2, verified_at = now(), verification_institution_id = $3 WHERE id = $1`, [id, employerStaff, employerId]))
      .rejects.toThrow(/on behalf of an institution/);
  });

  it('keeps a verification permanent and a decided document unchanged', async () => {
    const id = await plainDocument();
    await decide(id, 'VERIFIED');
    await expect(pool.query("UPDATE student_document_metadata SET verification_state = 'SELF_REPORTED', verified_by_user_id = NULL, verified_at = NULL, verification_institution_id = NULL WHERE id = $1", [id]))
      .rejects.toThrow(/cannot be unverified/);
    await expect(pool.query("UPDATE student_document_metadata SET title = 'Swapped' WHERE id = $1", [id])).rejects.toThrow(/decided student document cannot be changed/);
    const other = await user();
    await membership(institutionId, other);
    await expect(pool.query('UPDATE student_document_metadata SET verified_by_user_id = $2 WHERE id = $1', [id, other])).rejects.toThrow(/decided student document cannot be changed/);
    // Archiving and clearing the file pointer (privacy deletion) stay possible.
    await pool.query('UPDATE student_document_metadata SET archived_at = now(), current_version_id = NULL WHERE id = $1', [id]);
    expect((await row(id)).verification_state).toBe('VERIFIED');
  });
});

describe('migration 0107 resets self-asserted decisions', () => {
  it('turned every VERIFIED/REJECTED row with no verifier into SELF_REPORTED and changed nothing else', async () => {
    const result = await pool.query(`SELECT id, title, description, verification_state, verified_by_user_id
      FROM student_document_metadata WHERE id = ANY($1::uuid[])`, [Object.values(legacy)]);
    const byId = new Map(result.rows.map((r) => [r.id as string, r]));
    expect(byId.size).toBe(4);
    for (const [state, id] of Object.entries(legacy)) {
      expect(byId.get(id)).toEqual({
        id, title: `Legacy ${state}`, description: 'Kept as it was', verified_by_user_id: null,
        verification_state: state === 'PENDING_VERIFICATION' ? 'PENDING_VERIFICATION' : 'SELF_REPORTED',
      });
    }
  });

  it('is safe to run again', async () => {
    const files = (await readdir(migrationDir)).filter((file) => file.startsWith('0107'));
    expect(files).toHaveLength(1);
    await applyMigrations(files);
    await applyMigrations(files);
    const constraints = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'student_document_metadata'::regclass AND contype = 'c'
      AND conname IN ('student_document_decided_ck','student_document_not_self_verified_ck','student_document_verifier_ck') ORDER BY conname`);
    expect(constraints.rows.map((r) => r.conname)).toEqual(['student_document_decided_ck', 'student_document_not_self_verified_ck', 'student_document_verifier_ck']);
    const triggers = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'student_document_metadata'::regclass AND NOT tgisinternal`);
    expect(triggers.rows.map((r) => r.tgname)).toEqual(['student_document_verification_guard']);
  });
});

describe('no employer or institution surface shows a self-reported document as verified', () => {
  it('the application snapshot an employer receives carries no document verification', async () => {
    const id = await createDocument({ title: 'My résumé', documentType: 'RESUME', verificationState: 'PENDING_VERIFICATION' });
    const fileId = randomUUID(); const versionId = randomUUID();
    await pool.query(`INSERT INTO stored_files (id,storage_key,original_filename,content_type,byte_size,checksum_sha256,upload_state,scan_state,scan_engine,scan_completed_at,uploaded_by_user_id)
      VALUES ($1,$2,'resume.pdf','application/pdf',10,$3,'STORED','CLEAN','test-scanner',now(),$4)`, [fileId, `students/${fileId}.pdf`, 'a'.repeat(64), studentId]);
    await pool.query('INSERT INTO student_document_versions (id,document_id,version_number,file_id,created_by_user_id) VALUES ($1,$2,1,$3,$4)', [versionId, id, fileId, studentId]);
    await pool.query('UPDATE student_document_metadata SET current_version_id = $1 WHERE id = $2', [versionId, id]);

    const built = await buildSnapshotFor(drizzle(pool, { schema }), studentId, id, { phone: null, links: [] });
    expect(built.snapshot.resume).toMatchObject({ title: 'My résumé', filename: 'resume.pdf' });
    expect(JSON.stringify(built.snapshot.resume)).not.toMatch(/verif|PENDING|SELF_REPORTED/i);
  });

  it('only the student\'s own routes and their privacy export read a document\'s verification state', async () => {
    const allowed = new Set([
      'apps/api/src/http/student-operational-core.controller.ts', // the student's own document routes
      'apps/api/src/http/student-documents.controller.ts', // the student's own upload, refused on a decided document
      'apps/api/src/http/privacy-export.ts', // the student's own data copy
    ]);
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (allowed.has(file)) continue;
      const text = await readFile(new URL(file, repositoryRoot), 'utf8');
      for (const template of text.split('`').filter((_, index) => index % 2 === 1)) {
        if (!template.includes('student_document_metadata')) continue;
        const aliases = [...template.matchAll(/student_document_metadata\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1] as string);
        const unaliased = aliases.some((alias) => /^(where|set|on|join|left|order|limit|group)$/i.test(alias)) || aliases.length === 0;
        const named = aliases.filter((alias) => !/^(where|set|on|join|left|order|limit|group)$/i.test(alias));
        const reads = named.some((alias) => new RegExp(`\\b${alias}\\.(verification_state|verified_)`).test(template))
          || (unaliased && !/\bJOIN\b/i.test(template) && /(?<!\.)\b(verification_state|verified_at|verified_by_user_id)\b/.test(template));
        if (reads) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(): Promise<string[]> {
  const roots = ['apps/api/src', 'packages', 'jobs'];
  const found: string[] = [];
  async function walk(relative: string): Promise<void> {
    let entries;
    try { entries = await readdir(new URL(`${relative}/`, repositoryRoot), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) found.push(path);
    }
  }
  for (const root of roots) await walk(root);
  return found;
}

async function applyMigrations(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const migration = (await readFile(new URL(file, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await pool.query(migration);
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
