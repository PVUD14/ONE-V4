import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { LearnerContentStudio } from './learnerContentStudio.js';
import { PublishedContentCard } from './pilotParity/publishedContent.js';

const authored = {
  id: 'c-1', contentType: 'PRACTICE', title: 'Reading a SIEM alert', summary: 'Where to start when an alert fires.',
  content: { body: 'Begin with the source host.' }, publishedAt: null,
  source: 'AUTHORED', reviewState: 'IN_REVIEW',
  generatorVersion: null, promptVersion: null, generatedAt: null,
  createdByUserId: 'u-1', sortOrder: 0,
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/operations/admin'); });

describe('learner content studio', () => {
  it('states the separation of duties up front', async () => {
    stub({ '/api/v1/operations/learner-content': { items: [authored] } });
    await authenticate();
    render(<LearnerContentStudio />);
    expect(await screen.findByText(/Approving needs a reviewer other than the author/)).toBeInTheDocument();
    expect(screen.getByText(/publishing needs somebody other than the approver/)).toBeInTheDocument();
  });

  it('offers only the steps the lifecycle allows', async () => {
    stub({ '/api/v1/operations/learner-content': { items: [authored] } });
    await authenticate();
    render(<LearnerContentStudio />);
    // IN_REVIEW can move to changes requested or approved — and nowhere else.
    expect(await screen.findByRole('button', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Changes requested' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Published' })).not.toBeInTheDocument();
  });

  it('explains a refused step instead of leaking the database message', async () => {
    stubWithError(
      { '/api/v1/operations/learner-content': { items: [authored] } },
      { '/api/v1/operations/learner-content/c-1/transition': { status: 400, body: { error: { code: 'SEPARATION_OF_DUTIES', correlationId: 'c-1' } } } },
    );
    await authenticate();
    render(<LearnerContentStudio />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approved' }));
    await waitFor(() => expect(screen.getByText(/an author cannot approve their own work/)).toBeInTheDocument());
  });

  it('says whether a model wrote it, for content nothing generated', async () => {
    stub({ '/api/v1/operations/learner-content': { items: [authored] } });
    await authenticate();
    render(<LearnerContentStudio />);
    // The column exists before there is ever a value in it, so nobody has to notice it appear.
    expect(await screen.findByText('No — written by a person')).toBeInTheDocument();
  });

  it('shows a generated draft as generated, with its prompt version', async () => {
    stub({ '/api/v1/operations/learner-content': { items: [{ ...authored, source: 'SEEDED', generatorVersion: 'model-x@1', promptVersion: 'practice@3' }] } });
    await authenticate();
    render(<LearnerContentStudio />);
    expect(await screen.findByText('model-x@1')).toBeInTheDocument();
    expect(screen.getByText('prompt practice@3')).toBeInTheDocument();
  });

  it('tells an operator that an empty queue is empty', async () => {
    stub({ '/api/v1/operations/learner-content': { items: [] } });
    await authenticate();
    render(<LearnerContentStudio />);
    expect(await screen.findByText(/Nothing is in the queue/)).toBeInTheDocument();
  });
});

describe('published content on a learner page', () => {
  it('renders nothing at all when nothing is published', async () => {
    stub({ '/api/v1/learner-content': { items: [] } });
    await authenticate();
    const { container } = render(<PublishedContentCard contentType="PRACTICE" title="Practice resources" />);
    // The page's own empty states already say there is nothing; an empty card would add noise.
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders what has been published, and no review paperwork with it', async () => {
    stub({ '/api/v1/learner-content': { items: [{ ...authored, publishedAt: '2026-09-10T00:00:00.000Z' }] } });
    await authenticate();
    render(<PublishedContentCard contentType="PRACTICE" title="Practice resources" />);
    expect(await screen.findByText('Reading a SIEM alert')).toBeInTheDocument();
    expect(screen.getByText('Begin with the source host.')).toBeInTheDocument();
    // A student reads the thing, not the paperwork about the thing.
    expect(document.body.textContent).not.toMatch(/IN_REVIEW|AUTHORED|review state/i);
  });

  it('shows only recognised text keys from a free-form body', async () => {
    stub({ '/api/v1/learner-content': { items: [{
      ...authored, publishedAt: '2026-09-10T00:00:00.000Z',
      content: { body: 'Shown to the student.', internalNote: 'Not for a student to read.', count: 3 },
    }] } });
    await authenticate();
    render(<PublishedContentCard contentType="PRACTICE" title="Practice resources" />);
    expect(await screen.findByText('Shown to the student.')).toBeInTheDocument();
    expect(screen.queryByText('Not for a student to read.')).not.toBeInTheDocument();
  });
});

type ErrorStub = Readonly<Record<string, { readonly status: number; readonly body: unknown }>>;

function stub(routes: Readonly<Record<string, unknown>>): void {
  stubWithError(routes, {});
}

function stubWithError(routes: Readonly<Record<string, unknown>>, errors: ErrorStub): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const failure = errors[path];
    if (failure) return { ok: false, status: failure.status, json: async () => failure.body };
    return { ok: true, status: 200, json: async () => routes[path] ?? {} };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
