/**
 * Consented, per-skill verified evidence on one application (EMP-13, ADR-043).
 *
 * The one place that says which evidence a student may share with an employer, how a choice is
 * stored, and what an employer reads back. Everything else — the preview and apply in
 * student-hiring.controller.ts, the student's own control, the employer's panel and the applicant
 * filter — calls these functions, so the qualifying rule and the shown fields cannot drift apart.
 *
 * Shown, to both sides alike: the job skill, the evidence type, its source, the date, and whether it
 * was unaided. Never: a readiness band or score, a gap status, a mastery value, the stage, the marks
 * behind an item, a count, a rank or any identifier the employer could use. Design:
 * docs/architecture/application-evidence-shares-table-design.md.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

type Db = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };

/** Dark until Divakar approves HG-4: default off, and switching it on needs a second person (0093). */
export const SKILL_EVIDENCE_FLAG = 'employer.skill-evidence';
/** At most this many live shares on one application. */
export const MAX_EVIDENCE_SHARES = 60;
/** At most this many of the student's own items offered per job skill (every shared one is always listed). */
export const EVIDENCE_CHOICES_PER_SKILL = 20;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noApplication = '00000000-0000-0000-0000-000000000000';

export type EvidenceSource = 'ONE_SKILL_CHECK' | 'INSTITUTION_EXAM' | 'ONE_RECORD';

/** An evidence item as either side sees it. `evidenceId` goes to the student only. */
export interface EvidenceItem {
  readonly type: string;
  readonly source: EvidenceSource;
  readonly occurredAt: unknown;
  readonly unaided: boolean;
}

export interface EvidenceSkill<T> {
  readonly name: string;
  readonly level: string;
  /** False for a free-text job skill: no evidence can be matched to it. */
  readonly catalogue: boolean;
  readonly items: readonly T[];
}

export class EvidenceShareError extends Error {
  constructor(readonly code: 'EVIDENCE_NOT_SHAREABLE' | 'TOO_MANY_EVIDENCE_SHARES') {
    super(code);
  }
}

export async function skillEvidenceEnabled(db: Db): Promise<boolean> {
  const rows = await db.execute(sql`SELECT enabled FROM feature_flags WHERE key = ${SKILL_EVIDENCE_FLAG}`) as QueryResult<{ enabled: boolean }>;
  return rows.rows[0]?.enabled === true;
}

/**
 * The qualifying rule, on an `evidence_records` alias: graded work (never a lesson completion),
 * recorded after the skill reached DEMONSTRATED (unaided success on two days, learning-model-v1),
 * with something correct, and not replaced by a correction. Subject and topic are the caller's.
 */
export function qualifyingEvidence(alias: string): SQL {
  const e = sql.raw(safeAlias(alias));
  return sql`(${e}.evidence_type IN ('ASSESSMENT_OUTCOME', 'TOPIC_DEMONSTRATION')
    AND ${e}.stage_at_capture IN ('DEMONSTRATED', 'TRANSFERRED')
    AND ${e}.demonstrated > 0
    AND NOT EXISTS (SELECT 1 FROM evidence_records correction WHERE correction.supersedes_evidence_id = ${e}.id))`;
}

/**
 * True when the application row under `applicationAlias` has live, qualifying evidence shared for
 * `topicId`, against a catalogue skill of the version it is bound to. The caller adds the grant.
 */
export function sharesEvidenceForTopic(applicationAlias: string, topicId: string): SQL {
  const a = sql.raw(safeAlias(applicationAlias));
  return sql`EXISTS (SELECT 1 FROM application_evidence_shares filter_share
    JOIN evidence_records filter_evidence ON filter_evidence.id = filter_share.evidence_record_id
    JOIN opportunity_skill_requirements filter_skill ON filter_skill.opportunity_version_id = ${a}.applied_version_id
      AND filter_skill.taxonomy_topic_id = filter_evidence.topic_id
    WHERE filter_share.application_id = ${a}.id AND filter_share.revoked_at IS NULL
      AND filter_share.student_user_id = ${a}.student_user_id
      AND filter_evidence.subject_user_id = ${a}.student_user_id
      AND filter_evidence.topic_id = ${topicId}::uuid
      AND ${qualifyingEvidence('filter_evidence')})`;
}

export function evidenceSource(aggregateType: unknown): EvidenceSource {
  if (aggregateType === 'assessment_attempt') return 'ONE_SKILL_CHECK';
  if (aggregateType === 'exam_attempt') return 'INSTITUTION_EXAM';
  return 'ONE_RECORD';
}

/** The student's own qualifying evidence for each skill of a job version, with what is shared on `applicationId`. */
export async function readEvidenceChoices(db: Db, input: { studentUserId: string; versionId: string; applicationId: string | null }): Promise<EvidenceSkill<EvidenceItem & { evidenceId: string; shared: boolean; sharedAt: unknown }>[]> {
  const applicationId = input.applicationId ?? noApplication;
  const rows = await db.execute(sql`
    SELECT s.id AS skill_id, s.skill_name, s.requirement_level, s.taxonomy_topic_id,
           c.id AS evidence_id, c.evidence_type, c.source_aggregate_type, c.occurred_at, c.assisted, c.shared_at
    FROM opportunity_skill_requirements s
    LEFT JOIN LATERAL (
      SELECT q.* FROM (
        SELECT e.id, e.evidence_type, e.source_aggregate_type, e.occurred_at, e.assisted, sh.shared_at,
               row_number() OVER (ORDER BY e.occurred_at DESC, e.id) AS position
        FROM evidence_records e
        LEFT JOIN application_evidence_shares sh ON sh.application_id = ${applicationId}::uuid
          AND sh.evidence_record_id = e.id AND sh.revoked_at IS NULL
        WHERE e.subject_user_id = ${input.studentUserId}::uuid AND e.topic_id = s.taxonomy_topic_id
          AND ${qualifyingEvidence('e')}
      ) q WHERE q.position <= ${EVIDENCE_CHOICES_PER_SKILL} OR q.shared_at IS NOT NULL
    ) c ON s.taxonomy_topic_id IS NOT NULL
    WHERE s.opportunity_version_id = ${input.versionId}::uuid
    ORDER BY s.requirement_level DESC, lower(s.skill_name), s.id, c.occurred_at DESC, c.id
  `) as QueryResult<Record<string, unknown>>;
  return group(rows.rows, (row) => ({
    evidenceId: String(row.evidence_id), type: String(row.evidence_type), source: evidenceSource(row.source_aggregate_type),
    occurredAt: row.occurred_at, unaided: row.assisted !== true, shared: row.shared_at != null, sharedAt: row.shared_at ?? null,
  }));
}

/**
 * What the employer reads for one application: per job skill, the live shared items that still
 * qualify. The caller has already checked the employer, the application and the live grant.
 */
export async function readSharedEvidence(db: Db, input: { applicationId: string; studentUserId: string; versionId: string }): Promise<EvidenceSkill<EvidenceItem & { sharedAt: unknown }>[]> {
  const rows = await db.execute(sql`
    SELECT s.id AS skill_id, s.skill_name, s.requirement_level, s.taxonomy_topic_id,
           i.evidence_id, i.evidence_type, i.source_aggregate_type, i.occurred_at, i.assisted, i.shared_at
    FROM opportunity_skill_requirements s
    LEFT JOIN LATERAL (
      SELECT e.id AS evidence_id, e.evidence_type, e.source_aggregate_type, e.occurred_at, e.assisted, sh.shared_at
      FROM application_evidence_shares sh
      JOIN evidence_records e ON e.id = sh.evidence_record_id
      WHERE sh.application_id = ${input.applicationId}::uuid AND sh.revoked_at IS NULL
        AND sh.student_user_id = ${input.studentUserId}::uuid AND e.subject_user_id = ${input.studentUserId}::uuid
        AND e.topic_id = s.taxonomy_topic_id AND ${qualifyingEvidence('e')}
      ORDER BY e.occurred_at DESC, e.id
      LIMIT ${MAX_EVIDENCE_SHARES}
    ) i ON s.taxonomy_topic_id IS NOT NULL
    WHERE s.opportunity_version_id = ${input.versionId}::uuid
    ORDER BY s.requirement_level DESC, lower(s.skill_name), s.id, i.occurred_at DESC, i.evidence_id
  `) as QueryResult<Record<string, unknown>>;
  return group(rows.rows, (row) => ({
    type: String(row.evidence_type), source: evidenceSource(row.source_aggregate_type),
    occurredAt: row.occurred_at, unaided: row.assisted !== true, sharedAt: row.shared_at,
  }));
}

/**
 * Replaces the live shares on one application with `evidenceIds`: items left out are revoked, new
 * ones are checked against the qualifying rule and the job version's catalogue skills and inserted.
 * Runs inside the caller's transaction, which has locked the application row. Returns what changed.
 */
export async function replaceEvidenceShares(tx: Db, ids: { uuid(): string }, input: {
  applicationId: string; studentUserId: string; versionId: string; evidenceIds: readonly string[]; via: 'APPLY' | 'APPLICATION'; allowAdding: boolean;
}): Promise<{ added: number; revoked: number }> {
  const wanted = [...new Set(input.evidenceIds.map((id) => id.toLowerCase()))];
  if (wanted.length > MAX_EVIDENCE_SHARES) throw new EvidenceShareError('TOO_MANY_EVIDENCE_SHARES');
  const current = await tx.execute(sql`
    SELECT evidence_record_id FROM application_evidence_shares
    WHERE application_id = ${input.applicationId}::uuid AND revoked_at IS NULL
  `) as QueryResult<{ evidence_record_id: string }>;
  const live = new Set(current.rows.map((row) => String(row.evidence_record_id).toLowerCase()));
  const adding = wanted.filter((id) => !live.has(id));
  const removing = [...live].filter((id) => !wanted.includes(id));

  if (adding.length) {
    if (!input.allowAdding) throw new EvidenceShareError('EVIDENCE_NOT_SHAREABLE');
    const shareable = await tx.execute(sql`
      SELECT e.id FROM evidence_records e
      WHERE e.id IN (${sql.join(adding.map((id) => sql`${id}::uuid`), sql`, `)})
        AND e.subject_user_id = ${input.studentUserId}::uuid
        AND ${qualifyingEvidence('e')}
        AND EXISTS (SELECT 1 FROM opportunity_skill_requirements s
          WHERE s.opportunity_version_id = ${input.versionId}::uuid AND s.taxonomy_topic_id = e.topic_id)
    `) as QueryResult<{ id: string }>;
    if (shareable.rows.length !== adding.length) throw new EvidenceShareError('EVIDENCE_NOT_SHAREABLE');
  }
  if (removing.length) {
    await tx.execute(sql`
      UPDATE application_evidence_shares SET revoked_at = now(), revoked_reason = 'STUDENT_REVOKED'
      WHERE application_id = ${input.applicationId}::uuid AND revoked_at IS NULL
        AND evidence_record_id IN (${sql.join(removing.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
  }
  if (adding.length) {
    await tx.execute(sql`
      INSERT INTO application_evidence_shares (id, application_id, student_user_id, evidence_record_id, shared_via)
      VALUES ${sql.join(adding.map((id) => sql`(${ids.uuid()}::uuid, ${input.applicationId}::uuid, ${input.studentUserId}::uuid, ${id}::uuid, ${input.via})`), sql`, `)}
    `);
  }
  return { added: adding.length, revoked: removing.length };
}

/**
 * `evidenceRecordIds` from a request body: absent means none; otherwise an array of distinct
 * UUIDs, at most MAX_EVIDENCE_SHARES. Returns null for an invalid value (the caller answers 400).
 */
export function readEvidenceRecordIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_SHARES) return null;
  if (!value.every((item) => typeof item === 'string' && uuidPattern.test(item))) return null;
  const ids = value.map((item) => (item as string).toLowerCase());
  return new Set(ids).size === ids.length ? ids : null;
}

function group<T>(rows: readonly Record<string, unknown>[], item: (row: Record<string, unknown>) => T): EvidenceSkill<T>[] {
  const skills: { id: string; skill: { name: string; level: string; catalogue: boolean; items: T[] } }[] = [];
  for (const row of rows) {
    const id = String(row.skill_id);
    let entry = skills[skills.length - 1];
    if (!entry || entry.id !== id) {
      entry = { id, skill: { name: String(row.skill_name), level: String(row.requirement_level), catalogue: row.taxonomy_topic_id != null, items: [] } };
      skills.push(entry);
    }
    if (row.evidence_id != null) entry.skill.items.push(item(row));
  }
  return skills.map((entry) => entry.skill);
}

function safeAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('invalid SQL alias');
  return alias;
}
