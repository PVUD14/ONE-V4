import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getPrivacyConsentStatus, getProtectedAccessToken, grantPrivacyConsent } from './api.js';

type GateState =
  | { readonly phase: 'checking' | 'clear' }
  | { readonly phase: 'required'; readonly version: string; readonly busy: boolean; readonly error: string | null };

/**
 * DPDP consent gate. Dormant until the server is configured with a published
 * privacy-notice version (CONSENT_PRIVACY_NOTICE_VERSION); once active, it
 * blocks the authenticated workspace behind a one-time consent screen and
 * records the grant against the exact version shown. Fails open on network
 * errors — a monitoring outage must not lock every user out of the product;
 * the server still holds the authoritative consent record.
 */
export function ConsentGate({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<GateState>({ phase: 'checking' });

  useEffect(() => {
    if (!token) { setState({ phase: 'clear' }); return; }
    const abort = new AbortController();
    getPrivacyConsentStatus(token, abort.signal).then((status) => {
      if (status.required && status.requiredVersion) {
        setState({ phase: 'required', version: status.requiredVersion, busy: false, error: null });
      } else {
        setState({ phase: 'clear' });
      }
    }).catch(() => setState({ phase: 'clear' }));
    return () => abort.abort();
  }, [token]);

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
