/**
 * Teaching assignments and "My Students" on the institution screens (INST-03): faculty
 * see the students of their assigned sections from the server, admins and department
 * heads assign and end with a reason, and admins set a staff member's unit scope when
 * inviting and afterwards. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { InstitutionStaffPage } from './institution.js';
import { FacultyMyStudentsPage, TeachingAssignmentsPanel } from './institutionTeaching.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const institutionId = crypto.randomUUID();
const facultyMembership = crypto.randomUUID();
const headMembership = crypto.randomUUID();
const section = crypto.randomUUID();
const department = crypto.randomUUID();
const batch = crypto.randomUUID();
const assignmentId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const unit = { id: section, kind: 'SECTION', name: 'CSE 3A' };
const assignment = {
  id: assignmentId, facultyMembershipId: facultyMembership, facultyEmail: 'lecturer@example.test', unit, subject: { id: crypto.randomUUID(), name: 'Data Structures', code: 'CS201' },
  subjectCode: null, academicTerm: '2026-27 Odd semester', startsOn: '2026-07-01', endsOn: null, state: 'ACTIVE', active: true, reasonCode: 'NEW_TERM',
};
const myStudents = {
  mode: 'ASSIGNMENTS', assignments: [assignment], nextCursor: null, scope: { kind: 'UNITS', units: [unit] },
  students: [{
    profileId: crypto.randomUUID(), studentUserId: crypto.randomUUID(), fullName: 'Asha Local', institutionStudentId: 'CSE-001', units: { section: 'CSE 3A', batch: '2027' },
    activation: { state: 'INVITED', deliveryState: 'NOT_CONFIGURED', invitedAt: null, expiresAt: null, lastSentAt: null },
    openTasks: 2, recentAssessments: { submitted: 1, latestTitle: 'Unit test 1', latestSubmittedAt: '2026-09-20T10:00:00Z' },
  }],
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('My Students', () => {
  const page = () => <FacultyMyStudentsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'FACULTY_LECTURER' }} />;

  it('shows the assigned students with activation, recent assessments and open tasks from the server', async () => {
    fetchMock.mockResolvedValue(ok(myStudents));
    render(page());
    const row = (await screen.findByText('Asha Local')).closest('tr')!;
    expect(within(row).getByText('Invited')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText(/Unit test 1/)).toBeInTheDocument();
    expect(screen.getByText(/Data Structures/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/institutions/' + institutionId + '/my-students');
    expect(screen.queryByText(myStudents.students[0]!.profileId)).not.toBeInTheDocument();
  });

  it('says plainly when the lecturer has no teaching assignment', async () => {
    fetchMock.mockResolvedValue(ok({ ...myStudents, assignments: [], students: [] }));
    render(page());
    expect(await screen.findByText(/You have no active teaching assignment/)).toBeInTheDocument();
  });

  it('shows a safe forbidden state without upstream text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'private error' }) });
    render(page());
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.queryByText('private error')).not.toBeInTheDocument();
  });

  it('is what the faculty "My Students" item opens, with the navigation unchanged', async () => {
    fetchMock.mockResolvedValue(ok(myStudents));
    const portal = rolePortals.find((item) => item.key === 'faculty')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'My Students')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role: 'FACULTY_LECTURER' }} />);
    expect(await screen.findByText('Asha Local')).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });
});

describe('Teaching assignments panel', () => {
  const listing = {
    assignments: [assignment], nextCursor: null, canAssign: true,
    faculty: [{ membershipId: facultyMembership, email: 'lecturer@example.test' }],
    units: [unit], subjects: [{ id: assignment.subject.id, name: 'Data Structures', code: 'CS201' }],
  };

  it('creates an assignment with a subject, term and reason code', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve(ok(init?.method === 'POST' ? { assignment } : listing)));
    render(<TeachingAssignmentsPanel token="token" institutionId={institutionId} />);
    await screen.findByText('lecturer@example.test', { selector: 'td' });
    fireEvent.change(screen.getByLabelText('Faculty member'), { target: { value: facultyMembership } });
    fireEvent.change(screen.getByLabelText('Section or batch'), { target: { value: section } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: assignment.subject.id } });
    fireEvent.change(screen.getByLabelText('Academic term'), { target: { value: '2026-27 Odd semester' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'COVER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(call[0])).toContain('/institutions/' + institutionId + '/teaching-assignments');
    expect(JSON.parse(String(call[1].body))).toEqual({ facultyMembershipId: facultyMembership, unitId: section, subjectId: assignment.subject.id, academicTerm: '2026-27 Odd semester', reasonCode: 'COVER' });
  });

  it('ends an assignment with a reason code', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve(ok(init?.method === 'POST' ? { assignment: { ...assignment, state: 'ENDED' } } : listing)));
    render(<TeachingAssignmentsPanel token="token" institutionId={institutionId} />);
    const row = (await screen.findByText('lecturer@example.test', { selector: 'td' })).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'End assignment' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(call[0])).toContain('/teaching-assignments/' + assignmentId + '/end');
    expect(JSON.parse(String(call[1].body))).toEqual({ reasonCode: 'TERM_ENDED' });
  });

  it('hides assignment controls from a reader who cannot assign', async () => {
    fetchMock.mockResolvedValue(ok({ ...listing, canAssign: false, faculty: [], units: [], subjects: [] }));
    render(<TeachingAssignmentsPanel token="token" institutionId={institutionId} />);
    await screen.findByText('lecturer@example.test', { selector: 'td' });
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End assignment' })).not.toBeInTheDocument();
  });

  it('is what the department head "Faculty and Staff" item opens', async () => {
    fetchMock.mockResolvedValue(ok(listing));
    const portal = rolePortals.find((item) => item.key === 'department-head')!;
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'Faculty and Staff')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role: 'DEPARTMENT_HEAD' }} />);
    expect(await screen.findByText('lecturer@example.test', { selector: 'td' })).toBeInTheDocument();
  });
});

describe('Staff unit scope', () => {
  const portal = rolePortals.find((item) => item.key === 'institution-admin')!;
  const staff = {
    invitations: [],
    memberships: [{ id: headMembership, userId: crypto.randomUUID(), email: 'head@example.test', role: 'DEPARTMENT_HEAD', state: 'ACTIVE', createdAt: '2026-09-01', updatedAt: '2026-09-01', scope: { departmentUnitId: null, batchUnitId: null } }],
    unavailableActions: [],
  };
  const units = [{ id: department, institutionId, kind: 'DEPARTMENT', name: 'Computer Science' }, { id: batch, institutionId, kind: 'BATCH', name: '2027', parentUnitId: department }];
  function respond() {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve(ok({}));
      if (url.includes('/units')) return Promise.resolve(ok({ units }));
      if (url.includes('/teaching-assignments')) return Promise.resolve(ok({ assignments: [], nextCursor: null, canAssign: true, faculty: [], units: [], subjects: [] }));
      return Promise.resolve(ok({ staff }));
    });
  }
  const page = () => <InstitutionStaffPage portal={portal} authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />;

  it('invites a department head scoped to a department', async () => {
    respond(); render(page());
    await screen.findByText('head@example.test');
    fireEvent.change(screen.getByLabelText('Recipient email *'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Institution role *'), { target: { value: 'DEPARTMENT_HEAD' } });
    fireEvent.change(screen.getByLabelText('Department scope'), { target: { value: department } });
    fireEvent.click(screen.getByRole('button', { name: 'Send staff invitation' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ email: 'new@example.test', role: 'DEPARTMENT_HEAD', departmentUnitId: department });
  });

  it('shows each membership scope and sets it with a reason code', async () => {
    respond(); render(page());
    const row = (await screen.findByText('head@example.test')).closest('tr')!;
    expect(within(row).getByText('Whole institution')).toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Department for head@example.test'), { target: { value: department } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save scope' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(call[0])).toContain('/staff-memberships/' + headMembership + '/scope');
    expect(JSON.parse(String(call[1].body))).toEqual({ departmentUnitId: department, batchUnitId: null, reasonCode: 'SCOPE_REVIEW' });
  });
});
