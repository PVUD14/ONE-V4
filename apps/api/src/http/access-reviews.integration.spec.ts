/**
 * Quarterly internal access reviews over HTTP (OPS-15).
 *
 * A campaign freezes every standing internal access; a reviewer decides each item; a
 * REVOKE takes effect at once through the capability statements and is audited with the
 * campaign reference; nobody attests their own access except the marked solo case; the
 * campaign closes only when every item is decided; the CSV reproduces the campaign
 * exactly; and an overdue review is visible. The 0079 triggers are exercised directly
 * as well, because a second writer must not be able to skip the rules.
 *
 * Real Postgres in a throwaway schema. Time is moved by backdating with the trigger
 * disabled (only the table owner can), since the triggers stamp the database clock.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { isAccessReviewer } from '@planthepath/authorization/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { OperationsAccessReviewsController } from './operations-access-reviews.controller.js';
import { accessReviewCsvHeader, accessReviewCsvRow } from './access-review-csv.js';
import { csvCell } from './institution-export-csv.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for access review tests');

const schemaName = 'ops_access_reviews_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let collegeId: string;

interface Member { readonly userId: string; readonly membershipId: string; readonly email: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

let superAdmin: Member;
let reviewerOne: Member;
let reviewerTwo: Member;
let operations: Member;
let grantedReviewer: Member;
let leaver: Member;
let faculty: Member;
let institutionAdmin: Member;
let suspendedStaff: Member;

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
    controllers: [OperationsAccessReviewsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  collegeId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Review college')", [collegeId]);

  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  reviewerOne = await member('SECURITY_ADMIN');
  reviewerTwo = await member('SECURITY_ADMIN');
  operations = await member('OPERATIONS_ADMIN');
  await grant(operations, 'INCIDENT_MANAGE');
  await grant(operations, 'AI_OPS_CONFIGURE');
  await pool.query("UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now(), revoked_reason_code='CORRECTION' WHERE membership_id=$1 AND capability='AI_OPS_CONFIGURE'", [operations.membershipId, superAdmin.userId]);
  grantedReviewer = await member('OPERATIONS_ADMIN');
  await grant(grantedReviewer, 'SECURITY_ACCESS_REVIEW');
  leaver = await member('OPERATIONS_ADMIN');
  await grant(leaver, 'CATALOGUE_MANAGE');
  faculty = await member('FACULTY_LECTURER');
  await grant(faculty, 'CONTENT_REVIEW_EXTERNAL', 'FACULTY_REVIEWER_AGREED');
  institutionAdmin = await member('INSTITUTION_ADMIN');
  await grant(institutionAdmin, 'INSTITUTION_ANALYTICS', 'ACCESS_REVIEW');
  suspendedStaff = await member('SECURITY_ADMIN', 'SUSPENDED');
  // The first reviewer joined through an invitation the super admin sent.
  await pool.query(
    `INSERT INTO invitations (id,email,token_hash,state,invited_by_user_id,organization_id,role,scope_organization_id,expires_at,accepted_by_user_id,accepted_at)
     VALUES ($1,$2,$3,'ACCEPTED',$4,$5,'SECURITY_ADMIN',$5,now() + interval '7 days',$6,now())`,
    [randomUUID(), reviewerOne.email, 'x'.repeat(64), superAdmin.userId, platformId, reviewerOne.userId],
  );
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = 'staff-' + userId.slice(0, 8) + '@example.test';
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : collegeId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId, email };
}

async function grant(target: Member, capability: string, reason = 'NEW_RESPONSIBILITY'): Promise<void> {
  await pool.query(
    'INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), target.membershipId, capability, superAdmin.userId, reason],
  );
}

const api = () => request(app.getHttpServer());
const base = '/api/v1/operations/access-reviews';
const auth = (actor: Member) => ({ Authorization: 'Bearer ' + actor.userId, 'X-Correlation-Id': 'ops-ar-' + randomUUID() });

interface ItemDto {
  id: string; position: number; kind: string; subject: { email: string; isSelf: boolean }; role: string; capability: string | null;
  capabilities: string[]; highRisk: boolean; grantedBy: { email: string } | null; grantedAt: string; grantReasonCode: string | null;
  decision: string | null; mode: string | null; revocationOutcome: string | null; canKeep: boolean; canRevoke: boolean; refusal: string | null;
  organizationName: string;
}

async function allItems(actor: Member, campaignId: string): Promise<ItemDto[]> {
  const response = await api().get(`${base}/${campaignId}/items?limit=200`).set(auth(actor));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.items as ItemDto[];
}

function decide(actor: Member, campaignId: string, itemId: string, decision: 'KEEP' | 'REVOKE', reasonCode = decision === 'KEEP' ? 'STILL_REQUIRED' : 'NO_LONGER_REQUIRED', note?: string) {
  return api().post(`${base}/${campaignId}/items/${itemId}/decision`).set(auth(actor)).send({ decision, reasonCode, ...(note ? { note } : {}) });
}

const find = (items: ItemDto[], who: Member, capability: string | null = null) =>
  items.find((item) => item.subject.email === who.email && item.capability === capability)!;

async function auditRows(action: string, resourceId: string): Promise<{ context: Record<string, unknown>; correlation_id: string }[]> {
  return (await pool.query('SELECT context, correlation_id FROM audit_events WHERE action=$1 AND resource_id=$2 ORDER BY occurred_at', [action, resourceId])).rows;
}

/** Parse the house CSV (every cell quoted, CRLF, BOM) back into rows of strings. */
function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; } else if (char === '\r') { /* CRLF */ } else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += char;
  }
  return rows;
}

async function setMembershipState(target: Member, state: string): Promise<void> {
  await pool.query('UPDATE organization_memberships SET state=$2 WHERE id=$1', [target.membershipId, state]);
}

/** Move a campaign back in time. The trigger forbids this, so the owner bypasses it. */
async function backdateCampaign(campaignId: string, column: 'opened_at' | 'closed_at', interval: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE access_review_campaigns DISABLE TRIGGER access_review_campaign_guard');
    if (column === 'opened_at') {
      await client.query(`UPDATE access_review_campaigns SET opened_at = opened_at - $2::interval, due_at = due_at - $2::interval WHERE id = $1`, [campaignId, interval]);
    } else {
      await client.query(`UPDATE access_review_campaigns SET opened_at = opened_at - $2::interval, due_at = due_at - $2::interval, closed_at = closed_at - $2::interval WHERE id = $1`, [campaignId, interval]);
    }
    await client.query('ALTER TABLE access_review_campaigns ENABLE TRIGGER access_review_campaign_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let campaignId = '';
let items: ItemDto[] = [];

describe('who may run an access review', () => {
  it('401 without a token', async () => {
    expect((await api().get(base)).status).toBe(401);
  });

  it('403 for an operations admin without the grant and for a college admin', async () => {
    for (const actor of [operations, institutionAdmin, faculty]) {
      const response = await api().get(base).set(auth(actor));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect((await api().post(base).set(auth(actor)).send({ reasonCode: 'QUARTERLY_REVIEW' })).status).toBe(403);
    }
  });

  it('200 for the security admin, the super admin and an operations admin holding SECURITY_ACCESS_REVIEW', async () => {
    for (const actor of [reviewerOne, superAdmin, grantedReviewer]) expect((await api().get(base).set(auth(actor))).status).toBe(200);
  });

  it('shows that no review has ever been completed, as overdue', async () => {
    const response = await api().get(base).set(auth(reviewerOne));
    expect(response.body.summary).toMatchObject({ status: 'NEVER_REVIEWED', overdue: true, nextDueAt: null, open: null, lastClosed: null, soloSafeguardActive: false });
    expect(response.body.summary.reviewerCount).toBe(4);
    expect(response.body.policy.reasons.decision.REVOKE).toContain('LEAVER');
  });

  it('validates input before anything is written', async () => {
    const cases = [
      api().post(base).set(auth(reviewerOne)).send({ reasonCode: 'BECAUSE' }),
      api().post(base).set(auth(reviewerOne)).send({ reasonCode: 'QUARTERLY_REVIEW', extra: 1 }),
      api().post(base).set(auth(reviewerOne)).send({ reasonCode: 'QUARTERLY_REVIEW', note: 'x'.repeat(501) }),
      api().get(base + '?limit=0').set(auth(reviewerOne)),
      api().get(base + '?limit=201').set(auth(reviewerOne)),
      api().get(base + '?cursor=not-a-cursor').set(auth(reviewerOne)),
      api().get(base + '?unknown=1').set(auth(reviewerOne)),
      api().get(base + '/not-a-uuid').set(auth(reviewerOne)),
    ];
    for (const response of await Promise.all(cases)) expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM access_review_campaigns')).rows[0].n).toBe(0);
    expect((await api().get(base + '/' + randomUUID()).set(auth(reviewerOne))).status).toBe(404);
  });
});

describe('a campaign with more than one reviewer', () => {
  it('opens with a frozen snapshot of every standing internal access, and only one campaign is open', async () => {
    const opened = await api().post(base).set(auth(reviewerOne)).send({ reasonCode: 'QUARTERLY_REVIEW', note: 'First quarterly review' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    campaignId = opened.body.campaign.id;
    expect(opened.body.campaign).toMatchObject({ state: 'OPEN', openReasonCode: 'QUARTERLY_REVIEW', openedBy: { email: reviewerOne.email } });
    expect(opened.body.campaign.periodLabel).toMatch(/^[0-9]{4}-Q[1-4]$/);
    expect(new Date(opened.body.campaign.dueAt).getTime() - new Date(opened.body.campaign.openedAt).getTime()).toBe(30 * 86_400_000);

    items = await allItems(reviewerOne, campaignId);
    const roles = items.filter((item) => item.kind === 'PLATFORM_ROLE').map((item) => item.subject.email).sort();
    expect(roles).toEqual([superAdmin, reviewerOne, reviewerTwo, operations, grantedReviewer, leaver].map((m) => m.email).sort());
    const grants = items.filter((item) => item.kind === 'CAPABILITY_GRANT').map((item) => `${item.subject.email}:${item.capability}`).sort();
    expect(grants).toEqual([
      `${operations.email}:INCIDENT_MANAGE`, `${grantedReviewer.email}:SECURITY_ACCESS_REVIEW`, `${leaver.email}:CATALOGUE_MANAGE`,
      `${faculty.email}:CONTENT_REVIEW_EXTERNAL`,
    ].sort());
    expect(opened.body.campaign.itemCount).toBe(items.length);
    // Not reviewed here: a suspended membership, a revoked grant, and a college's own analytics delegation.
    expect(items.some((item) => item.subject.email === suspendedStaff.email)).toBe(false);
    expect(items.some((item) => item.capability === 'AI_OPS_CONFIGURE' || item.capability === 'INSTITUTION_ANALYTICS')).toBe(false);

    // Who granted it and when.
    const incident = find(items, operations, 'INCIDENT_MANAGE');
    expect(incident).toMatchObject({ grantedBy: { email: superAdmin.email }, grantReasonCode: 'NEW_RESPONSIBILITY', highRisk: false });
    expect(find(items, reviewerOne).grantedBy).toEqual({ email: superAdmin.email });
    expect(find(items, reviewerTwo).grantedBy).toBeNull();
    expect(find(items, superAdmin)).toMatchObject({ highRisk: true });
    expect(find(items, superAdmin).capabilities).toContain('APPROVE_HIGH_RISK');
    expect(find(items, operations).capabilities).toContain('INCIDENT_MANAGE');
    expect(find(items, faculty, 'CONTENT_REVIEW_EXTERNAL').organizationName).toBe('Review college');
    // Platform staff first, in a stable order.
    expect(items.map((item) => item.position)).toEqual(items.map((_, index) => index + 1));
    expect(items[items.length - 1]!.subject.email).toBe(faculty.email);

    // Identifiers of people stay on the server.
    expect(JSON.stringify(opened.body)).not.toMatch(/userId/);
    expect(JSON.stringify(items)).not.toMatch(/userId/);

    const audit = await auditRows('operations.access_review.opened', campaignId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({ reasonCode: 'QUARTERLY_REVIEW', itemCount: items.length });
    const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='access_review.opened' AND aggregate_id=$1", [campaignId]);
    expect(outbox.rows[0].n).toBe(1);

    const again = await api().post(base).set(auth(reviewerTwo)).send({ reasonCode: 'AD_HOC_REVIEW' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ACCESS_REVIEW_ALREADY_OPEN');
  });

  it('pages items in snapshot order with bounded limits', async () => {
    const first = await api().get(`${base}/${campaignId}/items?limit=2`).set(auth(reviewerOne));
    expect(first.status).toBe(200);
    expect(first.body.items.map((item: ItemDto) => item.position)).toEqual([1, 2]);
    const second = await api().get(`${base}/${campaignId}/items?limit=2&cursor=${first.body.nextCursor}`).set(auth(reviewerOne));
    expect(second.body.items.map((item: ItemDto) => item.position)).toEqual([3, 4]);
    for (const query of ['limit=0', 'limit=201', 'cursor=@@', 'filter=MAYBE']) {
      expect((await api().get(`${base}/${campaignId}/items?${query}`).set(auth(reviewerOne))).status).toBe(400);
    }
    const undecided = await api().get(`${base}/${campaignId}/items?filter=UNDECIDED&limit=200`).set(auth(reviewerOne));
    expect(undecided.body.items).toHaveLength(items.length);
  });

  it('never lets a reviewer attest their own access', async () => {
    const own = find(items, reviewerOne);
    expect(own).toMatchObject({ subject: { isSelf: true }, canKeep: false, canRevoke: false, refusal: 'ACCESS_REVIEW_OWN_ACCESS' });
    for (const decision of ['KEEP', 'REVOKE'] as const) {
      const response = await decide(reviewerOne, campaignId, own.id, decision);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCESS_REVIEW_OWN_ACCESS');
    }
    const grantHolder = find(items, grantedReviewer, 'SECURITY_ACCESS_REVIEW');
    expect((await decide(grantedReviewer, campaignId, grantHolder.id, 'KEEP')).status).toBe(403);
  });

  it('validates a decision and records a KEEP once, audited with the campaign', async () => {
    const item = find(items, superAdmin);
    for (const body of [{ decision: 'MAYBE', reasonCode: 'STILL_REQUIRED' }, { decision: 'KEEP', reasonCode: 'LEAVER' }, { decision: 'KEEP', reasonCode: 'STILL_REQUIRED', extra: true }]) {
      expect((await api().post(`${base}/${campaignId}/items/${item.id}/decision`).set(auth(reviewerOne)).send(body)).status).toBe(400);
    }
    expect((await api().post(`${base}/${campaignId}/items/not-a-uuid/decision`).set(auth(reviewerOne)).send({ decision: 'KEEP', reasonCode: 'STILL_REQUIRED' })).status).toBe(400);
    expect((await decide(reviewerOne, campaignId, randomUUID(), 'KEEP')).status).toBe(404);

    const kept = await decide(reviewerOne, campaignId, item.id, 'KEEP', 'ROLE_REQUIRES_IT', 'Founder account');
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body.item).toMatchObject({ decision: 'KEEP', mode: 'DUAL', decidedBy: { email: reviewerOne.email }, revocationOutcome: null });
    const again = await decide(reviewerTwo, campaignId, item.id, 'REVOKE');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ACCESS_REVIEW_ALREADY_DECIDED');
    const audit = await auditRows('operations.access_review.item_decided', item.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({ campaignId, decision: 'KEEP', reasonCode: 'ROLE_REQUIRES_IT', mode: 'DUAL', itemKind: 'PLATFORM_ROLE' });
  });

  it('revokes an internal grant at once, audited with the campaign reference', async () => {
    const item = find(items, operations, 'INCIDENT_MANAGE');
    const response = await decide(reviewerOne, campaignId, item.id, 'REVOKE', 'EXCESSIVE_PRIVILEGE');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.item).toMatchObject({ decision: 'REVOKE', revocationOutcome: 'APPLIED' });
    const grantRow = await pool.query("SELECT revoked_at, revoked_reason_code, revoked_by_user_id FROM membership_capabilities WHERE membership_id=$1 AND capability='INCIDENT_MANAGE'", [operations.membershipId]);
    expect(grantRow.rows[0]).toMatchObject({ revoked_reason_code: 'ACCESS_REVIEW_OUTCOME', revoked_by_user_id: reviewerOne.userId });
    const audit = await auditRows('operations.staff_capability.revoked', operations.membershipId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({
      capability: 'INCIDENT_MANAGE', reasonCode: 'ACCESS_REVIEW_OUTCOME',
      accessReview: { campaignId, itemId: item.id, decisionReasonCode: 'EXCESSIVE_PRIVILEGE' },
    });
    const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='organization_membership.capability_revoked' AND aggregate_id=$1", [operations.membershipId]);
    expect(outbox.rows[0].n).toBe(1);
  });

  it('revoking a reviewer grant takes the reviewer out immediately', async () => {
    const item = find(items, grantedReviewer, 'SECURITY_ACCESS_REVIEW');
    expect((await decide(reviewerOne, campaignId, item.id, 'REVOKE', 'NO_LONGER_REQUIRED')).status).toBe(201);
    expect((await api().get(base).set(auth(grantedReviewer))).status).toBe(403);
  });

  it('revokes a faculty review grant through the external review path, with the campaign reference', async () => {
    const item = find(items, faculty, 'CONTENT_REVIEW_EXTERNAL');
    const response = await decide(reviewerTwo, campaignId, item.id, 'REVOKE', 'NO_LONGER_REQUIRED');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.item.revocationOutcome).toBe('APPLIED');
    const live = await pool.query("SELECT count(*)::int AS n FROM membership_capabilities WHERE membership_id=$1 AND revoked_at IS NULL", [faculty.membershipId]);
    expect(live.rows[0].n).toBe(0);
    const audit = await auditRows('operations.external_reviewer.revoked', faculty.membershipId);
    expect(audit[0]!.context).toMatchObject({ capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: 'ACCESS_REVIEW_OUTCOME', accessReview: { campaignId, itemId: item.id } });
  });

  it('suspends a platform role at once, revoking its grants, audited with the campaign reference', async () => {
    const item = find(items, leaver);
    const response = await decide(reviewerOne, campaignId, item.id, 'REVOKE', 'LEAVER');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.item.revocationOutcome).toBe('APPLIED');
    const state = await pool.query('SELECT state::text AS state FROM organization_memberships WHERE id=$1', [leaver.membershipId]);
    expect(state.rows[0].state).toBe('SUSPENDED');
    const grantRow = await pool.query("SELECT revoked_reason_code FROM membership_capabilities WHERE membership_id=$1 AND capability='CATALOGUE_MANAGE'", [leaver.membershipId]);
    expect(grantRow.rows[0].revoked_reason_code).toBe('ACCESS_REVIEW_OUTCOME');
    const audit = await auditRows('operations.staff_membership.suspended', leaver.membershipId);
    expect(audit[0]!.context).toMatchObject({ reasonCode: 'ACCESS_REVIEW_OUTCOME', revokedCapabilities: ['CATALOGUE_MANAGE'], accessReview: { campaignId, itemId: item.id, decisionReasonCode: 'LEAVER' } });
    const events = await pool.query("SELECT event_type FROM outbox_events WHERE aggregate_id=$1 ORDER BY event_type", [leaver.membershipId]);
    expect(events.rows.map((row) => row.event_type)).toEqual(['organization_membership.capability_revoked', 'organization_membership.suspended']);
    // The leaver's access is gone for the next request, and their grant item records it already ended.
    const grantItem = find(items, leaver, 'CATALOGUE_MANAGE');
    const late = await decide(reviewerTwo, campaignId, grantItem.id, 'REVOKE', 'LEAVER');
    expect(late.status).toBe(201);
    expect(late.body.item.revocationOutcome).toBe('ALREADY_ENDED');
  });

  it('refuses to close while items are undecided', async () => {
    const response = await api().post(`${base}/${campaignId}/close`).set(auth(reviewerOne)).send({ reasonCode: 'REVIEW_COMPLETE' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACCESS_REVIEW_UNDECIDED_ITEMS');
    expect((await api().post(`${base}/${campaignId}/close`).set(auth(reviewerOne)).send({ reasonCode: 'DONE' })).status).toBe(400);
  });

  it('closes once every item is decided by someone other than its subject', async () => {
    items = await allItems(reviewerOne, campaignId);
    for (const item of items.filter((candidate) => candidate.decision === null)) {
      const decider = item.subject.email === reviewerOne.email ? reviewerTwo : reviewerOne;
      const response = await decide(decider, campaignId, item.id, 'KEEP');
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const closed = await api().post(`${base}/${campaignId}/close`).set(auth(reviewerTwo)).send({ reasonCode: 'REVIEW_COMPLETE' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body.campaign).toMatchObject({ state: 'CLOSED', closedBy: { email: reviewerTwo.email }, closeReasonCode: 'REVIEW_COMPLETE' });
    expect(closed.body.campaign.counts).toMatchObject({ decided: items.length, revoked: 5, kept: items.length - 5, solo: 0 });
    const audit = await auditRows('operations.access_review.closed', campaignId);
    expect(audit[0]!.context).toMatchObject({ revoked: 5, solo: 0 });
    const late = await decide(reviewerOne, campaignId, items[0]!.id, 'KEEP');
    expect(late.status).toBe(409);
    expect((await api().post(`${base}/${campaignId}/close`).set(auth(reviewerOne)).send({ reasonCode: 'REVIEW_COMPLETE' })).status).toBe(409);
  });

  it('exports CSV that reproduces the campaign exactly, and audits the export with its hash', async () => {
    expect((await api().post(`${base}/${campaignId}/export`).set(auth(reviewerOne)).send({})).status).toBe(400);
    expect((await api().post(`${base}/${campaignId}/export`).set(auth(operations)).send({ reasonCode: 'AUDIT_EVIDENCE' })).status).toBe(403);
    const response = await api().post(`${base}/${campaignId}/export`).set(auth(reviewerOne)).send({ reasonCode: 'AUDIT_EVIDENCE' })
      .buffer(true).parse((res, callback) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { text += chunk; }); res.on('end', () => callback(null, text)); });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="one-access-review-[0-9]{4}-q[1-4]-/);
    const text = response.body as string;
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...accessReviewCsvHeader]);

    const campaign = (await api().get(`${base}/${campaignId}`).set(auth(reviewerOne))).body.campaign;
    items = await allItems(reviewerOne, campaignId);
    expect(rows).toHaveLength(items.length + 1);
    items.forEach((item, index) => {
      const expected = accessReviewCsvRow(campaign, item as never).map((value) => {
        // What the reader sees in each cell: the house writer's rendering, unquoted.
        if (typeof value === 'number') return String(value);
        return csvCell(value).slice(1, -1).replaceAll('""', '"');
      });
      expect(rows[index + 1]).toEqual(expected);
    });
    // Spot-check the evidence itself, not only the round trip.
    const incidentRow = rows.find((row) => row[18] === 'INCIDENT_MANAGE')!;
    expect(incidentRow.slice(21, 31)).toEqual([superAdmin.email, expect.any(String), 'NEW_RESPONSIBILITY', 'REVOKE', 'EXCESSIVE_PRIVILEGE', '', reviewerOne.email, expect.any(String), 'DUAL', 'APPLIED']);
    expect(rows.find((row) => row[13] === reviewerTwo.email && row[12] === 'PLATFORM_ROLE')![21]).toBe('NA');
    expect(text).not.toMatch(/student/i);

    const audit = await auditRows('operations.access_review.exported', campaignId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({ reasonCode: 'AUDIT_EVIDENCE', rows: items.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') });
  });

  it('shows the schedule as current after a close, and overdue once the quarter has passed', async () => {
    const current = await api().get(base).set(auth(reviewerOne));
    expect(current.body.summary).toMatchObject({ status: 'CURRENT', overdue: false, open: null, lastClosed: { id: campaignId } });
    expect(current.body.campaigns[0]).toMatchObject({ id: campaignId, state: 'CLOSED' });
    await backdateCampaign(campaignId, 'closed_at', '120 days');
    const overdue = await api().get(base).set(auth(reviewerOne));
    expect(overdue.body.summary).toMatchObject({ status: 'REVIEW_OVERDUE', overdue: true });
    expect(new Date(overdue.body.summary.nextDueAt).getTime()).toBeLessThan(Date.now());
  });
});

describe('the solo operator', () => {
  let soloCampaign = '';

  it('keeps the last active super admin', async () => {
    // A fresh campaign in which the security admins are the reviewers.
    const opened = await api().post(base).set(auth(reviewerOne)).send({ reasonCode: 'AD_HOC_REVIEW' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    soloCampaign = opened.body.campaign.id;
    const superItem = find(await allItems(reviewerOne, soloCampaign), superAdmin);
    const response = await decide(reviewerOne, soloCampaign, superItem.id, 'REVOKE', 'EXCESSIVE_PRIVILEGE');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCESS_REVIEW_LAST_SUPER_ADMIN');
    expect((await pool.query('SELECT state::text AS s FROM organization_memberships WHERE id=$1', [superAdmin.membershipId])).rows[0].s).toBe('ACTIVE');
    expect((await pool.query('SELECT decision FROM access_review_items WHERE id=$1', [superItem.id])).rows[0].decision).toBeNull();
  });

  it('may keep their own access only after 15 minutes, marked SOLO, and never revoke it', async () => {
    // Only the super admin can review now.
    await setMembershipState(reviewerOne, 'SUSPENDED');
    await setMembershipState(reviewerTwo, 'SUSPENDED');
    const own = find(await allItems(superAdmin, soloCampaign), superAdmin);
    expect(own).toMatchObject({ canKeep: false, refusal: 'ACCESS_REVIEW_SOLO_COOLING_OFF' });
    const early = await decide(superAdmin, soloCampaign, own.id, 'KEEP');
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('ACCESS_REVIEW_SOLO_COOLING_OFF');

    await backdateCampaign(soloCampaign, 'opened_at', '16 minutes');
    expect((await api().get(base).set(auth(superAdmin))).body.summary).toMatchObject({ soloSafeguardActive: true, reviewerCount: 1 });
    const revokeOwn = await decide(superAdmin, soloCampaign, own.id, 'REVOKE');
    expect(revokeOwn.status).toBe(403);
    expect(revokeOwn.body.error.code).toBe('ACCESS_REVIEW_OWN_ACCESS');

    // The safeguard switches itself off the moment a second reviewer exists.
    await setMembershipState(reviewerTwo, 'ACTIVE');
    const withSecond = await decide(superAdmin, soloCampaign, own.id, 'KEEP');
    expect(withSecond.status).toBe(403);
    expect(withSecond.body.error.code).toBe('ACCESS_REVIEW_OWN_ACCESS');
    await setMembershipState(reviewerTwo, 'SUSPENDED');

    const solo = await decide(superAdmin, soloCampaign, own.id, 'KEEP', 'ROLE_REQUIRES_IT');
    expect(solo.status, JSON.stringify(solo.body)).toBe(201);
    expect(solo.body.item).toMatchObject({ decision: 'KEEP', mode: 'SOLO', decidedBy: { email: superAdmin.email } });
    expect(solo.body.campaign.counts.solo).toBe(1);
    const audit = await auditRows('operations.access_review.item_decided', own.id);
    expect(audit[0]!.context).toMatchObject({ mode: 'SOLO', decision: 'KEEP' });
    await setMembershipState(reviewerOne, 'ACTIVE');
    await setMembershipState(reviewerTwo, 'ACTIVE');
  });

  it('the database refuses what the API refuses, for any other writer', async () => {
    const soloItems = await allItems(reviewerOne, soloCampaign);
    const ownRole = find(soloItems, reviewerOne);
    const other = soloItems.find((item) => item.decision === null && item.subject.email !== reviewerOne.email)!;
    const expectRefused = async (text: string, values: unknown[], pattern: RegExp) => {
      await expect(pool.query(text, values)).rejects.toThrow(pattern);
    };
    await expectRefused(
      "UPDATE access_review_items SET decision='KEEP', decision_reason_code='STILL_REQUIRED', decided_by_user_id=$2, decision_correlation_id='x', decided_at=now() WHERE id=$1",
      [ownRole.id, reviewerOne.userId], /own access|access_review_item_solo_ck/,
    );
    await expectRefused(
      "UPDATE access_review_items SET decision='KEEP', decision_reason_code='STILL_REQUIRED', decided_by_user_id=$2, decision_correlation_id='x', decided_at=now() WHERE id=$1",
      [other.id, operations.userId], /only an access reviewer/,
    );
    await expectRefused("UPDATE access_review_items SET role='PLATFORM_SUPER_ADMIN' WHERE id=$1", [other.id], /snapshot cannot be changed/);
    await expectRefused('DELETE FROM access_review_items WHERE id=$1', [other.id], /never deleted/);
    await expectRefused('DELETE FROM access_review_campaigns WHERE id=$1', [soloCampaign], /never deleted/);
    await expectRefused(
      `INSERT INTO access_review_items (id,campaign_id,position,item_kind,membership_id,subject_user_id,organization_id,role,membership_state,capabilities_snapshot,high_risk,granted_at)
       VALUES ($1,$2,999,'PLATFORM_ROLE',$3,$4,$5,'SECURITY_ADMIN','ACTIVE','{}',false,now())`,
      [randomUUID(), soloCampaign, reviewerOne.membershipId, reviewerOne.userId, platformId], /only when the campaign opens/,
    );
    await expectRefused(
      "UPDATE access_review_campaigns SET state='CLOSED', closed_by_user_id=$2, close_reason_code='REVIEW_COMPLETE', close_correlation_id='x', closed_at=now() WHERE id=$1",
      [soloCampaign, reviewerOne.userId], /undecided/,
    );
    await expectRefused("UPDATE access_review_campaigns SET open_reason_code='AUDIT_REQUEST' WHERE id=$1", [soloCampaign], /cannot be changed/);
    await expectRefused(
      "INSERT INTO access_review_campaigns (id,opened_by_user_id,open_reason_code,open_correlation_id,item_count) VALUES ($1,$2,'AD_HOC_REVIEW','x',0)",
      [randomUUID(), operations.userId], /only an access reviewer/,
    );
  });

  it('shows an open campaign past its window as overdue', async () => {
    await backdateCampaign(soloCampaign, 'opened_at', '31 days');
    const response = await api().get(base).set(auth(reviewerOne));
    expect(response.body.summary).toMatchObject({ status: 'CAMPAIGN_OVERDUE', overdue: true, open: { id: soloCampaign } });
  });
});

describe('the database and the code agree on who is a reviewer', () => {
  it('matches isAccessReviewer for every platform role, with and without a grant, and for inactive memberships', async () => {
    const cases: { role: string; state: string; grants: string[] }[] = [];
    for (const role of [...platformRoles, 'INSTITUTION_ADMIN']) {
      for (const state of ['ACTIVE', 'SUSPENDED']) {
        for (const grants of [[], ['SECURITY_ACCESS_REVIEW']]) {
          if (grants.length && role === 'INSTITUTION_ADMIN') continue;
          if (grants.length && ['PLATFORM_SUPER_ADMIN', 'SECURITY_ADMIN'].includes(role) && state === 'SUSPENDED') continue;
          cases.push({ role, state, grants });
        }
      }
    }
    for (const testCase of cases) {
      const candidate = await member(testCase.role, 'ACTIVE');
      for (const capability of testCase.grants) {
        if (['PLATFORM_SUPER_ADMIN', 'SECURITY_ADMIN'].includes(testCase.role)) continue; // baseline already; a grant would be redundant
        await grant(candidate, capability);
      }
      if (testCase.state !== 'ACTIVE') await setMembershipState(candidate, testCase.state);
      const database = (await pool.query('SELECT access_review_is_reviewer($1) AS ok', [candidate.userId])).rows[0].ok;
      const code = isAccessReviewer({ memberships: [{ role: testCase.role, state: testCase.state, grants: testCase.grants }] });
      expect(database, JSON.stringify(testCase)).toBe(code);
    }
  });
});
