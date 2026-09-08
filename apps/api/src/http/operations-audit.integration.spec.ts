/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for operations audit tests');

// Its own schema rather than TRUNCATE, so this file never races another spec file.
const schemaName = 'ops_audit_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let platformId: string;
let employerId: string;

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
          return {
            externalSubject: token, issuer: 'local-test', clientId: 'local-test',
            tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [],
          };
        },
      },
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
  // Nineteen migrations into a fresh schema exceeds vitest's 10s default on a cold start.
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  await pool.query('TRUNCATE organizations CASCADE');
  tokens.clear();
  institutionId = randomUUID();
  platformId = randomUUID();
  employerId = randomUUID();
  // The membership trigger validates role against organization kind and scope, so each
  // role class needs the organization it actually belongs to.
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution')", [institutionId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','Local platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Local employer')", [employerId]);
});

const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];
const employerRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'];

async function member(role: string, state = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const isEmployer = employerRoles.includes(role);
  const org = isPlatform ? platformId : isEmployer ? employerId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_employer_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6,$7)`,
    [randomUUID(), org, id, role, state, isPlatform || isEmployer ? null : org, isEmployer ? org : null],
  );
  return id;
}

async function auditEvent(actorId: string, over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const id = randomUUID();
  const row = {
    action: 'organization.updated', resourceType: 'organization', resourceId: institutionId,
    outcome: 'SUCCESS', correlationId: randomUUID(), occurredAt: new Date().toISOString(), ...over,
  };
  await pool.query(
    `INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,organization_id,outcome,correlation_id,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
    [id, actorId, row.action, row.resourceType, row.resourceId, institutionId, row.outcome, row.correlationId, row.occurredAt],
  );
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const search = (id: string, query = '') => api().get('/api/v1/operations/audit-events' + query).set(auth(id));

describe('operations audit event search', () => {
  it.each(['SECURITY_ADMIN', 'OPERATIONS_ADMIN', 'PLATFORM_SUPER_ADMIN'])('allows %s to search', async (role) => {
    const actor = await member(role);
    await auditEvent(actor);
    const response = await search(actor);
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.correlationId).toBeTruthy();
  });

  it.each(['INSTITUTION_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER', 'RECRUITER'])('denies %s', async (role) => {
    const actor = await member(role);
    await auditEvent(actor);
    const response = await search(actor);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(response.body)).not.toContain('audit_events');
  });

  it('denies a suspended platform membership', async () => {
    const actor = await member('SECURITY_ADMIN', 'SUSPENDED');
    const response = await search(actor);
    expect([401, 403]).toContain(response.status);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await api().get('/api/v1/operations/audit-events');
    expect(response.status).toBe(401);
  });

  it('filters by action prefix, outcome and correlation id', async () => {
    const actor = await member('SECURITY_ADMIN');
    await auditEvent(actor, { action: 'organization.updated' });
    await auditEvent(actor, { action: 'institution.roster_import.committed' });
    const denied = randomUUID();
    await auditEvent(actor, { action: 'organization.deleted', outcome: 'DENIED', correlationId: denied });

    const byPrefix = await search(actor, '?action=organization.');
    expect(byPrefix.body.events).toHaveLength(2);

    const byOutcome = await search(actor, '?outcome=DENIED');
    expect(byOutcome.body.events).toHaveLength(1);
    expect(byOutcome.body.events[0].outcome).toBe('DENIED');

    const byCorrelation = await search(actor, '?correlationId=' + denied);
    expect(byCorrelation.body.events).toHaveLength(1);
    expect(byCorrelation.body.events[0].correlationId).toBe(denied);
  });

  it('pages with a stable keyset cursor and does not repeat or drop a row', async () => {
    const actor = await member('SECURITY_ADMIN');
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    for (let index = 0; index < 5; index++) {
      await auditEvent(actor, { occurredAt: new Date(base + index * 1000).toISOString() });
    }

    const first = await search(actor, '?limit=2');
    expect(first.body.events).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await search(actor, '?limit=2&cursor=' + encodeURIComponent(first.body.nextCursor));
    expect(second.body.events).toHaveLength(2);

    const third = await search(actor, '?limit=2&cursor=' + encodeURIComponent(second.body.nextCursor));
    expect(third.body.events).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();

    const seen = [...first.body.events, ...second.body.events, ...third.body.events].map((event: { id: string }) => event.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('refuses an out-of-range limit and a malformed cursor rather than guessing', async () => {
    const actor = await member('SECURITY_ADMIN');
    expect((await search(actor, '?limit=0')).status).toBe(400);
    expect((await search(actor, '?limit=500')).status).toBe(400);
    expect((await search(actor, '?limit=abc')).status).toBe(400);
    expect((await search(actor, '?cursor=not-a-cursor')).status).toBe(400);
    expect((await search(actor, '?actorUserId=nope')).status).toBe(400);
    expect((await search(actor, '?outcome=MAYBE')).status).toBe(400);
  });
});
