/**
 * The Growth portal shell (GROWTH-01, ADR-040): a growth person signs in to their own
 * workspace at /growth with the AI8HT wordmark and the approved navigation (HG-3,
 * 2026-09-30), every page says plainly what is not built yet, no figure is invented, and
 * the Operations workspace stays closed to them.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { growthPortal } from './rolePortalConfig.js';

const fetchMock = vi.fn();

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

function signInAs(role: 'GROWTH_EXECUTIVE' | 'GROWTH_MANAGER', me: Record<string, unknown> | null = null): void {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  fetchMock.mockImplementation(async (url: string) => {
    if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'growth-token', id_token: jwtWithEmail('field@uat.example.test') }) };
    if (url.endsWith('/health')) return { ok: true };
    if (url.endsWith('/api/v1/me/consents/privacy-notice')) return { ok: true, json: async () => ({ requiredVersion: null, grantedVersion: null, required: false }) };
    if (url.endsWith('/api/v1/security/context')) {
      return { ok: true, json: async () => ({ userId: 'growth-user', memberships: [{ organizationId: 'platform-1', role, scope: { organizationId: 'platform-1' } }] }) };
    }
    if (url.endsWith('/api/v1/growth/me')) {
      return { ok: true, json: async () => (me ?? { role, staffType: 'EMPLOYEE', teams: [], correlationId: 'corr-me' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'Not found', correlationId: 'corr-x' } }) };
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.sessionStorage.clear();
});

describe('the Growth portal navigation (HG-3 approved 2026-09-30)', () => {
  it('is exactly the approved items, in order, with Team for managers only', () => {
    expect(growthPortal.basePath).toBe('/growth');
    expect(growthPortal.nav.map((item) => [item.label, item.path])).toEqual([
      ['Home', '/growth'],
      ['Leads', '/growth/leads'],
      ['Field', '/growth/field'],
      ['Territory', '/growth/territory'],
      ['Targets', '/growth/targets'],
      ['Commission', '/growth/commission'],
      ['Team', '/growth/team'],
    ]);
    expect(growthPortal.nav.find((item) => item.label === 'Team')?.roles).toEqual(['GROWTH_MANAGER']);
    // No preview people or figures ride along with this portal.
    expect(growthPortal.kpis).toEqual([]);
    expect(growthPortal.records).toEqual([]);
  });
});

describe('a growth executive signing in', () => {
  it('lands on the Growth home with the wordmark, their own team, and NA where no source exists', async () => {
    signInAs('GROWTH_EXECUTIVE', {
      role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR', correlationId: 'corr-me',
      teams: [{ team: 'COLLEGE_PARTNERSHIPS', joinedAt: '2026-09-30T10:00:00.000Z', manager: { email: 'region.manager@uat.example.test' } }],
    });
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    expect(window.location.pathname).toBe('/growth');
    expect(within(sidebar).getByRole('img', { name: 'AI8HT' })).toBeInTheDocument();
    for (const label of ['Home', 'Leads', 'Field', 'Territory', 'Targets', 'Commission']) {
      expect(within(sidebar).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(sidebar).queryByRole('button', { name: 'Team' })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    expect(await screen.findByText('College partnerships')).toBeInTheDocument();
    expect(screen.getByText(/region\.manager@uat\.example\.test/)).toBeInTheDocument();
    expect(screen.getByText('Contractor')).toBeInTheDocument();
    const stats = screen.getByLabelText('Growth summary');
    for (const label of ['Open leads', 'Visits this month', 'Target progress', 'Commission this month']) {
      expect(within(stats).getByText(label)).toBeInTheDocument();
    }
    // Every figure slot is NA until its source exists: nothing is invented.
    expect(within(stats).getAllByText('NA')).toHaveLength(4);
    expect(within(stats).queryByText(/\d/)).not.toBeInTheDocument();
    expect(screen.getByText(/Leads, field visits, territory, targets and commission are not built yet/i)).toBeInTheDocument();
  });

  it('shows an honest empty state on every other page', async () => {
    signInAs('GROWTH_EXECUTIVE');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    for (const label of ['Leads', 'Field', 'Territory', 'Targets', 'Commission']) {
      fireEvent.click(within(sidebar).getByRole('button', { name: label }));
      expect(await screen.findByRole('heading', { name: label })).toBeInTheDocument();
      expect(screen.getByText(/is not built yet/i)).toBeInTheDocument();
      expect(within(sidebar).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    }
    // Commission never shows an amount: rates are not set.
    expect(screen.getByText(/no amount is shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/₹|INR|Rs\./)).not.toBeInTheDocument();
  });

  it('cannot open the Operations workspace', async () => {
    signInAs('GROWTH_EXECUTIVE');
    render(<App />);
    await screen.findByLabelText('Growth navigation');
    cleanup();
    window.history.pushState(null, '', '/operations/admin');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'You do not have access to this workspace' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Growth navigation')).not.toBeInTheDocument();
  });
});

describe('a growth manager signing in', () => {
  it('also sees Team, which says plainly it is not built yet', async () => {
    signInAs('GROWTH_MANAGER');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Team' }));
    expect(await screen.findByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByText(/is not built yet/i)).toBeInTheDocument();
    // A manager with no team rows yet is told so, not shown someone else's team.
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Home' }));
    expect(await screen.findByText(/not on a team yet/i)).toBeInTheDocument();
  });
});
