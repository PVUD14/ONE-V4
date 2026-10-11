/**
 * The Growth portal shell (GROWTH-01, ADR-040): a growth person signs in to their own
 * workspace at /growth with the ONE logo and the approved navigation (HG-3,
 * 2026-09-30), every page says plainly what is not built yet, no figure is invented, and
 * the Operations workspace stays closed to them.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { growthPortal } from './rolePortalConfig.js';

const fetchMock = vi.fn();
let territoryResponse: Record<string, unknown> | null = null;

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
    if (url.endsWith('/api/v1/growth/territory')) {
      return { ok: true, json: async () => (territoryResponse ?? { role, regions: [], correlationId: 'corr-territory' }) };
    }
    if (url.includes('/api/v1/growth/field?view=')) {
      return { ok: true, json: async () => ({
        view: 'MINE', canSeeTeam: role === 'GROWTH_MANAGER', today: '2026-10-01',
        counts: { visitsThisMonth: 2, activitiesThisMonth: 3, metThisMonth: 1, followUpsOverdue: 0, followUpsDueToday: 0, followUpsOpen: 0 },
        followUps: [], activities: [],
        vocabulary: { kinds: ['VISIT'], outcomes: ['MET'], cancelReasons: ['OTHER'], notesMax: 2000, titleMax: 280, reportMaxAgeDays: 7, locationRetentionDays: 180, listLimit: 100,
          locationNotice: { version: 'draft-2026-10', status: 'DRAFT_FOR_LEGAL_REVIEW', text: ['Attaching your location to a visit is optional.'] } },
        correlationId: 'corr-field' }) };
    }
    if (url.endsWith('/api/v1/growth/attributions')) {
      return { ok: true, json: async () => ({ credited: [], disputes: [], disputable: [], windowDays: 90, correlationId: 'corr-attr' }) };
    }
    if (url.endsWith('/api/v1/growth/me')) {
      return { ok: true, json: async () => (me ?? { role, staffType: 'EMPLOYEE', teams: [], correlationId: 'corr-me' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'Not found', correlationId: 'corr-x' } }) };
  });
}

beforeEach(() => {
  territoryResponse = null;
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
  it('lands on the Growth home with the ONE logo, their own team, and NA where no source exists', async () => {
    signInAs('GROWTH_EXECUTIVE', {
      role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR', correlationId: 'corr-me',
      teams: [{ team: 'COLLEGE_PARTNERSHIPS', joinedAt: '2026-09-30T10:00:00.000Z', manager: { email: 'region.manager@uat.example.test' } }],
    });
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    expect(window.location.pathname).toBe('/growth');
    expect(within(sidebar).getByRole('img', { name: 'ONE by AI8HT' })).toBeInTheDocument();
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
    // GROWTH-06 built Field; GROWTH-07 built credit; targets and commission amounts still say plainly they are not built.
    expect(screen.getByText(/Targets and commission amounts are not built yet/i)).toBeInTheDocument();
  });

  it('shows an honest empty state on every other page', async () => {
    signInAs('GROWTH_EXECUTIVE');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    // GROWTH-06: Field is built; GROWTH-07: Commission shows credit (see growthCommission.test.tsx).
    for (const label of ['Targets']) {
      fireEvent.click(within(sidebar).getByRole('button', { name: label }));
      expect(await screen.findByRole('heading', { name: label })).toBeInTheDocument();
      expect(screen.getByText(/is not built yet/i)).toBeInTheDocument();
      expect(within(sidebar).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    }
    // Commission never shows an amount: rates are not set.
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Commission' }));
    expect(await screen.findByRole('heading', { name: 'Credit and commission' })).toBeInTheDocument();
    expect(screen.getByText(/no amount is shown/i)).toBeInTheDocument();
    expect(screen.queryByText(/INR|Rs\./)).not.toBeInTheDocument();
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

describe('Growth → Field (GROWTH-06)', () => {
  it('opens the Field page with the server counts, and Home shows this month visits', async () => {
    signInAs('GROWTH_EXECUTIVE', { role: 'GROWTH_EXECUTIVE', staffType: 'EMPLOYEE', teams: [], openLeads: 1, visitsThisMonth: 2, followUpsDue: 0, correlationId: 'corr-me' });
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    const stats = screen.getByLabelText('Growth summary');
    expect(await within(stats).findByText('2')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is due today/)).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Field' }));
    expect(await screen.findByRole('heading', { name: 'Field', level: 1 })).toBeInTheDocument();
    const field = await screen.findByLabelText('Field summary');
    expect(within(field).getByText('Visits this month').parentElement).toHaveTextContent('2');
    expect(screen.queryByText(/is not built yet/i)).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Field' })).toHaveAttribute('aria-current', 'page');
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

describe('Growth → Territory (GROWTH-02)', () => {
  const since = new Date(Date.now() - 86_400_000).toISOString();

  it('shows an executive the regions they work, the areas, and the region managers, with unowned leads NA', async () => {
    territoryResponse = {
      role: 'GROWTH_EXECUTIVE', correlationId: 'corr-territory',
      regions: [{
        id: 'region-1', name: 'South-1', myRole: 'EXECUTIVE', since,
        areas: [{ stateCode: 'IN-KA', stateName: 'Karnataka', districtCode: null, districtName: null }, { stateCode: 'IN-TN', stateName: 'Tamil Nadu', districtCode: 603, districtName: 'Chennai' }],
        people: [{ email: 'region.manager@uat.example.test', role: 'MANAGER', since }],
      }],
    };
    signInAs('GROWTH_EXECUTIVE');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Territory' }));
    const region = await screen.findByLabelText('Region South-1');
    expect(within(region).getByText('Karnataka (whole state)')).toBeInTheDocument();
    expect(within(region).getByText('Chennai, Tamil Nadu')).toBeInTheDocument();
    expect(within(region).getByText('region.manager@uat.example.test')).toBeInTheDocument();
    expect(within(region).getByText('You work this region')).toBeInTheDocument();
    const stats = screen.getByLabelText('Territory summary');
    expect(within(stats).getAllByText('1')).toHaveLength(2); // one region, one manager
    expect(within(stats).getByText('2')).toBeInTheDocument(); // two areas
    // The unowned-lead count has no source yet: NA in its slot, never a number.
    expect(within(stats).getAllByText('NA')).toHaveLength(1);
    expect(within(stats).getByText('Unowned leads')).toBeInTheDocument();
    expect(screen.queryByText(/Territory is not built yet/i)).not.toBeInTheDocument();
  });

  it('counts the unowned leads of each region once the lead register reports them (GROWTH-03)', async () => {
    territoryResponse = {
      role: 'GROWTH_EXECUTIVE', correlationId: 'corr-territory',
      regions: [
        { id: 'region-1', name: 'South-1', myRole: 'EXECUTIVE', since, areas: [], people: [], unownedLeads: 4 },
        { id: 'region-2', name: 'South-2', myRole: 'EXECUTIVE', since, areas: [], people: [], unownedLeads: 1 },
      ],
    };
    signInAs('GROWTH_EXECUTIVE');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Territory' }));
    expect(within(await screen.findByLabelText('Region South-1')).getByText('4 unowned leads')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Region South-2')).getByText('1 unowned lead')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Territory summary')).getByText('Unowned leads').parentElement).toHaveTextContent('5');
  });

  it('tells a person with no region so plainly, and invents none', async () => {
    signInAs('GROWTH_MANAGER');
    render(<App />);
    const sidebar = await screen.findByLabelText('Growth navigation');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Territory' }));
    expect(await screen.findByText('No region assigned')).toBeInTheDocument();
    const stats = screen.getByLabelText('Territory summary');
    // GROWTH-03: with no region there are truly no unowned leads to see, so that slot is 0 too.
    expect(within(stats).getAllByText('0')).toHaveLength(4);
    expect(screen.queryByLabelText(/^Region /)).not.toBeInTheDocument();
  });
});
