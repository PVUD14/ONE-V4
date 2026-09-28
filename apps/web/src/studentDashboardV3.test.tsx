/**
 * ONE · Stream D — Learner
 * Owner: Santhosh · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Verifies the authenticated learner dashboard readiness-band presentation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api.js';
import { StudentDashboardV3 } from './studentDashboardV3.js';
import type { StudentStaffActionDto } from './api/student.js';

const apiState = vi.hoisted(() => ({
  token: 'learner-token' as string | null,
  learner: null as Record<string, unknown> | null,
  exams: [] as Record<string, unknown>[],
  applications: [] as Record<string, unknown>[],
  learnerError: null as string | null,
  examsError: null as string | null,
  applicationsError: null as string | null,
}));
const supportApi = vi.hoisted(() => ({ current: vi.fn(), list: vi.fn(), complete: vi.fn() }));
const counsellingApi = vi.hoisted(() => ({ shared: vi.fn() }));

// INST-11: the Support card also reads the counselling notes the college shared.
vi.mock('./api/counselling.js', () => ({ listMySharedCounsellingNotes: counsellingApi.shared }));

vi.mock('./api/student.js', () => ({
  getCurrentStudent: supportApi.current,
  listStudentStaffActions: supportApi.list,
  completeStudentStaffAction: supportApi.complete,
}));

vi.mock('./api.js', () => ({
  getProtectedAccessToken: () => apiState.token,
  getStudentProfile: vi.fn(async () => ({ profile: null })),
  getLearnerCareerReadinessState: vi.fn(async () => {
    if (apiState.learnerError) throw new Error(apiState.learnerError);
    return apiState.learner;
  }),
  listStudentExams: vi.fn(async () => {
    if (apiState.examsError) throw new Error(apiState.examsError);
    return { assessments: apiState.exams };
  }),
  listStudentApplications: vi.fn(async () => {
    if (apiState.applicationsError) throw new Error(apiState.applicationsError);
    return { applications: apiState.applications };
  }),
  listMyNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
  getStudentActivity: vi.fn(async () => ({ currentStreakDays: 0, activeDaysLast7: 0, last7: [] })),
}));

const catalog = {
  pilot: 'Career Readiness Fundamentals',
  releaseManifestId: 'release-1',
  topics: [{ id: 'topic-communication', stableKey: 'professional-communication', name: 'Professional Communication', description: 'Clear workplace communication.' }],
  modules: [],
  assessments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiState.token = 'learner-token';
  apiState.exams = [];
  apiState.applications = [];
  apiState.learnerError = null;
  apiState.examsError = null;
  apiState.applicationsError = null;
  supportApi.current.mockReset().mockResolvedValue({ student: { institutionId: 'student-institution' } });
  supportApi.list.mockReset().mockResolvedValue({ actions: [] });
  supportApi.complete.mockReset();
  counsellingApi.shared.mockReset().mockResolvedValue({ notes: [] });
  apiState.learner = {
    catalog,
    progress: [], attempts: [], evidence: [], roadmap: [], notificationPreferences: null, notifications: [],
    mastery: [{ id: 'mastery-1', topicId: 'topic-communication', band: 'PROGRESSING', evidenceIds: ['evidence-1', 'evidence-2'] }],
    readiness: { id: 'readiness-1', band: 'DEVELOPING', advisory: true, employerVisible: false,
      explanation: { factors: [{ topicId: 'topic-communication', masteryBand: 'PROGRESSING',
        explanation: '2 active evidence records evaluated by career-readiness-mastery-v1' }] } },
  };
});

function supportAction(overrides: Partial<StudentStaffActionDto> = {}): StudentStaffActionDto {
  return {
    id: 'support-internal-id', actionType: 'ASSIGNED_TASK', title: 'Upload your placement preparation checklist',
    note: 'Use the checklist supplied by your college.', state: 'OPEN', dueAt: '2030-04-15T09:00:00Z',
    createdAt: '2030-04-01T09:00:00Z', updatedAt: '2030-04-01T09:00:00Z', version: 3,
    canComplete: true, responseNote: null, assignerRole: 'PLACEMENT_ADMIN', ...overrides,
  };
}

async function supportSection(): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: 'Support' });
  await waitFor(() => expect(within(section).queryByText('Loading your support…')).not.toBeInTheDocument());
  return section;
}

describe('Student support', () => {
  it('renders the assigned title, kind, role, due date and state from the student-scoped read', async () => {
    const action = supportAction();
    supportApi.list.mockResolvedValue({ actions: [action] });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(supportApi.current).toHaveBeenCalledWith('learner-token', expect.any(AbortSignal));
    expect(supportApi.list).toHaveBeenCalledWith('learner-token', 'student-institution', expect.any(AbortSignal));
    expect(within(section).getByRole('heading', { name: action.title })).toBeInTheDocument();
    expect(within(section).getByText('Assigned task')).toBeInTheDocument();
    expect(within(section).getByText('Assigned by your Placement Officer')).toBeInTheDocument();
    expect(section.querySelector('time')).toHaveAttribute('datetime', action.dueAt);
    expect(within(section).getByText('Open')).toBeInTheDocument();
    expect(within(section).getByText(action.note!)).toBeInTheDocument();
    expect(section.textContent).not.toContain(action.id);
    expect(section.textContent).not.toContain(action.assignerRole);
    expect(document.body.textContent).not.toContain('/100');
  });

  it('completes with the current version and response note, then shows persisted state after remount', async () => {
    let stored = supportAction();
    supportApi.list.mockImplementation(async () => ({ actions: [stored] }));
    supportApi.complete.mockImplementation(async (_token, _id, body) => {
      stored = { ...stored, state: 'COMPLETED', version: body.version + 1, canComplete: false, responseNote: body.responseNote };
      return { id: stored.id, state: stored.state, version: stored.version, responseNote: stored.responseNote, resolvedAt: '2030-04-02T10:00:00Z' };
    });
    const mounted = render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    const note = within(section).getByRole('textbox', { name: /Response note/ });
    expect(note).toHaveAttribute('maxlength', '2000');
    fireEvent.change(note, { target: { value: 'The checklist is complete and attached.' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Mark complete' }));
    expect(await within(section).findByText('Completion saved.')).toBeInTheDocument();
    expect(supportApi.complete).toHaveBeenCalledExactlyOnceWith('learner-token', stored.id,
      { version: 3, responseNote: 'The checklist is complete and attached.' }, expect.any(AbortSignal));
    expect(supportApi.list).toHaveBeenCalledTimes(2);
    expect(within(section).getByText('Completed')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    mounted.unmount();
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const reloaded = await supportSection();
    expect(within(reloaded).getByText('Completed')).toBeInTheDocument();
    expect(within(reloaded).getByText('Your response: The checklist is complete and attached.')).toBeInTheDocument();
    expect(within(reloaded).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it.each(['OPEN', 'COMPLETED', 'UNDER_REVIEW', 'ARCHIVED'])('keeps a server-declared read-only %s item free of action controls', async (state) => {
    supportApi.list.mockResolvedValue({ actions: [supportAction({ actionType: 'INTERVENTION', state, canComplete: false, dueAt: null })] });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(within(section).getByText('Intervention')).toBeInTheDocument();
    expect(within(section).getByText('Due: NA')).toBeInTheDocument();
    expect(within(section).getByText('Read-only — no student action is available for this item.')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(supportApi.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['INSTITUTION_ADMIN', 'Institution Administrator'], ['FACULTY_LECTURER', 'Faculty Lecturer'],
    ['DEPARTMENT_HEAD', 'Department Head'], ['INSTITUTION_OWNER', 'Institution Owner'],
  ])('labels the %s assigner as a role, not a person', async (assignerRole, label) => {
    supportApi.list.mockResolvedValue({ actions: [supportAction({ assignerRole })] });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    expect(within(await supportSection()).getByText(`Assigned by your ${label}`)).toBeInTheDocument();
  });

  it('keeps unknown role/state values and invalid dates out of the rendered text', async () => {
    supportApi.list.mockResolvedValue({ actions: [supportAction({ assignerRole: 'private-role-id', state: 'private-state-id', dueAt: 'invalid', canComplete: false })] });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(within(section).getByText('Assigned by your college')).toBeInTheDocument();
    expect(within(section).getByText('Due: NA')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/private-role-id|private-state-id|Invalid Date/);
  });

  it('shows only the counselling notes the college shared, with the writer role and no names or ids (INST-11)', async () => {
    counsellingApi.shared.mockResolvedValue({ notes: [{
      id: 'note-internal-id', title: 'Plan agreed together', note: 'Weekly check-in until exams.',
      createdAt: '2030-04-02T09:00:00Z', authorRole: 'DEPARTMENT_HEAD',
    }] });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(await within(section).findByText('Weekly check-in until exams.')).toBeInTheDocument();
    expect(counsellingApi.shared).toHaveBeenCalledWith('learner-token', 'student-institution', expect.any(AbortSignal));
    expect(within(section).getByText('Plan agreed together')).toBeInTheDocument();
    expect(within(section).getByText(/Shared by your department head/)).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/note-internal-id|DEPARTMENT_HEAD/);
  });

  it('says plainly when no counselling note has been shared, and NA when the read fails', async () => {
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    expect(await within(await supportSection()).findByText('Your college has not shared any counselling notes with you.')).toBeInTheDocument();
    cleanup();
    counsellingApi.shared.mockRejectedValue(new Error('internal stack trace'));
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(await within(section).findByText('NA — shared counselling notes are unavailable right now.')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/stack trace/);
  });

  it('plainly says when nothing has been assigned', async () => {
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(within(section).getByText('Nothing has been assigned to you yet.')).toBeInTheDocument();
    expect(within(section).queryByRole('list')).not.toBeInTheDocument();
  });

  it.each(['profile', 'list'])('degrades a %s failure to an honest empty state without upstream error text', async (failure) => {
    (failure === 'profile' ? supportApi.current : supportApi.list).mockRejectedValue(new Error('internal-id database stack trace'));
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    expect(within(section).getByText('No support items are available right now.')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/internal-id|stack trace|database/);
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    if (failure === 'profile') expect(supportApi.list).not.toHaveBeenCalled();
  });

  it('does not guess an institution when the protected profile is partial', async () => {
    supportApi.current.mockResolvedValue({ student: {} });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    expect(within(await supportSection()).getByText('No support items are available right now.')).toBeInTheDocument();
    expect(supportApi.list).not.toHaveBeenCalled();
  });

  it('refreshes a failed completion without falsely marking it complete or dumping the error', async () => {
    supportApi.list.mockResolvedValueOnce({ actions: [supportAction()] }).mockResolvedValue({ actions: [supportAction({ state: 'CANCELLED', version: 4, canComplete: false })] });
    supportApi.complete.mockRejectedValue(new Error('STALE_VERSION private-id database stack trace'));
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    fireEvent.click(within(section).getByRole('button', { name: 'Mark complete' }));
    expect(await within(section).findByText('Completion could not be confirmed. Review the refreshed item before trying again.')).toBeInTheDocument();
    expect(within(section).getByText('Cancelled')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(section.textContent).not.toMatch(/Completion saved|STALE_VERSION|private-id|stack trace/);
  });

  it('prevents duplicate submissions while completion is pending', async () => {
    supportApi.list.mockResolvedValue({ actions: [supportAction()] });
    let resolve!: (value: unknown) => void;
    supportApi.complete.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    const form = within(section).getByRole('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(supportApi.complete).toHaveBeenCalledTimes(1);
    expect(within(section).getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => resolve({ state: 'COMPLETED' }));
    expect(await within(section).findByText('Completion saved.')).toBeInTheDocument();
  });

  it('distinguishes a saved completion from an unavailable refreshed list', async () => {
    supportApi.list.mockResolvedValueOnce({ actions: [supportAction()] }).mockRejectedValue(new Error('private refresh failure'));
    supportApi.complete.mockResolvedValue({ state: 'COMPLETED' });
    render(<StudentDashboardV3 studentName="Aanya Rao" />);
    const section = await supportSection();
    fireEvent.click(within(section).getByRole('button', { name: 'Mark complete' }));
    expect(await within(section).findByText('Completion saved. Support could not be refreshed.')).toBeInTheDocument();
    expect(within(section).getByText('No support items are available right now.')).toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('discards the previous session’s support and aborts its pending request', async () => {
    let resolve!: (value: unknown) => void;
    supportApi.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue({ actions: [] });
    const mounted = render(<StudentDashboardV3 studentName="Aanya Rao" />);
    await waitFor(() => expect(supportApi.list).toHaveBeenCalledTimes(1));
    const signal = supportApi.list.mock.calls[0]![2] as AbortSignal;
    apiState.token = 'next-learner-token';
    mounted.rerender(<StudentDashboardV3 studentName="Next learner" />);
    expect(within(await supportSection()).getByText('Nothing has been assigned to you yet.')).toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ actions: [supportAction()] }));
    expect(screen.queryByText(supportAction().title)).not.toBeInTheDocument();
  });
});

afterEach(() => cleanup());

describe('StudentDashboardV3 readiness presentation', () => {
  it('highlights the real four-segment readiness band and shows evidence-derived factors without numeric scores', async () => {
    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    expect(await screen.findByRole('heading', { name: 'Career Readiness Band' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Developing readiness band' })).toBeInTheDocument();
    expect(screen.getByText('2. Developing (current)')).toBeInTheDocument();
    expect(screen.getByText('Professional Communication')).toBeInTheDocument();
    expect(screen.getByText('2 active evidence records')).toBeInTheDocument();
    expect(screen.getByText('2 active evidence records evaluated by career-readiness-mastery-v1')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/100');
  });

  it('keeps the band and mastery categories honestly unavailable when the engine has no projection', async () => {
    apiState.learner = { catalog, progress: [], attempts: [], evidence: [], mastery: [], readiness: null,
      roadmap: [], notificationPreferences: null, notifications: [] };

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    expect(await screen.findByText('No advisory band yet')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Readiness band unavailable' })).toBeInTheDocument();
    expect(screen.getAllByText('No mastery projection available.')).toHaveLength(5);
    expect(document.body.textContent).not.toContain('/100');
  });

  it('renders safely when career readiness returns a partial learner payload', async () => {
    apiState.learner = {};

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    expect(await screen.findByRole('heading', { name: 'Career Readiness Band' })).toBeInTheDocument();
    expect(screen.getByText('No advisory band yet')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Readiness band unavailable' })).toBeInTheDocument();
    expect(screen.getAllByText('No mastery projection available.')).toHaveLength(5);
    expect(document.body.textContent).not.toContain('/100');
  });
});

function historyPoint(band: string, generatedAt: string, id: string, modelVersionId = 'private-model-version') {
  return { id, band, generatedAt, modelVersionId };
}

function application(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'private-application-id', opportunityId: 'private-opportunity-id',
    title: 'Engineering placement', employerName: 'Recorded employer', state: 'SHORTLISTED',
    submittedAt: '2026-08-01T09:00:00Z', updatedAt: '2026-08-05T12:00:00Z',
    ...overrides,
  };
}

function exam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'private-exam-id', title: 'Recorded communication assessment',
    attemptsUsed: 2, attemptsAllowed: 3, openAttemptId: null, latestResult: null,
    startsAt: '2026-01-01T09:00:00Z', endsAt: '2026-01-02T09:00:00Z', durationSeconds: 1800,
    ...overrides,
  };
}

function expectUnavailableReports(reports: HTMLElement): void {
  for (const title of ['Readiness over time', 'Learning progress', 'Learning evidence', 'Assessment activity', 'Application activity']) {
    expect(within(reports).getByRole('heading', { name: title })).toBeInTheDocument();
  }
  for (const message of [
    'NA — no readiness history available.',
    'NA — no recorded lesson progress available.',
    'NA — no learning evidence available.',
    'NA — no career-readiness attempts available.',
    'NA — no assigned assessment activity available.',
    'NA — no application activity available.',
  ]) expect(within(reports).getByText(message)).toBeInTheDocument();
}

describe('StudentDashboardV3 student reports', () => {
  it('renders all four recorded bands newest first without numeric readiness or internal identifiers', async () => {
    const history = Object.freeze([
      historyPoint('READY_FOR_NEXT_STEP', '2026-08-01T09:00:00Z', 'private-snapshot-ready'),
      historyPoint('PROGRESSING', '2026-07-01T09:00:00Z', 'private-snapshot-progressing'),
      historyPoint('DEVELOPING', '2026-06-01T09:00:00Z', 'private-snapshot-developing'),
      historyPoint('NOT_ENOUGH_EVIDENCE', '2026-05-01T09:00:00Z', 'private-snapshot-insufficient'),
    ].map((point) => Object.freeze({ ...point, score: 87, percentage: 87 })));
    apiState.learner = { ...apiState.learner, readinessHistory: history };

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const reports = await screen.findByRole('region', { name: 'Your Reports' });
    expect(screen.getByRole('link', { name: 'View Full Report' })).toHaveAttribute('href', '#student-reports-title');
    const timeline = within(reports).getByRole('list', { name: 'Readiness band history, newest first' });
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    for (const [index, label] of ['Ready For Next Step', 'Progressing', 'Developing', 'Not Enough Evidence'].entries()) {
      expect(within(steps[index]!).getByText(label)).toBeInTheDocument();
      expect(steps[index]!.querySelector('time')).toHaveAttribute('datetime', history[index]!.generatedAt);
    }
    expect(history[0]!.band).toBe('READY_FOR_NEXT_STEP');
    expect(within(reports).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(timeline.querySelector('svg, canvas, [aria-valuenow], [aria-valuemin], [aria-valuemax]')).toBeNull();
    expect(reports.innerHTML).not.toMatch(/private-|87|\/\s*100|out of 100/i);
    expect(document.body.innerHTML).not.toContain('/100');
    expect(within(reports).getByText(/Readiness is advisory and is never shared with employers/)).toBeInTheDocument();
  });

  it('marks a changed model even when the band stays the same, without exposing model identifiers', async () => {
    apiState.learner = { ...apiState.learner, readinessHistory: [
      historyPoint('PROGRESSING', '2026-08-01T09:00:00Z', 'private-snapshot-latest', 'private-model-new'),
      historyPoint('PROGRESSING', '2026-07-01T09:00:00Z', 'private-snapshot-previous', 'private-model-old'),
      historyPoint('DEVELOPING', '2026-06-01T09:00:00Z', 'private-snapshot-oldest', 'private-model-old'),
    ] };

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const timeline = await screen.findByRole('list', { name: 'Readiness band history, newest first' });
    const steps = within(timeline).getAllByRole('listitem');
    const boundary = /Model version changed since the previous snapshot/;
    expect(within(steps[0]!).getByText(boundary)).toHaveTextContent('Bands across this change are not comparable.');
    expect(within(steps[1]!).queryByText(boundary)).not.toBeInTheDocument();
    expect(within(steps[2]!).queryByText(boundary)).not.toBeInTheDocument();
    expect(timeline.innerHTML).not.toContain('private-');
  });

  it.each([
    ['empty history', { readinessHistory: [] }],
    ['missing history', {}],
    ['partial nested readiness', { readiness: { band: 'DEVELOPING' } }],
  ])('keeps all report widgets honestly unavailable with %s', async (_scenario, learner) => {
    apiState.learner = learner;

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    expectUnavailableReports(await screen.findByRole('region', { name: 'Your Reports' }));
    expect(screen.getAllByText('No mastery projection available.')).toHaveLength(5);
    expect(document.body.innerHTML).not.toContain('/100');
  });

  it('shows recorded learning, evidence, assessment and own-application fields with truthful scope labels', async () => {
    apiState.learner = {
      ...apiState.learner,
      catalog: { ...catalog, modules: [{ id: 'private-module', title: 'Recorded learning module', lessons: [
        { id: 'private-lesson', title: 'Recorded listening lesson' },
      ] }] },
      progress: [{ lessonVersionId: 'private-lesson', state: 'COMPLETED',
        startedAt: '2026-07-01T09:00:00Z', completedAt: '2026-07-01T09:30:00Z' }],
      evidence: [{ id: 'private-evidence', topicId: 'topic-communication', evidenceType: 'LESSON_COMPLETION',
        occurredAt: '2026-07-01T09:30:00Z', demonstrated: 1, possible: 1 }],
      attempts: [{ id: 'private-career-attempt', state: 'SUBMITTED', startedAt: '2026-07-02T09:00:00Z',
        submittedAt: '2026-07-02T09:30:00Z', scoreCorrect: 87, scorePossible: 100 }],
    };
    apiState.exams = [exam({ openAttemptId: 'private-open-attempt' }),
      exam({ id: 'private-published-exam', title: 'Recorded completed assessment', latestResult: { score: 87, maxScore: 100, percentage: 87 } })];
    apiState.applications = [application()];

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const reports = await screen.findByRole('region', { name: 'Your Reports' });
    const learning = within(reports).getByRole('region', { name: 'Learning progress' });
    expect(within(learning).getByText('Recorded listening lesson')).toBeInTheDocument();
    expect(within(learning).getByText('Completed')).toBeInTheDocument();
    expect([...learning.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      '2026-07-01T09:00:00Z', '2026-07-01T09:30:00Z',
    ]);
    const evidence = within(reports).getByRole('region', { name: 'Learning evidence' });
    expect(within(evidence).getByText('Professional Communication')).toBeInTheDocument();
    expect(evidence.querySelector('time')).toHaveAttribute('datetime', '2026-07-01T09:30:00Z');
    const attempts = within(reports).getByRole('list', { name: 'Career-readiness assessment attempts' });
    expect(within(attempts).getByText('Submitted')).toBeInTheDocument();
    expect([...attempts.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      '2026-07-02T09:00:00Z', '2026-07-02T09:30:00Z',
    ]);
    const assigned = within(reports).getByRole('list', { name: 'Assigned assessment activity' });
    expect(within(assigned).getByText('Recorded communication assessment')).toBeInTheDocument();
    expect(within(assigned).getAllByText('Attempts used: 2 · Allowed: 3')).toHaveLength(2);
    expect(within(assigned).getByText('In progress')).toBeInTheDocument();
    expect(within(assigned).getByText('Published result available')).toBeInTheDocument();
    const applications = within(reports).getByRole('list', { name: 'Your application activity' });
    expect(within(applications).getByText('Engineering placement')).toBeInTheDocument();
    expect(within(applications).getByText('Recorded employer')).toBeInTheDocument();
    expect(within(applications).getByText('Shortlisted')).toBeInTheDocument();
    expect([...applications.querySelectorAll('time')].map((time) => time.dateTime)).toEqual([
      '2026-08-01T09:00:00Z', '2026-08-05T12:00:00Z',
    ]);
    expect(within(reports).getByText(/Latest available snapshots, newest first \(up to 100\)/)).toBeInTheDocument();
    expect(within(reports).getByText(/Attempts used excludes any attempt still in progress/)).toBeInTheDocument();
    expect(within(reports).getByText(/Available assignments ordered by start date \(up to 100\)/)).toBeInTheDocument();
    expect(within(reports).getByText(/up to 200.*This is not a lifetime total/)).toBeInTheDocument();
    expect(reports.innerHTML).not.toMatch(/private-|87|\/\s*100/);
  });

  it('uses NA for invalid dates, unavailable labels and unknown state codes without leaking their values', async () => {
    apiState.learner = {
      ...apiState.learner,
      readinessHistory: [{ id: 'private-snapshot', band: 'PRIVATE_UPSTREAM_STATE', generatedAt: 'private-invalid-date' }],
      progress: [{ lessonVersionId: 'private-missing-lesson', state: 'PRIVATE_UPSTREAM_STATE', startedAt: 'private-invalid-date' }],
      evidence: [{ id: 'private-evidence', topicId: 'private-missing-topic', occurredAt: 'private-invalid-date' }],
      attempts: [{ id: 'private-attempt', state: 'PRIVATE_UPSTREAM_STATE', startedAt: 'private-invalid-date' }],
    };
    apiState.applications = [application({ state: 'PRIVATE_UPSTREAM_STATE', title: '', employerName: '',
      submittedAt: 'private-invalid-date', updatedAt: null })];

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const reports = await screen.findByRole('region', { name: 'Your Reports' });
    const timeline = within(reports).getByRole('list', { name: 'Readiness band history, newest first' });
    expect(within(timeline).getByText('Model version unavailable; comparison unavailable.')).toBeInTheDocument();
    expect(within(timeline).getAllByText('NA')).toHaveLength(2);
    expect(within(reports).getByRole('list', { name: 'Recorded lesson progress' })).toHaveTextContent('Started: NA · Completed: NA');
    expect(within(reports).getByRole('list', { name: 'Career-readiness assessment attempts' })).toHaveTextContent('Started: NA · Submitted: NA');
    expect(within(reports).getByRole('list', { name: 'Your application activity' })).toHaveTextContent('Submitted: NA · Updated: NA');
    expect(reports.querySelector('time')).toBeNull();
    expect(reports.innerHTML).not.toMatch(/private-|PRIVATE_UPSTREAM_STATE|Invalid Date|NaN/);
  });

  it('isolates a failed application request from successful learner and assessment reports', async () => {
    apiState.applicationsError = 'upstream stack trace private-application-id';
    apiState.learner = { ...apiState.learner, readinessHistory: [
      historyPoint('PROGRESSING', '2026-08-01T09:00:00Z', 'private-snapshot'),
    ] };
    apiState.exams = [exam()];

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const reports = await screen.findByRole('region', { name: 'Your Reports' });
    expect(within(reports).getByRole('list', { name: 'Readiness band history, newest first' })).toBeInTheDocument();
    expect(within(reports).getByText('Recorded communication assessment')).toBeInTheDocument();
    expect(within(reports).getByText('NA — no application activity available.')).toBeInTheDocument();
    expect(reports.innerHTML).not.toContain('upstream stack trace');
  });

  it('keeps own applications visible when learner and assessment requests fail', async () => {
    apiState.learnerError = 'upstream learner stack private-learner-id';
    apiState.examsError = 'upstream assessment stack private-exam-id';
    apiState.applications = [application()];

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    const reports = await screen.findByRole('region', { name: 'Your Reports' });
    expect(within(reports).getByText('Engineering placement')).toBeInTheDocument();
    expect(within(reports).getByText('NA — no readiness history available.')).toBeInTheDocument();
    expect(within(reports).getByText('NA — no assigned assessment activity available.')).toBeInTheDocument();
    expect(reports.innerHTML).not.toMatch(/upstream|private-/);
  });

  it('does not request student data without an authenticated token', () => {
    apiState.token = null;

    render(<StudentDashboardV3 studentName="Aanya Rao" />);

    for (const request of [api.getStudentProfile, api.getLearnerCareerReadinessState, api.listStudentExams,
      api.listMyNotifications, api.getStudentActivity, api.listStudentApplications]) {
      expect(request).not.toHaveBeenCalled();
    }
    expect(screen.queryByRole('region', { name: 'Your Reports' })).not.toBeInTheDocument();
  });

  it('passes the authenticated token and an abortable signal to every report source', async () => {
    const view = render(<StudentDashboardV3 studentName="Aanya Rao" />);
    await screen.findByRole('region', { name: 'Your Reports' });

    for (const request of [api.getStudentProfile, api.getLearnerCareerReadinessState, api.listStudentExams,
      api.listMyNotifications, api.getStudentActivity, api.listStudentApplications]) {
      expect(request).toHaveBeenCalledExactlyOnceWith('learner-token', expect.any(AbortSignal));
    }
    const signal = vi.mocked(api.getLearnerCareerReadinessState).mock.calls[0]![1]!;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
