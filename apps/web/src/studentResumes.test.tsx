/**
 * RESUME-GEN web: the Résumé Builder generates a résumé from the student's own record. The builder shows
 * each item with the label the server gave it ("Verified by <college>" only for verified records), sends ids
 * and the student's words — never a label — saves a version and downloads its PDF; Templates and Examples
 * show the student's own record (no invented person); Resume Score is a checklist with no number.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { StudentResumeBuilderPage } from './pilotParityPages.js';

const Q_VERIFIED = '11111111-1111-4111-8111-111111111111';
const Q_SELF = '22222222-2222-4222-8222-222222222222';
const T_ONE = '33333333-3333-4333-8333-333333333333';
const SKILL = '44444444-4444-4444-8444-444444444444';
const RESUME = '55555555-5555-4555-8555-555555555555';
const COLLEGE = 'Synthetic Institute of Technology';

type Handler = (init?: RequestInit) => { status?: number; body: unknown; blob?: Blob; headers?: Record<string, string> };
let routes: Record<string, Handler>;
let calls: { path: string; init?: RequestInit }[];

const sources = {
  header: { fullName: 'Synthetic Student', email: 'student@example.test', headline: 'Final-year student', summary: null, portfolioUrl: null },
  qualifications: [
    { id: Q_VERIFIED, title: 'B.Tech — Computer Science', institution: COLLEGE, period: '2022 – present', verification: `Verified by ${COLLEGE}`, verified: true,
      terms: [{ id: T_ONE, label: 'Semester 1', result: '8.40 CGPA (of 10)', verification: `Verified by ${COLLEGE}`, verified: true }] },
    { id: Q_SELF, title: 'Class XII', institution: 'Synthetic Junior College', period: '2020 – 2022', verification: 'Self-declared', verified: false, terms: [] },
  ],
  skills: [{ topicId: SKILL, name: 'SQL joins', basis: 'Shown in ONE skill checks, Sep 2026' }],
  certificates: [],
  careerTargets: [],
};
const templates = [
  { key: 'CLASSIC', name: 'Classic', description: 'One column.' },
  { key: 'MODERN', name: 'Modern', description: 'A coloured header strip.' },
  { key: 'COMPACT', name: 'Compact', description: 'Smaller type.' },
];
const content = (template = 'CLASSIC') => ({
  schemaVersion: 1, template,
  header: { fullName: 'Synthetic Student', headline: 'Final-year student', email: 'student@example.test', phone: null, location: null, links: [] },
  summary: null, objective: [],
  education: [
    { title: 'B.Tech — Computer Science', institution: COLLEGE, period: '2022 – present', status: 'In progress', verification: `Verified by ${COLLEGE}`, verified: true, results: [] },
    { title: 'Class XII', institution: 'Synthetic Junior College', period: '2020 – 2022', status: 'Awarded', verification: 'Self-declared', verified: false, results: [] },
  ],
  skills: { shown: [{ name: 'SQL joins', basis: 'Shown in ONE skill checks, Sep 2026' }], declared: [] },
  projects: [], certificates: [], languages: [],
  legend: '“Verified by” marks a record the named institution confirmed in ONE. Every other item is self-declared.',
  generatedOn: '2026-10-01',
});
const checks = [
  { key: 'NAME', passed: true, message: 'Your name is at the top.' },
  { key: 'PHONE', passed: false, message: 'A phone number is shown.' },
  { key: 'PROJECTS', passed: false, message: 'At least one project is described.' },
];
const summary = { id: RESUME, title: 'My résumé', createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z', latestVersion: 1, template: 'CLASSIC', latestSavedAt: '2026-10-01T09:00:00Z', versionCount: 1 };

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  calls = [];
  let saved = false;
  routes = {
    'GET /api/v1/students/me/documents': () => ({ body: { documents: [] } }),
    'GET /api/v1/learner-content': () => ({ body: { items: [] } }),
    'GET /api/v1/students/me/resume-sources': () => ({ body: { sources, templates } }),
    'GET /api/v1/students/me/resumes': () => ({ body: { resumes: saved ? [summary] : [] } }),
    'POST /api/v1/students/me/resumes/preview': (init) => ({ body: { content: content(JSON.parse(String(init?.body)).template), checks } }),
    'POST /api/v1/students/me/resumes': () => { saved = true; return { status: 201, body: { resume: { ...summary, versions: [], latest: { versionNumber: 1 } } } }; },
    [`GET /api/v1/students/me/resumes/${RESUME}/versions/1/pdf`]: () => ({ body: null, blob: new Blob(['%PDF-1.7']), headers: { 'content-disposition': 'attachment; filename="My-resume-v1.pdf"' } }),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, ...(init ? { init } : {}) });
    const handler = routes[`${init?.method ?? 'GET'} ${path.split('?')[0] ?? ''}`];
    const result = handler ? handler(init) : { body: {} };
    const status = result.status ?? 200;
    return {
      ok: status < 400, status, headers: { get: (name: string) => result.headers?.[name.toLowerCase()] ?? null },
      json: async () => result.body, blob: async () => result.blob ?? new Blob([]),
    };
  }));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
const sent = (method: string, suffix: string) => calls.filter((call) => call.init?.method === method && call.path.endsWith(suffix))
  .map((call) => JSON.parse(String(call.init?.body)));

describe('Résumé Builder', () => {
  it('builds a résumé from the record with honest labels, saves it and downloads the PDF', async () => {
    await authenticate();
    const createObjectURL = vi.fn(() => 'blob:resume');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<StudentResumeBuilderPage />);
    expect(await screen.findByText('No generated résumés yet. Create one from your ONE record.')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /Create New Resume/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Create New Resume/ }));
    expect(await screen.findByRole('heading', { name: 'New résumé' })).toBeInTheDocument();
    const education = screen.getByRole('heading', { name: 'Education' }).closest('section') as HTMLElement;
    for (const chip of within(education).getAllByText(`Verified by ${COLLEGE}`, { selector: '.pilot-chip' })) expect(chip).toHaveClass('green');
    expect(within(education).getByText('Self-declared', { selector: '.pilot-chip' })).toHaveClass('slate');

    // Tick the term result and add a self-declared skill; the preview is the server's.
    fireEvent.click(within(education).getByRole('checkbox', { name: /Semester 1/ }));
    fireEvent.change(screen.getByLabelText('Self-declared skills (comma-separated)'), { target: { value: 'Python, Excel' } });
    expect(await screen.findByRole('article', { name: 'Résumé preview' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save résumé' }));
    await waitFor(() => expect(sent('POST', '/students/me/resumes')).toHaveLength(1));
    const [draft] = sent('POST', '/students/me/resumes');
    expect(draft).toMatchObject({ qualificationIds: [Q_VERIFIED, Q_SELF], termIds: [T_ONE], skillTopicIds: [SKILL], declaredSkills: ['Python', 'Excel'] });
    // The client sends ids and words, never a label.
    expect(JSON.stringify(draft)).not.toMatch(/verif/i);

    const myResumes = (await screen.findByRole('heading', { name: 'My Resumes' })).closest('section') as HTMLElement;
    const row = (await within(myResumes).findByText('My résumé')).closest('.pilot-list-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(await screen.findByText('PDF downloaded.')).toBeInTheDocument();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  }, 20_000);

  it('shows the real templates and the student’s own record as examples, and checks without a number', async () => {
    await authenticate();
    render(<StudentResumeBuilderPage />);
    await screen.findByText(/No generated résumés yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    expect(await screen.findByRole('button', { name: 'Use Modern' })).toBeInTheDocument();
    expect((await screen.findAllByRole('article', { name: 'Résumé preview' })).length).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'Examples' }));
    const papers = await screen.findAllByRole('article', { name: 'Résumé preview' });
    expect(papers).toHaveLength(3);
    for (const paper of papers) expect(within(paper).getByText('Synthetic Student')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume Score' }));
    const card = (await screen.findByRole('heading', { name: 'Resume checks' })).closest('section') as HTMLElement;
    expect(within(card).getByText('A phone number is shown.')).toBeInTheDocument();
    expect(card.textContent ?? '').not.toMatch(/\d|%|\/100|score/i);
  });
});
