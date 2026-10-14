/**
 * A deterministic fake embedding provider, for tests only. Not exported from the package index; tests
 * import this path directly, and no app may (inference-boundary contract test).
 *
 * ENG-24's retrieval tests need vectors that behave like embeddings — texts sharing words land close
 * together — without a model, a network or randomness. This hashes each word into one of `dimensions`
 * buckets (a bag of words), so the same text always gives the same vector, and a query about subnet
 * masks is nearest to the passage about subnet masks.
 */
import { InferenceModelMismatchError, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingResult } from '../provider.js';

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  /** Every request received, in order. */
  readonly requests: EmbeddingRequest[];
}

function bucket(word: string, dimensions: number): number {
  // FNV-1a: small, stable and good enough to spread words across buckets.
  let hash = 0x811c9dc5;
  for (const char of word) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % dimensions;
}

/** The fake's vector for one text: word counts by bucket, plus a small constant so no vector is zero. */
export function fakeEmbedding(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) vector[bucket(word, dimensions)]! += 1;
  vector[0]! += 0.01;
  return vector;
}

export function createFakeEmbeddingProvider(options: { readonly model?: string; readonly dimensions?: number; readonly fail?: () => Error | undefined } = {}): FakeEmbeddingProvider {
  const requests: EmbeddingRequest[] = [];
  return {
    providerKey: 'fake-embeddings',
    requests,
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      requests.push(request);
      if (options.model && request.model !== options.model) throw new InferenceModelMismatchError();
      const failure = options.fail?.();
      if (failure) throw failure;
      return {
        vectors: request.inputs.map((input) => fakeEmbedding(input, options.dimensions ?? 64)),
        model: request.model,
        usage: { inputTokens: request.inputs.reduce((total, input) => total + input.length, 0), outputTokens: 0 },
        latencyMs: 1,
        attempts: 1,
      };
    },
  };
}
