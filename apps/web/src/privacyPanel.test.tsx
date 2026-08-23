import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { StudentPrivacyPanel } from './privacyPanel.js';

/**
 * Deletion is irreversible once its window elapses, so what matters here is that the
 * consequences and the grace period are stated before the student can act, and that
 * cancelling is always visible while the request is open.
 */

let requests: unknown[] = [];
let postResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 201, body: {} };
let lastPost = '';

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  requests = [];
  lastPost = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token' }) };
    if (init?.method === 'POST') {
      lastPost = url;
      return { ok: postResponse.ok, status: postResponse.status, json: async () => postResponse.body };
    }
    if (url.includes('/privacy/requests')) return { ok: true, status: 200, json: async () => ({ requests }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}

describe('data export', () => {
  it('offers a copy of the data and says how long it lasts', async () => {
    await authenticate();
    render(<StudentPrivacyPanel />);
    expect(await screen.findByRole('button', { name: 'Prepare my data' })).toBeInTheDocument();
    expect(screen.getByText(/stays available for seven days/)).toBeInTheDocument();
  });

  it('offers the download once the export is ready', async () => {
    requests = [{ id: 'r-1', requestType: 'EXPORT', state: 'READY', requestedAt: '2026-08-01T00:00:00.000Z', completedAt: null, cancelledAt: null, scheduledFor: null, expiresAt: '2026-08-08T00:00:00.000Z', downloadedAt: null, rejectionReasonCode: null }];
    await authenticate();
    render(<StudentPrivacyPanel />);
    expect(await screen.findByRole('button', { name: 'Download your data' })).toBeInTheDocument();
    expect(screen.getByText(/Available until/)).toBeInTheDocument();
  });

  it('explains a duplicate export instead of showing a raw code', async () => {
    postResponse = { ok: false, status: 400, body: { error: { code: 'EXPORT_ALREADY_REQUESTED' } } };
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare my data' }));
    await waitFor(() => expect(screen.getByText(/already have an export in progress/)).toBeInTheDocument());
  });
});

describe('account deletion', () => {
  it('does not delete on a single click', async () => {
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    // Confirmation only; nothing has been sent.
    expect(lastPost).toBe('');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('states what is kept and what is removed before confirming', async () => {
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    expect(screen.getByText(/removes your profile, your documents and your saved opportunities/i)).toBeInTheDocument();
    expect(screen.getByText(/an employer keeps the fact that you applied/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing happens for 30 days/i)).toBeInTheDocument();
  });

  it('lets the student back out of the confirmation', async () => {
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(lastPost).toBe('');
  });

  it('confirms the scheduled date after the request is made', async () => {
    postResponse = { ok: true, status: 201, body: { request: { id: 'd-1', state: 'RECEIVED', scheduledFor: '2026-09-30T00:00:00.000Z' }, gracePeriodDays: 30 } };
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete my account' }));
    await waitFor(() => expect(screen.getByText(/scheduled for deletion on/)).toBeInTheDocument());
    expect(lastPost).toContain('/privacy/deletions');
  });

  it('keeps the way out visible while a deletion is pending', async () => {
    requests = [{ id: 'd-1', requestType: 'DELETION', state: 'RECEIVED', requestedAt: '2026-08-01T00:00:00.000Z', completedAt: null, cancelledAt: null, scheduledFor: '2026-08-31T00:00:00.000Z', expiresAt: null, downloadedAt: null, rejectionReasonCode: null }];
    await authenticate();
    render(<StudentPrivacyPanel />);
    expect(await screen.findByRole('button', { name: 'Keep my account' })).toBeInTheDocument();
    expect(screen.getByText(/scheduled for deletion on/)).toBeInTheDocument();
    // The destructive path is not offered again while one is already pending.
    expect(screen.queryByRole('button', { name: 'Delete my account…' })).not.toBeInTheDocument();
  });

  it('says plainly that nothing was removed after cancelling', async () => {
    requests = [{ id: 'd-1', requestType: 'DELETION', state: 'RECEIVED', requestedAt: '2026-08-01T00:00:00.000Z', completedAt: null, cancelledAt: null, scheduledFor: '2026-08-31T00:00:00.000Z', expiresAt: null, downloadedAt: null, rejectionReasonCode: null }];
    postResponse = { ok: true, status: 201, body: {} };
    await authenticate();
    render(<StudentPrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my account' }));
    await waitFor(() => expect(screen.getByText(/Nothing has been deleted/)).toBeInTheDocument());
  });
});
