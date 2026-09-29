/**
 * Employer screening assessments: an employer's own question bank, a test built from it,
 * the applicants they send it to, and what came back.
 *
 * Design in docs/architecture/employer-assessment-table-design.md (0036) and, for what EMP-12
 * added, docs/architecture/employer-assessment-windows-and-notices-design.md; ADR-039 records
 * why employer tests keep their own tables.
 *
 * The domain rules come from `@planthepath/assessments` unchanged — it is pure and knows
 * nothing about who owns an assessment — so an employer test inherits the same integrity
 * properties an institution exam has: a paper frozen at start, per-candidate option order,
 * answer keys that never leave the server, and grading the client cannot influence.
 *
 * The boundaries enforced here rather than assumed:
 *
 *   A screening result never touches readiness. Nothing in this file reads or writes
 *   evidence, mastery or readiness, and no employer response carries any of it.
 *
 *   A test goes only to an applicant at the ASSESSMENT stage whose applicant-access grant is
 *   live, and every per-candidate read needs that grant at request time (EMP-SR-01). Results
 *   are listed in invitation order, never ranked by score (EMP-SR-17).
 *
 *   The window and the time limit are judged by the database's clock. An attempt's deadline is
 *   LEAST(started_at + duration, closes_at); nothing is written after it, and an attempt left
 *   open past it is graded from what was saved in time by whoever touches it next.
 *
 *   Every employer write re-reads the organisation FOR SHARE inside its transaction
 *   (EMP-SR-15), locks the row it changes, writes an audit row with the organisation and any
 *   reason code, and refuses unknown fields (EMP-SR-08). A suspended employer's tests are
 *   closed to candidates (EMP-SR-14).
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
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
import { CONTACT_VISIBLE_STATES } from '@planthepath/hiring/src/application-snapshot.js';
import { mentionsProtectedAttribute } from '@planthepath/hiring/src/opportunity-requirements.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { validateOutboxWriteInput } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant, assertEmployerApplicationAccess } from '@planthepath/persistence/src/employer-authentication.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerInGoodStandingSql, requireActiveEmployer, type EmployerAction } from './employer-organisation-state.js';
import { lockEmployerForWrite } from './interview-scheduling.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Employer roles that may build and send a screening test. */
const assessmentRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;

/**
 * Types this engine accepts. A screening test is machine-marked, so every type here has an
 * objective key; nothing that would need a human examiner is offered. Coding questions wait
 * for the code sandbox (none exists on the base branch), so none is offered (ADR-039).
 */
const employerQuestionTypes: readonly QuestionType[] = [
  'SINGLE_CHOICE_MCQ', 'MULTIPLE_SELECT', 'TRUE_FALSE', 'SCENARIO_MCQ', 'CODE_OUTPUT_MCQ', 'NUMERICAL_MCQ',
];

/** Fixed reason codes (Appendix 2 §5.7); no OTHER — detail belongs in the employer's own records. */
export const questionRejectReasonCodes = ['INACCURATE', 'AMBIGUOUS', 'NOT_RELEVANT_TO_ROLE', 'DUPLICATE', 'UNFAIR_OR_BIASED'] as const;
export const questionArchiveReasonCodes = ['OUTDATED', 'REPLACED', 'FLAWED', 'NO_LONGER_USED'] as const;
export const assessmentCloseReasonCodes = ['ROLE_FILLED', 'ROLE_CLOSED', 'SCREENING_COMPLETE', 'REPLACED_BY_NEW_TEST', 'CONTENT_FLAWED'] as const;

/** An invitation's window may open at most this far back (clock skew) and last at most this long. */
const windowMaxDays = 30;

const questionFields = ['questionText', 'questionType', 'difficulty', 'marks', 'options'] as const;
const optionFields = ['key', 'text', 'isCorrect'] as const;
const assessmentFields = ['title', 'durationSeconds', 'opportunityId', 'questionIds'] as const;
const invitationFields = ['applicationIds', 'opensAt', 'closesAt'] as const;
const answerFields = ['questionId', 'selectedOptionKeys', 'numericResponse'] as const;

/** The deadline of attempt `t` on invitation `v` of assessment `s`, on the database clock. */
const deadlineSql = sql`LEAST(t.started_at + make_interval(secs => s.duration_seconds), v.closes_at)`;

/**
 * "This candidate may still sit this test": the employer is verified and active, the
 * application is open, consented and still shared (live grant). Aliases: v invitation, a application.
 */
const invitationLiveSql = sql`(${employerInGoodStandingSql(sql`v.employer_id`)}
  AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL AND ${applicationHasLiveApplicantGrant('a')})`;

/** Which expired attempts and invitations a sweep may finalise. */
type SweepScope =
  | { readonly studentUserId: string }
  | { readonly invitationId: string }
  | { readonly attemptId: string }
  | { readonly employerId: string; readonly assessmentId: string }
  | { readonly employerId: string; readonly applicationId: string };

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
    const context = await this.requireEmployer(request, employerId, 'jobs.draft');
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
        // Flagged for the reviewer, never refused: see the design doc, section 6.
        mentionsProtectedAttribute: mentionsProtectedAttribute(String(row.question_text)),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/assessment-questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createQuestion(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.draft');
    const input = readQuestionInput(body, context.correlationId);
    try {
      validateObjectiveQuestion({ questionText: input.questionText, questionType: input.questionType, options: input.options });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const hash = questionHash(input.questionText);
    const id = this.ids.uuid();
    const actorId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.draft', context.correlationId);
      const duplicate = await tx.execute(sql`
        SELECT id FROM employer_assessment_questions
        WHERE employer_id = ${employerId}::uuid AND question_hash = ${hash} AND approval_status <> 'ARCHIVED'
      `) as QueryResult<{ id: string }>;
      if (duplicate.rows.length) throw badRequest('DUPLICATE_QUESTION', context.correlationId);
      await tx.execute(sql`
        INSERT INTO employer_assessment_questions
          (id, employer_id, question_text, question_type, difficulty, marks, question_hash, created_by_user_id)
        VALUES (${id}::uuid, ${employerId}::uuid, ${input.questionText}, ${input.questionType},
                ${input.difficulty}, ${input.marks}, ${hash}, ${actorId}::uuid)
      `);
      for (const option of input.options) {
        await tx.execute(sql`
          INSERT INTO employer_assessment_question_options (id, question_id, option_key, option_text, is_correct)
          VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${option.key}, ${option.text}, ${option.isCorrect})
        `);
      }
      await this.audit(tx, { actorId, action: 'employer.assessment_question.created', resourceType: 'employer_assessment_question', resourceId: id,
        employerId, correlationId: context.correlationId, context: { questionType: input.questionType, optionCount: input.options.length } });
    });
    return {
      question: { id, approvalStatus: 'DRAFT', mentionsProtectedAttribute: mentionsProtectedAttribute(input.questionText) },
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/assessment-questions/:questionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionQuestion(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('questionId') questionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.draft');
    const id = requireUuid(questionId, context.correlationId);
    const raw = readBody(body, ['toState', 'reasonCode'], context.correlationId);
    const toState = readEnum(raw, 'toState', ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'] as const, context.correlationId);
    const reasonCode = readReason(raw, toState === 'REJECTED' ? questionRejectReasonCodes : toState === 'ARCHIVED' ? questionArchiveReasonCodes : null, context.correlationId);
    const actorId = context.authorization.principal.userId;

    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.draft', context.correlationId);
      const rows = await tx.execute(sql`
        SELECT approval_status, created_by_user_id FROM employer_assessment_questions
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
        FOR UPDATE
      `) as QueryResult<{ approval_status: string; created_by_user_id: string }>;
      const [question] = rows.rows;
      if (!question) throw forbidden(context.correlationId);

      // The author does not approve their own question. A review ladder that one person can
      // walk end to end is a formality, not a review.
      if (toState === 'APPROVED' && question.created_by_user_id === actorId) {
        throw badRequest('AUTHOR_CANNOT_APPROVE_OWN_QUESTION', context.correlationId);
      }
      try {
        assertQuestionTransition(question.approval_status as QuestionStatus, toState as QuestionStatus);
      } catch (error) {
        throw ruleFailure(error, context.correlationId);
      }

      const decided = toState === 'APPROVED' || toState === 'REJECTED';
      await tx.execute(sql`
        UPDATE employer_assessment_questions
        SET approval_status = ${toState}, updated_at = now(),
            reviewed_by_user_id = ${decided ? sql`${actorId}::uuid` : sql`reviewed_by_user_id`},
            reviewed_at = ${decided ? sql`now()` : sql`reviewed_at`}
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid AND approval_status = ${question.approval_status}
      `);
      await this.audit(tx, { actorId, action: `employer.assessment_question.${toState.toLowerCase()}`, resourceType: 'employer_assessment_question',
        resourceId: id, employerId, correlationId: context.correlationId, context: { fromState: question.approval_status, toState, reasonCode } });
    });
    return { question: { id, approvalStatus: toState }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // The assessment
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listAssessments(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.draft');
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
      closeReasonCodes: assessmentCloseReasonCodes,
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createAssessment(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.draft');
    const input = readAssessmentInput(body, context.correlationId);
    const actorId = context.authorization.principal.userId;
    const id = this.ids.uuid();
    let totalMarks = 0;

    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.draft', context.correlationId);
      // Only approved questions, and only this employer's, held so none is archived while the
      // test is built. The composite foreign key would refuse a foreign question anyway; this
      // turns that into a clear error rather than a constraint violation.
      const approved = await tx.execute(sql`
        SELECT id, marks FROM employer_assessment_questions
        WHERE employer_id = ${employerId}::uuid AND approval_status = 'APPROVED'
          AND id IN (${sql.join(input.questionIds.map((questionId) => sql`${questionId}::uuid`), sql`, `)})
        FOR SHARE
      `) as QueryResult<{ id: string; marks: string }>;
      if (approved.rows.length !== input.questionIds.length) throw badRequest('QUESTIONS_NOT_APPROVED', context.correlationId);
      if (input.opportunityId) {
        const owned = await tx.execute(sql`
          SELECT 1 FROM opportunities WHERE id = ${input.opportunityId}::uuid AND employer_id = ${employerId}::uuid
        `) as QueryResult<unknown>;
        if (!owned.rows.length) throw badRequest('INVALID_OPPORTUNITYID', context.correlationId);
      }

      totalMarks = approved.rows.reduce((sum, row) => sum + Number(row.marks), 0);
      await tx.execute(sql`
        INSERT INTO employer_assessments
          (id, employer_id, opportunity_id, title, duration_seconds, total_marks, created_by_user_id)
        VALUES (${id}::uuid, ${employerId}::uuid, ${input.opportunityId}, ${input.title},
                ${input.durationSeconds}, ${totalMarks}, ${actorId}::uuid)
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
      await this.audit(tx, { actorId, action: 'employer.assessment.created', resourceType: 'employer_assessment', resourceId: id, employerId,
        correlationId: context.correlationId, context: { questionCount: input.questionIds.length, durationSeconds: input.durationSeconds, opportunityId: input.opportunityId } });
    });
    return { assessment: { id, totalMarks, lifecycleState: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/assessments/:assessmentId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publishAssessment(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string, @Body() body?: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.publish');
    const id = requireUuid(assessmentId, context.correlationId);
    readBody(body ?? {}, [], context.correlationId);
    const actorId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      // EMP-SR-15: a suspension either commits first and refuses this, or waits for it.
      await lockEmployerForWrite(tx, employerId, 'jobs.publish', context.correlationId);
      const rows = await tx.execute(sql`
        SELECT a.lifecycle_state, (SELECT count(*)::int FROM employer_assessment_items i WHERE i.assessment_id = a.id) AS item_count
        FROM employer_assessments a WHERE a.id = ${id}::uuid AND a.employer_id = ${employerId}::uuid
        FOR UPDATE OF a
      `) as QueryResult<{ lifecycle_state: string; item_count: number }>;
      const [assessment] = rows.rows;
      if (!assessment) throw forbidden(context.correlationId);
      if (assessment.lifecycle_state !== 'DRAFT') throw badRequest('ASSESSMENT_NOT_DRAFT', context.correlationId);
      // An empty test would be sent to real people and waste their time.
      if (Number(assessment.item_count) < 1) throw badRequest('ASSESSMENT_HAS_NO_QUESTIONS', context.correlationId);
      await tx.execute(sql`
        UPDATE employer_assessments SET lifecycle_state = 'PUBLISHED', published_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid AND lifecycle_state = 'DRAFT'
      `);
      await this.audit(tx, { actorId, action: 'employer.assessment.published', resourceType: 'employer_assessment', resourceId: id, employerId,
        correlationId: context.correlationId, context: { questionCount: Number(assessment.item_count) } });
    });
    return { assessment: { id, lifecycleState: 'PUBLISHED' }, correlationId: context.correlationId };
  }

  /**
   * Stop sending a published test. Invitations already sent keep their window: withdrawing a test
   * a candidate may be sitting would discard their work (0036's rule).
   */
  @Post('/employers/:employerId/assessments/:assessmentId/close')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async closeAssessment(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'jobs.publish');
    const id = requireUuid(assessmentId, context.correlationId);
    const raw = readBody(body, ['reasonCode'], context.correlationId);
    const reasonCode = readReason(raw, assessmentCloseReasonCodes, context.correlationId);
    const actorId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.publish', context.correlationId);
      const rows = await tx.execute(sql`
        SELECT lifecycle_state FROM employer_assessments WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid FOR UPDATE
      `) as QueryResult<{ lifecycle_state: string }>;
      const [assessment] = rows.rows;
      if (!assessment) throw forbidden(context.correlationId);
      if (assessment.lifecycle_state !== 'PUBLISHED') throw badRequest('ASSESSMENT_NOT_PUBLISHED', context.correlationId);
      await tx.execute(sql`
        UPDATE employer_assessments SET lifecycle_state = 'CLOSED', updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid AND lifecycle_state = 'PUBLISHED'
      `);
      await this.audit(tx, { actorId, action: 'employer.assessment.closed', resourceType: 'employer_assessment', resourceId: id, employerId,
        correlationId: context.correlationId, context: { reasonCode } });
    });
    return { assessment: { id, lifecycleState: 'CLOSED' }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Inviting applicants
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/assessments/:assessmentId/invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async invite(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'candidates');
    const id = requireUuid(assessmentId, context.correlationId);
    const input = readInvitationInput(body, context.correlationId);
    const actorId = context.authorization.principal.userId;

    const created: string[] = [];
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'candidates', context.correlationId);
      const rows = await tx.execute(sql`
        SELECT lifecycle_state, opportunity_id FROM employer_assessments
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
        FOR SHARE
      `) as QueryResult<{ lifecycle_state: string; opportunity_id: string | null }>;
      const [assessment] = rows.rows;
      if (!assessment) throw forbidden(context.correlationId);
      if (assessment.lifecycle_state !== 'PUBLISHED') throw badRequest('ASSESSMENT_NOT_PUBLISHED', context.correlationId);

      // The window, judged by the database's clock: open no earlier than five minutes ago, close
      // after it opens and after now, and last no more than 30 days.
      const opens = input.opensAt === null ? sql`now()` : sql`${input.opensAt}::timestamptz`;
      const window = await tx.execute(sql`
        SELECT (${input.closesAt}::timestamptz > GREATEST(now(), ${opens})
          AND ${opens} >= now() - interval '5 minutes'
          AND ${opens} <= now() + make_interval(days => ${windowMaxDays})
          AND ${input.closesAt}::timestamptz <= now() + make_interval(days => ${windowMaxDays})) AS valid
      `) as QueryResult<{ valid: boolean }>;
      if (window.rows[0]?.valid !== true) throw badRequest('INVALID_WINDOW', context.correlationId);

      // Open, consented applications of this employer in the ASSESSMENT stage — and, when the
      // test names a role, for that role. Held so none closes while the invitations are written.
      const eligible = await tx.execute(sql`
        SELECT a.id FROM applications a
        WHERE a.employer_id = ${employerId}::uuid
          AND a.closed_at IS NULL
          AND a.consent_revoked_at IS NULL
          AND a.state = 'ASSESSMENT'
          AND (${assessment.opportunity_id === null} OR a.opportunity_id = ${assessment.opportunity_id}::uuid)
          AND a.id IN (${sql.join(input.applicationIds.map((applicationId) => sql`${applicationId}::uuid`), sql`, `)})
        FOR SHARE OF a
      `) as QueryResult<{ id: string }>;
      if (eligible.rows.length !== input.applicationIds.length) throw badRequest('APPLICATION_NOT_INVITABLE', context.correlationId);

      // EMP-SR-01: an invitation reaches a named person, so every one of them needs a live
      // applicant-access grant now, share-locked while the invitations are written.
      try {
        await assertEmployerApplicationAccess(tx, { employerId, applicationIds: input.applicationIds, lockForMutation: true });
      } catch {
        throw forbidden(context.correlationId);
      }
      for (const applicationId of input.applicationIds) {
        const invitationId = this.ids.uuid();
        // Re-inviting the same application to the same assessment is a no-op rather than
        // an error: a recruiter selecting a list twice has not done anything wrong.
        const result = await tx.execute(sql`
          INSERT INTO employer_assessment_invitations
            (id, assessment_id, employer_id, application_id, invited_by_user_id, opens_at, closes_at)
          VALUES (${invitationId}::uuid, ${id}::uuid, ${employerId}::uuid, ${applicationId}::uuid,
                  ${actorId}::uuid, ${opens}, ${input.closesAt}::timestamptz)
          ON CONFLICT (assessment_id, application_id) DO NOTHING
          RETURNING id
        `) as QueryResult<{ id: string }>;
        if (!result.rows.length) continue;
        created.push(invitationId);
        await this.audit(tx, { actorId, action: 'employer.assessment_invitation.created', resourceType: 'employer_assessment_invitation',
          resourceId: invitationId, employerId, correlationId: context.correlationId,
          context: { assessmentId: id, applicationId, opensAt: input.opensAt, closesAt: input.closesAt } });
        await this.outbox(tx, { aggregateType: 'employer_assessment_invitation', aggregateId: invitationId, eventType: 'employer_assessment.invited',
          payload: { invitationId, applicationId, assessmentId: id }, actorId, employerId, correlationId: context.correlationId });
      }
    });
    // Nothing moves the application: a person moved it to ASSESSMENT, and a person moves it on.
    return { invited: created.length, correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/assessments/:assessmentId/results')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async results(
    @Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('assessmentId') assessmentId: string,
    @Query('limit') limitParam?: string, @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'candidates');
    const id = requireUuid(assessmentId, context.correlationId);
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    await this.finaliseExpired({ employerId, assessmentId: id });

    const rows = await this.db.execute(sql`
      SELECT v.id AS invitation_id, v.application_id, v.opens_at, v.closes_at, v.invited_at, v.invited_at::text AS invited_at_key,
             CASE WHEN v.state = 'INVITED' AND v.closes_at <= now() THEN 'EXPIRED' ELSE v.state END AS state,
             t.score, t.max_score, t.percentage, t.submitted_at,
             CASE WHEN t.submitted_at IS NULL THEN NULL WHEN t.submitted_at < ${deadlineSql} THEN 'CANDIDATE' ELSE 'TIME_LIMIT' END AS ended_by,
             a.state AS application_state, u.email AS candidate_email, isp.full_name AS candidate_name
      FROM employer_assessment_invitations v
      JOIN employer_assessments s ON s.id = v.assessment_id AND s.employer_id = v.employer_id
      JOIN applications a ON a.id = v.application_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      LEFT JOIN LATERAL (
        SELECT full_name FROM institution_student_profiles p
        WHERE p.student_user_id = a.student_user_id LIMIT 1
      ) isp ON true
      WHERE v.assessment_id = ${id}::uuid AND v.employer_id = ${employerId}::uuid
        AND a.consent_revoked_at IS NULL
        -- EMP-SR-01: a score is one person's result, so it is shown only while their
        -- applicant-access grant is live, like a revoked consent above.
        AND ${applicationHasLiveApplicantGrant('a')}
        AND (${cursor === null} OR (v.invited_at, v.id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      -- Invitation order, never score order: ONE does not rank candidates (EMP-SR-17).
      ORDER BY v.invited_at, v.id
      LIMIT ${limit + 1}
    `) as QueryResult<Record<string, unknown>>;
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.rows.length > limit && last ? encodeCursor(String(last.invited_at_key), String(last.invitation_id)) : null;
    await this.audit(this.db, { actorId: context.authorization.principal.userId, action: 'employer.assessment_results.viewed', resourceType: 'employer_assessment',
      resourceId: id, employerId, correlationId: context.correlationId, context: { rows: page.length } });
    // No readiness band, and no other employer's results. The employer sees what they
    // measured and nothing else.
    return {
      results: page.map((row) => ({
        invitationId: row.invitation_id, applicationId: row.application_id, state: row.state,
        candidateName: row.candidate_name ?? null,
        // 10.2 #9: email from SHORTLISTED onward.
        candidateEmail: CONTACT_VISIBLE_STATES.includes(String(row.application_state)) ? row.candidate_email : null,
        invitedAt: row.invited_at, opensAt: row.opens_at, closesAt: row.closes_at,
        score: row.score === null ? null : Number(row.score),
        maxScore: row.max_score === null ? null : Number(row.max_score),
        percentage: row.percentage === null ? null : Number(row.percentage),
        submittedAt: row.submitted_at ?? null,
        endedBy: row.ended_by ?? null,
      })),
      nextCursor,
      correlationId: context.correlationId,
    };
  }

  /**
   * One candidate's results on this employer's tests for this application, question by question.
   * Only while the applicant-access grant is live; audited. Nothing else about the student — no
   * readiness, no ONE or college assessment, no other employer's test.
   */
  @Get('/employers/:employerId/applications/:applicationId/assessment-results')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async candidateResults(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, 'candidates');
    const id = requireUuid(applicationId, context.correlationId);
    try {
      await assertEmployerApplicationAccess(this.db, { employerId, applicationIds: [id] });
    } catch {
      throw forbidden(context.correlationId);
    }
    await this.finaliseExpired({ employerId, applicationId: id });

    const invitations = await this.db.execute(sql`
      SELECT v.id AS invitation_id, s.id AS assessment_id, s.title, s.duration_seconds, s.total_marks, v.opens_at, v.closes_at, v.invited_at,
             CASE WHEN v.state = 'INVITED' AND v.closes_at <= now() THEN 'EXPIRED' ELSE v.state END AS state,
             t.id AS attempt_id, t.started_at, t.submitted_at, t.score, t.max_score, t.percentage,
             CASE WHEN t.submitted_at IS NULL THEN NULL WHEN t.submitted_at < ${deadlineSql} THEN 'CANDIDATE' ELSE 'TIME_LIMIT' END AS ended_by
      FROM employer_assessment_invitations v
      JOIN employer_assessments s ON s.id = v.assessment_id AND s.employer_id = v.employer_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      WHERE v.application_id = ${id}::uuid AND v.employer_id = ${employerId}::uuid
      ORDER BY v.invited_at, v.id
    `) as QueryResult<Record<string, unknown>>;

    const submittedAttempts = invitations.rows.filter((row) => row.submitted_at != null).map((row) => String(row.attempt_id));
    const breakdown = submittedAttempts.length ? await this.db.execute(sql`
      SELECT aq.attempt_id, aq.display_order, aq.marks, q.question_text, q.question_type,
             ans.marks_awarded, (ans.id IS NOT NULL AND cardinality(ans.selected_option_keys) > 0) AS answered
      FROM employer_assessment_attempt_questions aq
      JOIN employer_assessment_questions q ON q.id = aq.question_id
      LEFT JOIN employer_assessment_answers ans ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
      WHERE aq.attempt_id IN (${sql.join(submittedAttempts.map((attemptId) => sql`${attemptId}::uuid`), sql`, `)})
      ORDER BY aq.attempt_id, aq.display_order
    `) as QueryResult<Record<string, unknown>> : { rows: [] as Record<string, unknown>[] };

    await this.audit(this.db, { actorId: context.authorization.principal.userId, action: 'employer.candidate_assessment_results.viewed',
      resourceType: 'application', resourceId: id, employerId, correlationId: context.correlationId, context: { invitations: invitations.rows.length } });
    return {
      assessments: invitations.rows.map((row) => ({
        invitationId: row.invitation_id, assessmentId: row.assessment_id, title: row.title,
        durationSeconds: Number(row.duration_seconds), totalMarks: Number(row.total_marks),
        invitedAt: row.invited_at, opensAt: row.opens_at, closesAt: row.closes_at, state: row.state,
        startedAt: row.started_at ?? null, submittedAt: row.submitted_at ?? null, endedBy: row.ended_by ?? null,
        score: row.score == null ? null : Number(row.score),
        maxScore: row.max_score == null ? null : Number(row.max_score),
        percentage: row.percentage == null ? null : Number(row.percentage),
        questions: breakdown.rows.filter((question) => question.attempt_id === row.attempt_id).map((question) => ({
          displayOrder: Number(question.display_order), questionText: question.question_text, questionType: question.question_type,
          marks: Number(question.marks), marksAwarded: question.marks_awarded == null ? 0 : Number(question.marks_awarded),
          answered: question.answered === true,
        })),
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
    const userId = context.authorization.principal.userId;
    await this.finaliseExpired({ studentUserId: userId });
    const rows = await this.db.execute(sql`
      SELECT v.id, v.opens_at, v.closes_at,
             CASE WHEN v.state = 'INVITED' AND v.closes_at <= now() THEN 'EXPIRED' ELSE v.state END AS state,
             s.title, s.duration_seconds, s.total_marks,
             (SELECT count(*)::int FROM employer_assessment_items i WHERE i.assessment_id = s.id) AS question_count,
             org.legal_name AS employer_name, ov.title AS role_title,
             t.id AS attempt_id, t.state AS attempt_state, t.percentage,
             CASE WHEN t.state = 'IN_PROGRESS' THEN GREATEST(0, floor(extract(epoch FROM (${deadlineSql} - now()))))::int END AS remaining_seconds,
             (${invitationLiveSql} AND v.closes_at > now() AND (t.id IS NULL OR t.state = 'IN_PROGRESS')) AS available
      FROM employer_assessment_invitations v
      JOIN employer_assessments s ON s.id = v.assessment_id
      JOIN applications a ON a.id = v.application_id
      JOIN opportunity_versions ov ON ov.id = a.applied_version_id
      JOIN organizations org ON org.id = v.employer_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      WHERE a.student_user_id = ${userId}::uuid
      ORDER BY v.closes_at
    `) as QueryResult<Record<string, unknown>>;
    return {
      invitations: rows.rows.map((row) => ({
        id: row.id, state: row.state, opensAt: row.opens_at, closesAt: row.closes_at,
        title: row.title, durationSeconds: Number(row.duration_seconds), totalMarks: Number(row.total_marks),
        questionCount: Number(row.question_count),
        employerName: row.employer_name, roleTitle: row.role_title,
        attemptId: row.attempt_id ?? null, attemptState: row.attempt_state ?? null,
        remainingSeconds: row.remaining_seconds == null ? null : Number(row.remaining_seconds),
        available: row.available === true,
        // The candidate sees their own score once submitted. It is theirs too.
        percentage: row.percentage === null || row.percentage === undefined ? null : Number(row.percentage),
      })),
      correlationId: context.correlationId,
    };
  }

  /** What the candidate is about to be assessed on, and on what terms — read before starting. */
  @Get('/students/me/screening-assessments/:invitationId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async brief(@Req() request: ProtectedHttpRequest, @Param('invitationId') invitationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(invitationId, context.correlationId);
    const userId = context.authorization.principal.userId;
    await this.finaliseExpired({ invitationId: id });
    const rows = await this.db.execute(sql`
      SELECT v.id, v.opens_at, v.closes_at, s.id AS assessment_id, s.title, s.duration_seconds, s.total_marks,
             CASE WHEN v.state = 'INVITED' AND v.closes_at <= now() THEN 'EXPIRED' ELSE v.state END AS state,
             org.legal_name AS employer_name, ov.title AS role_title, t.state AS attempt_state,
             (${invitationLiveSql} AND v.closes_at > now() AND (t.id IS NULL OR t.state = 'IN_PROGRESS')) AS available,
             (now() < v.opens_at) AS not_open_yet,
             CASE WHEN t.id IS NOT NULL AND t.state = 'IN_PROGRESS'
                  THEN GREATEST(0, floor(extract(epoch FROM (${deadlineSql} - now())) / 60))::int
                  WHEN t.id IS NULL AND v.closes_at > now()
                  THEN GREATEST(0, floor(extract(epoch FROM LEAST(make_interval(secs => s.duration_seconds), v.closes_at - GREATEST(now(), v.opens_at))) / 60))::int
             END AS minutes_available
      FROM employer_assessment_invitations v
      JOIN employer_assessments s ON s.id = v.assessment_id
      JOIN applications a ON a.id = v.application_id
      JOIN opportunity_versions ov ON ov.id = a.applied_version_id
      JOIN organizations org ON org.id = v.employer_id
      LEFT JOIN employer_assessment_attempts t ON t.invitation_id = v.id
      WHERE v.id = ${id}::uuid AND a.student_user_id = ${userId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    const formats = await this.db.execute(sql`
      SELECT q.question_type, count(*)::int AS count
      FROM employer_assessment_items i JOIN employer_assessment_questions q ON q.id = i.question_id
      WHERE i.assessment_id = ${String(row.assessment_id)}::uuid
      GROUP BY q.question_type ORDER BY q.question_type
    `) as QueryResult<{ question_type: string; count: number }>;
    return {
      assessment: {
        id: row.id, title: row.title, employerName: row.employer_name, roleTitle: row.role_title,
        state: row.state, attemptState: row.attempt_state ?? null,
        opensAt: row.opens_at, closesAt: row.closes_at, notOpenYet: row.not_open_yet === true,
        durationSeconds: Number(row.duration_seconds), totalMarks: Number(row.total_marks),
        questionCount: formats.rows.reduce((sum, format) => sum + Number(format.count), 0),
        questionFormats: formats.rows.map((format) => ({ questionType: format.question_type, count: Number(format.count) })),
        minutesAvailableIfStartedNow: row.minutes_available == null ? null : Number(row.minutes_available),
        available: row.available === true,
        // Fixed statements the screen renders; each is true of this code, not a promise.
        rules: {
          oneSitting: true, timerRunsOnServer: true, timerPauses: false,
          cameraOrMicrophone: false, screenCapture: false, tabSwitchesRecorded: false,
          resultGoesTo: 'EMPLOYER_FOR_THIS_APPLICATION', learningEvidence: false, readinessChanged: false,
        },
      },
      correlationId: context.correlationId,
    };
  }

  @Post('/students/me/screening-assessments/:invitationId/start')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async start(@Req() request: ProtectedHttpRequest, @Param('invitationId') invitationId: string, @Body() body?: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(invitationId, context.correlationId);
    const raw = readBody(body ?? {}, ['acknowledged'], context.correlationId);
    // The candidate has read the brief and agrees to its terms; a client cannot start a test by accident.
    if (raw.acknowledged !== true) throw badRequest('ASSESSMENT_ACKNOWLEDGEMENT_REQUIRED', context.correlationId);
    const userId = context.authorization.principal.userId;
    await this.finaliseExpired({ invitationId: id });

    const attemptId = await this.db.transaction(async (tx) => {
      // The window is judged by the database's own clock on both sides. opens_at is written
      // with the database's now(), so comparing it against this process's clock makes the
      // check fail under even small skew.
      const rows = await tx.execute(sql`
        SELECT v.id, v.state, v.assessment_id, v.employer_id,
               ${invitationLiveSql} AS live,
               now() < v.opens_at AS not_open_yet,
               now() >= v.closes_at AS window_closed
        FROM employer_assessment_invitations v
        JOIN applications a ON a.id = v.application_id
        WHERE v.id = ${id}::uuid AND a.student_user_id = ${userId}::uuid
        FOR UPDATE OF v
      `) as QueryResult<Record<string, unknown>>;
      const [invitation] = rows.rows;
      if (!invitation) throw forbidden(context.correlationId);
      if (invitation.live !== true) throw unavailable(context.correlationId);

      const existing = await tx.execute(sql`
        SELECT id, state FROM employer_assessment_attempts WHERE invitation_id = ${id}::uuid
      `) as QueryResult<{ id: string; state: string }>;
      // Starting twice returns the attempt already in progress rather than a second paper.
      if (existing.rows[0]) {
        if (existing.rows[0].state !== 'IN_PROGRESS') throw badRequest('ASSESSMENT_ALREADY_SUBMITTED', context.correlationId);
        return existing.rows[0].id;
      }
      if (invitation.not_open_yet === true) throw badRequest('ASSESSMENT_NOT_OPEN_YET', context.correlationId);
      if (invitation.window_closed === true) throw badRequest('ASSESSMENT_WINDOW_CLOSED', context.correlationId);

      const items = await tx.execute(sql`
        SELECT i.question_id, i.marks, q.version, q.question_type,
               (SELECT array_agg(o.option_key ORDER BY o.option_key)
                FROM employer_assessment_question_options o WHERE o.question_id = i.question_id) AS option_keys
        FROM employer_assessment_items i
        JOIN employer_assessment_questions q ON q.id = i.question_id
        WHERE i.assessment_id = ${String(invitation.assessment_id)}::uuid
        ORDER BY i.sequence
      `) as QueryResult<Record<string, unknown>>;

      const newAttemptId = this.ids.uuid();
      const seed = `${newAttemptId}:${id}`;
      // The paper is frozen here. Order and option keys derive from the seed, so it renders
      // identically on every reload and differently for every candidate.
      const ordered = deterministicShuffle(items.rows, seed);
      await tx.execute(sql`
        INSERT INTO employer_assessment_attempts (id, invitation_id, candidate_user_id, seed)
        VALUES (${newAttemptId}::uuid, ${id}::uuid, ${userId}::uuid, ${seed})
      `);
      let order = 0;
      for (const item of ordered) {
        order += 1;
        const optionKeys = (item.option_keys as string[] | null) ?? [];
        const optionMap = buildOptionMap(optionKeys, `${seed}:${String(item.question_id)}`);
        await tx.execute(sql`
          INSERT INTO employer_assessment_attempt_questions
            (id, attempt_id, question_id, display_order, question_version, marks, option_map)
          VALUES (${this.ids.uuid()}::uuid, ${newAttemptId}::uuid, ${String(item.question_id)}::uuid,
                  ${order}, ${Number(item.version)}, ${Number(item.marks)}, ${JSON.stringify(optionMap)}::jsonb)
        `);
      }
      await tx.execute(sql`
        UPDATE employer_assessment_invitations SET state = 'STARTED' WHERE id = ${id}::uuid AND state = 'INVITED'
      `);
      await this.audit(tx, { actorId: userId, action: 'student.screening_assessment.started', resourceType: 'employer_assessment_attempt',
        resourceId: newAttemptId, employerId: String(invitation.employer_id), correlationId: context.correlationId,
        context: { invitationId: id, acknowledged: true } });
      return newAttemptId;
    });
    return { attempt: await this.renderAttempt(attemptId), correlationId: context.correlationId };
  }

  @Post('/students/me/screening-attempts/:attemptId/answers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async answer(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(attemptId, context.correlationId);
    const input = readAnswerInput(body, context.correlationId);
    const userId = context.authorization.principal.userId;

    const outcome = await this.db.transaction(async (tx) => {
      const attempt = await lockOwnAttempt(tx, id, userId, context.correlationId);
      if (attempt.live !== true) throw unavailable(context.correlationId);
      if (attempt.state !== 'IN_PROGRESS') throw badRequest('ATTEMPT_NOT_IN_PROGRESS', context.correlationId);
      if (attempt.time_over === true) {
        // Past the deadline nothing more is written; what was saved in time is graded now.
        await gradeAttempt(tx, id);
        return 'TIME_OVER' as const;
      }

      const known = await tx.execute(sql`
        SELECT option_map FROM employer_assessment_attempt_questions
        WHERE attempt_id = ${id}::uuid AND question_id = ${input.questionId}::uuid
      `) as QueryResult<{ option_map: Record<string, string> | null }>;
      if (!known.rows[0]) throw badRequest('QUESTION_NOT_IN_ATTEMPT', context.correlationId);
      const displayed = Object.keys(known.rows[0].option_map ?? {});
      if (input.selectedOptionKeys.some((key) => !displayed.includes(key))) throw badRequest('INVALID_SELECTEDOPTIONKEYS', context.correlationId);

      // A JS array is not a text[] parameter: it has to be built as an array literal or
      // Postgres receives a stringified value and refuses it.
      const keys = input.selectedOptionKeys.length
        ? sql`ARRAY[${sql.join(input.selectedOptionKeys.map((key) => sql`${key}`), sql`, `)}]::text[]`
        : sql`'{}'::text[]`;
      // Stored in the keys the candidate saw. Translating to the real keys happens only at
      // grading, where the answer key is also read.
      await tx.execute(sql`
        INSERT INTO employer_assessment_answers (id, attempt_id, question_id, selected_option_keys, numeric_response)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${input.questionId}::uuid, ${keys}, ${input.numericResponse})
        ON CONFLICT (attempt_id, question_id) DO UPDATE
          SET selected_option_keys = EXCLUDED.selected_option_keys,
              numeric_response = EXCLUDED.numeric_response,
              answered_at = now()
      `);
      return 'SAVED' as const;
    });
    if (outcome === 'TIME_OVER') throw badRequest('ATTEMPT_TIME_OVER', context.correlationId);
    return { saved: true, correlationId: context.correlationId };
  }

  @Post('/students/me/screening-attempts/:attemptId/submit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submit(@Req() request: ProtectedHttpRequest, @Param('attemptId') attemptId: string, @Body() body?: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(attemptId, context.correlationId);
    readBody(body ?? {}, [], context.correlationId);
    const userId = context.authorization.principal.userId;

    const result = await this.db.transaction(async (tx) => {
      const attempt = await lockOwnAttempt(tx, id, userId, context.correlationId);
      // Idempotent: a retry over a dropped connection returns the same result rather than
      // re-grading or refusing.
      if (attempt.state === 'SUBMITTED') {
        return { score: Number(attempt.score), maxScore: Number(attempt.max_score), percentage: Number(attempt.percentage) };
      }
      if (attempt.live !== true) throw unavailable(context.correlationId);
      if (attempt.state !== 'IN_PROGRESS') throw badRequest('ATTEMPT_NOT_IN_PROGRESS', context.correlationId);
      const summary = await gradeAttempt(tx, id);
      await this.audit(tx, { actorId: userId, action: 'student.screening_assessment.submitted', resourceType: 'employer_assessment_attempt',
        resourceId: id, employerId: String(attempt.employer_id), correlationId: context.correlationId,
        context: { endedBy: attempt.time_over === true ? 'TIME_LIMIT' : 'CANDIDATE' } });
      return summary;
    });
    // Nothing is written to evidence, mastery or readiness here, and nothing moves the
    // application's state. A person decides what a score means.
    return { result, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------

  /** The paper as the candidate sees it: no answer keys, no marks-awarded, no correctness. */
  private async renderAttempt(attemptId: string): Promise<Record<string, unknown>> {
    const attempt = await this.db.execute(sql`
      SELECT s.title, s.duration_seconds, ${deadlineSql} AS deadline,
             GREATEST(0, floor(extract(epoch FROM (${deadlineSql} - now()))))::int AS remaining_seconds
      FROM employer_assessment_attempts t
      JOIN employer_assessment_invitations v ON v.id = t.invitation_id
      JOIN employer_assessments s ON s.id = v.assessment_id
      WHERE t.id = ${attemptId}::uuid
    `) as QueryResult<Record<string, unknown>>;
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
    const [meta] = attempt.rows;
    return {
      id: attemptId,
      title: meta?.title ?? null,
      durationSeconds: meta ? Number(meta.duration_seconds) : null,
      deadline: meta?.deadline ?? null,
      remainingSeconds: meta ? Number(meta.remaining_seconds) : 0,
      questions,
    };
  }

  /**
   * Finalise, deterministically and on the database clock, every in-progress attempt in scope whose
   * deadline has passed (graded from what was saved in time, submitted_at = the deadline), and mark
   * every untouched invitation whose window has closed EXPIRED. Locks are skipped rather than waited
   * on: an attempt someone is writing to right now is finalised by that request instead.
   */
  private async finaliseExpired(scope: SweepScope): Promise<void> {
    const attemptScope: SQL = 'attemptId' in scope ? sql`t.id = ${scope.attemptId}::uuid`
      : 'invitationId' in scope ? sql`v.id = ${scope.invitationId}::uuid`
        : 'studentUserId' in scope ? sql`t.candidate_user_id = ${scope.studentUserId}::uuid`
          : 'assessmentId' in scope ? sql`v.employer_id = ${scope.employerId}::uuid AND v.assessment_id = ${scope.assessmentId}::uuid`
            : sql`v.employer_id = ${scope.employerId}::uuid AND v.application_id = ${scope.applicationId}::uuid`;
    const invitationScope: SQL = 'attemptId' in scope ? sql`false`
      : 'invitationId' in scope ? sql`v.id = ${scope.invitationId}::uuid`
        : 'studentUserId' in scope ? sql`v.application_id IN (SELECT id FROM applications WHERE student_user_id = ${scope.studentUserId}::uuid)`
          : 'assessmentId' in scope ? sql`v.employer_id = ${scope.employerId}::uuid AND v.assessment_id = ${scope.assessmentId}::uuid`
            : sql`v.employer_id = ${scope.employerId}::uuid AND v.application_id = ${scope.applicationId}::uuid`;
    await this.db.transaction(async (tx) => {
      const expired = await tx.execute(sql`
        SELECT t.id FROM employer_assessment_attempts t
        JOIN employer_assessment_invitations v ON v.id = t.invitation_id
        JOIN employer_assessments s ON s.id = v.assessment_id
        WHERE t.state = 'IN_PROGRESS' AND now() >= ${deadlineSql} AND ${attemptScope}
        FOR UPDATE OF t SKIP LOCKED
      `) as QueryResult<{ id: string }>;
      for (const row of expired.rows) await gradeAttempt(tx, row.id);
      await tx.execute(sql`
        UPDATE employer_assessment_invitations v SET state = 'EXPIRED'
        WHERE v.state = 'INVITED' AND v.closes_at <= now() AND ${invitationScope}
          AND NOT EXISTS (SELECT 1 FROM employer_assessment_attempts t WHERE t.invitation_id = v.id)
      `);
    });
  }

  private async audit(tx: Executor, input: {
    readonly actorId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
    readonly employerId: string; readonly correlationId: string; readonly context: Record<string, unknown>;
  }): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${input.actorId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
        ${input.employerId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
    `);
  }

  /** Registered events only: the payload is validated against packages/events before it is written. */
  private async outbox(tx: Executor, input: {
    readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
    readonly actorId: string; readonly employerId: string; readonly correlationId: string;
  }): Promise<void> {
    const id = this.ids.uuid();
    validateOutboxWriteInput({ id, aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, eventVersion: 1,
      payload: input.payload, actorUserId: input.actorId, organizationId: input.employerId, correlationId: input.correlationId });
    await tx.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
      VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
        ${input.actorId}::uuid, ${input.employerId}::uuid, ${input.correlationId})
    `);
  }

  /**
   * Appendix 2 §5.1: an unverified employer may build its bank and draft tests; publishing
   * and anything that touches candidates needs a verified, active organisation.
   */
  private requireEmployer(request: ProtectedHttpRequest, employerId: string, action: EmployerAction): Promise<ReturnType<typeof requireTrustedAuthorization>> {
    return requireActiveEmployer(this.db, request, employerId, action, assessmentRoles);
  }
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

/** The candidate's own attempt, locked, with whether it may still be written and whether time is up. */
async function lockOwnAttempt(tx: Executor, attemptId: string, userId: string, correlationId: string): Promise<Record<string, unknown>> {
  const rows = await tx.execute(sql`
    SELECT t.id, t.state, t.score, t.max_score, t.percentage, v.employer_id,
           ${invitationLiveSql} AS live,
           now() >= ${deadlineSql} AS time_over
    FROM employer_assessment_attempts t
    JOIN employer_assessment_invitations v ON v.id = t.invitation_id
    JOIN employer_assessments s ON s.id = v.assessment_id
    JOIN applications a ON a.id = v.application_id
    WHERE t.id = ${attemptId}::uuid AND t.candidate_user_id = ${userId}::uuid
    FOR UPDATE OF t
  `) as QueryResult<Record<string, unknown>>;
  const [attempt] = rows.rows;
  if (!attempt) throw forbidden(correlationId);
  return attempt;
}

/**
 * Grade an in-progress attempt against the real keys and close it, with submitted_at at the
 * earlier of now and its deadline. Answers are written only before the deadline, so grading
 * later gives the same result as grading at the deadline.
 */
async function gradeAttempt(tx: Executor, attemptId: string): Promise<{ score: number; maxScore: number; percentage: number }> {
  const rows = await tx.execute(sql`
    SELECT aq.question_id, aq.marks, aq.option_map, q.question_type,
           ans.selected_option_keys,
           (SELECT array_agg(o.option_key ORDER BY o.option_key)
            FROM employer_assessment_question_options o
            WHERE o.question_id = aq.question_id AND o.is_correct) AS correct_keys
    FROM employer_assessment_attempt_questions aq
    JOIN employer_assessment_questions q ON q.id = aq.question_id
    LEFT JOIN employer_assessment_answers ans ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
    WHERE aq.attempt_id = ${attemptId}::uuid
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

  for (const entry of graded) {
    await tx.execute(sql`
      UPDATE employer_assessment_answers
      SET is_correct = ${entry.isCorrect}, marks_awarded = ${entry.marksAwarded}
      WHERE attempt_id = ${attemptId}::uuid AND question_id = ${entry.questionId}::uuid
    `);
  }
  await tx.execute(sql`
    UPDATE employer_assessment_attempts t
    SET state = 'SUBMITTED',
        submitted_at = (SELECT LEAST(now(), ${deadlineSql})
                        FROM employer_assessment_invitations v JOIN employer_assessments s ON s.id = v.assessment_id
                        WHERE v.id = t.invitation_id),
        score = ${summary.score}, max_score = ${summary.maxScore}, percentage = ${summary.percentage}
    WHERE t.id = ${attemptId}::uuid AND t.state = 'IN_PROGRESS'
  `);
  await tx.execute(sql`
    UPDATE employer_assessment_invitations SET state = 'SUBMITTED'
    WHERE id = (SELECT invitation_id FROM employer_assessment_attempts WHERE id = ${attemptId}::uuid)
  `);
  return { score: summary.score, maxScore: summary.maxScore, percentage: summary.percentage };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface QuestionInput {
  readonly questionText: string;
  readonly questionType: QuestionType;
  readonly difficulty: string;
  readonly marks: number;
  readonly options: readonly { key: string; text: string; isCorrect: boolean }[];
}

function readQuestionInput(body: unknown, correlationId: string): QuestionInput {
  const raw = readBody(body, questionFields, correlationId);
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
    const entry = readBody(option, optionFields, correlationId);
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
  const raw = readBody(body, assessmentFields, correlationId);
  const title = readText(raw.title, 200, correlationId);
  const durationSeconds = Number(raw.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 300 || durationSeconds > 14400) throw badRequest('INVALID_DURATIONSECONDS', correlationId);
  const opportunityId = raw.opportunityId == null ? null : requireUuid(String(raw.opportunityId), correlationId);
  if (!Array.isArray(raw.questionIds) || raw.questionIds.length < 1 || raw.questionIds.length > 200) throw badRequest('INVALID_QUESTIONIDS', correlationId);
  const questionIds = raw.questionIds.map((id) => requireUuid(String(id), correlationId));
  if (new Set(questionIds).size !== questionIds.length) throw badRequest('INVALID_QUESTIONIDS', correlationId);
  return { title, durationSeconds, opportunityId, questionIds };
}

function readInvitationInput(body: unknown, correlationId: string): { readonly applicationIds: readonly string[]; readonly opensAt: string | null; readonly closesAt: string } {
  const raw = readBody(body, invitationFields, correlationId);
  if (!Array.isArray(raw.applicationIds) || raw.applicationIds.length < 1 || raw.applicationIds.length > 500) throw badRequest('INVALID_APPLICATIONIDS', correlationId);
  const applicationIds = raw.applicationIds.map((id) => requireUuid(String(id), correlationId));
  if (new Set(applicationIds).size !== applicationIds.length) throw badRequest('INVALID_APPLICATIONIDS', correlationId);
  // Parsed here only for shape; every comparison with "now" happens in SQL on the database clock.
  const closesAt = readInstant(raw.closesAt, 'CLOSESAT', correlationId);
  if (closesAt === null) throw badRequest('INVALID_CLOSESAT', correlationId);
  const opensAt = readInstant(raw.opensAt, 'OPENSAT', correlationId);
  return { applicationIds, opensAt, closesAt };
}

function readInstant(value: unknown, field: string, correlationId: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 40) throw badRequest(`INVALID_${field}`, correlationId);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`INVALID_${field}`, correlationId);
  return parsed.toISOString();
}

function readAnswerInput(body: unknown, correlationId: string): {
  readonly questionId: string; readonly selectedOptionKeys: readonly string[]; readonly numericResponse: number | null;
} {
  const raw = readBody(body, answerFields, correlationId);
  const questionId = requireUuid(String(raw.questionId ?? ''), correlationId);
  if (raw.selectedOptionKeys !== undefined && !Array.isArray(raw.selectedOptionKeys)) throw badRequest('INVALID_SELECTEDOPTIONKEYS', correlationId);
  const selected = Array.isArray(raw.selectedOptionKeys) ? raw.selectedOptionKeys.map((key) => String(key).slice(0, 8)) : [];
  if (selected.length > 10 || new Set(selected).size !== selected.length) throw badRequest('INVALID_SELECTEDOPTIONKEYS', correlationId);
  const numericResponse = raw.numericResponse == null ? null : Number(raw.numericResponse);
  if (numericResponse !== null && !Number.isFinite(numericResponse)) throw badRequest('INVALID_NUMERICRESPONSE', correlationId);
  return { questionId, selectedOptionKeys: selected, numericResponse };
}

/** An object body whose every key is allowed: unknown fields are refused, never ignored (§6.1). */
function readBody(value: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('INVALID_BODY', correlationId);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw badRequest('UNKNOWN_FIELD', correlationId);
  return value as Record<string, unknown>;
}

function readText(value: unknown, max: number, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest('INVALID_BODY', correlationId);
  const trimmed = value.trim();
  // A leading formula character would execute if the text ever reached a spreadsheet.
  if (!trimmed || trimmed.length > max || /^[=+@-]/.test(trimmed)) throw badRequest('INVALID_BODY', correlationId);
  return trimmed;
}

function readEnum<T extends readonly string[]>(raw: Record<string, unknown>, field: string, allowed: T, correlationId: string): T[number] {
  const value = raw[field];
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

/** A reason code from a fixed list when `allowed` is given (then required); none otherwise. */
function readReason(raw: Record<string, unknown>, allowed: readonly string[] | null, correlationId: string): string | null {
  const value = raw.reasonCode;
  if (allowed === null) {
    if (value !== undefined && value !== null) throw badRequest('INVALID_REASONCODE', correlationId);
    return null;
  }
  if (value === undefined || value === null || value === '') throw badRequest('REASON_CODE_REQUIRED', correlationId);
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('INVALID_REASONCODE', correlationId);
  return value;
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  if (!/^\d{1,3}$/.test(value)) throw badRequest('INVALID_LIMIT', correlationId);
  const limit = Number(value);
  if (limit < 1 || limit > 200) throw badRequest('INVALID_LIMIT', correlationId);
  return limit;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

function readCursor(value: string | undefined, correlationId: string): { readonly at: string; readonly id: string } | null {
  if (value === undefined || value === '') return null;
  try {
    if (value.length > 200) throw new Error('long');
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof decoded.at !== 'string' || Number.isNaN(new Date(decoded.at).getTime()) || typeof decoded.id !== 'string' || !uuidPattern.test(decoded.id)) {
      throw new Error('shape');
    }
    return { at: decoded.at, id: decoded.id };
  } catch {
    throw badRequest('INVALID_CURSOR', correlationId);
  }
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_ID', correlationId);
  return value;
}

function assessmentError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(assessmentError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(assessmentError('FORBIDDEN', correlationId));
}

/** The employer is not in good standing, or the application is closed or no longer shared. */
function unavailable(correlationId: string): ForbiddenException {
  return new ForbiddenException(assessmentError('ASSESSMENT_UNAVAILABLE', correlationId));
}

/** Domain rule failures surface their code, never the internal message. */
function ruleFailure(error: unknown, correlationId: string): Error {
  return error instanceof AssessmentRuleError
    ? badRequest('ASSESSMENT_RULE_VIOLATION', correlationId)
    : badRequest('INVALID_BODY', correlationId);
}
