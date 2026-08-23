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

  const [identity, profile, relationships, roster, documents, savedOpportunities, applications, offers, requests] = await Promise.all([
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
  ]);

  return {
    exportedAt: new Date().toISOString(),
    subjectUserId,
    // Says plainly what is not here, so an omission is not mistaken for "we hold nothing".
    notIncluded: [
      'Interview scorecards and employer notes, which are the employer\'s assessment rather than your record.',
      'Institution counselling notes held about you by your college.',
      'Security audit records, which are retained under the approved retention schedule.',
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
  };
}
