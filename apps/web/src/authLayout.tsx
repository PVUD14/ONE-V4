/**
 * ONE · The frame every signed-out page sits in: sign-in, password reset, employer access and
 * the legal placeholders.
 *
 * It is the approved Infinity Loop sign-in, redrawn in Momentum (design inventory
 * unified/sign-in.html, sign-in-mobile.html): an always-dark brand panel whose right edge runs
 * on the 12° slant, carrying the ∞ ribbons, the logo, LEARN | PREPARE | BUILD | GROW and what ONE
 * promises (authShowcase.tsx), beside the form card. On a phone the panel becomes a compact hero
 * band and the card overlaps it. The panel carries no product screenshot or sample person: any
 * capture shows a sandbox student and figures, which real users must never see. Partner
 * institution logos belong here only once real partners have agreed to be shown.
 */
import { useState, type ReactNode } from 'react';
import { Icon } from './icons/Icon.js';
import { AuthShowcase, useSignInPlay } from './authShowcase.js';

export const productTagline = 'LEARN | PREPARE | BUILD | GROW';
export const supportEmail = 'info@ai8ht.pro';

export function AuthLayout({ children, onNavigate }: { readonly children: ReactNode; readonly onNavigate: (path: string) => void }): React.ReactElement {
  const { motion, played } = useSignInPlay();
  return <div className={`auth-split si${motion ? ' si-motion' : ''}${played ? ' is-played' : ''}`}>
    <div className="si-side" aria-hidden="true" />
    <AuthShowcase motion={motion} played={played} />
    <div className="auth-panel">
      <main className="auth-panel-main">
        {children}
      </main>
    </div>
    <AuthFooter onNavigate={onNavigate} />
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
export function PasswordInput({ id, name, autoComplete, disabled, invalid, describedBy, leadingIcon = false }: {
  readonly id: string;
  readonly name: string;
  readonly autoComplete: 'current-password' | 'new-password';
  readonly disabled?: boolean | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  /** A lock glyph at the start of the field, as on the sign-in card. */
  readonly leadingIcon?: boolean | undefined;
}): React.ReactElement {
  const [visible, setVisible] = useState(false);
  return <span className={`password-field${leadingIcon ? ' si-input' : ''}`}>
    {leadingIcon ? <Icon name="lock" size={16} className="si-input-icon" /> : null}
    <input id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
    <button type="button" className="password-toggle" onClick={() => setVisible((value) => !value)} disabled={disabled} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} aria-controls={id}>
      {visible ? <Icon name="eye-off" size={20} /> : <Icon name="eye" size={20} />}
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
