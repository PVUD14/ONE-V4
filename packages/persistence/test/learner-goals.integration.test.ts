/**
 * Integration tests for ENG-19: learner goals (0068) and "Not sure yet" over real Postgres in a throwaway
 * schema, with the job-role catalogue seeded from the real input file and synthetic people only.
 *
 * Pinned here: role goals mirror career targets (set, switch, clear) and cannot be written any other way;
 * one primary role goal; the database refuses a primary topic goal, a reopened or rewritten goal and a
 * delete outside privacy erasure; live targets set before 0068 are backfilled by a replay; a topic goal's
 * evidence counts toward every role needing that skill and the shared skill is listed once; exam and
 * company goals only while the catalogue is open; discovery suggests only offered catalogue rows; an
 * independent learner (no enrolment) onboards with no institution.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildCareerCatalogueFile } from '../src/career-catalogue-input.js';
import { seedCareerCatalogue, seedCareerCatalogueGoals } from '../src/career-catalogue.js';
import { clearStudentCareerTarget, recomputeAllCareerGaps, setStudentCareerTarget } from '../src/career-targets.js';
import {
  LearnerGoalError,
  addLearnerGoal,
  endLearnerGoal,
  listLearnerGoals,
  readCareerDiscovery,
  searchGoalOptions,
  setRoleGoal,
  submitCareerDiscovery,
} from '../src/learner-goals.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const schemaName = 'eng19_goals_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const migrationDir = new URL('../drizzle/', import.meta.url);
const inputUrl = new URL('../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url);
const SHA = 'b'.repeat(64);

async function runMigration(name: string): Promise<void> {
  await pool.query((await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
}

async function user(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, `${id}@example.test`]);
  return id;
}

async function topic(authorId: string, key: string, name: string): Promise<string> {
  const id = randomUUID();
  const revision = randomUUID();
  await pool.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, id, authorId, SHA],
  );
  await pool.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for ENG-19 tests',$4)`, [id, key, name, revision],
  );
  return id;
}

async function requirement(roleId: string, topicId: string, level: string, target: number): Promise<void> {
  await pool.query('INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), roleId, topicId, level, target]);
}

async function evidence(subject: string, topicId: string): Promise<void> {
  await pool.query(
    `INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type,
       source_aggregate_id, content_version, provenance, occurred_at)
     VALUES ($1,$2,'TOPIC_DEMONSTRATION',$3,1,1,'eng19-test',$4,'eng19-v1','{}'::jsonb,now())`,
    [randomUUID(), subject, topicId, randomUUID()],
  );
}

async function goalRows(student: string): Promise<{ goal_type: string; priority: string; status: string; origin: string; career_target_id: string | null; institution_id: string | null }[]> {
  return (await pool.query("SELECT goal_type, priority, status, origin, career_target_id, institution_id FROM learner_goals WHERE student_user_id=$1 ORDER BY created_at, id", [student])).rows;
}

const roleId = (code: string) => pool.query<{ id: string }>('SELECT id FROM career_roles WHERE code=$1', [code]).then((result) => result.rows[0]!.id);

let author: string;
let comms: string;
let logs: string;
let sql: string;
let socId: string;
let sweId: string;
let dataId: string;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) await runMigration(name);
  author = await user();
  comms = await topic(author, 'eng19-professional-communication', 'Professional communication');
  logs = await topic(author, 'eng19-log-triage', 'Log triage');
  sql = await topic(author, 'eng19-sql-basics', 'SQL basics');
  // The starter roles as db:seed:careers writes them, then the real catalogue on top.
  for (const [code, title, family] of [
    ['SOC_ANALYST', 'Security Operations Analyst', 'Cyber Security'], ['SOFTWARE_ENGINEER', 'Software Engineer', 'Engineering'],
    ['DATA_ANALYST', 'Data Analyst', 'Data'], ['BUSINESS_ANALYST', 'Business Analyst', 'Business'], ['CUSTOMER_SUCCESS', 'Customer Success Associate', 'Business'],
  ] as const) {
    await pool.query('INSERT INTO career_roles (id, code, title, family, active) VALUES ($1,$2,$3,$4,true)', [randomUUID(), code, title, family]);
  }
  socId = await roleId('SOC_ANALYST');
  sweId = await roleId('SOFTWARE_ENGINEER');
  dataId = await roleId('DATA_ANALYST');
  // Communication is shared by two roles, as in data/careers/starter-v1.json.
  await requirement(socId, comms, 'ESSENTIAL', 0.75);
  await requirement(socId, logs, 'IMPORTANT', 0.6);
  await requirement(sweId, comms, 'IMPORTANT', 0.65);
  await requirement(dataId, sql, 'ESSENTIAL', 0.7);
  const file = buildCareerCatalogueFile(await readFile(inputUrl, 'utf8'));
  await seedCareerCatalogue(pool, file);
  expect(await seedCareerCatalogueGoals(pool, file)).toEqual({ goalsStored: 13 });
  expect(await seedCareerCatalogueGoals(pool, file)).toEqual({ goalsStored: 13 });
  await pool.query("INSERT INTO career_role_synonyms (id, career_role_id, synonym, normalized, reason_code) VALUES ($1,$2,'Cyber defender','cyber defender','SEARCH_TERM')", [randomUUID(), socId]);
}, 240_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

describe('catalogue goals', () => {
  it('stores the thirteen Appendix 4 goals with the ENG-19 mapping', async () => {
    const rows = (await pool.query<{ code: string; learner_goal_type: string | null; selectable: boolean }>(
      'SELECT code, learner_goal_type, selectable FROM career_catalogue_goals ORDER BY code')).rows;
    expect(rows).toHaveLength(13);
    expect(rows.filter((row) => row.selectable).map((row) => row.code)).toEqual(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G09']);
    expect(rows.find((row) => row.code === 'G13')).toEqual({ code: 'G13', learner_goal_type: 'DISCOVERY', selectable: false });
  });
});

describe('role goals mirror career targets', () => {
  it('creates, switches and ends role goals with their targets, keeping one primary', async () => {
    const student = await user();
    await setRoleGoal(pool, { studentId: student, careerRoleId: socId, priority: 'PRIMARY', origin: 'ONBOARDING', catalogueOpen: false });
    // The existing career-target route leaves the origin unset.
    await setStudentCareerTarget(pool, { subjectUserId: student, careerRoleId: sweId, priority: 'PRIMARY' });
    const rows = await goalRows(student);
    expect(rows.map((row) => [row.goal_type, row.priority, row.status, row.origin])).toEqual([
      ['ROLE', 'PRIMARY', 'WITHDRAWN', 'ONBOARDING'],
      ['ROLE', 'PRIMARY', 'ACTIVE', 'CAREER_TARGET'],
    ]);
    // Graduates and independent learners: no enrolment is needed or invented.
    expect(rows.every((row) => row.institution_id === null)).toBe(true);

    const view = await listLearnerGoals(pool, student);
    expect(view.onboarding).toBe(false);
    expect(view.goals).toHaveLength(1);
    await endLearnerGoal(pool, { studentId: student, goalId: view.goals[0]!.id, status: 'WITHDRAWN' });
    const targets = await pool.query('SELECT count(*)::int AS n FROM student_career_targets WHERE student_user_id=$1 AND cleared_at IS NULL', [student]);
    expect(targets.rows[0].n).toBe(0);
    expect((await listLearnerGoals(pool, student)).onboarding).toBe(true);
  });

  it('refuses role goals written directly, a primary non-role goal, rewrites, reopening and deletes', async () => {
    const student = await user();
    const { targetId } = await setStudentCareerTarget(pool, { subjectUserId: student, careerRoleId: dataId, priority: 'PRIMARY' });
    await expect(pool.query(
      "INSERT INTO learner_goals (id, student_user_id, goal_type, career_target_id, priority, origin) VALUES ($1,$2,'ROLE',$3,'SECONDARY','GOALS')",
      [randomUUID(), student, targetId],
    )).rejects.toThrow(/role goals are set through student_career_targets/);
    await expect(pool.query(
      "INSERT INTO learner_goals (id, student_user_id, goal_type, topic_id, priority, origin) VALUES ($1,$2,'TOPIC',$3,'PRIMARY','GOALS')",
      [randomUUID(), student, sql],
    )).rejects.toThrow(/learner_goals_priority_ck/);
    const roleGoal = (await pool.query<{ id: string }>("SELECT id FROM learner_goals WHERE career_target_id=$1", [targetId])).rows[0]!.id;
    await expect(pool.query("UPDATE learner_goals SET status='WITHDRAWN', ended_at=now() WHERE id=$1", [roleGoal]))
      .rejects.toThrow(/role goal ends when its career target is cleared/);
    await expect(endLearnerGoal(pool, { studentId: student, goalId: roleGoal, status: 'ACHIEVED' })).rejects.toMatchObject({ code: 'ROLE_GOAL_ENDS_BY_WITHDRAWAL' });

    const { goalId } = await addLearnerGoal(pool, { studentId: student, goal: { goalType: 'TOPIC', topicId: sql }, origin: 'GOALS', catalogueOpen: false });
    await expect(pool.query("UPDATE learner_goals SET origin='ONBOARDING' WHERE id=$1", [goalId])).rejects.toThrow(/only ends, once/);
    await endLearnerGoal(pool, { studentId: student, goalId, status: 'ACHIEVED' });
    await expect(pool.query("UPDATE learner_goals SET status='ACTIVE', ended_at=NULL WHERE id=$1", [goalId])).rejects.toThrow(/only ends, once/);
    await expect(pool.query('DELETE FROM learner_goals WHERE id=$1', [goalId])).rejects.toThrow(/only by privacy deletion/);

    // The privacy-deletion transaction for the same subject may erase them.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [student]);
      const gone = await client.query('DELETE FROM learner_goals WHERE student_user_id=$1', [student]);
      expect(gone.rowCount).toBe(2);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await clearStudentCareerTarget(pool, { subjectUserId: student, targetId });
  });

  it('backfills a role goal for a live target set before 0068, and a replay adds nothing more', async () => {
    const student = await user();
    await pool.query('ALTER TABLE student_career_targets DISABLE TRIGGER student_career_targets_goal_sync');
    try {
      await setStudentCareerTarget(pool, { subjectUserId: student, careerRoleId: socId, priority: 'PRIMARY' });
    } finally {
      await pool.query('ALTER TABLE student_career_targets ENABLE TRIGGER student_career_targets_goal_sync');
    }
    expect(await goalRows(student)).toHaveLength(0);
    await runMigration('0068_learner_goals.sql');
    await runMigration('0068_learner_goals.sql');
    expect((await goalRows(student)).map((row) => [row.goal_type, row.priority, row.status, row.origin])).toEqual([['ROLE', 'PRIMARY', 'ACTIVE', 'CAREER_TARGET']]);
  });
});

describe('topic goals and shared skills (acceptance)', () => {
  it("counts a topic goal's evidence toward every role needing that skill, and lists the shared skill once", async () => {
    const student = await user();
    await setRoleGoal(pool, { studentId: student, careerRoleId: socId, priority: 'PRIMARY', origin: 'ONBOARDING', catalogueOpen: false });
    await setRoleGoal(pool, { studentId: student, careerRoleId: sweId, priority: 'SECONDARY', origin: 'GOALS', catalogueOpen: false });
    const { goalId: topicGoal } = await addLearnerGoal(pool, { studentId: student, goal: { goalType: 'TOPIC', topicId: comms }, origin: 'GOALS', catalogueOpen: false });
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'TOPIC', topicId: comms }, origin: 'GOALS', catalogueOpen: false }))
      .rejects.toMatchObject({ code: 'GOAL_ALREADY_SET' });

    const before = await listLearnerGoals(pool, student);
    const commsBefore = before.skills.skills.filter((skill) => skill.topicId === comms);
    expect(commsBefore).toHaveLength(1);
    expect(commsBefore[0]!.goals.map((goal) => [goal.goalType, goal.status])).toEqual([['ROLE', 'UNKNOWN'], ['ROLE', 'UNKNOWN'], ['TOPIC', null]]);
    expect(before.skills.skills.map((skill) => skill.topicId).sort()).toEqual([comms, logs].sort());

    // Work done for the topic goal is evidence on the topic, and every role's gap reads it.
    await evidence(student, comms);
    await evidence(student, comms);
    await recomputeAllCareerGaps(pool, student);
    const after = await listLearnerGoals(pool, student);
    const commsAfter = after.skills.skills.find((skill) => skill.topicId === comms)!;
    expect(commsAfter.goals.map((goal) => [goal.goalType, goal.status])).toEqual([['ROLE', 'MET'], ['ROLE', 'MET'], ['TOPIC', null]]);
    expect(commsAfter.goals.find((goal) => goal.goalType === 'TOPIC')!.goalId).toBe(topicGoal);
    expect(after.skills.skills.find((skill) => skill.topicId === logs)!.goals.map((goal) => goal.status)).toEqual(['UNKNOWN']);
    // No number about the student: statuses only, never a readiness value or a score.
    expect(JSON.stringify(after)).not.toMatch(/readiness|score|observedMastery/i);
  });

  it('offers only active topics, and refuses an unknown or inactive one', async () => {
    const student = await user();
    const inactive = await topic(author, 'eng19-draft-topic', 'Draft only topic');
    await pool.query('UPDATE taxonomy_nodes SET active=false WHERE id=$1', [inactive]);
    const options = await searchGoalOptions(pool, { query: 'topic', catalogueOpen: false });
    expect(options.topics.map((entry) => entry.id)).not.toContain(inactive);
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'TOPIC', topicId: inactive }, origin: 'GOALS', catalogueOpen: false }))
      .rejects.toMatchObject({ code: 'TOPIC_NOT_FOUND' });
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'TOPIC', topicId: randomUUID() }, origin: 'GOALS', catalogueOpen: false }))
      .rejects.toBeInstanceOf(LearnerGoalError);
  });
});

describe('role search and catalogue goals', () => {
  it('searches offered roles by name and synonym, and hides catalogue rows and goals until the catalogue is open', async () => {
    const closed = await searchGoalOptions(pool, { query: 'cyber def', catalogueOpen: false });
    expect(closed.roles.map((role) => [role.code, role.matchedSynonym, role.releaseLabel])).toEqual([['SOC_ANALYST', 'Cyber defender', null]]);
    expect(closed.catalogueGoals).toEqual([]);
    expect((await searchGoalOptions(pool, { query: 'backend', catalogueOpen: false })).roles).toEqual([]);
    const open = await searchGoalOptions(pool, { query: 'backend', catalogueOpen: true });
    expect(open.roles.map((role) => role.catalogueCode)).toContain('S02');
    expect(open.roles.every((role) => role.releaseLabel === 'SELECTABLE')).toBe(true);
    expect((await searchGoalOptions(pool, { query: '', catalogueOpen: true })).catalogueGoals.map((goal) => goal.code))
      .toEqual(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G09']);
  });

  it('holds exam and company goals only while the catalogue is open, and never G08', async () => {
    const student = await user();
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'EXAM', catalogueGoalCode: 'G03' }, origin: 'GOALS', catalogueOpen: false }))
      .rejects.toMatchObject({ code: 'CATALOGUE_GOAL_NOT_FOUND' });
    await addLearnerGoal(pool, { studentId: student, goal: { goalType: 'EXAM', catalogueGoalCode: 'G03' }, origin: 'GOALS', catalogueOpen: true });
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'COMPANY', catalogueGoalCode: 'G08' }, origin: 'GOALS', catalogueOpen: true }))
      .rejects.toMatchObject({ code: 'CATALOGUE_GOAL_NOT_FOUND' });
    await expect(addLearnerGoal(pool, { studentId: student, goal: { goalType: 'COMPANY', catalogueGoalCode: 'G03' }, origin: 'GOALS', catalogueOpen: true }))
      .rejects.toMatchObject({ code: 'CATALOGUE_GOAL_NOT_FOUND' });
    const view = await listLearnerGoals(pool, student, { catalogueOpen: true });
    expect(view.goals.map((goal) => [goal.goalType, goal.catalogueGoal?.code])).toEqual([['EXAM', 'G03']]);
    // An exam goal has no skills until its track exists — nothing is invented for it.
    expect(view.skills.skills).toEqual([]);
  });
});

describe('"Not sure yet" (acceptance)', () => {
  it('suggests 3–5 roles from real catalogue rows only, records the answers, and ends when a primary role is chosen', async () => {
    const student = await user();
    const empty = await readCareerDiscovery(pool, { studentId: student, catalogueOpen: true, adaptive: false });
    expect(empty.answers).toBeNull();
    expect(empty.result).toBeNull();
    expect(empty.survey.branches).toContain('CSE');
    expect(empty.survey.branches.at(-1)).toBe('NOT_LISTED');

    const answered = await submitCareerDiscovery(pool, {
      studentId: student, answers: { interests: ['SECURING_SYSTEMS'], strengths: ['COMMUNICATION'], branch: 'ECE' },
      origin: 'ONBOARDING', catalogueOpen: true, adaptive: false,
    });
    const suggestions = answered.result!.suggestions;
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(answered.result!.usedShownSkills).toBe(false);
    const real = await pool.query<{ id: string }>('SELECT id FROM career_roles WHERE active AND id = ANY($1::uuid[])', [suggestions.map((entry) => entry.role.id)]);
    expect(real.rows).toHaveLength(suggestions.length);
    for (const suggestion of suggestions) expect(suggestion.reasons.length).toBeGreaterThan(0);
    expect(suggestions.some((entry) => entry.role.catalogueCode?.startsWith('C'))).toBe(true);
    expect(JSON.stringify(answered)).not.toMatch(/score/i);

    // Answering again replaces the live answers; one live "Not sure yet" at a time.
    await submitCareerDiscovery(pool, {
      studentId: student, answers: { interests: ['WORKING_WITH_DATA'], strengths: [], branch: 'NOT_LISTED' },
      origin: 'GOALS', catalogueOpen: true, adaptive: false,
    });
    expect((await goalRows(student)).map((row) => [row.goal_type, row.status])).toEqual([['DISCOVERY', 'WITHDRAWN'], ['DISCOVERY', 'ACTIVE']]);
    const reread = await readCareerDiscovery(pool, { studentId: student, catalogueOpen: true, adaptive: false });
    expect(reread.answers).toEqual({ interests: ['WORKING_WITH_DATA'], strengths: [], branch: 'NOT_LISTED' });

    const chosen = reread.result!.suggestions[0]!.role.id;
    await setRoleGoal(pool, { studentId: student, careerRoleId: chosen, priority: 'PRIMARY', origin: 'DISCOVERY_SUGGESTION', catalogueOpen: true });
    expect((await goalRows(student)).map((row) => [row.goal_type, row.status, row.origin])).toEqual([
      ['DISCOVERY', 'WITHDRAWN', 'ONBOARDING'], ['DISCOVERY', 'ACHIEVED', 'GOALS'], ['ROLE', 'ACTIVE', 'DISCOVERY_SUGGESTION'],
    ]);
  });

  it('suggests among the starter roles only while the catalogue is closed, and refuses answers outside the vocabulary', async () => {
    const student = await user();
    const closed = await submitCareerDiscovery(pool, {
      studentId: student, answers: { interests: ['BUSINESS_AND_PEOPLE'], strengths: ['COMMUNICATION'], branch: 'NOT_LISTED' },
      origin: 'ONBOARDING', catalogueOpen: false, adaptive: false,
    });
    const starterIds = new Set((await pool.query<{ id: string }>("SELECT id FROM career_roles WHERE origin='STARTER'")).rows.map((row) => row.id));
    expect(closed.result!.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(closed.result!.suggestions.every((entry) => starterIds.has(entry.role.id) && entry.role.catalogueCode === null && entry.role.releaseLabel === null)).toBe(true);
    await expect(submitCareerDiscovery(pool, { studentId: student, answers: { interests: ['ASTRONAUT'], branch: 'CSE' }, origin: 'GOALS', catalogueOpen: false, adaptive: false }))
      .rejects.toMatchObject({ code: 'INVALID_INTERESTS' });
    await expect(submitCareerDiscovery(pool, { studentId: student, answers: { interests: ['BUSINESS_AND_PEOPLE'], branch: 'Astrophysics' }, origin: 'GOALS', catalogueOpen: false, adaptive: false }))
      .rejects.toMatchObject({ code: 'INVALID_BRANCH' });
  });
});
