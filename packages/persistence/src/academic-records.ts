/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Academic records: qualifications, terms and subjects, and the verified facts an
 * employer eligibility rule resolves against.
 *
 * Design frozen in docs/architecture/academic-records-table-design.md.
 *
 * The provenance rule is the whole point of this module: a value is stored on the
 * scale it was issued on, and normalisation happens here at comparison time only.
 * Nothing normalised is ever written back, so it always remains possible to tell what
 * the institution said from what we computed.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class AcademicRecordError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AcademicRecordError';
  }
}

type Queryable = Pool | PoolClient;

export type ResultScale = 'CGPA_10' | 'GPA_4' | 'PERCENTAGE' | 'LETTER' | 'PASS_FAIL';
export type VerificationState = 'SELF_REPORTED' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';

/**
 * Normalise an issued result to a 0..1 proportion for comparison.
 *
 * Returns null where a scale cannot be normalised — `LETTER` and `PASS_FAIL` carry no
 * ordering we can defend across institutions. Null means **unknown**, never a guess
 * and never a zero: the eligibility engine already distinguishes unknown from failing
 * and fails closed, so unknown is the honest answer and needs no new behaviour.
 */
export function normaliseResult(value: number | null, scale: ResultScale | null): number | null {
  if (value === null || scale === null) return null;
  switch (scale) {
    case 'CGPA_10': return value / 10;
    case 'GPA_4': return value / 4;
    case 'PERCENTAGE': return value / 100;
    default: return null;
  }
}

/** A CGPA-10 equivalent for an employer rule expressed in those terms. */
export function asCgpa10(value: number | null, scale: ResultScale | null): number | null {
  const proportion = normaliseResult(value, scale);
  return proportion === null ? null : Math.round(proportion * 10 * 1000) / 1000;
}

export interface AcademicEligibilityFacts {
  /** Null means unknown: no verified term exists, or its scale cannot be normalised. */
  readonly cgpa10: number | null;
  readonly cumulativeBacklogs: number | null;
  readonly hasVerifiedRecord: boolean;
  readonly qualificationId: string | null;
  readonly termLabel: string | null;
}

/**
 * The facts an employer eligibility rule resolves against.
 *
 * Verified terms only. A self-reported figure never satisfies an employer's rule —
 * that would defeat the purpose of the module. Backlogs are summed across verified
 * terms here rather than stored, per the frozen design.
 */
export async function getAcademicEligibilityFacts(
  client: Queryable,
  studentUserId: string,
): Promise<AcademicEligibilityFacts> {
  const latest = await client.query<{ qualificationId: string; label: string; resultValue: string | null; resultScale: ResultScale | null }>(
    `SELECT q.id AS "qualificationId", t.label, t.result_value AS "resultValue", t.result_scale AS "resultScale"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     WHERE q.student_user_id = $1
       AND q.institution_id IS NOT NULL
       AND t.verification_state = 'VERIFIED'
     ORDER BY q.started_on DESC NULLS LAST, t.sequence DESC
     LIMIT 1`, [studentUserId],
  );
  const row = latest.rows[0];
  if (!row) {
    return { cgpa10: null, cumulativeBacklogs: null, hasVerifiedRecord: false, qualificationId: null, termLabel: null };
  }
  const backlogs = await client.query<{ total: string | null }>(
    `SELECT sum(t.backlog_count)::text AS total
     FROM student_academic_terms t
     WHERE t.qualification_id = $1 AND t.verification_state = 'VERIFIED' AND t.backlog_count IS NOT NULL`,
    [row.qualificationId],
  );
  const total = backlogs.rows[0]?.total;
  return {
    cgpa10: asCgpa10(row.resultValue === null ? null : Number(row.resultValue), row.resultScale),
    cumulativeBacklogs: total === null || total === undefined ? null : Number(total),
    hasVerifiedRecord: true,
    qualificationId: row.qualificationId,
    termLabel: row.label,
  };
}

/** Everything a student or an authorized staff member sees about one student's record. */
export async function listAcademicRecords(pool: Pool, studentUserId: string): Promise<Record<string, unknown>> {
  const qualifications = await pool.query(
    `SELECT q.id, q.institution_id AS "institutionId", q.institution_name_declared AS "institutionNameDeclared",
            o.name AS "institutionName", q.qualification_type AS "qualificationType", q.programme_name AS "programmeName",
            q.started_on AS "startedOn", q.completed_on AS "completedOn", q.awarded,
            q.verification_state AS "verificationState", q.verified_at AS "verifiedAt"
     FROM student_qualifications q
     LEFT JOIN organizations o ON o.id = q.institution_id
     WHERE q.student_user_id=$1
     ORDER BY q.started_on DESC NULLS LAST, q.created_at DESC`, [studentUserId],
  );
  const terms = await pool.query(
    `SELECT t.id, t.qualification_id AS "qualificationId", t.sequence, t.label,
            t.result_value AS "resultValue", t.result_scale AS "resultScale", t.result_letter AS "resultLetter",
            t.backlog_count AS "backlogCount", t.source, t.evidence_document_version_id AS "evidenceDocumentVersionId",
            t.verification_state AS "verificationState", t.verified_at AS "verifiedAt"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     WHERE q.student_user_id=$1
     ORDER BY t.qualification_id, t.sequence`, [studentUserId],
  );
  return {
    qualifications: qualifications.rows.map((qualification) => ({
      ...qualification,
      terms: terms.rows.filter((term) => term.qualificationId === qualification.id),
    })),
    // Reported alongside, so a caller never has to re-derive it and never stores it.
    eligibilityFacts: await getAcademicEligibilityFacts(pool, studentUserId),
  };
}

export interface QualificationInput {
  readonly institutionId?: string | null;
  readonly institutionNameDeclared?: string | null;
  readonly qualificationType: string;
  readonly programmeName: string;
  readonly startedOn?: string | null;
  readonly completedOn?: string | null;
  readonly awarded?: boolean;
}

/** A student declares their own record. It starts self-reported, always. */
export async function declareQualification(
  pool: Pool,
  input: QualificationInput & { readonly studentUserId: string },
): Promise<{ readonly id: string }> {
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO student_qualifications
       (id, student_user_id, institution_id, institution_name_declared, qualification_type,
        programme_name, started_on, completed_on, awarded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, input.studentUserId, input.institutionId ?? null, input.institutionNameDeclared ?? null,
        input.qualificationType, input.programmeName, input.startedOn ?? null, input.completedOn ?? null,
        input.awarded ?? false],
    );
  } catch {
    throw new AcademicRecordError('ACADEMIC_QUALIFICATION_INVALID');
  }
  return { id };
}

export interface TermInput {
  readonly sequence: number;
  readonly label: string;
  readonly resultValue?: number | null;
  readonly resultScale?: ResultScale | null;
  readonly resultLetter?: string | null;
  readonly backlogCount?: number | null;
  readonly evidenceDocumentVersionId?: string | null;
}

export async function declareTerm(
  pool: Pool,
  input: TermInput & { readonly studentUserId: string; readonly qualificationId: string },
): Promise<{ readonly id: string }> {
  const owned = await pool.query<{ id: string }>(
    'SELECT id FROM student_qualifications WHERE id=$1 AND student_user_id=$2',
    [input.qualificationId, input.studentUserId],
  );
  if (!owned.rows[0]) throw new AcademicRecordError('ACADEMIC_QUALIFICATION_NOT_FOUND');

  const id = randomUUID();
  const source = input.evidenceDocumentVersionId ? 'DOCUMENT_BACKED' : 'STUDENT_DECLARED';
  try {
    await pool.query(
      `INSERT INTO student_academic_terms
       (id, qualification_id, sequence, label, result_value, result_scale, result_letter,
        backlog_count, source, evidence_document_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.qualificationId, input.sequence, input.label, input.resultValue ?? null,
        input.resultScale ?? null, input.resultLetter ?? null, input.backlogCount ?? null,
        source, input.evidenceDocumentVersionId ?? null],
    );
  } catch {
    throw new AcademicRecordError('ACADEMIC_TERM_INVALID');
  }
  return { id };
}

/** Ask the issuing institution to verify. Only a record with an issuer can be submitted. */
export async function submitTermForVerification(
  pool: Pool,
  input: { readonly studentUserId: string; readonly termId: string },
): Promise<void> {
  const result = await pool.query(
    `UPDATE student_academic_terms t SET verification_state='PENDING_VERIFICATION'
     FROM student_qualifications q
     WHERE t.id=$1 AND t.qualification_id=q.id AND q.student_user_id=$2
       AND q.institution_id IS NOT NULL
       AND t.verification_state IN ('SELF_REPORTED','REJECTED')`,
    [input.termId, input.studentUserId],
  );
  if (!result.rowCount) throw new AcademicRecordError('ACADEMIC_TERM_NOT_SUBMITTABLE');
}

/**
 * The issuing institution decides.
 *
 * Scoped to `q.institution_id = $institutionId`, so a second institution cannot verify
 * a record it did not issue however convenient that would be for a transfer student.
 * The trigger in 0070 additionally refuses to let a VERIFIED row move back.
 */
export async function decideTermVerification(
  pool: Pool,
  input: {
    readonly institutionId: string;
    readonly reviewerUserId: string;
    readonly termId: string;
    readonly decision: 'VERIFIED' | 'REJECTED';
  },
): Promise<void> {
  const result = await pool.query(
    `UPDATE student_academic_terms t
     SET verification_state=$4, verified_by_user_id=$3, verified_at=now()
     FROM student_qualifications q
     WHERE t.id=$1 AND t.qualification_id=q.id AND q.institution_id=$2
       AND t.verification_state = 'PENDING_VERIFICATION'`,
    [input.termId, input.institutionId, input.reviewerUserId, input.decision],
  );
  if (!result.rowCount) throw new AcademicRecordError('ACADEMIC_TERM_NOT_REVIEWABLE');
}

/** The verification queue an institution works from. */
export async function listVerificationQueue(pool: Pool, institutionId: string): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT t.id AS "termId", t.label, t.sequence, t.result_value AS "resultValue", t.result_scale AS "resultScale",
            t.result_letter AS "resultLetter", t.backlog_count AS "backlogCount", t.source,
            t.evidence_document_version_id AS "evidenceDocumentVersionId",
            q.id AS "qualificationId", q.programme_name AS "programmeName", q.qualification_type AS "qualificationType",
            q.student_user_id AS "studentUserId", u.email AS "studentEmail"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     JOIN users u ON u.id = q.student_user_id
     WHERE q.institution_id=$1 AND t.verification_state='PENDING_VERIFICATION'
     ORDER BY t.created_at`, [institutionId],
  );
  return result.rows;
}
