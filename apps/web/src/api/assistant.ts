/**
 * ONE · API client — Stream E — Core
 *
 * The ONE Assistant streaming chat and feedback.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { bearerHeader } from '../sandbox.js';

export type AssistantPersona = 'student' | 'institution' | 'employer';

export interface AssistantMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * Streams an assistant answer, invoking onDelta for every text chunk and
 * resolving with the full answer. Non-2xx responses raise ApiRequestError so
 * the widget can distinguish "not configured" (503) and "daily cap" (429).
 */
export async function streamAssistantChat(
  token: string,
  persona: AssistantPersona,
  messages: readonly AssistantMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}/api/v1/assistant/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeader(token),
      'X-Correlation-Id': correlationId,
    },
    body: JSON.stringify({ persona, messages }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly error?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: body?.error?.correlationId ?? correlationId,
      ...(body?.error?.code ? { code: body.error.code } : {}),
    });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) {
      full += text;
      onDelta(text);
    }
  }
  return full;
}

export async function sendAssistantFeedback(token: string, helpful: boolean, question: string, answer: string): Promise<void> {
  await fetch(`${apiBaseUrl}/api/v1/assistant/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeader(token),
      'X-Correlation-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ helpful, question, answer }),
  }).catch(() => undefined);
}

// --- Notifications feed (mobile foundation) ---------------------------------
