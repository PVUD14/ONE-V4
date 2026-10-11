import { BadRequestException, Body, Controller, Get, Inject, Logger, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  AssessmentRuleError,
  buildOptionMap,
  gradeObjectiveAnswer,
  mapDisplayedResponse,
  remainingSeconds,
  selectAttemptQuestions,
  summarizeAttempt,
  validateAssessmentAvailability,
  validateAttemptLimit,
  type AttemptResponse,
  type QuestionType,
} from '@planthepath/assessments';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { recordExamResultEvidence } from '@planthepath/persistence/src/exam-evidence-bridge.js';
import { drizzleAsPgClient, recordGradedAttemptSession } from '@planthepath/persistence/src/learning-attempts.js';
import { recordNotification } from './notify.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Grace beyond the timer before a late submit is recorded as auto-submitted. */
const lateSubmitGraceSeconds = 30;

interface AttemptRow {
  id: string;
  institution_id: string;
  definition_id: string;
  student_user_id: string;
  status: string;
  paper_seed: string;
  started_at: string;
  screen_shift_count: number;
  duration_seconds: number;
  ends_at: string;
  publish_results_immediately: boolean;
  auto_submit_on_focus_loss: number | null;
}

/**
 * Student side of the assessment engine: see assigned assessments, start or
 * resume a timed attempt with a deterministic per-student paper, answer, report
 * focus-loss events, and submit for server-side scoring.
 *
 * The attempt payload never includes correct answers or accepted answers; every
 * response is graded on the server against the original option keys.
 */
@Controller('/api/v1/student')
export class StudentAssessmentAttemptsController {
  private readonly logger = new Logger('StudentAssessmentAttempts');

  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** Best-effort activity recording; never allowed to break the main action. */
  private async recordActivity(studentUserId: string, eventType: string): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO learner_activity_events (id, user_id, event_type)
        VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, ${eventType})
      `);
    } catch {
      // Activity is derived telemetry - the attempt itself is the record.
    }
  }

  @Get('/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listAssigned(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const rows = await this.db.execute(sql`
      SELECT d.id, d.title, d.exam_kind, d.lifecycle_state, d.total_marks, d.duration_seconds,
             d.starts_at, d.ends_at, d.attempts_allowed, s.name AS subject_name, org.legal_name AS institution_name,
             (SELECT count(*) FROM exam_attempts t
               WHERE t.definition_id = d.id AND t.student_user_id = ${studentUserId}::uuid AND t.status <> 'IN_PROGRESS') AS attempts_used,
             (SELECT t.id FROM exam_attempts t
               WHERE t.definition_id = d.id AND t.student_user_id = ${studentUserId}::uuid AND t.status = 'IN_PROGRESS'
               LIMIT 1) AS open_attempt_id,
             (SELECT jsonb_build_object('score', r.score, 'maxScore', r.max_score, 'percentage', r.percentage)
               FROM exam_results r
               JOIN exam_attempts t ON t.id = r.attempt_id
               WHERE t.definition_id = d.id AND t.student_user_id = ${studentUserId}::uuid AND r.published
               ORDER BY r.created_at DESC LIMIT 1) AS latest_result
      FROM exam_assignments a
      JOIN exam_definitions d ON d.id = a.definition_id
      JOIN exam_subjects s ON s.id = d.subject_id
      JOIN organizations org ON org.id = d.institution_id
      WHERE a.student_user_id = ${studentUserId}::uuid AND d.lifecycle_state = 'PUBLISHED'
      ORDER BY d.starts_at
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    return {
      assessments: rows.rows.map((row) => ({
        id: row['id'], title: row['title'], assessmentKind: row['exam_kind'],
        subjectName: row['subject_name'], institutionName: row['institution_name'],
        totalMarks: Number(row['total_marks']), durationSeconds: Number(row['duration_seconds']),
        startsAt: row['starts_at'], endsAt: row['ends_at'],
        attemptsAllowed: Number(row['attempts_allowed']), attemptsUsed: Number(row['attempts_used'] ?? 0),
        openAttemptId: row['open_attempt_id'], latestResult: row['latest_result'],
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/assessments/:definitionId/attempts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async startAttempt(@Req() request: ProtectedHttpRequest, @Param('definitionId') definitionId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(definitionId, context.correlationId);

    const definition = await this.db.execute(sql`
      SELECT d.id, d.institution_id, d.starts_at, d.ends_at, d.attempts_allowed, d.duration_seconds
      FROM exam_definitions d
      JOIN exam_assignments a ON a.definition_id = d.id AND a.student_user_id = ${studentUserId}::uuid
      WHERE d.id = ${id}::uuid AND d.lifecycle_state = 'PUBLISHED'
    `) as QueryResult<Record<string, unknown>>;
    const found = definition.rows[0];
    if (!found) throw new NotFoundException(assessmentApiError('ASSESSMENT_NOT_FOUND', context.correlationId));

    // An open attempt resumes only while it still has time. A stale one - its
    // duration spent, or the window closed and later reopened - is finalized
    // with whatever was answered, so the student gets a fresh, full-length
    // attempt when the allowance permits instead of a dead timer.
    const open = await this.db.execute(sql`
      SELECT t.id, t.institution_id, t.definition_id, t.student_user_id, t.status, t.paper_seed,
             t.started_at, t.screen_shift_count,
             d.duration_seconds, d.ends_at, d.publish_results_immediately, d.auto_submit_on_focus_loss
      FROM exam_attempts t
      JOIN exam_definitions d ON d.id = t.definition_id
      WHERE t.definition_id = ${id}::uuid AND t.student_user_id = ${studentUserId}::uuid AND t.status = 'IN_PROGRESS'
      LIMIT 1
    `) as unknown as QueryResult<AttemptRow>;
    const openAttempt = open.rows[0];
    if (openAttempt) {
      const timeLeft = remainingSeconds(openAttempt.started_at, Number(openAttempt.duration_seconds), openAttempt.ends_at);
      if (timeLeft > 0) return this.attemptPayload(openAttempt.id, studentUserId, context.correlationId);
      await this.finalizeAttempt({ ...openAttempt, duration_seconds: Number(openAttempt.duration_seconds) }, true);
    }

    const used = await this.db.execute(sql`
      SELECT count(*) AS n FROM exam_attempts
      WHERE definition_id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
    `) as QueryResult<{ n: string }>;
    try {
      validateAssessmentAvailability(String(found['starts_at']), String(found['ends_at']));
      validateAttemptLimit(Number(used.rows[0]?.n ?? 0), Number(found['attempts_allowed']));
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    const attemptId = this.ids.uuid();
    const attemptNumber = Number(used.rows[0]?.n ?? 0) + 1;

    // Assemble the paper: for each section, a deterministic selection from the
    // pinned pool, plus a per-question option shuffle - all derived from the
    // attempt id, so the paper is reproducible for audits and re-grades.
    const sections = await this.db.execute(sql`
      SELECT s.id, s.display_count, s.marks_per_question, s.negative_marks, s.position
      FROM exam_sections s WHERE s.definition_id = ${id}::uuid ORDER BY s.position
    `) as QueryResult<Record<string, unknown>>;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO exam_attempts (id, institution_id, definition_id, student_user_id, attempt_number, paper_seed)
        VALUES (${attemptId}::uuid, ${String(found['institution_id'])}::uuid, ${id}::uuid, ${studentUserId}::uuid, ${attemptNumber}, ${attemptId})
      `);
      let position = 1;
      for (const section of sections.rows) {
        const pool = await tx.execute(sql`
          SELECT p.question_id, q.question_type,
                 (SELECT jsonb_agg(o.option_key ORDER BY o.position) FROM exam_question_options o WHERE o.question_id = q.id) AS option_keys
          FROM exam_section_pool p
          JOIN exam_questions q ON q.id = p.question_id
          WHERE p.section_id = ${String(section['id'])}::uuid AND q.approval_status = 'APPROVED' AND q.is_active
        `) as QueryResult<{ question_id: string; question_type: QuestionType; option_keys: string[] | null }>;
        const chosen = selectAttemptQuestions(pool.rows, Number(section['display_count']), `${attemptId}:${String(section['id'])}`);
        for (const question of chosen) {
          const optionKeys = question.option_keys ?? [];
          const optionMap = optionKeys.length ? buildOptionMap(optionKeys, `${attemptId}:${question.question_id}`) : {};
          await tx.execute(sql`
            INSERT INTO exam_attempt_questions
              (id, attempt_id, section_id, question_id, position, option_map, marks, negative_marks)
            VALUES
              (${this.ids.uuid()}::uuid, ${attemptId}::uuid, ${String(section['id'])}::uuid, ${question.question_id}::uuid,
               ${position}, ${JSON.stringify(optionMap)}::jsonb, ${Number(section['marks_per_question'])}, ${Number(section['negative_marks'] ?? 0)})
          `);
          position += 1;
        }
      }
    });

    await this.recordActivity(studentUserId, 'EXAM_ATTEMPT_STARTED');
    return this.attemptPayload(attemptId, studentUserId, context.correlationId);
  }

  @Get('/assessment-attempts/:attemptId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getAttempt(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    return this.attemptPayload(requireUuid(attemptId, context.correlationId), studentUserId, context.correlationId);
  }

  @Post('/assessment-attempts/:attemptId/answers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async saveAnswer(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const attempt = await this.loadOpenAttempt(requireUuid(attemptId, context.correlationId), studentUserId, context.correlationId);
    if (remainingSeconds(attempt.started_at, attempt.duration_seconds, attempt.ends_at) <= 0) {
      throw new BadRequestException(assessmentApiError('ATTEMPT_TIME_OVER', context.correlationId));
    }
    const questionId = requireUuid(String(body['questionId'] ?? ''), context.correlationId);
    const onPaper = await this.db.execute(sql`
      SELECT 1 FROM exam_attempt_questions WHERE attempt_id = ${attempt.id}::uuid AND question_id = ${questionId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    if (!onPaper.rows.length) throw new BadRequestException(assessmentApiError('QUESTION_NOT_ON_PAPER', context.correlationId));
    const response = sanitizeResponse(body['response']);
    await this.db.execute(sql`
      INSERT INTO exam_answers (id, attempt_id, question_id, response)
      VALUES (${this.ids.uuid()}::uuid, ${attempt.id}::uuid, ${questionId}::uuid, ${JSON.stringify(response)}::jsonb)
      ON CONFLICT (attempt_id, question_id) DO UPDATE SET response = EXCLUDED.response, updated_at = now()
    `);
    return { saved: true, correlationId: context.correlationId };
  }

  @Post('/assessment-attempts/:attemptId/focus-events')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async recordFocusEvent(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const attempt = await this.loadOpenAttempt(requireUuid(attemptId, context.correlationId), studentUserId, context.correlationId);
    const limit = attempt.auto_submit_on_focus_loss;
    const nextCount = attempt.screen_shift_count + 1;
    const level = limit != null && nextCount >= limit ? 'FINAL' : limit != null && nextCount >= Math.max(1, limit - 1) ? 'WARNING' : 'INFO';
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO exam_screen_events (id, attempt_id, level) VALUES (${this.ids.uuid()}::uuid, ${attempt.id}::uuid, ${level})
      `);
      await tx.execute(sql`
        UPDATE exam_attempts SET screen_shift_count = ${nextCount} WHERE id = ${attempt.id}::uuid
      `);
    });
    if (level === 'FINAL') {
      const result = await this.finalizeAttempt(attempt, true);
      return { recorded: true, level, autoSubmitted: true, result, correlationId: context.correlationId };
    }
    return { recorded: true, level, remainingBeforeAutoSubmit: limit != null ? Math.max(0, limit - nextCount) : null, correlationId: context.correlationId };
  }

  @Post('/assessment-attempts/:attemptId/submit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submit(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const attempt = await this.loadOpenAttempt(requireUuid(attemptId, context.correlationId), studentUserId, context.correlationId);
    const late = remainingSeconds(attempt.started_at, attempt.duration_seconds, attempt.ends_at) <= -lateSubmitGraceSeconds;
    const result = await this.finalizeAttempt(attempt, late);
    await this.recordActivity(studentUserId, 'EXAM_ATTEMPT_SUBMITTED');
    return { submitted: true, autoSubmitted: late, result, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------

  private async loadOpenAttempt(attemptId: string, studentUserId: string, correlationId: string): Promise<AttemptRow> {
    const rows = await this.db.execute(sql`
      SELECT t.id, t.institution_id, t.definition_id, t.student_user_id, t.status, t.paper_seed,
             t.started_at, t.screen_shift_count,
             d.duration_seconds, d.ends_at, d.publish_results_immediately, d.auto_submit_on_focus_loss
      FROM exam_attempts t
      JOIN exam_definitions d ON d.id = t.definition_id
      WHERE t.id = ${attemptId}::uuid AND t.student_user_id = ${studentUserId}::uuid
    `) as unknown as QueryResult<AttemptRow>;
    const attempt = rows.rows[0];
    if (!attempt) throw new NotFoundException(assessmentApiError('ATTEMPT_NOT_FOUND', correlationId));
    if (attempt.status !== 'IN_PROGRESS') throw new BadRequestException(assessmentApiError('ATTEMPT_ALREADY_SUBMITTED', correlationId));
    return { ...attempt, screen_shift_count: Number(attempt.screen_shift_count), duration_seconds: Number(attempt.duration_seconds), auto_submit_on_focus_loss: attempt.auto_submit_on_focus_loss == null ? null : Number(attempt.auto_submit_on_focus_loss) };
  }

  /** The paper as the student sees it: shuffled options, no answer key. */
  private async attemptPayload(attemptId: string, studentUserId: string, correlationId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.execute(sql`
      SELECT t.id, t.status, t.started_at, t.attempt_number, t.screen_shift_count,
             d.id AS definition_id, d.title, d.duration_seconds, d.ends_at, d.total_marks, d.auto_submit_on_focus_loss
      FROM exam_attempts t
      JOIN exam_definitions d ON d.id = t.definition_id
      WHERE t.id = ${attemptId}::uuid AND t.student_user_id = ${studentUserId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const attempt = rows.rows[0];
    if (!attempt) throw new NotFoundException(assessmentApiError('ATTEMPT_NOT_FOUND', correlationId));

    const questions = await this.db.execute(sql`
      SELECT aq.question_id, aq.position, aq.option_map, aq.marks, aq.negative_marks,
             q.question_type, q.question_text,
             (SELECT jsonb_agg(jsonb_build_object('key', o.option_key, 'text', o.option_text, 'matchKey', o.match_key) ORDER BY o.position)
                FROM exam_question_options o WHERE o.question_id = q.id) AS options,
             a.response AS saved_response
      FROM exam_attempt_questions aq
      JOIN exam_questions q ON q.id = aq.question_id
      LEFT JOIN exam_answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      WHERE aq.attempt_id = ${attemptId}::uuid
      ORDER BY aq.position
    `) as QueryResult<Record<string, unknown>>;

    const paper = questions.rows.map((row) => {
      const optionMap = (row['option_map'] ?? {}) as Record<string, string>;
      const options = ((row['options'] ?? []) as { key: string; text: string; matchKey: string | null }[]);
      const byOriginal = new Map(options.map((option) => [option.key, option]));
      // Present options in display order: displayKey -> text of the original it maps to.
      const displayed = Object.keys(optionMap).sort().map((displayKey) => ({
        key: displayKey,
        text: byOriginal.get(optionMap[displayKey] ?? '')?.text ?? '',
      }));
      const matchTargets = options.map((option) => option.matchKey).filter((value): value is string => Boolean(value)).sort();
      return {
        questionId: row['question_id'], position: Number(row['position']),
        questionType: row['question_type'], questionText: row['question_text'],
        marks: Number(row['marks']), negativeMarks: Number(row['negative_marks']),
        options: displayed.length ? displayed : undefined,
        matchTargets: matchTargets.length ? matchTargets : undefined,
        savedResponse: row['saved_response'] ?? null,
      };
    });

    return {
      attempt: {
        id: attempt['id'], status: attempt['status'], attemptNumber: Number(attempt['attempt_number']),
        assessmentId: attempt['definition_id'], title: attempt['title'], totalMarks: Number(attempt['total_marks']),
        startedAt: attempt['started_at'], durationSeconds: Number(attempt['duration_seconds']),
        remainingSeconds: attempt['status'] === 'IN_PROGRESS'
          ? remainingSeconds(String(attempt['started_at']), Number(attempt['duration_seconds']), String(attempt['ends_at']))
          : 0,
        screenShiftCount: Number(attempt['screen_shift_count']),
        autoSubmitOnFocusLoss: attempt['auto_submit_on_focus_loss'],
        questions: paper,
      },
      correlationId,
    };
  }

  /** Grades on the server against original keys and writes the single result row. */
  private async finalizeAttempt(attempt: AttemptRow, autoSubmitted: boolean): Promise<Record<string, unknown> | null> {
    const rows = await this.db.execute(sql`
      SELECT aq.question_id, aq.option_map, aq.marks, aq.negative_marks,
             q.question_type, q.accepted_answers, q.case_sensitive, q.version AS question_version,
             (SELECT jsonb_agg(jsonb_build_object('key', o.option_key, 'isCorrect', o.is_correct, 'matchKey', o.match_key))
                FROM exam_question_options o WHERE o.question_id = q.id) AS options,
             a.response
      FROM exam_attempt_questions aq
      JOIN exam_questions q ON q.id = aq.question_id
      LEFT JOIN exam_answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
      WHERE aq.attempt_id = ${attempt.id}::uuid
    `) as QueryResult<Record<string, unknown>>;

    const graded = rows.rows.map((row) => {
      const questionType = String(row['question_type']) as QuestionType;
      const options = ((row['options'] ?? []) as { key: string; isCorrect: boolean; matchKey: string | null }[]);
      const answerKey = {
        correctOptionKeys: options.filter((option) => option.isCorrect).map((option) => option.key),
        acceptedAnswers: (row['accepted_answers'] ?? []) as string[],
        caseSensitive: Boolean(row['case_sensitive']),
        matches: Object.fromEntries(options.filter((option) => option.matchKey).map((option) => [option.key, String(option.matchKey)])),
      };
      const optionMap = (row['option_map'] ?? {}) as Record<string, string>;
      const response = mapDisplayedResponse(questionType, row['response'] as AttemptResponse | null, optionMap);
      const marks = Number(row['marks']);
      const outcome = gradeObjectiveAnswer({ questionType, answerKey, marks, negativeMarks: Number(row['negative_marks']) }, response);
      return { ...outcome, marks, questionId: String(row['question_id']), questionVersion: Number(row['question_version']) };
    });

    const summary = summarizeAttempt(graded);
    const status = autoSubmitted ? 'AUTO_SUBMITTED' : 'SUBMITTED';
    const timeTaken = Math.max(0, Math.min(attempt.duration_seconds, Math.floor((Date.now() - new Date(attempt.started_at).getTime()) / 1000)));
    const resultId = this.ids.uuid();
    const published = Boolean(attempt.publish_results_immediately);

    await this.db.transaction(async (tx) => {
      const closed = await tx.execute(sql`
        UPDATE exam_attempts SET status = ${status}, submitted_at = now(), auto_submitted = ${autoSubmitted}
        WHERE id = ${attempt.id}::uuid AND status = 'IN_PROGRESS'
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (closed.rows.length !== 1) return;
      await tx.execute(sql`
        INSERT INTO exam_results
          (id, attempt_id, score, max_score, percentage, correct_count, wrong_count, not_attempted_count, time_taken_seconds, published)
        VALUES
          (${resultId}::uuid, ${attempt.id}::uuid, ${summary.score}, ${summary.maxScore}, ${summary.percentage},
           ${summary.correct}, ${summary.wrong}, ${summary.notAttempted}, ${timeTaken}, ${published})
      `);
      // The attempt log (ENG-03): one row per graded question on the paper, answered or
      // not, in the same transaction as the result, whether or not the result is published
      // -- publication gates evidence, not the record of what the student did. An exam
      // question is authored against an institution subject, not a readiness topic, so the
      // row carries no skill; the projection resolves it through the subject mapping.
      await recordGradedAttemptSession(drizzleAsPgClient(tx), {
        subjectUserId: attempt.student_user_id, institutionId: attempt.institution_id,
        mode: 'ASSESSMENT', context: 'ASSESSMENT',
        sourceAttemptType: 'exam_attempt', sourceAttemptId: attempt.id,
        startedAt: attempt.started_at, contentVersion: 'institution-exam-v1',
        responses: graded.map((entry) => ({
          itemSource: 'INSTITUTION_EXAM_QUESTION' as const, itemId: entry.questionId, itemVersion: entry.questionVersion,
          skillId: null, answered: entry.answered, correct: entry.isCorrect,
          marksAwarded: entry.marksAwarded, marksPossible: entry.marks,
        })),
      });
      // A published result is the institution's word about the student, so it becomes
      // readiness evidence in the same transaction that records it -- never one without
      // the other. An unmapped subject writes nothing and says so rather than guessing
      // a topic, and re-publishing does not double-count.
      if (published) {
        const bridged = await recordExamResultEvidence(tx, { attemptId: attempt.id });
        if (bridged.unmappedSubject) {
          // Visible, not filled. Until the institution maps this subject onto readiness
          // topics, its exams move no bands, and that should be findable in the log
          // rather than discovered as "the feature is broken".
          this.logger.warn(JSON.stringify({
            event: 'exam.evidence.subject_unmapped', attemptId: attempt.id, definitionId: attempt.definition_id,
          }));
        }
      }
    });

    if (published) {
      const titled = await this.db.execute(sql`
        SELECT title FROM exam_definitions WHERE id = ${attempt.definition_id}::uuid
      `) as QueryResult<{ title: string }>;
      await recordNotification(this.db, this.ids, {
        userId: attempt.student_user_id,
        kind: 'RESULT_PUBLISHED',
        title: `Result published: ${titled.rows[0]?.title ?? 'Assessment'}`,
        body: `You scored ${summary.score}/${summary.maxScore} (${summary.percentage}%). Open Assessments to review.`,
        data: { assessmentId: attempt.definition_id, attemptId: attempt.id },
      });
    }

    return published
      ? { score: summary.score, maxScore: summary.maxScore, percentage: summary.percentage, correct: summary.correct, wrong: summary.wrong, notAttempted: summary.notAttempted }
      : null;
  }
}

function sanitizeResponse(value: unknown): AttemptResponse {
  const raw = (value ?? {}) as Record<string, unknown>;
  const response: { selectedOptionKeys?: string[]; text?: string; matches?: Record<string, string> } = {};
  if (Array.isArray(raw['selectedOptionKeys'])) {
    response.selectedOptionKeys = raw['selectedOptionKeys'].map((key) => String(key).slice(0, 8)).slice(0, 12);
  }
  if (typeof raw['text'] === 'string') response.text = raw['text'].slice(0, 2000);
  if (raw['matches'] && typeof raw['matches'] === 'object') {
    response.matches = Object.fromEntries(
      Object.entries(raw['matches'] as Record<string, unknown>).slice(0, 12).map(([key, target]) => [String(key).slice(0, 8), String(target).slice(0, 64)]),
    );
  }
  return response;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw new BadRequestException(assessmentApiError('INVALID_ID', correlationId));
  return value;
}

function asRuleError(error: unknown, correlationId: string): Error {
  if (error instanceof AssessmentRuleError) {
    return new BadRequestException({ error: { code: 'ASSESSMENT_RULE', message: error.message, correlationId } });
  }
  return error instanceof Error ? error : new BadRequestException(assessmentApiError('INVALID_REQUEST', correlationId));
}

function assessmentApiError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}
