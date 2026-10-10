import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { CareerReadinessApiPanel } from './careerReadinessApiPanel.js';
import { OperationsCareerReadinessPanel } from './operationsCareerReadinessPanel.js';

const catalog = { pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release-1', modules: [], assessments: [] };
const learner = { catalog, progress: [], attempts: [], evidence: [], mastery: [], readiness: null,
  roadmap: [{ id: 'roadmap-1', topicId: 'topic-1', actionCode: 'COMPLETE_LESSON', reasonCode: 'MISSING_FOUNDATION', state: 'OPEN' }],
  notificationPreferences: { emailEnabled: true, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3 },
  notifications: [{ id: 'notification-1', templateKey: 'assessment-due', channel: 'EMAIL', legalPurpose: 'transactional assessment due reminder',
    state: 'PENDING', createdAt: '2026-08-18T12:00:00.000Z', expiresAt: '2026-08-19T12:00:00.000Z' }] };

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('API-backed Career Readiness surfaces', () => {
  it('renders explainable roadmap and native notification state without exposing a destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/oauth2/token') ? { access_token: 'test-access-token' } : url.endsWith('/catalog') ? catalog : learner })));
    await authenticateThroughHostedUiCallback();
    const { rerender } = render(<CareerReadinessApiPanel route="roadmap" />);
    expect(await screen.findByRole('heading', { name: 'Complete Lesson' })).toBeInTheDocument();
    expect(screen.getByText(/Reason: Missing Foundation/)).toBeInTheDocument();
    rerender(<CareerReadinessApiPanel route="notifications" />);
    expect(await screen.findByRole('heading', { name: 'Assessment-due' })).toBeInTheDocument();
    expect(screen.getByText(/Destinations stay server-side/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('@');
  });

  it('keeps Readiness about the advisory band and Skills about each skill, never a number', async () => {
    const topics = [{ id: 'topic-1', stableKey: 'networking', name: 'Networking basics', description: '' }, { id: 'topic-2', stableKey: 'siem', name: 'SIEM triage', description: '' }];
    const banded = { ...learner, catalog: { ...catalog, topics },
      evidence: [{ id: 'evidence-1', evidenceType: 'ASSESSMENT', topicId: 'topic-1', demonstrated: 3, possible: 4 }],
      mastery: [{ id: 'mastery-1', topicId: 'topic-1', band: 'PROGRESSING', evidenceIds: ['evidence-1'] }],
      readiness: { id: 'readiness-1', band: 'PROGRESSING', advisory: true, employerVisible: false,
        explanation: { factors: [{ topicId: 'topic-1', masteryBand: 'PROGRESSING', explanation: 'Assessment evidence on networking.' }] } },
      readinessHistory: [{ id: 'history-1', band: 'DEVELOPING', modelVersionId: 'model-2', generatedAt: '2026-09-01T00:00:00.000Z' }] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/oauth2/token') ? { access_token: 'test-access-token' } : url.endsWith('/catalog') ? { ...catalog, topics } : banded })));
    await authenticateThroughHostedUiCallback();
    const { rerender } = render(<CareerReadinessApiPanel route="readiness" />);
    expect(await screen.findByText('Current advisory band')).toBeInTheDocument();
    expect(screen.getByText('Assessment evidence on networking.', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Developing' })).toBeInTheDocument();
    expect(screen.queryByText('Skills in this pathway')).not.toBeInTheDocument();
    rerender(<CareerReadinessApiPanel route="skills" />);
    expect(await screen.findByText('Skills in this pathway')).toBeInTheDocument();
    expect(screen.getByText('Networking basics')).toBeInTheDocument();
    expect(screen.queryByText('Current advisory band')).not.toBeInTheDocument();
    expect(screen.queryByText('Advisory band')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
  });

  it('lets a student choose the lesson language; a lesson with no published version in it is shown in English with a notice (ENG-16)', async () => {
    const lesson = (id: string, over: Record<string, unknown>) => ({ id, stableKey: id, version: 1, topicId: 'topic-1', prerequisiteLessonIds: [], ...over });
    const telugu = {
      ...catalog,
      modules: [{ id: 'module-1', stableKey: 'module-1', version: 1, title: 'Synthetic module', description: '', lessons: [
        lesson('lesson-te', { title: 'సింథటిక్ పాఠం', body: { summary: 'సింథటిక్ సారాంశం' }, language: 'te', languageNotice: null }),
        lesson('lesson-en', { title: 'Synthetic English lesson', body: { summary: 'Synthetic English summary' }, language: 'en', languageNotice: 'TRANSLATION_MISSING' }),
        lesson('lesson-old', { title: 'పాత సింథటిక్ పాఠం', body: { summary: 'సారాంశం' }, language: 'te', languageNotice: 'TRANSLATION_OUTDATED' }),
      ] }],
    };
    const offered = [{ language: 'en', name: 'English', nativeName: 'English' }, { language: 'te', name: 'Telugu', nativeName: 'తెలుగు' }];
    const state = { ...learner, catalog: telugu, lessonLanguage: { selected: 'te', offered } };
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => ({ ok: true, json: async () => {
      if (url.endsWith('/oauth2/token')) return { access_token: 'test-access-token' };
      if (url.endsWith('/catalog')) return catalog;
      if (url.endsWith('/me/lesson-language')) return { lessonLanguage: { selected: JSON.parse(String(init?.body)).language, offered } };
      return state;
    } }));
    vi.stubGlobal('fetch', fetchMock);
    await authenticateThroughHostedUiCallback();
    render(<CareerReadinessApiPanel route="learning" />);
    const picker = await screen.findByLabelText('Lesson language');
    expect(picker).toHaveValue('te');
    expect(within(picker).getByRole('option', { name: 'తెలుగు · Telugu' })).toBeInTheDocument();
    const teluguTitle = screen.getByRole('heading', { name: 'సింథటిక్ పాఠం' });
    expect(teluguTitle).toHaveAttribute('lang', 'te');
    expect(teluguTitle.style.fontFamily).toContain('ONE Telugu');
    expect(screen.getByRole('heading', { name: 'Synthetic English lesson' })).toHaveAttribute('lang', 'en');
    expect(screen.getByText('Not yet available in Telugu. Shown in English.')).toBeInTheDocument();
    expect(screen.getByText(/The English lesson was updated after this Telugu version was written/)).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'en' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/career-readiness/me/lesson-language') && init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/me/lesson-language'))!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ language: 'en' });
    expect(await screen.findByText('Lessons are shown in English.')).toBeInTheDocument();
  });

  it('renders the restricted operations governance and automation summary from real APIs', async () => {
    const imports = [{ id: 'run-1', packageIdentity: 'v4-frozen-package', sourceRepository: 'https://github.com/PVUD14/V4--Database',
      sourceCommit: '0c067ce24f92662daa933edf0fc8b75636d99469', manifestHash: 'a'.repeat(64), transformVersion: 'v1', status: 'STAGED', blockedRecords: 11 }];
    const status = { releases: [{ id: 'release-1', name: 'Career Readiness Fundamentals', version: 1, manifestHash: 'b'.repeat(64), status: 'PUBLISHED' }],
      sourceGovernance: [], reviewQueue: [], outboxFailures: [], workflows: [{ id: 'workflow-1', allowlistId: 'assessment-due', version: 1,
        workflowHash: 'c'.repeat(64), operation: 'SEND_EMAIL', destinationClass: 'EMAIL', active: false, killSwitch: true }], automationCommands: [] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/oauth2/token') ? { access_token: 'test-access-token' } : url.endsWith('/imports') ? imports : status })));
    await authenticateThroughHostedUiCallback();
    render(<OperationsCareerReadinessPanel />);
    await waitFor(() => expect(screen.getByText('11 quarantined records.')).toBeInTheDocument());
    expect(screen.getByText('1 workflow')).toBeInTheDocument();
    expect(screen.getByText(/Source data, message contents, recipient addresses and secrets are never shown here/)).toBeInTheDocument();
  });
});

async function authenticateThroughHostedUiCallback(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
