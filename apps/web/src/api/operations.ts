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
