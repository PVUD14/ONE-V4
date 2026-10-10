/**
 * ONE · Forgot password.
 *
 * The sign-in card had no way back for someone who forgot their password. This page runs
 * Cognito's own reset: it emails a one-time code, then takes the code and a new password.
 * The first step answers the same whether or not the address has an account, so the page
 * cannot be used to find out who is on ONE.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { confirmPasswordReset, requestPasswordReset, type PasswordResetResult } from './auth.js';
import { AuthLayout, PasswordInput } from './authLayout.js';

const productName = 'ONE by AI8HT';

function messageFor(result: PasswordResetResult): string {
  switch (result.state) {
    case 'code_invalid': return 'That code is not right. Check the latest email from ONE and try again.';
    case 'code_expired': return 'That code has expired. Ask for a new one below.';
    case 'password_rejected': return 'Choose a stronger password: at least 8 characters, with upper and lower case letters, a number and a symbol.';
    case 'rate_limited': return 'Too many attempts. Wait a few minutes and try again.';
    case 'unconfigured': return 'Password reset is not available right now. Write to info@ai8ht.pro for help.';
    default: return 'Something went wrong. Try again in a moment.';
  }
}

export function ForgotPasswordPage({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  const [step, setStep] = useState<'request' | 'confirm' | 'done'>('request');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => { document.title = `Reset password | ${productName}`; }, []);

  async function sendCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    if (!value) { setFieldErrors({ email: 'Enter the email you sign in with.' }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setFieldErrors({ email: 'Enter a valid email address.' }); return; }
    setFieldErrors({}); setError(''); setBusy(true);
    const result = await requestPasswordReset(value);
    setBusy(false);
    if (result.state === 'code_sent') { setEmail(value); setStep('confirm'); return; }
    setError(messageFor(result));
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    const password = String(form.get('newPassword') ?? '');
    const errors: Record<string, string> = {};
    if (!code) errors.code = 'Enter the code from the email.';
    if (!password) errors.newPassword = 'Choose a new password.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setError(''); setBusy(true);
    const result = await confirmPasswordReset(email, code, password);
    setBusy(false);
    if (result.state === 'reset') { setStep('done'); return; }
    setError(messageFor(result));
  }

  return <AuthLayout onNavigate={onNavigate}>
    <section className="login-card" aria-labelledby="one-reset-title">
      <p className="auth-eyebrow">ONE PLATFORM</p>
      <h1 id="one-reset-title">{step === 'done' ? 'Password changed' : 'Reset your password'}</h1>
      {step === 'request' ? <>
        <p className="auth-subtitle">Enter the email you sign in with. If it has a ONE account, we will email you a code to set a new password.</p>
        <form className="login-form" onSubmit={(event) => void sendCode(event)} noValidate>
          <label htmlFor="one-reset-email">Email</label>
          <input id="one-reset-email" name="email" type="email" autoComplete="username" inputMode="email" aria-invalid={fieldErrors.email ? true : undefined} aria-describedby={fieldErrors.email ? 'one-reset-email-error' : undefined} />
          {fieldErrors.email ? <p id="one-reset-email-error" className="field-error">{fieldErrors.email}</p> : null}
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
        </form>
      </> : null}
      {step === 'confirm' ? <>
        <p className="auth-subtitle" role="status">If {email} has a ONE account, a code is on its way. It can take a minute to arrive.</p>
        <form className="login-form" onSubmit={(event) => void confirm(event)} noValidate>
          <label htmlFor="one-reset-code">Code from the email</label>
          <input id="one-reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" aria-invalid={fieldErrors.code ? true : undefined} aria-describedby={fieldErrors.code ? 'one-reset-code-error' : undefined} />
          {fieldErrors.code ? <p id="one-reset-code-error" className="field-error">{fieldErrors.code}</p> : null}
          <label htmlFor="one-reset-password">New password</label>
          <PasswordInput id="one-reset-password" name="newPassword" autoComplete="new-password" invalid={Boolean(fieldErrors.newPassword)} describedBy={fieldErrors.newPassword ? 'one-reset-password-error' : 'one-reset-password-hint'} />
          {fieldErrors.newPassword ? <p id="one-reset-password-error" className="field-error">{fieldErrors.newPassword}</p> : <p id="one-reset-password-hint" className="field-hint">At least 8 characters, with upper and lower case letters, a number and a symbol.</p>}
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set new password'}</button>
        </form>
        <button type="button" className="auth-text-button" onClick={() => { setStep('request'); setError(''); setFieldErrors({}); }}>Send a new code</button>
      </> : null}
      {step === 'done' ? <>
        <p className="auth-subtitle" role="status">Your password has been changed. Sign in with your new password.</p>
        <button type="button" className="auth-primary" onClick={() => onNavigate('/login')}>Go to sign in</button>
      </> : null}
      {error ? <p className="auth-boundary auth-error" role="alert">{error}</p> : null}
      {step !== 'done' ? <p className="auth-footnote"><a href="/login" onClick={(event) => { event.preventDefault(); onNavigate('/login'); }}>Back to sign in</a></p> : null}
    </section>
  </AuthLayout>;
}
