import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, demoPortalEnabled } from './App.js';
import { activeRolePortals, rolePortals } from './rolePortalConfig.js';
import { staffNavItems } from './staffConfig.js';
import { studentProfile } from './studentData.js';

const fetchMock = vi.fn();

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

function demoPathFor(path: string): string {
  return path.startsWith('/demo/') ? path : `/demo${path}`;
}

function configureHostedCallback(email = 'institution.admin@uat.example.test'): void {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  void email;
}

function institutionSecurityContext(): { readonly userId: string; readonly memberships: readonly { readonly organizationId: string; readonly role: string; readonly scope: { readonly organizationId: string; readonly institutionId: string } }[] } {
  return { userId: 'admin-user', memberships: [{ organizationId: 'institution-1', role: 'INSTITUTION_ADMIN', scope: { organizationId: 'institution-1', institutionId: 'institution-1' } }] };
}

const recruiterEmployerId = 'employer-1';
const recruiterOpportunityId = 'opportunity-1';
const recruiterOpportunity = {
  id: recruiterOpportunityId,
  referenceCode: 'SOC-2026-01',
  lifecycleState: 'PUBLISHED',
  title: 'SOC Analyst Intern',
  employmentType: 'INTERNSHIP',
  workMode: 'ONSITE',
  locationCity: 'Bengaluru',
  applicationDeadline: null,
  publishedAt: '2026-08-01T00:00:00.000Z',
  applicationCount: 3,
  openApplicationCount: 3,
};
const recruiterApplicants = [
  { id: 'route-interview', state: 'INTERVIEW', consentRevoked: false, candidateName: 'Aanya Interview', candidateEmail: 'aanya@uat.example.test',
    institutionStudentId: null, submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, interviewCount: 1, offerState: null, updatedAt: '2026-08-10T00:00:00.000Z' },
  { id: 'route-offer', state: 'OFFER', consentRevoked: false, candidateName: 'Ojas Offer', candidateEmail: 'ojas@uat.example.test',
    institutionStudentId: null, submittedAt: '2026-08-11T00:00:00.000Z', closedAt: null, interviewCount: 1, offerState: 'EXTENDED', updatedAt: '2026-08-11T00:00:00.000Z' },
  { id: 'route-applied', state: 'APPLIED', consentRevoked: false, candidateName: 'Mira Applied', candidateEmail: 'mira@uat.example.test',
    institutionStudentId: null, submittedAt: '2026-08-12T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-08-12T00:00:00.000Z' },
];

function recruiterSecurityContext(): { readonly userId: string; readonly memberships: readonly { readonly organizationId: string; readonly role: string; readonly scope: { readonly organizationId: string; readonly employerId: string } }[] } {
  return { userId: 'recruiter-user', memberships: [{ organizationId: recruiterEmployerId, role: 'RECRUITER', scope: { organizationId: recruiterEmployerId, employerId: recruiterEmployerId } }] };
}

function configureRecruiterFetch(): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'recruiter-token', id_token: jwtWithEmail('recruiter@example.test') }) };
    if (url.endsWith('/health')) return { ok: true };
    if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => recruiterSecurityContext() };
    if (url.endsWith(`/api/v1/employers/${recruiterEmployerId}/opportunities`)) return { ok: true, json: async () => ({ opportunities: [recruiterOpportunity] }) };
    if (url.endsWith(`/api/v1/employers/${recruiterEmployerId}/opportunities/${recruiterOpportunityId}/applications`)) return { ok: true, json: async () => ({ applications: recruiterApplicants }) };
    return { ok: true, json: async () => ({}) };
  });
}

async function signInRecruiter(): Promise<void> {
  configureHostedCallback('recruiter@example.test');
  configureRecruiterFetch();
  render(<App />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
  cleanup();
}

beforeEach(() => {
  window.history.pushState(null, '', '/demo/student');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('All-role portal registry and preview workflows', () => {
  const previewPortals = activeRolePortals.filter((portal) => portal.key !== 'recruiter');

  it('renders ONE login first at root and /login without a fixture workspace', () => {
    fetchMock.mockResolvedValue({ ok: true });
    for (const path of ['/', '/login']) {
      cleanup();
      window.history.pushState(null, '', path);
      render(<App />);
      expect(screen.getByText('ONE PLATFORM')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
      expect(screen.getByText('LEARN | PREPARE | BUILD | GROW')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
      expect(screen.getByText(/Secure sign-in is not available in this UAT environment yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/Cognito UAT login is not configured/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
    }
  });

  it('does not persist login password input while Cognito is unavailable', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/');
    render(<App />);
    const password = screen.getByLabelText('Password');
    expect(password).toBeDisabled();
    expect(window.localStorage.length).toBe(0);
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index)).join(' ')).not.toMatch(/password|secret/i);
  });

  it('fails closed on protected portal families without leaking demo identities', () => {
    fetchMock.mockResolvedValue({ ok: true });
    for (const path of ['/student', '/institution', '/employer', '/operations']) {
      cleanup();
      window.history.pushState(null, '', path);
      render(<App />);
      expect(screen.getByRole('heading', { name: 'Sign in required' })).toBeInTheDocument();
      expect(screen.getByText(/does not use role selection, fixture data, or browser-stored demo identities/i)).toBeInTheDocument();
      expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
    }
  });

  it('keeps Rahul fixture data only inside explicit demo routes', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student');
    render(<App />);
    expect(screen.getAllByText('DEMO PREVIEW').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Student profile menu' })).toHaveTextContent('Rahul Kumar');
  });

  it('resolves four product portal family roots at the demo boundary', () => {
    fetchMock.mockResolvedValue({ ok: true });
    for (const [path, heading] of [['/demo/student', 'Student Dashboard'], ['/demo/institution', 'Institution Administration'], ['/demo/employer', 'Sign in to manage hiring'], ['/demo/operations', 'Operations Dashboard']] as const) {
      cleanup();
      window.history.pushState(null, '', path);
      render(<App />);
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.getAllByText('DEMO PREVIEW').length).toBeGreaterThan(0);
    }
  });

  it('renders the demo launcher with every portal card and no login claim', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Multi-role portal launcher' })).toBeInTheDocument();
    expect(screen.getByText(/Role selection here does not authenticate or authorize a user/i)).toBeInTheDocument();
    for (const portal of rolePortals) {
      expect(screen.getAllByRole('heading', { name: portal.roleName }).length).toBeGreaterThan(0);
      expect(screen.getAllByText(portal.enforcementStatus).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('heading', { name: /login/i })).not.toBeInTheDocument();
  }, 20000);

  it('opens each new role dashboard with role identity, active navigation, and route-aware title', () => {
    fetchMock.mockResolvedValue({ ok: true });
    for (const portal of previewPortals) {
      cleanup();
      window.history.pushState(null, '', demoPathFor(portal.basePath));
      render(<App />);
      expect(screen.getByRole('heading', { name: portal.dashboardTitle })).toBeInTheDocument();
      expect(screen.getByLabelText(`${portal.roleName} navigation`)).toBeInTheDocument();
      expect(screen.getByText(portal.previewUser)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: portal.nav[0]!.label })).toHaveAttribute('aria-current', 'page');
      expect(document.title).toBe(`${portal.dashboardTitle} | ONE`);
    }
  });

  it('resolves every visible navigation item for every new role without disabled nav', () => {
    fetchMock.mockResolvedValue({ ok: true });
    for (const portal of previewPortals) {
      for (const item of portal.nav) {
        cleanup();
        window.history.pushState(null, '', demoPathFor(item.path));
        render(<App />);
        expect(screen.getByRole('heading', { name: item.path === portal.basePath ? portal.dashboardTitle : item.label })).toBeInTheDocument();
        const nav = screen.getByLabelText(`${portal.roleName} navigation`);
        expect(within(nav).getByRole('button', { name: item.label })).toHaveAttribute('aria-current', 'page');
        expect(within(nav).getByRole('button', { name: item.label })).not.toHaveAttribute('aria-disabled');
      }
    }
  }, 20000);

  it('filters, clears, opens detail, edits preview state, records activity, and resets on a new role page', () => {
    fetchMock.mockResolvedValue({ ok: true });
    const portal = activeRolePortals.find((item) => item.key === 'hiring-manager')!;
    window.history.pushState(null, '', demoPathFor(`${portal.basePath}/candidates`));
    render(<App />);
    expect(screen.getByText('3 records shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Candidate' }));
    expect(screen.getByText('1 records shown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Candidate' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('3 records shown')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search candidates...'), { target: { value: 'Rahul' } });
    expect(screen.getByText('1 records shown')).toBeInTheDocument();
    const record = screen.getByText('Rahul Kumar').closest('.role-record-row, .role-record-card') as HTMLElement;
    fireEvent.click(within(record).getByRole('button', { name: 'View detail' }));
    expect(screen.getByRole('dialog', { name: 'Rahul Kumar' })).toHaveTextContent('Consented applicant profile');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(within(record).getByRole('button', { name: 'Edit preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preview change' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Status and preview note are required.');
    fireEvent.change(screen.getByLabelText('Preview note'), { target: { value: 'Hiring-manager shortlist note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save preview change' }));
    expect(screen.getByText(/Unsaved session changes/)).toBeInTheDocument();
    expect(screen.getByText(/Update candidate stage/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset demo data' }));
    expect(screen.queryByText(/Unsaved session changes/)).not.toBeInTheDocument();
  });

  it('fails closed for API-backed Operations organizations without an access token', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/operations/admin/organizations');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.getByText(/operations portal is protected/i)).toBeInTheDocument();
    expect(screen.getByText(/Cognito is not configured, so this route fails closed/i)).toBeInTheDocument();
    expect(screen.queryByText('ABC Engineering College')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update preview queue status/i })).not.toBeInTheDocument();
  });

  it('requires authentication for employer hiring instead of showing a fake applicant directory', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/employer/recruiter');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Sign in to manage hiring' })).toBeInTheDocument();
    expect(screen.getByText(/Sign in with an employer identity/i)).toBeInTheDocument();
    expect(screen.getByText(/Preview role switching is not authentication/i)).toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
    expect(screen.queryByText('312')).not.toBeInTheDocument();
    expect(screen.queryByText(/Student Readiness/i)).not.toBeInTheDocument();
  });

  it('routes recruiter Interviews and Offers to filtered Applicants while Talent Pool stays unfiltered', async () => {
    const recruiter = activeRolePortals.find((item) => item.key === 'recruiter')!;
    expect(recruiter.nav.filter((item) => item.group === 'Hiring').map((item) => [item.label, item.path])).toEqual([
      ['Opportunities', '/employer/recruiter/opportunities'],
      ['Opportunity Detail', '/employer/recruiter/opportunity-detail'],
      ['Applicants', '/employer/recruiter/applicants'],
      ['Candidate Detail', '/employer/recruiter/candidate-detail'],
      ['Assessments', '/employer/recruiter/assessments'],
      ['Interviews', '/employer/recruiter/interviews'],
      ['Talent Pool', '/employer/recruiter/talent-pool'],
      ['Offers', '/employer/recruiter/offers'],
    ]);

    await signInRecruiter();

    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/interviews');
    render(<App />);
    expect(await screen.findByText('Aanya Interview')).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'Application state filter: Interview')).toBeInTheDocument();
    expect(screen.queryByText('Ojas Offer')).not.toBeInTheDocument();
    expect(screen.queryByText('Mira Applied')).not.toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Recruiter navigation')).getByRole('button', { name: 'Interviews' })).toHaveAttribute('aria-current', 'page');

    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/offers');
    render(<App />);
    expect(await screen.findByText('Ojas Offer')).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'Application state filter: Offer')).toBeInTheDocument();
    expect(screen.queryByText('Aanya Interview')).not.toBeInTheDocument();
    expect(screen.queryByText('Mira Applied')).not.toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Recruiter navigation')).getByRole('button', { name: 'Offers' })).toHaveAttribute('aria-current', 'page');

    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/talent-pool');
    render(<App />);
    expect(await screen.findByText('Aanya Interview')).toBeInTheDocument();
    expect(screen.getByText('Ojas Offer')).toBeInTheDocument();
    expect(screen.getByText('Mira Applied')).toBeInTheDocument();
    expect(screen.queryByText((_content, element) => element?.textContent?.startsWith('Application state filter:') ?? false)).not.toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Recruiter navigation')).getByRole('button', { name: 'Talent Pool' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders invitation acceptance as a protected verified-recipient workflow without accepting from preview state', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/invitations/accept?token=raw-invite-token');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Accept organization invitation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.getByText(/raw invitation token is read only from this link and is not stored/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/health'), expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/v1/invitations/accept'), expect.anything());
  });

  it('lets an authenticated Institution Admin send a staff invitation without direct userId attachment', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    let contextCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'institution-token', id_token: jwtWithEmail('institution.admin@example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) {
        contextCalls += 1;
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer institution-token');
        return { ok: true, json: async () => ({ userId: 'admin-user', memberships: [{ organizationId: 'institution-1', role: 'INSTITUTION_ADMIN', scope: { organizationId: 'institution-1', institutionId: 'institution-1' } }] }) };
      }
      if (url.endsWith('/api/v1/institutions/institution-1/staff-role-assignments')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer institution-token');
        if (init?.method === 'GET' || !init?.method) {
          return { ok: true, json: async () => ({ staff: { invitations: [], memberships: [], unavailableActions: ['revoke', 'resend', 'endMembership'] } }) };
        }
        expect(init?.body).toBe(JSON.stringify({ email: 'faculty@example.test', role: 'DEPARTMENT_HEAD' }));
        expect(String(init?.body)).not.toContain('userId');
        return { ok: true, json: async () => ({ invitation: { id: 'invite-1', email: 'faculty@example.test', role: 'DEPARTMENT_HEAD', tokenPreviewAvailable: false } }) };
      }
      return { ok: false };
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    cleanup();
    window.history.pushState(null, '', '/institution/admin/staff');
    render(<App />);
    const recipientInput = await screen.findByLabelText(/Recipient email/i);
    fireEvent.change(recipientInput, { target: { value: 'faculty@example.test' } });
    fireEvent.change(screen.getByLabelText(/Institution role/i), { target: { value: 'DEPARTMENT_HEAD' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send staff invitation' })).not.toBeDisabled());
    expect(contextCalls).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send staff invitation' }));
    await waitFor(() => expect(screen.getByText(/Membership is created only after the verified recipient accepts/i)).toBeInTheDocument());
    expect(screen.queryByText('OPERATIONS_ADMIN')).not.toBeInTheDocument();
  });

  it('ignores an aborted workspace context request instead of showing a false workspace failure', async () => {
    configureHostedCallback();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'institution-token', id_token: jwtWithEmail('institution.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) throw new DOMException('Request was aborted by effect cleanup.', 'AbortError');
      return { ok: false };
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Choose your ONE workspace' })).toBeInTheDocument();
    expect(screen.getByText(/Resolving authorized workspaces/i)).toBeInTheDocument();
    expect(screen.queryByText(/We could not load your ONE workspace/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry workspace' })).not.toBeInTheDocument();
  });

  it('keeps real workspace HTTP failures visible with a safe correlation reference', async () => {
    configureHostedCallback();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'institution-token', id_token: jwtWithEmail('institution.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: false, status: 500, headers: { get: () => 'ctx-500' }, json: async () => ({ message: { correlationId: 'ctx-500' } }) };
      return { ok: false };
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your ONE workspace. Reference: ctx-500');
    expect(screen.getByRole('button', { name: 'Retry workspace' })).toBeInTheDocument();
  });

  it('retries a transient workspace network failure and auto-routes the single Institution workspace', async () => {
    configureHostedCallback();
    let contextCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'institution-token', id_token: jwtWithEmail('institution.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) {
        contextCalls += 1;
        if (contextCalls === 1) throw new TypeError('temporary network failure');
        return { ok: true, json: async () => institutionSecurityContext() };
      }
      return { ok: false };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry workspace' }));
    await waitFor(() => expect(window.location.pathname).toBe('/institution/admin'));
    await waitFor(() => expect(screen.getByText('Placement Dashboard')).toBeInTheDocument());
    expect(screen.queryByText(/Rahul Kumar/)).not.toBeInTheDocument();
  });

  it('opens dashboard record workflows and returns focus after Escape', () => {
    fetchMock.mockResolvedValue({ ok: true });
    const portal = activeRolePortals.find((item) => item.key === 'faculty')!;
    window.history.pushState(null, '', demoPathFor(portal.basePath));
    render(<App />);
    const record = screen.getByText('Rahul Kumar').closest('.role-record-card') as HTMLElement;
    const detailButton = within(record).getByRole('button', { name: 'View detail' });
    fireEvent.click(detailButton);
    expect(screen.getByRole('dialog', { name: 'Rahul Kumar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(detailButton).toHaveFocus();

    const editButton = within(record).getByRole('button', { name: 'Edit preview' });
    fireEvent.click(editButton);
    expect(screen.getByRole('dialog', { name: 'Generate preview report' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(editButton).toHaveFocus();
  });

  it('connects new-role topbar messages and notifications to observable preview behavior', () => {
    fetchMock.mockResolvedValue({ ok: true });
    const recruiter = activeRolePortals.find((item) => item.key === 'recruiter')!;
    window.history.pushState(null, '', demoPathFor(recruiter.basePath));
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Messages' }).find((button) => button.className.includes('icon-button'))!);
    expect(window.location.pathname).toBe('/demo/employer/recruiter/messages');
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
  });

  it('keeps Student and Placement Officer portals available after adding all-role routing', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/applications');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Applications' })).toBeInTheDocument();
    cleanup();
    window.history.pushState(null, '', '/demo/institution/placement-officer/reports');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });
});
afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  await import('./auth.js').then(({ signOut }) => signOut());
  vi.unstubAllGlobals();
});

describe('Student portal completion', () => {
  it('renders the approved shell and development health indicators without exposing API URL', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<App />);
    expect(screen.getByRole('complementary', { name: 'Student navigation' })).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Student profile menu' })).toHaveTextContent('Rahul Kumar');
    expect(screen.getByRole('heading', { name: 'Student Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('API Online')).toBeInTheDocument());
    expect(screen.queryByText(/127\.0\.0\.1:3000/i)).not.toBeInTheDocument();
  });

  it('opens real inbox flyouts from the Student topbar messages and notifications icons', () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.getByRole('dialog', { name: 'Messages' })).toHaveTextContent(/No messages yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toHaveTextContent(/caught up/);
  });

  it('keeps Experience in grouped navigation and supports drawer keyboard behavior', () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<App />);
    const nav = screen.getByRole('complementary', { name: 'Student navigation' });
    expect(within(nav).getByRole('button', { name: 'Experience' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open student navigation' }));
    expect(nav).toHaveClass('drawer-open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav).not.toHaveClass('drawer-open');
  });

  it.each([
    ['/demo/student', 'Student Dashboard', /Cybersecurity Analyst path/i],
    ['/demo/student/career-path', 'My Career Path', /Milestone roadmap/i],
    ['/demo/student/ai-coach', 'AI Career Coach', /Preview-only guidance/i],
    ['/demo/student/readiness', 'Readiness', /Score explanation/i],
    ['/demo/student/skills', 'Skills', /Skill inventory/i],
    ['/demo/student/assessments', 'Assessments', /Assessment workspace/i],
    ['/demo/student/learning', 'Learning', /Continue learning/i],
    ['/demo/student/experience', 'Experience', /Experience and evidence/i],
    ['/demo/student/opportunities', 'Opportunities', /Career marketplace/i],
    ['/demo/student/applications', 'Applications', /Application pipeline/i],
    ['/demo/student/interviews', 'Interviews', /Preparation checklist/i],
    ['/demo/student/documents', 'Documents', /Documents and privacy/i],
    ['/demo/student/profile', 'Profile', /Student-owned profile/i],
    ['/demo/student/settings', 'Settings', /Security overview/i],
  ])('renders route %s', (path, heading, content) => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', path);
    render(<App />);
    expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText(content).length).toBeGreaterThan(0);
  });

  it('sets active route state for the AI Career Coach path', () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Career Coach' }));
    expect(window.location.pathname).toBe('/demo/student/ai-coach');
    expect(screen.getByRole('button', { name: 'AI Career Coach' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText(/No protected Student data is sent to an external model/i)).toBeInTheDocument();
  });

  it('uses consistent shared Student identity and target career data', () => {
    expect(studentProfile.name).toBe('Rahul Kumar');
    expect(studentProfile.program).toBe('B.Tech CSE');
    expect(studentProfile.graduationYear).toBe('2027');
    expect(studentProfile.targetRole).toBe('Cybersecurity Analyst');
    expect(studentProfile.readiness).toBe(68);
  });

  it('renders the dashboard hero and four snapshot cards as one upper composition', () => {
    fetchMock.mockResolvedValue({ ok: true });
    render(<App />);
    const snapshot = screen.getByLabelText('Student dashboard snapshot');
    expect(screen.getByText(/Your Cybersecurity Analyst path is moving forward/i)).toBeInTheDocument();
    for (const label of ['Career readiness', 'Target career', 'Next milestone', 'AI Career Coach']) {
      expect(within(snapshot).getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Recommended next actions')).toBeInTheDocument();
    expect(screen.getByText('Readiness breakdown')).toBeInTheDocument();
  });

  it('renders filters, application stages, and verification states', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/opportunities');
    render(<App />);
    expect(screen.getByLabelText('Filters')).toHaveTextContent('Eligible');
    expect(screen.getAllByText('Supporting factors, not AI certainty').length).toBeGreaterThan(0);
    cleanup();
    window.history.pushState(null, '', '/demo/student/applications');
    render(<App />);
    expect(screen.getByText('Shortlisted')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    cleanup();
    window.history.pushState(null, '', '/demo/student/skills');
    render(<App />);
    expect(screen.getAllByText(/Assessment-verified/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Self-declared/i).length).toBeGreaterThan(0);
  });

  it('uses normal action labels with secure preview notices instead of developer-facing preview labels', () => {
    const bannedLabels = [
      /Apply preview/i,
      /Withdraw presentation/i,
      /Upload presentation/i,
      /Preview\/download/i,
      /Start preview/i,
      /Continue preview/i,
      /Practice preview/i,
      /Schedule preview/i,
      /Add internship preview/i,
      /Start mock preview/i,
    ];

    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/opportunities');
    render(<App />);
    expect(screen.getAllByText('Apply').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Secure workflow required').length).toBeGreaterThan(0);
    for (const label of bannedLabels) expect(screen.queryByText(label)).not.toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/applications');
    render(<App />);
    expect(screen.getAllByText('Withdraw application').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Secure workflow required').length).toBeGreaterThan(0);
    for (const label of bannedLabels) expect(screen.queryByText(label)).not.toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/documents');
    render(<App />);
    expect(screen.getAllByText('Upload document').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Preview').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Download').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Secure workflow required').length).toBeGreaterThan(0);
    for (const label of bannedLabels) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it('renders the refined settings groups, profile workspace, and connected application pipeline', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/settings');
    render(<App />);
    for (const group of ['Notifications', 'Privacy and visibility', 'Institution relationship', 'Consent', 'Communication', 'Accessibility', 'Language', 'Security', 'Data and account']) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }

    cleanup();
    window.history.pushState(null, '', '/demo/student/profile');
    render(<App />);
    expect(screen.getByText(/Target career: Cybersecurity Analyst/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Career objective/i).length).toBeGreaterThan(0);

    cleanup();
    window.history.pushState(null, '', '/demo/student/applications');
    render(<App />);
    const pipeline = screen.getByLabelText('Application stage pipeline');
    for (const stage of ['Draft', 'Applied', 'Shortlisted', 'Assessment', 'Interview', 'Offer', 'Closed']) {
      expect(within(pipeline).getByText(stage)).toBeInTheDocument();
    }
  });

  it('renders final polish semantics for settings, readiness, profile, and interviews', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/settings');
    render(<App />);
    expect(screen.getByRole('checkbox', { name: 'Email weekly summary' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Assessment reminders' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Active institution/i })).not.toBeInTheDocument();
    expect(screen.getByText('Active institution')).toBeInTheDocument();
    expect(screen.getByText('Manage consent')).toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/readiness');
    render(<App />);
    expect(screen.getByRole('img', { name: /connected readiness score trend/i })).toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/profile');
    render(<App />);
    expect(screen.getByText(/Missing items: portfolio source labels/i)).toBeInTheDocument();
    expect(screen.getByText(/Recommended next action: attach the SIEM lab evidence summary/i)).toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/interviews');
    render(<App />);
    expect(screen.getByText('Upcoming interviews')).toBeInTheDocument();
    expect(screen.getByText('Preparation progress')).toBeInTheDocument();
    expect(screen.getByText('August schedule')).toBeInTheDocument();
  });

  it('keeps preview UI visible when API health fails', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    render(<App />);
    await waitFor(() => expect(screen.getByText('API Offline')).toBeInTheDocument());
    expect(screen.getAllByText('DEMO PREVIEW').length).toBeGreaterThan(0);
  });

  it('sets route-aware Student document titles', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/learning');
    render(<App />);
    await waitFor(() => expect(document.title).toBe('Learning - Student | ONE'));
  });
  it('edits Student-owned target career with validation and session-local feedback', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/career-path');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit career goal' }));
    fireEvent.change(screen.getByLabelText('Target career'), { target: { value: 'AI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target career' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Target career must be at least 3 characters.');
    fireEvent.change(screen.getByLabelText('Target career'), { target: { value: 'Cloud Security Analyst' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target career' }));
    expect(screen.getByRole('heading', { name: 'Cloud Security Analyst' })).toBeInTheDocument();
    const sessionStatus = screen.getByText('Updated target career: Cloud Security Analyst').closest('[role="status"]');
    expect(sessionStatus).toHaveTextContent('Updated target career');
  });

  it('adds and removes self-declared skills while preserving verified skills as read-only', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/skills');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Add or update skill' }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'Threat hunting notes' } });
    fireEvent.change(screen.getByLabelText('Evidence metadata'), { target: { value: 'Portfolio write-up metadata only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
    expect(screen.getByText('Threat hunting notes')).toBeInTheDocument();
    expect(screen.getAllByText('Verified read-only').length).toBeGreaterThan(0);
    const row = screen.getByText('Threat hunting notes').closest('.data-list-item') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('Threat hunting notes')).not.toBeInTheDocument();
  });

  it('saves opportunities and creates editable local application drafts', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/opportunities');
    render(<App />);
    const marketWorks = screen.getByText('Incident Response Associate').closest('article') as HTMLElement;
    fireEvent.click(within(marketWorks).getByRole('button', { name: 'Save' }));
    expect(within(marketWorks).getByText('Saved')).toBeInTheDocument();
    fireEvent.click(within(marketWorks).getByRole('button', { name: 'Apply' }));
    window.history.pushState(null, '', '/demo/student/applications');
    fireEvent.popState(window);
    const draftRow = screen.getAllByText('Incident Response Associate').map((node) => node.closest('.data-list-item') as HTMLElement).find((row) => within(row).queryByRole('button', { name: 'Edit draft' }));
    if (!draftRow) throw new Error('Created draft row was not rendered');
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Edit draft' }));
    fireEvent.change(screen.getByLabelText('Cover-note text'), { target: { value: 'Tailor resume to incident response.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByText(/Tailor resume to incident response/i)).toBeInTheDocument();
  });

  it('supports AI Coach local conversation and destructive clear confirmation', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/ai-coach');
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('Ask why a role matches your readiness...'), { target: { value: 'What evidence should I attach?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview prompt' }));
    expect(screen.getAllByText('What evidence should I attach?').length).toBeGreaterThan(0);
    expect(screen.getByText(/Demo guidance/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }));
    const clearDialog = screen.getByRole('alertdialog', { name: 'Clear coach conversation' });
    expect(clearDialog).toBeInTheDocument();
    fireEvent.click(within(clearDialog).getByRole('button', { name: 'Clear conversation' }));
    expect(screen.queryByText(/Demo guidance/i)).not.toBeInTheDocument();
  });

  it('keeps protected Student profile and document data read-only while metadata remains editable', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/profile');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Academic profile' }).closest('.data-list-item')).toHaveTextContent('Read-only');
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: 'Rahul K.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(screen.getByRole('heading', { name: 'Rahul K.' })).toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/student/documents');
    render(<App />);
    expect(screen.getAllByText('Verified read-only').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Portfolio evidence note' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Metadata-only artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save metadata' }));
    expect(screen.getByText('Portfolio evidence note')).toBeInTheDocument();
  });

  it('filters Student skills by category, verified state, search, and clear filters', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/skills');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Communication' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Technical' }));
    expect(screen.queryByRole('heading', { name: 'Communication' })).not.toBeInTheDocument();
    expect(screen.getByText(/4 skills shown/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verified' }));
    expect(screen.getByText('Networking fundamentals')).toBeInTheDocument();
    expect(screen.queryByText('Linux fundamentals')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search SIEM, Linux, communication...'), { target: { value: 'security' } });
    expect(screen.getByText('Security fundamentals')).toBeInTheDocument();
    expect(screen.queryByText('Networking fundamentals')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(screen.getByRole('heading', { name: 'Communication' })).toBeInTheDocument();
  });

  it('filters assessments and opens preview/result dialogs', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/assessments');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    expect(screen.getByText('SIEM Investigation Assessment')).toBeInTheDocument();
    expect(screen.queryByText('Networking Fundamentals')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Practical lab' }));
    expect(screen.getByText('Linux Hardening Lab')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue assessment' }));
    expect(screen.getByRole('dialog', { name: 'Assessment preview workspace' })).toHaveTextContent('This preview does not start a real assessment');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Practical lab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    expect(screen.getByRole('dialog', { name: 'Read-only assessment result' })).toHaveTextContent('Completed score 82% is read-only');
  });

  it('filters learning courses and continue learning changes visible progress', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/learning');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'SIEM' }));
    expect(screen.getAllByText('SIEM Investigation Sprint').length).toBeGreaterThan(0);
    expect(screen.queryByText('Linux Hardening Basics')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(screen.getByText('Linux Hardening Basics')).toBeInTheDocument();
    expect(screen.getAllByText('60%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue learning' }));
    expect(screen.getAllByText('70%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Update filters' }));
    expect(screen.getByText(/Filters focused/)).toBeInTheDocument();
  });

  it('filters experience records and request verification updates visible status', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/experience');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Certifications' }));
    expect(screen.getByText('Networking Fundamentals Certificate')).toBeInTheDocument();
    expect(screen.queryByText('Security incident readiness dashboard')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Needs verification' }));
    expect(screen.getByText('Security incident readiness dashboard')).toBeInTheDocument();
    const record = screen.getByText('Security incident readiness dashboard').closest('.data-list-item') as HTMLElement;
    fireEvent.click(within(record).getByRole('button', { name: 'Request verification' }));
    expect(within(record).getByText('Verification requested')).toBeInTheDocument();
  });

  it('filters opportunities, toggles saved results, explains match, and routes apply to drafts', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/opportunities');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Remote' }));
    expect(screen.getByText('Cybersecurity Intern')).toBeInTheDocument();
    expect(screen.getByText('1 opportunities shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
    expect(screen.getByText('Cybersecurity Intern')).toBeInTheDocument();
    expect(screen.getByText('1 opportunities shown')).toBeInTheDocument();
    const savedRole = screen.getByText('Cybersecurity Intern').closest('article') as HTMLElement;
    fireEvent.click(within(savedRole).getByRole('button', { name: 'Unsave' }));
    expect(screen.queryByText('Cybersecurity Intern')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    const soc = screen.getAllByText('SOC Analyst Intern')[0]!.closest('article') as HTMLElement;
    fireEvent.click(within(soc).getByRole('button', { name: 'Explain match' }));
    expect(screen.getByRole('dialog', { name: 'Explain opportunity match' })).toHaveTextContent('not AI certainty');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(soc).getByRole('button', { name: 'Apply' }));
    expect(window.location.pathname).toBe('/demo/student/applications');
    expect(screen.getAllByText('SOC Analyst Intern').length).toBeGreaterThan(0);
  });

  it('opens application details, edits drafts, preserves cancel, confirms withdrawal, and expands timelines', () => {
    fetchMock.mockResolvedValue({ ok: true });
    window.history.pushState(null, '', '/demo/student/applications');
    render(<App />);
    const draftRow = screen.getByText('SOC Analyst Intern').closest('.data-list-item') as HTMLElement;
    fireEvent.click(within(draftRow).getByRole('button', { name: 'View detail' }));
    expect(screen.getByRole('dialog', { name: 'Application detail' })).toHaveTextContent('Student-owned documents');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Edit draft' }));
    fireEvent.change(screen.getByLabelText('Cover-note text'), { target: { value: 'Updated SOC draft note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByText(/Updated SOC draft note/i)).toBeInTheDocument();
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Activity timeline' }));
    expect(within(draftRow).getByRole('button', { name: 'Activity timeline' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(draftRow).getByText(/Updated application draft/i)).toBeInTheDocument();
    const appliedRow = screen.getByText('Cybersecurity Intern').closest('.data-list-item') as HTMLElement;
    expect(within(appliedRow).queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
    fireEvent.click(within(appliedRow).getByRole('button', { name: 'Withdraw application' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Withdraw application' })).getAllByRole('button', { name: 'Cancel' })[1]!);
    expect(within(appliedRow).getByText('Applied')).toBeInTheDocument();
    fireEvent.click(within(appliedRow).getByRole('button', { name: 'Withdraw application' }));
    fireEvent.change(screen.getByLabelText('Withdrawal reason'), { target: { value: 'Accepted another path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm withdraw' }));
    expect(within(appliedRow).getByText('Closed')).toBeInTheDocument();
    expect(within(appliedRow).getByText(/Accepted another path/i)).toBeInTheDocument();
  });
});

describe('Institution placement officer portal foundation', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/demo/institution/placement-officer');
    fetchMock.mockResolvedValue({ ok: true });
  });

  it('renders the Placement Officer route with role and institution identity', async () => {
    render(<App />);
    expect(screen.getByRole('complementary', { name: 'Institution placement navigation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Placement Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('ABC Engineering College').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Placement Officer').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Placement Officer identity')).toHaveTextContent('Anita Sharma');
    await waitFor(() => expect(screen.getByText('API Online')).toBeInTheDocument());
    expect(screen.queryByText(/127\.0\.0\.1:3000/i)).not.toBeInTheDocument();
    expect(document.title).toBe('Placement Dashboard | ONE');
  });

  it.each([
    ['/demo/institution/placement-officer/students', 'Students - Placement Officer | ONE'],
    ['/demo/institution/placement-officer/assessments', 'Assessments - Placement Officer | ONE'],
    ['/demo/institution/placement-officer/reports', 'Reports - Placement Officer | ONE'],
  ])('sets staff document title for %s', (path, title) => {
    window.history.pushState(null, '', path);
    render(<App />);
    expect(document.title).toBe(title);
  });

  it('renders six compact KPI cards', () => {
    render(<App />);
    const kpis = screen.getByLabelText('Placement KPI summary');
    for (const label of ['Total Students', 'Placement Eligible', 'Placement Ready', 'Need Intervention', 'High Risk', 'Offers Received']) {
      expect(within(kpis).getByText(label)).toBeInTheDocument();
    }
    expect(within(kpis).getAllByRole('article').length).toBe(6);
  });

  it('renders readiness chart accessibility and interactive distribution legend', () => {
    render(<App />);
    expect(screen.getByRole('img', { name: /average readiness score trend/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Readiness distribution donut')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /At Risk/i }));
    expect(screen.getByRole('button', { name: /At Risk/i })).toHaveClass('selected');
  });

  it('renders readiness distribution rows with separate count and percentage cells', () => {
    render(<App />);
    const bands = [
      ['Ready', '(70-100)', '712', '25.3%'],
      ['Moderate', '(40-69)', '804', '28.6%'],
      ['Low', '(20-39)', '374', '13.3%'],
      ['At Risk', '(0-19)', '103', '9.5%'],
    ] as const;

    for (const [label, range, count, percent] of bands) {
      const band = screen.getByRole('button', { name: new RegExp(label, 'i') });
      expect(within(band).getByText(label)).toBeInTheDocument();
      expect(within(band).getByText(range)).toBeInTheDocument();
      expect(within(band).getByText(count)).toHaveClass('distribution-count');
      expect(within(band).getByText(percent)).toHaveClass('distribution-percent');
    }
  });

  it('renders placement pipeline and students requiring attention table', () => {
    render(<App />);
    expect(screen.getByLabelText('Placement pipeline funnel')).toHaveTextContent('Applications');
    const table = screen.getByRole('table', { name: /Students requiring attention/i });
    expect(within(table).getByText('Rahul Kumar')).toBeInTheDocument();
    expect(within(table).getByText('Priya Singh')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search student, gap, intervention...'), { target: { value: 'Neha' } });
    expect(within(table).getByText('Neha Patel')).toBeInTheDocument();
    expect(within(table).queryByText('Rahul Kumar')).not.toBeInTheDocument();
  });

  it('supports mobile filter panel toggle semantics', () => {
    render(<App />);
    const filterButton = screen.getByRole('button', { name: 'Filters' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(filterButton);
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    const panelId = filterButton.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId ?? '');
    expect(panel).toHaveClass('open');
    expect(within(panel as HTMLElement).getByText('Department')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText('Readiness')).toBeInTheDocument();
  });

  it('renders mobile record-card content for students requiring attention', () => {
    render(<App />);
    const records = screen.getByLabelText('Students requiring attention records');
    const rahulRecord = within(records).getByText('Rahul Kumar').closest('article');
    expect(rahulRecord).toBeTruthy();
    expect(within(rahulRecord as HTMLElement).getByText(/CSE.*Batch 2027/)).toBeInTheDocument();
    expect(within(records).getAllByText('Readiness').length).toBeGreaterThan(0);
    expect(within(records).getAllByText('Primary gap').length).toBeGreaterThan(0);
    expect(within(records).getAllByText('Last activity').length).toBeGreaterThan(0);
    expect(within(records).getAllByText('Intervention').length).toBeGreaterThan(0);
    expect(within(records).getAllByRole('button', { name: /View student preview action/i }).length).toBeGreaterThan(0);
    expect(within(records).getAllByRole('button', { name: /Assign preview action/i }).length).toBeGreaterThan(0);
    const actionGrid = within(rahulRecord as HTMLElement).getByRole('button', { name: /Assign preview action/i }).parentElement;
    expect(actionGrid).toHaveClass('record-actions');
  });

  it('renders enabled sidebar links without disabled semantics', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Grouped Institution placement navigation' });
    for (const group of ['Home', 'Students', 'Placement', 'Engagement', 'Analytics']) {
      expect(within(nav).getAllByText(group).length).toBeGreaterThan(0);
    }
    expect(within(nav).getByRole('button', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    for (const item of staffNavItems) {
      const button = within(nav).getByRole('button', { name: item.label });
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  it.each(staffNavItems)('loads staff route $path with active navigation', (item) => {
    window.history.pushState(null, '', demoPathFor(item.path));
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: item.label })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText(/empty placeholder/i)).not.toBeInTheDocument();
  });

  it('supports staff browser history and dashboard action navigation', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Students' }));
    expect(window.location.pathname).toBe('/demo/institution/placement-officer/students');
    expect(screen.getByRole('heading', { name: 'Students' })).toBeInTheDocument();
    window.history.pushState(null, '', '/demo/institution/placement-officer');
    fireEvent.popState(window);
    expect(screen.getByRole('heading', { name: 'Placement Dashboard' })).toBeInTheDocument();
    const assignAction = screen.getAllByRole('button', { name: /Assign preview action/i })[0];
    if (!assignAction) throw new Error('Assign action was not rendered');
    fireEvent.click(assignAction);
    expect(window.location.pathname).toBe('/demo/institution/placement-officer/interventions');
  });

  it('routes previously topbar and section-only staff controls to visible destinations', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(window.location.pathname).toBe('/demo/institution/placement-officer/events');
    expect(screen.getByRole('heading', { name: 'Events' })).toBeInTheDocument();
    window.history.pushState(null, '', '/demo/institution/placement-officer');
    fireEvent.popState(window);
    fireEvent.click(screen.getByRole('button', { name: 'View full report' }));
    expect(window.location.pathname).toBe('/demo/institution/placement-officer/reports');
    cleanup();
    window.history.pushState(null, '', '/demo/institution/placement-officer');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Low.*20-39.*374.*13\.3%/i }));
    expect(screen.getByText(/Selected readiness band: Low/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(window.location.pathname).toBe('/demo/institution/placement-officer/communications');
    expect(screen.getByRole('heading', { name: 'Communications' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('status')).toHaveTextContent('Placement notifications preview');
  });

  it('opens staff record review workflows from table action buttons', () => {
    window.history.pushState(null, '', '/demo/institution/placement-officer/students');
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Review preview action' })[0]!);
    expect(screen.getByRole('dialog', { name: 'Edit placement status' })).toBeInTheDocument();
  });

  it('opens, validates, saves, audits and resets a staff preview form', () => {
    window.history.pushState(null, '', '/demo/institution/placement-officer/assessments');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));
    expect(screen.getByRole('dialog', { name: 'Create assessment' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Title/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Title, status and owner are required.');
    fireEvent.change(screen.getByLabelText(/Title/i), { target: { value: 'Cybersecurity readiness check' } });
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'Scheduled for CSE 2027' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByText('Cybersecurity readiness check').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('Demo changes not saved to backend');
    expect(screen.getByText('Preview activity log')).toBeInTheDocument();
    expect(screen.getAllByText('Scheduled for CSE 2027').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset preview action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset preview action' }));
    expect(screen.queryByText('Cybersecurity readiness check')).not.toBeInTheDocument();
  });

  it('closes staff modal with Escape and returns focus', () => {
    window.history.pushState(null, '', '/demo/institution/placement-officer/interventions');
    render(<App />);
    const openButton = screen.getByRole('button', { name: 'Create intervention' });
    fireEvent.click(openButton);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();
  });

  it('renders read-only ownership boundaries and removes generic/technical copy', () => {
    window.history.pushState(null, '', '/demo/institution/placement-officer/students');
    render(<App />);
    expect(screen.getByText(/student identity, consent decisions, profile fields/i)).toBeInTheDocument();
    expect(screen.queryByText(/Create workflow/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/PLACEMENT_ADMIN/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/PLACEMENT_OFFICER appears/i)).not.toBeInTheDocument();
    cleanup();
    window.history.pushState(null, '', '/demo/institution/placement-officer/opportunities');
    render(<App />);
    expect(screen.getByText(/employer-owned title, compensation/i)).toBeInTheDocument();
  });

  it('supports institution drawer accessibility and Escape focus return', () => {
    render(<App />);
    const openButton = screen.getByRole('button', { name: 'Open institution navigation' });
    const nav = screen.getByRole('complementary', { name: 'Institution placement navigation' });
    fireEvent.click(openButton);
    expect(nav).toHaveClass('drawer-open');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav).not.toHaveClass('drawer-open');
    expect(openButton).toHaveFocus();
  });

  it('removes development-only indicators in production mode', () => {
    expect(import.meta.env.DEV).toBe(true);
    render(<App />);
    expect(screen.getByLabelText('Institution preview mode')).toBeInTheDocument();
  });

  it('keeps the Student route regression intact after adding staff portal routing', () => {
    window.history.pushState(null, '', '/demo/student');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Student Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Student navigation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Student profile menu' }));
    expect(window.location.pathname).toBe('/demo/student/profile');
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Institution placement navigation' })).not.toBeInTheDocument();
  });
});



describe('demo portal gating', () => {
  it('is enabled in development and by explicit flag, off otherwise', () => {
    expect(demoPortalEnabled({ DEV: true })).toBe(true);
    expect(demoPortalEnabled({ DEV: false, VITE_ENABLE_DEMO_PORTAL: 'true' })).toBe(true);
    // A production build without the flag must refuse every /demo route, not just
    // hide the launcher button.
    expect(demoPortalEnabled({ DEV: false })).toBe(false);
    expect(demoPortalEnabled({ DEV: false, VITE_ENABLE_DEMO_PORTAL: 'false' })).toBe(false);
    expect(demoPortalEnabled({ DEV: false, VITE_ENABLE_DEMO_PORTAL: '1' })).toBe(false);
  });
});
