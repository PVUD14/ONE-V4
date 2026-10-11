/**
 * ENG-24: the embedding capability — the adapter's `/embeddings` call against a local fake endpoint,
 * the all-or-nothing environment, the orchestrator's checks and metering, and the recipe's chunker.
 *
 * Pinned: vectors come back in input order whatever order the endpoint lists them; a missing, mixed-length
 * or non-numeric vector is unusable as a whole; a retryable status is retried; the endpoint is held to the
 * configured model; no error carries the upstream body or the key; blank configuration is "unavailable";
 * the orchestrator refuses (and meters) off, stopped, over-cap and oversized calls and meters successes and
 * failures; chunks are deterministic, bounded and lose nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  AiKillSwitchEngagedError,
  AiOrchestrator,
  ContentTooLongForEmbeddingError,
  EmbeddingVectorUnusableError,
  InferenceMalformedResponseError,
  InferenceModelMismatchError,
  InferenceProviderError,
  InferenceUnconfiguredError,
  OpenAICompatibleProvider,
  PromptRegistry,
  UnconfiguredInferenceProvider,
  chunkForEmbedding,
  contentEmbeddingRecipeV1,
  embeddingProviderFromEnvironment,
  embeddingVersionOf,
  normaliseEmbedding,
  oneEmbeddingFeatures,
  readEmbeddingConfiguration,
  type AiFeaturePolicy,
  type EmbeddingProvider,
  type UsageCounter,
} from '../src/index.js';
import { startFakeOpenAiServer, type FakeAnswer, type FakeOpenAiServer } from '../src/testing/fake-openai-server.js';
import { createFakeEmbeddingProvider, fakeEmbedding } from '../src/testing/fake-embedding-provider.js';

// Test-only sentinels; neither is a credential.
const testKey = 'test-only-embedding-bearer-0000';
const upstreamText = 'UPSTREAM-DETAIL-must-not-leak (echo: lesson text)';
const model = 'fake/embedding-model';

const servers: FakeOpenAiServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function serve(answer: (index: number, body: string) => FakeAnswer): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAiServer((request, index) => answer(index, request.body));
  servers.push(server);
  return server;
}

const noSleep = async (): Promise<void> => undefined;
const adapter = (server: FakeOpenAiServer): OpenAICompatibleProvider =>
  new OpenAICompatibleProvider({ baseUrl: server.baseUrl, apiKey: testKey, model, sleep: noSleep, timeoutMs: 2_000 });

const embeddingsBody = (vectors: number[][], order: number[] = vectors.map((_, index) => index)): unknown => ({
  object: 'list',
  model,
  data: order.map((index) => ({ object: 'embedding', index, embedding: vectors[index] })),
  usage: { prompt_tokens: 12, total_tokens: 12 },
});

describe('the adapter embeds through POST /embeddings', () => {
  it('sends the inputs with the bearer key and returns one vector per input, in input order', async () => {
    const server = await serve(() => ({ status: 200, json: embeddingsBody([[1, 0], [0, 1], [1, 1]], [2, 0, 1]) }));
    const result = await adapter(server).embed({ model, inputs: ['a', 'b', 'c'] });
    expect(result.vectors).toEqual([[1, 0], [0, 1], [1, 1]]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 0 });
    expect(result.attempts).toBe(1);
    expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/v1/embeddings', authorization: `Bearer ${testKey}` });
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ model, input: ['a', 'b', 'c'], encoding_format: 'float' });
  });

  it('retries a 503 and then succeeds', async () => {
    const server = await serve((index) => (index < 2 ? { status: 503, raw: upstreamText } : { status: 200, json: embeddingsBody([[0.5, 0.5]]) }));
    const result = await adapter(server).embed({ model, inputs: ['x'] });
    expect(result.attempts).toBe(3);
  });

  it('treats a missing, mixed-length or non-numeric vector as an unusable answer, whole', async () => {
    for (const body of [
      embeddingsBody([[1, 0]]),
      { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }] },
      { data: [{ index: 0, embedding: [1, 'x'] }, { index: 1, embedding: [1, 0] }] },
      { data: [{ index: 0, embedding: [] }, { index: 1, embedding: [1, 0] }] },
      { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] },
    ]) {
      const server = await serve(() => ({ status: 200, json: body }));
      await expect(adapter(server).embed({ model, inputs: ['a', 'b'] })).rejects.toBeInstanceOf(InferenceMalformedResponseError);
    }
  });

  it('refuses another model before the network, and never puts the body or the key in an error', async () => {
    const server = await serve(() => ({ status: 400, raw: upstreamText }));
    await expect(adapter(server).embed({ model: 'other/model', inputs: ['a'] })).rejects.toBeInstanceOf(InferenceModelMismatchError);
    expect(server.requests).toHaveLength(0);
    const failure = await adapter(server).embed({ model, inputs: ['a'] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InferenceProviderError);
    expect(String((failure as Error).message)).not.toContain('UPSTREAM');
    expect(JSON.stringify(failure)).not.toContain(testKey);
  });
});

describe('the embedding endpoint comes from three variables, all or nothing', () => {
  it('is unavailable, never a crash, when any is blank, and its refusal names no secret', async () => {
    expect(readEmbeddingConfiguration({})).toEqual({ state: 'UNCONFIGURED', reason: 'BASE_URL_MISSING' });
    expect(readEmbeddingConfiguration({ ONE_AI_EMBEDDING_BASE_URL: 'https://pod.example.test/v1', ONE_AI_EMBEDDING_MODEL: model }))
      .toEqual({ state: 'UNCONFIGURED', reason: 'KEY_MISSING' });
    // The chat endpoint's variables do not configure embeddings.
    expect(readEmbeddingConfiguration({ ONE_AI_BASE_URL: 'https://pod.example.test/v1', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model }).state).toBe('UNCONFIGURED');
    const { provider } = embeddingProviderFromEnvironment({});
    await expect(provider.embed({ model, inputs: ['a'] })).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    const configured = embeddingProviderFromEnvironment({ ONE_AI_EMBEDDING_BASE_URL: 'https://pod.example.test/v1', ONE_AI_EMBEDDING_API_KEY: testKey, ONE_AI_EMBEDDING_MODEL: model });
    expect(configured.configuration).toMatchObject({ state: 'CONFIGURED', endpointHost: 'pod.example.test', model });
    expect(configured.provider).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

const policy: AiFeaturePolicy = { featureKey: 'content.embeddings', enabled: true, cap: 2, window: 'DAY', model, maxInputChars: 100 };

function recordingCounter(used = 0): UsageCounter & { readonly records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return { records, async count() { return used; }, async record(input) { records.push({ ...input }); } };
}

function orchestrator(options: { embeddings?: EmbeddingProvider; used?: number; policy?: AiFeaturePolicy | undefined; killSwitch?: boolean } = {}) {
  const usage = recordingCounter(options.used ?? 0);
  const resolved = 'policy' in options ? options.policy : policy;
  return {
    usage,
    orchestrator: new AiOrchestrator({
      provider: new UnconfiguredInferenceProvider(),
      prompts: new PromptRegistry([]),
      usage,
      policy: async () => resolved,
      killSwitchEngaged: async () => options.killSwitch ?? false,
      generatorVersion: 'test-generator',
      now: () => new Date('2026-10-08T00:00:00Z'),
      ...(options.embeddings ? { embeddings: options.embeddings } : {}),
    }),
  };
}

const request = { featureKey: 'content.embeddings', recipe: contentEmbeddingRecipeV1, inputs: ['subnet masks', 'binary numbers'], correlationId: 'eng24-test-corr' };

describe('AiOrchestrator.embed', () => {
  it('returns vectors with provenance and meters the success against the recipe', async () => {
    const fake = createFakeEmbeddingProvider({ model });
    const { orchestrator: ai, usage } = orchestrator({ embeddings: fake });
    const record = await ai.embed(request);
    expect(record).toMatchObject({ featureKey: 'content.embeddings', model, dimensions: 64, source: 'AI_GENERATED', generatorVersion: 'test-generator', promptVersion: 'content-embedding@1', generatedAt: '2026-10-08T00:00:00.000Z' });
    expect(record.vectors).toEqual([fakeEmbedding('subnet masks'), fakeEmbedding('binary numbers')]);
    expect(fake.requests[0]).toMatchObject({ model, inputs: request.inputs });
    expect(usage.records).toEqual([expect.objectContaining({ outcome: 'SUCCEEDED', promptKey: 'content-embedding', promptVersion: 1, providerKey: 'fake-embeddings', featureKey: 'content.embeddings' })]);
  });

  it('refuses, and meters, a stopped, switched-off, over-cap or oversized call without calling the endpoint', async () => {
    const cases: [Parameters<typeof orchestrator>[0], typeof request, unknown, string][] = [
      [{ killSwitch: true }, request, AiKillSwitchEngagedError, 'KILL_SWITCH_ENGAGED'],
      [{ policy: { ...policy, enabled: false } }, request, AiFeatureDisabledError, 'FEATURE_DISABLED'],
      [{ used: 2 }, request, AiCapExceededError, 'CAP_EXCEEDED'],
      [{}, { ...request, inputs: ['x'.repeat(101)] }, AiInputTooLargeError, 'INPUT_TOO_LARGE'],
      [{}, { ...request, inputs: [] }, AiInputTooLargeError, 'INPUT_TOO_LARGE'],
      [{}, { ...request, inputs: ['  '] }, AiInputTooLargeError, 'INPUT_TOO_LARGE'],
    ];
    for (const [options, call, error, failureClass] of cases) {
      const fake = createFakeEmbeddingProvider({ model });
      const { orchestrator: ai, usage } = orchestrator({ ...options, embeddings: fake });
      await expect(ai.embed(call)).rejects.toBeInstanceOf(error as new () => Error);
      expect(fake.requests).toHaveLength(0);
      expect(usage.records).toEqual([expect.objectContaining({ outcome: 'REFUSED', failureClass })]);
    }
  });

  it('treats an unknown feature as off, and a missing endpoint as a metered PROVIDER_UNCONFIGURED failure', async () => {
    await expect(orchestrator({ policy: undefined }).orchestrator.embed(request)).rejects.toBeInstanceOf(AiFeatureDisabledError);
    const { orchestrator: ai, usage } = orchestrator();
    await expect(ai.embed(request)).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    expect(usage.records).toEqual([expect.objectContaining({ outcome: 'FAILED', failureClass: 'PROVIDER_UNCONFIGURED', providerKey: 'unconfigured' })]);
  });

  it('meters a model mismatch as a failure and returns nothing', async () => {
    const { orchestrator: ai, usage } = orchestrator({ embeddings: createFakeEmbeddingProvider({ model: 'another/model' }) });
    await expect(ai.embed(request)).rejects.toBeInstanceOf(InferenceModelMismatchError);
    expect(usage.records).toEqual([expect.objectContaining({ outcome: 'FAILED', failureClass: 'PROVIDER_MODEL_MISMATCH' })]);
  });
});

describe('the content-embedding@1 recipe', () => {
  const recipe = contentEmbeddingRecipeV1;

  it('is versioned like a prompt and declared by both features, which start off with no model chosen', () => {
    expect(embeddingVersionOf(recipe)).toBe('content-embedding@1');
    expect(oneEmbeddingFeatures.map((feature) => [feature.featureKey, feature.recipe, feature.defaultModel]))
      .toEqual([['content.embeddings', recipe, 'embedding-model-not-chosen'], ['tutor.retrieval', recipe, 'embedding-model-not-chosen']]);
  });

  it('packs paragraphs under the title, deterministically, within the limit, losing nothing', () => {
    const paragraphs = Array.from({ length: 9 }, (_, index) => `Paragraph ${index}. ` + 'Subnet masks split an address. '.repeat(10));
    const source = { title: 'Subnetting  basics', sections: [paragraphs.slice(0, 5).join('\n\n'), paragraphs.slice(5).join('\n\n'), null] };
    const chunks = chunkForEmbedding(recipe, source);
    expect(chunkForEmbedding(recipe, source)).toEqual(chunks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(recipe.maxChunkChars);
      expect(chunk.startsWith('Subnetting basics\n\n')).toBe(true);
    }
    const rejoined = chunks.map((chunk) => chunk.slice('Subnetting basics\n\n'.length)).join('\n\n');
    expect(rejoined).toBe(paragraphs.map((paragraph) => paragraph.trim()).join('\n\n'));
  });

  it('splits an over-long paragraph by sentence, then by length; a title alone is one chunk; nothing is none', () => {
    const long = 'A sentence about binary. '.repeat(120) + 'x'.repeat(2500);
    const chunks = chunkForEmbedding(recipe, { title: 'T', sections: [long] });
    expect(chunks.every((chunk) => chunk.length <= recipe.maxChunkChars)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(3)).join('').replace(/\s+/gu, '')).toBe(long.replace(/\s+/gu, ''));
    expect(chunkForEmbedding(recipe, { title: 'Only a title', sections: ['', null] })).toEqual(['Only a title']);
    expect(chunkForEmbedding(recipe, { title: '', sections: [] })).toEqual([]);
  });

  it('refuses content that needs more chunks than the recipe allows, rather than truncating it', () => {
    const huge = Array.from({ length: 200 }, () => 'w'.repeat(900)).join('\n\n');
    expect(() => chunkForEmbedding(recipe, { title: 'T', sections: [huge] })).toThrow(ContentTooLongForEmbeddingError);
  });

  it('normalises to unit length and refuses a zero or non-finite vector', () => {
    const unit = normaliseEmbedding([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
    expect(() => normaliseEmbedding([0, 0])).toThrow(EmbeddingVectorUnusableError);
    expect(() => normaliseEmbedding([Number.NaN, 1])).toThrow(EmbeddingVectorUnusableError);
    expect(() => normaliseEmbedding([])).toThrow(EmbeddingVectorUnusableError);
  });
});
