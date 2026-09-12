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
 * Stream C calls `recordExamResultEvidence` when it publishes a result. This module
 * owns what gets written and refuses to invent any of it.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface ExamEvidenceOutcome {
  readonly written: number;
  /** Subjects with no live topic mapping. Reported so the gap is visible, not filled. */
  readonly unmappedSubject: boolean;
  readonly topicIds: readonly string[];
}

/**
 * Write one ASSESSMENT_OUTCOME evidence row per topic the exam's subject maps onto.
 *
 * Three refusals are the substance of this function:
 *
 *  - An unmapped subject writes nothing and reports itself. Guessing a topic from a
 *    subject name would put invented evidence under a student's readiness band.
 *  - An unpublished result writes nothing. An unpublished result is not yet the
 *    institution's word about the student.
 *  - Negative marking is not carried through. `exam_results.score` may legitimately be
 *    negative, `evidence_records` requires 0 <= demonstrated <= possible, and a penalty
 *    is an assessment policy rather than a statement about what was demonstrated. The
 *    counts are used instead of the score for exactly this reason.
 *
 * Idempotent on the attempt: re-publishing a result does not double-count, because the
 * source aggregate is the attempt and existing rows for it are left alone.
 */
export async function recordExamResultEvidence(
  client: Queryable,
  input: { readonly attemptId: string },
): Promise<ExamEvidenceOutcome> {
  const attempt = await client.query<{
    subjectUserId: string; subjectId: string; correct: number; wrong: number; notAttempted: number; published: boolean;
  }>(
    `SELECT a.student_user_id AS "subjectUserId",
            d.subject_id AS "subjectId",
            r.correct_count AS correct,
            r.wrong_count AS wrong,
            r.not_attempted_count AS "notAttempted",
            r.published
     FROM exam_results r
     JOIN exam_attempts a ON a.id = r.attempt_id
     JOIN exam_definitions d ON d.id = a.definition_id
     WHERE r.attempt_id = $1`, [input.attemptId],
  );
  const row = attempt.rows[0];
  if (!row || !row.published) return { written: 0, unmappedSubject: false, topicIds: [] };

  const existing = await client.query(
    `SELECT 1 FROM evidence_records
     WHERE source_aggregate_type = 'exam_attempt' AND source_aggregate_id = $1 LIMIT 1`, [input.attemptId],
  );
  if (existing.rowCount) return { written: 0, unmappedSubject: false, topicIds: [] };

  const links = await client.query<{ topicId: string; weight: string }>(
    `SELECT topic_id AS "topicId", weight FROM exam_subject_topic_links
     WHERE exam_subject_id = $1 AND retired_at IS NULL`, [row.subjectId],
  );
  if (!links.rows.length) return { written: 0, unmappedSubject: true, topicIds: [] };

  const answered = row.correct + row.wrong + row.notAttempted;
  if (answered <= 0) return { written: 0, unmappedSubject: false, topicIds: [] };

  const topicIds: string[] = [];
  for (const link of links.rows) {
    const weight = Number(link.weight);
    // Rounded to whole marks so demonstrated and possible stay integers and the
    // evidence invariant (0 <= demonstrated <= possible) cannot be broken by a float.
    const possible = Math.max(1, Math.round(answered * weight));
    const demonstrated = Math.min(possible, Math.round(row.correct * weight));
    await client.query(
      `INSERT INTO evidence_records
       (id, subject_user_id, evidence_type, topic_id, demonstrated, possible,
        source_aggregate_type, source_aggregate_id, content_version, provenance, occurred_at)
       VALUES ($1,$2,'ASSESSMENT_OUTCOME',$3,$4,$5,'exam_attempt',$6,$7,$8::jsonb,now())`,
      [randomUUID(), row.subjectUserId, link.topicId, demonstrated, possible,
        input.attemptId, 'institution-exam-v1',
        // Provenance names the mapping that produced this row, so a band can always be
        // traced back to the paper and the weighting behind it.
        JSON.stringify({ source: 'INSTITUTION_EXAM', examSubjectId: row.subjectId, weight })],
    );
    topicIds.push(link.topicId);
  }
  return { written: topicIds.length, unmappedSubject: false, topicIds };
}

/** The mappings an institution has declared, for its own exam manager. */
export async function listExamSubjectTopicLinks(
  client: Queryable,
  institutionId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await client.query(
    `SELECT l.id, l.exam_subject_id AS "examSubjectId", s.name AS "subjectName",
            l.topic_id AS "topicId", n.name AS "topicName", l.weight, l.created_at AS "createdAt"
     FROM exam_subject_topic_links l
     JOIN exam_subjects s ON s.id = l.exam_subject_id
     JOIN taxonomy_nodes n ON n.id = l.topic_id
     WHERE l.institution_id = $1 AND l.retired_at IS NULL
     ORDER BY s.name, n.name`, [institutionId],
  );
  return result.rows;
}

export async function linkExamSubjectToTopic(
  client: Queryable,
  input: {
    readonly institutionId: string; readonly examSubjectId: string;
    readonly topicId: string; readonly weight: number; readonly createdByUserId: string;
  },
): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO exam_subject_topic_links
     (id, exam_subject_id, institution_id, topic_id, weight, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.examSubjectId, input.institutionId, input.topicId, input.weight, input.createdByUserId],
  );
  return { id };
}

export async function retireExamSubjectTopicLink(
  client: Queryable,
  input: { readonly institutionId: string; readonly linkId: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE exam_subject_topic_links SET retired_at = now()
     WHERE id = $1 AND institution_id = $2 AND retired_at IS NULL`,
    [input.linkId, input.institutionId],
  );
  return (result.rowCount ?? 0) > 0;
}
