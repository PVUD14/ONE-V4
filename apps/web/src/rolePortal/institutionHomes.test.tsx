/**
 * The four institution homes in the Momentum re-skin (phase 6), rendered through the real route
 * dispatcher with the API stubbed at fetch. Pins the owner's rules for these screens:
 *   - no "NA" anywhere, with full data or with every read refused (a block without data is left out);
 *   - a count of people under five is "<5" and a suppressed band is the fixed hatched block — never
 *     a proportional step, bar or height;
 *   - no visible total lets a small group be worked out by subtraction (parts become ranges);
 *   - readiness is an aggregate band distribution only: the lecturer sees their own students by name
 *     but no institution home draws one student's band, because no read returns it.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals, type RolePortalKey } from '../rolePortalConfig.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const base = `/api/v1/institutions/${institutionId}`;
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const refused = { ok: false, status: 403, headers: { get: () => 'corr-403' }, json: async () => ({ error: { code: 'FORBIDDEN', message: 'upstream private detail' } }) };

const shown = (value: number) => ({ suppressed: false, value });
const withheld = { suppressed: true, value: null };
const band = (code: string, count: number | null) => ({ band: code, count, suppressed: count === null });
const later = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

const overview = {
  scope: { kind: 'UNITS', units: [{ id: 'd1', kind: 'DEPARTMENT', name: 'Computer Science' }] }, unit: null,
  students: { onRoster: 12, current: 10 },
  activation: { ACTIVATED: 9, INVITED: 2, EXPIRED: 0, BOUNCED: 0, NOT_INVITED: 1 },
  assessments: { inProgress: 1, assignedStudents: 8, completedStudents: 6 },
  readiness: { month: '2026-09', aggregate: { suppressed: false, minimumCohortSize: 5, cohortSize: null, cohortSizeSuppressed: true,
    bands: [band('NOT_ENOUGH_EVIDENCE', null), band('DEVELOPING', 6), band('PROGRESSING', null), band('READY_FOR_NEXT_STEP', null)] } },
  staffActions: { openInterventions: 1, openTasks: 3 },
  batches: [{ id: 'b1', name: 'CSE 2026', parentName: 'B.Tech CSE', students: 9, current: 8, activated: 7 },
    { id: 'b2', name: 'CSE 2027', parentName: 'B.Tech CSE', students: 3, current: 2, activated: 2 }],
};
const students = Array.from({ length: 12 }, (_, index) => ({
  id: `p${index}`, studentUserId: `u${index}`, institutionId, institutionStudentId: `CSE-${index}`, fullName: `Roster Student ${index}`, email: `s${index}@example.test`,
  status: index < 10 ? 'ACTIVE' : 'INVITED', units: {}, activation: null,
}));
const myStudents = { mode: 'ASSIGNMENTS', assignments: [], nextCursor: null, students: [
  { profileId: 'm1', studentUserId: 'u1', fullName: 'Asha Taught', institutionStudentId: 'CSE-101', units: { section: 'A', batch: 'CSE 2026' }, activation: null, openTasks: 1,
    recentAssessments: { submitted: 1, latestTitle: 'SQL joins practice set', latestSubmittedAt: later(-2) } },
  { profileId: 'm2', studentUserId: 'u2', fullName: 'Ravi Taught', institutionStudentId: 'CSE-102', units: { section: 'A', batch: 'CSE 2026' }, activation: null, openTasks: 0,
    recentAssessments: { submitted: 0, latestTitle: null, latestSubmittedAt: null } }] };
const statsRow = { eligible: shown(9), notShared: withheld, applied: withheld, shortlisted: withheld, withOffer: withheld, placed: withheld, placementPercentage: null, offersPerPlacedStudent: null };
const tableOf = (keys: readonly string[]) => ({ suppressed: false, total: withheld, cells: keys.map((key, index) => ({ key, count: index === 0 ? 7 : null, suppressed: index !== 0 })) });

const full: Readonly<Record<string, unknown>> = {
  [`${base}/students`]: { students, activationSummary: overview.activation },
  [`${base}/units`]: { units: [{ id: 'd1', kind: 'DEPARTMENT', name: 'Computer Science', parentUnitId: null }, { id: 'b1', kind: 'BATCH', name: 'CSE 2026', parentUnitId: 'd1' }] },
  [`${base}/staff-role-assignments`]: { staff: { memberships: [{ id: 's1', userId: 'x', email: 'officer@example.test', role: 'PLACEMENT_ADMIN', state: 'ACTIVE', createdAt: later(-9), updatedAt: later(-9) }], invitations: [], unavailableActions: [] } },
  [`${base}/academic-verification-summary`]: { summary: { pending: 0, notCurrent: 0 } },
  [`${base}/assessments`]: { assessments: [] },
  [`${base}/placement-statistics`]: { asOf: { month: '2026-09', lastDay: '2026-09-30' }, overall: statsRow, groups: [], offersByMonth: [{ month: '2026-09', offers: withheld }] },
  [`${base}/placement-register`]: { employers: [{ name: 'Synthetic Employer', drives: { approved: 1, scheduled: 0, completed: 0 }, jobsAddressedToCollege: 2, lastEngagedAt: later(-5) }], drives: [] },
  [`${base}/campus-drives`]: { drives: [], canDecide: true, nextCursor: null },
  [`${base}/department-overview`]: overview,
  [`${base}/placement-pipeline`]: { scope: overview.scope, unit: null, studentsSharing: shown(7),
    stages: tableOf(['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN']),
    offers: { suppressed: true, total: withheld, cells: [] }, placementStatus: tableOf(['NOT_SHARED', 'APPLIED', 'IN_PROCESS', 'OFFER', 'ACCEPTED']) },
  [`${base}/department-staff`]: { scope: overview.scope, staff: [{ email: 'lecturer@example.test', role: 'FACULTY_LECTURER', department: 'Computer Science', batch: null, assignments: [] }] },
  [`${base}/placement-applications`]: { applications: [], nextCursor: null },
  [`${base}/my-students`]: myStudents,
  [`${base}/staff-actions`]: { actions: [{ id: 'a1', title: 'Finish the SQL lesson', studentName: 'Asha Taught', state: 'OPEN', dueAt: later(3), updatedAt: later(-1), actionType: 'ASSIGNED_TASK' }], students: [], assignees: [] },
  '/api/v1/me/calendar': { entries: [{ id: 'c1', kind: 'MEETING', title: 'Department meeting', detail: null, startsAt: later(1), endsAt: null, location: null, joinUrl: null, audience: 'STAFF' }], range: { from: later(-1), to: later(30) } },
};

function routes(table: Readonly<Record<string, unknown>>, fallback: 'empty' | 'refuse' = 'empty'): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    if (path in table) return table[path] === 'REFUSE' ? refused : ok(table[path]);
    return fallback === 'refuse' ? refused : ok({});
  });
}

const homes: readonly (readonly [RolePortalKey, string, string])[] = [
  ['institution-admin', 'INSTITUTION_ADMIN', 'Institution Administration'],
  ['placement-officer', 'PLACEMENT_ADMIN', 'Placement Dashboard'],
  ['faculty', 'FACULTY_LECTURER', 'Faculty Dashboard'],
  ['department-head', 'DEPARTMENT_HEAD', 'Department Dashboard'],
];

async function openHome(key: RolePortalKey, role: string, title: string): Promise<void> {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.basePath);
  render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
  expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('.ih [role="status"]')).toBeNull());
}

/** The home's own content (the placement officer's page also carries its approval sections below). */
const home = (): HTMLElement => document.querySelector('.ih') as HTMLElement;

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('no "NA" on the four institution homes', () => {
  it.each(homes)('%s: none with full data', async (key, role, title) => {
    routes(full);
    await openHome(key, role, title);
    expect(home().querySelector('.ih-kpi')).not.toBeNull();
    expect(home().textContent).not.toMatch(/\bNA\b/);
    expect(home().textContent).not.toMatch(/not available to your role|not published yet/i);
  });

  it.each(homes)('%s: none, and no made-up zero, when every read is refused', async (key, role, title) => {
    routes({}, 'refuse');
    await openHome(key, role, title);
    expect(home().textContent).not.toMatch(/\bNA\b/);
    // Nothing could be read, so no figure is drawn at all rather than a 0 in its place.
    expect(home().querySelector('.ih-kpi, .ih-card')).toBeNull();
    expect(document.body.textContent).not.toContain('upstream private detail');
  });
});

describe('small counts on the homes', () => {
  it('draws suppressed bands as the fixed hatched block with no mix bar, and no activation bar beside a small group', async () => {
    routes(full);
    await openHome('institution-admin', 'INSTITUTION_ADMIN', 'Institution Administration');
    const cohort = screen.getByRole('heading', { name: 'Cohort readiness' }).closest('section')!;
    const steps = within(cohort).getByRole('list', { name: /Readiness bands/ });
    expect(steps.querySelectorAll('.sc-hatch--step')).toHaveLength(3);
    expect(steps.querySelectorAll('.bclimb-bar')).toHaveLength(1);
    expect(cohort.querySelector('.bclimb-stack')).toBeNull();
    expect(within(steps).getAllByText('<5')).toHaveLength(3);
    const activation = screen.getByRole('heading', { name: 'Student activation' }).closest('section')!;
    expect(activation.querySelector('.ih-abar')).toBeNull();
  });

  it('never shows a total that would let a small group be worked out', async () => {
    routes(full);
    await openHome('department-head', 'DEPARTMENT_HEAD', 'Department Dashboard');
    // 12 on the roster, 10 enrolled: an exact 10 would reveal the 2 who are not.
    expect(screen.getByText('Enrolled now').parentElement).toHaveTextContent('10–14Enrolled now');
    // The server withheld the cohort total beside suppressed bands, so none is shown.
    expect(screen.queryByText(/students with a band/)).not.toBeInTheDocument();
    cleanup();
    routes(full);
    await openHome('institution-admin', 'INSTITUTION_ADMIN', 'Institution Administration');
    const batches = screen.getByRole('heading', { name: 'Cohort by batch' }).closest('section')!;
    // CSE 2027 has 3 students; beside the roster total of 12, CSE 2026's exact 9 would reveal it.
    const first = within(batches).getByRole('row', { name: /CSE 2026/ });
    expect(within(first).getAllByRole('cell').slice(1).map((cell) => cell.textContent)).toEqual(['5–9', '5–9', '5–9']);
    expect(within(within(batches).getByRole('row', { name: /CSE 2027/ })).getAllByRole('cell').slice(1).map((cell) => cell.textContent)).toEqual(['<5', '<5', '<5']);
  });
});

describe('readiness is an aggregate, never one student\'s band', () => {
  it('the lecturer sees their own students by name, with no per-student band drawn (no read returns one)', async () => {
    routes(full);
    await openHome('faculty', 'FACULTY_LECTURER', 'Faculty Dashboard');
    const table = screen.getByRole('table', { name: 'My students' });
    expect(within(table).getByText('Asha Taught')).toBeInTheDocument();
    expect(within(table).getByText('Ravi Taught')).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /band/i })).not.toBeInTheDocument();
    expect(home().querySelector('.mband, [data-band]')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/department-overview'))).toBe(false);
  });

  it.each(homes.filter(([key]) => key !== 'faculty'))('%s shows the band distribution only, with no student named in it', async (key, role, title) => {
    routes(full);
    await openHome(key, role, title);
    expect(home().querySelectorAll('.bclimb-s[data-band]')).toHaveLength(4);
    expect(home().querySelector('.mband')).toBeNull();
    const cohort = home().querySelector('.ih-cohort-card') as HTMLElement;
    expect(cohort.textContent).not.toMatch(/Roster Student|Asha|Ravi/);
    // No percentage and no average: the privacy line's "never a score" is the only mention of a score.
    expect(cohort.textContent).not.toMatch(/\d\s*%|average/i);
    expect(cohort.textContent?.match(/score/gi) ?? []).toHaveLength(1);
  });
});
