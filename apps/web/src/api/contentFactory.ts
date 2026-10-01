/**
 * ONE · API client — the content factory (ENG-23): "Draft with AI".
 *
 * Asking for a draft only queues a job; the content factory worker runs it later through ONE AI
 * Orchestration, and what passes its guard appears in the lesson editor or the question bank as an
 * AI draft authored by the person who asked. Nothing here calls a model. Refusals come back typed:
 * 409 AI_FEATURE_DISABLED / AI_KILL_SWITCH_ENGAGED, 429 AI_CAP_REACHED / AI_DRAFTS_IN_FLIGHT.
 */
import { requestJson } from './http.js';

export type ContentDraftKind = 'LESSON' | 'LESSON_VARIANT' | 'QUESTION' | 'ANSWER_CHECK';
export type ContentDraftState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'REFUSED' | 'REJECTED' | 'FAILED';

export interface ContentFactoryFeatureDto {
  readonly featureKey: string;
  readonly kinds: readonly ContentDraftKind[];
  readonly registered: boolean;
  readonly switchedOn: boolean;
  readonly available: boolean;
  readonly cap: number | null;
  readonly window: 'DAY' | 'MONTH' | null;
  readonly usedInWindow: number | null;
  readonly openJobs: number | null;
  readonly model: string | null;
  readonly prompt: { readonly key: string; readonly version: number } | null;
}

export interface ContentFactoryStatusDto {
  readonly killSwitchEngaged: boolean;
  readonly features: readonly ContentFactoryFeatureDto[];
  readonly maxInFlight: number;
  readonly viewerOpenJobs: number;
  readonly viewer: { readonly userId: string; readonly mayRequest: Readonly<Record<ContentDraftKind, boolean>>; readonly seesAnswerChecks: boolean };
  readonly reasons: Readonly<Record<ContentDraftKind, readonly string[]>>;
  readonly limits: { readonly authorNote: number };
  readonly correlationId: string;
}

export interface ContentDraftDto {
  readonly id: string;
  readonly kind: ContentDraftKind;
  readonly state: ContentDraftState;
  readonly outcomeCode: string | null;
  readonly findings: readonly string[];
  readonly requestedBy: { readonly userId: string; readonly email: string };
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly attempts: number;
  readonly target: {
    readonly topic: { readonly id: string; readonly stableKey: string; readonly name: string } | null;
    readonly baseLesson: { readonly lessonId: string; readonly stableKey: string; readonly title: string } | null;
    readonly questionRevisionId: string | null;
    readonly stableKey: string | null;
    readonly title: string | null;
    readonly language: string;
    readonly level: string | null;
    readonly style: string | null;
    readonly authorNote: string | null;
  };
  readonly prompt: { readonly key: string; readonly version: number };
  readonly generation: {
    readonly source: 'AI_GENERATED'; readonly generatorVersion: string; readonly model: string; readonly generatedAt: string;
    readonly fitted: boolean | null; readonly truncated: boolean;
  } | null;
  readonly produced: { readonly lessonId: string | null; readonly questionId: string | null; readonly revisionId: string } | null;
  /** Withheld (null) from anyone who may not see answer keys. */
  readonly check: { readonly option: string; readonly working: string; readonly agreesWithKey: boolean; readonly contentHash: string; readonly stale: boolean; readonly reviewState: 'DRAFT' } | null;
}

/** The provenance block the lesson editor and the question bank show on an AI draft. */
export interface AiDraftDto {
  readonly jobId: string;
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly expertCheck: string | null;
  /** The model's full text by section (lessons); null for a question. */
  readonly sections: Readonly<Record<string, string>> | null;
  readonly fitted: boolean;
}

export interface ContentDraftRequestDto {
  readonly kind: ContentDraftKind;
  readonly topicKey?: string;
  readonly baseLessonId?: string;
  readonly questionRevisionId?: string;
  readonly stableKey?: string;
  readonly title?: string;
  readonly language?: string;
  readonly level?: string;
  readonly style?: string;
  readonly authorNote?: string;
  readonly reasonCode: string;
}

const base = '/api/v1/operations/content-factory';
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

const noKinds: Readonly<Record<ContentDraftKind, boolean>> = { LESSON: false, LESSON_VARIANT: false, QUESTION: false, ANSWER_CHECK: false };
const noReasons: Readonly<Record<ContentDraftKind, readonly string[]>> = { LESSON: [], LESSON_VARIANT: [], QUESTION: [], ANSWER_CHECK: [] };

/** An answer missing a part reads as "nothing available, nothing allowed", never as a crash. */
function normaliseStatus(raw: Partial<ContentFactoryStatusDto> | null | undefined): ContentFactoryStatusDto {
  const value = raw ?? {};
  const viewer = value.viewer ?? { userId: '', mayRequest: noKinds, seesAnswerChecks: false };
  return {
    killSwitchEngaged: value.killSwitchEngaged === true,
    features: Array.isArray(value.features) ? value.features : [],
    maxInFlight: typeof value.maxInFlight === 'number' ? value.maxInFlight : 0,
    viewerOpenJobs: typeof value.viewerOpenJobs === 'number' ? value.viewerOpenJobs : 0,
    viewer: { userId: viewer.userId ?? '', mayRequest: { ...noKinds, ...(viewer.mayRequest ?? {}) }, seesAnswerChecks: viewer.seesAnswerChecks === true },
    reasons: { ...noReasons, ...(value.reasons ?? {}) },
    limits: { authorNote: value.limits && typeof value.limits.authorNote === 'number' ? value.limits.authorNote : 1000 },
    correlationId: value.correlationId ?? '',
  };
}

export async function getContentFactoryStatus(token: string, signal?: AbortSignal): Promise<ContentFactoryStatusDto> {
  return normaliseStatus(await requestJson<Partial<ContentFactoryStatusDto>>(`${base}/status`, { token, ...signalOf(signal) }));
}

export async function listContentDrafts(token: string, filters: {
  readonly kinds?: readonly ContentDraftKind[]; readonly mine?: boolean; readonly baseLessonId?: string; readonly questionRevisionId?: string; readonly limit?: number;
} = {}, signal?: AbortSignal): Promise<{ readonly drafts: readonly ContentDraftDto[]; readonly correlationId: string }> {
  const answer = await requestJson<{ readonly drafts?: readonly ContentDraftDto[]; readonly correlationId?: string }>(listPath(filters), { token, ...signalOf(signal) });
  return { drafts: Array.isArray(answer.drafts) ? answer.drafts : [], correlationId: answer.correlationId ?? '' };
}

function listPath(filters: {
  readonly kinds?: readonly ContentDraftKind[]; readonly mine?: boolean; readonly baseLessonId?: string; readonly questionRevisionId?: string; readonly limit?: number;
}): string {
  const query = new URLSearchParams();
  if (filters.kinds && filters.kinds.length) query.set('kinds', filters.kinds.join(','));
  if (filters.mine) query.set('mine', 'true');
  if (filters.baseLessonId) query.set('baseLessonId', filters.baseLessonId);
  if (filters.questionRevisionId) query.set('questionRevisionId', filters.questionRevisionId);
  if (filters.limit) query.set('limit', String(filters.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return `${base}/drafts${suffix}`;
}

export function requestContentDraft(token: string, body: ContentDraftRequestDto): Promise<{ readonly draft: ContentDraftDto | null; readonly correlationId: string }> {
  return requestJson(`${base}/drafts`, { token, method: 'POST', body });
}
