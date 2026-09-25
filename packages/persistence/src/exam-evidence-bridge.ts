/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Institution exam results become readiness evidence.
 *
 * Design in docs/architecture/exam-topic-bridge-table-design.md; schema in migration
 * 0030, which also publishes readiness model version 2 because this changes what the
 * band is allowed to consider.
 *
 * Written against `PersistenceDb` rather than a pg client, following
 * outbox-dispatcher, so it can run inside the same transaction that writes the result.
 * Evidence and result land together or not at all.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';
import { refreshReadinessAfterEvidence } from './career-readiness.js';
import { drizzleAsPgClient } from './learning-attempts.js';

type QueryResult<T> = { rows: T[] };

export interface ExamEvidenceOutcome {
  readonly written: number;
  /** Subjects with no live topic mapping. Reported so the gap is visible, not filled. */
  readonly unmappedSubject: boolean;
  readonly topicIds: readonly string[];
  /**
   * The band after the readiness path ran on the new evidence (ENG-03, C9). Null when nothing
   * was written, or while no readiness model is published in this environment.
   */
  readonly readiness?: { readonly snapshotId: string; readonly band: string } | null;
}

/**
 * Write one ASSESSMENT_OUTCOME evidence row per topic the exam's subject maps onto.
 *
 * Four refusals are the substance of this function:
 *
 *  - An unmapped subject writes nothing and reports itself. Guessing a topic from a
 *    subject name would put invented evidence under a student's readiness band.
 *  - An unpublished result writes nothing. An unpublished result is not yet the
 *    institution's word about the student.
 *  - Negative marking is not carried through. `exam_results.score` may legitimately be
 *    negative, `evidence_records` requires 0 <= demonstrated <= possible, and a penalty
 *    is an assessment policy rather than a statement about what was demonstrated. The
 *    counts are used instead of the score for exactly this reason.
 *  - Re-publishing does not double-count: evidence already recorded against this
 *    attempt is left alone.
 *
 * When evidence is written, readiness is recomputed through `recomputeReadiness` in the same
 * transaction (ENG-03), so a mapped exam result moves the band as C9 requires.
 */
export async function recordExamResultEvidence(
  db: PersistenceDb,
  input: { readonly attemptId: string; readonly correlationId?: string },
): Promise<ExamEvidenceOutcome> {
  const none: ExamEvidenceOutcome = { written: 0, unmappedSubject: false, topicIds: [] };

  const attempt = await db.execute(sql`
    SELECT a.student_user_id, d.subject_id, r.correct_count, r.wrong_count, r.not_attempted_count, r.published
    FROM exam_results r
    JOIN exam_attempts a ON a.id = r.attempt_id
    JOIN exam_definitions d ON d.id = a.definition_id
    WHERE r.attempt_id = ${input.attemptId}::uuid
  `) as QueryResult<{
    student_user_id: string; subject_id: string;
    correct_count: number; wrong_count: number; not_attempted_count: number; published: boolean;
  }>;
  const row = attempt.rows[0];
  if (!row || !row.published) return none;

  const existing = await db.execute(sql`
    SELECT 1 FROM evidence_records
    WHERE source_aggregate_type = 'exam_attempt' AND source_aggregate_id = ${input.attemptId}::uuid
    LIMIT 1
  `) as QueryResult<Record<string, unknown>>;
  if (existing.rows.length) return none;

  const links = await db.execute(sql`
    SELECT topic_id, weight FROM exam_subject_topic_links
    WHERE exam_subject_id = ${row.subject_id}::uuid AND retired_at IS NULL
  `) as QueryResult<{ topic_id: string; weight: string }>;
  if (!links.rows.length) return { written: 0, unmappedSubject: true, topicIds: [] };

  const answered = row.correct_count + row.wrong_count + row.not_attempted_count;
  if (answered <= 0) return none;

  const topicIds: string[] = [];
  for (const link of links.rows) {
    const weight = Number(link.weight);
    // Rounded to whole marks so demonstrated and possible stay integers and the
    // evidence invariant (0 <= demonstrated <= possible) cannot be broken by a float.
    const possible = Math.max(1, Math.round(answered * weight));
    const demonstrated = Math.min(possible, Math.round(row.correct_count * weight));
    // Provenance names the mapping that produced this row, so a band can always be
    // traced back to the paper and the weighting behind it.
    const provenance = JSON.stringify({ source: 'INSTITUTION_EXAM', examSubjectId: row.subject_id, weight });
    await db.execute(sql`
      INSERT INTO evidence_records
        (id, subject_user_id, evidence_type, topic_id, demonstrated, possible,
         source_aggregate_type, source_aggregate_id, content_version, provenance, occurred_at)
      VALUES (${randomUUID()}::uuid, ${row.student_user_id}::uuid, 'ASSESSMENT_OUTCOME', ${link.topic_id}::uuid,
              ${demonstrated}, ${possible}, 'exam_attempt', ${input.attemptId}::uuid, 'institution-exam-v1',
              ${provenance}::jsonb, now())
    `);
    topicIds.push(link.topic_id);
  }
  // Evidence moves the band in the same transaction that records it, through the one
  // readiness path (ADR-034). Before ENG-03 this bridge stopped at the evidence and the
  // band stayed where it was until the student happened to sit a readiness check (C9).
  const readiness = await refreshReadinessAfterEvidence(drizzleAsPgClient(db), {
    subjectUserId: row.student_user_id,
    correlationId: input.correlationId ?? `exam-evidence:${input.attemptId}`,
  });
  return { written: topicIds.length, unmappedSubject: false, topicIds, readiness };
}

/** The mappings an institution has declared, for its own exam manager. */
export async function listExamSubjectTopicLinks(
  db: PersistenceDb,
  institutionId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await db.execute(sql`
    SELECT l.id, l.exam_subject_id AS "examSubjectId", s.name AS "subjectName",
           l.topic_id AS "topicId", n.name AS "topicName", l.weight, l.created_at AS "createdAt"
    FROM exam_subject_topic_links l
    JOIN exam_subjects s ON s.id = l.exam_subject_id
    JOIN taxonomy_nodes n ON n.id = l.topic_id
    WHERE l.institution_id = ${institutionId}::uuid AND l.retired_at IS NULL
    ORDER BY s.name, n.name
  `) as QueryResult<Record<string, unknown>>;
  return result.rows;
}

/** The readiness topics a mapping may point at. TOPIC nodes only, enforced by 0030. */
export async function listMappableTopics(db: PersistenceDb): Promise<readonly Record<string, unknown>[]> {
  const result = await db.execute(sql`
    SELECT id, stable_key AS "stableKey", name
    FROM taxonomy_nodes WHERE kind = 'TOPIC' AND active ORDER BY name
  `) as QueryResult<Record<string, unknown>>;
  return result.rows;
}

export async function linkExamSubjectToTopic(
  db: PersistenceDb,
  input: {
    readonly institutionId: string; readonly examSubjectId: string;
    readonly topicId: string; readonly weight: number; readonly createdByUserId: string;
  },
): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO exam_subject_topic_links
      (id, exam_subject_id, institution_id, topic_id, weight, created_by_user_id)
    VALUES (${id}::uuid, ${input.examSubjectId}::uuid, ${input.institutionId}::uuid,
            ${input.topicId}::uuid, ${input.weight}, ${input.createdByUserId}::uuid)
  `);
  return { id };
}

export async function retireExamSubjectTopicLink(
  db: PersistenceDb,
  input: { readonly institutionId: string; readonly linkId: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE exam_subject_topic_links SET retired_at = now()
    WHERE id = ${input.linkId}::uuid AND institution_id = ${input.institutionId}::uuid AND retired_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length > 0;
}
