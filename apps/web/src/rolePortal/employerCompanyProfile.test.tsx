/**
 * The employer Company Profile screen (EMP-04).
 *
 * The "Company Profile" label in the employer navigation said "Not built yet" until the
 * company-profile API existed. These tests render it through the real route dispatcher for
 * the label, with the API stubbed at fetch, and check that it shows only what the server
 * returned, keeps the details operations verifies read-only, lets owners and admins change
 * only the description, gives recruiters a read-only view, and reports errors plainly. Other
 * labels still say "Not built yet".
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import type { EmployerCompanyProfileDto } from '../api/hiring.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));

const employerId = crypto.randomUUID();
const portal = rolePortals.find((item) => item.key === 'recruiter') ?? rolePortals[0]!;
const path = `/api/v1/employers/${employerId}/company-profile`;

function profileFor(canEdit: boolean, overrides: Partial<EmployerCompanyProfileDto> = {}): EmployerCompanyProfileDto {
  return {
    legalName: 'Aster Mobility Private Limited', verificationState: 'VERIFIED', profileSetUp: true,
    displayName: 'Aster Mobility', websiteUrl: 'https://www.aster.example', countryCode: 'IN', stateOrProvince: 'Karnataka', city: 'Bengaluru',
    postalCode: null, primaryContactEmail: 'hiring@aster.example',
    about: null, industry: null, companySizeBand: null, careersPageUrl: null, updatedAt: '2026-09-20T00:00:00Z',
    canEdit,
    options: { industries: ['SOFTWARE_AND_IT_SERVICES', 'MANUFACTURING'], sizeBands: ['11-50', '201-1000'] },
    ...overrides,
  };
}

let role: string;
let profile: EmployerCompanyProfileDto;
let failWith: { status: number; body: unknown } | null;

beforeEach(() => {
  role = 'EMPLOYER_OWNER';
  profile = profileFor(true);
  failWith = null;
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role, scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const requested = new URL(url, window.location.origin).pathname;
    if (requested !== path) throw new Error('Unexpected endpoint ' + requested);
    if (init?.method === 'POST') {
      if (failWith) return response(failWith.body, failWith.status);
      const changes = JSON.parse(String(init.body)) as Record<string, string | null>;
      profile = { ...profile, ...changes, updatedAt: '2026-09-25T00:00:00Z' };
      return response({ companyProfile: profile }, 201);
    }
    if (failWith) return response(failWith.body, failWith.status);
    return response({ companyProfile: profile });
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body, headers: new Headers() }; }
function show(label = 'Company Profile') { return render(<EmployerRecruiterRealityPage portal={portal} routeLabel={label} />); }
function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)) as unknown);
}

describe('EMP-04 employer Company Profile screen', () => {
  it('shows the verified details read-only and says what is missing instead of inventing it', async () => {
    profile = profileFor(true, { websiteUrl: null });
    show();
    const verified = await screen.findByRole('region', { name: 'Verified details' });
    expect(within(verified).getByText('Managed by AI8HT operations. These are what your company was verified against, so they change only through operations.')).toBeInTheDocument();
    expect(within(verified).getByText('Aster Mobility Private Limited')).toBeInTheDocument();
    expect(within(verified).getByText('hiring@aster.example')).toBeInTheDocument();
    expect(within(verified).getByText('Not provided')).toBeInTheDocument();
    expect(within(verified).queryByRole('textbox')).not.toBeInTheDocument();
    const preview = screen.getByRole('region', { name: 'How students see you' });
    expect(within(preview).getByText('No description yet.')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
  });

  it('lets an owner describe the company and sends only what changed — never the legal name', async () => {
    show();
    const form = await screen.findByRole('form', { name: 'Edit company profile' });
    expect(within(form).queryByLabelText(/legal name/i)).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('About the company'), { target: { value: 'We build fleet-telematics software.' } });
    fireEvent.change(within(form).getByLabelText('Industry'), { target: { value: 'SOFTWARE_AND_IT_SERVICES' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Company profile saved. Students see it on your jobs.')).toBeInTheDocument();
    expect(posts()).toEqual([{ about: 'We build fleet-telematics software.', industry: 'SOFTWARE_AND_IT_SERVICES' }]);
    expect(within(screen.getByRole('region', { name: 'How students see you' })).getByText('We build fleet-telematics software.')).toBeInTheDocument();
  });

  it('gives a recruiter the profile read-only, as the server says', async () => {
    role = 'RECRUITER';
    profile = profileFor(false, { about: 'We build fleet-telematics software.' });
    show();
    expect(await screen.findByRole('heading', { name: 'Managed by your owner or admin' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Edit company profile' })).not.toBeInTheDocument();
    expect(screen.getByText('We build fleet-telematics software.')).toBeInTheDocument();
  });

  it('reports a refused change plainly, with its reference', async () => {
    show();
    const form = await screen.findByRole('form', { name: 'Edit company profile' });
    failWith = { status: 400, body: { error: { code: 'COMPANY_PROFILE_CAREERS_URL_OFF_DOMAIN', correlationId: 'corr-7' } } };
    fireEvent.change(within(form).getByLabelText('Careers page (on your website)'), { target: { value: 'https://elsewhere.example/jobs' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText(/The careers page must be on your company website, or a subdomain of it\. Reference: corr-7/)).toBeInTheDocument();
  });

  it('explains a suspended employer instead of showing an empty profile', async () => {
    failWith = { status: 403, body: { error: { code: 'EMPLOYER_ORGANISATION_INACTIVE', correlationId: 'corr-9' } } };
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your employer account is suspended or was not approved, so the company profile is not available. Reference: corr-9');
  });

  it('leaves every other unbuilt label saying so', async () => {
    show('Messages');
    expect(await screen.findByText('Not built yet')).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
