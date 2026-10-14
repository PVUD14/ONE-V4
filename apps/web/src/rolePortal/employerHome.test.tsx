/**
 * The employer's Hiring overview (EMP-15, re-skin phase 7). Its figures come from the server's
 * summary and nowhere else (checked by giving the lists different numbers); this week's interviews
 * are the server's window without cancelled ones; a block whose read fails is left out and nothing
 * prints "NA"; team controls appear only for owners and admins; and no readiness of any kind is
 * read, drawn or named anywhere on an employer screen (product rule 2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { EmployerDashboardV3 } from '../staffDashboardsV3.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));

const employerId = crypto.randomUUID();
const base = `/api/v1/employers/${employerId}`;
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });

const weekStart = new Date(Date.now() - 2 * 86_400_000);
const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
const summary = {
  openJobs: 3, newApplicantsLast7Days: 4, interviewsThisWeek: 2, offersPending: 1, drivesAwaitingApproval: 2, drivesChangesRequested: 1,
  applicationsTotal: 41, openApplications: 30, hires: 6,
  currentStages: { APPLIED: 12, SCREENING: 7, SHORTLISTED: 5, ASSESSMENT: 0, INTERVIEW: 3, OFFER: 1, HIRED: 6, REJECTED: 4, WITHDRAWN: 1 },
  week: { startsAt: weekStart.toISOString(), endsAt: weekEnd.toISOString() }, timeZone: 'Asia/Kolkata',
};
function interview(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(), applicationId: crypto.randomUUID(), applicationState: 'INTERVIEW', opportunityId: crypto.randomUUID(), referenceCode: 'R-1',
    title: 'Graduate engineer', consentRevoked: false, candidateAccess: true, candidateName: 'Asha Synthetic', candidateEmail: null, institutionStudentId: null,
    roundNumber: 1, mode: 'VIDEO', state: 'SCHEDULED', scheduledStart: new Date(weekStart.getTime() + 86_400_000).toISOString(), scheduledEnd: null,
    locationDetail: null, joiningLink: null, ...overrides,
  };
}
// Extra fields an over-sharing API might carry: none of them may ever reach an employer screen.
const leak = { readinessBand: 'READY_FOR_NEXT_STEP', band: 'PROGRESSING', readiness: { band: 'DEVELOPING' }, mastery: 0.82 };

function routes(options: { summaryStatus?: number; teamStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === `${base}/summary`) return options.summaryStatus ? ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-summary' } }, options.summaryStatus) : ok({ summary });
    if (path === `${base}/interviews`) {
      return ok({ interviews: [
        interview({ ...leak }),
        interview({ candidateAccess: false, candidateName: null, scheduledStart: new Date(weekStart.getTime() + 2 * 86_400_000).toISOString() }),
        interview({ state: 'CANCELLED', candidateName: 'Cancelled Person' }),
        interview({ candidateName: 'Next Week Person', scheduledStart: new Date(weekEnd.getTime() + 3_600_000).toISOString() }),
      ] });
    }
    if (path === `${base}/campus-drives`) return ok({ drives: [] });
    // Deliberately different numbers from the summary: the dashboard must not count these lists.
    if (path === `${base}/opportunities`) {
      return ok({ opportunities: [
        { id: 'job', title: 'Graduate engineer', referenceCode: 'GE-1', lifecycleState: 'PUBLISHED', applicationCount: 1, openApplicationCount: 1, employmentType: 'FULL_TIME', workMode: null, locationCity: 'Pune', applicationDeadline: null, publishedAt: null },
        { id: 'quiet', title: 'Firmware intern', referenceCode: 'FW-1', lifecycleState: 'PUBLISHED', applicationCount: 0, openApplicationCount: 0, employmentType: null, workMode: null, locationCity: null, applicationDeadline: null, publishedAt: null },
      ] });
    }
    if (path === `${base}/opportunities/job/applications`) {
      return ok({ applications: [{ id: 'a1', state: 'SHORTLISTED', candidateName: 'Bala Synthetic', consentRevoked: false, candidateAccess: true, updatedAt: '2026-10-01T00:00:00.000Z', ...leak }] });
    }
    if (path === `${base}/offers`) {
      return ok({ offers: [{ id: 'o1', applicationId: 'a9', applicationState: 'OFFER', title: 'Graduate engineer', state: 'EXTENDED', candidateName: 'Chitra Synthetic', candidateEmail: null, consentRevoked: false, candidateAccess: true, institutionStudentId: null, offerExpiresAt: null, extendedAt: '2026-10-02T00:00:00.000Z', ...leak }] });
    }
    if (path === `${base}/message-threads`) return ok({ threads: [], withheldCount: 0, nextCursor: null });
    if (path === `${base}/team`) {
      return options.teamStatus ? ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-team' } }, options.teamStatus) : ok({ team: {
        actorRole: 'EMPLOYER_OWNER', invitableRoles: ['RECRUITER'], deliveryConfigured: false, nextCursor: null, invitations: [], invitationsTruncated: false,
        reasonCodes: { revoke: [], resend: [], end: [] },
        members: [{ membershipId: 'm1', email: 'owner@uat.example.test', role: 'EMPLOYER_OWNER', state: 'ACTIVE', since: '2026-09-01T00:00:00.000Z', isSelf: true, canEnd: false }],
      } });
    }
    throw new Error('Unexpected request ' + path);
  });
}

function signInAs(role: string): void {
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role, scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  signInAs('RECRUITER');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/employer/recruiter');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const kpi = (label: string): HTMLElement => screen.getByText(label, { selector: '.ih-kl' }).closest('.ih-kpi') as HTMLElement;
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
const naPattern = /(^|[^A-Za-z])NA([^A-Za-z]|$)/;

describe('the employer Hiring overview', () => {
  it('shows the server summary in every figure, not counts of the lists it also reads', async () => {
    routes();
    render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
    expect(await screen.findByRole('heading', { name: 'Hiring overview' })).toBeInTheDocument();
    await screen.findByText('Open roles', { selector: '.ih-kl' });
    expect(within(kpi('Open roles')).getByText('3')).toBeInTheDocument();
    expect(within(kpi('Applicants')).getByText('41')).toBeInTheDocument();
    expect(within(kpi('Applicants')).getByText('4 new this week')).toBeInTheDocument();
    expect(within(kpi('In the pipeline')).getByText('30')).toBeInTheDocument();
    expect(within(kpi('Interviews')).getByText('2')).toBeInTheDocument();
    expect(within(kpi('Offer pending')).getByText('6 hired so far')).toBeInTheDocument();
    // The pipeline climb carries every stage, Applied → Hired, from the summary's current stages.
    const climb = screen.getByRole('list', { name: 'Applicants by stage' });
    expect(within(climb).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['12Applied', '7Screening', '5Shortlisted', '0Assessment', '3Interview', '1Offer', '6Hired']);
    // This week's interviews: the server's window, without cancelled ones or next week's.
    const interviews = card('Interviews this week');
    expect(within(interviews).getByText('2 scheduled')).toBeInTheDocument();
    expect(within(interviews).getByText('Asha Synthetic')).toBeInTheDocument();
    expect(within(interviews).getByText('Details no longer shared')).toBeInTheDocument();
    expect(within(interviews).queryByText('Cancelled Person')).toBeNull();
    expect(within(interviews).queryByText('Next Week Person')).toBeNull();
    // Named rows only through the lists, each while the applicant-access grant is live.
    expect(within(card('Recently shortlisted')).getByText('Bala Synthetic')).toBeInTheDocument();
    expect(within(card('Offers')).getByText('Chitra Synthetic')).toBeInTheDocument();
    // A live role nobody has applied to gets its calm empty state.
    expect(within(card('Firmware intern')).getByText('No applicants yet')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(naPattern);
  });

  it('leaves the figures out, with a plain line, when the summary cannot be read — and prints no NA', async () => {
    routes({ summaryStatus: 500 });
    render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
    expect(await screen.findByText(/Your hiring figures could not be loaded just now/)).toBeInTheDocument();
    expect(screen.queryByText('Open roles', { selector: '.ih-kl' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Applicant pipeline' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Interviews this week' })).toBeNull();
    // The lists that did load still show.
    expect(screen.getByRole('heading', { name: 'Open roles' })).toBeInTheDocument();
    expect(screen.queryByText('41')).toBeNull();
    expect(document.body.textContent).not.toMatch(naPattern);
  });
});

describe('owner-only controls on the Hiring overview', () => {
  it('gives a recruiter the lock note and no team controls, and never reads the team', async () => {
    routes();
    render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
    const team = await screen.findByRole('heading', { name: 'Team' });
    const section = team.closest('section') as HTMLElement;
    expect(within(section).getByTestId('owner-only-hint')).toHaveTextContent('Team and settings are managed by your owner or admin');
    expect(within(section).getByText('Owner manages')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Manage team/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/team'))).toBe(false);
  });

  for (const role of ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN']) {
    it(`gives an ${role} the team and the Manage team control`, async () => {
      signInAs(role);
      routes();
      render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
      const section = (await screen.findByText('owner@uat.example.test · you')).closest('section') as HTMLElement;
      expect(within(section).queryByTestId('owner-only-hint')).toBeNull();
      fireEvent.click(within(section).getByRole('button', { name: /Manage team/ }));
      expect(window.location.pathname).toBe('/employer/recruiter/team');
    });
  }

  it('shows no team list and no control to an owner when the team cannot be read', async () => {
    signInAs('EMPLOYER_OWNER');
    routes({ teamStatus: 500 });
    render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
    const section = (await screen.findByRole('heading', { name: 'Team' })).closest('section') as HTMLElement;
    expect(within(section).queryByRole('button', { name: /Manage team/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(naPattern);
  });
});

/** Every source file an employer can reach, including this phase's home. */
function employerFacingFiles(): string[] {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const shared = /^(hiringPages|talentPool|applicationSnapshotView|applicationMessages|skillEvidence|interviewScheduling|staffDashboardsV3|employerAssessmentsPage)\.tsx$/;
  return files.filter((path) => {
    const name = path.split(/[\\/]/).pop()!;
    return /employer|recruiter/i.test(name) || shared.test(name);
  });
}

describe('employers never see readiness (product rule 2)', () => {
  it('guards the Hiring overview along with every other employer file', () => {
    const names = employerFacingFiles().map((path) => path.split(/[\\/]/).pop());
    expect(names).toEqual(expect.arrayContaining(['employerHome.tsx', 'employer.tsx', 'hiringPages.tsx', 'talentPool.tsx', 'staffDashboardsV3.tsx', 'employerCandidateDetail.tsx']));
  });

  it('no employer file imports a readiness component, reads a readiness API or draws a readiness colour', () => {
    const forbidden: readonly [string, RegExp][] = [
      ['readiness band component', /momentum\/readinessBand|\bReadinessBand\b|READINESS_BAND/],
      ['band climb', /momentum\/bandClimb|\bBandClimb\b|CohortBandsCard/],
      ['readiness API', /api\/(cohortReadiness|careerReadiness)|getLearnerCareerReadinessState|getCohortReadiness/],
      ['readiness colour', /--band-[1-4]|\bbclimb\b|\brband\b/],
      ['readiness field', /\.readinessBand\b|\.readiness\.band\b|\.mastery\b/],
    ];
    const offenders = employerFacingFiles().flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return forbidden.filter(([, pattern]) => pattern.test(source)).map(([what]) => `${path.split(/[\\/]/).pop()}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  it('renders no readiness, band or mastery even when the API sends some', async () => {
    signInAs('EMPLOYER_OWNER');
    routes();
    render(<EmployerDashboardV3 basePath="/employer/recruiter" />);
    await screen.findByText('Bala Synthetic');
    const text = document.body.textContent ?? '';
    for (const word of [/readiness/i, /Ready For Next Step/i, /Progressing/i, /Developing/i, /Not Enough Evidence/i, /mastery/i, /\b82\s?%/]) {
      expect(text, String(word)).not.toMatch(word);
    }
    expect(document.querySelector('.rband, .bclimb, [class*="readiness"]')).toBeNull();
  });
});
