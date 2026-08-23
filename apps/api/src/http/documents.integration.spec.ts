import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
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
import type { FileScanner, ScanVerdict } from '../storage/clamav.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for document integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-documents-test-client';
const keyId = 'documents-test-key';
const schemaName = `documents_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

/** Verdict is switched per test so every branch of the upload path is exercised. */
let nextVerdict: ScanVerdict = { state: 'CLEAN' };
const scanner: FileScanner = { engine: 'test-scanner', async scan() { return nextVerdict; } };

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let storageRoot: string;
let studentToken: string;
let otherToken: string;
let documentId: string;

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'one-docs-'));

  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      verifier, identityStore, db,
      fileStorage: createLocalDiskStorage(storageRoot),
      fileScanner: scanner,
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const sub = `sub:${randomUUID()}`;
  const studentId = randomUUID();
  await db.insert(schema.users).values({ id: studentId, externalSubject: sub, email: 'docs@uat.test', state: 'ACTIVE' });
  studentToken = signAccessToken(privateKey, { sub, email: 'docs@uat.test' });

  const otherSub = `sub:${randomUUID()}`;
  await db.insert(schema.users).values({ id: randomUUID(), externalSubject: otherSub, email: 'other@uat.test', state: 'ACTIVE' });
  otherToken = signAccessToken(privateKey, { sub: otherSub, email: 'other@uat.test' });

  documentId = randomUUID();
  await pool.query(
    `INSERT INTO student_document_metadata (id, student_user_id, title, document_type) VALUES ($1, $2, 'My CV', 'RESUME')`,
    [documentId, studentId],
  );
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `docs-test-${randomUUID()}` });
const pdf = Buffer.from('%PDF-1.7\nfake but well typed\n');

function storedFileCount(): number {
  const walk = (dir: string): number => readdirSync(dir, { withFileTypes: true })
    .reduce((total, entry) => total + (entry.isDirectory() ? walk(join(dir, entry.name)) : 1), 0);
  return walk(storageRoot);
}

describe('document upload', () => {
  it('refuses a content type outside the allowlist', async () => {
    nextVerdict = { state: 'CLEAN' };
    await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/x-msdownload')
      .send(Buffer.from('MZ')).expect(415);
    expect(storedFileCount()).toBe(0);
  });

  it('refuses another student document', async () => {
    nextVerdict = { state: 'CLEAN' };
    await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(otherToken)).set('Content-Type', 'application/pdf')
      .send(pdf).expect(403);
    expect(storedFileCount()).toBe(0);
  });

  it('rejects an infected file and writes no bytes', async () => {
    nextVerdict = { state: 'INFECTED', signature: 'Eicar-Test-Signature' };
    const response = await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/pdf')
      .set('X-Filename', 'bad.pdf').send(pdf).expect(400);
    expect(response.body.error.code).toBe('FILE_REJECTED_MALWARE');

    // Nothing on disk, but the event is on the record.
    expect(storedFileCount()).toBe(0);
    const files = await pool.query("SELECT scan_state, deleted_at FROM stored_files WHERE scan_state = 'INFECTED'");
    expect(files.rows).toHaveLength(1);
    expect(files.rows[0].deleted_at).not.toBeNull();
    const events = await pool.query("SELECT signature_reference FROM file_scan_events WHERE scan_state = 'INFECTED'");
    expect(events.rows[0].signature_reference).toBe('Eicar-Test-Signature');
    const readable = await pool.query('SELECT count(*)::int AS count FROM readable_stored_files');
    expect(readable.rows[0].count).toBe(0);
  });

  it('refuses to store anything when the scanner cannot answer', async () => {
    nextVerdict = { state: 'SCAN_FAILED', reason: 'scanner timed out' };
    await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/pdf')
      .send(pdf).expect(503);
    expect(storedFileCount()).toBe(0);
    const readable = await pool.query('SELECT count(*)::int AS count FROM readable_stored_files');
    expect(readable.rows[0].count).toBe(0);
  });

  it('accepts a clean file and makes it the current version', async () => {
    nextVerdict = { state: 'CLEAN' };
    const response = await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/pdf')
      .set('X-Filename', 'cv.pdf').send(pdf).expect(201);
    expect(response.body.file.versionNumber).toBe(1);
    expect(response.body.file.byteSize).toBe(pdf.length);

    expect(storedFileCount()).toBe(1);
    const readable = await pool.query('SELECT original_filename, checksum_sha256 FROM readable_stored_files');
    expect(readable.rows).toHaveLength(1);
    expect(readable.rows[0].original_filename).toBe('cv.pdf');
    const current = await pool.query('SELECT current_version_id FROM student_document_metadata WHERE id = $1', [documentId]);
    expect(current.rows[0].current_version_id).not.toBeNull();
  });

  it('strips any path from the supplied filename', async () => {
    nextVerdict = { state: 'CLEAN' };
    await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/pdf')
      .set('X-Filename', '../../etc/passwd').send(pdf).expect(201);
    const names = await pool.query("SELECT original_filename FROM stored_files WHERE original_filename LIKE '%passwd%'");
    expect(names.rows[0].original_filename).toBe('passwd');
    // Every stored key stays under the storage root.
    const keys = await pool.query('SELECT storage_key FROM stored_files WHERE deleted_at IS NULL');
    for (const row of keys.rows) expect(String(row.storage_key)).toMatch(/^students\//);
  });

  it('versions a second upload rather than replacing the first', async () => {
    nextVerdict = { state: 'CLEAN' };
    const response = await api().post(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).set('Content-Type', 'application/pdf')
      .set('X-Filename', 'cv-v3.pdf').send(pdf).expect(201);
    expect(response.body.file.versionNumber).toBe(3);
    const versions = await pool.query('SELECT count(*)::int AS count FROM student_document_versions WHERE document_id = $1', [documentId]);
    expect(versions.rows[0].count).toBe(3);
  });
});

describe('document download', () => {
  it('returns the current version as an attachment', async () => {
    const response = await api().get(`/api/v1/students/me/documents/${documentId}/file`)
      .set(auth(studentToken)).expect(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(response.body).toString()).toBe(pdf.toString());
  });

  it('does not serve another student document', async () => {
    await api().get(`/api/v1/students/me/documents/${documentId}/file`).set(auth(otherToken)).expect(403);
  });

  it('records every download in the audit trail', async () => {
    const audit = await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action = 'document.file_downloaded'");
    expect(audit.rows[0].count).toBeGreaterThan(0);
  });
});

describe('storage without configuration', () => {
  it('reports unavailable rather than accepting unscanned files', async () => {
    const bare = await Test.createTestingModule({
      imports: [Phase1ApiSecurityModule.register({
        verifier,
        identityStore: {
          findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
          loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
        },
        db,
      })],
      providers: [{ provide: PG_POOL, useValue: pool }],
    }).compile();
    const bareApp = bare.createNestApplication();
    await bareApp.init();
    try {
      const response = await request(bareApp.getHttpServer())
        .post(`/api/v1/students/me/documents/${documentId}/file`)
        .set(auth(studentToken)).set('Content-Type', 'application/pdf').send(pdf).expect(503);
      expect(response.body.error.code).toBe('FILE_STORAGE_NOT_CONFIGURED');
    } finally {
      await bareApp.close();
    }
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
