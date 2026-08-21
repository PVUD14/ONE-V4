import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.pushState(null, '', '/student');
});

describe('Cognito Hosted UI browser authentication', () => {
  it('keeps sign-in disabled when non-production Cognito is not configured', async () => {
    const { App } = await import('./App.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    render(React.createElement(App));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByText('ONE PLATFORM')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByText('Secure sign-in is not available in this UAT environment yet.')).toBeInTheDocument();
  });

  it('exchanges a Hosted UI authorization code and uses the returned access token for protected API calls', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') {
        expect(String(init?.body)).toContain('code_verifier=verifier-12345678901234567890');
        return { ok: true, json: async () => ({ access_token: 'uat-access-token', id_token: jwtWithEmail('aanya.student01@example.test') }) };
      }
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/career-readiness/catalog')) return { ok: true, json: async () => ({ pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release', modules: [], assessments: [] }) };
      if (url.endsWith('/api/v1/career-readiness/me')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer uat-access-token');
        return { ok: true, json: async () => ({ catalog: {}, progress: [], attempts: [], evidence: [], mastery: [], readiness: null, roadmap: [], notificationPreferences: null, notifications: [] }) };
      }
      return { ok: false };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    expect(screen.getByText('aanya.student01@example.test')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose your ONE workspace' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Student Learning, readiness/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Student profile menu' })).toHaveTextContent('Aanya Student01'));
    expect(screen.getByText('Authenticated API-backed mode')).toBeInTheDocument();
    expect(screen.getAllByText('API-backed').length).toBeGreaterThan(0);
    expect(screen.queryByText('/100')).not.toBeInTheDocument();
    window.history.pushState(null, '', '/student/readiness');
    render(React.createElement(App));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/career-readiness/me'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer uat-access-token' }),
    })));
    expect(window.sessionStorage.getItem('planthepath.accessToken')).toBeNull();
  });

  it('ignores legacy access-token fragments and requires authorization-code PKCE', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    window.history.pushState(null, '', '/auth/callback#access_token=injected-token');
    const { completeHostedLoginFromLocation, getAccessToken } = await import('./auth.js');
    await expect(completeHostedLoginFromLocation()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('strips invitation token query strings from OAuth return paths', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.sessionStorage.setItem('planthepath.oauthReturnPath', '/invitations/accept?token=raw-invite-token');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'uat-access-token' }) })));
    const { completeHostedLoginFromLocation } = await import('./auth.js');
    await expect(completeHostedLoginFromLocation()).resolves.toBe(true);
    expect(window.location.pathname).toBe('/invitations/accept');
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem('planthepath.oauthReturnPath')).toBeNull();
  });
});
