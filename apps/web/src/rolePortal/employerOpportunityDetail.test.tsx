/**
 * The employer Opportunity Detail screen (EMP-05).
 *
 * The "Opportunity Detail" label rendered the same list as "Opportunities" until jobs could be
 * changed after publishing. These tests render it through the real route dispatcher for the
 * label, with the API stubbed at fetch, and check that it shows one job's state, audience,
 * current terms and version history as the server returned them, offers only the actions the
 * server lists, sends a reason code where one is needed, saves an edit as a new version against
 * the version it was based on, and reports refusals plainly. The navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));
// The Opportunities list reads its token from the hosted-login session.
vi.mock('../auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));

const employerId = crypto.randomUUID();
const jobId = crypto.randomUUID();
const versionOne = crypto.randomUUID();
const versionTwo = crypto.randomUUID();
const portal = rolePortals.find((item) => item.key === 'recruiter') ?? rolePortals[0]!;
const base = `/api/v1/employers/${employerId}/opportunities`;

const reasonCodes = {
  PAUSE: ['HIRING_ON_HOLD', 'REVIEWING_APPLICANTS', 'UPDATING_DETAILS'],
  CLOSE: ['POSITION_FILLED', 'ENOUGH_APPLICANTS', 'HIRING_ON_HOLD', 'ROLE_CANCELLED', 'POSTED_IN_ERROR'],
  REOPEN: [],
  WITHDRAW: ['POSTED_IN_ERROR', 'ROLE_CANCELLED', 'DUPLICATE_POSTING', 'TERMS_INCORRECT'],
};

function detailFor(state: string, actions: readonly string[]) {
  return {
    opportunity: {
      id: jobId, referenceCode: 'PLAT-01', lifecycleState: state, publishedAt: '2026-09-01T00:00:00Z', closedAt: null,
      createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', canEdit: state !== 'WITHDRAWN', availableActions: actions, reasonCodes,
      audiences: [{ kind: 'PUBLIC', institutionName: null, unitName: null }],
      applicationCount: 3, openApplicationCount: 2, awaitingAcknowledgementCount: 1,
      lastLifecycleChange: { action: 'opportunity.published', reasonCode: null, trigger: 'EMPLOYER', occurredAt: '2026-09-01T00:00:00Z' },
    },
    currentVersion: {
      id: versionTwo, versionNumber: 2, title: 'Platform engineer', summary: 'Build the platform.', responsibilities: null,
      employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Pune', positionsAvailable: 2, durationMonths: null,
      compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: '1000000.00', compensationMax: null, compensationPeriod: 'YEAR',
      joiningConditions: null, applicationDeadline: null, createdAt: '2026-09-20T00:00:00Z',
    },
    versions: [
      { id: versionTwo, versionNumber: 2, title: 'Platform engineer', createdAt: '2026-09-20T00:00:00Z', isCurrent: true, change: 'MATERIAL', changedTerms: ['compensationMin'] },
      { id: versionOne, versionNumber: 1, title: 'Platform engineer', createdAt: '2026-08-30T00:00:00Z', isCurrent: false, change: 'INITIAL', changedTerms: [] },
    ],
  };
}

let detail: ReturnType<typeof detailFor>;
let jobs: unknown[];
let failWith: { status: number; body: unknown } | null;

beforeEach(() => {
  detail = detailFor('PUBLISHED', ['PAUSE', 'CLOSE', 'WITHDRAW']);
  jobs = [{ id: jobId, referenceCode: 'PLAT-01', lifecycleState: 'PUBLISHED', title: 'Platform engineer', employmentType: 'FULL_TIME', workMode: 'ONSITE',
    locationCity: 'Pune', applicationDeadline: null, publishedAt: '2026-09-01T00:00:00Z', closedAt: null, versionNumber: 2, applicationCount: 3, openApplicationCount: 2 }];
  failWith = null;
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const requested = new URL(url, window.location.origin).pathname;
    if (init?.method === 'POST') {
      if (failWith) return response(failWith.body, failWith.status);
      if (requested === `${base}/${jobId}/close`) {
        detail = detailFor('CLOSED', ['REOPEN', 'WITHDRAW']);
        return response({ opportunity: { id: jobId, lifecycleState: 'CLOSED' } }, 201);
      }
      if (requested === `${base}/${jobId}/versions`) {
        return response({ version: { id: crypto.randomUUID(), versionNumber: 3, change: 'MATERIAL', changedTerms: ['compensationMin'] },
          applicants: { termChangesRecorded: 2, acknowledgementsRequired: 2 } }, 201);
      }
      throw new Error('Unexpected POST ' + requested);
    }
    if (requested === base) return response({ opportunities: jobs });
    if (requested === `${base}/${jobId}`) return response(detail);
    // EMP-11: the job's campus drives section (none for this job).
    if (requested === `/api/v1/employers/${employerId}/campus-drives`) return response({ drives: [] });
    throw new Error('Unexpected endpoint ' + requested);
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.history.pushState(null, '', '/'); });

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body, headers: new Headers() }; }
function show(label = 'Opportunity Detail') { return render(<EmployerRecruiterRealityPage portal={portal} routeLabel={label} />); }
function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> }));
}

describe('EMP-05 employer Opportunity Detail screen', () => {
  it('shows the job, its current terms and its version history as the server returned them', async () => {
    show();
    const state = await screen.findByRole('region', { name: 'Job state' });
    expect(within(state).getByText('Live: students who match its audience can see it and apply.')).toBeInTheDocument();
    expect(within(state).getByText(/Audience: All students/)).toBeInTheDocument();
    expect(within(state).getByText(/1 applicant\(s\) have not yet accepted the changed terms/)).toBeInTheDocument();
    expect(within(state).getAllByRole('button').map((button) => button.textContent)).toEqual(['Edit job', 'Pause', 'Close', 'Withdraw']);
    const terms = screen.getByRole('region', { name: 'Current terms' });
    expect(within(terms).getByText(`INR ${Number(1000000).toLocaleString()} / year`)).toBeInTheDocument();
    expect(within(terms).getByText('No deadline')).toBeInTheDocument();
    expect(within(terms).getAllByText('NA').length).toBeGreaterThan(0);
    const history = screen.getByRole('region', { name: 'Version history' });
    const rows = within(history).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows.map((row) => [row[0], row[3]])).toEqual([['2 · current', 'Pay'], ['1', 'First version']]);
  });

  it('closes with a chosen reason and shows the new state', async () => {
    show();
    const state = await screen.findByRole('region', { name: 'Job state' });
    fireEvent.click(within(state).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(state).getByRole('button', { name: 'Confirm: close' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a reason.');
    expect(posts()).toEqual([]);
    fireEvent.change(within(state).getByRole('combobox'), { target: { value: 'POSITION_FILLED' } });
    fireEvent.click(within(state).getByRole('button', { name: 'Confirm: close' }));
    expect(await screen.findByText('Job closed.')).toBeInTheDocument();
    expect(posts()).toEqual([{ path: `${base}/${jobId}/close`, body: { reasonCode: 'POSITION_FILLED' } }]);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Job state' })).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Edit job', 'Reopen', 'Withdraw']));
  });

  it('saves an edit as a new version against the version it was based on, and says who must accept it', async () => {
    show();
    fireEvent.click(within(await screen.findByRole('region', { name: 'Job state' })).getByRole('button', { name: 'Edit job' }));
    const form = screen.getByRole('form', { name: 'Edit job' });
    expect(within(form).getByLabelText('Title')).toHaveValue('Platform engineer');
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '900000' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText(/Saved as version 3\. Changed: Pay\. 2 applicants must accept the new terms before you can move them on\./)).toBeInTheDocument();
    const [post] = posts();
    expect(post!.path).toBe(`${base}/${jobId}/versions`);
    expect(post!.body).toMatchObject({ expectedCurrentVersionId: versionTwo, title: 'Platform engineer', compensationDisclosed: true, compensationMin: 900000, locationCity: 'Pune', applicationDeadline: null });
  });

  it('reports a conflicting edit plainly, with a reference', async () => {
    failWith = { status: 409, body: { error: { code: 'OPPORTUNITY_VERSION_CONFLICT', correlationId: 'corr-409' } } };
    show();
    fireEvent.click(within(await screen.findByRole('region', { name: 'Job state' })).getByRole('button', { name: 'Edit job' }));
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit job' })).getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone saved a newer version of this job while you were editing. Reload it and make your change again. Support code: corr409');
  });

  it('says there are no jobs instead of showing any', async () => {
    jobs = [];
    show();
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
  });

  it('refuses a suspended employer plainly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'EMPLOYER_ORGANISATION_INACTIVE', correlationId: 'corr-403' } }, 403)));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your employer account is suspended or was not approved, so your jobs are not available. Support code: corr403');
  });

  it('keeps Opportunities as the list, now linking each job to its detail', async () => {
    show('Opportunities');
    expect(await screen.findByRole('heading', { name: 'Your opportunities' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(window.location.pathname).toBe('/employer/recruiter/opportunity-detail');
    expect(window.location.search).toBe(`?opportunity=${jobId}`);
    const labels = portal.nav.map((item) => item.label);
    expect(labels.slice(labels.indexOf('Opportunities'), labels.indexOf('Opportunities') + 2)).toEqual(['Opportunities', 'Opportunity Detail']);
  });
});
