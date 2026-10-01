/**
 * ONE AI evaluation (ENG-21): the evaluation set, the automatic checks, the scoring against each
 * feature's thresholds, the human review sheet and the cost estimate behind every `ai_evaluations`
 * record a bake-off produces.
 *
 * Pure apart from `repository.ts` (which reads the packs in data/engine). Nothing here calls a
 * model, touches a database or records anything; `ai:bake-off-import` in packages/persistence does
 * the recording, as an operator.
 *
 * Design: docs/architecture/ai-bake-off-design.md
 */
export * from './set-format.js';
export * from './cases.js';
export * from './build-set.js';
export * from './checks.js';
export * from './content-guard.js';
export * from './thresholds.js';
export * from './results.js';
export * from './cost.js';
export * from './review.js';
export * from './score.js';
export * from './report.js';
export * from './repository.js';
export * from './cli/options.js';
