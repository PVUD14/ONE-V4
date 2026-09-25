import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getPrivacyConsentStatus, getProtectedAccessToken, grantPrivacyConsent } from './api.js';

type GateState =
  | { readonly phase: 'checking' | 'clear' }
  | { readonly phase: 'unavailable'; readonly retrying: boolean }
  | { readonly phase: 'required'; readonly version: string; readonly busy: boolean; readonly error: string | null };

/**
 * DPDP consent gate. Dormant until a privacy-notice version is published in the
 * consent registry (migration 0028); once active, it blocks the authenticated
 * workspace behind a one-time consent screen and records the grant against the exact
 * version shown.
 *
 * **Fails closed.** If the status cannot be read, the workspace is not rendered. The
 * previous behaviour treated a failed check as consent, which meant a user could reach
 * their whole workspace during an outage without any consent record existing — the one
 * outcome the gate exists to prevent. An outage blocking the product is a visible,
 * fixable problem; processing personal data without a recorded lawful basis is not.
 *
 * Note that "no published notice" and "cannot tell" are different answers: the first
 * renders the workspace because there is genuinely nothing to consent to, the second
 * blocks.
 *
 * The `checking` phase is closed too (ENG-01): until the first answer arrives the gate
 * shows a short "checking" card instead of the workspace, so there is no window in which
 * the workspace renders before consent is known.
 */
export function ConsentGate({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  // Bumped by the retry button so the effect runs again after a failed check.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) { setState({ phase: 'clear' }); return; }
    const abort = new AbortController();
    getPrivacyConsentStatus(token, abort.signal).then((status) => {
      if (status.required && status.requiredVersion) {
        setState({ phase: 'required', version: status.requiredVersion, busy: false, error: null });
      } else {
        setState({ phase: 'clear' });
      }
    }).catch(() => {
      if (!abort.signal.aborted) setState({ phase: 'unavailable', retrying: false });
    });
    return () => abort.abort();
  }, [token, attempt]);

  if (state.phase === 'unavailable') {
    return (
      <div className="consent-gate" role="alert" aria-label="Consent status unavailable">
        <div className="consent-card">
          <span className="consent-icon"><ShieldCheck size={26} /></span>
          <h1>We could not confirm your privacy consent</h1>
          <p className="consent-sub">ONE will not open your workspace until it can confirm your consent is on record. This is usually a temporary connection problem.</p>
          <button type="button" className="consent-accept" disabled={state.retrying} onClick={() => { setState({ phase: 'unavailable', retrying: true }); setAttempt((value) => value + 1); }}>
            {state.retrying ? 'Checking…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === 'checking') {
    return (
      <div className="consent-gate" role="status" aria-label="Checking privacy consent">
        <div className="consent-card">
          <span className="consent-icon"><ShieldCheck size={26} /></span>
          <p className="consent-sub">Checking your privacy consent…</p>
        </div>
      </div>
    );
  }

  if (state.phase !== 'required') return <>{children}</>;

  const accept = async (): Promise<void> => {
    if (!token) return;
    setState({ ...state, busy: true, error: null });
    try {
      await grantPrivacyConsent(token, state.version);
      setState({ phase: 'clear' });
    } catch {
      setState({ ...state, busy: false, error: 'Your consent could not be recorded just now. Please try again.' });
    }
  };

  return (
    <div className="consent-gate" role="dialog" aria-modal="true" aria-label="Privacy notice and consent">
      <div className="consent-card">
        <span className="consent-icon"><ShieldCheck size={26} /></span>
        <h1>Your data, your consent</h1>
        <p className="consent-sub">Before you continue, please read how ONE handles your personal data and confirm your consent. This takes one minute and is asked only once per notice version.</p>
        <div className="consent-summary">
          <p><b>What we collect:</b> your profile (education, skills, projects, documents), assessment attempts and results, learning progress, and technical logs — to run your placement-readiness workspace.</p>
          <p><b>What stays private:</b> readiness guidance is advisory, never shown to employers and never public. Your profile is shared with others only when you choose to share it.</p>
          <p><b>AI features:</b> limited data is processed by our AI provider (Anthropic, in the United States) to power help and guidance. It is not used to train AI models.</p>
          <p><b>Your rights:</b> you can export a copy of your data, request correction or erasure, and withdraw consent at any time from Settings. Grievance contact details are in the full notice.</p>
        </div>
        <p className="consent-link">Read the full privacy notice (version {state.version}) in Settings → Privacy at any time.</p>
        {state.error ? <p className="consent-error">{state.error}</p> : null}
        <button type="button" className="consent-accept" disabled={state.busy} onClick={() => void accept()}>
          {state.busy ? 'Recording…' : 'I have read the notice and I consent'}
        </button>
      </div>
    </div>
  );
}
