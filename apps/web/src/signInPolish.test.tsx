/**
 * The signed-out pages: what the sign-in card checks before it calls Cognito, the password
 * reset it now offers, and the internal wording and broken Hosted UI route it no longer shows.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeWebsite } from './publicEmployerAccessPage.js';

vi.setConfig({ testTimeout: 30000 });

const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];

function mockCognito(forgotError?: { code: string }, confirmError?: { code: string }): void {
  vi.doMock('amazon-cognito-identity-js', () => ({
    AuthenticationDetails: class { constructor(readonly details: unknown) {} },
    CognitoRefreshToken: class {},
    CognitoUserPool: class { constructor(readonly options: unknown) {} },
    CognitoUser: class {
      constructor(readonly options: { Username: string }) {}
      setAuthenticationFlowType(): void {}
      authenticateUser(_details: unknown, callbacks: { onFailure: (error: unknown) => void }): void {
        calls.push({ method: 'authenticateUser', args: [this.options.Username] });
        callbacks.onFailure({ code: 'NotAuthorizedException' });
      }
      forgotPassword(callbacks: { onSuccess: () => void; onFailure: (error: unknown) => void }): void {
        calls.push({ method: 'forgotPassword', args: [this.options.Username] });
        if (forgotError) callbacks.onFailure(forgotError); else callbacks.onSuccess();
      }
      confirmPassword(code: string, password: string, callbacks: { onSuccess: () => void; onFailure: (error: unknown) => void }): void {
        calls.push({ method: 'confirmPassword', args: [this.options.Username, code, password] });
        if (confirmError) callbacks.onFailure(confirmError); else callbacks.onSuccess();
      }
    },
  }));
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client');
  vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_pool');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
}

async function renderAt(path: string): Promise<void> {
  window.history.pushState(null, '', path);
  const { App } = await import('./App.js');
  render(React.createElement(App));
}

beforeEach(() => {
  cleanup();
  calls.length = 0;
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('amazon-cognito-identity-js');
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('amazon-cognito-identity-js');
});

describe('sign-in card', () => {
  it('shows no configuration diagnostics, no Hosted UI fallback, and the tagline once', async () => {
    mockCognito();
    await renderAt('/login');
    expect(screen.queryByText(/\bUAT\b|Cognito|configured/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hosted sign-in/i })).not.toBeInTheDocument();
    expect(screen.getAllByText('LEARN | PREPARE | BUILD | GROW')).toHaveLength(1);
    expect(screen.getByText('Demo – sample data')).toBeInTheDocument();
  });

  it('asks for the missing fields itself instead of sending an empty sign-in to Cognito', async () => {
    mockCognito();
    await renderAt('/login');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('still reports a wrong password from Cognito once both fields are filled', async () => {
    mockCognito();
    await renderAt('/login');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed. Check your email and password.');
    expect(calls.map((call) => call.method)).toEqual(['authenticateUser']);
  });

  it('lets a person show and hide the password they typed', async () => {
    mockCognito();
    await renderAt('/login');
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('carries a footer with the legal links and the contact address', async () => {
    mockCognito();
    await renderAt('/login');
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(/© \d{4} AI8HT\. All rights reserved\./);
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:info@ai8ht.pro');
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    expect(window.location.pathname).toBe('/privacy');
    expect(screen.getByRole('heading', { name: 'Privacy notice' })).toBeInTheDocument();
    expect(screen.getByText(/is being finalised/)).toBeInTheDocument();
  });
});

describe('password reset', () => {
  it('opens from the sign-in card, sends a code, then sets the new password', async () => {
    mockCognito();
    await renderAt('/login');
    fireEvent.click(screen.getByRole('link', { name: 'Forgot password?' }));
    expect(window.location.pathname).toBe('/forgot-password');
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByText('Enter the email you sign in with.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByText(/a code is on its way/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: ' 123456 ' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'New-Password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(calls).toEqual([
      { method: 'forgotPassword', args: ['person@example.test'] },
      { method: 'confirmPassword', args: ['person@example.test', '123456', 'New-Password-1'] },
    ]);
    expect(JSON.stringify(window.sessionStorage)).not.toContain('New-Password-1');
  });

  it('answers the same for an address with no account, so the form cannot find who is on ONE', async () => {
    mockCognito({ code: 'UserNotFoundException' });
    await renderAt('/forgot-password');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nobody@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByText(/If nobody@example.test has a ONE account, a code is on its way/)).toBeInTheDocument();
  });

  it('says plainly when the code is wrong', async () => {
    mockCognito(undefined, { code: 'CodeMismatchException' });
    await renderAt('/forgot-password');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'New-Password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That code is not right.'));
  });
});

describe('employer access website field', () => {
  it('adds https:// to a bare domain and leaves a full address alone', () => {
    expect(normalizeWebsite(' acme.com ')).toBe('https://acme.com');
    expect(normalizeWebsite('http://acme.com')).toBe('http://acme.com');
    expect(normalizeWebsite('https://www.acme.com/about')).toBe('https://www.acme.com/about');
    expect(normalizeWebsite('')).toBe('');
  });
});
