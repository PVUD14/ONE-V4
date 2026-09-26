/**
 * ONE · API client — Stream E — Core
 *
 * Base URL resolution, the shared error type, health, the protected-token
 * accessors and the security context every workspace mounts behind.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { getAccessToken } from '../auth.js';
import { requestJson } from './http.js';

export type ApiHealth = 'checking' | 'online' | 'offline';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;

export const apiBaseUrl = resolveApiBaseUrl(configuredBaseUrl, allowLoopbackApiFallback());

/**
 * Whether the loopback API fallback may be used.
 *
 * This has to depend on where the app is *running*, not on how it was *built*.
 * `vite build` inherits an ambient NODE_ENV, so a production build performed on a
 * host whose environment sets NODE_ENV=development leaves `import.meta.env.DEV`
 * true and bakes http://127.0.0.1:3000 into the bundle. Every visitor's browser
 * then tries to call its own machine, and the app fails with no server-side trace.
 * Requiring a local hostname as well makes the bundle correct either way.
 */
export function allowLoopbackApiFallback(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === 'undefined' || !window.location) return true;
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(window.location.hostname);
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly correlationId: string;
  readonly code?: string;
  readonly field?: string;
  /** Human-readable detail from the API's error body, when it sent one. */
  readonly detail?: string;

  constructor(input: { readonly status: number; readonly correlationId: string; readonly code?: string; readonly field?: string; readonly detail?: string }) {
    super(input.detail ?? `API request failed with status ${input.status}`);
    this.name = 'ApiRequestError';
    this.status = input.status;
    this.correlationId = input.correlationId;
    if (input.code) this.code = input.code;
    if (input.field) this.field = input.field;
    if (input.detail) this.detail = input.detail;
  }
}

export function resolveApiBaseUrl(configured: string | undefined, development: boolean): string {
  const value = configured?.trim();
  if (!value) return development ? 'http://127.0.0.1:3000' : '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('VITE_API_BASE_URL must contain only a trusted origin');
  }
  if (parsed.protocol !== 'https:' && !(development && parsed.protocol === 'http:')) {
    throw new Error('VITE_API_BASE_URL must use HTTPS outside development');
  }
  return parsed.origin;
}

export async function getApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, signal ? { signal } : undefined);
    return response.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

export function getCareerReadinessAccessToken(): string | null {
  return getAccessToken();
}

export const getProtectedAccessToken = getCareerReadinessAccessToken;

export interface SecurityContextDto {
  readonly userId: string;
  readonly selectedOrganizationId?: string | null;
  readonly memberships: readonly { readonly organizationId: string; readonly role: string; readonly scope: Record<string, string | undefined> }[];
  readonly studentRelationships?: readonly { readonly institutionId: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null }[];
  /** INST-10: relationships the person left by graduating, transferring or ending; they keep the student workspace. */
  readonly formerStudentRelationships?: readonly { readonly institutionId: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null }[];
}

export function getSecurityContext(token: string, signal?: AbortSignal): Promise<SecurityContextDto> {
  return requestJson('/api/v1/security/context', { token, ...(signal ? { signal } : {}) });
}

export function acceptInvitation(token: string, invitationToken: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  return requestJson('/api/v1/invitations/accept', { token, method: 'POST', idempotencyKey, body: { token: invitationToken } });
}

// --- Calendar -----------------------------------------------------------------

export interface CalendarEntryDto {
  readonly id: string;
  readonly kind: 'INTERVIEW' | 'EXAM' | 'TASK' | 'MEETING' | 'ROADMAP';
  readonly title: string;
  readonly detail: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly location: string | null;
  readonly joinUrl: string | null;
  readonly audience: 'STUDENT' | 'EMPLOYER' | 'STAFF';
}

export function listCalendar(token: string, signal?: AbortSignal): Promise<{
  readonly entries: readonly CalendarEntryDto[];
  readonly range: { readonly from: string; readonly to: string };
}> {
  return requestJson('/api/v1/me/calendar', { token, ...(signal ? { signal } : {}) });
}

// --- Learner content ----------------------------------------------------------

export type LearnerContentType = 'PRACTICE' | 'COMPANY_PREP' | 'CAREER_TOOL' | 'SCHOLARSHIP' | 'RESUME_BUILDER';

export interface LearnerContentItemDto {
  readonly id: string;
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly publishedAt: string | null;
}

export interface LearnerContentOperatorItemDto extends LearnerContentItemDto {
  readonly source: string;
  readonly reviewState: string;
  /** Null for everything today. Surfaced so a generated draft is visibly generated. */
  readonly generatorVersion: string | null;
  readonly promptVersion: string | null;
  readonly generatedAt: string | null;
  readonly createdByUserId: string;
  readonly sortOrder: number;
}

export function listLearnerContent(token: string, contentType: LearnerContentType, signal?: AbortSignal): Promise<{ readonly items: readonly LearnerContentItemDto[] }> {
  return requestJson(`/api/v1/learner-content?contentType=${encodeURIComponent(contentType)}`, { token, ...(signal ? { signal } : {}) });
}

export function listLearnerContentQueue(token: string, contentType?: LearnerContentType, signal?: AbortSignal): Promise<{ readonly items: readonly LearnerContentOperatorItemDto[] }> {
  const query = contentType ? `?contentType=${encodeURIComponent(contentType)}` : '';
  return requestJson(`/api/v1/operations/learner-content${query}`, { token, ...(signal ? { signal } : {}) });
}

export function createLearnerContent(token: string, body: {
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly sortOrder?: number;
}): Promise<{ readonly item: LearnerContentOperatorItemDto }> {
  return requestJson('/api/v1/operations/learner-content', { token, method: 'POST', body });
}

export function transitionLearnerContent(token: string, contentId: string, toState: string, note?: string): Promise<{ readonly item: LearnerContentOperatorItemDto }> {
  return requestJson(`/api/v1/operations/learner-content/${encodeURIComponent(contentId)}/transition`, { token, method: 'POST', body: { toState, ...(note ? { note } : {}) } });
}

// --- Public profile -----------------------------------------------------------

export type CoverKey = 'MIDNIGHT' | 'TEAL' | 'VIOLET' | 'EMBER';

export interface ShareSectionsDto {
  readonly showPhoto: boolean;
  readonly showHeadline: boolean;
  readonly showCity: boolean;
  readonly showInstitution: boolean;
  readonly showEducation: boolean;
  readonly showSelfReported: boolean;
  readonly showAssessments: boolean;
  readonly showLearning: boolean;
  readonly showCertificates: boolean;
  readonly showSkills: boolean;
  readonly showPortfolio: boolean;
}

export interface ShareLinkDto {
  readonly id: string;
  readonly coverKey: CoverKey;
  readonly sections: ShareSectionsDto;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastViewedAt: string | null;
  readonly expired: boolean;
  /** Returned once, when the link is created. Never available again. */
  readonly token?: string;
}

export interface PublicProfileDto {
  readonly coverKey: CoverKey;
  readonly name: string | null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly targetCareer: string | null;
  readonly city: string | null;
  readonly institutionName: string | null;
  readonly expectedGraduation: string | null;
  readonly photoUrl: string | null;
  readonly portfolioUrl: string | null;
  readonly skills: readonly string[];
  readonly education: readonly {
    readonly programmeName: string;
    readonly qualificationType: string;
    readonly institutionName: string | null;
    readonly declaredInstitutionName: string | null;
    readonly startedOn: string | null;
    readonly completedOn: string | null;
    readonly verified: boolean;
    readonly terms: readonly {
      readonly label: string;
      readonly result: string | null;
      readonly verified: boolean;
      readonly verifiedAt: string | null;
    }[];
  }[];
  readonly assessments: readonly { readonly title: string; readonly percentage: number; readonly takenAt: string | null }[];
  readonly learning: readonly { readonly title: string; readonly completedAt: string | null }[];
  readonly certificates: readonly { readonly title: string }[];
  readonly verifiedCount: number;
  readonly totalClaimCount: number;
  readonly expiresAt: string;
}

/** The only read in the web app that carries no access token, deliberately. */
export function readPublicProfile(token: string, signal?: AbortSignal): Promise<{ readonly profile: PublicProfileDto }> {
  return requestJson(`/api/v1/public/profiles/${encodeURIComponent(token)}`, { ...(signal ? { signal } : {}) });
}

export function readMyShareLink(token: string, signal?: AbortSignal): Promise<{ readonly link: ShareLinkDto | null; readonly hasPhoto: boolean }> {
  return requestJson('/api/v1/students/me/public-profile', { token, ...(signal ? { signal } : {}) });
}

export function publishShareLink(token: string, body: {
  readonly days?: number; readonly coverKey?: CoverKey; readonly sections?: Partial<ShareSectionsDto>;
} = {}): Promise<{ readonly link: ShareLinkDto }> {
  return requestJson('/api/v1/students/me/public-profile', { token, method: 'POST', body });
}

export function updateShareSettings(token: string, body: {
  readonly days?: number; readonly coverKey?: CoverKey; readonly sections?: Partial<ShareSectionsDto>;
}): Promise<{ readonly link: ShareLinkDto }> {
  return requestJson('/api/v1/students/me/public-profile/settings', { token, method: 'POST', body });
}

export function revokeShareLinkRequest(token: string): Promise<{ readonly revoked: boolean }> {
  return requestJson('/api/v1/students/me/public-profile', { token, method: 'DELETE' });
}

export function uploadProfilePhoto(token: string, contentType: string, base64Data: string): Promise<{ readonly uploaded: boolean }> {
  return requestJson('/api/v1/students/me/profile-photo', { token, method: 'POST', body: { contentType, data: base64Data } });
}

export function removeProfilePhoto(token: string): Promise<{ readonly removed: boolean }> {
  return requestJson('/api/v1/students/me/profile-photo', { token, method: 'DELETE' });
}
