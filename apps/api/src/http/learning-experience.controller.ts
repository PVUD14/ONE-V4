/**
 * The student learning experience routes (ENG-18): the path (skip / review / learn, due reviews, latest step),
 * the next step with its reasons, and practice on the step with the hint ladder — for the signed-in student's
 * own data only.
 *
 * Why it exists: the web Learning page and the Android Learning tab show the same experience from one contract.
 * The subject is always the authenticated principal, so there is no identifier to tamper with. Planning is
 * ENG-08's rules over stored data (no model call, safe in a request handler); consent is read on every call.
 * Responses never carry an answer key, the correct option, an explanation, a model number or a readiness
 * value; errors carry a code, a plain sentence and the correlation id, nothing internal.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  LearningStepError,
  answerStepQuestion,
  readLearningPath,
  readLearningStep,
  requestStepTutorHint,
  revealStepHint,
  startNextLearningStep,
  type LearningPathView,
  type LearningStepView,
  type StepAnswerView,
} from '@planthepath/persistence/src/learning-experience.js';
import { TutorHintRequestError } from '@planthepath/persistence/src/tutor-hints.js';
import type { TutorVisibleReason } from '@planthepath/tutoring/src/index.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId;
  if (!userId || !correlationId) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied', correlationId: correlationId ?? 'unknown' } });
  return { userId, correlationId };
}

function badRequest(correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed', correlationId } });
}

function objectBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest(correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw badRequest(correlationId);
  return record;
}

function readMinutes(body: unknown, correlationId: string): number | null {
  const { sessionMinutes } = objectBody(body, ['sessionMinutes'], correlationId);
  if (sessionMinutes === undefined || sessionMinutes === null) return null;
  if (typeof sessionMinutes !== 'number' || !Number.isInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 600) throw badRequest(correlationId);
  return sessionMinutes;
}

function readQuestion(body: unknown, correlationId: string): string {
  const { questionId } = objectBody(body, ['questionId'], correlationId);
  if (typeof questionId !== 'string' || !uuidPattern.test(questionId)) throw badRequest(correlationId);
  return questionId;
}

function readAnswer(body: unknown, correlationId: string): { questionId: string; selectedOptionId: string } {
  const { questionId, selectedOptionId } = objectBody(body, ['questionId', 'selectedOptionId'], correlationId);
  if (typeof questionId !== 'string' || !uuidPattern.test(questionId)) throw badRequest(correlationId);
  if (typeof selectedOptionId !== 'string' || selectedOptionId.length < 1 || selectedOptionId.length > 64) throw badRequest(correlationId);
  return { questionId, selectedOptionId };
}

/**
 * ENG-22: why the AI tutor cannot give a hint right now, in plain words. Never anything internal: the
 * pilot's own reasons (ENG-25: college off, no-tutor group) reach here as OFF, like AI off.
 */
const TUTOR_REFUSAL_MESSAGES: Readonly<Record<TutorVisibleReason, string>> = {
  ASSESSMENT_MODE: 'The AI tutor is not available here.',
  OFF: 'The AI tutor is not switched on.',
  NO_CONSENT: 'The AI tutor needs your agreement first.',
  LANGUAGE_NOT_SUPPORTED: 'The AI tutor does not write in your language yet. The written hints still work.',
  NO_LADDER: 'This question has no hints.',
  HINTS_USED: 'You have seen every hint for this question.',
  PENDING: 'The AI tutor is still writing your last hint.',
  DAILY_LIMIT: 'You have used today’s AI hints. The written hints still work.',
};

function mapError(error: unknown, correlationId: string): Error {
  if (error instanceof TutorHintRequestError) {
    return new ConflictException({ error: { code: `TUTOR_${error.reason}`, message: TUTOR_REFUSAL_MESSAGES[error.reason], correlationId } });
  }
  if (!(error instanceof LearningStepError)) return error instanceof Error ? error : new Error('learning step failed');
  switch (error.code) {
    case 'INVALID_INPUT':
      return badRequest(correlationId);
    case 'INVALID_OPTION':
      return new BadRequestException({ error: { code: 'INVALID_OPTION', message: 'Choose one of the options shown for this question.', correlationId } });
    case 'NOT_FOUND':
      return new NotFoundException({ error: { code: 'NOT_FOUND', message: 'That step was not found.', correlationId } });
    case 'SUPERSEDED':
      return new ConflictException({ error: { code: 'STEP_SUPERSEDED', message: 'You have a newer step. Reload to continue.', correlationId } });
    case 'NOT_CURRENT_QUESTION':
      return new ConflictException({ error: { code: 'NOT_CURRENT_QUESTION', message: 'That is not the question you are on. Reload to continue.', correlationId } });
    case 'NO_HINTS':
      return new ConflictException({ error: { code: 'NO_HINTS', message: 'This question has no hints.', correlationId } });
    case 'HINTS_EXHAUSTED':
      return new ConflictException({ error: { code: 'HINTS_EXHAUSTED', message: 'You have seen every hint for this question.', correlationId } });
  }
}

@Controller('/api/v1/learning')
export class LearningExperienceController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** The path in skip / review / learn groups, due reviews (adaptive only) and the latest step. */
  @Get('/path')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async path(@Req() request: ProtectedHttpRequest): Promise<{ path: LearningPathView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    try {
      return { path: await readLearningPath(this.db, userId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Plans and records the next step (ENG-08), opens it and serves its first practice question if one is published. */
  @Post('/next-step')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async nextStep(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<{ step: LearningStepView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    const sessionMinutes = readMinutes(body, correlationId);
    try {
      return { step: await startNextLearningStep(this.db, { subjectUserId: userId, sessionMinutes, correlationId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** One of the student's steps, as it stands. */
  @Get('/steps/:decisionId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async step(@Req() request: ProtectedHttpRequest, @Param('decisionId') decisionId: string): Promise<{ step: LearningStepView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(decisionId)) throw badRequest(correlationId);
    try {
      return { step: await readLearningStep(this.db, { subjectUserId: userId, decisionId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Shows the next hint of the question being answered; hints 3 and 4 make the answer assisted. */
  @Post('/steps/:decisionId/hints')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async hint(
    @Req() request: ProtectedHttpRequest,
    @Param('decisionId') decisionId: string,
    @Body() body: unknown,
  ): Promise<{ step: LearningStepView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(decisionId)) throw badRequest(correlationId);
    const questionId = readQuestion(body, correlationId);
    try {
      return { step: await revealStepHint(this.db, { subjectUserId: userId, decisionId, questionId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * ENG-22: asks the AI tutor for the next hint level of the question being answered. Records the request
   * and its outbox job and returns at once (202) with the level shown as pending; the outbox worker writes
   * the hint (no model call here), and the screen polls GET /steps/:decisionId. The level counts exactly
   * like "Show hint": an answer after level 3 is assisted.
   */
  @Post('/steps/:decisionId/tutor-hints')
  @HttpCode(202)
  @UseGuards(ProtectedApiAuthenticationGuard)
  async tutorHint(
    @Req() request: ProtectedHttpRequest,
    @Param('decisionId') decisionId: string,
    @Body() body: unknown,
  ): Promise<{ step: LearningStepView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(decisionId)) throw badRequest(correlationId);
    const questionId = readQuestion(body, correlationId);
    try {
      return { step: await requestStepTutorHint(this.db, { subjectUserId: userId, decisionId, questionId, correlationId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Answers the question being answered; returns right or not (never the key) and the step's next state. */
  @Post('/steps/:decisionId/answers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async answer(
    @Req() request: ProtectedHttpRequest,
    @Param('decisionId') decisionId: string,
    @Body() body: unknown,
  ): Promise<StepAnswerView & { correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(decisionId)) throw badRequest(correlationId);
    const answer = readAnswer(body, correlationId);
    try {
      return { ...(await answerStepQuestion(this.db, { subjectUserId: userId, decisionId, ...answer })), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }
}
