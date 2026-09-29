/**
 * Faculty learning actions (INST-16) on the lecturer's Learning Resources page: real server data only
 * (published content, the lecturer's own actions), assigning to a class or to students picked from the cohort
 * view, a group session, a next-step override with a listed reason, a student's plan shown only with their
 * consent, "<5" for small counts, safe errors with a reference, and the faculty navigation unchanged (HG-3).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { FacultyLearningActionsPage } from './institutionLearningActions.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const faculty = { organizationId: institutionId, role: 'FACULTY_LECTURER' } as const;
const skillA = crypto.randomUUID(); const skillB = crypto.randomUUID(); const lessonId = crypto.randomUUID();
const sectionX = crypto.randomUUID();
const asha = { profileId: crypto.randomUUID(), studentUserId: crypto.randomUUID(), fullName: 'Asha Synthetic', institutionStudentId: 'SYN-001', units: { section: 'Section X', batch: null }, activation: null, openTasks: 0, recentAssessments: { submitted: 0, latestTitle: null, latestSubmittedAt: null } };
const ravi = { ...asha, profileId: crypto.randomUUID(), studentUserId: crypto.randomUUID(), fullName: 'Ravi Synthetic', institutionStudentId: 'SYN-002' };
const resources = {
  resources: [
    { kind: 'LESSON', skillId: skillA, lessonVersionId: lessonId, title: 'Subnetting by hand', skillName: 'Subnetting', moduleTitle: 'Networks', questionCount: null },
    { kind: 'PRACTICE', skillId: skillB, lessonVersionId: null, title: 'Ports', skillName: 'Ports', moduleTitle: null, questionCount: 4 },
    { kind: 'PRACTICE', skillId: skillA, lessonVersionId: null, title: 'Subnetting', skillName: 'Subnetting', moduleTitle: null, questionCount: 12 },
  ],
  nextCursor: null,
};
const actions = {
  mode: 'ASSIGNMENTS', canAct: true,
  targets: [{ unitId: sectionX, kind: 'SECTION', name: 'Section X' }],
  assignments: [{
    id: crypto.randomUUID(), resource: { kind: 'PRACTICE', skillId: skillA, lessonVersionId: null, title: 'Subnetting', skillName: 'Subnetting' },
    target: { kind: 'UNIT', unitName: 'Section X' }, note: null, assignedAt: '2026-09-28T09:00:00.000Z', withdrawn: false, students: 30, done: { suppressed: true, count: null },
  }],
  sessions: [{ id: crypto.randomUUID(), title: 'Subnetting clinic', scheduledStartAt: '2026-10-02T09:00:00.000Z', scheduledEndAt: '2026-10-02T10:00:00.000Z', state: 'DRAFT', attendees: 12, content: [{ kind: 'PRACTICE', title: 'Subnetting', skillName: 'Subnetting' }] }],
  overrides: [{ id: crypto.randomUUID(), student: { profileId: asha.profileId, fullName: 'Asha Synthetic', rollNumber: 'SYN-001' }, action: 'PRACTICE',
    resource: { kind: 'PRACTICE', skillId: skillB, lessonVersionId: null, title: 'Ports', skillName: 'Ports' }, reasonCode: 'CLASS_TOPIC_ALIGNMENT', state: 'PENDING', createdAt: '2026-09-28T10:00:00.000Z' }],
  overrideActions: ['LEARN', 'PRACTICE', 'REVIEW'],
  overrideReasonCodes: ['CLASS_TOPIC_ALIGNMENT', 'PREREQUISITE_FIRST', 'REVISIT_FUNDAMENTALS', 'UPCOMING_ASSESSMENT', 'STUDENT_REQUEST', 'FACULTY_JUDGEMENT'],
  withdrawReasonCodes: ['NO_LONGER_NEEDED', 'SET_IN_ERROR', 'REPLACED'],
};
const myStudents = { mode: 'ASSIGNMENTS', assignments: [], nextCursor: null, students: [asha, ravi] };
const planNoConsent = { student: { profileId: ravi.profileId, fullName: 'Ravi Synthetic', rollNumber: 'SYN-002' }, consent: { offered: true, held: false }, latestStep: null, pendingOverride: null };
const planShared = { ...planNoConsent, consent: { offered: true, held: true }, latestStep: { action: 'PRACTICE', skillName: 'Ports', reasonCodes: ['GAP_PARTIAL'] } };

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
let posted: { url: string; body: unknown }[] = [];

function route(overrides: { plan?: unknown; actions?: unknown; post?: (url: string) => ReturnType<typeof ok> } = {}) {
  posted = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(overrides.post ? overrides.post(path) : ok({ assignment: { id: crypto.randomUUID(), students: 30 }, session: { id: crypto.randomUUID(), attendees: 2 }, override: { id: crypto.randomUUID(), state: 'PENDING' } }, 201));
    }
    if (path.includes('/learning-resources')) return Promise.resolve(ok(resources));
    if (path.includes('/learning-actions')) return Promise.resolve(ok(overrides.actions ?? actions));
    if (path.includes('/learning-plan')) return Promise.resolve(ok(overrides.plan ?? planNoConsent));
    if (path.includes('/my-students')) return Promise.resolve(ok(myStudents));
    if (path.includes('/content-reviews')) return Promise.resolve(ok({ reviews: [], nextCursor: null }));
    return Promise.resolve(ok({}));
  });
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const page = () => <FacultyLearningActionsPage authenticatedWorkspace={faculty} />;

describe('Assign and plan learning', () => {
  it('shows published content and the lecturer\'s own actions from the server, with small counts as <5', async () => {
    route();
    render(page());
    const lessonRow = (await screen.findByText('Subnetting by hand')).closest('tr')!;
    expect(within(lessonRow).getByText('Lesson')).toBeInTheDocument();
    expect(screen.getByText('Practice set · 12 questions')).toBeInTheDocument();
    const assignments = await screen.findByRole('table', { name: 'Your assignments' });
    const row = within(assignments).getByText('Subnetting').closest('tr')!;
    expect(within(row).getByText('<5')).toBeInTheDocument();
    expect(within(row).getByText('30')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Your group sessions' })).toHaveTextContent('Subnetting clinic');
    const overrides = screen.getByRole('table', { name: 'Next steps you set' });
    expect(overrides).toHaveTextContent('Asha Synthetic (SYN-001)');
    expect(overrides).toHaveTextContent('Matches what the class is working on now');
    expect(overrides).toHaveTextContent('Waiting for the student');
    const text = document.body.textContent ?? '';
    // No model number or score: the only mention of readiness is the promise that it is never changed.
    expect(text).not.toMatch(/likelihood|score|%|\d\.\d/i);
    expect(text).not.toContain(asha.profileId);
  });

  it('assigns a practice set to a class the lecturer teaches', async () => {
    route();
    render(page());
    const row = (await screen.findByText('Ports', { selector: 'th' })).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Assign' }));
    const form = await screen.findByRole('form', { name: 'Assign to your students' });
    fireEvent.change(within(form).getByLabelText(/Note to the student/), { target: { value: 'Before Friday' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Assign' }));
    await screen.findByText('Assigned to 30 students. They have been told.');
    expect(posted).toEqual([{ url: expect.stringContaining(`/institutions/${institutionId}/learning-assignments`), body: {
      resource: { kind: 'PRACTICE', skillId: skillB, lessonVersionId: null }, unitId: sectionX, note: 'Before Friday',
    } }]);
  });

  it('opens prefilled from the cohort view: the stuck skill\'s practice set and the stuck students', async () => {
    window.history.replaceState(null, '', `/institution/faculty/learning-resources?assign=PRACTICE&skill=${skillA}&students=${asha.profileId},${ravi.profileId}`);
    route();
    render(page());
    await screen.findByText('Subnetting', { selector: 'strong' });
    expect(await screen.findByLabelText('Choose Asha Synthetic')).toBeChecked();
    expect(screen.getByLabelText('Choose Ravi Synthetic')).toBeChecked();
    fireEvent.click(screen.getByText('Assign', { selector: 'form button' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ resource: { kind: 'PRACTICE', skillId: skillA, lessonVersionId: null }, studentProfileIds: [asha.profileId, ravi.profileId] });
  });

  it('plans a group session around a resource', async () => {
    route();
    render(page());
    const row = (await screen.findByText('Subnetting by hand')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Plan a group session' }));
    const form = await screen.findByRole('form', { name: 'Plan a group session' });
    fireEvent.change(within(form).getByLabelText('Starts'), { target: { value: '2026-10-05T09:00' } });
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '2026-10-05T10:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Plan the session' }));
    await screen.findByText('Group session planned for 2 students. It is on your Calendar.');
    const body = posted[0]!.body as Record<string, unknown>;
    expect(posted[0]!.url).toContain('/group-sessions');
    expect(body).toMatchObject({ title: 'Group session: Subnetting', resources: [{ kind: 'LESSON', skillId: skillA, lessonVersionId: lessonId }], unitId: sectionX });
    expect(typeof body.scheduledStartAt).toBe('string');
  });

  it('sets one student\'s next step with a listed reason; their plan is NA without their consent', async () => {
    window.history.replaceState(null, '', `/institution/faculty/learning-resources?override=${ravi.profileId}`);
    route();
    render(page());
    expect(await screen.findByText(/this student has not chosen to share their learning data/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: `PRACTICE:${skillB}:` } });
    await screen.findByText('Ports', { selector: 'form strong' });
    await screen.findByText(/this student has not chosen to share their learning data/);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'UPCOMING_ASSESSMENT' } });
    fireEvent.click(screen.getByText('Set next step', { selector: 'form button' }));
    await screen.findByText(/Next step set. The student has been told/);
    expect(posted[0]!.url).toContain(`/students/${ravi.profileId}/plan-overrides`);
    expect(posted[0]!.body).toEqual({ action: 'PRACTICE', resource: { kind: 'PRACTICE', skillId: skillB, lessonVersionId: null }, reasonCode: 'UPCOMING_ASSESSMENT' });
  });

  it('shows the student\'s current step only when they share their learning data, and a safe conflict message', async () => {
    window.history.replaceState(null, '', `/institution/faculty/learning-resources?override=${ravi.profileId}`);
    route({ plan: planShared, post: () => ok({ error: { code: 'OVERRIDE_PENDING', correlationId: 'corr-pending', message: 'private upstream text' } }, 409) });
    render(page());
    expect(await screen.findByText('Practise: Ports')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: `PRACTICE:${skillA}:` } });
    await screen.findByText('Subnetting', { selector: 'form strong' });
    await screen.findByText('Practise: Ports');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'FACULTY_JUDGEMENT' } });
    fireEvent.click(screen.getByText('Set next step', { selector: 'form button' }));
    const alert = await screen.findByText(/already has a next step set by a lecturer/);
    expect(alert).toHaveTextContent('already has a next step set by a lecturer');
    expect(alert).toHaveTextContent('corr-pending');
    expect(screen.queryByText(/private upstream text/)).not.toBeInTheDocument();
  });

  it('says plainly when the lecturer has no teaching assignment, and disables the actions', async () => {
    route({ actions: { ...actions, canAct: false, targets: [], assignments: [], sessions: [], overrides: [] } });
    render(page());
    expect(await screen.findByText(/You need an active teaching assignment/)).toBeInTheDocument();
    const row = (await screen.findByText('Ports', { selector: 'th' })).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(screen.getByText('You have not assigned anything yet.')).toBeInTheDocument();
  });

  it('shows a safe forbidden state without upstream text', async () => {
    fetchMock.mockResolvedValue(ok({ message: 'private upstream error', error: { code: 'FORBIDDEN', correlationId: 'corr-403' } }, 403));
    render(page());
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('corr-403');
    expect(screen.queryByText('private upstream error')).not.toBeInTheDocument();
  });

  it('renders nothing and asks nothing for a role other than faculty', () => {
    render(<FacultyLearningActionsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    expect(screen.queryByText('Assign and plan learning')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is the faculty "Learning Resources" page, with the navigation unchanged', async () => {
    route();
    const portal = rolePortals.find((item) => item.key === 'faculty')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'Learning Resources')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={faculty} />);
    expect(await screen.findByRole('heading', { name: 'Assign and plan learning' })).toBeInTheDocument();
    expect(await screen.findByText('Subnetting by hand')).toBeInTheDocument();
  });
});
