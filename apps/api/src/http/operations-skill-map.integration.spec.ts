/**
 * The skill map editor over HTTP (OPS-09a).
 *
 * A skill goes draft → review → publish; the author and anyone who edited it are refused as
 * reviewer and publisher; approving records a real rights review (a release-eligible source
 * record); publishing goes through a release manifest and, when it changes readiness inputs,
 * needs a second person's approval bound to the exact revision, hash and reason; prerequisite
 * cycles are refused; skills publish in prerequisite order; and an ENG-11 pending topic is
 * published through this path under 0056's triggers. Plus the §6.6 minimums: 401, 403, 200,
 * input 400s, pagination bounds, audit rows with reason codes. Real Postgres in a throwaway schema.
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
import { importCareerTargetDraftPack, type CareerTargetDraftPack } from '@planthepath/persistence/src/career-target-drafts.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for skill map tests');

const schemaName = 'ops_skill_map_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'b'.repeat(64);
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

/** A live topic the way the pilot fixtures write one (active, content revision not through the editor). */
async function liveTopic(authorId: string, key: string): Promise<string> {
  const id = randomUUID();
  const revision = randomUUID();
  await pool.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, id, authorId, SHA],
  );
  await pool.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for OPS-09a tests',$4)`, [id, key, `Synthetic ${key}`, revision],
  );
  return id;
}

let superAdmin: Member | undefined;
let approver: Member;
let editor: Member;
let secondEditor: Member;
let editorWhoReviews: Member;
let editorWhoPublishes: Member;
let reviewer: Member;
let publisher: Member;
let catalogueManager: Member;
let plainOperations: Member;
let institutionAdmin: Member;
let importer: Member;

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
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Skill map college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  // Two approvers, so the solo safeguard is off and self-approval is refused outright.
  approver = await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  editor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  secondEditor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  editorWhoReviews = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
  editorWhoPublishes = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_PUBLISH']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  catalogueManager = await member('OPERATIONS_ADMIN', ['CATALOGUE_MANAGE']);
  plainOperations = await member('OPERATIONS_ADMIN');
  institutionAdmin = await member('INSTITUTION_ADMIN');
  importer = await member('OPERATIONS_ADMIN');

  // What ENG-11's pack needs: the catalogue (C01) and the two starter topics, live.
  await liveTopic(superAdmin.userId, 'professional-communication');
  await liveTopic(superAdmin.userId, 'interview-foundations');
  await pool.query("INSERT INTO career_roles (id, code, title, family, active) VALUES ($1,'SOC_ANALYST','Security Operations Analyst','Cyber Security',true)", [randomUUID()]);
  await seedCareerCatalogue(pool, buildCareerCatalogueFile(await readFile(new URL('../../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url), 'utf8')));
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-skill-' + randomUUID() });
const base = '/api/v1/operations/skill-map';

const levels = {
  AWARE: 'Knows what the skill is and why it matters',
  GUIDED: 'Does it with a runbook and a senior nearby',
  INDEPENDENT: 'Does it unaided on ordinary cases',
  TROUBLESHOOT: 'Works out why it went wrong and fixes it',
};

interface SkillDto {
  topicId: string; stableKey: string; status: string; publishedRevision: number | null;
  openRevision: { id: string; revision: number; state: string } | null;
  current: { id: string; state: string; revision: number; fields: { levels: Record<string, string>; prerequisites: string[] }; expertCheck: string | null; contributors: { userId: string }[] };
  open: { id: string; state: string; revision: number } | null;
  publishNeedsApproval: boolean;
}

function create(actor: Member, stableKey: string, name = `Synthetic ${stableKey}`) {
  return api().post(`${base}/skills`).set(auth(actor.userId)).send({ stableKey, name, description: `Synthetic skill ${stableKey} for tests`, reasonCode: 'NEW_SKILL' });
}
function save(actor: Member, revisionId: string, over: Record<string, unknown> = {}) {
  return api().post(`${base}/revisions/${revisionId}/draft`).set(auth(actor.userId)).send({
    name: 'Synthetic skill', description: 'Synthetic description for tests', levels, prerequisites: [], licenceLabel: 'AI8HT-Owned', reasonCode: 'DRAFT_EDIT', ...over,
  });
}
function transition(actor: Member, revisionId: string, toState: string, reasonCode: string, rightsReasonCode?: string) {
  return api().post(`${base}/revisions/${revisionId}/transition`).set(auth(actor.userId)).send({ toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}) });
}
function publish(actor: Member, revisionId: string, body: Record<string, unknown>) {
  return api().post(`${base}/revisions/${revisionId}/publish`).set(auth(actor.userId)).send(body);
}
function requestApproval(actor: Member, payload: Record<string, unknown>) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey: 'CONTENT_SKILL_PUBLISH', payload });
}
function decide(actor: Member, approvalId: string) {
  return api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(actor.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
}
async function detail(topicId: string): Promise<SkillDto> {
  const response = await api().get(`${base}/skills/${topicId}`).set(auth(reviewer.userId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.skill as SkillDto;
}
async function auditCount(action: string, resourceId: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows[0].n;
}

/** Create, fill, submit and approve a skill; returns its topic and open revision. */
async function approvedSkill(stableKey: string, prerequisites: readonly string[] = []): Promise<{ topicId: string; revisionId: string }> {
  const created = await create(editor, stableKey);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const topicId = created.body.skill.topicId as string;
  const revisionId = created.body.skill.current.id as string;
  expect((await save(editor, revisionId, { prerequisites })).status).toBe(201);
  expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
  const approved = await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
  expect(approved.status, JSON.stringify(approved.body)).toBe(201);
  return { topicId, revisionId };
}

/** File, approve and execute a publish that needs an approval. */
async function publishWithApproval(revisionId: string, reasonCode = 'NEW_SKILL', actor = publisher) {
  const filed = await requestApproval(actor, { revisionId, reasonCode });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  expect((await decide(approver, filed.body.approval.id)).status).toBe(201);
  return publish(actor, revisionId, { reasonCode, approvalId: filed.body.approval.id });
}

describe('access (§6.6 minimums)', () => {
  it('401 without a token', async () => {
    await api().get(`${base}/skills`).expect(401);
    await api().get(`${base}/policy`).expect(401);
  });

  it('403 without a content or catalogue capability, and for an institution member', async () => {
    expect((await api().get(`${base}/skills`).set(auth(plainOperations.userId))).status).toBe(403);
    expect((await api().get(`${base}/skills`).set(auth(institutionAdmin.userId))).status).toBe(403);
    expect((await create(plainOperations, 'ops09a-forbidden')).status).toBe(403);
  });

  it('200 for readers; a catalogue manager reads but cannot write', async () => {
    const response = await api().get(`${base}/skills`).set(auth(catalogueManager.userId));
    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({ live: expect.any(Number), pending: expect.any(Number) });
    expect((await create(catalogueManager, 'ops09a-catalogue-only')).status).toBe(403);
    const policy = await api().get(`${base}/policy`).set(auth(editor.userId));
    expect(policy.body.levels.map((entry: { level: string }) => entry.level)).toEqual(['AWARE', 'GUIDED', 'INDEPENDENT', 'TROUBLESHOOT']);
    expect(policy.body.viewer).toMatchObject({ edit: true, review: false, publish: false });
  });

  it('400 on invalid input: key, unknown fields, levels, limits, cursor and filter', async () => {
    expect((await create(editor, 'Bad Key')).body.error.code).toBe('SKILL_KEY_INVALID');
    const extra = await api().post(`${base}/skills`).set(auth(editor.userId)).send({ stableKey: 'ops09a-extra', name: 'N', description: 'D', reasonCode: 'NEW_SKILL', active: true });
    expect(extra.status).toBe(400);
    expect((await api().post(`${base}/skills`).set(auth(editor.userId)).send({ stableKey: 'ops09a-reason', name: 'N', description: 'D', reasonCode: 'BECAUSE' })).body.error.code).toBe('REASON_CODE_INVALID');
    for (const limit of ['0', '201', 'x']) expect((await api().get(`${base}/skills`).query({ limit }).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/skills`).query({ cursor: 'not-a-cursor' }).set(auth(editor.userId))).body.error.code).toBe('CURSOR_INVALID');
    expect((await api().get(`${base}/skills`).query({ filter: 'EVERYTHING' }).set(auth(editor.userId))).body.error.code).toBe('SKILL_FILTER_INVALID');
    const created = await create(editor, 'ops09a-input-checks');
    const revisionId = created.body.skill.current.id as string;
    expect((await save(editor, revisionId, { levels: { ...levels, EXPERT: 'no such level' } })).status).toBe(400);
    expect((await save(editor, revisionId, { licenceLabel: 'All-Rights-Reserved' })).body.error.code).toBe('SKILL_LICENCE_INVALID');
    expect((await api().get(`${base}/skills/not-a-uuid`).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/skills/${randomUUID()}`).set(auth(editor.userId))).status).toBe(404);
  });

  it('paginates on (stable key, id) within the bounds', async () => {
    const first = await api().get(`${base}/skills`).query({ limit: '1' }).set(auth(editor.userId));
    expect(first.status).toBe(200);
    expect(first.body.skills).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get(`${base}/skills`).query({ limit: '1', cursor: first.body.nextCursor }).set(auth(editor.userId));
    expect(second.body.skills[0].stableKey > first.body.skills[0].stableKey).toBe(true);
    const all = await api().get(`${base}/skills`).query({ limit: '200' }).set(auth(editor.userId));
    expect(all.body.skills.length).toBeLessThanOrEqual(200);
  });
});

describe('draft → review → publish', () => {
  it('creates a pending skill with an audit row, and refuses a duplicate key', async () => {
    const created = await create(editor, 'ops09a-log-review');
    expect(created.status).toBe(201);
    const skill = created.body.skill as SkillDto;
    expect(skill.status).toBe('PENDING');
    expect(skill.current.state).toBe('DRAFT');
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.skill_created' AND resource_id=$1", [skill.current.id])).rows[0];
    expect(auditRow.context).toMatchObject({ reasonCode: 'NEW_SKILL', stableKey: 'ops09a-log-review' });
    expect((await create(secondEditor, 'ops09a-log-review')).status).toBe(409);
    // The node is not live and nothing picks it up as a live topic.
    expect((await pool.query('SELECT active FROM taxonomy_nodes WHERE id=$1', [skill.topicId])).rows[0].active).toBe(false);
  });

  it('refuses to submit without all four levels and a licence, then submits a complete draft', async () => {
    const created = await create(editor, 'ops09a-ticketing');
    const revisionId = created.body.skill.current.id as string;
    expect((await save(editor, revisionId, { levels: { AWARE: 'Only aware' }, licenceLabel: null })).status).toBe(201);
    const refused = await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('SKILL_INVALID');
    expect(refused.body.error.problems).toEqual(expect.arrayContaining(['SKILL_LEVEL_MISSING:GUIDED', 'SKILL_LICENCE_MISSING']));
    expect((await save(editor, revisionId)).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    // Frozen while in review.
    expect((await save(editor, revisionId)).body.error.code).toBe('SKILL_REVISION_NOT_EDITABLE');
    expect(await auditCount('operations.content.skill_transitioned', revisionId)).toBe(1);
  });

  it('rejects self-review by the author, and by anyone who edited the draft', async () => {
    const own = await create(editorWhoReviews, 'ops09a-own-skill');
    const ownRevision = own.body.skill.current.id as string;
    await save(editorWhoReviews, ownRevision);
    await transition(editorWhoReviews, ownRevision, 'IN_REVIEW', 'READY_FOR_REVIEW');
    const self = await transition(editorWhoReviews, ownRevision, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SKILL_SELF_REVIEW_REFUSED');

    const theirs = await create(editor, 'ops09a-co-edited');
    const revisionId = theirs.body.skill.current.id as string;
    await save(editor, revisionId);
    expect((await save(editorWhoReviews, revisionId, { description: 'A contributor rewrote this' })).status).toBe(201);
    await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect((await transition(editorWhoReviews, revisionId, 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR')).body.error.code).toBe('SKILL_SELF_REVIEW_REFUSED');
    const detailed = await detail(theirs.body.skill.topicId);
    expect(detailed.current.contributors.map((entry) => entry.userId).sort()).toEqual([editor.userId, editorWhoReviews.userId].sort());
    // A third person may review it.
    expect((await transition(reviewer, revisionId, 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR')).status).toBe(201);
    expect((await save(editor, revisionId)).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'CHANGES_MADE')).status).toBe(201);
  });

  it('approving is the rights review: it needs a rights reason and writes a release-eligible source record', async () => {
    const created = await create(editor, 'ops09a-rights');
    const revisionId = created.body.skill.current.id as string;
    await save(editor, revisionId, { licenceLabel: 'CC-BY-4.0', attribution: 'Synthetic source, CC BY 4.0' });
    await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED')).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'LICENCE_VERIFIED')).status).toBe(201);
    const source = (await pool.query(
      "SELECT s.release_eligible, s.license_label, s.attribution_required, r.reviewer_user_id, r.reason_code FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id WHERE s.source_entity_type='SKILL_MAP_REVISION' AND s.source_record_id=$1",
      [revisionId],
    )).rows[0];
    expect(source).toMatchObject({ release_eligible: true, license_label: 'CC-BY-4.0', attribution_required: true, reviewer_user_id: reviewer.userId, reason_code: 'LICENCE_VERIFIED' });
    expect(await auditCount('operations.content.skill_rights_reviewed', revisionId)).toBe(1);
    const state = (await pool.query('SELECT state FROM content_revisions WHERE id=$1', [revisionId])).rows[0].state;
    expect(state).toBe('APPROVED');
  });

  it('a first publish needs CONTENT_PUBLISH, a non-author publisher and an approval for the exact payload', async () => {
    const { topicId, revisionId } = await approvedSkill('ops09a-first-publish');
    expect((await publish(editor, revisionId, { reasonCode: 'NEW_SKILL' })).status).toBe(403);
    expect((await publish(publisher, revisionId, { reasonCode: 'NEW_SKILL' })).body.error.code).toBe('APPROVAL_REQUIRED');
    expect((await detail(topicId)).publishNeedsApproval).toBe(true);

    // An approval for a different reason does not cover this publish.
    const filed = await requestApproval(publisher, { revisionId, reasonCode: 'TRACK_RELEASE' });
    expect(filed.status).toBe(201);
    expect((await decide(publisher, filed.body.approval.id)).status).toBe(403);
    expect((await decide(approver, filed.body.approval.id)).status).toBe(201);
    expect((await publish(publisher, revisionId, { reasonCode: 'NEW_SKILL', approvalId: filed.body.approval.id })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');

    const published = await publish(publisher, revisionId, { reasonCode: 'TRACK_RELEASE', approvalId: filed.body.approval.id });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.approval.mode).toBe('DUAL');
    const skill = published.body.skill as SkillDto;
    expect(skill.status).toBe('LIVE');
    expect(skill.publishedRevision).toBe(1);
    const manifest = (await pool.query(
      'SELECT m.status, m.approved_by_user_id, m.published_by_user_id FROM content_revisions c JOIN release_manifests m ON m.id = c.release_manifest_id WHERE c.id=$1', [revisionId],
    )).rows[0];
    expect(manifest).toMatchObject({ status: 'PUBLISHED', approved_by_user_id: reviewer.userId, published_by_user_id: publisher.userId });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.skill_published' AND resource_id=$1", [revisionId])).rows[0];
    expect(auditRow.context).toMatchObject({ reasonCode: 'TRACK_RELEASE', firstPublish: true, approvalRequired: true, mode: 'DUAL' });
    const events = (await pool.query("SELECT event_type FROM outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at", [revisionId])).rows.map((row) => row.event_type);
    expect(events).toContain('skill_map.skill_published');
    // The approval is consumed; it cannot publish twice.
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [filed.body.approval.id])).rows[0].state).toBe('EXECUTED');

    // The queue names the skill, never an identifier.
    const queue = await api().get('/api/v1/operations/approvals').query({ state: 'EXECUTED' }).set(auth(approver.userId));
    const row = queue.body.approvals.find((entry: { id: string }) => entry.id === filed.body.approval.id);
    expect(row.summary).toMatchObject({ skillKey: 'ops09a-first-publish', skillRevision: 1 });
  });

  it('the author never publishes their own skill, even holding CONTENT_PUBLISH', async () => {
    const created = await create(editorWhoPublishes, 'ops09a-author-publisher');
    const revisionId = created.body.skill.current.id as string;
    await save(editorWhoPublishes, revisionId);
    await transition(editorWhoPublishes, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect((await requestApproval(editorWhoPublishes, { revisionId, reasonCode: 'NEW_SKILL' })).body.error.code).toBe('SKILL_SELF_PUBLISH_REFUSED');
    expect((await publish(editorWhoPublishes, revisionId, { reasonCode: 'NEW_SKILL' })).body.error.code).toBe('SKILL_SELF_PUBLISH_REFUSED');
    // And the database refuses it from any other writer (0057).
    await expect(pool.query(
      "INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id) VALUES ($1,$2,$3,'PUBLISH','APPROVED','PUBLISHED','NEW_SKILL','direct-writer-1')",
      [randomUUID(), revisionId, editorWhoPublishes.userId],
    )).rejects.toThrow(/author cannot publish own skill revision/);
  });

  it('a revision of a live skill no role requires publishes with CONTENT_PUBLISH alone; the old revision stays published', async () => {
    const { topicId, revisionId } = await approvedSkill('ops09a-revisable');
    expect((await publishWithApproval(revisionId)).status).toBe(201);
    const started = await api().post(`${base}/skills/${topicId}/revisions`).set(auth(secondEditor.userId)).send({ reasonCode: 'LEVEL_DESCRIPTORS' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect((await api().post(`${base}/skills/${topicId}/revisions`).set(auth(secondEditor.userId)).send({ reasonCode: 'CORRECTION' })).body.error.code).toBe('SKILL_OPEN_REVISION_EXISTS');
    const next = (started.body.skill as SkillDto).open!;
    expect(next.revision).toBe(2);
    expect((await save(secondEditor, next.id, { levels: { ...levels, TROUBLESHOOT: 'A clearer troubleshoot descriptor' } })).status).toBe(201);
    await transition(secondEditor, next.id, 'IN_REVIEW', 'READY_FOR_REVIEW');
    await transition(reviewer, next.id, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect((await detail(topicId)).publishNeedsApproval).toBe(false);
    expect((await requestApproval(publisher, { revisionId: next.id, reasonCode: 'SKILL_REVISION' })).body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    const published = await publish(publisher, next.id, { reasonCode: 'SKILL_REVISION' });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const skill = published.body.skill as SkillDto;
    expect(skill.publishedRevision).toBe(2);
    expect(skill.current.fields.levels.TROUBLESHOOT).toBe('A clearer troubleshoot descriptor');
    const states = (await pool.query("SELECT revision, state FROM content_revisions WHERE entity_type='TOPIC' AND entity_id=$1 ORDER BY revision", [topicId])).rows;
    expect(states).toEqual([{ revision: 1, state: 'PUBLISHED' }, { revision: 2, state: 'PUBLISHED' }]);
  });

  it('a skill a live requirement names needs an approval to publish a revision', async () => {
    const { topicId, revisionId } = await approvedSkill('ops09a-required');
    expect((await publishWithApproval(revisionId)).status).toBe(201);
    const role = (await pool.query("SELECT id FROM career_roles WHERE catalogue_code='D01'")).rows[0].id;
    await pool.query("INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'IMPORTANT',0.6)", [randomUUID(), role, topicId]);
    const started = await api().post(`${base}/skills/${topicId}/revisions`).set(auth(editor.userId)).send({ reasonCode: 'CORRECTION' });
    const next = (started.body.skill as SkillDto).open!;
    await save(editor, next.id);
    await transition(editor, next.id, 'IN_REVIEW', 'READY_FOR_REVIEW');
    await transition(reviewer, next.id, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect((await publish(publisher, next.id, { reasonCode: 'CORRECTION' })).body.error.code).toBe('APPROVAL_REQUIRED');
    expect((await publishWithApproval(next.id, 'CORRECTION')).status).toBe(201);
  });
});

describe('prerequisites', () => {
  it('refuses a cycle and an unknown prerequisite, with the existing acyclic check', async () => {
    const a = await create(editor, 'ops09a-cycle-a');
    const b = await create(editor, 'ops09a-cycle-b');
    expect((await save(editor, a.body.skill.current.id, { prerequisites: ['ops09a-cycle-b'] })).status).toBe(201);
    const cycle = await save(editor, b.body.skill.current.id, { prerequisites: ['ops09a-cycle-a'] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.problems).toEqual(['SKILL_PREREQUISITE_CYCLE']);
    const unknown = await save(editor, b.body.skill.current.id, { prerequisites: ['ops09a-no-such-skill'] });
    expect(unknown.body.error.problems).toEqual(['SKILL_PREREQUISITE_UNKNOWN:ops09a-no-such-skill']);
    const self = await save(editor, b.body.skill.current.id, { prerequisites: ['ops09a-cycle-b'] });
    expect(self.status).toBe(400);
  });

  it('publishes in prerequisite order: a skill whose prerequisite is not live cannot publish, and the approval survives', async () => {
    const base1 = await approvedSkill('ops09a-order-base');
    const dependent = await approvedSkill('ops09a-order-dependent', ['ops09a-order-base']);
    const filed = await requestApproval(publisher, { revisionId: dependent.revisionId, reasonCode: 'NEW_SKILL' });
    await decide(approver, filed.body.approval.id);
    const early = await publish(publisher, dependent.revisionId, { reasonCode: 'NEW_SKILL', approvalId: filed.body.approval.id });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('SKILL_PREREQUISITE_NOT_LIVE');
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [filed.body.approval.id])).rows[0].state).toBe('APPROVED');
    expect((await publishWithApproval(base1.revisionId)).status).toBe(201);
    expect((await publish(publisher, dependent.revisionId, { reasonCode: 'NEW_SKILL', approvalId: filed.body.approval.id })).status).toBe(201);
    const skill = await detail(base1.topicId);
    expect(skill.status).toBe('LIVE');
  });
});

describe('ENG-11 pending topics publish through the editor', () => {
  it('fills levels on an agent-drafted skill, reviews it and publishes it live under 0056, keeping its provenance', async () => {
    const pack = JSON.parse(await readFile(new URL('../../../../data/engine/soc-analyst-l1-target-v1.draft.json', import.meta.url), 'utf8')) as CareerTargetDraftPack;
    await importCareerTargetDraftPack(db as never, pack, { userId: importer.userId, breakGlass: false, correlationId: 'eng11-import-ops09a' });
    const listed = await api().get(`${base}/skills`).query({ filter: 'PENDING', q: 'soc-', limit: '50' }).set(auth(editor.userId));
    expect(listed.body.skills.filter((entry: { source: string }) => entry.source === 'AGENT_DRAFTED')).toHaveLength(13);
    expect(listed.body.summary.agentDraftedPending).toBe(13);
    const topicId = (await pool.query("SELECT id FROM taxonomy_nodes WHERE stable_key='soc-networking-fundamentals'")).rows[0].id as string;
    const before = await detail(topicId);
    expect(before.status).toBe('PENDING');
    expect(before.current.expertCheck).toMatch(/protocol list/);
    const revisionId = before.current.id;

    // The agent drafted no levels, so a person writes them; the importer is the author.
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).body.error.problems).toEqual(expect.arrayContaining(['SKILL_LEVEL_MISSING:AWARE']));
    expect((await save(editor, revisionId, { name: 'Networking fundamentals for security monitoring', description: 'TCP/IP, DNS and common ports as they appear in logs.' })).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    expect((await transition(editor, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).status).toBe(403);
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).status).toBe(201);
    const published = await publishWithApproval(revisionId);
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    const node = (await pool.query('SELECT active, source, generator_version, content_revision_id FROM taxonomy_nodes WHERE id=$1', [topicId])).rows[0];
    expect(node).toMatchObject({ active: true, source: 'AGENT_DRAFTED', content_revision_id: revisionId });
    expect(node.generator_version).toEqual(expect.any(String));
    const body = (await pool.query('SELECT body FROM content_revisions WHERE id=$1', [revisionId])).rows[0].body;
    expect(body).toMatchObject({ provenance: { source: 'AGENT_DRAFTED' }, packKey: pack.packKey, levels });
    expect(body.expertCheck).toEqual(expect.any(String));

    // The C01 draft set now shows that skill live; the others are still pending.
    const set = (await pool.query(
      `SELECT count(*) FILTER (WHERE n.active)::int AS live, count(*) FILTER (WHERE NOT n.active)::int AS pending
       FROM career_requirement_set_items i JOIN taxonomy_nodes n ON n.id = i.topic_id JOIN career_requirement_sets s ON s.id = i.set_id
       WHERE s.source = 'AGENT_DRAFTED'`,
    )).rows[0];
    expect(set).toEqual({ live: 3, pending: 12 });

    // A dependent SOC skill cannot go first.
    const logSources = (await pool.query("SELECT id FROM taxonomy_nodes WHERE stable_key='soc-alert-triage'")).rows[0].id as string;
    expect((await detail(logSources)).status).toBe('PENDING');
  });
});

describe('database guards (0057)', () => {
  it('a live topic moves only to a published revision of itself, and goes live only on published content', async () => {
    const created = await create(editor, 'ops09a-guarded');
    const topicId = created.body.skill.topicId as string;
    await expect(pool.query('UPDATE taxonomy_nodes SET active = true WHERE id = $1', [topicId])).rejects.toThrow(/goes live only once its content revision is published/);
    const other = await create(editor, 'ops09a-guarded-other');
    await expect(pool.query('UPDATE taxonomy_nodes SET content_revision_id = $2 WHERE id = $1', [topicId, other.body.skill.current.id]))
      .rejects.toThrow(/moves only to a published revision of that topic/);
  });
});
