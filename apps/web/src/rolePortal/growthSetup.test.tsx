/**
 * Operations → Settings → Growth set-up (GROWTH-02): a GROWTH_ADMIN holder previews and commits
 * the LGD district import, creates regions, adds areas and assigns growth people, each with a
 * reason; an operator without GROWTH_ADMIN sees nothing of it. A section of Settings, not a
 * navigation item.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { OperationsGrowthSetupPanel } from './growthSetup.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const regionId = crypto.randomUUID();
const executiveId = crypto.randomUUID();
const managerId = crypto.randomUUID();
const now = new Date().toISOString();
const reasons = {
  createRegion: ['NEW_REGION', 'REORGANISATION', 'CORRECTION'], retireRegion: ['REORGANISATION', 'NO_LONGER_WORKED', 'CORRECTION'],
  addArea: ['NEW_COVERAGE', 'TERRITORY_CHANGE', 'CORRECTION'], removeArea: ['TERRITORY_CHANGE', 'REGION_RETIRING', 'CORRECTION'],
  startAssignment: ['NEW_ASSIGNMENT', 'TERRITORY_CHANGE', 'COVERAGE', 'CORRECTION'], endAssignment: ['TERRITORY_CHANGE', 'WORKLOAD', 'LEFT_REGION', 'CORRECTION'],
  importDistricts: ['INITIAL_IMPORT', 'LGD_UPDATE', 'CORRECTION'],
};
const setup = () => ({
  states: [
    { code: 'IN-KA', name: 'Karnataka', kind: 'STATE', districtCount: 2 },
    { code: 'IN-DL', name: 'Delhi', kind: 'UNION_TERRITORY', districtCount: 0 },
  ],
  regions: [{
    id: regionId, name: 'South-1', createdAt: now, reasonCode: 'NEW_REGION', retiredAt: null, retiredReasonCode: null,
    areas: [], assignments: [{ id: crypto.randomUUID(), membershipId: managerId, email: 'region.manager@example.test', role: 'MANAGER', startsAt: now, reasonCode: 'NEW_ASSIGNMENT', membershipState: 'ACTIVE' }],
  }],
  truncated: false,
  people: [
    { membershipId: executiveId, email: 'field.person@example.test', role: 'GROWTH_EXECUTIVE' },
    { membershipId: managerId, email: 'region.manager@example.test', role: 'GROWTH_MANAGER' },
  ],
  lastImport: null,
  vocabulary: { assignmentRoles: ['EXECUTIVE', 'MANAGER'], reasons },
  limits: { importRows: 2000, importCharacters: 1_000_000 },
  correlationId: 'corr-setup',
});
const preview = {
  filename: 'lgd.csv', fileProblems: [], rowCount: 2, counts: { new: 1, unchanged: 0, renamed: 1, errors: 0 }, committable: true, digest: 'a'.repeat(64),
  rows: [
    { line: 2, districtCode: 555, districtName: 'Bengaluru Urban', stateCode: 'IN-KA', status: 'NEW', issues: [] },
    { line: 3, districtCode: 556, districtName: 'Mysore', stateCode: 'IN-KA', status: 'RENAMED', issues: [], previousName: 'Mysuru' },
  ],
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string) => Promise.resolve({ ok: false, status, json: async () => ({ error: { code, correlationId: 'corr-fail' } }), headers: new Headers() });
let listResponse: () => Promise<unknown>;

beforeEach(() => {
  listResponse = () => ok(setup());
  vi.mocked(getProtectedAccessToken).mockReturnValue('ops-token');
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (path.endsWith('/district-imports/preview')) return ok({ preview, correlationId: 'corr-preview' });
    if (init?.method === 'POST') return ok({ correlationId: 'corr-post' });
    if (path.includes('/growth-territories/districts?state=IN-KA')) return ok({ stateCode: 'IN-KA', districts: [{ code: 555, name: 'Bengaluru Urban', region: null }, { code: 556, name: 'Mysuru', region: { id: 'x', name: 'Old-South' } }] });
    if (path.endsWith('/api/v1/operations/growth-territories')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> }));

describe('Growth set-up section', () => {
  it('renders nothing for an operator without GROWTH_ADMIN', async () => {
    listResponse = () => failure(403, 'FORBIDDEN');
    const { container } = render(<OperationsGrowthSetupPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows real counts, the regions with their people, and says plainly that no district list is imported yet', async () => {
    render(<OperationsGrowthSetupPanel />);
    expect(await screen.findByRole('heading', { name: 'Growth set-up' })).toBeInTheDocument();
    const summary = screen.getByLabelText('Growth set-up summary');
    expect(within(summary).getByText('Live regions').parentElement).toHaveTextContent('1');
    expect(within(summary).getByText('Districts imported').parentElement).toHaveTextContent('2');
    expect(screen.getByText(/No district list has been imported yet/)).toBeInTheDocument();
    const region = screen.getByRole('article', { name: 'Region South-1' });
    expect(within(region).getByText(/region\.manager@example\.test · Manager/)).toBeInTheDocument();
    // A region with people cannot be retired from here.
    expect(within(region).getByRole('button', { name: 'Retire region' })).toBeDisabled();
  });

  it('previews the district file first and commits exactly that preview with a reason', async () => {
    render(<OperationsGrowthSetupPanel />);
    await screen.findByRole('heading', { name: 'Growth set-up' });
    const file = new File(['state,district_code,district_name\nKarnataka,555,Bengaluru Urban'], 'lgd.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('LGD district file'), { target: { files: [file] } });
    const previewButton = screen.getByRole('button', { name: 'Preview import' });
    await waitFor(() => expect(previewButton).toBeEnabled());
    fireEvent.click(previewButton);
    const shown = await screen.findByLabelText('Import preview');
    expect(within(shown).getByText(/1 new · 1 renamed · 0 unchanged · 0 with errors/)).toBeInTheDocument();
    expect(within(shown).getByText('Mysore (was Mysuru)')).toBeInTheDocument();
    const commit = within(shown).getByRole('button', { name: 'Commit import' });
    expect(commit).toBeDisabled();
    fireEvent.change(within(shown).getByLabelText('Reason for the import'), { target: { value: 'INITIAL_IMPORT' } });
    fireEvent.click(commit);
    await waitFor(() => expect(posts().some((post) => post.url.endsWith('/district-imports/commit'))).toBe(true));
    const sent = posts().find((post) => post.url.endsWith('/district-imports/commit'))!;
    expect(sent.body).toMatchObject({ filename: 'lgd.csv', previewDigest: 'a'.repeat(64), reasonCode: 'INITIAL_IMPORT' });
  });

  it('creates a region, adds a district area and assigns an executive, each with its reason', async () => {
    render(<OperationsGrowthSetupPanel />);
    await screen.findByRole('heading', { name: 'Growth set-up' });
    fireEvent.change(screen.getByLabelText('Region name'), { target: { value: 'North-1' } });
    fireEvent.change(screen.getByLabelText('Reason for the new region'), { target: { value: 'NEW_REGION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create region' }));
    await waitFor(() => expect(posts().some((post) => post.url.endsWith('/growth-territories/regions'))).toBe(true));
    expect(posts().find((post) => post.url.endsWith('/growth-territories/regions'))!.body).toEqual({ name: 'North-1', reasonCode: 'NEW_REGION' });

    const region = screen.getByRole('article', { name: 'Region South-1' });
    fireEvent.change(within(region).getByLabelText('State to add to South-1'), { target: { value: 'IN-KA' } });
    await within(region).findByRole('option', { name: 'Mysuru — in Old-South' });
    fireEvent.change(within(region).getByLabelText('District to add to South-1'), { target: { value: '555' } });
    fireEvent.change(within(region).getByLabelText('Reason for adding an area to South-1'), { target: { value: 'NEW_COVERAGE' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Add area' }));
    await waitFor(() => expect(posts().some((post) => post.url.endsWith(`/regions/${regionId}/areas`))).toBe(true));
    expect(posts().find((post) => post.url.endsWith(`/regions/${regionId}/areas`))!.body).toEqual({ stateCode: 'IN-KA', districtCode: 555, reasonCode: 'NEW_COVERAGE' });

    // The manager already assigned is not offered again; the executive is assigned as an executive.
    const personSelect = within(region).getByLabelText('Person to assign to South-1');
    expect(within(personSelect).queryByRole('option', { name: /region\.manager/ })).not.toBeInTheDocument();
    fireEvent.change(personSelect, { target: { value: executiveId } });
    fireEvent.change(within(region).getByLabelText('Reason for assigning to South-1'), { target: { value: 'NEW_ASSIGNMENT' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Assign as executive' }));
    await waitFor(() => expect(posts().some((post) => post.url.endsWith(`/regions/${regionId}/assignments`))).toBe(true));
    expect(posts().find((post) => post.url.endsWith(`/regions/${regionId}/assignments`))!.body).toEqual({ membershipId: executiveId, role: 'EXECUTIVE', reasonCode: 'NEW_ASSIGNMENT' });
  });
});
