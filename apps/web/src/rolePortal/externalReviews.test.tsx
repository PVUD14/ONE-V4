/**
 * External faculty review screens (OPS-10): the operator panel under Content Management shows real
 * reviewers, drafts and faculty decisions, grants and assigns only through dialogs that require a
 * reason code, and offers withdrawal only to assigners; the faculty queue shows only what the server
 * returns, never an answer key, requires a comment for a request for changes, and has honest
 * loading / NA / empty / error / forbidden states. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { FacultyContentReviewsPage, OperationsExternalReviewsPage } from './externalReviews.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const college = '11111111-1111-4111-8111-111111111111';
const policy = (viewer: Record<string, boolean> = {}) => ({
  viewer: { read: true, assign: true, administer: true, userId: 'u-1', ...viewer },
  reasons: {
    grant: ['FACULTY_REVIEWER_AGREED', 'CORRECTION'], revoke: ['REVIEW_PROGRAMME_ENDED', 'LEAVER'], assign: ['SUBJECT_EXPERT_REVIEW'], unassign: ['REASSIGNED'],
    decision: { APPROVE: ['REVIEW_PASSED'], REQUEST_CHANGES: ['CONTENT_INACCURATE'] },
  },
  window: { min: 1, max: 30, default: 14 },
  limits: { revisionsPerAssignment: 50, comment: 2000, note: 500 },
  correlationId: 'corr-policy',
});
const reviewer = { membershipId: 'm-1', email: 'lecturer@college.test', institutionId: college, institutionName: 'Synthetic College', role: 'FACULTY_LECTURER', state: 'ACTIVE', grant: { grantedAt: '2026-09-20T00:00:00.000Z', reasonCode: 'FACULTY_REVIEWER_AGREED' }, openAssignments: 1 };
const assignment = {
  id: 'a-1', status: 'DECIDED', reviewer: { membershipId: 'm-1', email: 'lecturer@college.test', institutionName: 'Synthetic College', role: 'FACULTY_LECTURER', eligible: true },
  revision: { id: 'r-1', entityType: 'TOPIC', stableKey: 'syn-skill', title: 'Synthetic skill', revision: 1, state: 'IN_REVIEW' },
  assignedBy: 'reviewer@one.test', assignedAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-10-04T00:00:00.000Z', reasonCode: 'SUBJECT_EXPERT_REVIEW',
  decision: { decision: 'REQUEST_CHANGES', reasonCode: 'CONTENT_INACCURATE', comment: 'Synthetic: the GUIDED level is too advanced.', decidedAt: '2026-09-21T00:00:00.000Z' }, revoked: null,
};
const openAssignment = { ...assignment, id: 'a-2', status: 'OPEN', decision: null };

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let routes: Record<string, () => Promise<unknown>>;

beforeEach(() => {
  routes = {
    'GET /operations/external-reviews/policy': () => ok(policy()),
    'GET /operations/external-reviews/reviewers': () => ok({ reviewers: [reviewer], nextCursor: null, summary: { reviewers: 1, open: 1, approved: 3, changesRequested: 1, expired: 0 }, correlationId: 'c' }),
    'GET /operations/external-reviews/assignments': () => ok({ assignments: [assignment, openAssignment], nextCursor: null, correlationId: 'c' }),
    'GET /operations/external-reviews/revisions': () => ok({ revisions: [{ revisionId: 'r-9', entityType: 'QUESTION', stableKey: 'syn-question', title: 'Synthetic question?', revision: 2, openAssignments: 0, decisions: { approve: 0, requestChanges: 0 } }], correlationId: 'c' }),
    'GET /operations/external-reviews/reviewers/lookup': () => ok({ candidates: [{ ...reviewer, membershipId: 'm-2', email: 'new@college.test', grant: null, openAssignments: 0 }], correlationId: 'c' }),
    'POST /operations/external-reviews/reviewers/m-2/grant': () => ok({ reviewer: { ...reviewer, membershipId: 'm-2', email: 'new@college.test' }, correlationId: 'corr-grant' }),
    'POST /operations/external-reviews/assignments': () => ok({ assignments: [openAssignment], correlationId: 'corr-assign' }),
    [`GET /institutions/${college}/content-reviews`]: () => ok({
      assignments: [
        { id: 'a-2', status: 'OPEN', kind: 'QUESTION', stableKey: 'syn-question', title: 'Synthetic question?', assignedAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-10-04T00:00:00.000Z', decision: null },
        { id: 'a-3', status: 'EXPIRED', kind: 'SKILL', stableKey: 'syn-old', title: null, assignedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-02T00:00:00.000Z', decision: null },
      ],
      decisions: [{ decision: 'APPROVE', reasons: ['REVIEW_PASSED'] }, { decision: 'REQUEST_CHANGES', reasons: ['CONTENT_INACCURATE'] }],
      limits: { comment: 2000 }, correlationId: 'c',
    }),
    [`GET /institutions/${college}/content-reviews/a-2`]: () => ok({
      review: { id: 'a-2', status: 'OPEN', kind: 'QUESTION', stableKey: 'syn-question', title: 'Synthetic question?', assignedAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-10-04T00:00:00.000Z', decision: null,
        content: { kind: 'QUESTION', stableKey: 'syn-question', skill: 'Synthetic skill', prompt: 'Synthetic question?', options: [{ id: 'a', text: 'Synthetic one' }, { id: 'b', text: 'Synthetic two' }], difficulty: 'FOUNDATION' } },
      correlationId: 'c',
    }),
    [`POST /institutions/${college}/content-reviews/a-2/decision`]: () => ok({ review: { id: 'a-2', status: 'DECIDED' }, correlationId: 'corr-decided' }),
  };
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url).replace(/^.*\/api\/v1/, '').replace(/\?.*$/, '');
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    return handler ? handler() : ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = (suffix: string) => fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes(suffix));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>;

describe('the operator panel', () => {
  it('shows NA while loading, then real reviewers, drafts and the faculty decisions', async () => {
    render(<OperationsExternalReviewsPage />);
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
    expect(await screen.findByText('Synthetic: the GUIDED level is too advanced.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Faculty approvals').previousSibling).toHaveTextContent('3');
    const reviewers = screen.getByRole('table', { name: 'Reviewers' });
    expect(within(reviewers).getByText('lecturer@college.test')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Drafts in review' })).getByText('syn-question')).toBeInTheDocument();
    const list = screen.getByRole('table', { name: 'Assignment list' });
    expect(within(list).getByText('Withdraw…')).toBeInTheDocument();
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('grants through a dialog that requires a reason code', async () => {
    render(<OperationsExternalReviewsPage />);
    fireEvent.change(await screen.findByLabelText('Faculty email'), { target: { value: 'new@college.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Grant faculty review…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Approval: not required/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Grant' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason code'), { target: { value: 'FACULTY_REVIEWER_AGREED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts('/reviewers/m-2/grant')).toHaveLength(1));
    expect(bodyOf(posts('/reviewers/m-2/grant')[0]!)).toEqual({ reasonCode: 'FACULTY_REVIEWER_AGREED' });
    expect(await screen.findByText(/can now be assigned drafts to review. Reference: corr-grant/)).toBeInTheDocument();
  });

  it('assigns the selected drafts to a chosen reviewer for the chosen days', async () => {
    render(<OperationsExternalReviewsPage />);
    fireEvent.click(await screen.findByLabelText('Select syn-question'));
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'm-1' } });
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /^Assign 1/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/without answer keys/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason code'), { target: { value: 'SUBJECT_EXPERT_REVIEW' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(posts('/external-reviews/assignments')).toHaveLength(1));
    expect(bodyOf(posts('/external-reviews/assignments')[0]!)).toEqual({ revisionIds: ['r-9'], reviewerMembershipId: 'm-1', days: 7, reasonCode: 'SUBJECT_EXPERT_REVIEW' });
  });

  it('offers no grant, revoke, assign or withdraw to a publisher who only reads', async () => {
    routes['GET /operations/external-reviews/policy'] = () => ok(policy({ assign: false, administer: false }));
    render(<OperationsExternalReviewsPage />);
    expect(await screen.findByText('Synthetic: the GUIDED level is too advanced.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByLabelText('Faculty email')).toBeNull();
    expect(screen.queryByText('Revoke…')).toBeNull();
    expect(screen.queryByText('Withdraw…')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Drafts in review' })).toBeNull();
  });

  it('shows empty states when nothing exists yet', async () => {
    routes['GET /operations/external-reviews/reviewers'] = () => ok({ reviewers: [], nextCursor: null, summary: { reviewers: 0, open: 0, approved: 0, changesRequested: 0, expired: 0 }, correlationId: 'c' });
    routes['GET /operations/external-reviews/assignments'] = () => ok({ assignments: [], nextCursor: null, correlationId: 'c' });
    routes['GET /operations/external-reviews/revisions'] = () => ok({ revisions: [], correlationId: 'c' });
    render(<OperationsExternalReviewsPage />);
    expect(await screen.findByText('No faculty reviewers yet')).toBeInTheDocument();
    expect(screen.getByText('No drafts in review')).toBeInTheDocument();
    expect(screen.getByText('No assignments yet')).toBeInTheDocument();
  });

  it('shows forbidden and error states with a reference', async () => {
    routes['GET /operations/external-reviews/policy'] = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsExternalReviewsPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
    cleanup();
    routes['GET /operations/external-reviews/policy'] = () => failure(500, 'INTERNAL', 'corr-error');
    render(<OperationsExternalReviewsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-error');
  });
});

describe('the faculty queue', () => {
  it('lists only what the server returns and opens a question without its answer key', async () => {
    render(<FacultyContentReviewsPage institutionId={college} />);
    expect(screen.getByText('Loading your content reviews…')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Your assignments' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(table).getByRole('button', { name: 'Review…' }));
    const panel = await screen.findByRole('region', { name: 'Draft under review' });
    expect(within(panel).getByText('Synthetic two')).toBeInTheDocument();
    expect(within(panel).getByText('Not shown to external reviewers.')).toBeInTheDocument();
    expect(within(panel).getByText(/does not approve or publish/)).toBeInTheDocument();
  });

  it('needs a comment to request changes, then records the decision', async () => {
    render(<FacultyContentReviewsPage institutionId={college} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review…' }));
    const panel = await screen.findByRole('region', { name: 'Draft under review' });
    fireEvent.change(within(panel).getByLabelText('Decision'), { target: { value: 'REQUEST_CHANGES' } });
    fireEvent.change(within(panel).getByLabelText('Reason code'), { target: { value: 'CONTENT_INACCURATE' } });
    const record = within(panel).getByRole('button', { name: 'Record decision' });
    expect(record).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText('Comment'), { target: { value: 'Synthetic: option b is ambiguous.' } });
    expect(record).not.toBeDisabled();
    fireEvent.click(record);
    await waitFor(() => expect(posts('/content-reviews/a-2/decision')).toHaveLength(1));
    expect(bodyOf(posts('/content-reviews/a-2/decision')[0]!)).toEqual({ decision: 'REQUEST_CHANGES', reasonCode: 'CONTENT_INACCURATE', comment: 'Synthetic: option b is ambiguous.' });
    expect(await screen.findByText(/Reference: corr-decided/)).toBeInTheDocument();
  });

  it('says plainly when nothing is assigned, when access is absent, and hides itself where asked', async () => {
    routes[`GET /institutions/${college}/content-reviews`] = () => ok({ assignments: [], decisions: [], limits: { comment: 2000 }, correlationId: 'c' });
    render(<FacultyContentReviewsPage institutionId={college} />);
    expect(await screen.findByText('Nothing assigned yet')).toBeInTheDocument();
    cleanup();
    routes[`GET /institutions/${college}/content-reviews`] = () => failure(403, 'FORBIDDEN', 'corr-no-access');
    render(<FacultyContentReviewsPage institutionId={college} />);
    expect(await screen.findByText('No content review access')).toBeInTheDocument();
    cleanup();
    const { container } = render(<FacultyContentReviewsPage institutionId={college} hideWhenForbidden />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error with a reference', async () => {
    routes[`GET /institutions/${college}/content-reviews`] = () => failure(500, 'INTERNAL', 'corr-queue');
    render(<FacultyContentReviewsPage institutionId={college} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-queue');
  });
});

describe('navigation', () => {
  it('keeps the operations, faculty and department-head labels unchanged', () => {
    const labels = (key: string) => rolePortals.find((portal) => portal.key === key)!.nav.map((item) => item.label);
    expect(labels('operations-admin')).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
    expect(labels('faculty')).toEqual([
      'Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources',
      'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ',
    ]);
    expect(labels('department-head')).toEqual([
      'Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions', 'Faculty and Staff',
      'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ',
    ]);
  });
});
