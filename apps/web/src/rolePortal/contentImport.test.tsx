/**
 * Operations Content Management — bulk import (OPS-09d): the screen shows the server's fields and
 * caps, previews a picked file (kind, format, file name and content go to the server), shows every
 * row's problems in plain words and offers no commit while any row or the file has a problem,
 * commits only the previewed file with its digest and a reason code chosen in a confirm dialog,
 * previews again when a commit is refused as stale, and its loading / NA / empty / error /
 * forbidden states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsContentImportPage } from './contentImport.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const policy = {
  kinds: [
    { kind: 'SKILL', required: ['stable_key', 'name', 'description'], optional: ['level_aware', 'prerequisites', 'licence'] },
    { kind: 'QUESTION', required: ['stable_key', 'skill_key', 'prompt'], optional: ['option_a', 'correct_option'] },
    { kind: 'LESSON', required: ['stable_key', 'title', 'level', 'style'], optional: ['summary'] },
    { kind: 'LESSON_VARIANT', required: ['base_lesson_key', 'language', 'level', 'style', 'title'], optional: ['summary'] },
  ],
  formats: ['CSV', 'JSON'],
  limits: { rows: 200, characters: 90_000, filename: 160 },
  reasons: ['TRACK_BUILD', 'CONTENT_MIGRATION', 'EXPERT_BATCH'],
  correlationId: 'corr-policy',
};
const digest = 'd'.repeat(64);
const report = (over: Record<string, unknown> = {}) => ({
  kind: 'SKILL', format: 'CSV', digest, rowCount: 2, counts: { create: 2, invalid: 0 }, fileProblems: [],
  rows: [{ rowNumber: 2, key: 'syn-one', outcome: 'CREATE', issues: [] }, { rowNumber: 3, key: 'syn-two', outcome: 'CREATE', issues: [] }],
  ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let policyResponse: () => Promise<unknown>;
let previewResponse: () => Promise<unknown>;
let commitResponse: () => Promise<unknown>;

beforeEach(() => {
  policyResponse = () => ok(policy);
  previewResponse = () => ok({ preview: report(), correlationId: 'corr-preview' });
  commitResponse = () => ok({ import: { reference: crypto.randomUUID(), kind: 'SKILL', created: 2, keys: ['syn-one', 'syn-two'] }, correlationId: 'corr-commit' });
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string) => {
    const path = String(url);
    if (path.endsWith('/operations/content-imports/policy')) return policyResponse();
    if (path.endsWith('/operations/content-imports/preview')) return previewResponse();
    if (path.endsWith('/operations/content-imports/commit')) return commitResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = (suffix: string) => fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).endsWith(suffix));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>;
const csv = 'stable_key,name,description\nsyn-one,One,First\nsyn-two,Two,Second\n';

async function pickAndPreview(content = csv, filename = 'skills.csv'): Promise<void> {
  const input = await screen.findByLabelText('Import file');
  fireEvent.change(input, { target: { files: [new File([content], filename, { type: 'text/plain' })] } });
  const button = screen.getByRole('button', { name: 'Preview' });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

describe('bulk import', () => {
  it('shows the fields and caps for the chosen kind, NA counts and an empty report', async () => {
    render(<OperationsContentImportPage />);
    expect(screen.getByText('Loading the import policy…')).toBeInTheDocument();
    expect(await screen.findByText('stable_key, name, description')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('No file previewed yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Import kind'), { target: { value: 'QUESTION' } });
    expect(screen.getByText('stable_key, skill_key, prompt')).toBeInTheDocument();
  });

  it('shows a forbidden state with its reference to staff without Content Edit', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsContentImportPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrforb')).toBeInTheDocument();
    expect(screen.queryByLabelText('Import file')).not.toBeInTheDocument();
  });

  it('shows an error with its reference when the policy cannot load', async () => {
    policyResponse = () => failure(500, 'INTERNAL', 'corr-broken');
    render(<OperationsContentImportPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrbrok');
  });

  it('previews the picked file: kind, format, file name and content go to the server', async () => {
    render(<OperationsContentImportPage />);
    await pickAndPreview();
    await screen.findByRole('table', { name: 'Rows' });
    const [call] = posts('/preview');
    expect(bodyOf(call!)).toEqual({ kind: 'SKILL', format: 'CSV', filename: 'skills.csv', content: csv });
    expect(screen.getByText('Every row is ready. Committing imports exactly this file as drafts; nothing is published.')).toBeInTheDocument();
  });

  it('takes the format from a .json file name', async () => {
    render(<OperationsContentImportPage />);
    await pickAndPreview('[{"stable_key":"syn-one","name":"One","description":"First"}]', 'skills.json');
    await screen.findByRole('table', { name: 'Rows' });
    expect(bodyOf(posts('/preview')[0]!).format).toBe('JSON');
  });

  it('shows every row problem in plain words and offers no commit', async () => {
    previewResponse = () => ok({ preview: report({
      counts: { create: 1, invalid: 2 }, rowCount: 3,
      rows: [
        { rowNumber: 2, key: 'syn-one', outcome: 'CREATE', issues: [] },
        { rowNumber: 3, key: 'syn-two', outcome: 'INVALID', issues: ['SKILL_PREREQUISITE_CYCLE', 'IMPORT_FIELD_REQUIRED:description'] },
        { rowNumber: 4, key: '', outcome: 'INVALID', issues: ['SKILL_LEVEL_TOO_LONG:AWARE'] },
      ],
    }), correlationId: 'corr-preview' });
    render(<OperationsContentImportPage />);
    await pickAndPreview();
    const table = await screen.findByRole('table', { name: 'Rows' });
    expect(within(table).getByText('The prerequisites form a cycle')).toBeInTheDocument();
    expect(within(table).getByText('A required field is empty: description')).toBeInTheDocument();
    expect(within(table).getByText('SKILL_LEVEL_TOO_LONG:AWARE')).toBeInTheDocument();
    expect(within(table).getByText('NA')).toBeInTheDocument();
    expect(screen.getByText(/2 rows have problems\. Nothing can be imported until every row is fixed; nothing was written\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /as drafts/ })).not.toBeInTheDocument();
  });

  it('shows file problems and offers no commit', async () => {
    previewResponse = () => ok({ preview: report({ rowCount: 0, counts: { create: 0, invalid: 0 }, rows: [], fileProblems: ['IMPORT_COLUMN_UNKNOWN:score'] }), correlationId: 'corr-preview' });
    render(<OperationsContentImportPage />);
    await pickAndPreview();
    expect(await screen.findByText('This column is not part of the import: score')).toBeInTheDocument();
    expect(screen.getByText('The file cannot be imported.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /as drafts/ })).not.toBeInTheDocument();
  });

  it('commits the previewed file with its digest only after a reason code is chosen', async () => {
    render(<OperationsContentImportPage />);
    await pickAndPreview();
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 as drafts…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/You will not be able to review or publish these drafts/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Not required: every row becomes a draft/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Import as drafts' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason code'), { target: { value: 'EXPERT_BATCH' } });
    fireEvent.click(submit);
    expect(await screen.findByText(/Imported 2 drafts\. Open them in the editors above/)).toBeInTheDocument();
    expect(bodyOf(posts('/commit')[0]!)).toEqual({ kind: 'SKILL', format: 'CSV', filename: 'skills.csv', content: csv, previewDigest: digest, reasonCode: 'EXPERT_BATCH' });
    expect(screen.getByText('No file previewed yet')).toBeInTheDocument();
  });

  it('previews again when a commit is refused as stale, and says nothing was imported', async () => {
    commitResponse = () => failure(409, 'IMPORT_STALE', 'corr-stale');
    render(<OperationsContentImportPage />);
    await pickAndPreview();
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 as drafts…' }));
    fireEvent.change(screen.getByLabelText('Reason code'), { target: { value: 'TRACK_BUILD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import as drafts' }));
    expect(await screen.findByText(/changed since the preview, so nothing was imported.*Support code: corrstal/)).toBeInTheDocument();
    await waitFor(() => expect(posts('/preview')).toHaveLength(2));
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
