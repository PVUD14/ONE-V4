/**
 * Institution settings, the academic calendar and staff profile screens (INST-05): the
 * admin's Settings edits the college profile, grading scales and calendar; department
 * heads read them under their own profile and preferences; faculty Profile, Settings and
 * Calendar show real data. A programme without a scale reads NA. Navigation is unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { AcademicCalendarPanel, InstitutionSettingsPage, StaffSettingsPage } from './institutionSettings.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const programme = crypto.randomUUID();
const otherProgramme = crypto.randomUUID();
const termId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const settings = (canEdit: boolean) => ({
  profile: { legalName: 'Local Institute of Technology', verificationState: 'VERIFIED', profileSetUp: true, displayName: 'Local Tech', websiteUrl: 'https://local.example.test',
    countryCode: 'IN', stateOrProvince: null, city: 'Local City', postalCode: null, addressLine1: null, addressLine2: null, primaryContactEmail: 'office@local.example.test', institutionType: 'ENGINEERING_COLLEGE' },
  college: { about: 'A college of engineering.', placementContactEmail: null, updatedAt: '2026-09-20T10:00:00Z' },
  programmes: [
    { programUnitId: programme, programName: 'BTech Computer Science', parentName: 'Computer Science', gradingScale: { programUnitId: programme, scale: 'CGPA_10', passThreshold: 5, updatedAt: '2026-09-20T10:00:00Z' } },
    { programUnitId: otherProgramme, programName: 'BCom', parentName: null, gradingScale: null },
  ],
  canEdit,
  options: { scales: ['CGPA_10', 'GPA_4', 'PERCENTAGE', 'LETTER', 'PASS_FAIL'], numericScaleMaximum: { CGPA_10: 10, GPA_4: 4, PERCENTAGE: 100 } },
});
const terms = (canEdit: boolean) => ({
  terms: [{ id: termId, name: '2026-27 Odd semester', kind: 'TERM', startsOn: '2026-07-01', endsOn: '2026-11-30', unit: null, current: true, archived: false, archiveReasonCode: null, updatedAt: '2026-09-20T10:00:00Z' }],
  nextCursor: null, canEdit, options: { kinds: ['TERM', 'EXAMINATIONS', 'BREAK'], units: canEdit ? [{ id: programme, kind: 'PROGRAM', name: 'BTech Computer Science' }] : [] },
});
const staffProfile = (role: string) => ({
  email: 'me@example.test', institutionName: 'Local Tech', roles: [{ role, department: role === 'DEPARTMENT_HEAD' ? 'Computer Science' : null, batch: null }],
  teachingAssignments: role === 'FACULTY_LECTURER' ? [{ unit: 'CSE 3A', subject: 'Data Structures', academicTerm: '2026-27 Odd semester' }] : [],
  notificationPreferences: null, notificationDefaults: { emailEnabled: true, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3 }, staffRemindersLive: false,
});

function respond({ canEdit = true, role = 'INSTITUTION_ADMIN' }: { canEdit?: boolean; role?: string } = {}) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      if (url.includes('/staff-profile')) return Promise.resolve(ok({ staffProfile: { ...staffProfile(role), notificationPreferences: { emailEnabled: false, quietHoursStartMinute: 0, quietHoursEndMinute: 360, dailyCap: 1 } } }));
      if (url.includes('/settings')) return Promise.resolve(ok({ settings: settings(canEdit) }));
      if (url.includes('/academic-terms')) return Promise.resolve(ok({ term: terms(canEdit).terms[0] }));
      return Promise.resolve(ok({ gradingScale: null }));
    }
    if (url.includes('/staff-profile')) return Promise.resolve(ok({ staffProfile: staffProfile(role) }));
    if (url.includes('/academic-terms')) return Promise.resolve(ok(terms(canEdit)));
    if (url.includes('/settings')) return Promise.resolve(ok({ settings: settings(canEdit) }));
    if (url.includes('/calendar')) return Promise.resolve(ok({ entries: [] }));
    // EMP-11: the college's placement policies (none in force yet).
    if (url.includes('/placement-policies')) return Promise.resolve(ok({ policies: [], canManage: canEdit }));
    return Promise.resolve(ok({ students: [], actions: [] }));
  });
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH');
const portalAt = (key: string, label: string, role: string) => {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
  return render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('navigation stays as it was', () => {
  it('keeps every institution role\'s labels, and gives the placement officer no Settings', () => {
    const labels = (key: string) => rolePortals.find((item) => item.key === key)!.nav.map((item) => item.label);
    expect(labels('institution-admin')).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions', 'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(labels('department-head')).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
    expect(labels('faculty')).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    expect(labels('placement-officer')).not.toContain('Settings');
  });
});

describe('admin Settings', () => {
  it('opens from the Settings item with the verified details, grading scales, calendar and honest empty sections', async () => {
    respond();
    portalAt('institution-admin', 'Settings', 'INSTITUTION_ADMIN');
    expect(await screen.findByText('Local Institute of Technology')).toBeInTheDocument();
    expect(screen.getByText(/Managed by AI8HT operations/)).toBeInTheDocument();
    const scales = screen.getByRole('table', { name: 'Programme grading scales' });
    const bcom = within(scales).getByRole('row', { name: /BCom/ });
    expect(within(bcom).getAllByText('NA')).toHaveLength(2);
    expect(within(within(scales).getByRole('row', { name: /BTech Computer Science/ })).getAllByRole('cell')[0]).toHaveTextContent('CGPA out of 10');
    expect(await screen.findByText('2026-27 Odd semester')).toBeInTheDocument();
    // EMP-11 built placement policies: the section is real, and says plainly that none is in force.
    expect(screen.queryByText('Placement policies — not built yet')).not.toBeInTheDocument();
    expect(await screen.findByText('No placement policy is in force. Students may apply through your drives whatever offers they hold.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Set placement policy' })).toBeInTheDocument();
    expect(screen.getByText('Data-processing terms — not built yet')).toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    expect(screen.queryByText(programme)).not.toBeInTheDocument();
  });

  it('saves only the college-written fields', async () => {
    respond();
    render(<InstitutionSettingsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    fireEvent.change(await screen.findByLabelText('Placement office email'), { target: { value: 'placements@local.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save college profile' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/institutions/' + institutionId + '/settings');
    expect(JSON.parse(String(init.body))).toEqual({ placementContactEmail: 'placements@local.example.test' });
  });

  it('sets a programme grading scale with its pass mark', async () => {
    respond();
    render(<InstitutionSettingsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    fireEvent.change(await screen.findByLabelText('Scale for BCom'), { target: { value: 'PERCENTAGE' } });
    fireEvent.change(screen.getByLabelText('Pass mark for BCom'), { target: { value: '40' } });
    fireEvent.click(within(screen.getByRole('row', { name: /BCom/ })).getByRole('button', { name: 'Save scale' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/grading-scales');
    expect(JSON.parse(String(init.body))).toEqual({ programUnitId: otherProgramme, scale: 'PERCENTAGE', passThreshold: 40 });
  });

  it('offers no pass mark on a pass/fail scale, and removes a scale with a reason', async () => {
    respond();
    render(<InstitutionSettingsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    fireEvent.change(await screen.findByLabelText('Scale for BCom'), { target: { value: 'PASS_FAIL' } });
    expect(screen.queryByLabelText('Pass mark for BCom')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('row', { name: /BTech Computer Science/ })).getByRole('button', { name: 'Remove scale' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/grading-scales/' + programme + '/remove');
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'WRONG_SCALE' });
  });

  it('shows a safe error without upstream text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'private stack' }) });
    render(<InstitutionSettingsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />);
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('Reference:');
    expect(screen.queryByText(/private stack/)).not.toBeInTheDocument();
  });
});

describe('academic calendar', () => {
  it('lets an admin add an entry for a programme', async () => {
    respond();
    render(<AcademicCalendarPanel token="token" institutionId={institutionId} />);
    await screen.findByText('2026-27 Odd semester');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'End-semester examinations' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'EXAMINATIONS' } });
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2026-12-20' } });
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: programme } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ name: 'End-semester examinations', kind: 'EXAMINATIONS', startsOn: '2026-12-01', endsOn: '2026-12-20', unitId: programme });
  });

  it('archives an entry with a reason', async () => {
    respond();
    render(<AcademicCalendarPanel token="token" institutionId={institutionId} />);
    const row = (await screen.findByText('2026-27 Odd semester')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/academic-terms/' + termId + '/archive');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'CANCELLED' });
  });

  it('says plainly when no calendar exists, without controls for a reader', async () => {
    fetchMock.mockResolvedValue(ok({ ...terms(false), terms: [] }));
    render(<AcademicCalendarPanel token="token" institutionId={institutionId} />);
    expect(await screen.findByText(/No academic calendar has been set up yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).not.toBeInTheDocument();
  });

  it('shows the academic calendar alongside meetings on the faculty Calendar', async () => {
    respond({ canEdit: false, role: 'FACULTY_LECTURER' });
    portalAt('faculty', 'Calendar', 'FACULTY_LECTURER');
    const calendar = await screen.findByRole('table', { name: 'Academic calendar' });
    expect(within(calendar).getByText('2026-27 Odd semester')).toBeInTheDocument();
    expect(within(calendar).getByText('Now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/staff-actions?actionType=MEETING'))).toBe(true));
  });
});

describe('department head and faculty', () => {
  it('shows the department head their profile, preferences and the college settings read-only', async () => {
    respond({ canEdit: false, role: 'DEPARTMENT_HEAD' });
    portalAt('department-head', 'Settings', 'DEPARTMENT_HEAD');
    expect(await screen.findByText('me@example.test')).toBeInTheDocument();
    expect(await screen.findByText('A college of engineering.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save college profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save scale' })).not.toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
    expect(screen.queryByText('Placement policies — not built yet')).not.toBeInTheDocument();
  });

  it('shows a lecturer their profile and teaching from the Profile item', async () => {
    respond({ canEdit: false, role: 'FACULTY_LECTURER' });
    portalAt('faculty', 'Profile', 'FACULTY_LECTURER');
    expect(await screen.findByText('Data Structures · CSE 3A · 2026-27 Odd semester')).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });

  it('saves a lecturer\'s own notification preferences and is honest that staff reminders are not sent yet', async () => {
    respond({ canEdit: false, role: 'FACULTY_LECTURER' });
    render(<StaffSettingsPage authenticatedWorkspace={{ organizationId: institutionId, role: 'FACULTY_LECTURER' }} />);
    expect(await screen.findByText(/does not send reminder emails to institution staff yet/)).toBeInTheDocument();
    expect(screen.getByText(/defaults are shown/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Email me reminders'));
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '00:00' } });
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '06:00' } });
    fireEvent.change(screen.getByLabelText('Most reminders a day'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/institutions/' + institutionId + '/staff-profile/notification-preferences');
    expect(JSON.parse(String(init.body))).toEqual({ emailEnabled: false, quietHoursStartMinute: 0, quietHoursEndMinute: 360, dailyCap: 1 });
    expect(await screen.findByText('Notification preferences saved.')).toBeInTheDocument();
  });

  it('opens the faculty Settings item on the preferences screen', async () => {
    respond({ canEdit: false, role: 'FACULTY_LECTURER' });
    portalAt('faculty', 'Settings', 'FACULTY_LECTURER');
    expect(await screen.findByRole('button', { name: 'Save preferences' })).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });
});
