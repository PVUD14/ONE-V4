/**
 * The boundary between ONE and whatever is actually doing inference.
 *
 * Every feature is written against `InferenceProvider`, and the venue is a constructor
 * argument. ADR-047 puts inference on an OpenAI-compatible endpoint (vLLM on a RunPod pod,
 * behind a bearer key); a later move to AWS (Bedrock exposes the same chat-completions
 * shape) is configuration, not a rewrite.
 *
 * `OpenAICompatibleProvider` is the adapter ENG-20 builds: one non-streaming chat-completions
 * call with a per-attempt timeout and bounded retries. `AnthropicProvider` predates it and is
 * kept so the in-app assistant can move behind this interface rather than keep its own call
 * site. Design: docs/architecture/inference-adapter-design.md.
 *
 * The rule every error here keeps: no message carries the upstream body, its status text or
 * the key. The body can echo the prompt, which can carry student data.
 */

export interface InferenceMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface InferenceRequest {
  readonly model: string;
  readonly messages: readonly InferenceMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** Abort the call rather than let a slow model hold a worker open indefinitely. */
  readonly signal?: AbortSignal;
}

export interface InferenceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface InferenceResult {
  readonly text: string;
  readonly usage: InferenceUsage;
  /** What actually answered, which is not always what was asked for. */
  readonly model: string;
  readonly stopReason: 'END' | 'MAX_TOKENS' | 'OTHER';
  /** Wall time of the call, retries and backoff included. Absent when the provider does not measure it. */
  readonly latencyMs?: number;
  /** HTTP attempts made. */
  readonly attempts?: number;
}

/** What AI Operations is told about the endpoint. Never carries the key or an upstream body. */
export interface InferenceProbe {
  readonly reachable: boolean;
  /** Whether the configured model is listed by the endpoint; null when it could not be asked. */
  readonly modelServed: boolean | null;
  readonly failureClass: InferenceFailureClass | null;
  readonly latencyMs: number | null;
}

export interface InferenceProvider {
  /** Stable identifier recorded against every generation, e.g. `openai-compatible`. */
  readonly providerKey: string;
  complete(request: InferenceRequest): Promise<InferenceResult>;
  /** A cheap reachability check (model listing). Never throws. */
  probe?(): Promise<InferenceProbe>;
}

/**
 * ENG-24: one embedding call — several texts in, one vector each out. Used only by offline and worker
 * jobs through `AiOrchestrator.embed`, never by a request handler.
 */
export interface EmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly string[];
  readonly signal?: AbortSignal;
}

export interface EmbeddingResult {
  /** One vector per input, in input order, all of one length. */
  readonly vectors: readonly (readonly number[])[];
  /** What actually answered, as the endpoint reported it. */
  readonly model: string;
  readonly usage: InferenceUsage;
  readonly latencyMs?: number;
  readonly attempts?: number;
}

export interface EmbeddingProvider {
  readonly providerKey: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export type InferenceFailureClass =
  | 'PROVIDER_UNCONFIGURED'
  | 'PROVIDER_MODEL_MISMATCH'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'PROVIDER_CANCELLED';

/**
 * Every adapter failure. `failureClass` is what gets metered; `attempts` and `latencyMs` are
 * filled in by the adapter so a failure is accounted for as well as a success.
 */
export class InferenceProviderError extends Error {
  attempts: number | undefined;
  latencyMs: number | undefined;

  constructor(readonly failureClass: InferenceFailureClass, message: string) {
    super(message);
    this.name = 'InferenceProviderError';
  }
}

export class InferenceUnconfiguredError extends InferenceProviderError {
  constructor(detail: string) {
    super('PROVIDER_UNCONFIGURED', detail);
    this.name = 'InferenceUnconfiguredError';
  }
}

export class InferenceModelMismatchError extends InferenceProviderError {
  constructor() {
    super('PROVIDER_MODEL_MISMATCH', 'the feature names a model the inference endpoint is not configured to serve');
    this.name = 'InferenceModelMismatchError';
  }
}

export class InferenceUpstreamError extends InferenceProviderError {
  constructor(readonly status: number, detail = 'inference provider returned an error') {
    super(classifyStatus(status), detail);
    this.name = 'InferenceUpstreamError';
  }
}

export class InferenceAuthError extends InferenceUpstreamError {
  constructor(status: number) {
    super(status, 'inference provider refused the credentials');
    this.name = 'InferenceAuthError';
  }
}

export class InferenceRateLimitedError extends InferenceUpstreamError {
  constructor() {
    super(429, 'inference provider rate limited');
    this.name = 'InferenceRateLimitedError';
  }
}

export class InferenceTimeoutError extends InferenceProviderError {
  constructor() {
    super('PROVIDER_TIMEOUT', 'inference provider did not answer in time');
    this.name = 'InferenceTimeoutError';
  }
}

export class InferenceUnreachableError extends InferenceProviderError {
  constructor() {
    super('PROVIDER_UNREACHABLE', 'inference provider could not be reached');
    this.name = 'InferenceUnreachableError';
  }
}

export class InferenceMalformedResponseError extends InferenceProviderError {
  constructor() {
    super('PROVIDER_MALFORMED_RESPONSE', 'inference provider returned a response that could not be used');
    this.name = 'InferenceMalformedResponseError';
  }
}

export class InferenceCancelledError extends InferenceProviderError {
  constructor() {
    super('PROVIDER_CANCELLED', 'inference call was cancelled');
    this.name = 'InferenceCancelledError';
  }
}

function classifyStatus(status: number): InferenceFailureClass {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 404) return 'PROVIDER_NOT_FOUND';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_SERVER_ERROR';
  if (status >= 200 && status < 300) return 'PROVIDER_MALFORMED_RESPONSE';
  return 'PROVIDER_REJECTED';
}

/**
 * A provider that refuses every call, with a message that says why.
 *
 * This is what ONE runs whenever ONE_AI_BASE_URL, ONE_AI_API_KEY or ONE_AI_MODEL is blank.
 * With the flag off nothing calls inference at all; with the flag on and no endpoint the
 * failure is a clear, typed, metered refusal rather than a crash or — worse — a silent
 * fallback that puts something invented in front of a student.
 */
export class UnconfiguredInferenceProvider implements InferenceProvider {
  readonly providerKey = 'unconfigured';

  constructor(private readonly reason = 'BASE_URL_MISSING') {}

  async complete(): Promise<InferenceResult> {
    throw new InferenceUnconfiguredError(`no inference endpoint is configured (${this.reason}); set ONE_AI_BASE_URL, ONE_AI_API_KEY and ONE_AI_MODEL on the server`);
  }

  async probe(): Promise<InferenceProbe> {
    return { reachable: false, modelServed: null, failureClass: 'PROVIDER_UNCONFIGURED', latencyMs: null };
  }
}

/**
 * ENG-24: the embedding counterpart of `UnconfiguredInferenceProvider` — what ONE runs whenever
 * ONE_AI_EMBEDDING_BASE_URL, ONE_AI_EMBEDDING_API_KEY or ONE_AI_EMBEDDING_MODEL is blank. Every call is a
 * typed PROVIDER_UNCONFIGURED refusal; nothing crashes and nothing is invented.
 */
export class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly providerKey = 'unconfigured';

  constructor(private readonly reason = 'BASE_URL_MISSING') {}

  async embed(): Promise<EmbeddingResult> {
    throw new InferenceUnconfiguredError(`no embedding endpoint is configured (${this.reason}); set ONE_AI_EMBEDDING_BASE_URL, ONE_AI_EMBEDDING_API_KEY and ONE_AI_EMBEDDING_MODEL on the server`);
  }
}

interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface FetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<FetchResponseLike>;
}

export interface OpenAICompatibleOptions {
  /** The OpenAI base URL, including its version path: `https://<pod-id>-8888.proxy.runpod.net/v1`. */
  readonly baseUrl: string;
  /** Sent as a bearer token, never logged and never placed in an error. */
  readonly apiKey?: string | undefined;
  /** The model the endpoint serves. When set, a request for any other model is refused before a call. */
  readonly model?: string | undefined;
  readonly providerKey?: string;
  /** Per attempt, body read included. Default 60 s. */
  readonly timeoutMs?: number;
  /** Total attempts for a retryable answer. Default 3, at most 10. */
  readonly maxAttempts?: number;
  /** First backoff; doubles each retry. Default 500 ms. */
  readonly backoffMs?: number;
  /** For the reachability probe. Default 10 s. */
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly clock?: () => number;
}

/** The status codes that mean "try again". Everything else fails at once. */
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

/**
 * The OpenAI chat-completions shape: vLLM, TGI, Ollama, llama.cpp and Bedrock's OpenAI-compatible
 * endpoint all speak it, so changing venue is a base URL, a key and a model id.
 *
 * Not streamed: generation is a background job whose output lands as a DRAFT for a human, so
 * nobody is waiting on the first token. A timed-out attempt is not retried — the model may still
 * be generating and billing, and a retry doubles both.
 */
export class OpenAICompatibleProvider implements InferenceProvider, EmbeddingProvider {
  readonly providerKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly probeTimeoutMs: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new InferenceUnconfiguredError('inference base URL must be http(s)');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.providerKey = options.providerKey ?? 'openai-compatible';
    this.timeoutMs = bounded(options.timeoutMs, 60_000, 50, 600_000);
    this.maxAttempts = bounded(options.maxAttempts, 3, 1, 10);
    this.backoffMs = bounded(options.backoffMs, 500, 0, 60_000);
    this.probeTimeoutMs = bounded(options.probeTimeoutMs, 10_000, 50, 120_000);
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    // Before the network: a feature evaluated on one model never silently runs on another.
    if (this.options.model && request.model !== this.options.model) throw new InferenceModelMismatchError();
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0,
      stream: false,
    });
    const { value, attempts, latencyMs } = await this.exchange('/chat/completions', body, request.signal, (text) => parseCompletion(text, request.model));
    return { ...value, latencyMs, attempts };
  }

  /**
   * ENG-24: the OpenAI embeddings shape (`POST /embeddings`), with the same model guard, timeout,
   * retries and no-leak errors as `complete`. The vectors come back exactly as served; normalising
   * them is the caller's choice.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.options.model && request.model !== this.options.model) throw new InferenceModelMismatchError();
    if (request.inputs.length === 0) throw new InferenceMalformedResponseError();
    const body = JSON.stringify({ model: request.model, input: request.inputs, encoding_format: 'float' });
    const { value, attempts, latencyMs } = await this.exchange('/embeddings', body, request.signal, (text) => parseEmbeddings(text, request.inputs.length, request.model));
    return { ...value, latencyMs, attempts };
  }

  /**
   * One POST with retries: a retryable status or an unreachable endpoint is tried again with backoff
   * until `maxAttempts`; a timeout is not (the model may still be working, and billing). Every failure
   * is a typed error stamped with attempts and wall time.
   */
  private async exchange<T>(path: string, body: string, signal: AbortSignal | undefined, parse: (text: string) => T): Promise<{ value: T; attempts: number; latencyMs: number }> {
    const clock = this.options.clock ?? (() => performance.now());
    const started = clock();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const answer = await this.send('POST', path, body, this.timeoutMs, signal);
        if (!answer.ok) {
          const failure = answer.status === 401 || answer.status === 403 ? new InferenceAuthError(answer.status)
            : answer.status === 429 ? new InferenceRateLimitedError()
              : new InferenceUpstreamError(answer.status);
          if (retryableStatuses.has(answer.status) && attempts < this.maxAttempts) {
            await this.backoff(attempts, signal);
            continue;
          }
          throw failure;
        }
        return { value: parse(answer.text), attempts, latencyMs: elapsed(clock, started) };
      } catch (error) {
        const failure = error instanceof InferenceProviderError ? error : new InferenceUnreachableError();
        if (failure instanceof InferenceUnreachableError && attempts < this.maxAttempts) {
          try {
            await this.backoff(attempts, signal);
            continue;
          } catch (cancelled) {
            throw stamp(cancelled instanceof InferenceProviderError ? cancelled : new InferenceCancelledError(), attempts, elapsed(clock, started));
          }
        }
        throw stamp(failure, attempts, elapsed(clock, started));
      }
    }
  }

  async probe(): Promise<InferenceProbe> {
    const clock = this.options.clock ?? (() => performance.now());
    const started = clock();
    try {
      const answer = await this.send('GET', '/models', undefined, this.probeTimeoutMs);
      const latencyMs = elapsed(clock, started);
      if (!answer.ok) {
        return { reachable: false, modelServed: null, failureClass: new InferenceUpstreamError(answer.status).failureClass, latencyMs };
      }
      let listed: unknown;
      try { listed = JSON.parse(answer.text); } catch { listed = undefined; }
      const data = listed && typeof listed === 'object' ? (listed as { data?: unknown }).data : undefined;
      if (!Array.isArray(data)) return { reachable: true, modelServed: null, failureClass: 'PROVIDER_MALFORMED_RESPONSE', latencyMs };
      const ids = data
        .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string');
      return { reachable: true, modelServed: this.options.model ? ids.includes(this.options.model) : null, failureClass: null, latencyMs };
    } catch (error) {
      const failureClass = error instanceof InferenceProviderError ? error.failureClass : 'PROVIDER_UNREACHABLE';
      return { reachable: false, modelServed: null, failureClass, latencyMs: elapsed(clock, started) };
    }
  }

  /**
   * One HTTP exchange, body read included, under its own timeout. Throws only typed errors:
   * timeout, cancellation, or unreachable — never the underlying network error, whose message
   * can name the host and port.
   */
  private async send(method: 'GET' | 'POST', path: string, body: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; text: string }> {
    if (signal?.aborted) throw new InferenceCancelledError();
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const relay = (): void => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    try {
      const response = await fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      // The body is read even for an error so the connection is released; it is then discarded.
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    } catch {
      if (timedOut) throw new InferenceTimeoutError();
      if (signal?.aborted) throw new InferenceCancelledError();
      throw new InferenceUnreachableError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    }
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const wait = this.backoffMs * 2 ** (attempt - 1);
    const sleep = this.options.sleep ?? defaultSleep;
    await sleep(wait, signal);
    if (signal?.aborted) throw new InferenceCancelledError();
  }
}

function parseCompletion(text: string, requestedModel: string): Omit<InferenceResult, 'latencyMs' | 'attempts'> {
  let body: {
    choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    model?: unknown;
  } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new InferenceMalformedResponseError();
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.choices)) throw new InferenceMalformedResponseError();
  const choice = body.choices[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new InferenceMalformedResponseError();
  return {
    text: content,
    usage: {
      inputTokens: asCount(body.usage?.prompt_tokens),
      outputTokens: asCount(body.usage?.completion_tokens),
    },
    model: typeof body.model === 'string' && body.model ? body.model : requestedModel,
    stopReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : choice?.finish_reason === 'stop' ? 'END' : 'OTHER',
  };
}

/**
 * The OpenAI embeddings body: `data[i].embedding` with `data[i].index`. Every vector must be present,
 * finite and of one length, or the whole answer is unusable — a partial index is worse than none.
 */
function parseEmbeddings(text: string, expected: number, requestedModel: string): Omit<EmbeddingResult, 'latencyMs' | 'attempts'> {
  let body: { data?: unknown; usage?: { prompt_tokens?: unknown }; model?: unknown } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new InferenceMalformedResponseError();
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.data) || body.data.length !== expected) throw new InferenceMalformedResponseError();
  const vectors: (readonly number[] | undefined)[] = Array.from({ length: expected }, () => undefined);
  for (const [position, entry] of (body.data as unknown[]).entries()) {
    if (!entry || typeof entry !== 'object') throw new InferenceMalformedResponseError();
    const { index, embedding } = entry as { index?: unknown; embedding?: unknown };
    const slot = typeof index === 'number' ? index : position;
    if (!Number.isInteger(slot) || slot < 0 || slot >= expected || vectors[slot] !== undefined) throw new InferenceMalformedResponseError();
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new InferenceMalformedResponseError();
    }
    vectors[slot] = embedding as number[];
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (vectors.some((vector) => vector === undefined || vector.length !== dimensions)) throw new InferenceMalformedResponseError();
  return {
    vectors: vectors as (readonly number[])[],
    model: typeof body.model === 'string' && body.model ? body.model : requestedModel,
    usage: { inputTokens: asCount(body.usage?.prompt_tokens), outputTokens: 0 },
  };
}

function stamp(error: InferenceProviderError, attempts: number, latencyMs: number): InferenceProviderError {
  error.attempts = attempts;
  error.latencyMs = latencyMs;
  return error;
}

function elapsed(clock: () => number, started: number): number {
  return Math.max(0, Math.round(clock() - started));
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

interface AnthropicFetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

/**
 * Anthropic's Messages API.
 *
 * Present so the existing in-app assistant can move behind this interface rather than
 * keeping its own call site. Using it puts student text in a third-party processor in
 * another country, which the consent notice has to actually say — see ADR-029.
 */
export class AnthropicProvider implements InferenceProvider {
  readonly providerKey = 'anthropic';

  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly fetchImpl?: AnthropicFetchLike;
      readonly baseUrl?: string;
    },
  ) {
    if (!options.apiKey) throw new InferenceUnconfiguredError('ANTHROPIC_API_KEY is not set');
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as AnthropicFetchLike);
    // Anthropic takes the system prompt as its own field rather than a message.
    const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const messages = request.messages.filter((message) => message.role !== 'system');

    const response = await fetchImpl(`${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(system ? { system } : {}),
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status === 429) throw new InferenceRateLimitedError();
    if (!response.ok) throw new InferenceUpstreamError(response.status);

    const body = await response.json() as {
      content?: readonly { type?: unknown; text?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      model?: unknown;
      stop_reason?: unknown;
    };
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (!text) throw new InferenceMalformedResponseError();

    return {
      text,
      usage: {
        inputTokens: asCount(body.usage?.input_tokens),
        outputTokens: asCount(body.usage?.output_tokens),
      },
      model: typeof body.model === 'string' ? body.model : request.model,
      stopReason: body.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : body.stop_reason === 'end_turn' ? 'END' : 'OTHER',
    };
  }
}

/** Usage figures are advisory; a provider that omits them must not break metering. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
