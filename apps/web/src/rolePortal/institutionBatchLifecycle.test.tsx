/**
 * Year-end actions on the institution Students page (INST-10): nothing is requested until the
 * admin previews; the preview lists every student with its outcome; commit sends exactly the
 * previewed request with its digest and a reason; an invalid row blocks commit; a stale preview
 * is refused and cleared; refusals never show upstream text. The Students page carries the
 * panel, and the admin's navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { YearEndBatchPanel, startOfLocalDay } from './institutionBatchLifecycle.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const batchUnit = { id: crypto.randomUUID(), institutionId, kind: 'BATCH', name: 'CSE 2022', parentUnitId: null };
const departmentUnit = { id: crypto.randomUUID(), institutionId, kind: 'DEPARTMENT', name: 'Computer Science', parentUnitId: null };
const digest = 'a'.repeat(64);
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (status: number, code: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { code, message: 'upstream detail text', correlationId: 'corr-batch' } }) });
const previewBody = (counts: { change: number; unchanged: number; invalid: number }, rows: unknown[]) => ({ batch: { state: 'GRADUATED', effectiveTo: null, counts, digest, rows } });
const rows = [
  { institutionStudentId: 'CSE-001', fullName: 'Asha Rao', currentState: 'ACTIVE', outcome: 'CHANGE', issues: [] },
  { institutionStudentId: 'CSE-900', fullName: 'Vikram Iyer', currentState: 'GRADUATED', outcome: 'UNCHANGED', issues: [] },
];
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index]![1].body)) as Record<string, unknown>;

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

function renderPanel(onChanged = vi.fn()) {
  render(<YearEndBatchPanel token="token" institutionId={institutionId} units={[departmentUnit, batchUnit]} onChanged={onChanged} />);
  return onChanged;
}

describe('Year-end actions', () => {
  it('requests nothing until previewed, then previews a batch and commits exactly that with a reason', async () => {
    const onChanged = renderPanel();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Batch or unit'), { target: { value: batchUnit.id } });
    fetchMock.mockResolvedValueOnce(ok(previewBody({ change: 1, unchanged: 1, invalid: 0 }, rows)));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(table).getByText('Will change')).toBeInTheDocument();
    expect(within(table).getByText('Already left — no change')).toBeInTheDocument();
    expect(screen.getByText('1 will be recorded as graduated, 1 already left, 0 cannot be changed.')).toBeInTheDocument();
    expect(bodyOf(0)).toEqual({ state: 'GRADUATED', unitId: batchUnit.id });
    expect(String(posts()[0]![0])).toContain('/institutions/' + institutionId + '/relationship-batches/preview');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'EARLY_COMPLETION' } });
    fetchMock.mockResolvedValueOnce(ok({ batch: { ...previewBody({ change: 1, unchanged: 1, invalid: 0 }, rows).batch, changed: 1, effectiveTo: '2026-05-30T18:30:00.000Z' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 change' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(bodyOf(1)).toEqual({ state: 'GRADUATED', unitId: batchUnit.id, previewDigest: digest, reasonCode: 'EARLY_COMPLETION' });
    expect(String(posts()[1]![0])).toContain('/relationship-batches/commit');
    expect(onChanged.mock.calls[0]![0]).toMatch(/^1 student recorded as graduated from .*2026\. They keep their ONE accounts and will be notified\.$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sends a list of roll numbers and the start of the chosen day', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'TRANSFERRED' } });
    fireEvent.change(screen.getByLabelText('Students'), { target: { value: 'rolls' } });
    fireEvent.change(screen.getByLabelText('Roll numbers (one per line)'), { target: { value: 'CSE-001\n\nCSE-002, CSE-003' } });
    fireEvent.change(screen.getByLabelText('Effective date (leave empty for today)'), { target: { value: '2026-05-31' } });
    fetchMock.mockResolvedValueOnce(ok(previewBody({ change: 0, unchanged: 0, invalid: 0 }, [])));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('No students in this selection.');
    expect(bodyOf(0)).toEqual({ state: 'TRANSFERRED', institutionStudentIds: ['CSE-001', 'CSE-002', 'CSE-003'], effectiveTo: startOfLocalDay('2026-05-31') });
    expect(screen.getByRole('button', { name: 'Commit 0 changes' })).toBeDisabled();
  });

  it('blocks commit while any row cannot change, and says why in plain words', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Students'), { target: { value: 'rolls' } });
    fireEvent.change(screen.getByLabelText('Roll numbers (one per line)'), { target: { value: 'CSE-001\nNOPE-1' } });
    fetchMock.mockResolvedValueOnce(ok(previewBody({ change: 1, unchanged: 0, invalid: 1 }, [rows[0], { institutionStudentId: 'NOPE-1', fullName: null, currentState: null, outcome: 'INVALID', issues: ['STUDENT_NOT_FOUND'] }])));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Not on your roster')).toBeInTheDocument();
    expect(within(table).getByText('Not found')).toBeInTheDocument();
    expect(within(table).getByText('Not recorded')).toBeInTheDocument();
    expect(within(table).queryByText('NA')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit 1 change' })).toBeDisabled();
    expect(screen.getByText(/Nothing is saved while any row cannot change/)).toBeInTheDocument();
  });

  it('clears a stale preview and explains refusals without upstream text', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Batch or unit'), { target: { value: batchUnit.id } });
    fetchMock.mockResolvedValueOnce(ok(previewBody({ change: 1, unchanged: 1, invalid: 0 }, rows)));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('table');
    fetchMock.mockResolvedValueOnce(refused(409, 'BATCH_PREVIEW_STALE'));
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The roster changed since your preview. Nothing was saved — preview again. Support code: corrbatc');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(refused(400, 'EFFECTIVE_DATE_IN_FUTURE'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The date cannot be in the future.');
    fetchMock.mockResolvedValueOnce(refused(403, 'FORBIDDEN'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Support code: corrbatc'));
    expect(document.body.textContent).not.toContain('upstream detail text');
  });

  it('asks for a unit or roll numbers before previewing', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a batch or unit.');
    fireEvent.change(screen.getByLabelText('Students'), { target: { value: 'rolls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter at least one roll number.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Students page', () => {
  it('carries the year-end panel for an admin, requesting nothing for it, with navigation unchanged', async () => {
    const portal = rolePortals.find((item) => item.key === 'institution-admin')!;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/units')) return ok({ units: [batchUnit] });
      if (String(url).includes('/placement-status')) return ok({ students: [], nextCursor: null });
      if (String(url).includes('/students')) return ok({ students: [], activationSummary: {}, scope: { kind: 'INSTITUTION', units: [] } });
      return ok({});
    });
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'Students')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    expect(await screen.findByRole('heading', { name: 'Year-end actions' })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByLabelText('Batch or unit')).getByText('CSE 2022 (Batch)')).toBeInTheDocument());
    expect(posts()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('relationship-batches'))).toBe(false);
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
  });
});
