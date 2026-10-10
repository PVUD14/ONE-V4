/**
 * Accreditation outcomes on the web (INST-13). The student's "After college" card on Profile shares
 * higher studies or a venture with one college, changes and withdraws it, and says plainly that the
 * college sees only counts; the college's Exports panel offers the accreditation file with no month
 * or unit picker and says it is not an official template. API stubbed at fetch; real data, empty,
 * NA and error states; navigation labels unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from './api.js';
import { StudentOutcomesCard } from './studentOutcomes.js';
import { InstitutionExportsPanel } from './rolePortal/institutionAnalytics.js';
import { rolePortals } from './rolePortalConfig.js';

vi.mock('./api.js', async (original) => ({
  ...await original<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('./auth.js', async (original) => ({
  ...await original<typeof import('./auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));

const institutionId = crypto.randomUUID();
const declarationId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });
const refused = (status: number, code: string) => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { code, message: 'upstream detail text', correlationId: 'corr-outcome' } }) });
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> }));
const college = (declaration: Record<string, unknown> | null = null, overrides: Record<string, unknown> = {}) => ({
  institutionId, institutionName: 'Synthetic Institute', relationship: 'GRADUATED', graduatedOn: '2025-06-15', declaration, ...overrides,
});

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('After college (student Profile)', () => {
  it('shares an outcome with the college and says the college sees only counts', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => Promise.resolve(init?.method === 'POST'
      ? ok({ colleges: [college({ id: declarationId, outcome: 'HIGHER_STUDIES', declaredAt: '2026-09-20T10:00:00.000Z' })] })
      : ok({ colleges: [college()] })));
    render(<StudentOutcomesCard />);
    const card = await screen.findByRole('region', { name: 'After college' });
    expect(within(card).getByText(/never sees your name next to this/)).toBeInTheDocument();
    expect(within(card).getByText(/marked as self-reported/)).toBeInTheDocument();
    expect(within(card).getByText('Nothing shared')).toBeInTheDocument();
    const share = within(card).getByRole('button', { name: 'Share with Synthetic Institute' });
    expect(share).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('What did you go on to do?'), { target: { value: 'HIGHER_STUDIES' } });
    fireEvent.click(share);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ path: '/api/v1/students/me/outcome-declarations', body: { institutionId, outcome: 'HIGHER_STUDIES' } });
    expect(await within(card).findByText(/counted from the start of next month/)).toBeInTheDocument();
    expect(within(card).getByText(/^Shared: Higher studies/)).toBeInTheDocument();
    expect(screen.queryByText(declarationId)).not.toBeInTheDocument();
  });

  it('withdraws a shared outcome', async () => {
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => Promise.resolve(init?.method === 'POST'
      ? ok({ colleges: [college()] })
      : ok({ colleges: [college({ id: declarationId, outcome: 'ENTREPRENEURSHIP', declaredAt: '2026-08-01T00:00:00.000Z' })] })));
    render(<StudentOutcomesCard />);
    expect(await screen.findByText(/^Shared: My own business or venture/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ path: `/api/v1/students/me/outcome-declarations/${declarationId}/withdraw`, body: {} });
    expect(await screen.findByText(/no longer counts it/)).toBeInTheDocument();
    expect(screen.getByText('Nothing shared')).toBeInTheDocument();
  });

  it('shows a current student when they will be counted, and NA for a missing date', async () => {
    fetchMock.mockResolvedValue(ok({ colleges: [college(null, { relationship: 'CURRENT', graduatedOn: null }), college(null, { institutionId: crypto.randomUUID(), institutionName: 'Second College', graduatedOn: null })] }));
    render(<StudentOutcomesCard />);
    expect(await screen.findByText('Studying here now — counted once your graduation is recorded')).toBeInTheDocument();
    expect(screen.getByText('Graduated NA')).toBeInTheDocument();
  });

  it('stays out of the way with no college, and explains a refusal without upstream text', async () => {
    fetchMock.mockResolvedValue(ok({ colleges: [] }));
    const { container, unmount } = render(<StudentOutcomesCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    unmount();

    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => Promise.resolve(init?.method === 'POST' ? refused(403, 'OUTCOME_COLLEGE_NOT_ELIGIBLE') : ok({ colleges: [college()] })));
    render(<StudentOutcomesCard />);
    fireEvent.change(await screen.findByLabelText('What did you go on to do?'), { target: { value: 'ENTREPRENEURSHIP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share with Synthetic Institute' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You can share this only with a college you study at or graduated from. Support code: corroutc');
    expect(screen.queryByText(/upstream detail text/)).not.toBeInTheDocument();
  });

  it('says so when the list cannot be loaded', async () => {
    fetchMock.mockResolvedValue(refused(500, 'INTERNAL'));
    render(<StudentOutcomesCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your outcome sharing could not be loaded.');
  });
});

describe('Accreditation outcomes in the Exports panel', () => {
  const csvResponse = (filename: string) => ({
    ok: true, status: 200, headers: { get: (name: string) => (name.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : null) },
    text: async () => '﻿"Row"\r\n', json: async () => ({}),
  });

  it('offers the file with no month or unit, says it is not an official template, and sends only the reason', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(csvResponse('one-accreditation-outcomes-2026-08.csv'));
    render(<InstitutionExportsPanel institutionId={institutionId} />);
    fireEvent.change(screen.getByLabelText('What to export'), { target: { value: 'accreditation-outcomes' } });
    expect(screen.getByText(/ONE does not claim it matches any accreditation format/)).toBeInTheDocument();
    expect(screen.getByText(/self-reported by graduates who chose to share them/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Month')).not.toBeInTheDocument();
    expect(screen.queryByText('Limit to one department, programme, batch or section')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason for this export'), { target: { value: 'ACCREDITATION_PREPARATION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Accreditation outcomes exported as one-accreditation-outcomes-2026-08.csv');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/institutions/' + institutionId + '/exports/accreditation-outcomes');
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'ACCREDITATION_PREPARATION' });
    click.mockRestore();
  });

  it('leaves every navigation label as it was', () => {
    const labels = (key: string) => rolePortals.find((portal) => portal.key === key)!.nav.map((item) => item.label);
    expect(labels('institution-admin')).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(labels('department-head')).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
  });
});
