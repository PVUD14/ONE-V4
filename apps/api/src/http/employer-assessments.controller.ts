/**
 * Employer screening assessments: an employer's own question bank, a test built from it,
 * and the applicants they send it to.
 *
 * Design in docs/architecture/employer-assessment-table-design.md.
 *
 * The domain rules come from `@planthepath/assessments` unchanged — it is pure and knows
 * nothing about who owns an assessment — so an employer test inherits the same integrity
 * properties an institution exam has: a paper frozen at start, per-candidate option order,
 * answer keys that never leave the server, and grading the client cannot influence.
 *
 * Two boundaries are enforced here rather than assumed:
 *
 *   A screening result never touches readiness. Nothing in this file reads or writes
 *   evidence, mastery or readiness. An employer shaping the band, even indirectly, would
 *   hollow out the one promise the whole product rests on.
 *
 *   An invitation requires a live, consented application. The employer's access to a
 *   person ends when the application closes, and an invitation must not become a way to
 *   reach them afterwards.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AssessmentRuleError,
  assertQuestionTransition,
  buildOptionMap,
  deterministicShuffle,
  gradeObjectiveAnswer,
  mapDisplayedResponse,
  questionHash,
  summarizeAttempt,
  validateObjectiveQuestion,
  type QuestionStatus,
  type QuestionType,
} from '@planthepath/assessments';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Employer roles that may build and send a screening test. */
const assessmentRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;

/**
 * Types this engine accepts. A screening test is machine-marked, so every type here has an
 * objective key; nothing that would need a human examiner is offered, because there is no
 * workflow to mark it.
 */
const employerQuestionTypes: readonly QuestionType[] = [
  'SINGLE_CHOICE_MCQ', 'MULTIPLE_SELECT', 'TRUE_FALSE', 'SCENARIO_MCQ', 'CODE_OUTPUT_MCQ', 'NUMERICAL_MCQ',
];

@Controller('/api/v1')
export class EmployerAssessmentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // The employer's bank
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/assessment-questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listQuestions(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const rows = await this.db.execute(sql`
      SELECT q.id, q.question_text, q.question_type, q.difficulty, q.marks, q.approval_status, q.version,
             (SELECT count(*)::int FROM employer_assessment_question_options o WHERE o.question_id = q.id) AS option_count
      FROM employer_assessment_questions q
      WHERE q.employer_id = ${employerId}::uuid AND q.approval_status <> 'ARCHIVED'
      ORDER BY q.created_at DESC LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    // No is_correct anywhere in this projection: the bank list is read on screens that a
    // recruiter shares, and an answer key has no business being there either.
    return {
      questions: rows.rows.map((row) => ({
        id: row.id, questionText: row.question_text, questionType: row.question_type,
        difficulty: row.difficulty, marks: Number(row.marks), approvalStatus: row.approval_status,
        version: Number(row.version), optionCount: Number(row.option_count),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/assessment-questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createQuestion(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const input = readQuestionInput(body, context.correlationId);
    try {
      validateObjectiveQuestion({ questionText: input.questionText, questionType: input.questionType, options: input.options });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const hash = questionHash(input.questionText);
    const duplicate = await this.db.execute(sql`
      SELECT id FROM employer_assessment_questions
      WHERE employer_id = ${employerId}::uuid AND question_hash = ${hash} AND approval_status <> 'ARCHIVED'
    `) as QueryResult<{ id: string }>;
    if (duplicate.rows.length) throw badRequest('DUPLICATE_QUESTION', context.correlationId);

    const id = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO employer_assessment_questions
          (id, employer_id, question_text, question_type, difficulty, marks, question_hash, created_by_user_id)
        VALUES (${id}::uuid, ${employerId}::uuid, ${input.questionText}, ${input.questionType},
                ${input.difficulty}, ${input.marks}, ${hash}, ${context.authorization.principal.userId}::uuid)
      `);
      for (const option of input.options) {
        await tx.execute(sql`
          INSERT INTO employer_assessment_question_options (id, question_id, option_key, option_text, is_correct)
          VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${option.key}, ${option.text}, ${option.isCorrect})
        `);
      }
    });
    return { question: { id, approvalStatus: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/assessment-questions/:questionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionQuestion(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('questionId') questionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const id = requireUuid(questionId, context.correlationId);
    const toState = readEnum(body, 'toState', ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'] as const, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT approval_status, created_by_user_id FROM employer_assessment_questions
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `) as QueryResult<{ approval_status: string; created_by_user_id: string }>;
    const [question] = rows.rows;
    if (!question) throw forbidden(context.correlationId);

    // The author does not approve their own question. A review ladder that one person can
    // walk end to end is a formality, not a review.
    if (toState === 'APPROVED' && question.created_by_user_id === context.authorization.principal.userId) {
      throw badRequest('AUTHOR_CANNOT_APPROVE_OWN_QUESTION', context.correlationId);
    }
    try {
      assertQuestionTransition(question.approval_status as QuestionStatus, toState as QuestionStatus);
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const decided = toState === 'APPROVED' || toState === 'REJECTED';
    await this.db.execute(sql`
      UPDATE employer_assessment_questions
      SET approval_status = ${toState}, updated_at = now(),
          reviewed_by_user_id = ${decided ? sql`${context.authorization.principal.userId}::uuid` : sql`reviewed_by_user_id`},
          reviewed_at = ${decided ? sql`now()` : sql`reviewed_at`}
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    return { question: { id, approvalStatus: toState }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // The assessment
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listAssessments(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const rows = await this.db.execute(sql`
      SELECT a.id, a.title, a.duration_seconds, a.total_marks, a.lifecycle_state, a.opportunity_id, a.published_at,
             (SELECT count(*)::int FROM employer_assessment_items i WHERE i.assessment_id = a.id) AS item_count,
             (SELECT count(*)::int FROM employer_assessment_invitations v WHERE v.assessment_id = a.id) AS invited_count,
             (SELECT count(*)::int FROM employer_assessment_invitations v WHERE v.assessment_id = a.id AND v.state = 'SUBMITTED') AS submitted_count
      FROM employer_assessments a
      WHERE a.employer_id = ${employerId}::uuid AND a.lifecycle_state <> 'ARCHIVED'
      ORDER BY a.created_at DESC LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return {
      assessments: rows.rows.map((row) => ({
        id: row.id, title: row.title, durationSeconds: Number(row.duration_seconds),
        totalMarks: Number(row.total_marks), lifecycleState: row.lifecycle_state,
        opportunityId: row.opportunity_id ?? null, publishedAt: row.published_at ?? null,
        itemCount: Number(row.item_count), invitedCount: Number(row.invited_count),
        submittedCount: Number(row.submitted_count),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createAssessment(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const input = readAssessmentInput(body, context.correlationId);

    // Only approved questions, and only this employer's. The composite foreign key would
    // refuse a foreign question anyway; this turns that into a clear error rather than a
    // constraint violation.
    const approved = await this.db.execute(sql`
      SELECT id, marks FROM employer_assessment_questions
      WHERE employer_id = ${employerId}::uuid AND approval_status = 'APPROVED'
        AND id IN (${sql.join(input.questionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `) as QueryResult<{ id: string; marks: string }>;
    if (approved.rows.length !== input.questionIds.length) throw badRequest('QUESTIONS_NOT_APPROVED', context.correlationId);

    const id = this.ids.uuid();
    const totalMarks = approved.rows.reduce((sum, row) => sum + Number(row.marks), 0);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO employer_assessments
          (id, employer_id, opportunity_id, title, duration_seconds, total_marks, created_by_user_id)
        VALUES (${id}::uuid, ${employerId}::uuid, ${input.opportunityId}, ${input.title},
                ${input.durationSeconds}, ${totalMarks}, ${context.authorization.principal.userId}::uuid)
      `);
      let sequence = 0;
      for (const questionId of input.questionIds) {
        sequence += 1;
        const marks = Number(approved.rows.find((row) => row.id === questionId)?.marks ?? 1);
        await tx.execute(sql`
          INSERT INTO employer_assessment_items (id, assessment_id, employer_id, question_id, sequence, marks)
          VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${employerId}::uuid, ${questionId}::uuid, ${sequence}, ${marks})
        `);
      }
    });
    return { assessment: { id, totalMarks, lifecycleState: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/assessments/:assessmentId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publishAssessment(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const id = requireUuid(assessmentId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT a.lifecycle_state, (SELECT count(*)::int FROM employer_assessment_items i WHERE i.assessment_id = a.id) AS item_count
      FROM employer_assessments a WHERE a.id = ${id}::uuid AND a.employer_id = ${employerId}::uuid
    `) as QueryResult<{ lifecycle_state: string; item_count: number }>;
    const [assessment] = rows.rows;
    if (!assessment) throw forbidden(context.correlationId);
    if (assessment.lifecycle_state !== 'DRAFT') throw badRequest('ASSESSMENT_NOT_DRAFT', context.correlationId);
    // An empty test would be sent to real people and waste their time.
    if (Number(assessment.item_count) < 1) throw badRequest('ASSESSMENT_HAS_NO_QUESTIONS', context.correlationId);

    await this.db.execute(sql`
      UPDATE employer_assessments SET lifecycle_state = 'PUBLISHED', published_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    return { assessment: { id, lifecycleState: 'PUBLISHED' }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Inviting applicants
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/assessments/:assessmentId/invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async invite(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const id = requireUuid(assessmentId, context.correlationId);
    const input = readInvitationInput(body, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT lifecycle_state, opportunity_id FROM employer_assessments
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `) as QueryResult<{ lifecycle_state: string; opportunity_id: string | null }>;
    const [assessment] = rows.rows;
    if (!assessment) throw forbidden(context.correlationId);
    if (assessment.lifecycle_state !== 'PUBLISHED') throw badRequest('ASSESSMENT_NOT_PUBLISHED', context.correlationId);

    // A live, consented application at this employer, and — when the assessment names an
    // opportunity — for that opportunity. The employer's access to a person ends with the
    // application; an invitation must not outlive it.
    const eligible = await this.db.execute(sql`
      SELECT a.id FROM applications a
      WHERE a.employer_id = ${employerId}::uuid
        AND a.closed_at IS NULL
        AND a.consent_revoked_at IS NULL
        AND a.state NOT IN ('DRAFT','REJECTED','WITHDRAWN','HIRED')
        AND (${assessment.opportunity_id === null} OR a.opportunity_id = ${assessment.opportunity_id}::uuid)
        AND a.id IN (${sql.join(input.applicationIds.map((applicationId) => sql`${applicationId}::uuid`), sql`, `)})
    `) as QueryResult<{ id: string }>;
    if (eligible.rows.length !== input.applicationIds.length) throw badRequest('APPLICATION_NOT_INVITABLE', context.correlationId);

    const created: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const applicationId of input.applicationIds) {
        const invitationId = this.ids.uuid();
        // Re-inviting the same application to the same assessment is a no-op rather than
        // an error: a recruiter selecting a list twice has not done anything wrong.
        const result = await tx.execute(sql`
          INSERT INTO employer_assessment_invitations
            (id, assessment_id, employer_id, application_id, invited_by_user_id, closes_at)
          VALUES (${invitationId}::uuid, ${id}::uuid, ${employerId}::uuid, ${applicationId}::uuid,
                  ${context.authorization.principal.userId}::uuid, ${input.closesAt})
          ON CONFLICT (assessment_id, application_id) DO NOTHING
          RETURNING id
        `) as QueryResult<{ id: string }>;
        if (result.rows.length) created.push(invitationId);
      }
    });
    return { invited: created.length, correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/assessments/:assessmentId/results')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async results(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId);
    const id = requireUuid(assessmentId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT v.id AS invitation_id, v.state, v.application_id, v.closes_at,
             t.score, t.max_score, t.percentage, t.submitted_at,
             u.email AS candidate_email, isp.full_name AS candidate_name
      FROM employer_assessment_invitations v
      JOIN applications a ON a.id = v.application_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      LEFT JOIN LATERAL (
        SELECT full_name FROM institution_student_profiles p
        WHERE p.student_user_id = a.student_user_id LIMIT 1
      ) isp ON true
      WHERE v.assessment_id = ${id}::uuid AND v.employer_id = ${employerId}::uuid
        AND a.consent_revoked_at IS NULL
      ORDER BY t.percentage DESC NULLS LAST, v.invited_at
    `) as QueryResult<Record<string, unknown>>;
    // No readiness band, and no other employer's results. The employer sees what they
    // measured and nothing else.
    return {
      results: rows.rows.map((row) => ({
        invitationId: row.invitation_id, applicationId: row.application_id, state: row.state,
        candidateName: row.candidate_name ?? null, candidateEmail: row.candidate_email,
        closesAt: row.closes_at,
        score: row.score === null ? null : Number(row.score),
        maxScore: row.max_score === null ? null : Number(row.max_score),
        percentage: row.percentage === null ? null : Number(row.percentage),
        submittedAt: row.submitted_at ?? null,
      })),
      correlationId: context.correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // The candidate's side
  // -------------------------------------------------------------------------

  @Get('/students/me/screening-assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async myInvitations(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const rows = await this.db.execute(sql`
      SELECT v.id, v.state, v.opens_at, v.closes_at,
             s.title, s.duration_seconds, org.legal_name AS employer_name, ov.title AS role_title,
             t.id AS attempt_id, t.state AS attempt_state, t.percentage
      FROM employer_assessment_invitations v
      JOIN employer_assessments s ON s.id = v.assessment_id
      JOIN applications a ON a.id = v.application_id
      JOIN opportunity_versions ov ON ov.id = a.applied_version_id
      JOIN organizations org ON org.id = v.employer_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      WHERE a.student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY v.closes_at
    `) as QueryResult<Record<string, unknown>>;
    return {
      invitations: rows.rows.map((row) => ({
        id: row.id, state: row.state, opensAt: row.opens_at, closesAt: row.closes_at,
        title: row.title, durationSeconds: Number(row.duration_seconds),
        employerName: row.employer_name, roleTitle: row.role_title,
        attemptId: row.attempt_id ?? null, attemptState: row.attempt_state ?? null,
        // The candidate sees their own score once submitted. It is theirs too.
        percentage: row.percentage === null || row.percentage === undefined ? null : Number(row.percentage),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/students/me/screening-assessments/:invitationId/start')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async start(@Req() request: ProtectedHttpRequest, @Param('invitationId') invitationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(invitationId, context.correlationId);
    const userId = context.authorization.principal.userId;

    // The window is judged by the database's own clock on both sides. opens_at is written
    // with the database's now(), so comparing it against this process's clock makes the
    // check fail under even small skew -- and a candidate would be told a test they were
    // just sent has not opened yet.
    const rows = await this.db.execute(sql`
      SELECT v.id, v.state, v.assessment_id, a.student_user_id,
             now() < v.opens_at AS not_open_yet,
             now() > v.closes_at AS window_closed
      FROM employer_assessment_invitations v
      JOIN applications a ON a.id = v.application_id
      WHERE v.id = ${id}::uuid AND a.student_user_id = ${userId}::uuid AND a.consent_revoked_at IS NULL
    `) as QueryResult<Record<string, unknown>>;
    const [invitation] = rows.rows;
    if (!invitation) throw forbidden(context.correlationId);
    if (invitation.not_open_yet === true) throw badRequest('ASSESSMENT_NOT_OPEN_YET', context.correlationId);
    if (invitation.window_closed === true) throw badRequest('ASSESSMENT_WINDOW_CLOSED', context.correlationId);

    const existing = await this.db.execute(sql`
      SELECT id, state FROM employer_assessment_attempts WHERE invitation_id = ${id}::uuid
    `) as QueryResult<{ id: string; state: string }>;
    // Starting twice returns the attempt already in progress rather than a second paper.
    if (existing.rows[0]) {
      if (existing.rows[0].state !== 'IN_PROGRESS') throw badRequest('ASSESSMENT_ALREADY_SUBMITTED', context.correlationId);
      return { attempt: await this.renderAttempt(existing.rows[0].id), correlationId: context.correlationId };
    }

    const items = await this.db.execute(sql`
      SELECT i.question_id, i.marks, q.version, q.question_type,
             (SELECT array_agg(o.option_key ORDER BY o.option_key)
              FROM employer_assessment_question_options o WHERE o.question_id = i.question_id) AS option_keys
      FROM employer_assessment_items i
      JOIN employer_assessment_questions q ON q.id = i.question_id
      WHERE i.assessment_id = ${String(invitation.assessment_id)}::uuid
      ORDER BY i.sequence
    `) as QueryResult<Record<string, unknown>>;

    const attemptId = this.ids.uuid();
    const seed = `${attemptId}:${id}`;
    // The paper is frozen here. Order and option keys derive from the seed, so it renders
    // identically on every reload and differently for every candidate.
    const ordered = deterministicShuffle(items.rows, seed);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO employer_assessment_attempts (id, invitation_id, candidate_user_id, seed)
        VALUES (${attemptId}::uuid, ${id}::uuid, ${userId}::uuid, ${seed})
      `);
      let order = 0;
      for (const item of ordered) {
        order += 1;
        const optionKeys = (item.option_keys as string[] | null) ?? [];
        const optionMap = buildOptionMap(optionKeys, `${seed}:${String(item.question_id)}`);
        await tx.execute(sql`
          INSERT INTO employer_assessment_attempt_questions
            (id, attempt_id, question_id, display_order, question_version, marks, option_map)
          VALUES (${this.ids.uuid()}::uuid, ${attemptId}::uuid, ${String(item.question_id)}::uuid,
                  ${order}, ${Number(item.version)}, ${Number(item.marks)}, ${JSON.stringify(optionMap)}::jsonb)
        `);
      }
      await tx.execute(sql`
        UPDATE employer_assessment_invitations SET state = 'STARTED' WHERE id = ${id}::uuid AND state = 'INVITED'
      `);
    });
    return { attempt: await this.renderAttempt(attemptId), correlationId: context.correlationId };
  }

  @Post('/students/me/screening-attempts/:attemptId/answers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async answer(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(attemptId, context.correlationId);
    const input = readAnswerInput(body, context.correlationId);
    const attempt = await this.requireOwnAttempt(id, context.authorization.principal.userId, context.correlationId);
    if (attempt.state !== 'IN_PROGRESS') throw badRequest('ATTEMPT_NOT_IN_PROGRESS', context.correlationId);

    const known = await this.db.execute(sql`
      SELECT question_id FROM employer_assessment_attempt_questions
      WHERE attempt_id = ${id}::uuid AND question_id = ${input.questionId}::uuid
    `) as QueryResult<{ question_id: string }>;
    if (!known.rows.length) throw badRequest('QUESTION_NOT_IN_ATTEMPT', context.correlationId);

    // A JS array is not a text[] parameter: it has to be built as an array literal or
    // Postgres receives a stringified value and refuses it.
    const keys = input.selectedOptionKeys.length
      ? sql`ARRAY[${sql.join(input.selectedOptionKeys.map((key) => sql`${key}`), sql`, `)}]::text[]`
      : sql`'{}'::text[]`;

    // Stored in the keys the candidate saw. Translating to the real keys happens only at
    // submission, where the answer key is also read.
    await this.db.execute(sql`
      INSERT INTO employer_assessment_answers (id, attempt_id, question_id, selected_option_keys, numeric_response)
      VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${input.questionId}::uuid, ${keys}, ${input.numericResponse})
      ON CONFLICT (attempt_id, question_id) DO UPDATE
        SET selected_option_keys = EXCLUDED.selected_option_keys,
            numeric_response = EXCLUDED.numeric_response,
            answered_at = now()
    `);
    return { saved: true, correlationId: context.correlationId };
  }

  @Post('/students/me/screening-attempts/:attemptId/submit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submit(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(attemptId, context.correlationId);
    const attempt = await this.requireOwnAttempt(id, context.authorization.principal.userId, context.correlationId);
    // Idempotent: a retry over a dropped connection returns the same result rather than
    // re-grading or refusing.
    if (attempt.state === 'SUBMITTED') {
      return { result: { score: Number(attempt.score), maxScore: Number(attempt.max_score), percentage: Number(attempt.percentage) }, correlationId: context.correlationId };
    }

    const rows = await this.db.execute(sql`
      SELECT aq.question_id, aq.marks, aq.option_map, q.question_type,
             ans.selected_option_keys,
             (SELECT array_agg(o.option_key ORDER BY o.option_key)
              FROM employer_assessment_question_options o
              WHERE o.question_id = aq.question_id AND o.is_correct) AS correct_keys
      FROM employer_assessment_attempt_questions aq
      JOIN employer_assessment_questions q ON q.id = aq.question_id
      LEFT JOIN employer_assessment_answers ans ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
      WHERE aq.attempt_id = ${id}::uuid
      ORDER BY aq.display_order
    `) as QueryResult<Record<string, unknown>>;

    const graded = rows.rows.map((row) => {
      const optionMap = (row.option_map ?? {}) as Record<string, string>;
      const displayed = { selectedOptionKeys: (row.selected_option_keys as string[] | null) ?? [] };
      const response = mapDisplayedResponse(row.question_type as QuestionType, displayed, optionMap);
      const outcome = gradeObjectiveAnswer({
        questionType: row.question_type as QuestionType,
        answerKey: { correctOptionKeys: (row.correct_keys as string[] | null) ?? [] },
        marks: Number(row.marks),
      }, response);
      return { ...outcome, marks: Number(row.marks), questionId: String(row.question_id) };
    });
    const summary = summarizeAttempt(graded);

    await this.db.transaction(async (tx) => {
      for (const entry of graded) {
        await tx.execute(sql`
          UPDATE employer_assessment_answers
          SET is_correct = ${entry.isCorrect}, marks_awarded = ${entry.marksAwarded}
          WHERE attempt_id = ${id}::uuid AND question_id = ${entry.questionId}::uuid
        `);
      }
      await tx.execute(sql`
        UPDATE employer_assessment_attempts
        SET state = 'SUBMITTED', submitted_at = now(),
            score = ${summary.score}, max_score = ${summary.maxScore}, percentage = ${summary.percentage}
        WHERE id = ${id}::uuid AND state = 'IN_PROGRESS'
      `);
      await tx.execute(sql`
        UPDATE employer_assessment_invitations SET state = 'SUBMITTED'
        WHERE id = (SELECT invitation_id FROM employer_assessment_attempts WHERE id = ${id}::uuid)
      `);
    });
    // Nothing is written to evidence, mastery or readiness here, and nothing moves the
    // application's state. A person decides what a score means.
    return { result: { score: summary.score, maxScore: summary.maxScore, percentage: summary.percentage }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------

  /** The paper as the candidate sees it: no answer keys, no marks-awarded, no correctness. */
  private async renderAttempt(attemptId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.execute(sql`
      SELECT aq.question_id, aq.display_order, aq.marks, aq.option_map, q.question_text, q.question_type,
             ans.selected_option_keys
      FROM employer_assessment_attempt_questions aq
      JOIN employer_assessment_questions q ON q.id = aq.question_id
      LEFT JOIN employer_assessment_answers ans ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
      WHERE aq.attempt_id = ${attemptId}::uuid
      ORDER BY aq.display_order
    `) as QueryResult<Record<string, unknown>>;

    const questions = await Promise.all(rows.rows.map(async (row) => {
      const optionMap = (row.option_map ?? {}) as Record<string, string>;
      const options = await this.db.execute(sql`
        SELECT option_key, option_text FROM employer_assessment_question_options
        WHERE question_id = ${String(row.question_id)}::uuid
      `) as QueryResult<{ option_key: string; option_text: string }>;
      const byKey = new Map(options.rows.map((option) => [option.option_key, option.option_text]));
      return {
        questionId: row.question_id,
        displayOrder: Number(row.display_order),
        questionText: row.question_text,
        questionType: row.question_type,
        marks: Number(row.marks),
        // Presented in the candidate's own key order; the map back to real keys stays here.
        options: Object.entries(optionMap).map(([displayKey, storedKey]) => ({
          key: displayKey, text: byKey.get(storedKey) ?? '',
        })).sort((left, right) => left.key.localeCompare(right.key)),
        selectedOptionKeys: (row.selected_option_keys as string[] | null) ?? [],
      };
    }));
    return { id: attemptId, questions };
  }

  private async requireOwnAttempt(attemptId: string, userId: string, correlationId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.execute(sql`
      SELECT t.id, t.state, t.score, t.max_score, t.percentage
      FROM employer_assessment_attempts t
      WHERE t.id = ${attemptId}::uuid AND t.candidate_user_id = ${userId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [attempt] = rows.rows;
    if (!attempt) throw forbidden(correlationId);
    return attempt;
  }

  private requireEmployer(request: ProtectedHttpRequest, employerId: string): ReturnType<typeof requireTrustedAuthorization> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(employerId, context.correlationId);
    const permitted = context.authorization.memberships.some((membership) => (
      membership.organizationId === id
      && membership.scope.organizationId === id
      && membership.scope.employerId === id
      && membership.state === 'ACTIVE'
      && (assessmentRoles as readonly string[]).includes(membership.role)
    ));
    if (!permitted) throw forbidden(context.correlationId);
    return context;
  }
}

// ---------------------------------------------------------------------------

interface QuestionInput {
  readonly questionText: string;
  readonly questionType: QuestionType;
  readonly difficulty: string;
  readonly marks: number;
  readonly options: readonly { key: string; text: string; isCorrect: boolean }[];
}

function readQuestionInput(body: unknown, correlationId: string): QuestionInput {
  const raw = readObject(body, correlationId);
  const questionText = readText(raw.questionText, 4000, correlationId);
  const questionType = raw.questionType;
  if (typeof questionType !== 'string' || !(employerQuestionTypes as readonly string[]).includes(questionType)) {
    throw badRequest('INVALID_QUESTIONTYPE', correlationId);
  }
  const difficulty = typeof raw.difficulty === 'string' && ['EASY', 'MEDIUM', 'HARD'].includes(raw.difficulty) ? raw.difficulty : 'MEDIUM';
  const marks = Number(raw.marks ?? 1);
  if (!Number.isFinite(marks) || marks <= 0 || marks > 100) throw badRequest('INVALID_MARKS', correlationId);
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 10) throw badRequest('INVALID_OPTIONS', correlationId);
  const options = raw.options.map((option) => {
    const entry = readObject(option, correlationId);
    return {
      key: readText(entry.key, 8, correlationId),
      text: readText(entry.text, 2000, correlationId),
      isCorrect: entry.isCorrect === true,
    };
  });
  if (new Set(options.map((option) => option.key)).size !== options.length) throw badRequest('INVALID_OPTIONS', correlationId);
  return { questionText, questionType: questionType as QuestionType, difficulty, marks, options };
}

function readAssessmentInput(body: unknown, correlationId: string): {
  readonly title: string; readonly durationSeconds: number;
  readonly opportunityId: string | null; readonly questionIds: readonly string[];
} {
  const raw = readObject(body, correlationId);
  const title = readText(raw.title, 200, correlationId);
  const durationSeconds = Number(raw.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 300 || durationSeconds > 14400) throw badRequest('INVALID_DURATIONSECONDS', correlationId);
  const opportunityId = raw.opportunityId == null ? null : requireUuid(String(raw.opportunityId), correlationId);
  if (!Array.isArray(raw.questionIds) || raw.questionIds.length < 1 || raw.questionIds.length > 200) throw badRequest('INVALID_QUESTIONIDS', correlationId);
  const questionIds = raw.questionIds.map((id) => requireUuid(String(id), correlationId));
  if (new Set(questionIds).size !== questionIds.length) throw badRequest('INVALID_QUESTIONIDS', correlationId);
  return { title, durationSeconds, opportunityId, questionIds };
}

function readInvitationInput(body: unknown, correlationId: string): { readonly applicationIds: readonly string[]; readonly closesAt: string } {
  const raw = readObject(body, correlationId);
  if (!Array.isArray(raw.applicationIds) || raw.applicationIds.length < 1 || raw.applicationIds.length > 500) throw badRequest('INVALID_APPLICATIONIDS', correlationId);
  const applicationIds = raw.applicationIds.map((id) => requireUuid(String(id), correlationId));
  if (new Set(applicationIds).size !== applicationIds.length) throw badRequest('INVALID_APPLICATIONIDS', correlationId);
  const closesAt = new Date(String(raw.closesAt));
  if (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= Date.now()) throw badRequest('INVALID_CLOSESAT', correlationId);
  return { applicationIds, closesAt: closesAt.toISOString() };
}

function readAnswerInput(body: unknown, correlationId: string): {
  readonly questionId: string; readonly selectedOptionKeys: readonly string[]; readonly numericResponse: number | null;
} {
  const raw = readObject(body, correlationId);
  const questionId = requireUuid(String(raw.questionId ?? ''), correlationId);
  const selected = Array.isArray(raw.selectedOptionKeys) ? raw.selectedOptionKeys.map((key) => String(key).slice(0, 8)) : [];
  if (selected.length > 10) throw badRequest('INVALID_SELECTEDOPTIONKEYS', correlationId);
  const numericResponse = raw.numericResponse == null ? null : Number(raw.numericResponse);
  if (numericResponse !== null && !Number.isFinite(numericResponse)) throw badRequest('INVALID_NUMERICRESPONSE', correlationId);
  return { questionId, selectedOptionKeys: selected, numericResponse };
}

function readObject(value: unknown, correlationId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('INVALID_BODY', correlationId);
  return value as Record<string, unknown>;
}

function readText(value: unknown, max: number, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest('INVALID_BODY', correlationId);
  const trimmed = value.trim();
  // A leading formula character would execute if the text ever reached a spreadsheet.
  if (!trimmed || trimmed.length > max || /^[=+@-]/.test(trimmed)) throw badRequest('INVALID_BODY', correlationId);
  return trimmed;
}

function readEnum<T extends readonly string[]>(body: unknown, field: string, allowed: T, correlationId: string): T[number] {
  const raw = readObject(body, correlationId);
  const value = raw[field];
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_ID', correlationId);
  return value;
}

function safeError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safeError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

/** Domain rule failures surface their code, never the internal message. */
function ruleFailure(error: unknown, correlationId: string): Error {
  return error instanceof AssessmentRuleError
    ? badRequest('ASSESSMENT_RULE_VIOLATION', correlationId)
    : badRequest('INVALID_BODY', correlationId);
}
