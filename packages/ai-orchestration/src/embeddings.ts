/**
 * ENG-24: how ONE turns approved content into embedding inputs, and the two embedding features.
 *
 * Why this exists: a vector is only comparable with vectors made the same way — same model, same
 * chunking, same input prefix. That "same way" is the recipe, and it is versioned in code next to the
 * prompts for the same reason prompts are: a recipe edited in place would silently mix incomparable
 * vectors in one index. Changing anything here is a new version, and the embedding job re-embeds.
 *
 * Pure: no database, no network, no clock. Design: docs/architecture/content-retrieval-design.md
 * (Decisions 6 and 7); ADR-050.
 */

export interface EmbeddingRecipe {
  readonly key: string;
  readonly version: number;
  readonly purpose: string;
  /** Upper bound on one chunk, title line included. */
  readonly maxChunkChars: number;
  /** A revision with more text than this many chunks is refused rather than silently truncated. */
  readonly maxChunksPerSource: number;
  /** Prepended to a passage before it is embedded (some models want "passage: "). Part of the version. */
  readonly passagePrefix: string;
  /** Prepended to a query before it is embedded (some models want "query: "). Part of the version. */
  readonly queryPrefix: string;
}

export const contentEmbeddingRecipeV1: EmbeddingRecipe = {
  key: 'content-embedding',
  version: 1,
  purpose: 'Approved lesson text, as the lesson title then up to 1,200 characters of paragraph-packed text per chunk, for tutor retrieval.',
  maxChunkChars: 1200,
  maxChunksPerSource: 64,
  passagePrefix: '',
  queryPrefix: '',
};

/** The recipe the job writes and retrieval reads. */
export const currentEmbeddingRecipe = contentEmbeddingRecipeV1;

/** Every recipe a feature may name as its prompt, so AI Operations resolves it like a registered prompt. */
export const registeredEmbeddingRecipes: readonly EmbeddingRecipe[] = [contentEmbeddingRecipeV1];

/** `content-embedding@1`: what `content_embeddings.embedding_version` and `prompt_version` hold. */
export function embeddingVersionOf(recipe: EmbeddingRecipe): string {
  return `${recipe.key}@${recipe.version}`;
}

export class ContentTooLongForEmbeddingError extends Error {
  constructor() {
    super('the content needs more chunks than the embedding recipe allows');
    this.name = 'ContentTooLongForEmbeddingError';
  }
}

const TITLE_LIMIT = 200;

/** Collapse runs of spaces and tabs inside a line; keep paragraph breaks. */
function tidy(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').map((line) => line.replace(/[ \t]+/gu, ' ').trim()).join('\n').trim();
}

/** Split a paragraph that is too long on sentence ends, then, if a sentence is still too long, by length. */
function splitLong(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const sentences = paragraph.split(/(?<=[.!?।])\s+/u);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current) { pieces.push(current); current = ''; }
      for (let start = 0; start < sentence.length; start += limit) pieces.push(sentence.slice(start, start + limit));
      continue;
    }
    const joined = current ? `${current} ${sentence}` : sentence;
    if (joined.length > limit) { pieces.push(current); current = sentence; } else current = joined;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * The passages of one source, each "title, blank line, text", every one at most `maxChunkChars`.
 * Paragraphs are packed greedily in order; nothing is dropped or overlapped. Deterministic: the same
 * content and recipe always give the same chunks. A source with no text but a title is one chunk of its
 * title; one with neither has no chunks.
 */
export function chunkForEmbedding(recipe: EmbeddingRecipe, source: { readonly title: string; readonly sections: readonly (string | null)[] }): string[] {
  const title = tidy(source.title).replace(/\n+/gu, ' ').slice(0, TITLE_LIMIT);
  const paragraphs = source.sections
    .filter((section): section is string => typeof section === 'string')
    .flatMap((section) => tidy(section).split(/\n\s*\n/u))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const lead = title ? `${title}\n\n` : '';
  const room = recipe.maxChunkChars - recipe.passagePrefix.length - lead.length;
  if (paragraphs.length === 0) return title ? [`${recipe.passagePrefix}${title}`] : [];

  const bodies: string[] = [];
  let current = '';
  for (const piece of paragraphs.flatMap((paragraph) => splitLong(paragraph, room))) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length > room) { bodies.push(current); current = piece; } else current = joined;
  }
  if (current) bodies.push(current);
  if (bodies.length > recipe.maxChunksPerSource) throw new ContentTooLongForEmbeddingError();
  return bodies.map((body) => `${recipe.passagePrefix}${lead}${body}`);
}

/** The text a query is embedded as. */
export function queryForEmbedding(recipe: EmbeddingRecipe, query: string): string {
  return `${recipe.queryPrefix}${tidy(query)}`;
}

export class EmbeddingVectorUnusableError extends Error {
  constructor() {
    super('an embedding vector was empty, zero or not finite');
    this.name = 'EmbeddingVectorUnusableError';
  }
}

/** Scale to unit length so the inner product is the cosine. A zero or non-finite vector is unusable. */
export function normaliseEmbedding(vector: readonly number[]): number[] {
  if (vector.length === 0 || !vector.every((value) => Number.isFinite(value))) throw new EmbeddingVectorUnusableError();
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingVectorUnusableError();
  return vector.map((value) => value / norm);
}

export interface EmbeddingFeatureDeclaration {
  readonly featureKey: string;
  readonly description: string;
  readonly defaultModel: string;
  readonly defaultCap: number;
  readonly defaultWindow: 'DAY' | 'MONTH';
  readonly maxInputChars: number;
  readonly recipe: EmbeddingRecipe;
}

/**
 * No embedding model has been chosen or is served yet. A real endpoint refuses a call naming this id,
 * and switching a feature on needs a passing evaluation for the model it names (0089), so the features
 * cannot run until a model is chosen and evaluated.
 */
export const embeddingModelNotChosen = 'embedding-model-not-chosen';

export const CONTENT_EMBEDDINGS_FEATURE_KEY = 'content.embeddings';
export const TUTOR_RETRIEVAL_FEATURE_KEY = 'tutor.retrieval';

/** Declared, never enabled: registration inserts a missing policy row switched off. */
export const oneEmbeddingFeatures: readonly EmbeddingFeatureDeclaration[] = [
  {
    featureKey: CONTENT_EMBEDDINGS_FEATURE_KEY,
    description: 'Content retrieval: the offline job that embeds approved lesson text, one call per revision (ENG-24). Off until a model is chosen and evaluated.',
    defaultModel: embeddingModelNotChosen, defaultCap: 2000, defaultWindow: 'DAY', maxInputChars: 80000,
    recipe: contentEmbeddingRecipeV1,
  },
  {
    featureKey: TUTOR_RETRIEVAL_FEATURE_KEY,
    description: 'Tutor retrieval: embeds the question to find approved lesson passages in the student\'s scope (ENG-24). Off until evaluated.',
    defaultModel: embeddingModelNotChosen, defaultCap: 1000, defaultWindow: 'DAY', maxInputChars: 2000,
    recipe: contentEmbeddingRecipeV1,
  },
];
