/**
 * ONE · API client — Stream E — Core
 *
 * The shared JSON request helper. Internal to this directory: it is deliberately
 * not re-exported from api.ts, so callers reach the API through a named function.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';

export async function requestJson<T>(path: string, input: {
  readonly token?: string; readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly body?: unknown;
  readonly idempotencyKey?: string; readonly signal?: AbortSignal;
} = {}): Promise<T> {
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Correlation-Id': correlationId };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: input.method ?? 'GET', headers, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly message?: { readonly code?: string; readonly correlationId?: string; readonly field?: string; readonly message?: string }; readonly error?: { readonly code?: string; readonly correlationId?: string; readonly field?: string; readonly message?: string } } | null;
    const safeError = body?.error ?? body?.message;
    throw new ApiRequestError({
      status: response.status,
      correlationId: safeError?.correlationId ?? response.headers?.get('x-correlation-id') ?? correlationId,
      ...(safeError?.code ? { code: safeError.code } : {}),
      ...(safeError?.field ? { field: safeError.field } : {}),
      ...(typeof safeError?.message === 'string' && safeError.message ? { detail: safeError.message } : {}),
    });
  }
  return response.json() as Promise<T>;
}

// --- Assessment engine (exam) client ----------------------------------------
