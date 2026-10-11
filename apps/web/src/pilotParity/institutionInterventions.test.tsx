/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, listInstitutionExamResults, listInstitutionExams } from '../api.js';
import { InstitutionInterventionsPage } from './institutionInterventions.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(),
  getProtectedAccessToken: vi.fn(), listInstitutionExams: vi.fn(), listInstitutionExamResults: vi.fn(),
}));
const institutionId = crypto.randomUUID();
const studentId = crypto.randomUUID();
const actionId = crypto.randomUUID();
const fetchMock = vi.fn();
const action = {
  id: actionId, title: 'Assessment follow-up', studentName: 'Local student', ownerName: 'staff@example.test',
  note: 'Recorded follow-up', outcomeNote: null, state: 'DRAFT', version: 1, dueAt: null,
  allowedTransitions: ['UNDER_REVIEW', 'CANCELLED'],
};
const response = (data: unknown) => ({ ok: true, json: async () => data });
beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(listInstitutionExams).mockReset().mockResolvedValue({ assessments: [] } as never);
  vi.mocked(listInstitutionExamResults).mockReset();
  fetchMock.mockReset().mockResolvedValue(response({ actions: [], students: [{ id: studentId, name: 'Local student' }] }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function page(id = institutionId, basePath = '/institution/admin') {
  return <InstitutionInterventionsPage institutionId={id} basePath={basePath} />;
}
async function loaded() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Assign Intervention' })).toBeEnabled());
}
describe('C4 Institution Interventions', () => {
  it.each(['/institution/admin', '/institution/placement-officer', '/institution/faculty', '/institution/department-head'])('loads protected records for the %s screen', async (basePath) => {
    render(page(institutionId, basePath));
    await loaded();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/v1/institutions/' + institutionId + '/staff-actions');
    expect(options.headers.Authorization).toBe('Bearer ' + getProtectedAccessToken());
    expect(screen.getByRole('heading', { name: 'Tracked interventions' })).toBeInTheDocument();
  });

  it('preserves the assessment attention queue and every existing widget while rendering persisted outcomes', async () => {
    vi.mocked(listInstitutionExams).mockResolvedValue({ assessments: [{
      id: crypto.randomUUID(), title: 'Local assessment', lifecycleState: 'PUBLISHED', assignedCount: 1, endsAt: '2026-09-10T12:00:00Z',
    }] } as never);
    vi.mocked(listInstitutionExamResults).mockResolvedValue({ notAttempted: [{
      studentName: 'Queue student', institutionStudentId: 'LOCAL-01', inProgress: false,
    }] } as never);
    fetchMock.mockResolvedValue(response({ actions: [{ ...action, state: 'COMPLETED', outcomeNote: 'Follow-up finished', allowedTransitions: [] }], students: [] }));
    render(page());
    await loaded();
    expect(await screen.findByText('Queue student')).toBeInTheDocument();
    expect(screen.getByText('Has not attempted: Local assessment')).toBeInTheDocument();
    expect(screen.getByText('Outcome: Follow-up finished')).toBeInTheDocument();
    expect(screen.getByText('Local student · Owner: staff@example.test')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    for (const heading of ['Needs attention now', 'Tracked interventions', 'Why Interventions Work', 'Completion Rate']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(screen.queryByText(actionId)).not.toBeInTheDocument();
  });

  it('creates an intervention only after submission and reloads persisted results', async () => {
    fetchMock.mockResolvedValueOnce(response({ actions: [], students: [{ id: studentId, name: 'Local student' }] }))
      .mockResolvedValueOnce(response({ id: actionId }))
      .mockResolvedValue(response({ actions: [action], students: [] }));
    render(page());
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Assign Intervention' }));
    fireEvent.change(screen.getByLabelText('Student'), { target: { value: studentId } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: action.title } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: action.note } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('heading', { name: action.title });
    const options = fetchMock.mock.calls[1]![1];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ studentUserId: studentId, title: action.title, note: action.note, dueAt: null });
    expect(screen.getByRole('status')).toHaveTextContent('Draft intervention saved');
  });

  it('uses server-provided transitions and sends the record version', async () => {
    fetchMock.mockResolvedValue(response({ actions: [action], students: [] }));
    render(page()); await loaded();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]![0]).toContain('/' + actionId + '/transition');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ version: 1, toState: 'UNDER_REVIEW' });
  });

  it('requires an outcome before completion and prevents a missing-note request', async () => {
    fetchMock.mockResolvedValue(response({ actions: [{ ...action, state: 'IN_PROGRESS', allowedTransitions: ['COMPLETED'] }], students: [] }));
    render(page()); await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add a review or outcome note');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable widgets as NA and does not display upstream error text', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'private upstream detail' }) });
    vi.mocked(listInstitutionExams).mockRejectedValue(new Error('unavailable'));
    render(page());
    expect(await screen.findByRole('alert')).toHaveTextContent('current institution scope');
    expect(screen.getByText('NA — intervention records unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Completion Rate' })).toBeInTheDocument();
    expect(screen.queryByText(/private upstream detail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nobody needs attention/)).not.toBeInTheDocument();
  });

  it('does not request protected data without a session', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(page());
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listInstitutionExams).not.toHaveBeenCalled();
  });

  it('aborts old workspace requests and ignores their late responses', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue(response({ actions: [], students: [] }));
    const view = render(page());
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(page(crypto.randomUUID()));
    await loaded();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(response({ actions: [action], students: [] })); });
    expect(screen.queryByRole('heading', { name: action.title })).not.toBeInTheDocument();
  });
});
