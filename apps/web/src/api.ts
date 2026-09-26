/**
 * ONE · API client — barrel.
 *
 * The client is split into per-domain modules under ./api/ so that each stream
 * appends to its own file instead of all five appending here. This file re-exports
 * every public module, so `import { ... } from './api.js'` keeps working exactly
 * as before and no calling site needed to change.
 *
 * Add new functions to the domain module you own, not to this file.
 * The shared request helper lives in ./api/http.ts and is intentionally private.
 */
export * from './api/core.js';
export * from './api/careerReadiness.js';
export * from './api/student.js';
export * from './api/privacy.js';
export * from './api/operations.js';
export * from './api/support.js';
export * from './api/institution.js';
export * from './api/hiring.js';
export * from './api/assessments.js';
export * from './api/assistant.js';
export * from './api/platform.js';
export * from './api/systemHealth.js';
export * from './api/privacyOperations.js';
export * from './api/operationsOverview.js';
export * from './api/careerCatalogue.js';
export * from './api/roleDemand.js';
export * from './api/skillMap.js';
