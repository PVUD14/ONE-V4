/**
 * Web tests for the Tutor hints panel on AI Operations (ENG-22): the sample, the refused list with the
 * guard's findings, a verdict with a reason, no student identity, and NA (not a crash) on a malformed reply.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TutorHintsPanel } from './tutorHintReview.js';

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const hint = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), requestedAt: '2026-10-02T09:00:00.000Z', level: 2, language: 'en', status: 'SHOWN', fallbackReason: null,
  guardFindings: [], generatedText: 'Think of equal groups.', questionPrompt: 'Synthetic: what is 6 × 7?', model: 'fake/model',
  promptVersion: 'tutor-hint@1', guardVersion: 'tutor-guard-v1', reviewState: 'DRAFT', reviewReasonCode: null, ...over,
});
const list = (hints: unknown[], canReview = true) => ({
  view: 'sample', hints, counts: { shown7d: 3, fallback7d: 1, published: 0, rejected: 0 },
  reasons: { approve: ['ACCURATE_AND_SAFE'], reject: ['LEAKS_ANSWER', 'UNSAFE'] }, viewer: { canReview },
});
let response: () => Promise<unknown>;

beforeEach(() => {
  response = () => ok(list([hint()]));
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return ok({ tutorHint: { id: 'x', reviewState: 'PUBLISHED' } });
    if (String(url).includes('/operations/ai/tutor-hints')) return response();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Tutor hints panel', () => {
  it('shows the question, the hint, its provenance and counts — never the student', async () => {
    render(<TutorHintsPanel token="t" />);
    const row = (await screen.findByText('Think of equal groups.')).closest('tr') as HTMLElement;
    expect(within(row).getByText(/Synthetic: what is 6 × 7\?/)).toBeInTheDocument();
    expect(within(row).getByText('Shown to the student')).toBeInTheDocument();
    expect(within(row).getByText(/tutor-hint@1/)).toBeInTheDocument();
    expect(screen.getByText(/3 shown · 1 replaced by the written hint/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\w.]+@[\w-]+\.[a-z]{2,}|student id/i);
  });

  it('records a verdict: fine at once, a rejection only with a reason', async () => {
    const target = hint();
    response = () => ok(list([target]));
    render(<TutorHintsPanel token="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Should not have been shown' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose why the hint should not have been shown.');
    fireEvent.change(screen.getByLabelText('Why hint 2 should not have been shown'), { target: { value: 'UNSAFE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Should not have been shown' }));
    expect(await screen.findByText('Marked as should not have been shown.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Reviewed — fine' }));
    expect(await screen.findByText('Marked reviewed and fine.')).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url, init]) => [String(url).replace(/^https?:\/\/[^/]+/, ''), JSON.parse(String(init.body))])).toEqual([
      [`/api/v1/operations/ai/tutor-hints/${target.id}/review`, { verdict: 'REJECT', reasonCode: 'UNSAFE' }],
      [`/api/v1/operations/ai/tutor-hints/${target.id}/review`, { verdict: 'APPROVE', reasonCode: 'ACCURATE_AND_SAFE' }],
    ]);
  });

  it('lists refused hints with what the guard found, and offers no verdict to a viewer who cannot review', async () => {
    response = () => ok(list([hint({ status: 'FALLBACK', fallbackReason: 'GUARD_REFUSED', guardFindings: ['ANSWER_LEAK'], generatedText: 'It is 42.' })], false));
    render(<TutorHintsPanel token="t" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refused by the guard' }));
    expect(await screen.findByText('Found: ANSWER_LEAK')).toBeInTheDocument();
    expect(screen.getByText('Refused — written hint shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reviewed — fine' })).toBeNull();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('view=refused');
  });

  it('says NA on a reply it cannot read, and explains an empty list', async () => {
    response = () => ok({});
    render(<TutorHintsPanel token="t" />);
    expect(await screen.findByText('NA — tutor hints could not be read right now.')).toBeInTheDocument();
    cleanup();
    response = () => ok(list([]));
    render(<TutorHintsPanel token="t" />);
    expect(await screen.findByText('No tutor hints here')).toBeInTheDocument();
  });
});
