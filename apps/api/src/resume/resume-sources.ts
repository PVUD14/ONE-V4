/**
 * Reads what a student may put on a generated résumé, from their own rows only (RESUME-GEN).
 *
 * Every query filters on the student's user id, so nothing here can return another person's record; the
 * content builder then keeps only the ids the student ticked from these lists. Skills come from EMP-13's
 * qualifying-evidence rule (skill-evidence.ts), grouped by topic: the topic's name, where it was shown and
 * when — never marks, a stage, a count or a readiness value. Design: docs/architecture/student-resumes-table-design.md.
 */
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { evidenceSource, qualifyingEvidence } from '../http/skill-evidence.js';
import { RESUME_LIMITS, type QualificationSource, type ResumeSources, type SkillSource, type TermSource } from './resume-content.js';

type Db = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };
type Row = Record<string, unknown>;

const textOrNull = (value: unknown): string | null => (value == null || value === '' ? null : String(value));
const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const isoOf = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export async function readResumeSources(db: Db, studentUserId: string): Promise<ResumeSources> {
  const subject = sql`${studentUserId}::uuid`;
  const run = async (query: ReturnType<typeof sql>): Promise<Row[]> => ((await db.execute(query)) as QueryResult<Row>).rows;

  const identity = await run(sql`SELECT email FROM users WHERE id = ${subject}`);
  // The college's roster is the only place ONE holds a person's name: ACTIVE first, then an alumnus's GRADUATED record.
  const roster = await run(sql`
    SELECT full_name FROM institution_student_profiles
    WHERE student_user_id = ${subject} AND status IN ('ACTIVE', 'GRADUATED')
    ORDER BY (status = 'ACTIVE') DESC, updated_at DESC, id LIMIT 1`);
  const profile = await run(sql`SELECT profile_headline, profile_summary, portfolio_url FROM student_profiles WHERE user_id = ${subject}`);
  // A record the college rejected is never offered.
  const qualifications = await run(sql`
    SELECT q.id, q.qualification_type, q.programme_name, org.legal_name AS issuer_name,
           coalesce(org.legal_name, q.institution_name_declared) AS institution_name,
           to_char(q.started_on, 'YYYY-MM-DD') AS started_on, to_char(q.completed_on, 'YYYY-MM-DD') AS completed_on,
           q.awarded, q.verification_state
    FROM student_qualifications q LEFT JOIN organizations org ON org.id = q.institution_id
    WHERE q.student_user_id = ${subject} AND q.verification_state <> 'REJECTED'
    ORDER BY q.started_on DESC NULLS LAST, q.created_at DESC, q.id
    LIMIT ${RESUME_LIMITS.qualifications}`);
  const terms = await run(sql`
    SELECT t.id, t.qualification_id, t.label, t.result_value, t.result_scale, t.result_letter, t.verification_state
    FROM student_academic_terms t JOIN student_qualifications q ON q.id = t.qualification_id
    WHERE q.student_user_id = ${subject} AND q.verification_state <> 'REJECTED' AND t.verification_state <> 'REJECTED'
    ORDER BY t.sequence, t.id`);
  const skills = await run(sql`
    SELECT tn.id AS topic_id, tn.name, array_agg(DISTINCT e.source_aggregate_type) AS source_types, max(e.occurred_at) AS latest_at
    FROM evidence_records e JOIN taxonomy_nodes tn ON tn.id = e.topic_id
    WHERE e.subject_user_id = ${subject} AND ${qualifyingEvidence('e')}
    GROUP BY tn.id, tn.name
    ORDER BY max(e.occurred_at) DESC, lower(tn.name), tn.id
    LIMIT ${RESUME_LIMITS.skills}`);
  const certificates = await run(sql`
    SELECT id, title, description FROM student_document_metadata
    WHERE student_user_id = ${subject} AND document_type = 'CERTIFICATE' AND archived_at IS NULL
    ORDER BY updated_at DESC, id LIMIT ${RESUME_LIMITS.certificates}`);
  const targets = await run(sql`
    SELECT t.id, r.title FROM student_career_targets t JOIN career_roles r ON r.id = t.career_role_id
    WHERE t.student_user_id = ${subject} AND t.cleared_at IS NULL
    ORDER BY (t.priority = 'PRIMARY') DESC, t.selected_at, t.id LIMIT ${RESUME_LIMITS.careerTargets}`);

  const profileRow = profile[0];
  return {
    email: String(identity[0]?.email ?? ''),
    fullName: textOrNull(roster[0]?.full_name),
    headline: textOrNull(profileRow?.profile_headline),
    summary: textOrNull(profileRow?.profile_summary),
    portfolioUrl: textOrNull(profileRow?.portfolio_url),
    qualifications: qualifications.map((q): QualificationSource => ({
      id: String(q.id),
      qualificationType: String(q.qualification_type),
      programmeName: String(q.programme_name),
      institutionName: textOrNull(q.institution_name),
      issuerName: textOrNull(q.issuer_name),
      startedOn: textOrNull(q.started_on),
      completedOn: textOrNull(q.completed_on),
      awarded: q.awarded === true,
      state: String(q.verification_state),
      terms: terms.filter((t) => t.qualification_id === q.id).map((t): TermSource => ({
        id: String(t.id),
        label: String(t.label),
        resultValue: numberOrNull(t.result_value),
        resultScale: textOrNull(t.result_scale),
        resultLetter: textOrNull(t.result_letter),
        state: String(t.verification_state),
        issuerName: textOrNull(q.issuer_name),
      })),
    })),
    skills: skills.map((s) => ({
      topicId: String(s.topic_id),
      name: String(s.name),
      sources: [...new Set(pgArray(s.source_types).map((type) => evidenceSource(type) as SkillSource))],
      latestAt: isoOf(s.latest_at),
    })),
    certificates: certificates.map((c) => ({ id: String(c.id), title: String(c.title), description: textOrNull(c.description) })),
    careerTargets: targets.map((t) => ({ id: String(t.id), roleTitle: String(t.title) })),
  };
}

/** node-postgres returns text[] as an array, but an aggregate over an unknown type can arrive as '{a,b}'. */
function pgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((part) => part.replace(/^"|"$/g, ''));
  return [];
}
