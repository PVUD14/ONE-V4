/**
 * The code submission job (ENG-12): the outbox consumer that runs one student program on the isolated
 * sandbox and records the result. Worker-only.
 *
 * Why this exists: ADR-034 §6 and CLAUDE.md keep untrusted code — and any call to the machine that runs
 * it — out of request handlers. A request (code-submissions.ts) leaves a QUEUED row and a
 * `code.submission.requested` event; this consumer, run by the outbox worker (ADR-028), re-checks that
 * the run is still wanted and allowed, claims the row so a redelivered event never runs the code twice,
 * calls Piston once per test case with ONE's limits (code-sandbox-client.ts), outside any database
 * transaction, and records COMPLETED (with a graded attempt in the attempt log — the evidence, ADR-049)
 * or FAILED with a stable code. With no sandbox configured every job ends FAILED/SANDBOX_UNAVAILABLE and
 * nothing crashes.
 *
 * It writes only `code_submissions`, `code_submission_cases`, the attempt log and sessions (through
 * ENG-03's writer, which also requests the ENG-05 projection), `audit_events` and
 * `event_consumer_receipts`. Never `evidence_records`, mastery or readiness.
 *
 * Design: docs/architecture/code-sandbox-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import {
  CODE_GRADER_VERSION,
  CODE_SANDBOX_LIMITS_VERSION,
  CODE_SANDBOX_RUNNER,
  CodeSandboxError,
  codeSandboxConfigFromEnvironment,
  gradeInSandbox,
  type CodeSandboxFailureCode,
  type FetchLike,
  type GradedSubmission,
} from './code-sandbox-client.js';
import {
  CODE_SUBMISSION_CONSUMER,
  CODE_SUBMISSION_PENDING_SECONDS,
  CODE_SUBMISSION_REQUESTED,
  codeSandboxEnabledFor,
} from './code-submissions.js';
import { drizzleAsPgClient, recordGradedAttemptSession } from './learning-attempts.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Environment = Readonly<Record<string, string | undefined>>;
export type CodeSubmissionFailureCode = CodeSandboxFailureCode | 'SWITCHED_OFF' | 'TASK_UNAVAILABLE' | 'EXPIRED';
export type CodeSubmissionJobOutcome = 'PASSED' | 'FAILED_TESTS' | CodeSubmissionFailureCode | 'NOTHING_TO_DO';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export interface CodeSubmissionWorkerOptions {
  readonly db: PersistenceDb;
  /** The worker's environment: ONE_CODE_SANDBOX_URL and ONE_CODE_SANDBOX_TOKEN. Defaults to process.env. */
  readonly env?: Environment;
  /** Tests may supply the HTTP transport; the worker uses the platform fetch. */
  readonly fetch?: FetchLike;
}

interface SubmissionContext {
  id: string; subject_user_id: string; institution_id: string | null; task_id: string; status: string; purpose: string;
  language: string; language_version: string; source_code: string; correlation_id: string; requested_at: Date | string; expired: boolean;
  task_state: string; task_version: number; skill_id: string; test_cases: unknown;
}

async function loadContext(db: PersistenceDb, submissionId: string): Promise<SubmissionContext | null> {
  const [row] = await rows<SubmissionContext>(db, sql`
    SELECT s.id::text AS id, s.subject_user_id::text AS subject_user_id, s.institution_id::text AS institution_id, s.task_id::text AS task_id,
           s.status, s.purpose, s.language, s.language_version, s.source_code, s.correlation_id, s.requested_at,
           (s.requested_at <= now() - make_interval(secs => ${CODE_SUBMISSION_PENDING_SECONDS})) AS expired,
           t.state AS task_state, t.version AS task_version, t.skill_id::text AS skill_id, t.test_cases
    FROM code_submissions s JOIN code_tasks t ON t.id = s.task_id
    WHERE s.id = ${submissionId}::uuid
  `);
  return row ?? null;
}

function testCasesOf(value: unknown): { stdin: string; expectedStdout: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { stdin, expectedStdout } = entry as { stdin?: unknown; expectedStdout?: unknown };
    return typeof stdin === 'string' && typeof expectedStdout === 'string' ? [{ stdin, expectedStdout }] : [];
  });
}

/**
 * How the job ended, by code and counts only — never the program, its output or the sandbox's text. The
 * audit outcome is SUCCESS (the job did what it is for: record the run's end); `outcome` says how it ended.
 */
async function audit(db: PersistenceDb, context: SubmissionContext, outcome: CodeSubmissionJobOutcome, counts?: { passed: number; total: number }): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${context.subject_user_id}::uuid, 'code.submission.completed', 'code_submission', ${context.id}, ${context.institution_id}::uuid,
      'SUCCESS', ${context.correlation_id},
      ${JSON.stringify({ by: CODE_SUBMISSION_CONSUMER, outcome, ...(counts ?? {}) })}::jsonb)
  `);
}

type Shaped = { readonly executed: boolean; readonly outcome?: CodeSubmissionJobOutcome };
const shape = (result: { executed: boolean; result?: CodeSubmissionJobOutcome }): Shaped =>
  ({ executed: result.executed, ...(result.result ? { outcome: result.result } : {}) });

/** Closes the submission FAILED from the given states, under the consumer receipt. */
async function fail(db: PersistenceDb, event: IntegrationEventEnvelope, context: SubmissionContext, code: CodeSubmissionFailureCode,
  from: readonly ('QUEUED' | 'RUNNING')[]): Promise<Shaped> {
  return shape(await handleEventIdempotently(db, {
    consumerName: CODE_SUBMISSION_CONSUMER,
    eventId: event.eventId,
    failureClass: 'CODE_SUBMISSION_RECORD_FAILED',
    effect: async (tx) => {
      const closed = await rows<{ id: string }>(tx, sql`
        UPDATE code_submissions SET status = 'FAILED', failure_code = ${code}, completed_at = now()
        WHERE id = ${context.id}::uuid AND status = ANY(${`{${from.join(',')}}`}::text[])
        RETURNING id::text AS id
      `);
      if (!closed.length) return 'NOTHING_TO_DO' as const;
      await audit(tx, context, code);
      return code;
    },
  }));
}

/** Records a graded run once: the cases, COMPLETED with provenance, the attempt (ADR-049) and the audit row. */
async function complete(db: PersistenceDb, event: IntegrationEventEnvelope, context: SubmissionContext, graded: GradedSubmission): Promise<Shaped> {
  return shape(await handleEventIdempotently(db, {
    consumerName: CODE_SUBMISSION_CONSUMER,
    eventId: event.eventId,
    failureClass: 'CODE_SUBMISSION_RECORD_FAILED',
    effect: async (tx) => {
      const [still] = await rows<{ status: string }>(tx, sql`SELECT status FROM code_submissions WHERE id = ${context.id}::uuid FOR UPDATE`);
      if (still?.status !== 'RUNNING') return 'NOTHING_TO_DO' as const;
      for (const entry of graded.cases) {
        await tx.execute(sql`
          INSERT INTO code_submission_cases (id, submission_id, subject_user_id, case_index, outcome, exit_code, signal, wall_time_ms, cpu_time_ms, memory_bytes)
          VALUES (${randomUUID()}::uuid, ${context.id}::uuid, ${context.subject_user_id}::uuid, ${entry.caseIndex}, ${entry.outcome}, ${entry.exitCode},
            ${entry.signal}, ${entry.wallTimeMs}, ${entry.cpuTimeMs}, ${entry.memoryBytes})
        `);
      }
      await tx.execute(sql`
        UPDATE code_submissions SET status = 'COMPLETED', verdict = ${graded.verdict}, tests_passed = ${graded.passed}, tests_total = ${graded.total},
          runner = ${CODE_SANDBOX_RUNNER}, runner_version = ${graded.runtime}, limits_version = ${CODE_SANDBOX_LIMITS_VERSION},
          grader_version = ${CODE_GRADER_VERSION}, completed_at = now()
        WHERE id = ${context.id}::uuid
      `);
      // The evidence: one graded PRACTICE attempt on the task's skill, through ENG-03's own writer, which
      // also asks the ENG-05 projector to recompute the skill's stage. Not evidence_records (ADR-049).
      await recordGradedAttemptSession(drizzleAsPgClient(tx), {
        subjectUserId: context.subject_user_id,
        institutionId: context.institution_id,
        mode: 'PRACTICE',
        context: 'PRACTICE',
        sourceAttemptType: 'code_submission',
        sourceAttemptId: context.id,
        startedAt: new Date(context.requested_at),
        contentVersion: `code-task-v${Number(context.task_version)}`,
        responses: [{
          itemSource: 'CODE_TASK',
          itemId: context.task_id,
          itemVersion: Number(context.task_version),
          skillId: context.skill_id,
          answered: true,
          correct: graded.verdict === 'PASSED',
          marksAwarded: graded.passed,
          marksPossible: graded.total,
          highestHintLevel: 0,
        }],
      });
      const outcome: CodeSubmissionJobOutcome = graded.verdict === 'PASSED' ? 'PASSED' : 'FAILED_TESTS';
      await audit(tx, context, outcome, { passed: graded.passed, total: graded.total });
      return outcome;
    },
  }));
}

/** The outbox consumer for `code.submission.requested` v1. */
export async function consumeCodeSubmissionRequested(options: CodeSubmissionWorkerOptions, event: IntegrationEventEnvelope): Promise<Shaped> {
  if (event.eventType !== CODE_SUBMISSION_REQUESTED || event.eventVersion !== 1) throw new Error('event is outside the code submission consumer contract');
  const submissionId = typeof event.payload.codeSubmissionId === 'string' ? event.payload.codeSubmissionId : '';
  if (!UUID.test(submissionId) || event.aggregateId !== submissionId) throw new Error('invalid code submission event');
  const db = options.db;
  const context = await loadContext(db, submissionId);
  if (!context) throw new Error('code submission not found');

  // Already claimed: only a run abandoned past its window is closed (a worker died mid-run).
  if (context.status === 'RUNNING') return context.expired ? fail(db, event, context, 'EXPIRED', ['RUNNING']) : { executed: false, outcome: 'NOTHING_TO_DO' };
  if (context.status !== 'QUEUED') return { executed: false, outcome: 'NOTHING_TO_DO' };

  // Re-check everything that may have changed since the request; none of these call the sandbox.
  if (context.expired) return fail(db, event, context, 'EXPIRED', ['QUEUED']);
  if (!(await codeSandboxEnabledFor(db, context.subject_user_id, context.institution_id))) return fail(db, event, context, 'SWITCHED_OFF', ['QUEUED']);
  const testCases = testCasesOf(context.test_cases);
  if (context.task_state !== 'PUBLISHED' || testCases.length === 0 || context.purpose !== 'PRACTICE') return fail(db, event, context, 'TASK_UNAVAILABLE', ['QUEUED']);
  const config = codeSandboxConfigFromEnvironment(options.env ?? process.env);
  if (!config) return fail(db, event, context, 'SANDBOX_UNAVAILABLE', ['QUEUED']);

  // Claim: only one worker ever runs a submission.
  const claimed = await rows<{ id: string }>(db, sql`
    UPDATE code_submissions SET status = 'RUNNING', started_at = now() WHERE id = ${context.id}::uuid AND status = 'QUEUED' RETURNING id::text AS id
  `);
  if (!claimed.length) return { executed: false, outcome: 'NOTHING_TO_DO' };

  let graded: GradedSubmission;
  try {
    graded = await gradeInSandbox(config, {
      language: context.language, languageVersion: context.language_version, source: context.source_code, testCases,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    const code: CodeSandboxFailureCode = error instanceof CodeSandboxError ? error.code : 'SANDBOX_ERROR';
    return fail(db, event, context, code, ['RUNNING']);
  }
  return complete(db, event, context, graded);
}
