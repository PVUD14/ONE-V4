/**
 * Database tests for the session planner's audit (ENG-08, migration 0053): planning a step from
 * real rows, recording it, replaying it (C4), scenario X1 end to end through the skill state
 * projection, due reviews first (C7), the consent fallback (ENG-01), the append-only guard and
 * outcome linking.
 *
 * Why: the pure package proves the rules; these prove that the loader feeds them the right facts
 * (published strategies only, no profile without consent, the projection's active codes with the
 * attempt log's counts) and that what is stored replays. Every person, topic, misconception and
 * strategy here is synthetic.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ImportPackageManifest, TeachingStrategyDraft } from '@planthepath/career-readiness/src/index.js';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import { publishCareerReadinessPilot, stageImportManifest, type PilotFixture } from '../src/career-readiness.js';
import { setStudentCareerTarget } from '../src/career-targets.js';
import {
  createMisconceptionCodeDraft,
  createTeachingStrategyDraft,
  publishEngineContentRelease,
  transitionEngineContent,
} from '../src/misconceptions.js';
import { clearLearnerSkillStateForWithdrawal, projectSubjectSkillState } from '../src/learner-skill-state.js';
import {
  linkDecisionOutcomeAttempts,
  loadPlannerInput,
  planNextLearningStep,
  replayLearningDecision,
  replayLearningDecisions,
} from '../src/learning-decisions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const SHA = 'c'.repeat(64);
const CONSENT_VERSION = 'eng08-synthetic-test';
const actors = {
  authorUserId: '53000000-0000-4000-8000-000000000001',
  reviewerUserId: '53000000-0000-4000-8000-000000000002',
  publisherUserId: '53000000-0000-4000-8000-000000000003',
};
const provenance = {
  source: 'AGENT_DRAFTED' as const, generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-08-test',
  generatedAt: new Date('2026-09-26T00:00:00Z'), basis: 'Synthetic basis for a test.', expertCheckNotes: 'Synthetic: not a real claim.',
};
let topicA: string;
let topicB: string;
let roleId: string;
let sourceRecordId: string;
let boundaryCode: string;
let boundaryCodeId: string;

async function publish(revisionIds: readonly string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const revisionId of revisionIds) {
      await transitionEngineContent(tx, { revisionId, to: 'IN_REVIEW', actorUserId: actors.authorUserId, reasonCode: 'SYNTHETIC', correlationId: `eng08-${randomUUID()}` });
      await transitionEngineContent(tx, { revisionId, to: 'APPROVED', actorUserId: actors.reviewerUserId, reasonCode: 'SYNTHETIC', correlationId: `eng08-${randomUUID()}` });
    }
    await publishEngineContentRelease(tx, { revisionIds, releaseName: `eng08-${randomUUID()}`, releaseVersion: 1, sourceRecordId,
      approverUserId: actors.reviewerUserId, publisherUserId: actors.publisherUserId, correlationId: `eng08-${randomUUID()}` });
  });
}

async function strategyDraft(draft: Omit<TeachingStrategyDraft, keyof typeof provenance | 'title' | 'description'>): Promise<string> {
  const created = await createTeachingStrategyDraft(db, {
    ...provenance, ...draft, title: `Synthetic ${draft.code}`, description: 'Synthetic strategy for the planner test.', authorUserId: actors.authorUserId,
  });
  return created.revisionId;
}

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  await pool.query('TRUNCATE users CASCADE');
  for (const [index, userId] of Object.values(actors).entries()) {
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `decisions-test:${index}`, `decisions-${index}@example.test`]);
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  const fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const staging = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, staging, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  [topicA, topicB] = fixture.topics.map((topic) => topic.id) as [string, string];

  // A synthetic role needing topic A (essential) and topic B (important).
  roleId = randomUUID();
  await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1,$2,'Planner test role','Test')`,
    [roleId, `PLANNER_TEST_${roleId.slice(0, 8).toUpperCase()}`]);
  await pool.query(`INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery)
    VALUES ($1,$2,$3,'ESSENTIAL',0.8), ($4,$2,$5,'IMPORTANT',0.6)`, [randomUUID(), roleId, topicA, randomUUID(), topicB]);

  // The adaptive-learning purpose, live for this suite only (publishing the real one is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')
    ON CONFLICT (consent_key, version) DO UPDATE SET retired_at = NULL`, [CONSENT_VERSION]);

  // A release-eligible synthetic source record for publishing engine content.
  const runId = randomUUID();
  const packageId = randomUUID();
  sourceRecordId = randomUUID();
  await pool.query(
    `INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
     VALUES ($1,$2,'synthetic/eng-08',$3,$4,'eng08-test','STAGED',$5,now())`,
    [runId, `eng08-${runId}`, 'd'.repeat(40), SHA, actors.authorUserId],
  );
  await pool.query(
    `INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
     VALUES ($1,$2,$3,'synthetic/eng-08',$4,$5,'eng08-test','[]','{}','{}')`,
    [packageId, runId, `eng08-${packageId}`, 'd'.repeat(40), SHA],
  );
  await pool.query(
    `INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
       rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
     VALUES ($1,$2,'ENGINE_CONTENT','eng08','synthetic.json',$3,'Synthetic','APPROVED','APPROVED','APPROVED','MAPPED','UNIQUE','ELIGIBLE',true)`,
    [sourceRecordId, packageId, SHA],
  );

  // Published: a misconception on topic A, error correction (after two signals), retrieval
  // practice for reviews, and a model-only strategy the planner must never pick. A draft that
  // would otherwise win is left unpublished.
  boundaryCode = `SYN_ENG08_BOUNDARY_${randomUUID().slice(0, 6).toUpperCase()}`;
  const code = await createMisconceptionCodeDraft(db, { ...provenance, code: boundaryCode, skillId: topicA,
    title: 'Synthetic boundary misconception', description: 'Synthetic: counts a subnet boundary off by one.', authorUserId: actors.authorUserId });
  boundaryCodeId = code.id;
  const published = [
    code.revisionId,
    await strategyDraft({ code: 'SYN_ERROR_CORRECTION', strategyKind: 'ERROR_CORRECTION', requiresModel: false,
      applicability: { modes: ['PRACTICE', 'LEARN', 'REVIEW'], triggers: ['MISCONCEPTION_DETECTED'], minRecentErrors: 2 } }),
    await strategyDraft({ code: 'SYN_RETRIEVAL_PRACTICE', strategyKind: 'RETRIEVAL_PRACTICE', requiresModel: false,
      applicability: { modes: ['REVIEW', 'PRACTICE'], triggers: ['DUE_REVIEW', 'NEAR_MASTERY'] } }),
    await strategyDraft({ code: 'SYN_SOCRATIC', strategyKind: 'SOCRATIC_QUESTIONING', requiresModel: true,
      applicability: { modes: ['LEARN', 'PRACTICE'], triggers: ['MISCONCEPTION_DETECTED', 'REPEATED_ERROR', 'NEW_SKILL'] } }),
  ];
  await publish(published);
  await strategyDraft({ code: 'SYN_DRAFT_ONLY', strategyKind: 'WORKED_EXAMPLE', requiresModel: false,
    applicability: { misconceptionCodes: [boundaryCode] } });
});

afterAll(async () => {
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND version = $1", [CONSENT_VERSION]);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function newStudent(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, `sub-${id}`, `${id}@example.test`]);
  await setStudentCareerTarget(pool, { subjectUserId: id, careerRoleId: roleId, priority: 'PRIMARY' });
  return id;
}

async function consent(userId: string, action: 'GRANTED' | 'WITHDRAWN'): Promise<void> {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1,$2,'adaptive-learning',$3,$4, clock_timestamp())`, [randomUUID(), userId, CONSENT_VERSION, action]);
}

/** Append one graded attempt fact on a topic (with its session), as a grading path does. */
async function attempt(studentId: string, fact: {
  readonly skillId: string; readonly itemId: string; readonly correct: boolean; readonly occurredAt?: string; readonly codeIds?: readonly string[];
}): Promise<string> {
  const sessionId = randomUUID();
  const sourceId = randomUUID();
  const attemptId = randomUUID();
  const at = fact.occurredAt ?? null;
  await pool.query(
    `INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at, ended_at)
     VALUES ($1,$2,'ASSESSMENT','assessment_attempt',$3, COALESCE($4::timestamptz, now()) - interval '5 minutes', COALESCE($4::timestamptz, now()))`,
    [sessionId, studentId, sourceId, at],
  );
  await pool.query(
    `INSERT INTO learning_attempt_events
       (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct, score,
        highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at, misconception_code_ids)
     VALUES ($1,$2,$3,'CAREER_READINESS_QUESTION',$4,1,$5,'ASSESSMENT',true,$6,$7,0,false,'assessment-v1','assessment_attempt',$8,
             COALESCE($9::timestamptz, now()), $10::uuid[])`,
    [attemptId, studentId, sessionId, fact.itemId, fact.skillId, fact.correct, fact.correct ? 1 : 0, sourceId, at,
      `{${(fact.codeIds ?? []).join(',')}}`],
  );
  return attemptId;
}

const daysAgo = (days: number, hour = 5): string => new Date(Date.now() - days * 86_400_000 + hour * 3_600_000).toISOString();

async function decisionRow(id: string): Promise<Record<string, unknown>> {
  return (await pool.query('SELECT * FROM learning_decisions WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('without adaptive-learning consent (ENG-01)', () => {
  it('plans from the career gap alone, reads no profile, records the decision and replays it', async () => {
    const studentId = await newStudent();
    await attempt(studentId, { skillId: topicA, itemId: 'hosts-1', correct: true, occurredAt: daysAgo(40) });
    const input = await loadPlannerInput(db, { subjectUserId: studentId, sessionMinutes: null });
    expect(input).toMatchObject({ adaptive: false, skillStates: [], dueReviews: [] });
    expect(input.strategies.map((s) => s.code).sort()).toEqual(['SYN_ERROR_CORRECTION', 'SYN_RETRIEVAL_PRACTICE', 'SYN_SOCRATIC']);

    const recorded = await planNextLearningStep(db, { subjectUserId: studentId, correlationId: `plan-${randomUUID()}` });
    expect(recorded.decision).toMatchObject({
      action: 'LEARN', skillId: topicA, strategy: null,
      reasonCodes: ['GAP_UNKNOWN', 'REQUIREMENT_ESSENTIAL', 'NON_ADAPTIVE_NO_CONSENT'],
    });
    const row = await decisionRow(recorded.decisionId);
    expect(row).toMatchObject({ subject_user_id: studentId, adaptive: false, action: 'LEARN', skill_id: topicA,
      policy_version: 'learning-orchestrator-v1', strategy_code: null, override_by_user_id: null, outcome_attempt_ids: [] });
    expect(row.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await replayLearningDecision(db, recorded.decisionId)).toEqual({ decisionId: recorded.decisionId, status: 'MATCHED' });
  });

  it('with no primary target there is nothing to plan, and it says so', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, `sub-${id}`, `${id}@example.test`]);
    const recorded = await planNextLearningStep(db, { subjectUserId: id, correlationId: `plan-${randomUUID()}` });
    expect(recorded.decision).toMatchObject({ action: 'NONE', skillId: null, reasonCodes: ['NO_CAREER_TARGET', 'NON_ADAPTIVE_NO_CONSENT'] });
  });
});

describe('scenario X1 end to end', () => {
  it('switches to targeted remediation after repeated boundary errors and returns to the full problem once cleared', async () => {
    const studentId = await newStudent();
    await consent(studentId, 'GRANTED');
    // Host counts right; subnet boundaries wrong three times, each signalling the code. All today,
    // so no review is due yet and the plan is about the misconception.
    await attempt(studentId, { skillId: topicA, itemId: 'hosts-1', correct: true });
    await attempt(studentId, { skillId: topicA, itemId: 'hosts-2', correct: true });
    for (const item of ['boundary-1', 'boundary-2', 'boundary-3']) {
      await attempt(studentId, { skillId: topicA, itemId: item, correct: false, codeIds: [boundaryCodeId] });
    }
    await projectSubjectSkillState(db, studentId);

    const input = await loadPlannerInput(db, { subjectUserId: studentId, sessionMinutes: 30 });
    expect(input.adaptive).toBe(true);
    expect(input.skillStates.find((s) => s.skillId === topicA)?.misconceptions).toEqual([{ code: boundaryCode, unclearedSignals: 3 }]);
    // Never the shadow BKT value or FSRS numbers.
    expect(JSON.stringify(input)).not.toMatch(/mastery|stability|difficulty|likelihood/i);

    const remediate = await planNextLearningStep(db, { subjectUserId: studentId, sessionMinutes: 30, correlationId: `plan-${randomUUID()}` });
    expect(remediate.decision).toMatchObject({
      action: 'REMEDIATE', skillId: topicA, focusMisconceptionCode: boundaryCode,
      strategy: { code: 'SYN_ERROR_CORRECTION', version: 1, kind: 'ERROR_CORRECTION' },
    });
    expect(remediate.decision.reasonCodes[0]).toBe('REPEATED_MISCONCEPTION');
    expect(await decisionRow(remediate.decisionId)).toMatchObject({
      action: 'REMEDIATE', focus_misconception_code: boundaryCode, strategy_code: 'SYN_ERROR_CORRECTION', strategy_version: 1, adaptive: true,
    });

    // Two of the three boundary items later answered correctly without help: one signal remains.
    await attempt(studentId, { skillId: topicA, itemId: 'boundary-1', correct: true });
    await attempt(studentId, { skillId: topicA, itemId: 'boundary-2', correct: true });
    await projectSubjectSkillState(db, studentId);
    const back = await planNextLearningStep(db, { subjectUserId: studentId, sessionMinutes: 30, correlationId: `plan-${randomUUID()}` });
    expect(back.decision).toMatchObject({ action: 'PRACTICE', skillId: topicA, focusMisconceptionCode: null });
    expect(back.decision.reasonCodes).toContain('ACTIVE_MISCONCEPTION');
    // The model-only strategy and the unpublished draft are never chosen.
    for (const decision of [remediate.decision, back.decision]) {
      expect(decision.strategy?.code).not.toBe('SYN_SOCRATIC');
      expect(decision.strategy?.code).not.toBe('SYN_DRAFT_ONLY');
    }

    for (const id of [remediate.decisionId, back.decisionId]) {
      expect((await replayLearningDecision(db, id))?.status).toBe('MATCHED');
    }
  });
});

describe('C7: a skill past its due interval comes first', () => {
  it('reviews the overdue skill before remediation or the gap', async () => {
    const studentId = await newStudent();
    await consent(studentId, 'GRANTED');
    // Topic B practised once, long ago: its review is overdue.
    await attempt(studentId, { skillId: topicB, itemId: 'b-1', correct: true, occurredAt: daysAgo(120) });
    for (const item of ['boundary-1', 'boundary-2']) {
      await attempt(studentId, { skillId: topicA, itemId: item, correct: false, occurredAt: daysAgo(1), codeIds: [boundaryCodeId] });
    }
    await projectSubjectSkillState(db, studentId);
    const recorded = await planNextLearningStep(db, { subjectUserId: studentId, sessionMinutes: 10, correlationId: `plan-${randomUUID()}` });
    expect(recorded.decision).toMatchObject({ action: 'REVIEW', skillId: topicB });
    expect(recorded.decision.reasonCodes[0]).toBe('DUE_REVIEW');
    expect(recorded.decision.strategy).toEqual({ code: 'SYN_RETRIEVAL_PRACTICE', version: 1, kind: 'RETRIEVAL_PRACTICE' });
  });
});

describe('withdrawal', () => {
  it('turns the next plan non-adaptive and keeps the decisions already made', async () => {
    const studentId = await newStudent();
    await consent(studentId, 'GRANTED');
    await attempt(studentId, { skillId: topicB, itemId: 'b-1', correct: true, occurredAt: daysAgo(120) });
    await projectSubjectSkillState(db, studentId);
    const before = await planNextLearningStep(db, { subjectUserId: studentId, correlationId: `plan-${randomUUID()}` });
    expect(before.decision.action).toBe('REVIEW');

    await consent(studentId, 'WITHDRAWN');
    await clearLearnerSkillStateForWithdrawal(db, studentId);
    const after = await planNextLearningStep(db, { subjectUserId: studentId, correlationId: `plan-${randomUUID()}` });
    expect(after.decision).toMatchObject({ action: 'LEARN', skillId: topicA });
    expect(after.decision.reasonCodes).toContain('NON_ADAPTIVE_NO_CONSENT');
    const kept = await pool.query('SELECT count(*)::int AS count FROM learning_decisions WHERE subject_user_id = $1', [studentId]);
    expect(kept.rows[0].count).toBe(2);
  });
});

describe('the audit is append-only', () => {
  it('refuses to rewrite or delete a decision, and lets outcome attempts only grow', async () => {
    const studentId = await newStudent();
    const recorded = await planNextLearningStep(db, { subjectUserId: studentId, correlationId: `plan-${randomUUID()}` });
    await expect(pool.query("UPDATE learning_decisions SET action = 'PRACTICE' WHERE id = $1", [recorded.decisionId])).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE learning_decisions SET inputs = '{}'::jsonb WHERE id = $1", [recorded.decisionId])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM learning_decisions WHERE id = $1', [recorded.decisionId])).rejects.toThrow(/append-only/);

    const first = await attempt(studentId, { skillId: topicA, itemId: 'a-1', correct: true });
    const second = await attempt(studentId, { skillId: topicA, itemId: 'a-2', correct: false });
    expect(await linkDecisionOutcomeAttempts(db, { decisionId: recorded.decisionId, attemptIds: [first] })).toBe(1);
    expect(await linkDecisionOutcomeAttempts(db, { decisionId: recorded.decisionId, attemptIds: [second, first] })).toBe(2);
    await expect(pool.query("UPDATE learning_decisions SET outcome_attempt_ids = '{}' WHERE id = $1", [recorded.decisionId])).rejects.toThrow(/append-only/);

    // Another person's attempt, or one made before the decision, is not an outcome of it.
    const other = await newStudent();
    const foreign = await attempt(other, { skillId: topicA, itemId: 'a-1', correct: true });
    const earlier = await attempt(studentId, { skillId: topicA, itemId: 'a-0', correct: true, occurredAt: daysAgo(30) });
    expect(await linkDecisionOutcomeAttempts(db, { decisionId: recorded.decisionId, attemptIds: [foreign] })).toBeNull();
    expect(await linkDecisionOutcomeAttempts(db, { decisionId: recorded.decisionId, attemptIds: [earlier] })).toBeNull();
    expect((await decisionRow(recorded.decisionId)).outcome_attempt_ids).toHaveLength(2);
    // Linking outcomes does not disturb replay.
    expect((await replayLearningDecision(db, recorded.decisionId))?.status).toBe('MATCHED');
  });

  it('enforces the shape at the database: a reason is required, a skill exactly when acting, an override says so', async () => {
    const studentId = await newStudent();
    const insert = (columns: Record<string, unknown>) => {
      const row = { id: randomUUID(), subject_user_id: studentId, policy_version: 'learning-orchestrator-v1', adaptive: false,
        inputs: '{}', inputs_hash: 'a'.repeat(64), action: 'NONE', skill_id: null, reason_codes: '{NO_CAREER_TARGET}',
        correlation_id: 'shape-test', override_by_user_id: null, override_reason_code: null, ...columns };
      const keys = Object.keys(row);
      return pool.query(`INSERT INTO learning_decisions (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
    };
    await expect(insert({ reason_codes: '{}' })).rejects.toThrow(/learning_decisions_reasons_ck/);
    await expect(insert({ reason_codes: '{lowercase}' })).rejects.toThrow(/learning_decisions_reasons_ck/);
    await expect(insert({ action: 'LEARN' })).rejects.toThrow(/learning_decisions_skill_ck/);
    await expect(insert({ action: 'REMEDIATE', skill_id: topicA })).rejects.toThrow(/learning_decisions_focus_ck/);
    await expect(insert({ override_by_user_id: actors.reviewerUserId, override_reason_code: 'EXAM_NEXT_WEEK' }))
      .rejects.toThrow(/learning_decisions_override_ck/);
    await expect(insert({ inputs_hash: 'not-a-hash' })).rejects.toThrow(/learning_decisions_inputs_ck/);
    await expect(insert({ action: 'LEARN', skill_id: topicA, strategy_code: 'NO_SUCH_STRATEGY', strategy_version: 1 }))
      .rejects.toThrow(/learning_decisions_strategy_fk/);
  });
});

describe('replay (C4)', () => {
  it('replays every stored decision, and reports one whose inputs do not match its hash rather than trusting it', async () => {
    const studentId = await newStudent();
    const altered = randomUUID();
    await pool.query(
      `INSERT INTO learning_decisions (id, subject_user_id, policy_version, adaptive, inputs, inputs_hash, action, reason_codes, correlation_id)
       VALUES ($1,$2,'learning-orchestrator-v1',false,$3::jsonb,$4,'NONE','{NO_CAREER_TARGET,NON_ADAPTIVE_NO_CONSENT}','replay-test')`,
      [altered, studentId, JSON.stringify({ adaptive: false, sessionMinutes: null, careerGap: null, skillStates: [], dueReviews: [], strategies: [],
        constraints: { override: null, assignments: [] } }), 'b'.repeat(64)],
    );
    const summary = await replayLearningDecisions(db);
    expect(summary.hashMismatch).toEqual([altered]);
    expect(summary.mismatched).toEqual([]);
    expect(summary.invalidInputs).toEqual([]);
    expect(summary.unsupportedPolicy).toEqual([]);
    expect(summary.matched).toBe(summary.checked - 1);
    expect(summary.checked).toBeGreaterThanOrEqual(8);
  });
});
