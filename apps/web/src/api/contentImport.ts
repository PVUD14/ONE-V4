/**
 * ONE · API client — Operations content bulk import (OPS-09d).
 *
 * A CSV or JSON file of skills, questions, lessons or lesson variants: preview returns a row-level
 * validation report and a digest and writes no content; commit writes exactly the previewed file,
 * all rows or none, every row a DRAFT authored by the importer. A commit refused because a row is
 * invalid (400 IMPORT_HAS_INVALID_ROWS) or the file or content changed (409 IMPORT_STALE) writes
 * nothing; the screen previews again. The report never carries a row's text.
 */
import { requestJson } from './http.js';

export type ContentImportKind = 'SKILL' | 'QUESTION' | 'LESSON' | 'LESSON_VARIANT';
export type ContentImportFormat = 'CSV' | 'JSON';

export interface ContentImportPolicyDto {
  readonly kinds: readonly { readonly kind: ContentImportKind; readonly required: readonly string[]; readonly optional: readonly string[] }[];
  readonly formats: readonly ContentImportFormat[];
  readonly limits: { readonly rows: number; readonly characters: number; readonly filename: number };
  readonly reasons: readonly string[];
  readonly correlationId: string;
}

export interface ContentImportRowDto {
  readonly rowNumber: number;
  readonly key: string;
  readonly outcome: 'CREATE' | 'INVALID';
  readonly issues: readonly string[];
}

export interface ContentImportReportDto {
  readonly kind: ContentImportKind;
  readonly format: ContentImportFormat;
  readonly digest: string;
  readonly rowCount: number;
  readonly counts: { readonly create: number; readonly invalid: number };
  readonly fileProblems: readonly string[];
  readonly rows: readonly ContentImportRowDto[];
}

export interface ContentImportUpload {
  readonly kind: ContentImportKind;
  readonly format: ContentImportFormat;
  readonly filename: string;
  readonly content: string;
}

const base = '/api/v1/operations/content-imports';

export function getContentImportPolicy(token: string, signal?: AbortSignal): Promise<ContentImportPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...(signal ? { signal } : {}) });
}

export function previewContentImport(token: string, body: ContentImportUpload): Promise<{ readonly preview: ContentImportReportDto; readonly correlationId: string }> {
  return requestJson(`${base}/preview`, { token, method: 'POST', body });
}

export function commitContentImport(token: string, body: ContentImportUpload & { readonly previewDigest: string; readonly reasonCode: string }): Promise<{
  readonly import: { readonly reference: string; readonly kind: ContentImportKind; readonly created: number; readonly keys: readonly string[] };
  readonly correlationId: string;
}> {
  return requestJson(`${base}/commit`, { token, method: 'POST', body });
}
