/**
 * ONE · The frame every signed-out page sits in: sign-in, password reset, employer access and
 * the legal placeholders.
 *
 * The left panel says what ONE is before asking anyone to sign in, which the bare logo on a
 * black-to-white fade never did. It carries no product screenshot: any capture shows a sandbox
 * student and figures, and Divakar did not want a "Demo – sample data" label on the sign-in page,
 * so a picture would put fictional people in front of real users. Partner institution logos belong here too, but only once real partners have agreed to be
 * shown; until then the slot is simply absent rather than filled with stand-ins.
 */
import { useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { BrandLogo } from './brand.js';

export const productTagline = 'LEARN | PREPARE | BUILD | GROW';
export const supportEmail = 'info@ai8ht.pro';

const benefits: ReadonlyArray<{ readonly who: string; readonly what: string }> = [
  { who: 'Students and graduates', what: 'An advisory readiness band built from verified evidence, and a plan to move it.' },
  { who: 'Colleges', what: 'Cohorts, verification and placement drives run from one record.' },
  { who: 'Employers', what: 'Verified candidates who chose to be seen, with every stage in one place.' },
];

export function AuthLayout({ children, onNavigate }: { readonly children: ReactNode; readonly onNavigate: (path: string) => void }): React.ReactElement {
  return <div className="auth-split">
    <aside className="auth-showcase" aria-label="About ONE">
      <BrandLogo className="auth-showcase-logo" surface="dark" height={112} />
      <h2 className="auth-showcase-title">One workspace from learning to landing the role.</h2>
      <ul className="auth-benefits">
        {benefits.map((benefit) => <li key={benefit.who}><strong>{benefit.who}</strong><span>{benefit.what}</span></li>)}
      </ul>
      <p className="auth-showcase-tagline">{productTagline}</p>
    </aside>
    <div className="auth-panel">
      <main className="auth-panel-main">
        {children}
      </main>
      <AuthFooter onNavigate={onNavigate} />
    </div>
  </div>;
}

export function AuthFooter({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  const go = (path: string) => (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onNavigate(path); };
  return <footer className="auth-footer">
    <span>© {new Date().getFullYear()} AI8HT. All rights reserved.</span>
    <nav aria-label="Legal">
      <a href="/privacy" onClick={go('/privacy')}>Privacy</a>
      <a href="/terms" onClick={go('/terms')}>Terms</a>
      <a href={`mailto:${supportEmail}`}>Contact</a>
    </nav>
  </footer>;
}

/** A password input with a show/hide control, so a person can check what they typed on a phone. */
export function PasswordInput({ id, name, autoComplete, disabled, invalid, describedBy }: {
  readonly id: string;
  readonly name: string;
  readonly autoComplete: 'current-password' | 'new-password';
  readonly disabled?: boolean | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
}): React.ReactElement {
  const [visible, setVisible] = useState(false);
  return <span className="password-field">
    <input id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
    <button type="button" className="password-toggle" onClick={() => setVisible((value) => !value)} disabled={disabled} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} aria-controls={id}>
      {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
    </button>
  </span>;
}

/**
 * /privacy and /terms. The notices themselves are drafts awaiting legal review
 * (docs/legal/), and publishing a draft as if it were in force would be worse than saying
 * plainly that it is not ready. These pages say exactly that and give the contact address.
 */
export function LegalPlaceholderPage({ kind, onNavigate }: { readonly kind: 'privacy' | 'terms'; readonly onNavigate: (path: string) => void }): React.ReactElement {
  const title = kind === 'privacy' ? 'Privacy notice' : 'Terms of use';
  return <AuthLayout onNavigate={onNavigate}>
    <section className="login-card" aria-labelledby="one-legal-title">
      <p className="auth-eyebrow">ONE BY AI8HT</p>
      <h1 id="one-legal-title">{title}</h1>
      <p className="auth-subtitle">Our {title.toLowerCase()} is being finalised and will be published here. Until then, write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a> with any question about how ONE handles your information.</p>
      <button type="button" className="secondary" onClick={() => onNavigate('/login')}>Back to sign in</button>
    </section>
  </AuthLayout>;
}
