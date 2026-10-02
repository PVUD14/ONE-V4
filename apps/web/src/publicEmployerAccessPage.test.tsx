/**
 * The public "request employer access" page and its Operations queue (EMP-04).
 *
 * The page renders without a session, carries the AI8HT wordmark, sends exactly the four
 * fields, and confirms without saying whether anything exists on ONE. The queue on the
 * Organizations screen shows pending requests with their review signals and records a
 * decision only with a reason, and only links — never creates or verifies — an employer.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, type EmployerAccessRequestDto, type OrganizationManagementDto } from './api.js';
import { PublicEmployerAccessPage } from './publicEmployerAccessPage.js';
import { EmployerAccessRequestsSection } from './rolePortal/operationsEmployerAccessRequests.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(),
}));

let failWith: { status: number; body: unknown } | null;
let queue: EmployerAccessRequestDto[];

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body, headers: new Headers() }; }
function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as unknown, auth: (init!.headers as Record<string, string>).Authorization }));
}

const requestId = crypto.randomUUID();
const employerOrgId = crypto.randomUUID();

beforeEach(() => {
  failWith = null;
  queue = [{
    id: requestId, requesterName: 'Priya Raman', companyName: 'Aster Mobility', workEmail: 'priya@aster.example', emailDomain: 'aster.example',
    websiteUrl: 'https://www.aster.example', emailMatchesWebsite: true, freeMail: false, emailConfirmed: false, state: 'PENDING', organizationId: null,
    decisionReasonCode: null, decidedAt: null, submissionCount: 2, createdAt: '2026-09-24T00:00:00Z', lastSubmittedAt: '2026-09-25T00:00:00Z',
    possibleMatches: [{ organizationId: employerOrgId, legalName: 'Aster Mobility Private Limited', verificationState: 'PENDING' }],
  }];
  vi.mocked(getProtectedAccessToken).mockReturnValue('ops-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    if (failWith) return response(failWith.body, failWith.status);
    if (path === '/api/v1/employer-access-requests' && init?.method === 'POST') return response({ received: true, correlationId: 'c-1' }, 202);
    if (path === '/api/v1/operations/employer-access-requests') return response({ requests: queue, nextCursor: null, reasonCodes: { ONBOARDED: ['ORGANISATION_CREATED'], DECLINED: ['NOT_AN_EMPLOYER'], SPAM: ['BULK_SUBMISSION'] } });
    if (path === `/api/v1/operations/employer-access-requests/${requestId}/decision`) { queue = []; return response({ request: { id: requestId, state: 'ONBOARDED' } }, 201); }
    throw new Error('Unexpected endpoint ' + path);
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('EMP-04 public employer access request page', () => {
  function fill() {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: ' Priya Raman ' } });
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Aster Mobility' } });
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'priya@aster.example' } });
    fireEvent.change(screen.getByLabelText('Company website'), { target: { value: 'https://www.aster.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  }

  it('carries the ONE logo, sends the four fields without a session, and promises nothing', async () => {
    render(<PublicEmployerAccessPage onNavigate={() => undefined} />);
    expect(screen.getByRole('img', { name: 'ONE by AI8HT' })).toHaveAttribute('src', '/assets/one-logo-light.png');
    fill();
    expect(await screen.findByText('Thank you. Your request has been received.')).toBeInTheDocument();
    expect(screen.getByText(/No account has been created and nothing has been published/)).toBeInTheDocument();
    expect(posts()).toEqual([{ path: '/api/v1/employer-access-requests', auth: undefined,
      body: { requesterName: 'Priya Raman', companyName: 'Aster Mobility', workEmail: 'priya@aster.example', websiteUrl: 'https://www.aster.example' } }]);
  });

  it('passes the code of a referral link on with the request and shows nothing about it (GROWTH-05)', async () => {
    window.history.pushState({}, '', '/employer-access?ref=ABCDEFGHJK');
    try {
      render(<PublicEmployerAccessPage onNavigate={() => undefined} />);
      fill();
      expect(await screen.findByText('Thank you. Your request has been received.')).toBeInTheDocument();
      expect(posts()[0]!.body).toEqual({ requesterName: 'Priya Raman', companyName: 'Aster Mobility', workEmail: 'priya@aster.example', websiteUrl: 'https://www.aster.example', ref: 'ABCDEFGHJK' });
      expect(document.body.textContent).not.toContain('ABCDEFGHJK');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('explains the work-email rule and the rate limit plainly', async () => {
    render(<PublicEmployerAccessPage onNavigate={() => undefined} />);
    failWith = { status: 400, body: { error: { code: 'EMPLOYER_ACCESS_REQUEST_WORK_EMAIL_REQUIRED', correlationId: 'c-2' } } };
    fill();
    expect(await screen.findByRole('alert')).toHaveTextContent('Use your work email address — personal webmail addresses cannot be accepted. Reference: c-2');
    failWith = { status: 429, body: { error: { code: 'EMPLOYER_ACCESS_REQUEST_RATE_LIMITED', correlationId: 'c-3' } } };
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/Too many requests have been sent from here recently\. Please try again later\. Reference: c-3/)).toBeInTheDocument();
  });
});

describe('EMP-04 employer access requests in the Organizations screen', () => {
  const organizations = [
    { id: employerOrgId, kind: 'EMPLOYER', legalName: 'Aster Mobility Private Limited', verificationState: 'PENDING', active: true, updatedAt: '2026-09-25T00:00:00Z', profile: {} },
    { id: crypto.randomUUID(), kind: 'INSTITUTION', legalName: 'Some College', verificationState: 'VERIFIED', active: true, updatedAt: '2026-09-25T00:00:00Z', profile: {} },
  ] as OrganizationManagementDto[];

  it('shows pending requests with their review signals and says the email is not confirmed', async () => {
    render(<EmployerAccessRequestsSection organizations={organizations} />);
    const section = await screen.findByRole('region', { name: 'Employer access requests' });
    const row = await within(section).findByRole('row', { name: /Aster Mobility/ });
    expect(within(row).getByText('Email is on the website domain')).toBeInTheDocument();
    expect(within(row).getByText('Email not confirmed — confirm with the requester before onboarding')).toBeInTheDocument();
    expect(within(row).getByText('Sent 2 times')).toBeInTheDocument();
    expect(within(row).getByText('Aster Mobility Private Limited (PENDING)')).toBeInTheDocument();
  });

  it('links a request to an employer only with a reason, and offers only employers to link', async () => {
    render(<EmployerAccessRequestsSection organizations={organizations} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark onboarded' }));
    const form = screen.getByRole('form', { name: 'Confirm access request decision' });
    const orgSelect = within(form).getByLabelText('Employer organisation *');
    expect(within(orgSelect).queryByText(/Some College/)).not.toBeInTheDocument();
    const submit = within(form).getByRole('button', { name: 'Mark onboarded' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Reason *'), { target: { value: 'ORGANISATION_CREATED' } });
    fireEvent.click(submit);
    expect(await screen.findByText(/Verification is still a separate step/)).toBeInTheDocument();
    expect(posts()).toEqual([{ path: `/api/v1/operations/employer-access-requests/${requestId}/decision`, auth: 'Bearer ops-token',
      body: { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: employerOrgId } }]);
    expect(await screen.findByText('No pending employer access requests.')).toBeInTheDocument();
  });
});
