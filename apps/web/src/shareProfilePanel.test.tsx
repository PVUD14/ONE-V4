import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { ShareProfilePanel } from './shareProfilePanel.js';

const sections = {
  showPhoto: false, showHeadline: true, showCity: true, showInstitution: true,
  showEducation: true, showSelfReported: true, showAssessments: false, showLearning: true,
  showCertificates: true, showSkills: true, showPortfolio: true,
};

const link = {
  id: 'link-1', coverKey: 'MIDNIGHT', sections,
  createdAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2099-12-12T00:00:00.000Z',
  lastViewedAt: null, expired: false,
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('a student controlling their public profile', () => {
  it('offers to create a link when there is none, and shares nothing until then', async () => {
    stub({ '/api/v1/students/me/public-profile': { link: null, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByRole('button', { name: 'Create my public link' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is shared until you turn it on/)).toBeInTheDocument();
    // No switches to get wrong before a link exists.
    expect(screen.queryByRole('heading', { name: 'What your link shows' })).not.toBeInTheDocument();
  });

  it('shows the link once and says it will not be shown again', async () => {
    stub({
      '/api/v1/students/me/public-profile': { link: null, hasPhoto: false },
    }, { '/api/v1/students/me/public-profile:POST': { link: { ...link, token: 'tok-abc123' } } });
    await authenticate();
    render(<ShareProfilePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create my public link' }));
    await waitFor(() => expect(screen.getByText(/\/p\/tok-abc123/)).toBeInTheDocument());
    // Only a fingerprint is stored, so the screen must be honest that this is the one look.
    expect(screen.getByText(/we cannot show it to you again/)).toBeInTheDocument();
  });

  it('starts with the photo and assessment scores switched off', async () => {
    stub({ '/api/v1/students/me/public-profile': { link, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByRole('checkbox', { name: /Show my photo/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Assessment results/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Academic record/ })).toBeChecked();
  });

  it('presents readiness and applications as locked, not as switches', async () => {
    stub({ '/api/v1/students/me/public-profile': { link, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByRole('heading', { name: 'Never shared, whatever you choose' })).toBeInTheDocument();
    expect(screen.getByText(/The database will not let it be made public/)).toBeInTheDocument();
    // They are not choices, so they are not offered as choices.
    expect(screen.queryByRole('checkbox', { name: /Readiness/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /applications/i })).not.toBeInTheDocument();
  });

  it('says switching off reaches everyone who already had the link', async () => {
    stub({ '/api/v1/students/me/public-profile': { link, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByText(/applies to everyone who already has the link/)).toBeInTheDocument();
    expect(screen.getByText(/the old one never comes back/)).toBeInTheDocument();
  });

  it('explains why a cover cannot be uploaded rather than just not offering one', async () => {
    stub({ '/api/v1/students/me/public-profile': { link, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByText(/would need somebody checking it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Teal' })).toBeInTheDocument();
  });

  it('tells the student an expired link can be brought back', async () => {
    stub({ '/api/v1/students/me/public-profile': { link: { ...link, expired: true, expiresAt: '2020-01-01T00:00:00.000Z' }, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    expect(await screen.findByText(/This link has expired. Extend it to make it live again./)).toBeInTheDocument();
  });

  it('refuses a photo of the wrong type before sending anything', async () => {
    stub({ '/api/v1/students/me/public-profile': { link, hasPhoto: false } });
    await authenticate();
    render(<ShareProfilePanel />);
    const input = await screen.findByLabelText('Choose a photo');
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getByText('Choose a JPEG or PNG.')).toBeInTheDocument());
  });
});

function stub(routes: Readonly<Record<string, unknown>>, byMethod: Readonly<Record<string, unknown>> = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const keyed = byMethod[`${path}:${init?.method ?? 'GET'}`];
    return { ok: true, status: 200, json: async () => keyed ?? routes[path] ?? {} };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
