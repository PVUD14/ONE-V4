/**
 * ONE · API client — Operations lesson and variant editor (OPS-09c).
 *
 * Lessons and their language, level and style variants, and their revisions from draft through
 * review (which is also the rights review) to a publish. A base lesson's first publish, or a
 * revision that changes its skill or prerequisites, needs an approval (Settings → Approvals);
 * without one the server answers 403 APPROVAL_REQUIRED and nothing changes. A wording revision
 * and a variant publish directly.
 */
import { requestJson } from './http.js';

export type LessonRevisionState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export type LessonStatus = 'LIVE' | 'PENDING';
export type LessonKind = 'BASE' | 'VARIANT';

export interface LessonVariantDto {
  readonly language: string;
  readonly level: string;
  readonly style: string;
}

export interface LessonEditorPolicyDto {
  readonly viewer: { readonly edit: boolean; readonly review: boolean; readonly publish: boolean; readonly userId: string };
  readonly languages: readonly { readonly language: string; readonly name: string }[];
  readonly levels: readonly { readonly level: string; readonly meaning: string }[];
  readonly styles: readonly { readonly style: string; readonly meaning: string }[];
  readonly licences: readonly { readonly licence: string; readonly attributionRequired: boolean }[];
  readonly modules: readonly { readonly stableKey: string; readonly title: string }[];
  readonly transitions: Readonly<Record<LessonRevisionState, readonly LessonRevisionState[]>>;
  readonly reasons: {
    readonly create: readonly string[];
    readonly createVariant: readonly string[];
    readonly revise: readonly string[];
    readonly save: readonly string[];
    readonly transition: Readonly<Record<string, readonly string[]>>;
    readonly rights: readonly string[];
    readonly publish: readonly string[];
  };
  readonly limits: {
    readonly title: number; readonly summary: number; readonly practice: number; readonly prerequisites: number;
    readonly attribution: number; readonly basis: number; readonly note: number;
  };
  readonly correlationId: string;
}

export interface LessonTopicDto {
  readonly id: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: 'LIVE' | 'PENDING' | 'RETIRED';
}

export interface LessonSummaryDto {
  readonly lessonId: string;
  readonly stableKey: string;
  readonly kind: LessonKind;
  readonly variant: LessonVariantDto;
  readonly variantOf: string | null;
  readonly title: string;
  readonly status: LessonStatus;
  readonly publishedRevision: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: LessonRevisionState } | null;
  readonly topic: LessonTopicDto | null;
  readonly moduleKey: string | null;
  readonly variantCount: number;
  readonly basedOnRevision: number | null;
  readonly baseRevision: number | null;
}

export interface LessonEditorSummaryDto {
  readonly live: number;
  readonly pending: number;
  readonly awaitingReview: number;
  readonly awaitingPublish: number;
  readonly liveVariants: number;
}

export interface LessonFieldsDto {
  readonly title: string;
  readonly summary: string;
  readonly practice: string | null;
  readonly moduleKey: string | null;
  readonly topicId: string | null;
  readonly prerequisites: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

export interface LessonRevisionDto {
  readonly id: string;
  readonly revision: number;
  readonly state: LessonRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  readonly approver: { readonly userId: string; readonly email: string } | null;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly identity: { readonly stableKey: string; readonly variantOf: string | null; readonly variant: LessonVariantDto; readonly basedOnRevision: number | null };
  readonly fields: LessonFieldsDto;
  readonly topic: LessonTopicDto | null;
  /** Set when an import pack drafted the revision (program B.8); null when a person wrote it. */
  readonly agentDraft: { readonly generatorVersion: string; readonly promptVersion: string; readonly generatedAt: string } | null;
  readonly expertCheck: string | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface LessonDetailDto extends LessonSummaryDto {
  readonly current: LessonRevisionDto | null;
  readonly open: LessonRevisionDto | null;
  readonly versions: readonly { readonly version: number; readonly publishedAt: string; readonly superseded: boolean }[];
  readonly variants: readonly LessonSummaryDto[];
  readonly base: LessonSummaryDto | null;
  readonly publishNeedsApproval: boolean;
  readonly history: readonly {
    readonly revision: number; readonly action: string; readonly fromState: string; readonly toState: string;
    readonly reasonCode: string; readonly actorEmail: string; readonly occurredAt: string;
  }[];
}

export interface LessonListDto {
  readonly lessons: readonly LessonSummaryDto[];
  readonly nextCursor: string | null;
  readonly summary: LessonEditorSummaryDto;
  readonly correlationId: string;
}

export interface LessonDraftInputDto {
  readonly title: string;
  readonly summary: string;
  readonly practice?: string;
  readonly moduleKey?: string;
  readonly topicKey?: string;
  readonly prerequisites?: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution?: string;
  readonly basis?: string;
  readonly reasonCode: string;
}

const base = '/api/v1/operations/lessons';
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
type LessonEnvelope = { readonly lesson: LessonDetailDto; readonly correlationId: string };

export function getLessonEditorPolicy(token: string, signal?: AbortSignal): Promise<LessonEditorPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...signalOf(signal) });
}

export function listEditorLessons(token: string, filters: { readonly q?: string; readonly filter?: string } = {}, cursor?: string | null, signal?: AbortSignal): Promise<LessonListDto> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.filter) query.set('filter', filters.filter);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`${base}/lessons${suffix}`, { token, ...signalOf(signal) });
}

export function getEditorLesson(token: string, lessonId: string, signal?: AbortSignal): Promise<LessonEnvelope> {
  return requestJson(`${base}/lessons/${encodeURIComponent(lessonId)}`, { token, ...signalOf(signal) });
}

export function createEditorLesson(token: string, body: { readonly stableKey: string; readonly title: string; readonly level: string; readonly style: string; readonly reasonCode: string }): Promise<LessonEnvelope> {
  return requestJson(`${base}/lessons`, { token, method: 'POST', body });
}

export function createEditorLessonVariant(token: string, lessonId: string, body: {
  readonly language: string; readonly level: string; readonly style: string; readonly title: string; readonly reasonCode: string;
}): Promise<LessonEnvelope> {
  return requestJson(`${base}/lessons/${encodeURIComponent(lessonId)}/variants`, { token, method: 'POST', body });
}

export function startEditorLessonRevision(token: string, lessonId: string, body: { readonly reasonCode: string }): Promise<LessonEnvelope> {
  return requestJson(`${base}/lessons/${encodeURIComponent(lessonId)}/revisions`, { token, method: 'POST', body });
}

export function saveEditorLessonDraft(token: string, revisionId: string, body: LessonDraftInputDto): Promise<LessonEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/draft`, { token, method: 'POST', body });
}

export function transitionEditorLessonRevision(token: string, revisionId: string, body: {
  readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string; readonly rightsReasonCode?: string; readonly note?: string;
}): Promise<LessonEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/transition`, { token, method: 'POST', body });
}

/** Directly when no approval is needed; from the Approvals queue, with the approved payload, when one is. */
export function publishEditorLessonRevision(token: string, revisionId: string, body: { readonly reasonCode: string; readonly approvalId?: string }): Promise<LessonEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/publish`, { token, method: 'POST', body });
}
