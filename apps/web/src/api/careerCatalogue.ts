/**
 * ONE · API client — Operations job-role catalogue (OPS-08).
 *
 * The catalogue list and role detail, synonyms, and requirement sets from draft through
 * review to a publish. A publish needs an approval (Settings → Approvals); without one the
 * server answers 403 APPROVAL_REQUIRED and nothing changes.
 */
import { requestJson } from './http.js';

export type CareerReleaseLabel = 'SELECTABLE' | 'VERIFIED';
export type CareerRequirementSetState = 'DRAFT' | 'IN_REVIEW' | 'REVIEWED' | 'PUBLISHED' | 'SUPERSEDED' | 'WITHDRAWN';
export type CareerRequirementLevel = 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';

export interface CareerCataloguePolicyDto {
  readonly viewer: { readonly manage: boolean; readonly review: boolean; readonly publish: boolean; readonly userId: string };
  readonly families: readonly { readonly code: string; readonly label: string }[];
  readonly branches: readonly string[];
  readonly releaseLabels: readonly CareerReleaseLabel[];
  readonly requirementLevels: readonly CareerRequirementLevel[];
  readonly evidenceTypes: readonly string[];
  readonly transitions: Readonly<Record<CareerRequirementSetState, readonly CareerRequirementSetState[]>>;
  readonly reasons: {
    readonly synonymAdd: readonly string[];
    readonly synonymRemove: readonly string[];
    readonly draftCreate: readonly string[];
    readonly itemsSave: readonly string[];
    readonly transition: Readonly<Record<string, readonly string[]>>;
    readonly publish: readonly string[];
  };
  readonly studentFlag: { readonly key: string; readonly enabled: boolean };
  readonly correlationId: string;
}

export interface CatalogueRoleDto {
  readonly id: string;
  readonly code: string;
  readonly catalogueCode: string | null;
  readonly title: string;
  readonly catalogueTitle: string | null;
  readonly family: string;
  readonly catalogueFamily: string | null;
  readonly eligibleBranches: readonly string[];
  readonly plannedRelease: string | null;
  readonly releaseLabel: CareerReleaseLabel | null;
  readonly origin: 'STARTER' | 'CATALOGUE';
  readonly active: boolean;
  readonly liveRequirementCount: number;
  readonly openSetState: CareerRequirementSetState | null;
  readonly publishedVersion: number | null;
  readonly synonymCount: number;
}

export interface CatalogueSummaryDto {
  readonly totalRoles: number;
  readonly catalogueRoles: number;
  readonly starterRoles: number;
  readonly selectable: number;
  readonly verified: number;
  readonly plannedV1: number;
  readonly plannedV2: number;
  readonly plannedV3: number;
  readonly liveSynonyms: number;
  readonly setsInDraft: number;
  readonly setsInReview: number;
  readonly setsReviewed: number;
  readonly setsPublished: number;
}

export interface CatalogueRoleListDto {
  readonly roles: readonly CatalogueRoleDto[];
  readonly nextCursor: string | null;
  readonly summary: CatalogueSummaryDto;
  readonly correlationId: string;
}

export interface RequirementItemDto {
  readonly topicId: string;
  readonly topicKey: string | null;
  readonly topicTitle: string | null;
  readonly requirementLevel: CareerRequirementLevel;
  readonly targetMastery: number;
  readonly rationale: string | null;
  readonly requiredEvidenceTypes: readonly string[];
}

export interface RequirementSetDto {
  readonly id: string;
  readonly version: number;
  readonly state: CareerRequirementSetState;
  readonly basedOn: 'EMPTY' | 'LIVE' | 'SET';
  readonly reasonCode: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly reviewer: { readonly userId: string; readonly email: string } | null;
  readonly reviewedAt: string | null;
  readonly reviewReasonCode: string | null;
  readonly reviewNote: string | null;
  readonly publishedAt: string | null;
  readonly publisherEmail: string | null;
  readonly releaseLabelAtPublish: CareerReleaseLabel | null;
  readonly supersededAt: string | null;
  readonly withdrawnAt: string | null;
  readonly items: readonly RequirementItemDto[];
}

export interface CatalogueRoleDetailDto extends CatalogueRoleDto {
  readonly summary: string | null;
  readonly coreSkillAreas: string | null;
  readonly mainEvidence: string | null;
  readonly catalogueVersion: string | null;
  readonly synonyms: readonly { readonly id: string; readonly synonym: string; readonly reasonCode: string; readonly createdAt: string }[];
  readonly liveRequirements: readonly RequirementItemDto[];
  readonly requirementSets: readonly RequirementSetDto[];
  /** Null when fewer than five students; the screen shows "<5". */
  readonly liveTargetCount: number | null;
  readonly liveTargetCountSuppressed?: boolean;
}

export interface CatalogueRoleFiltersDto {
  readonly q?: string;
  readonly family?: string;
  readonly branch?: string;
  readonly releaseLabel?: string;
}

export interface RequirementItemInputDto {
  readonly topicId: string;
  readonly requirementLevel: CareerRequirementLevel;
  readonly targetMastery: number;
  readonly rationale?: string;
  readonly requiredEvidenceTypes: readonly string[];
}

const base = '/api/v1/operations/career-catalogue';
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
type RoleEnvelope = { readonly role: CatalogueRoleDetailDto; readonly correlationId: string };

export function getCareerCataloguePolicy(token: string, signal?: AbortSignal): Promise<CareerCataloguePolicyDto> {
  return requestJson(`${base}/policy`, { token, ...signalOf(signal) });
}

export function listCatalogueRoles(token: string, filters: CatalogueRoleFiltersDto = {}, cursor?: string | null, signal?: AbortSignal): Promise<CatalogueRoleListDto> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.family) query.set('family', filters.family);
  if (filters.branch) query.set('branch', filters.branch);
  if (filters.releaseLabel) query.set('releaseLabel', filters.releaseLabel);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`${base}/roles${suffix}`, { token, ...signalOf(signal) });
}

export function getCatalogueRole(token: string, roleId: string, signal?: AbortSignal): Promise<RoleEnvelope> {
  return requestJson(`${base}/roles/${encodeURIComponent(roleId)}`, { token, ...signalOf(signal) });
}

export function searchCatalogueTopics(token: string, q: string): Promise<{ readonly topics: readonly { readonly id: string; readonly stableKey: string; readonly name: string }[] }> {
  return requestJson(`${base}/topics?${new URLSearchParams({ q }).toString()}`, { token });
}

export function addCareerRoleSynonym(token: string, roleId: string, body: { readonly synonym: string; readonly reasonCode: string }): Promise<RoleEnvelope> {
  return requestJson(`${base}/roles/${encodeURIComponent(roleId)}/synonyms`, { token, method: 'POST', body });
}

export function removeCareerRoleSynonym(token: string, roleId: string, synonymId: string, body: { readonly reasonCode: string }): Promise<RoleEnvelope> {
  return requestJson(`${base}/roles/${encodeURIComponent(roleId)}/synonyms/${encodeURIComponent(synonymId)}/remove`, { token, method: 'POST', body });
}

export function createCareerRequirementDraft(token: string, roleId: string, body: { readonly reasonCode: string }): Promise<RoleEnvelope & { readonly setId: string; readonly version: number }> {
  return requestJson(`${base}/roles/${encodeURIComponent(roleId)}/requirement-sets`, { token, method: 'POST', body });
}

export function saveCareerRequirementItems(token: string, setId: string, body: { readonly reasonCode: string; readonly items: readonly RequirementItemInputDto[] }): Promise<RoleEnvelope> {
  return requestJson(`${base}/requirement-sets/${encodeURIComponent(setId)}/items`, { token, method: 'POST', body });
}

export function transitionCareerRequirementSet(token: string, setId: string, body: { readonly toState: CareerRequirementSetState; readonly reasonCode: string; readonly note?: string }): Promise<RoleEnvelope> {
  return requestJson(`${base}/requirement-sets/${encodeURIComponent(setId)}/transition`, { token, method: 'POST', body });
}

/** Carried out from the Approvals queue with the approved payload. */
export function publishCareerRequirementSet(token: string, setId: string, body: { readonly releaseLabel: string; readonly reasonCode: string; readonly approvalId: string }): Promise<RoleEnvelope> {
  return requestJson(`${base}/requirement-sets/${encodeURIComponent(setId)}/publish`, { token, method: 'POST', body });
}
