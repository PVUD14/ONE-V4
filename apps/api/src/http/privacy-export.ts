import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

type QueryResult<T> = { rows: T[] };

/**
 * Assembles everything the platform holds about one person into a single document.
 *
 * Scoped strictly to the subject: every query filters on their user id, so an export
 * can never contain another person's data. Employer-side commentary such as interview
 * scorecards and internal notes is deliberately excluded, since those are the
 * employer's assessments rather than the subject's own record, and returning them
 * would disclose another party's material through a subject request.
 */
export async function assembleSubjectExport(db: PersistenceDb, subjectUserId: string): Promise<Record<string, unknown>> {
  const one = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    ((await db.execute(query)) as QueryResult<Record<string, unknown>>).rows;

  const [identity, profile, relationships, roster, documents, savedOpportunities, applications, offers, requests, sharedNotes, heldNotes, messages, screenings, screeningQuestions] = await Promise.all([
    one(sql`SELECT id, email, state, created_at, anonymised_at FROM users WHERE id = ${subjectUserId}::uuid`),
    one(sql`SELECT target_career, career_interests, profile_headline, profile_summary, portfolio_url, visibility_state, employer_discovery_enabled, updated_at
            FROM student_profiles WHERE user_id = ${subjectUserId}::uuid`),
    one(sql`SELECT institution_id, state, effective_from, effective_to FROM institution_relationships
            WHERE student_user_id = ${subjectUserId}::uuid ORDER BY effective_from`),
    one(sql`SELECT institution_id, institution_student_id, full_name, status, academic_start_date, expected_graduation_date
            FROM institution_student_profiles WHERE student_user_id = ${subjectUserId}::uuid`),
    one(sql`SELECT d.id, d.title, d.document_type, d.description, d.verification_state, d.created_at, d.archived_at,
                   v.version_number, f.original_filename, f.byte_size, f.checksum_sha256
            FROM student_document_metadata d
            LEFT JOIN student_document_versions v ON v.document_id = d.id
            LEFT JOIN stored_files f ON f.id = v.file_id
            WHERE d.student_user_id = ${subjectUserId}::uuid ORDER BY d.created_at, v.version_number`),
    one(sql`SELECT opportunity_ref, title, organization_name, notes, created_at, archived_at
            FROM student_saved_opportunities WHERE student_user_id = ${subjectUserId}::uuid ORDER BY created_at`),
    one(sql`SELECT a.id, a.state, a.submitted_at, a.closed_at, a.withdrawn_reason, org.legal_name AS employer_name, v.title
            FROM applications a
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            WHERE a.student_user_id = ${subjectUserId}::uuid ORDER BY a.created_at`),
    one(sql`SELECT o.state, o.compensation_currency, o.compensation_amount, o.compensation_period, o.joining_date, o.extended_at, o.responded_at, org.legal_name AS employer_name
            FROM offers o
            JOIN applications a ON a.id = o.application_id
            JOIN organizations org ON org.id = o.employer_id
            WHERE a.student_user_id = ${subjectUserId}::uuid ORDER BY o.created_at`),
    one(sql`SELECT request_type, state, requested_at, completed_at FROM privacy_requests
            WHERE subject_user_id = ${subjectUserId}::uuid ORDER BY requested_at`),
    // INST-11: counselling notes the college shared with the subject, in full; for the ones it has
    // not shared, how many each college holds (DPDP s.11 summary), never their text.
    one(sql`SELECT org.legal_name AS institution_name, a.title, a.note, a.created_at
            FROM staff_actions a JOIN organizations org ON org.id = a.institution_id
            WHERE a.subject_student_user_id = ${subjectUserId}::uuid AND a.action_type = 'COUNSELLING_NOTE'
              AND a.visibility = 'SUBJECT_VISIBLE'
            ORDER BY a.created_at, a.id`),
    one(sql`SELECT org.legal_name AS institution_name, count(*)::int AS staff_only_notes
            FROM staff_actions a JOIN organizations org ON org.id = a.institution_id
            WHERE a.subject_student_user_id = ${subjectUserId}::uuid AND a.action_type = 'COUNSELLING_NOTE'
              AND a.visibility = 'STAFF_ONLY'
            GROUP BY org.legal_name ORDER BY org.legal_name`),
    // EMP-10: the subject's application conversations — both sides, which company, never which recruiter.
    one(sql`SELECT t.id AS thread_id, org.legal_name AS employer_name, v.title, t.started_at,
                   m.sender_side, m.body, m.sent_at, m.read_at, m.erased_at, m.erasure_reason,
                   CASE WHEN m.sender_side = 'EMPLOYER' THEN m.reported_at END AS reported_at
            FROM application_message_threads t
            JOIN applications a ON a.id = t.application_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            JOIN organizations org ON org.id = t.employer_id
            JOIN application_messages m ON m.thread_id = t.id
            WHERE t.student_user_id = ${subjectUserId}::uuid
            ORDER BY t.started_at, t.id, m.sent_at, m.id`),
    // Employer screening tests sent on the subject's applications, and their own attempt at each: what
    // they already see on My applications (the percentage), never the raw score or how it was marked.
    one(sql`SELECT v.id AS invitation_id, org.legal_name AS employer_name, ov.title AS role_title, s.title,
                   v.invited_at, v.opens_at, v.closes_at,
                   CASE WHEN v.state = 'INVITED' AND v.closes_at <= now() THEN 'EXPIRED' ELSE v.state END AS state,
                   t.id AS attempt_id, t.state AS attempt_state, t.started_at, t.submitted_at, t.percentage
            FROM employer_assessment_invitations v
            JOIN employer_assessments s ON s.id = v.assessment_id
            JOIN applications a ON a.id = v.application_id
            JOIN opportunity_versions ov ON ov.id = a.applied_version_id
            JOIN organizations org ON org.id = v.employer_id
            LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id AND t.candidate_user_id = ${subjectUserId}::uuid
            WHERE a.student_user_id = ${subjectUserId}::uuid
            ORDER BY v.invited_at, v.id`),
    // Each question they were served, the options as shown to them and what they chose. Option
    // correctness (the answer key) and the marks each answer earned are never selected.
    one(sql`SELECT aq.attempt_id, aq.display_order, aq.option_map, q.question_text,
                   (SELECT coalesce(jsonb_object_agg(o.option_key, o.option_text), '{}'::jsonb)
                    FROM employer_assessment_question_options o WHERE o.question_id = aq.question_id) AS option_texts,
                   ans.selected_option_keys, ans.numeric_response
            FROM employer_assessment_attempt_questions aq
            JOIN employer_assessment_attempts t ON t.id = aq.attempt_id
            JOIN employer_assessment_questions q ON q.id = aq.question_id
            LEFT JOIN employer_assessment_answers ans ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
            WHERE t.candidate_user_id = ${subjectUserId}::uuid
            ORDER BY aq.attempt_id, aq.display_order`),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    subjectUserId,
    // Says plainly what is not here, so an omission is not mistaken for "we hold nothing".
    notIncluded: [
      'Interview scorecards and employer notes, which are the employer\'s assessment rather than your record.',
      'The text of counselling notes your college has not shared with you. How many each college holds is listed under counsellingNotes; the college can share them with you.',
      'Security audit records, which are retained under the approved retention schedule.',
      'Which member of an employer team wrote each application message, and how operations handled any message you reported.',
      'The answer key to employer screening tests, and how each of your answers was marked. Your result is shown as the percentage you see on My applications.',
    ],
    identity: identity[0] ?? null,
    studentProfile: profile[0] ?? null,
    institutionRelationships: relationships,
    institutionRecords: roster,
    documents,
    savedOpportunities,
    applications,
    offers,
    privacyRequests: requests,
    applicationMessages: groupConversations(messages),
    screeningAssessments: screeningAttempts(screenings, screeningQuestions),
    counsellingNotes: {
      shared: sharedNotes.map((row) => ({ institutionName: row.institution_name, title: row.title, note: row.note, createdAt: row.created_at })),
      heldByCollege: heldNotes.map((row) => ({ institutionName: row.institution_name, staffOnlyNotes: row.staff_only_notes })),
    },
  };
}

/** One entry per conversation, its messages in order. Erased text says so rather than vanishing. */
function groupConversations(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const byThread = new Map<string, { employerName: unknown; title: unknown; startedAt: unknown; messages: Record<string, unknown>[] }>();
  for (const row of rows) {
    const key = String(row.thread_id);
    let conversation = byThread.get(key);
    if (!conversation) {
      conversation = { employerName: row.employer_name, title: row.title, startedAt: row.started_at, messages: [] };
      byThread.set(key, conversation);
    }
    conversation.messages.push({
      from: row.sender_side === 'STUDENT' ? 'YOU' : 'EMPLOYER',
      text: row.body ?? null,
      erased: row.erased_at != null ? { at: row.erased_at, reason: row.erasure_reason } : null,
      sentAt: row.sent_at,
      readAt: row.read_at ?? null,
      reportedByYouAt: row.reported_at ?? null,
    });
  }
  return [...byThread.values()];
}

/**
 * One entry per screening test sent to the subject, with their attempt if they started it. Options and
 * selections use the keys the candidate saw (their shuffle), not the stored ones, and the stored
 * mapping itself is not exported.
 */
function screeningAttempts(invitations: readonly Record<string, unknown>[], questions: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return invitations.map((row) => ({
    employerName: row.employer_name,
    roleTitle: row.role_title,
    title: row.title,
    invitedAt: row.invited_at,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    state: row.state,
    attempt: row.attempt_id == null ? null : {
      state: row.attempt_state,
      startedAt: row.started_at,
      submittedAt: row.submitted_at ?? null,
      percentage: row.percentage == null ? null : Number(row.percentage),
      questions: questions.filter((question) => question.attempt_id === row.attempt_id).map((question) => {
        const optionMap = (question.option_map ?? {}) as Record<string, string>;
        const optionTexts = (question.option_texts ?? {}) as Record<string, string>;
        const shownAs = new Map(Object.entries(optionMap).map(([displayKey, storedKey]) => [storedKey, displayKey]));
        const selected = (question.selected_option_keys as string[] | null) ?? [];
        return {
          displayOrder: Number(question.display_order),
          questionText: question.question_text,
          options: Object.entries(optionMap)
            .map(([displayKey, storedKey]) => ({ key: displayKey, text: optionTexts[storedKey] ?? '' }))
            .sort((left, right) => left.key.localeCompare(right.key)),
          yourAnswer: {
            selectedOptionKeys: selected.map((storedKey) => shownAs.get(storedKey)).filter((key): key is string => key !== undefined).sort(),
            numericResponse: question.numeric_response == null ? null : Number(question.numeric_response),
          },
        };
      }),
    },
  }));
}
