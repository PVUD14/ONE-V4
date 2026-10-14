/**
 * Analytics access and CSV exports on the institution screens (INST-08): admins grant and
 * revoke access with reason codes on Staff; the exports panel on Reports (admin) and
 * Reports and Analytics (department head) requests nothing until the person acts, sends a
 * reason with every export, saves the server's file, and explains a refusal without
 * upstream text. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { AnalyticsAccessPanel, InstitutionExportsPanel } from './institutionAnalytics.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const institutionId = crypto.randomUUID();
const headMembership = crypto.randomUUID();
const adminMembership = crypto.randomUUID();
const capabilityId = crypto.randomUUID();
const assessmentId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const csvResponse = (filename: string, text: string) => ({
  ok: true, status: 200, headers: { get: (name: string) => (name.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : null) },
  text: async () => text, json: async () => ({}),
});
const refused = (status: number, code: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { code, message: 'upstream detail text', correlationId: 'corr-export' } }) });
const eligible = [
  { membershipId: headMembership, email: 'head@example.test', role: 'DEPARTMENT_HEAD', department: 'Mechanical', grant: null },
  { membershipId: adminMembership, email: 'admin@example.test', role: 'INSTITUTION_ADMIN', department: null, grant: { capabilityId, grantedAt: '2026-09-01T10:00:00.000Z', reasonCode: 'ANALYTICS_RESPONSIBILITY' } },
];
let anchorClick: ReturnType<typeof vi.spyOn>;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:export');
  URL.revokeObjectURL = vi.fn();
  // jsdom cannot follow a download link; the saved file is asserted through createObjectURL.
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); anchorClick.mockRestore(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('Analytics and exports access', () => {
  it('lists who may hold access and grants it with a reason code', async () => {
    fetchMock.mockResolvedValue(ok({ capabilities: [], eligible }));
    render(<AnalyticsAccessPanel token="token" institutionId={institutionId} />);
    const row = (await screen.findByText('head@example.test')).closest('tr')!;
    expect(within(row).getByText('No access')).toBeInTheDocument();
    expect(within(row).getByText('Mechanical')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason for granting'), { target: { value: 'DEPARTMENT_REPORTING' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Grant access to head@example.test' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/institutions/' + institutionId + '/capabilities');
    expect(JSON.parse(String(init.body))).toEqual({ membershipId: headMembership, capability: 'INSTITUTION_ANALYTICS', reasonCode: 'DEPARTMENT_REPORTING' });
    expect(await screen.findByText('Access granted to head@example.test.')).toBeInTheDocument();
    expect(screen.queryByText(headMembership)).not.toBeInTheDocument();
  });

  it('removes access with a reason code', async () => {
    fetchMock.mockResolvedValue(ok({ capabilities: [], eligible }));
    render(<AnalyticsAccessPanel token="token" institutionId={institutionId} />);
    const row = (await screen.findByText('admin@example.test')).closest('tr')!;
    expect(within(row).getByText('Granted 2026-09-01')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason for removing'), { target: { value: 'ACCESS_REVIEW' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Remove access for admin@example.test' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/capabilities/' + capabilityId + '/revoke');
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'ACCESS_REVIEW' });
  });

  it('says plainly that nobody can grant access to themselves, without upstream text', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => Promise.resolve(init?.method === 'POST' ? refused(400, 'CAPABILITY_SELF_GRANT_REFUSED') : ok({ eligible })));
    render(<AnalyticsAccessPanel token="token" institutionId={institutionId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant access to head@example.test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot grant access to yourself. Another owner or admin must. Support code: correxpo');
    expect(screen.queryByText(/upstream detail text/)).not.toBeInTheDocument();
  });
});

describe('Exports panel', () => {
  it('requests nothing until the person exports, then sends the reason and saves the server file', async () => {
    fetchMock.mockResolvedValue(csvResponse('one-roster-2026-09-26.csv', '\uFEFF"Student ID"\r\n'));
    render(<InstitutionExportsPanel institutionId={institutionId} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for this export'), { target: { value: 'ACCREDITATION_PREPARATION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('status')).toHaveTextContent('exported as one-roster-2026-09-26.csv');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/institutions/' + institutionId + '/exports/roster');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer token' } });
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'ACCREDITATION_PREPARATION' });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('sends one ended month for the readiness and staff-action summaries', async () => {
    fetchMock.mockResolvedValue(csvResponse('one-readiness-bands-2026-08.csv', '\uFEFF"Month"\r\n'));
    render(<InstitutionExportsPanel institutionId={institutionId} />);
    fireEvent.change(screen.getByLabelText('What to export'), { target: { value: 'readiness-bands' } });
    const month = screen.getByLabelText('Month') as HTMLInputElement;
    expect(month.max).toBe(month.value);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/exports/readiness-bands');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ reasonCode: 'MANAGEMENT_REPORTING', month: month.value });
  });

  it('loads assessments only when that export is chosen, and sends the chosen one', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve(init?.method === 'POST'
      ? csvResponse('one-assessment-results-2026-09-26.csv', '\uFEFF"Assessment"\r\n')
      : ok({ assessments: [{ id: assessmentId, title: 'Unit test 1' }] })));
    render(<InstitutionExportsPanel institutionId={institutionId} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('What to export'), { target: { value: 'assessment-results' } });
    await screen.findByRole('option', { name: 'Unit test 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an assessment to export.');
    fireEvent.change(screen.getByLabelText('Assessment'), { target: { value: assessmentId } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'MANAGEMENT_REPORTING', assessmentId });
  });

  it.each([
    [403, 'ANALYTICS_CAPABILITY_REQUIRED', 'You do not have analytics and exports access. An owner or admin of your college can grant it on the Staff page.'],
    [403, 'SCOPE_REQUIRED', 'Exports need a department on your staff membership.'],
    [422, 'EXPORT_TOO_LARGE', 'Limit it to one department, programme, batch or section.'],
    [429, 'EXPORT_RATE_LIMITED', 'You have reached the limit of 30 exports in 24 hours.'],
    [500, 'EXPORT_FAILED', 'The export could not be prepared. Try again.'],
  ])('explains a %i %s refusal with its reference and no upstream text', async (status, code, message) => {
    fetchMock.mockResolvedValue(refused(status, code));
    render(<InstitutionExportsPanel institutionId={institutionId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent('Support code: correxpo');
    expect(screen.queryByText(/upstream detail text/)).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('Where the panels live, with navigation unchanged', () => {
  const renderRoute = (key: string, label: string, role: string) => {
    const portal = rolePortals.find((item) => item.key === key)!;
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role }} />);
    return portal;
  };

  it('opens the department report and exports on the department head "Reports and Analytics" item', async () => {
    const portal = renderRoute('department-head', 'Reports and Analytics', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('heading', { name: 'Reports and Analytics', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Exports' })).toBeInTheDocument();
    expect(screen.getByLabelText('Month')).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
  });

  it('puts the exports panel under the admin readiness report, and the access panel on Staff', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes('/capabilities') ? { eligible } : { staff: { invitations: [], memberships: [], unavailableActions: [] }, units: [], assignments: [], canAssign: false, faculty: [], subjects: [] })));
    const portal = renderRoute('institution-admin', 'Reports', 'INSTITUTION_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Exports' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reports', level: 1 })).toBeInTheDocument();
    cleanup();
    renderRoute('institution-admin', 'Staff', 'INSTITUTION_ADMIN');
    expect(await screen.findByText('head@example.test')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analytics and exports access' })).toBeInTheDocument();
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
  });
});
