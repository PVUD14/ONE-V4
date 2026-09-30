/**
 * Operations' college data terms and college exits sections (INST-18): collapsed until opened, a
 * published draft is labelled as a draft, the runbook's steps each take a listed reason, the dry run
 * shows what would be deleted and kept, and the deletion is only ever a request for a second
 * person's approval — executed from the Approvals queue, which names the college.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import type { OperationApprovalDto, OrganizationManagementDto } from '../api.js';
import { describeApproval } from './approvals.js';
import { CollegeExitsSection, InstitutionDataTermsOperationsSection } from './operationsInstitutionExits.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const collegeId = crypto.randomUUID();
const exitId = crypto.randomUUID();
const organizations = [
  { id: collegeId, kind: 'INSTITUTION', legalName: 'Gamma Polytechnic', profile: { displayName: 'Gamma' } },
  { id: crypto.randomUUID(), kind: 'EMPLOYER', legalName: 'Acme Robotics', profile: { displayName: 'Acme' } },
] as unknown as OrganizationManagementDto[];
const policy = { retentionDays: 90, reasons: { NOTICE: ['CONTRACT_ENDED'], END: ['NOTICE_PERIOD_COMPLETE'], CANCEL: ['COLLEGE_RENEWED'] }, purgeReasons: ['RETENTION_PERIOD_ENDED'] };
const exit = (extra: Record<string, unknown> = {}) => ({
  id: exitId, institutionId: collegeId, institutionName: 'Gamma Polytechnic', state: 'NOTICE', noticeAt: '2026-06-01T10:00:00Z', noticeReasonCode: 'CONTRACT_ENDED',
  endedAt: null, endReasonCode: null, retentionEndsAt: null, retentionElapsed: false, cancelledAt: null, cancelReasonCode: null, purgedAt: null, purgeSummary: null,
  exitExportLastTakenAt: '2026-06-02T10:00:00Z', changes: { relationships: 0, memberships: 0, restored: 0 }, ...extra,
});

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('college data-processing terms', () => {
  it('makes no request until opened, then labels a draft and publishes a version', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve(ok(init?.method === 'POST'
      ? { version: { version: 'v2', requiresReacceptance: true } }
      : { versions: [{ version: 'v1', title: 'College terms', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null, requiresReacceptance: true, publishedAt: '2026-09-30T10:00:00Z', acceptedBy: 2 }] })));
    render(<InstitutionDataTermsOperationsSection />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage college data terms' }));
    expect(await screen.findByText('Draft — pending legal review')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Publish college data terms' });
    fireEvent.change(within(form).getByLabelText('Version'), { target: { value: 'v2' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'College terms' } });
    fireEvent.change(within(form).getByLabelText('Terms text'), { target: { value: 'DRAFT' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Publish version' }));
    expect(await screen.findByText(/Version v2 is published\. Every college’s owner must accept it/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(url).toContain('/api/v1/operations/institution-data-terms');
    expect(JSON.parse(init.body as string)).toMatchObject({ version: 'v2', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', requiresReacceptance: true, reasonCode: 'TERMS_PUBLISHED' });
  });
});

describe('college exits', () => {
  it('records a notice for a college only, and ends it with a listed reason', async () => {
    let listed = [exit()];
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/end')) {
        listed = [exit({ state: 'ENDED', endedAt: '2026-06-10T10:00:00Z', retentionEndsAt: '2026-09-08T10:00:00Z', changes: { relationships: 120, memberships: 9, restored: 0 } })];
        return Promise.resolve(ok({ offboarding: listed[0] }));
      }
      if (init?.method === 'POST') return Promise.resolve(ok({ offboarding: exit() }));
      return Promise.resolve(ok({ offboardings: listed, policy }));
    });
    render(<CollegeExitsSection organizations={organizations} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage college exits' }));
    const form = await screen.findByRole('form', { name: 'Record an exit notice' });
    const college = within(form).getByLabelText('College');
    expect(within(college).queryByText('Acme')).not.toBeInTheDocument();
    fireEvent.change(college, { target: { value: collegeId } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'CONTRACT_ENDED' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record exit notice' }));
    expect(await screen.findByText(/Exit notice recorded for Gamma Polytechnic/)).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')![1].body as string)).toEqual({ institutionId: collegeId, reasonCode: 'CONTRACT_ENDED' });

    fireEvent.click(await screen.findByRole('button', { name: 'End…' }));
    const dialog = screen.getByRole('dialog', { name: 'End the exit' });
    const confirm = within(dialog).getByRole('button', { name: 'End now' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'NOTICE_PERIOD_COMPLETE' } });
    fireEvent.click(confirm);
    expect(await screen.findByText(/120 student links and 9 staff memberships ended/)).toBeInTheDocument();
  });

  it('dry-runs the deletion and files the approval request only once the retention period has passed', async () => {
    const ended = exit({ state: 'ENDED', endedAt: '2026-06-10T10:00:00Z', retentionEndsAt: '2026-09-08T10:00:00Z', retentionElapsed: true });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/purge-preview')) return Promise.resolve(ok({ offboarding: ended, preview: { deletes: { staff_actions: 40, institution_student_profiles: 120 }, keeps: { institution_relationships: 120 }, studentsUnderHold: 0 } }));
      if (url.includes('/approvals/policy')) return Promise.resolve(ok({ actions: [], decisionReasons: { APPROVE: [], REJECT: [] }, approverCount: 2, soloSafeguardActive: false }));
      return Promise.resolve(ok({ offboardings: [ended], policy }));
    });
    render(<CollegeExitsSection organizations={organizations} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage college exits' }));
    expect(await screen.findByRole('button', { name: 'Request deletion…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel exit…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    const dry = await screen.findByLabelText('Deletion dry run');
    expect(within(dry).getByRole('row', { name: /institution_student_profiles 120 Deleted/ })).toBeInTheDocument();
    expect(within(dry).getByRole('row', { name: /institution_relationships 120 Kept/ })).toBeInTheDocument();
    expect(within(dry).getByText('No legal hold covers its students.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Request deletion…' }));
    expect(await screen.findByText('Delete the records of Gamma Polytechnic')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/approvals/policy'))).toBe(true));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/purge') && !String(url).includes('preview') && init?.method === 'POST')).toBe(false);
  });

  it('names the college in the Approvals queue', () => {
    const approval = { actionKey: 'INSTITUTION_DATA_PURGE', summary: { organizationName: 'Gamma Polytechnic' } } as unknown as OperationApprovalDto;
    expect(describeApproval(approval)).toBe('Delete the records of Gamma Polytechnic, which has left ONE');
  });
});
