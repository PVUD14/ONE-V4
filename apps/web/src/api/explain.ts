/**
 * ONE · API client — "Ask ONE to explain" (ADR-052): the student's routes and the operations review queue.
 *
 * Why it exists: the web screen and the Content Management review panel read the same contract as the
 * Android app. A lesson is written by a job, so asking answers at once (202) with the lesson being prepared
 * and the screen polls one request until it is final. Responses carry the lesson text only when it passed
 * ONE's checks and was not withdrawn — never the model's refused text, a guard finding or a readiness value.
 */
import { requestJson } from './http.js';

export type ExplainState = 'PREPARING' | 'READY' | 'NOT_AVAILABLE' | 'REFUSED';
export type ExplainNotAvailable = 'CHECKS_FAILED' | 'TIMED_OUT' | 'AI_UNAVAILABLE' | 'WITHDRAWN';
export type ExplainReportReason = 'WRONG_FACT' | 'CONFUSING' | 'UNSAFE' | 'NOT_WHAT_I_ASKED' | 'OTHER';

export interface ExplainLessonDto {
  /** Always "AI-generated — not checked by a person". */
  readonly label: string;
  readonly title: string;
  readonly sections: readonly { readonly heading: string; readonly text: string }[];
  readonly generatedAt: string;
  readonly promptVersion: string;
}

export interface ExplainRequestDto {
  readonly id: string;
  readonly topic: string;
  readonly askedAt: string;
  readonly state: ExplainState;
  readonly notAvailable: ExplainNotAvailable | null;
  readonly servedFromCache: boolean;
  readonly reported: boolean;
  readonly lesson: ExplainLessonDto | null;
}

export interface ExplainAvailabilityDto {
  readonly available: boolean;
  readonly reason: 'OFF' | 'PREPARING' | 'DAILY_LIMIT' | null;
  readonly remainingToday: number | null;
  readonly limits: { readonly topicMin: number; readonly topicMax: number; readonly perDay: number; readonly reportNoteMax: number };
}

const base = '/api/v1/learning/explain';
const opts = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function getExplainStatus(token: string, signal?: AbortSignal): Promise<{ readonly availability: ExplainAvailabilityDto }> {
  return requestJson<{ readonly availability: ExplainAvailabilityDto }>(`${base}/status`, opts(token, signal));
}

/** Ask ONE to explain a topic. Answers at once: a cached lesson, or the lesson being prepared by a job. */
export function askOneToExplain(token: string, topic: string): Promise<{ readonly request: ExplainRequestDto }> {
  return requestJson<{ readonly request: ExplainRequestDto }>(base, { token, method: 'POST', body: { topic } });
}

export function listExplainRequests(token: string, signal?: AbortSignal): Promise<{ readonly requests: readonly ExplainRequestDto[] }> {
  return requestJson<{ readonly requests: readonly ExplainRequestDto[] }>(`${base}/requests`, opts(token, signal));
}

/** One request as it stands (the screen polls this while the lesson is being prepared). */
export function getExplainRequest(token: string, requestId: string, signal?: AbortSignal): Promise<{ readonly request: ExplainRequestDto }> {
  return requestJson<{ readonly request: ExplainRequestDto }>(`${base}/requests/${encodeURIComponent(requestId)}`, opts(token, signal));
}

export function reportExplainLesson(token: string, requestId: string, reasonCode: ExplainReportReason, note: string | null): Promise<{ readonly request: ExplainRequestDto }> {
  return requestJson<{ readonly request: ExplainRequestDto }>(`${base}/requests/${encodeURIComponent(requestId)}/report`, {
    token, method: 'POST', body: { reasonCode, ...(note ? { note } : {}) },
  });
}

// --- Operations: review by exception (Content Management) -------------------

export type ExplainReviewView = 'flagged' | 'most-viewed' | 'withdrawn' | 'promoted';

export interface ExplainReviewRowDto {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly reviewState: string;
  readonly requests: number;
  readonly reports: number;
  readonly reportReasons: Readonly<Record<string, number>>;
  readonly reportNotes: readonly string[];
  readonly text: string | null;
  readonly model: string;
  readonly servedModel: string | null;
  readonly promptVersion: string;
  readonly generatorVersion: string | null;
  readonly guardVersion: string | null;
  readonly generatedAt: string | null;
  readonly reviewReasonCode: string | null;
  readonly reviewedAt: string | null;
  readonly promotedLessonId: string | null;
}

export interface ExplainReviewListDto {
  readonly lessons: readonly ExplainReviewRowDto[];
  readonly counts: { readonly ready: number; readonly flagged: number; readonly withdrawn: number; readonly promoted: number; readonly blocked: number; readonly refused: number };
  readonly viewer: { readonly canWithdraw: boolean; readonly canPromote: boolean };
  readonly reasons: { readonly withdraw: readonly string[]; readonly promote: readonly string[] };
}

const opsBase = '/api/v1/operations/explain-lessons';

export function listExplainLessonsForReview(token: string, view: ExplainReviewView, signal?: AbortSignal): Promise<ExplainReviewListDto> {
  return requestJson<ExplainReviewListDto>(`${opsBase}?view=${encodeURIComponent(view)}`, opts(token, signal));
}

export function withdrawExplainLesson(token: string, lessonId: string, reasonCode: string): Promise<{ readonly lesson: { readonly id: string; readonly reviewState: string } }> {
  return requestJson(`${opsBase}/${encodeURIComponent(lessonId)}/withdraw`, { token, method: 'POST', body: { reasonCode } });
}

export function promoteExplainLesson(token: string, lessonId: string, input: {
  readonly reasonCode: string; readonly stableKey: string; readonly title: string; readonly level: string; readonly style: string;
}): Promise<{ readonly lesson: { readonly id: string; readonly reviewState: string; readonly lessonId: string; readonly revisionId: string } }> {
  return requestJson(`${opsBase}/${encodeURIComponent(lessonId)}/promote`, { token, method: 'POST', body: input });
}
