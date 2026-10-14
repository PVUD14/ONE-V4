/**
 * "Ask ONE to explain" — the student's routes (ADR-052): whether it is available, ask (202), read one's own
 * requests, and report a mistake. The subject is always the signed-in principal, so there is no identifier
 * to tamper with; another person's request is simply not found.
 *
 * Why it exists: the web screen and the Android screen show the same thing from one contract. This
 * controller never calls a model and imports nothing that can (CLAUDE.md; inference-boundary.spec.ts): a
 * request with no cached lesson leaves an outbox job, and the screen polls GET /requests/:id. While the
 * feature is off (its switch, or the global kill switch) every route but /status answers 404 with a plain
 * sentence, and /status says OFF so the screen shows its empty state. Errors carry a code, a plain sentence
 * and the correlation id — never the model's text, a guard finding or anything internal.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ExplainError,
  explainAvailability,
  explainFeatureOn,
  listExplainRequests,
  loadExplainRequest,
  reportExplainLesson,
  requestExplanation,
  type ExplainAvailability,
  type ExplainErrorCode,
  type ExplainRequestView,
} from '@planthepath/persistence/src/explain-topic.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain sentences for every refusal a student can meet. */
export const EXPLAIN_ERROR_MESSAGES: Readonly<Partial<Record<ExplainErrorCode, string>>> = {
  EXPLAIN_NOT_AVAILABLE: 'Ask ONE to explain is not available yet.',
  TOPIC_LENGTH: 'Write the topic in 3 to 120 characters.',
  TOPIC_NOT_ENGLISH: 'Ask ONE to explain works in English for now. Write the topic in English.',
  TOPIC_PERSONAL_DATA: 'Leave out personal details such as phone numbers, e-mail addresses or ID numbers.',
  TOPIC_LINK: 'Write the topic itself, not a link.',
  EXPLAIN_PREPARING: 'Your last lesson is still being prepared. Ask again when it is ready.',
  EXPLAIN_DAILY_LIMIT: 'You have asked for 10 lessons today. You can ask again tomorrow.',
  EXPLAIN_BUSY: 'ONE has prepared as many new lessons as it can today. Try again tomorrow.',
  EXPLAIN_REQUEST_NOT_FOUND: 'That lesson could not be found.',
  EXPLAIN_NOT_REPORTABLE: 'Only a lesson you can read can be reported.',
  EXPLAIN_ALREADY_REPORTED: 'You have already reported this lesson. Thank you.',
  REPORT_REASON_INVALID: 'Choose what is wrong with the lesson.',
  NOTE_LENGTH: 'Keep the note to 300 characters.',
  NOTE_PERSONAL_DATA: 'Leave personal details out of the note.',
};

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId;
  if (!userId || !correlationId) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied', correlationId: correlationId ?? 'unknown' } });
  return { userId, correlationId };
}

function errorBody(code: string, correlationId: string): Record<string, unknown> {
  return { error: { code, message: EXPLAIN_ERROR_MESSAGES[code as ExplainErrorCode] ?? 'Request could not be processed', correlationId } };
}

function readBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException(errorBody('INVALID_REQUEST', correlationId));
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new BadRequestException(errorBody('INVALID_REQUEST', correlationId));
  return record;
}

const notFound: readonly string[] = ['EXPLAIN_NOT_AVAILABLE', 'EXPLAIN_REQUEST_NOT_FOUND'];
const tooMany: readonly string[] = ['EXPLAIN_DAILY_LIMIT', 'EXPLAIN_BUSY'];
const conflicts: readonly string[] = ['EXPLAIN_PREPARING', 'EXPLAIN_NOT_REPORTABLE', 'EXPLAIN_ALREADY_REPORTED'];

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ExplainError) {
    if (notFound.includes(error.code)) return new NotFoundException(errorBody(error.code, correlationId));
    if (tooMany.includes(error.code)) return new HttpException(errorBody(error.code, correlationId), HttpStatus.TOO_MANY_REQUESTS);
    if (conflicts.includes(error.code)) return new HttpException(errorBody(error.code, correlationId), HttpStatus.CONFLICT);
    return new BadRequestException(errorBody(error.code, correlationId));
  }
  // Never forward database or driver text.
  return new BadRequestException(errorBody('INVALID_REQUEST', correlationId));
}

@Controller('/api/v1/learning/explain')
export class ExplainTopicController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Whether the student may ask now. OFF means the screen shows its empty state and nothing else. */
  @Get('/status')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async status(@Req() request: ProtectedHttpRequest): Promise<{ availability: ExplainAvailability; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    return { availability: await explainAvailability(this.db, userId), correlationId };
  }

  /**
   * Ask ONE to explain a topic. A cached lesson answers at once; otherwise this records the request and its
   * outbox job and returns (202) with the lesson being prepared. No model call here.
   */
  @Post('/')
  @HttpCode(202)
  @UseGuards(ProtectedApiAuthenticationGuard)
  async ask(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<{ request: ExplainRequestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    const { topic } = readBody(body, ['topic'], correlationId);
    try {
      return { request: await requestExplanation(this.db, { subjectUserId: userId, topic, correlationId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Get('/requests')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<{ requests: readonly ExplainRequestView[]; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    await this.requireOn(correlationId);
    return { requests: await listExplainRequests(this.db, userId), correlationId };
  }

  /** One of the student's own requests; the screen polls this while the lesson is being prepared. */
  @Get('/requests/:requestId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string): Promise<{ request: ExplainRequestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(requestId)) throw new NotFoundException(errorBody('EXPLAIN_REQUEST_NOT_FOUND', correlationId));
    await this.requireOn(correlationId);
    const view = await loadExplainRequest(this.db, userId, requestId);
    if (!view) throw new NotFoundException(errorBody('EXPLAIN_REQUEST_NOT_FOUND', correlationId));
    return { request: view, correlationId };
  }

  /** Report a mistake: a reason and an optional short note without personal details. */
  @Post('/requests/:requestId/report')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async report(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string, @Body() body: unknown): Promise<{ request: ExplainRequestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(requestId)) throw new NotFoundException(errorBody('EXPLAIN_REQUEST_NOT_FOUND', correlationId));
    const { reasonCode, note } = readBody(body, ['reasonCode', 'note'], correlationId);
    try {
      await this.requireOn(correlationId);
      return { request: await reportExplainLesson(this.db, { subjectUserId: userId, requestId, reasonCode, note, correlationId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  private async requireOn(correlationId: string): Promise<void> {
    if (!(await explainFeatureOn(this.db)).on) throw new NotFoundException(errorBody('EXPLAIN_NOT_AVAILABLE', correlationId));
  }
}
