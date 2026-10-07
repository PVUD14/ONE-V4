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
  UnconfiguredEmbeddingProvider,
  UnconfiguredInferenceProvider,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
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
  embeddingEnvironmentVariables,
  embeddingProviderFromEnvironment,
  inferenceEnvironmentVariables,
  inferenceProviderFromEnvironment,
  readEmbeddingConfiguration,
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
  contentItemDraftPromptV1,
  contentLessonDraftPromptV1,
  contentLessonDraftPromptV2,
  firstFeaturePrompts,
  hintLevelMeanings,
  lessonDraftHeadings,
  lessonHeadingIndex,
  oneAiFeatures,
  servedModelAtRegistration,
  tutorHintPromptV1,
  tutorHintPromptV2,
  type AiFeatureDeclaration,
} from './first-features.js';

export {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  AiKillSwitchEngagedError,
  AiOrchestrator,
  maxEmbeddingInputsPerCall,
  type AiFeaturePolicy,
  type EmbeddingGenerationRequest,
  type EmbeddingRecord,
  type GenerationRecord,
  type GenerationRequest,
  type OrchestratorOptions,
  type ReviewState,
  type UsageCounter,
} from './orchestrator.js';

export {
  CONTENT_EMBEDDINGS_FEATURE_KEY,
  ContentTooLongForEmbeddingError,
  EmbeddingVectorUnusableError,
  TUTOR_RETRIEVAL_FEATURE_KEY,
  chunkForEmbedding,
  contentEmbeddingRecipeV1,
  currentEmbeddingRecipe,
  embeddingModelNotChosen,
  embeddingVersionOf,
  normaliseEmbedding,
  oneEmbeddingFeatures,
  queryForEmbedding,
  registeredEmbeddingRecipes,
  type EmbeddingFeatureDeclaration,
  type EmbeddingRecipe,
} from './embeddings.js';
