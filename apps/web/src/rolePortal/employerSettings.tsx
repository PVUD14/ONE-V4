/**
 * ONE · Employer portal — Settings and trust cases (EMP-16).
 *
 * The screen behind the recruiter portal's existing "Settings" label, which said "Not built yet".
 * It shows the employer terms (with their legal-review state, so a draft is never presented as
 * final) and lets an owner accept the current version; what ONE keeps about candidates and for how
 * long, read from the values the server enforces; the viewer's own notification preferences; and
 * the trust and safety cases about the organisation that AI8HT operations has disclosed, with the
 * right to respond and to appeal a decision once.
 *
 * The trust-case panel is also shown on the plain status page of a suspended or rejected employer,
 * because answering a case is the one thing such an employer can still do (Appendix 2 §5.1).
 * Whether the viewer may accept, respond or appeal is the server's answer; this page decides
 * nothing about authority. Nothing is invented: a missing value is left out, or said plainly
 * ("Not yet", "Not recorded") where a table cell must stay.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getProtectedAccessToken } from '../api.js';
import {
  acceptEmployerTerms,
  answerEmployerTrustCase,
  getEmployerSettings,
  getEmployerTrustCase,
  listEmployerTrustCases,
  updateEmployerNotificationPreferences,
  type EmployerSettingsDto,
  type EmployerTrustCaseDetailDto,
  type EmployerTrustCaseDto,
} from '../api/employerTerms.js';
import { V2Stat } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import * as dates from '../dates.js';

function formatDate(value: string | null | undefined, missing = 'Not recorded'): string {
  if (!value) return missing;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? missing : dates.formatDate(date);
}

/** " Title (version N)" for a job, leaving out whichever part was not recorded. */
function jobAndVersion(title: string | null | undefined, version: number | string | null | undefined): string {
  return `${title ? ` ${title}` : ''}${version !== null && version !== undefined ? ` (version ${version})` : ''}`;
}

const termsStatusLabels: Readonly<Record<string, string>> = {
  NO_TERMS_PUBLISHED: 'None published',
  ACCEPTED: 'Accepted',
  ACCEPTANCE_REQUIRED: 'Acceptance needed',
};

const accessEndsLabels: Readonly<Record<string, string>> = {
  APPLICATION_CLOSED: 'you hire or reject the candidate',
  CANDIDATE_WITHDREW: 'the candidate withdraws',
  CANDIDATE_DECLINED_NEW_TERMS: 'the candidate declines changed job terms',
  CANDIDATE_DELETED_ACCOUNT: 'the candidate asks ONE to delete their account',
  ACCESS_PERIOD_EXPIRED: 'an access period set for the application runs out',
};

export function EmployerSettingsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [settings, setSettings] = useState<EmployerSettingsDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [dailyCap, setDailyCap] = useState(3);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getEmployerSettings(token, employerId, controller.signal).then(({ settings: loaded }) => {
      if (controller.signal.aborted) return;
      setSettings(loaded); setLoadError('');
      const preferences = loaded.notificationPreferences ?? loaded.notificationDefaults;
      setEmailEnabled(preferences.emailEnabled); setDailyCap(preferences.dailyCap);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(cause instanceof ApiRequestError && cause.code === 'EMPLOYER_ORGANISATION_INACTIVE'
        ? `Your employer account is suspended or was not approved, so Settings is not available.${supportCodeSuffix(cause.correlationId)}`
        : formatApiError(cause, 'Your settings could not be loaded.'));
    });
    return () => controller.abort();
  }, [token, employerId]);

  const subtitle = 'Employer terms, what ONE keeps about candidates, and your notifications.';
  if (!token) return <StaffPilotWrap title="Settings" subtitle="Sign in with an employer identity to see your settings."><p role="status">You are not signed in.</p></StaffPilotWrap>;
  if (loadError) return <StaffPilotWrap title="Settings" subtitle={subtitle}><p className="form-error" role="alert">{loadError}</p></StaffPilotWrap>;
  if (!settings) return <StaffPilotWrap title="Settings" subtitle={subtitle}><p role="status">Loading your settings…</p></StaffPilotWrap>;

  const { terms, retention } = settings;
  const current = terms.current;

  async function accept(): Promise<void> {
    if (!current) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { settings: updated } = await acceptEmployerTerms(token!, employerId, current.version);
      setSettings(updated);
      setNotice(`You accepted version ${current.version} for your organisation.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The terms could not be accepted.'));
    } finally {
      setBusy(false);
    }
  }

  async function savePreferences(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const { settings: updated } = await updateEmployerNotificationPreferences(token!, employerId, { emailEnabled, dailyCap });
      setSettings(updated);
      setNotice('Your notification preferences are saved.');
    } catch (cause) {
      setError(formatApiError(cause, 'Your notification preferences could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  return <StaffPilotWrap title="Settings" subtitle={subtitle}>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📜" tone="teal" value={termsStatusLabels[terms.status] ?? null} label="Employer terms" />
      <V2Stat icon="✅" tone="blue" value={terms.latestAcceptance?.version ?? null} label="Version accepted" />
      <V2Stat icon="💬" tone="amber" value={`${retention.messageRetentionDaysAfterAccessEnds} days`} label="Messages kept after access ends" />
      <V2Stat icon="📄" tone="purple" value={`${retention.resumeLinkSeconds} s`} label="Résumé link lifetime" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    <section className="role-card role-wide" aria-label="Employer terms">
      <h2>Employer terms</h2>
      {!current ? <p>AI8HT has not published employer terms yet, so there is nothing to accept. Publishing works as it does today.</p> : <>
        <p>
          <strong>{current.title}</strong> · version {current.version} · published {formatDate(current.publishedAt)}{' '}
          {current.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW'
            ? <StatusBadge label="Draft — pending legal review" tone="warning" />
            : <StatusBadge label="Reviewed" tone="success" />}
        </p>
        {current.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW'
          ? <p className="hiring-meta">This text is a draft that has not finished legal review. It is not final.</p>
          : current.legalReviewReference ? <p className="hiring-meta">Legal review: {current.legalReviewReference}</p> : null}
        {current.changeSummary ? <p><strong>What changed:</strong> {current.changeSummary}</p> : null}
        <div style={{ whiteSpace: 'pre-wrap' }} aria-label="Terms text">{current.body}</div>
        <p role="status">{terms.status === 'ACCEPTED'
          ? terms.currentVersionAccepted ? 'Your organisation has accepted these terms.' : 'Your organisation has accepted the terms it needs to; this latest version changed nothing that needs accepting again.'
          : 'An owner of your organisation must accept these terms before your organisation publishes another job. Jobs already live stay live.'}</p>
        <p className="hiring-meta">{terms.latestAcceptance
          ? `Last accepted: version ${terms.latestAcceptance.version} on ${formatDate(terms.latestAcceptance.acceptedAt)}${terms.latestAcceptance.acceptedBy ? ` by ${terms.latestAcceptance.acceptedBy}` : ''}.`
          : 'Not accepted yet.'}</p>
        {terms.canAccept
          ? <button type="button" disabled={busy} onClick={() => void accept()}>Accept version {current.version} for my organisation</button>
          : terms.status === 'ACCEPTANCE_REQUIRED' ? <p className="hiring-meta">Only an owner can accept the terms for the organisation.</p> : null}
      </>}
    </section>

    <section className="role-card role-wide" aria-label="What ONE keeps">
      <h2>What ONE keeps about candidates</h2>
      <p>You see a candidate only while their application gives you access. Access ends when {retention.accessEndsWhen.map((code) => accessEndsLabels[code] ?? code).join(', or when ')}.</p>
      <ul>
        <li>Résumé downloads are single-use links that expire after {retention.resumeLinkSeconds} seconds.</li>
        <li>Message text is erased {retention.messageRetentionDaysAfterAccessEnds} days after your access to that candidate ends.</li>
        <li>A candidate who asks to delete their account has {retention.candidateDeletionGraceDays} days to change their mind; you lose access as soon as they ask.</li>
        {retention.heldForOpenTrustCasesAndLegalHolds ? <li>Nothing is erased while an open trust and safety case or a legal hold needs it.</li> : null}
      </ul>
    </section>

    <form className="role-card role-wide role-management-form" aria-label="Your notifications" onSubmit={(event) => void savePreferences(event)}>
      <h2>Your notifications</h2>
      <p className="hiring-meta">These are your own preferences, not your organisation's.</p>
      <label><span>Email me about hiring activity</span><input type="checkbox" checked={emailEnabled} onChange={(event) => setEmailEnabled(event.target.checked)} /></label>
      <label><span>Most emails a day</span><input type="number" min={0} max={20} value={dailyCap}
        onChange={(event) => setDailyCap(Math.max(0, Math.min(20, Number(event.target.value) || 0)))} /></label>
      <button type="submit" disabled={busy}>Save notifications</button>
    </form>

    <EmployerTrustCasesPanel employerId={employerId} />
  </StaffPilotWrap>;
}

const caseStatusLabels: Readonly<Record<string, string>> = {
  UNDER_REVIEW: 'Under review',
  RESPONSE_REQUESTED: 'Your response is requested',
  DECIDED: 'Decided',
  APPEAL_UNDER_REVIEW: 'Appeal under review',
  CLOSED: 'Closed',
  CLOSED_NO_ACTION: 'Closed without action',
};
const caseTypeLabels: Readonly<Record<string, string>> = {
  EMPLOYER_ACCOUNTABILITY: 'Employer conduct',
  OPPORTUNITY_MODERATION: 'Job posting',
  USER_SAFETY: 'Safety',
  CONTENT: 'Content',
};
const statementLabels: Readonly<Record<string, string>> = {
  ALLEGATION_SUMMARY: 'What AI8HT operations shared',
  DECISION_SUMMARY: 'Decision',
  EMPLOYER_RESPONSE: 'Your response',
  EMPLOYER_APPEAL: 'Your appeal',
};
const actionLabels: Readonly<Record<string, string>> = {
  WARNING: 'Warning', ENHANCED_MODERATION: 'Enhanced moderation', POSTING_RESTRICTION: 'Posting restriction',
  TRUST_DOWNGRADE: 'Trust downgrade', TEMPORARY_SUSPENSION: 'Temporary suspension', PERMANENT_REMOVAL: 'Permanent removal',
};

function subjectLabel(record: EmployerTrustCaseDto): string {
  return record.subject.kind === 'JOB' ? `${record.subject.jobTitle ? 'Job:' : 'A job'}${jobAndVersion(record.subject.jobTitle, record.subject.jobVersion)}` : 'Your organisation';
}

/** Trust and safety cases about the employer that operations have disclosed. */
export function EmployerTrustCasesPanel({ employerId }: { readonly employerId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [cases, setCases] = useState<readonly EmployerTrustCaseDto[] | null>(null);
  const [open, setOpen] = useState<EmployerTrustCaseDetailDto | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'owner-only' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listEmployerTrustCases(token, employerId, controller.signal).then(({ cases: loaded }) => {
      if (controller.signal.aborted) return;
      setCases(loaded); setState('ready');
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiRequestError && cause.status === 403) { setState('owner-only'); return; }
      setError(formatApiError(cause, 'Trust and safety cases could not be loaded.')); setState('error');
    });
    return () => controller.abort();
  }, [token, employerId, reload]);

  async function openCase(caseId: string): Promise<void> {
    if (!token) return;
    setBusy(true); setError(''); setNotice(''); setDraft('');
    try {
      setOpen((await getEmployerTrustCase(token, employerId, caseId)).case);
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be loaded.'));
    } finally {
      setBusy(false);
    }
  }

  async function answer(kind: 'response' | 'appeal'): Promise<void> {
    if (!token || !open || !draft.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      setOpen((await answerEmployerTrustCase(token, employerId, open.id, kind, draft.trim())).case);
      setDraft('');
      setNotice(kind === 'response' ? 'Your response was sent to AI8HT operations.' : 'Your appeal was sent to AI8HT operations.');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, kind === 'response' ? 'Your response could not be sent.' : 'Your appeal could not be sent.'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide" aria-label="Trust and safety cases">
    <h2>Trust and safety cases</h2>
    <p className="hiring-meta">A report about your organisation opens a case; it is not a penalty. You see a case once AI8HT operations asks you to respond or decides it. You are never told who reported it.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {state === 'loading' ? <p role="status">Loading cases…</p> : null}
    {state === 'owner-only' ? <p>Trust and safety cases are answered by your employer&apos;s owner or admin.</p> : null}
    {state === 'ready' && cases && !cases.length ? <p>There are no trust and safety cases about your organisation.</p> : null}
    {state === 'ready' && cases && cases.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Concern</th><th>About</th><th>Status</th><th>Response requested</th><th>Decided</th><th>Details</th></tr></thead>
      <tbody>{cases.map((record) => <tr key={record.id}>
        <td>{caseTypeLabels[record.caseType] ?? record.caseType}</td>
        <td>{subjectLabel(record)}</td>
        <td><StatusBadge label={caseStatusLabels[record.status] ?? record.status} tone={record.status === 'RESPONSE_REQUESTED' ? 'warning' : 'neutral'} /></td>
        <td>{formatDate(record.responseRequestedAt, 'Not requested')}</td>
        <td>{formatDate(record.decidedAt, 'Not yet')}</td>
        <td><button type="button" className="pilot-btn" disabled={busy} onClick={() => void openCase(record.id)}>Open</button></td>
      </tr>)}</tbody>
    </table></div> : null}

    {open ? <div className="role-card" aria-label="Case details">
      <h3>{caseTypeLabels[open.caseType] ?? open.caseType} · {subjectLabel(open)}</h3>
      <p role="status">{caseStatusLabels[open.status] ?? open.status}</p>
      {open.statements.map((statement, index) => <div key={index}>
        <p><strong>{statementLabels[statement.kind] ?? statement.kind}</strong> · {formatDate(statement.createdAt)}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{statement.body}</p>
      </div>)}
      <p><strong>Evidence shared with you:</strong> {open.evidence.shared.length
        ? open.evidence.shared.map((item) => item.kind === 'DETECTOR_SIGNAL'
          ? `Automatic check${item.signalCode ? ` "${item.signalCode}"` : ''}${item.jobTitle ? ' on' : ''}${jobAndVersion(item.jobTitle, item.jobVersion)}`
          : `Your job${jobAndVersion(item.jobTitle, item.jobVersion)}`).join('; ')
        : 'None'}{open.evidence.withheldCount ? `. ${open.evidence.withheldCount} further item(s) are held by AI8HT operations and not shared.` : '.'}</p>
      {open.actions.length ? <p><strong>Actions:</strong> {open.actions.map((action) =>
        `${actionLabels[action.action] ?? action.action} from ${formatDate(action.effectiveFrom)}${action.effectiveTo ? ` to ${formatDate(action.effectiveTo)}` : ''}${action.reversed ? ' (reversed)' : ''}`).join('; ')}</p> : <p><strong>Actions:</strong> None</p>}
      {open.canRespond || open.canAppeal ? <form className="role-management-form" aria-label={open.canRespond ? 'Respond to the case' : 'Appeal the decision'}
        onSubmit={(event) => { event.preventDefault(); void answer(open.canRespond ? 'response' : 'appeal'); }}>
        <label><span>{open.canRespond ? 'Your response' : 'Why the decision should change (you can appeal once)'}</span>
          <textarea value={draft} maxLength={4000} rows={5} onChange={(event) => setDraft(event.target.value)} /></label>
        <button type="submit" disabled={busy || !draft.trim()}>{open.canRespond ? 'Send response' : 'Send appeal'}</button>
      </form> : null}
      <button type="button" className="pilot-btn" onClick={() => setOpen(null)}>Close</button>
    </div> : null}
  </section>;
}
