/**
 * Every navigation item lands on its own view, and no item opens onto a refusal.
 *
 * Pins the routing fixes from the role-portal audit: each institution role lands on its own
 * home (only the placement officer keeps the Placement Dashboard), items that used to render
 * the same page show distinct views of real data, page headings match their navigation
 * labels, and screens read with an internal capability are neither offered nor asked for
 * unless the server reports the workspace holds one (ADR-032).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals, type RolePortalKey } from '../rolePortalConfig.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const platformId = crypto.randomUUID();
const base = `/api/v1/institutions/${institutionId}`;
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

/** What an operations admin holds by baseline (packages/authorization internal-capabilities.ts). */
const operationsAdminBaseline = ['OPS_ORG_MANAGE', 'OPS_VERIFY', 'OPS_FLAGS_MANAGE', 'OPS_JOBS_REPLAY', 'SUPPORT_CASES', 'SUPPORT_ACCOUNT_LOOKUP',
  'TRUST_SAFETY_INVESTIGATE', 'TRUST_SAFETY_ENFORCE', 'PRIVACY_REQUESTS', 'PRIVACY_HOLDS', 'SECURITY_AUDIT_SEARCH', 'AI_OPS_VIEW', 'ANALYTICS_VIEW',
  'ACCOUNT_MANAGE', 'COMMS_TEMPLATES'];

const missing = { ok: false, status: 404, headers: { get: () => 'corr-404' }, json: async () => ({ error: { code: 'NOT_FOUND', correlationId: 'corr-404' } }) };

/** Answers the listed paths; anything else is an empty object, or a 404 with `strict`. */
function routes(table: Readonly<Record<string, unknown>>, strict = false): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    if (path in table) return ok(table[path]);
    return strict ? missing : ok({});
  });
}

function requested(fragment: string): boolean {
  return fetchMock.mock.calls.some(([url]) => String(url).includes(fragment));
}

function open(key: RolePortalKey, label: string, role: string, capabilities?: readonly string[], organizationId = institutionId): void {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
  render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId, role, ...(capabilities ? { capabilities } : {}) }} />);
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  routes({});
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('each institution role lands on its own home', () => {
  it('the placement officer keeps the Placement Dashboard', async () => {
    open('placement-officer', 'Dashboard', 'PLACEMENT_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Placement Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('the institution admin lands on the institution overview', async () => {
    routes({ [`${base}/units`]: { units: [{ id: crypto.randomUUID(), kind: 'DEPARTMENT', name: 'Computer Science', parentUnitId: null }] } });
    open('institution-admin', 'Dashboard', 'INSTITUTION_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Institution Administration', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Placement Dashboard')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Academic Structure' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Staff' })).toBeInTheDocument();
    await waitFor(() => expect(requested(`${base}/staff-role-assignments`)).toBe(true));
  });

  it('the lecturer lands on a teaching home and never asks for drives or placement figures', async () => {
    routes({ [`${base}/my-students`]: { mode: 'ASSIGNMENTS', assignments: [], nextCursor: null, students: [
      { profileId: 'p1', studentUserId: 's1', fullName: 'Meera Local', institutionStudentId: 'CSE-010', units: { section: 'A', batch: 'CSE 2027' }, activation: null, openTasks: 2,
        recentAssessments: { submitted: 0, latestTitle: null, latestSubmittedAt: null } }] },
    [`${base}/academic-verification-summary`]: { summary: { pending: 3, notCurrent: 0 } } });
    open('faculty', 'Dashboard', 'FACULTY_LECTURER');
    expect(await screen.findByRole('heading', { name: 'Faculty Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Placement Dashboard')).not.toBeInTheDocument();
    const myStudents = screen.getByRole('heading', { name: 'My Students' }).closest('section')!;
    expect(await within(myStudents).findByText('Meera Local')).toBeInTheDocument();
    const tasks = screen.getByRole('heading', { name: 'Assigned Tasks' }).closest('section')!;
    expect(within(tasks).getByText('2 open')).toBeInTheDocument();
    expect(requested('/campus-drives')).toBe(false);
    expect(requested('/placement-statistics')).toBe(false);
    expect(screen.queryByText(/not available to your role/)).not.toBeInTheDocument();
  });

  it('the department head lands on a department home that links to the full overview', async () => {
    routes({ [`${base}/department-overview`]: { unit: null, students: { onRoster: 12, current: 11 }, activation: { ACTIVATED: 9, INVITED: 2, EXPIRED: 0, BOUNCED: 0, NOT_INVITED: 0 },
      assessments: { inProgress: 0, assignedStudents: 0, completedStudents: 0 }, readiness: { month: null, aggregate: null }, staffActions: { openInterventions: 4, openTasks: 1 }, batches: [] } }, true);
    open('department-head', 'Dashboard', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('heading', { name: 'Department Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Placement Dashboard')).not.toBeInTheDocument();
    await waitFor(() => expect(requested(`${base}/department-overview`)).toBe(true));
    expect(screen.getByRole('heading', { name: 'Your Department' })).toBeInTheDocument();
    expect(await screen.findByText('4 open')).toBeInTheDocument();
  });
});

describe('items that shared a page now show distinct views', () => {
  const units = [
    { id: 'd1', kind: 'DEPARTMENT', name: 'Computer Science', parentUnitId: null },
    { id: 'p1', kind: 'PROGRAM', name: 'B.Tech CSE', parentUnitId: 'd1' },
    { id: 'b1', kind: 'BATCH', name: 'CSE 2027', parentUnitId: 'p1' },
  ];

  it('the placement officer\'s Departments and Batches each list only their kind', async () => {
    routes({ [`${base}/units`]: { units } });
    open('placement-officer', 'Departments', 'PLACEMENT_ADMIN');
    const departments = await screen.findByRole('table', { name: /departments/i });
    expect(within(departments).getByText('Computer Science')).toBeInTheDocument();
    expect(within(departments).queryByText('CSE 2027')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Academic Structure' })).not.toBeInTheDocument();
    cleanup();
    open('placement-officer', 'Batches', 'PLACEMENT_ADMIN');
    const batches = await screen.findByRole('table', { name: /batches/i });
    expect(within(batches).getByText('CSE 2027')).toBeInTheDocument();
    expect(within(batches).getByText('B.Tech CSE')).toBeInTheDocument();
    expect(within(batches).queryByText('Computer Science')).not.toBeInTheDocument();
  });

  it('the placement officer\'s Readiness page is titled Readiness', async () => {
    open('placement-officer', 'Readiness', 'PLACEMENT_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Readiness', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reports', level: 1 })).not.toBeInTheDocument();
  });

  it('the admin\'s Students rows open Student Detail on that student', async () => {
    const id = crypto.randomUUID();
    routes({ [`${base}/students`]: { students: [{ id, institutionId, institutionStudentId: 'CSE-001', fullName: 'Asha Local', email: 'asha@example.test', status: 'ACTIVE', units: {} }] },
      [`${base}/units`]: { units: [] } });
    open('institution-admin', 'Students', 'INSTITUTION_ADMIN');
    fireEvent.click(await screen.findByRole('button', { name: 'Open detail for Asha Local' }));
    expect(window.location.pathname).toBe('/institution/admin/student-detail');
    expect(window.location.search).toBe('');
    expect(await screen.findByRole('heading', { name: 'Student Detail', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Detail for Asha Local' })).toBeInTheDocument();
  });

  const organizations = [
    { id: crypto.randomUUID(), kind: 'INSTITUTION', legalName: 'Lakeview Institute', verificationState: 'UNDER_REVIEW', updatedAt: '2026-10-01T00:00:00.000Z', profile: { displayName: 'Lakeview' }, initialAdminInvitation: null },
    { id: crypto.randomUUID(), kind: 'EMPLOYER', legalName: 'Corvane Labs', verificationState: 'VERIFIED', updatedAt: '2026-10-01T00:00:00.000Z', profile: { displayName: 'Corvane' }, initialAdminInvitation: null },
  ];

  it('Operations Verification lists only organisations awaiting a decision', async () => {
    routes({ '/api/v1/operations/organizations': { organizations } });
    open('operations-admin', 'Verification', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    expect(await screen.findByRole('heading', { name: 'Verification', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Lakeview')).toBeInTheDocument();
    expect(screen.queryByText('Corvane')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add Organization' })).not.toBeInTheDocument();
  });

  it('Operations Organization Detail is a chooser, then one organisation', async () => {
    routes({ '/api/v1/operations/organizations': { organizations } });
    open('operations-admin', 'Organization Detail', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    expect(await screen.findByRole('heading', { name: 'Organization Detail', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Choose an organisation to see its detail')).toBeInTheDocument();
    const chooser = screen.getByRole('combobox', { name: 'Organisation' });
    await waitFor(() => expect(within(chooser).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(chooser, { target: { value: organizations[1]!.id } });
    const table = await screen.findByRole('table', { name: /real organizations/ });
    expect(within(table).getByText('Corvane')).toBeInTheDocument();
    expect(within(table).queryByText('Lakeview')).not.toBeInTheDocument();
  });
});

describe('screens read with an internal capability', () => {
  const navLabels = (): readonly string[] => within(screen.getByRole('navigation', { name: /Grouped .* navigation/ })).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '');

  it('Content Management is offered only to a holder of a content capability', () => {
    open('operations-admin', 'Overview', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    expect(navLabels()).not.toContain('Content Management');
    expect(navLabels()).toContain('Security');
    cleanup();
    open('operations-admin', 'Overview', 'OPERATIONS_ADMIN', [...operationsAdminBaseline, 'CONTENT_REVIEW'], platformId);
    expect(navLabels()).toContain('Content Management');
    cleanup();
    // An API that does not report capabilities withholds nothing.
    open('operations-admin', 'Overview', 'OPERATIONS_ADMIN', undefined, platformId);
    expect(navLabels()).toContain('Content Management');
  });

  it('Content Management reached by address says so once and asks for nothing', async () => {
    open('operations-admin', 'Content Management', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    expect(await screen.findByRole('heading', { name: 'Content Management', level: 1 })).toBeInTheDocument();
    expect(requested('/career-catalogue')).toBe(false);
    expect(requested('/question-bank')).toBe(false);
    expect(screen.queryByText('Not permitted')).not.toBeInTheDocument();
  });

  it('Security does not ask for access reviews or incidents without their capabilities', async () => {
    routes({}, true);
    open('operations-admin', 'Security', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(requested('/operations/access-reviews')).toBe(false);
    expect(requested('/operations/incidents')).toBe(false);
  });

  it('Settings does not ask for staff capabilities or growth administration without them', async () => {
    routes({}, true);
    open('operations-admin', 'Settings', 'OPERATIONS_ADMIN', operationsAdminBaseline, platformId);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(requested('/operations/staff')).toBe(false);
    expect(requested('/operations/growth-')).toBe(false);
    expect(requested('/operations/approvals')).toBe(true);
  });

  it('a lecturer\'s Learning Resources is titled for its item and asks for reviews only with the grant', async () => {
    open('faculty', 'Learning Resources', 'FACULTY_LECTURER', []);
    expect(await screen.findByRole('heading', { name: 'Learning Resources', level: 1 })).toBeInTheDocument();
    expect(requested('/content-reviews')).toBe(false);
    cleanup();
    fetchMock.mockClear();
    open('faculty', 'Learning Resources', 'FACULTY_LECTURER', ['CONTENT_REVIEW_EXTERNAL']);
    await waitFor(() => expect(requested(`${base}/content-reviews`)).toBe(true));
  });

  it('a department head\'s Assessments asks for content reviews only with the grant', async () => {
    routes({}, true);
    open('department-head', 'Assessments', 'DEPARTMENT_HEAD', []);
    await waitFor(() => expect(requested(`${base}/assessments`)).toBe(true));
    expect(requested('/content-reviews')).toBe(false);
    cleanup();
    fetchMock.mockClear();
    open('department-head', 'Assessments', 'DEPARTMENT_HEAD', ['CONTENT_REVIEW_EXTERNAL']);
    await waitFor(() => expect(requested(`${base}/content-reviews`)).toBe(true));
  });

  it('navigation labels and their order are unchanged', () => {
    expect(rolePortals.find((item) => item.key === 'operations-admin')!.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings']);
    expect(rolePortals.find((item) => item.key === 'faculty')!.nav.map((item) => item.label)).toEqual([
      'Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources',
      'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
  });
});
