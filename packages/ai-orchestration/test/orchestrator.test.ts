/**
 * What the orchestrator refuses is the reason it exists.
 *
 * A layer that calls a model when asked is trivial. The value is in the cases below: an
 * unknown feature resolving to off rather than on, a cap that actually stops, a refusal
 * that still gets metered, and — most importantly — no fallback text when inference is
 * unavailable, because a plausible substitute in front of a student is the outcome the
 * whole design is arranged to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  AiOrchestrator,
  InferenceUnconfiguredError,
  PromptRegistry,
  UnconfiguredInferenceProvider,
  type AiFeaturePolicy,
  type InferenceProvider,
  type UsageCounter,
} from '../src/index.js';

const prompt = {
  key: 'career.summary',
  version: 1,
  purpose: 'Draft a careers-office summary of a student profile for human review.',
  system: 'You summarise a student profile for a careers adviser. Use only what is given.',
  parameters: ['studentName', 'evidence'],
  user: 'Student: {{studentName}}\n\nEvidence:\n{{evidence}}',
  maxOutputTokens: 400,
  temperature: 0,
};

const registry = new PromptRegistry([prompt]);

const policy: AiFeaturePolicy = {
  featureKey: 'career.summary',
  enabled: true,
  cap: 2,
  window: 'DAY',
  model: 'local/qwen2.5-14b-instruct',
  maxInputChars: 4000,
};

function recordingCounter(used = 0): UsageCounter & { readonly records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    async count() { return used; },
    async record(input) { records.push({ ...input }); },
  };
}

function stubProvider(text = 'A short draft summary.'): InferenceProvider {
  return {
    providerKey: 'stub',
    async complete() {
      return { text, usage: { inputTokens: 120, outputTokens: 40 }, model: 'local/qwen2.5-14b-instruct', stopReason: 'END' as const };
    },
  };
}

function orchestrator(overrides: Partial<{
  provider: InferenceProvider;
  usage: UsageCounter;
  policy: (key: string) => Promise<AiFeaturePolicy | undefined>;
}> = {}): { orchestrator: AiOrchestrator; usage: ReturnType<typeof recordingCounter> } {
  const usage = (overrides.usage as ReturnType<typeof recordingCounter>) ?? recordingCounter();
  return {
    usage,
    orchestrator: new AiOrchestrator({
      provider: overrides.provider ?? stubProvider(),
      prompts: registry,
      usage,
      policy: overrides.policy ?? (async (key) => (key === 'career.summary' ? policy : undefined)),
      generatorVersion: 'orchestration-v1',
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    }),
  };
}

const request = {
  featureKey: 'career.summary',
  promptKey: 'career.summary',
  promptVersion: 1,
  parameters: { studentName: 'A student', evidence: 'Two assessments, one lesson.' },
  correlationId: 'corr-0000001',
};

describe('generation', () => {
  it('returns a DRAFT carrying its full provenance', async () => {
    const { orchestrator: subject } = orchestrator();
    const record = await subject.generate(request);
    // Everything a reviewer or an auditor needs to know where this text came from.
    expect(record.reviewState).toBe('DRAFT');
    expect(record.source).toBe('AI_GENERATED');
    expect(record.generatorVersion).toBe('orchestration-v1');
    expect(record.promptVersion).toBe('career.summary@1');
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(record.generatedAt).toBe('2026-09-12T00:00:00.000Z');
  });

  it('never returns anything already published', async () => {
    const { orchestrator: subject } = orchestrator();
    const record = await subject.generate(request);
    // There is no path through this class that produces a published row. A human does
    // that, elsewhere, having read it.
    expect(record.reviewState).toBe('DRAFT');
  });

  it('meters a successful generation with its token usage', async () => {
    const { orchestrator: subject, usage } = orchestrator();
    await subject.generate(request);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ outcome: 'SUCCEEDED', featureKey: 'career.summary', providerKey: 'stub' });
    expect(usage.records[0]?.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it('flags a draft that ran out of room rather than finishing', async () => {
    const truncating: InferenceProvider = {
      providerKey: 'stub',
      async complete() {
        return { text: 'Cut off mid-', usage: { inputTokens: 10, outputTokens: 400 }, model: 'm', stopReason: 'MAX_TOKENS' as const };
      },
    };
    const { orchestrator: subject } = orchestrator({ provider: truncating });
    expect((await subject.generate(request)).truncated).toBe(true);
  });
});

describe('refusals', () => {
  it('treats an unknown feature as off, not on', async () => {
    const { orchestrator: subject } = orchestrator({ policy: async () => undefined });
    // A typo in a feature key must never be the thing that switches inference on.
    await expect(subject.generate(request)).rejects.toBeInstanceOf(AiFeatureDisabledError);
  });

  it('refuses a disabled feature', async () => {
    const { orchestrator: subject } = orchestrator({ policy: async () => ({ ...policy, enabled: false }) });
    await expect(subject.generate(request)).rejects.toBeInstanceOf(AiFeatureDisabledError);
  });

  it('stops at the cap', async () => {
    const { orchestrator: subject } = orchestrator({ usage: recordingCounter(2) });
    await expect(subject.generate(request)).rejects.toBeInstanceOf(AiCapExceededError);
  });

  it('refuses an oversized prompt before calling out', async () => {
    let called = false;
    const watchful: InferenceProvider = {
      providerKey: 'stub',
      async complete() { called = true; throw new Error('should not be reached'); },
    };
    const { orchestrator: subject } = orchestrator({
      provider: watchful,
      policy: async () => ({ ...policy, maxInputChars: 10 }),
    });
    await expect(subject.generate(request)).rejects.toBeInstanceOf(AiInputTooLargeError);
    // The point is not the error, it is that no tokens were spent discovering it.
    expect(called).toBe(false);
  });

  it('meters refusals as well as successes', async () => {
    const usage = recordingCounter(99);
    const { orchestrator: subject } = orchestrator({ usage });
    await expect(subject.generate(request)).rejects.toBeInstanceOf(AiCapExceededError);
    // A feature refusing constantly looks identical to nobody using it unless the
    // refusal is written down.
    expect(usage.records[0]).toMatchObject({ outcome: 'REFUSED', failureClass: 'CAP_EXCEEDED' });
  });
});

describe('no inference provider', () => {
  it('fails loudly rather than substituting text', async () => {
    const { orchestrator: subject, usage } = orchestrator({ provider: new UnconfiguredInferenceProvider() });
    // Until the GPU pod serves, this is the live path. It must never degrade into
    // something plausible: a fabricated summary of a real student is the worst
    // available outcome, worse than an error.
    await expect(subject.generate(request)).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    expect(usage.records[0]).toMatchObject({ outcome: 'FAILED', failureClass: 'PROVIDER_UNCONFIGURED' });
  });
});
