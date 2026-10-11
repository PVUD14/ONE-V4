import { AuthenticationDetails, CognitoRefreshToken, CognitoUser, CognitoUserPool, type CognitoUserSession, type ICognitoStorage } from 'amazon-cognito-identity-js';

const oauthStateKey = 'planthepath.oauthState';
const oauthVerifierKey = 'planthepath.oauthVerifier';
const oauthReturnPathKey = 'planthepath.oauthReturnPath';
const sessionKey = 'planthepath.authSession.v1';
const cognitoStoragePrefix = 'planthepath.cognito.';

let accessToken: string | null = null;
let idToken: string | null = null;
let refreshToken: string | null = null;
let authenticatedEmail: string | null = null;
let authenticatedUsername: string | null = null;
let accessTokenExpiresAt = 0;

export interface CognitoHostedUiConfig {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly logoutUri: string;
  readonly userPoolId?: string;
}

export type AuthStatus =
  | { readonly state: 'restoring' }
  | { readonly state: 'unconfigured' }
  | { readonly state: 'anonymous'; readonly config: CognitoHostedUiConfig }
  | { readonly state: 'authenticated'; readonly config: CognitoHostedUiConfig; readonly email: string | null };

export type DirectLoginResult =
  | { readonly state: 'success' }
  | { readonly state: 'invalid_credentials' }
  | { readonly state: 'password_reset_required' }
  | { readonly state: 'new_password_required' }
  | { readonly state: 'mfa_required' }
  | { readonly state: 'session_expired' }
  | { readonly state: 'unconfigured' }
  | { readonly state: 'error' };

interface PersistedSession {
  readonly accessToken: string;
  readonly idToken?: string | null;
  readonly refreshToken?: string | null;
  readonly email?: string | null;
  readonly username?: string | null;
  readonly accessTokenExpiresAt: number;
}

export function getCognitoHostedUiConfig(): CognitoHostedUiConfig | null {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN?.trim();
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID?.trim();
  const redirectUri = (import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim() || `${window.location.origin}/auth/callback`);
  const logoutUri = (import.meta.env.VITE_COGNITO_LOGOUT_URI?.trim() || `${window.location.origin}/login`);
  const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID?.trim();
  if (!domain || !clientId) return null;
  const normalizedDomain = normalizeTrustedUrl(domain, 'Cognito domain');
  const normalizedRedirect = normalizeTrustedUrl(redirectUri, 'Cognito redirect URI');
  const normalizedLogout = normalizeTrustedUrl(logoutUri, 'Cognito logout URI');
  return { domain: normalizedDomain.origin, clientId, redirectUri: normalizedRedirect.toString(), logoutUri: normalizedLogout.toString(), ...(userPoolId ? { userPoolId } : {}) };
}

export function getAccessToken(): string | null {
  return isCurrentAccessTokenUsable() ? accessToken : null;
}

export function getAuthStatus(): AuthStatus {
  const config = getCognitoHostedUiConfig();
  if (!config) return { state: 'unconfigured' };
  if (isCurrentAccessTokenUsable()) return { state: 'authenticated', config, email: authenticatedEmail };
  return { state: 'anonymous', config };
}

/**
 * True when this tab holds a saved session whose access token has run out. Read it before
 * restoreAuthenticatedSession (which clears such a session): when the restore then ends signed
 * out, the app shows "Your session has expired" rather than a plain sign-in prompt (re-skin phase 8).
 */
export function hasExpiredStoredSession(): boolean {
  const persisted = readPersistedSession();
  return Boolean(persisted && persisted.accessTokenExpiresAt <= Date.now() + 30_000);
}

export function hasStoredAuthSession(): boolean {
  return window.sessionStorage.getItem(sessionKey) !== null;
}

export async function restoreAuthenticatedSession(): Promise<AuthStatus> {
  const config = getCognitoHostedUiConfig();
  if (!config) {
    clearStoredAuthSession();
    return { state: 'unconfigured' };
  }
  const persisted = readPersistedSession();
  if (!persisted) return { state: 'anonymous', config };
  applyPersistedSession(persisted);
  if (isCurrentAccessTokenUsable()) return { state: 'authenticated', config, email: authenticatedEmail };
  if (persisted.refreshToken && config.userPoolId && persisted.username) {
    try {
      await refreshAuthenticatedSession(config, persisted.username, persisted.refreshToken);
      return { state: 'authenticated', config, email: authenticatedEmail };
    } catch {
      clearStoredAuthSession();
      return { state: 'anonymous', config };
    }
  }
  clearStoredAuthSession();
  return { state: 'anonymous', config };
}

export async function signInWithPassword(username: string, password: string): Promise<DirectLoginResult> {
  const config = getCognitoHostedUiConfig();
  if (!config?.userPoolId) return { state: 'unconfigured' };
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) return { state: 'invalid_credentials' };
  const pool = createUserPool(config);
  const user = new CognitoUser({ Username: normalizedUsername, Pool: pool, Storage: sessionScopedCognitoStorage });
  user.setAuthenticationFlowType('USER_SRP_AUTH');
  const details = new AuthenticationDetails({ Username: normalizedUsername, Password: password });
  try {
    const session = await authenticateUser(user, details);
    setAuthenticatedSessionFromCognito(session, normalizedUsername);
    return { state: 'success' };
  } catch (error) {
    return mapCognitoError(error);
  }
}

/**
 * Self-service password reset. Cognito emails a one-time code; the person enters it with a new
 * password. "No such account" collapses into the same answer as success, so the reset form never
 * tells a visitor which addresses have accounts on ONE.
 */
export type PasswordResetResult =
  | { readonly state: 'code_sent' }
  | { readonly state: 'reset' }
  | { readonly state: 'code_invalid' }
  | { readonly state: 'code_expired' }
  | { readonly state: 'password_rejected' }
  | { readonly state: 'rate_limited' }
  | { readonly state: 'unconfigured' }
  | { readonly state: 'error' };

export async function requestPasswordReset(username: string): Promise<PasswordResetResult> {
  const config = getCognitoHostedUiConfig();
  if (!config?.userPoolId) return { state: 'unconfigured' };
  const user = new CognitoUser({ Username: username.trim(), Pool: createUserPool(config), Storage: sessionScopedCognitoStorage });
  try {
    await new Promise<void>((resolve, reject) => {
      user.forgotPassword({ onSuccess: () => resolve(), onFailure: (error) => reject(error), inputVerificationCode: () => resolve() });
    });
    return { state: 'code_sent' };
  } catch (error) {
    return mapPasswordResetError(error, 'code_sent');
  }
}

export async function confirmPasswordReset(username: string, code: string, newPassword: string): Promise<PasswordResetResult> {
  const config = getCognitoHostedUiConfig();
  if (!config?.userPoolId) return { state: 'unconfigured' };
  const user = new CognitoUser({ Username: username.trim(), Pool: createUserPool(config), Storage: sessionScopedCognitoStorage });
  try {
    await new Promise<void>((resolve, reject) => {
      user.confirmPassword(code.trim(), newPassword, { onSuccess: () => resolve(), onFailure: (error) => reject(error) });
    });
    return { state: 'reset' };
  } catch (error) {
    return mapPasswordResetError(error, 'code_invalid');
  }
}

function mapPasswordResetError(error: unknown, unknownAccount: 'code_sent' | 'code_invalid'): PasswordResetResult {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : '';
  const value = code || name;
  if (value === 'UserNotFoundException' || value === 'NotAuthorizedException') return { state: unknownAccount };
  if (value === 'CodeMismatchException') return { state: 'code_invalid' };
  if (value === 'ExpiredCodeException') return { state: 'code_expired' };
  if (value === 'InvalidPasswordException') return { state: 'password_rejected' };
  if (value === 'LimitExceededException' || value === 'TooManyRequestsException' || value === 'TooManyFailedAttemptsException') return { state: 'rate_limited' };
  return { state: 'error' };
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
  clearStoredAuthSession();
  if (!config) {
    window.history.replaceState(null, '', '/login');
    return;
  }
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
  const tokenSet = await response.json() as { readonly access_token?: string; readonly id_token?: string; readonly refresh_token?: string };
  if (!tokenSet.access_token) throw new Error('Cognito token response did not include an access token');
  setAuthenticatedSession(tokenSet.access_token, tokenSet.id_token, tokenSet.refresh_token, readJwtEmail(tokenSet.id_token ?? '') ?? null);
}

function authenticateUser(user: CognitoUser, details: AuthenticationDetails): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(session),
      onFailure: (error) => reject(error),
      newPasswordRequired: () => reject({ code: 'NEW_PASSWORD_REQUIRED' }),
      mfaRequired: () => reject({ code: 'MFA_REQUIRED' }),
      totpRequired: () => reject({ code: 'MFA_REQUIRED' }),
      mfaSetup: () => reject({ code: 'MFA_REQUIRED' }),
      selectMFAType: () => reject({ code: 'MFA_REQUIRED' }),
      customChallenge: () => reject({ code: 'MFA_REQUIRED' }),
    });
  });
}

function refreshAuthenticatedSession(config: CognitoHostedUiConfig, username: string, token: string): Promise<void> {
  const pool = createUserPool(config);
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: sessionScopedCognitoStorage });
  return new Promise((resolve, reject) => {
    user.refreshSession(new CognitoRefreshToken({ RefreshToken: token }), (error, session) => {
      if (error || !session) {
        reject(error ?? new Error('refresh failed'));
        return;
      }
      setAuthenticatedSessionFromCognito(session as CognitoUserSession, username);
      resolve();
    });
  });
}

function setAuthenticatedSessionFromCognito(session: CognitoUserSession, username: string): void {
  const nextAccessToken = session.getAccessToken().getJwtToken();
  const nextIdToken = session.getIdToken().getJwtToken();
  const nextRefreshToken = session.getRefreshToken().getToken();
  const expiresAt = session.getAccessToken().getExpiration() * 1000;
  setAuthenticatedSession(nextAccessToken, nextIdToken, nextRefreshToken, readJwtEmail(nextIdToken) ?? username, username, expiresAt);
}

function setAuthenticatedSession(token: string, nextIdToken: string | null | undefined, nextRefreshToken?: string | null, email?: string | null, username?: string | null, expiresAt?: number): void {
  accessToken = token;
  idToken = nextIdToken ?? null;
  refreshToken = nextRefreshToken ?? null;
  authenticatedEmail = email ?? (idToken ? readJwtEmail(idToken) : null);
  authenticatedUsername = username ?? authenticatedEmail;
  accessTokenExpiresAt = expiresAt ?? readJwtExpirationMillis(token) ?? Date.now() + (55 * 60 * 1000);
  persistSession();
}

function persistSession(): void {
  if (!accessToken) return;
  const persisted: PersistedSession = {
    accessToken,
    idToken,
    refreshToken,
    email: authenticatedEmail,
    username: authenticatedUsername,
    accessTokenExpiresAt,
  };
  window.sessionStorage.setItem(sessionKey, JSON.stringify(persisted));
}

function readPersistedSession(): PersistedSession | null {
  const raw = window.sessionStorage.getItem(sessionKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.accessTokenExpiresAt !== 'number') return null;
    return {
      accessToken: parsed.accessToken,
      idToken: typeof parsed.idToken === 'string' ? parsed.idToken : null,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      username: typeof parsed.username === 'string' ? parsed.username : null,
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
    };
  } catch {
    return null;
  }
}

function applyPersistedSession(persisted: PersistedSession): void {
  accessToken = persisted.accessToken;
  idToken = persisted.idToken ?? null;
  refreshToken = persisted.refreshToken ?? null;
  authenticatedEmail = persisted.email ?? (idToken ? readJwtEmail(idToken) : null);
  authenticatedUsername = persisted.username ?? authenticatedEmail;
  accessTokenExpiresAt = persisted.accessTokenExpiresAt;
}

function clearStoredAuthSession(): void {
  accessToken = null;
  idToken = null;
  refreshToken = null;
  authenticatedEmail = null;
  authenticatedUsername = null;
  accessTokenExpiresAt = 0;
  window.sessionStorage.removeItem(sessionKey);
  window.sessionStorage.removeItem(oauthStateKey);
  window.sessionStorage.removeItem(oauthVerifierKey);
  window.sessionStorage.removeItem(oauthReturnPathKey);
  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(cognitoStoragePrefix)) window.sessionStorage.removeItem(key);
  }
}

function isCurrentAccessTokenUsable(): boolean {
  return Boolean(accessToken && accessTokenExpiresAt > Date.now() + 30_000);
}

function createUserPool(config: CognitoHostedUiConfig): CognitoUserPool {
  if (!config.userPoolId) throw new Error('Cognito user pool ID is not configured');
  return new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId, Storage: sessionScopedCognitoStorage });
}

const sessionScopedCognitoStorage: ICognitoStorage = {
  setItem(key, value) { window.sessionStorage.setItem(`${cognitoStoragePrefix}${key}`, value); },
  getItem(key) { return window.sessionStorage.getItem(`${cognitoStoragePrefix}${key}`); },
  removeItem(key) { window.sessionStorage.removeItem(`${cognitoStoragePrefix}${key}`); },
  clear() {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(cognitoStoragePrefix)) window.sessionStorage.removeItem(key);
    }
  },
};

function mapCognitoError(error: unknown): DirectLoginResult {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : '';
  const value = code || name;
  if (['NotAuthorizedException', 'UserNotFoundException'].includes(value)) return { state: 'invalid_credentials' };
  if (value === 'PasswordResetRequiredException') return { state: 'password_reset_required' };
  if (value === 'NEW_PASSWORD_REQUIRED') return { state: 'new_password_required' };
  if (value === 'MFA_REQUIRED' || value.endsWith('_MFA')) return { state: 'mfa_required' };
  if (value === 'SESSION_EXPIRED' || value === 'TokenRefreshException') return { state: 'session_expired' };
  return { state: 'error' };
}

function readJwtEmail(token: string): string | null {
  const payload = readJwtPayload(token);
  return typeof payload?.email === 'string' ? payload.email : null;
}

function readJwtExpirationMillis(token: string): number | null {
  const payload = readJwtPayload(token);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as Record<string, unknown>;
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
  const config = getCognitoHostedUiConfig();
  if (!config) return 'Cognito UAT login is not configured';
  if (!config.userPoolId) return 'Cognito UAT password sign-in is not configured';
  return 'Cognito UAT login is configured';
}
