/**
 * The faculty cohort view (INST-15) on the lecturer's My Students page: real server data only,
 * NA with a plain explanation while students have not been asked for adaptive-learning consent,
 * safe error and forbidden states, actions that open the lecturer's existing screens, and the
 * faculty navigation unchanged (HG-3).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { FacultyLearningCohortSection } from './institutionLearningCohort.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const faculty = { organizationId: institutionId, role: 'FACULTY_LECTURER' } as const;
const asha = { profileId: crypto.randomUUID(), fullName: 'Asha Synthetic', rollNumber: 'SYN-001' };
const ravi = { profileId: crypto.randomUUID(), fullName: 'Ravi Synthetic', rollNumber: 'SYN-002' };
const cohort = {
  mode: 'ASSIGNMENTS', consent: { offered: true }, students: 30,
  studentsSharing: { suppressed: true, count: null },
  stuckSkills: [{ skillId: crypto.randomUUID(), skillName: 'Subnetting', studentCount: 2, students: [asha, ravi] }],
  misconceptions: [{ code: 'SYN_NETWORK_AS_HOST', title: 'Counts the network address as a host', skillName: 'Subnetting', students: 6 }],
  misconceptionsWithheld: true,
};
const due = { mode: 'ASSIGNMENTS', students: [{ ...asha, dueSkills: ['Subnetting', 'Ports'] }], nextCursor: null };
const myStudents = { mode: 'ASSIGNMENTS', assignments: [], nextCursor: null, scope: { kind: 'NONE' }, students: [] };

function route(overrides: { cohort?: unknown; due?: unknown } = {}) {
  fetchMock.mockImplementation((url: string) => {
    const path = String(url);
    if (path.includes('/learning-cohort/due-reviews')) return Promise.resolve(ok(overrides.due ?? due));
    if (path.includes('/learning-cohort')) return Promise.resolve(ok(overrides.cohort ?? cohort));
    return Promise.resolve(ok(myStudents));
  });
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('Learning across your students', () => {
  const section = () => <FacultyLearningCohortSection authenticatedWorkspace={faculty} basePath="/institution/faculty" />;

  it('shows stuck skills, common misconceptions and reviews due from the server, with no dates or model numbers', async () => {
    route();
    render(section());
    const stuck = (await screen.findByText('Subnetting', { selector: 'th' })).closest('tr')!;
    expect(within(stuck).getByText('Asha Synthetic (SYN-001), Ravi Synthetic (SYN-002)')).toBeInTheDocument();
    const trap = screen.getByText('Counts the network address as a host').closest('tr')!;
    expect(within(trap).getByText('6')).toBeInTheDocument();
    expect(screen.getByText(/Other misconceptions are held by fewer than five students/)).toBeInTheDocument();
    const dueRow = screen.getByText('Subnetting, Ports').closest('tr')!;
    expect(within(dueRow).getByText('Asha Synthetic')).toBeInTheDocument();
    // Suppressed count of students sharing their data.
    expect(screen.getByText('<5')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/%|readiness|likelihood|score/i);
    expect(text).not.toContain(asha.profileId);
    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.includes('/institutions/' + institutionId + '/learning-cohort'))).toBe(true);
    expect(paths.some((path) => path.includes('/learning-cohort/due-reviews?limit=50'))).toBe(true);
  });

  it('says plainly that there is nothing to show while students have not been asked for consent', async () => {
    route({ cohort: { ...cohort, consent: { offered: false }, stuckSkills: [], misconceptions: [], misconceptionsWithheld: false }, due: { ...due, students: [] } });
    render(section());
    expect(await screen.findByText('No learning data to show yet')).toBeInTheDocument();
    expect(screen.getAllByText('NA')).toHaveLength(4);
    expect(screen.queryByText('Stuck on the same skill')).not.toBeInTheDocument();
  });

  it('shows honest empty states when nothing applies', async () => {
    route({ cohort: { ...cohort, stuckSkills: [], misconceptions: [], misconceptionsWithheld: false }, due: { ...due, students: [] } });
    render(section());
    expect(await screen.findByText('No student is stuck on a skill right now.')).toBeInTheDocument();
    expect(screen.getByText('No misconception is common among your students right now.')).toBeInTheDocument();
    expect(screen.getByText('No student has a review due right now.')).toBeInTheDocument();
  });

  it('shows a safe forbidden state without upstream text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'private upstream error' }) });
    render(section());
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.queryByText('private upstream error')).not.toBeInTheDocument();
  });

  it('shows a plain error for a response it does not recognise', async () => {
    route({ cohort: { unexpected: true } });
    render(section());
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load learning across your students.');
  });

  it('links each item to its INST-16 action on Learning Resources, prefilled from the row', async () => {
    route();
    render(section());
    const stuck = (await screen.findByText('Subnetting', { selector: 'th' })).closest('tr')!;
    fireEvent.click(within(stuck).getByRole('button', { name: 'Assign practice' }));
    expect(window.location.pathname).toBe('/institution/faculty/learning-resources');
    const assign = new URLSearchParams(window.location.search);
    expect(assign.get('assign')).toBe('PRACTICE');
    expect(assign.get('skill')).toBe(cohort.stuckSkills[0]!.skillId);
    expect(assign.get('students')).toBe(`${asha.profileId},${ravi.profileId}`);
    fireEvent.click(screen.getByRole('button', { name: 'Plan a group session' }));
    expect(window.location.pathname).toBe('/institution/faculty/learning-resources');
    expect(new URLSearchParams(window.location.search).get('q')).toBe('Subnetting');
    const dueRow = screen.getByText('Subnetting, Ports').closest('tr')!;
    fireEvent.click(within(dueRow).getByRole('button', { name: 'Set next step' }));
    expect(new URLSearchParams(window.location.search).get('override')).toBe(asha.profileId);
  });

  it('renders nothing and asks nothing for a role other than faculty', () => {
    render(<FacultyLearningCohortSection authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} basePath="/institution/admin" />);
    expect(screen.queryByText('Learning across your students')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is part of the faculty "My Students" page, with the navigation unchanged', async () => {
    route();
    const portal = rolePortals.find((item) => item.key === 'faculty')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'My Students')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={faculty} />);
    expect(await screen.findByRole('heading', { name: 'My Students' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Learning across your students' })).toBeInTheDocument();
    expect(await screen.findByText('Counts the network address as a host')).toBeInTheDocument();
  });
});
