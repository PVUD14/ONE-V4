/**
 * ONE · Public "request employer access" page (EMP-04).
 *
 * A company that wants to hire on ONE had no way to ask: every employer exists because an
 * operator typed it in. This page lets someone ask, without an account. It creates only a
 * pending request for AI8HT operations to review — no account, no organisation, nothing
 * published — and says so plainly.
 *
 * The API answers the same way whatever already exists on ONE, so the confirmation here never
 * says whether a company or address is known. Rate limits and the work-email rule are the
 * server's; this page only reports their answers. It renders without a session, so it is
 * routed before any signed-in check in App.tsx. Branding is the ONE logo via
 * BrandLogo, like the sign-in page it sits beside.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, submitEmployerAccessRequest } from './api.js';
import { BrandLogo } from './brand.js';

const productName = 'ONE by AI8HT';

function messageFor(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Your request could not be sent. Check your connection and try again.';
  const reference = ` Reference: ${error.correlationId}`;
  switch (error.code) {
    case 'EMPLOYER_ACCESS_REQUEST_WORK_EMAIL_REQUIRED': return `Use your work email address — personal webmail addresses cannot be accepted.${reference}`;
    case 'EMPLOYER_ACCESS_REQUEST_RATE_LIMITED': return `Too many requests have been sent from here recently. Please try again later.${reference}`;
    case 'EMPLOYER_ACCESS_REQUEST_EMAIL_INVALID': return `Enter a valid work email address.${reference}`;
    case 'EMPLOYER_ACCESS_REQUEST_WEBSITE_INVALID': return `Enter your company website starting with https://.${reference}`;
    case 'EMPLOYER_ACCESS_REQUEST_NAME_INVALID': return `Enter your name (up to 120 characters).${reference}`;
    case 'EMPLOYER_ACCESS_REQUEST_COMPANY_INVALID': return `Enter your company name (up to 180 characters).${reference}`;
    default: return `Your request could not be sent. Check the fields and try again.${reference}`;
  }
}

export function PublicEmployerAccessPage({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  const [form, setForm] = useState({ requesterName: '', companyName: '', workEmail: '', websiteUrl: 'https://' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { document.title = `Request employer access | ${productName}`; }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await submitEmployerAccessRequest({
        requesterName: form.requesterName.trim(), companyName: form.companyName.trim(),
        workEmail: form.workEmail.trim(), websiteUrl: form.websiteUrl.trim(),
      });
      setSent(true);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-shell">
    <section className="login-card" aria-labelledby="one-employer-access-title">
      <BrandLogo className="login-logo" height={72} />
      <p className="auth-eyebrow">ONE FOR EMPLOYERS</p>
      <h1 id="one-employer-access-title">Request employer access</h1>
      {sent ? <>
        <p className="auth-subtitle" role="status">Thank you. Your request has been received.</p>
        <p>AI8HT operations reviews every request by hand. If we can confirm your company, we will contact you at the work email you gave. No account has been created and nothing has been published.</p>
        <button type="button" className="secondary" onClick={() => onNavigate('/login')}>Back to sign in</button>
      </> : <>
        <p className="auth-subtitle">Tell us who you are and we will be in touch. AI8HT operations verifies every employer before it can post jobs or see candidates.</p>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="one-access-name">Your name</label>
          <input id="one-access-name" name="requesterName" autoComplete="name" maxLength={120} required value={form.requesterName}
            onChange={(event) => setForm((value) => ({ ...value, requesterName: event.target.value }))} />
          <label htmlFor="one-access-company">Company name</label>
          <input id="one-access-company" name="companyName" autoComplete="organization" maxLength={180} required value={form.companyName}
            onChange={(event) => setForm((value) => ({ ...value, companyName: event.target.value }))} />
          <label htmlFor="one-access-email">Work email</label>
          <input id="one-access-email" name="workEmail" type="email" autoComplete="email" inputMode="email" maxLength={254} required value={form.workEmail}
            onChange={(event) => setForm((value) => ({ ...value, workEmail: event.target.value }))} />
          <label htmlFor="one-access-website">Company website</label>
          <input id="one-access-website" name="websiteUrl" type="url" autoComplete="url" maxLength={256} required value={form.websiteUrl}
            onChange={(event) => setForm((value) => ({ ...value, websiteUrl: event.target.value }))} />
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        </form>
        {error ? <p className="auth-boundary" role="alert">{error}</p> : null}
        <p className="auth-footnote">We use these details only to review your request and contact you about it.</p>
        <button type="button" className="secondary" onClick={() => onNavigate('/login')}>Back to sign in</button>
      </>}
    </section>
  </main>;
}
