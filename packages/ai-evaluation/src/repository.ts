/**
 * The repository's own evaluation set and the one entry point that turns a results file into a
 * scorecard (ENG-21). Shared by the report command and the importer, so both compute the same
 * numbers from the same raw replies.
 *
 * Why this exists: the set the importer scores against is rebuilt from the packs in the repository,
 * never read from the committed file a person could edit; a test keeps the committed file equal to it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEvaluationSet, buildExplainEvaluationSet, contentSha256, serialiseEvaluationSet, type AptitudeBankPack, type CareerTargetPack } from './build-set.js';
import type { CostAssumptions } from './cost.js';
import { matchResultsToSet, readBakeOffResults, type BakeOffResults } from './results.js';
import { readReviewSheet } from './review.js';
import { scoreBakeOff, type Scorecard } from './score.js';
import type { EvaluationSet, EvaluationTask } from './set-format.js';
import { BakeOffResultsError } from './results.js';

const repositoryRoot = new URL('../../../', import.meta.url);

export const committedSetPath = fileURLToPath(new URL('deploy/ai-pod/bake-off/eval-set-v1.json', repositoryRoot));
/** ADR-052: the `one-ai-explain` v1 set, a file of its own so `one-ai-bakeoff` v1 never changes. */
export const committedExplainSetPath = fileURLToPath(new URL('deploy/ai-pod/bake-off/eval-set-explain-v1.json', repositoryRoot));

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, repositoryRoot), 'utf8')) as T;
}

export interface RepositorySet {
  readonly set: EvaluationSet;
  readonly text: string;
  readonly sha256: string;
}

let cached: RepositorySet | undefined;

/** The set built from data/engine/*.json. */
export function repositoryEvaluationSet(): RepositorySet {
  if (!cached) {
    const set = buildEvaluationSet(
      readJson<AptitudeBankPack>('data/engine/aptitude-bank-v1.draft.json'),
      readJson<CareerTargetPack>('data/engine/soc-analyst-l1-target-v1.draft.json'),
    );
    const text = serialiseEvaluationSet(set);
    cached = { set, text, sha256: contentSha256(text) };
  }
  return cached;
}

let explainCached: RepositorySet | undefined;

/** ADR-052: the `one-ai-explain` set, built from explain-cases.ts. */
export function repositoryExplainEvaluationSet(): RepositorySet {
  if (!explainCached) {
    const set = buildExplainEvaluationSet();
    const text = serialiseEvaluationSet(set);
    explainCached = { set, text, sha256: contentSha256(text) };
  }
  return explainCached;
}

/** Every set this repository builds, with the file each is committed as. */
export function repositoryEvaluationSets(): readonly (RepositorySet & { readonly path: string })[] {
  return [{ ...repositoryEvaluationSet(), path: committedSetPath }, { ...repositoryExplainEvaluationSet(), path: committedExplainSetPath }];
}

/** The repository's set a results file names by key (an unknown key falls to v1, whose check then refuses it). */
export function repositorySetFor(setKey: unknown): RepositorySet {
  return repositoryEvaluationSets().find((entry) => entry.set.setKey === setKey) ?? repositoryEvaluationSet();
}

export interface EvaluatedRun {
  readonly set: EvaluationSet;
  readonly results: BakeOffResults;
  readonly resultsSha256: string;
  readonly scorecard: Scorecard;
  readonly reviewed: boolean;
}

/** Parse, match and score a results file (and its review sheet, when given). Throws the typed errors. */
export function evaluateResultsText(input: {
  readonly resultsText: string;
  readonly reviewText?: string | undefined;
  readonly cost?: CostAssumptions | undefined;
  readonly featureKeys?: Partial<Readonly<Record<EvaluationTask, string>>> | undefined;
}): EvaluatedRun {
  let raw: unknown;
  try {
    raw = JSON.parse(input.resultsText);
  } catch {
    throw new BakeOffResultsError('RESULTS_MALFORMED', 'the results file is not JSON');
  }
  const results = readBakeOffResults(raw);
  const { set, text } = repositorySetFor(results.set.key);
  matchResultsToSet(results, set, text);
  const resultsSha256 = contentSha256(input.resultsText);
  let human;
  if (input.reviewText !== undefined) {
    let sheet: unknown;
    try {
      sheet = JSON.parse(input.reviewText);
    } catch {
      sheet = null;
    }
    human = readReviewSheet(sheet, set, results, resultsSha256);
  }
  const scorecard = scoreBakeOff(set, results, {
    ...(input.cost ? { cost: input.cost } : {}),
    ...(human ? { human } : {}),
    ...(input.featureKeys ? { featureKeys: input.featureKeys } : {}),
  });
  return { set, results, resultsSha256, scorecard, reviewed: human !== undefined };
}
