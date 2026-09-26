/**
 * Reading the student's own records into a consented application snapshot, and storing it
 * (EMP-07). Shared by the student's preview and by apply, so the snapshot the student reviews and
 * the one ONE stores are built by the same code from the same queries; packages/hiring decides the
 * content. Design: docs/architecture/application-snapshots-table-design.md.
 */
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  buildApplicationSnapshot,
  snapshotHash,
  type ApplicationSnapshotV1,
  type SnapshotChoices,
  type SnapshotQualificationSource,
  type SnapshotSources,
} from '@planthepath/hiring/src/application-snapshot.js';

type QueryResult<T> = { rows: T[] };
type Db = Pick<PersistenceDb, 'execute'>;

/** The chosen résumé's pointers, stored beside the snapshot; never shown to the employer. */
export interface ResumePointers { readonly documentId: string; readonly documentVersionId: string; readonly fileId: string }

export interface BuiltSnapshot {
  readonly snapshot: ApplicationSnapshotV1;
  readonly hash: string;
  readonly resume: ResumePointers | null;
}

export class SnapshotResumeUnavailable extends Error {
  constructor() { super('RESUME_NOT_AVAILABLE'); this.name = 'SnapshotResumeUnavailable'; }
}

/** The student's RESUME documents with a scanned-clean current file: what they may attach. */
export async function readResumeOptions(db: Db, studentUserId: string): Promise<readonly Record<string, unknown>[]> {
  const rows = await db.execute(sql`
    SELECT d.id, d.title, v.version_number, f.original_filename, f.content_type, f.byte_size
    FROM student_document_metadata d
    JOIN student_document_versions v ON v.id = d.current_version_id
    JOIN readable_stored_files f ON f.id = v.file_id
    WHERE d.student_user_id = ${studentUserId}::uuid AND d.document_type = 'RESUME' AND d.archived_at IS NULL
    ORDER BY d.updated_at DESC
    LIMIT 20
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.map((row) => ({
    documentId: row.id, title: row.title, versionNumber: Number(row.version_number),
    filename: row.original_filename, contentType: row.content_type, byteSize: Number(row.byte_size),
  }));
}

/**
 * Builds the snapshot from the student's records as they stand in `db` (inside apply, the apply
 * transaction). Throws SnapshotResumeUnavailable when the chosen résumé is not the student's,
 * not a résumé, archived, or has no scanned-clean file.
 */
export async function buildSnapshotFor(db: Db, studentUserId: string, resumeDocumentId: string | null, choices: SnapshotChoices): Promise<BuiltSnapshot> {
  // One after another: inside apply this runs on the transaction's single connection.
  const identity = await db.execute(sql`SELECT email FROM users WHERE id = ${studentUserId}::uuid`) as QueryResult<{ email: string }>;
  const roster = await (
    // The college's roster is the only place ONE holds a person's name. ACTIVE first; an alumnus
    // who has left applies with their GRADUATED record.
    db.execute(sql`
      SELECT isp.full_name, org.legal_name AS institution_name, prog.name AS programme_name, dept.name AS department_name,
             to_char(isp.expected_graduation_date, 'YYYY-MM-DD') AS expected_graduation_date
      FROM institution_student_profiles isp
      JOIN organizations org ON org.id = isp.institution_id
      LEFT JOIN institution_units prog ON prog.id = isp.program_unit_id
      LEFT JOIN institution_units dept ON dept.id = isp.department_unit_id
      WHERE isp.student_user_id = ${studentUserId}::uuid AND isp.status IN ('ACTIVE', 'GRADUATED')
      ORDER BY (isp.status = 'ACTIVE') DESC, isp.updated_at DESC, isp.id
      LIMIT 1
    `) as Promise<QueryResult<Record<string, unknown>>>);
  // A qualification the college rejected is not shared as if it stood.
  const qualifications = await (db.execute(sql`
      SELECT q.qualification_type, q.programme_name, coalesce(org.legal_name, q.institution_name_declared) AS institution_name,
             to_char(q.started_on, 'YYYY-MM-DD') AS started_on, to_char(q.completed_on, 'YYYY-MM-DD') AS completed_on,
             q.awarded, q.verification_state
      FROM student_qualifications q
      LEFT JOIN organizations org ON org.id = q.institution_id
      WHERE q.student_user_id = ${studentUserId}::uuid AND q.verification_state <> 'REJECTED'
      ORDER BY q.started_on DESC NULLS LAST, q.id
      LIMIT 20
    `) as Promise<QueryResult<Record<string, unknown>>>);
  const profile = await db.execute(sql`SELECT profile_headline, profile_summary FROM student_profiles WHERE user_id = ${studentUserId}::uuid`) as QueryResult<Record<string, unknown>>;

  let resume: SnapshotSources['resume'] = null;
  let pointers: ResumePointers | null = null;
  if (resumeDocumentId) {
    const rows = await db.execute(sql`
      SELECT d.id AS document_id, d.title, v.id AS version_id, v.version_number, f.id AS file_id,
             f.original_filename, f.content_type, f.byte_size
      FROM student_document_metadata d
      JOIN student_document_versions v ON v.id = d.current_version_id
      JOIN readable_stored_files f ON f.id = v.file_id
      WHERE d.id = ${resumeDocumentId}::uuid AND d.student_user_id = ${studentUserId}::uuid
        AND d.document_type = 'RESUME' AND d.archived_at IS NULL
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw new SnapshotResumeUnavailable();
    resume = {
      title: String(row.title), filename: String(row.original_filename), versionNumber: Number(row.version_number),
      contentType: String(row.content_type), byteSize: Number(row.byte_size),
    };
    pointers = { documentId: String(row.document_id), documentVersionId: String(row.version_id), fileId: String(row.file_id) };
  }

  const rosterRow = roster.rows[0];
  const profileRow = profile.rows[0];
  const text = (value: unknown): string | null => (value == null || value === '' ? null : String(value));
  const snapshot = buildApplicationSnapshot({
    email: String(identity.rows[0]?.email ?? ''),
    roster: rosterRow ? {
      fullName: text(rosterRow.full_name), institutionName: text(rosterRow.institution_name), programmeName: text(rosterRow.programme_name),
      departmentName: text(rosterRow.department_name), expectedGraduationDate: text(rosterRow.expected_graduation_date),
    } : null,
    qualifications: qualifications.rows.map((row): SnapshotQualificationSource => ({
      qualificationType: String(row.qualification_type), programmeName: String(row.programme_name), institutionName: text(row.institution_name),
      startedOn: text(row.started_on), completedOn: text(row.completed_on), awarded: row.awarded === true, verificationState: String(row.verification_state),
    })),
    profile: profileRow ? { headline: text(profileRow.profile_headline), summary: text(profileRow.profile_summary) } : null,
    resume,
  }, choices);
  return { snapshot, hash: snapshotHash(snapshot), resume: pointers };
}

/** Stores the one snapshot of an application, in the apply transaction. The 0058 trigger checks the version. */
export async function writeApplicationSnapshot(tx: Db, input: {
  readonly id: string; readonly applicationId: string; readonly versionId: string; readonly built: BuiltSnapshot;
}): Promise<void> {
  const { built } = input;
  await tx.execute(sql`
    INSERT INTO application_profile_snapshots (id, application_id, opportunity_version_id, schema_version, snapshot, snapshot_hash,
      resume_document_id, resume_document_version_id, resume_file_id)
    VALUES (${input.id}::uuid, ${input.applicationId}::uuid, ${input.versionId}::uuid, ${built.snapshot.schemaVersion},
      ${JSON.stringify(built.snapshot)}::jsonb, ${built.hash},
      ${built.resume?.documentId ?? null}::uuid, ${built.resume?.documentVersionId ?? null}::uuid, ${built.resume?.fileId ?? null}::uuid)
  `);
}
