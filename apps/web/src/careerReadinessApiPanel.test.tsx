import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText(/No source database, event payload, recipient address, or secret/)).toBeInTheDocument();
  });
});

async function authenticateThroughHostedUiCallback(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
