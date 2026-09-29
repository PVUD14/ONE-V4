/**
 * Cohort readiness by career role and preparation sprints (INST-17) on the admin's Career Readiness, the placement
 * officer's Readiness and the department head's Readiness: real server data only, bands and "<5" (never a score),
 * NA and empty states, starting and ending a sprint, safe errors with a reference, and navigation unchanged (HG-3).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { CohortReadinessByRoleSection } from './institutionCohortReadiness.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const roleId = crypto.randomUUID(); const emptyRoleId = crypto.randomUUID(); const driveId = crypto.randomUUID();
const topicA = crypto.randomUUID(); const topicB = crypto.randomUUID(); const lessonId = crypto.randomUUID(); const deptA = crypto.randomUUID();
const sprintId = crypto.randomUUID();
const roles = {
  roles: [
    { id: roleId, title: 'SOC Analyst', catalogueCode: 'C01', catalogueTitle: 'SOC Analyst L1', releaseLabel: 'SELECTABLE', essentialRequirements: 2, otherRequirements: 1 },
    { id: emptyRoleId, title: 'Game Tester', catalogueCode: null, catalogueTitle: null, releaseLabel: null, essentialRequirements: 0, otherRequirements: 0 },
  ],
  drives: [{ driveId, employerName: 'Synthetic Employer', jobTitle: 'SOC trainee', state: 'APPROVED', careerRoleId: roleId, roleTitle: 'SOC Analyst' }],
};
const cells = (values: Record<string, number | null>) => Object.entries(values).map(([key, count]) => ({ key, count, suppressed: count === null }));
const view = {
  role: { id: roleId, title: 'SOC Analyst', catalogueCode: 'C01', catalogueTitle: 'SOC Analyst L1', releaseLabel: 'SELECTABLE' },
  period: { month: '2026-08', periodStart: '2026-08-01', periodEnd: '2026-08-31' },
  scope: { kind: 'INSTITUTION', units: [] },
  requirementCounts: { essential: 2, other: 1 },
  cohort: { suppressed: false, total: { suppressed: true, count: null } },
  requirements: [
    { topicId: topicA, skillName: 'Log triage', cells: cells({ MET: 7, PARTIAL: 6, MISSING: 5, NOT_ENOUGH_EVIDENCE: null, NO_EVIDENCE: 9 }),
      gaps: { suppressed: false, count: 11 }, unknowns: { suppressed: true, count: null },
      resources: [{ kind: 'PRACTICE', skillId: topicA, lessonVersionId: null, title: 'Log triage' }, { kind: 'LESSON', skillId: topicA, lessonVersionId: lessonId, title: 'Reading an alert' }] },
    { topicId: topicB, skillName: 'Network basics', cells: [], gaps: { suppressed: true, count: null }, unknowns: { suppressed: true, count: null }, resources: [] },
  ],
  canRunSprints: true,
  sprintReasonCodes: ['CAMPUS_DRIVE_PREPARATION', 'ESSENTIAL_GAP', 'PLACEMENT_SEASON'],
  sprintDays: { min: 7, max: 42 },
};
const sprints = {
  sprints: [{
    id: sprintId, role: { id: roleId, title: 'SOC Analyst' }, skillName: 'Log triage', resource: { kind: 'PRACTICE', title: 'Log triage' },
    reasonCode: 'CAMPUS_DRIVE_PREPARATION', note: null, includeUnknown: false, unitName: null, drive: { employerName: 'Synthetic Employer', jobTitle: 'SOC trainee' },
    startsAt: '2026-09-20T09:00:00.000Z', endsAt: '2026-10-04T09:00:00.000Z', cancelledAt: null, state: 'RUNNING', startedByYou: true, canEnd: true,
    progress: { cutoff: '2026-09-30T00:00:00.000Z', available: true, requirementLive: true, reached: { suppressed: false, count: 11 },
      cells: cells({ MET: 5, NEW_EVIDENCE: 6, NO_NEW_EVIDENCE: null }), workDone: { suppressed: true, count: null } },
  }],
  cancelReasonCodes: ['NO_LONGER_NEEDED', 'SET_IN_ERROR', 'REPLACED'],
  canRunSprints: true,
};

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
const refused = (code: string, status = 409) => ({ ok: false, status, headers: new Headers({ 'x-correlation-id': 'corr-17' }), json: async () => ({ error: { code, message: 'upstream private detail', correlationId: 'corr-17' } }) });
let posted: { url: string; body: unknown }[] = [];

function route(overrides: { view?: unknown; sprints?: unknown; post?: (url: string) => unknown; viewError?: unknown } = {}) {
  posted = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(overrides.post ? overrides.post(path) : ok({ sprint: { id: sprintId, endsAt: '2026-10-14T09:00:00.000Z', reached: { suppressed: false, count: 11 } } }, 201));
    }
    if (path.includes('/cohort-readiness/roles')) return Promise.resolve(ok(roles));
    if (path.includes('/cohort-readiness?')) return Promise.resolve(overrides.viewError ?? ok(overrides.view ?? view));
    if (path.includes('/preparation-sprints')) return Promise.resolve(ok(overrides.sprints ?? sprints));
    if (path.includes('/department-overview')) return Promise.resolve(ok({ scope: { kind: 'UNITS', units: [] }, readiness: { month: '2026-08', aggregate: null } }));
    if (path.includes('/units')) return Promise.resolve(ok({ units: [{ id: deptA, institutionId, kind: 'DEPARTMENT', name: 'Department A', parentUnitId: null }] }));
    return Promise.resolve(ok({}));
  });
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

async function chooseRole(value: string) {
  const select = await screen.findByRole('combobox', { name: 'Career role' });
  await within(select).findByText('Synthetic Employer — SOC trainee (SOC Analyst)');
  fireEvent.change(select, { target: { value } });
}

describe('Cohort readiness by career role', () => {
  it('shows bands, gaps and unknowns per essential requirement from the server, with <5 and NA, and no score', async () => {
    route();
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    expect(await screen.findByText('Choose a role')).toBeInTheDocument();
    await chooseRole(`role:${roleId}`);
    const table = await screen.findByRole('table', { name: 'Essential requirements' });
    const rowA = within(table).getByText('Log triage').closest('tr')!;
    expect(Array.from(rowA.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['7', '6', '5', '<5', '9', '11', '<5', 'Run a sprint']);
    const rowB = within(table).getByText('Network basics').closest('tr')!;
    expect(within(rowB).getAllByText('<5')).toHaveLength(7);
    expect(within(rowB).getByText('No published content')).toBeInTheDocument();
    expect(screen.getByText(/As at the end of 2026-08\. 1 further requirement is not essential/)).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bscore\b|%|\/100|\d\.\d/i);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`careerRoleId=${roleId}`))).toBe(true);
  });

  it('says NA plainly for a role with no essential requirements, and shows a safe error with a reference', async () => {
    route({ view: { ...view, role: { ...view.role, id: emptyRoleId, title: 'Game Tester' }, requirements: [], requirementCounts: { essential: 0, other: 0 } } });
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    await chooseRole(`role:${emptyRoleId}`);
    expect(await screen.findByText('No essential requirements published')).toBeInTheDocument();
    expect(screen.getByText(/nothing to measure: NA/)).toBeInTheDocument();
    cleanup();
    route({ viewError: refused('REPORT_PERIOD_INVALID', 400) });
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    await chooseRole(`role:${roleId}`);
    const alert = await screen.findByText(/Choose a whole calendar month that has ended\. Reference: corr-17/);
    expect(alert).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('upstream private detail');
  });

  it('starts a sprint from a campus drive\'s role: the requirement, the content, the time box and the drive', async () => {
    route();
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    await chooseRole(`drive:${driveId}`);
    expect(await screen.findByText(/Campus drive: Synthetic Employer — SOC trainee/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Run a sprint' }));
    const form = await screen.findByRole('form', { name: 'Run a preparation sprint' });
    fireEvent.change(within(form).getByLabelText('What to practise'), { target: { value: '1' } });
    fireEvent.change(within(form).getByLabelText('Who'), { target: { value: deptA } });
    fireEvent.click(within(form).getByLabelText(/Also include students with no evidence/));
    fireEvent.change(within(form).getByLabelText(/Note to the students/), { target: { value: 'Before the drive' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start the sprint' }));
    expect(await screen.findByText(/Sprint started for 11 students until/)).toBeInTheDocument();
    expect(posted).toEqual([{ url: expect.stringContaining(`/institutions/${institutionId}/preparation-sprints`), body: {
      careerRoleId: roleId, topicId: topicA, resource: { kind: 'LESSON', skillId: topicA, lessonVersionId: lessonId }, durationDays: 14,
      includeUnknown: true, reasonCode: 'CAMPUS_DRIVE_PREPARATION', note: 'Before the drive', unitId: deptA, campusDriveId: driveId,
    } }]);
  });

  it('explains a refused sprint in plain words', async () => {
    route({ post: () => refused('NO_STUDENTS_WITH_GAPS') });
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    await chooseRole(`role:${roleId}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a sprint' }));
    const form = await screen.findByRole('form', { name: 'Run a preparation sprint' });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'ESSENTIAL_GAP' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start the sprint' }));
    expect(await screen.findByText(/No current student in your scope has a gap in this requirement.*Reference: corr-17/)).toBeInTheDocument();
  });

  it('lists sprints with progress as counts, and ends one early with a reason', async () => {
    route();
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    const table = await screen.findByRole('table', { name: 'Preparation sprints' });
    const row = within(table).getByText('SOC Analyst · Log triage').closest('tr')!;
    expect(Array.from(row.querySelectorAll('td')).slice(1, 6).map((cell) => cell.textContent)).toEqual(['11', '5', '6', '<5', '<5']);
    expect(row).toHaveTextContent('Running');
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'REPLACED' } });
    expect(await screen.findByText(/Sprint ended\./)).toBeInTheDocument();
    expect(posted).toEqual([{ url: expect.stringContaining(`/preparation-sprints/${sprintId}/cancel`), body: { reasonCode: 'REPLACED' } }]);
  });

  it('shows NA for a sprint on its first day and an empty state with no sprints', async () => {
    route({ sprints: { ...sprints, sprints: [{ ...sprints.sprints[0], progress: { cutoff: null, available: false, requirementLive: true, reached: { suppressed: true, count: null }, cells: [], workDone: { suppressed: true, count: null } } }] } });
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    const row = (await screen.findByText('SOC Analyst · Log triage')).closest('tr')!;
    expect(within(row).getAllByText('NA')).toHaveLength(5);
    expect(screen.getByText(/first figures appear the day after it starts/)).toBeInTheDocument();
    cleanup();
    route({ sprints: { ...sprints, sprints: [] } });
    render(<CohortReadinessByRoleSection institutionId={institutionId} />);
    expect(await screen.findByText('No sprints yet')).toBeInTheDocument();
  });
});

describe('INST-17 screens on existing navigation (HG-3)', () => {
  function open(key: 'institution-admin' | 'placement-officer' | 'department-head', label: string, role: string): void {
    const portal = rolePortals.find((item) => item.key === key)!;
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role }} />);
  }

  it('the admin\'s Career Readiness, the placement officer\'s Readiness and the head\'s Readiness show it', async () => {
    route();
    open('institution-admin', 'Career Readiness', 'INSTITUTION_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Cohort readiness by career role' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('read-only in Phase 2A');
    cleanup();
    open('placement-officer', 'Readiness', 'PLACEMENT_ADMIN');
    expect(await screen.findByRole('heading', { name: 'Cohort readiness by career role' })).toBeInTheDocument();
    cleanup();
    open('department-head', 'Readiness', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('heading', { name: 'Cohort readiness by career role' })).toBeInTheDocument();
  });

  it('navigation labels are unchanged', () => {
    const labels = (key: string) => rolePortals.find((item) => item.key === key)!.nav.map((item) => item.label);
    expect(labels('institution-admin')).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(labels('placement-officer')).toEqual(['Dashboard', 'Assessments', 'Help & FAQ', 'Students', 'Student Search', 'Readiness', 'Departments', 'Batches']);
    expect(labels('department-head')).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff',
      'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
  });
});
