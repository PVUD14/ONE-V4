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
}

export function getSecurityContext(token: string, signal?: AbortSignal): Promise<SecurityContextDto> {
  return requestJson('/api/v1/security/context', { token, ...(signal ? { signal } : {}) });
}

export function acceptInvitation(token: string, invitationToken: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  return requestJson('/api/v1/invitations/accept', { token, method: 'POST', idempotencyKey, body: { token: invitationToken } });
}
