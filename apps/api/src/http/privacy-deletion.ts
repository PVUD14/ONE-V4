import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { DELETION_POLICY, anonymisedIdentity, isDeletionDue, type DeletionCategory, type PrivacyRequestState } from '@planthepath/privacy';
import { detachSupportCasesForDeletedUser } from '@planthepath/persistence/src/support-cases.js';
import { eraseApplicationMessagesForSubject } from '@planthepath/persistence/src/application-messages.js';
import { projectSubjectSkillState } from '@planthepath/persistence/src/learner-skill-state.js';
import { ERASED_SNAPSHOT, snapshotHash } from '@planthepath/hiring/src/application-snapshot.js';
import type { FileStorage } from '../storage/file-storage.js';

type QueryResult<T> = { rows: T[] };

/** What a staff-only college action about a deleted person is titled once its text is erased (NOT NULL column). */
export const STAFF_ACTION_ERASED_TITLE = 'Erased: the student deleted their account';

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
  // EMP-13: every piece of evidence they chose to share is taken back with the grants. The rows stay
  // as the record of what they consented to, pointing at the anonymised application and evidence.
  await db.execute(sql`
    UPDATE application_evidence_shares SET revoked_at = now(), revoked_reason = 'ACCOUNT_DELETION'
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

  // Employer screening attempts (EMP-12 privacy fix; docs/architecture/employer-screening-privacy-design.md).
  // The attempt and its stored score stay, detached with the application: they are the employer's
  // record of what it measured. What the person selected is erased; the employer's per-question
  // marking stays, so the marks still sum to the stored score. A sitting still open is closed
  // unscored first, because the next sweep would otherwise grade the emptied answers and store a
  // score of 0 nobody earned. The employer's access to all of it already ended with the grants above.
  counts.EMPLOYER_SCREENING = await db.transaction(async (tx) => {
    const attempts = await tx.execute(sql`
      SELECT count(*)::int AS count FROM employer_assessment_attempts WHERE candidate_user_id = ${subjectUserId}::uuid
    `) as QueryResult<{ count: number }>;
    await tx.execute(sql`
      WITH closed AS (
        UPDATE employer_assessment_attempts SET state = 'EXPIRED'
        WHERE candidate_user_id = ${subjectUserId}::uuid AND state = 'IN_PROGRESS'
        RETURNING invitation_id
      )
      UPDATE employer_assessment_invitations SET state = 'EXPIRED'
      WHERE id IN (SELECT invitation_id FROM closed) AND state = 'STARTED'
    `);
    await tx.execute(sql`
      UPDATE employer_assessment_answers SET selected_option_keys = '{}', numeric_response = NULL
      WHERE attempt_id IN (SELECT id FROM employer_assessment_attempts WHERE candidate_user_id = ${subjectUserId}::uuid)
        AND (cardinality(selected_option_keys) > 0 OR numeric_response IS NOT NULL)
    `);
    return Number(attempts.rows[0]?.count ?? 0);
  });

  // EMP-10: the text of every message in the person's application conversations, both sides. The
  // rows stay without text (append-only; 0067) so pipelines and trust-case references stay valid.
  counts.APPLICATION_MESSAGES = await eraseApplicationMessagesForSubject(db, subjectUserId);

  // Records that point at the person's document versions must let go before the versions go
  // (privacy-export-coverage.md). A college verification action keeps its row — whether it is the
  // college's record or the person's is decision 3 there — but loses the link to the erased document.
  // The person's academic records are erased with the profile (decision 2); a document-backed term
  // references its evidence, so they go first. Before 2026-09-30 either link made the deletion FAIL.
  await db.execute(sql`
    UPDATE staff_actions SET evidence_document_version_id = NULL
    WHERE evidence_document_version_id IN (
      SELECT v.id FROM student_document_versions v JOIN student_document_metadata d ON d.id = v.document_id
      WHERE d.student_user_id = ${subjectUserId}::uuid)
  `);
  const academicRecords = await countOf(sql`
    WITH qualifications AS (SELECT id FROM student_qualifications WHERE student_user_id = ${subjectUserId}::uuid),
         terms AS (SELECT id FROM student_academic_terms WHERE qualification_id IN (SELECT id FROM qualifications)),
         subjects AS (DELETE FROM student_academic_subjects WHERE term_id IN (SELECT id FROM terms) RETURNING 1)
    SELECT count(*)::int AS count FROM subjects`)
    + await countOf(sql`WITH gone AS (DELETE FROM student_academic_terms WHERE qualification_id IN (
        SELECT id FROM student_qualifications WHERE student_user_id = ${subjectUserId}::uuid) RETURNING 1)
      SELECT count(*)::int AS count FROM gone`)
    + await countOf(sql`WITH gone AS (DELETE FROM student_qualifications WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
      SELECT count(*)::int AS count FROM gone`);

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
  counts.STUDENT_PROFILE += academicRecords;
  // The public profile (0071): its share links, and the photo with its bytes. The public photo route
  // reads the link and the photo without the account state, so a live link kept serving a deleted
  // person's photo until 2026-09-30.
  const photos = await db.execute(sql`SELECT storage_key FROM student_profile_photos WHERE student_user_id = ${subjectUserId}::uuid`) as QueryResult<{ storage_key: string }>;
  for (const photo of photos.rows) {
    if (deps.storage) await deps.storage.delete(String(photo.storage_key)).catch(() => undefined);
  }
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM student_profile_photos WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM public_profile_links WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  // Applications the person declared themselves (0019) and the gap counts computed for the roles they
  // chose (0011) are only about them. Both were left behind until 2026-09-30.
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM external_applications WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM career_gap_items WHERE snapshot_id IN (
      SELECT id FROM career_gap_snapshots WHERE student_user_id = ${subjectUserId}::uuid) RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM career_gap_snapshots WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  // Goals and "Not sure yet" survey answers (ENG-19, 0068) are about the person: erased with the profile.
  // The 0068 guard allows DELETE only inside the transaction-local erase setting for this subject.
  counts.STUDENT_PROFILE += await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${subjectUserId}, true)`);
    const gone = await tx.execute(sql`WITH gone AS (DELETE FROM learner_goals WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`) as QueryResult<{ count: number }>;
    // The career roles the person chose (0011) are about them too. Role goals reference these rows, so
    // they go after the goals above. They were left behind until 2026-09-29 (found by ENG-19).
    const targets = await tx.execute(sql`WITH gone AS (DELETE FROM student_career_targets WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`) as QueryResult<{ count: number }>;
    // Outcomes the person shared with a college (INST-13, 0083) are about them: erased, withdrawn or not.
    // The 0083 guard allows DELETE only inside this transaction-local erase setting.
    const outcomes = await tx.execute(sql`WITH gone AS (DELETE FROM student_outcome_declarations WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`) as QueryResult<{ count: number }>;
    return Number(gone.rows[0]?.count ?? 0) + Number(targets.rows[0]?.count ?? 0) + Number(outcomes.rows[0]?.count ?? 0);
  });
  await db.execute(sql`DELETE FROM student_saved_opportunities WHERE student_user_id = ${subjectUserId}::uuid`);
  // The language the person chose to read lessons in (ENG-16, 0097) is their own setting.
  counts.STUDENT_PROFILE += await countOf(sql`WITH gone AS (DELETE FROM learner_language_preferences WHERE user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);

  counts.NOTIFICATIONS = await countOf(sql`SELECT count(*)::int AS count FROM notification_commands WHERE subject_user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM notification_commands WHERE subject_user_id = ${subjectUserId}::uuid`);
  await db.execute(sql`DELETE FROM notification_preferences WHERE user_id = ${subjectUserId}::uuid`);
  // The in-app notifications (their text names employers, jobs and times) and the devices registered for
  // push (0013). Delivery logs that point at a notification keep their row; the FK sets it NULL.
  counts.NOTIFICATIONS += await countOf(sql`WITH gone AS (DELETE FROM user_notifications WHERE user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);
  counts.NOTIFICATIONS += await countOf(sql`WITH gone AS (DELETE FROM device_push_tokens WHERE user_id = ${subjectUserId}::uuid RETURNING 1)
    SELECT count(*)::int AS count FROM gone`);

  // Engine behavioural data is erased (ADR-034, ENG-03, ENG-05, ENG-08). The attempt log and sessions are
  // append-only; their trigger allows DELETE only for the subject named in the
  // transaction-local setting set here, so this one transaction is the only way to remove
  // them. Attempts before sessions, which they reference.
  counts.LEARNING_ACTIVITY = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${subjectUserId}, true)`);
    const removed = async (query: ReturnType<typeof sql>): Promise<number> =>
      Number(((await tx.execute(query)) as QueryResult<{ count: number }>).rows[0]?.count ?? 0);
    // Practice questions served on steps (ENG-18, 0072) reference decisions, sessions and questions: first.
    const stepItems = await removed(sql`WITH gone AS (DELETE FROM learning_step_items WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const attempts = await removed(sql`WITH gone AS (DELETE FROM learning_attempt_events WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // Placement sittings (ENG-14, 0064): served items, then sittings, before the sessions they reference.
    const placementItems = await removed(sql`WITH gone AS (DELETE FROM placement_test_items WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const placementTests = await removed(sql`WITH gone AS (DELETE FROM placement_tests WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const sessions = await removed(sql`WITH gone AS (DELETE FROM learning_sessions WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    const activity = await removed(sql`WITH gone AS (DELETE FROM learner_activity_events WHERE user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // What lecturers set for the person (INST-16, 0082): their plan overrides (which point at decisions, so
    // first), the assignments they received and the group sessions they were invited to. The lecturer's own
    // act (assignment header, meeting, content links) names no student and stays.
    const facultyActions = await removed(sql`WITH gone AS (DELETE FROM learning_plan_overrides WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM learning_assignment_students WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM staff_action_attendees WHERE student_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // The planner's decision audit (ENG-08) holds the inputs each decision was made from.
    const decisions = await removed(sql`WITH gone AS (DELETE FROM learning_decisions WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // The learning history (Divakar, 2026-09-30; privacy-export-coverage.md D2): lessons, topic bands,
    // readiness snapshots, the roadmap and readiness checks. Only the person's own screens read these rows;
    // college and operator aggregates read them per student with EXISTS, so the person simply drops out.
    // Children before parents. Readiness snapshots are deleted, never altered, so their CHECKs are untouched;
    // a readiness-check attempt may be deleted only inside this transaction (0087).
    const history = await removed(sql`WITH gone AS (DELETE FROM readiness_factors WHERE
        snapshot_id IN (SELECT id FROM readiness_snapshots WHERE subject_user_id = ${subjectUserId}::uuid)
        OR mastery_projection_id IN (SELECT id FROM mastery_projections WHERE subject_user_id = ${subjectUserId}::uuid) RETURNING 1)
      SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM readiness_snapshots WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM mastery_projections WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM roadmap_actions WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM learner_progress WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM assessment_responses WHERE attempt_item_id IN (
          SELECT i.id FROM assessment_attempt_items i JOIN assessment_attempts a ON a.id = i.attempt_id WHERE a.subject_user_id = ${subjectUserId}::uuid) RETURNING 1)
        SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM assessment_attempt_items WHERE attempt_id IN (
          SELECT id FROM assessment_attempts WHERE subject_user_id = ${subjectUserId}::uuid) RETURNING 1)
        SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM assessment_attempts WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`)
      + await removed(sql`WITH gone AS (DELETE FROM assessment_assignments WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1) SELECT count(*)::int AS count FROM gone`);
    // Deletion triggers a rebuild of the skill state projection (ENG-05). With the facts gone the
    // rebuild is the empty set, so every projection row of the subject is removed here.
    const projection = await projectSubjectSkillState(tx, subjectUserId);
    return stepItems + attempts + placementItems + placementTests + sessions + activity + facultyActions + decisions + history + projection.deleted;
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

  // Every other staff-only college action about the person (Divakar, 2026-09-30; privacy-export-coverage.md
  // D1): interventions, faculty notes, verifications, and tasks or meetings the college kept to itself. All
  // of the text goes; the row stays, because the college's counts read it and 0082's attendee and content
  // rows reference it, and nothing left in it identifies the person once the account is anonymised. The
  // version moves on so an edit form still open elsewhere is refused as stale instead of writing text back.
  // staff_actions has no guard trigger, so no erase setting is needed.
  counts.STAFF_ACTIONS = await countOf(sql`
    WITH erased AS (
      UPDATE staff_actions SET title = ${STAFF_ACTION_ERASED_TITLE}, note = NULL, outcome_note = NULL,
        version = version + 1, updated_at = greatest(now(), created_at)
      WHERE subject_student_user_id = ${subjectUserId}::uuid AND visibility = 'STAFF_ONLY' AND action_type <> 'COUNSELLING_NOTE'
      RETURNING 1)
    SELECT count(*)::int AS count FROM erased`);

  // Nominations the person never accepted (INST-14, 0080) are only about them: erased. Accepted and
  // withdrawn ones stay with the application they produced, which is anonymised with APPLICATIONS,
  // and are counted there. The 0080 guard allows DELETE only inside this transaction-local setting.
  counts.APPLICATIONS = (counts.APPLICATIONS ?? 0) + await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${subjectUserId}, true)`);
    const gone = await tx.execute(sql`WITH gone AS (DELETE FROM campus_drive_nominations WHERE student_user_id = ${subjectUserId}::uuid AND application_id IS NULL RETURNING 1)
      SELECT count(*)::int AS count FROM gone`) as QueryResult<{ count: number }>;
    return Number(gone.rows[0]?.count ?? 0);
  });

  // Support cases (OPS-05) keep the service record and lose the person: the subject
  // link, the typed summary and every note on those cases.
  counts.SUPPORT_CASES = await detachSupportCasesForDeletedUser(db, subjectUserId);

  // The college's invitations to the person keep their row (the college's send record) and lose the
  // address, which is the person's identity as much as the account's email is.
  await db.execute(sql`
    UPDATE invitations SET email = ${replacement.email}, updated_at = now()
    WHERE (student_user_id = ${subjectUserId}::uuid OR accepted_by_user_id = ${subjectUserId}::uuid) AND email <> ${replacement.email}
  `);

  // Consent grants and withdrawals stay as proof of what the person agreed to (Divakar, 2026-09-30;
  // privacy-export-coverage.md D3). Nothing in the rows is changed: they already hold only what proof needs,
  // and the account they point at is anonymised below.
  counts.CONSENT_RECORDS = await countOf(sql`SELECT count(*)::int AS count FROM user_consents WHERE user_id = ${subjectUserId}::uuid`);

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
