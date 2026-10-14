/**
 * The lesson and variant editor over HTTP (OPS-09c).
 *
 * A lesson goes draft → review → publish through the learner-content lifecycle: the author, anyone
 * who edited it and its submitter are refused as reviewer and publisher, and its approver is refused
 * as publisher; approving records a real rights review; lesson prerequisite cycles are rejected; a
 * first publish (or a change of skill or prerequisites) needs a second person's approval bound to
 * the exact revision, hash and reason, while a wording revision and a variant do not. A published
 * revision supersedes the old lesson version in the catalogue, and a learner who completed the old
 * version is shown the revised lesson as done and is not given a second piece of the same evidence.
 * A variant (another language, level or style) is reviewed and published on its own and writes no
 * lesson version. Plus the §6.6 minimums: 401, 403, 200, input 400s, 404, pagination bounds, audit
 * rows with reason codes. Real Postgres in a throwaway schema; synthetic data only.
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
import {
  completeLesson,
  getLearnerCareerReadinessState,
  getPublishedCareerReadinessCatalog,
  publishCareerReadinessPilot,
  type PilotFixture,
} from '@planthepath/persistence/src/career-readiness.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for lesson editor tests');

const schemaName = 'ops_lessons_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let institutionId: string;
let fixture: PilotFixture;
let moduleKey: string;
let topicKey: string;
let otherTopicKey: string;

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function user(): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  return userId;
}

async function member(role: string, grants: readonly string[] = []): Promise<Member> {
  const userId = await user();
  const membershipId = randomUUID();
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

let superAdmin: Member | undefined;
let approver: Member;
let editor: Member;
let secondEditor: Member;
let editorWhoReviews: Member;
let editorWhoPublishes: Member;
let reviewer: Member;
let reviewerWhoPublishes: Member;
let publisher: Member;
let catalogueManager: Member;
let plainOperations: Member;
let institutionAdmin: Member;
let studentId: string;

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
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Lesson editor college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  // Two approvers, so the solo safeguard is off and self-approval is refused outright.
  approver = await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  editor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  secondEditor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  editorWhoReviews = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
  editorWhoPublishes = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_PUBLISH']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  reviewerWhoPublishes = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW', 'CONTENT_PUBLISH']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  catalogueManager = await member('OPERATIONS_ADMIN', ['CATALOGUE_MANAGE']);
  plainOperations = await member('OPERATIONS_ADMIN');
  institutionAdmin = await member('INSTITUTION_ADMIN');
  studentId = await user();

  // The pilot: live topics, one published module and its three lessons (a prerequisite chain).
  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const actors = { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() };
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  moduleKey = fixture.module.stableKey;
  topicKey = fixture.topics[0]!.stableKey;
  otherTopicKey = fixture.topics[1]!.stableKey;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-lesson-' + randomUUID() });
const base = '/api/v1/operations/lessons';
const firstPilot = () => fixture.lessons[0]!;
const secondPilot = () => fixture.lessons[1]!;
const thirdPilot = () => fixture.lessons[2]!;

function complete(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Synthetic lesson title',
    summary: 'Synthetic summary a learner reads.',
    practice: 'Synthetic practice prompt.',
    moduleKey,
    topicKey,
    prerequisites: [],
    licenceLabel: 'AI8HT-Owned',
    basis: 'Synthetic basis for tests',
    reasonCode: 'DRAFT_EDIT',
    ...over,
  };
}
const variantDraft = (over: Record<string, unknown> = {}) => ({
  title: 'Synthetic variant title', summary: 'Synthetic rendering of the summary.', licenceLabel: 'AI8HT-Owned', basis: 'Synthetic basis', reasonCode: 'DRAFT_EDIT', ...over,
});

function create(actor: Member, stableKey: string, over: Record<string, unknown> = {}) {
  return api().post(`${base}/lessons`).set(auth(actor.userId)).send({ stableKey, title: `Synthetic ${stableKey}`, reasonCode: 'NEW_LESSON', ...over });
}
function createVariant(actor: Member, lessonId: string, over: Record<string, unknown> = {}) {
  return api().post(`${base}/lessons/${lessonId}/variants`).set(auth(actor.userId))
    .send({ language: 'te', level: 'STANDARD', style: 'EXPLANATION', title: 'Synthetic Telugu title', reasonCode: 'NEW_LANGUAGE', ...over });
}
function save(actor: Member, revisionId: string, body: Record<string, unknown>) {
  return api().post(`${base}/revisions/${revisionId}/draft`).set(auth(actor.userId)).send(body);
}
function transition(actor: Member, revisionId: string, toState: string, reasonCode: string, rightsReasonCode?: string, languageReviewCode?: string) {
  return api().post(`${base}/revisions/${revisionId}/transition`).set(auth(actor.userId))
    .send({ toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}), ...(languageReviewCode ? { languageReviewCode } : {}) });
}
function publish(actor: Member, revisionId: string, body: Record<string, unknown>) {
  return api().post(`${base}/revisions/${revisionId}/publish`).set(auth(actor.userId)).send(body);
}
function revise(actor: Member, lessonId: string, reasonCode = 'CONTENT_UPDATE') {
  return api().post(`${base}/lessons/${lessonId}/revisions`).set(auth(actor.userId)).send({ reasonCode });
}
function requestApproval(actor: Member, payload: Record<string, unknown>) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey: 'CONTENT_LESSON_PUBLISH', payload });
}
function decide(actor: Member, approvalId: string) {
  return api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(actor.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
}
async function auditCount(action: string, resourceId: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows[0].n;
}

/**
 * Submit and approve an open revision (the editor wrote it; the reviewer approves). A variant in a
 * language other than English also needs the reviewer's native-speaker review code (ENG-16).
 */
async function submitAndApprove(revisionId: string, submitter: Member = editor, languageReviewCode?: string): Promise<void> {
  const submitted = await transition(submitter, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  const approved = await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED', languageReviewCode);
  expect(approved.status, JSON.stringify(approved.body)).toBe(201);
}

/** Create, fill, submit and approve a base lesson. */
async function approvedLesson(stableKey: string, over: Record<string, unknown> = {}): Promise<{ lessonId: string; revisionId: string }> {
  const created = await create(editor, stableKey);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const lessonId = created.body.lesson.lessonId as string;
  const revisionId = created.body.lesson.open.id as string;
  const saved = await save(editor, revisionId, complete(over));
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  await submitAndApprove(revisionId);
  return { lessonId, revisionId };
}

/** File and approve a publish; returns the approval id. */
async function approvedPublish(revisionId: string, reasonCode = 'NEW_LESSON', actor = publisher): Promise<string> {
  const filed = await requestApproval(actor, { revisionId, reasonCode });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  expect((await decide(approver, filed.body.approval.id)).status).toBe(201);
  return filed.body.approval.id as string;
}

async function catalogLessons(): Promise<{ id: string; stableKey: string; version: number; title: string; prerequisiteLessonIds: string[] }[]> {
  const catalog = await getPublishedCareerReadinessCatalog(pool) as { modules: { lessons: { id: string; stableKey: string; version: number; title: string; prerequisiteLessonIds: string[] }[] }[] };
  return catalog.modules.flatMap((entry) => entry.lessons);
}

describe('access (§6.6 minimums)', () => {
  it('401 without a token', async () => {
    await api().get(`${base}/lessons`).expect(401);
    await api().get(`${base}/policy`).expect(401);
  });

  it('403 without a content or catalogue capability, and writes need CONTENT_EDIT', async () => {
    for (const userId of [plainOperations.userId, institutionAdmin.userId, studentId]) {
      expect((await api().get(`${base}/lessons`).set(auth(userId))).status).toBe(403);
    }
    expect((await create(plainOperations, 'ops09c-forbidden')).status).toBe(403);
    expect((await create(reviewer, 'ops09c-reviewer-cannot-create')).status).toBe(403);
    expect((await create(catalogueManager, 'ops09c-catalogue-cannot-create')).status).toBe(403);
  });

  it('200 for readers, with the pilot lessons, the published module and the variant vocabularies', async () => {
    const response = await api().get(`${base}/lessons`).set(auth(catalogueManager.userId));
    expect(response.status).toBe(200);
    expect(response.body.summary.live).toBeGreaterThanOrEqual(3);
    expect(response.body.lessons.map((lesson: { stableKey: string }) => lesson.stableKey)).toEqual(expect.arrayContaining(fixture.lessons.map((lesson) => lesson.stableKey)));
    const pilot = response.body.lessons.find((lesson: { stableKey: string }) => lesson.stableKey === firstPilot().stableKey);
    expect(pilot).toMatchObject({ kind: 'BASE', status: 'LIVE', publishedRevision: 1, variant: { language: 'en', level: 'STANDARD', style: 'EXPLANATION' }, moduleKey: null });
    const policy = await api().get(`${base}/policy`).set(auth(publisher.userId));
    expect(policy.body.viewer).toMatchObject({ publish: true, edit: false });
    expect(policy.body.modules).toEqual([{ stableKey: moduleKey, title: fixture.module.title }]);
    expect(policy.body.languages[0]).toEqual({ language: 'en', name: 'English' });
    expect(policy.body.levels.map((entry: { level: string }) => entry.level)).toEqual(['FOUNDATION', 'STANDARD', 'ADVANCED']);
    expect(policy.body.styles.map((entry: { style: string }) => entry.style)).toEqual(['EXPLANATION', 'WORKED_EXAMPLE', 'STEP_BY_STEP', 'SUMMARY']);
  });

  it('400 on invalid input; 404 for unknown', async () => {
    expect((await create(editor, 'Bad Key')).body.error.code).toBe('LESSON_KEY_INVALID');
    expect((await create(editor, 'ops09c-level', { level: 'HARDEST' })).body.error.code).toBe('LESSON_LEVEL_INVALID');
    expect((await create(editor, 'ops09c-extra', { language: 'te' })).status).toBe(400);
    expect((await create(editor, 'ops09c-reason', { reasonCode: 'BECAUSE' })).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await create(editor, 'ops09c-title', { title: '' })).body.error.code).toBe('LESSON_TITLE_INVALID');
    for (const limit of ['0', '201', 'x']) expect((await api().get(`${base}/lessons`).query({ limit }).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/lessons`).query({ cursor: 'not-a-cursor' }).set(auth(editor.userId))).body.error.code).toBe('CURSOR_INVALID');
    expect((await api().get(`${base}/lessons`).query({ filter: 'EVERYTHING' }).set(auth(editor.userId))).body.error.code).toBe('LESSON_FILTER_INVALID');
    expect((await createVariant(editor, firstPilot().id, { language: 'xx' })).body.error.code).toBe('LESSON_LANGUAGE_INVALID');
    const created = await create(editor, 'ops09c-input-checks');
    const revisionId = created.body.lesson.open.id as string;
    expect((await save(editor, revisionId, complete({ prerequisites: 'write-for-action' }))).body.error.code).toBe('LESSON_PREREQUISITES_INVALID');
    expect((await save(editor, revisionId, complete({ licenceLabel: 'All-Rights-Reserved' }))).body.error.code).toBe('LESSON_LICENCE_INVALID');
    expect((await save(editor, revisionId, complete({ summary: 'x'.repeat(1001) }))).body.error.code).toBe('LESSON_SUMMARY_INVALID');
    expect((await api().get(`${base}/lessons/not-a-uuid`).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/lessons/${randomUUID()}`).set(auth(editor.userId))).status).toBe(404);
  });

  it('paginates on (key, id) within the bounds', async () => {
    const first = await api().get(`${base}/lessons`).query({ limit: '1' }).set(auth(editor.userId));
    expect(first.status).toBe(200);
    expect(first.body.lessons).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get(`${base}/lessons`).query({ limit: '1', cursor: first.body.nextCursor }).set(auth(editor.userId));
    expect(second.body.lessons[0].stableKey >= first.body.lessons[0].stableKey).toBe(true);
    expect(second.body.lessons[0].lessonId).not.toBe(first.body.lessons[0].lessonId);
    const searched = await api().get(`${base}/lessons`).query({ q: 'evidence', filter: 'LIVE' }).set(auth(editor.userId));
    expect(searched.body.lessons.map((lesson: { stableKey: string }) => lesson.stableKey)).toContain(secondPilot().stableKey);
  });
});

describe('draft → review → publish', () => {
  it('creates a draft with an audit row, and refuses a duplicate key (including a pilot key)', async () => {
    const created = await create(editor, 'ops09c-created', { level: 'FOUNDATION', style: 'WORKED_EXAMPLE' });
    expect(created.status).toBe(201);
    expect(created.body.lesson).toMatchObject({ status: 'PENDING', kind: 'BASE', stableKey: 'ops09c-created', variant: { language: 'en', level: 'FOUNDATION', style: 'WORKED_EXAMPLE' }, openRevision: { state: 'DRAFT', revision: 1 } });
    const row = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_created' AND resource_id=$1", [created.body.lesson.open.id])).rows[0];
    expect(row.context).toMatchObject({ reasonCode: 'NEW_LESSON', stableKey: 'ops09c-created', variant: 'en/FOUNDATION/WORKED_EXAMPLE' });
    expect((await create(secondEditor, 'ops09c-created')).status).toBe(409);
    expect((await create(secondEditor, firstPilot().stableKey)).body.error.code).toBe('LESSON_KEY_EXISTS');
  });

  it('refuses to submit an incomplete lesson, an unknown module, skill or prerequisite', async () => {
    const created = await create(editor, 'ops09c-incomplete');
    const revisionId = created.body.lesson.open.id as string;
    const refused = await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect(refused.status).toBe(400);
    expect(refused.body.error.problems).toEqual(expect.arrayContaining(['LESSON_SUMMARY_MISSING', 'LESSON_MODULE_MISSING', 'LESSON_TOPIC_MISSING', 'LESSON_LICENCE_MISSING']));
    expect((await save(editor, revisionId, complete({ moduleKey: 'no-such-module' }))).body.error.problems).toContain('LESSON_MODULE_UNKNOWN');
    expect((await save(editor, revisionId, complete({ topicKey: 'no-such-topic' }))).body.error.code).toBe('LESSON_TOPIC_UNKNOWN');
    expect((await save(editor, revisionId, complete({ prerequisites: ['no-such-lesson'] }))).body.error.problems).toEqual(['LESSON_PREREQUISITE_UNKNOWN:no-such-lesson']);
    expect((await save(editor, revisionId, complete({ prerequisites: [firstPilot().stableKey] }))).status).toBe(201);
  });

  it('rejects prerequisite cycles, among drafts and through the live lessons', async () => {
    const a = await create(editor, 'ops09c-cycle-a');
    const b = await create(editor, 'ops09c-cycle-b');
    expect((await save(editor, a.body.lesson.open.id, complete({ prerequisites: [] }))).status).toBe(201);
    expect((await save(editor, b.body.lesson.open.id, complete({ prerequisites: ['ops09c-cycle-a'] }))).status).toBe(201);
    const cycle = await save(editor, a.body.lesson.open.id, complete({ prerequisites: ['ops09c-cycle-b'] }));
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.problems).toEqual(['LESSON_PREREQUISITE_CYCLE']);
    expect((await save(editor, a.body.lesson.open.id, complete({ prerequisites: ['ops09c-cycle-a'] }))).body.error.problems).toContain('LESSON_PREREQUISITE_SELF');
    // The pilot chain is write → evidence story → interview loop; the first cannot require the last.
    const started = await revise(secondEditor, firstPilot().id, 'PREREQUISITE_CHANGE');
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const pilotCycle = await save(secondEditor, started.body.lesson.open.id, complete({
      title: firstPilot().title, summary: firstPilot().body.summary, topicKey, prerequisites: [thirdPilot().stableKey],
    }));
    expect(pilotCycle.body.error.problems).toEqual(['LESSON_PREREQUISITE_CYCLE']);
  });

  it('submits, freezes the draft, and rejects self-review by any contributor', async () => {
    const created = await create(editor, 'ops09c-review-flow');
    const revisionId = created.body.lesson.open.id as string;
    expect((await save(editor, revisionId, complete())).status).toBe(201);
    expect((await save(editorWhoReviews, revisionId, complete({ summary: 'Synthetic: a contributor rewrote this.' }))).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    expect((await save(editor, revisionId, complete())).body.error.code).toBe('LESSON_REVISION_NOT_EDITABLE');
    const self = await transition(editorWhoReviews, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('LESSON_SELF_REVIEW_REFUSED');
    expect((await transition(reviewer, revisionId, 'CHANGES_REQUESTED', 'CONTENT_INACCURATE')).status).toBe(201);
    expect((await save(secondEditor, revisionId, complete())).status).toBe(201);
    expect((await transition(secondEditor, revisionId, 'IN_REVIEW', 'CHANGES_MADE')).status).toBe(201);
    const detailed = await api().get(`${base}/lessons/${created.body.lesson.lessonId}`).set(auth(reviewer.userId));
    expect(detailed.body.lesson.open.contributors.map((entry: { userId: string }) => entry.userId).sort())
      .toEqual([editor.userId, editorWhoReviews.userId, secondEditor.userId].sort());
    expect(await auditCount('operations.content.lesson_transitioned', revisionId)).toBe(3);
    expect(await auditCount('operations.content.lesson_draft_saved', revisionId)).toBe(3);
  });

  it('approving is the rights review: it needs a rights reason and writes a release-eligible source record', async () => {
    const created = await create(editor, 'ops09c-rights');
    const revisionId = created.body.lesson.open.id as string;
    await save(editor, revisionId, complete({ licenceLabel: 'CC-BY-4.0', attribution: 'Synthetic source, CC BY 4.0' }));
    await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED')).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'LICENCE_VERIFIED')).status).toBe(201);
    const source = (await pool.query(
      `SELECT s.release_eligible, s.license_label, s.attribution_required, r.reason_code, r.reviewer_user_id
       FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id
       WHERE s.source_entity_type='LESSON_EDITOR_REVISION' AND s.source_record_id=$1`, [revisionId],
    )).rows[0];
    expect(source).toMatchObject({ release_eligible: true, license_label: 'CC-BY-4.0', attribution_required: true, reason_code: 'LICENCE_VERIFIED', reviewer_user_id: reviewer.userId });
    expect(await auditCount('operations.content.lesson_rights_reviewed', revisionId)).toBe(1);
  });

  it('a first publish needs an approval bound to the revision, hash and reason, and writes the lesson version students complete', async () => {
    const { lessonId, revisionId } = await approvedLesson('ops09c-publish', { prerequisites: [firstPilot().stableKey], practice: null });
    const bare = await publish(publisher, revisionId, { reasonCode: 'NEW_LESSON' });
    expect(bare.status).toBe(403);
    expect(bare.body.error.code).toBe('APPROVAL_REQUIRED');
    // The author cannot even ask.
    expect((await requestApproval(editor, { revisionId, reasonCode: 'NEW_LESSON' })).status).toBe(403);
    const approvalId = await approvedPublish(revisionId);
    expect((await publish(publisher, revisionId, { reasonCode: 'TRACK_RELEASE', approvalId })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const published = await publish(publisher, revisionId, { reasonCode: 'NEW_LESSON', approvalId });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.lesson).toMatchObject({ status: 'LIVE', publishedRevision: 1, openRevision: null });
    const version = (await pool.query(
      `SELECT v.id, v.version, v.title, v.body, v.superseded_at, m.stable_key AS module_key FROM lesson_versions v JOIN learning_modules m ON m.id = v.module_id WHERE v.stable_key='ops09c-publish'`,
    )).rows;
    expect(version).toHaveLength(1);
    // Only the text learners read: no rights, basis or provenance.
    expect(version[0]).toMatchObject({ version: 1, superseded_at: null, module_key: moduleKey, body: { summary: 'Synthetic summary a learner reads.' } });
    expect(Object.keys(version[0].body)).toEqual(['summary']);
    const prerequisites = (await pool.query('SELECT prerequisite_lesson_version_id FROM lesson_prerequisites WHERE lesson_version_id=$1', [version[0].id])).rows;
    expect(prerequisites).toEqual([{ prerequisite_lesson_version_id: firstPilot().id }]);
    const listed = (await catalogLessons()).find((lesson) => lesson.stableKey === 'ops09c-publish');
    expect(listed).toMatchObject({ id: version[0].id, prerequisiteLessonIds: [firstPilot().id] });
    const manifest = (await pool.query(
      `SELECT m.name, m.status, m.approved_by_user_id, m.published_by_user_id FROM content_revisions c JOIN release_manifests m ON m.id = c.release_manifest_id WHERE c.id=$1`, [revisionId],
    )).rows[0];
    expect(manifest).toMatchObject({ name: 'Lesson: ops09c-publish', status: 'PUBLISHED', approved_by_user_id: reviewer.userId, published_by_user_id: publisher.userId });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_published' AND resource_id=$1", [revisionId])).rows[0];
    expect(auditRow.context).toMatchObject({ reasonCode: 'NEW_LESSON', approvalId, lessonId, kind: 'BASE', firstPublish: true, approvalRequired: true });
    const events = (await pool.query('SELECT event_type FROM outbox_events WHERE aggregate_id=$1', [revisionId])).rows.map((row) => row.event_type);
    expect(events).toContain('lesson_editor.lesson_published');
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [approvalId])).rows[0].state).toBe('EXECUTED');
    // The approvals queue names the lesson and its variant.
    const queue = await api().get('/api/v1/operations/approvals').query({ state: 'EXECUTED' }).set(auth(publisher.userId));
    const filed = queue.body.approvals.find((entry: { id: string }) => entry.id === approvalId);
    expect(filed.summary).toMatchObject({ lessonKey: 'ops09c-publish', lessonVariant: 'en/STANDARD/EXPLANATION', lessonRevision: 1, questionKey: null });
  });

  it('refuses a publisher who wrote, edited or submitted the revision, and the approver, at the request and at publish', async () => {
    const created = await create(editorWhoPublishes, 'ops09c-own-publish');
    const revisionId = created.body.lesson.open.id as string;
    await save(editorWhoPublishes, revisionId, complete());
    await transition(editorWhoPublishes, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect((await transition(reviewerWhoPublishes, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).status).toBe(201);
    const asked = await requestApproval(editorWhoPublishes, { revisionId, reasonCode: 'NEW_LESSON' });
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe('LESSON_SELF_PUBLISH_REFUSED');
    // The learner-content lifecycle's rule: whoever approved it does not publish it.
    const byApprover = await requestApproval(reviewerWhoPublishes, { revisionId, reasonCode: 'NEW_LESSON' });
    expect(byApprover.status).toBe(403);
    expect(byApprover.body.error.code).toBe('LESSON_APPROVER_PUBLISH_REFUSED');
    const approvalId = await approvedPublish(revisionId);
    expect((await publish(editorWhoPublishes, revisionId, { reasonCode: 'NEW_LESSON', approvalId })).body.error.code).toBe('LESSON_SELF_PUBLISH_REFUSED');
    expect((await publish(reviewerWhoPublishes, revisionId, { reasonCode: 'NEW_LESSON', approvalId })).body.error.code).toBe('LESSON_APPROVER_PUBLISH_REFUSED');
    // The database refuses a PUBLISH action by the revision's author, whoever writes it (0065).
    await expect(pool.query(
      `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
       VALUES ($1,$2,$3,'PUBLISH','APPROVED','PUBLISHED','NEW_LESSON','ops09c-direct-publish')`, [randomUUID(), revisionId, editorWhoPublishes.userId],
    )).rejects.toThrow(/author cannot publish own lesson revision/);
    // The approval is still usable by the right person.
    expect((await publish(publisher, revisionId, { reasonCode: 'NEW_LESSON', approvalId })).status).toBe(201);
  });

  it('refuses to publish while a prerequisite is not live, leaving the approval usable', async () => {
    const pending = await create(editor, 'ops09c-pending-prereq');
    await save(editor, pending.body.lesson.open.id, complete());
    const { revisionId } = await approvedLesson('ops09c-needs-pending', { prerequisites: ['ops09c-pending-prereq'] });
    const approvalId = await approvedPublish(revisionId);
    const refused = await publish(publisher, revisionId, { reasonCode: 'NEW_LESSON', approvalId });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'LESSON_PREREQUISITE_NOT_LIVE', problems: ['LESSON_PREREQUISITE_NOT_LIVE:ops09c-pending-prereq'] });
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [approvalId])).rows[0].state).toBe('APPROVED');
    expect((await pool.query("SELECT count(*)::int AS n FROM lesson_versions WHERE stable_key='ops09c-needs-pending'")).rows[0].n).toBe(0);
  });
});

describe('revising a live lesson', () => {
  it('a wording revision publishes without an approval, supersedes the old version, and keeps a learner’s completion', async () => {
    const pilot = secondPilot();
    // The learner completes the pilot's first two lessons on version 1.
    await completeLesson(pool, { subjectUserId: studentId, lessonVersionId: firstPilot().id, correlationId: 'ops09c-complete-first' });
    const completed = await completeLesson(pool, { subjectUserId: studentId, lessonVersionId: pilot.id, correlationId: 'ops09c-complete-second' });
    const started = await revise(editor, pilot.id);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const open = started.body.lesson.open;
    // The pilot lesson starts complete from what is live: its module, skill and prerequisite.
    expect(open).toMatchObject({ revision: 2, fields: { moduleKey, topicId: pilot.topicId, prerequisites: [firstPilot().stableKey], summary: pilot.body.summary } });
    expect((await revise(secondEditor, pilot.id)).body.error.code).toBe('LESSON_OPEN_REVISION_EXISTS');
    const pilotTopicKey = fixture.topics.find((topic) => topic.id === pilot.topicId)!.stableKey;
    expect((await save(editor, open.id, complete({ title: 'Synthetic revised title', summary: 'Synthetic revised summary.', topicKey: pilotTopicKey, prerequisites: [firstPilot().stableKey] }))).status).toBe(201);
    await submitAndApprove(open.id);
    const detail = await api().get(`${base}/lessons/${pilot.id}`).set(auth(publisher.userId));
    expect(detail.body.lesson.publishNeedsApproval).toBe(false);
    expect((await requestApproval(publisher, { revisionId: open.id, reasonCode: 'LESSON_REVISION' })).body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    const published = await publish(publisher, open.id, { reasonCode: 'LESSON_REVISION' });
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    const versions = (await pool.query('SELECT id, version, superseded_at FROM lesson_versions WHERE stable_key=$1 ORDER BY version', [pilot.stableKey])).rows;
    expect(versions.map((row) => [row.version, row.superseded_at !== null])).toEqual([[1, true], [2, false]]);
    await expect(pool.query("UPDATE lesson_versions SET title='changed' WHERE id=$1", [versions[0].id])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE lesson_versions SET superseded_at=NULL WHERE id=$1', [versions[0].id])).rejects.toThrow(/stays superseded/);
    await expect(pool.query('DELETE FROM lesson_versions WHERE id=$1', [versions[1].id])).rejects.toThrow(/cannot be deleted/);

    // The catalogue lists the lesson once, at its new version; the next lesson names it by that id.
    const lessons = await catalogLessons();
    expect(lessons.filter((lesson) => lesson.stableKey === pilot.stableKey)).toEqual([expect.objectContaining({ id: versions[1].id, version: 2, title: 'Synthetic revised title' })]);
    expect(lessons.find((lesson) => lesson.stableKey === thirdPilot().stableKey)!.prerequisiteLessonIds).toEqual([versions[1].id]);
    // The learner's completion shows against the current version, and completing it again adds no evidence.
    const state = await getLearnerCareerReadinessState(pool, studentId) as { progress: { lessonVersionId: string; state: string }[] };
    expect(state.progress.map((entry) => entry.lessonVersionId)).toContain(versions[1].id);
    const evidenceBefore = (await pool.query("SELECT count(*)::int AS n FROM evidence_records WHERE subject_user_id=$1 AND evidence_type='LESSON_COMPLETION'", [studentId])).rows[0].n;
    const again = await completeLesson(pool, { subjectUserId: studentId, lessonVersionId: versions[1].id, correlationId: 'ops09c-complete-again' });
    expect(again).toMatchObject({ idempotentReplay: true, progressId: completed.progressId });
    expect((await pool.query("SELECT count(*)::int AS n FROM evidence_records WHERE subject_user_id=$1 AND evidence_type='LESSON_COMPLETION'", [studentId])).rows[0].n).toBe(evidenceBefore);
    // The third lesson unlocks: its prerequisite was completed on the old version.
    const third = await completeLesson(pool, { subjectUserId: studentId, lessonVersionId: thirdPilot().id, correlationId: 'ops09c-complete-third' });
    expect(third.idempotentReplay).toBe(false);
  });

  it('a revision that changes the skill or prerequisites needs an approval', async () => {
    const pilot = thirdPilot();
    const started = await revise(editor, pilot.id, 'PREREQUISITE_CHANGE');
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const revisionId = started.body.lesson.open.id as string;
    expect((await save(editor, revisionId, complete({ title: pilot.title, summary: pilot.body.summary, topicKey: otherTopicKey, prerequisites: [firstPilot().stableKey] }))).status).toBe(201);
    await submitAndApprove(revisionId);
    const refused = await publish(publisher, revisionId, { reasonCode: 'LESSON_REVISION' });
    expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = await approvedPublish(revisionId, 'LESSON_REVISION');
    const published = await publish(publisher, revisionId, { reasonCode: 'LESSON_REVISION', approvalId });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_published' AND resource_id=$1", [revisionId])).rows[0];
    expect(auditRow.context).toMatchObject({ firstPublish: false, prerequisitesChanged: true, approvalRequired: true });
  });
});

describe('variants', () => {
  it('are created only for a live base lesson, once per language, level and style, never the base’s own', async () => {
    const pending = await create(editor, 'ops09c-variant-of-pending');
    expect((await createVariant(editor, pending.body.lesson.lessonId)).body.error.code).toBe('LESSON_BASE_NOT_LIVE');
    expect((await createVariant(editor, firstPilot().id, { language: 'en', level: 'STANDARD', style: 'EXPLANATION' })).body.error.code).toBe('LESSON_VARIANT_EXISTS');
    const created = await createVariant(editor, firstPilot().id, { language: 'hi', level: 'FOUNDATION', style: 'STEP_BY_STEP' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.lesson).toMatchObject({ kind: 'VARIANT', variantOf: firstPilot().id, stableKey: firstPilot().stableKey, variant: { language: 'hi', level: 'FOUNDATION', style: 'STEP_BY_STEP' }, basedOnRevision: 1, baseRevision: 1 });
    expect((await createVariant(secondEditor, firstPilot().id, { language: 'hi', level: 'FOUNDATION', style: 'STEP_BY_STEP' })).body.error.code).toBe('LESSON_VARIANT_EXISTS');
    expect((await createVariant(editor, created.body.lesson.lessonId)).body.error.code).toBe('LESSON_NOT_A_BASE');
    const baseDetail = await api().get(`${base}/lessons/${firstPilot().id}`).set(auth(editor.userId));
    expect(baseDetail.body.lesson.variants.map((entry: { variant: { language: string } }) => entry.variant.language)).toContain('hi');
  });

  it('go through review and publish without an approval, and write no lesson version', async () => {
    const lessonsBefore = (await catalogLessons()).length;
    const created = await createVariant(editor, firstPilot().id, { language: 'te', level: 'STANDARD', style: 'EXPLANATION' });
    const variantId = created.body.lesson.lessonId as string;
    const revisionId = created.body.lesson.open.id as string;
    // A variant carries no module, skill or prerequisites of its own.
    expect((await save(editor, revisionId, { ...variantDraft(), moduleKey })).body.error.problems).toContain('LESSON_VARIANT_STRUCTURE_INVALID');
    expect((await save(editor, revisionId, variantDraft())).status).toBe(201);
    await submitAndApprove(revisionId, editor, 'NATIVE_SPEAKER_REVIEWED');
    const self = await publish(editor, revisionId, { reasonCode: 'NEW_VARIANT' });
    expect(self.status).toBe(403);
    expect((await requestApproval(publisher, { revisionId, reasonCode: 'NEW_VARIANT' })).body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    const published = await publish(publisher, revisionId, { reasonCode: 'NEW_VARIANT' });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.lesson).toMatchObject({ status: 'LIVE', publishedRevision: 1, kind: 'VARIANT' });
    expect((await catalogLessons()).length).toBe(lessonsBefore);
    const row = (await pool.query(
      `SELECT c.state, c.body, m.name FROM content_revisions c JOIN release_manifests m ON m.id = c.release_manifest_id WHERE c.id=$1`, [revisionId],
    )).rows[0];
    expect(row).toMatchObject({ state: 'PUBLISHED', name: `Lesson variant: ${firstPilot().stableKey} te/STANDARD/EXPLANATION`, body: { variantOf: firstPilot().id, basedOnRevision: 1, variant: { language: 'te' } } });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_published' AND resource_id=$1", [revisionId])).rows[0];
    expect(auditRow.context).toMatchObject({ kind: 'VARIANT', lessonVersionId: null, approvalRequired: false, isVariant: true });
    const summary = await api().get(`${base}/lessons`).query({ filter: 'VARIANTS' }).set(auth(editor.userId));
    expect(summary.body.lessons.map((lesson: { lessonId: string }) => lesson.lessonId)).toContain(variantId);
    expect(summary.body.summary.liveVariants).toBeGreaterThanOrEqual(1);
  });
});

describe('archiving a published lesson or variant (content-archive-design.md)', () => {
  const archive = (actor: Member, lessonId: string, reasonCode = 'OUT_OF_DATE') =>
    api().post(`${base}/lessons/${lessonId}/archive`).set(auth(actor.userId)).send({ reasonCode });

  it('takes a base lesson out of the catalogue at once, keeps its record, and is final', async () => {
    const { lessonId, revisionId } = await approvedLesson('ops-archive-lesson');
    const approvalId = await approvedPublish(revisionId);
    expect((await publish(publisher, revisionId, { reasonCode: 'NEW_LESSON', approvalId })).status).toBe(201);
    expect((await catalogLessons()).map((lesson) => lesson.stableKey)).toContain('ops-archive-lesson');

    expect((await archive(editor, lessonId)).status).toBe(403);
    expect((await archive(publisher, lessonId, 'SEND_IT')).body.error.code).toBe('REASON_CODE_INVALID');
    const archived = await archive(publisher, lessonId);
    expect(archived.status, JSON.stringify(archived.body)).toBe(201);
    expect(archived.body.archivedRevisions).toEqual([1]);
    expect(archived.body.lesson).toMatchObject({ status: 'ARCHIVED', publishedRevision: null });

    expect((await catalogLessons()).map((lesson) => lesson.stableKey)).not.toContain('ops-archive-lesson');
    const version = (await pool.query("SELECT superseded_at FROM lesson_versions WHERE stable_key='ops-archive-lesson'")).rows;
    expect(version).toHaveLength(1);
    expect(version[0].superseded_at).not.toBeNull();
    expect((await pool.query('SELECT state, published_at FROM content_revisions WHERE id=$1', [revisionId])).rows[0]).toMatchObject({ state: 'ARCHIVED', published_at: expect.any(Date) });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_archived' AND resource_id=$1", [revisionId])).rows;
    expect(auditRow).toHaveLength(1);
    expect(auditRow[0].context).toMatchObject({ lessonId, stableKey: 'ops-archive-lesson', kind: 'BASE', reasonCode: 'OUT_OF_DATE', archivedRevisions: [1] });

    expect((await archive(publisher, lessonId)).body.error.code).toBe('LESSON_NOT_LIVE');
    expect((await revise(editor, lessonId)).body.error.code).toBe('LESSON_NOT_LIVE');
    expect((await createVariant(editor, lessonId)).body.error.code).toBe('LESSON_BASE_NOT_LIVE');
    const listed = await api().get(`${base}/lessons`).query({ filter: 'ARCHIVED', q: 'ops-archive-lesson' }).set(auth(editor.userId)).expect(200);
    expect(listed.body.lessons.map((lesson: { lessonId: string }) => lesson.lessonId)).toEqual([lessonId]);
    expect(listed.body.summary.archived).toBeGreaterThanOrEqual(1);
  });

  it('refuses a base lesson with a live variant, archives the variant without touching the base, then no longer blocks on it', async () => {
    const created = await createVariant(editor, secondPilot().id, { language: 'ta', level: 'STANDARD', style: 'EXPLANATION' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const variantId = created.body.lesson.lessonId as string;
    const variantRevision = created.body.lesson.open.id as string;
    expect((await save(editor, variantRevision, variantDraft())).status).toBe(201);
    await submitAndApprove(variantRevision, editor, 'NATIVE_SPEAKER_REVIEWED');
    expect((await publish(publisher, variantRevision, { reasonCode: 'NEW_VARIANT' })).status).toBe(201);

    const blocked = await archive(publisher, secondPilot().id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LESSON_ARCHIVE_BLOCKED');
    expect(blocked.body.error.problems).toContain('LESSON_HAS_LIVE_VARIANTS');
    const lessonsBefore = await catalogLessons();

    const variant = await archive(publisher, variantId, 'RIGHTS_WITHDRAWN');
    expect(variant.status, JSON.stringify(variant.body)).toBe(201);
    expect(variant.body.lesson).toMatchObject({ status: 'ARCHIVED', kind: 'VARIANT' });
    expect((await pool.query("SELECT count(*)::int AS n FROM content_revisions WHERE entity_type='LESSON' AND entity_id=$1 AND state='PUBLISHED'", [variantId])).rows[0].n).toBe(0);
    // The base lesson and every lesson version are untouched.
    expect(await catalogLessons()).toEqual(lessonsBefore);
    // With its only variant archived and nothing else needing it, the base lesson archives too.
    const again = await archive(publisher, secondPilot().id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await catalogLessons()).map((lesson) => lesson.stableKey)).not.toContain(secondPilot().stableKey);
  });
});
