/**
 * Export applicants on the Applicants page (EMP-17, journey J9): shown to owners and admins only,
 * requests nothing until the person acts, sends the chosen reason and scope, saves the server's
 * file, explains a refusal without upstream text, and adds no navigation item (HG-3).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken } from '../auth.js';
import { EmployerApplicantsPage } from '../hiringPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerApplicantExportPanel } from './employerApplicantExport.js';

vi.mock('../auth.js', async (original) => ({ ...await original<typeof import('../auth.js')>(), getAccessToken: vi.fn() }));

const employerId = crypto.randomUUID();
const opportunityId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const csvResponse = (filename: string) => ({
  ok: true, status: 200,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : null) },
  blob: async () => new Blob(['﻿"Candidate"\r\n'], { type: 'text/csv' }), json: async () => ({}),
});
const refused = (status: number, code: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { code, message: 'upstream detail text', correlationId: 'corr-export' } }) });
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
let anchorClick: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getAccessToken).mockReturnValue('token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:export');
  URL.revokeObjectURL = vi.fn();
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); anchorClick.mockRestore(); vi.unstubAllGlobals(); });

describe('EmployerApplicantExportPanel', () => {
  it('requests nothing until asked, then posts the reason and scope and saves the server\'s file', async () => {
    fetchMock.mockResolvedValue(csvResponse('one-applicants-graduate-analyst-2026-09-30.csv'));
    render(<EmployerApplicantExportPanel employerId={employerId} opportunityId={opportunityId} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/only candidates who still share their application/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Applicants'), { target: { value: 'SHORTLISTED_ONWARD' } });
    fireEvent.change(screen.getByLabelText('Reason for this export'), { target: { value: 'HIRING_COMMITTEE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applicant-export`);
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'HIRING_COMMITTEE', scope: 'SHORTLISTED_ONWARD' });
    expect(await screen.findByText('Exported as one-applicants-graduate-analyst-2026-09-30.csv. The export is recorded with your reason.')).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, 'EXPORT_RATE_LIMITED', 'You have reached the limit of 20 exports in 24 hours.'],
    [422, 'EXPORT_TOO_LARGE', 'Export Shortlisted onward instead.'],
    [403, 'FORBIDDEN', 'Only owners and admins of your organisation can export applicants.'],
    [403, 'EMPLOYER_ORGANISATION_UNVERIFIED', 'Your organisation is not verified yet'],
  ])('explains a %i %s plainly, with the reference and without upstream text', async (status, code, message) => {
    fetchMock.mockResolvedValue(refused(status, code));
    render(<EmployerApplicantExportPanel employerId={employerId} opportunityId={opportunityId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent('Reference: corr-export');
    expect(alert).not.toHaveTextContent('upstream detail text');
    expect(anchorClick).not.toHaveBeenCalled();
  });
});

describe('the Applicants page', () => {
  function routes(): void {
    fetchMock.mockImplementation(async (input: string) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === `/api/v1/employers/${employerId}/opportunities`) {
        return ok({ opportunities: [{ id: opportunityId, referenceCode: 'EX-1', title: 'Graduate analyst', lifecycleState: 'PUBLISHED', applicationCount: 0 }] });
      }
      return ok({ applications: [], stages: [] });
    });
  }

  it('shows the export to owners and admins once a job is chosen', async () => {
    routes();
    render(<EmployerApplicantsPage employerId={employerId} canExport />);
    expect(await screen.findByRole('heading', { name: 'Export applicants' })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('does not show it to recruiters', async () => {
    routes();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('No applications for this opportunity yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Export applicants' })).not.toBeInTheDocument();
  });

  it('adds no navigation item (HG-3)', () => {
    const labels = rolePortals.find((item) => item.key === 'recruiter')!.nav.map((item) => item.label);
    expect(labels).toEqual(['Dashboard', 'Opportunities', 'Opportunity Detail', 'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers', 'Reports', 'Team', 'Messages', 'Company Profile', 'Settings', 'Help & FAQ']);
  });
});
