/**
 * The boundary between ONE and whatever is actually doing inference.
 *
 * ADR-029 puts inference on ONE's own GPU pod, and the pod is not serving yet. The
 * point of this interface is that "not serving yet" costs one adapter rather than a
 * rewrite: every feature is written against `InferenceProvider`, and the venue is a
 * constructor argument.
 *
 * Two adapters ship here. `OpenAICompatibleProvider` is the one the pod will use —
 * vLLM, TGI, Ollama and llama.cpp all expose the same `/v1/chat/completions` shape, so
 * a self-hosted model needs a base URL and nothing else. `AnthropicProvider` exists
 * because the in-app assistant already calls that API directly today, and moving it
 * behind this interface is what stops a second provider call site appearing.
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
}

export interface InferenceProvider {
  /** Stable identifier recorded against every generation, e.g. `runpod-vllm`. */
  readonly providerKey: string;
  complete(request: InferenceRequest): Promise<InferenceResult>;
}

export class InferenceUnconfiguredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'InferenceUnconfiguredError';
  }
}

export class InferenceUpstreamError extends Error {
  constructor(readonly status: number, detail: string) {
    super(detail);
    this.name = 'InferenceUpstreamError';
  }
}

export class InferenceRateLimitedError extends Error {
  constructor() {
    super('inference provider rate limited');
    this.name = 'InferenceRateLimitedError';
  }
}

/**
 * A provider that refuses every call, with a message that says why.
 *
 * This is the default until the pod serves. It exists so that AI features can be built,
 * wired, flagged and tested now: with the flag off nothing calls inference at all, and
 * with the flag on and no pod the failure is a clear, typed, logged refusal rather than
 * a crash or — worse — a silent fallback that puts something invented in front of a
 * student.
 */
export class UnconfiguredInferenceProvider implements InferenceProvider {
  readonly providerKey = 'unconfigured';

  async complete(): Promise<InferenceResult> {
    throw new InferenceUnconfiguredError(
      'no inference provider is configured; set PTP_INFERENCE_BASE_URL for the GPU pod',
    );
  }
}

interface FetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

/**
 * The OpenAI chat-completions shape, which is the lingua franca of self-hosted serving.
 *
 * `apiKey` is optional on purpose: a pod on a private network commonly has no auth, and
 * requiring a placeholder key would be ceremony. When one is set it is sent as a bearer
 * token and never logged.
 */
export class OpenAICompatibleProvider implements InferenceProvider {
  readonly providerKey: string;

  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly apiKey?: string | undefined;
      readonly providerKey?: string;
      readonly fetchImpl?: FetchLike;
    },
  ) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new InferenceUnconfiguredError('inference base URL must be http(s)');
    this.providerKey = options.providerKey ?? 'openai-compatible';
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const fetchImpl = (this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature ?? 0,
        stream: false,
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status === 429) throw new InferenceRateLimitedError();
    if (!response.ok) {
      // The upstream body may echo the prompt, which can carry student data, so the
      // status is recorded and the body is not.
      throw new InferenceUpstreamError(response.status, 'inference provider returned an error');
    }

    const body = await response.json() as {
      choices?: readonly { message?: { content?: unknown }; finish_reason?: unknown }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      model?: unknown;
    };
    const choice = body.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!text) throw new InferenceUpstreamError(200, 'inference provider returned no content');

    return {
      text,
      usage: {
        inputTokens: asCount(body.usage?.prompt_tokens),
        outputTokens: asCount(body.usage?.completion_tokens),
      },
      model: typeof body.model === 'string' ? body.model : request.model,
      stopReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : choice?.finish_reason === 'stop' ? 'END' : 'OTHER',
    };
  }
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
      readonly fetchImpl?: FetchLike;
      readonly baseUrl?: string;
    },
  ) {
    if (!options.apiKey) throw new InferenceUnconfiguredError('ANTHROPIC_API_KEY is not set');
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const fetchImpl = (this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
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
    if (!response.ok) throw new InferenceUpstreamError(response.status, 'inference provider returned an error');

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
    if (!text) throw new InferenceUpstreamError(200, 'inference provider returned no content');

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
