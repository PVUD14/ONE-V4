/**
 * The admin Settings sections for a college's data-processing terms and leaving ONE (INST-18): a
 * draft is labelled as a draft, only an owner is offered Accept, the exit export appears only while a
 * notice is open and only for an owner, every download carries the chosen reason, counselling notes
 * need an explicit confirmation and a listed reason, and errors show a plain message and a reference.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstitutionDataTermsSection, InstitutionExitSection } from './institutionContract.js';

const institutionId = crypto.randomUUID();
const token = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const draft = {
  version: '2026-10-draft-1', title: 'ONE data-processing terms for colleges', body: 'DRAFT — FOR LEGAL REVIEW.', bodySha256: 'a'.repeat(64),
  legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null, requiresReacceptance: true, changeSummary: null, publishedAt: '2026-09-30T10:00:00Z',
};
const pending = { status: 'ACCEPTANCE_REQUIRED', current: draft, required: { version: draft.version, publishedAt: draft.publishedAt }, latestAcceptance: null, currentVersionAccepted: false };
const openExport = {
  available: true,
  sections: [{ section: 'units', rows: 4, parts: 1 }, { section: 'roster', rows: 12_000, parts: 2 }],
  restricted: { section: 'counselling-notes', rows: 3, parts: 1, reasons: ['LEGAL_OBLIGATION', 'REGULATOR_REQUEST'] },
  reasons: ['COLLEGE_EXIT_RECORDS', 'ACCREDITATION_ARCHIVE'],
  excluded: ['Students’ applications, offers and anything employers hold — and never offer pay'],
};
const notice = { state: 'NOTICE', noticeAt: '2026-09-30T10:00:00Z', endedAt: null, retentionEndsAt: null, cancelledAt: null, purgedAt: null, exitExportLastTakenAt: null };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:exit');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('data-processing terms', () => {
  it('labels a draft as a draft and lets an owner accept the current version', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => Promise.resolve(ok(init?.method === 'POST'
      ? { terms: { ...pending, status: 'ACCEPTED', currentVersionAccepted: true, latestAcceptance: { version: draft.version, acceptedAt: '2026-09-30T11:00:00Z', acceptedBy: 'owner@college.example.test' } }, canAccept: true }
      : { terms: pending, canAccept: true })));
    render(<InstitutionDataTermsSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText('Draft — pending legal review')).toBeInTheDocument();
    expect(screen.getByText('This text is a draft that has not finished legal review. It is not final.')).toBeInTheDocument();
    expect(screen.getByText(/must accept these terms before more students are added/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept version 2026-10-draft-1 for my college' }));
    expect(await screen.findByText('Your college has accepted these terms.')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(url).toContain(`/institutions/${institutionId}/data-terms/accept`);
    expect(JSON.parse(init.body as string)).toEqual({ version: '2026-10-draft-1' });
    expect(screen.getByText(/by owner@college\.example\.test/)).toBeInTheDocument();
  });

  it('tells an admin that only an owner accepts, and says plainly when nothing is published', async () => {
    fetchMock.mockResolvedValueOnce(ok({ terms: pending, canAccept: false }));
    render(<InstitutionDataTermsSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText('Only an owner of the college can accept the terms.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept version/ })).not.toBeInTheDocument();
    cleanup();
    fetchMock.mockResolvedValueOnce(ok({ terms: { status: 'NO_TERMS_PUBLISHED', current: null, required: null, latestAcceptance: null, currentVersionAccepted: false }, canAccept: true }));
    render(<InstitutionDataTermsSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText(/AI8HT has not published data-processing terms yet/)).toBeInTheDocument();
    expect(screen.getByText('None published yet')).toBeInTheDocument();
  });

  it('shows a plain error with its reference', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: { code: 'REQUEST_FAILED', message: 'x', correlationId: 'ref-inst18-1' } }), headers: new Headers() });
    render(<InstitutionDataTermsSection token={token} institutionId={institutionId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: ref-inst18-1');
  });
});

describe('leaving ONE', () => {
  it('says the college is using ONE when there is no exit, and offers no export', async () => {
    fetchMock.mockResolvedValueOnce(ok({ exit: null, export: { available: false, sections: [], restricted: null, reasons: [], excluded: [] } }));
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText(/Your college is using ONE\. To leave, contact AI8HT operations/)).toBeInTheDocument();
    expect(screen.queryByText('Exit export')).not.toBeInTheDocument();
    expect(screen.getByText(/students keep their ONE accounts/)).toBeInTheDocument();
  });

  it('gives the owner every section during a notice, with the chosen reason on each download', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, text: async () => '﻿"Unit"\r\n', headers: new Headers({ 'content-disposition': 'attachment; filename="one-exit-roster-part-2-2026-09-30.csv"' }) });
      return Promise.resolve(ok({ exit: notice, export: openExport }));
    });
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText('Exit export')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Exit export sections' });
    expect(within(table).getByRole('row', { name: /Student roster/ })).toHaveTextContent('12000');
    expect(screen.getByText(/never offer pay/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'ACCREDITATION_ARCHIVE' } });
    fireEvent.click(within(within(table).getByRole('row', { name: /Student roster/ })).getByRole('button', { name: 'File 2' }));
    expect(await screen.findByText(/Student roster, file 2 downloaded/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(url).toContain(`/institutions/${institutionId}/exit-export/roster`);
    expect(JSON.parse(init.body as string)).toEqual({ reasonCode: 'ACCREDITATION_ARCHIVE', part: 2 });
  });

  it('keeps counselling notes apart until the owner confirms and chooses a listed reason', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, status: 200, text: async () => '﻿"Note"\r\n', headers: new Headers() });
      return Promise.resolve(ok({ exit: notice, export: openExport }));
    });
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    const section = await screen.findByLabelText('Counselling notes');
    const button = within(section).getByRole('button', { name: 'Download counselling notes' });
    expect(button).toBeDisabled();
    fireEvent.click(within(section).getByLabelText(/I am asking for the college’s restricted counselling notes/));
    expect(button).toBeDisabled();
    fireEvent.change(within(section).getByLabelText('Reason for releasing them'), { target: { value: 'REGULATOR_REQUEST' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(url).toContain('/exit-export/counselling-notes');
    expect(JSON.parse(init.body as string)).toEqual({ reasonCode: 'REGULATOR_REQUEST', part: 1, includeRestrictedCounsellingNotes: true });
  });

  it('tells an admin during a notice that only an owner exports, and shows an ended exit with its retention date', async () => {
    fetchMock.mockResolvedValueOnce(ok({ exit: notice, export: { ...openExport, available: false, sections: [], restricted: null } }));
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText('Only an owner of the college can take the exit export.')).toBeInTheDocument();
    cleanup();
    fetchMock.mockResolvedValueOnce(ok({ exit: { ...notice, state: 'ENDED', endedAt: '2026-10-01T10:00:00Z', retentionEndsAt: '2026-12-30T10:00:00Z' }, export: { available: false, sections: [], restricted: null, reasons: [], excluded: [] } }));
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    expect(await screen.findByText(/stopped using ONE on .* can be restored until then/)).toBeInTheDocument();
  });

  it('explains a refused download in plain words with a reference', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, status: 429, json: async () => ({ error: { code: 'EXPORT_RATE_LIMITED', correlationId: 'ref-inst18-2' } }), headers: new Headers() });
      return Promise.resolve(ok({ exit: notice, export: openExport }));
    });
    render(<InstitutionExitSection token={token} institutionId={institutionId} />);
    const table = await screen.findByRole('table', { name: 'Exit export sections' });
    fireEvent.click(within(within(table).getByRole('row', { name: /Academic structure/ })).getByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('limit of 30 exports in 24 hours. Try again later. Reference: ref-inst18-2');
  });
});
