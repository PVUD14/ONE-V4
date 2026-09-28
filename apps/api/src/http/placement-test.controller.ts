/**
 * The placement test routes (ENG-14): read, start or resume, and answer — for the signed-in
 * student's own sittings only.
 *
 * Why it exists: the placement test's online path (packages/persistence/src/placement-tests.ts)
 * needs a door that the student learning experience (ENG-18, web and Android) will use. No client
 * calls it yet. It fails closed: without the adaptive-learning purpose, or with fewer than 25
 * published and calibrated aptitude items (the state today), it answers NOT_AVAILABLE and writes
 * nothing. Responses never carry an answer key, whether an answer was right, an item parameter or
 * the ability estimate; errors carry a code, a plain sentence and the correlation id, nothing internal.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  PlacementTestError,
  answerPlacementQuestion,
  readPlacementTest,
  startPlacementTest,
  type PlacementTestView,
} from '@planthepath/persistence/src/placement-tests.js';
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

function readAnswer(body: unknown, correlationId: string): { questionId: string; selectedOptionId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'questionId' && key !== 'selectedOptionId')) throw badRequest(correlationId);
  const { questionId, selectedOptionId } = record;
  if (typeof questionId !== 'string' || !uuidPattern.test(questionId)) throw badRequest(correlationId);
  if (typeof selectedOptionId !== 'string' || selectedOptionId.length < 1 || selectedOptionId.length > 64) throw badRequest(correlationId);
  return { questionId, selectedOptionId };
}

function mapError(error: unknown, correlationId: string): Error {
  if (!(error instanceof PlacementTestError)) return error instanceof Error ? error : new Error('placement test failed');
  switch (error.code) {
    case 'INVALID_INPUT':
      return badRequest(correlationId);
    case 'INVALID_OPTION':
      return new BadRequestException({ error: { code: 'INVALID_OPTION', message: 'Choose one of the options shown for this question.', correlationId } });
    case 'NOT_FOUND':
      return new NotFoundException({ error: { code: 'NOT_FOUND', message: 'That placement test was not found.', correlationId } });
    case 'NOT_SERVED_QUESTION':
      return new ConflictException({ error: { code: 'NOT_CURRENT_QUESTION', message: 'That is not the question you are on. Reload to continue.', correlationId } });
    case 'ALREADY_COMPLETED':
      return new ConflictException({ error: { code: 'ALREADY_COMPLETED', message: 'This placement test has already finished.', correlationId } });
  }
}

@Controller('/api/v1/learning/placement-test')
export class PlacementTestController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** The student's placement: in progress (with the current question), latest result, not started, or not available. */
  @Get('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async current(@Req() request: ProtectedHttpRequest): Promise<{ placement: PlacementTestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    try {
      return { placement: await readPlacementTest(this.db, userId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Resumes the sitting in progress, or starts one and serves the first question. */
  @Post('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async start(@Req() request: ProtectedHttpRequest): Promise<{ placement: PlacementTestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    try {
      return { placement: await startPlacementTest(this.db, { subjectUserId: userId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Answers the question currently served; returns the next question or the result. */
  @Post('/:placementTestId/answers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async answer(
    @Req() request: ProtectedHttpRequest,
    @Param('placementTestId') placementTestId: string,
    @Body() body: unknown,
  ): Promise<{ placement: PlacementTestView; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(placementTestId)) throw badRequest(correlationId);
    const answer = readAnswer(body, correlationId);
    try {
      return { placement: await answerPlacementQuestion(this.db, { subjectUserId: userId, placementTestId, ...answer }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }
}
