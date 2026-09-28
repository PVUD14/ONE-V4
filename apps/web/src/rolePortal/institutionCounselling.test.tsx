/**
 * The counselling notes section of Interventions (INST-11): real server data only, the
 * restriction stated plainly, sharing and participant management offered only where the server
 * says so, and safe error states that carry a reference but no upstream text.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/core.js';
import { CounsellingNotesSection, counsellingError } from './institutionCounselling.js';
import type { CounsellingCasesDto, CounsellingNotesDto } from '../api/counselling.js';

const api = vi.hoisted(() => ({
  cases: vi.fn(), notes: vi.fn(), write: vi.fn(), visibility: vi.fn(), erase: vi.fn(), add: vi.fn(), remove: vi.fn(),
}));
vi.mock('../api/counselling.js', () => ({
  listCounsellingCases: api.cases, listCounsellingNotes: api.notes, writeCounsellingNote: api.write,
  setCounsellingNoteVisibility: api.visibility, eraseCounsellingNote: api.erase,
  addCounsellingParticipant: api.add, removeCounsellingParticipant: api.remove,
}));
vi.mock('../api.js', async () => ({
  ApiRequestError: (await import('../api/core.js')).ApiRequestError,
  getProtectedAccessToken: () => 'staff-token',
}));

const cases: CounsellingCasesDto = {
  cases: [{ studentUserId: 'student-1', studentName: 'Aanya Rao', notes: 2, lastNoteAt: '2030-04-02T09:00:00Z', participant: false }],
  students: [{ id: 'student-1', name: 'Aanya Rao' }, { id: 'student-2', name: 'Kiran Das' }],
  canManageParticipants: true,
};
const detail: CounsellingNotesDto = {
  student: { id: 'student-1', name: 'Aanya Rao' },
  notes: [
    { id: 'note-1', title: 'First session', note: 'Talked through exam stress.', visibility: 'STAFF_ONLY', version: 1, createdAt: '2030-04-02T09:00:00Z',
      authorName: 'counsellor@college.test', authorRole: 'FACULTY_LECTURER', writtenByYou: false, canChangeVisibility: true, canErase: true },
  ],
  nextCursor: null,
  participants: [{ membershipId: 'membership-9', name: 'counsellor@college.test', role: 'FACULTY_LECTURER', addedAt: '2030-04-01T09:00:00Z', reasonCode: 'CASE_REFERRAL' }],
  eligibleStaff: [{ membershipId: 'membership-7', name: 'head@college.test', role: 'DEPARTMENT_HEAD' }],
  canWrite: true, canManageParticipants: true,
};

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.cases.mockResolvedValue(cases);
  api.notes.mockResolvedValue(detail);
});
afterEach(cleanup);

describe('Counselling notes section', () => {
  it('states who can read the notes and lists only the cases the server returned', async () => {
    render(<CounsellingNotesSection institutionId="inst-1" />);
    const section = await screen.findByRole('region', { name: 'Counselling notes' });
    expect(within(section).getByText(/Readable only by the note's author, institution owners and administrators, and staff added/)).toBeInTheDocument();
    const list = await within(section).findByLabelText('Counselling cases');
    expect(within(list).getByText('Aanya Rao')).toBeInTheDocument();
    expect(within(section).getByText(/2 notes you can read/)).toBeInTheDocument();
    expect(api.cases).toHaveBeenCalledWith('staff-token', 'inst-1', expect.any(AbortSignal));
  });

  it('opens a case with its notes, sharing, erasure and participant management as the server allows', async () => {
    render(<CounsellingNotesSection institutionId="inst-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open notes for Aanya Rao' }));
    const caseCard = await screen.findByRole('region', { name: 'Notes for Aanya Rao' });
    expect(within(caseCard).getByText('Talked through exam stress.')).toBeInTheDocument();
    expect(within(caseCard).getByText('Staff only')).toBeInTheDocument();
    expect(within(caseCard).getByText(/Written by counsellor@college.test \(Faculty\)/)).toBeInTheDocument();
    expect(within(caseCard).getByRole('button', { name: 'Remove counsellor@college.test' })).toBeInTheDocument();

    api.visibility.mockResolvedValue({ id: 'note-1', visibility: 'SUBJECT_VISIBLE', version: 2 });
    fireEvent.click(within(caseCard).getByRole('button', { name: 'Share with the student' }));
    await waitFor(() => expect(api.visibility).toHaveBeenCalledWith('staff-token', 'inst-1', 'note-1', { visibility: 'SUBJECT_VISIBLE', version: 1 }));
    expect(await screen.findByText('The note is now shared with the student.')).toBeInTheDocument();

    api.add.mockResolvedValue({ id: 'participant-1' });
    const form = await screen.findByRole('form', { name: 'Add a case participant' });
    fireEvent.change(within(form).getByLabelText('Staff member'), { target: { value: 'membership-7' } });
    fireEvent.submit(form);
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('staff-token', 'inst-1', 'student-1', 'membership-7', 'CASE_REFERRAL'));
  });

  it('hides participant management and erasure when the server does not grant them', async () => {
    api.cases.mockResolvedValue({ ...cases, canManageParticipants: false });
    api.notes.mockResolvedValue({ ...detail, participants: [], eligibleStaff: [], canManageParticipants: false,
      notes: [{ ...detail.notes[0]!, writtenByYou: true, canErase: false }] });
    render(<CounsellingNotesSection institutionId="inst-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open notes for Aanya Rao' }));
    const caseCard = await screen.findByRole('region', { name: 'Notes for Aanya Rao' });
    expect(within(caseCard).getByText('Written by you', { exact: false })).toBeInTheDocument();
    expect(within(caseCard).queryByRole('button', { name: 'Erase note' })).not.toBeInTheDocument();
    expect(within(caseCard).queryByText('Case participants')).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a case participant' })).not.toBeInTheDocument();
  });

  it('writes a staff-only note by default and shares only when asked', async () => {
    api.write.mockResolvedValue({ id: 'note-2', visibility: 'STAFF_ONLY', version: 1 });
    render(<CounsellingNotesSection institutionId="inst-1" />);
    const form = await screen.findByRole('form', { name: 'Write a counselling note' });
    fireEvent.change(within(form).getByLabelText('Student'), { target: { value: 'student-2' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Check-in' } });
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: 'Doing better this week.' } });
    fireEvent.submit(form);
    await waitFor(() => expect(api.write).toHaveBeenCalledWith('staff-token', 'inst-1', 'student-2', { title: 'Check-in', note: 'Doing better this week.', shareWithStudent: false }));
    expect(await screen.findByText('Note saved. Only its readers can see it.')).toBeInTheDocument();
  });

  it('says plainly when there is nothing to read or write', async () => {
    api.cases.mockResolvedValue({ cases: [], students: [], canManageParticipants: false });
    render(<CounsellingNotesSection institutionId="inst-1" />);
    expect(await screen.findByText('No counselling notes you can read yet.')).toBeInTheDocument();
    expect(screen.getByText('No students are in your writing scope.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
  });

  it('shows a safe message with a reference, never upstream text, when the read is refused', async () => {
    api.cases.mockRejectedValue(new ApiRequestError({ status: 403, correlationId: 'corr-123', detail: 'internal stack trace' }));
    render(<CounsellingNotesSection institutionId="inst-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Counselling notes for this student are not available to you. Reference: corr-123.');
    expect(document.body.textContent).not.toMatch(/stack trace/);
    expect(screen.getByText('NA — counselling notes unavailable.')).toBeInTheDocument();
  });

  it('explains SCOPE_REQUIRED in plain words', () => {
    expect(counsellingError(new ApiRequestError({ status: 403, correlationId: 'c', code: 'SCOPE_REQUIRED' })))
      .toMatch(/needs a department or teaching assignment/);
  });
});
