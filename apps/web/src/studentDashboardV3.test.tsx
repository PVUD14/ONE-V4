/**
 * ONE · Stream D — Learner
 * Owner: Santhosh · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Verifies the authenticated learner dashboard readiness-band presentation.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentDashboardV3 } from './studentDashboardV3.js';

const apiState = vi.hoisted(() => ({ learner: null as Record<string, unknown> | null }));

vi.mock('./api.js', () => ({
  getProtectedAccessToken: () => 'learner-token',
  getStudentProfile: async () => ({ profile: null }),
  getLearnerCareerReadinessState: async () => apiState.learner,
  listStudentExams: async () => ({ assessments: [] }),
  listMyNotifications: async () => ({ notifications: [], unreadCount: 0 }),
  getStudentActivity: async () => ({ currentStreakDays: 0, activeDaysLast7: 0, last7: [] }),
}));

const catalog = {
  pilot: 'Career Readiness Fundamentals',
  releaseManifestId: 'release-1',
  topics: [{ id: 'topic-communication', stableKey: 'professional-communication', name: 'Professional Communication', description: 'Clear workplace communication.' }],
  modules: [],
  assessments: [],
};

beforeEach(() => {
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
});
