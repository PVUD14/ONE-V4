import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

/**
 * The Documents page is reached through the authenticated Student route, so these
 * drive the real app rather than the component in isolation. What matters here is
 * that a rejected file is explained honestly: a student must be told their file was
 * refused and that nothing was kept.
 */

const student = { userId: 'student-1', fullName: 'Aanya Student', verifiedEmail: 'aanya@uat.example.test', institutionStudentId: 'UAT-STU-001', institutionId: 'inst-1', academicStatus: 'ACTIVE', department: null, program: null, batch: null, section: null };
// studentRelationships is what routes an identity with no org membership to /student.
const securityContext = { userId: 'student-1', memberships: [], studentRelationships: [{ institutionId: 'inst-1', state: 'ACTIVE', effectiveFrom: '2026-08-01T00:00:00.000Z' }] };

function documentsPayload(file: unknown) {
  return {
    documents: [{
      id: '11111111-1111-4111-8111-111111111111',
      title: 'My CV', documentType: 'RESUME', description: null,
      verificationState: 'SELF_REPORTED', archivedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      file,
    }],
    storage: { fileStorage: 'AVAILABLE', message: 'Files are scanned for malware before they are stored.' },
  };
}

let uploadResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 201, body: { file: { id: 'f-1', versionNumber: 1, filename: 'cv.pdf', byteSize: 2048 } } };
let attachedFile: unknown = null;

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  attachedFile = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token' }) };
    if (url.endsWith('/health')) return { ok: true, status: 200 };
    if (url.includes('/students/me/documents') && init?.method === 'POST') {
      return { ok: uploadResponse.ok, status: uploadResponse.status, json: async () => uploadResponse.body };
    }
    if (url.includes('/api/v1/students/me/documents')) return { ok: true, status: 200, json: async () => documentsPayload(attachedFile) };
    if (url.includes('/api/v1/students/me/profile')) return { ok: true, status: 200, json: async () => ({ profile: { targetCareer: null, careerInterests: [], profileHeadline: null, profileSummary: null, portfolioUrl: null, visibilityState: 'PRIVATE', employerDiscoveryEnabled: false } }) };
    if (url.includes('/api/v1/students/me')) return { ok: true, status: 200, json: async () => ({ student }) };
    if (url.includes('/api/v1/security/context')) return { ok: true, status: 200, json: async () => securityContext };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

/** Signs in through the callback, lets the app route to /student, then opens Documents. */
async function openDocuments(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  render(<App />);
  await waitFor(() => expect(window.location.pathname).toBe('/student'));
  fireEvent.click(await screen.findByRole('button', { name: 'Documents' }));
  await screen.findByRole('heading', { name: 'Your documents', level: 2 });
}

function pdfFile(name = 'cv.pdf'): File {
  return new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' });
}

describe('student document upload', () => {
  it('shows no file attached until one is', async () => {
    await openDocuments();
    expect(await screen.findByText('No file attached')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('confirms a clean upload and reports the scan', async () => {
    uploadResponse = { ok: true, status: 201, body: { file: { id: 'f-1', versionNumber: 1, filename: 'cv.pdf', byteSize: 2048 } } };
    await openDocuments();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    await waitFor(() => expect(screen.getByText(/cv\.pdf attached and scanned clean \(version 1\)/)).toBeInTheDocument());
  });

  it('tells the student plainly when a file is rejected as malware', async () => {
    uploadResponse = { ok: false, status: 400, body: { error: { code: 'FILE_REJECTED_MALWARE', correlationId: 'c-1' } } };
    await openDocuments();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile('bad.pdf')] } });
    await waitFor(() => expect(screen.getByText(/a malware scan flagged it\. Nothing was stored\./)).toBeInTheDocument());
  });

  it('distinguishes an unavailable scanner from an infected file', async () => {
    uploadResponse = { ok: false, status: 503, body: { error: { code: 'FILE_SCAN_UNAVAILABLE', correlationId: 'c-2' } } };
    await openDocuments();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    // Not the student's fault and not their file's fault; say so.
    await waitFor(() => expect(screen.getByText(/scanner is unavailable right now/)).toBeInTheDocument());
    expect(screen.queryByText(/malware scan flagged/)).not.toBeInTheDocument();
  });

  it('refuses an oversized file before sending it', async () => {
    await openDocuments();
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const before = fetchMock.mock.calls.length;
    const huge = new File([new Uint8Array(1)], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [huge] } });
    await waitFor(() => expect(screen.getByText(/larger than 20 MB/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('offers download and replace once a scanned file is attached', async () => {
    attachedFile = { versionNumber: 2, filename: 'cv.pdf', byteSize: 4096, contentType: 'application/pdf' };
    await openDocuments();
    expect(await screen.findByText('cv.pdf')).toBeInTheDocument();
    expect(screen.getByText(/v2 · 4 KB · scanned clean/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('only offers the accepted file types', async () => {
    await openDocuments();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('application/pdf');
    expect(input.accept).not.toContain('application/x-msdownload');
  });
});
