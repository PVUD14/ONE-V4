/**
 * Integration tests for ENG-10: importing the aptitude skill map and draft item bank through the
 * skill map and question bank editors (real Postgres, a throwaway schema).
 *
 * Pinned here: the pack lands as 25 pending AGENT_DRAFTED skills, their misconception codes and
 * 300 items — all DRAFT, attributed to the importer, carrying provenance and expert-check notes,
 * each through the editor's own functions and audit rows; nothing is submitted, reviewed,
 * approved or published, and nothing reaches question_versions or question_answer_keys (so no
 * answer key can reach a learner); a rerun writes nothing; the editor's acyclic check still
 * guards the imported map; a reader without key rights sees the key withheld; and a reviewer
 * can approve items one by one — the submitted item's ladder and tags keep AGENT_DRAFTED
 * provenance, its author and submitter cannot approve it, and every other item stays DRAFT.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { refuseQuestionTransition } from '@planthepath/authorization/src/index.js';
import { importAptitudeBankPack, type AptitudeBankPack, type AptitudeBankImportResult } from '../src/aptitude-bank.js';
import { loadQuestion, transitionQuestionRevision } from '../src/question-bank.js';
import { SkillMapError, saveSkillDraft, type SkillActor, type TransactionalRunner } from '../src/skill-map.js';
import type { PersistenceDb } from '../src/repositories.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const schemaName = 'eng10_aptitude_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool) as unknown as TransactionalRunner & PersistenceDb;
const migrationDir = new URL('../drizzle/', import.meta.url);
const packUrl = new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);

let pack: AptitudeBankPack;
let importer: SkillActor;
let submitter: SkillActor;
let reviewer: SkillActor;
let first: AptitudeBankImportResult;

async function migrateAll(): Promise<void> {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
}

async function user(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, `${id}@example.test`]);
  return id;
}

const actor = (userId: string): SkillActor => ({ userId, breakGlass: false, correlationId: `eng10-test-${randomUUID()}` });
const staff = (userId: string, grants: readonly string[]) => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants }] });
const n = async (query: string, params: unknown[] = []): Promise<number> => Number((await pool.query(query, params)).rows[0].n);

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  await migrateAll();
  pack = JSON.parse(await readFile(packUrl, 'utf8')) as AptitudeBankPack;
  importer = actor(await user());
  submitter = actor(await user());
  reviewer = actor(await user());
  first = await importAptitudeBankPack(db, pack, importer);
}, 300_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

describe('importing the aptitude bank', () => {
  it('creates every skill, code and item once', () => {
    expect(first.skillsCreated).toHaveLength(25);
    expect(first.skillsReused).toEqual([]);
    expect(first.codesCreated).toHaveLength(pack.misconceptions.length);
    expect(first.itemsCreated).toBe(300);
    expect(first.itemsSkipped).toEqual([]);
  });

  it('lands the skills as pending AGENT_DRAFTED topics with levels, prerequisites, rights and provenance', async () => {
    const skills = (await pool.query(
      `SELECT n.stable_key, n.active, n.source, n.generator_version, n.prompt_version, n.generated_at, c.state, c.author_user_id, c.body
       FROM taxonomy_nodes n JOIN content_revisions c ON c.id = n.content_revision_id WHERE n.stable_key LIKE 'apt-%' ORDER BY n.stable_key`,
    )).rows;
    expect(skills).toHaveLength(25);
    for (const skill of skills) {
      const source = pack.skills.find((entry) => entry.stableKey === skill.stable_key)!;
      expect(skill).toMatchObject({ active: false, source: 'AGENT_DRAFTED', generator_version: pack.generatorVersion, prompt_version: pack.promptVersion, state: 'DRAFT', author_user_id: importer.userId });
      expect(new Date(skill.generated_at).toISOString()).toBe(pack.generatedAt);
      expect(skill.body).toMatchObject({
        schema: 'skill-map/v1', stableKey: source.stableKey, levels: source.levels, prerequisites: source.prerequisites,
        rights: { licenceLabel: 'AI8HT-Owned', attribution: null }, basis: source.basis, expertCheck: source.expertCheck,
        area: source.area, packKey: pack.packKey, provenance: { source: 'AGENT_DRAFTED', promptVersion: pack.promptVersion },
      });
    }
    // The editor's own audit rows: created, then saved with the levels.
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.skill_created' AND actor_user_id = $1 AND context->>'source' = 'AGENT_DRAFTED'", [importer.userId])).toBe(25);
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.skill_draft_saved' AND actor_user_id = $1", [importer.userId])).toBe(25);
  });

  it('lands every misconception code as an AGENT_DRAFTED DRAFT on its own skill', async () => {
    const codes = (await pool.query(
      `SELECT m.code, m.review_state, m.source, m.expert_check_notes, m.prompt_version, n.stable_key AS skill
       FROM misconception_codes m JOIN taxonomy_nodes n ON n.id = m.skill_id WHERE m.code LIKE 'APT_%'`,
    )).rows;
    expect(codes).toHaveLength(pack.misconceptions.length);
    for (const code of codes) {
      expect(code).toMatchObject({ review_state: 'DRAFT', source: 'AGENT_DRAFTED', prompt_version: pack.promptVersion });
      expect(code.expert_check_notes).toBeTruthy();
      expect(code.skill).toBe(pack.misconceptions.find((entry) => entry.code === code.code)!.skill);
    }
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE action = 'engine.content.misconception_drafted'")).toBe(pack.misconceptions.length);
  });

  it('lands 300 DRAFT items with answer keys, tags on their own skill, hints and provenance — and publishes nothing', async () => {
    const items = (await pool.query(
      "SELECT r.state, r.author_user_id, r.body FROM content_revisions r WHERE r.entity_type = 'QUESTION' AND r.body->>'stableKey' LIKE 'apt-%'",
    )).rows;
    expect(items).toHaveLength(300);
    const codeSkill = new Map((await pool.query('SELECT id::text, skill_id::text FROM misconception_codes')).rows.map((row) => [row.id, row.skill_id]));
    for (const row of items) {
      expect(row).toMatchObject({ state: 'DRAFT', author_user_id: importer.userId });
      const body = row.body;
      expect(body).toMatchObject({ schema: 'question-bank/v1', rights: { licenceLabel: 'AI8HT-Owned' }, packKey: pack.packKey, provenance: { source: 'AGENT_DRAFTED' } });
      expect(body.correctOptionId).toMatch(/^[a-d]$/);
      expect(body.hints.every((hint: string) => hint.length > 0)).toBe(true);
      const tagged = body.options.filter((option: { misconception: { codeId: string } | null }) => option.misconception);
      expect(tagged.length).toBeGreaterThanOrEqual(1);
      for (const option of tagged) expect(codeSkill.get(option.misconception.codeId)).toBe(body.topicId);
    }
    // Nothing moved out of DRAFT; nothing is learner-facing; nothing was materialised for review.
    expect(await n("SELECT count(*)::int AS n FROM content_review_actions a JOIN content_revisions r ON r.id = a.content_revision_id WHERE r.author_user_id = $1", [importer.userId])).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM content_revisions WHERE author_user_id = $1 AND state <> 'DRAFT'", [importer.userId])).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM question_versions WHERE stable_key LIKE 'apt-%'")).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM question_answer_keys')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM question_hint_ladders')).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM question_option_misconceptions')).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM taxonomy_nodes WHERE stable_key LIKE 'apt-%' AND active")).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.question_created' AND context->>'source' = 'AGENT_DRAFTED'")).toBe(300);
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.question_draft_saved' AND actor_user_id = $1", [importer.userId])).toBe(300);
  });

  it('a rerun creates nothing', async () => {
    const before = await n("SELECT count(*)::int AS n FROM content_revisions");
    const again = await importAptitudeBankPack(db, pack, importer);
    expect(again).toMatchObject({ skillsCreated: [], codesCreated: [], itemsCreated: 0 });
    expect(again.skillsReused).toHaveLength(25);
    expect(again.itemsSkipped).toHaveLength(300);
    expect(await n("SELECT count(*)::int AS n FROM content_revisions")).toBe(before);
  });

  it('refuses a pack that fails validation, writing nothing', async () => {
    const broken = { ...pack, notice: 'not marked' };
    await expect(importAptitudeBankPack(db, broken, importer)).rejects.toMatchObject({ code: 'PACK_INVALID' });
  });
});

describe('the imported map stays governed by the editors', () => {
  it('the acyclic prerequisite check refuses a save that would close a cycle', async () => {
    const [root] = (await pool.query(
      "SELECT c.id FROM taxonomy_nodes n JOIN content_revisions c ON c.id = n.content_revision_id WHERE n.stable_key = 'apt-q-arithmetic-operations'",
    )).rows;
    const source = pack.skills.find((skill) => skill.stableKey === 'apt-q-arithmetic-operations')!;
    const error = await saveSkillDraft(db, {
      revisionId: root.id, actor: submitter,
      fields: { name: source.name, description: source.description, levels: source.levels, prerequisites: ['apt-q-profit-loss-discount'], licenceLabel: 'AI8HT-Owned', attribution: null, basis: source.basis },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SkillMapError);
    expect((error as SkillMapError).problems).toContain('SKILL_PREREQUISITE_CYCLE');
  });

  it('shows the item as agent-drafted, and withholds the key from a reader without key rights', async () => {
    const [row] = (await pool.query("SELECT entity_id FROM content_revisions WHERE entity_type = 'QUESTION' AND body->>'stableKey' = 'apt-q-percentages-001'")).rows;
    const withKey = await loadQuestion(db, row.entity_id, { answerKeys: true });
    expect(withKey!.open!.agentDraft).toMatchObject({ generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion });
    expect(withKey!.open!.expertCheck).toMatch(/only defensible option/);
    expect(withKey!.open!.fields.correctOptionId).toMatch(/^[a-d]$/);
    // ENG-15: the editor shows what the ladder rules find (nothing, for the pack's ladders).
    expect(withKey!.open!.ladderChecks).toEqual({ rulesVersion: 'hint-ladder-v1', findings: [] });
    const withheld = await loadQuestion(db, row.entity_id, { answerKeys: false });
    expect(withheld!.open!.answerKeyWithheld).toBe(true);
    expect(withheld!.open!.fields.correctOptionId).toBeNull();
    expect(withheld!.open!.fields.explanation).toBeNull();
    expect(withheld!.open!.fields.options.every((option) => option.misconception === null)).toBe(true);
  });

  it('a reviewer approves items one by one; the author and the submitter cannot', async () => {
    const [row] = (await pool.query("SELECT id, entity_id FROM content_revisions WHERE entity_type = 'QUESTION' AND body->>'stableKey' = 'apt-q-averages-005'")).rows;
    const move = (by: SkillActor, grants: readonly string[], toState: 'IN_REVIEW' | 'APPROVED', reasonCode: string, rightsReasonCode: string | null) =>
      transitionQuestionRevision(db, {
        revisionId: row.id, toState, reasonCode, rightsReasonCode, note: null, actor: by,
        refuse: (current) => refuseQuestionTransition({ actor: staff(by.userId, grants), from: current.from, to: toState, reasonCode, rightsReasonCode, contributorUserIds: current.contributorUserIds }),
      });

    await move(submitter, ['CONTENT_EDIT'], 'IN_REVIEW', 'READY_FOR_REVIEW', null);
    // Submission writes the ladder and tags — still agent-drafted, with the expert note. The ladder
    // takes its own provenance (ENG-15 revised the ladders, not the items) and the pack's four hints.
    const [ladder] = (await pool.query('SELECT source, generator_version, prompt_version, generated_at, expert_check_notes, review_state, hint_1, hint_2, hint_3, hint_4 FROM question_hint_ladders WHERE question_revision_id = $1', [row.id])).rows;
    expect(ladder).toMatchObject({ source: 'AGENT_DRAFTED', generator_version: pack.hintLadder.generatorVersion, prompt_version: pack.hintLadder.promptVersion, review_state: 'IN_REVIEW' });
    expect(new Date(ladder.generated_at).toISOString()).toBe(new Date(pack.hintLadder.generatedAt).toISOString());
    expect([ladder.hint_1, ladder.hint_2, ladder.hint_3, ladder.hint_4]).toEqual(pack.items.find((entry) => entry.stableKey === 'apt-q-averages-005')!.hints);
    expect(ladder.expert_check_notes).toMatch(/only defensible option/);
    expect(ladder.expert_check_notes).toContain(`Hint ladder: ${pack.hintLadder.expertCheck}`);
    const tags = (await pool.query('SELECT source, prompt_version, expert_check_notes, review_state FROM question_option_misconceptions WHERE question_revision_id = $1', [row.id])).rows;
    expect(tags.length).toBeGreaterThanOrEqual(1);
    for (const tag of tags) expect(tag).toMatchObject({ source: 'AGENT_DRAFTED', prompt_version: pack.promptVersion, review_state: 'IN_REVIEW' });

    await expect(move(importer, ['CONTENT_REVIEW'], 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).rejects.toMatchObject({ code: 'QUESTION_SELF_REVIEW_REFUSED' });
    await expect(move(submitter, ['CONTENT_REVIEW'], 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED')).rejects.toMatchObject({ code: 'QUESTION_SELF_REVIEW_REFUSED' });
    await move(reviewer, ['CONTENT_REVIEW'], 'APPROVED', 'REVIEW_PASSED', 'OWNERSHIP_VERIFIED');

    expect((await pool.query('SELECT state FROM content_revisions WHERE id = $1', [row.id])).rows[0].state).toBe('APPROVED');
    expect(await n("SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'QUESTION' AND body->>'stableKey' LIKE 'apt-%' AND state = 'DRAFT'")).toBe(299);
    // Approved is not published: still nothing a learner can be served.
    expect(await n("SELECT count(*)::int AS n FROM question_versions WHERE stable_key LIKE 'apt-%'")).toBe(0);
  });
});
