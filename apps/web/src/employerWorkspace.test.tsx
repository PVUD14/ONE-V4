/**
 * Employer workspace resolution for owners, admins and recruiters (EMP-01, defect D-1).
 *
 * Operations invites the first employer user as an owner or admin, and before EMP-01
 * workspaceForMembership (App.tsx) mapped only RECRUITER to the employer portal, so that
 * first user landed on "No active ONE workspace" and every /employer deep link was denied.
 * These tests sign in through the real callback flow (style of auth.test.ts: resetModules
 * and a dynamic App import per test) and assert where each role lands. The RECRUITER and
 * institution-only cases are controls that must keep passing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jwtWithEmail(email: string): string {
  const payload = window.btoa(JSON.stringify({ email })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${payload}.signature`;
}

vi.setConfig({ testTimeout: 30000 });

const employerId = 'employer-1';
const institutionId = 'institution-1';
const opportunity = {
  id: 'opportunity-1', referenceCode: 'EMP01-FIXTURE', lifecycleState: 'DRAFT', title: 'Fixture Draft Role',
  employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: null, applicationDeadline: null,
  publishedAt: null, applicationCount: 0, openApplicationCount: 0,
};

let employerFeed: { notifications: Record<string, unknown>[]; unreadCount: number } = { notifications: [], unreadCount: 0 };

type Membership = { readonly organizationId: string; readonly role: string; readonly scope: Record<string, string> };

function employerMembership(role: string): Membership {
  return { organizationId: employerId, role, scope: { organizationId: employerId, employerId } };
}

function institutionMembership(role = 'INSTITUTION_ADMIN'): Membership {
  return { organizationId: institutionId, role, scope: { organizationId: institutionId, institutionId } };
}

function signInWith(email: string, memberships: readonly Membership[]): void {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://uat-auth.example.test/oauth2/token') return { ok: true, json: async () => ({ access_token: 'employer-token', id_token: jwtWithEmail(email) }) };
    if (url.endsWith('/health')) return { ok: true };
    if (url.endsWith('/api/v1/me/consents/privacy-notice')) return { ok: true, json: async () => ({ requiredVersion: null, grantedVersion: null, required: false }) };
    if (url.endsWith('/api/v1/security/context')) return { ok: true, json: async () => ({ userId: 'employer-user', memberships, studentRelationships: [] }) };
    // EMP-08: the employer's own notification feed (offer answers).
    if (url.endsWith('/api/v1/me/notifications')) return { ok: true, json: async () => employerFeed };
    if (url.endsWith('/api/v1/me/notifications/read-all')) return { ok: true, json: async () => ({ marked: employerFeed.unreadCount }) };
    if (url.endsWith(`/api/v1/employers/${employerId}/opportunities`)) return { ok: true, json: async () => ({ opportunities: [opportunity] }) };
    if (url.endsWith(`/api/v1/employers/${employerId}/team`)) return { ok: true, json: async () => ({ team: {
      actorRole: memberships.find((item) => item.organizationId === employerId)?.role, invitableRoles: ['RECRUITER'], deliveryConfigured: false,
      members: [{ membershipId: 'member-1', email: 'team.viewer@uat.example.test', role: 'EMPLOYER_OWNER', state: 'ACTIVE', since: null, isSelf: true, canEnd: false }],
      nextCursor: null, invitations: [], invitationsTruncated: false, reasonCodes: { revoke: [], resend: [], end: [] },
    } }) };
    return { ok: false };
  }));
}

beforeEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.pushState(null, '', '/login');
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('D-1: employer owners and admins resolve the employer workspace', () => {
  it.each(['EMPLOYER_ADMIN', 'EMPLOYER_OWNER'])('lands an %s in the employer workspace', async (role) => {
    signInWith('employer.admin@uat.example.test', [employerMembership(role)]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    expect(screen.queryByText('No active ONE workspace is available for this identity.')).not.toBeInTheDocument();
    expect((await screen.findAllByText(role)).length).toBeGreaterThan(0);
    // The portal is shared with recruiters, but the label names the role actually held.
    const roleName = role === 'EMPLOYER_OWNER' ? 'Employer Owner' : 'Employer Admin';
    expect(screen.getByText(`Signed in as ${roleName}`)).toBeInTheDocument();
    expect(screen.queryByText('Signed in as Recruiter')).not.toBeInTheDocument();
  });

  it('opens an employer deep link for an EMPLOYER_ADMIN', async () => {
    signInWith('employer.admin@uat.example.test', [employerMembership('EMPLOYER_ADMIN')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());

    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/opportunities');
    render(React.createElement(App));
    // Wait for the route to settle one way or the other, then assert the access decision
    // before the content, so a regression fails on the denial rather than on the fixture.
    const denied = { name: 'You do not have access to this workspace' };
    await waitFor(() => expect(screen.queryByRole('heading', denied) ?? screen.queryByText('Fixture Draft Role')).not.toBeNull());
    expect(screen.queryByRole('heading', denied)).not.toBeInTheDocument();
    expect(await screen.findByText('Fixture Draft Role')).toBeInTheDocument();
  });

  it('offers both workspaces to an employer admin who also administers an institution', async () => {
    signInWith('dual.admin@uat.example.test', [institutionMembership(), employerMembership('EMPLOYER_ADMIN')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    expect(await screen.findByRole('heading', { name: 'Choose your ONE workspace' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Employer/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Institution/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/auth/callback');
  });

  // Controls: these pass today and must keep passing after EMP-01.
  it('still lands a RECRUITER in the employer workspace', async () => {
    signInWith('recruiter@uat.example.test', [employerMembership('RECRUITER')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    expect((await screen.findAllByText('RECRUITER')).length).toBeGreaterThan(0);
  });

  it('keeps an institution-only identity out of the employer workspace', async () => {
    signInWith('institution.admin@uat.example.test', [institutionMembership()]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/institution/admin'));

    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/opportunities');
    render(React.createElement(App));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'You do not have access to this workspace' })).toBeInTheDocument());
    expect(screen.queryByText('Fixture Draft Role')).not.toBeInTheDocument();
  });
});

describe('EMP-01: employer workspace behaviour for each role', () => {
  it('opens one employer workspace for an owner who is also a recruiter of the same employer', async () => {
    signInWith('owner.recruiter@uat.example.test', [employerMembership('RECRUITER'), employerMembership('EMPLOYER_OWNER')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    expect(screen.queryByRole('heading', { name: 'Choose your ONE workspace' })).not.toBeInTheDocument();
  });

  async function openTeamAs(role: string): Promise<void> {
    signInWith('team.viewer@uat.example.test', [employerMembership(role)]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    cleanup();
    window.history.pushState(null, '', '/employer/recruiter/team');
    render(React.createElement(App));
  }

  it('tells a recruiter that Team is managed by the owner or admin', async () => {
    await openTeamAs('RECRUITER');
    expect(await screen.findByText('Managed by your owner or admin')).toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
  });

  // EMP-01 showed owners and admins the honest not-built state here; EMP-02 built Team.
  it.each(['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'])('shows Team to an %s as the live team screen', async (role) => {
    await openTeamAs(role);
    expect(await screen.findByText('team.viewer@uat.example.test (you)')).toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Managed by your owner or admin')).not.toBeInTheDocument();
  });
});

describe('EMP-08: an employer hears when a candidate answers an offer', () => {
  it('shows the latest notice from the feed when the bell is pressed, naming no candidate', async () => {
    employerFeed = { unreadCount: 1, notifications: [{ id: 'n-1', kind: 'OFFER_RESPONDED', title: 'Offer accepted: Fixture Draft Role',
      body: 'A candidate accepted your offer for Fixture Draft Role (EMP01-FIXTURE). Open Offers to see it and record the hire.',
      data: { screen: 'offers', opportunityTitle: 'Fixture Draft Role' }, createdAt: '2026-09-26T00:00:00.000Z', readAt: null }] };
    signInWith('recruiter@uat.example.test', [employerMembership('RECRUITER')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    (await screen.findByRole('button', { name: 'Notifications' })).click();
    expect(await screen.findByText(/Notifications: 1 unread\. Latest: Offer accepted: Fixture Draft Role — A candidate accepted your offer/)).toBeInTheDocument();
  });

  it('says plainly when there is nothing yet', async () => {
    employerFeed = { unreadCount: 0, notifications: [] };
    signInWith('recruiter@uat.example.test', [employerMembership('RECRUITER')]);
    const { App } = await import('./App.js');
    render(React.createElement(App));
    await waitFor(() => expect(window.location.pathname).toBe('/employer/recruiter'));
    (await screen.findByRole('button', { name: 'Notifications' })).click();
    expect(await screen.findByText('No notifications yet. You will be told here when a candidate accepts or declines an offer.')).toBeInTheDocument();
  });
});
