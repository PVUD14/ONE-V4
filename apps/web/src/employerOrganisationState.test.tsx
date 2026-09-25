/**
 * What an employer sees when its organisation is suspended, rejected or not yet verified
 * (EMP-03). The API refuses those employers (Appendix 2 §5.1); these tests pin the web
 * side: one plain status page for suspended and rejected employers, a notice and honest
 * candidate-page empty states for unverified ones, the normal portal for verified ones,
 * and the navigation unchanged in every state.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });

const employerId = 'employer-1';
const opportunity = {
  id: 'opportunity-1', referenceCode: 'EMP03-FIXTURE', lifecycleState: 'DRAFT', title: 'Fixture Draft Role',
  employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: null, applicationDeadline: null,
  publishedAt: null, applicationCount: 0, openApplicationCount: 0,
};
type VerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

function organisation(verificationState: VerificationState, active = verificationState !== 'SUSPENDED') {
  const verified = verificationState === 'VERIFIED' && active;
  const canDraft = active && ['PENDING', 'UNDER_REVIEW', 'VERIFIED'].includes(verificationState);
  return { verificationState, active, canDraft, canPublish: verified, canReachCandidates: verified };
}

let opportunitiesRequested = 0;
function signInAs(verificationState: VerificationState): void {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  const memberships = [{ organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'employer-token', id_token: jwtWithEmail('recruiter@uat.example.test') }) };
    if (url.endsWith('/health')) return { ok: true };
    if (url.endsWith('/api/v1/me/consents/privacy-notice')) return { ok: true, json: async () => ({ requiredVersion: null, grantedVersion: null, required: false }) };
    if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({ userId: 'employer-user', memberships, studentRelationships: [] }) };
    if (url.endsWith(`/api/v1/employers/${employerId}/organisation-status`)) return { ok: true, json: async () => ({ organisation: organisation(verificationState) }) };
    if (url.endsWith(`/api/v1/employers/${employerId}/opportunities`)) { opportunitiesRequested += 1; return { ok: true, json: async () => ({ opportunities: [opportunity] }) }; }
    return { ok: false };
  }));
}

async function openEmployerPage(verificationState: VerificationState, path: string): Promise<void> {
  signInAs(verificationState);
  const { App } = await import('./App.js');
  render(React.createElement(App));
  await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
  cleanup();
  opportunitiesRequested = 0;
  window.history.pushState(null, '', path);
  render(React.createElement(App));
}

beforeEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.pushState(null, '', '/login');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('EMP-03: employer organisation state in the web portal', () => {
  it('shows a suspended employer the plain status page instead of its jobs', async () => {
    await openEmployerPage('SUSPENDED', '/employer/recruiter/opportunities');
    expect(await screen.findByRole('heading', { name: 'Your organisation is suspended' })).toBeInTheDocument();
    expect(screen.getByText(/your published jobs are paused so students no longer see them/)).toBeInTheDocument();
    expect(screen.queryByText('Fixture Draft Role')).not.toBeInTheDocument();
    expect(opportunitiesRequested).toBe(0);
  });

  it('shows a rejected employer the plain status page on the dashboard too', async () => {
    await openEmployerPage('REJECTED', '/employer/recruiter');
    expect(await screen.findByRole('heading', { name: 'Your organisation was not verified' })).toBeInTheDocument();
    expect(opportunitiesRequested).toBe(0);
  });

  it('keeps every navigation label for a suspended employer', async () => {
    await openEmployerPage('SUSPENDED', '/employer/recruiter/applicants');
    await screen.findByRole('heading', { name: 'Your organisation is suspended' });
    for (const label of ['Opportunities', 'Applicants', 'Interviews', 'Offers', 'Reports', 'Team', 'Settings', 'Help & FAQ']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('lets an unverified employer see its drafts, with a notice', async () => {
    await openEmployerPage('PENDING', '/employer/recruiter/opportunities');
    expect(await screen.findByText('Fixture Draft Role')).toBeInTheDocument();
    expect(screen.getByText('Awaiting verification')).toBeInTheDocument();
  });

  it.each(['/employer/recruiter/applicants', '/employer/recruiter/offers'])('tells an unverified employer that %s opens once verified', async (path) => {
    await openEmployerPage('UNDER_REVIEW', path);
    expect(await screen.findByRole('heading', { name: 'Available once your organisation is verified' })).toBeInTheDocument();
  });

  it('shows a verified employer its portal without any status notice', async () => {
    await openEmployerPage('VERIFIED', '/employer/recruiter/opportunities');
    expect(await screen.findByText('Fixture Draft Role')).toBeInTheDocument();
    expect(screen.queryByText('Awaiting verification')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Your organisation/ })).not.toBeInTheDocument();
  });
});
