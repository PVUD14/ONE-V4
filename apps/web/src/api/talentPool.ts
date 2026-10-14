/**
 * ONE · API client — the consented talent pool (EMP-14, ADR-044).
 *
 * The student's opt-in, card choices, invitations and blocks, and the employer's filter-only search,
 * one card, and invitations to apply. While the feature is off (hard gate HG-4) every read answers
 * `available: false` and the UI shows its honest not-available state.
 */
import { requestJson } from './http.js';

/** One evidence item as both sides see it: type, source, date, unaided. Never marks, a stage or a score. */
export interface TalentPoolEvidenceItemDto {
  readonly type: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly unaided: boolean;
}

export interface TalentPoolChoiceDto extends TalentPoolEvidenceItemDto {
  readonly evidenceId: string;
  readonly shown: boolean;
}

export interface TalentPoolInvitationDto {
  readonly id: string;
  readonly opportunityId: string;
  readonly employerName: string;
  readonly title: string | null;
  /** SENT, EXPIRED, APPLIED, DECLINED or CANCELLED. */
  readonly state: string;
  readonly sentAt: string;
  readonly expiresAt: string;
  readonly respondedAt: string | null;
}

export interface StudentTalentPoolDto {
  readonly available: boolean;
  readonly optedIn: boolean;
  readonly discoverable: boolean;
  readonly consent: { readonly version: string; readonly title: string; readonly granted: boolean } | null;
  readonly visibility?: string;
  readonly listing: { readonly showBranch: boolean; readonly showGraduationYear: boolean; readonly preferredCities: readonly string[]; readonly optedInAt: string } | null;
  readonly roster: { readonly branch: string | null; readonly graduationYear: number | null } | null;
  readonly skills: readonly { readonly name: string; readonly items: readonly TalentPoolChoiceDto[] }[];
  readonly invitations: readonly TalentPoolInvitationDto[];
  readonly blocks: readonly { readonly employerId: string; readonly employerName: string; readonly blockedAt: string }[];
}

export interface TalentPoolListingInput {
  /** Sent only by the explicit act of joining (or re-agreeing to a new notice). */
  readonly consentVersion?: string;
  readonly showBranch?: boolean;
  readonly showGraduationYear?: boolean;
  readonly preferredCities?: readonly string[];
  readonly evidenceRecordIds?: readonly string[];
}

type StudentResponse = Promise<{ readonly talentPool: StudentTalentPoolDto }>;

export function getMyTalentPool(token: string, signal?: AbortSignal): StudentResponse {
  return requestJson('/api/v1/students/me/talent-pool', { token, ...(signal ? { signal } : {}) });
}

export function saveMyTalentPool(token: string, input: TalentPoolListingInput): StudentResponse {
  return requestJson('/api/v1/students/me/talent-pool', { token, method: 'PUT', body: input });
}

/** Leave the pool: effective on the employer's next request. */
export function leaveTalentPool(token: string): StudentResponse {
  return requestJson('/api/v1/students/me/talent-pool', { token, method: 'DELETE' });
}

export function declineTalentPoolInvitation(token: string, invitationId: string): StudentResponse {
  return requestJson(`/api/v1/students/me/talent-pool/invitations/${encodeURIComponent(invitationId)}/decline`, { token, method: 'POST' });
}

export function findEmployersToBlock(token: string, q: string, signal?: AbortSignal): Promise<{ readonly employers: readonly { readonly employerId: string; readonly name: string }[] }> {
  return requestJson(`/api/v1/students/me/talent-pool/employers?q=${encodeURIComponent(q.trim().slice(0, 80))}`, { token, ...(signal ? { signal } : {}) });
}

export function blockEmployer(token: string, employerId: string): StudentResponse {
  return requestJson('/api/v1/students/me/talent-pool/blocks', { token, method: 'POST', body: { employerId } });
}

export function unblockEmployer(token: string, employerId: string): StudentResponse {
  return requestJson(`/api/v1/students/me/talent-pool/blocks/${encodeURIComponent(employerId)}`, { token, method: 'DELETE' });
}

// --- Employer ------------------------------------------------------------------------------------

/** A card: only what the student chose to show. No name, contact, college or identifier. */
export interface TalentPoolCardDto {
  readonly cardRef: string;
  readonly skills: readonly string[];
  readonly branch: string | null;
  readonly graduationYear: number | null;
  readonly preferredCities: readonly string[];
}

export interface TalentPoolCardDetailDto {
  readonly cardRef: string;
  readonly branch: string | null;
  readonly graduationYear: number | null;
  readonly preferredCities: readonly string[];
  readonly skills: readonly { readonly name: string; readonly items: readonly TalentPoolEvidenceItemDto[] }[];
}

export interface EmployerTalentPoolDto {
  readonly available: boolean;
  readonly invitableJobs?: readonly { readonly opportunityId: string; readonly title: string; readonly referenceCode: string | null; readonly applicationDeadline: string | null }[];
  readonly dailyInvitationLimit?: number;
  readonly invitationsLeftToday?: number;
  /** PENDING (no answer yet, including a decline), APPLIED or CLOSED. */
  readonly invitations?: readonly { readonly title: string | null; readonly sentAt: string; readonly expiresAt: string; readonly status: string }[];
}

export interface TalentPoolSearchInput {
  readonly skills: readonly string[];
  readonly branch?: string;
  readonly graduationYear?: string;
  readonly city?: string;
  readonly page?: number;
}

export function getEmployerTalentPool(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly talentPool?: EmployerTalentPoolDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/talent-pool`, { token, ...(signal ? { signal } : {}) });
}

export function searchTalentPool(token: string, employerId: string, input: TalentPoolSearchInput, signal?: AbortSignal): Promise<{ readonly talentPool: { readonly available: boolean; readonly cards: readonly TalentPoolCardDto[]; readonly hasMore: boolean } }> {
  const params = new URLSearchParams();
  for (const skill of input.skills) params.append('skill', skill);
  if (input.branch?.trim()) params.set('branch', input.branch.trim());
  if (input.graduationYear?.trim()) params.set('graduationYear', input.graduationYear.trim());
  if (input.city?.trim()) params.set('city', input.city.trim());
  if (input.page) params.set('page', String(input.page));
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/talent-pool/search?${params.toString()}`, { token, ...(signal ? { signal } : {}) });
}

export function getTalentPoolCard(token: string, employerId: string, cardRef: string, signal?: AbortSignal): Promise<{ readonly talentPool: { readonly available: boolean; readonly card?: TalentPoolCardDetailDto } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/talent-pool/cards/${encodeURIComponent(cardRef)}`, { token, ...(signal ? { signal } : {}) });
}

export function inviteFromTalentPool(token: string, employerId: string, cardRef: string, opportunityId: string): Promise<{ readonly invitation: { readonly status: string; readonly expiresAt: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/talent-pool/invitations`, { token, method: 'POST', body: { cardRef, opportunityId } });
}
