import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

function jwtWithEmailAndExpiry(email: string): string {
  const payload = window.btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

beforeEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('amazon-cognito-identity-js');
  vi.resetModules();
  window.history.pushState(null, '', '/login');
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('amazon-cognito-identity-js');
  vi.resetModules();
  window.history.pushState(null, '', '/login');
});

describe('Cognito Hosted UI browser authentication', () => {
  it('passes the visible ONE email and password fields into Cognito SRP without storing the password', async () => {
    const captured: { username?: string; password?: string; flow?: string } = {};
    vi.doMock('amazon-cognito-identity-js', () => ({
      AuthenticationDetails: class {
        readonly Username: string;
        readonly Password: string;
        constructor(input: { Username: string; Password: string }) {
          captured.username = input.Username;
          captured.password = input.Password;
          this.Username = input.Username;
          this.Password = input.Password;
        }
      },
      CognitoUserPool: class {
        constructor(readonly input: unknown) {}
      },
      CognitoRefreshToken: class {
        constructor(readonly input: unknown) {}
      },
      CognitoUser: class {
        constructor(readonly input: { Username: string }) {}
        setAuthenticationFlowType(flow: string): void { captured.flow = flow; }
        authenticateUser(_details: unknown, callbacks: { onSuccess: (session: unknown) => void }): void {
          callbacks.onSuccess({
            getAccessToken: () => ({ getJwtToken: () => jwtWithEmailAndExpiry('student.aanya@uat.example.test'), getExpiration: () => Math.floor(Date.now() / 1000) + 3600 }),
            getIdToken: () => ({ getJwtToken: () => jwtWithEmail('student.aanya@uat.example.test') }),
            getRefreshToken: () => ({ getToken: () => 'refresh-token' }),
          });
        }
        refreshSession(): void {}
      },
    }));
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_uatpool');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) {
        expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
        return { ok: true, json: async () => ({ userId: 'student-user', memberships: [], studentRelationships: [{ institutionId: 'institution-1', state: 'ACTIVE', effectiveFrom: '2026-08-21T00:00:00.000Z' }] }) };
      }
      if (url.endsWith('/api/v1/students/me')) return { ok: true, json: async () => ({ student: { userId: 'student-user', verifiedEmail: 'student.aanya@uat.example.test', fullName: 'Aanya Rao', institutionStudentId: 'UAT-S-001', institutionId: 'institution-1', academicStatus: 'ACTIVE' } }) };
      if (url.endsWith('/api/v1/career-readiness/catalog')) return { ok: true, json: async () => ({ pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release', modules: [], assessments: [] }) };
      if (url.endsWith('/api/v1/career-readiness/me')) return { ok: true, json: async () => ({ catalog: {}, progress: [], attempts: [], evidence: [], mastery: [], readiness: null, roadmap: [], notificationPreferences: null, notifications: [] }) };
      return { ok: false };
    }));
    window.history.pushState(null, '', '/login');
    const { App } = await import('./App.js');
    render(React.createElement(App));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'student.aanya@uat.example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(window.location.pathname).toBe('/student'));
    expect(captured).toMatchObject({ username: 'student.aanya@uat.example.test', password: 'Correct-Horse-1', flow: 'USER_SRP_AUTH' });
    expect(JSON.stringify(window.sessionStorage)).not.toContain('Correct-Horse-1');
    expect(window.localStorage.length).toBe(0);
  });

  it('keeps sign-in disabled when non-production Cognito is not configured', async () => {
    const { App } = await import('./App.js');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    render(React.createElement(App));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByText('ONE PLATFORM')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByText('Secure sign-in is not available in this UAT environment yet.')).toBeInTheDocument();
  });

  it('saves authenticated Student profile fields through the protected API', async () => {
    vi.doMock('amazon-cognito-identity-js', () => ({
      AuthenticationDetails: class {
        constructor(readonly input: { Username: string; Password: string }) {}
      },
      CognitoUserPool: class {
        constructor(readonly input: unknown) {}
      },
      CognitoRefreshToken: class {
        constructor(readonly input: unknown) {}
      },
      CognitoUser: class {
        constructor(readonly input: { Username: string }) {}
        setAuthenticationFlowType(): void {}
        authenticateUser(_details: unknown, callbacks: { onSuccess: (session: unknown) => void }): void {
          callbacks.onSuccess({
            getAccessToken: () => ({ getJwtToken: () => jwtWithEmailAndExpiry('student.aanya@uat.example.test'), getExpiration: () => Math.floor(Date.now() / 1000) + 3600 }),
            getIdToken: () => ({ getJwtToken: () => jwtWithEmail('student.aanya@uat.example.test') }),
            getRefreshToken: () => ({ getToken: () => 'refresh-token' }),
          });
        }
        refreshSession(): void {}
      },
    }));
    const profileRequests: unknown[] = [];
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_uatpool');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({ userId: 'student-user', memberships: [], studentRelationships: [{ institutionId: 'institution-1', state: 'ACTIVE', effectiveFrom: '2026-08-21T00:00:00.000Z' }] }) };
      if (url.endsWith('/api/v1/students/me')) return { ok: true, json: async () => ({ student: { userId: 'student-user', verifiedEmail: 'student.aanya@uat.example.test', fullName: 'Aanya Rao', institutionStudentId: 'UAT-S-001', institutionId: 'institution-1', academicStatus: 'ACTIVE' } }) };
      if (url.endsWith('/api/v1/students/me/profile') && (!init?.method || init.method === 'GET')) return { ok: true, json: async () => ({ profile: { userId: 'student-user', verifiedEmail: 'student.aanya@uat.example.test', targetCareer: null, careerInterests: [], profileHeadline: null, profileSummary: null, portfolioUrl: null, visibilityState: 'PRIVATE', employerDiscoveryEnabled: false, updatedAt: null } }) };
      if (url.endsWith('/api/v1/students/me/profile') && init?.method === 'PATCH') {
        profileRequests.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ profile: { userId: 'student-user', verifiedEmail: 'student.aanya@uat.example.test', targetCareer: 'Security Analyst', careerInterests: ['SOC'], profileHeadline: 'Security learner', profileSummary: 'Evidence-backed learner', portfolioUrl: null, visibilityState: 'INSTITUTION_VISIBLE', employerDiscoveryEnabled: false, updatedAt: '2026-08-22T00:00:00Z' } }) };
      }
      if (url.endsWith('/api/v1/career-readiness/catalog')) return { ok: true, json: async () => ({ pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release', modules: [], assessments: [] }) };
      if (url.endsWith('/api/v1/career-readiness/me')) return { ok: true, json: async () => ({ catalog: {}, progress: [], attempts: [], evidence: [], mastery: [], readiness: null, roadmap: [], notificationPreferences: null, notifications: [] }) };
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'student.aanya@uat.example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(window.location.pathname).toBe('/student'));
    window.history.pushState(null, '', '/student/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Student-owned profile' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Target career'), { target: { value: 'Security Analyst' } });
    fireEvent.change(screen.getByLabelText('Headline'), { target: { value: 'Security learner' } });
    fireEvent.change(screen.getByLabelText('Career interests, comma separated'), { target: { value: 'SOC' } });
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Evidence-backed learner' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'INSTITUTION_VISIBLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(screen.getByText('Profile saved.')).toBeInTheDocument());
    expect(profileRequests[0]).toMatchObject({ targetCareer: 'Security Analyst', careerInterests: ['SOC'], visibilityState: 'INSTITUTION_VISIBLE' });
    expect(JSON.stringify(profileRequests[0])).not.toContain('studentUserId');
  });

  it('exchanges a Hosted UI authorization code and uses the returned access token for protected API calls', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') {
        expect(String(init?.body)).toContain('code_verifier=verifier-12345678901234567890');
        return { ok: true, json: async () => ({ access_token: 'uat-access-token', id_token: jwtWithEmail('aanya.student01@example.test') }) };
      }
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer uat-access-token');
        return { ok: true, json: async () => ({ userId: 'student-user-1', memberships: [], studentRelationships: [{ institutionId: 'institution-1', state: 'ACTIVE', effectiveFrom: '2026-08-21T00:00:00.000Z' }] }) };
      }
      if (url.endsWith('/api/v1/students/me')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer uat-access-token');
        return { ok: true, json: async () => ({ student: { userId: 'student-user-1', verifiedEmail: 'aanya.student01@example.test', fullName: 'Aanya Rao', institutionStudentId: 'UAT-S-001', institutionId: 'institution-1', academicStatus: 'ACTIVE', department: 'CSE', program: 'BTech', batch: '2027', section: 'A' } }) };
      }
      if (url.endsWith('/api/v1/career-readiness/catalog')) return { ok: true, json: async () => ({ pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release', modules: [], assessments: [] }) };
      if (url.endsWith('/api/v1/career-readiness/me')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer uat-access-token');
        return { ok: true, json: async () => ({ catalog: {}, progress: [], attempts: [], evidence: [], mastery: [], readiness: null, roadmap: [], notificationPreferences: null, notifications: [] }) };
      }
      return { ok: false };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    expect(screen.getByText('aanya.student01@example.test')).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/student'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Student profile menu' })).toHaveTextContent('Aanya Rao'));
    expect(screen.getByText('Authenticated Student workspace')).toBeInTheDocument();
    expect(screen.getByText('Real Student identity')).toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
    expect(screen.queryByText('DEMO PREVIEW')).not.toBeInTheDocument();
    expect(screen.queryByText('/100')).not.toBeInTheDocument();
    window.history.pushState(null, '', '/student/readiness');
    render(React.createElement(App));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/career-readiness/me'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer uat-access-token' }),
    })));
    expect(window.sessionStorage.getItem('planthepath.accessToken')).toBeNull();
  });

  it('ignores legacy access-token fragments and requires authorization-code PKCE', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    window.history.pushState(null, '', '/auth/callback#access_token=injected-token');
    const { completeHostedLoginFromLocation, getAccessToken } = await import('./auth.js');
    await expect(completeHostedLoginFromLocation()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('strips invitation token query strings from OAuth return paths', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.sessionStorage.setItem('planthepath.oauthReturnPath', '/invitations/accept?token=raw-invite-token');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'uat-access-token' }) })));
    const { completeHostedLoginFromLocation } = await import('./auth.js');
    await expect(completeHostedLoginFromLocation()).resolves.toBe(true);
    expect(window.location.pathname).toBe('/invitations/accept');
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem('planthepath.oauthReturnPath')).toBeNull();
  });

  it('routes an Institution Admin by verified membership and denies Student deep links', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'institution-token', id_token: jwtWithEmail('institution.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({
        userId: 'institution-user',
        memberships: [{ organizationId: 'institution-1', role: 'INSTITUTION_ADMIN', scope: {} }],
        studentRelationships: [],
      }) };
      return { ok: false };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/institution/admin'));
    await waitFor(() => expect(screen.getAllByText('institution.admin@uat.example.test').length).toBeGreaterThan(0));
    expect(screen.getByText('INSTITUTION_ADMIN')).toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();

    window.history.pushState(null, '', '/student');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'You do not have access to this workspace' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Student Dashboard' })).not.toBeInTheDocument();
  });

  it('selects role-specific landings instead of routing every institution role to admin', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'placement-token', id_token: jwtWithEmail('placement.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({
        userId: 'placement-user',
        memberships: [{ organizationId: 'institution-1', role: 'PLACEMENT_ADMIN', scope: {} }],
        studentRelationships: [],
      }) };
      return { ok: false };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/institution/placement-officer'));
    expect(screen.queryByRole('heading', { name: 'Institution Administration' })).not.toBeInTheDocument();
  });

  it('keeps demo fixture identities out of authenticated role shells while preserving demo routes', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'recruiter-token', id_token: jwtWithEmail('recruiter@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({
        userId: 'recruiter-user',
        memberships: [{ organizationId: 'employer-1', role: 'RECRUITER', scope: {} }],
        studentRelationships: [],
      }) };
      return { ok: false };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    expect(screen.getAllByText('recruiter@uat.example.test').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rohan Shah')).not.toBeInTheDocument();
    expect(screen.queryByText(/role selection here does not authenticate/i)).not.toBeInTheDocument();

    cleanup();
    window.history.pushState(null, '', '/demo/employer/recruiter');
    render(React.createElement(App));
    expect(screen.getByText('Rohan Shah')).toBeInTheDocument();
    expect(screen.getAllByText('DEMO PREVIEW').length).toBeGreaterThan(0);
  });

  it('routes Operations Admin to operations without a Student fallback', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'operations-token', id_token: jwtWithEmail('operations.admin@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({
        userId: 'operations-user',
        memberships: [{ organizationId: 'operations-org', role: 'OPERATIONS_ADMIN', scope: {} }],
        studentRelationships: [],
      }) };
      return { ok: false };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/operations/admin'));
    expect(screen.getByText('OPERATIONS_ADMIN')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Student Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
  });

  it('shows a safe correlation reference when security context is rejected', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'rejected-token', id_token: jwtWithEmail('unmapped@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return {
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({ message: { code: 'FORBIDDEN', correlationId: 'ctx-ref-123456' } }),
      };
      return { ok: false };
    }));
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not load your ONE workspace. Reference: ctx-ref-123456'));
    expect(screen.queryByRole('heading', { name: 'Student Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Rahul Kumar')).not.toBeInTheDocument();
    expect(screen.queryByText('ONE could not resolve an active workspace for this identity.')).not.toBeInTheDocument();
  });

  it('signs out through Cognito logout, returns to /login, and clears transient auth state', async () => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
    vi.stubEnv('VITE_COGNITO_LOGOUT_URI', 'http://127.0.0.1:5173/login');
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'student-token', id_token: jwtWithEmail('student.aanya@uat.example.test') }) };
      if (url.endsWith('/health')) return { ok: true };
      if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({
        userId: 'student-user',
        memberships: [],
        studentRelationships: [{ institutionId: 'institution-1', state: 'ACTIVE', effectiveFrom: '2026-08-21T00:00:00.000Z' }],
      }) };
      if (url.endsWith('/api/v1/career-readiness/catalog')) return { ok: true, json: async () => ({ pilot: 'Career Readiness Fundamentals', releaseManifestId: 'release', modules: [], assessments: [] }) };
      if (url.endsWith('/api/v1/career-readiness/me')) return { ok: true, json: async () => ({ catalog: {}, progress: [], attempts: [], evidence: [], mastery: [], readiness: null, roadmap: [], notificationPreferences: null, notifications: [] }) };
      return { ok: false };
    }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, origin: 'http://127.0.0.1:5173', pathname: '/student', search: '' } });
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(assign).toHaveBeenCalledWith('https://uat-auth.example.test/logout?client_id=uat-client&logout_uri=http%3A%2F%2F127.0.0.1%3A5173%2Flogin');
    const { getAccessToken } = await import('./auth.js');
    expect(getAccessToken()).toBeNull();
    expect(window.sessionStorage.getItem('planthepath.oauthState')).toBeNull();
    expect(window.sessionStorage.getItem('planthepath.oauthVerifier')).toBeNull();
    expect(window.sessionStorage.getItem('planthepath.oauthReturnPath')).toBeNull();
  });
});
