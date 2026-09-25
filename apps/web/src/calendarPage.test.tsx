import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { CalendarPage } from './calendarPage.js';

const interview = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'INTERVIEW', title: 'Interview · SOC Analyst Intern',
  detail: 'Round 1 with Aster Mobility · video call',
  startsAt: '2026-09-20T04:30:00.000Z', endsAt: '2026-09-20T05:15:00.000Z',
  location: null, joinUrl: 'https://meet.example.test/abc', audience: 'STUDENT',
};

const deadline = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'ROADMAP', title: 'Finish lesson · Linux hardening',
  detail: 'Suggested next step',
  startsAt: '2026-09-21T18:30:00.000Z', endsAt: null,
  location: null, joinUrl: null, audience: 'STUDENT',
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('calendar', () => {
  it('groups what is already scheduled by day', async () => {
    stubCalendar([interview, deadline]);
    await authenticate();
    render(<CalendarPage />);
    expect(await screen.findByText('Interview · SOC Analyst Intern')).toBeInTheDocument();
    expect(screen.getByText('Finish lesson · Linux hardening')).toBeInTheDocument();
    // Two entries on different days produce two day sections, not one merged list.
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Join' })).toHaveAttribute('href', 'https://meet.example.test/abc');
  });

  it('says an empty calendar is empty instead of showing examples', async () => {
    stubCalendar([]);
    await authenticate();
    render(<CalendarPage />);
    expect(await screen.findByText(/Nothing is scheduled in the next few weeks/)).toBeInTheDocument();
    // Nothing to export, so nothing is offered.
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('offers the download only when there is something in it', async () => {
    stubCalendar([interview]);
    await authenticate();
    render(<CalendarPage />);
    expect(await screen.findByRole('button', { name: /Download for Outlook or Google Calendar/ })).toBeInTheDocument();
  });

  it('reports a failure instead of rendering an empty day list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
      return { ok: false, status: 500, json: async () => ({ error: { code: 'UPSTREAM', correlationId: 'c-1' } }) };
    }));
    await authenticate();
    render(<CalendarPage />);
    await waitFor(() => expect(screen.getByText('Your calendar could not be loaded.')).toBeInTheDocument());
    expect(screen.queryByText(/Nothing is scheduled/)).not.toBeInTheDocument();
  });

  it('shows a deadline as a moment rather than inventing a duration', async () => {
    stubCalendar([deadline]);
    await authenticate();
    render(<CalendarPage />);
    expect(await screen.findByText('Finish lesson · Linux hardening')).toBeInTheDocument();
    // An en-dash would mean a range; a deadline has only a start.
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();
  });
});

function stubCalendar(entries: readonly unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    return { ok: true, status: 200, json: async () => ({ entries, range: { from: '2026-09-13T00:00:00.000Z', to: '2026-11-12T00:00:00.000Z' } }) };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
