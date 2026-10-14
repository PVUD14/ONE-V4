/**
 * ONE · API client — Operations skill map editor (OPS-09a).
 *
 * Skills and their revisions from draft through review (which is also the rights review) to a
 * publish. A publish that changes readiness inputs needs an approval (Settings → Approvals);
 * without one the server answers 403 APPROVAL_REQUIRED and nothing changes.
 */
import { requestJson } from './http.js';

export type SkillRevisionState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export type SkillStatus = 'LIVE' | 'PENDING' | 'RETIRED';
export type SkillLevel = 'AWARE' | 'GUIDED' | 'INDEPENDENT' | 'TROUBLESHOOT';
export type SkillListFilter = SkillStatus | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'AWAITING_PUBLISH';

export interface SkillMapPolicyDto {
  readonly viewer: { readonly edit: boolean; readonly review: boolean; readonly publish: boolean; readonly userId: string };
  readonly levels: readonly { readonly level: SkillLevel; readonly meaning: string }[];
  readonly licences: readonly { readonly licence: string; readonly attributionRequired: boolean }[];
  readonly transitions: Readonly<Record<SkillRevisionState, readonly SkillRevisionState[]>>;
  readonly reasons: {
    readonly create: readonly string[];
    readonly revise: readonly string[];
    readonly save: readonly string[];
    readonly transition: Readonly<Record<string, readonly string[]>>;
    readonly rights: readonly string[];
    readonly publish: readonly string[];
    /** Why published content is archived (content-archive-design.md). */
    readonly archive?: readonly string[];
  };
  readonly limits: { readonly name: number; readonly description: number; readonly level: number; readonly prerequisites: number; readonly attribution: number; readonly basis: number; readonly note: number };
  readonly correlationId: string;
}

export interface SkillSummaryDto {
  readonly topicId: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: SkillStatus;
  readonly source: 'AUTHORED' | 'AGENT_DRAFTED';
  readonly publishedRevision: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: SkillRevisionState } | null;
  readonly prerequisites: readonly string[];
  readonly levelsComplete: boolean;
  readonly liveRequirementCount: number;
}

export interface SkillMapSummaryDto {
  readonly live: number;
  readonly pending: number;
  readonly agentDraftedPending: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly awaitingPublish: number;
}

export interface SkillFieldsDto {
  readonly name: string;
  readonly description: string;
  readonly levels: Readonly<Record<SkillLevel, string>>;
  readonly prerequisites: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

export interface SkillRevisionDto {
  readonly id: string;
  readonly revision: number;
  readonly state: SkillRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly fields: SkillFieldsDto;
  readonly expertCheck: string | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface SkillDetailDto extends SkillSummaryDto {
  readonly description: string;
  readonly provenance: { readonly generatorVersion: string | null; readonly promptVersion: string | null; readonly generatedAt: string | null };
  readonly current: SkillRevisionDto;
  readonly open: SkillRevisionDto | null;
  readonly prerequisiteSkills: readonly { readonly stableKey: string; readonly name: string | null; readonly status: SkillStatus | 'UNKNOWN' }[];
  readonly dependents: readonly { readonly stableKey: string; readonly name: string }[];
  readonly requiredBy: readonly { readonly roleTitle: string; readonly catalogueCode: string | null; readonly level: string }[];
  readonly openSetCount: number;
  readonly publishNeedsApproval: boolean;
  readonly history: readonly {
    readonly revision: number; readonly action: string; readonly fromState: string; readonly toState: string;
    readonly reasonCode: string; readonly actorEmail: string; readonly occurredAt: string;
  }[];
}

export interface SkillListDto {
  readonly skills: readonly SkillSummaryDto[];
  readonly nextCursor: string | null;
  readonly summary: SkillMapSummaryDto;
  readonly correlationId: string;
}

export interface SkillDraftInputDto {
  readonly name: string;
  readonly description: string;
  readonly levels: Readonly<Record<SkillLevel, string>>;
  readonly prerequisites: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution?: string;
  readonly basis?: string;
  readonly reasonCode: string;
}

const base = '/api/v1/operations/skill-map';
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
type SkillEnvelope = { readonly skill: SkillDetailDto; readonly correlationId: string };

export function getSkillMapPolicy(token: string, signal?: AbortSignal): Promise<SkillMapPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...signalOf(signal) });
}

export function listSkills(token: string, filters: { readonly q?: string; readonly filter?: string } = {}, cursor?: string | null, signal?: AbortSignal): Promise<SkillListDto> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.filter) query.set('filter', filters.filter);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`${base}/skills${suffix}`, { token, ...signalOf(signal) });
}

export function getSkill(token: string, topicId: string, signal?: AbortSignal): Promise<SkillEnvelope> {
  return requestJson(`${base}/skills/${encodeURIComponent(topicId)}`, { token, ...signalOf(signal) });
}

export function createSkill(token: string, body: { readonly stableKey: string; readonly name: string; readonly description: string; readonly reasonCode: string }): Promise<SkillEnvelope> {
  return requestJson(`${base}/skills`, { token, method: 'POST', body });
}

/** Archive a live skill: CONTENT_PUBLISH and a reason; it is retired, never deleted. */
export function archiveSkill(token: string, topicId: string, body: { readonly reasonCode: string }): Promise<SkillEnvelope> {
  return requestJson(`${base}/skills/${encodeURIComponent(topicId)}/archive`, { token, method: 'POST', body });
}

export function startSkillRevision(token: string, topicId: string, body: { readonly reasonCode: string }): Promise<SkillEnvelope> {
  return requestJson(`${base}/skills/${encodeURIComponent(topicId)}/revisions`, { token, method: 'POST', body });
}

export function saveSkillDraft(token: string, revisionId: string, body: SkillDraftInputDto): Promise<SkillEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/draft`, { token, method: 'POST', body });
}

export function transitionSkillRevision(token: string, revisionId: string, body: {
  readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string; readonly rightsReasonCode?: string; readonly note?: string;
}): Promise<SkillEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/transition`, { token, method: 'POST', body });
}

/** Without an approval when none is needed; from the Approvals queue with the approved payload when one is. */
export function publishSkillRevision(token: string, revisionId: string, body: { readonly reasonCode: string; readonly approvalId?: string }): Promise<SkillEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/publish`, { token, method: 'POST', body });
}
