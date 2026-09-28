import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { DELETION_POLICY, anonymisedIdentity, isDeletionDue, type DeletionCategory, type PrivacyRequestState } from '@planthepath/privacy';
import { detachSupportCasesForDeletedUser } from '@planthepath/persistence/src/support-cases.js';
import { projectSubjectSkillState } from '@planthepath/persistence/src/learner-skill-state.js';
import { ERASED_SNAPSHOT, snapshotHash } from '@planthepath/hiring/src/application-snapshot.js';
import type { FileStorage } from '../storage/file-storage.js';

type QueryResult<T> = { rows: T[] };

export interface DeletionExecutionSummary {
  readonly requestId: string;
  readonly subjectUserId: string;
  readonly outcome: 'COMPLETED' | 'HELD' | 'FAILED';
  readonly categories: readonly { readonly category: DeletionCategory; readonly disposition: string; readonly recordCount: number }[];
  readonly detail?: string;
}

export interface DeletionExecutionDeps {
  readonly db: PersistenceDb;
  readonly ids: { uuid(): string };
  readonly storage?: FileStorage | undefined;
  readonly now?: Date;
}

/**
 * Executes every deletion whose grace period has elapsed.
 *
 * Written to be safe to run repeatedly: requests are selected only while open, and a
 * subject already anonymised is skipped, so a retry after a partial failure does not
 * double-erase or resurrect anything.
 */
export async function executeDueDeletions(deps: DeletionExecutionDeps): Promise<readonly DeletionExecutionSummary[]> {
  const now = deps.now ?? new Date();
  const due = await deps.db.execute(sql`
    SELECT id, subject_user_id, state, deletion_scheduled_for
    FROM privacy_requests
    WHERE request_type = 'DELETION'
      AND state IN ('RECEIVED','IN_PROGRESS')
      AND deletion_scheduled_for <= ${now.toISOString()}::timestamptz
    ORDER BY deletion_scheduled_for
    LIMIT 100
  `) as QueryResult<Record<string, unknown>>;

  const summaries: DeletionExecutionSummary[] = [];
  for (const row of due.rows) {
    const requestId = String(row.id);
    const subjectUserId = String(row.subject_user_id);
    if (!isDeletionDue({ state: String(row.state) as PrivacyRequestState, scheduledFor: new Date(String(row.deletion_scheduled_for)), now })) continue;
    summaries.push(await executeOne(deps, requestId, subjectUserId, String(row.state)));
  }
  return summaries;
}

async function executeOne(deps: DeletionExecutionDeps, requestId: string, subjectUserId: string, fromState: string): Promise<DeletionExecutionSummary> {
  const { db, ids } = deps;

  // A hold means wait, not fail. The request stays open and is picked up again once
  // the hold is released.
  const holds = await db.execute(sql`
    SELECT count(*)::int AS count FROM data_retention_holds
    WHERE subject_user_id = ${subjectUserId}::uuid AND released_at IS NULL
  `) as QueryResult<{ count: number }>;
  if ((holds.rows[0]?.count ?? 0) > 0) {
    return { requestId, subjectUserId, outcome: 'HELD', categories: [], detail: 'retention hold active' };
  }

  if (fromState === 'RECEIVED') {
    await db.execute(sql`UPDATE privacy_requests SET state = 'IN_PROGRESS', started_at = now(), updated_at = now() WHERE id = ${requestId}::uuid`);
    await recordEvent(deps, requestId, 'RECEIVED', 'IN_PROGRESS');
  }

  try {
    const counts = await erase(deps, subjectUserId);

    for (const entry of DELETION_POLICY) {
      await db.execute(sql`
        INSERT INTO privacy_deletion_records (id, request_id, category, disposition, basis, record_count)
        VALUES (${ids.uuid()}::uuid, ${requestId}::uuid, ${entry.category}, ${entry.disposition}, ${entry.basis ?? null}, ${counts[entry.category] ?? 0})
        ON CONFLICT (request_id, category) DO NOTHING
      `);
    }

    await db.execute(sql`
      UPDATE privacy_requests SET state = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE id = ${requestId}::uuid
    `);
    await recordEvent(deps, requestId, 'IN_PROGRESS', 'COMPLETED');
    // Attributed to the subject, who asked for it, rather than to nobody. The audit
    // table requires an actor, and the row survives anonymisation so the reference
    // stays valid; the action name records that the platform executed it.
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
      VALUES (${ids.uuid()}::uuid, ${subjectUserId}::uuid, 'privacy.deletion_executed', 'privacy_request', ${requestId}::uuid, 'SUCCESS', ${`privacy-deletion-${requestId}`})
    `);

    return {
      requestId, subjectUserId, outcome: 'COMPLETED',
      categories: DELETION_POLICY.map((entry) => ({ category: entry.category, disposition: entry.disposition, recordCount: counts[entry.category] ?? 0 })),
    };
  } catch (error) {
    await db.execute(sql`UPDATE privacy_requests SET state = 'FAILED', updated_at = now() WHERE id = ${requestId}::uuid AND state = 'IN_PROGRESS'`);
    await recordEvent(deps, requestId, 'IN_PROGRESS', 'FAILED');
    return { requestId, subjectUserId, outcome: 'FAILED', categories: [], detail: describeFailure(error) };
  }
}

/** Applies the declared policy and reports how many records each category touched. */
async function erase(deps: DeletionExecutionDeps, subjectUserId: string): Promise<Partial<Record<DeletionCategory, number>>> {
  const { db } = deps;
  const counts: Partial<Record<DeletionCategory, number>> = {};
  const countOf = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(((await db.execute(query)) as QueryResult<{ count: number }>).rows[0]?.count ?? 0);

  // Every employer's access to this person ends now and for good (EMP-SR-02). While the
  // request was open the shared grant predicate already withheld them; this makes it
  // permanent. It runs first, so a run that fails part-way has still closed that access.
  await db.execute(sql`
    UPDATE employer_applicant_access_grants SET revoked_at = now(), updated_at = now()
    WHERE student_user_id = ${subjectUserId}::uuid AND revoked_at IS NULL
  `);

  // Retained and anonymised categories are counted before identity changes, so the
  // record reflects what existed at the moment of deletion.
  counts.APPLICATIONS = await countOf(sql`SELECT count(*)::int AS count FROM applications WHERE student_user_id = ${subjectUserId}::uuid`);
  counts.OFFERS = await countOf(sql`SELECT count(*)::int AS count FROM offers o JOIN applications a ON a.id = o.application_id WHERE a.student_user_id = ${subjectUserId}::uuid`);
  counts.ASSESSMENT_EVIDENCE = await countOf(sql`SELECT count(*)::int AS count FROM evidence_records WHERE subject_user_id = ${subjectUserId}::uuid`);
  counts.AUDIT = await countOf(sql`SELECT count(*)::int AS count FROM audit_events WHERE actor_user_id = ${subjectUserId}::uuid`);

  // EMP-07: application snapshots keep their row (APPLICATIONS are anonymised, not erased) and
  // lose what the student shared. This must precede the document deletion below, because a
  // snapshot points at the résumé version it carried. The 0058 trigger allows this one update
  // only inside the transaction-local erase setting for this subject.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${subjectUserId}, true)`);
    await tx.execute(sql`
      UPDATE application_profile_snapshots
      SET snapshot = ${JSON.stringify(ERASED_SNAPSHOT)}::jsonb, snapshot_hash = ${snapshotHash(ERASED_SNAPSHOT)},
          resume_document_id = NULL, resume_document_version_id = NULL, resume_file_id = NULL, erased_at = now()
      WHERE erased_at IS NULL AND application_id IN (SELECT id FROM applications WHERE student_user_id = ${subjectUserId}::uuid)
    `);
  });

  // Documents: remove the bytes, then the rows that point at them.
  const files = await db.execute(sql`
    SELECT f.id, f.storage_key FROM stored_files f
    JOIN student_document_versions v ON v.file_id = f.id
    JOIN student_document_metadata d ON d.id = v.document_id
    WHERE d.student_user_id = ${subjectUserId}::uuid AND f.deleted_at IS NULL
  `) as QueryResult<Record<string, unknown>>;
  for (const file of files.rows) {
    if (deps.storage) await deps.storage.delete(String(file.storage_key)).catch(() => undefined);
    await db.execute(sql`UPDATE stored_files SET deleted_at = now(), updated_at = now() WHERE id = ${String(file.id)}::uuid`);
  }
  counts.DOCUMENTS = files.rows.length;
  await db.execute(sql`UPDATE student_document_metadata SET current_version_id = NULL WHERE student_user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM student_document_versions WHERE document_id IN (SELECT id FROM student_document_metadata WHERE student_user_id = ${subjectUserId}::uuid)`);
  await db.execute(sql`DELETE FROM student_document_metadata WHERE student_user_id = ${subjectUserId}::uuid`);

  counts.STUDENT_PROFILE = await countOf(sql`SELECT count(*)::int AS count FROM student_profiles WHERE user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM student_profiles WHERE user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM student_saved_opportunities WHERE student_user_id = ${subjectUserId}::uuid`);

  counts.NOTIFICATIONS = await countOf(sql`SELECT count(*)::int AS count FROM notification_commands WHERE subject_user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM notification_commands WHERE subject_user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM notification_preferences WHERE user_id = ${subjectUserId}::uuid`);

  // Engine behavioural data is erased (ADR-034, ENG-03, ENG-05, ENG-08). The attempt log and sessions are
  // append-only; their trigger allows DELETE only for the subject named in the
  // transaction-local setting set here, so this one transaction is the only way to remove
  // them. Attempts before sessions, which they reference.
  counts.LEARNING_ACTIVITY = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${subjectUserId}, true)`);
    const removed = async (query: ReturnType<typeof sql>): Promise<number> =>
      Number(((await tx.execute(query)) as QueryResult<{ count: number }>).rows[0]?.count ?? 0);
    const attempts = await removed(sql`WITH gone AS (DELETE FROM learning_attempt_events WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // Placement sittings (ENG-14, 0064): served items, then sittings, before the sessions they reference.
    const placementItems = await removed(sql`WITH gone AS (DELETE FROM placement_test_items WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const placementTests = await removed(sql`WITH gone AS (DELETE FROM placement_tests WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const sessions = await removed(sql`WITH gone AS (DELETE FROM learning_sessions WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const activity = await removed(sql`WITH gone AS (DELETE FROM learner_activity_events WHERE user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // The planner's decision audit (ENG-08) holds the inputs each decision was made from.
    const decisions = await removed(sql`WITH gone AS (DELETE FROM learning_decisions WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // Deletion triggers a rebuild of the skill state projection (ENG-05). With the facts gone the
    // rebuild is the empty set, so every projection row of the subject is removed here.
    const projection = await projectSubjectSkillState(tx, subjectUserId);
    return attempts + placementItems + placementTests + sessions + activity + decisions + projection.deleted;
  });

  // Institution roster history survives, with the person removed from it.
  counts.INSTITUTION_ROSTER = await countOf(sql`SELECT count(*)::int AS count FROM institution_student_profiles WHERE student_user_id = ${subjectUserId}::uuid`);
  const replacement = anonymisedIdentity(subjectUserId);
  await db.execute(sql`
    UPDATE institution_student_profiles SET full_name = ${replacement.displayName}, updated_at = now()
    WHERE student_user_id = ${subjectUserId}::uuid
  `);

  // Counselling notes (INST-11) are only about the person: erased, with their case's participant
  // list. The audit rows that recorded reads of them stay (AUDIT is retained) and carry no text.
  // The count is notes plus participant rows: both are records about the person.
  counts.COUNSELLING_NOTES = await countOf(sql`
    WITH gone AS (DELETE FROM staff_actions WHERE subject_student_user_id = ${subjectUserId}::uuid AND action_type = 'COUNSELLING_NOTE' RETURNING 1)
    SELECT count(*)::int AS count FROM gone`) + await countOf(sql`
    WITH gone AS (DELETE FROM counselling_case_participants WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);

  // Support cases (OPS-05) keep the service record and lose the person: the subject
  // link, the typed summary and every note on those cases.
  counts.SUPPORT_CASES = await detachSupportCasesForDeletedUser(db, subjectUserId);

  // Identity last: once this lands the person is gone, and every earlier step has
  // already been recorded.
  await db.execute(sql`
    UPDATE users
    SET email = ${replacement.email}, external_subject = NULL, state = 'DELETED', anonymised_at = now(), updated_at = now()
    WHERE id = ${subjectUserId}::uuid AND anonymised_at IS NULL
  `);
  counts.IDENTITY = 1;

  return counts;
}

/**
 * Driver errors arrive wrapped, with the useful message on `cause`. Unwrapping it
 * matters here: a failed deletion is investigated by a person, and "Failed query:"
 * on its own tells them nothing.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown failure';
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return `${error.message}${causeMessage ? ` | ${causeMessage}` : ''}`.replace(/\s+/g, ' ').slice(0, 300);
}

async function recordEvent(deps: DeletionExecutionDeps, requestId: string, from: string, to: string): Promise<void> {
  await deps.db.execute(sql`
    INSERT INTO privacy_request_events (id, request_id, from_state, to_state, actor_role)
    VALUES (${deps.ids.uuid()}::uuid, ${requestId}::uuid, ${from}, ${to}, 'SYSTEM')
  `);
}
