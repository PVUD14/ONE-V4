/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { InstitutionStaffActionsPage, InstitutionStudentsPage } from './institution.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const institutionId = crypto.randomUUID();
const studentId = crypto.randomUUID();
const membershipId = crypto.randomUUID();
const actionId = crypto.randomUUID();
const fetchMock = vi.fn();
const response = (body: unknown) => ({ ok: true, json: async () => body });
const data = (actions: unknown[] = []) => ({ actions, students: [{ id: studentId, name: 'Local student' }], assignees: [{ id: membershipId, name: 'You' }] });
const action = {
  id: actionId, title: 'Recorded task', actionType: 'ASSIGNED_TASK', note: 'Recorded note', outcomeNote: null,
  studentUserId: studentId, studentName: 'Local student', ownerName: 'owner@example.test', authorName: 'author@example.test',
  assignedToMembershipId: membershipId, state: 'DRAFT', visibility: 'STAFF_ONLY', version: 1,
  dueAt: null, scheduledStartAt: null, scheduledEndAt: null, reviewerName: null, lastReviewedAt: null,
  allowedTransitions: ['UNDER_REVIEW', 'CANCELLED'], canEdit: true,
};
beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockResolvedValue(response(data()));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });
function page(label = 'Assigned Tasks', org = institutionId, role = 'FACULTY_LECTURER') {
  return <InstitutionStaffActionsPage routeLabel={label} authenticatedWorkspace={{ organizationId: org, role }} />;
}
async function loaded() {
  await waitFor(() => expect(screen.getByRole('button', { name: /^Create / })).toBeEnabled());
}
const workflows = [
  ['Assigned Tasks', 'ASSIGNED_TASK', 'task'],
  ['Student Detail', 'FACULTY_NOTE', 'note'],
  ['Academic Verification', 'ACADEMIC_VERIFICATION', 'verification'],
  ['Meetings', 'MEETING', 'meeting'],
] as const;

describe('C5 institution workflows', () => {
  it.each(workflows)('loads %s from its protected typed endpoint and renders an honest empty state', async (label, type) => {
    render(page(label)); await loaded();
    expect(fetchMock.mock.calls[0]![0]).toContain('/institutions/' + institutionId + '/staff-actions?actionType=' + type);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer ' + getProtectedAccessToken());
    expect(screen.getByText('No records match your current scope and filters.')).toBeInTheDocument();
    expect(screen.queryByText(studentId)).not.toBeInTheDocument();
  });

  it.each(workflows)('creates %s with staff-only visibility and reloads persisted data', async (label, type, noun) => {
    fetchMock.mockResolvedValueOnce(response(data())).mockResolvedValueOnce(response({ id: actionId })).mockResolvedValue(response(data([{ ...action, actionType: type }])));
    render(page(label)); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Create ' + noun }));
    fireEvent.change(screen.getByLabelText('Student'), { target: { value: studentId } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Recorded task' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Recorded note' } });
    if (type === 'MEETING') {
      fireEvent.change(screen.getByLabelText('Meeting start'), { target: { value: '2030-01-01T10:00' } });
      fireEvent.change(screen.getByLabelText('Meeting end'), { target: { value: '2030-01-01T11:00' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('heading', { name: 'Recorded task' })).toBeInTheDocument();
    const options = fetchMock.mock.calls[1]![1];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({ studentUserId: studentId, title: 'Recorded task', note: 'Recorded note', visibility: 'STAFF_ONLY' });
    expect(screen.getByText(/Author: author@example.test/)).toBeInTheDocument();
    expect(screen.queryByText(actionId)).not.toBeInTheDocument();
  });

  it('shows loading without presenting an empty result or enabling writes', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(page());
    expect(screen.getByText('Loading records…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    expect(screen.queryByText('No records match your current scope and filters.')).not.toBeInTheDocument();
  });

  it.each([
    [403, 'You do not have permission in this institution or student scope.'],
    [401, 'Your session has expired. Sign in again.'],
    [500, 'Unable to load or save records. Please try again.'],
  ])('shows safe %s errors without exposing upstream text', async (status, message) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ message: 'private upstream error' }) });
    render(page());
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('private upstream error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
  });

  it('does not fetch without authentication or institution permission', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    const view = render(page());
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
    view.rerender(page('Assigned Tasks', institutionId, 'EMPLOYER_ADMIN'));
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates only supported task fields with the persisted version', async () => {
    fetchMock.mockResolvedValueOnce(response(data([action]))).mockResolvedValueOnce(response({ version: 2 })).mockResolvedValue(response(data([{ ...action, title: 'Edited task', version: 2 }])));
    render(page()); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('heading', { name: 'Edited task' });
    expect(fetchMock.mock.calls[1]![0]).toContain('/' + actionId + '/update');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ version: 1, title: 'Edited task', note: 'Recorded note', dueAt: null });
  });

  it('requires a verification review note and uses the server-approved transition and version', async () => {
    fetchMock.mockResolvedValueOnce(response(data([{ ...action, actionType: 'ACADEMIC_VERIFICATION', canEdit: false, state: 'UNDER_REVIEW', version: 2, allowedTransitions: ['APPROVED', 'REJECTED'] }])))
      .mockResolvedValueOnce(response({ version: 3 })).mockResolvedValue(response(data([{ ...action, state: 'APPROVED', canEdit: false, allowedTransitions: [], reviewerName: 'reviewer@example.test', lastReviewedAt: '2030-01-01T10:00:00Z', outcomeNote: 'Review recorded' }])));
    render(page('Academic Verification')); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add a review or outcome note');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Review or outcome note for Recorded task'), { target: { value: 'Review recorded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/Reviewed by reviewer@example.test/)).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ version: 2, toState: 'APPROVED', note: 'Review recorded' });
    expect(screen.queryByRole('button', { name: 'Edit task' })).not.toBeInTheDocument();
  });

  it('validates meeting dates before sending and supports a studentless staff meeting', async () => {
    render(page('Meetings')); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Staff planning' } });
    fireEvent.change(screen.getByLabelText('Meeting start'), { target: { value: '2030-01-01T11:00' } });
    fireEvent.change(screen.getByLabelText('Meeting end'), { target: { value: '2030-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Meeting end must be after its start.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Meeting end'), { target: { value: '2030-01-01T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ studentUserId: null, title: 'Staff planning' });
  });

  it('sends student/state/responsibility/meeting-period filters to the typed endpoint', async () => {
    render(page('Meetings')); await loaded();
    fireEvent.change(screen.getByLabelText('Filter student'), { target: { value: studentId } }); await loaded();
    fireEvent.change(screen.getByLabelText('Filter state'), { target: { value: 'DRAFT' } }); await loaded();
    fireEvent.change(screen.getByLabelText('Filter responsibility'), { target: { value: membershipId } }); await loaded();
    fireEvent.change(screen.getByLabelText('Meeting period'), { target: { value: 'past' } }); await loaded();
    const url = new URL(fetchMock.mock.calls.at(-1)![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ actionType: 'MEETING', studentUserId: studentId, state: 'DRAFT', assigneeMembershipId: membershipId, period: 'past' });
  });

  it('aborts and discards late data when institution or action type changes', async () => {
    let resolveOld!: (result: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(response(data()));
    const view = render(page());
    const oldSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(page('Student Detail', crypto.randomUUID())); await loaded();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(response(data([action]))));
    expect(screen.queryByRole('heading', { name: action.title })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Faculty Notes' })).toBeInTheDocument();
  });
});

describe('C5 Core dispatcher exception', () => {
  it.each([
    ['faculty', 'Assigned Tasks', 'ASSIGNED_TASK'],
    ['faculty', 'Student Detail', 'FACULTY_NOTE'],
    ['faculty', 'Academic Verification', 'ACADEMIC_VERIFICATION'],
    ['faculty', 'Calendar', 'MEETING'],
    ['department-head', 'Meetings', 'MEETING'],
  ])('routes %s / %s to the C-owned implementation without adding navigation', async (key, label, type) => {
    const portal = rolePortals.find((item) => item.key === key)!;
    const route = portal.nav.find((item) => item.label === label)!;
    window.history.replaceState(null, '', route.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role: portal.backendRole }} />);
    await loaded();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/staff-actions?actionType=' + type))).toBe(true);
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });
});

describe('Placement Officer roster', () => {
  const portal = rolePortals.find((item) => item.key === 'placement-officer')!;
  const department = crypto.randomUUID(); const batch = crypto.randomUUID();
  const placement = (org = institutionId) => <InstitutionStudentsPage portal={portal} authenticatedWorkspace={{ organizationId: org, role: 'PLACEMENT_ADMIN' }} />;
  function rosterResponse() {
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes('/units') ? { units: [
      { id: department, kind: 'DEPARTMENT', name: 'Engineering' }, { id: batch, kind: 'BATCH', name: 'Final year' },
    ] } : { students: [
      { id: studentId, fullName: 'Local placement student', institutionStudentId: 'LOCAL-001', status: 'ACTIVE', units: { departmentUnitId: department, batchUnitId: batch } },
      { id: crypto.randomUUID(), fullName: 'Other local student', institutionStudentId: 'LOCAL-002', status: 'INACTIVE', units: {} },
    ] })));
  }
  it('loads the selected institution read-only with placement columns and no invented values or admin mutations', async () => {
    rosterResponse(); render(placement());
    expect(screen.getByText('Loading roster…')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Placement student roster' });
    expect(within(table).getByRole('columnheader', { name: 'Readiness band' })).toBeInTheDocument();
    // INST-09 added the Placement status column: a roster row with no linked account has no status either, so NA (four NA cells).
    expect(within(within(table).getByRole('row', { name: /Local placement student/ })).getAllByRole('cell', { name: 'NA' })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /Add student|Validate CSV|Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByText(studentId)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/institutions/' + institutionId + '/'))).toBe(true);
  });
  it('filters by department, batch, status and searches names/roll numbers/unit names', async () => {
    rosterResponse(); render(placement()); await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: department } });
    fireEvent.change(screen.getByLabelText('Batch'), { target: { value: batch } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ACTIVE' } });
    expect(screen.queryByText('Other local student')).not.toBeInTheDocument();
    for (const query of ['engineering', 'LOCAL-001', 'placement']) {
      fireEvent.change(screen.getByLabelText('Search students'), { target: { value: query } });
      expect(screen.getByText('Local placement student')).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'missing student' } });
    expect(screen.getByText('No students match your scope and filters.')).toBeInTheDocument();
  });
  it('clears the old institution before loading a new workspace', async () => {
    rosterResponse(); const view = render(placement()); await screen.findByRole('table');
    fetchMock.mockReturnValue(new Promise(() => {}));
    view.rerender(placement(crypto.randomUUID()));
    expect(screen.getByText('Loading roster…')).toBeInTheDocument();
    expect(screen.queryByText('Local placement student')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('shows a safe denied state and never loads without a token', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'private error' }) });
    const view = render(placement());
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.queryByText('private error')).not.toBeInTheDocument();
    view.unmount(); fetchMock.mockClear(); vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(placement());
    expect(screen.getByText('Sign in to your institution staff workspace.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the units a scoped reader is limited to, and says nothing extra for the whole institution', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes('/units') ? { units: [] } : {
      students: [], scope: { kind: 'UNITS', units: [{ id: department, kind: 'DEPARTMENT', name: 'Mechanical Engineering' }] },
    })));
    const view = render(placement());
    expect(await screen.findByText('Showing students in Mechanical Engineering.')).toBeInTheDocument();
    view.unmount();
    rosterResponse(); render(placement());
    await screen.findByRole('table', { name: 'Placement student roster' });
    expect(screen.queryByText(/^Showing students in/)).not.toBeInTheDocument();
  });
});


describe('External application distinction in the placement roster', () => {
  const portal = rolePortals.find((item) => item.key === 'placement-officer')!;
  const profileId = crypto.randomUUID(); const otherProfileId = crypto.randomUUID(); const otherStudentId = crypto.randomUUID();
  const placement = (org = institutionId) => <InstitutionStudentsPage portal={portal} authenticatedWorkspace={{ organizationId: org, role: 'PLACEMENT_ADMIN' }} />;
  const native = { id: crypto.randomUUID(), employer: { name: 'Native employer' }, opportunityTitle: 'Native role', state: 'APPLIED',
    createdAt: '2026-09-01T10:00:00Z', submittedAt: '2026-09-01T10:00:00Z', offer: { exists: false, responseState: null } };
  const external = { id: crypto.randomUUID(), companyName: 'Declared employer', roleTitle: 'Declared role', stage: 'HIRED',
    appliedOn: '2026-09-01', sourceKind: 'REFERRAL', source: 'STUDENT_DECLARED', verificationState: 'UNVERIFIED' };
  function mockRoster(externalRead: (url: string, options: RequestInit) => unknown = () => Promise.resolve(response({ externalApplications: [external] }))) {
    fetchMock.mockImplementation((url: string, options: RequestInit) => {
      if (url.includes('/external-applications')) return externalRead(url, options);
      if (url.endsWith('/applications')) return Promise.resolve(response({ applications: [native] }));
      if (url.includes('/units')) return Promise.resolve(response({ units: [] }));
      return Promise.resolve(response({ students: [
        { id: profileId, studentUserId: studentId, fullName: 'First local student', institutionStudentId: 'EXT-001', status: 'ACTIVE', units: {} },
        { id: otherProfileId, studentUserId: otherStudentId, fullName: 'Second local student', institutionStudentId: 'EXT-002', status: 'ACTIVE', units: {} },
      ] }));
    });
  }
  async function openFirst() {
    fireEvent.click(await screen.findByRole('button', { name: 'View applications for First local student' }));
  }

  it('uses the student user ID and keeps declared HIRED separate from native counts and labels', async () => {
    mockRoster(); render(placement());
    await screen.findByRole('table', { name: 'Placement student roster' });
    // Roster, units and (INST-09) the audited placement-status list — and no per-student application read until one is opened.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/placement-status'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => /\/students\/[^/]+\/(external-)?applications/.test(String(url)))).toBe(false);
    await openFirst();
    const externalRegion = screen.getByRole('region', { name: 'Student-declared external applications (unverified)' });
    const nativeRegion = screen.getByRole('region', { name: 'Applications on ONE' });
    await within(externalRegion).findByRole('table');
    await within(nativeRegion).findByRole('table');
    expect(within(externalRegion).getByText('Hired (student-declared)')).toBeInTheDocument();
    expect(externalRegion).toHaveTextContent('Shared external declarations shown: 1');
    expect(externalRegion).toHaveTextContent('is not counted in placement figures');
    expect(nativeRegion).toHaveTextContent('Shared applications on ONE shown: 1');
    expect(within(nativeRegion).queryByText('Declared employer')).not.toBeInTheDocument();
    expect(within(externalRegion).queryByText('Native employer')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/students/' + studentId + '/external-applications'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/students/' + profileId + '/'))).toBe(false);
    expect(screen.queryByText(studentId)).not.toBeInTheDocument();
    expect(screen.queryByText(external.id)).not.toBeInTheDocument();

    const nativeBefore = nativeRegion.innerHTML;
    mockRoster(() => Promise.resolve(response({ externalApplications: [] })));
    fireEvent.click(within(externalRegion).getByRole('button', { name: 'Refresh external declarations' }));
    await within(externalRegion).findByText('No external declarations are shared and available in this scope.');
    expect(externalRegion).toHaveTextContent('Shared external declarations shown: 0');
    expect(nativeRegion.innerHTML).toBe(nativeBefore);
    expect(screen.queryByText('Declared employer')).not.toBeInTheDocument();
  });

  it('shows loading as unavailable until an actual empty result arrives', async () => {
    let resolve!: (value: unknown) => void;
    mockRoster(() => new Promise((done) => { resolve = done; }));
    render(placement()); await openFirst();
    const region = screen.getByRole('region', { name: 'Student-declared external applications (unverified)' });
    expect(within(region).getByRole('status')).toHaveTextContent('Loading external declarations');
    expect(region).toHaveTextContent('Shared external declarations shown: NA');
    expect(within(region).queryByText(/No external declarations/)).not.toBeInTheDocument();
    await act(async () => resolve(response({ externalApplications: [] })));
    expect(region).toHaveTextContent('Shared external declarations shown: 0');
  });

  it.each([401, 403, 500])('keeps native results separate from a safe external %s error', async (status) => {
    mockRoster(() => Promise.resolve({ ok: false, status, json: async () => ({ message: 'private upstream error' }) }));
    render(placement()); await openFirst();
    const region = screen.getByRole('region', { name: 'Student-declared external applications (unverified)' });
    expect(await within(region).findByRole('alert')).not.toHaveTextContent('private upstream error');
    expect(region).toHaveTextContent('Shared external declarations shown: NA');
    expect(screen.queryByText('private upstream error')).not.toBeInTheDocument();
    expect(await within(screen.getByRole('region', { name: 'Applications on ONE' })).findByText('Native employer')).toBeInTheDocument();
  });

  it('aborts old student requests, discards late data and clears details on a workspace switch', async () => {
    let resolveOld!: (value: unknown) => void;
    let oldSignal!: AbortSignal;
    mockRoster((url, options) => {
      if (url.includes('/students/' + studentId + '/')) {
        oldSignal = options.signal!;
        return new Promise((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve(response({ externalApplications: [{ ...external, companyName: 'Second declared employer' }] }));
    });
    const view = render(placement()); await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'View applications for Second local student' }));
    await screen.findByText('Second declared employer');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(response({ externalApplications: [external] })));
    expect(screen.queryByText('Declared employer')).not.toBeInTheDocument();
    view.rerender(placement(crypto.randomUUID()));
    expect(screen.queryByText('Second declared employer')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Shared applications for/ })).not.toBeInTheDocument();
  });

  it('does not mislabel a response with unexpected verification provenance', async () => {
    mockRoster(() => Promise.resolve(response({ externalApplications: [{ ...external, verificationState: 'VERIFIED' }] })));
    render(placement()); await openFirst();
    const region = screen.getByRole('region', { name: 'Student-declared external applications (unverified)' });
    await within(region).findByRole('alert');
    expect(within(region).queryByText('Declared employer')).not.toBeInTheDocument();
    expect(region).toHaveTextContent('Shared external declarations shown: NA');
  });
});
