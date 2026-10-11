/**
 * The inference adapter (ENG-20) against a local fake OpenAI-compatible server — no real network.
 *
 * What is pinned here: tokens and latency come back for accounting; a timeout, a 401, a 5xx that
 * never recovers and a malformed body each fail with their own class and the right number of
 * attempts; blank configuration is "unavailable", never a crash; and no error a caller could pass
 * on contains the upstream body or the key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiFeatureDisabledError,
  AiKillSwitchEngagedError,
  AiOrchestrator,
  InferenceAuthError,
  InferenceMalformedResponseError,
  InferenceModelMismatchError,
  InferenceProviderError,
  InferenceTimeoutError,
  InferenceUnconfiguredError,
  InferenceUnreachableError,
  InferenceUpstreamError,
  OpenAICompatibleProvider,
  PromptRegistry,
  UnconfiguredInferenceProvider,
  describeInferenceConfiguration,
  inferenceProviderFromEnvironment,
  readInferenceConfiguration,
  type AiFeaturePolicy,
  type InferenceRequest,
  type UsageCounter,
} from '../src/index.js';
import { completion, startFakeOpenAiServer, type FakeAnswer, type FakeOpenAiServer } from '../src/testing/fake-openai-server.js';

// Test-only sentinels. Neither is a credential; they exist so a leak is detectable by search.
const testKey = 'test-only-bearer-value-0000';
const upstreamText = 'UPSTREAM-DETAIL-must-not-leak (echo: the student wrote this)';
const model = 'fake/served-model';

const servers: FakeOpenAiServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function serve(answer: (index: number) => FakeAnswer): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAiServer((_request, index) => answer(index));
  servers.push(server);
  return server;
}

const noSleep = async (): Promise<void> => undefined;

function adapter(server: FakeOpenAiServer, overrides: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: testKey, model, sleep: noSleep, timeoutMs: 2_000, ...overrides });
}

const request: InferenceRequest = {
  model,
  maxOutputTokens: 64,
  temperature: 0,
  messages: [{ role: 'system', content: 'You draft.' }, { role: 'user', content: 'Draft one line.' }],
};

/** Everything about an error a careless caller might print, log or return. */
function everythingAbout(error: unknown): string {
  const record = error as Record<string, unknown>;
  return [String(error), (error as Error).message, (error as Error).stack ?? '', JSON.stringify(record), JSON.stringify(Object.entries(record))].join('\n');
}

async function failureOf(promise: Promise<unknown>): Promise<InferenceProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceProviderError);
    return error as InferenceProviderError;
  }
  throw new Error('expected the call to fail');
}

describe('a successful call', () => {
  it('returns the text with token usage, latency and attempts for accounting', async () => {
    const server = await serve(() => ({ status: 200, json: completion('A short draft.', { prompt_tokens: 321, completion_tokens: 45 }) }));
    const result = await adapter(server).complete(request);
    expect(result.text).toBe('A short draft.');
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 45 });
    expect(result.model).toBe(model);
    expect(result.stopReason).toBe('END');
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('speaks the OpenAI chat-completions shape at {base}/chat/completions with a bearer key', async () => {
    const server = await serve(() => ({ status: 200, json: completion('ok') }));
    await adapter(server).complete(request);
    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/chat/completions');
    expect(sent.authorization).toBe(`Bearer ${testKey}`);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model, max_tokens: 64, temperature: 0, stream: false });
    expect(body.messages).toEqual(request.messages);
  });

  it('marks a draft that stopped for length as truncated', async () => {
    const server = await serve(() => ({ status: 200, json: completion('Cut off', undefined, 'length') }));
    expect((await adapter(server).complete(request)).stopReason).toBe('MAX_TOKENS');
  });

  it('meters zero tokens rather than failing when the endpoint omits usage', async () => {
    const server = await serve(() => ({ status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }));
    expect((await adapter(server).complete(request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('failures', () => {
  it('times out an attempt that never answers, and does not retry it', async () => {
    const server = await serve(() => ({ hang: true }));
    const failure = await failureOf(adapter(server, { timeoutMs: 150, maxAttempts: 3 }).complete(request));
    expect(failure).toBeInstanceOf(InferenceTimeoutError);
    expect(failure.failureClass).toBe('PROVIDER_TIMEOUT');
    // Retrying a timeout could double what the pod is already generating and billing.
    expect(server.requests).toHaveLength(1);
    expect(failure.attempts).toBe(1);
    expect(failure.latencyMs).toBeGreaterThanOrEqual(100);
  });

  it('fails a 401 at once as an authentication failure', async () => {
    const server = await serve(() => ({ status: 401, json: { error: { message: upstreamText } } }));
    const failure = await failureOf(adapter(server).complete(request));
    expect(failure).toBeInstanceOf(InferenceAuthError);
    expect(failure.failureClass).toBe('PROVIDER_AUTH_FAILED');
    expect((failure as InferenceUpstreamError).status).toBe(401);
    expect(server.requests).toHaveLength(1);
  });

  it('retries a 5xx with backoff, then fails once the attempts are spent', async () => {
    const waits: number[] = [];
    const server = await serve(() => ({ status: 503, raw: upstreamText }));
    const failure = await failureOf(adapter(server, { maxAttempts: 3, backoffMs: 200, sleep: async (ms) => { waits.push(ms); } }).complete(request));
    expect(failure.failureClass).toBe('PROVIDER_SERVER_ERROR');
    expect(server.requests).toHaveLength(3);
    expect(failure.attempts).toBe(3);
    // Exponential: 200 then 400, and no wait after the last attempt.
    expect(waits).toEqual([200, 400]);
  });

  it('recovers when a retried 5xx is followed by a success, and says how many attempts it took', async () => {
    const server = await serve((index) => (index < 2 ? { status: 502, raw: 'bad gateway' } : { status: 200, json: completion('Recovered.') }));
    const result = await adapter(server).complete(request);
    expect(result.text).toBe('Recovered.');
    expect(result.attempts).toBe(3);
  });

  it('retries a rate limit and reports it if it persists', async () => {
    const server = await serve(() => ({ status: 429, raw: 'slow down' }));
    const failure = await failureOf(adapter(server, { maxAttempts: 2 }).complete(request));
    expect(failure.failureClass).toBe('PROVIDER_RATE_LIMITED');
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry a 404 and names it, because it is usually a base URL without /v1', async () => {
    const server = await serve(() => ({ status: 404, raw: 'not found' }));
    const failure = await failureOf(adapter(server).complete(request));
    expect(failure.failureClass).toBe('PROVIDER_NOT_FOUND');
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ['a body that is not JSON', { status: 200, raw: '<html>' + upstreamText + '</html>' }],
    ['JSON without choices', { status: 200, json: { object: 'error', message: upstreamText } }],
    ['an empty completion', { status: 200, json: completion('   ') }],
    ['content that is not text', { status: 200, json: { choices: [{ message: { content: 42 } }] } }],
  ] as const)('rejects %s as malformed, without retrying', async (_label, answer) => {
    const server = await serve(() => answer);
    const failure = await failureOf(adapter(server).complete(request));
    expect(failure).toBeInstanceOf(InferenceMalformedResponseError);
    expect(failure.failureClass).toBe('PROVIDER_MALFORMED_RESPONSE');
    expect(server.requests).toHaveLength(1);
  });

  it('retries a connection that drops, then reports the endpoint unreachable', async () => {
    const server = await serve(() => ({ destroy: true }));
    const failure = await failureOf(adapter(server, { maxAttempts: 2 }).complete(request));
    expect(failure).toBeInstanceOf(InferenceUnreachableError);
    expect(failure.attempts).toBe(2);
  });

  it('refuses a model the endpoint is not configured to serve, before any network call', async () => {
    const server = await serve(() => ({ status: 200, json: completion('should not be reached') }));
    const failure = await failureOf(adapter(server).complete({ ...request, model: 'some/other-model' }));
    expect(failure).toBeInstanceOf(InferenceModelMismatchError);
    expect(server.requests).toHaveLength(0);
  });

  it('stops when the caller cancels', async () => {
    const server = await serve(() => ({ hang: true }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const failure = await failureOf(adapter(server, { timeoutMs: 5_000 }).complete({ ...request, signal: controller.signal }));
    expect(failure.failureClass).toBe('PROVIDER_CANCELLED');
  });
});

describe('no upstream text and no key in anything a caller could surface', () => {
  const scripted: readonly [string, FakeAnswer][] = [
    ['401', { status: 401, json: { error: { message: upstreamText, key: testKey } } }],
    ['403', { status: 403, raw: upstreamText }],
    ['500', { status: 500, raw: `${upstreamText} ${testKey}` }],
    ['400', { status: 400, json: { error: upstreamText } }],
    ['malformed', { status: 200, raw: `${upstreamText} ${testKey}` }],
    ['error object in 200', { status: 200, json: { error: { message: upstreamText } } }],
  ];

  it.each(scripted)('%s', async (_label, answer) => {
    const server = await serve(() => answer);
    const failure = await failureOf(adapter(server, { maxAttempts: 1 }).complete(request));
    const surfaced = everythingAbout(failure);
    expect(surfaced).not.toContain('UPSTREAM-DETAIL');
    expect(surfaced).not.toContain('the student wrote this');
    expect(surfaced).not.toContain(testKey);
  });

  it('an unreachable endpoint does not surface its host and port either', async () => {
    const server = await serve(() => ({ destroy: true }));
    const failure = await failureOf(adapter(server, { maxAttempts: 1 }).complete(request));
    expect(everythingAbout(failure)).not.toContain(new URL(server.baseUrl).port);
  });
});

describe('configuration from the environment', () => {
  it('is unavailable — never a crash — when any of the three variables is blank', async () => {
    for (const env of [
      {},
      { ONE_AI_BASE_URL: '', ONE_AI_API_KEY: '', ONE_AI_MODEL: '' },
      { ONE_AI_BASE_URL: 'https://pod.example.test/v1', ONE_AI_API_KEY: '  ', ONE_AI_MODEL: model },
      { ONE_AI_BASE_URL: 'https://pod.example.test/v1', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: '' },
    ]) {
      const { provider, configuration } = inferenceProviderFromEnvironment(env);
      expect(configuration.state).toBe('UNCONFIGURED');
      expect(provider).toBeInstanceOf(UnconfiguredInferenceProvider);
      await expect(provider.complete(request)).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    }
  });

  it.each([
    ['not a URL', 'pod', 'BASE_URL_INVALID'],
    ['another scheme', 'ftp://pod.example.test/v1', 'BASE_URL_INVALID'],
    ['credentials in the URL', 'https://user:secret@pod.example.test/v1', 'BASE_URL_INVALID'],
    ['a query string', 'https://pod.example.test/v1?key=x', 'BASE_URL_INVALID'],
    ['plain http to a remote host', 'http://pod.example.test/v1', 'BASE_URL_INSECURE'],
  ])('refuses %s', (_label, baseUrl, reason) => {
    const configuration = readInferenceConfiguration({ ONE_AI_BASE_URL: baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model });
    expect(configuration).toEqual({ state: 'UNCONFIGURED', reason });
  });

  it('accepts the pod URL shape and loopback http, and keeps the /v1 path', () => {
    const pod = readInferenceConfiguration({ ONE_AI_BASE_URL: 'https://abc123-8888.proxy.runpod.net/v1/', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model });
    expect(pod).toMatchObject({ state: 'CONFIGURED', baseUrl: 'https://abc123-8888.proxy.runpod.net/v1', endpointHost: 'abc123-8888.proxy.runpod.net', model });
    expect(readInferenceConfiguration({ ONE_AI_BASE_URL: 'http://127.0.0.1:8000/v1', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model }).state).toBe('CONFIGURED');
  });

  it('describes the endpoint for AI Operations without the key or the full URL', () => {
    const view = describeInferenceConfiguration({ ONE_AI_BASE_URL: 'https://abc123-8888.proxy.runpod.net/v1', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model });
    expect(view).toEqual({ configured: true, reason: null, providerKey: 'openai-compatible', endpointHost: 'abc123-8888.proxy.runpod.net', model, keyConfigured: true });
    expect(JSON.stringify(view)).not.toContain(testKey);
    expect(describeInferenceConfiguration({})).toEqual({ configured: false, reason: 'BASE_URL_MISSING', providerKey: 'unconfigured', endpointHost: null, model: null, keyConfigured: false });
  });

  it('builds a working adapter from the three variables', async () => {
    const server = await serve(() => ({ status: 200, json: completion('From the environment.') }));
    const { provider } = inferenceProviderFromEnvironment({ ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model });
    expect(provider.providerKey).toBe('openai-compatible');
    expect((await provider.complete(request)).text).toBe('From the environment.');
  });
});

describe('the reachability probe', () => {
  it('lists models and says whether the configured one is served', async () => {
    const server = await serve(() => ({ status: 200, json: { object: 'list', data: [{ id: model, object: 'model' }] } }));
    const probe = await adapter(server).probe();
    expect(probe).toMatchObject({ reachable: true, modelServed: true, failureClass: null });
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', authorization: `Bearer ${testKey}` });
  });

  it('reports a model that is not loaded', async () => {
    const server = await serve(() => ({ status: 200, json: { data: [{ id: 'something/else' }] } }));
    expect(await adapter(server).probe()).toMatchObject({ reachable: true, modelServed: false });
  });

  it('reports a wrong key without throwing', async () => {
    const server = await serve(() => ({ status: 401, raw: upstreamText }));
    const probe = await adapter(server).probe();
    expect(probe).toMatchObject({ reachable: false, failureClass: 'PROVIDER_AUTH_FAILED' });
    expect(JSON.stringify(probe)).not.toContain('UPSTREAM-DETAIL');
  });

  it('reports a dead endpoint without throwing', async () => {
    const server = await serve(() => ({ destroy: true }));
    expect(await adapter(server).probe()).toMatchObject({ reachable: false, failureClass: 'PROVIDER_UNREACHABLE' });
  });

  it('reports unconfigured without a network call', async () => {
    expect(await new UnconfiguredInferenceProvider().probe()).toEqual({ reachable: false, modelServed: null, failureClass: 'PROVIDER_UNCONFIGURED', latencyMs: null });
  });
});

describe('through the orchestrator', () => {
  const prompt = {
    key: 'demo.draft', version: 1, purpose: 'Test fixture.', system: 'You draft.', parameters: ['topic'],
    user: 'Draft about {{topic}}.', maxOutputTokens: 64, temperature: 0,
  };
  const policy: AiFeaturePolicy = { featureKey: 'demo.draft', enabled: true, cap: 5, window: 'DAY', model, maxInputChars: 4000 };

  function harness(server: FakeOpenAiServer, options: { enabled?: boolean; killSwitch?: boolean; env?: Record<string, string> } = {}) {
    const records: Parameters<UsageCounter['record']>[0][] = [];
    const { provider } = inferenceProviderFromEnvironment(
      options.env ?? { ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model },
      { sleep: noSleep, timeoutMs: 2_000 },
    );
    const orchestrator = new AiOrchestrator({
      provider,
      prompts: new PromptRegistry([prompt]),
      usage: { async count() { return 0; }, async record(input) { records.push(input); } },
      policy: async (key) => (key === policy.featureKey ? { ...policy, enabled: options.enabled ?? true } : undefined),
      killSwitchEngaged: async () => options.killSwitch ?? false,
      generatorVersion: 'orchestration-v1',
    });
    const generate = () => orchestrator.generate({ featureKey: 'demo.draft', promptKey: 'demo.draft', promptVersion: 1, parameters: { topic: 'loops' }, correlationId: 'corr-eng20-01' });
    return { records, generate };
  }

  it('meters a success with tokens, latency and attempts', async () => {
    const server = await serve(() => ({ status: 200, json: completion('Draft.', { prompt_tokens: 50, completion_tokens: 9 }) }));
    const { records, generate } = harness(server);
    const record = await generate();
    expect(record.reviewState).toBe('DRAFT');
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'SUCCEEDED', providerKey: 'openai-compatible', usage: { inputTokens: 50, outputTokens: 9 }, attempts: 1 });
    expect(records[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('with the kill switch on, makes no call and meters KILL_SWITCH_ENGAGED', async () => {
    const server = await serve(() => ({ status: 200, json: completion('should not be reached') }));
    const { records, generate } = harness(server, { killSwitch: true });
    await expect(generate()).rejects.toBeInstanceOf(AiKillSwitchEngagedError);
    expect(server.requests).toHaveLength(0);
    expect(records).toEqual([expect.objectContaining({ outcome: 'REFUSED', failureClass: 'KILL_SWITCH_ENGAGED' })]);
    expect(records[0]!.latencyMs).toBeUndefined();
  });

  it('with the feature flag off, makes no call and meters FEATURE_DISABLED', async () => {
    const server = await serve(() => ({ status: 200, json: completion('should not be reached') }));
    const { records, generate } = harness(server, { enabled: false });
    await expect(generate()).rejects.toBeInstanceOf(AiFeatureDisabledError);
    expect(server.requests).toHaveLength(0);
    expect(records).toEqual([expect.objectContaining({ outcome: 'REFUSED', failureClass: 'FEATURE_DISABLED' })]);
  });

  it('with blank configuration, meters PROVIDER_UNCONFIGURED and makes no call', async () => {
    const server = await serve(() => ({ status: 200, json: completion('should not be reached') }));
    const { records, generate } = harness(server, { env: {} });
    await expect(generate()).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    expect(server.requests).toHaveLength(0);
    expect(records).toEqual([expect.objectContaining({ outcome: 'FAILED', failureClass: 'PROVIDER_UNCONFIGURED', providerKey: 'unconfigured' })]);
  });

  it('meters a failure with its class, attempts and latency, and rethrows nothing upstream', async () => {
    const server = await serve(() => ({ status: 500, raw: upstreamText }));
    const { records, generate } = harness(server);
    const failure = await generate().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(InferenceUpstreamError);
    expect(everythingAbout(failure)).not.toContain('UPSTREAM-DETAIL');
    expect(records[0]).toMatchObject({ outcome: 'FAILED', failureClass: 'PROVIDER_SERVER_ERROR', attempts: 3 });
    expect(JSON.stringify(records)).not.toContain('UPSTREAM-DETAIL');
  });
});
