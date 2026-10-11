/**
 * Content bulk import over HTTP (OPS-09d).
 *
 * A CSV or JSON file of skills, questions, lessons or lesson variants is previewed (a row-level
 * validation report and a digest, with no content written) and committed (exactly the previewed
 * file, all rows or none). Every row goes through the editors' own functions and lands as a DRAFT
 * authored by the importer, so the editors' rules apply — key uniqueness, the acyclic prerequisite
 * check, known skills and misconception codes, a live base for a variant — and the importer can
 * never review or publish what they imported. An invalid file shows row-level errors and writes
 * nothing; a stale digest writes nothing; answer keys appear in no response, audit row or outbox
 * payload and reach no learner table. Plus the §6.6 minimums: 401, 403, 200, input 400s, audit rows
 * with reason codes. Real Postgres in a throwaway schema; synthetic data only.
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
import { createMisconceptionCodeDraft } from '@planthepath/persistence/src/misconceptions.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for content import tests');

const schemaName = 'ops_import_' + randomUUID().replaceAll('-', '');
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

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function user(): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  return userId;
}

let superAdmin: Member | undefined;
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

let editor: Member;
let importerWhoReviewsAndPublishes: Member;
let reviewer: Member;
let publisher: Member;
let catalogueManager: Member;
let plainOperations: Member;
let institutionAdmin: Member;

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
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Content import college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  editor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  importerWhoReviewsAndPublishes = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  catalogueManager = await member('OPERATIONS_ADMIN', ['CATALOGUE_MANAGE']);
  plainOperations = await member('OPERATIONS_ADMIN');
  institutionAdmin = await member('INSTITUTION_ADMIN');

  // The pilot: live topics, one published module and its lessons.
  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const actors = { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() };
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  moduleKey = fixture.module.stableKey;
  topicKey = fixture.topics[0]!.stableKey;

  // ENG-07 misconception codes: one on the first topic, one on another topic.
  const codeAuthor = await user();
  const codeInput = (code: string, skillId: string) => ({
    code, skillId, title: `Synthetic ${code}`, description: 'Synthetic misconception for OPS-09d tests.', source: 'AUTHORED' as const,
    basis: 'Synthetic basis', authorUserId: codeAuthor,
  });
  await createMisconceptionCodeDraft(db, codeInput('SYN_OPS09D_CODE', fixture.topics[0]!.id));
  await createMisconceptionCodeDraft(db, codeInput('SYN_OPS09D_OTHER', fixture.topics[1]!.id));
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string, correlationId = 'ops-import-' + randomUUID()) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': correlationId });
const base = '/api/v1/operations/content-imports';

function preview(actor: Member, kind: string, content: string, format = 'CSV') {
  return api().post(`${base}/preview`).set(auth(actor.userId)).send({ kind, format, filename: `synthetic.${format.toLowerCase()}`, content });
}
function commit(actor: Member, kind: string, content: string, previewDigest: string, format = 'CSV', reasonCode = 'TRACK_BUILD', correlationId?: string) {
  return api().post(`${base}/commit`).set(auth(actor.userId, correlationId)).send({ kind, format, filename: `synthetic.${format.toLowerCase()}`, content, previewDigest, reasonCode });
}

/** Everything an import could write, counted. */
async function snapshot(): Promise<Record<string, number>> {
  const tables = ['content_revisions', 'taxonomy_nodes', 'lesson_versions', 'question_versions', 'question_answer_keys', 'question_hint_ladders',
    'question_option_misconceptions', 'content_review_actions', 'source_records', 'release_manifests', 'audit_events', 'outbox_events'];
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  return counts;
}

async function revisionFor(entityType: string, stableKey: string): Promise<{ id: string; state: string; author_user_id: string; body: Record<string, unknown> } | undefined> {
  const found = await pool.query(
    "SELECT id, state, author_user_id, body FROM content_revisions WHERE entity_type = $1 AND body ->> 'stableKey' = $2 ORDER BY revision DESC LIMIT 1",
    [entityType, stableKey],
  );
  return found.rows[0];
}

const skillHeader = 'stable_key,name,description,level_aware,level_guided,level_independent,level_troubleshoot,prerequisites,licence,attribution,basis';
const skillRow = (key: string, prerequisites = '') => `${key},Synthetic ${key},"Synthetic description, with a comma",aware,guided,independent,troubleshoot,${prerequisites},AI8HT-Owned,,Synthetic basis`;

describe('access (§6.6)', () => {
  it('401 without a token', async () => {
    await api().get(`${base}/policy`).expect(401);
    await api().post(`${base}/preview`).send({ kind: 'SKILL', format: 'CSV', content: 'x' }).expect(401);
  });

  it('403 for anyone without CONTENT_EDIT, on every endpoint', async () => {
    for (const actor of [reviewer, publisher, catalogueManager, plainOperations, institutionAdmin]) {
      await api().get(`${base}/policy`).set(auth(actor.userId)).expect(403);
      await preview(actor, 'SKILL', `${skillHeader}\n${skillRow('syn-forbidden')}\n`).expect(403);
      await commit(actor, 'SKILL', `${skillHeader}\n${skillRow('syn-forbidden')}\n`, 'a'.repeat(64)).expect(403);
    }
    expect(await revisionFor('TOPIC', 'syn-forbidden')).toBeUndefined();
  });

  it('200 policy for an editor: kinds with their fields, caps and reason codes', async () => {
    const response = await api().get(`${base}/policy`).set(auth(editor.userId)).expect(200);
    expect(response.body.kinds.map((entry: { kind: string }) => entry.kind)).toEqual(['SKILL', 'QUESTION', 'LESSON', 'LESSON_VARIANT']);
    expect(response.body.kinds[1].required).toEqual(['stable_key', 'skill_key', 'prompt']);
    expect(response.body.limits).toEqual({ rows: 200, characters: 90_000, filename: 160 });
    expect(response.body.reasons).toEqual(['TRACK_BUILD', 'CONTENT_MIGRATION', 'EXPERT_BATCH']);
  });

  it('400 for malformed requests, before anything is evaluated', async () => {
    const good = { kind: 'SKILL', format: 'CSV', filename: 'x.csv', content: `${skillHeader}\n${skillRow('syn-malformed')}\n` };
    const post = (path: string, body: unknown) => api().post(`${base}/${path}`).set(auth(editor.userId)).send(body as object);
    expect((await post('preview', { ...good, extra: 1 }).expect(400)).body.error.code).toBe('INVALID_REQUEST');
    expect((await post('preview', { ...good, kind: 'RUBRIC' }).expect(400)).body.error.code).toBe('IMPORT_KIND_INVALID');
    expect((await post('preview', { ...good, format: 'XLSX' }).expect(400)).body.error.code).toBe('IMPORT_FORMAT_INVALID');
    expect((await post('preview', { ...good, content: '' }).expect(400)).body.error.code).toBe('IMPORT_FILE_EMPTY');
    expect((await post('preview', { ...good, content: 'x'.repeat(90_001) }).expect(400)).body.error.code).toBe('IMPORT_FILE_TOO_LARGE');
    expect((await post('preview', { ...good, filename: 'x'.repeat(161) }).expect(400)).body.error.code).toBe('IMPORT_FILENAME_INVALID');
    expect((await post('preview', { ...good, previewDigest: 'a'.repeat(64) }).expect(400)).body.error.code).toBe('INVALID_REQUEST');
    expect((await post('commit', { ...good, reasonCode: 'TRACK_BUILD' }).expect(400)).body.error.code).toBe('PREVIEW_DIGEST_REQUIRED');
    expect((await post('commit', { ...good, previewDigest: 'a'.repeat(64), reasonCode: 'PUBLISH_NOW' }).expect(400)).body.error.code).toBe('REASON_CODE_INVALID');
    expect(await revisionFor('TOPIC', 'syn-malformed')).toBeUndefined();
  });
});

describe('an invalid file shows row-level errors and writes nothing', () => {
  it('reports every bad row, then refuses the commit with nothing written', async () => {
    const content = [
      skillHeader,
      skillRow('syn-bad-ok'),
      'syn-bad-missing,Missing,,,,,,,,,',
      skillRow(topicKey), // a key the pilot already uses
      skillRow('syn-bad-cycle-a', 'syn-bad-cycle-b'),
      skillRow('syn-bad-cycle-b', 'syn-bad-cycle-a'),
      skillRow('syn-bad-unknown', 'syn-no-such-skill'),
      skillRow('BAD KEY'),
    ].join('\n');
    const before = await snapshot();
    const response = await preview(editor, 'SKILL', content).expect(201);
    const report = response.body.preview;
    expect(report.counts).toEqual({ create: 2, invalid: 5 });
    const byRow = new Map<number, { outcome: string; issues: string[] }>(report.rows.map((row: { rowNumber: number; outcome: string; issues: string[] }) => [row.rowNumber, row]));
    expect(byRow.get(2)).toMatchObject({ outcome: 'CREATE', issues: [] });
    expect(byRow.get(3)!.issues).toEqual(['IMPORT_FIELD_REQUIRED:description']);
    expect(byRow.get(4)!.issues).toEqual(['SKILL_KEY_EXISTS']);
    // The first of the two to be saved is fine on its own; the second closes the cycle.
    expect([...byRow.get(5)!.issues, ...byRow.get(6)!.issues]).toEqual(['SKILL_PREREQUISITE_CYCLE']);
    expect(byRow.get(7)!.issues).toEqual(['SKILL_PREREQUISITE_UNKNOWN:syn-no-such-skill']);
    expect(byRow.get(8)!.issues).toEqual(['SKILL_KEY_INVALID']);
    // The preview wrote only its own audit row.
    const afterPreview = await snapshot();
    expect(afterPreview).toEqual({ ...before, audit_events: before.audit_events! + 1 });
    expect(await revisionFor('TOPIC', 'syn-bad-ok')).toBeUndefined();

    const refused = await commit(editor, 'SKILL', content, report.digest).expect(400);
    expect(refused.body.error.code).toBe('IMPORT_HAS_INVALID_ROWS');
    expect(refused.body.preview.counts).toEqual({ create: 2, invalid: 5 });
    expect(await snapshot()).toEqual(afterPreview);
    expect(await revisionFor('TOPIC', 'syn-bad-ok')).toBeUndefined();
  });

  it('refuses unknown columns as a file problem and writes nothing', async () => {
    const content = `${skillHeader},score\n${skillRow('syn-bad-column')},5\n`;
    const report = (await preview(editor, 'SKILL', content).expect(201)).body.preview;
    expect(report.fileProblems).toEqual(['IMPORT_COLUMN_UNKNOWN:score']);
    expect(report.rows).toEqual([]);
    const before = await snapshot();
    expect((await commit(editor, 'SKILL', content, report.digest).expect(400)).body.error.code).toBe('IMPORT_FILE_INVALID');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses unknown JSON fields on their row and writes nothing', async () => {
    const content = JSON.stringify([
      { stable_key: 'syn-json-a', name: 'A', description: 'B' },
      { stable_key: 'syn-json-b', name: 'B', description: 'C', publish: 'yes' },
    ]);
    const report = (await preview(editor, 'SKILL', content, 'JSON').expect(201)).body.preview;
    expect(report.rows.map((row: { issues: string[] }) => row.issues)).toEqual([[], ['IMPORT_FIELD_UNKNOWN:publish']]);
    const before = await snapshot();
    expect((await commit(editor, 'SKILL', content, report.digest, 'JSON').expect(400)).body.error.code).toBe('IMPORT_HAS_INVALID_ROWS');
    expect(await snapshot()).toEqual(before);
    expect(await revisionFor('TOPIC', 'syn-json-a')).toBeUndefined();
  });

  it('refuses a commit whose file differs from the preview (stale digest) and writes nothing', async () => {
    const previewed = `${skillHeader}\n${skillRow('syn-stale')}\n`;
    const report = (await preview(editor, 'SKILL', previewed).expect(201)).body.preview;
    expect(report.counts).toEqual({ create: 1, invalid: 0 });
    const changed = previewed.replace(',aware,guided,', ',aware now,guided,');
    const before = await snapshot();
    const refused = await commit(editor, 'SKILL', changed, report.digest).expect(409);
    expect(refused.body.error.code).toBe('IMPORT_STALE');
    expect(refused.body.preview.digest).not.toBe(report.digest);
    expect(await snapshot()).toEqual(before);
  });

  it('a second commit of the same file finds its keys taken and writes nothing more', async () => {
    const content = `${skillHeader}\n${skillRow('syn-twice')}\n`;
    const report = (await preview(editor, 'SKILL', content).expect(201)).body.preview;
    await commit(editor, 'SKILL', content, report.digest).expect(201);
    const before = await snapshot();
    const again = await commit(editor, 'SKILL', content, report.digest).expect(400);
    expect(again.body.error.code).toBe('IMPORT_HAS_INVALID_ROWS');
    expect(again.body.preview.rows[0].issues).toEqual(['SKILL_KEY_EXISTS']);
    expect(await snapshot()).toEqual(before);
  });
});

describe('a valid file lands as drafts, through the editors', () => {
  it('imports skills in prerequisite order, all DRAFT, authored and audited', async () => {
    const correlationId = 'ops-import-skills-' + randomUUID();
    // The first row requires the second, defined later in the file.
    const content = `${skillHeader}\n${skillRow('syn-skill-top', 'syn-skill-base')}\n${skillRow('syn-skill-base')}\n`;
    const report = (await preview(editor, 'SKILL', content).expect(201)).body.preview;
    expect(report.counts).toEqual({ create: 2, invalid: 0 });
    const done = await commit(editor, 'SKILL', content, report.digest, 'CSV', 'CONTENT_MIGRATION', correlationId).expect(201);
    expect(done.body.import).toMatchObject({ kind: 'SKILL', created: 2, keys: ['syn-skill-top', 'syn-skill-base'] });

    const top = await revisionFor('TOPIC', 'syn-skill-top');
    expect(top).toMatchObject({ state: 'DRAFT', author_user_id: editor.userId });
    expect(top!.body).toMatchObject({ prerequisites: ['syn-skill-base'], levels: { AWARE: 'aware' }, rights: { licenceLabel: 'AI8HT-Owned' } });
    const node = await pool.query("SELECT active FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = 'syn-skill-top'");
    expect(node.rows[0].active).toBe(false);

    const audits = await pool.query('SELECT action, context FROM audit_events WHERE correlation_id = $1 ORDER BY occurred_at, action', [correlationId]);
    const actions = audits.rows.map((row) => row.action as string);
    expect(actions.filter((action) => action === 'operations.content.skill_created')).toHaveLength(2);
    expect(actions.filter((action) => action === 'operations.content.skill_draft_saved')).toHaveLength(2);
    const created = audits.rows.find((row) => row.action === 'operations.content.skill_created');
    expect(created.context.reasonCode).toBe('CONTENT_MIGRATION');
    const committed = audits.rows.find((row) => row.action === 'operations.content.import_committed');
    expect(committed.context).toMatchObject({ kind: 'SKILL', format: 'CSV', reasonCode: 'CONTENT_MIGRATION', created: 2, digest: report.digest });
    // Nothing leaves DRAFT on import.
    const states = await pool.query("SELECT DISTINCT state FROM content_revisions WHERE body ->> 'stableKey' IN ('syn-skill-top','syn-skill-base')");
    expect(states.rows).toEqual([{ state: 'DRAFT' }]);
  });

  it('the importer can never review or publish what they imported', async () => {
    const importer = importerWhoReviewsAndPublishes;
    const content = `${skillHeader}\n${skillRow('syn-self-review')}\n`;
    const report = (await preview(importer, 'SKILL', content).expect(201)).body.preview;
    await commit(importer, 'SKILL', content, report.digest).expect(201);
    const revision = await revisionFor('TOPIC', 'syn-self-review');
    const move = (actor: Member, toState: string, reasonCode: string, rightsReasonCode?: string) => api()
      .post(`/api/v1/operations/skill-map/revisions/${revision!.id}/transition`).set(auth(actor.userId))
      .send({ toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}) });
    await move(importer, 'IN_REVIEW', 'READY_FOR_REVIEW').expect(201);
    expect((await move(importer, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED').expect(403)).body.error.code).toBe('SKILL_SELF_REVIEW_REFUSED');
    await move(reviewer, 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED').expect(201);
    const publish = await api().post(`/api/v1/operations/skill-map/revisions/${revision!.id}/publish`).set(auth(importer.userId)).send({ reasonCode: 'NEW_SKILL' }).expect(403);
    expect(publish.body.error.code).toBe('SKILL_SELF_PUBLISH_REFUSED');
    const node = await pool.query("SELECT active FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = 'syn-self-review'");
    expect(node.rows[0].active).toBe(false);
  });

  it('imports questions with answer keys, hints and misconception tags — and no answer leaves the content tables', async () => {
    const correlationId = 'ops-import-questions-' + randomUUID();
    const header = 'stable_key,skill_key,prompt,option_a,option_b,option_c,correct_option,explanation,difficulty,hint_1,hint_2,hint_3,hint_4,misconception_a,rationale_a,misconception_c,rationale_c,licence,basis';
    const row = (key: string, codeC = 'SYN_OPS09D_CODE') => `${key},${topicKey},"Synthetic prompt for ${key}?",Alpha,ZZ-SECRET-CORRECT-OPTION,Gamma,b,ZZ-SECRET-EXPLANATION,FOUNDATION,h1,h2,h3,h4,SYN_OPS09D_CODE,Synthetic rationale a,${codeC},Synthetic rationale c,AI8HT-Owned,Synthetic basis`;
    const invalid = [header, row('syn-q-good'), row('syn-q-other-topic', 'SYN_OPS09D_OTHER'), row('syn-q-unknown-code', 'SYN_NO_SUCH_CODE'),
      `syn-q-bad-skill,no-such-skill,Prompt,A,B,,a,E,,,,,,,,,,,`].join('\n');
    const report = (await preview(editor, 'QUESTION', invalid).expect(201)).body.preview;
    expect(report.rows.map((entry: { key: string; issues: string[] }) => [entry.key, entry.issues])).toEqual([
      ['syn-q-good', []],
      ['syn-q-other-topic', ['QUESTION_MISCONCEPTION_UNKNOWN:c']],
      ['syn-q-unknown-code', ['IMPORT_MISCONCEPTION_UNKNOWN:c']],
      ['syn-q-bad-skill', ['QUESTION_TOPIC_UNKNOWN:no-such-skill']],
    ]);
    expect(JSON.stringify(report)).not.toContain('ZZ-SECRET');

    const content = [header, row('syn-q-one'), row('syn-q-two')].join('\n');
    const questionVersionsBefore = Number((await pool.query('SELECT count(*)::int AS n FROM question_versions')).rows[0].n);
    const clean = await preview(editor, 'QUESTION', content).expect(201);
    const done = await commit(editor, 'QUESTION', content, clean.body.preview.digest, 'CSV', 'EXPERT_BATCH', correlationId).expect(201);
    expect(done.body.import).toMatchObject({ kind: 'QUESTION', created: 2 });
    expect(JSON.stringify([clean.body, done.body])).not.toContain('ZZ-SECRET');

    const revision = await revisionFor('QUESTION', 'syn-q-one');
    expect(revision).toMatchObject({ state: 'DRAFT', author_user_id: editor.userId });
    expect(revision!.body).toMatchObject({ correctOptionId: 'b', explanation: 'ZZ-SECRET-EXPLANATION', difficulty: 'FOUNDATION', hints: ['h1', 'h2', 'h3', 'h4'] });
    expect((revision!.body.options as { misconception: unknown }[])[2]!.misconception).toMatchObject({ rationale: 'Synthetic rationale c' });
    // No learner-facing row, and the answer is in no audit or outbox payload.
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM question_versions')).rows[0].n)).toBe(questionVersionsBefore);
    expect((await pool.query("SELECT count(*)::int AS n FROM question_versions WHERE stable_key IN ('syn-q-one','syn-q-two')")).rows[0].n).toBe(0);
    const audits = await pool.query("SELECT context::text AS context FROM audit_events WHERE action LIKE 'operations.content.%'");
    expect(audits.rows.some((entry) => entry.context.includes('ZZ-SECRET'))).toBe(false);
    const outbox = await pool.query('SELECT payload::text AS payload FROM outbox_events');
    expect(outbox.rows.some((entry) => entry.payload.includes('ZZ-SECRET'))).toBe(false);
    const created = await pool.query("SELECT context FROM audit_events WHERE correlation_id = $1 AND action = 'operations.content.question_created'", [correlationId]);
    expect(created.rows.map((entry) => entry.context.reasonCode)).toEqual(['EXPERT_BATCH', 'EXPERT_BATCH']);
  });

  it('imports lessons (prerequisites within the file) and variants of a live lesson', async () => {
    const header = 'stable_key,title,level,style,summary,practice,module_key,skill_key,prerequisites,licence,basis';
    const content = [header,
      `syn-lesson-two,Second synthetic lesson,STANDARD,EXPLANATION,Synthetic summary,,${moduleKey},${topicKey},syn-lesson-one,AI8HT-Owned,Synthetic basis`,
      `syn-lesson-one,First synthetic lesson,FOUNDATION,STEP_BY_STEP,Synthetic summary,Try it,${moduleKey},${topicKey},,AI8HT-Owned,Synthetic basis`,
    ].join('\n');
    const report = (await preview(editor, 'LESSON', content).expect(201)).body.preview;
    expect(report.counts).toEqual({ create: 2, invalid: 0 });
    await commit(editor, 'LESSON', content, report.digest).expect(201);
    const second = await revisionFor('LESSON', 'syn-lesson-two');
    expect(second).toMatchObject({ state: 'DRAFT', author_user_id: editor.userId });
    expect(second!.body).toMatchObject({ prerequisites: ['syn-lesson-one'], moduleKey, variant: { language: 'en', level: 'STANDARD', style: 'EXPLANATION' } });
    const lessonVersions = await pool.query("SELECT count(*)::int AS n FROM lesson_versions WHERE stable_key IN ('syn-lesson-one','syn-lesson-two')");
    expect(lessonVersions.rows[0].n).toBe(0);

    const livePilot = fixture.lessons[0]!.stableKey;
    const variants = ['base_lesson_key,language,level,style,title,summary,licence',
      `${livePilot},te,STANDARD,EXPLANATION,Synthetic Telugu title,Synthetic rendering,AI8HT-Owned`,
      'syn-lesson-one,hi,STANDARD,EXPLANATION,Not live yet,Synthetic rendering,AI8HT-Owned',
      'syn-no-such-lesson,hi,STANDARD,EXPLANATION,Unknown base,Synthetic rendering,AI8HT-Owned',
    ].join('\n');
    const variantReport = (await preview(editor, 'LESSON_VARIANT', variants).expect(201)).body.preview;
    expect(variantReport.rows.map((entry: { issues: string[] }) => entry.issues)).toEqual([[], ['LESSON_BASE_NOT_LIVE'], ['IMPORT_BASE_LESSON_UNKNOWN']]);
    const onlyLive = variants.split('\n').slice(0, 2).join('\n');
    const liveReport = (await preview(editor, 'LESSON_VARIANT', onlyLive).expect(201)).body.preview;
    await commit(editor, 'LESSON_VARIANT', onlyLive, liveReport.digest).expect(201);
    const variant = await pool.query(
      "SELECT state, author_user_id, body FROM content_revisions WHERE entity_type = 'LESSON' AND body ->> 'stableKey' = $1 AND body ->> 'variantOf' IS NOT NULL AND body ->> 'variantOf' <> ''",
      [livePilot],
    );
    expect(variant.rows).toHaveLength(1);
    expect(variant.rows[0]).toMatchObject({ state: 'DRAFT', author_user_id: editor.userId, body: { variant: { language: 'te' }, title: 'Synthetic Telugu title' } });
  });

  it('a lesson prerequisite cycle within the file is refused by the editor', async () => {
    const header = 'stable_key,title,level,style,prerequisites';
    const content = [header, 'syn-loop-a,A,STANDARD,EXPLANATION,syn-loop-b', 'syn-loop-b,B,STANDARD,EXPLANATION,syn-loop-a'].join('\n');
    const report = (await preview(editor, 'LESSON', content).expect(201)).body.preview;
    expect(report.rows.flatMap((entry: { issues: string[] }) => entry.issues)).toEqual(['LESSON_PREREQUISITE_CYCLE']);
    expect(await revisionFor('LESSON', 'syn-loop-a')).toBeUndefined();
  });
});
