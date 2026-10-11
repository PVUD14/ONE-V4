/**
 * The code sandbox routes (ENG-12): a student sends a Python program for a code task, and reads how its
 * run ended — for the signed-in student's own submissions only.
 *
 * Why it exists: ADR-034 §6 runs untrusted code on an isolated VM, reached only through the outbox. So
 * POST only queues (202 with the submission id) and never touches the sandbox; the outbox worker runs
 * the program and the client polls GET. The subject is always the authenticated principal, so there is
 * no identifier to tamper with; another student's submission answers 404, the same as a missing one.
 * Responses carry status, verdict, counts, per-case outcome codes and a plain sentence — never the test
 * cases, the program's output, the sandbox's text or a stack trace.
 *
 * No screen uses these routes yet (code tasks arrive with code content); they are the contract the web
 * and Android screens will share.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  CodeSubmissionError,
  queueCodeSubmission,
  readCodeSubmission,
  type CodeSubmissionView,
} from '@planthepath/persistence/src/code-submissions.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a run did not produce a result, in plain words. Never anything internal. */
export const CODE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  SANDBOX_UNAVAILABLE: 'The code runner is not available right now. Your program was not run; you can send it again later.',
  SANDBOX_ERROR: 'The code runner could not run your program. You can send it again.',
  SANDBOX_REJECTED: 'The code runner could not run your program. You can send it again.',
  SWITCHED_OFF: 'The code runner was switched off before your program ran.',
  TASK_UNAVAILABLE: 'This task is no longer available.',
  EXPIRED: 'Your program waited too long and was not run. You can send it again.',
};

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId;
  if (!userId || !correlationId) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied', correlationId: correlationId ?? 'unknown' } });
  return { userId, correlationId };
}

function badRequest(correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed', correlationId } });
}

function readSubmission(body: unknown, correlationId: string): { taskId: string; source: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'taskId' && key !== 'source')) throw badRequest(correlationId);
  if (typeof record.taskId !== 'string' || !uuidPattern.test(record.taskId)) throw badRequest(correlationId);
  if (typeof record.source !== 'string') throw badRequest(correlationId);
  return { taskId: record.taskId, source: record.source };
}

function mapError(error: unknown, correlationId: string): Error {
  if (!(error instanceof CodeSubmissionError)) return error instanceof Error ? error : new Error('code submission failed');
  switch (error.code) {
    case 'INVALID_SOURCE':
      return new BadRequestException({ error: { code: 'INVALID_SOURCE', message: 'Send a program of 1 to 20,000 characters.', correlationId } });
    case 'TASK_NOT_FOUND':
      return new NotFoundException({ error: { code: 'NOT_FOUND', message: 'That task was not found.', correlationId } });
    case 'SWITCHED_OFF':
      return new ConflictException({ error: { code: 'CODE_SANDBOX_OFF', message: 'The code runner is not switched on.', correlationId } });
    case 'PENDING':
      return new ConflictException({ error: { code: 'SUBMISSION_PENDING', message: 'Your last program is still running.', correlationId } });
    case 'DAILY_LIMIT':
      return new HttpException({ error: { code: 'DAILY_LIMIT', message: 'You have sent today’s programs. Try again tomorrow.', correlationId } }, HttpStatus.TOO_MANY_REQUESTS);
    case 'CAPACITY_REACHED':
      return new HttpException({ error: { code: 'CAPACITY_REACHED', message: 'The code runner is full for today. Try again tomorrow.', correlationId } }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Controller('/api/v1/learning/code-submissions')
export class CodeSubmissionsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Queues a program for the task. 202: the outbox worker runs it on the sandbox; poll GET /:id. */
  @Post()
  @HttpCode(202)
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submit(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<{ submission: { id: string; status: 'QUEUED' }; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    const input = readSubmission(body, correlationId);
    try {
      return { submission: await queueCodeSubmission(this.db, { subjectUserId: userId, taskId: input.taskId, source: input.source, correlationId }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** The student's own submission: status, verdict, counts and case outcome codes. */
  @Get('/:submissionId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async read(
    @Req() request: ProtectedHttpRequest,
    @Param('submissionId') submissionId: string,
  ): Promise<{ submission: CodeSubmissionView & { message: string | null }; correlationId: string }> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(submissionId)) throw badRequest(correlationId);
    const submission = await readCodeSubmission(this.db, userId, submissionId);
    if (!submission) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'That submission was not found.', correlationId } });
    const message = submission.failureCode ? CODE_FAILURE_MESSAGES[submission.failureCode] ?? CODE_FAILURE_MESSAGES.SANDBOX_ERROR! : null;
    return { submission: { ...submission, message }, correlationId };
  }
}
