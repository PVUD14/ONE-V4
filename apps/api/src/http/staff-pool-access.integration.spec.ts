/**
 * Staff-pool access, end to end through the real guard and a real database (OPS-07).
 *
 * ADR-025 puts staff in a separate Cognito pool with MFA required. Accepting that pool's
 * tokens is not enough: the same person could still sign in through the student pool,
 * where MFA is off, and use an internal role. These tests run one person with one set of
 * memberships through two pools and assert that, with a staff pool configured, only the
 * staff-pool token reaches operations endpoints -- including one served by a controller
 * outside the security module -- and that with no staff pool nothing changes.
 *
 * The verifier is a stub that reports which pool a token came from; the signature side
 * of the two-pool split is covered in packages/identity.
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
import { platformInternalRoles } from '@planthepath/authorization/src/index.js';
import type { IdentityTokenVerifier } from '@planthepath/identity/src/cognito.js';
import { createStaffPoolPolicy } from '@planthepath/identity/src/staff-pool.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { OperationsStaffController } from './operations-staff.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for staff-pool access tests');

const schemaName = 'staff_pool_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const studentPool = { issuer: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_students', clientId: 'student-client' };
const staffPool = { issuer: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_staff', clientId: 'staff-client' };
const staffPoolPolicy = createStaffPoolPolicy({ userPoolId: 'ap-south-1_staff', clientId: staffPool.clientId, staffOnlyRoles: platformInternalRoles });

/** Tokens look like "<pool>:<subject>"; the stub reports that pool's issuer and client id. */
const subjects = new Set<string>();
const verifier: IdentityTokenVerifier = {
  async verifyAccessToken(token: string) {
    const [poolName, subject] = token.split(':');
    const issuing = poolName === 'staff' ? staffPool : poolName === 'student' ? studentPool : undefined;
    if (!issuing || !subject || !subjects.has(subject)) throw new Error('Invalid local test identity');
    return {
      externalSubject: subject, issuer: issuing.issuer, clientId: issuing.clientId,
      tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [],
    };
  },
};

let enforced: INestApplication;
let unconfigured: INestApplication;
let platformId: string;
let institutionId: string;

async function build(withPolicy: boolean): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier,
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
      ...(withPolicy ? { staffPoolPolicy } : {}),
    })],
    // Registered outside the security module, as AppModule does, to prove the exported
    // guard carries the policy to controllers it does not own.
    controllers: [OperationsStaffController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  const app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  return app;
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  enforced = await build(true);
  unconfigured = await build(false);
}, 120_000);

afterAll(async () => {
  await enforced?.close();
  await unconfigured?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

// A private schema and fresh ids per test, so no TRUNCATE is needed between tests.
beforeEach(async () => {
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','Local platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution')", [institutionId]);
});

async function person(roles: readonly { role: string; org: 'platform' | 'institution' }[]): Promise<string> {
  const id = randomUUID();
  subjects.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  for (const { role, org } of roles) {
    const organizationId = org === 'platform' ? platformId : institutionId;
    await pool.query(
      `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
       VALUES ($1,$2,$3,$4,'ACTIVE',$2,$5)`,
      [randomUUID(), organizationId, id, role, org === 'institution' ? organizationId : null],
    );
  }
  return id;
}

const as = (app: INestApplication, poolName: 'staff' | 'student', subject: string, path: string) => request(app.getHttpServer())
  .get(path)
  .set({ Authorization: `Bearer ${poolName}:${subject}`, 'X-Correlation-Id': randomUUID() });

describe('with the staff pool configured', () => {
  it('a student-pool token cannot act as an internal role', async () => {
    const admin = await person([{ role: 'OPERATIONS_ADMIN', org: 'platform' }]);
    const response = await as(enforced, 'student', admin, '/api/v1/operations/audit-events');
    expect(response.status).toBe(403);
    // The denial is the standard safe shape: nothing about pools, issuers or roles.
    expect(JSON.stringify(response.body)).not.toMatch(/pool|issuer|OPERATIONS_ADMIN|staff/i);
  });

  it('the same person with a staff-pool token keeps the internal role', async () => {
    const admin = await person([{ role: 'OPERATIONS_ADMIN', org: 'platform' }]);
    expect((await as(enforced, 'staff', admin, '/api/v1/operations/audit-events')).status).toBe(200);
  });

  it('applies to controllers outside the security module too', async () => {
    const owner = await person([{ role: 'PLATFORM_SUPER_ADMIN', org: 'platform' }]);
    expect((await as(enforced, 'student', owner, '/api/v1/operations/staff')).status).toBe(403);
    expect((await as(enforced, 'staff', owner, '/api/v1/operations/staff')).status).toBe(200);
  });

  it('a student-pool token cannot select the platform organisation', async () => {
    const admin = await person([{ role: 'SECURITY_ADMIN', org: 'platform' }]);
    const response = await as(enforced, 'student', admin, `/api/v1/security/context?organizationId=${platformId}`);
    expect(response.status).toBe(403);
  });

  it('removes only the internal roles: other memberships still count for a student-pool token', async () => {
    const both = await person([{ role: 'OPERATIONS_ADMIN', org: 'platform' }, { role: 'INSTITUTION_ADMIN', org: 'institution' }]);
    const viaStudent = await as(enforced, 'student', both, '/api/v1/security/context');
    expect(viaStudent.status).toBe(200);
    expect(viaStudent.body.memberships.map((m: { role: string }) => m.role)).toEqual(['INSTITUTION_ADMIN']);
    const viaStaff = await as(enforced, 'staff', both, '/api/v1/security/context');
    expect(viaStaff.body.memberships.map((m: { role: string }) => m.role).sort()).toEqual(['INSTITUTION_ADMIN', 'OPERATIONS_ADMIN']);
  });
});

describe('without a staff pool (the default)', () => {
  it('behaves exactly as before: the student-pool token keeps the internal role', async () => {
    const admin = await person([{ role: 'OPERATIONS_ADMIN', org: 'platform' }]);
    expect((await as(unconfigured, 'student', admin, '/api/v1/operations/audit-events')).status).toBe(200);
    const owner = await person([{ role: 'PLATFORM_SUPER_ADMIN', org: 'platform' }]);
    expect((await as(unconfigured, 'student', owner, '/api/v1/operations/staff')).status).toBe(200);
  });

  it('still refuses an unauthenticated request', async () => {
    const response = await request(unconfigured.getHttpServer()).get('/api/v1/operations/audit-events');
    expect(response.status).toBe(401);
  });
});
