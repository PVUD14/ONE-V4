/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Verify institution report wiring, workspace boundaries and privacy suppression.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from './api.js';
import { InstitutionReportsPage } from './institutionReportsPage.js';
import { RolePortal } from './rolePortalPages.js';
import { rolePortals } from './rolePortalConfig.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api.js')>(),
  getProtectedAccessToken: vi.fn(),
}));

const institutionId = '62000000-0000-4000-8000-000000000001';
const fetchMock = vi.fn();
const report = {
  reportId: '63000000-0000-4000-8000-000000000001',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  expiresAt: '2026-10-05T00:00:00.000Z',
  aggregate: {
    suppressed: false,
    minimumCohortSize: 5,
    cohortSize: 7,
    bands: [{ band: 'DEVELOPING', count: 5 }, { band: 'READY_FOR_NEXT_STEP', count: 2 }],
  },
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue('local-report-test-token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => {
    if (url.endsWith('/api/v1/me/consents/privacy-notice')) {
      return Promise.resolve({ ok: true, json: async () => ({ required: false, requiredVersion: null }) });
    }
    return fetchMock(url, options);
  });
  window.history.replaceState(null, '', '/institution/admin/reports');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function choosePeriod(): void {
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: report.periodStart } });
  fireEvent.change(screen.getByLabelText('End date'), { target: { value: report.periodEnd } });
}
function generate(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Generate report' }));
}
function renderRoute(workspace: { role: string; organizationId: string | null }, demoMode = false): void {
  if (demoMode) window.history.replaceState(null, '', '/demo/institution/admin/reports');
  render(<RolePortal portal={rolePortals.find((portal) => portal.key === 'institution-admin')!}
    apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice="" showDevelopmentIndicators={false}
    onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    demoMode={demoMode} authenticatedWorkspace={workspace} />);
}

describe('Institution Reports — C1', () => {
  it.each(['INSTITUTION_ADMIN', 'INSTITUTION_OWNER'])('wires the Reports route for %s to the selected institution and renders returned data', async (role) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => report });
    renderRoute({ role, organizationId: institutionId });
    expect(fetchMock).not.toHaveBeenCalled();
    choosePeriod();
    generate();
    await screen.findByRole('heading', { name: 'Career-readiness report' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    const endpoint = new URL(url as string, 'http://localhost');
    expect(endpoint.pathname).toBe('/api/v1/institutions/' + institutionId + '/career-readiness/reports');
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({ periodStart: report.periodStart, periodEnd: report.periodEnd });
    expect(options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer local-report-test-token', Accept: 'application/json' } });
    expect(options.headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText(/Students with readiness records:/)).toHaveTextContent('7');
    const table = screen.getByRole('table', { name: 'Readiness distribution' });
    expect(within(table).getByRole('row', { name: 'Developing 5' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Ready for next step 2' })).toBeInTheDocument();
    expect(screen.getByText('Report reference: ' + report.reportId)).toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
  });

  it('keeps suppressed counts and bands hidden', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      ...report, aggregate: { ...report.aggregate, suppressed: true, cohortSize: 999 },
    }) });
    render(<InstitutionReportsPage institutionId={institutionId} />);
    generate();
    expect(await screen.findByText(/Results are withheld to protect student privacy/)).toHaveTextContent('At least 5 students');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/Students with readiness records:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
  });

  it('disables generation while a request is pending and cancels it on unmount', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const view = render(<InstitutionReportsPage institutionId={institutionId} />);
    generate();
    expect(screen.getByRole('status')).toHaveTextContent('Generating');
    expect(screen.getByRole('button', { name: 'Generating report…' })).toBeDisabled();
    expect(screen.getByLabelText('Start date')).toBeDisabled();
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('rejects an inverted date range without requesting a report', () => {
    render(<InstitutionReportsPage institutionId={institutionId} />);
    choosePeriod();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-01' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Generate report' }).closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a start date on or before the end date.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<InstitutionReportsPage institutionId={institutionId} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to an institution workspace');
    expect(screen.queryByRole('button', { name: 'Generate report' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'INSTITUTION_ADMIN', organizationId: null },
    { role: 'FACULTY_LECTURER', organizationId: institutionId },
    { role: 'OPERATIONS_ADMIN', organizationId: institutionId },
  ])('does not mount reports with invalid workspace $role / $organizationId', (workspace) => {
    renderRoute(workspace);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate report' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the demo Reports route from calling the protected endpoint', () => {
    renderRoute({ role: 'INSTITUTION_ADMIN', organizationId: institutionId }, true);
    expect(screen.queryByRole('button', { name: 'Generate report' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'Your session has expired.'],
    [403, 'You do not have permission'],
    [500, 'Unable to generate the report.'],
  ])('handles HTTP %s without rendering a report', async (status, message) => {
    fetchMock.mockResolvedValue({ ok: false, status });
    render(<InstitutionReportsPage institutionId={institutionId} />);
    generate();
    expect(await screen.findByRole('alert')).toHaveTextContent(message as string);
    expect(screen.queryByRole('heading', { name: 'Career-readiness report' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate report' })).toBeEnabled();
  });

  it('allows retry after a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce({ ok: true, json: async () => report });
    render(<InstitutionReportsPage institutionId={institutionId} />);
    generate();
    await screen.findByRole('alert');
    generate();
    await screen.findByRole('table', { name: 'Readiness distribution' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not show a response from the previous institution after the workspace changes', async () => {
    let resolveResponse!: (response: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveResponse = resolve; }));
    const view = render(<InstitutionReportsPage institutionId={institutionId} />);
    generate();
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(<InstitutionReportsPage institutionId="62000000-0000-4000-8000-000000000002" />);
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveResponse({ ok: true, json: async () => report }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate report' })).toBeEnabled());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
