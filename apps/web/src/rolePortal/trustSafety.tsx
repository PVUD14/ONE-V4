/**
 * ONE · Role portal — Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Trust & Safety: the case queue and the detector queue, side by side.
 *
 * `opportunity_review_signals` has been written on every opportunity publish and read
 * by nothing. A signal is the most common reason a case gets opened, so the two
 * queues belong on one screen.
 *
 * Opening a case applies no penalty — spec 38 is explicit that a report does not
 * automatically penalise an employer — so this screen opens and moves cases and
 * carries no enforcement controls. Enforcement acts on a decided case, alongside the
 * decision that justified it. EMP-10: a case a student opened by reporting an employer's message
 * shows that conversation, on request, as the evidence it is.
 */
import { getProtectedAccessToken, getTrustCaseMessageThreads, listTrustCases, openTrustCaseFromSignal, transitionTrustCase } from '../api.js';
import type { ReviewSignalDto, TrustCaseDto, TrustCaseMessageThreadDto } from '../api.js';
import { V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError, RestrictedApiState } from './shared.js';
import { useEffect, useState } from 'react';

export function OperationsTrustSafetyPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [cases, setCases] = useState<readonly TrustCaseDto[]>([]);
  const [signals, setSignals] = useState<readonly ReviewSignalDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);
  // EMP-10: the reported conversation attached to one case, read on request (audited).
  const [evidence, setEvidence] = useState<{ readonly caseId: string; readonly threads: readonly TrustCaseMessageThreadDto[] } | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listTrustCases(token, false, controller.signal)
      .then((result) => { setCases(result.cases); setSignals(result.pendingSignals); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load trust and safety cases.')); });
    return () => controller.abort();
  }, [token, reload]);

  if (!token) return <RestrictedApiState title="Trust and Safety" message="Sign in with an authorized platform identity to review cases." />;

  const openFromSignal = async (signal: ReviewSignalDto): Promise<void> => {
    setBusy(signal.id);
    try {
      await openTrustCaseFromSignal(token, {
        caseType: 'OPPORTUNITY_MODERATION',
        subjectKind: 'OPPORTUNITY_VERSION',
        subjectId: signal.opportunityVersionId,
        // A demand for payment from an applicant is the one detector code that is
        // never a borderline call.
        severity: signal.signalCode === 'APPLICANT_PAYMENT_DEMAND' ? 'CRITICAL' : 'MEDIUM',
        signalIds: [signal.id],
      });
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be opened.'));
    } finally {
      setBusy('');
    }
  };

  const readConversation = async (record: TrustCaseDto): Promise<void> => {
    setBusy(record.id);
    try {
      const result = await getTrustCaseMessageThreads(token, record.id);
      setEvidence({ caseId: record.id, threads: result.threads });
    } catch (cause) {
      setError(formatApiError(cause, 'The reported conversation could not be loaded.'));
    } finally {
      setBusy('');
    }
  };

  const advance = async (record: TrustCaseDto, toState: string): Promise<void> => {
    setBusy(record.id);
    try {
      await transitionTrustCase(token, record.id, toState, 'OPERATIONS_REVIEW');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be moved.'));
    } finally {
      setBusy('');
    }
  };

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Platform operations</span><h1>Trust and Safety</h1>
      <p>Opening a case records a concern; it does not penalise anyone. Enforcement follows a decision, and a case never affects a student readiness band.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📂" tone="teal" value={cases.length} label="Open cases" />
      <V2Stat icon="🚨" tone="amber" value={cases.filter((record) => record.severity === 'CRITICAL' || record.severity === 'HIGH').length} label="High or critical" />
      <V2Stat icon="🔎" tone="purple" value={signals.length} label="Signals awaiting review" />
      <V2Stat icon="⚖️" tone="blue" value={cases.reduce((total, record) => total + record.liveActions, 0)} label="Live enforcement actions" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><h2>Detector signals awaiting review</h2>
      {!signals.length ? <p>No opportunity review signals are pending.</p> : <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Signal</th><th>Opportunity version</th><th>Detector</th><th>First seen</th><th>Action</th></tr></thead>
        <tbody>{signals.map((signal) => <tr key={signal.id}>
          <td><StatusBadge label={signal.signalCode} tone={signal.signalCode === 'APPLICANT_PAYMENT_DEMAND' ? 'danger' : 'warning'} /></td>
          <td>{signal.opportunityVersionId}</td>
          <td>{signal.detectorVersion}</td>
          <td>{new Date(signal.firstDetectedAt).toLocaleString()}</td>
          <td><button type="button" className="pilot-btn" disabled={busy === signal.id} onClick={() => void openFromSignal(signal)}>Open case</button></td>
        </tr>)}</tbody></table></div>}
    </section>
    <section className="role-card role-wide"><h2>Cases</h2>
      {!cases.length && !error ? <p>No open cases.</p> : null}
      {cases.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Type</th><th>Subject</th><th>Organization</th><th>Severity</th><th>State</th><th>Evidence</th><th>Opened</th><th>Next</th></tr></thead>
        <tbody>{cases.map((record) => <tr key={record.id}>
          <td>{record.caseType}</td>
          <td>{record.subjectKind}</td>
          <td>{record.organizationName ?? 'Platform'}</td>
          <td><StatusBadge label={record.severity} tone={record.severity === 'CRITICAL' ? 'danger' : record.severity === 'HIGH' ? 'warning' : 'neutral'} /></td>
          <td>{record.state}</td>
          <td>{record.evidenceCount}{record.caseType === 'EMPLOYER_ACCOUNTABILITY'
            ? <> <button type="button" className="pilot-btn" disabled={busy === record.id} onClick={() => void readConversation(record)}>Reported conversation</button></> : null}</td>
          <td>{new Date(record.openedAt).toLocaleDateString()}</td>
          <td>{record.state === 'REPORTED'
            ? <button type="button" className="pilot-btn" disabled={busy === record.id} onClick={() => void advance(record, 'TRIAGED')}>Triage</button>
            : record.state === 'TRIAGED'
              ? <button type="button" className="pilot-btn" disabled={busy === record.id} onClick={() => void advance(record, 'AWAITING_RESPONSE')}>Ask for response</button>
              : <span>&mdash;</span>}</td>
        </tr>)}</tbody></table></div> : null}
    </section>
    {evidence ? <section className="role-card role-wide" aria-label="Reported conversation">
      <h2>Reported conversation</h2>
      <p>Evidence on this case. Reading it is recorded. Message text is shown as written and never as a link.</p>
      {!evidence.threads.length ? <p>No application conversation is attached to this case.</p> : evidence.threads.map((thread) => <div key={thread.startedAt + thread.opportunityTitle}>
        <h3>{thread.employerName} · {thread.opportunityTitle}</h3>
        <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>From</th><th>Sent</th><th>Message</th><th>Report</th></tr></thead>
          <tbody>{thread.messages.map((message, index) => <tr key={index}>
            <td>{message.from === 'EMPLOYER' ? 'Employer' : 'Candidate'}</td>
            <td>{new Date(message.sentAt).toLocaleString()}</td>
            <td style={{ whiteSpace: 'pre-wrap' }}>{message.body ?? 'Erased'}{message.containsLink ? ' (contains a link)' : ''}</td>
            <td>{message.reported ? <StatusBadge label={message.reportReasonCode ?? 'REPORTED'} tone="warning" /> : null}</td>
          </tr>)}</tbody>
        </table></div>
      </div>)}
      <button type="button" className="pilot-btn" onClick={() => setEvidence(null)}>Close</button>
    </section> : null}
  </section>;
}
