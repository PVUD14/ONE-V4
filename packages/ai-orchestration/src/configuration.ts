/**
 * Where ONE's inference endpoint comes from: three server environment variables, all or nothing.
 *
 * ADR-047 puts the endpoint and its key in the server's environment, never in the repository or
 * a database row. This file is the one place their names are read. Blank means "AI unavailable":
 * every call becomes a metered PROVIDER_UNCONFIGURED failure, and nothing crashes on start.
 *
 * `describeInferenceConfiguration` is what AI Operations may see: whether each part is set, the
 * endpoint's host and the model id — never the key, never the full URL.
 * Design: docs/architecture/inference-adapter-design.md §1.
 */
import {
  OpenAICompatibleProvider,
  UnconfiguredEmbeddingProvider,
  UnconfiguredInferenceProvider,
  type EmbeddingProvider,
  type FetchLike,
  type InferenceProvider,
} from './provider.js';

export const inferenceEnvironmentVariables = {
  baseUrl: 'ONE_AI_BASE_URL',
  apiKey: 'ONE_AI_API_KEY',
  model: 'ONE_AI_MODEL',
} as const;

/**
 * ENG-24: the embedding endpoint, also all or nothing. Separate from the chat endpoint because a vLLM
 * server serves one model, so the embedding model is a second endpoint (or a second port on the pod).
 * The key may be the same value as ONE_AI_API_KEY; it is still named on its own so neither is assumed.
 */
export const embeddingEnvironmentVariables = {
  baseUrl: 'ONE_AI_EMBEDDING_BASE_URL',
  apiKey: 'ONE_AI_EMBEDDING_API_KEY',
  model: 'ONE_AI_EMBEDDING_MODEL',
} as const;

type EndpointVariableNames = { readonly baseUrl: string; readonly apiKey: string; readonly model: string };

export type InferenceUnconfiguredReason =
  | 'BASE_URL_MISSING'
  | 'BASE_URL_INVALID'
  | 'BASE_URL_INSECURE'
  | 'KEY_MISSING'
  | 'MODEL_MISSING';

export type InferenceConfiguration =
  | {
    readonly state: 'CONFIGURED';
    readonly baseUrl: string;
    readonly endpointHost: string;
    readonly apiKey: string;
    readonly model: string;
  }
  | {
    readonly state: 'UNCONFIGURED';
    readonly reason: InferenceUnconfiguredReason;
  };

/** The provider key recorded on every generation and probe made through this configuration. */
export const configuredProviderKey = 'openai-compatible';

type Environment = Readonly<Record<string, string | undefined>>;

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Read the three variables. Never throws; anything unusable is a reason, not an exception. */
export function readInferenceConfiguration(env: Environment = process.env, names: EndpointVariableNames = inferenceEnvironmentVariables): InferenceConfiguration {
  const rawUrl = env[names.baseUrl]?.trim() ?? '';
  const apiKey = env[names.apiKey]?.trim() ?? '';
  const model = env[names.model]?.trim() ?? '';
  if (!rawUrl) return { state: 'UNCONFIGURED', reason: 'BASE_URL_MISSING' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { state: 'UNCONFIGURED', reason: 'BASE_URL_INVALID' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { state: 'UNCONFIGURED', reason: 'BASE_URL_INVALID' };
  // Credentials, a query or a fragment in the base URL would end up in every request line and
  // every log of it. The key belongs in ONE_AI_API_KEY.
  if (url.username || url.password || url.search || url.hash) return { state: 'UNCONFIGURED', reason: 'BASE_URL_INVALID' };
  // A bearer key is never sent in clear text, except to this machine.
  if (url.protocol === 'http:' && !loopbackHosts.has(url.hostname)) return { state: 'UNCONFIGURED', reason: 'BASE_URL_INSECURE' };
  if (!apiKey) return { state: 'UNCONFIGURED', reason: 'KEY_MISSING' };
  if (!model) return { state: 'UNCONFIGURED', reason: 'MODEL_MISSING' };

  return {
    state: 'CONFIGURED',
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    endpointHost: url.host,
    apiKey,
    model,
  };
}

export interface InferenceAdapterTuning {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * The provider a worker should use. Unconfigured → `UnconfiguredInferenceProvider`, so a blank
 * environment is a refusal at call time rather than a crash at start.
 */
export function inferenceProviderFromEnvironment(
  env: Environment = process.env,
  tuning: InferenceAdapterTuning = {},
): { readonly provider: InferenceProvider; readonly configuration: InferenceConfiguration } {
  const configuration = readInferenceConfiguration(env);
  if (configuration.state === 'UNCONFIGURED') {
    return { provider: new UnconfiguredInferenceProvider(configuration.reason), configuration };
  }
  return {
    configuration,
    provider: new OpenAICompatibleProvider({
      baseUrl: configuration.baseUrl,
      apiKey: configuration.apiKey,
      model: configuration.model,
      providerKey: configuredProviderKey,
      ...tuning,
    }),
  };
}

/** ENG-24: the embedding endpoint's configuration, by the same rules as the chat endpoint's. */
export function readEmbeddingConfiguration(env: Environment = process.env): InferenceConfiguration {
  return readInferenceConfiguration(env, embeddingEnvironmentVariables);
}

/**
 * ENG-24: the embedding provider a worker or offline job should use. Unconfigured →
 * `UnconfiguredEmbeddingProvider`, a typed refusal at call time rather than a crash at start.
 */
export function embeddingProviderFromEnvironment(
  env: Environment = process.env,
  tuning: InferenceAdapterTuning = {},
): { readonly provider: EmbeddingProvider; readonly configuration: InferenceConfiguration } {
  const configuration = readEmbeddingConfiguration(env);
  if (configuration.state === 'UNCONFIGURED') {
    return { provider: new UnconfiguredEmbeddingProvider(configuration.reason), configuration };
  }
  return {
    configuration,
    provider: new OpenAICompatibleProvider({
      baseUrl: configuration.baseUrl,
      apiKey: configuration.apiKey,
      model: configuration.model,
      providerKey: configuredProviderKey,
      ...tuning,
    }),
  };
}

/** What may leave the server about the endpoint. The key is reported only as set or not set. */
export interface InferenceConfigurationView {
  readonly configured: boolean;
  readonly reason: InferenceUnconfiguredReason | null;
  readonly providerKey: string;
  readonly endpointHost: string | null;
  readonly model: string | null;
  readonly keyConfigured: boolean;
}

export function describeInferenceConfiguration(env: Environment = process.env): InferenceConfigurationView {
  const configuration = readInferenceConfiguration(env);
  const keyConfigured = Boolean(env[inferenceEnvironmentVariables.apiKey]?.trim());
  const model = env[inferenceEnvironmentVariables.model]?.trim() || null;
  if (configuration.state === 'CONFIGURED') {
    return { configured: true, reason: null, providerKey: configuredProviderKey, endpointHost: configuration.endpointHost, model: configuration.model, keyConfigured: true };
  }
  return { configured: false, reason: configuration.reason, providerKey: 'unconfigured', endpointHost: null, model, keyConfigured };
}
