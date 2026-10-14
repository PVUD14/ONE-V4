/**
 * Code submissions (ENG-12, migration 0113) — the request side and the student's view.
 *
 * Why this exists: a student sends a Python program for a code task. Everything about that here is
 * plain database work, in one transaction under a per-student lock: is the sandbox switched on for
 * them, is the task published, are they within the caps, then the QUEUED row, its outbox job
 * (`code.submission.requested`) and the audit row. The program is run by `code-submission-worker.ts`
 * on the isolated VM (ADR-034 §6) — never here, never from a request handler.
 *
 * The student's view carries status, verdict, counts and per-case outcome codes only: never the test
 * cases, never the program's output, never the sandbox's text.
 *
 * Design: docs/architecture/code-sandbox-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { currentInstitutionOf, drizzleAsPgClient } from './learning-attempts.js';
import { resolveFeatureFlag } from './platform-controls.js';
import type { PersistenceDb } from './repositories.js';

export const CODE_SUBMISSION_REQUESTED = 'code.submission.requested' as const;
export const CODE_SUBMISSION_CONSUMER = 'code-submission-runner' as const;
export const CODE_SANDBOX_FLAG = 'learning.code-sandbox' as const;
/** A submission not run within this window is closed EXPIRED (by the worker, or by the student's next request). */
export const CODE_SUBMISSION_PENDING_SECONDS = 600;
export const CODE_SUBMISSIONS_PER_STUDENT_PER_DAY = 50;
export const CODE_SOURCE_MAX_CHARS = 20_000;
/**
 * What a submission is for. Only PRACTICE exists (0113 CHECK). The seam for EMP-12: an employer coding
 * item adds EMPLOYER_ASSESSMENT with a later migration and its own evidence writer (ADR-039's tables),
 * chosen in the worker by this value.
 */
export type CodeSubmissionPurpose = 'PRACTICE';

type QueryResult<T> = { rows: T[] };

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export type CodeSubmissionRefusal = 'SWITCHED_OFF' | 'TASK_NOT_FOUND' | 'INVALID_SOURCE' | 'PENDING' | 'DAILY_LIMIT' | 'CAPACITY_REACHED';

export class CodeSubmissionError extends Error {
  constructor(readonly code: CodeSubmissionRefusal) {
    super(`code submission refused: ${code}`);
    this.name = 'CodeSubmissionError';
  }
}

/** Source text a submission may carry: 1–20,000 characters, not only whitespace, no NUL. */
export function acceptableSource(source: unknown): source is string {
  return typeof source === 'string' && source.length >= 1 && source.length <= CODE_SOURCE_MAX_CHARS
    && source.trim().length > 0 && !source.includes('\u0000');
}

/** Whether the sandbox is switched on for this student (user override, then organisation, then global). */
export async function codeSandboxEnabledFor(db: PersistenceDb, subjectUserId: string, institutionId: string | null): Promise<boolean> {
  // resolveFeatureFlag only calls query(); the drizzle adapter provides exactly that.
  return resolveFeatureFlag(drizzleAsPgClient(db) as unknown as PoolClient, { key: CODE_SANDBOX_FLAG, userId: subjectUserId, organizationId: institutionId });
}

/**
 * Queues one program. One transaction under a per-student advisory lock: the student's stale open
 * submission (if any) is closed EXPIRED, then the switch, the task, one-open-at-a-time and both caps
 * are checked; the QUEUED row, its outbox job and the audit row are written together.
 */
export async function queueCodeSubmission(db: PersistenceDb, input: {
  readonly subjectUserId: string;
  readonly taskId: string;
  readonly source: string;
  readonly correlationId: string;
}): Promise<{ readonly id: string; readonly status: 'QUEUED' }> {
  if (!acceptableSource(input.source)) throw new CodeSubmissionError('INVALID_SOURCE');
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    await runner.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`code-submission:${input.subjectUserId}`}))`);
    const institutionId = await currentInstitutionOf(drizzleAsPgClient(runner), input.subjectUserId);
    if (!(await codeSandboxEnabledFor(runner, input.subjectUserId, institutionId))) throw new CodeSubmissionError('SWITCHED_OFF');

    const [task] = await rows<{ id: string; language: string; language_version: string }>(runner, sql`
      SELECT id::text AS id, language, language_version FROM code_tasks WHERE id = ${input.taskId}::uuid AND state = 'PUBLISHED'
    `);
    if (!task) throw new CodeSubmissionError('TASK_NOT_FOUND');

    // A submission left open past its window (a lost job) no longer blocks the student.
    await runner.execute(sql`
      UPDATE code_submissions SET status = 'FAILED', failure_code = 'EXPIRED', completed_at = now()
      WHERE subject_user_id = ${input.subjectUserId}::uuid AND status IN ('QUEUED','RUNNING')
        AND requested_at <= now() - make_interval(secs => ${CODE_SUBMISSION_PENDING_SECONDS})
    `);
    const [counts] = await rows<{ open: number; mine_today: number; all_today: number; cap: string | null }>(runner, sql`
      SELECT
        (SELECT count(*)::int FROM code_submissions WHERE subject_user_id = ${input.subjectUserId}::uuid AND status IN ('QUEUED','RUNNING')) AS open,
        (SELECT count(*)::int FROM code_submissions WHERE subject_user_id = ${input.subjectUserId}::uuid AND requested_at >= date_trunc('day', now())) AS mine_today,
        (SELECT count(*)::int FROM code_submissions WHERE requested_at >= date_trunc('day', now())) AS all_today,
        (SELECT cap_value::text FROM feature_flags WHERE key = ${CODE_SANDBOX_FLAG} AND cap_kind = 'INVOCATIONS' AND cap_window = 'DAY') AS cap
    `);
    if (Number(counts?.open ?? 0) > 0) throw new CodeSubmissionError('PENDING');
    if (Number(counts?.mine_today ?? 0) >= CODE_SUBMISSIONS_PER_STUDENT_PER_DAY) throw new CodeSubmissionError('DAILY_LIMIT');
    // No cap row means no ceiling was configured: refuse rather than run without one.
    if (counts?.cap === null || counts?.cap === undefined || Number(counts.all_today) >= Number(counts.cap)) throw new CodeSubmissionError('CAPACITY_REACHED');

    const id = randomUUID();
    const eventId = randomUUID();
    const payload = { codeSubmissionId: id };
    // Validates the payload against the registered schema before anything is written.
    createIntegrationEventEnvelope({
      eventId, eventType: CODE_SUBMISSION_REQUESTED, eventVersion: 1, occurredAt: new Date().toISOString(),
      aggregateId: id, correlationId: input.correlationId, payload,
    });
    await runner.execute(sql`
      INSERT INTO code_submissions (id, subject_user_id, institution_id, task_id, purpose, language, language_version, source_code, source_sha256, correlation_id)
      VALUES (${id}::uuid, ${input.subjectUserId}::uuid, ${institutionId}::uuid, ${task.id}::uuid, 'PRACTICE', ${task.language}, ${task.language_version},
        ${input.source}, encode(sha256(convert_to(${input.source}, 'UTF8')), 'hex'), ${input.correlationId})
    `);
    await runner.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
      VALUES (${eventId}::uuid, 'code_submission', ${id}::uuid, ${CODE_SUBMISSION_REQUESTED}, 1, ${JSON.stringify(payload)}::jsonb, ${input.subjectUserId}::uuid, ${input.correlationId})
    `);
    await runner.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${randomUUID()}::uuid, ${input.subjectUserId}::uuid, 'code.submission.requested', 'code_submission', ${id}, ${institutionId}::uuid, 'SUCCESS',
        ${input.correlationId}, ${JSON.stringify({ taskId: task.id, purpose: 'PRACTICE', sourceChars: input.source.length })}::jsonb)
    `);
    return { id, status: 'QUEUED' as const };
  });
}

/** What the student may see of their own submission. */
export interface CodeSubmissionView {
  readonly id: string;
  readonly taskId: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly verdict: 'PASSED' | 'FAILED' | null;
  readonly testsPassed: number | null;
  readonly testsTotal: number | null;
  /** A stable code when FAILED; the screen explains it in its own words. */
  readonly failureCode: string | null;
  readonly cases: readonly { readonly index: number; readonly outcome: string }[];
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

/** The student's own submission, or null (absent or someone else's — indistinguishable on purpose). */
export async function readCodeSubmission(db: PersistenceDb, subjectUserId: string, submissionId: string): Promise<CodeSubmissionView | null> {
  const [row] = await rows<{
    id: string; task_id: string; status: CodeSubmissionView['status']; verdict: CodeSubmissionView['verdict']; tests_passed: number | null;
    tests_total: number | null; failure_code: string | null; requested_at: Date | string; completed_at: Date | string | null;
  }>(db, sql`
    SELECT id::text AS id, task_id::text AS task_id, status, verdict, tests_passed, tests_total, failure_code, requested_at, completed_at
    FROM code_submissions WHERE id = ${submissionId}::uuid AND subject_user_id = ${subjectUserId}::uuid
  `);
  if (!row) return null;
  const cases = await rows<{ case_index: number; outcome: string }>(db, sql`
    SELECT case_index, outcome FROM code_submission_cases WHERE submission_id = ${submissionId}::uuid ORDER BY case_index
  `);
  return {
    id: row.id, taskId: row.task_id, status: row.status, verdict: row.verdict,
    testsPassed: row.tests_passed === null ? null : Number(row.tests_passed),
    testsTotal: row.tests_total === null ? null : Number(row.tests_total),
    failureCode: row.failure_code,
    cases: cases.map((entry) => ({ index: Number(entry.case_index), outcome: entry.outcome })),
    requestedAt: new Date(row.requested_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  };
}
