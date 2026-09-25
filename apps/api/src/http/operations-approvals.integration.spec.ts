/**
 * Dual control for high-risk operator actions over HTTP (OPS-02).
 *
 * Every high-risk action that exists today refuses to run without an approval; a request
 * is approved by a second person, bound to the exact payload, expires after 24 hours,
 * is single-use and only its requester can execute it; the solo-operator safeguard works
 * only with exactly one approver and after 15 minutes. The 0038 trigger is exercised
 * directly as well, because a second writer must not be able to skip the rules.
 *
 * Real Postgres in a throwaway schema. Time is moved by backdating a request with the
 * trigger disabled (only the table owner can), since the trigger stamps requests with
 * the database clock and refuses to let anyone else change them.
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
import { OperationsStaffController } from './operations-staff.controller.js';
import { PlatformControlsController } from './platform-controls.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for operation approval tests');

const schemaName = 'ops_approvals_' + randomUUID().replaceAll('-', '');
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
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [PlatformControlsController, OperationsStaffController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Approvals college')", [institutionId]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function verifiedOrganization(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state) VALUES ($1,'EMPLOYER','Approvals employer','VERIFIED')", [id]);
  return id;
}

async function hold(placedBy: string): Promise<{ holdId: string; subjectEmail: string }> {
  const subject = await member('OPERATIONS_ADMIN');
  const holdId = randomUUID();
  await pool.query("INSERT INTO data_retention_holds (id,subject_user_id,reason_code,placed_by_user_id) VALUES ($1,$2,'LEGAL_OBLIGATION',$3)", [holdId, subject.userId, placedBy]);
  return { holdId, subjectEmail: subject.userId + '@example.test' };
}

async function highRiskFlag(direction: 'ENABLE' | 'DISABLE', enabled: boolean): Promise<string> {
  const key = 'ai.test-' + randomUUID().slice(0, 8);
  await pool.query('INSERT INTO feature_flags (key,description,enabled,high_risk_direction) VALUES ($1,$2,$3,$4)', [key, 'A high-risk test flag', enabled, direction]);
  return key;
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-appr-' + randomUUID() });

function requestApproval(actor: Member, actionKey: string, payload: Record<string, unknown>, note?: string) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey, payload, ...(note ? { note } : {}) });
}
function decide(actor: Member, approvalId: string, decision: 'APPROVE' | 'REJECT', reasonCode = decision === 'APPROVE' ? 'VERIFIED_NEED' : 'NOT_NEEDED') {
  return api().post('/api/v1/operations/approvals/' + approvalId + '/decision').set(auth(actor.userId)).send({ decision, reasonCode });
}
async function approved(requester: Member, approver: Member, actionKey: string, payload: Record<string, unknown>): Promise<string> {
  const filed = await requestApproval(requester, actionKey, payload);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const decided = await decide(approver, filed.body.approval.id, 'APPROVE');
  expect(decided.status, JSON.stringify(decided.body)).toBe(201);
  return filed.body.approval.id as string;
}

/** Move a request back in time. The trigger forbids this, so it is bypassed by the owner. */
async function backdate(approvalId: string, interval: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE operation_approvals DISABLE TRIGGER operation_approval_guard');
    await client.query(`UPDATE operation_approvals SET requested_at = requested_at - $2::interval, expires_at = expires_at - $2::interval WHERE id=$1`, [approvalId, interval]);
    await client.query('ALTER TABLE operation_approvals ENABLE TRIGGER operation_approval_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const suspend = (actor: Member, organizationId: string, body: Record<string, unknown>) =>
  api().post('/api/v1/operations/organizations/' + organizationId + '/verification').set(auth(actor.userId)).send({ toState: 'SUSPENDED', ...body });

async function state(organizationId: string): Promise<string> {
  return (await pool.query('SELECT verification_state FROM organizations WHERE id=$1', [organizationId])).rows[0].verification_state as string;
}

describe('every high-risk action refuses to run without an approval', () => {
  it('returns 403 APPROVAL_REQUIRED and changes nothing, for the super admin too', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const organizationId = await verifiedOrganization();
    const flagKey = await highRiskFlag('ENABLE', false);
    const { holdId } = await hold(admin.userId);

    const calls = [
      suspend(admin, organizationId, { reasonCode: 'POLICY_VIOLATION' }),
      api().post('/api/v1/operations/feature-flags/' + flagKey + '/state').set(auth(admin.userId)).send({ enabled: true, reasonCode: 'PILOT_ROLLOUT' }),
      api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(admin.userId)).send({ reasonCode: 'PRE_DISPATCHER_BACKLOG', olderThan: '2000-01-01T00:00:00.000Z' }),
      api().post('/api/v1/operations/privacy/holds/' + holdId + '/release').set(auth(admin.userId)).send({ reasonCode: 'CASE_CLOSED' }),
      api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: 'CONTENT_PUBLISH', reasonCode: 'NEW_RESPONSIBILITY' }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', correlationId: expect.any(String) });
    }
    expect(await state(organizationId)).toBe('VERIFIED');
    expect((await pool.query('SELECT enabled FROM feature_flags WHERE key=$1', [flagKey])).rows[0].enabled).toBe(false);
    expect((await pool.query('SELECT released_at FROM data_retention_holds WHERE id=$1', [holdId])).rows[0].released_at).toBeNull();
    expect((await pool.query('SELECT 1 FROM membership_capabilities WHERE membership_id=$1', [security.membershipId])).rowCount).toBe(0);
  });

  it('leaves ordinary changes ungated and refuses an approvalId where none is needed', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const flagKey = await highRiskFlag('ENABLE', true);
    // Switching an AI feature OFF is the safe direction.
    await api().post('/api/v1/operations/feature-flags/' + flagKey + '/state').set(auth(admin.userId)).send({ enabled: false, reasonCode: 'ROLLBACK' }).expect(201);
    const organizationId = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Pending college')", [organizationId]);
    const withApproval = await api().post('/api/v1/operations/organizations/' + organizationId + '/verification').set(auth(admin.userId))
      .send({ toState: 'UNDER_REVIEW', approvalId: randomUUID() });
    expect(withApproval.status).toBe(400);
    expect(withApproval.body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    const needless = await requestApproval(admin, 'FEATURE_FLAG_HIGH_RISK_CHANGE', { key: flagKey, enabled: false, reasonCode: 'ROLLBACK' });
    expect(needless.status).toBe(400);
    expect(needless.body.error.code).toBe('APPROVAL_NOT_REQUIRED');
  });
});

describe('POST /operations/approvals', () => {
  it('requires authentication and a capability for the action', async () => {
    expect((await api().post('/api/v1/operations/approvals').send({})).status).toBe(401);
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const denied = await requestApproval(institutionAdmin, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    // SECURITY_ADMIN may release holds but not suspend organisations.
    const security = await member('SECURITY_ADMIN');
    expect((await requestApproval(security, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' })).status).toBe(403);
  });

  it('validates the action, the payload, the reason and the target before filing', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const organizationId = await verifiedOrganization();
    const cases: readonly [Record<string, unknown>, number, string][] = [
      [{ actionKey: 'DROP_DATABASE', payload: {} }, 400, 'APPROVAL_ACTION_INVALID'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId, reasonCode: 'POLICY_VIOLATION', extra: 1 } }, 400, 'INVALID_REQUEST'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId, reasonCode: 'OPS_TEST' } }, 400, 'REASON_CODE_INVALID'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId: 'nope', reasonCode: 'POLICY_VIOLATION' } }, 400, 'INVALID_REQUEST'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId, reasonCode: 'POLICY_VIOLATION' }, note: 'x'.repeat(501) }, 400, 'NOTE_INVALID'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId: randomUUID(), reasonCode: 'POLICY_VIOLATION' } }, 404, 'APPROVAL_TARGET_NOT_FOUND'],
      [{ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId, reasonCode: 'POLICY_VIOLATION' }, extra: true }, 400, 'INVALID_REQUEST'],
    ];
    for (const [body, status, code] of cases) {
      const response = await api().post('/api/v1/operations/approvals').set(auth(operations.userId)).send(body);
      expect(response.status, code).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(JSON.stringify(response.body)).not.toMatch(/violates|trigger|operation_approvals/);
    }
    expect((await pool.query('SELECT 1 FROM operation_approvals WHERE requested_by_user_id=$1', [operations.userId])).rowCount).toBe(0);
  });

  it('files a request with a reason code, audits it and announces it on the outbox', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const organizationId = await verifiedOrganization();
    const filed = await requestApproval(operations, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'FRAUD_SUSPECTED' }, 'Reported by two colleges');
    expect(filed.status).toBe(201);
    expect(filed.body.approval).toMatchObject({
      actionKey: 'ORGANIZATION_SUSPEND', state: 'PENDING', reasonCode: 'FRAUD_SUSPECTED', note: 'Reported by two colleges',
      summary: expect.objectContaining({ organizationName: 'Approvals employer' }), requestedBy: { isSelf: true }, canApprove: false, canExecute: false,
    });
    const row = (await pool.query("SELECT extract(epoch FROM expires_at - requested_at)::int AS window, payload_hash FROM operation_approvals WHERE id=$1", [filed.body.approval.id])).rows[0];
    expect(row.window).toBe(86_400);
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='operations.approval.requested' AND resource_id=$1", [filed.body.approval.id]);
    expect(audit.rows).toEqual([{ actor_user_id: operations.userId, context: expect.objectContaining({ actionKey: 'ORGANIZATION_SUSPEND', reasonCode: 'FRAUD_SUSPECTED' }) }]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='operation_approval.requested' AND aggregate_id=$1", [filed.body.approval.id]);
    expect(outbox.rows).toEqual([{ payload: { approvalId: filed.body.approval.id, actionKey: 'ORGANIZATION_SUSPEND' } }]);
  });
});

describe('deciding and executing', () => {
  it('suspends an organisation only after a second person approves, once, for exactly the approved payload', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const organizationId = await verifiedOrganization();
    const filed = await requestApproval(operations, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'POLICY_VIOLATION' });
    const approvalId = filed.body.approval.id as string;

    // Not approved yet.
    const early = await suspend(operations, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('APPROVAL_NOT_APPROVED');
    // A decision needs APPROVE_HIGH_RISK.
    expect((await decide(await member('OPERATIONS_ADMIN'), approvalId, 'APPROVE')).status).toBe(403);
    // Bad decision input.
    expect((await decide(approver, approvalId, 'APPROVE', 'NOT_NEEDED')).status).toBe(400);
    expect((await api().post('/api/v1/operations/approvals/' + approvalId + '/decision').set(auth(approver.userId)).send({ decision: 'MAYBE', reasonCode: 'VERIFIED_NEED' })).status).toBe(400);

    const decided = await decide(approver, approvalId, 'APPROVE');
    expect(decided.status).toBe(201);
    expect(decided.body.approval).toMatchObject({ state: 'APPROVED', mode: 'DUAL', decisionReasonCode: 'VERIFIED_NEED', soloNotice: null });
    expect((await decide(approver, approvalId, 'REJECT')).status).toBe(409);

    // A changed payload (a different reason) is refused, as is the approver acting on it.
    const changed = await suspend(operations, organizationId, { reasonCode: 'CONTRACT_ENDED', approvalId });
    expect(changed.status).toBe(403);
    expect(changed.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const other = await verifiedOrganization();
    expect((await suspend(operations, other, { reasonCode: 'POLICY_VIOLATION', approvalId })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const byApprover = await suspend(approver, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId });
    expect(byApprover.body.error.code).toBe('APPROVAL_NOT_REQUESTER');
    expect(await state(organizationId)).toBe('VERIFIED');

    const executed = await suspend(operations, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId });
    expect(executed.status).toBe(201);
    expect(await state(organizationId)).toBe('SUSPENDED');

    // Single use.
    await pool.query("UPDATE organizations SET verification_state='VERIFIED', active=true WHERE id=$1", [organizationId]);
    const again = await suspend(operations, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('APPROVAL_NOT_APPROVED');

    const trail = await pool.query(
      "SELECT action, actor_user_id, context FROM audit_events WHERE resource_id=$1 OR (action='organization.verification_transitioned' AND resource_id=$2) ORDER BY occurred_at",
      [approvalId, organizationId],
    );
    expect(trail.rows.map((row) => row.action)).toEqual(['operations.approval.requested', 'operations.approval.approved', 'operations.approval.executed', 'organization.verification_transitioned']);
    expect(trail.rows[1]).toMatchObject({ actor_user_id: approver.userId, context: expect.objectContaining({ requestedByUserId: operations.userId, decidedByUserId: approver.userId, mode: 'DUAL' }) });
    expect(trail.rows[2].context).toMatchObject({ requestedByUserId: operations.userId, approvedByUserId: approver.userId, mode: 'DUAL' });
    expect(trail.rows[3].context).toMatchObject({ reasonCode: 'POLICY_VIOLATION', approval: expect.objectContaining({ approvalId, approvedByUserId: approver.userId }) });
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type LIKE 'operation_approval.%'", [approvalId])).rows[0].n).toBe(3);
  });

  it('refuses the requester deciding their own request while another approver exists', async () => {
    const requester = await member('PLATFORM_SUPER_ADMIN');
    await member('PLATFORM_SUPER_ADMIN');
    const filed = await requestApproval(requester, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
    await backdate(filed.body.approval.id, '20 minutes');
    for (const decision of ['APPROVE', 'REJECT'] as const) {
      const response = await decide(requester, filed.body.approval.id, decision);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('APPROVAL_SELF_DECISION_REFUSED');
    }
  });

  it('refuses decisions and execution after 24 hours', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const organizationId = await verifiedOrganization();
    const stale = await requestApproval(operations, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'POLICY_VIOLATION' });
    await backdate(stale.body.approval.id, '25 hours');
    const late = await decide(approver, stale.body.approval.id, 'APPROVE');
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('APPROVAL_EXPIRED');

    const approvalId = await approved(operations, approver, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'CONTRACT_ENDED' });
    await backdate(approvalId, '24 hours');
    const expired = await suspend(operations, organizationId, { reasonCode: 'CONTRACT_ENDED', approvalId });
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('APPROVAL_EXPIRED');
    expect(await state(organizationId)).toBe('VERIFIED');
    const list = await api().get('/api/v1/operations/approvals?state=EXPIRED&limit=200').set(auth(approver.userId));
    expect(list.body.approvals.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining([stale.body.approval.id, approvalId]));
  });

  it('never executes a rejected request', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const organizationId = await verifiedOrganization();
    const filed = await requestApproval(operations, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'POLICY_VIOLATION' });
    const rejected = await decide(approver, filed.body.approval.id, 'REJECT', 'WRONG_TARGET');
    expect(rejected.body.approval.state).toBe('REJECTED');
    const response = await suspend(operations, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId: filed.body.approval.id });
    expect(response.body.error.code).toBe('APPROVAL_NOT_APPROVED');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='operations.approval.rejected' AND resource_id=$1", [filed.body.approval.id])).rowCount).toBe(1);
  });

  it('enables a high-risk feature flag with an approval', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const key = await highRiskFlag('ENABLE', false);
    const approvalId = await approved(operations, approver, 'FEATURE_FLAG_HIGH_RISK_CHANGE', { key, enabled: true, reasonCode: 'PILOT_ROLLOUT' });
    const done = await api().post('/api/v1/operations/feature-flags/' + key + '/state').set(auth(operations.userId)).send({ enabled: true, reasonCode: 'PILOT_ROLLOUT', approvalId });
    expect(done.status).toBe(201);
    expect(done.body.flags.find((flag: { key: string }) => flag.key === key)).toMatchObject({ enabled: true, highRiskDirection: 'ENABLE' });
  });

  it('turns a safety kill switch off only with an approval', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const key = await highRiskFlag('DISABLE', true);
    const refused = await api().post('/api/v1/operations/feature-flags/' + key + '/state').set(auth(operations.userId)).send({ enabled: false, reasonCode: 'ROLLBACK' });
    expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = await approved(operations, approver, 'FEATURE_FLAG_HIGH_RISK_CHANGE', { key, enabled: false, reasonCode: 'EVALUATION_COMPLETE' });
    await api().post('/api/v1/operations/feature-flags/' + key + '/state').set(auth(operations.userId)).send({ enabled: false, reasonCode: 'EVALUATION_COMPLETE', approvalId }).expect(201);
    expect((await pool.query('SELECT enabled FROM feature_flags WHERE key=$1', [key])).rows[0].enabled).toBe(false);
  });

  it('supersedes the backlog with an approval bound to the cutoff and limit', async () => {
    const security = await member('SECURITY_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const payload = { olderThan: '2000-01-01T00:00:00.000Z', limit: 50, reasonCode: 'PRE_DISPATCHER_BACKLOG' };
    const approvalId = await approved(security, approver, 'OUTBOX_BACKLOG_SUPERSEDE', payload);
    const wider = await api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(security.userId)).send({ ...payload, limit: 51, approvalId });
    expect(wider.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const done = await api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(security.userId)).send({ ...payload, approvalId });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ superseded: 0 });
    expect((await pool.query("SELECT state FROM operation_approvals WHERE id=$1", [approvalId])).rows[0].state).toBe('EXECUTED');
  });

  it('releases a legal hold with an approval, and never shows the hold subject in the queue', async () => {
    const security = await member('SECURITY_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const { holdId, subjectEmail } = await hold(security.userId);
    const approvalId = await approved(security, approver, 'PRIVACY_HOLD_RELEASE', { holdId, reasonCode: 'OBLIGATION_ENDED' });
    const list = await api().get('/api/v1/operations/approvals?state=APPROVED&limit=200').set(auth(approver.userId));
    const entry = list.body.approvals.find((row: { id: string }) => row.id === approvalId);
    expect(entry.summary.holdReason).toBe('LEGAL_OBLIGATION');
    expect(JSON.stringify(list.body)).not.toContain(subjectEmail);
    expect((await api().post('/api/v1/operations/privacy/holds/' + randomUUID() + '/release').set(auth(security.userId)).send({ reasonCode: 'OBLIGATION_ENDED', approvalId })).status).toBe(404);
    await api().post('/api/v1/operations/privacy/holds/' + holdId + '/release').set(auth(security.userId)).send({ reasonCode: 'OBLIGATION_ENDED', approvalId }).expect(201);
    const released = await pool.query("SELECT released_at FROM data_retention_holds WHERE id=$1", [holdId]);
    expect(released.rows[0].released_at).not.toBeNull();
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='privacy.retention_hold.released' AND resource_id=$1", [holdId]);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'OBLIGATION_ENDED', approval: expect.objectContaining({ approvalId }) });
  });

  it('grants a high-risk capability with an approval, and refuses an approver deciding their own elevation', async () => {
    const admin = await member('PLATFORM_SUPER_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const payload = { membershipId: security.membershipId, capability: 'CONTENT_PUBLISH', reasonCode: 'NEW_RESPONSIBILITY' };
    const approvalId = await approved(admin, approver, 'CAPABILITY_GRANT_HIGH_RISK', payload);
    const granted = await api().post('/api/v1/operations/staff/' + security.membershipId + '/capabilities').set(auth(admin.userId)).send({ capability: payload.capability, reasonCode: payload.reasonCode, approvalId });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body.member.effective).toContain('CONTENT_PUBLISH');
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.staff_capability.granted' AND resource_id=$1", [security.membershipId]);
    expect(audit.rows[0].context).toMatchObject({ capability: 'CONTENT_PUBLISH', approval: expect.objectContaining({ approvalId, approvedByUserId: approver.userId }) });

    // The security admin becomes an approver, then is asked to approve their own new power.
    await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'APPROVE_HIGH_RISK',$3,'NEW_RESPONSIBILITY')", [randomUUID(), security.membershipId, admin.userId]);
    const elevation = await requestApproval(admin, 'CAPABILITY_GRANT_HIGH_RISK', { membershipId: security.membershipId, capability: 'AI_OPS_CONFIGURE', reasonCode: 'NEW_RESPONSIBILITY' });
    const conflict = await decide(security, elevation.body.approval.id, 'APPROVE');
    expect(conflict.status).toBe(403);
    expect(conflict.body.error.code).toBe('APPROVAL_SUBJECT_CONFLICT');
    // A request that could never execute is not filed.
    const self = await requestApproval(admin, 'CAPABILITY_GRANT_HIGH_RISK', { membershipId: admin.membershipId, capability: 'CONTENT_PUBLISH', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(self.body.error.code).toBe('CAPABILITY_SELF_CHANGE_REFUSED');
  });
});

describe('GET /operations/approvals', () => {
  it('shows approvers the queue, others only their own requests, and bounds the page', async () => {
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const mine = await member('OPERATIONS_ADMIN');
    const theirs = await member('OPERATIONS_ADMIN');
    const a = await requestApproval(mine, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
    const b = await requestApproval(theirs, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
    const own = await api().get('/api/v1/operations/approvals?state=PENDING&limit=200').set(auth(mine.userId));
    expect(own.status).toBe(200);
    expect(own.body.viewerIsApprover).toBe(false);
    expect(own.body.approvals.map((row: { id: string }) => row.id)).toEqual([a.body.approval.id]);
    const all = await api().get('/api/v1/operations/approvals?state=PENDING&limit=200').set(auth(approver.userId));
    const ids = all.body.approvals.map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([a.body.approval.id, b.body.approval.id]));
    expect(all.body.approvals.find((row: { id: string }) => row.id === b.body.approval.id)).toMatchObject({ canApprove: true, canReject: true, canExecute: false });

    const first = await api().get('/api/v1/operations/approvals?limit=1').set(auth(approver.userId));
    const second = await api().get('/api/v1/operations/approvals?limit=1&cursor=' + encodeURIComponent(first.body.nextCursor)).set(auth(approver.userId));
    expect(second.body.approvals[0].id).not.toBe(first.body.approvals[0].id);
    for (const query of ['?limit=0', '?limit=201', '?state=OPEN', '?cursor=bad', '?actor=x']) {
      expect((await api().get('/api/v1/operations/approvals' + query).set(auth(approver.userId))).status, query).toBe(400);
    }
    expect((await api().get('/api/v1/operations/approvals')).status).toBe(401);
    expect((await api().get('/api/v1/operations/approvals').set(auth((await member('INSTITUTION_ADMIN')).userId))).status).toBe(403);
  });
});

describe('the database refuses what the API refuses', () => {
  it('keeps requests immutable, never deleted, and never self-approved outside the solo rule', async () => {
    const requester = await member('PLATFORM_SUPER_ADMIN');
    await member('PLATFORM_SUPER_ADMIN');
    const filed = await requestApproval(requester, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
    const id = filed.body.approval.id;
    await expect(pool.query("UPDATE operation_approvals SET reason_code='CONTRACT_ENDED' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM operation_approvals WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query(
      "UPDATE operation_approvals SET state='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason_code='VERIFIED_NEED' WHERE id=$1",
      [id, requester.userId],
    )).rejects.toThrow(/requester may not decide/);
    await backdate(id, '20 minutes');
    await expect(pool.query(
      "UPDATE operation_approvals SET state='APPROVED', decided_by_user_id=$2, decided_at=now(), decision_reason_code='VERIFIED_NEED', solo=true, solo_notice_state='NOT_DELIVERED' WHERE id=$1",
      [id, requester.userId],
    )).rejects.toThrow(/exactly one approver/);
    await expect(pool.query(
      "INSERT INTO operation_approvals (id,action_key,target_type,target_id,payload,payload_hash,requested_by_user_id,reason_code,correlation_id,expires_at,state) VALUES ($1,'ORGANIZATION_SUSPEND','organization','x','{}'::jsonb,repeat('a',64),$2,'POLICY_VIOLATION','ops-appr-direct',now(),'APPROVED')",
      [randomUUID(), requester.userId],
    )).rejects.toThrow(/starts PENDING/);
  });
});

// Last, because it suspends every other platform membership in this schema to leave
// exactly one approver, and restores them afterwards.
describe('the solo-operator safeguard', () => {
  it('applies only with exactly one approver, after 15 minutes, marked SOLO, with the notice recorded honestly', async () => {
    const solo = await member('PLATFORM_SUPER_ADMIN');
    const suspended = await pool.query(
      "UPDATE organization_memberships SET state='SUSPENDED' WHERE organization_id=$1 AND user_id<>$2 AND state='ACTIVE' RETURNING id",
      [platformId, solo.userId],
    );
    try {
      const organizationId = await verifiedOrganization();
      const filed = await requestApproval(solo, 'ORGANIZATION_SUSPEND', { organizationId, reasonCode: 'POLICY_VIOLATION' });
      const approvalId = filed.body.approval.id as string;
      const policy = await api().get('/api/v1/operations/approvals/policy').set(auth(solo.userId));
      expect(policy.body).toMatchObject({ approverCount: 1, soloSafeguardActive: true });

      const tooSoon = await decide(solo, approvalId, 'APPROVE');
      expect(tooSoon.status).toBe(403);
      expect(tooSoon.body.error.code).toBe('APPROVAL_SOLO_COOLING_OFF');

      await backdate(approvalId, '16 minutes');
      const approvedSolo = await decide(solo, approvalId, 'APPROVE');
      expect(approvedSolo.status).toBe(201);
      // No email sender is configured (HG-7): the notice is recorded as not delivered, not faked.
      expect(approvedSolo.body.approval).toMatchObject({ state: 'APPROVED', mode: 'SOLO', soloNotice: 'NOT_DELIVERED' });
      expect((await pool.query("SELECT 1 FROM notification_commands WHERE dedupe_key LIKE $1", ['approval-solo:' + approvalId + ':%'])).rowCount).toBe(0);
      const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.approval.approved' AND resource_id=$1", [approvalId]);
      expect(audit.rows[0].context).toMatchObject({ mode: 'SOLO', soloNotice: 'NOT_DELIVERED', requestedByUserId: solo.userId, decidedByUserId: solo.userId });
      await suspend(solo, organizationId, { reasonCode: 'POLICY_VIOLATION', approvalId }).expect(201);
      const executed = await pool.query("SELECT context FROM audit_events WHERE action='operations.approval.executed' AND resource_id=$1", [approvalId]);
      expect(executed.rows[0].context).toMatchObject({ mode: 'SOLO' });

      // With a sender registered, the notice goes through the existing pipeline.
      await pool.query(
        "INSERT INTO automation_workflow_registry (id,allowlist_id,version,workflow_hash,operation,destination_class,active,kill_switch) VALUES ($1,'security-notification',1,repeat('b',64),'SEND_EMAIL','EMAIL',true,false)",
        [randomUUID()],
      );
      const second = await requestApproval(solo, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
      await backdate(second.body.approval.id, '16 minutes');
      const queued = await decide(solo, second.body.approval.id, 'APPROVE');
      expect(queued.body.approval.soloNotice).toBe('QUEUED');
      const commands = await pool.query("SELECT id, state FROM notification_commands WHERE dedupe_key LIKE $1", ['approval-solo:' + second.body.approval.id + ':%']);
      expect(commands.rows).toEqual([{ id: expect.any(String), state: 'PENDING' }]);
      expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type='notification.delivery.requested' AND aggregate_id=$1", [commands.rows[0].id])).rowCount).toBe(1);

      // A second approver switches the safeguard off with no configuration change.
      await member('SECURITY_ADMIN').then((security) => pool.query(
        "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'APPROVE_HIGH_RISK',$3,'NEW_RESPONSIBILITY')",
        [randomUUID(), security.membershipId, solo.userId],
      ));
      const third = await requestApproval(solo, 'ORGANIZATION_SUSPEND', { organizationId: await verifiedOrganization(), reasonCode: 'POLICY_VIOLATION' });
      await backdate(third.body.approval.id, '16 minutes');
      const refused = await decide(solo, third.body.approval.id, 'APPROVE');
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('APPROVAL_SELF_DECISION_REFUSED');
    } finally {
      await pool.query("UPDATE organization_memberships SET state='ACTIVE' WHERE id = ANY($1::uuid[])", [suspended.rows.map((row) => row.id)]);
    }
  });
});
