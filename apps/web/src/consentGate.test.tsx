/**
 * The consent gate fails closed in every state (ENG-01): the workspace renders only once
 * the server has answered that nothing needs consenting to, never while it is still
 * checking and never when the check failed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from './api.js';
import { ConsentGate } from './consentGate.js';

vi.mock('./api.js', async (original) => ({
  ...await original<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(),
}));
const workspace = <p>Private workspace</p>;
let answer: (value: unknown) => void;
let fail: (error: unknown) => void;

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue('local-consent-test-token');
  vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve, reject) => {
    answer = (body) => resolve({ ok: true, json: async () => body });
    fail = reject;
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ConsentGate', () => {
  it('shows a checking state, not the workspace, until the answer arrives', async () => {
    render(<ConsentGate>{workspace}</ConsentGate>);
    expect(screen.getByRole('status', { name: 'Checking privacy consent' })).toBeInTheDocument();
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument();
    answer({ required: false, requiredVersion: null });
    expect(await screen.findByText('Private workspace')).toBeInTheDocument();
  });

  it('asks for consent when a notice version is required, and still hides the workspace', async () => {
    render(<ConsentGate>{workspace}</ConsentGate>);
    answer({ required: true, requiredVersion: '2026-09' });
    expect(await screen.findByRole('dialog', { name: 'Privacy notice and consent' })).toBeInTheDocument();
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument();
  });

  it('blocks with a retry when the check fails, and opens only after a successful retry', async () => {
    render(<ConsentGate>{workspace}</ConsentGate>);
    fail(new TypeError('network down'));
    expect(await screen.findByRole('alert', { name: 'Consent status unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    answer({ required: false, requiredVersion: null });
    expect(await screen.findByText('Private workspace')).toBeInTheDocument();
  });

  it('does not check anything for a signed-out visitor', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<ConsentGate>{workspace}</ConsentGate>);
    expect(screen.getByText('Private workspace')).toBeInTheDocument();
  });
});
