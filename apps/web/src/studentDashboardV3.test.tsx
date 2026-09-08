/**
 * ONE · Stream D — Learner
 * Owner: Santhosh · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Verifies the authenticated learner dashboard readiness-band presentation.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api.js';
import { StudentDashboardV3 } from './studentDashboardV3.js';

const apiState = vi.hoisted(() => ({
  token: 'learner-token' as string | null,
  learner: null as Record<string, unknown> | null,
  exams: [] as Record<string, unknown>[],
  applications: [] as Record<string, unknown>[],
  learnerError: null as string | null,
  examsError: null as string | null,
  applicationsError: null as string | null,
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
  apiState.learner = {
    catalog,
    progress: [], attempts: [], evidence: [], roadmap: [], notificationPreferences: null, notifications: [],
    mastery: [{ id: 'mastery-1', topicId: 'topic-communication', band: 'PROGRESSING', evidenceIds: ['evidence-1', 'evidence-2'] }],
    readiness: { id: 'readiness-1', band: 'DEVELOPING', advisory: true, employerVisible: false,
      explanation: { factors: [{ topicId: 'topic-communication', masteryBand: 'PROGRESSING',
        explanation: '2 active evidence records evaluated by career-readiness-mastery-v1' }] } },
  };
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
