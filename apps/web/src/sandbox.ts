/**
 * The sandbox build of the real application (demo.oneby8.com, ADR-046).
 *
 * demo.oneby8.com runs this same application against its own API and database of
 * fictional sample data. Two things differ, both decided at build time so the
 * oneby8.com bundle is unchanged:
 *
 * - every screen carries the "Demo - sample data" marker (sandboxMarker.tsx);
 * - the sign-in token travels as X-One-Authorization, because the browser is already
 *   sending the demo host's per-person lock (HTTP basic auth) in Authorization. Caddy
 *   turns it back into Authorization for the sandbox API (deploy/vps/Caddyfile).
 */
export const isSandboxBuild = import.meta.env.VITE_SANDBOX === 'true';

export const authHeaderName: string = isSandboxBuild ? 'X-One-Authorization' : 'Authorization';

/** The header that carries the user's access token to the API. */
export function bearerHeader(token: string): Record<string, string> {
  return { [authHeaderName]: `Bearer ${token}` };
}
