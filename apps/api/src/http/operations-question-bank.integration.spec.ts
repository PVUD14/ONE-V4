/**
 * The question bank editor over HTTP (OPS-09b).
 *
 * A question goes draft → review → publish; the author, anyone who edited it and its submitter
 * are refused as reviewer and publisher; approving records a real rights review; submitting
 * writes the option tags (ENG-07's table) and the hint ladder (0061), which move and publish with
 * the question; every publish needs a second person's approval bound to the exact revision, hash
 * and reason; a republished pilot question supersedes its old version in the readiness-check pool;
 * and answer keys reach only content editors and reviewers — never a publisher-only reader, and
 * never a learner starting the readiness check. Plus the §6.6 minimums: 401, 403, 200, input
 * 400s, 404, pagination bounds, audit rows with reason codes. Real Postgres in a throwaway schema.
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
import { publishCareerReadinessPilot, startAssessmentAttempt, type PilotFixture } from '@planthepath/persistence/src/career-readiness.js';
import { createMisconceptionCodeDraft, publishEngineContentRelease, transitionEngineContent } from '@planthepath/persistence/src/misconceptions.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for question bank tests');

const schemaName = 'ops_question_bank_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const PILOT_SOURCE_RECORD_ID = '25000000-0000-4000-8000-000000000002';
let app: INestApplication;
let platformId: string;
let institutionId: string;
let fixture: PilotFixture;
let topicKey: string;
let otherTopicKey: string;
let publishedCodeId: string;
let draftCodeId: string;
let otherTopicCodeId: string;

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
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Question bank college')", [institutionId]);
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
  studentId = await user();

  // The pilot: live topics, six published questions and the readiness check that draws them.
  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const actors = { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() };
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  topicKey = fixture.topics[0]!.stableKey;
  otherTopicKey = fixture.topics[1]!.stableKey;

  // ENG-07 misconception codes on the first topic: one published, one still a draft; one on another topic.
  const codeAuthor = await user();
  const codeReviewer = await user();
  const codeInput = (code: string, skillId: string) => ({
    code, skillId, title: `Synthetic ${code}`, description: 'Synthetic misconception for OPS-09b tests.', source: 'AUTHORED' as const,
    basis: 'Synthetic basis', authorUserId: codeAuthor,
  });
  const published = await createMisconceptionCodeDraft(db, codeInput('SYN_OPS09B_PUBLISHED', fixture.topics[0]!.id));
  await transitionEngineContent(db, { revisionId: published.revisionId, to: 'IN_REVIEW', actorUserId: codeAuthor, reasonCode: 'SYNTHETIC_REVIEW', correlationId: 'ops09b-code-submit' });
  await transitionEngineContent(db, { revisionId: published.revisionId, to: 'APPROVED', actorUserId: codeReviewer, reasonCode: 'SYNTHETIC_REVIEW', correlationId: 'ops09b-code-approve' });
  await publishEngineContentRelease(db, {
    revisionIds: [published.revisionId], releaseName: 'ops09b synthetic codes', releaseVersion: 1, sourceRecordId: PILOT_SOURCE_RECORD_ID,
    approverUserId: codeReviewer, publisherUserId: codeReviewer, correlationId: 'ops09b-code-publish',
  });
  publishedCodeId = published.id;
  draftCodeId = (await createMisconceptionCodeDraft(db, codeInput('SYN_OPS09B_DRAFT', fixture.topics[0]!.id))).id;
  otherTopicCodeId = (await createMisconceptionCodeDraft(db, codeInput('SYN_OPS09B_OTHER', fixture.topics[1]!.id))).id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-question-' + randomUUID() });
const base = '/api/v1/operations/question-bank';
const hints = ['Synthetic nudge.', 'Synthetic strategy.', 'Synthetic first step.', 'Synthetic near solution.'];

function complete(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicKey,
    prompt: 'Synthetic: which follow-up is clearest?',
    options: [
      { id: 'a', text: 'Synthetic vague request', misconceptionCodeId: publishedCodeId, rationale: 'Synthetic: mistakes politeness for clarity.' },
      { id: 'b', text: 'Synthetic specific request with a deadline' },
      { id: 'c', text: 'Synthetic one-word nudge' },
    ],
    correctOptionId: 'b',
    explanation: 'Synthetic: it names the action and the deadline.',
    difficulty: 'FOUNDATION',
    hints,
    licenceLabel: 'AI8HT-Owned',
    basis: 'Synthetic basis for tests',
    reasonCode: 'DRAFT_EDIT',
    ...over,
  };
}

function create(actor: Member, stableKey: string, over: Record<string, unknown> = {}) {
  return api().post(`${base}/questions`).set(auth(actor.userId)).send({ stableKey, topicKey, prompt: `Synthetic prompt for ${stableKey}`, reasonCode: 'NEW_QUESTION', ...over });
}
function save(actor: Member, revisionId: string, over: Record<string, unknown> = {}) {
  return api().post(`${base}/revisions/${revisionId}/draft`).set(auth(actor.userId)).send(complete(over));
}
function transition(actor: Member, revisionId: string, toState: string, reasonCode: string, rightsReasonCode?: string) {
  return api().post(`${base}/revisions/${revisionId}/transition`).set(auth(actor.userId)).send({ toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}) });
}
function publish(actor: Member, revisionId: string, body: Record<string, unknown>) {
  return api().post(`${base}/revisions/${revisionId}/publish`).set(auth(actor.userId)).send(body);
}
function requestApproval(actor: Member, payload: Record<string, unknown>) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey: 'CONTENT_QUESTION_PUBLISH', payload });
}
function decide(actor: Member, approvalId: string) {
  return api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(actor.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
}
async function auditCount(action: string, resourceId: string): Promise<number> {
  return (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows[0].n;
}

/** Create, fill, submit and approve a question; returns its id and open revision. */
async function approvedQuestion(stableKey: string, over: Record<string, unknown> = {}): Promise<{ questionId: string; revisionId: string }> {
  const created = await create(editor, stableKey);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const questionId = created.body.question.questionId as string;
  const revisionId = created.body.question.open.id as string;
  const saved = await save(editor, revisionId, over);
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
  const approved = await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
  expect(approved.status, JSON.stringify(approved.body)).toBe(201);
  return { questionId, revisionId };
}

/** File and approve a publish; returns the approval id. */
async function approvedPublish(revisionId: string, reasonCode = 'NEW_QUESTION', actor = publisher): Promise<string> {
  const filed = await requestApproval(actor, { revisionId, reasonCode });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  expect((await decide(approver, filed.body.approval.id)).status).toBe(201);
  return filed.body.approval.id as string;
}

describe('access (§6.6 minimums)', () => {
  it('401 without a token', async () => {
    await api().get(`${base}/questions`).expect(401);
    await api().get(`${base}/policy`).expect(401);
  });

  it('403 without a content capability: plain operations, catalogue managers, institution staff, students', async () => {
    for (const userId of [plainOperations.userId, catalogueManager.userId, institutionAdmin.userId, studentId]) {
      expect((await api().get(`${base}/questions`).set(auth(userId))).status).toBe(403);
    }
    expect((await create(plainOperations, 'ops09b-forbidden')).status).toBe(403);
    expect((await create(reviewer, 'ops09b-reviewer-cannot-create')).status).toBe(403);
  });

  it('200 for content readers; the policy says who sees answer keys', async () => {
    const response = await api().get(`${base}/questions`).set(auth(publisher.userId));
    expect(response.status).toBe(200);
    expect(response.body.summary).toMatchObject({ live: expect.any(Number), pending: expect.any(Number) });
    expect(response.body.summary.live).toBeGreaterThanOrEqual(6);
    expect((await api().get(`${base}/policy`).set(auth(publisher.userId))).body.viewer).toMatchObject({ publish: true, answerKeys: false });
    const policy = await api().get(`${base}/policy`).set(auth(reviewer.userId));
    expect(policy.body.viewer).toMatchObject({ review: true, answerKeys: true });
    expect(policy.body.difficulties.map((entry: { difficulty: string }) => entry.difficulty)).toEqual(['FOUNDATION', 'INTERMEDIATE', 'ADVANCED']);
    expect(policy.body.hintLevels).toHaveLength(4);
  });

  it('400 on invalid input: key, topic, unknown fields, options, hints, limits, cursor and filter; 404 for unknown', async () => {
    expect((await create(editor, 'Bad Key')).body.error.code).toBe('QUESTION_KEY_INVALID');
    expect((await create(editor, 'ops09b-no-topic', { topicKey: 'no-such-topic' })).body.error.code).toBe('QUESTION_TOPIC_UNKNOWN');
    expect((await create(editor, 'ops09b-extra', { published: true })).status).toBe(400);
    expect((await create(editor, 'ops09b-reason', { reasonCode: 'BECAUSE' })).body.error.code).toBe('REASON_CODE_INVALID');
    for (const limit of ['0', '201', 'x']) expect((await api().get(`${base}/questions`).query({ limit }).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/questions`).query({ cursor: 'not-a-cursor' }).set(auth(editor.userId))).body.error.code).toBe('CURSOR_INVALID');
    expect((await api().get(`${base}/questions`).query({ filter: 'EVERYTHING' }).set(auth(editor.userId))).body.error.code).toBe('QUESTION_FILTER_INVALID');
    const created = await create(editor, 'ops09b-input-checks');
    const revisionId = created.body.question.open.id as string;
    expect((await save(editor, revisionId, { options: [{ id: 'b', text: 'out of order' }] })).body.error.code).toBe('QUESTION_OPTIONS_INVALID');
    expect((await save(editor, revisionId, { hints: ['only one'] })).body.error.code).toBe('QUESTION_HINTS_INVALID');
    expect((await save(editor, revisionId, { difficulty: 'HARDEST' })).body.error.code).toBe('QUESTION_DIFFICULTY_INVALID');
    expect((await save(editor, revisionId, { correctOptionId: 'z' })).body.error.code).toBe('QUESTION_CORRECT_OPTION_INVALID');
    expect((await save(editor, revisionId, { licenceLabel: 'All-Rights-Reserved' })).body.error.code).toBe('QUESTION_LICENCE_INVALID');
    expect((await api().get(`${base}/questions/not-a-uuid`).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/questions/${randomUUID()}`).set(auth(editor.userId))).status).toBe(404);
  });

  it('paginates on (stable key, id) within the bounds', async () => {
    const first = await api().get(`${base}/questions`).query({ limit: '1' }).set(auth(editor.userId));
    expect(first.status).toBe(200);
    expect(first.body.questions).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get(`${base}/questions`).query({ limit: '1', cursor: first.body.nextCursor }).set(auth(editor.userId));
    expect(second.body.questions[0].stableKey > first.body.questions[0].stableKey).toBe(true);
    const searched = await api().get(`${base}/questions`).query({ q: 'crf-q', filter: 'LIVE' }).set(auth(editor.userId));
    expect(searched.body.questions.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(searched.body)).not.toContain('correctOptionId');
  });
});

describe('draft → review → publish', () => {
  it('creates a draft with an audit row, and refuses a duplicate key (including a pilot key)', async () => {
    const created = await create(editor, 'ops09b-created');
    expect(created.status).toBe(201);
    expect(created.body.question).toMatchObject({ status: 'PENDING', stableKey: 'ops09b-created', openRevision: { state: 'DRAFT', revision: 1 } });
    const row = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.question_created' AND resource_id=$1", [created.body.question.open.id])).rows[0];
    expect(row.context).toMatchObject({ reasonCode: 'NEW_QUESTION', stableKey: 'ops09b-created' });
    expect((await create(secondEditor, 'ops09b-created')).status).toBe(409);
    expect((await create(secondEditor, 'crf-q1')).body.error.code).toBe('QUESTION_KEY_EXISTS');
  });

  it('refuses to submit an incomplete question, and a code from another topic', async () => {
    const created = await create(editor, 'ops09b-incomplete');
    const revisionId = created.body.question.open.id as string;
    const refused = await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect(refused.status).toBe(400);
    expect(refused.body.error.problems).toEqual(expect.arrayContaining(['QUESTION_OPTIONS_TOO_FEW', 'QUESTION_ANSWER_KEY_MISSING', 'QUESTION_HINT_MISSING:1', 'QUESTION_LICENCE_MISSING']));
    const wrongTopic = await save(editor, revisionId, { options: [{ id: 'a', text: 'x', misconceptionCodeId: otherTopicCodeId, rationale: 'why' }, { id: 'b', text: 'y' }] });
    expect(wrongTopic.status).toBe(400);
    expect(wrongTopic.body.error.problems).toContain('QUESTION_MISCONCEPTION_UNKNOWN:a');
    const onCorrect = await save(editor, revisionId, { correctOptionId: 'a' });
    expect(onCorrect.body.error.problems).toContain('QUESTION_MISCONCEPTION_ON_CORRECT:a');
    expect((await save(editor, revisionId, { topicKey: otherTopicKey, options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] })).status).toBe(201);
  });

  it('submits: writes the hint ladder and the option tags, freezes the draft, and rejects self-review by any contributor', async () => {
    const created = await create(editor, 'ops09b-review-flow');
    const questionId = created.body.question.questionId as string;
    const revisionId = created.body.question.open.id as string;
    expect((await save(editor, revisionId)).status).toBe(201);
    expect((await save(editorWhoReviews, revisionId, { explanation: 'Synthetic: a contributor rewrote this.' })).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    const ladder = (await pool.query('SELECT hint_1, hint_4, review_state, source FROM question_hint_ladders WHERE question_revision_id=$1', [revisionId])).rows;
    expect(ladder).toEqual([{ hint_1: hints[0], hint_4: hints[3], review_state: 'IN_REVIEW', source: 'AUTHORED' }]);
    const tags = (await pool.query('SELECT option_id, misconception_code_id, review_state FROM question_option_misconceptions WHERE question_revision_id=$1', [revisionId])).rows;
    expect(tags).toEqual([{ option_id: 'a', misconception_code_id: publishedCodeId, review_state: 'IN_REVIEW' }]);
    expect((await save(editor, revisionId)).body.error.code).toBe('QUESTION_REVISION_NOT_EDITABLE');
    const self = await transition(editorWhoReviews, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('QUESTION_SELF_REVIEW_REFUSED');
    // A reviewer sends it back; the ladder and tag follow; the editor changes the rationale and resubmits.
    expect((await transition(reviewer, revisionId, 'CHANGES_REQUESTED', 'DISTRACTORS_WEAK')).status).toBe(201);
    expect((await pool.query('SELECT review_state FROM question_hint_ladders WHERE question_revision_id=$1', [revisionId])).rows[0].review_state).toBe('CHANGES_REQUESTED');
    expect((await pool.query('SELECT review_state FROM question_option_misconceptions WHERE question_revision_id=$1', [revisionId])).rows[0].review_state).toBe('CHANGES_REQUESTED');
    const options = (complete().options as Record<string, unknown>[]).map((option) => option.id === 'a' ? { ...option, rationale: 'Synthetic: a sharper rationale.' } : option);
    expect((await save(secondEditor, revisionId, { options })).status).toBe(201);
    expect((await transition(secondEditor, revisionId, 'IN_REVIEW', 'CHANGES_MADE')).status).toBe(201);
    const reused = (await pool.query('SELECT rationale, review_state FROM question_option_misconceptions WHERE question_revision_id=$1', [revisionId])).rows;
    expect(reused).toEqual([{ rationale: 'Synthetic: a sharper rationale.', review_state: 'IN_REVIEW' }]);
    const detailed = await api().get(`${base}/questions/${questionId}`).set(auth(reviewer.userId));
    expect(detailed.body.question.open.contributors.map((entry: { userId: string }) => entry.userId).sort())
      .toEqual([editor.userId, editorWhoReviews.userId, secondEditor.userId].sort());
    expect(await auditCount('operations.content.question_transitioned', revisionId)).toBe(3);
    expect(await auditCount('operations.content.question_draft_saved', revisionId)).toBe(3);
  });

  it('approving is the rights review: it needs a rights reason and writes a release-eligible source record', async () => {
    const created = await create(editor, 'ops09b-rights');
    const revisionId = created.body.question.open.id as string;
    await save(editor, revisionId, { licenceLabel: 'CC-BY-4.0', attribution: 'Synthetic source, CC BY 4.0' });
    await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED')).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'LICENCE_VERIFIED')).status).toBe(201);
    const source = (await pool.query(
      `SELECT s.release_eligible, s.license_label, s.attribution_required, r.reason_code, r.reviewer_user_id
       FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id
       WHERE s.source_entity_type='QUESTION_BANK_REVISION' AND s.source_record_id=$1`, [revisionId],
    )).rows[0];
    expect(source).toMatchObject({ release_eligible: true, license_label: 'CC-BY-4.0', attribution_required: true, reason_code: 'LICENCE_VERIFIED', reviewer_user_id: reviewer.userId });
    expect((await pool.query('SELECT review_state FROM question_option_misconceptions WHERE question_revision_id=$1', [revisionId])).rows[0].review_state).toBe('APPROVED');
    expect(await auditCount('operations.content.question_rights_reviewed', revisionId)).toBe(1);
  });

  it('publishes only with an approval bound to the revision, hash and reason; writes the version, the key, the tags and the ladder', async () => {
    const { questionId, revisionId } = await approvedQuestion('ops09b-publish');
    // No approval: refused, nothing changes.
    const bare = await publish(publisher, revisionId, { reasonCode: 'NEW_QUESTION' });
    expect(bare.status).toBe(403);
    expect(bare.body.error.code).toBe('APPROVAL_REQUIRED');
    // The author cannot even ask; the approver cannot approve their own request (tested in OPS-02).
    expect((await requestApproval(editor, { revisionId, reasonCode: 'NEW_QUESTION' })).status).toBe(403);
    const approvalId = await approvedPublish(revisionId);
    // A different reason is a different payload.
    expect((await publish(publisher, revisionId, { reasonCode: 'TRACK_RELEASE', approvalId })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const published = await publish(publisher, revisionId, { reasonCode: 'NEW_QUESTION', approvalId });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect(published.body.question).toMatchObject({ status: 'LIVE', publishedVersion: 1, openRevision: null });
    const version = (await pool.query(
      `SELECT v.id, v.version, v.options, v.superseded_at, k.correct_option_id, k.explanation
       FROM question_versions v JOIN question_answer_keys k ON k.question_version_id = v.id WHERE v.stable_key='ops09b-publish'`,
    )).rows;
    expect(version).toHaveLength(1);
    expect(version[0]).toMatchObject({ version: 1, superseded_at: null, correct_option_id: 'b' });
    // The learner-facing row holds {id, text} only.
    for (const option of version[0].options as Record<string, unknown>[]) expect(Object.keys(option).sort()).toEqual(['id', 'text']);
    expect((await pool.query('SELECT review_state FROM question_hint_ladders WHERE question_revision_id=$1', [revisionId])).rows[0].review_state).toBe('PUBLISHED');
    expect((await pool.query('SELECT review_state FROM question_option_misconceptions WHERE question_revision_id=$1', [revisionId])).rows[0].review_state).toBe('PUBLISHED');
    const manifest = (await pool.query(
      `SELECT m.status, m.approved_by_user_id, m.published_by_user_id, count(i.*)::int AS items
       FROM content_revisions c JOIN release_manifests m ON m.id = c.release_manifest_id JOIN release_manifest_items i ON i.manifest_id = m.id
       WHERE c.id=$1 GROUP BY m.id`, [revisionId],
    )).rows[0];
    expect(manifest).toMatchObject({ status: 'PUBLISHED', approved_by_user_id: reviewer.userId, published_by_user_id: publisher.userId, items: 2 });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.question_published' AND resource_id=$1", [revisionId])).rows[0];
    expect(auditRow.context).toMatchObject({ reasonCode: 'NEW_QUESTION', approvalId, tagCount: 1, questionId });
    expect(JSON.stringify(auditRow.context)).not.toContain('Synthetic specific request');
    const events = (await pool.query("SELECT event_type, payload FROM outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at", [revisionId])).rows;
    expect(events.map((event) => event.event_type)).toContain('question_bank.question_published');
    expect(JSON.stringify(events)).not.toContain('correctOptionId');
    // The approval was used.
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [approvalId])).rows[0].state).toBe('EXECUTED');
    // A published tag makes a wrong answer name its misconception (ENG-07 through this path).
    const tagged = (await pool.query(
      `SELECT c.code FROM question_versions v JOIN question_option_misconceptions t ON t.question_revision_id = v.content_revision_id
       JOIN misconception_codes c ON c.id = t.misconception_code_id WHERE v.stable_key='ops09b-publish' AND t.review_state='PUBLISHED'`,
    )).rows;
    expect(tagged).toEqual([{ code: 'SYN_OPS09B_PUBLISHED' }]);
  });

  it('refuses a publisher who wrote, edited or submitted the revision, at the request and at publish', async () => {
    const created = await create(editorWhoPublishes, 'ops09b-own-publish');
    const revisionId = created.body.question.open.id as string;
    await save(editorWhoPublishes, revisionId);
    await transition(editorWhoPublishes, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW');
    await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');
    const asked = await requestApproval(editorWhoPublishes, { revisionId, reasonCode: 'NEW_QUESTION' });
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe('QUESTION_SELF_PUBLISH_REFUSED');
    const approvalId = await approvedPublish(revisionId);
    expect((await publish(editorWhoPublishes, revisionId, { reasonCode: 'NEW_QUESTION', approvalId })).body.error.code).toBe('QUESTION_SELF_PUBLISH_REFUSED');
    // And the database refuses a PUBLISH action by the revision's author, whoever writes it (0061).
    await expect(pool.query(
      `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
       VALUES ($1,$2,$3,'PUBLISH','APPROVED','PUBLISHED','NEW_QUESTION','ops09b-direct-publish')`, [randomUUID(), revisionId, editorWhoPublishes.userId],
    )).rejects.toThrow(/author cannot publish own question revision/);
  });

  it('refuses to publish while a tagged code is unpublished, leaving the approval usable', async () => {
    const options = [
      { id: 'a', text: 'Synthetic distractor', misconceptionCodeId: draftCodeId, rationale: 'Synthetic: draft code.' },
      { id: 'b', text: 'Synthetic answer' },
    ];
    const { revisionId } = await approvedQuestion('ops09b-draft-code', { options });
    const approvalId = await approvedPublish(revisionId);
    const refused = await publish(publisher, revisionId, { reasonCode: 'NEW_QUESTION', approvalId });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'QUESTION_MISCONCEPTION_NOT_PUBLISHED', problems: ['QUESTION_MISCONCEPTION_NOT_PUBLISHED:a'] });
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id=$1', [approvalId])).rows[0].state).toBe('APPROVED');
    expect((await pool.query("SELECT count(*)::int AS n FROM question_versions WHERE stable_key='ops09b-draft-code'")).rows[0].n).toBe(0);
  });
});

describe('answer keys', () => {
  it('are withheld from a publisher-only reader and shown to editors and reviewers', async () => {
    const { questionId } = await approvedQuestion('ops09b-keys');
    const asPublisher = await api().get(`${base}/questions/${questionId}`).set(auth(publisher.userId));
    expect(asPublisher.status).toBe(200);
    expect(asPublisher.body.question.open).toMatchObject({ answerKeyWithheld: true, tags: [] });
    expect(asPublisher.body.question.open.fields).toMatchObject({ correctOptionId: null, explanation: null });
    expect(asPublisher.body.question.open.fields.options.every((option: { misconception: unknown }) => option.misconception === null)).toBe(true);
    expect(asPublisher.body.question.misconceptionChoices).toEqual([]);
    expect(JSON.stringify(asPublisher.body)).not.toContain('Synthetic: it names the action');
    const asReviewer = await api().get(`${base}/questions/${questionId}`).set(auth(reviewer.userId));
    expect(asReviewer.body.question.open.fields).toMatchObject({ correctOptionId: 'b', explanation: 'Synthetic: it names the action and the deadline.' });
    expect(asReviewer.body.question.open.tags).toEqual([expect.objectContaining({ optionId: 'a', code: 'SYN_OPS09B_PUBLISHED', tagState: 'APPROVED' })]);
    // The approvals queue names the question, never its answer.
    const approvalId = await approvedPublish(asReviewer.body.question.open.id);
    const queue = await api().get('/api/v1/operations/approvals').query({ state: 'APPROVED' }).set(auth(publisher.userId));
    const filed = queue.body.approvals.find((entry: { id: string }) => entry.id === approvalId);
    expect(filed.summary).toMatchObject({ questionKey: 'ops09b-keys', questionRevision: 1, skillName: null });
    expect(JSON.stringify(filed)).not.toContain('correctOptionId');
  });

  it('never reach a learner: a republished pilot question supersedes its old version and the check strips the key', async () => {
    const pilotQuestion = fixture.assessment.questions[0]!;
    const started = await api().post(`${base}/questions/${pilotQuestion.id}/revisions`).set(auth(editor.userId)).send({ reasonCode: 'HINT_CHANGE' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const revisionId = started.body.question.open.id as string;
    expect(started.body.question.open.revision).toBe(2);
    // The pilot body is read as it is: its prompt, options and key carry into the draft.
    expect(started.body.question.open.fields).toMatchObject({ prompt: pilotQuestion.prompt, correctOptionId: pilotQuestion.correctOptionId });
    expect((await api().post(`${base}/questions/${pilotQuestion.id}/revisions`).set(auth(secondEditor.userId)).send({ reasonCode: 'HINT_CHANGE' })).body.error.code).toBe('QUESTION_OPEN_REVISION_EXISTS');
    const options = pilotQuestion.options.map((option) => ({ id: option.id, text: option.text }));
    expect((await save(editor, revisionId, { prompt: pilotQuestion.prompt, options, correctOptionId: pilotQuestion.correctOptionId, explanation: pilotQuestion.explanation })).status).toBe(201);
    expect((await transition(editor, revisionId, 'IN_REVIEW', 'READY_FOR_REVIEW')).status).toBe(201);
    expect((await transition(reviewer, revisionId, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).status).toBe(201);
    const approvalId = await approvedPublish(revisionId, 'QUESTION_REVISION');
    expect((await publish(publisher, revisionId, { reasonCode: 'QUESTION_REVISION', approvalId })).status).toBe(201);

    const versions = (await pool.query("SELECT id, version, superseded_at FROM question_versions WHERE stable_key=$1 ORDER BY version", [pilotQuestion.stableKey])).rows;
    expect(versions.map((row) => [row.version, row.superseded_at !== null])).toEqual([[1, true], [2, false]]);
    // The old version stays immutable apart from that one mark.
    await expect(pool.query("UPDATE question_versions SET prompt='changed' WHERE id=$1", [versions[0].id])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE question_versions SET superseded_at=NULL WHERE id=$1', [versions[0].id])).rejects.toThrow(/stays superseded/);
    await expect(pool.query('DELETE FROM question_hint_ladders WHERE question_revision_id=$1', [revisionId])).rejects.toThrow(/cannot be deleted/);

    // A learner starting the readiness check never sees version 1, and never sees a key, explanation, tag, hint or band.
    const attempt = await startAssessmentAttempt(pool, {
      subjectUserId: studentId, assessmentDefinitionId: fixture.assessment.id, correlationId: 'ops09b-attempt-' + randomUUID().slice(0, 8), selectionSeed: 'ops09b-seed-0001',
    });
    const questions = attempt.questions as { id: string; options: { id: string; text: string }[] }[];
    expect(questions.length).toBe(fixture.assessment.selectionCount);
    expect(questions.map((question) => question.id)).not.toContain(versions[0].id);
    for (const question of questions) {
      expect(Object.keys(question).sort()).toEqual(['id', 'options', 'prompt', 'publishedRevision', 'topicId']);
      for (const option of question.options) expect(Object.keys(option).sort()).toEqual(['id', 'text']);
    }
    const serialised = JSON.stringify(attempt);
    for (const secret of ['correctOptionId', 'correct_option_id', 'explanation', 'misconception', 'hint', 'difficulty', pilotQuestion.explanation]) {
      expect(serialised).not.toContain(secret);
    }
    const pool6 = (await pool.query(
      `SELECT count(*)::int AS n FROM question_versions q JOIN release_manifests rm ON rm.id = q.release_manifest_id AND rm.status='PUBLISHED'
       WHERE q.superseded_at IS NULL AND q.stable_key LIKE 'crf-%'`,
    )).rows[0].n;
    expect(pool6).toBe(fixture.assessment.questions.length);
  });
});
