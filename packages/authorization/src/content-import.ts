/**
 * Content bulk import rules (OPS-09d, Appendix 1 §3 Content, §5.3).
 *
 * Who may preview and commit a bulk import of skills, questions, lessons or lesson variants, and
 * the reason codes a commit carries — declared once, as data and pure functions, so the API and the
 * web screen agree. An import is authoring: CONTENT_EDIT. Every row lands as a DRAFT authored by the
 * importer, so the editors' own contributor rule keeps the importer from reviewing or publishing it;
 * nothing here publishes, and no import needs an approval (dual control stays at publish).
 *
 * Design: docs/architecture/content-bulk-import-design.md
 */
import { hasInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** §5.3: why a batch of drafts is being imported. Carried into every row's audit row. */
export const contentImportReasons = ['TRACK_BUILD', 'CONTENT_MIGRATION', 'EXPERT_BATCH'] as const;
export type ContentImportReason = (typeof contentImportReasons)[number];

export function isContentImportReason(value: unknown): value is ContentImportReason {
  return typeof value === 'string' && (contentImportReasons as readonly string[]).includes(value);
}

/** Importing is authoring: only CONTENT_EDIT previews or commits, on an ACTIVE platform membership. */
export function canImportContent(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'CONTENT_EDIT');
}
