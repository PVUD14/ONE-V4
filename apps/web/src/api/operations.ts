/**
 * ONE · API client — Stream E — Core
 *
 * Platform governance: organizations, verification, users and invitations.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface OrganizationManagementDto {
  readonly id: string;
  readonly kind: 'INSTITUTION' | 'EMPLOYER';
  readonly legalName: string;
  readonly verificationState: string;
  readonly active: boolean;
  readonly updatedAt: string;
  readonly profile: {
    readonly displayName?: string | null; readonly countryCode?: string | null; readonly stateOrProvince?: string | null; readonly city?: string | null; readonly postalCode?: string | null;
    readonly addressLine1?: string | null; readonly addressLine2?: string | null;
    readonly websiteUrl?: string | null; readonly institutionType?: string | null; readonly primaryContactEmail?: string | null;
  };
  readonly initialAdminInvitation?: { readonly id: string; readonly email: string; readonly state: string } | null;
}

export interface OperationsUserAccessDto {
  readonly id: string;
  readonly email: string;
  readonly verifiedEmail: string | null;
  readonly identityLinkStatus: string;
  readonly state: string;
  readonly memberships: readonly Record<string, unknown>[];
  readonly studentRelationshipCount: number;
  readonly studentRelationships: readonly Record<string, unknown>[];
}

export interface OperationsInvitationDto {
  readonly id: string;
  readonly recipientEmail: string;
  readonly organization: { readonly id: string; readonly legalName: string; readonly kind: string } | null;
  readonly role: string;
  readonly state: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly delivery?: { readonly commandId: string; readonly state: string; readonly destinationRef?: string; readonly providerKind?: string | null; readonly providerReference?: string | null; readonly outcome?: string | null } | null;
}

export function listOperationsOrganizations(token: string, filters: { readonly q?: string; readonly kind?: string; readonly verification?: string } = {}, signal?: AbortSignal): Promise<{ readonly organizations: readonly OrganizationManagementDto[] }> {
  const query = new URLSearchParams();
  if (filters.q?.trim()) query.set('q', filters.q.trim());
  if (filters.kind?.trim()) query.set('kind', filters.kind.trim());
  if (filters.verification?.trim()) query.set('verification', filters.verification.trim());
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/organizations${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function listOperationsUsersAccess(token: string, q = '', signal?: AbortSignal): Promise<{ readonly users: readonly OperationsUserAccessDto[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`/api/v1/operations/users-access${query}`, { token, ...(signal ? { signal } : {}) });
}

export function listOperationsInvitations(token: string, q = '', signal?: AbortSignal): Promise<{ readonly invitations: readonly OperationsInvitationDto[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`/api/v1/operations/invitations${query}`, { token, ...(signal ? { signal } : {}) });
}

export function createOperationsOrganization(token: string, body: unknown): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson('/api/v1/operations/organizations', { token, method: 'POST', body });
}

export function updateOperationsOrganization(token: string, organizationId: string, body: unknown): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}`, { token, method: 'PATCH', body });
}

export function transitionOrganizationVerification(token: string, organizationId: string, toState: string): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/verification`, { token, method: 'POST', body: { toState, reasonCode: 'OPERATIONS_UAT' } });
}

export function inviteInitialOrganizationAdmin(token: string, organizationId: string, email: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/initial-admin-invitations`, { token, method: 'POST', body: { email } });
}

export function getOperationsOrganizationOnboardingStatus(token: string, organizationId: string): Promise<{ readonly status: Record<string, unknown> }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/onboarding-status`, { token });
}

export interface AuditEventDto {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly organizationId: string | null;
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly context: Record<string, unknown>;
}

export interface AuditSearchFilters {
  readonly action?: string;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly actorUserId?: string;
  readonly organizationId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Keyset-paginated audit and security event search. The server bounds the page size
 * and rejects an unparseable cursor, so the caller passes `nextCursor` back verbatim
 * rather than constructing a position of its own.
 */
export function searchAuditEvents(
  token: string,
  filters: AuditSearchFilters = {},
  signal?: AbortSignal,
): Promise<{ readonly events: readonly AuditEventDto[]; readonly nextCursor: string | null; readonly correlationId: string }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const text = typeof value === 'number' ? String(value) : value?.trim();
    if (text) query.set(key, text);
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/audit-events${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export interface FeatureFlagDto {
  readonly key: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly cap: { readonly kind: string; readonly value: number; readonly window: string } | null;
  readonly overrides: number;
  readonly lastChangedAt: string | null;
}

export function listFeatureFlags(token: string, signal?: AbortSignal): Promise<{ readonly flags: readonly FeatureFlagDto[] }> {
  return requestJson('/api/v1/operations/feature-flags', { token, ...(signal ? { signal } : {}) });
}

/**
 * A reason code is required by the server, not optional here: flipping a flag that
 * gates a safety behaviour is a high-risk action and the record of why is the point.
 */
export function setFeatureFlagState(token: string, key: string, enabled: boolean, reasonCode: string): Promise<{ readonly flags: readonly FeatureFlagDto[] }> {
  return requestJson(`/api/v1/operations/feature-flags/${encodeURIComponent(key)}/state`, { token, method: 'POST', body: { enabled, reasonCode } });
}

export interface TrustCaseDto {
  readonly id: string;
  readonly caseType: string;
  readonly subjectKind: string;
  readonly state: string;
  readonly severity: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly reportedByUserId: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly evidenceCount: number;
  readonly liveActions: number;
}

export interface ReviewSignalDto {
  readonly id: string;
  readonly opportunityVersionId: string;
  readonly signalCode: string;
  readonly detectorVersion: string;
  readonly firstDetectedAt: string;
}

export function listTrustCases(token: string, includeClosed = false, signal?: AbortSignal): Promise<{
  readonly cases: readonly TrustCaseDto[]; readonly pendingSignals: readonly ReviewSignalDto[];
}> {
  return requestJson(`/api/v1/operations/trust-safety/cases?includeClosed=${includeClosed}`, { token, ...(signal ? { signal } : {}) });
}

/** Opening a case is not a penalty: enforcement is a separate act on a decided case. */
export function openTrustCaseFromSignal(token: string, body: unknown): Promise<{ readonly id: string; readonly cases: readonly TrustCaseDto[] }> {
  return requestJson('/api/v1/operations/trust-safety/cases', { token, method: 'POST', body });
}

export function transitionTrustCase(token: string, caseId: string, toState: string, reasonCode: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/operations/trust-safety/cases/${encodeURIComponent(caseId)}/transition`, { token, method: 'POST', body: { toState, reasonCode } });
}

// --- Staff and capabilities (OPS-01, ADR-032) -------------------------------

export interface StaffCapabilityGrantDto {
  readonly capability: string;
  readonly grantedAt: string;
  readonly reasonCode: string;
  readonly highRisk: boolean;
}

export interface StaffMemberDto {
  readonly membershipId: string;
  readonly email: string;
  readonly role: string;
  readonly state: string;
  readonly isSelf: boolean;
  readonly baseline: readonly string[];
  readonly grants: readonly StaffCapabilityGrantDto[];
  readonly effective: readonly string[];
}

export interface StaffCapabilityCatalogueEntryDto {
  readonly capability: string;
  readonly highRisk: boolean;
  readonly grantableHere: boolean;
}

export interface StaffDirectoryDto {
  readonly staff: readonly StaffMemberDto[];
  readonly nextCursor: string | null;
  readonly capabilities: readonly StaffCapabilityCatalogueEntryDto[];
  readonly grantReasons: readonly string[];
  readonly revokeReasons: readonly string[];
  /** Until dual control exists (OPS-02) only a Platform Super Admin may grant a high-risk capability. */
  readonly actorMayGrantHighRisk: boolean;
  readonly correlationId: string;
}

export function listOperationsStaff(token: string, cursor?: string | null, signal?: AbortSignal): Promise<StaffDirectoryDto> {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`/api/v1/operations/staff${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function grantStaffCapability(
  token: string, membershipId: string, body: { readonly capability: string; readonly reasonCode: string; readonly note?: string },
): Promise<{ readonly member: StaffMemberDto; readonly correlationId: string }> {
  return requestJson(`/api/v1/operations/staff/${encodeURIComponent(membershipId)}/capabilities`, { token, method: 'POST', body });
}

export function revokeStaffCapability(
  token: string, membershipId: string, capability: string, body: { readonly reasonCode: string; readonly note?: string },
): Promise<{ readonly member: StaffMemberDto; readonly correlationId: string }> {
  return requestJson(`/api/v1/operations/staff/${encodeURIComponent(membershipId)}/capabilities/${encodeURIComponent(capability)}/revoke`, { token, method: 'POST', body });
}
