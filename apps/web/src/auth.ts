const oauthStateKey = 'planthepath.oauthState';
const oauthVerifierKey = 'planthepath.oauthVerifier';
const oauthReturnPathKey = 'planthepath.oauthReturnPath';
let accessToken: string | null = null;
let authenticatedEmail: string | null = null;

export interface CognitoHostedUiConfig {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly logoutUri: string;
}

export type AuthStatus =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'anonymous'; readonly config: CognitoHostedUiConfig }
  | { readonly state: 'authenticated'; readonly config: CognitoHostedUiConfig; readonly email: string | null };

export function getCognitoHostedUiConfig(): CognitoHostedUiConfig | null {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN?.trim();
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID?.trim();
  const redirectUri = (import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim() || `${window.location.origin}/auth/callback`);
  const logoutUri = (import.meta.env.VITE_COGNITO_LOGOUT_URI?.trim() || window.location.origin);
  if (!domain || !clientId) return null;
  const normalizedDomain = normalizeTrustedUrl(domain, 'Cognito domain');
  const normalizedRedirect = normalizeTrustedUrl(redirectUri, 'Cognito redirect URI');
  const normalizedLogout = normalizeTrustedUrl(logoutUri, 'Cognito logout URI');
  return { domain: normalizedDomain.origin, clientId, redirectUri: normalizedRedirect.toString(), logoutUri: normalizedLogout.toString() };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAuthStatus(): AuthStatus {
  const config = getCognitoHostedUiConfig();
  if (!config) return { state: 'unconfigured' };
  if (accessToken) return { state: 'authenticated', config, email: authenticatedEmail };
  return { state: 'anonymous', config };
}

export async function beginHostedLogin(returnPath = `${window.location.pathname}${window.location.search}`): Promise<void> {
  const config = getCognitoHostedUiConfig();
  if (!config) throw new Error('Cognito Hosted UI is not configured');
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  window.sessionStorage.setItem(oauthStateKey, state);
  window.sessionStorage.setItem(oauthVerifierKey, verifier);
  const safeReturnPath = normalizeSameOriginReturnPath(returnPath);
  if (safeReturnPath) window.sessionStorage.setItem(oauthReturnPathKey, safeReturnPath);
  const challenge = await sha256Base64Url(verifier);
  const url = new URL('/oauth2/authorize', config.domain);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  window.location.assign(url.toString());
}

export async function completeHostedLoginFromLocation(): Promise<boolean> {
  const config = getCognitoHostedUiConfig();
  if (!config) return false;
  const current = new URL(window.location.href);
  const code = current.searchParams.get('code');
  const state = current.searchParams.get('state');
  if (!code) {
    if (current.hash.includes('access_token=') || current.hash.includes('id_token=')) {
      current.hash = '';
      window.history.replaceState(null, '', current.toString());
    }
    return false;
  }
  await completeAuthorizationCodeLogin(config, code, state);
  const returnPath = window.sessionStorage.getItem(oauthReturnPathKey);
  window.sessionStorage.removeItem(oauthReturnPathKey);
  current.search = '';
  current.hash = '';
  window.history.replaceState(null, '', returnPath ? normalizeSameOriginReturnPath(returnPath) ?? current.toString() : current.toString());
  return true;
}

export function signOut(): void {
  const config = getCognitoHostedUiConfig();
  accessToken = null;
  authenticatedEmail = null;
  window.sessionStorage.removeItem(oauthStateKey);
  window.sessionStorage.removeItem(oauthVerifierKey);
  window.sessionStorage.removeItem(oauthReturnPathKey);
  if (!config) return;
  const url = new URL('/logout', config.domain);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', config.logoutUri);
  window.location.assign(url.toString());
}

async function completeAuthorizationCodeLogin(config: CognitoHostedUiConfig, code: string, returnedState: string | null): Promise<void> {
  const expectedState = window.sessionStorage.getItem(oauthStateKey);
  const verifier = window.sessionStorage.getItem(oauthVerifierKey);
  window.sessionStorage.removeItem(oauthStateKey);
  window.sessionStorage.removeItem(oauthVerifierKey);
  if (!expectedState || !returnedState || expectedState !== returnedState || !verifier) throw new Error('Cognito login state is invalid');
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', config.clientId);
  body.set('code', code);
  body.set('redirect_uri', config.redirectUri);
  body.set('code_verifier', verifier);
  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error('Cognito token exchange failed');
  const tokenSet = await response.json() as { readonly access_token?: string; readonly id_token?: string };
  if (!tokenSet.access_token) throw new Error('Cognito token response did not include an access token');
  setAuthenticatedSession(tokenSet.access_token, tokenSet.id_token);
}

function setAuthenticatedSession(token: string, idToken: string | null | undefined): void {
  accessToken = token;
  authenticatedEmail = idToken ? readJwtEmail(idToken) : null;
}

function readJwtEmail(token: string): string | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { readonly email?: unknown };
    return typeof decoded.email === 'string' ? decoded.email : null;
  } catch {
    return null;
  }
}

function normalizeTrustedUrl(value: string, label: string): URL {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !localHttp)) {
    throw new Error(`${label} must be HTTPS or loopback HTTP and must not include credentials, query, or fragment`);
  }
  return url;
}

function normalizeSameOriginReturnPath(value: string): string | null {
  if (!value.startsWith('/')) return null;
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || url.username || url.password || url.hash) return null;
  if (url.pathname === '/auth/callback') return null;
  if (url.pathname === '/invitations/accept') return url.pathname;
  return `${url.pathname}${url.search}`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function getAuthDebugStatus(): string {
  if (!getCognitoHostedUiConfig()) return 'Cognito UAT login is not configured';
  return 'Cognito UAT login is configured';
}
