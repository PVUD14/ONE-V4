/**
 * Consented placement visibility (INST-09): the admin's Placement item and Student Detail,
 * the placement officer's roster and the department head's pipeline show each student's
 * placement status from what they shared — "Nothing shared", never "not applied" — with
 * small groups as <5, no pay, safe errors, and navigation labels exactly as they were.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const base = `/api/v1/institutions/${institutionId}`;
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

function routes(table: Readonly<Record<string, unknown>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const body = table[path];
    if (body === 'FORBIDDEN') return { ok: false, status: 403, headers: { get: () => 'corr-403' }, json: async () => ({ error: { code: 'FORBIDDEN', message: 'upstream private detail', correlationId: 'corr-403' } }) };
    return ok(body ?? {});
  });
}

function open(key: 'institution-admin' | 'placement-officer' | 'department-head', label: string, role: string): void {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
  render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
}

const asha = crypto.randomUUID(); const ravi = crypto.randomUUID();
const statusRows = [
  { studentUserId: asha, fullName: 'Asha Local', institutionStudentId: 'CSE-001', department: 'Computer Science', batch: 'CSE 2027',
    status: 'OFFER', sharedApplications: 2, sharedExternalDeclarations: 1, lastSharedActivityAt: '2026-09-20T10:00:00.000Z' },
  { studentUserId: ravi, fullName: 'Ravi Local', institutionStudentId: 'CSE-002', department: 'Computer Science', batch: null,
    status: 'NOT_SHARED', sharedApplications: 0, sharedExternalDeclarations: 0, lastSharedActivityAt: null },
];
const suppressed = (key: string) => ({ key, count: null, suppressed: true });
const pipeline = {
  scope: { kind: 'INSTITUTION' }, unit: null,
  studentsSharing: { suppressed: false, value: 7 },
  stages: { suppressed: false, total: { suppressed: true, value: null }, cells: [{ key: 'APPLIED', count: 6, suppressed: false }, suppressed('INTERVIEW')] },
  offers: { suppressed: true, total: { suppressed: true, value: null }, cells: [] },
  placementStatus: { suppressed: false, total: { suppressed: false, value: 40 }, cells: [
    { key: 'NOT_SHARED', count: 33, suppressed: false }, { key: 'APPLIED', count: 7, suppressed: false }, suppressed('IN_PROCESS'), suppressed('OFFER'), suppressed('ACCEPTED')] },
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('admin Placement', () => {
  it('shows the status distribution with <5, the stage funnel and every student\'s status, never pay', async () => {
    routes({ [`${base}/placement-pipeline`]: pipeline, [`${base}/placement-status`]: { students: statusRows, nextCursor: null } });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Placement', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Students by placement status' })).toBeInTheDocument();
    const list = await screen.findByRole('region', { name: 'Placement status by student' });
    const ashaRow = await within(list).findByRole('row', { name: /Asha Local/ });
    expect(within(ashaRow).getByText('Offer')).toBeInTheDocument();
    expect(ashaRow).toHaveTextContent('2 on ONE · 1 declared elsewhere');
    expect(ashaRow).toHaveTextContent('2026-09-20');
    const raviRow = within(list).getByRole('row', { name: /Ravi Local/ });
    expect(within(raviRow).getByText('Nothing shared')).toBeInTheDocument();
    expect(within(raviRow).getByText('Not shared')).toBeInTheDocument();
    expect(within(raviRow).getByText('No batch')).toBeInTheDocument();
    expect(within(raviRow).getByText('Never')).toBeInTheDocument();   // no shared update
    expect(within(raviRow).queryByText('NA')).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('<5');
    expect(screen.queryByText(/^not applied$/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/compensation|salary|stipend|CTC/i);
    expect(screen.queryByText(asha)).not.toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });

  it('opens one student\'s shared applications from the list', async () => {
    routes({
      [`${base}/placement-pipeline`]: pipeline, [`${base}/placement-status`]: { students: statusRows, nextCursor: null },
      [`${base}/students/${asha}/applications`]: { applications: [{ id: crypto.randomUUID(), employer: { name: 'Local Employer' }, opportunityTitle: 'Graduate engineer', state: 'OFFER',
        createdAt: '2026-09-01T00:00:00Z', submittedAt: '2026-09-01T00:00:00Z', offer: { exists: true, responseState: 'EXTENDED' } }] },
      [`${base}/students/${asha}/external-applications`]: { externalApplications: [] },
    });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    fireEvent.click(await screen.findByRole('button', { name: 'View shared applications for Asha Local' }));
    const region = await screen.findByRole('region', { name: 'Shared applications for Asha Local' });
    expect(await within(region).findByText('Local Employer')).toBeInTheDocument();
    expect(within(region).getByText('Extended')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View shared applications for Ravi Local' })).not.toBeInTheDocument();
  });

  it('pages with Load more', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/placement-pipeline')) return ok(pipeline);
      // INST-12's statistics and register load on the same page; only the status list pages.
      if (!String(url).includes('/placement-status')) return ok({});
      calls += 1;
      return ok(calls === 1 ? { students: [statusRows[0]], nextCursor: 'next-page' } : { students: [statusRows[1]], nextCursor: null });
    });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    fireEvent.click(await screen.findByRole('button', { name: 'Load more students' }));
    expect(await screen.findByText('Ravi Local')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=next-page'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more students' })).not.toBeInTheDocument();
  });

  it('hides the figures and shows a safe forbidden message, never the upstream text', async () => {
    routes({ [`${base}/placement-pipeline`]: 'FORBIDDEN', [`${base}/placement-status`]: 'FORBIDDEN' });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('You do not have permission to view this.');
    expect(document.body.textContent).not.toContain('upstream private detail');
    expect(document.querySelectorAll('.pilot-kpi')).toHaveLength(0);
    expect(screen.queryByText('NA')).not.toBeInTheDocument();
  });

  it('shows an honest empty list when nobody is in scope', async () => {
    routes({ [`${base}/placement-pipeline`]: { ...pipeline, placementStatus: undefined }, [`${base}/placement-status`]: { students: [], nextCursor: null } });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    expect(await screen.findByText('No students in your scope')).toBeInTheDocument();
  });

  it('Student Detail is one student: a chooser first, then their consented placement status and shared applications', async () => {
    routes({ [`${base}/students`]: { students: [{ id: crypto.randomUUID(), studentUserId: asha, fullName: 'Asha Local', institutionStudentId: 'CSE-001', email: 'asha@example.test', status: 'ACTIVE', units: {} }], scope: { kind: 'INSTITUTION' } },
      [`${base}/units`]: { units: [] }, [`${base}/placement-status`]: { students: statusRows, nextCursor: null },
      [`${base}/students/${asha}/applications`]: { applications: [] }, [`${base}/students/${asha}/external-applications`]: { externalApplications: [] } });
    open('institution-admin', 'Student Detail', 'INSTITUTION_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Student Detail', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Choose a student to see their detail')).toBeInTheDocument();
    // Not the roster a second time: no add, import or lifecycle controls here.
    expect(screen.queryByRole('heading', { name: 'Add Student' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail for Asha Local' }));
    const detail = await screen.findByRole('region', { name: 'Detail for Asha Local' });
    await waitFor(() => expect(within(detail).getByText('Offer')).toBeInTheDocument());
    expect(within(detail).getByText('CSE-001')).toBeInTheDocument();
    expect(within(detail).getByText('Active')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Applications on ONE' })).toBeInTheDocument();
  });
});

describe('placement officer and department head', () => {
  it('the officer\'s Students roster shows each student\'s placement status from the audited list', async () => {
    routes({
      [`${base}/students`]: { students: [
        { id: crypto.randomUUID(), studentUserId: asha, fullName: 'Asha Local', institutionStudentId: 'CSE-001', status: 'ACTIVE', units: {} },
        { id: crypto.randomUUID(), studentUserId: ravi, fullName: 'Ravi Local', institutionStudentId: 'CSE-002', status: 'ACTIVE', units: {} }] },
      [`${base}/units`]: { units: [] },
      [`${base}/placement-status`]: { students: statusRows, nextCursor: null },
    });
    open('placement-officer', 'Students', 'PLACEMENT_ADMIN');
    const table = await screen.findByRole('table', { name: 'Placement student roster' });
    expect(within(table).getByRole('columnheader', { name: 'Placement status' })).toBeInTheDocument();
    await waitFor(() => expect(within(within(table).getByRole('row', { name: /Asha Local/ })).getByText('Offer')).toBeInTheDocument());
    expect(within(within(table).getByRole('row', { name: /Ravi Local/ })).getByText('Nothing shared')).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Asha Local/ })).toHaveTextContent('20 Sep 2026');
  });

  it('the roster says the status is not available when the status list is refused', async () => {
    routes({
      [`${base}/students`]: { students: [{ id: crypto.randomUUID(), studentUserId: asha, fullName: 'Asha Local', institutionStudentId: 'CSE-001', status: 'ACTIVE', units: {} }] },
      [`${base}/units`]: { units: [] }, [`${base}/placement-status`]: 'FORBIDDEN',
    });
    open('placement-officer', 'Students', 'PLACEMENT_ADMIN');
    const table = await screen.findByRole('table', { name: 'Placement student roster' });
    // Cells: roll, department, batch, status, placement status, applications, last activity (no per-student band).
    await waitFor(() => expect(within(within(table).getByRole('row', { name: /Asha Local/ })).getAllByRole('cell')[4]).toHaveTextContent(/^Not available$/));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('upstream private detail');
  });

  it('Student Search is search-first: nothing is listed until something is typed', async () => {
    routes({
      [`${base}/students`]: { students: [
        { id: crypto.randomUUID(), studentUserId: asha, fullName: 'Asha Local', institutionStudentId: 'CSE-001', status: 'ACTIVE', units: {} },
        { id: crypto.randomUUID(), studentUserId: ravi, fullName: 'Ravi Local', institutionStudentId: 'CSE-002', status: 'ACTIVE', units: {} }] },
      [`${base}/units`]: { units: [] }, [`${base}/placement-status`]: { students: statusRows, nextCursor: null },
    });
    open('placement-officer', 'Student Search', 'PLACEMENT_ADMIN');
    expect(await screen.findByText('Search for a student')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Student search results' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'ravi' } });
    const table = await screen.findByRole('table', { name: 'Student search results' });
    expect(within(table).getByRole('row', { name: /Ravi Local/ })).toBeInTheDocument();
    expect(within(table).queryByRole('row', { name: /Asha Local/ })).not.toBeInTheDocument();
  });

  it('the department head\'s Placement Pipeline shows students by placement status', async () => {
    routes({ [`${base}/placement-pipeline`]: pipeline });
    open('department-head', 'Placement Pipeline', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('heading', { name: 'Students by placement status' })).toBeInTheDocument();
    expect(await screen.findByText('Nothing shared')).toBeInTheDocument();
    expect(screen.getByText('33')).toBeInTheDocument();
  });

  it('navigation labels are unchanged for the admin and the placement officer', () => {
    expect(rolePortals.find((item) => item.key === 'institution-admin')!.nav.map((item) => item.label)).toEqual([
      'Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(rolePortals.find((item) => item.key === 'placement-officer')!.nav.map((item) => item.label)).toEqual([
      'Dashboard', 'Assessments', 'Help & FAQ', 'Students', 'Student Search', 'Readiness', 'Departments', 'Batches']);
  });
});
