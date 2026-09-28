/**
 * External faculty review over HTTP (OPS-10, ADR-037, migration 0066).
 *
 * A capability administrator grants CONTENT_REVIEW_EXTERNAL to a college faculty member; an
 * internal reviewer who did not write a draft assigns it; the faculty member sees only that draft,
 * only while the assignment is open, never an answer key, never a student, and records an advisory
 * decision that is audited — and publishing still needs internal reviewers and publishers. Cross-
 * tenant access (another college's path, another reviewer's assignment) finds nothing. Plus the
 * §6.6 minimums: 401, 403, 200, input 400s, pagination bounds, audit rows with reason codes.
 * Real Postgres in a throwaway schema.
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
import { publishCareerReadinessPilot, type PilotFixture } from '@planthepath/persistence/src/career-readiness.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for external review tests');

const schemaName = 'ops_external_review_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const KEY_MARKER = 'SYNTHETIC-ANSWER-KEY-MARKER';
const STUDENT_MARKER = 'synthetic-student-marker';
let app: INestApplication;
let platformId: string;
let collegeA: string;
let collegeB: string;
let topicKey: string;

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function user(email?: string): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email ?? userId + '@example.test']);
  return userId;
}

async function membership(userId: string, role: string, org: string): Promise<string> {
  const membershipId = randomUUID();
  const isPlatform = platformRoles.includes(role);
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$2,$5)`,
    [membershipId, org, userId, role, isPlatform ? null : org],
  );
  return membershipId;
}

async function member(role: string, grants: readonly string[] = [], org?: string): Promise<Member> {
  const userId = await user();
  const membershipId = await membership(userId, role, org ?? (platformRoles.includes(role) ? platformId : collegeA));
  for (const capability of grants) {
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
      [randomUUID(), membershipId, capability, superAdmin?.userId ?? userId],
    );
  }
  return { userId, membershipId };
}

let superAdmin: Member | undefined;
let superAdminFaculty: string;
let approver: Member;
let editor: Member;
let editorWhoReviews: Member;
let reviewer: Member;
let secondReviewer: Member;
let publisher: Member;
let plainOperations: Member;
let institutionAdmin: Member;
let facultyA: Member;
let headA: Member;
let facultyB: Member;
let ungrantedFaculty: Member;
let dual: { userId: string; opsMembershipId: string; facultyMembershipId: string };
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
  collegeA = randomUUID();
  collegeB = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic College A')", [collegeA]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic College B')", [collegeB]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  superAdminFaculty = await membership(superAdmin.userId, 'FACULTY_LECTURER', collegeA);
  // Two approvers, so the solo safeguard is off.
  approver = await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  editor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  editorWhoReviews = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  secondReviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  plainOperations = await member('OPERATIONS_ADMIN');
  institutionAdmin = await member('INSTITUTION_ADMIN', [], collegeA);
  facultyA = await member('FACULTY_LECTURER', [], collegeA);
  headA = await member('DEPARTMENT_HEAD', [], collegeA);
  facultyB = await member('FACULTY_LECTURER', [], collegeB);
  ungrantedFaculty = await member('FACULTY_LECTURER', [], collegeA);
  const dualUser = await user();
  dual = { userId: dualUser, opsMembershipId: await membership(dualUser, 'OPERATIONS_ADMIN', platformId), facultyMembershipId: await membership(dualUser, 'FACULTY_LECTURER', collegeA) };
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'CONTENT_EDIT',$3,'NEW_RESPONSIBILITY')", [randomUUID(), dual.opsMembershipId, superAdmin.userId]);
  // A student of college A. Nothing on the review path may ever carry them.
  studentId = await user(`${STUDENT_MARKER}@example.test`);
  await membership(studentId, 'STUDENT', collegeA).catch(() => undefined);

  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  const fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() });
  topicKey = fixture.topics[0]!.stableKey;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-external-' + randomUUID() });
const ops = '/api/v1/operations/external-reviews';
const queue = (college: string) => `/api/v1/institutions/${college}/content-reviews`;
const levels = { AWARE: 'Synthetic aware', GUIDED: 'Synthetic guided', INDEPENDENT: 'Synthetic independent', TROUBLESHOOT: 'Synthetic troubleshoot' };

function grant(actorId: string, membershipId: string, reasonCode = 'FACULTY_REVIEWER_AGREED') {
  return api().post(`${ops}/reviewers/${membershipId}/grant`).set(auth(actorId)).send({ reasonCode });
}
function assign(actorId: string, revisionIds: readonly string[], reviewerMembershipId: string, over: Record<string, unknown> = {}) {
  return api().post(`${ops}/assignments`).set(auth(actorId)).send({ revisionIds, reviewerMembershipId, days: 14, reasonCode: 'SUBJECT_EXPERT_REVIEW', ...over });
}
function decide(actorId: string, college: string, assignmentId: string, body: Record<string, unknown>) {
  return api().post(`${queue(college)}/${assignmentId}/decision`).set(auth(actorId)).send(body);
}

/** A skill submitted for review by `author`; returns its topic and revision. */
async function skillInReview(stableKey: string, author: string = editor.userId): Promise<{ topicId: string; revisionId: string }> {
  const created = await api().post('/api/v1/operations/skill-map/skills').set(auth(author)).send({ stableKey, name: `Synthetic ${stableKey}`, description: 'Synthetic skill for tests', reasonCode: 'NEW_SKILL' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const revisionId = created.body.skill.current.id as string;
  const saved = await api().post(`/api/v1/operations/skill-map/revisions/${revisionId}/draft`).set(auth(author)).send({
    name: `Synthetic ${stableKey}`, description: 'Synthetic description for tests', levels, prerequisites: [], licenceLabel: 'AI8HT-Owned', reasonCode: 'DRAFT_EDIT',
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  const submitted = await api().post(`/api/v1/operations/skill-map/revisions/${revisionId}/transition`).set(auth(author)).send({ toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  return { topicId: created.body.skill.topicId as string, revisionId };
}

/** A question with a planted answer key, submitted for review. */
async function questionInReview(stableKey: string): Promise<string> {
  const created = await api().post('/api/v1/operations/question-bank/questions').set(auth(editor.userId)).send({ stableKey, topicKey, prompt: 'Synthetic prompt', reasonCode: 'NEW_QUESTION' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const revisionId = created.body.question.open.id as string;
  const saved = await api().post(`/api/v1/operations/question-bank/revisions/${revisionId}/draft`).set(auth(editor.userId)).send({
    topicKey, prompt: 'Synthetic: which follow-up is clearest?',
    options: [{ id: 'a', text: 'Synthetic vague request' }, { id: 'b', text: 'Synthetic specific request' }, { id: 'c', text: 'Synthetic nudge' }],
    correctOptionId: 'b', explanation: `${KEY_MARKER} explanation`, difficulty: 'FOUNDATION',
    hints: [`${KEY_MARKER} hint 1`, `${KEY_MARKER} hint 2`, `${KEY_MARKER} hint 3`, `${KEY_MARKER} hint 4`],
    licenceLabel: 'AI8HT-Owned', basis: 'Synthetic basis', reasonCode: 'DRAFT_EDIT',
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  const submitted = await api().post(`/api/v1/operations/question-bank/revisions/${revisionId}/transition`).set(auth(editor.userId)).send({ toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  return revisionId;
}

async function auditRows(action: string, resourceId: string): Promise<{ organization_id: string; context: Record<string, unknown>; actor_user_id: string }[]> {
  return (await pool.query('SELECT organization_id, context, actor_user_id FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows;
}

describe('granting CONTENT_REVIEW_EXTERNAL', () => {
  it('lets a capability administrator grant faculty and department heads, audited with a reason code', async () => {
    const granted = await grant(superAdmin!.userId, facultyA.membershipId);
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body.reviewer).toMatchObject({ membershipId: facultyA.membershipId, role: 'FACULTY_LECTURER', institutionName: 'Synthetic College A', grant: { reasonCode: 'FACULTY_REVIEWER_AGREED' } });
    expect((await grant(superAdmin!.userId, headA.membershipId)).status).toBe(201);
    expect((await grant(superAdmin!.userId, facultyB.membershipId)).status).toBe(201);
    expect((await grant(superAdmin!.userId, dual.facultyMembershipId)).status).toBe(201);
    const [row] = await auditRows('operations.external_reviewer.granted', facultyA.membershipId);
    expect(row).toMatchObject({ organization_id: collegeA, actor_user_id: superAdmin!.userId, context: { capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: 'FACULTY_REVIEWER_AGREED' } });
    const outbox = (await pool.query("SELECT payload FROM outbox_events WHERE event_type='organization_membership.capability_granted' AND aggregate_id=$1", [facultyA.membershipId])).rows;
    expect(outbox).toEqual([{ payload: { membershipId: facultyA.membershipId, capability: 'CONTENT_REVIEW_EXTERNAL' } }]);
  });

  it('refuses non-administrators, ineligible memberships, a second grant, a self-grant and unlisted reasons', async () => {
    expect((await grant(reviewer.userId, ungrantedFaculty.membershipId)).status).toBe(403);
    expect((await grant(plainOperations.userId, ungrantedFaculty.membershipId)).status).toBe(403);
    expect((await grant(institutionAdmin.userId, ungrantedFaculty.membershipId)).status).toBe(403);
    const admin = await grant(superAdmin!.userId, institutionAdmin.membershipId);
    expect([admin.status, admin.body.error.code]).toEqual([409, 'EXTERNAL_REVIEWER_NOT_ELIGIBLE']);
    expect((await grant(superAdmin!.userId, reviewer.membershipId)).body.error.code).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    expect((await grant(superAdmin!.userId, facultyA.membershipId)).body.error.code).toBe('EXTERNAL_REVIEWER_ALREADY_GRANTED');
    const self = await grant(superAdmin!.userId, superAdminFaculty);
    expect([self.status, self.body.error.code]).toEqual([403, 'EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED']);
    expect((await grant(superAdmin!.userId, ungrantedFaculty.membershipId, 'BECAUSE')).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await api().post(`${ops}/reviewers/${ungrantedFaculty.membershipId}/grant`).set(auth(superAdmin!.userId)).send({ reasonCode: 'CORRECTION', extra: 1 })).status).toBe(400);
    expect((await grant(superAdmin!.userId, randomUUID())).status).toBe(404);
  });

  it('keeps the Settings staff screen from granting it, as OPS-01 left it', async () => {
    const response = await api().post(`/api/v1/operations/staff/${facultyA.membershipId}/capabilities`).set(auth(superAdmin!.userId))
      .send({ capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: 'NEW_RESPONSIBILITY' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('access (§6.6 minimums)', () => {
  it('401 without a token', async () => {
    await api().get(`${ops}/assignments`).expect(401);
    await api().get(queue(collegeA)).expect(401);
  });

  it('403 on the operator side for plain operations, institution staff and faculty reviewers', async () => {
    for (const userId of [plainOperations.userId, institutionAdmin.userId, facultyA.userId, headA.userId]) {
      expect((await api().get(`${ops}/assignments`).set(auth(userId))).status).toBe(403);
      expect((await api().get(`${ops}/policy`).set(auth(userId))).status).toBe(403);
    }
    expect((await assign(publisher.userId, [randomUUID()], facultyA.membershipId)).status).toBe(403);
    expect((await assign(editor.userId, [randomUUID()], facultyA.membershipId)).status).toBe(403);
  });

  it('403 on the faculty side without the grant, for another role, and in another college', async () => {
    for (const userId of [ungrantedFaculty.userId, institutionAdmin.userId, reviewer.userId, studentId]) {
      expect((await api().get(queue(collegeA)).set(auth(userId))).status).toBe(403);
    }
    expect((await api().get(queue(collegeB)).set(auth(facultyA.userId))).status).toBe(403);
    expect((await api().get(queue(collegeA)).set(auth(facultyB.userId))).status).toBe(403);
    expect((await api().get(queue('not-a-uuid')).set(auth(facultyA.userId))).status).toBe(403);
  });

  it('200 for content staff; the policy states the viewer powers and the reasons', async () => {
    const policy = await api().get(`${ops}/policy`).set(auth(reviewer.userId));
    expect(policy.status).toBe(200);
    expect(policy.body.viewer).toMatchObject({ read: true, assign: true, administer: false });
    expect(policy.body.window).toEqual({ min: 1, max: 30, default: 14 });
    expect((await api().get(`${ops}/policy`).set(auth(publisher.userId))).body.viewer).toMatchObject({ read: true, assign: false, administer: false });
    const reviewers = await api().get(`${ops}/reviewers`).set(auth(publisher.userId));
    expect(reviewers.status).toBe(200);
    expect(reviewers.body.summary.reviewers).toBeGreaterThanOrEqual(4);
  });

  it('looks up faculty by exact email only, and only for administrators and assigners', async () => {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [ungrantedFaculty.userId])).rows[0].email as string;
    const found = await api().get(`${ops}/reviewers/lookup`).query({ email: email.toUpperCase() }).set(auth(superAdmin!.userId));
    expect(found.status).toBe(200);
    expect(found.body.candidates).toEqual([expect.objectContaining({ membershipId: ungrantedFaculty.membershipId, grant: null })]);
    expect((await api().get(`${ops}/reviewers/lookup`).query({ email: email.slice(0, 8) }).set(auth(superAdmin!.userId))).status).toBe(400);
    expect((await api().get(`${ops}/reviewers/lookup`).query({ email }).set(auth(publisher.userId))).status).toBe(403);
  });
});

describe('assigning drafts', () => {
  it('assigns an item set to a granted reviewer, audited, and refuses what the rules refuse', async () => {
    const one = await skillInReview('ops10-set-one');
    const two = await skillInReview('ops10-set-two');
    const created = await assign(reviewer.userId, [one.revisionId, two.revisionId], facultyA.membershipId, { reasonCode: 'CURRICULUM_ALIGNMENT', days: 7 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.assignments).toHaveLength(2);
    expect(created.body.assignments[0]).toMatchObject({ status: 'OPEN', reasonCode: 'CURRICULUM_ALIGNMENT', revision: { entityType: 'TOPIC', stableKey: 'ops10-set-one' }, reviewer: { membershipId: facultyA.membershipId, eligible: true } });
    const window = (await pool.query('SELECT extract(epoch FROM expires_at - assigned_at)::int AS seconds FROM external_review_assignments WHERE id=$1', [created.body.assignments[0].id])).rows[0].seconds;
    expect(window).toBe(7 * 86_400);
    const [row] = await auditRows('operations.external_review.assigned', created.body.assignments[0].id);
    expect(row).toMatchObject({ organization_id: collegeA, context: { revisionId: one.revisionId, entityType: 'TOPIC', reasonCode: 'CURRICULUM_ALIGNMENT', days: 7 } });

    expect((await assign(reviewer.userId, [one.revisionId], facultyA.membershipId)).body.error.code).toBe('EXTERNAL_REVIEW_ALREADY_ASSIGNED');
    expect((await assign(reviewer.userId, [one.revisionId], ungrantedFaculty.membershipId)).body.error.code).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    expect((await assign(reviewer.userId, [one.revisionId], facultyA.membershipId, { days: 31 })).body.error.code).toBe('EXTERNAL_REVIEW_WINDOW_INVALID');
    expect((await assign(reviewer.userId, [one.revisionId], facultyA.membershipId, { reasonCode: 'BECAUSE' })).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await assign(reviewer.userId, [], facultyA.membershipId)).status).toBe(400);
    expect((await assign(reviewer.userId, [one.revisionId], facultyA.membershipId, { extra: true })).status).toBe(400);
    expect((await assign(reviewer.userId, [randomUUID()], facultyA.membershipId)).status).toBe(404);
    // All or none: one bad revision in a set writes nothing.
    const before = (await pool.query('SELECT count(*)::int AS n FROM external_review_assignments')).rows[0].n;
    const three = await skillInReview('ops10-set-three');
    expect((await assign(reviewer.userId, [three.revisionId, randomUUID()], headA.membershipId)).status).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM external_review_assignments')).rows[0].n).toBe(before);
  });

  it('refuses contributors: an editor cannot assign, and an author cannot be the reviewer (API and trigger)', async () => {
    const edited = await skillInReview('ops10-contributor', editorWhoReviews.userId);
    const byContributor = await assign(editorWhoReviews.userId, [edited.revisionId], facultyA.membershipId);
    expect([byContributor.status, byContributor.body.error.code]).toEqual([403, 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED']);
    const authored = await skillInReview('ops10-dual-author', dual.userId);
    const toAuthor = await assign(reviewer.userId, [authored.revisionId], dual.facultyMembershipId);
    expect([toAuthor.status, toAuthor.body.error.code]).toEqual([403, 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED']);
    const hash = (await pool.query('SELECT content_hash FROM content_revisions WHERE id=$1', [authored.revisionId])).rows[0].content_hash;
    await expect(pool.query(
      `INSERT INTO external_review_assignments (id,content_revision_id,content_hash,reviewer_membership_id,reviewer_user_id,institution_id,assigned_by_user_id,expires_at,reason_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '5 days','SUBJECT_EXPERT_REVIEW')`,
      [randomUUID(), authored.revisionId, hash, dual.facultyMembershipId, dual.userId, collegeA, reviewer.userId],
    )).rejects.toThrow(/author of a revision may not review it/);
    // The trigger also refuses a reviewer without the grant, and a draft that is not in review.
    await expect(pool.query(
      `INSERT INTO external_review_assignments (id,content_revision_id,content_hash,reviewer_membership_id,reviewer_user_id,institution_id,assigned_by_user_id,expires_at,reason_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '5 days','SUBJECT_EXPERT_REVIEW')`,
      [randomUUID(), authored.revisionId, hash, ungrantedFaculty.membershipId, ungrantedFaculty.userId, collegeA, reviewer.userId],
    )).rejects.toThrow(/holding CONTENT_REVIEW_EXTERNAL/);
    await expect(pool.query('DELETE FROM external_review_assignments')).rejects.toThrow(/never deleted/);
  });

  it('marks a super admin assignment as break-glass', async () => {
    const skill = await skillInReview('ops10-break-glass');
    const created = await assign(superAdmin!.userId, [skill.revisionId], headA.membershipId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [row] = await auditRows('operations.external_review.assigned', created.body.assignments[0].id);
    expect(row!.context.break_glass).toBe(true);
  });

  it('paginates the operator list with bounds', async () => {
    const first = await api().get(`${ops}/assignments`).query({ limit: '1' }).set(auth(publisher.userId));
    expect(first.status).toBe(200);
    expect(first.body.assignments).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get(`${ops}/assignments`).query({ limit: '1', cursor: first.body.nextCursor }).set(auth(publisher.userId));
    expect(second.body.assignments[0].id).not.toBe(first.body.assignments[0].id);
    for (const limit of ['0', '201', 'x']) expect((await api().get(`${ops}/assignments`).query({ limit }).set(auth(publisher.userId))).status).toBe(400);
    expect((await api().get(`${ops}/assignments`).query({ status: 'NOPE' }).set(auth(publisher.userId))).status).toBe(400);
    expect((await api().get(`${ops}/assignments`).query({ other: '1' }).set(auth(publisher.userId))).status).toBe(400);
    const open = await api().get(`${ops}/assignments`).query({ status: 'OPEN' }).set(auth(publisher.userId));
    expect(open.body.assignments.every((entry: { status: string }) => entry.status === 'OPEN')).toBe(true);
  });
});

describe('the faculty reviewer', () => {
  it('sees only their own assignments, and a question without its answer key, hints or any student', async () => {
    const revisionId = await questionInReview('ops10-question');
    const created = await assign(reviewer.userId, [revisionId], facultyA.membershipId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const assignmentId = created.body.assignments[0].id as string;

    const list = await api().get(queue(collegeA)).set(auth(facultyA.userId));
    expect(list.status).toBe(200);
    expect(list.body.assignments.map((entry: { id: string }) => entry.id)).toContain(assignmentId);
    const others = (await pool.query('SELECT id FROM external_review_assignments WHERE reviewer_user_id <> $1', [facultyA.userId])).rows.map((row) => row.id as string);
    expect(others.length).toBeGreaterThan(0);
    for (const id of others) expect(list.body.assignments.map((entry: { id: string }) => entry.id)).not.toContain(id);

    const detail = await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(facultyA.userId));
    expect(detail.status).toBe(200);
    expect(detail.body.review).toMatchObject({
      status: 'OPEN', kind: 'QUESTION',
      content: { kind: 'QUESTION', prompt: 'Synthetic: which follow-up is clearest?', options: [{ id: 'a', text: 'Synthetic vague request' }, { id: 'b', text: 'Synthetic specific request' }, { id: 'c', text: 'Synthetic nudge' }], difficulty: 'FOUNDATION' },
    });
    const serialised = JSON.stringify([list.body, detail.body]);
    expect(serialised).not.toContain(KEY_MARKER);
    expect(serialised).not.toContain('correctOptionId');
    expect(serialised).not.toContain(STUDENT_MARKER);
    expect(serialised).not.toContain(studentId);
    expect(serialised).not.toContain('@example.test');

    // Cross-tenant and cross-person: nothing to find.
    expect((await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(headA.userId))).status).toBe(404);
    expect((await api().get(`${queue(collegeB)}/${assignmentId}`).set(auth(facultyB.userId))).status).toBe(404);
    expect((await api().get(`${queue(collegeB)}/${assignmentId}`).set(auth(facultyA.userId))).status).toBe(403);
    expect((await decide(facultyB.userId, collegeB, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED' })).status).toBe(404);
    // A student's identifiers lead nowhere on this path.
    expect((await api().get(`${queue(collegeA)}/${studentId}`).set(auth(facultyA.userId))).status).toBe(404);
  });

  it('records an advisory decision, audited; the revision stays in review and publishing stays internal', async () => {
    const skill = await skillInReview('ops10-journey');
    const created = await assign(reviewer.userId, [skill.revisionId], facultyA.membershipId);
    const assignmentId = created.body.assignments[0].id as string;
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'REQUEST_CHANGES', reasonCode: 'LEVEL_MISMATCH' })).body.error.code).toBe('EXTERNAL_REVIEW_COMMENT_REQUIRED');
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'LEVEL_MISMATCH' })).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'MAYBE', reasonCode: 'REVIEW_PASSED' })).status).toBe(400);
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED', extra: 1 })).status).toBe(400);
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED', comment: 'x'.repeat(2001) })).body.error.code).toBe('EXTERNAL_REVIEW_COMMENT_TOO_LONG');

    const decided = await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED', comment: 'Synthetic: levels read well.' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    expect(decided.body.review).toMatchObject({ status: 'DECIDED', decision: { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED', comment: 'Synthetic: levels read well.' } });
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED' })).body.error.code).toBe('EXTERNAL_REVIEW_NOT_OPEN');
    const [row] = await auditRows('institution.content_review.decided', assignmentId);
    expect(row).toMatchObject({ organization_id: collegeA, actor_user_id: facultyA.userId, context: { revisionId: skill.revisionId, decision: 'APPROVE', reasonCode: 'REVIEW_PASSED', commentLength: 28 } });
    expect(JSON.stringify(row!.context)).not.toContain('levels read well');
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='external_review.decided' AND aggregate_id=$1", [assignmentId])).rows)
      .toEqual([{ payload: { assignmentId, revisionId: skill.revisionId, decision: 'APPROVE' } }]);

    // Advisory: the revision is still in review; the faculty member cannot approve or publish it.
    expect((await pool.query('SELECT state FROM content_revisions WHERE id=$1', [skill.revisionId])).rows[0].state).toBe('IN_REVIEW');
    expect((await api().post(`/api/v1/operations/skill-map/revisions/${skill.revisionId}/transition`).set(auth(facultyA.userId)).send({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' })).status).toBe(403);
    expect((await api().post(`/api/v1/operations/skill-map/revisions/${skill.revisionId}/publish`).set(auth(facultyA.userId)).send({ reasonCode: 'NEW_SKILL' })).status).toBe(403);

    // The operator sees the decision beside the draft; then internal people approve and publish.
    const seen = await api().get(`${ops}/assignments`).query({ revisionId: skill.revisionId }).set(auth(publisher.userId));
    expect(seen.body.assignments[0]).toMatchObject({ status: 'DECIDED', decision: { decision: 'APPROVE', comment: 'Synthetic: levels read well.' } });
    const approved = await api().post(`/api/v1/operations/skill-map/revisions/${skill.revisionId}/transition`).set(auth(secondReviewer.userId)).send({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const filed = await api().post('/api/v1/operations/approvals').set(auth(publisher.userId)).send({ actionKey: 'CONTENT_SKILL_PUBLISH', payload: { revisionId: skill.revisionId, reasonCode: 'NEW_SKILL' } });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect((await api().post(`/api/v1/operations/approvals/${filed.body.approval.id}/decision`).set(auth(approver.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' })).status).toBe(201);
    const published = await api().post(`/api/v1/operations/skill-map/revisions/${skill.revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_SKILL', approvalId: filed.body.approval.id });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
  });

  it('closes an assignment when the revision leaves review, and hides the draft', async () => {
    const skill = await skillInReview('ops10-closed');
    const assignmentId = (await assign(reviewer.userId, [skill.revisionId], facultyA.membershipId)).body.assignments[0].id as string;
    const changes = await api().post(`/api/v1/operations/skill-map/revisions/${skill.revisionId}/transition`).set(auth(reviewer.userId)).send({ toState: 'CHANGES_REQUESTED', reasonCode: 'CONTENT_INACCURATE' });
    expect(changes.status, JSON.stringify(changes.body)).toBe(201);
    const detail = await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(facultyA.userId));
    expect(detail.body.review).toMatchObject({ status: 'CLOSED', title: null, content: null });
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED' })).body.error.code).toBe('EXTERNAL_REVIEW_NOT_OPEN');
  });

  it('expires an assignment: no draft, no decision (API and trigger)', async () => {
    const skill = await skillInReview('ops10-expired');
    const assignmentId = (await assign(reviewer.userId, [skill.revisionId], facultyA.membershipId, { days: 1 })).body.assignments[0].id as string;
    // Move the assignment back in time. The trigger forbids this, so it is bypassed by the owner.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE external_review_assignments DISABLE TRIGGER external_review_assignment_guard');
      await client.query("UPDATE external_review_assignments SET assigned_at = assigned_at - interval '2 days', expires_at = expires_at - interval '2 days' WHERE id=$1", [assignmentId]);
      await client.query('ALTER TABLE external_review_assignments ENABLE TRIGGER external_review_assignment_guard');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(facultyA.userId))).body.review).toMatchObject({ status: 'EXPIRED', content: null });
    expect((await decide(facultyA.userId, collegeA, assignmentId, { decision: 'APPROVE', reasonCode: 'REVIEW_PASSED' })).body.error.code).toBe('EXTERNAL_REVIEW_EXPIRED');
    await expect(pool.query("UPDATE external_review_assignments SET state='DECIDED', decision='APPROVE', decision_reason_code='REVIEW_PASSED', decided_at=now() WHERE id=$1", [assignmentId]))
      .rejects.toThrow(/expired/);
  });

  it('loses access when an assignment is withdrawn or the grant is revoked', async () => {
    const one = await skillInReview('ops10-withdrawn');
    const two = await skillInReview('ops10-grant-revoked');
    const withdrawnId = (await assign(reviewer.userId, [one.revisionId], headA.membershipId)).body.assignments[0].id as string;
    const withdrawn = await api().post(`${ops}/assignments/${withdrawnId}/revoke`).set(auth(reviewer.userId)).send({ reasonCode: 'REASSIGNED' });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(201);
    expect(withdrawn.body.assignment).toMatchObject({ status: 'REVOKED', revoked: { reasonCode: 'REASSIGNED' } });
    expect((await api().get(`${queue(collegeA)}/${withdrawnId}`).set(auth(headA.userId))).body.review).toMatchObject({ status: 'REVOKED', content: null });
    expect((await api().post(`${ops}/assignments/${withdrawnId}/revoke`).set(auth(reviewer.userId)).send({ reasonCode: 'REASSIGNED' })).body.error.code).toBe('EXTERNAL_REVIEW_NOT_OPEN');

    const openId = (await assign(reviewer.userId, [two.revisionId], headA.membershipId)).body.assignments[0].id as string;
    expect((await api().post(`${ops}/reviewers/${headA.membershipId}/revoke`).set(auth(reviewer.userId)).send({ reasonCode: 'COLLEGE_REQUEST' })).status).toBe(403);
    const stillOpen = (await pool.query("SELECT count(*)::int AS n FROM external_review_assignments WHERE reviewer_membership_id=$1 AND state='ASSIGNED'", [headA.membershipId])).rows[0].n as number;
    expect(stillOpen).toBeGreaterThanOrEqual(1);
    const revoked = await api().post(`${ops}/reviewers/${headA.membershipId}/revoke`).set(auth(superAdmin!.userId)).send({ reasonCode: 'COLLEGE_REQUEST' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(201);
    expect(revoked.body.reviewer).toMatchObject({ grant: null, closedAssignments: stillOpen, openAssignments: 0 });
    expect((await pool.query('SELECT state, revoked_reason_code FROM external_review_assignments WHERE id=$1', [openId])).rows[0]).toEqual({ state: 'REVOKED', revoked_reason_code: 'GRANT_REVOKED' });
    expect((await api().get(queue(collegeA)).set(auth(headA.userId))).status).toBe(403);
    expect((await api().get(`${queue(collegeA)}/${openId}`).set(auth(headA.userId))).status).toBe(403);
    expect(await auditRows('operations.external_reviewer.revoked', headA.membershipId)).toHaveLength(1);
  });

  it('loses access when the college ends the membership', async () => {
    const skill = await skillInReview('ops10-membership-ended');
    const leaver = await member('FACULTY_LECTURER', [], collegeA);
    expect((await grant(superAdmin!.userId, leaver.membershipId)).status).toBe(201);
    const assignmentId = (await assign(reviewer.userId, [skill.revisionId], leaver.membershipId)).body.assignments[0].id as string;
    expect((await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(leaver.userId))).status).toBe(200);
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [leaver.membershipId]);
    expect((await api().get(`${queue(collegeA)}/${assignmentId}`).set(auth(leaver.userId))).status).toBe(403);
    const listed = await api().get(`${ops}/assignments`).query({ revisionId: skill.revisionId }).set(auth(reviewer.userId));
    expect(listed.body.assignments[0].reviewer.eligible).toBe(false);
  });
});
