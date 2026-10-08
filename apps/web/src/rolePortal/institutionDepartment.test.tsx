/**
 * Department head and faculty workspaces (INST-07): the department head's remaining items
 * and the lecturer's Assessment Detail and Reports render the server's scoped, suppressed
 * numbers — NA where there is no source, <5 for a small group, bands never scores, offers
 * never pay — and the navigation labels stay exactly as they were.
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
    if (body === 'FORBIDDEN') return { ok: false, status: 403, headers: { get: () => 'corr-403' }, json: async () => ({ error: { code: 'FORBIDDEN', message: 'upstream private detail' } }) };
    return ok(body ?? {});
  });
}

function open(key: 'department-head' | 'faculty', label: string, role: string): void {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
  render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
}

const scope = { kind: 'UNITS', units: [{ id: crypto.randomUUID(), kind: 'DEPARTMENT', name: 'Computer Science' }] };
const overview = {
  scope, unit: null,
  students: { onRoster: 42, current: 40 },
  activation: { ACTIVATED: 31, INVITED: 6, EXPIRED: 2, BOUNCED: 1, NOT_INVITED: 2 },
  assessments: { inProgress: 3, assignedStudents: 27, completedStudents: 19 },
  readiness: { month: '2026-08', aggregate: { suppressed: false, minimumCohortSize: 5, cohortSize: null, cohortSizeSuppressed: true, bands: [
    { band: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true }, { band: 'DEVELOPING', count: 14, suppressed: false },
    { band: 'PROGRESSING', count: 9, suppressed: false }, { band: 'READY_FOR_NEXT_STEP', count: null, suppressed: true }] } },
  staffActions: { openInterventions: 4, openTasks: 11 },
  batches: [{ id: crypto.randomUUID(), name: 'CSE 2027', parentName: 'B.Tech CSE', students: 42, current: 40, activated: 31 }],
};
const pipeline = {
  scope, unit: null,
  studentsSharing: { suppressed: false, value: 12 },
  stages: { suppressed: false, total: { suppressed: true, value: null }, cells: [
    { key: 'APPLIED', count: 8, suppressed: false }, { key: 'SCREENING', count: null, suppressed: true }, { key: 'SHORTLISTED', count: 6, suppressed: false },
    { key: 'ASSESSMENT', count: null, suppressed: true }, { key: 'INTERVIEW', count: null, suppressed: true }, { key: 'OFFER', count: null, suppressed: true },
    { key: 'HIRED', count: null, suppressed: true }, { key: 'REJECTED', count: null, suppressed: true }, { key: 'WITHDRAWN', count: null, suppressed: true }] },
  offers: { suppressed: true, total: { suppressed: true, value: null }, cells: [] },
};
const application = {
  id: crypto.randomUUID(), student: { fullName: 'Asha Local', institutionStudentId: 'CSE-001' }, employer: { name: 'Local Employer' },
  opportunityTitle: 'Graduate engineer', state: 'OFFER', submittedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
  offer: { exists: true, responseState: 'ACCEPTED' },
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('department head workspace', () => {
  it('Department Overview shows the server\'s scoped counts, readiness as bands with <5, and the pipeline', async () => {
    routes({ [`${base}/department-overview`]: overview, [`${base}/placement-pipeline`]: pipeline, [`${base}/academic-verification-summary`]: { summary: { pending: 5, notCurrent: 0 } } });
    open('department-head', 'Department Overview', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('heading', { name: 'Department Overview' })).toBeInTheDocument();
    expect(await screen.findByText('Students on roster')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Showing students in Computer Science.')).toBeInTheDocument();
    const readiness = screen.getByRole('heading', { name: 'Cohort Readiness' }).closest('section')!;
    expect(within(readiness).getByText('14')).toBeInTheDocument();
    expect(within(readiness).getAllByText('<5')).toHaveLength(2);
    expect(within(readiness).getByText('withheld')).toBeInTheDocument();
    expect(within(readiness).queryByText(/%/)).not.toBeInTheDocument();
    const funnel = screen.getByRole('heading', { name: 'Placement Pipeline' }).closest('section')!;
    expect(within(funnel).getByText('8')).toBeInTheDocument();
    expect(screen.getByText('CSE 2027')).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });

  it('says readiness is withheld when the department is too small, and reads NA without a pipeline', async () => {
    routes({
      [`${base}/department-overview`]: { ...overview, readiness: { month: '2026-08', aggregate: { suppressed: true, minimumCohortSize: 5, cohortSize: 0, cohortSizeSuppressed: true, bands: [] } } },
      [`${base}/placement-pipeline`]: 'FORBIDDEN',
    });
    open('department-head', 'Department Overview', 'DEPARTMENT_HEAD');
    expect(await screen.findByText(/Withheld for 2026-08/)).toBeInTheDocument();
    const funnel = screen.getByRole('heading', { name: 'Placement Pipeline' }).closest('section')!;
    await waitFor(() => expect(within(funnel).getAllByText('NA').length).toBeGreaterThan(0));
  });

  it('shows a safe error, never upstream text, when the overview is refused', async () => {
    routes({ [`${base}/department-overview`]: 'FORBIDDEN' });
    open('department-head', 'Department Overview', 'DEPARTMENT_HEAD');
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to view this. Support code: corr403');
    expect(screen.queryByText(/upstream private detail/)).not.toBeInTheDocument();
  });

  it('Placement Pipeline shows stages and offers through suppression and says pay is never shown', async () => {
    routes({ [`${base}/placement-pipeline`]: pipeline });
    open('department-head', 'Placement Pipeline', 'DEPARTMENT_HEAD');
    const stages = (await screen.findByRole('heading', { name: 'Applications by stage' })).closest('section')!;
    expect(within(stages).getByText('Shortlisted')).toBeInTheDocument();
    expect(within(stages).getByText('6')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/Offer pay and terms are never shown/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/salary|compensation|CTC|₹/i);
  });

  it('Opportunities and Offers lists shared applications with the offer response, never pay', async () => {
    routes({ [`${base}/placement-applications`]: { applications: [application, { ...application, id: crypto.randomUUID(), student: { fullName: 'Ravi Local', institutionStudentId: 'CSE-002' }, state: 'APPLIED', offer: { exists: false, responseState: null } }], nextCursor: null } });
    open('department-head', 'Opportunities and Offers', 'DEPARTMENT_HEAD');
    const row = (await screen.findByText('Asha Local')).closest('tr')!;
    expect(within(row).getByText('Offer accepted')).toBeInTheDocument();
    expect(within(screen.getByText('Ravi Local').closest('tr')!).getByText('No offer')).toBeInTheDocument();
    expect(screen.queryByText(application.id)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/salary|compensation|CTC|₹/i);
  });

  it('Opportunities and Offers says plainly when nothing is shared', async () => {
    routes({ [`${base}/placement-applications`]: { applications: [], nextCursor: null } });
    open('department-head', 'Opportunities and Offers', 'DEPARTMENT_HEAD');
    expect(await screen.findByText('No shared applications')).toBeInTheDocument();
  });

  it('Batches lists the department batches with their counts', async () => {
    routes({ [`${base}/department-overview`]: overview });
    open('department-head', 'Batches', 'DEPARTMENT_HEAD');
    const row = (await screen.findByText('CSE 2027')).closest('tr')!;
    expect(within(row).getByText('B.Tech CSE')).toBeInTheDocument();
    expect(within(row).getByText('31')).toBeInTheDocument();
  });

  it('Readiness shows last month\'s bands and the month-by-month report', async () => {
    routes({ [`${base}/department-overview`]: overview });
    open('department-head', 'Readiness', 'DEPARTMENT_HEAD');
    expect(await screen.findByText('Developing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate report' })).toBeInTheDocument();
  });

  it('Reports and Analytics shows department summaries and the exports panel', async () => {
    routes({ [`${base}/department-overview`]: overview, [`${base}/placement-pipeline`]: pipeline });
    open('department-head', 'Reports and Analytics', 'DEPARTMENT_HEAD');
    const summary = (await screen.findByRole('heading', { name: 'Department summary' })).closest('section')!;
    await waitFor(() => expect(within(summary).getByText('11')).toBeInTheDocument());
    // INST-08 built the exports; the panel replaces the earlier NA note.
    expect(screen.getByRole('heading', { name: 'Exports' })).toBeInTheDocument();
    expect(screen.queryByText(/NA — downloadable exports/)).not.toBeInTheDocument();
    const stages = screen.getByRole('heading', { name: 'Shared applications by stage' }).closest('section')!;
    await waitFor(() => expect(within(stages).getByText('withheld')).toBeInTheDocument());
  });

  it('Students shows the department roster above the verification queue', async () => {
    routes({ [`${base}/students`]: { students: [{ id: crypto.randomUUID(), studentUserId: crypto.randomUUID(), fullName: 'Asha Local', institutionStudentId: 'CSE-001', email: 'asha@example.test', status: 'ACTIVE', units: {}, relationship: { state: 'ACTIVE' } }], scope }, [`${base}/units`]: { units: [] }, [`${base}/academic-verification-queue`]: { queue: [] } });
    open('department-head', 'Students', 'DEPARTMENT_HEAD');
    expect(await screen.findByText('Asha Local')).toBeInTheDocument();
    expect(screen.getByText('Your department')).toBeInTheDocument();
    expect(screen.queryByText(/roster is not built yet/)).not.toBeInTheDocument();
  });

  it('Faculty and Staff lists the department staff and who teaches where', async () => {
    routes({
      [`${base}/department-staff`]: { scope, staff: [{ email: 'lecturer@example.test', role: 'FACULTY_LECTURER', department: null, batch: null, assignments: [{ unitName: 'CSE 3A', subject: 'Data Structures', academicTerm: '2026-27 Odd' }] }] },
      [`${base}/teaching-assignments`]: { assignments: [], nextCursor: null, canAssign: false, faculty: [], units: [], subjects: [] },
    });
    open('department-head', 'Faculty and Staff', 'DEPARTMENT_HEAD');
    const row = (await screen.findByText('lecturer@example.test', { selector: 'th' })).closest('tr')!;
    expect(within(row).getByText('Faculty')).toBeInTheDocument();
    expect(within(row).getByText('Data Structures · CSE 3A · 2026-27 Odd')).toBeInTheDocument();
  });

  it('leaves no department head item on the view-only empty state, with the navigation unchanged', async () => {
    const portal = rolePortals.find((item) => item.key === 'department-head')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions',
      'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
    const emptyOverview = { ...overview, students: { onRoster: 0, current: 0 }, batches: [], readiness: { month: '2026-08', aggregate: { suppressed: true, minimumCohortSize: 5, cohortSize: 0, cohortSizeSuppressed: true, bands: [] } } };
    routes({ [`${base}/department-overview`]: emptyOverview, [`${base}/placement-pipeline`]: pipeline, [`${base}/placement-applications`]: { applications: [], nextCursor: null } });
    for (const label of ['Department Overview', 'Readiness', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Reports and Analytics']) {
      open('department-head', label, 'DEPARTMENT_HEAD');
      expect(await screen.findByRole('heading', { name: label, level: 1 })).toBeInTheDocument();
      expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe('faculty workspace', () => {
  const exams = { assessments: [
    { id: crypto.randomUUID(), title: 'Unit test 1', assessmentKind: 'UNIT_TEST', lifecycleState: 'PUBLISHED', subjectName: 'Data Structures', totalMarks: 10, durationSeconds: 600, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-30T00:00:00Z', attemptsAllowed: 1, assignedCount: 4, completedAttempts: 3 },
    { id: crypto.randomUUID(), title: 'Draft quiz', assessmentKind: 'UNIT_TEST', lifecycleState: 'DRAFT', subjectName: 'Data Structures', totalMarks: 10, durationSeconds: 600, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-30T00:00:00Z', attemptsAllowed: 1, assignedCount: 0, completedAttempts: 0 },
  ] };
  const results = {
    results: [{ studentName: 'Asha Local', institutionStudentId: 'CSE-001', attemptNumber: 1, status: 'SUBMITTED', score: 8, maxScore: 10, percentage: 80, timeTakenSeconds: 420 }],
    notAttempted: [{ studentName: 'Ravi Local', institutionStudentId: 'CSE-002', inProgress: false }],
    summary: { attempts: 1, averagePercentage: 80, assigned: 2, notAttemptedCount: 1 },
  };

  it('Assessment Detail shows one assessment\'s results for the lecturer\'s students, withholding a small-class average', async () => {
    routes({ [`${base}/assessments`]: exams, [`${base}/assessments/${exams.assessments[0]!.id}/results`]: results });
    open('faculty', 'Assessment Detail', 'FACULTY_LECTURER');
    const row = (await screen.findByText('Asha Local')).closest('tr')!;
    expect(within(row).getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('<5 results')).toBeInTheDocument();
    expect(screen.getByText('Ravi Local')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Draft quiz/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assessment'), { target: { value: exams.assessments[0]!.id } });
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });

  it('Reports summarises each class the lecturer teaches', async () => {
    routes({ [`${base}/class-reports`]: { mode: 'ASSIGNMENTS', classes: [{ unit: { id: crypto.randomUUID(), kind: 'SECTION', name: 'CSE 3A' }, subjects: ['Data Structures'], students: 38, activated: 30, openTasks: 7,
      assessments: [{ id: crypto.randomUUID(), title: 'Unit test 1', lifecycleState: 'PUBLISHED', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-30T00:00:00Z', assigned: 38, completed: 35, averagePercentage: 71.5, averageSuppressed: false },
        { id: crypto.randomUUID(), title: 'Quiz 2', lifecycleState: 'PUBLISHED', startsAt: '2026-09-10T00:00:00Z', endsAt: '2026-09-20T00:00:00Z', assigned: 38, completed: 3, averagePercentage: null, averageSuppressed: true }] }] } });
    open('faculty', 'Reports', 'FACULTY_LECTURER');
    const section = await screen.findByRole('region', { name: 'CSE 3A' });
    expect(within(section).getAllByText('38')).toHaveLength(3);
    expect(within(section).getByText('71.5%')).toBeInTheDocument();
    expect(within(section).getByText('<5 results')).toBeInTheDocument();
  });

  it('Reports says plainly when the lecturer has no class', async () => {
    routes({ [`${base}/class-reports`]: { mode: 'ASSIGNMENTS', classes: [] } });
    open('faculty', 'Reports', 'FACULTY_LECTURER');
    expect(await screen.findByText('No classes to report on')).toBeInTheDocument();
  });

  it('leaves no faculty item on the view-only state (INST-16 made Learning Resources real), with the navigation unchanged', async () => {
    const portal = rolePortals.find((item) => item.key === 'faculty')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    routes({ [`${base}/assessments`]: { assessments: [] }, [`${base}/class-reports`]: { mode: 'ASSIGNMENTS', classes: [] } });
    for (const label of ['Assessment Detail', 'Reports']) {
      open('faculty', label, 'FACULTY_LECTURER');
      expect(await screen.findByRole('heading', { name: label, level: 1 })).toBeInTheDocument();
      expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
      cleanup();
    }
    open('faculty', 'Learning Resources', 'FACULTY_LECTURER');
    expect(await screen.findByRole('heading', { name: 'Assign and plan learning' })).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });
});
