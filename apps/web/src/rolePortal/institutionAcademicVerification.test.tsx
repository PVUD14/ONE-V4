/**
 * Academic verification screens (INST-04): reachable behind existing labels only, a
 * reason code on every decision, evidence shown as metadata and never opened, conflicts
 * shown beside the student's value, and a results upload that commits only what was
 * previewed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { AcademicResultsUpload, AcademicVerificationPage } from '../academicVerificationPage.js';
import { InstitutionDashboardV3 } from '../staffDashboardsV3.js';

vi.mock('../auth.js', async (original) => ({ ...await original<typeof import('../auth.js')>(), getAccessToken: () => 'test-access-token' }));
vi.mock('../api.js', async (original) => ({ ...await original<typeof import('../api.js')>(), getProtectedAccessToken: () => 'test-access-token' }));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = '33333333-3333-4333-8333-333333333333';
const base = `/api/v1/institutions/${institutionId}`;
const entry = {
  termId: 'term-1', label: 'Semester 4', sequence: 4, resultValue: '9.10', resultScale: 'CGPA_10', resultLetter: null, backlogCount: 0,
  source: 'DOCUMENT_BACKED', qualificationId: 'q-1', programmeName: 'Computer Science and Engineering', qualificationType: 'BTECH',
  claimedStartedOn: '2022-08-01', claimedCompletedOn: null, studentUserId: 'u-1', studentEmail: 'student@uat.example.test',
  studentName: 'Local Student', institutionStudentId: 'CSE-001', relationship: 'CURRENT',
  evidence: { title: 'Semester 4 marksheet', documentType: 'TRANSCRIPT', versionNumber: 2, shared: false },
  institutionRecord: { resultValue: 8.4, resultScale: 'CGPA_10', resultLetter: null, backlogCount: 0 },
};
const row = (overrides: Record<string, unknown>) => ({
  rowNumber: 2, institutionStudentId: 'CSE-001', studentName: 'Local Student', termSequence: 4, termLabel: 'Semester 4', scale: 'CGPA_10',
  result: '8.4', backlogs: 0, outcome: 'CREATE', issues: [], studentReported: null, verifiedRecord: null, ...overrides,
});
const counts = (overrides: Record<string, number> = {}) => ({ create: 1, confirm: 0, unchanged: 0, conflict: 0, invalid: 0, differsFromStudent: 0, ...overrides });
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

function routes(table: Readonly<Record<string, unknown>>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const body = table[path];
    if (body instanceof Error) return { ok: false, status: 500, headers: { get: () => 'corr-500' }, json: async () => ({}) };
    return ok(body ?? {});
  });
}
const bodyOf = (fragment: string) => JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).includes(fragment))![1].body));

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('verification queue', () => {
  it('shows evidence as title, type and version, says it is not shared, and offers no way to open it', async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry], nextCursor: null } });
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText('Semester 4 marksheet')).toBeInTheDocument();
    expect(screen.getByText('TRANSCRIPT · version 2')).toBeInTheDocument();
    expect(screen.getByText(/Not shared with the college/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open|download|view document/i })).not.toBeInTheDocument();
  });

  it("shows the institution's verified value beside a differing claim", async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry] } });
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText('Your verified record: 8.4 / 10, 0 backlog')).toBeInTheDocument();
    expect(screen.getByText('9.10 / 10')).toBeInTheDocument();
  });

  it('sends a reason code with a confirmation, and will not reject without a chosen reason', async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry] }, [`${base}/academic-verification/term-1/decide`]: { queue: [entry] } });
    render(<AcademicVerificationPage institutionId={institutionId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirmReject = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirmReject).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for rejecting'), { target: { value: 'DOES_NOT_MATCH_RECORD' } });
    fireEvent.click(confirmReject);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Rejected/));
    expect(bodyOf('/decide')).toEqual({ decision: 'REJECTED', reasonCode: 'DOES_NOT_MATCH_RECORD' });
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/permanent/));
    expect(bodyOf('/decide')).toEqual({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' });
  });

  it('shows a plain error with a reference when the queue cannot load', async () => {
    routes({ [`${base}/academic-verification-queue`]: new Error('down') });
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText(/The verification queue could not be loaded\. Reference: corr-500/)).toBeInTheDocument();
    expect(screen.queryByText(/stack|Error:/)).not.toBeInTheDocument();
  });

  it('loads the next page from the keyset cursor', async () => {
    fetchMock.mockImplementation(async (url: string) => ok(String(url).includes('after=term-1')
      ? { queue: [{ ...entry, termId: 'term-2', studentName: 'Second Student' }], nextCursor: null }
      : { queue: [entry], nextCursor: 'term-1' }));
    render(<AcademicVerificationPage institutionId={institutionId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more requests' }));
    expect(await screen.findByText('Second Student')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more requests' })).not.toBeInTheDocument();
  });
});

describe('results upload', () => {
  const previewPath = `${base}/academic-results-imports/preview`;
  const commitPath = `${base}/academic-results-imports/commit`;

  it('lists row issues and offers no commit while any row is invalid', async () => {
    routes({ [previewPath]: { preview: { digest: 'a'.repeat(64), rowCount: 2, counts: counts({ invalid: 1 }), rows: [
      row({}), row({ rowNumber: 3, institutionStudentId: 'NOPE', studentName: null, outcome: 'INVALID', issues: ['student_not_found'] }),
    ] } } });
    render(<AcademicResultsUpload institutionId={institutionId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Validate results' }));
    expect(await screen.findByText('No student with this ID on the roster you manage')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing is recorded while any row is invalid/);
    expect(screen.queryByRole('button', { name: /^Record / })).not.toBeInTheDocument();
  });

  it("shows the student's differing value beside a new record and commits exactly the previewed digest", async () => {
    const digest = 'b'.repeat(64);
    routes({
      [previewPath]: { preview: { digest, rowCount: 1, counts: counts({ differsFromStudent: 1 }), rows: [
        row({ studentReported: { resultValue: '9.100', resultScale: 'CGPA_10', resultLetter: null, backlogCount: 0, verificationState: 'PENDING_VERIFICATION' } }),
      ] } },
      [commitPath]: { import: { reference: 'r', created: 1, confirmed: 0, counts: counts(), rows: [] } },
    });
    render(<AcademicResultsUpload institutionId={institutionId} />);
    fireEvent.change(screen.getByLabelText('Or paste the CSV'), { target: { value: 'institution_student_id,term_sequence,term_label,scale,result,backlogs\nCSE-001,4,Semester 4,CGPA_10,8.4,0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate results' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Student entered 9.100 / 10, 0 backlog')).toBeInTheDocument();
    expect(screen.getByText(/1 differ from what the student entered — both will be kept/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'PAST_TERMS_BACKFILL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record 1 verified result' }));
    await waitFor(() => expect(screen.getByText(/1 result recorded as verified/)).toBeInTheDocument());
    expect(bodyOf('/academic-results-imports/commit')).toEqual({
      filename: 'results.csv', csv: 'institution_student_id,term_sequence,term_label,scale,result,backlogs\nCSE-001,4,Semester 4,CGPA_10,8.4,0',
      previewDigest: digest, reasonCode: 'PAST_TERMS_BACKFILL',
    });
  });
});

describe('reachable behind existing labels only', () => {
  const render_ = (key: string, label: string, role: string) => {
    const portal = rolePortals.find((item) => item.key === key)!;
    const route = portal.nav.find((item) => item.label === label)!;
    window.history.replaceState(null, '', route.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role }} />);
  };

  it('gives faculty the queue first and keeps the staff-action list as the second tab', async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry] } });
    render_('faculty', 'Academic Verification', 'FACULTY_LECTURER');
    expect(await screen.findByText('Local Student')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verification queue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Staff actions' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/staff-actions?actionType=ACADEMIC_VERIFICATION'))).toBe(true));
    // No results upload for faculty: they confirm one at a time.
    expect(screen.queryByRole('heading', { name: 'Upload results' })).not.toBeInTheDocument();
  });

  it('adds the verification section and the upload to the admin Students page', async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry] }, [`${base}/students`]: { students: [] }, [`${base}/units`]: { units: [] } });
    render_('institution-admin', 'Students', 'INSTITUTION_ADMIN');
    expect(await screen.findByText('Local Student')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upload results' })).toBeInTheDocument();
  });

  it("gives a department head their department's queue and upload under Students", async () => {
    routes({ [`${base}/academic-verification-queue`]: { queue: [entry] } });
    render_('department-head', 'Students', 'DEPARTMENT_HEAD');
    expect(await screen.findByText('Local Student')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upload results' })).toBeInTheDocument();
    expect(screen.getByText(/The department roster is not built yet/)).toBeInTheDocument();
  });

  it('leaves every institution navigation label exactly as it was', () => {
    const labels = (key: string) => rolePortals.find((item) => item.key === key)!.nav.map((item) => item.label);
    expect(labels('faculty')).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail',
      'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    expect(labels('institution-admin')).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions',
      'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(labels('department-head')).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions',
      'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
  });
});

describe('dashboard verification backlog', () => {
  it('shows the server-counted backlog and links to where this role reviews it', async () => {
    routes({ [`${base}/academic-verification-summary`]: { summary: { pending: 7, notCurrent: 2 } } });
    render(<InstitutionDashboardV3 institutionId={institutionId} basePath="/institution/faculty" />);
    const card = (await screen.findByRole('heading', { name: 'Academic Verification' })).closest('section')!;
    expect(within(card).getByText('Waiting for a decision').parentElement).toHaveTextContent('Waiting for a decision 7');
    expect(within(card).getByText(/not on the roster/).parentElement).toHaveTextContent(/2$/);
    fireEvent.click(within(card).getByRole('button', { name: 'Review Queue' }));
    expect(window.location.pathname).toBe('/institution/faculty/academic-verification');
  });

  it('shows NA, not zero, when the summary cannot be read', async () => {
    routes({ [`${base}/academic-verification-summary`]: new Error('down') });
    render(<InstitutionDashboardV3 institutionId={institutionId} basePath="/institution/placement-officer" />);
    const card = (await screen.findByRole('heading', { name: 'Academic Verification' })).closest('section')!;
    expect(within(card).getByText('Waiting for a decision').parentElement).toHaveTextContent('Waiting for a decision NA');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });
});
