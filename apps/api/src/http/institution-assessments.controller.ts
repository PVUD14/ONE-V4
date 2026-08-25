import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  AssessmentRuleError,
  QUESTION_TYPES,
  ASSESSMENT_KINDS,
  assertDefinitionTransition,
  assertQuestionTransition,
  questionHash,
  validateObjectiveQuestion,
  validateSectionCounts,
  type QuestionStatus,
  type QuestionType,
  type SectionRule,
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

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Staff who may run the assessment engine for their institution. */
const assessmentStaffRoles: readonly string[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
/** Approval is a governance act, reserved for senior roles. */
const assessmentApprovalRoles: readonly string[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'];

/**
 * Institution-side assessment engine: subjects, a lifecycle-governed question
 * bank, blueprint-assembled assessment definitions, publication and student
 * assignment. Every surface is institution-scoped through memberships, and the
 * composite foreign keys in migration 0012 make cross-institution references
 * structurally impossible.
 */
@Controller('/api/v1')
export class InstitutionAssessmentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // Subjects
  // -------------------------------------------------------------------------

  @Get('/institutions/:institutionId/assessment-subjects')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listSubjects(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const rows = await this.db.execute(sql`
      SELECT s.id, s.name, s.code, s.is_active,
             (SELECT count(*) FROM exam_questions q WHERE q.subject_id = s.id AND q.approval_status = 'APPROVED' AND q.is_active) AS approved_questions
      FROM exam_subjects s
      WHERE s.institution_id = ${institutionId}::uuid
      ORDER BY lower(s.name)
    `) as QueryResult<Record<string, unknown>>;
    return {
      subjects: rows.rows.map((row) => ({
        id: row['id'], name: row['name'], code: row['code'], isActive: row['is_active'],
        approvedQuestions: Number(row['approved_questions'] ?? 0),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/assessment-subjects')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createSubject(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const name = requireText(body['name'], 1, 160, 'SUBJECT_NAME_INVALID', context.correlationId);
    const code = optionalText(body['code'], 32);
    const subjectId = this.ids.uuid();
    const created = await this.db.execute(sql`
      INSERT INTO exam_subjects (id, institution_id, name, code)
      VALUES (${subjectId}::uuid, ${institutionId}::uuid, ${name}, ${code})
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (created.rows.length !== 1) throw badRequest('SUBJECT_NAME_TAKEN', context.correlationId);
    return { subject: { id: subjectId, name, code }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Question bank
  // -------------------------------------------------------------------------

  @Get('/institutions/:institutionId/assessment-questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listQuestions(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('subjectId') subjectId?: string,
    @Query('status') status?: string,
  ): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const subjectFilter = subjectId && uuidPattern.test(subjectId) ? subjectId : null;
    const statusFilter = status && ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'].includes(status) ? status : null;
    const rows = await this.db.execute(sql`
      SELECT q.id, q.subject_id, q.question_type, q.question_text, q.difficulty, q.marks,
             q.approval_status, q.version, q.created_at, s.name AS subject_name
      FROM exam_questions q
      JOIN exam_subjects s ON s.id = q.subject_id
      WHERE q.institution_id = ${institutionId}::uuid
        AND (${subjectFilter}::uuid IS NULL OR q.subject_id = ${subjectFilter}::uuid)
        AND (${statusFilter}::text IS NULL OR q.approval_status = ${statusFilter})
      ORDER BY q.created_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return {
      questions: rows.rows.map((row) => ({
        id: row['id'], subjectId: row['subject_id'], subjectName: row['subject_name'],
        questionType: row['question_type'], questionText: row['question_text'],
        difficulty: row['difficulty'], marks: Number(row['marks']), approvalStatus: row['approval_status'],
        version: Number(row['version']), createdAt: row['created_at'],
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/assessment-questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createQuestion(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const actorId = context.authorization.principal.userId;
    const subjectId = requireUuid(String(body['subjectId'] ?? ''), context.correlationId);
    const questionType = String(body['questionType'] ?? '') as QuestionType;
    if (!QUESTION_TYPES.includes(questionType)) throw badRequest('QUESTION_TYPE_INVALID', context.correlationId);
    const questionText = requireText(body['questionText'], 1, 4000, 'QUESTION_TEXT_INVALID', context.correlationId);
    const difficulty = ['EASY', 'MEDIUM', 'HARD'].includes(String(body['difficulty'])) ? String(body['difficulty']) : 'MEDIUM';
    const marks = clampNumber(body['marks'], 0.25, 100, 1);
    const explanation = optionalText(body['explanation'], 4000);
    const options = Array.isArray(body['options']) ? (body['options'] as Record<string, unknown>[]).slice(0, 12).map((option, index) => ({
      key: String(option['key'] ?? String.fromCharCode(65 + index)).slice(0, 8),
      text: requireText(option['text'], 1, 2000, 'OPTION_TEXT_INVALID', context.correlationId),
      isCorrect: Boolean(option['isCorrect']),
      matchKey: optionalText(option['matchKey'], 64),
    })) : [];
    const acceptedAnswers = Array.isArray(body['acceptedAnswers'])
      ? (body['acceptedAnswers'] as unknown[]).map((answer) => String(answer)).filter((answer) => answer.trim().length > 0).slice(0, 20)
      : [];

    try {
      validateObjectiveQuestion({ questionText, questionType, options, acceptedAnswers });
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    const subject = await this.db.execute(sql`
      SELECT id FROM exam_subjects WHERE id = ${subjectId}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ id: string }>;
    if (subject.rows.length !== 1) throw badRequest('SUBJECT_NOT_FOUND', context.correlationId);

    const questionId = this.ids.uuid();
    const hash = questionHash(questionText);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO exam_questions
          (id, institution_id, subject_id, question_type, question_text, difficulty, marks, explanation,
           accepted_answers, case_sensitive, question_hash, approval_status, created_by_user_id)
        VALUES
          (${questionId}::uuid, ${institutionId}::uuid, ${subjectId}::uuid, ${questionType}, ${questionText},
           ${difficulty}, ${marks}, ${explanation}, ${JSON.stringify(acceptedAnswers)}::jsonb,
           ${Boolean(body['caseSensitive'])}, ${hash}, 'DRAFT', ${actorId}::uuid)
      `);
      for (const [index, option] of options.entries()) {
        await tx.execute(sql`
          INSERT INTO exam_question_options (id, question_id, option_key, option_text, is_correct, match_key, position)
          VALUES (${this.ids.uuid()}::uuid, ${questionId}::uuid, ${option.key}, ${option.text}, ${option.isCorrect}, ${option.matchKey}, ${index})
        `);
      }
      await tx.execute(sql`
        INSERT INTO exam_question_versions (id, question_id, version, snapshot, changed_by_user_id)
        VALUES (${this.ids.uuid()}::uuid, ${questionId}::uuid, 1,
                ${JSON.stringify({ questionText, questionType, difficulty, marks, options, acceptedAnswers })}::jsonb,
                ${actorId}::uuid)
      `);
    });

    const duplicates = await this.db.execute(sql`
      SELECT count(*) AS n FROM exam_questions
      WHERE institution_id = ${institutionId}::uuid AND question_hash = ${hash} AND id <> ${questionId}::uuid
    `) as QueryResult<{ n: string }>;

    return {
      question: { id: questionId, approvalStatus: 'DRAFT', duplicateSuspects: Number(duplicates.rows[0]?.n ?? 0) },
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/assessment-questions/:questionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionQuestion(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('questionId') questionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const toStatus = String(body['toStatus'] ?? '') as QuestionStatus;
    const approving = toStatus === 'APPROVED' || toStatus === 'REJECTED';
    const context = this.requireInstitutionStaff(request, institutionId, approving ? assessmentApprovalRoles : assessmentStaffRoles);
    const actorId = context.authorization.principal.userId;
    const id = requireUuid(questionId, context.correlationId);
    const note = optionalText(body['note'], 2000);

    const current = await this.db.execute(sql`
      SELECT approval_status FROM exam_questions WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ approval_status: QuestionStatus }>;
    const fromStatus = current.rows[0]?.approval_status;
    if (!fromStatus) throw badRequest('QUESTION_NOT_FOUND', context.correlationId);
    try {
      assertQuestionTransition(fromStatus, toStatus);
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE exam_questions SET approval_status = ${toStatus}, updated_at = now()
        WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid AND approval_status = ${fromStatus}
      `);
      await tx.execute(sql`
        INSERT INTO exam_question_reviews (id, question_id, reviewer_user_id, from_status, to_status, note)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${actorId}::uuid, ${fromStatus}, ${toStatus}, ${note})
      `);
    });
    return { question: { id, approvalStatus: toStatus }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Assessment definitions
  // -------------------------------------------------------------------------

  @Get('/institutions/:institutionId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listDefinitions(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const rows = await this.db.execute(sql`
      SELECT d.id, d.title, d.exam_kind, d.lifecycle_state, d.total_marks, d.duration_seconds,
             d.starts_at, d.ends_at, d.attempts_allowed, s.name AS subject_name,
             (SELECT count(*) FROM exam_assignments a WHERE a.definition_id = d.id) AS assigned_count,
             (SELECT count(*) FROM exam_attempts t WHERE t.definition_id = d.id AND t.status <> 'IN_PROGRESS') AS completed_attempts
      FROM exam_definitions d
      JOIN exam_subjects s ON s.id = d.subject_id
      WHERE d.institution_id = ${institutionId}::uuid
      ORDER BY d.created_at DESC
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    return {
      assessments: rows.rows.map((row) => ({
        id: row['id'], title: row['title'], assessmentKind: row['exam_kind'],
        lifecycleState: row['lifecycle_state'], subjectName: row['subject_name'],
        totalMarks: Number(row['total_marks']), durationSeconds: Number(row['duration_seconds']),
        startsAt: row['starts_at'], endsAt: row['ends_at'], attemptsAllowed: Number(row['attempts_allowed']),
        assignedCount: Number(row['assigned_count'] ?? 0), completedAttempts: Number(row['completed_attempts'] ?? 0),
      })),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/assessments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createDefinition(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const actorId = context.authorization.principal.userId;
    const subjectId = requireUuid(String(body['subjectId'] ?? ''), context.correlationId);
    const title = requireText(body['title'], 1, 200, 'ASSESSMENT_TITLE_INVALID', context.correlationId);
    const assessmentKind = String(body['assessmentKind'] ?? '');
    if (!ASSESSMENT_KINDS.includes(assessmentKind as never)) throw badRequest('ASSESSMENT_KIND_INVALID', context.correlationId);
    const durationSeconds = Math.round(clampNumber(body['durationSeconds'], 60, 21600, 3600));
    const attemptsAllowed = Math.round(clampNumber(body['attemptsAllowed'], 1, 10, 1));
    const startsAt = requireDate(body['startsAt'], context.correlationId);
    const endsAt = requireDate(body['endsAt'], context.correlationId);
    if (endsAt.getTime() <= startsAt.getTime()) throw badRequest('ASSESSMENT_WINDOW_INVALID', context.correlationId);
    const totalMarks = clampNumber(body['totalMarks'], 1, 1000, 0);
    const publishResultsImmediately = body['publishResultsImmediately'] !== false;
    const focusLimit = body['autoSubmitOnFocusLoss'] == null ? null : Math.round(clampNumber(body['autoSubmitOnFocusLoss'], 1, 50, 5));

    const sectionsInput = Array.isArray(body['sections']) ? body['sections'] as Record<string, unknown>[] : [];
    const sections: (SectionRule & { questionIds: string[] })[] = sectionsInput.slice(0, 10).map((section) => ({
      title: requireText(section['title'], 1, 160, 'SECTION_TITLE_INVALID', context.correlationId),
      poolSize: Math.round(Number(section['poolSize'] ?? 0)),
      displayCount: Math.round(Number(section['displayCount'] ?? 0)),
      marksPerQuestion: clampNumber(section['marksPerQuestion'], 0.25, 100, 1),
      negativeMarks: clampNumber(section['negativeMarks'], 0, 100, 0),
      questionIds: Array.isArray(section['questionIds'])
        ? (section['questionIds'] as unknown[]).map((value) => String(value)).filter((value) => uuidPattern.test(value))
        : [],
    }));

    try {
      validateSectionCounts(sections, totalMarks, sections.map((section) => section.questionIds.length));
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    // Every pooled question must be an APPROVED, active question of this
    // institution and subject; the pool row pins its version.
    const allQuestionIds = sections.flatMap((section) => section.questionIds);
    if (new Set(allQuestionIds).size !== allQuestionIds.length) throw badRequest('POOL_QUESTION_REPEATED', context.correlationId);
    const approved = await this.db.execute(sql`
      SELECT id, version FROM exam_questions
      WHERE institution_id = ${institutionId}::uuid AND subject_id = ${subjectId}::uuid
        AND approval_status = 'APPROVED' AND is_active
        AND id = ANY(${sql.raw(`ARRAY[${allQuestionIds.map((value) => `'${value}'::uuid`).join(',') || 'NULL::uuid'}]`)})
    `) as QueryResult<{ id: string; version: number }>;
    if (approved.rows.length !== allQuestionIds.length) throw badRequest('POOL_REQUIRES_APPROVED_SUBJECT_QUESTIONS', context.correlationId);
    const versionByQuestion = new Map(approved.rows.map((row) => [row.id, Number(row.version)]));

    const definitionId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO exam_definitions
          (id, institution_id, subject_id, title, exam_kind, total_marks, duration_seconds,
           starts_at, ends_at, attempts_allowed, publish_results_immediately, auto_submit_on_focus_loss, created_by_user_id)
        VALUES
          (${definitionId}::uuid, ${institutionId}::uuid, ${subjectId}::uuid, ${title}, ${assessmentKind},
           ${totalMarks}, ${durationSeconds}, ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
           ${attemptsAllowed}, ${publishResultsImmediately}, ${focusLimit}, ${actorId}::uuid)
      `);
      for (const [index, section] of sections.entries()) {
        const sectionId = this.ids.uuid();
        await tx.execute(sql`
          INSERT INTO exam_sections
            (id, institution_id, definition_id, title, pool_size, display_count, marks_per_question, negative_marks, position)
          VALUES
            (${sectionId}::uuid, ${institutionId}::uuid, ${definitionId}::uuid, ${section.title},
             ${section.poolSize}, ${section.displayCount}, ${section.marksPerQuestion}, ${section.negativeMarks ?? 0}, ${index})
        `);
        for (const questionId of section.questionIds) {
          await tx.execute(sql`
            INSERT INTO exam_section_pool (section_id, question_id, institution_id, question_version)
            VALUES (${sectionId}::uuid, ${questionId}::uuid, ${institutionId}::uuid, ${versionByQuestion.get(questionId) ?? 1})
          `);
        }
      }
    });
    return { assessment: { id: definitionId, lifecycleState: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/assessments/:definitionId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publishDefinition(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('definitionId') definitionId: string,
  ): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentApprovalRoles);
    const actorId = context.authorization.principal.userId;
    const id = requireUuid(definitionId, context.correlationId);

    const definition = await this.db.execute(sql`
      SELECT lifecycle_state, total_marks FROM exam_definitions
      WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ lifecycle_state: string; total_marks: string }>;
    const state = definition.rows[0];
    if (!state) throw badRequest('ASSESSMENT_NOT_FOUND', context.correlationId);
    try {
      assertDefinitionTransition(state.lifecycle_state as never, 'PUBLISHED');
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    // Publication re-validates the blueprint against the live bank state: a
    // question un-approved since drafting blocks publish.
    const sections = await this.db.execute(sql`
      SELECT s.id, s.title, s.pool_size, s.display_count, s.marks_per_question,
             count(p.question_id) FILTER (WHERE q.approval_status = 'APPROVED' AND q.is_active) AS approved_in_pool
      FROM exam_sections s
      LEFT JOIN exam_section_pool p ON p.section_id = s.id
      LEFT JOIN exam_questions q ON q.id = p.question_id
      WHERE s.definition_id = ${id}::uuid
      GROUP BY s.id
      ORDER BY s.position
    `) as QueryResult<Record<string, unknown>>;
    try {
      validateSectionCounts(
        sections.rows.map((row) => ({
          title: String(row['title']),
          poolSize: Number(row['pool_size']),
          displayCount: Number(row['display_count']),
          marksPerQuestion: Number(row['marks_per_question']),
        })),
        Number(state.total_marks),
        sections.rows.map((row) => Number(row['approved_in_pool'] ?? 0)),
      );
    } catch (error) {
      throw asRuleError(error, context.correlationId);
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE exam_definitions SET lifecycle_state = 'PUBLISHED', published_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid AND lifecycle_state = 'DRAFT'
      `);
      await tx.execute(sql`
        INSERT INTO exam_definition_events (id, definition_id, actor_user_id, from_state, to_state)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${actorId}::uuid, 'DRAFT', 'PUBLISHED')
      `);
    });
    return { assessment: { id, lifecycleState: 'PUBLISHED' }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/assessments/:definitionId/assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assignStudents(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('definitionId') definitionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const actorId = context.authorization.principal.userId;
    const id = requireUuid(definitionId, context.correlationId);
    const studentProfileIds = Array.isArray(body['studentProfileIds'])
      ? [...new Set((body['studentProfileIds'] as unknown[]).map((value) => String(value)).filter((value) => uuidPattern.test(value)))].slice(0, 500)
      : [];
    if (!studentProfileIds.length) throw badRequest('NO_STUDENTS_GIVEN', context.correlationId);

    const definition = await this.db.execute(sql`
      SELECT lifecycle_state FROM exam_definitions WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ lifecycle_state: string }>;
    if (definition.rows[0]?.lifecycle_state !== 'PUBLISHED') throw badRequest('ASSESSMENT_NOT_PUBLISHED', context.correlationId);

    // Roster profile ids resolve to user ids server-side; only ACTIVE
    // relationships at this institution are eligible.
    const eligible = await this.db.execute(sql`
      SELECT student_user_id FROM institution_student_profiles
      WHERE institution_id = ${institutionId}::uuid AND status = 'ACTIVE'
        AND id = ANY(${sql.raw(`ARRAY[${studentProfileIds.map((value) => `'${value}'::uuid`).join(',')}]`)})
    `) as QueryResult<{ student_user_id: string }>;
    const eligibleIds = [...new Set(eligible.rows.map((row) => row.student_user_id))];

    let assigned = 0;
    for (const studentUserId of eligibleIds) {
      const inserted = await this.db.execute(sql`
        INSERT INTO exam_assignments (id, institution_id, definition_id, student_user_id, assigned_by_user_id)
        VALUES (${this.ids.uuid()}::uuid, ${institutionId}::uuid, ${id}::uuid, ${studentUserId}::uuid, ${actorId}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as QueryResult<{ id: string }>;
      assigned += inserted.rows.length;
    }
    return {
      assignment: { assessmentId: id, requested: studentProfileIds.length, eligible: eligibleIds.length, newlyAssigned: assigned },
      correlationId: context.correlationId,
    };
  }

  /**
   * Reopens a published assessment for late or repeat attempts: extends the
   * window and/or raises the attempt allowance. Recorded as a definition event.
   */
  @Post('/institutions/:institutionId/assessments/:definitionId/reopen')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reopenDefinition(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('definitionId') definitionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentApprovalRoles);
    const actorId = context.authorization.principal.userId;
    const id = requireUuid(definitionId, context.correlationId);
    const extendMinutes = Math.round(clampNumber(body['extendMinutes'], 0, 10080, 0));
    const extraAttempts = Math.round(clampNumber(body['extraAttempts'], 0, 9, 0));
    if (extendMinutes === 0 && extraAttempts === 0) throw badRequest('NOTHING_TO_REOPEN', context.correlationId);

    const current = await this.db.execute(sql`
      SELECT lifecycle_state, attempts_allowed FROM exam_definitions
      WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ lifecycle_state: string; attempts_allowed: number }>;
    const state = current.rows[0];
    if (!state) throw badRequest('ASSESSMENT_NOT_FOUND', context.correlationId);
    if (state.lifecycle_state !== 'PUBLISHED') throw badRequest('ASSESSMENT_NOT_PUBLISHED', context.correlationId);
    const newAttempts = Math.min(10, Number(state.attempts_allowed) + extraAttempts);

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE exam_definitions
        SET ends_at = GREATEST(ends_at, now()) + make_interval(mins => ${extendMinutes}),
            attempts_allowed = ${newAttempts},
            updated_at = now()
        WHERE id = ${id}::uuid AND institution_id = ${institutionId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO exam_definition_events (id, definition_id, actor_user_id, from_state, to_state)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${actorId}::uuid, 'PUBLISHED', 'PUBLISHED')
      `);
    });
    return { assessment: { id, attemptsAllowed: newAttempts, extendedMinutes: extendMinutes }, correlationId: context.correlationId };
  }

  @Get('/institutions/:institutionId/assessments/:definitionId/results')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listResults(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('definitionId') definitionId: string,
  ): Promise<Record<string, unknown>> {
    const context = this.requireInstitutionStaff(request, institutionId, assessmentStaffRoles);
    const id = requireUuid(definitionId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT r.score, r.max_score, r.percentage, r.correct_count, r.wrong_count, r.not_attempted_count,
             r.time_taken_seconds, r.created_at, t.attempt_number, t.status, t.auto_submitted, t.screen_shift_count,
             p.full_name, p.institution_student_id
      FROM exam_results r
      JOIN exam_attempts t ON t.id = r.attempt_id
      JOIN institution_student_profiles p ON p.student_user_id = t.student_user_id AND p.institution_id = t.institution_id
      WHERE t.definition_id = ${id}::uuid AND t.institution_id = ${institutionId}::uuid
      ORDER BY r.percentage DESC, r.created_at
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    const results = rows.rows.map((row) => ({
      studentName: row['full_name'], institutionStudentId: row['institution_student_id'],
      attemptNumber: Number(row['attempt_number']), status: row['status'], autoSubmitted: row['auto_submitted'],
      screenShiftCount: Number(row['screen_shift_count']), score: Number(row['score']), maxScore: Number(row['max_score']),
      percentage: Number(row['percentage']), correct: Number(row['correct_count']), wrong: Number(row['wrong_count']),
      notAttempted: Number(row['not_attempted_count']), timeTakenSeconds: Number(row['time_taken_seconds']),
      completedAt: row['created_at'],
    }));
    const average = results.length ? Math.round(results.reduce((sum, entry) => sum + entry.percentage, 0) / results.length * 100) / 100 : 0;

    // Assigned students with no completed attempt - the "who has not taken it" view.
    const pending = await this.db.execute(sql`
      SELECT p.full_name, p.institution_student_id,
             EXISTS (SELECT 1 FROM exam_attempts t
                      WHERE t.definition_id = ${id}::uuid AND t.student_user_id = a.student_user_id AND t.status = 'IN_PROGRESS') AS in_progress
      FROM exam_assignments a
      JOIN institution_student_profiles p ON p.student_user_id = a.student_user_id AND p.institution_id = a.institution_id
      WHERE a.definition_id = ${id}::uuid AND a.institution_id = ${institutionId}::uuid
        AND NOT EXISTS (SELECT 1 FROM exam_attempts t
                         WHERE t.definition_id = ${id}::uuid AND t.student_user_id = a.student_user_id AND t.status <> 'IN_PROGRESS')
      ORDER BY p.full_name
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    const notAttempted = pending.rows.map((row) => ({
      studentName: row['full_name'], institutionStudentId: row['institution_student_id'], inProgress: Boolean(row['in_progress']),
    }));

    const assignedCount = await this.db.execute(sql`
      SELECT count(*) AS n FROM exam_assignments
      WHERE definition_id = ${id}::uuid AND institution_id = ${institutionId}::uuid
    `) as QueryResult<{ n: string }>;

    return {
      results,
      notAttempted,
      summary: {
        attempts: results.length,
        averagePercentage: average,
        assigned: Number(assignedCount.rows[0]?.n ?? 0),
        notAttemptedCount: notAttempted.length,
      },
      correlationId: context.correlationId,
    };
  }

  // -------------------------------------------------------------------------

  private requireInstitutionStaff(request: ProtectedHttpRequest, institutionId: string, roles: readonly string[]): ReturnType<typeof requireTrustedAuthorization> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    const permitted = context.authorization.memberships.some((membership) => (
      membership.organizationId === id
      && membership.scope.organizationId === id
      && membership.scope.institutionId === id
      && membership.state === 'ACTIVE'
      && roles.includes(membership.role)
    ));
    if (!permitted) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return context;
  }
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_ID', correlationId);
  return value;
}

function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length ? text.slice(0, max) : null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requireDate(value: unknown, correlationId: string): Date {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw badRequest('DATE_INVALID', correlationId);
  return date;
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(assessmentApiError(code, correlationId));
}

function asRuleError(error: unknown, correlationId: string): Error {
  if (error instanceof AssessmentRuleError) {
    return new BadRequestException({ error: { code: 'ASSESSMENT_RULE', message: error.message, correlationId } });
  }
  return error instanceof Error ? error : badRequest('INVALID_REQUEST', correlationId);
}

function assessmentApiError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}
