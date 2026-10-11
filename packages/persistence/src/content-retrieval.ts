/**
 * Tenant-scoped retrieval over approved content, for the tutor (ENG-24). Worker-only.
 *
 * Why this exists: the tutor may be shown approved lesson passages to ground a hint, and the acceptance
 * rule is that it never returns another tenant's private content. Three things make that hold here, in
 * one query, every time:
 *  - the reader's institutions are derived in SQL from their ACTIVE institution_student_profiles — the
 *    caller passes only the student, so it cannot widen the scope;
 *  - a chunk is returned only if it is global or owned by one of those institutions, and its owner still
 *    matches its revision's;
 *  - its revision is in content_retrieval_sources right now (0114), so archived, rolled-back or replaced
 *    content is excluded the moment it changes, whatever the embedding job has or has not done.
 * Vectors are compared only with vectors of the same model, recipe and length; any mismatch returns no
 * passages, with a reason, never a cross-model comparison.
 *
 * The query embedding is a model call, so this runs only in a worker or job, through ONE AI Orchestration
 * (the `tutor.retrieval` switch and cap, the kill switch, metering). Nothing under apps/ may import it
 * (inference-boundary.spec.ts). It never throws for an AI reason: the caller's fallback is the human path.
 *
 * Not yet called by the tutor hint job: that needs `tutor-hint@3` and its evaluation (design, Decision 8).
 * Design: docs/architecture/content-retrieval-design.md.
 */
import type { Pool, PoolClient } from 'pg';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  EmbeddingVectorUnusableError,
  InferenceProviderError,
  InferenceUnconfiguredError,
  TUTOR_RETRIEVAL_FEATURE_KEY,
  currentEmbeddingRecipe,
  embeddingVersionOf,
  normaliseEmbedding,
  queryForEmbedding,
  type EmbeddingGenerationRequest,
  type EmbeddingRecipe,
  type EmbeddingRecord,
} from '@planthepath/ai-orchestration/src/index.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** At most this many passages, and this many characters in all, go to the tutor. */
export const TUTOR_RETRIEVAL_MAX_PASSAGES = 3;
export const TUTOR_RETRIEVAL_MAX_CHARS = 3000;
/** The query is cut to this before it is embedded; the feature's own input limit is 2,000. */
const QUERY_LIMIT = 1800;

export interface RetrievedPassage {
  readonly contentRevisionId: string;
  readonly chunkIndex: number;
  readonly language: string;
  readonly text: string;
  /** Cosine similarity with the query, -1 to 1. Ordering only; never shown to anyone. */
  readonly score: number;
  readonly tenantScope: 'GLOBAL' | 'INSTITUTION';
}

export type RetrievalUnavailableReason =
  | 'QUERY_EMPTY'
  | 'FEATURE_DISABLED'
  | 'CAP_REACHED'
  | 'INPUT_TOO_LARGE'
  | 'ENDPOINT_UNCONFIGURED'
  | 'PROVIDER_FAILED'
  | 'NO_INDEX_FOR_MODEL';

export type RetrievalOutcome =
  | { readonly state: 'OK'; readonly passages: readonly RetrievedPassage[]; readonly model: string; readonly embeddingVersion: string }
  | { readonly state: 'UNAVAILABLE'; readonly reason: RetrievalUnavailableReason };

export interface RetrievalRequest {
  readonly db: Queryable;
  /** ONE AI Orchestration's `embed` (createWorkerAiOrchestrator), or a test's. */
  readonly embed: (request: EmbeddingGenerationRequest) => Promise<EmbeddingRecord>;
  /** The student the passages are for. Their tenant scope is derived from this, never passed. */
  readonly subjectUserId: string;
  readonly query: string;
  /** Languages wanted, in order of preference (e.g. the hint's language, then 'en'). Default English. */
  readonly languages?: readonly string[];
  readonly maxPassages?: number;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly recipe?: EmbeddingRecipe;
}

function unavailableReason(error: unknown): RetrievalUnavailableReason | null {
  if (error instanceof AiCapExceededError) return 'CAP_REACHED';
  if (error instanceof AiFeatureDisabledError) return 'FEATURE_DISABLED';
  if (error instanceof AiInputTooLargeError) return 'INPUT_TOO_LARGE';
  if (error instanceof InferenceUnconfiguredError) return 'ENDPOINT_UNCONFIGURED';
  if (error instanceof InferenceProviderError || error instanceof EmbeddingVectorUnusableError) return 'PROVIDER_FAILED';
  return null;
}

export async function retrieveApprovedContent(request: RetrievalRequest): Promise<RetrievalOutcome> {
  const recipe = request.recipe ?? currentEmbeddingRecipe;
  const embeddingVersion = embeddingVersionOf(recipe);
  const query = queryForEmbedding(recipe, request.query.slice(0, QUERY_LIMIT));
  if (!query.trim()) return { state: 'UNAVAILABLE', reason: 'QUERY_EMPTY' };

  let record: EmbeddingRecord;
  let vector: number[];
  try {
    record = await request.embed({
      featureKey: TUTOR_RETRIEVAL_FEATURE_KEY,
      recipe,
      inputs: [query],
      subjectUserId: request.subjectUserId,
      correlationId: request.correlationId,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    vector = normaliseEmbedding(record.vectors[0] ?? []);
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason) return { state: 'UNAVAILABLE', reason };
    throw error;
  }

  const limit = Math.max(1, Math.min(TUTOR_RETRIEVAL_MAX_PASSAGES, Math.floor(request.maxPassages ?? TUTOR_RETRIEVAL_MAX_PASSAGES)));
  const languages = request.languages?.length ? [...request.languages] : ['en'];
  const found = (await request.db.query<{
    content_revision_id: string; chunk_index: number; language: string; chunk_text: string; score: number; tenant_scope: 'GLOBAL' | 'INSTITUTION';
  }>(
    `SELECT e.content_revision_id::text AS content_revision_id, e.chunk_index, e.language, e.chunk_text, e.tenant_scope,
            (SELECT sum(a::float8 * b::float8) FROM unnest(e.embedding, $4::real[]) AS t(a, b))::float8 AS score
     FROM content_embeddings e
     JOIN content_retrieval_sources s ON s.content_revision_id = e.content_revision_id
     WHERE e.embedding_model = $1 AND e.embedding_version = $2 AND e.dimensions = $3
       AND e.language = ANY($5::text[])
       AND s.owner_institution_id IS NOT DISTINCT FROM e.owner_institution_id
       AND (e.owner_institution_id IS NULL OR e.owner_institution_id IN (
             SELECT p.institution_id FROM institution_student_profiles p
             WHERE p.student_user_id = $6::uuid AND p.status = 'ACTIVE'))
     ORDER BY score DESC, e.content_revision_id, e.chunk_index
     LIMIT $7`,
    [record.model, embeddingVersion, vector.length, vector, languages, request.subjectUserId, limit],
  )).rows;

  if (!found.length) {
    const [index] = (await request.db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM content_embeddings WHERE embedding_model = $1 AND embedding_version = $2 AND dimensions = $3) AS present`,
      [record.model, embeddingVersion, vector.length],
    )).rows;
    if (!index?.present) return { state: 'UNAVAILABLE', reason: 'NO_INDEX_FOR_MODEL' };
  }

  const passages: RetrievedPassage[] = [];
  let used = 0;
  for (const row of found) {
    if (used + row.chunk_text.length > TUTOR_RETRIEVAL_MAX_CHARS) break;
    used += row.chunk_text.length;
    passages.push({
      contentRevisionId: row.content_revision_id,
      chunkIndex: Number(row.chunk_index),
      language: row.language,
      text: row.chunk_text,
      score: Number(row.score),
      tenantScope: row.tenant_scope,
    });
  }
  return { state: 'OK', passages, model: record.model, embeddingVersion };
}
