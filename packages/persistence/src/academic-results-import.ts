/**
 * Academic results import: a college uploads a term's results and ONE records them as
 * institution-verified, attributed to the person who uploaded them (INST-04).
 *
 * Design: docs/architecture/academic-results-import-design.md. Decision 10.2 #9 is the
 * policy — the institution's record is created, and where a student reported something
 * else that is shown, never overwritten. The preview stores nothing; commit re-evaluates
 * the same file inside its transaction and refuses unless the result still matches the
 * digest the uploader was shown.
 *
 * A roll number that belongs to a student who deleted their account is SKIPPED (`student_deleted`):
 * the roster keeps the anonymised row, but nothing is ever created or confirmed for that person again
 * (Divakar, 2026-09-30; docs/architecture/privacy-export-coverage.md, D4).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeClause } from './institution-scope.js';
import { AcademicRecordError, type ResultScale } from './academic-records.js';

type Queryable = Pool | PoolClient;

export const resultsImportColumns = [
  'institution_student_id', 'term_sequence', 'term_label', 'scale', 'result', 'backlogs', 'qualification_type', 'programme',
] as const;
const requiredColumns = resultsImportColumns.slice(0, 6);
const scales: readonly ResultScale[] = ['CGPA_10', 'GPA_4', 'PERCENTAGE', 'LETTER', 'PASS_FAIL'];
const qualificationTypes = ['BTECH', 'BE', 'BSC', 'BA', 'BCOM', 'BBA', 'BCA', 'MBBS', 'BDS', 'DIPLOMA',
  'MTECH', 'ME', 'MBA', 'MSC', 'MA', 'MCOM', 'MCA', 'PHD', 'OTHER'];
const maxRows = 1_000;
const maxBytes = 512_000;
const formulaPrefix = /^[=+\-@]/;

export type ResultsImportOutcome = 'CREATE' | 'CONFIRM' | 'UNCHANGED' | 'CONFLICT' | 'INVALID' | 'SKIPPED';

interface ParsedRow {
  readonly rowNumber: number;
  readonly institutionStudentId: string;
  readonly termSequence: string;
  readonly termLabel: string;
  readonly scale: string;
  readonly result: string;
  readonly backlogs: string;
  readonly qualificationType: string;
  readonly programme: string;
}

/** A recorded term as shown beside a row: the value as issued, with its scale. */
export interface RecordedResult {
  readonly resultValue: string | null;
  readonly resultScale: ResultScale | null;
  readonly resultLetter: string | null;
  readonly backlogCount: number | null;
  readonly verificationState: string;
}

/** What the uploader sees for one row. No internal identifiers. */
export interface ResultsImportRowView {
  readonly rowNumber: number;
  readonly institutionStudentId: string;
  readonly studentName: string | null;
  readonly termSequence: number | null;
  readonly termLabel: string;
  readonly scale: string;
  readonly result: string;
  readonly backlogs: number | null;
  readonly outcome: ResultsImportOutcome;
  readonly issues: readonly string[];
  /** A differing value the student declared; kept, shown, never overwritten. */
  readonly studentReported: RecordedResult | null;
  /** The already-verified record a CONFLICT or UNCHANGED row was compared against. */
  readonly verifiedRecord: RecordedResult | null;
}

interface EvaluatedRow extends ResultsImportRowView {
  readonly studentUserId: string | null;
  readonly value: { readonly resultValue: number | null; readonly resultScale: ResultScale; readonly resultLetter: string | null } | null;
  /** CONFIRM: the student's term to verify. */
  readonly confirmTermId: string | null;
  /** CREATE: the institution-issued qualification, or null when this commit creates it. */
  readonly targetQualificationId: string | null;
  readonly newQualification: { readonly qualificationType: string; readonly programmeName: string; readonly startedOn: string | null } | null;
}

export interface ResultsImportEvaluation {
  readonly digest: string;
  readonly rowCount: number;
  readonly counts: Readonly<Record<'create' | 'confirm' | 'unchanged' | 'conflict' | 'invalid' | 'skipped' | 'differsFromStudent', number>>;
  readonly rows: readonly ResultsImportRowView[];
}

/** Whole-file problems. Row problems are row issues, never exceptions. */
export function parseResultsCsv(csv: string): readonly ParsedRow[] {
  if (typeof csv !== 'string' || csv.length === 0 || csv.length > maxBytes) throw new AcademicRecordError('RESULTS_CSV_INVALID');
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2 || lines.length > maxRows + 1) throw new AcademicRecordError('RESULTS_CSV_INVALID');
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const known = new Set<string>(resultsImportColumns);
  if (new Set(header).size !== header.length || header.some((column) => !known.has(column))
    || !requiredColumns.every((column) => header.includes(column))) {
    throw new AcademicRecordError('RESULTS_CSV_HEADER_INVALID');
  }
  return lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    if (cells.length > header.length) throw new AcademicRecordError('RESULTS_CSV_INVALID');
    const cell = (column: string): string => {
      const at = header.indexOf(column);
      return at < 0 ? '' : (cells[at] ?? '').trim();
    };
    return {
      rowNumber: index + 2,
      institutionStudentId: cell('institution_student_id'),
      termSequence: cell('term_sequence'),
      termLabel: cell('term_label'),
      scale: cell('scale').toUpperCase(),
      result: cell('result'),
      backlogs: cell('backlogs'),
      qualificationType: cell('qualification_type').toUpperCase(),
      programme: cell('programme'),
    };
  });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

/** The value as issued, checked against its own scale. Null when it does not fit. */
function readResult(scale: ResultScale, raw: string): { resultValue: number | null; resultLetter: string | null } | null {
  if (scale === 'LETTER') {
    const letter = raw.toUpperCase();
    return /^[A-Z][A-Z0-9+-]{0,15}$/.test(letter) ? { resultValue: null, resultLetter: letter } : null;
  }
  if (scale === 'PASS_FAIL') {
    const letter = raw.toUpperCase();
    return letter === 'PASS' || letter === 'FAIL' ? { resultValue: null, resultLetter: letter } : null;
  }
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(raw)) return null;
  const value = Number(raw);
  const max = scale === 'CGPA_10' ? 10 : scale === 'GPA_4' ? 4 : 100;
  return value >= 0 && value <= max ? { resultValue: value, resultLetter: null } : null;
}

interface RosterRow { studentUserId: string; rollNumber: string; fullName: string; programmeUnit: string | null; startedOn: string | null; deleted: boolean }
interface TermRow {
  id: string; qualificationId: string; studentUserId: string; sequence: number;
  resultValue: string | null; resultScale: ResultScale | null; resultLetter: string | null; backlogCount: number | null;
  verificationState: string; institutionIssued: boolean;
}

function sameResult(term: TermRow, value: NonNullable<EvaluatedRow['value']>, backlogs: number): boolean {
  if (term.resultScale !== value.resultScale || term.backlogCount !== backlogs) return false;
  if (value.resultLetter !== null) return (term.resultLetter ?? '').toUpperCase() === value.resultLetter;
  return term.resultValue !== null && Number(term.resultValue) === value.resultValue;
}

function recorded(term: TermRow): RecordedResult {
  return { resultValue: term.resultValue, resultScale: term.resultScale, resultLetter: term.resultLetter,
    backlogCount: term.backlogCount, verificationState: term.verificationState };
}

/**
 * Evaluate every row against the roster (inside the uploader's scope) and the terms the
 * students already hold at this institution. Pure reads; safe inside a transaction.
 */
export async function evaluateResultsImport(
  db: Queryable,
  institutionId: string,
  scope: InstitutionStudentScope,
  parsed: readonly ParsedRow[],
): Promise<{ readonly evaluation: ResultsImportEvaluation; readonly rows: readonly EvaluatedRow[] }> {
  const rollNumbers = [...new Set(parsed.map((row) => row.institutionStudentId.toLowerCase()).filter(Boolean))];
  const values: unknown[] = [institutionId, rollNumbers];
  const inScope = institutionStudentScopeClause(scope, 'isp', values);
  const roster = (await db.query<RosterRow>(
    `SELECT isp.student_user_id AS "studentUserId", lower(isp.institution_student_id) AS "rollNumber",
            isp.full_name AS "fullName", pu.name AS "programmeUnit", isp.academic_start_date::text AS "startedOn",
            (u.anonymised_at IS NOT NULL) AS "deleted"
     FROM institution_student_profiles isp
     JOIN users u ON u.id = isp.student_user_id
     LEFT JOIN institution_units pu ON pu.id = isp.program_unit_id
     WHERE isp.institution_id = $1 AND lower(isp.institution_student_id) = ANY($2::text[]) AND ${inScope}`, values,
  )).rows;
  const byRoll = new Map(roster.map((row) => [row.rollNumber, row]));
  // A deleted person's records are never read or written again, so they are not even looked up.
  const studentIds = [...new Set(roster.filter((row) => !row.deleted).map((row) => row.studentUserId))];
  const terms = studentIds.length === 0 ? [] : (await db.query<TermRow>(
    `SELECT t.id, t.qualification_id AS "qualificationId", q.student_user_id AS "studentUserId", t.sequence,
            t.result_value::text AS "resultValue", t.result_scale AS "resultScale", t.result_letter AS "resultLetter",
            t.backlog_count AS "backlogCount", t.verification_state AS "verificationState",
            (q.verification_state = 'VERIFIED') AS "institutionIssued"
     FROM student_academic_terms t
     JOIN student_qualifications q ON q.id = t.qualification_id
     WHERE q.institution_id = $1 AND q.student_user_id = ANY($2::uuid[])
     ORDER BY (q.verification_state = 'VERIFIED') DESC, t.created_at DESC, t.id`, [institutionId, studentIds],
  )).rows;
  const issued = studentIds.length === 0 ? [] : (await db.query<{ id: string; studentUserId: string }>(
    `SELECT DISTINCT ON (student_user_id) id, student_user_id AS "studentUserId"
     FROM student_qualifications
     WHERE institution_id = $1 AND student_user_id = ANY($2::uuid[]) AND verification_state = 'VERIFIED'
     ORDER BY student_user_id, created_at DESC, id`, [institutionId, studentIds],
  )).rows;
  const issuedByStudent = new Map(issued.map((row) => [row.studentUserId, row.id]));

  const seen = new Set<string>();
  const pendingNewQualification = new Map<string, { qualificationType: string; programmeName: string }>();
  const rows: EvaluatedRow[] = parsed.map((row) => {
    const issues: string[] = [];
    const found = byRoll.get(row.institutionStudentId.toLowerCase()) ?? null;
    if (found?.deleted) {
      // Whatever else the row says, nothing will be written for this person, so there is nothing to fix.
      return {
        rowNumber: row.rowNumber, institutionStudentId: row.institutionStudentId, studentName: found.fullName,
        termSequence: /^\d{1,2}$/.test(row.termSequence) ? Number(row.termSequence) : null, termLabel: row.termLabel,
        scale: row.scale, result: row.result, backlogs: /^\d{1,3}$/.test(row.backlogs) ? Number(row.backlogs) : null,
        outcome: 'SKIPPED' as const, issues: ['student_deleted'], studentReported: null, verifiedRecord: null,
        studentUserId: null, value: null, confirmTermId: null, targetQualificationId: null, newQualification: null,
      };
    }
    const student = found;
    if (!row.institutionStudentId || formulaPrefix.test(row.institutionStudentId) || !student) issues.push('student_not_found');
    const sequence = /^\d{1,2}$/.test(row.termSequence) ? Number(row.termSequence) : NaN;
    if (!(sequence >= 1 && sequence <= 30)) issues.push('term_sequence_invalid');
    if (row.termLabel.length < 1 || row.termLabel.length > 80 || formulaPrefix.test(row.termLabel)) issues.push('term_label_invalid');
    const scale = scales.includes(row.scale as ResultScale) ? row.scale as ResultScale : null;
    if (!scale) issues.push('scale_invalid');
    const parsedResult = scale ? readResult(scale, row.result) : null;
    if (scale && !parsedResult) issues.push('result_invalid');
    const backlogs = /^\d{1,3}$/.test(row.backlogs) && Number(row.backlogs) <= 100 ? Number(row.backlogs) : null;
    if (backlogs === null) issues.push('backlogs_invalid');
    if (row.qualificationType && !qualificationTypes.includes(row.qualificationType)) issues.push('qualification_type_invalid');
    if (row.programme && (row.programme.length > 200 || formulaPrefix.test(row.programme))) issues.push('programme_invalid');
    if (student && Number.isInteger(sequence)) {
      const key = `${student.studentUserId}:${sequence}`;
      if (seen.has(key)) issues.push('duplicate_row');
      seen.add(key);
    }

    const value = scale && parsedResult ? { resultScale: scale, ...parsedResult } : null;
    const base = {
      rowNumber: row.rowNumber, institutionStudentId: row.institutionStudentId, studentName: student?.fullName ?? null,
      termSequence: Number.isInteger(sequence) ? sequence : null, termLabel: row.termLabel, scale: row.scale, result: row.result,
      backlogs, studentUserId: student?.studentUserId ?? null, value,
      studentReported: null, verifiedRecord: null, confirmTermId: null, targetQualificationId: null, newQualification: null,
    };
    if (issues.length > 0 || !student || !value || backlogs === null) {
      return { ...base, outcome: 'INVALID' as const, issues, studentUserId: null, value: null };
    }

    const existing = terms.filter((term) => term.studentUserId === student.studentUserId && term.sequence === sequence);
    const verified = existing.find((term) => term.verificationState === 'VERIFIED');
    if (verified) {
      return { ...base, outcome: sameResult(verified, value, backlogs) ? 'UNCHANGED' as const : 'CONFLICT' as const,
        issues: [], verifiedRecord: recorded(verified) };
    }
    const matching = existing.find((term) => sameResult(term, value, backlogs));
    if (matching) return { ...base, outcome: 'CONFIRM' as const, issues: [], confirmTermId: matching.id };
    const differing = existing[0] ?? null;
    if (differing?.institutionIssued) {
      return { ...base, outcome: 'CONFLICT' as const, issues: ['declaration_in_institution_record'], studentReported: recorded(differing) };
    }

    const targetQualificationId = issuedByStudent.get(student.studentUserId) ?? null;
    let newQualification: EvaluatedRow['newQualification'] = null;
    if (!targetQualificationId) {
      const qualificationType = row.qualificationType;
      const programmeName = row.programme || student.programmeUnit || '';
      const missing = [...(qualificationType ? [] : ['qualification_type_required']), ...(programmeName ? [] : ['programme_required'])];
      if (missing.length) return { ...base, outcome: 'INVALID' as const, issues: missing, studentUserId: null, value: null };
      // Every row that creates the same student's programme record must agree on it.
      const earlier = pendingNewQualification.get(student.studentUserId);
      if (earlier && (earlier.qualificationType !== qualificationType || earlier.programmeName !== programmeName)) {
        return { ...base, outcome: 'INVALID' as const, issues: ['qualification_mismatch'], studentUserId: null, value: null };
      }
      pendingNewQualification.set(student.studentUserId, { qualificationType, programmeName });
      newQualification = { qualificationType, programmeName, startedOn: student.startedOn };
    }
    return { ...base, outcome: 'CREATE' as const, issues: [], studentReported: differing ? recorded(differing) : null,
      targetQualificationId, newQualification };
  });

  const count = (outcome: ResultsImportOutcome): number => rows.filter((row) => row.outcome === outcome).length;
  const digest = createHash('sha256').update(JSON.stringify({ institutionId, rows: rows.map((row) => [
    row.rowNumber, row.outcome, row.studentUserId, row.termSequence, row.termLabel, row.value, row.backlogs,
    row.confirmTermId, row.targetQualificationId, row.newQualification, row.issues,
  ]) })).digest('hex');
  return {
    rows,
    evaluation: {
      digest,
      rowCount: rows.length,
      counts: {
        create: count('CREATE'), confirm: count('CONFIRM'), unchanged: count('UNCHANGED'), conflict: count('CONFLICT'),
        invalid: count('INVALID'), skipped: count('SKIPPED'), differsFromStudent: rows.filter((row) => row.outcome === 'CREATE' && row.studentReported).length,
      },
      rows: rows.map(toView),
    },
  };
}

function toView(row: EvaluatedRow): ResultsImportRowView {
  return {
    rowNumber: row.rowNumber, institutionStudentId: row.institutionStudentId, studentName: row.studentName,
    termSequence: row.termSequence, termLabel: row.termLabel, scale: row.scale, result: row.result, backlogs: row.backlogs,
    outcome: row.outcome, issues: row.issues, studentReported: row.studentReported, verifiedRecord: row.verifiedRecord,
  };
}

export async function previewResultsImport(
  pool: Pool,
  input: { readonly institutionId: string; readonly scope: InstitutionStudentScope; readonly csv: string; readonly filename: string;
    readonly actorUserId: string; readonly correlationId: string },
): Promise<ResultsImportEvaluation> {
  const { evaluation } = await evaluateResultsImport(pool, input.institutionId, input.scope, parseResultsCsv(input.csv));
  await pool.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,'institution.academic_results.previewed','academic_results_import',$3,$4,'SUCCESS',$5,$6::jsonb)`,
    [randomUUID(), input.actorUserId, evaluation.digest, input.institutionId, input.correlationId,
      JSON.stringify({ filename: input.filename, rowCount: evaluation.rowCount, counts: evaluation.counts })],
  );
  return evaluation;
}

export class ResultsImportRejected extends Error {
  constructor(readonly code: 'RESULTS_IMPORT_HAS_INVALID_ROWS' | 'RESULTS_IMPORT_STALE', readonly evaluation: ResultsImportEvaluation) {
    super(code);
    this.name = 'ResultsImportRejected';
  }
}

/**
 * Write every CREATE and CONFIRM, all or nothing, attributed to the uploader. Refuses when
 * any row is invalid or the evaluation no longer matches the preview the uploader saw.
 */
export async function commitResultsImport(
  pool: Pool,
  input: { readonly institutionId: string; readonly scope: InstitutionStudentScope; readonly csv: string; readonly filename: string;
    readonly previewDigest: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string },
): Promise<{ readonly reference: string; readonly evaluation: ResultsImportEvaluation; readonly created: number; readonly confirmed: number }> {
  const parsed = parseResultsCsv(input.csv);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One upload at a time per institution, so two concurrent commits cannot both
    // create the same student's programme record or the same term.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`academic-results-import:${input.institutionId}`]);
    const { evaluation, rows } = await evaluateResultsImport(client, input.institutionId, input.scope, parsed);
    if (evaluation.counts.invalid > 0) throw new ResultsImportRejected('RESULTS_IMPORT_HAS_INVALID_ROWS', evaluation);
    if (evaluation.digest !== input.previewDigest) throw new ResultsImportRejected('RESULTS_IMPORT_STALE', evaluation);

    const reference = randomUUID();
    const createdQualifications = new Map<string, string>();
    let created = 0;
    let confirmed = 0;
    const audit = async (termId: string, outcome: string): Promise<void> => {
      await client.query(
        `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
         VALUES ($1,$2,'academic_term.verified_by_import','student_academic_term',$3,$4,'SUCCESS',$5,$6::jsonb)`,
        [randomUUID(), input.actorUserId, termId, input.institutionId, input.correlationId,
          JSON.stringify({ outcome, importReference: reference, reasonCode: input.reasonCode })],
      );
    };
    for (const row of rows) {
      if (row.outcome === 'CONFIRM' && row.confirmTermId) {
        const updated = await client.query(
          `UPDATE student_academic_terms SET verification_state='VERIFIED', verified_by_user_id=$2, verified_at=now()
           WHERE id=$1 AND verification_state <> 'VERIFIED'`, [row.confirmTermId, input.actorUserId],
        );
        if (updated.rowCount !== 1) throw new ResultsImportRejected('RESULTS_IMPORT_STALE', evaluation);
        await audit(row.confirmTermId, 'CONFIRM');
        confirmed += 1;
      } else if (row.outcome === 'CREATE' && row.studentUserId && row.value && row.termSequence !== null) {
        let qualificationId = row.targetQualificationId ?? createdQualifications.get(row.studentUserId) ?? null;
        if (!qualificationId && row.newQualification) {
          qualificationId = randomUUID();
          await client.query(
            `INSERT INTO student_qualifications
             (id, student_user_id, institution_id, qualification_type, programme_name, started_on,
              verification_state, verified_by_user_id, verified_at)
             VALUES ($1,$2,$3,$4,$5,$6,'VERIFIED',$7,now())`,
            [qualificationId, row.studentUserId, input.institutionId, row.newQualification.qualificationType,
              row.newQualification.programmeName, row.newQualification.startedOn, input.actorUserId],
          );
          createdQualifications.set(row.studentUserId, qualificationId);
        }
        if (!qualificationId) throw new ResultsImportRejected('RESULTS_IMPORT_STALE', evaluation);
        const termId = randomUUID();
        await client.query(
          `INSERT INTO student_academic_terms
           (id, qualification_id, sequence, label, result_value, result_scale, result_letter, backlog_count, source,
            verification_state, verified_by_user_id, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INSTITUTION_IMPORTED','VERIFIED',$9,now())`,
          [termId, qualificationId, row.termSequence, row.termLabel, row.value.resultValue, row.value.resultScale,
            row.value.resultLetter, row.backlogs, input.actorUserId],
        );
        await audit(termId, 'CREATE');
        created += 1;
      }
    }
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
       VALUES ($1,$2,'institution.academic_results.imported','academic_results_import',$3,$4,'SUCCESS',$5,$6::jsonb)`,
      [randomUUID(), input.actorUserId, reference, input.institutionId, input.correlationId,
        JSON.stringify({ filename: input.filename, digest: evaluation.digest, reasonCode: input.reasonCode, created, confirmed,
          counts: evaluation.counts })],
    );
    await client.query('COMMIT');
    return { reference, evaluation, created, confirmed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof ResultsImportRejected || error instanceof AcademicRecordError) throw error;
    // A constraint refusing a write means the records moved under us; nothing was kept.
    throw new AcademicRecordError('RESULTS_IMPORT_STALE');
  } finally {
    client.release();
  }
}
