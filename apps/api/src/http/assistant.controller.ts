import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
/**
 * The minimal streaming surface this controller needs from the underlying
 * Express response; typed locally so the api package needs no express types.
 */
interface StreamableResponse {
  status(code: number): StreamableResponse;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): void;
  end(): void;
  json(body: unknown): void;
}
import {
  AssistantRateLimitedError,
  AssistantService,
  AssistantUnconfiguredError,
  type AssistantChatMessage,
} from '../assistant/assistant.service.js';
import type { AssistantPersona } from '../assistant/help-articles.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { aiAssistantSwitchAllows } from '@planthepath/persistence/src/ai-operations.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

const PERSONAS: readonly AssistantPersona[] = ['student', 'institution', 'employer'];
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2000;

function assistantError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId;
  if (!userId || !correlationId) throw new ForbiddenException(assistantError('FORBIDDEN', correlationId ?? 'unknown'));
  return { userId, correlationId };
}

function parseChatBody(body: unknown, correlationId: string): { persona: AssistantPersona; messages: AssistantChatMessage[] } {
  const raw = body as { persona?: unknown; messages?: unknown } | null;
  const persona = raw?.persona;
  if (typeof persona !== 'string' || !PERSONAS.includes(persona as AssistantPersona)) {
    throw new BadRequestException(assistantError('ASSISTANT_INVALID_PERSONA', correlationId));
  }
  if (!Array.isArray(raw?.messages) || raw.messages.length === 0 || raw.messages.length > MAX_MESSAGES) {
    throw new BadRequestException(assistantError('ASSISTANT_INVALID_MESSAGES', correlationId));
  }
  const messages: AssistantChatMessage[] = [];
  for (const entry of raw.messages as unknown[]) {
    const candidate = entry as { role?: unknown; content?: unknown };
    if ((candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string'
      || candidate.content.trim().length === 0 || candidate.content.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(assistantError('ASSISTANT_INVALID_MESSAGES', correlationId));
    }
    messages.push({ role: candidate.role, content: candidate.content });
  }
  if (messages[messages.length - 1]?.role !== 'user') {
    throw new BadRequestException(assistantError('ASSISTANT_INVALID_MESSAGES', correlationId));
  }
  return { persona: persona as AssistantPersona, messages };
}

@Controller('/api/v1/assistant')
export class AssistantController {
  private readonly logger = new Logger('assistant');
  private readonly service = new AssistantService();

  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /**
   * OPS-12: the console switches (flag ai.assistant, default off, and the global AI kill switch),
   * read on every request so switching off needs no restart. Fail closed: an unreadable switch is off.
   */
  private async consoleAllows(): Promise<boolean> {
    try {
      return await aiAssistantSwitchAllows(this.db);
    } catch {
      return false;
    }
  }

  @Post('/chat')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async chat(@Req() request: ProtectedHttpRequest, @Body() body: unknown, @Res() response: StreamableResponse): Promise<void> {
    const { userId, correlationId } = requireContext(request);
    const { persona, messages } = parseChatBody(body, correlationId);
    // Off unless the server switch (ASSISTANT_ENABLED), a key, and the console switches all allow it.
    if (!this.service.configured || !(await this.consoleAllows())) {
      throw new ServiceUnavailableException(assistantError('ASSISTANT_UNCONFIGURED', correlationId));
    }
    try {
      this.service.consumeAllowance(userId);
    } catch (error) {
      if (error instanceof AssistantRateLimitedError) {
        response.status(429).json(assistantError('ASSISTANT_RATE_LIMITED', correlationId));
        return;
      }
      throw error;
    }

    response.status(200);
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.flushHeaders();
    try {
      const answer = await this.service.streamChat({
        persona,
        messages,
        onDelta: (text) => response.write(text),
      });
      // Q&A pairs are logged (content only, no personal profile data is sent to
      // the model) so weak answers can improve the article corpus. The widget
      // discloses this to the user.
      this.logger.log({ event: 'assistant.answered', persona, correlationId, question: messages[messages.length - 1]?.content.slice(0, 300), answerLength: answer.length });
    } catch (error) {
      if (error instanceof AssistantUnconfiguredError) {
        response.write('The assistant is not configured on this server yet.');
      } else {
        this.logger.warn({ event: 'assistant.failed', correlationId, reason: error instanceof Error ? error.message : 'unknown' });
        response.write('\n\nSorry — I could not finish that answer. Please try again in a moment.');
      }
    } finally {
      response.end();
    }
  }

  @Post('/feedback')
  @HttpCode(204)
  @UseGuards(ProtectedApiAuthenticationGuard)
  feedback(@Req() request: ProtectedHttpRequest, @Body() body: unknown): void {
    const { correlationId } = requireContext(request);
    const raw = body as { helpful?: unknown; question?: unknown; answer?: unknown } | null;
    if (typeof raw?.helpful !== 'boolean' || typeof raw?.question !== 'string' || typeof raw?.answer !== 'string'
      || raw.question.length > MAX_MESSAGE_LENGTH || raw.answer.length > 8000) {
      throw new BadRequestException(assistantError('ASSISTANT_INVALID_FEEDBACK', correlationId));
    }
    this.logger.log({ event: 'assistant.feedback', helpful: raw.helpful, correlationId, question: raw.question.slice(0, 300) });
  }
}
