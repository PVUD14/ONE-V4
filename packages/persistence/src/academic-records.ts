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
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeClause } from './institution-scope.js';

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
            o.legal_name AS "institutionName", q.qualification_type AS "qualificationType", q.programme_name AS "programmeName",
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
  // The foreign key guarantees the organization exists and nothing more. Without this
  // check a qualification could name an employer, which no institution staff member can
  // ever reach -- leaving the student waiting on a queue nobody can see.
  if (input.institutionId) {
    const issuer = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE id=$1 AND kind='INSTITUTION' AND active AND verification_state='VERIFIED'`,
      [input.institutionId],
    );
    if (!issuer.rows[0]) throw new AcademicRecordError('ACADEMIC_ISSUER_NOT_AN_INSTITUTION');
  }

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
 *
 * With a `reasonCode` and `correlationId` the decision and its audit row are written in
 * one transaction (INST-04, Section 5.4): a decision nobody can trace is not one a
 * college can stand behind.
 */
export async function decideTermVerification(
  pool: Pool,
  input: {
    readonly institutionId: string;
    readonly reviewerUserId: string;
    readonly termId: string;
    readonly decision: 'VERIFIED' | 'REJECTED';
    readonly reasonCode?: string;
    readonly correlationId?: string;
  },
): Promise<void> {
  const update = `UPDATE student_academic_terms t
     SET verification_state=$4, verified_by_user_id=$3, verified_at=now()
     FROM student_qualifications q
     WHERE t.id=$1 AND t.qualification_id=q.id AND q.institution_id=$2
       AND t.verification_state = 'PENDING_VERIFICATION'`;
  const parameters = [input.termId, input.institutionId, input.reviewerUserId, input.decision];
  if (input.reasonCode === undefined || input.correlationId === undefined) {
    const result = await pool.query(update, parameters);
    if (!result.rowCount) throw new AcademicRecordError('ACADEMIC_TERM_NOT_REVIEWABLE');
    return;
  }
  // A PoolClient (as the persistence tests pass) is already one connection; a Pool lends one.
  const client = 'release' in pool ? null : await pool.connect();
  const db: Queryable = client ?? pool;
  try {
    await db.query('BEGIN');
    const result = await db.query(update, parameters);
    if (!result.rowCount) throw new AcademicRecordError('ACADEMIC_TERM_NOT_REVIEWABLE');
    await db.query(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
       VALUES ($1,$2,'academic_term.verification_decided','student_academic_term',$3,$4,'SUCCESS',$5,$6::jsonb)`,
      [randomUUID(), input.reviewerUserId, input.termId, input.institutionId, input.correlationId,
        JSON.stringify({ decision: input.decision, reasonCode: input.reasonCode })],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

/**
 * The verification queue an institution works from.
 *
 * Scoped by which institution *issued* the qualification, and by nothing else. It does
 * not ask whether the person is still enrolled, and that is deliberate: an alumnus asking
 * their old college to confirm a result they earned in 2019 is exactly as legitimate as a
 * current student submitting this semester. Do not add an enrolment filter here.
 *
 * `relationship` tells staff which case they are looking at. CURRENT and FORMER can be
 * checked against the roster; NONE means the institution holds no record of this person
 * at all, so the answer is in an archive rather than on a screen.
 *
 * `studentName` comes from this institution's own roster and is therefore null for a
 * NONE request -- ONE holds no platform-level name for a person, only the one each
 * institution recorded. A null is the truth, and callers must show the email rather than
 * inventing a name to fill the column.
 */
/**
 * Pending terms for the institution. A scoped reader (INST-02) sees only students whose
 * roster profile falls inside their units; a claim from someone with no roster profile
 * (a past student asking retroactively) has no unit and stays with institution-wide staff.
 */
export async function listVerificationQueue(
  pool: Pool,
  institutionId: string,
  scope: InstitutionStudentScope = { kind: 'INSTITUTION' },
  page: { readonly limit?: number; readonly after?: string | null } = {},
): Promise<readonly Record<string, unknown>[]> {
  const values: unknown[] = [institutionId];
  const inScope = scope.kind === 'INSTITUTION' ? 'TRUE' : institutionStudentScopeClause(scope, 'isp', values);
  // Keyset pagination (Section 5.6): oldest request first, then by id for a stable order.
  values.push(Math.min(Math.max(Math.trunc(page.limit ?? 200), 1), 200));
  const limitRef = `$${values.length}`;
  let after = 'TRUE';
  if (page.after) {
    values.push(page.after);
    after = `(t.created_at, t.id) > (SELECT c.created_at, c.id FROM student_academic_terms c WHERE c.id = $${values.length}::uuid)`;
  }
  const result = await pool.query(
    `SELECT t.id AS "termId", t.label, t.sequence, t.result_value AS "resultValue", t.result_scale AS "resultScale",
            t.result_letter AS "resultLetter", t.backlog_count AS "backlogCount", t.source,
            t.evidence_document_version_id AS "evidenceDocumentVersionId",
            q.id AS "qualificationId", q.programme_name AS "programmeName", q.qualification_type AS "qualificationType",
            q.started_on AS "claimedStartedOn", q.completed_on AS "claimedCompletedOn",
            q.student_user_id AS "studentUserId", u.email AS "studentEmail",
            isp.full_name AS "studentName", isp.institution_student_id AS "institutionStudentId",
            COALESCE((
              SELECT CASE
                       WHEN bool_or(r.state IN ('VERIFIED','ACTIVE')) THEN 'CURRENT'
                       WHEN bool_or(r.state IN ('GRADUATED','TRANSFERRED','ENDED')) THEN 'FORMER'
                       ELSE 'NONE'
                     END
              FROM institution_relationships r
              WHERE r.institution_id = q.institution_id AND r.student_user_id = q.student_user_id
            ), 'NONE') AS "relationship",
            -- ADR-027: what staff may know about evidence without the student's consent for
            -- that version -- title, type and version number. Never the filename, never a link.
            CASE WHEN t.evidence_document_version_id IS NULL THEN NULL ELSE (
              SELECT jsonb_build_object('title', dm.title, 'documentType', dm.document_type,
                                        'versionNumber', dv.version_number, 'shared', false)
              FROM student_document_versions dv
              JOIN student_document_metadata dm ON dm.id = dv.document_id
              WHERE dv.id = t.evidence_document_version_id
            ) END AS "evidence",
            -- A result this institution has already verified for the same term, when it
            -- differs from the claim: the conflict a bulk upload left in place is shown to
            -- the person deciding, never resolved by overwriting the student's value.
            (
              SELECT jsonb_build_object('resultValue', vt.result_value, 'resultScale', vt.result_scale,
                                        'resultLetter', vt.result_letter, 'backlogCount', vt.backlog_count)
              FROM student_academic_terms vt
              JOIN student_qualifications vq ON vq.id = vt.qualification_id
              WHERE vq.institution_id = q.institution_id AND vq.student_user_id = q.student_user_id
                AND vt.sequence = t.sequence AND vt.verification_state = 'VERIFIED' AND vt.id <> t.id
                AND (vt.result_scale IS DISTINCT FROM t.result_scale OR vt.result_value IS DISTINCT FROM t.result_value
                     OR vt.result_letter IS DISTINCT FROM t.result_letter OR vt.backlog_count IS DISTINCT FROM t.backlog_count)
              ORDER BY vt.verified_at DESC
              LIMIT 1
            ) AS "institutionRecord"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     JOIN users u ON u.id = q.student_user_id
     LEFT JOIN institution_student_profiles isp
       ON isp.student_user_id = q.student_user_id AND isp.institution_id = q.institution_id
     WHERE q.institution_id=$1 AND t.verification_state='PENDING_VERIFICATION'
       AND ${inScope} AND ${after}
     ORDER BY t.created_at, t.id
     LIMIT ${limitRef}`, values,
  );
  return result.rows;
}

/**
 * Counts for the dashboards, computed in SQL over the same scoped rows as the queue
 * (Section 5.6: dashboards use summary endpoints, never lists counted in the browser).
 */
export async function verificationQueueSummary(
  pool: Pool,
  institutionId: string,
  scope: InstitutionStudentScope = { kind: 'INSTITUTION' },
): Promise<{ readonly pending: number; readonly notCurrent: number }> {
  const values: unknown[] = [institutionId];
  const inScope = scope.kind === 'INSTITUTION' ? 'TRUE' : institutionStudentScopeClause(scope, 'isp', values);
  const result = await pool.query<{ pending: string; notCurrent: string }>(
    `SELECT count(*)::text AS pending,
            count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM institution_relationships r
              WHERE r.institution_id = q.institution_id AND r.student_user_id = q.student_user_id
                AND r.state IN ('VERIFIED','ACTIVE')))::text AS "notCurrent"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     LEFT JOIN institution_student_profiles isp
       ON isp.student_user_id = q.student_user_id AND isp.institution_id = q.institution_id
     WHERE q.institution_id=$1 AND t.verification_state='PENDING_VERIFICATION' AND ${inScope}`, values,
  );
  return { pending: Number(result.rows[0]?.pending ?? 0), notCurrent: Number(result.rows[0]?.notCurrent ?? 0) };
}

/**
 * Institutions a student can name as the issuer of a qualification.
 *
 * Identity only -- enough to recognise your own college in a list, and nothing an
 * institution did not ask to publish. Verified and active only: an unverified
 * organization cannot meaningfully confirm anything.
 */
export async function searchInstitutions(
  pool: Pool,
  query: string,
  limit = 20,
): Promise<readonly Record<string, unknown>[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  const result = await pool.query(
    `SELECT o.id, o.legal_name AS "name", pr.city, pr.state_or_province AS "stateOrProvince"
     FROM organizations o
     LEFT JOIN organization_profiles pr ON pr.organization_id = o.id
     WHERE o.kind='INSTITUTION' AND o.active AND o.verification_state='VERIFIED'
       AND o.legal_name ILIKE '%' || $1 || '%'
     ORDER BY o.legal_name
     LIMIT $2`,
    [term, Math.min(Math.max(limit, 1), 50)],
  );
  return result.rows;
}
