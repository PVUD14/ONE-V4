/**
 * Integration tests for OPS-08: the job-role catalogue seed and the 0051 rules (real
 * Postgres, a throwaway schema).
 *
 * Pinned here: the seed loads all 108 roles, maps the five starter roles instead of
 * duplicating them, marks nothing verified, stores no goal and is idempotent; a student's
 * existing target and gap survive it; students see only the starter roles until the flag
 * is on; the database refuses a label change, a self-review, an edit after submission and
 * a publish without an executed approval; and an approval row carrying an action added
 * after 0038 survives the migrator replaying every file.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildCareerCatalogueFile } from '../src/career-catalogue-input.js';
import { seedCareerCatalogue } from '../src/career-catalogue.js';
import { getStudentCareerTargetState, listCareerRoles, setStudentCareerTarget, CareerTargetError } from '../src/career-targets.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const schemaName = 'ops08_catalogue_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const migrationDir = new URL('../drizzle/', import.meta.url);
const inputUrl = new URL('../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url);
const SHA = 'a'.repeat(64);

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

/** The starter roles as `db:seed:careers` writes them (codes and titles from starter-v1.json). */
const starterRoles = [
  ['SOC_ANALYST', 'Security Operations Analyst', 'Cyber Security'],
  ['SOFTWARE_ENGINEER', 'Software Engineer', 'Engineering'],
  ['DATA_ANALYST', 'Data Analyst', 'Data'],
  ['BUSINESS_ANALYST', 'Business Analyst', 'Business'],
  ['CUSTOMER_SUCCESS', 'Customer Success Associate', 'Business'],
] as const;

let studentId: string;
let socId: string;
let topicA: string;
let topicB: string;
let otherTopic: string;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  await migrateAll();
  const author = await user();
  topicA = await topic(author, 'ops08-incident-handover');
  topicB = await topic(author, 'ops08-log-triage');
  otherTopic = await topic(author, 'ops08-unrelated');
  for (const [code, title, family] of starterRoles) {
    await pool.query('INSERT INTO career_roles (id, code, title, family, summary, active) VALUES ($1,$2,$3,$4,NULL,true)', [randomUUID(), code, title, family]);
  }
  socId = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE code='SOC_ANALYST'")).rows[0]!.id;
  await pool.query(
    "INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.75)",
    [randomUUID(), socId, topicA],
  );
  // A student who chose the starter SOC role before the catalogue existed.
  studentId = await user();
  await setStudentCareerTarget(pool, { subjectUserId: studentId, careerRoleId: socId, priority: 'PRIMARY' });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

describe('catalogue seed', () => {
  it('loads 108 roles, maps the starter five, marks nothing verified, and is idempotent', async () => {
    const file = buildCareerCatalogueFile(await readFile(inputUrl, 'utf8'));
    const before = await getStudentCareerTargetState(pool, studentId);

    const first = await seedCareerCatalogue(pool, file);
    expect(first).toMatchObject({ created: 103, updated: 5, mappingConflicts: [], goalsStored: 0 });
    expect([...first.mappedStarterRoles].sort()).toEqual(['BUSINESS_ANALYST->S21', 'CUSTOMER_SUCCESS->B11', 'DATA_ANALYST->D01', 'SOC_ANALYST->C01', 'SOFTWARE_ENGINEER->S01']);

    const second = await seedCareerCatalogue(pool, file);
    expect(second).toMatchObject({ created: 0, updated: 108 });

    const counts = (await pool.query<{ total: number; catalogued: number; selectable: number; verified: number; starter: number; v1: number; v2: number; v3: number }>(`
      SELECT count(*)::int AS total, count(catalogue_code)::int AS catalogued,
             count(*) FILTER (WHERE release_label = 'SELECTABLE')::int AS selectable,
             count(*) FILTER (WHERE release_label = 'VERIFIED')::int AS verified,
             count(*) FILTER (WHERE origin = 'STARTER')::int AS starter,
             count(*) FILTER (WHERE planned_release = 'V1')::int AS v1,
             count(*) FILTER (WHERE planned_release = 'V2')::int AS v2,
             count(*) FILTER (WHERE planned_release = 'V3')::int AS v3
      FROM career_roles`)).rows[0]!;
    expect(counts).toEqual({ total: 108, catalogued: 108, selectable: 108, verified: 0, starter: 5, v1: 1, v2: 13, v3: 38 });

    // The mapped row keeps what students know it by, and carries the catalogue's name beside it.
    const soc = (await pool.query('SELECT id, code, title, family, catalogue_code, catalogue_title, catalogue_family FROM career_roles WHERE id=$1', [socId])).rows[0];
    expect(soc).toMatchObject({ code: 'SOC_ANALYST', title: 'Security Operations Analyst', family: 'Cyber Security', catalogue_code: 'C01', catalogue_title: 'SOC Analyst L1', catalogue_family: 'B' });

    // No requirement set, no goal table, no requirement rows beyond what already existed.
    expect((await pool.query('SELECT count(*)::int AS n FROM career_requirement_sets')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM career_role_requirements')).rows[0].n).toBe(1);

    // The student's target and gap are untouched.
    const after = await getStudentCareerTargetState(pool, studentId);
    expect(after).toEqual(before);
  });

  it('offers students only the starter roles until the catalogue is open to them', async () => {
    const closed = await listCareerRoles(pool);
    expect(closed).toHaveLength(5);
    expect(closed.every((role) => role.releaseLabel === null && role.catalogueCode === null)).toBe(true);
    const open = await listCareerRoles(pool, { catalogueOpen: true });
    expect(open).toHaveLength(108);
    expect(open.every((role) => role.releaseLabel === 'SELECTABLE')).toBe(true);

    const s02 = (await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE catalogue_code='S02'")).rows[0]!.id;
    const other = await user();
    await expect(setStudentCareerTarget(pool, { subjectUserId: other, careerRoleId: s02, priority: 'PRIMARY' }))
      .rejects.toEqual(new CareerTargetError('CAREER_ROLE_NOT_FOUND'));
    await setStudentCareerTarget(pool, { subjectUserId: other, careerRoleId: s02, priority: 'PRIMARY', catalogueOpen: true });
    const state = await getStudentCareerTargetState(pool, other) as { targets: { careerRoleId: string }[] };
    expect(state.targets.map((target) => target.careerRoleId)).toEqual([s02]);
  });
});

describe('0051 rules a second writer cannot skip', () => {
  it('refuses a release label change that no published set made', async () => {
    await expect(pool.query("UPDATE career_roles SET release_label='VERIFIED' WHERE id=$1", [socId])).rejects.toThrow(/release label changes only/);
    await expect(pool.query(
      "INSERT INTO career_roles (id, code, title, family, active, release_label) VALUES ($1,'VERIFIED_BY_HAND','x','y',true,'VERIFIED')", [randomUUID()],
    )).rejects.toThrow(/verified only through/);
  });

  it('freezes items on submission, refuses a self-review, and refuses a publish without an executed approval', async () => {
    const author = await user();
    const reviewer = await user();
    const setId = randomUUID();
    await pool.query(
      "INSERT INTO career_requirement_sets (id, career_role_id, version, based_on, reason_code, created_by_user_id) VALUES ($1,$2,1,'LIVE','NEW_REQUIREMENT_SET',$3)",
      [setId, socId, author],
    );
    await pool.query(
      "INSERT INTO career_requirement_set_items (id, set_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.8)",
      [randomUUID(), setId, topicB],
    );
    await pool.query("UPDATE career_requirement_sets SET state='IN_REVIEW', submitted_by_user_id=$2, submitted_at=now() WHERE id=$1", [setId, author]);
    await expect(pool.query(
      "INSERT INTO career_requirement_set_items (id, set_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'HELPFUL',0.5)",
      [randomUUID(), setId, otherTopic],
    )).rejects.toThrow(/only while the set is a DRAFT/);
    await expect(pool.query("UPDATE career_requirement_set_items SET target_mastery=0.9 WHERE set_id=$1", [setId])).rejects.toThrow(/only while the set is a DRAFT/);
    await expect(pool.query(
      "UPDATE career_requirement_sets SET state='REVIEWED', reviewed_by_user_id=$2, reviewed_at=now(), review_reason_code='REVIEW_PASSED' WHERE id=$1",
      [setId, author],
    )).rejects.toThrow(/career_requirement_set_state_ck/);
    await pool.query(
      "UPDATE career_requirement_sets SET state='REVIEWED', reviewed_by_user_id=$2, reviewed_at=now(), review_reason_code='REVIEW_PASSED' WHERE id=$1",
      [setId, reviewer],
    );
    // A made-up approval id, then a real approval that was never executed.
    await expect(pool.query(
      `UPDATE career_requirement_sets SET state='PUBLISHED', published_by_user_id=$2, published_at=now(), publish_approval_id=NULL,
         publish_reason_code='NEW_REQUIREMENT_SET', release_label_at_publish='SELECTABLE' WHERE id=$1`, [setId, author],
    )).rejects.toThrow();
    const approvalId = randomUUID();
    await pool.query(
      `INSERT INTO operation_approvals (id, extended_action_key, extended_target_type, target_id, payload, payload_hash, requested_by_user_id, reason_code, correlation_id, expires_at)
       VALUES ($1,'CAREER_REQUIREMENT_SET_PUBLISH','career_requirement_set',$2,'{}'::jsonb,$3,$4,'NEW_REQUIREMENT_SET','ops08-test-corr',now())`,
      [approvalId, setId, SHA, author],
    );
    await expect(pool.query(
      `UPDATE career_requirement_sets SET state='PUBLISHED', published_by_user_id=$2, published_at=now(), publish_approval_id=$3,
         publish_reason_code='NEW_REQUIREMENT_SET', release_label_at_publish='SELECTABLE' WHERE id=$1`, [setId, author, approvalId],
    )).rejects.toThrow(/needs an executed approval/);
    // Sets are never deleted.
    await expect(pool.query('DELETE FROM career_requirement_sets WHERE id=$1', [setId])).rejects.toThrow(/never deleted/);
    // Leave the role free for the next test.
    await pool.query("UPDATE career_requirement_sets SET state='WITHDRAWN', withdrawn_at=now(), withdrawn_reason_code='ENTERED_IN_ERROR' WHERE id=$1", [setId]);
  });

  it('refuses an unknown extended approval action and keeps the extension columns immutable', async () => {
    const requester = await user();
    await expect(pool.query(
      `INSERT INTO operation_approvals (id, extended_action_key, extended_target_type, target_id, payload, payload_hash, requested_by_user_id, reason_code, correlation_id, expires_at)
       VALUES ($1,'MADE_UP_ACTION','career_requirement_set','x','{}'::jsonb,$2,$3,'NEW_REQUIREMENT_SET','ops08-test-corr',now())`,
      [randomUUID(), SHA, requester],
    )).rejects.toThrow(/unknown extended approval action/);
    // Both a legacy key and an extended key on one row is not a shape.
    await expect(pool.query(
      `INSERT INTO operation_approvals (id, action_key, target_type, extended_action_key, extended_target_type, target_id, payload, payload_hash, requested_by_user_id, reason_code, correlation_id, expires_at)
       VALUES ($1,'ORGANIZATION_SUSPEND','organization','CAREER_REQUIREMENT_SET_PUBLISH','career_requirement_set','x','{}'::jsonb,$2,$3,'POLICY_VIOLATION','ops08-test-corr',now())`,
      [randomUUID(), SHA, requester],
    )).rejects.toThrow(/operation_approval_action_extension_ck/);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO operation_approvals (id, extended_action_key, extended_target_type, target_id, payload, payload_hash, requested_by_user_id, reason_code, correlation_id, expires_at)
       VALUES ($1,'CAREER_REQUIREMENT_SET_PUBLISH','career_requirement_set','x','{}'::jsonb,$2,$3,'NEW_REQUIREMENT_SET','ops08-test-corr',now())`,
      [id, SHA, requester],
    );
    await expect(pool.query("UPDATE operation_approvals SET action_key='ORGANIZATION_SUSPEND', target_type='organization', extended_action_key=NULL, extended_target_type=NULL WHERE id=$1", [id]))
      .rejects.toThrow(/immutable/);
  });

  it('survives the migrator replaying every file while an extended approval row exists', async () => {
    expect((await pool.query("SELECT count(*)::int AS n FROM operation_approvals WHERE extended_action_key IS NOT NULL")).rows[0].n).toBeGreaterThan(0);
    // This is what `db:migrate` does on every run. Before 0051's extension columns, a sixth
    // key in action_key would make 0038's re-added CHECK fail right here.
    await expect(migrateAll()).resolves.toBeUndefined();
    expect((await pool.query("SELECT count(*)::int AS n FROM career_roles WHERE catalogue_code IS NOT NULL")).rows[0].n).toBe(108);
  }, 180_000);
});
