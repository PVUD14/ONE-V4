/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Academic records: the constraints that carry the module's promises.
 *
 * The provenance rule — store what the institution issued, never a conversion — is
 * the thing most likely to be traded away the first time an employer filter wants a
 * comparable number. It is tested here on purpose, in the same change as the
 * migration that introduces it.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  asCgpa10,
  getAcademicEligibilityFacts,
  normaliseResult,
  declareQualification,
  listAcademicRecords,
  listVerificationQueue,
  searchInstitutions,
  submitTermForVerification,
  AcademicRecordError,
} from '../src/academic-records.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let studentId: string;
let reviewerId: string;
let institutionId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  studentId = randomUUID();
  reviewerId = randomUUID();
  institutionId = randomUUID();
  for (const id of [studentId, reviewerId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, id + '@example.test']);
  }
  await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'E local test institution')", [institutionId]);
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

async function insertQualification(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO student_qualifications
     (id, student_user_id, institution_id, institution_name_declared, qualification_type, programme_name, started_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, studentId, overrides.institutionId === undefined ? institutionId : overrides.institutionId,
      overrides.institutionNameDeclared ?? null, 'BTECH', 'Computer Science and Engineering', '2022-08-01'],
  );
  return id;
}

async function insertTerm(qualificationId: string, values: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO student_academic_terms
     (id, qualification_id, sequence, label, result_value, result_scale, result_letter, backlog_count, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, qualificationId, values.sequence ?? 1, values.label ?? 'Semester 1',
      values.resultValue ?? null, values.resultScale ?? null, values.resultLetter ?? null,
      values.backlogCount ?? null, values.source ?? 'STUDENT_DECLARED'],
  );
  return id;
}

async function verify(termId: string): Promise<void> {
  await client.query(
    "UPDATE student_academic_terms SET verification_state='VERIFIED', verified_by_user_id=$2, verified_at=now() WHERE id=$1",
    [termId, reviewerId],
  );
}

describe('academic record provenance', () => {
  it('refuses a result value without the scale it was issued on', async () => {
    const qualification = await insertQualification();
    await expect(insertTerm(qualification, { resultValue: 8.2 }))
      .rejects.toThrow(/student_term_value_needs_scale_ck/);
  });

  it('refuses a value outside the range of its own scale', async () => {
    const qualification = await insertQualification();
    // 82 is a plausible percentage and an impossible CGPA. Storing it as a CGPA is
    // exactly the confusion the scale column exists to prevent.
    await expect(insertTerm(qualification, { resultValue: 82, resultScale: 'CGPA_10' }))
      .rejects.toThrow(/student_term_value_range_ck/);
  });

  // One rejected statement per test: a failed statement aborts the surrounding
  // transaction, so a second assertion in the same test would only ever see
  // "current transaction is aborted".
  it('refuses a numeric value on a categorical scale', async () => {
    const qualification = await insertQualification();
    await expect(insertTerm(qualification, { resultValue: 7, resultScale: 'PASS_FAIL' }))
      .rejects.toThrow(/student_term_scale_shape_ck/);
  });

  it('refuses a letter grade on a numeric scale', async () => {
    const qualification = await insertQualification();
    await expect(insertTerm(qualification, { resultLetter: 'A', resultScale: 'CGPA_10' }))
      .rejects.toThrow(/student_term_scale_shape_ck/);
  });

  it('normalises only at comparison time and never stores the converted figure', async () => {
    const qualification = await insertQualification();
    const termId = await insertTerm(qualification, { resultValue: 8.2, resultScale: 'CGPA_10' });
    await verify(termId);

    const stored = await client.query<{ result_value: string; result_scale: string }>(
      'SELECT result_value, result_scale FROM student_academic_terms WHERE id=$1', [termId],
    );
    // Stored as issued.
    expect(Number(stored.rows[0]?.result_value)).toBe(8.2);
    expect(stored.rows[0]?.result_scale).toBe('CGPA_10');

    // Comparable on demand, from the same issued value.
    expect(normaliseResult(8.2, 'CGPA_10')).toBeCloseTo(0.82);
    expect(asCgpa10(82, 'PERCENTAGE')).toBe(8.2);

    // And there is nowhere for a converted number to have been written.
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='student_academic_terms'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain('normalised_value');
    expect(names).not.toContain('cgpa_equivalent');
  });

  it('reports an unnormalisable scale as unknown rather than guessing', () => {
    expect(normaliseResult(1, 'PASS_FAIL')).toBeNull();
    expect(asCgpa10(null, 'CGPA_10')).toBeNull();
  });
});

describe('verification', () => {
  it('cannot be granted to a record with no issuing institution', async () => {
    const qualification = await insertQualification({ institutionId: null, institutionNameDeclared: 'A college elsewhere' });
    await expect(client.query(
      "UPDATE student_qualifications SET verification_state='VERIFIED', verified_by_user_id=$2, verified_at=now() WHERE id=$1",
      [qualification, reviewerId],
    )).rejects.toThrow(/student_qualification_unverifiable_ck/);
  });

  it('is permanent once granted', async () => {
    const qualification = await insertQualification();
    const termId = await insertTerm(qualification, { resultValue: 8.2, resultScale: 'CGPA_10' });
    await verify(termId);
    await expect(client.query(
      "UPDATE student_academic_terms SET verification_state='SELF_REPORTED' WHERE id=$1", [termId],
    )).rejects.toThrow(/cannot be unverified/);
  });

  it('does not let the recorded verifier be rewritten', async () => {
    const qualification = await insertQualification();
    const termId = await insertTerm(qualification, { resultValue: 8.2, resultScale: 'CGPA_10' });
    await verify(termId);
    await expect(client.query(
      'UPDATE student_academic_terms SET verified_by_user_id=$2 WHERE id=$1', [termId, studentId],
    )).rejects.toThrow(/verifier of a verified academic record cannot be changed/);
  });

  it('requires a reviewer identity and a review time together', async () => {
    const qualification = await insertQualification();
    const termId = await insertTerm(qualification, { resultValue: 8.2, resultScale: 'CGPA_10' });
    await expect(client.query(
      "UPDATE student_academic_terms SET verification_state='VERIFIED', verified_by_user_id=$2 WHERE id=$1",
      [termId, reviewerId],
    )).rejects.toThrow(/student_term_reviewer_ck/);
  });
});

describe('eligibility facts', () => {
  it('returns unknown when nothing is verified', async () => {
    const qualification = await insertQualification();
    await insertTerm(qualification, { resultValue: 9.1, resultScale: 'CGPA_10' });
    const facts = await getAcademicEligibilityFacts(client, studentId);
    // A self-reported 9.1 must not satisfy an employer rule.
    expect(facts.hasVerifiedRecord).toBe(false);
    expect(facts.cgpa10).toBeNull();
  });

  it('resolves against the most recent verified term and derives cumulative backlogs', async () => {
    const qualification = await insertQualification();
    const first = await insertTerm(qualification, { sequence: 1, label: 'Semester 1', resultValue: 7.4, resultScale: 'CGPA_10', backlogCount: 2 });
    const second = await insertTerm(qualification, { sequence: 2, label: 'Semester 2', resultValue: 8.2, resultScale: 'CGPA_10', backlogCount: 1 });
    await verify(first);
    await verify(second);

    const facts = await getAcademicEligibilityFacts(client, studentId);
    expect(facts.hasVerifiedRecord).toBe(true);
    expect(facts.termLabel).toBe('Semester 2');
    expect(facts.cgpa10).toBeCloseTo(8.2);
    // Summed at read time from per-term counts; never stored.
    expect(facts.cumulativeBacklogs).toBe(3);
  });

  it('ignores a self-reported prior qualification held at another institution', async () => {
    const elsewhere = await insertQualification({ institutionId: null, institutionNameDeclared: 'A college elsewhere' });
    await insertTerm(elsewhere, { resultValue: 9.9, resultScale: 'CGPA_10' });
    const facts = await getAcademicEligibilityFacts(client, studentId);
    expect(facts.hasVerifiedRecord).toBe(false);
    expect(facts.cgpa10).toBeNull();
  });
});

/**
 * A record earned at an institution can be confirmed by that institution after the person
 * has left it. Nothing in the verification path asks about enrolment, and these tests
 * exist so that nobody adds such a check believing it was an oversight.
 */
describe('alumni verification requests', () => {
  async function verifiedInstitution(name = 'Verified test college'): Promise<string> {
    const id = randomUUID();
    await client.query(
      "INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'INSTITUTION', $2, 'VERIFIED')",
      [id, name],
    );
    return id;
  }

  it('reads a student record back with the issuing institution name', async () => {
    // This is the test whose absence let `o.name` survive: the column was renamed to
    // legal_name in 0001, so every call to this function raised at runtime.
    await insertQualification();
    const records = await listAcademicRecords(client as never, studentId);
    const qualifications = records.qualifications as { institutionName: string }[];
    expect(qualifications[0]?.institutionName).toBe('E local test institution');
  });

  it('keeps a request from someone who never enrolled, and labels it honestly', async () => {
    const issuer = await verifiedInstitution();
    const qualification = randomUUID();
    await client.query(
      `INSERT INTO student_qualifications (id, student_user_id, institution_id, qualification_type, programme_name, started_on, completed_on)
       VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering','2015-08-01','2019-06-30')`,
      [qualification, studentId, issuer],
    );
    const term = await insertTerm(qualification, { sequence: 8, label: 'Semester 8', resultValue: 8.4, resultScale: 'CGPA_10' });
    await submitTermForVerification(client as never, { studentUserId: studentId, termId: term });

    const queue = await listVerificationQueue(client as never, issuer);
    expect(queue).toHaveLength(1);
    const entry = queue[0] as Record<string, unknown>;
    // The institution holds no record of this person, which is precisely the case that
    // needs a human to check an archive.
    expect(entry.relationship).toBe('NONE');
    // And no name, because ONE has never been told one. A null is the truth here.
    expect(entry.studentName).toBeNull();
    expect(entry.studentEmail).toBe(studentId + '@example.test');
    expect(String(entry.claimedCompletedOn)).toContain('2019');
  });

  it('labels a graduated student as former rather than current', async () => {
    const issuer = await verifiedInstitution('Graduation test college');
    await client.query(
      `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from, effective_to)
       VALUES ($1,$2,$3,'GRADUATED', now() - interval '6 years', now() - interval '2 years')`,
      [randomUUID(), issuer, studentId],
    );
    const qualification = randomUUID();
    await client.query(
      `INSERT INTO student_qualifications (id, student_user_id, institution_id, qualification_type, programme_name)
       VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering')`,
      [qualification, studentId, issuer],
    );
    const term = await insertTerm(qualification, { sequence: 8, label: 'Semester 8', resultValue: 8.4, resultScale: 'CGPA_10' });
    await submitTermForVerification(client as never, { studentUserId: studentId, termId: term });

    const queue = await listVerificationQueue(client as never, issuer);
    expect((queue[0] as Record<string, unknown>).relationship).toBe('FORMER');
  });

  it('refuses a qualification issued by something that is not a verified institution', async () => {
    const employer = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'EMPLOYER', 'Not a college', 'VERIFIED')", [employer]);
    // An employer can never reach an institution verification queue, so a qualification
    // pointed at one would wait forever while looking to the student like neglect.
    await expect(declareQualification(client as never, {
      studentUserId: studentId, institutionId: employer,
      qualificationType: 'BTECH', programmeName: 'Computer Science and Engineering',
    })).rejects.toBeInstanceOf(AcademicRecordError);

    const unverified = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'Pending college')", [unverified]);
    await expect(declareQualification(client as never, {
      studentUserId: studentId, institutionId: unverified,
      qualificationType: 'BTECH', programmeName: 'Computer Science and Engineering',
    })).rejects.toBeInstanceOf(AcademicRecordError);
  });

  it('still accepts a college that is not on ONE, and leaves it permanently self-reported', async () => {
    const created = await declareQualification(client as never, {
      studentUserId: studentId, institutionNameDeclared: 'A college that never joined',
      qualificationType: 'BTECH', programmeName: 'Computer Science and Engineering',
    });
    const row = await client.query('SELECT institution_id, verification_state FROM student_qualifications WHERE id=$1', [created.id]);
    expect(row.rows[0].institution_id).toBeNull();
    expect(row.rows[0].verification_state).toBe('SELF_REPORTED');
  });

  it('finds an institution by name, and lists only the ones that could actually verify', async () => {
    await verifiedInstitution('Aurora Institute of Technology');
    const unverified = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'Aurora Pending College')", [unverified]);
    const closed = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state, active) VALUES ($1, 'INSTITUTION', 'Aurora Closed College', 'VERIFIED', false)", [closed]);
    const employer = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'EMPLOYER', 'Aurora Mobility', 'VERIFIED')", [employer]);

    const found = await searchInstitutions(client as never, 'Aurora');
    expect(found.map((row) => row.name)).toEqual(['Aurora Institute of Technology']);
  });

  it('refuses to enumerate the directory from a single character', async () => {
    await verifiedInstitution('Aurora Institute of Technology');
    expect(await searchInstitutions(client as never, 'A')).toEqual([]);
    expect(await searchInstitutions(client as never, '  ')).toEqual([]);
  });
});
