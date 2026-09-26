/**
 * Integration tests for ENG-11: importing the SOC Analyst L1 draft target through the OPS-08
 * authoring path, and the 0056 rules (real Postgres, a throwaway schema).
 *
 * Pinned here: the pack lands as one DRAFT set for C01 with AGENT_DRAFTED provenance and its
 * thirteen skills as pending topics that no picker lists and no student measures; the live
 * requirements are untouched; a rerun writes nothing; computeCareerGap runs against the draft as
 * loaded; the author cannot review it; provenance cannot be edited; and nothing can go live on a
 * pending topic — not the set, not a live requirement, not the topic itself before it is published.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { computeCareerGap, type MasteryProjection } from '@planthepath/career-readiness';
import { buildCareerCatalogueFile } from '../src/career-catalogue-input.js';
import {
  CareerCatalogueError,
  loadCatalogueRole,
  publishRequirementSet,
  saveRequirementSetItems,
  searchCatalogueTopics,
  seedCareerCatalogue,
  transitionRequirementSet,
  type CatalogueActor,
  type TransactionalRunner,
} from '../src/career-catalogue.js';
import { CareerTargetDraftError, importCareerTargetDraftPack, type CareerTargetDraftPack } from '../src/career-target-drafts.js';
import { listMappableTopics } from '../src/exam-evidence-bridge.js';
import type { PersistenceDb } from '../src/repositories.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const schemaName = 'eng11_target_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool) as unknown as TransactionalRunner & PersistenceDb;
const migrationDir = new URL('../drizzle/', import.meta.url);
const packUrl = new URL('../../../data/engine/soc-analyst-l1-target-v1.draft.json', import.meta.url);
const inputUrl = new URL('../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url);
const SHA = 'b'.repeat(64);

let pack: CareerTargetDraftPack;
let importer: CatalogueActor;
let reviewer: CatalogueActor;
let socId: string;
let liveTopics: Record<string, string>;
let setId: string;

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

/** A live (active, AUTHORED) topic, as the starter requirements use (synthetic name). */
async function liveTopic(authorId: string, key: string): Promise<string> {
  const id = randomUUID();
  const revision = randomUUID();
  await pool.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, id, authorId, SHA],
  );
  await pool.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,$3,'Synthetic live topic for ENG-11 tests',$4)`, [id, key, `Synthetic ${key}`, revision],
  );
  return id;
}

const actor = (userId: string): CatalogueActor => ({ userId, breakGlass: false, correlationId: `eng11-test-${randomUUID()}` });

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  await migrateAll();
  pack = JSON.parse(await readFile(packUrl, 'utf8')) as CareerTargetDraftPack;
  const author = await user();
  importer = actor(await user());
  reviewer = actor(await user());
  // The starter SOC role with its live requirements on the two pilot topics, then the catalogue.
  liveTopics = {
    'professional-communication': await liveTopic(author, 'professional-communication'),
    'interview-foundations': await liveTopic(author, 'interview-foundations'),
  };
  socId = randomUUID();
  await pool.query("INSERT INTO career_roles (id, code, title, family, summary, active) VALUES ($1,'SOC_ANALYST','Security Operations Analyst','Cyber Security',NULL,true)", [socId]);
  await pool.query(
    `INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery, rationale)
     VALUES ($1,$2,$3,'ESSENTIAL',0.75,'starter'), ($4,$2,$5,'IMPORTANT',0.6,'starter')`,
    [randomUUID(), socId, liveTopics['professional-communication'], randomUUID(), liveTopics['interview-foundations']],
  );
  await seedCareerCatalogue(pool, buildCareerCatalogueFile(await readFile(inputUrl, 'utf8')));
}, 180_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

describe('importing the SOC Analyst L1 draft', () => {
  it('refuses a role that is not in the catalogue, writing nothing', async () => {
    await expect(importCareerTargetDraftPack(db, { ...pack, roleCatalogueCode: 'B99' }, importer))
      .rejects.toMatchObject({ code: 'ROLE_NOT_IN_CATALOGUE' });
    expect((await pool.query("SELECT count(*)::int AS n FROM taxonomy_nodes WHERE stable_key LIKE 'soc-%'")).rows[0].n).toBe(0);
  });

  it('lands as one AGENT_DRAFTED DRAFT set for C01 through the operator path, and changes nothing live', async () => {
    const liveBefore = (await pool.query('SELECT topic_id, requirement_level, target_mastery FROM career_role_requirements WHERE career_role_id=$1 ORDER BY topic_id', [socId])).rows;

    const result = await importCareerTargetDraftPack(db, pack, importer);
    expect(result).toMatchObject({ roleId: socId, version: 1, createdSet: true, itemCount: 15 });
    expect(result.skillsCreated).toHaveLength(13);
    setId = result.setId;

    const set = (await pool.query('SELECT * FROM career_requirement_sets WHERE id=$1', [setId])).rows[0];
    expect(set).toMatchObject({
      career_role_id: socId, state: 'DRAFT', based_on: 'LIVE', reason_code: 'NEW_REQUIREMENT_SET', created_by_user_id: importer.userId,
      source: 'AGENT_DRAFTED', generator_version: pack.generatorVersion, prompt_version: pack.promptVersion, source_basis: pack.sourceBasis,
      submitted_at: null, reviewed_at: null, published_at: null,
    });
    expect(new Date(set.generated_at).toISOString()).toBe(new Date(pack.generatedAt).toISOString());

    // The skills are pending topics: inactive, DRAFT revisions, agent provenance, citing their basis.
    const skills = (await pool.query(
      `SELECT n.stable_key, n.active, n.source, n.prompt_version, c.state, c.body
       FROM taxonomy_nodes n JOIN content_revisions c ON c.id = n.content_revision_id WHERE n.stable_key LIKE 'soc-%'`,
    )).rows;
    expect(skills).toHaveLength(13);
    for (const skill of skills) {
      expect(skill).toMatchObject({ active: false, source: 'AGENT_DRAFTED', prompt_version: pack.promptVersion, state: 'DRAFT' });
      expect(skill.body.basis).toBeTruthy();
      expect(skill.body.expertCheck).toBeTruthy();
    }

    // No picker lists them, so no institution can map an exam to them and no operator can add them elsewhere.
    expect(await searchCatalogueTopics(db, 'soc', 50)).toEqual([]);
    expect((await listMappableTopics(db)).map((topic) => topic.stableKey).filter((key) => String(key).startsWith('soc-'))).toEqual([]);

    // Live requirements, the release label and every other role are untouched.
    expect((await pool.query('SELECT topic_id, requirement_level, target_mastery FROM career_role_requirements WHERE career_role_id=$1 ORDER BY topic_id', [socId])).rows).toEqual(liveBefore);
    expect((await pool.query('SELECT release_label FROM career_roles WHERE id=$1', [socId])).rows[0].release_label).toBe('SELECTABLE');

    // Audited through the OPS-08 path, plus one row per drafted topic.
    const actions = (await pool.query('SELECT action, count(*)::int AS n FROM audit_events WHERE actor_user_id=$1 GROUP BY action ORDER BY action', [importer.userId])).rows;
    expect(actions).toEqual(expect.arrayContaining([
      { action: 'engine.content.topic_drafted', n: 13 },
      { action: 'operations.career_catalogue.requirement_set_created', n: 1 },
      { action: 'operations.career_catalogue.requirement_set_items_saved', n: 1 },
    ]));
  });

  it('shows the reviewer the provenance and which skills are not yet published', async () => {
    const role = await loadCatalogueRole(db, socId);
    const draft = role!.requirementSets.find((set) => set.id === setId)!;
    expect(draft.provenance).toMatchObject({ source: 'AGENT_DRAFTED', generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion });
    expect(draft.items).toHaveLength(15);
    expect(draft.items.filter((item) => !item.topicLive)).toHaveLength(13);
    expect(draft.items.filter((item) => item.topicLive).map((item) => item.topicKey).sort()).toEqual(['interview-foundations', 'professional-communication']);
    expect(role!.liveRequirements.every((item) => item.topicLive)).toBe(true);
  });

  it('is idempotent: a rerun finds its own draft and writes nothing', async () => {
    const before = (await pool.query('SELECT (SELECT count(*) FROM career_requirement_sets)::int AS sets, (SELECT count(*) FROM taxonomy_nodes)::int AS topics, (SELECT count(*) FROM audit_events)::int AS audits')).rows[0];
    const again = await importCareerTargetDraftPack(db, pack, importer);
    expect(again).toMatchObject({ setId, createdSet: false, itemCount: 15 });
    expect(again.skillsCreated).toEqual([]);
    expect(again.skillsReused).toHaveLength(13);
    const after = (await pool.query('SELECT (SELECT count(*) FROM career_requirement_sets)::int AS sets, (SELECT count(*) FROM taxonomy_nodes)::int AS topics, (SELECT count(*) FROM audit_events)::int AS audits')).rows[0];
    expect(after).toEqual(before);
  });

  it('never overwrites a different open set', async () => {
    await expect(importCareerTargetDraftPack(db, { ...pack, promptVersion: 'eng-11-soc-analyst-l1-target-v2' }, importer))
      .rejects.toBeInstanceOf(CareerTargetDraftError);
  });

  it('runs computeCareerGap against the draft as loaded', async () => {
    const items = (await pool.query<{ topic_id: string; requirement_level: 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL'; target_mastery: string }>(
      'SELECT topic_id, requirement_level, target_mastery FROM career_requirement_set_items WHERE set_id=$1', [setId],
    )).rows.map((row) => ({ topicId: row.topic_id, requirementLevel: row.requirement_level, targetMastery: Number(row.target_mastery) }));
    expect(items).toHaveLength(15);

    const nothingKnown = computeCareerGap(items, []);
    expect(nothingKnown).toMatchObject({ modelVersion: 'career-gap-v1', requirementsTotal: 15, requirementsUnknown: 15, requirementsMet: 0 });

    // Synthetic projections: one skill met, one short, one with too little evidence to judge.
    const byKey = Object.fromEntries((await pool.query<{ stable_key: string; id: string }>("SELECT stable_key, id FROM taxonomy_nodes WHERE kind='TOPIC'")).rows.map((row) => [row.stable_key, row.id]));
    const projection = (key: string, band: MasteryProjection['band'], ratio: number): MasteryProjection => ({
      topicId: byKey[key]!, evidenceIds: [randomUUID()], algorithmVersion: 'career-readiness-mastery-v1', band, ratio,
    });
    const gap = computeCareerGap(items, [
      projection('soc-alert-triage', 'DEMONSTRATED', 0.8),
      projection('soc-log-analysis-correlation', 'DEVELOPING', 0.2),
      projection('soc-networking-fundamentals', 'NOT_ENOUGH_EVIDENCE', 0.9),
    ]);
    const status = (key: string) => gap.items.find((item) => item.topicId === byKey[key])!.status;
    expect(status('soc-alert-triage')).toBe('MET');
    expect(status('soc-log-analysis-correlation')).toBe('MISSING');
    expect(status('soc-networking-fundamentals')).toBe('UNKNOWN');
    expect(gap.requirementsMet).toBe(1);
    expect(gap.items.at(-1)!.topicId).toBe(byKey['soc-alert-triage']);
  });
});

describe('0056 rules', () => {
  it('refuses the author as reviewer, and a second person can review', async () => {
    await transitionRequirementSet(db, { setId, toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW', note: null, actor: importer, refuse: () => null });
    // Even with the API rule bypassed, the 0051 CHECK refuses a self-review.
    await expect(transitionRequirementSet(db, { setId, toState: 'REVIEWED', reasonCode: 'REVIEW_PASSED', note: null, actor: importer, refuse: () => null }))
      .rejects.toBeInstanceOf(CareerCatalogueError);
    await transitionRequirementSet(db, { setId, toState: 'REVIEWED', reasonCode: 'REVIEW_PASSED', note: null, actor: reviewer, refuse: () => null });
    expect((await pool.query('SELECT state, source FROM career_requirement_sets WHERE id=$1', [setId])).rows[0]).toEqual({ state: 'REVIEWED', source: 'AGENT_DRAFTED' });
  });

  it('refuses to publish while a skill is still pending, before touching the approval', async () => {
    await expect(publishRequirementSet(db, {
      setId, releaseLabel: 'SELECTABLE', reasonCode: 'NEW_REQUIREMENT_SET', approvalId: randomUUID(), approvalPayload: {}, actor: reviewer,
    })).rejects.toMatchObject({ code: 'CAREER_TOPIC_NOT_LIVE' });
    expect((await pool.query('SELECT state FROM career_requirement_sets WHERE id=$1', [setId])).rows[0].state).toBe('REVIEWED');
    expect((await pool.query('SELECT count(*)::int AS n FROM career_role_requirements WHERE career_role_id=$1', [socId])).rows[0].n).toBe(2);
  });

  it('refuses a publish on a pending topic in the database too', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Isolate the 0056 trigger from 0051's approval check, inside a transaction that is rolled back.
      await client.query('ALTER TABLE career_requirement_sets DISABLE TRIGGER career_requirement_set_guard');
      await expect(client.query(
        `UPDATE career_requirement_sets SET state='PUBLISHED', published_by_user_id=$2, published_at=now(), publish_approval_id=$3,
           publish_reason_code='NEW_REQUIREMENT_SET', release_label_at_publish='SELECTABLE' WHERE id=$1`,
        [setId, reviewer.userId, null],
      )).rejects.toThrow(/every topic it names is live/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses a live requirement on a pending topic', async () => {
    const pending = (await pool.query("SELECT id FROM taxonomy_nodes WHERE stable_key='soc-alert-triage'")).rows[0].id;
    await expect(pool.query(
      "INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.7)",
      [randomUUID(), socId, pending],
    )).rejects.toThrow(/needs a live topic/);
  });

  it('keeps an agent-drafted topic inactive until its revision is published, and its provenance fixed', async () => {
    const pending = (await pool.query("SELECT id FROM taxonomy_nodes WHERE stable_key='soc-alert-triage'")).rows[0].id;
    await expect(pool.query('UPDATE taxonomy_nodes SET active=true WHERE id=$1', [pending])).rejects.toThrow(/goes live only once its content revision is published/);
    await expect(pool.query("UPDATE taxonomy_nodes SET source='AUTHORED', generator_version=NULL, prompt_version=NULL, generated_at=NULL WHERE id=$1", [pending]))
      .rejects.toThrow(/provenance is immutable/);
    const revision = randomUUID();
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, randomUUID(), importer.userId, SHA]);
    await expect(pool.query(
      `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active, source, generator_version, prompt_version, generated_at)
       VALUES ($1,'TOPIC','soc-active-draft',1,'x','x',$2,true,'AGENT_DRAFTED','g','p',now())`, [randomUUID(), revision],
    )).rejects.toThrow(/goes live only once/);
    await expect(pool.query(
      `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active, source)
       VALUES ($1,'TOPIC','soc-no-provenance',1,'x','x',$2,false,'AGENT_DRAFTED')`, [randomUUID(), revision],
    )).rejects.toThrow(/taxonomy_node_provenance_ck/);
  });

  it('keeps a set\'s provenance fixed and refuses agent provenance without its basis', async () => {
    // A legal transition (REVIEWED -> DRAFT) carrying a provenance change: 0051 allows the move, 0056 refuses the change.
    await expect(pool.query("UPDATE career_requirement_sets SET state='DRAFT', source_basis='changed' WHERE id=$1", [setId])).rejects.toThrow(/provenance is immutable/);
    await expect(pool.query(
      "UPDATE career_requirement_sets SET state='DRAFT', source='AUTHORED', generator_version=NULL, prompt_version=NULL, generated_at=NULL, source_basis=NULL WHERE id=$1",
      [setId],
    )).rejects.toThrow(/provenance is immutable/);
    await expect(pool.query(
      `INSERT INTO career_requirement_sets (id, career_role_id, version, state, based_on, reason_code, created_by_user_id, source, generator_version, prompt_version, generated_at)
       VALUES ($1,$2,99,'DRAFT','EMPTY','NEW_REQUIREMENT_SET',$3,'AGENT_DRAFTED','g','p',now())`, [randomUUID(), socId, importer.userId],
    )).rejects.toThrow(/career_requirement_set_provenance_ck/);
  });

  it('still refuses a retired topic in a draft', async () => {
    // A topic that was published and then deactivated is retired, not pending.
    const topicId = randomUUID();
    const revision = randomUUID();
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, importer.userId, SHA]);
    await pool.query("UPDATE content_revisions SET state='ARCHIVED' WHERE id=$1", [revision]);
    await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active)
      VALUES ($1,'TOPIC','eng11-retired',1,'Retired','Synthetic retired topic',$2,false)`, [topicId, revision]);
    const roleId = (await pool.query("SELECT id FROM career_roles WHERE catalogue_code='C02'")).rows[0].id;
    const draft = randomUUID();
    await pool.query(`INSERT INTO career_requirement_sets (id, career_role_id, version, state, based_on, reason_code, created_by_user_id)
      VALUES ($1,$2,1,'DRAFT','EMPTY','NEW_REQUIREMENT_SET',$3)`, [draft, roleId, importer.userId]);
    await expect(saveRequirementSetItems(db, {
      setId: draft, actor: importer,
      items: [{ topicId, requirementLevel: 'HELPFUL', targetMastery: 0.5, rationale: null, requiredEvidenceTypes: [] }],
    })).rejects.toMatchObject({ code: 'CAREER_TOPIC_NOT_FOUND' });
  });
});
