/**
 * The content embedding job (ENG-24): embeds approved, current lesson text into `content_embeddings`.
 * Worker and offline only.
 *
 * Why this exists: tutor retrieval (content-retrieval.ts) needs vectors of the approved content a student
 * may be shown. This job is the only writer of those vectors. It reads only `content_retrieval_sources`
 * (0114: PUBLISHED, released, current lessons) — and the table's trigger refuses anything else — chunks
 * each revision by the current recipe, embeds it through ONE AI Orchestration (kill switch, the
 * `content.embeddings` switch and cap, metering), and writes one revision's chunks in one statement, so a
 * revision is embedded wholly or not at all. Reruns are idempotent; `REBUILD` starts from an empty index.
 *
 * With the feature off, the kill switch engaged or no embedding endpoint configured, it does nothing at all
 * and says so. Withdrawn content does not depend on this job: retrieval re-checks approval live, and the
 * prune here is housekeeping.
 *
 * Like ai-workers.ts, nothing under apps/ may import this (inference-boundary.spec.ts).
 * Design: docs/architecture/content-retrieval-design.md; ADR-050.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  CONTENT_EMBEDDINGS_FEATURE_KEY,
  ContentTooLongForEmbeddingError,
  EmbeddingVectorUnusableError,
  InferenceProviderError,
  InferenceUnconfiguredError,
  chunkForEmbedding,
  currentEmbeddingRecipe,
  embeddingVersionOf,
  maxEmbeddingInputsPerCall,
  normaliseEmbedding,
  oneEmbeddingFeatures,
  type EmbeddingFeatureDeclaration,
  type EmbeddingGenerationRequest,
  type EmbeddingRecipe,
  type EmbeddingRecord,
} from '@planthepath/ai-orchestration/src/index.js';
import { readLessonDraftFields, readLessonIdentity } from '@planthepath/career-readiness';
import { loadAiFeaturePolicy } from './ai-orchestration.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Register the two embedding features as policy rows, switched off, naming the recipe they run as their
 * prompt so 0089 can require a passing evaluation for it. Inserts only missing rows; never changes or
 * switches on an existing one.
 */
export async function registerOneEmbeddingFeatures(db: Queryable, features: readonly EmbeddingFeatureDeclaration[] = oneEmbeddingFeatures): Promise<{ readonly registered: readonly string[] }> {
  const registered: string[] = [];
  for (const feature of features) {
    const inserted = await db.query(
      `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feature_key) DO NOTHING RETURNING feature_key`,
      [feature.featureKey, feature.description, feature.defaultModel, feature.defaultCap, feature.defaultWindow, feature.maxInputChars,
        feature.recipe.key, feature.recipe.version],
    );
    if (inserted.rowCount) registered.push(feature.featureKey);
  }
  return { registered };
}

export type ContentEmbeddingUnavailableReason = 'FEATURE_NOT_REGISTERED' | 'FEATURE_DISABLED' | 'ENDPOINT_UNCONFIGURED';
export type ContentEmbeddingStopReason = 'CAP_REACHED' | 'FEATURE_DISABLED' | 'ENDPOINT_UNCONFIGURED' | 'PROVIDER_FAILED';

export type ContentEmbeddingRun =
  | { readonly state: 'UNAVAILABLE'; readonly reason: ContentEmbeddingUnavailableReason }
  | {
    readonly state: 'COMPLETED' | 'STOPPED';
    readonly mode: 'INCREMENTAL' | 'REBUILD';
    readonly model: string;
    readonly embeddingVersion: string;
    /** Rows removed before embedding: withdrawn content, another model or recipe, or everything on a rebuild. */
    readonly pruned: number;
    readonly embeddedRevisions: number;
    readonly chunksWritten: number;
    /** Revisions left out this run, by why. None of them blocks the others. */
    readonly skipped: { readonly empty: number; readonly tooLong: number; readonly withdrawnDuringRun: number };
    readonly stopReason: ContentEmbeddingStopReason | null;
    /** The provider's failure class when it was the reason; never its message. */
    readonly failureClass: string | null;
  };

export interface ContentEmbeddingJobOptions {
  readonly db: Queryable;
  /** ONE AI Orchestration's `embed` (createWorkerAiOrchestrator), or a test's. */
  readonly embed: (request: EmbeddingGenerationRequest) => Promise<EmbeddingRecord>;
  /** Whether ONE_AI_EMBEDDING_* is configured. False: the job does nothing. */
  readonly endpointConfigured: boolean;
  readonly mode?: 'INCREMENTAL' | 'REBUILD';
  /** At most this many revisions embedded in one run (default 500); the next run continues. */
  readonly maxRevisions?: number;
  readonly correlationId?: string;
  readonly recipe?: EmbeddingRecipe;
}

interface SourceRow {
  content_revision_id: string;
  owner_institution_id: string | null;
  content_hash: string;
  body: unknown;
}

const BATCH = 25;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function stopReasonOf(error: unknown): { reason: ContentEmbeddingStopReason; failureClass: string | null } | null {
  if (error instanceof AiCapExceededError) return { reason: 'CAP_REACHED', failureClass: null };
  // The kill switch is a kind of disabled.
  if (error instanceof AiFeatureDisabledError) return { reason: 'FEATURE_DISABLED', failureClass: null };
  if (error instanceof InferenceUnconfiguredError) return { reason: 'ENDPOINT_UNCONFIGURED', failureClass: error.failureClass };
  if (error instanceof InferenceProviderError) return { reason: 'PROVIDER_FAILED', failureClass: error.failureClass };
  if (error instanceof EmbeddingVectorUnusableError) return { reason: 'PROVIDER_FAILED', failureClass: 'PROVIDER_MALFORMED_RESPONSE' };
  return null;
}

/** The trigger's refusal when a revision stopped being approved between the select and the insert. */
const isWithdrawnRefusal = (error: unknown): boolean => error instanceof Error && /only approved, current content is embedded/u.test(error.message);

/** One run. Never throws for an AI reason: it reports why it stopped. Database errors propagate. */
export async function runContentEmbeddings(options: ContentEmbeddingJobOptions): Promise<ContentEmbeddingRun> {
  const { db } = options;
  const recipe = options.recipe ?? currentEmbeddingRecipe;
  const embeddingVersion = embeddingVersionOf(recipe);
  const mode = options.mode ?? 'INCREMENTAL';
  const correlationId = options.correlationId ?? `content-embeddings-${randomUUID()}`;

  // Read, not called: an off feature or a blank endpoint means this run does nothing at all.
  const policy = await loadAiFeaturePolicy(db, CONTENT_EMBEDDINGS_FEATURE_KEY);
  if (!policy) return { state: 'UNAVAILABLE', reason: 'FEATURE_NOT_REGISTERED' };
  if (!policy.enabled) return { state: 'UNAVAILABLE', reason: 'FEATURE_DISABLED' };
  if (!options.endpointConfigured) return { state: 'UNAVAILABLE', reason: 'ENDPOINT_UNCONFIGURED' };
  const model = policy.model;

  const pruned = mode === 'REBUILD'
    ? (await db.query('DELETE FROM content_embeddings')).rowCount ?? 0
    : (await db.query(
      `DELETE FROM content_embeddings e
       WHERE e.embedding_model <> $1 OR e.embedding_version <> $2
          OR NOT EXISTS (SELECT 1 FROM content_retrieval_sources s WHERE s.content_revision_id = e.content_revision_id)`,
      [model, embeddingVersion],
    )).rowCount ?? 0;

  const maxRevisions = Math.max(1, Math.min(10_000, Math.floor(options.maxRevisions ?? 500)));
  const passed: string[] = [];
  const skipped = { empty: 0, tooLong: 0, withdrawnDuringRun: 0 };
  let embeddedRevisions = 0;
  let chunksWritten = 0;
  const finish = (stop: { reason: ContentEmbeddingStopReason; failureClass: string | null } | null): ContentEmbeddingRun => ({
    state: stop ? 'STOPPED' : 'COMPLETED', mode, model, embeddingVersion, pruned, embeddedRevisions, chunksWritten, skipped,
    stopReason: stop?.reason ?? null, failureClass: stop?.failureClass ?? null,
  });

  while (embeddedRevisions < maxRevisions) {
    const pending = (await db.query<SourceRow>(
      `SELECT s.content_revision_id::text AS content_revision_id, s.owner_institution_id::text AS owner_institution_id, s.content_hash, s.body
       FROM content_retrieval_sources s
       WHERE NOT EXISTS (SELECT 1 FROM content_embeddings e
                         WHERE e.content_revision_id = s.content_revision_id AND e.embedding_model = $1 AND e.embedding_version = $2)
         AND NOT (s.content_revision_id = ANY($3::uuid[]))
       ORDER BY s.published_at, s.content_revision_id
       LIMIT $4`,
      [model, embeddingVersion, passed, Math.min(BATCH, maxRevisions - embeddedRevisions)],
    )).rows;
    if (!pending.length) return finish(null);

    for (const source of pending) {
      passed.push(source.content_revision_id);
      const fields = readLessonDraftFields(source.body);
      const language = readLessonIdentity(source.body).variant.language;
      let chunks: string[];
      try {
        chunks = chunkForEmbedding(recipe, { title: fields.title, sections: [fields.summary, fields.practice] });
      } catch (error) {
        if (!(error instanceof ContentTooLongForEmbeddingError)) throw error;
        skipped.tooLong += 1;
        continue;
      }
      if (!chunks.length) { skipped.empty += 1; continue; }

      let vectors: number[][];
      let record: EmbeddingRecord;
      try {
        // maxChunksPerSource equals the per-call limit for this recipe; a later recipe may need batching.
        if (chunks.length > maxEmbeddingInputsPerCall) { skipped.tooLong += 1; continue; }
        record = await options.embed({ featureKey: CONTENT_EMBEDDINGS_FEATURE_KEY, recipe, inputs: chunks, correlationId });
        vectors = record.vectors.map((vector) => normaliseEmbedding(vector));
        if (record.dimensions < 8 || record.dimensions > 4096) throw new EmbeddingVectorUnusableError();
      } catch (error) {
        if (error instanceof AiInputTooLargeError) { skipped.tooLong += 1; continue; }
        const stop = stopReasonOf(error);
        if (stop) return finish(stop);
        throw error;
      }

      const values: unknown[] = [];
      const tuples = chunks.map((text, index) => {
        const base = values.length;
        values.push(
          randomUUID(), source.content_revision_id, source.owner_institution_id, source.owner_institution_id ? 'INSTITUTION' : 'GLOBAL', language,
          index, chunks.length, text, sha256(text), source.content_hash, vectors[index], record.dimensions, record.model, embeddingVersion,
          record.generatorVersion, record.promptVersion, record.generatedAt,
        );
        const p = (offset: number): string => `$${base + offset}`;
        return `(${p(1)}::uuid, ${p(2)}::uuid, 'LESSON', ${p(3)}::uuid, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}::real[], ${p(12)}, `
          + `${p(13)}, ${p(14)}, 'AI_GENERATED', ${p(15)}, ${p(16)}, ${p(17)}::timestamptz)`;
      });
      try {
        const inserted = await db.query(
          `INSERT INTO content_embeddings (id, content_revision_id, entity_type, owner_institution_id, tenant_scope, language, chunk_index, chunk_count,
             chunk_text, chunk_hash, source_content_hash, embedding, dimensions, embedding_model, embedding_version, source, generator_version,
             prompt_version, generated_at)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (content_revision_id, embedding_model, embedding_version, chunk_index) DO NOTHING`,
          values,
        );
        chunksWritten += inserted.rowCount ?? 0;
        embeddedRevisions += 1;
      } catch (error) {
        if (!isWithdrawnRefusal(error)) throw error;
        skipped.withdrawnDuringRun += 1;
      }
      if (embeddedRevisions >= maxRevisions) break;
    }
  }
  return finish(null);
}
