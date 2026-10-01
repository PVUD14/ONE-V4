/**
 * ONE AI Orchestration.
 *
 * Everything AI in ONE goes through here: features ask for a generation, this decides
 * whether it is allowed, which prompt version produces it, and what is recorded. The
 * inference venue is an adapter configured from the server environment (ADR-047: an
 * OpenAI-compatible endpoint on a RunPod pod), so a change of venue is configuration.
 */
export {
  AnthropicProvider,
  InferenceAuthError,
  InferenceCancelledError,
  InferenceMalformedResponseError,
  InferenceModelMismatchError,
  InferenceProviderError,
  InferenceRateLimitedError,
  InferenceTimeoutError,
  InferenceUnconfiguredError,
  InferenceUnreachableError,
  InferenceUpstreamError,
  OpenAICompatibleProvider,
  UnconfiguredInferenceProvider,
  type FetchLike,
  type InferenceFailureClass,
  type InferenceMessage,
  type InferenceProbe,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceUsage,
  type OpenAICompatibleOptions,
} from './provider.js';

export {
  configuredProviderKey,
  describeInferenceConfiguration,
  inferenceEnvironmentVariables,
  inferenceProviderFromEnvironment,
  readInferenceConfiguration,
  type InferenceAdapterTuning,
  type InferenceConfiguration,
  type InferenceConfigurationView,
  type InferenceUnconfiguredReason,
} from './configuration.js';

export {
  PromptNotFoundError,
  PromptParameterError,
  PromptRegistry,
  promptFingerprint,
  renderPrompt,
  type PromptVersion,
} from './prompts.js';

export { onePromptRegistry, registeredPrompts } from './registry.js';

export {
  contentAnswerCheckPromptV1,
  contentLessonDraftPromptV1,
  firstFeaturePrompts,
  hintLevelMeanings,
  lessonDraftHeadings,
  oneAiFeatures,
  servedModelAtRegistration,
  tutorHintPromptV1,
  type AiFeatureDeclaration,
} from './first-features.js';

export {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  AiKillSwitchEngagedError,
  AiOrchestrator,
  type AiFeaturePolicy,
  type GenerationRecord,
  type GenerationRequest,
  type OrchestratorOptions,
  type ReviewState,
  type UsageCounter,
} from './orchestrator.js';
