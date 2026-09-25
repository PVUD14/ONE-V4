/**
 * Internal capabilities over HTTP (OPS-01, ADR-032).
 *
 * Two halves. The retrofit matrix proves every operations endpoint moved to a
 * capability check still admits exactly the platform roles it admitted before — the
 * expectations are written out by hand from the pre-OPS-01 role lists, not derived from
 * the new baselines, so the test would catch a baseline that drifted — and denies an
 * ACTIVE institution admin. The staff half covers the Settings endpoints: who may
 * grant, what is refused and why, and the audit and outbox rows a change leaves.
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
import { changeMembershipRole } from '@planthepath/persistence/src/platform-controls.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { OperationsStaffController } from './operations-staff.controller.js';
import { PlatformControlsController } from './platform-controls.controller.js';
import { TrustSafetyController } from './trust-safety.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for operations capability tests');

// Its own schema, and no TRUNCATE between tests: every test creates its own people, so
// the file never races another spec and stays fast.
const schemaName = 'ops_caps_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let institutionId: string;

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
    controllers: [PlatformControlsController, TrustSafetyController, OperationsStaffController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Capability college')", [institutionId]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'] as const;

interface Member { readonly userId: string; readonly membershipId: string }

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = (platformRoles as readonly string[]).includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function freshOrganization(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Retrofit college')", [id]);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-caps-' + randomUUID() });

type Call = (actor: Member) => Promise<request.Response>;
interface Route { readonly name: string; readonly admits: readonly string[]; readonly call: Call }

// Written out from the role lists each controller carried before OPS-01:
// organisations/verification/users/invitations admitted super and operations admins;
// the audit-search family (audit, outbox, privacy, trust-and-safety, flags) admitted all three.
const organisationRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'];
const auditFamilyRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

const routes: readonly Route[] = [
  { name: 'GET organisations (OPS_ORG_MANAGE)', admits: organisationRoles, call: (a) => api().get('/api/v1/operations/organizations').set(auth(a.userId)) },
  { name: 'POST organisation (OPS_ORG_MANAGE)', admits: organisationRoles, call: (a) => api().post('/api/v1/operations/organizations').set(auth(a.userId))
    .send({ kind: 'INSTITUTION', legalName: 'Retrofit college ' + randomUUID().slice(0, 8), profile: { countryCode: 'IN' } }) },
  { name: 'GET organisation (OPS_ORG_MANAGE)', admits: organisationRoles, call: async (a) => api().get('/api/v1/operations/organizations/' + await freshOrganization()).set(auth(a.userId)) },
  { name: 'PATCH organisation (OPS_ORG_MANAGE)', admits: organisationRoles, call: async (a) => api().patch('/api/v1/operations/organizations/' + await freshOrganization()).set(auth(a.userId)).send({ legalName: 'Renamed college' }) },
  { name: 'POST verification (OPS_VERIFY)', admits: organisationRoles, call: async (a) => api().post('/api/v1/operations/organizations/' + await freshOrganization() + '/verification').set(auth(a.userId)).send({ toState: 'UNDER_REVIEW' }) },
  { name: 'POST initial admin invitation (OPS_ORG_MANAGE)', admits: organisationRoles, call: async (a) => api().post('/api/v1/operations/organizations/' + await freshOrganization() + '/initial-admin-invitations').set(auth(a.userId)).send({ email: 'admin-' + randomUUID().slice(0, 8) + '@example.test' }) },
  { name: 'GET onboarding status (OPS_ORG_MANAGE)', admits: organisationRoles, call: async (a) => api().get('/api/v1/operations/organizations/' + await freshOrganization() + '/onboarding-status').set(auth(a.userId)) },
  { name: 'GET users-access (OPS_ORG_MANAGE)', admits: organisationRoles, call: (a) => api().get('/api/v1/operations/users-access?q=nobody').set(auth(a.userId)) },
  { name: 'GET invitations (OPS_ORG_MANAGE)', admits: organisationRoles, call: (a) => api().get('/api/v1/operations/invitations?q=nobody').set(auth(a.userId)) },
  { name: 'GET feature flags (OPS_FLAGS_MANAGE)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/feature-flags').set(auth(a.userId)) },
  { name: 'POST feature flag state (OPS_FLAGS_MANAGE)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/feature-flags/never.created/state').set(auth(a.userId)).send({ enabled: true, reasonCode: 'OPS_TEST' }) },
  { name: 'GET audit events (SECURITY_AUDIT_SEARCH)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/audit-events').set(auth(a.userId)) },
  { name: 'GET failed outbox (OPS_JOBS_REPLAY)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/outbox/failed').set(auth(a.userId)) },
  { name: 'POST outbox replay (OPS_JOBS_REPLAY)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/outbox/' + randomUUID() + '/replay').set(auth(a.userId)).send({ reasonCode: 'OPS_TEST' }) },
  { name: 'POST backlog supersede (OPS_JOBS_REPLAY)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(a.userId)).send({ reasonCode: 'OPS_TEST', olderThan: '2000-01-01T00:00:00.000Z' }) },
  { name: 'GET privacy requests (PRIVACY_REQUESTS)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/privacy/requests').set(auth(a.userId)) },
  { name: 'GET privacy holds (PRIVACY_REQUESTS)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/privacy/holds').set(auth(a.userId)) },
  { name: 'POST privacy hold (PRIVACY_HOLDS)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/privacy/holds').set(auth(a.userId)).send({ subjectUserId: a.userId, reasonCode: 'DISPUTE' }) },
  { name: 'POST privacy hold release (PRIVACY_HOLDS)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/privacy/holds/' + randomUUID() + '/release').set(auth(a.userId)).send({ reasonCode: 'OPS_TEST' }) },
  { name: 'GET trust cases (TRUST_SAFETY_INVESTIGATE)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/trust-safety/cases').set(auth(a.userId)) },
  { name: 'GET trust case (TRUST_SAFETY_INVESTIGATE)', admits: auditFamilyRoles, call: (a) => api().get('/api/v1/operations/trust-safety/cases/' + randomUUID()).set(auth(a.userId)) },
  { name: 'POST trust case (TRUST_SAFETY_INVESTIGATE)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/trust-safety/cases').set(auth(a.userId)).send({}) },
  { name: 'POST trust transition (TRUST_SAFETY_INVESTIGATE)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/trust-safety/cases/' + randomUUID() + '/transition').set(auth(a.userId)).send({}) },
  { name: 'POST trust action (TRUST_SAFETY_ENFORCE)', admits: auditFamilyRoles, call: (a) => api().post('/api/v1/operations/trust-safety/cases/' + randomUUID() + '/actions').set(auth(a.userId)).send({}) },
];

describe('retrofitted operations endpoints keep exactly their previous platform roles', () => {
  it.each(routes.map((route) => [route.name, route] as const))('%s', async (_name, route) => {
    for (const role of platformRoles) {
      const actor = await member(role);
      const response = await route.call(actor);
      if (route.admits.includes(role)) expect([401, 403], `${role} should be admitted`).not.toContain(response.status);
      else expect(response.status, `${role} should be denied`).toBe(403);
    }
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const denied = await route.call(institutionAdmin);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(await route.call({ userId: randomUUID(), membershipId: randomUUID() }).then((response) => response.status)).toBe(401);
  });

  it('admits a platform role through an explicit grant, and not once the membership is suspended', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    expect((await api().get('/api/v1/operations/organizations').set(auth(security.userId))).status).toBe(403);
    const granted = await api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities').set(auth(admin.userId))
      .send({ capability: 'OPS_ORG_MANAGE', reasonCode: 'TEMPORARY_COVER' });
    expect(granted.status).toBe(201);
    expect((await api().get('/api/v1/operations/organizations').set(auth(security.userId))).status).toBe(200);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [security.membershipId]);
    expect([401, 403]).toContain((await api().get('/api/v1/operations/organizations').set(auth(security.userId))).status);
  });
});

describe('GET /operations/staff', () => {
  it('requires authentication', async () => {
    expect((await api().get('/api/v1/operations/staff')).status).toBe(401);
  });

  it.each(['OPERATIONS_ADMIN', 'SECURITY_ADMIN', 'INSTITUTION_ADMIN'])('denies %s without CAPABILITY_ADMIN', async (role) => {
    const actor = await member(role);
    const response = await api().get('/api/v1/operations/staff').set(auth(actor.userId));
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'FORBIDDEN', correlationId: expect.any(String) });
  });

  it('lists platform memberships with baseline, grants and effective capabilities, and nothing more', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const faculty = await member('FACULTY_LECTURER');
    const response = await api().get('/api/v1/operations/staff?limit=200').set(auth(admin.userId));
    expect(response.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(response.body.staff.map((entry: Record<string, unknown>) => [entry.membershipId as string, entry]));
    expect(byId.has(faculty.membershipId)).toBe(false);
    const self = byId.get(admin.membershipId)!;
    expect(self.isSelf).toBe(true);
    expect(self.baseline).toHaveLength(19);
    const row = byId.get(security.membershipId)!;
    expect(Object.keys(row).sort()).toEqual(['baseline', 'effective', 'email', 'grants', 'isSelf', 'membershipId', 'role', 'state']);
    expect(row.baseline).toContain('OPS_FLAGS_MANAGE');
    expect(row.baseline).not.toContain('OPS_ORG_MANAGE');
    expect(response.body.grantReasons).toEqual(['NEW_RESPONSIBILITY', 'TEMPORARY_COVER', 'ACCESS_REVIEW_OUTCOME', 'CORRECTION']);
    expect(response.body.actorMayGrantHighRisk).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('user_id');
  });

  it('pages with a keyset cursor and rejects bad bounds and unknown fields', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    await member('SECURITY_ADMIN');
    const first = await api().get('/api/v1/operations/staff?limit=1').set(auth(admin.userId));
    expect(first.body.staff).toHaveLength(1);
    const second = await api().get('/api/v1/operations/staff?limit=1&cursor=' + encodeURIComponent(first.body.nextCursor)).set(auth(admin.userId));
    expect(second.status).toBe(200);
    expect(second.body.staff[0].membershipId).not.toBe(first.body.staff[0].membershipId);
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=not-a-cursor', '?role=SECURITY_ADMIN']) {
      expect((await api().get('/api/v1/operations/staff' + query).set(auth(admin.userId))).status, query).toBe(400);
    }
  });
});

describe('POST /operations/staff/:membershipId/capabilities', () => {
  const grant = (actor: Member, membershipId: string, body: Record<string, unknown>) =>
    api().post('/api/v1/operations/staff/' + membershipId + '/capabilities').set(auth(actor.userId)).send(body);

  it('grants SUPPORT_CASES to a platform membership and audits it with the reason code, with an outbox event', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const response = await grant(admin, security.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY', note: 'Covers the pilot inbox' });
    expect(response.status).toBe(201);
    expect(response.body.member.effective).toContain('SUPPORT_CASES');
    expect(response.body.member.grants).toEqual([expect.objectContaining({ capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY', highRisk: false })]);
    const audit = await pool.query(
      "SELECT actor_user_id, organization_id, outcome, correlation_id, context FROM audit_events WHERE action='operations.staff_capability.granted' AND resource_id=$1",
      [security.membershipId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: admin.userId, organization_id: platformId, outcome: 'SUCCESS', correlation_id: expect.stringMatching(/^ops-caps-/) });
    expect(audit.rows[0].context).toMatchObject({ capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY', note: 'Covers the pilot inbox' });
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='organization_membership.capability_granted' AND aggregate_id=$1", [security.membershipId]);
    expect(outbox.rows).toEqual([{ payload: { membershipId: security.membershipId, capability: 'SUPPORT_CASES' } }]);
  });

  it('refuses SUPPORT_CASES for an institution membership, and the database refuses it too', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const response = await grant(admin, institutionAdmin.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CAPABILITY_ROLE_NOT_ELIGIBLE');
    await expect(pool.query(
      `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code) VALUES ($1,$2,'SUPPORT_CASES',$3,'NEW_RESPONSIBILITY')`,
      [randomUUID(), institutionAdmin.membershipId, admin.userId],
    )).rejects.toThrow(/may be granted only to a membership of the ONE platform organisation/);
    expect((await pool.query('SELECT 1 FROM membership_capabilities WHERE membership_id=$1', [institutionAdmin.membershipId])).rowCount).toBe(0);
  });

  it('rejects a self-grant', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const response = await grant(admin, admin.membershipId, { capability: 'CONTENT_EDIT', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CAPABILITY_SELF_CHANGE_REFUSED');
    expect((await pool.query('SELECT 1 FROM membership_capabilities WHERE membership_id=$1', [admin.membershipId])).rowCount).toBe(0);
  });

  it('lets a delegated CAPABILITY_ADMIN grant ordinary capabilities but not high-risk ones', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const operations = await member('OPERATIONS_ADMIN');
    const security = await member('SECURITY_ADMIN');
    expect((await grant(admin, operations.membershipId, { capability: 'CAPABILITY_ADMIN', reasonCode: 'NEW_RESPONSIBILITY' })).status).toBe(201);
    const list = await api().get('/api/v1/operations/staff').set(auth(operations.userId));
    expect(list.status).toBe(200);
    expect(list.body.actorMayGrantHighRisk).toBe(false);
    expect((await grant(operations, security.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'TEMPORARY_COVER' })).status).toBe(201);
    const highRisk = await grant(operations, security.membershipId, { capability: 'APPROVE_HIGH_RISK', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(highRisk.status).toBe(403);
    expect(highRisk.body.error.code).toBe('HIGH_RISK_GRANT_REQUIRES_SUPER_ADMIN');
    expect((await grant(admin, security.membershipId, { capability: 'APPROVE_HIGH_RISK', reasonCode: 'NEW_RESPONSIBILITY' })).status).toBe(201);
  });

  it('validates input explicitly before touching the database', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const cases: readonly [string, Record<string, unknown>, string][] = [
      [security.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY', extra: true }, 'INVALID_REQUEST'],
      [security.membershipId, { capability: 'EVERYTHING', reasonCode: 'NEW_RESPONSIBILITY' }, 'CAPABILITY_INVALID'],
      [security.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'OPS_TEST' }, 'REASON_CODE_INVALID'],
      [security.membershipId, { capability: 'SUPPORT_CASES' }, 'REASON_CODE_INVALID'],
      [security.membershipId, { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY', note: 'x'.repeat(501) }, 'NOTE_INVALID'],
      ['not-a-uuid', { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY' }, 'INVALID_REQUEST'],
      [security.membershipId, { capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: 'NEW_RESPONSIBILITY' }, 'CAPABILITY_NOT_GRANTABLE_HERE'],
    ];
    for (const [membershipId, body, code] of cases) {
      const response = await grant(admin, membershipId, body);
      expect(response.status, code).toBe(400);
      expect(response.body.error.code).toBe(code);
      expect(JSON.stringify(response.body)).not.toMatch(/membership_capabilities|violates|trigger/);
    }
    expect((await grant(admin, randomUUID(), { capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY' })).status).toBe(404);
    const held = await grant(admin, security.membershipId, { capability: 'SECURITY_AUDIT_SEARCH', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe('CAPABILITY_ALREADY_HELD');
  });
});

describe('POST /operations/staff/:membershipId/capabilities/:capability/revoke', () => {
  it('revokes a live grant with a revoke reason, audits it, and refuses a second revoke', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    await api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY' });
    const path = '/api/v1/operations/staff/' + security.membershipId + '/capabilities/SUPPORT_CASES/revoke';
    expect((await api().post(path).set(auth(admin.userId)).send({ reasonCode: 'NEW_RESPONSIBILITY' })).status).toBe(400);
    const revoked = await api().post(path).set(auth(admin.userId)).send({ reasonCode: 'LEAVER' });
    expect(revoked.status).toBe(201);
    expect(revoked.body.member.grants).toEqual([]);
    const row = await pool.query('SELECT revoked_reason_code, revoked_by_user_id FROM membership_capabilities WHERE membership_id=$1', [security.membershipId]);
    expect(row.rows).toEqual([{ revoked_reason_code: 'LEAVER', revoked_by_user_id: admin.userId }]);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.staff_capability.revoked' AND resource_id=$1", [security.membershipId]);
    expect(audit.rows[0].context).toMatchObject({ capability: 'SUPPORT_CASES', reasonCode: 'LEAVER' });
    const again = await api().post(path).set(auth(admin.userId)).send({ reasonCode: 'LEAVER' });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('CAPABILITY_NOT_GRANTED');
  });

  it('refuses revocation by a caller without CAPABILITY_ADMIN', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const operations = await member('OPERATIONS_ADMIN');
    const security = await member('SECURITY_ADMIN');
    await api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: 'SUPPORT_CASES', reasonCode: 'NEW_RESPONSIBILITY' });
    const response = await api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities/SUPPORT_CASES/revoke').set(auth(operations.userId)).send({ reasonCode: 'LEAVER' });
    expect(response.status).toBe(403);
  });
});

describe('role changes', () => {
  it('revoke every internal capability of the membership', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const operations = await member('OPERATIONS_ADMIN');
    await api().post('/api/v1/operations/staff/' + operations.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: 'SUPPORT_ACCOUNT_LOOKUP', reasonCode: 'NEW_RESPONSIBILITY' }).expect(409);
    await api().post('/api/v1/operations/staff/' + operations.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: 'CONTENT_EDIT', reasonCode: 'NEW_RESPONSIBILITY' }).expect(201);
    const result = await changeMembershipRole(pool, {
      membershipId: operations.membershipId, role: 'SECURITY_ADMIN', actorUserId: admin.userId,
      reasonCode: 'RESPONSIBILITY_ENDED', correlationId: 'ops-caps-role-change',
    });
    expect(result.revokedCapabilities).toBe(1);
    const list = await api().get('/api/v1/operations/staff?limit=200').set(auth(admin.userId));
    const row = list.body.staff.find((entry: { membershipId: string }) => entry.membershipId === operations.membershipId);
    expect(row).toMatchObject({ role: 'SECURITY_ADMIN', grants: [] });
    expect(row.effective).not.toContain('CONTENT_EDIT');
  });
});
