import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicProfilePage } from './publicProfilePage.js';

const profile = {
  coverKey: 'MIDNIGHT',
  name: 'Rahul Kumar',
  headline: 'Security operations · Final-year B.Tech student',
  summary: 'Focused on security operations and incident response.',
  targetCareer: 'SOC Analyst',
  city: 'Bengaluru',
  institutionName: 'ABC Engineering College',
  expectedGraduation: '2026-06-30T00:00:00.000Z',
  photoUrl: null,
  portfolioUrl: 'https://example.test/rahul',
  skills: ['SIEM triage', 'Python'],
  education: [
    {
      programmeName: 'B.Tech, Computer Science and Engineering',
      qualificationType: 'BTECH',
      institutionName: 'ABC Engineering College',
      declaredInstitutionName: null,
      startedOn: '2022-08-01T00:00:00.000Z',
      completedOn: null,
      verified: true,
      terms: [{ label: 'Semester 6', result: '8.40 / 10', verified: true, verifiedAt: '2026-08-12T00:00:00.000Z' }],
    },
    {
      programmeName: 'Higher Secondary',
      qualificationType: 'OTHER',
      institutionName: null,
      declaredInstitutionName: "St. Mary's Junior College",
      startedOn: null,
      completedOn: null,
      verified: false,
      terms: [],
    },
  ],
  assessments: [{ title: 'Security Operations Fundamentals', percentage: 82, takenAt: '2026-05-04T00:00:00.000Z' }],
  learning: [{ title: 'Incident Response track', completedAt: '2026-06-02T00:00:00.000Z' }],
  certificates: [{ title: 'AWS Certified Cloud Practitioner' }],
  verifiedCount: 4,
  totalClaimCount: 6,
  expiresAt: '2026-12-12T00:00:00.000Z',
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubProfile(payload: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status: ok ? 200 : 404, json: async () => payload,
  })));
}

describe('the public profile a stranger sees', () => {
  it('renders without any access token at all', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ profile }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicProfilePage token="tok-123" />);
    expect(await screen.findByRole('heading', { name: 'Rahul Kumar', level: 1 })).toBeInTheDocument();
    // The one request in the app that deliberately carries no Authorization header.
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  it('never lets a verified record and a self-reported one look alike', async () => {
    stubProfile({ profile });
    render(<PublicProfilePage token="tok-123" />);
    expect(await screen.findByText('B.Tech, Computer Science and Engineering')).toBeInTheDocument();
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Self-reported').length).toBeGreaterThan(0);
    // And the reason the second one cannot be confirmed is stated, not implied.
    expect(screen.getByText(/St\. Mary's Junior College is not on ONE, so nobody can confirm this/)).toBeInTheDocument();
  });

  it('summarises with a count of facts, never a score', async () => {
    stubProfile({ profile });
    render(<PublicProfilePage token="tok-123" />);
    const panel = (await screen.findByRole('heading', { name: 'What is verified' })).closest('section')!;
    expect(within(panel).getByText(/of 6 items independently confirmed/)).toBeInTheDocument();
    // The summary is a count, so it carries no percentage at all.
    expect(panel.textContent).not.toMatch(/%/);
    // And nothing on the page is presented as a rating of the person. The words
    // "readiness" and "profile-strength" do appear -- in the list of what is refused --
    // so the check is for a heading that rates, not for the words themselves.
    expect(screen.queryByRole('heading', { name: /strength|match|rating/i })).not.toBeInTheDocument();
  });

  it('says plainly what it refuses to publish', async () => {
    stubProfile({ profile });
    render(<PublicProfilePage token="tok-123" />);
    expect(await screen.findByRole('heading', { name: 'Deliberately not here' })).toBeInTheDocument();
    expect(screen.getByText(/ONE does not rate people out of a hundred/)).toBeInTheDocument();
    expect(screen.getByText(/certificates and transcripts stay private/)).toBeInTheDocument();
  });

  it('tells a visitor the link is not live, rather than showing an error', async () => {
    stubProfile({ error: { code: 'PROFILE_NOT_AVAILABLE' } }, false);
    render(<PublicProfilePage token="tok-dead" />);
    await waitFor(() => expect(screen.getByText('This profile link is no longer live')).toBeInTheDocument());
    // The copy offers both possibilities without committing to either, so a visitor cannot
    // learn whether the link was revoked, expired, or never existed.
    expect(screen.getByText(/may have switched it off, or it may have expired/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not found|404|no such|invalid token/i);
  });

  it('shows initials when no photo is published', async () => {
    stubProfile({ profile });
    render(<PublicProfilePage token="tok-123" />);
    const avatar = await screen.findByText('RK');
    // Scoped to the avatar: the brand wordmark is itself three decorative <img> slices.
    expect(avatar.querySelector('img')).toBeNull();
  });

  it('leaves out a section the student did not publish', async () => {
    stubProfile({ profile: { ...profile, assessments: [], skills: [], portfolioUrl: null } });
    render(<PublicProfilePage token="tok-123" />);
    expect(await screen.findByRole('heading', { name: 'Education' })).toBeInTheDocument();
    // An unpublished section is absent, not an empty card explaining its own absence.
    expect(screen.queryByRole('heading', { name: 'Assessments sat on ONE' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Skills' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portfolio' })).not.toBeInTheDocument();
  });

  it('marks an outbound portfolio link so it carries no endorsement', async () => {
    stubProfile({ profile });
    render(<PublicProfilePage token="tok-123" />);
    const link = await screen.findByRole('link', { name: 'https://example.test/rahul' });
    expect(link).toHaveAttribute('rel', expect.stringContaining('nofollow'));
    expect(screen.getByText(/ONE does not check what is behind it/)).toBeInTheDocument();
  });
});
