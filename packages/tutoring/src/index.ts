/**
 * ONE tutoring (ENG-22): the hint policy, the tutoring brief and the reply guard for the practice
 * tutor. Pure — nothing here touches a database, calls a model or reads readiness; the request
 * (packages/persistence/src/tutor-hints.ts) and the job (tutor-hint-worker.ts) use these rules.
 *
 * Design: docs/architecture/tutor-hints-table-design.md
 */
export * from './policy.js';
export * from './brief.js';
export * from './guard.js';
export * from './arithmetic.js';
