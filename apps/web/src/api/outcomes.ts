/**
 * API client for graduates' self-reported outcomes (INST-13).
 *
 * A student tells one college they studied at that they went on to higher studies or started a
 * venture, so the college can count it in its accreditation figures. The college never sees who: it
 * reads only suppressed counts in its accreditation export. Kept in its own file so the Profile
 * panel and its tests share one set of types.
 */
import { requestJson } from './http.js';

export type SelfReportedOutcome = 'HIGHER_STUDIES' | 'ENTREPRENEURSHIP';

export const selfReportedOutcomeLabels: Readonly<Record<SelfReportedOutcome, string>> = {
  HIGHER_STUDIES: 'Higher studies (for example a master\'s, a doctorate or another degree)',
  ENTREPRENEURSHIP: 'My own business or venture',
};

export interface OutcomeCollegeDto {
  readonly institutionId: string;
  readonly institutionName: string;
  readonly relationship: 'CURRENT' | 'GRADUATED';
  readonly graduatedOn: string | null;
  readonly declaration: { readonly id: string; readonly outcome: SelfReportedOutcome; readonly declaredAt: string } | null;
}

export function listMyOutcomeDeclarations(token: string, signal?: AbortSignal): Promise<{ readonly colleges: readonly OutcomeCollegeDto[] }> {
  return requestJson('/api/v1/students/me/outcome-declarations', { token, ...(signal ? { signal } : {}) });
}

export function shareOutcomeDeclaration(token: string, institutionId: string, outcome: SelfReportedOutcome): Promise<{ readonly colleges: readonly OutcomeCollegeDto[] }> {
  return requestJson('/api/v1/students/me/outcome-declarations', { token, method: 'POST', body: { institutionId, outcome } });
}

export function withdrawOutcomeDeclaration(token: string, declarationId: string): Promise<{ readonly colleges: readonly OutcomeCollegeDto[] }> {
  return requestJson(`/api/v1/students/me/outcome-declarations/${encodeURIComponent(declarationId)}/withdraw`, { token, method: 'POST', body: {} });
}
