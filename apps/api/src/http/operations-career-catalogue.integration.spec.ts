/**
 * Job-role catalogue administration over HTTP (OPS-08).
 *
 * All 108 roles load and are searchable by code, name, branch and synonym; every write
 * needs its capability and a reason code and leaves an audit row; a requirement set goes
 * draft → review by someone other than its author → publish, and the publish needs
 * CONTENT_PUBLISH plus a second person's approval bound to the exact set, label and
 * reason. Students keep their starter targets and see the full catalogue only behind the
 * flag. Plus the §6.6 minimums: 401, 403, 200, input 400s, pagination bounds.
 *
 * Real Postgres in a throwaway schema; the catalogue is seeded from the real input file.
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
import { seedCareerCatalogue } from '@planthepath/persistence/src/career-catalogue.js';
import { setStudentCareerTarget } from '@planthepath/persistence/src/career-targets.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { CareerTargetsController } from './career-targets.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for career catalogue tests');

const schemaName = 'ops_catalogue_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'a'.repeat(64);
let app: INestApplication;
let platformId: string;
let institutionId: string;

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, grants: readonly string[] = []): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$2,$5)`,
    [membershipId, org, userId, role, isPlatform ? null : org],
  );
  for (const capability of grants) {
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
      [randomUUID(), membershipId, capability, superAdmin?.userId ?? userId],
    );
  }
  return { userId, membershipId };
}

async function learner(): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  return userId;
}

async function topic(authorId: string, key: string): Promise<string> {
  const id = randomUUID();
  const revision = randomUUID();
  await pool.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, id, authorId, SHA],
  );
  await pool.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for OPS-08 tests',$4)`, [id, key, `Synthetic ${key}`, revision],
  );
  return id;
}

let superAdmin: Member | undefined;
let secondApprover: Member;
let author: Member;
let authorWhoReviews: Member;
let reviewer: Member;
let publisher: Member;
let plainOperations: Member;
let securityAdmin: Member;
let institutionAdmin: Member;
let student: string;
let studentTargetId: string;
let socId: string;
let dataAnalystId: string;
let s02Id: string;
let topicA: string;
let topicB: string;

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
    controllers: [CareerTargetsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Catalogue college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  // Two approvers, so the solo safeguard is off and self-approval is refused outright.
  secondApprover = await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  author = await member('OPERATIONS_ADMIN', ['CATALOGUE_MANAGE']);
  authorWhoReviews = await member('OPERATIONS_ADMIN', ['CATALOGUE_MANAGE', 'CONTENT_REVIEW']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  plainOperations = await member('OPERATIONS_ADMIN');
  securityAdmin = await member('SECURITY_ADMIN');
  institutionAdmin = await member('INSTITUTION_ADMIN', []);

  topicA = await topic(superAdmin.userId, 'ops08-incident-handover');
  topicB = await topic(superAdmin.userId, 'ops08-log-triage');
  for (const [code, title, family] of [
    ['SOC_ANALYST', 'Security Operations Analyst', 'Cyber Security'], ['SOFTWARE_ENGINEER', 'Software Engineer', 'Engineering'],
    ['DATA_ANALYST', 'Data Analyst', 'Data'], ['BUSINESS_ANALYST', 'Business Analyst', 'Business'], ['CUSTOMER_SUCCESS', 'Customer Success Associate', 'Business'],
  ] as const) {
    await pool.query('INSERT INTO career_roles (id, code, title, family, active) VALUES ($1,$2,$3,$4,true)', [randomUUID(), code, title, family]);
  }
  socId = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE code='SOC_ANALYST'")).rows[0]!.id;
  dataAnalystId = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE code='DATA_ANALYST'")).rows[0]!.id;
  await pool.query("INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.75)", [randomUUID(), socId, topicA]);
  student = await learner();
  studentTargetId = (await setStudentCareerTarget(pool, { subjectUserId: student, careerRoleId: socId, priority: 'PRIMARY' })).targetId;

  await seedCareerCatalogue(pool, buildCareerCatalogueFile(await readFile(new URL('../../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url), 'utf8')));
  s02Id = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE catalogue_code='S02'")).rows[0]!.id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-cat-' + randomUUID() });
const base = '/api/v1/operations/career-catalogue';

async function roles(actor: Member, query: Record<string, string> = {}) {
  return api().get(base + '/roles').query(query).set(auth(actor.userId));
}
async function codes(actor: Member, query: Record<string, string>): Promise<string[]> {
  const response = await roles(actor, { limit: '200', ...query });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.roles as { catalogueCode: string }[]).map((role) => role.catalogueCode);
}
function transition(actor: Member, setId: string, toState: string, reasonCode: string, note?: string) {
  return api().post(`${base}/requirement-sets/${setId}/transition`).set(auth(actor.userId)).send({ toState, reasonCode, ...(note ? { note } : {}) });
}
function publish(actor: Member, setId: string, body: Record<string, unknown>) {
  return api().post(`${base}/requirement-sets/${setId}/publish`).set(auth(actor.userId)).send(body);
}
function requestApproval(actor: Member, payload: Record<string, unknown>) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey: 'CAREER_REQUIREMENT_SET_PUBLISH', payload });
}
function decide(actor: Member, approvalId: string) {
  return api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(actor.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
}
async function auditCount(action: string, resourceId: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows[0].n;
}
/** A reviewed set on a role, ready for a publish request. */
async function reviewedSet(roleId: string, reasonCode = 'NEW_REQUIREMENT_SET'): Promise<string> {
  const created = await api().post(`${base}/roles/${roleId}/requirement-sets`).set(auth(author.userId)).send({ reasonCode });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const setId = created.body.setId as string;
  const saved = await api().post(`${base}/requirement-sets/${setId}/items`).set(auth(author.userId)).send({
    reasonCode: 'DRAFT_EDIT', items: [{ topicId: topicB, requirementLevel: 'IMPORTANT', targetMastery: 0.6, requiredEvidenceTypes: ['ASSESSMENT_OUTCOME'] }],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  expect((await transition(author, setId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
  expect((await transition(reviewer, setId, 'REVIEWED', 'REVIEW_PASSED')).status).toBe(201);
  return setId;
}
/** Backdate an approval past its window; the 0038 trigger forbids it, so the owner bypasses it. */
async function backdate(approvalId: string, interval: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE operation_approvals DISABLE TRIGGER operation_approval_guard');
    await client.query('UPDATE operation_approvals SET requested_at = requested_at - $2::interval, expires_at = expires_at - $2::interval WHERE id=$1', [approvalId, interval]);
    await client.query('ALTER TABLE operation_approvals ENABLE TRIGGER operation_approval_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('access', () => {
  it('401 without a token', async () => {
    expect((await api().get(base + '/roles')).status).toBe(401);
    expect((await api().get(base + '/policy')).status).toBe(401);
  });

  it('403 without a catalogue capability, for platform roles and an institution admin alike', async () => {
    for (const actor of [plainOperations, securityAdmin, institutionAdmin]) {
      const response = await roles(actor);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect((await api().get(base + '/policy').set(auth(actor.userId))).status).toBe(403);
    }
  });

  it('each write needs its own capability', async () => {
    expect((await api().post(`${base}/roles/${socId}/synonyms`).set(auth(reviewer.userId)).send({ synonym: 'Blue team', reasonCode: 'INDUSTRY_TITLE' })).status).toBe(403);
    expect((await api().post(`${base}/roles/${socId}/requirement-sets`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_REQUIREMENT_SET' })).status).toBe(403);
    expect((await publish(author, randomUUID(), { releaseLabel: 'SELECTABLE', reasonCode: 'NEW_REQUIREMENT_SET', approvalId: randomUUID() })).status).toBe(403);
  });

  it('200 with a catalogue capability, and the policy says what the viewer may do', async () => {
    const policy = await api().get(base + '/policy').set(auth(reviewer.userId));
    expect(policy.status).toBe(200);
    expect(policy.body.viewer).toMatchObject({ manage: false, review: true, publish: false });
    expect(policy.body.studentFlag).toEqual({ key: 'career-catalogue.selectable-roles', enabled: false });
    expect(policy.body.branches).toContain('Civil');
    expect(policy.body.branches).not.toContain('All branches');
  });
});

describe('the catalogue', () => {
  it('loads all 108 roles with nothing verified, paged 50 by default and at most 200', async () => {
    const first = await roles(author);
    expect(first.status).toBe(200);
    expect(first.body.roles).toHaveLength(50);
    expect(first.body.summary).toMatchObject({ totalRoles: 108, catalogueRoles: 108, starterRoles: 5, selectable: 108, verified: 0, plannedV1: 1, plannedV2: 13, plannedV3: 38 });
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await roles(author, { limit: '40', ...(cursor ? { cursor } : {}) });
      expect(page.status).toBe(200);
      for (const role of page.body.roles as { id: string }[]) {
        expect(seen.has(role.id)).toBe(false);
        seen.add(role.id);
      }
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(108);
    expect((await roles(author, { limit: '201' })).status).toBe(400);
    expect((await roles(author, { limit: '0' })).status).toBe(400);
    expect((await roles(author, { cursor: 'not-a-cursor' })).status).toBe(400);
    expect((await roles(author, { sort: 'title' })).status).toBe(400);
    expect((await roles(author, { family: 'Z' })).status).toBe(400);
    expect((await roles(author, { releaseLabel: 'V2' })).status).toBe(400);
  });

  it('is searchable by code, name, branch and synonym, and filterable by family, branch and label', async () => {
    expect(await codes(author, { q: 'C01' })).toEqual(['C01']);
    expect(await codes(author, { q: 'soc analyst' })).toEqual(['C01']);
    expect(await codes(author, { q: 'SOC_ANALYST' })).toEqual(['C01']);
    expect(await codes(author, { q: 'maths-strong' })).toEqual(['D05']);
    expect(await codes(author, { q: 'Geo-informatics' })).toEqual(['V10']);
    const familyB = await codes(author, { family: 'B', releaseLabel: 'SELECTABLE' });
    expect(familyB).toHaveLength(18);
    expect(familyB.slice(0, 2)).toEqual(['C01', 'C02']);
    const civil = await codes(author, { branch: 'Civil' });
    for (const code of ['V01', 'V11', 'P06', 'S01', 'B14', 'S19']) expect(civil).toContain(code);
    expect(civil).not.toContain('S02');
    expect(await codes(author, { releaseLabel: 'VERIFIED' })).toEqual([]);

    const added = await api().post(`${base}/roles/${socId}/synonyms`).set(auth(author.userId)).send({ synonym: '  Cyber   Defender ', reasonCode: 'STUDENT_WORDING' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.role.synonyms.map((entry: { synonym: string }) => entry.synonym)).toEqual(['Cyber Defender']);
    expect(await codes(author, { q: 'cyber defender' })).toEqual(['C01']);
  });

  it('shows a role with its planning data, live requirements and a suppressed target count, never a student', async () => {
    const response = await api().get(`${base}/roles/${socId}`).set(auth(reviewer.userId));
    expect(response.status).toBe(200);
    expect(response.body.role).toMatchObject({
      code: 'SOC_ANALYST', title: 'Security Operations Analyst', catalogueCode: 'C01', catalogueTitle: 'SOC Analyst L1',
      catalogueFamily: 'B', plannedRelease: 'V1', releaseLabel: 'SELECTABLE', origin: 'STARTER', liveTargetCount: null, liveTargetCountSuppressed: true,
      eligibleBranches: ['CSE', 'IT', 'ECE'], requirementSets: [],
    });
    expect(response.body.role.liveRequirements).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain(student);
    expect((await api().get(`${base}/roles/${randomUUID()}`).set(auth(reviewer.userId))).status).toBe(404);
    expect((await api().get(`${base}/roles/not-a-uuid`).set(auth(reviewer.userId))).status).toBe(400);
  });
});

describe('synonyms', () => {
  it('needs a listed reason, refuses formula text and duplicates, and audits add and remove', async () => {
    const path = `${base}/roles/${dataAnalystId}/synonyms`;
    expect((await api().post(path).set(auth(author.userId)).send({ synonym: 'Numbers person', reasonCode: 'BECAUSE' })).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await api().post(path).set(auth(author.userId)).send({ synonym: '=HYPERLINK()', reasonCode: 'CORRECTION' })).body.error.code).toBe('CAREER_SYNONYM_INVALID');
    expect((await api().post(path).set(auth(author.userId)).send({ synonym: 'Numbers person', reasonCode: 'STUDENT_WORDING', extra: 1 })).status).toBe(400);
    const added = await api().post(path).set(auth(author.userId)).send({ synonym: 'Numbers person', reasonCode: 'STUDENT_WORDING' });
    expect(added.status).toBe(201);
    const duplicate = await api().post(path).set(auth(author.userId)).send({ synonym: 'NUMBERS  person', reasonCode: 'STUDENT_WORDING' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CAREER_SYNONYM_EXISTS');
    const audit = (await pool.query("SELECT actor_user_id, context, correlation_id FROM audit_events WHERE action='operations.career_catalogue.synonym_added' AND resource_id=$1", [dataAnalystId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: author.userId, context: { reasonCode: 'STUDENT_WORDING', synonym: 'Numbers person' } });
    expect(audit[0].context.break_glass).toBeUndefined();

    const synonymId = added.body.role.synonyms[0].id as string;
    const removed = await api().post(`${path}/${synonymId}/remove`).set(auth(author.userId)).send({ reasonCode: 'MISLEADING' });
    expect(removed.status).toBe(201);
    expect(removed.body.role.synonyms).toEqual([]);
    expect(await auditCount('operations.career_catalogue.synonym_removed', dataAnalystId)).toBe(1);
    expect((await api().post(`${path}/${synonymId}/remove`).set(auth(author.userId)).send({ reasonCode: 'MISLEADING' })).status).toBe(404);
  });

  it('audits the super admin as break-glass', async () => {
    const response = await api().post(`${base}/roles/${s02Id}/synonyms`).set(auth(superAdmin!.userId)).send({ synonym: 'Backend engineer', reasonCode: 'INDUSTRY_TITLE' });
    expect(response.status).toBe(201);
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='operations.career_catalogue.synonym_added' AND resource_id=$1", [s02Id])).rows[0];
    expect(audit.context.break_glass).toBe(true);
  });
});

describe('requirement sets', () => {
  it('cannot go live without review by someone else and an approval, and goes live exactly as approved', async () => {
    const created = await api().post(`${base}/roles/${socId}/requirement-sets`).set(auth(author.userId)).send({ reasonCode: 'REVISION' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const setId = created.body.setId as string;
    const draft = (created.body.role.requirementSets as { id: string; basedOn: string; state: string; items: unknown[] }[]).find((set) => set.id === setId)!;
    expect(draft).toMatchObject({ basedOn: 'LIVE', state: 'DRAFT' });
    expect(draft.items).toHaveLength(1);
    expect((await api().post(`${base}/roles/${socId}/requirement-sets`).set(auth(author.userId)).send({ reasonCode: 'REVISION' })).status).toBe(409);

    const items = `${base}/requirement-sets/${setId}/items`;
    const bad = async (item: Record<string, unknown>) => (await api().post(items).set(auth(author.userId)).send({ reasonCode: 'DRAFT_EDIT', items: [item] })).body.error.code;
    expect(await bad({ topicId: topicA, requirementLevel: 'ESSENTIAL', targetMastery: 1.5 })).toBe('CAREER_ITEM_TARGET_INVALID');
    expect(await bad({ topicId: topicA, requirementLevel: 'CRUCIAL', targetMastery: 0.5 })).toBe('CAREER_ITEM_LEVEL_INVALID');
    expect(await bad({ topicId: topicA, requirementLevel: 'ESSENTIAL', targetMastery: 0.5, requiredEvidenceTypes: ['VIBES'] })).toBe('CAREER_ITEM_EVIDENCE_INVALID');
    expect(await bad({ topicId: randomUUID(), requirementLevel: 'ESSENTIAL', targetMastery: 0.5 })).toBe('CAREER_TOPIC_NOT_FOUND');
    const saved = await api().post(items).set(auth(author.userId)).send({
      reasonCode: 'DRAFT_EDIT',
      items: [
        { topicId: topicA, requirementLevel: 'ESSENTIAL', targetMastery: 0.8, rationale: 'Handover notes are acted on under pressure.' },
        { topicId: topicB, requirementLevel: 'IMPORTANT', targetMastery: 0.6, requiredEvidenceTypes: ['ASSESSMENT_OUTCOME'] },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);

    expect((await transition(author, setId, 'REVIEWED', 'REVIEW_PASSED')).status).toBe(400);
    expect((await transition(author, setId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    // Frozen once submitted.
    expect((await api().post(items).set(auth(author.userId)).send({ reasonCode: 'DRAFT_EDIT', items: [] })).status).toBe(409);
    // The author holds no CONTENT_REVIEW; a reviewer passes it.
    expect((await transition(author, setId, 'REVIEWED', 'REVIEW_PASSED')).status).toBe(403);
    expect((await transition(reviewer, setId, 'REVIEWED', 'REVIEW_PASSED', 'Checked against the draft skill areas.')).status).toBe(201);

    // Without an approval: 403 APPROVAL_REQUIRED, and nothing changes.
    const unapproved = await publish(publisher, setId, { releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION' });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error.code).toBe('APPROVAL_REQUIRED');
    expect((await pool.query('SELECT count(*)::int AS n FROM career_role_requirements WHERE career_role_id=$1', [socId])).rows[0].n).toBe(1);

    // Only CONTENT_PUBLISH can ask; the requester cannot approve their own request.
    expect((await requestApproval(author, { setId, releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION' })).status).toBe(403);
    const filed = await requestApproval(publisher, { setId, releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const approvalId = filed.body.approval.id as string;
    expect(filed.body.approval.summary).toMatchObject({ careerRoleTitle: 'Security Operations Analyst', careerRoleCatalogueCode: 'C01', careerSetVersion: 1, releaseLabel: 'SELECTABLE' });
    const stored = (await pool.query('SELECT action_key, extended_action_key, target_type, extended_target_type FROM operation_approvals WHERE id=$1', [approvalId])).rows[0];
    expect(stored).toEqual({ action_key: null, extended_action_key: 'CAREER_REQUIREMENT_SET_PUBLISH', target_type: null, extended_target_type: 'career_requirement_set' });
    expect((await decide(publisher, approvalId)).status).toBe(403);
    expect((await decide(secondApprover, approvalId)).status).toBe(201);

    // A different label than the one approved is a different payload.
    const changed = await publish(publisher, setId, { releaseLabel: 'VERIFIED', reasonCode: 'REQUIREMENT_CORRECTION', approvalId });
    expect(changed.status).toBe(403);
    expect(changed.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    // Only the requester executes.
    const notRequester = await publish(superAdmin!, setId, { releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION', approvalId });
    expect(notRequester.status).toBe(403);
    expect(notRequester.body.error.code).toBe('APPROVAL_NOT_REQUESTER');
    expect((await pool.query('SELECT count(*)::int AS n FROM career_role_requirements WHERE career_role_id=$1', [socId])).rows[0].n).toBe(1);

    const published = await publish(publisher, setId, { releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION', approvalId });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.approval.mode).toBe('DUAL');
    const live = (await pool.query('SELECT topic_id, requirement_level, target_mastery::text, required_evidence_types FROM career_role_requirements WHERE career_role_id=$1 ORDER BY requirement_level', [socId])).rows;
    expect(live).toEqual([
      { topic_id: topicA, requirement_level: 'ESSENTIAL', target_mastery: '0.800', required_evidence_types: [] },
      { topic_id: topicB, requirement_level: 'IMPORTANT', target_mastery: '0.600', required_evidence_types: ['ASSESSMENT_OUTCOME'] },
    ]);
    const set = published.body.role.requirementSets.find((entry: { id: string }) => entry.id === setId);
    expect(set).toMatchObject({ state: 'PUBLISHED', releaseLabelAtPublish: 'SELECTABLE', reviewReasonCode: 'REVIEW_PASSED' });
    expect(set.reviewer.userId).toBe(reviewer.userId);
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='operations.career_catalogue.requirement_set_published' AND resource_id=$1", [setId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].context).toMatchObject({ approvalId, requestedByUserId: publisher.userId, approvedByUserId: secondApprover.userId, mode: 'DUAL', reasonCode: 'REQUIREMENT_CORRECTION' });
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='career_requirement_set.published' AND aggregate_id=$1", [setId])).rows[0].n).toBe(1);

    // Single use.
    expect((await publish(publisher, setId, { releaseLabel: 'SELECTABLE', reasonCode: 'REQUIREMENT_CORRECTION', approvalId })).status).toBe(409);

    // The student's target is the same row and still reads.
    const state = await api().get('/api/v1/students/me/career-targets').set(auth(student));
    expect(state.status).toBe(200);
    expect(state.body.targets.map((target: { id: string }) => target.id)).toEqual([studentTargetId]);
  });

  it('refuses a self-review over HTTP, and a publish request for a set nobody reviewed', async () => {
    const created = await api().post(`${base}/roles/${dataAnalystId}/requirement-sets`).set(auth(authorWhoReviews.userId)).send({ reasonCode: 'NEW_REQUIREMENT_SET' });
    expect(created.status).toBe(201);
    const setId = created.body.setId as string;
    expect(created.body.role.requirementSets[0].basedOn).toBe('EMPTY');
    // An empty set cannot be submitted: publishing it would wipe the role's requirements.
    expect((await transition(authorWhoReviews, setId, 'IN_REVIEW', 'READY_FOR_REVIEW')).body.error.code).toBe('CAREER_SET_EMPTY');
    await api().post(`${base}/requirement-sets/${setId}/items`).set(auth(authorWhoReviews.userId))
      .send({ reasonCode: 'DRAFT_EDIT', items: [{ topicId: topicA, requirementLevel: 'HELPFUL', targetMastery: 0.5 }] });
    expect((await transition(authorWhoReviews, setId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    const self = await transition(authorWhoReviews, setId, 'REVIEWED', 'REVIEW_PASSED');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CAREER_SET_SELF_REVIEW_REFUSED');
    const early = await requestApproval(publisher, { setId, releaseLabel: 'SELECTABLE', reasonCode: 'NEW_REQUIREMENT_SET' });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('APPROVAL_TARGET_STATE_INVALID');
    // The reviewer sends it back with a note the author can read; then the author withdraws it.
    expect((await transition(reviewer, setId, 'DRAFT', 'CHANGES_REQUESTED', 'Add the SQL requirement.')).status).toBe(201);
    const detail = await api().get(`${base}/roles/${dataAnalystId}`).set(auth(authorWhoReviews.userId));
    expect(detail.body.role.requirementSets[0]).toMatchObject({ state: 'DRAFT', reviewReasonCode: 'CHANGES_REQUESTED', reviewNote: 'Add the SQL requirement.', reviewer: null });
    expect((await transition(authorWhoReviews, setId, 'WITHDRAWN', 'ABANDONED')).status).toBe(201);
    expect(await auditCount('operations.career_catalogue.requirement_set_transitioned', setId)).toBe(3);
  });

  it('refuses an expired approval, and verifies a role only through an approved publish', async () => {
    const setId = await reviewedSet(s02Id);
    const filed = await requestApproval(publisher, { setId, releaseLabel: 'VERIFIED', reasonCode: 'ROLE_VERIFIED' });
    expect(filed.status).toBe(201);
    expect((await decide(secondApprover, filed.body.approval.id)).status).toBe(201);
    await backdate(filed.body.approval.id, '25 hours');
    const expired = await publish(publisher, setId, { releaseLabel: 'VERIFIED', reasonCode: 'ROLE_VERIFIED', approvalId: filed.body.approval.id });
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('APPROVAL_EXPIRED');
    expect((await pool.query('SELECT release_label FROM career_roles WHERE id=$1', [s02Id])).rows[0].release_label).toBe('SELECTABLE');

    const again = await requestApproval(publisher, { setId, releaseLabel: 'VERIFIED', reasonCode: 'ROLE_VERIFIED' });
    expect((await decide(secondApprover, again.body.approval.id)).status).toBe(201);
    const published = await publish(publisher, setId, { releaseLabel: 'VERIFIED', reasonCode: 'ROLE_VERIFIED', approvalId: again.body.approval.id });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.role.releaseLabel).toBe('VERIFIED');
    expect((await roles(author)).body.summary.verified).toBe(1);

    // The next version starts from the published set, and publishing it supersedes this one.
    const next = await reviewedSet(s02Id, 'REVISION');
    const nextApproval = await requestApproval(publisher, { setId: next, releaseLabel: 'VERIFIED', reasonCode: 'REQUIREMENT_CORRECTION' });
    await decide(secondApprover, nextApproval.body.approval.id);
    const republished = await publish(publisher, next, { releaseLabel: 'VERIFIED', reasonCode: 'REQUIREMENT_CORRECTION', approvalId: nextApproval.body.approval.id });
    expect(republished.status).toBe(201);
    const states = (republished.body.role.requirementSets as { version: number; state: string; basedOn: string }[]).map((set) => [set.version, set.state, set.basedOn]);
    expect(states).toEqual([[2, 'PUBLISHED', 'SET'], [1, 'SUPERSEDED', 'EMPTY']]);
  });
});

describe('students', () => {
  it('see only the starter roles, with no catalogue fields, until the flag is on', async () => {
    const closed = await api().get('/api/v1/career-targets/catalog').set(auth(student));
    expect(closed.status).toBe(200);
    expect(closed.body.careerRoles).toHaveLength(5);
    expect(closed.body.careerRoles.every((role: { releaseLabel: unknown; catalogueCode: unknown }) => role.releaseLabel === null && role.catalogueCode === null)).toBe(true);
    const refused = await api().post('/api/v1/students/me/career-targets').set(auth(student)).send({ careerRoleId: s02Id, priority: 'SECONDARY' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('CAREER_ROLE_NOT_FOUND');

    await pool.query("UPDATE feature_flags SET enabled=true WHERE key='career-catalogue.selectable-roles'");
    try {
      const open = await api().get('/api/v1/career-targets/catalog').set(auth(student));
      expect(open.body.careerRoles).toHaveLength(108);
      const labels = new Map((open.body.careerRoles as { catalogueCode: string; releaseLabel: string }[]).map((role) => [role.catalogueCode, role.releaseLabel]));
      expect(labels.get('S02')).toBe('VERIFIED');
      expect(labels.get('C01')).toBe('SELECTABLE');
      const chosen = await api().post('/api/v1/students/me/career-targets').set(auth(student)).send({ careerRoleId: s02Id, priority: 'SECONDARY' });
      expect(chosen.status, JSON.stringify(chosen.body)).toBe(201);
      expect(chosen.body.targets.map((target: { id: string }) => target.id)).toContain(studentTargetId);
    } finally {
      await pool.query("UPDATE feature_flags SET enabled=false WHERE key='career-catalogue.selectable-roles'");
    }
  });
});
