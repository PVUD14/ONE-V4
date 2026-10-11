// Tests for the system pages (re-skin phase 8): an unknown path shows the 404, a page that fails to
// draw shows the 500 without any error text, and a saved session that ran out says so.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PageErrorBoundary } from './systemPages.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
  window.history.pushState(null, '', '/');
});

describe('404', () => {
  it('shows "We can’t find that page" for a path the app does not have', () => {
    window.history.pushState(null, '', '/definitely-not-a-page');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'We can’t find that page' })).toBeInTheDocument();
    expect(screen.getByText(/The link may be out of date or the page has moved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Go to sign in/ }));
    expect(window.location.pathname).toBe('/login');
  });
});

function Broken(): React.ReactElement {
  throw new Error('internal detail: relation "users" does not exist at 10.0.0.12');
}

describe('the error boundary (500)', () => {
  it('shows the approved page and none of the error text, and tries again on request', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Maybe(): React.ReactElement { return broken ? <Broken /> : <p>Recovered page</p>; }
    render(<PageErrorBoundary><Maybe /></PageErrorBoundary>);
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong on our side' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/internal detail|relation|10\.0\.0\.12/);
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(screen.getByText('Recovered page')).toBeInTheDocument();
    quiet.mockRestore();
  });
});

describe('session expired', () => {
  it('says the session has expired when a saved sign-in ran out', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    window.sessionStorage.setItem('planthepath.authSession.v1', JSON.stringify({ accessToken: 'expired-token', idToken: null, refreshToken: null, email: 'student@uat.example.test', username: 'student@uat.example.test', accessTokenExpiresAt: Date.now() - 60_000 }));
    window.history.pushState(null, '', '/student');
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your session has expired' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sign in again/ }));
    expect(window.location.pathname).toBe('/login');
  });
});
