/**
 * ONE · API client — the résumé generator (RESUME-GEN).
 *
 * What the student may put on a résumé (each item with the label it would carry), a preview, saved
 * versions and the PDF of a version. The server resolves every label from the student's own records: the
 * client sends record ids and the student's own words, never "verified". Nothing here carries readiness, a
 * band, a score, a stage or mastery. Design: docs/architecture/student-resumes-table-design.md.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';

export type ResumeTemplateKey = 'CLASSIC' | 'MODERN' | 'COMPACT';

export interface ResumeTemplateDto { readonly key: ResumeTemplateKey; readonly name: string; readonly description: string }
export interface ResumeLinkDto { readonly label: string | null; readonly url: string }
export interface ResumeProjectDto { readonly title: string; readonly description: string | null; readonly url: string | null }

export interface ResumeSourcesDto {
  readonly header: { readonly fullName: string | null; readonly email: string | null; readonly headline: string | null; readonly summary: string | null; readonly portfolioUrl: string | null };
  readonly qualifications: readonly {
    readonly id: string; readonly title: string; readonly institution: string | null; readonly period: string | null;
    readonly verification: string; readonly verified: boolean;
    readonly terms: readonly { readonly id: string; readonly label: string; readonly result: string; readonly verification: string; readonly verified: boolean }[];
  }[];
  readonly skills: readonly { readonly topicId: string; readonly name: string; readonly basis: string }[];
  readonly certificates: readonly { readonly id: string; readonly title: string; readonly description: string | null; readonly verification: string }[];
  readonly careerTargets: readonly { readonly id: string; readonly roleTitle: string }[];
}

/** What the student ticked and typed. */
export interface ResumeDraftDto {
  readonly title: string;
  readonly template: ResumeTemplateKey;
  readonly header: {
    readonly fullName: string | null; readonly headline: string | null; readonly phone: string | null; readonly location: string | null;
    readonly showEmail: boolean; readonly links: readonly ResumeLinkDto[];
  };
  readonly summary: string | null;
  readonly qualificationIds: readonly string[];
  readonly termIds: readonly string[];
  readonly skillTopicIds: readonly string[];
  readonly certificateIds: readonly string[];
  readonly careerTargetIds: readonly string[];
  readonly declaredSkills: readonly string[];
  readonly projects: readonly ResumeProjectDto[];
  readonly languages: readonly string[];
}

/** The résumé as drawn: every word and label. */
export interface ResumeContentDto {
  readonly schemaVersion: 1;
  readonly template: ResumeTemplateKey;
  readonly header: { readonly fullName: string | null; readonly headline: string | null; readonly email: string | null; readonly phone: string | null; readonly location: string | null; readonly links: readonly ResumeLinkDto[] };
  readonly summary: string | null;
  readonly objective: readonly string[];
  readonly education: readonly {
    readonly title: string; readonly institution: string | null; readonly period: string | null; readonly status: string | null;
    readonly verification: string; readonly verified: boolean;
    readonly results: readonly { readonly label: string; readonly result: string; readonly verification: string; readonly verified: boolean }[];
  }[];
  readonly skills: { readonly shown: readonly { readonly name: string; readonly basis: string }[]; readonly declared: readonly string[] };
  readonly projects: readonly ResumeProjectDto[];
  readonly certificates: readonly { readonly title: string; readonly description: string | null; readonly verification: string }[];
  readonly languages: readonly string[];
  readonly legend: string;
  readonly generatedOn: string;
}

/** An objective completeness check. Passed or not — never a number. */
export interface ResumeCheckDto { readonly key: string; readonly passed: boolean; readonly message: string }

export interface ResumeSummaryDto {
  readonly id: string; readonly title: string; readonly createdAt: string; readonly updatedAt: string;
  readonly latestVersion: number; readonly template: ResumeTemplateKey; readonly latestSavedAt: string; readonly versionCount: number;
}

export interface ResumeDetailDto {
  readonly id: string; readonly title: string; readonly createdAt: string; readonly updatedAt: string;
  readonly versions: readonly { readonly versionNumber: number; readonly template: ResumeTemplateKey; readonly createdAt: string }[];
  readonly latest: {
    readonly versionNumber: number; readonly template: ResumeTemplateKey; readonly createdAt: string;
    readonly selections: ResumeDraftDto; readonly content: ResumeContentDto; readonly checks: readonly ResumeCheckDto[];
  } | null;
}

const base = '/api/v1/students/me';

export function getResumeSources(token: string, signal?: AbortSignal): Promise<{ readonly sources: ResumeSourcesDto; readonly templates: readonly ResumeTemplateDto[] }> {
  return requestJson(`${base}/resume-sources`, { token, ...(signal ? { signal } : {}) });
}

export function previewResume(token: string, draft: ResumeDraftDto, signal?: AbortSignal): Promise<{ readonly content: ResumeContentDto; readonly checks: readonly ResumeCheckDto[] }> {
  return requestJson(`${base}/resumes/preview`, { token, method: 'POST', body: draft, ...(signal ? { signal } : {}) });
}

export function listResumes(token: string, signal?: AbortSignal): Promise<{ readonly resumes: readonly ResumeSummaryDto[] }> {
  return requestJson(`${base}/resumes`, { token, ...(signal ? { signal } : {}) });
}

export function getResume(token: string, resumeId: string, signal?: AbortSignal): Promise<{ readonly resume: ResumeDetailDto }> {
  return requestJson(`${base}/resumes/${encodeURIComponent(resumeId)}`, { token, ...(signal ? { signal } : {}) });
}

export function createResume(token: string, draft: ResumeDraftDto): Promise<{ readonly resume: ResumeDetailDto }> {
  return requestJson(`${base}/resumes`, { token, method: 'POST', body: draft });
}

export function saveResumeVersion(token: string, resumeId: string, draft: ResumeDraftDto): Promise<{ readonly resume: ResumeDetailDto }> {
  return requestJson(`${base}/resumes/${encodeURIComponent(resumeId)}/versions`, { token, method: 'POST', body: draft });
}

export function deleteResume(token: string, resumeId: string): Promise<{ readonly deleted: boolean }> {
  return requestJson(`${base}/resumes/${encodeURIComponent(resumeId)}`, { token, method: 'DELETE' });
}

/** The PDF of one saved version, as a blob with the filename the server chose. */
export async function downloadResumePdf(token: string, resumeId: string, versionNumber: number): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}${base}/resumes/${encodeURIComponent(resumeId)}/versions/${versionNumber}/pdf`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId, Accept: 'application/pdf' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly error?: { readonly code?: string } } | null;
    throw new ApiRequestError({ status: response.status, correlationId: response.headers?.get('x-correlation-id') ?? correlationId, ...(body?.error?.code ? { code: body.error.code } : {}) });
  }
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `resume-v${versionNumber}.pdf`;
  return { blob: await response.blob(), filename };
}
