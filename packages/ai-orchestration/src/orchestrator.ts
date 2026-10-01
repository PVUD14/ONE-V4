/**
 * ONE AI Orchestration — the single place inference happens.
 *
 * The rule it exists to enforce: no portal and no request handler calls a model. They
 * ask for a generation, and this decides whether it is allowed, which prompt version
 * produces it, what it costs, and what gets recorded. One choke point is what makes
 * "every AI feature behind its own flag with its own cap" true rather than aspirational.
 *
 * What it deliberately does NOT do:
 *  - It does not publish. Every generation comes back `DRAFT` for a human to accept.
 *  - It does not score readiness. An LLM is never the readiness engine, and nothing
 *    here can produce a numeric readiness value.
 *  - It does not fall back. If inference is unavailable the generation fails loudly;
 *    a plausible substitute in front of a student is the outcome to avoid.
 */
import {
  InferenceProviderError,
  type InferenceProvider,
  type InferenceUsage,
} from './provider.js';
import { PromptRegistry, renderPrompt, promptFingerprint, type PromptVersion } from './prompts.js';

export type ReviewState = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'REJECTED';

/** A feature's switch and its ceiling. One of these per AI feature, no sharing. */
export interface AiFeaturePolicy {
  readonly featureKey: string;
  readonly enabled: boolean;
  /** Generations allowed in the window. A feature with no cap is not shippable. */
  readonly cap: number;
  readonly window: 'DAY' | 'MONTH';
  readonly model: string;
  /** Refuse before calling out, when the assembled prompt is implausibly large. */
  readonly maxInputChars: number;
}

export interface GenerationRequest {
  readonly featureKey: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly parameters: Readonly<Record<string, string>>;
  /** Whose record this generation is about, for metering and for the audit trail. */
  readonly subjectUserId?: string | undefined;
  readonly correlationId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface GenerationRecord {
  readonly featureKey: string;
  readonly text: string;
  readonly source: 'AI_GENERATED';
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly promptFingerprint: string;
  /** Always DRAFT. The type is wider only because the stored row's state changes. */
  readonly reviewState: Extract<ReviewState, 'DRAFT'>;
  readonly generatedAt: string;
  readonly usage: InferenceUsage;
  readonly truncated: boolean;
  /** Wall time of the provider call, retries included; null when the provider does not measure it. */
  readonly latencyMs: number | null;
}

export class AiFeatureDisabledError extends Error {
  constructor(featureKey: string) {
    super(`AI feature ${featureKey} is disabled`);
    this.name = 'AiFeatureDisabledError';
  }
}

/**
 * The global kill switch is engaged. A kind of "disabled", so code that already handles a
 * disabled feature handles this too; the metered reason says which.
 */
export class AiKillSwitchEngagedError extends AiFeatureDisabledError {
  constructor(featureKey: string) {
    super(featureKey);
    this.message = `AI is stopped by the global kill switch (${featureKey})`;
    this.name = 'AiKillSwitchEngagedError';
  }
}

export class AiCapExceededError extends Error {
  constructor(featureKey: string, readonly cap: number) {
    super(`AI feature ${featureKey} has reached its cap of ${cap}`);
    this.name = 'AiCapExceededError';
  }
}

export class AiInputTooLargeError extends Error {
  constructor(featureKey: string) {
    super(`assembled prompt for ${featureKey} exceeds its configured limit`);
    this.name = 'AiInputTooLargeError';
  }
}

/** Counts generations already made in the current window. Backed by the database. */
export interface UsageCounter {
  count(input: { readonly featureKey: string; readonly window: 'DAY' | 'MONTH' }): Promise<number>;
  record(input: {
    readonly featureKey: string;
    readonly subjectUserId?: string | undefined;
    readonly promptKey: string;
    readonly promptVersion: number;
    readonly providerKey: string;
    readonly model: string;
    readonly usage: InferenceUsage;
    readonly correlationId: string;
    readonly outcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
    readonly failureClass?: string;
    /** Provider wall time, retries included. Absent when no call was made. */
    readonly latencyMs?: number | undefined;
    /** HTTP attempts made. Absent when no call was made. */
    readonly attempts?: number | undefined;
  }): Promise<void>;
}

export interface OrchestratorOptions {
  readonly provider: InferenceProvider;
  readonly prompts: PromptRegistry;
  readonly usage: UsageCounter;
  /** Resolves a feature's flag and cap. Absent feature means disabled, never enabled. */
  readonly policy: (featureKey: string) => Promise<AiFeaturePolicy | undefined>;
  /**
   * Whether the global kill switch is engaged (OPS-12). Checked before the feature's own switch
   * on every call, so the refusal says why. Absent means "no kill switch to consult", which only
   * tests should rely on — the worker factory always supplies it.
   */
  readonly killSwitchEngaged?: () => Promise<boolean>;
  /** Stamped on every row so a change of serving stack is visible in the data. */
  readonly generatorVersion: string;
  readonly now?: () => Date;
}

export class AiOrchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  /**
   * Produce one draft.
   *
   * Order matters: kill switch, flag, then cap, then size, then the call. Each refusal is metered
   * too — a feature that is refusing constantly is a thing to know about, and a refusal
   * that leaves no trace looks identical to nobody using it.
   */
  async generate(request: GenerationRequest): Promise<GenerationRecord> {
    const policy = await this.options.policy(request.featureKey);
    // An unknown feature resolves to off. A typo in a feature key must never be the
    // thing that switches inference on.
    //
    // An unknown feature is also the one refusal that is NOT metered, and the reason is
    // worth stating: metering writes a row against a feature, and there is no feature to
    // write it against. The store enforces that with a foreign key, which is a guarantee
    // worth more than the telemetry — a metering row for `careeer.summary` would be a
    // record of a feature that has never existed and has no cap. An unknown key is a
    // programming error, and it surfaces as this exception rather than as usage data.
    if (!policy) throw new AiFeatureDisabledError(request.featureKey);
    if (this.options.killSwitchEngaged && await this.options.killSwitchEngaged()) {
      await this.meter(request, policy, 'REFUSED', 'KILL_SWITCH_ENGAGED');
      throw new AiKillSwitchEngagedError(request.featureKey);
    }
    if (!policy.enabled) {
      // A configured-but-off feature is different: somebody turned it off deliberately,
      // and calls still arriving is a thing to know.
      await this.meter(request, policy, 'REFUSED', 'FEATURE_DISABLED');
      throw new AiFeatureDisabledError(request.featureKey);
    }

    const used = await this.options.usage.count({ featureKey: policy.featureKey, window: policy.window });
    if (used >= policy.cap) {
      await this.meter(request, policy, 'REFUSED', 'CAP_EXCEEDED');
      throw new AiCapExceededError(policy.featureKey, policy.cap);
    }

    const prompt: PromptVersion = this.options.prompts.get(request.promptKey, request.promptVersion);
    const rendered = renderPrompt(prompt, request.parameters);
    if (rendered.system.length + rendered.user.length > policy.maxInputChars) {
      await this.meter(request, policy, 'REFUSED', 'INPUT_TOO_LARGE');
      throw new AiInputTooLargeError(policy.featureKey);
    }

    let result;
    try {
      result = await this.options.provider.complete({
        model: policy.model,
        maxOutputTokens: prompt.maxOutputTokens,
        temperature: prompt.temperature,
        messages: [
          { role: 'system', content: rendered.system },
          { role: 'user', content: rendered.user },
        ],
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      const known = error instanceof InferenceProviderError ? error : undefined;
      await this.meter(request, policy, 'FAILED', known?.failureClass ?? 'PROVIDER_FAILED', {
        latencyMs: known?.latencyMs,
        attempts: known?.attempts,
      });
      // Rethrown, never swallowed: there is no acceptable substitute output here. The typed
      // provider errors carry fixed messages only — never the upstream body or the key.
      throw error;
    }

    await this.options.usage.record({
      featureKey: policy.featureKey,
      subjectUserId: request.subjectUserId,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      providerKey: this.options.provider.providerKey,
      model: result.model,
      usage: result.usage,
      correlationId: request.correlationId,
      outcome: 'SUCCEEDED',
      latencyMs: result.latencyMs,
      attempts: result.attempts,
    });

    return {
      featureKey: policy.featureKey,
      text: result.text,
      source: 'AI_GENERATED',
      generatorVersion: this.options.generatorVersion,
      promptVersion: `${prompt.key}@${prompt.version}`,
      promptFingerprint: promptFingerprint(prompt),
      reviewState: 'DRAFT',
      generatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      usage: result.usage,
      // A truncated draft is still a draft, but the reviewer should be told it stopped
      // because it ran out of room rather than because it had finished.
      truncated: result.stopReason === 'MAX_TOKENS',
      latencyMs: result.latencyMs ?? null,
    };
  }

  private async meter(
    request: GenerationRequest,
    policy: AiFeaturePolicy,
    outcome: 'REFUSED' | 'FAILED',
    failureClass: string,
    timing: { readonly latencyMs?: number | undefined; readonly attempts?: number | undefined } = {},
  ): Promise<void> {
    await this.options.usage.record({
      featureKey: request.featureKey,
      subjectUserId: request.subjectUserId,
      promptKey: request.promptKey,
      promptVersion: request.promptVersion,
      providerKey: this.options.provider.providerKey,
      model: policy.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      correlationId: request.correlationId,
      outcome,
      failureClass,
      ...(timing.latencyMs === undefined ? {} : { latencyMs: timing.latencyMs }),
      ...(timing.attempts === undefined ? {} : { attempts: timing.attempts }),
    });
  }
}
