import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { getAccessToken } from './auth.js';
import { V2Stat } from './dashboardsV2.js';
import {
  listEmployerInterviews, listEmployerOffers, updateInterviewState, submitInterviewOutcome,
  withdrawEmployerOffer, revokeInstitutionVisibility, getEmployerHiringAnalytics,
  type EmployerInterviewDto, type EmployerOfferDto, type InterviewScheduleInput,
  type InterviewStateInput, type InterviewOutcomeInput, type OfferInput, type HiringAnalyticsDto,
  listInterviewParticipantOptions, type InterviewParticipantOptionDto,
  listExternalApplications, getExternalApplication, createExternalApplication, updateExternalApplication,
  deleteExternalApplication, changeExternalInstitutionVisibility, type ExternalApplicationDto, type ExternalApplicationInput,
} from './api/hiring.js';
import {
  ApiRequestError,
  addOpportunityAudience,
  applyToOpportunity,
  createEmployerOpportunity,
  extendOffer,
  getOpportunity,
  listEmployerApplicants,
  listEmployerOpportunities,
  listOpportunities,
  listCandidateFeedbackReasons,
  listStudentApplications,
  listStudentOffers,
  publishOpportunity,
  readApplicationFeedback,
  releaseCandidateFeedback,
  respondToOffer,
  scheduleInterview,
  transitionApplication,
  withdrawApplication,
  type CandidateFeedbackReasonDto,
  type EligibilityDto,
  type StudentApplicationFeedbackDto,
  type EmployerApplicantDto,
  type EmployerOpportunityDto,
  type OpportunityDetailDto,
  type OpportunitySummaryDto,
  type StudentApplicationDto,
  type StudentOfferDto,
} from './api.js';

/**
 * Hiring screens for the Student and Employer portals, backed by the real API.
 * Error codes from the API are translated into sentences a person can act on;
 * an unrecognised code degrades to a plain message rather than leaking the code.
 */

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CONSENT_REQUIRED: 'You need to agree to share your profile before applying.',
  ALREADY_APPLIED: 'You have already applied to this opportunity.',
  DEADLINE_PASSED: 'The deadline for this opportunity has passed.',
  OPPORTUNITY_NOT_OPEN: 'This opportunity is no longer open for applications.',
  APPLICATION_CLOSED: 'This application is closed and can no longer be changed.',
  CONSENT_REVOKED: 'This candidate has withdrawn, so their application cannot be changed.',
  INVALID_TRANSITION: 'That is not a valid next step for this application.',
  OFFER_NOT_ACCEPTED: 'The candidate has to accept the offer before you can record the hire.',
  OFFER_EXPIRED: 'This offer has expired.',
  TERMS_ACKNOWLEDGEMENT_REQUIRED: 'The candidate still needs to accept the updated terms.',
  AUDIENCE_REQUIRED: 'Choose who can see this opportunity before publishing it.',
  DUPLICATE_REFERENCE_CODE: 'You already have an opportunity with that reference code.',
  ACTIVE_OFFER_EXISTS: 'There is already an active offer for this candidate.',
  APPLICATION_NOT_AT_OFFER_STAGE: 'Move the candidate to the offer stage first.',
  LOCATION_REQUIRED: 'On-site roles need a location.',
  INVALID_SCHEDULE: 'Choose an end time after the interview starts.',
  INVALID_PARTICIPANTS: 'Select current members of this employer to join the interview.',
  PARTICIPANT_VISIBILITY_REQUIRED: 'Confirm that the selected participants may see the candidate for this interview.',
  EXTERNAL_APPLICATION_LIMIT: 'You can hold up to 500 external applications. Permanently delete a record before adding another.',
  EXTERNAL_APPLICATION_STALE: 'This record changed elsewhere. Refresh and reopen it before trying again.',
  INVALID_EXTERNAL_APPLICATION: 'Check the company, role, source, application date and HTTPS link. Future application dates are not allowed.',
  FORBIDDEN: 'You do not have access to that.',
};

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError) || !error.code) return fallback;
  return ERROR_MESSAGES[error.code] ?? fallback;
}

function formatMoney(currency: string | null, amount: string | null | undefined, period: string | null): string {
  if (!amount || !currency) return 'Not disclosed';
  const periodLabel = period === 'TOTAL_STIPEND' ? 'total' : period ? period.toLowerCase() : '';
  return `${currency} ${Number(amount).toLocaleString()}${periodLabel ? ` / ${periodLabel}` : ''}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString();
}

function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

export function StudentOpportunitiesPage(): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly OpportunitySummaryDto[]>([]);
  const [selected, setSelected] = useState<{ opportunity: OpportunityDetailDto; eligibility: EligibilityDto } | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('Loading opportunities…');
  const [busy, setBusy] = useState(false);
  const [institutionVisibilityGranted, setInstitutionVisibilityGranted] = useState(false);

  // `message` wins over the computed summary, so a confirmation survives the refresh
  // that follows it instead of being overwritten a moment later.
  const reload = async (query = '', message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listOpportunities(token, query);
    setOpportunities(response.opportunities);
    setStatus(message ?? (response.opportunities.length
      ? `${response.opportunities.length} open ${response.opportunities.length === 1 ? 'opportunity' : 'opportunities'}.`
      : 'No opportunities are open to you right now.'));
  };

  useEffect(() => { void reload().catch(() => setStatus('Opportunities could not be loaded.')); }, []);

  async function openDetail(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      setInstitutionVisibilityGranted(false);
      setSelected(await getOpportunity(token, id));
    } catch (error) {
      setStatus(messageFor(error, 'That opportunity could not be opened.'));
    }
  }

  async function apply(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      await applyToOpportunity(token, id, institutionVisibilityGranted);
      await reload(search, 'Application submitted. You can track it under Applications.');
      await openDetail(id);
    } catch (error) {
      setStatus(messageFor(error, 'Your application could not be submitted.'));
    } finally {
      setBusy(false);
    }
  }

  const closingSoon = opportunities.filter((item) => item.applicationDeadline && Date.parse(item.applicationDeadline) - Date.now() < 7 * 24 * 60 * 60 * 1000).length;
  return <div className="workspace-grid">
    <div className="v2-row v2-cols-4 career-stat-strip wide-card">
      <V2Stat icon="💼" tone="blue" value={opportunities.length} label="Open to you" />
      <V2Stat icon="📨" tone="green" value={opportunities.filter((item) => item.alreadyApplied).length} label="Already applied" />
      <V2Stat icon="⏳" tone="amber" value={closingSoon} label="Closing within a week" />
      <V2Stat icon="🤝" tone="purple" value="Consent" label="Profile shared per role only" />
    </div>
    <section className="card wide-card">
      <h2>Open opportunities</h2>
      <p role="status">{status}</p>
      <form className="hiring-search" onSubmit={(event) => { event.preventDefault(); void reload(search); }}>
        <label className="student-form-field"><span>Search by role or company</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="SOC analyst, Aster Mobility…" maxLength={80} />
        </label>
        <button type="submit">Search</button>
      </form>
    </section>

    <section className="card wide-card">
      <h2>Results</h2>
      {opportunities.length === 0
        ? <p>Nothing matches yet. Opportunities appear here when an employer opens one to your college or to everyone.</p>
        : <ul className="hiring-list">
          {opportunities.map((item) => <li key={item.id} className="hiring-list-item">
            <div>
              <h3>{item.title}</h3>
              <p className="hiring-meta">{item.employerName} · {humanise(item.employmentType)} · {humanise(item.workMode)}{item.locationCity ? ` · ${item.locationCity}` : ''}</p>
              <p className="hiring-meta">
                {item.compensation ? formatMoney(item.compensation.currency, item.compensation.min, item.compensation.period) : 'Compensation not disclosed'}
                {item.applicationDeadline ? ` · closes ${formatDate(item.applicationDeadline)}` : ''}
              </p>
            </div>
            <div className="hiring-actions">
              {item.alreadyApplied ? <span className="hiring-tag">Applied</span> : null}
              <button type="button" className="secondary" onClick={() => { void openDetail(item.id); }}>View details</button>
            </div>
          </li>)}
        </ul>}
    </section>

    {selected ? <section className="card wide-card">
      <span className="eyebrow">Opportunity detail</span>
      <h2>{selected.opportunity.title}</h2>
      <p className="hiring-meta">{selected.opportunity.employerName} · {humanise(selected.opportunity.employmentType)} · {humanise(selected.opportunity.workMode)}</p>
      {selected.opportunity.summary ? <p>{selected.opportunity.summary}</p> : null}
      {selected.opportunity.responsibilities ? <p>{selected.opportunity.responsibilities}</p> : null}

      <h3>What they are looking for</h3>
      {selected.opportunity.skills.length
        ? <ul className="hiring-chips">{selected.opportunity.skills.map((skill) => <li key={skill.name} className={skill.level === 'REQUIRED' ? 'hiring-chip required' : 'hiring-chip'}>{skill.name}{skill.level === 'PREFERRED' ? ' (preferred)' : ''}</li>)}</ul>
        : <p>No specific skills listed.</p>}

      {selected.opportunity.selectionStages.length ? <><h3>How the process runs</h3>
        <ol className="hiring-stages">{selected.opportunity.selectionStages.map((stage) => <li key={stage.order}>{stage.label}{stage.detail ? ` — ${stage.detail}` : ''}</li>)}</ol></> : null}

      <h3>Can you apply?</h3>
      <EligibilityNotice eligibility={selected.eligibility} />

      {/* PRIVACY REVIEW REQUIRED BEFORE SHIPPING: draft notice, not approved copy (ADR-019). */}
      <label className="hiring-checkbox"><input type="checkbox" checked={institutionVisibilityGranted}
        disabled={busy || selected.opportunity.alreadyApplied === true}
        onChange={(event) => setInstitutionVisibilityGranted(event.target.checked)} />
        <span>Also share this application's employer, role, stage, key dates and offer response with my institution while our relationship is active (optional).</span>
      </label>
      <p className="hiring-consent-note">This does not share offer compensation, documents or readiness information. You can stop sharing from Applications at any time, without withdrawing your application.</p>

      <div className="hiring-actions">
        <button type="button" disabled={busy || selected.opportunity.alreadyApplied === true} onClick={() => { void apply(selected.opportunity.id); }}>
          {selected.opportunity.alreadyApplied ? 'Already applied' : 'Apply and share my profile'}
        </button>
        <button type="button" className="secondary" onClick={() => setSelected(null)}>Close</button>
      </div>
      <p className="hiring-consent-note">Applying shares your profile with {selected.opportunity.employerName} for this role only. You can withdraw at any time, which ends their access.</p>
    </section> : null}
  </div>;
}

function EligibilityNotice({ eligibility }: { readonly eligibility: EligibilityDto }): React.ReactElement {
  if (eligibility.eligible && eligibility.advisoryFailures.length === 0) {
    return <p className="hiring-eligible">You meet everything the employer asked for.</p>;
  }
  return <div>
    {eligibility.blockingFailures.length
      ? <p className="hiring-blocked">You do not currently meet: {eligibility.blockingFailures.map(humanise).join(', ')}.</p>
      : null}
    {eligibility.needsMoreInformation.length
      ? <p className="hiring-unknown">We cannot confirm {eligibility.needsMoreInformation.map(humanise).join(', ')} yet, because that information is not on your record. Ask your college to add it.</p>
      : null}
    {eligibility.advisoryFailures.length
      ? <p className="hiring-meta">Preferred but not required: {eligibility.advisoryFailures.map(humanise).join(', ')}.</p>
      : null}
  </div>;
}

export function StudentApplicationsPage(): React.ReactElement {
  const [applications, setApplications] = useState<readonly StudentApplicationDto[]>([]);
  const [status, setStatus] = useState('Loading your applications…');
  const [revoking, setRevoking] = useState(false);
  // null = closed, 'loading', 'none' = the employer withdrew it between list and read.
  const [feedback, setFeedback] = useState<StudentApplicationFeedbackDto | 'loading' | 'none' | null>(null);

  async function revokeVisibility(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token || revoking) return;
    setRevoking(true);
    try {
      await revokeInstitutionVisibility(token, id);
      await reload('Institution sharing stopped. Your application is unchanged.');
    } catch (error) {
      setStatus(messageFor(error, 'Institution sharing could not be stopped.'));
    } finally { setRevoking(false); }
  }

  // `message` wins over the computed summary, so a confirmation survives the refresh
  // that follows it instead of being overwritten a moment later.
  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listStudentApplications(token);
    setApplications(response.applications);
    setStatus(message ?? (response.applications.length ? '' : 'You have not applied to anything yet.'));
  };
  useEffect(() => { void reload().catch(() => setStatus('Your applications could not be loaded.')); }, []);

  async function withdraw(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await withdrawApplication(token, id);
      await reload('Application withdrawn. The employer no longer has access to your profile for this role.');
    } catch (error) {
      setStatus(messageFor(error, 'The application could not be withdrawn.'));
    }
  }

  async function openFeedback(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setFeedback('loading');
    try {
      const response = await readApplicationFeedback(token, id);
      // A released row can be superseded between the list and this read, so an absent
      // one is a normal outcome rather than an error.
      setFeedback(response.feedback ?? 'none');
    } catch (error) {
      setStatus(messageFor(error, 'That feedback could not be loaded.'));
      setFeedback(null);
    }
  }

  const openApplications = applications.filter((item) => !item.closedAt);
  return <div className="workspace-grid">
    <div className="v2-row v2-cols-4 career-stat-strip wide-card">
      <V2Stat icon="📨" tone="blue" value={applications.length} label="Applications" />
      <V2Stat icon="🔄" tone="green" value={openApplications.length} label="In progress" />
      <V2Stat icon="📅" tone="purple" value={applications.filter((item) => /interview/i.test(item.state)).length} label="At interview" />
      <V2Stat icon="🏁" tone="amber" value={applications.filter((item) => /offer/i.test(item.state)).length} label="At offer" />
    </div>
    <section className="card wide-card">
      <h2>Your applications</h2>
      <p>Applications submitted through ONE. External declarations are listed separately below.</p>
      {status ? <p role="status">{status}</p> : null}
      {applications.length === 0
        ? <p>When you apply to an opportunity it will appear here, with the stage it has reached.</p>
        : <div className="data-table-wrap"><table>
          <thead><tr><th>Role</th><th>Company</th><th>Stage</th><th>Applied</th><th>Feedback</th><th>Institution sharing</th><th>Action</th></tr></thead>
          <tbody>{applications.map((item) => <tr key={item.id}>
            <td>{item.title}</td>
            <td>{item.employerName}</td>
            <td><span className={`hiring-state state-${item.state.toLowerCase()}`}>{humanise(item.state)}</span>
              {item.termsAcknowledgementPending ? <span className="hiring-tag warn">Terms changed</span> : null}</td>
            <td>{formatDate(item.submittedAt)}</td>
            <td>{item.feedbackReleased
              ? <button type="button" className="secondary" onClick={() => { void openFeedback(item.id); }}>See why</button>
              : <span className="hiring-meta">{item.state === 'REJECTED' ? 'None shared' : '—'}</span>}</td>
            <td>{item.institutionVisibilityGrantedAt && !item.institutionVisibilityRevokedAt
              ? <button type="button" className="secondary" disabled={revoking} onClick={() => { void revokeVisibility(item.id); }}>Stop institution sharing</button>
              : <span>{item.institutionVisibilityRevokedAt ? 'Sharing stopped' : 'Not shared'}</span>}</td>
            <td>{item.closedAt
              ? <span className="hiring-meta">Closed</span>
              : <button type="button" className="secondary" onClick={() => { void withdraw(item.id); }}>Withdraw</button>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {feedback ? <StudentFeedbackCard feedback={feedback} onClose={() => setFeedback(null)} /> : null}
    <StudentOffersPanel onChanged={() => { void reload(); }} />
    <StudentExternalApplicationsPanel />
  </div>;
}

/**
 * What an employer chose to say to this candidate, and what they can do about it.
 *
 * A reason with no mapped topic shows the reason alone. Nothing here invents a next
 * step, and nothing here shows a readiness band.
 */
export function StudentFeedbackCard({ feedback, onClose }: {
  readonly feedback: StudentApplicationFeedbackDto | 'loading' | 'none';
  readonly onClose: () => void;
}): React.ReactElement {
  if (feedback === 'loading') return <section className="card wide-card"><h2>Feedback</h2><p role="status">Loading…</p></section>;
  if (feedback === 'none') {
    return <section className="card wide-card">
      <h2>Feedback</h2>
      <p role="status">This feedback is no longer available.</p>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </section>;
  }
  return <section className="card wide-card">
    <h2>Why this application did not go further</h2>
    <p>{feedback.employerName} shared this on {formatDate(feedback.releasedAt)} about your application for {feedback.title}.</p>
    <ul className="check-stack">
      {feedback.reasons.map((reason) => <li key={reason.code}>
        <strong>{reason.studentLabel}</strong>
        {reason.topics.length
          ? <span className="hiring-meta"> Worth working on: {reason.topics.map((topic) => topic.name).join(', ')}</span>
          : null}
      </li>)}
    </ul>
    {feedback.note ? <p><em>&ldquo;{feedback.note}&rdquo;</em></p> : null}
    <p className="hiring-meta">Only you can see this. It is not shown to your institution or to other employers, and it does not affect your readiness.</p>
    <button type="button" className="secondary" onClick={onClose}>Close</button>
  </section>;
}

const externalStages: readonly ExternalApplicationInput['stage'][] = ['APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];
const externalSources: readonly ExternalApplicationInput['sourceKind'][] = ['JOB_BOARD', 'COMPANY_SITE', 'REFERRAL'];
const externalLabel = 'Student-declared · Unverified';
const externalConsentNotice = 'Share this external application’s company, role, stage and dates with my institution. This is optional; I can stop sharing at any time. The application link stays private.';

export function StudentExternalApplicationsPanel(): React.ReactElement {
  const token = getAccessToken();
  if (!token) return <section className="card wide-card"><h2>External applications</h2><p>Sign in to record applications made outside ONE.</p><p>Records: NA of 500</p></section>;
  return <ExternalApplicationsWorkspace key={token} token={token} />;
}

function ExternalApplicationsWorkspace({ token }: { readonly token: string }): React.ReactElement {
  const [rows, setRows] = useState<readonly ExternalApplicationDto[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<ExternalApplicationDto | null>(null);
  const [editor, setEditor] = useState<ExternalApplicationDto | 'new' | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  useEffect(() => () => detailRequest.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void listExternalApplications(token, offset, abort.signal).then((page) => {
      if (abort.signal.aborted) return;
      if (!Array.isArray(page.externalApplications) || !Number.isInteger(page.total)) throw new Error('Invalid response');
      if (offset > 0 && offset >= page.total) { setOffset(Math.floor(Math.max(0, page.total - 1) / 50) * 50); return; }
      setRows(page.externalApplications); setTotal(page.total);
    }).catch(() => { if (!abort.signal.aborted) { setRows([]); setTotal(null); setNotice('External applications could not be loaded. Please refresh.'); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [token, offset, refresh]);

  function closeDetail(): void { detailRequest.current?.abort(); setDetail(null); setEditor(null); }
  async function openDetail(row: ExternalApplicationDto): Promise<void> {
    closeDetail();
    const abort = new AbortController(); detailRequest.current = abort;
    try {
      const response = await getExternalApplication(token, row.id, abort.signal);
      if (!abort.signal.aborted) setDetail(response.externalApplication);
    } catch (error) { if (!abort.signal.aborted) setNotice(messageFor(error, 'This external application could not be opened. Refresh to check whether it still exists.')); }
  }
  async function mutate(operation: () => Promise<unknown>, success: string): Promise<void> {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await operation(); closeDetail(); setRows([]); setTotal(null); setLoading(true);
      setNotice(success); setRefresh((value) => value + 1);
    } catch (error) { setNotice(messageFor(error, 'The external application could not be changed.')); throw error; }
    finally { setBusy(false); }
  }
  async function remove(row: ExternalApplicationDto): Promise<void> {
    if (!window.confirm('Permanently delete this external application? This cannot be undone. If your institution previously saw it, it will disappear from later reports.')) return;
    await mutate(() => deleteExternalApplication(token, row.id, row.revision), 'External application permanently deleted. It will no longer appear in later reports.').catch(() => undefined);
  }
  async function changeSharing(row: ExternalApplicationDto, action: 'grant' | 'revoke'): Promise<void> {
    if (action === 'grant' && !window.confirm(externalConsentNotice)) return;
    await mutate(() => changeExternalInstitutionVisibility(token, row.id, row.revision, action), action === 'grant' ? 'Institution sharing enabled for this declaration.' : 'Institution sharing stopped. Your declaration is unchanged.').catch(() => undefined);
  }
  function sharing(row: ExternalApplicationDto): string {
    return row.institutionVisibilityGrantedAt && !row.institutionVisibilityRevokedAt ? 'Shared with institution' : row.institutionVisibilityRevokedAt ? 'Sharing stopped' : 'Not shared';
  }
  return <section className="card wide-card">
    <h2>External applications</h2>
    <p>Record applications you made outside ONE. These declarations are unverified and do not count toward placement or conversion metrics.</p>
    <p>Records: {total ?? 'NA'} of 500</p>
    <div className="hiring-actions">
      <button type="button" disabled={busy || total === 500} onClick={() => { closeDetail(); setEditor('new'); }}>Record external application</button>
      <button type="button" className="secondary" disabled={busy || loading} onClick={() => { closeDetail(); setRefresh((value) => value + 1); }}>Refresh external applications</button>
    </div>
    {total === 500 ? <p>You have reached the 500-record limit. Editing and stopping institution sharing remain available.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {loading ? <p role="status">Loading external applications…</p> : null}
    {!loading && total === 0 ? <p>No external applications recorded.</p> : null}
    <div className="data-table-wrap"><table aria-label="Student-declared external applications">
      <thead><tr><th>Role</th><th>Company</th><th>Source</th><th>Declared stage</th><th>Date applied</th><th>Institution sharing</th><th>Actions</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td>{row.roleTitle || 'NA'}<div className="hiring-meta">{externalLabel}</div></td><td>{row.companyName || 'NA'}</td><td>{humanise(row.sourceKind)}</td>
        <td>{humanise(row.stage)}<span className="hiring-meta"> · Unverified</span></td><td>{row.appliedOn || 'NA'}</td><td>{sharing(row)}</td>
        <td><div className="hiring-actions">
          <button type="button" disabled={busy} onClick={() => { void openDetail(row); }}>View external application</button>
          <button type="button" disabled={busy} onClick={() => { closeDetail(); setEditor(row); }}>Edit external application</button>
          <button type="button" disabled={busy} className="secondary" onClick={() => { void remove(row); }}>Delete permanently</button>
        </div></td>
      </tr>)}</tbody>
    </table></div>
    <div className="hiring-actions">
      <button type="button" disabled={loading || busy || offset === 0} onClick={() => { closeDetail(); setRows([]); setOffset((value) => Math.max(0, value - 50)); }}>Previous external applications</button>
      <button type="button" disabled={loading || busy || total == null || offset + 50 >= total} onClick={() => { closeDetail(); setRows([]); setOffset((value) => value + 50); }}>Next external applications</button>
    </div>
    {detail ? <section className="role-card">
      <h3>{detail.roleTitle || 'NA'}</h3><p>{externalLabel}</p><p>Company: {detail.companyName || 'NA'}</p>
      <p>Source: {humanise(detail.sourceKind)}</p><p>Declared stage: {humanise(detail.stage)} · Unverified</p><p>Date applied: {detail.appliedOn || 'NA'}</p>
      <p>Application link: {detail.applicationUrl && /^https:\/\//i.test(detail.applicationUrl) ? <a href={detail.applicationUrl} target="_blank" rel="noopener noreferrer">Open application link</a> : 'NA'}</p>
      <p>Institution sharing: {sharing(detail)}</p>
      <p>{externalConsentNotice}</p>
      <button type="button" disabled={busy} onClick={() => { void changeSharing(detail, detail.institutionVisibilityGrantedAt && !detail.institutionVisibilityRevokedAt ? 'revoke' : 'grant'); }}>
        {detail.institutionVisibilityGrantedAt && !detail.institutionVisibilityRevokedAt ? 'Stop sharing external application' : 'Share external application with institution'}
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={closeDetail}>Close external details</button>
    </section> : null}
    {editor ? <ExternalApplicationForm key={editor === 'new' ? 'new' : `${editor.id}-${editor.revision}`} initial={editor === 'new' ? undefined : editor} busy={busy} onCancel={closeDetail}
      onSave={async (input) => { await mutate(() => editor === 'new' ? createExternalApplication(token, input)
        : updateExternalApplication(token, editor.id, { companyName: input.companyName, roleTitle: input.roleTitle, sourceKind: input.sourceKind,
          appliedOn: input.appliedOn, applicationUrl: input.applicationUrl ?? null, stage: input.stage, revision: editor.revision }),
      editor === 'new' ? 'External application recorded as student-declared and unverified.' : 'External application updated.'); }} /> : null}
  </section>;
}

function ExternalApplicationForm({ initial, busy, onSave, onCancel }: {
  readonly initial: ExternalApplicationDto | undefined; readonly busy: boolean;
  readonly onSave: (input: ExternalApplicationInput) => Promise<void>; readonly onCancel: () => void;
}): React.ReactElement {
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); if (busy) return;
    const form = new FormData(event.currentTarget);
    const appliedOn = String(form.get('appliedOn'));
    if (appliedOn > new Date().toISOString().slice(0, 10)) { setError('Choose the date you applied; future dates are not allowed.'); return; }
    setError('');
    try { await onSave({ companyName: String(form.get('companyName')).trim(), roleTitle: String(form.get('roleTitle')).trim(),
      sourceKind: String(form.get('sourceKind')) as ExternalApplicationInput['sourceKind'], appliedOn,
      applicationUrl: String(form.get('applicationUrl')) || null, stage: String(form.get('stage')) as ExternalApplicationInput['stage'],
      ...(!initial ? { institutionVisibilityGranted: form.get('institutionVisibilityGranted') === 'on' } : {}) });
    } catch (failure) { setError(messageFor(failure, 'The external application could not be saved.')); }
  }
  return <form className="role-management-form" onSubmit={(event) => { void submit(event); }}>
    <h3 className="wide-card">{initial ? 'Edit external application' : 'Record external application'}</h3><p className="wide-card">{externalLabel}</p>
    <fieldset className="role-management-form wide-card" disabled={busy}><legend>Application you made outside ONE</legend>
      <label><span>Company name</span><input name="companyName" required maxLength={200} defaultValue={initial?.companyName ?? ''} /></label>
      <label><span>Role title</span><input name="roleTitle" required maxLength={200} defaultValue={initial?.roleTitle ?? ''} /></label>
      <label><span>Application source</span><select name="sourceKind" required defaultValue={initial?.sourceKind ?? ''}><option value="" disabled>Select source</option>{externalSources.map((source) => <option key={source} value={source}>{humanise(source)}</option>)}</select></label>
      <label><span>Date applied</span><input name="appliedOn" type="date" required max={new Date().toISOString().slice(0, 10)} defaultValue={initial?.appliedOn ?? ''} /></label>
      <label><span>Application link (optional)</span><input name="applicationUrl" type="url" pattern="https://[^\s]+" maxLength={2048} defaultValue={initial?.applicationUrl ?? ''} /></label>
      <label><span>Declared stage</span><select name="stage" required defaultValue={initial?.stage ?? 'APPLIED'}>{externalStages.map((stage) => <option key={stage} value={stage}>{humanise(stage)} · Unverified</option>)}</select></label>
      {!initial ? <label className="hiring-checkbox"><input name="institutionVisibilityGranted" type="checkbox" defaultChecked={false} /><span>{externalConsentNotice}</span></label> : <p>Editing does not change institution sharing. Use the separate sharing control in the record details.</p>}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" disabled={busy}>Save external application</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel external edit</button>
  </form>;
}

export function StudentOffersPanel({ onChanged }: { readonly onChanged?: () => void }): React.ReactElement {
  const [offers, setOffers] = useState<readonly StudentOfferDto[]>([]);
  const [status, setStatus] = useState('');

  const reload = async (): Promise<void> => {
    const token = getAccessToken();
    if (!token) return;
    const response = await listStudentOffers(token);
    setOffers(response.offers);
  };
  useEffect(() => { void reload().catch(() => setStatus('Your offers could not be loaded.')); }, []);

  async function respond(offerId: string, decision: 'ACCEPT' | 'DECLINE'): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await respondToOffer(token, offerId, decision);
      setStatus(decision === 'ACCEPT' ? 'Offer accepted. The employer will confirm your joining details.' : 'Offer declined.');
      await reload();
      onChanged?.();
    } catch (error) {
      setStatus(messageFor(error, 'Your response could not be recorded.'));
    }
  }

  return <section className="card wide-card">
    <h2>Your offers</h2>
    {status ? <p role="status">{status}</p> : null}
    {offers.length === 0
      ? <p>No offers yet. Any offer an employer makes will appear here with its deadline.</p>
      : <ul className="hiring-list">{offers.map((offer) => <li key={offer.id} className="hiring-list-item">
        <div>
          <h3>{offer.title}</h3>
          <p className="hiring-meta">{offer.employerName} · {formatMoney(offer.compensation.currency, offer.compensation.amount, offer.compensation.period)}</p>
          <p className="hiring-meta">
            {offer.joiningDate ? `Joining ${formatDate(offer.joiningDate)}` : 'Joining date to be confirmed'}
            {offer.offerExpiresAt ? ` · respond by ${formatDate(offer.offerExpiresAt)}` : ''}
          </p>
          {offer.conditions ? <p>{offer.conditions}</p> : null}
        </div>
        <div className="hiring-actions">
          {offer.state === 'EXTENDED'
            ? <>
              <button type="button" onClick={() => { void respond(offer.id, 'ACCEPT'); }}>Accept</button>
              <button type="button" className="secondary" onClick={() => { void respond(offer.id, 'DECLINE'); }}>Decline</button>
            </>
            : <span className={`hiring-state state-${offer.state.toLowerCase()}`}>{humanise(offer.state)}</span>}
        </div>
      </li>)}</ul>}
  </section>;
}

// ---------------------------------------------------------------------------
// Employer
// ---------------------------------------------------------------------------

export function EmployerOpportunitiesPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  const [status, setStatus] = useState('Loading your opportunities…');
  const [creating, setCreating] = useState(false);

  const reload = async (): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listEmployerOpportunities(token, employerId);
    setOpportunities(response.opportunities);
    setStatus('');
  };
  useEffect(() => { void reload().catch(() => setStatus('Your opportunities could not be loaded.')); }, [employerId]);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const disclosed = form.get('compensationDisclosed') === 'on';
    const workMode = String(form.get('workMode'));
    try {
      const created = await createEmployerOpportunity(token, employerId, {
        referenceCode: String(form.get('referenceCode') ?? ''),
        title: String(form.get('title') ?? ''),
        summary: String(form.get('summary') ?? '') || undefined,
        employmentType: String(form.get('employmentType')),
        workMode,
        locationCity: String(form.get('locationCity') ?? '') || undefined,
        ...(disclosed ? {
          compensationDisclosed: true,
          compensationCurrency: String(form.get('compensationCurrency') ?? 'INR'),
          compensationMin: Number(form.get('compensationMin') ?? 0),
          compensationPeriod: String(form.get('compensationPeriod') ?? 'MONTH'),
        } : { compensationDisclosed: false }),
      });
      // A new opportunity reaches nobody until it has an audience, so the default
      // is set here rather than leaving a draft that cannot be published.
      await addOpportunityAudience(token, employerId, created.opportunity.id, { audienceKind: 'PUBLIC' });
      setStatus('Draft created and open to all students. Publish it when you are ready.');
      setCreating(false);
      await reload();
    } catch (error) {
      setStatus(messageFor(error, 'The opportunity could not be created.'));
    }
  }

  async function publish(id: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await publishOpportunity(token, employerId, id);
      setStatus('Opportunity published. Students who match its audience can now see it.');
      await reload();
    } catch (error) {
      setStatus(messageFor(error, 'The opportunity could not be published.'));
    }
  }

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Opportunities</span>
      <h1>Your opportunities</h1>
      <p>Create a role, choose who can see it, and publish. Applications appear under Applicants.</p>
    </div></div>

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="💼" tone="blue" value={opportunities.filter((item) => item.lifecycleState === 'PUBLISHED').length} label="Published" />
      <V2Stat icon="✏️" tone="amber" value={opportunities.filter((item) => item.lifecycleState !== 'PUBLISHED').length} label="Drafts" />
      <V2Stat icon="📥" tone="green" value={opportunities.reduce((sum, item) => sum + item.applicationCount, 0)} label="Applications" />
      <V2Stat icon="🔄" tone="purple" value={opportunities.reduce((sum, item) => sum + item.openApplicationCount, 0)} label="Open applications" />
    </div>

    {status ? <section className="role-card role-wide"><p role="status">{status}</p></section> : null}

    <section className="role-card role-wide">
      <div className="role-section-title"><h2>Open and draft roles</h2>
        <button type="button" onClick={() => setCreating((value) => !value)}>{creating ? 'Cancel' : 'New opportunity'}</button></div>
      {creating ? <form className="role-management-form" onSubmit={(event) => { void create(event); }}>
        <label><span>Reference code</span><input name="referenceCode" required maxLength={64} placeholder="SOC-2026-01" /></label>
        <label><span>Title</span><input name="title" required maxLength={200} placeholder="SOC Analyst Intern" /></label>
        <label><span>Employment type</span><select name="employmentType" defaultValue="INTERNSHIP">
          {['INTERNSHIP', 'FULL_TIME', 'PART_TIME', 'APPRENTICESHIP', 'CONTRACT'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
        </select></label>
        <label><span>Work mode</span><select name="workMode" defaultValue="ONSITE">
          {['ONSITE', 'HYBRID', 'REMOTE'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
        </select></label>
        <label><span>Location</span><input name="locationCity" maxLength={120} placeholder="Bengaluru" /></label>
        <label><span>Summary</span><textarea name="summary" maxLength={2000} /></label>
        <label className="hiring-checkbox"><input type="checkbox" name="compensationDisclosed" /><span>Show the pay on the listing</span></label>
        <label><span>Currency</span><input name="compensationCurrency" defaultValue="INR" maxLength={3} /></label>
        <label><span>Amount</span><input name="compensationMin" type="number" min={0} step={100} /></label>
        <label><span>Per</span><select name="compensationPeriod" defaultValue="MONTH">
          {['HOUR', 'MONTH', 'YEAR', 'TOTAL_STIPEND'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
        </select></label>
        <button type="submit">Create draft</button>
      </form> : null}

      {opportunities.length === 0
        ? <p>You have not created any opportunities yet.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Title</th><th>Reference</th><th>Status</th><th>Applicants</th><th>Action</th></tr></thead>
          <tbody>{opportunities.map((item) => <tr key={item.id}>
            <td>{item.title ?? 'Untitled'}</td>
            <td>{item.referenceCode}</td>
            <td><span className={`hiring-state state-${item.lifecycleState.toLowerCase()}`}>{humanise(item.lifecycleState)}</span></td>
            <td>{item.applicationCount} ({item.openApplicationCount} open)</td>
            <td>{item.lifecycleState === 'DRAFT'
              ? <button type="button" onClick={() => { void publish(item.id); }}>Publish</button>
              : <span className="hiring-meta">Live</span>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </section>;
}

const PIPELINE_NEXT: Readonly<Record<string, readonly string[]>> = {
  APPLIED: ['SCREENING', 'SHORTLISTED', 'REJECTED'],
  SCREENING: ['SHORTLISTED', 'REJECTED'],
  SHORTLISTED: ['ASSESSMENT', 'INTERVIEW', 'REJECTED'],
  ASSESSMENT: ['INTERVIEW', 'REJECTED'],
  INTERVIEW: ['OFFER', 'REJECTED'],
  OFFER: ['HIRED', 'REJECTED'],
};

// Shared verbatim consent redaction from the Applicants table.
export function CandidateIdentity({ item }: { readonly item: Pick<EmployerApplicantDto, 'consentRevoked' | 'candidateName' | 'candidateEmail' | 'institutionStudentId'> }): React.ReactElement {
  return item.consentRevoked
    ? <span className="hiring-meta">Withdrawn — details no longer shared</span>
    : <>{item.candidateName ?? item.candidateEmail ?? 'NA'}{item.institutionStudentId ? <span className="hiring-meta"> · {item.institutionStudentId}</span> : null}</>;
}

function formatDateTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'NA';
  return new Date(value).toLocaleString();
}

function ScheduleFields(): React.ReactElement {
  return <>
    <p>Times use your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
    <label><span>Date</span><input name="date" type="date" required /></label>
    <label><span>Start time</span><input name="startTime" type="time" required /></label>
    <label><span>Duration (minutes)</span><input name="duration" type="number" required min={1} max={1440} step={1} /></label>
  </>;
}

function scheduleWindow(form: FormData): { scheduledStart: string; scheduledEnd: string } {
  const start = new Date(`${String(form.get('date'))}T${String(form.get('startTime'))}`);
  const duration = Number(form.get('duration'));
  if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now() || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
    throw new Error('Choose a future date and a duration between 1 and 1440 minutes.');
  }
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + duration * 60_000).toISOString() };
}

function InterviewForm({ employerId, onSave, onCancel }: { readonly employerId: string; readonly onSave: (input: InterviewScheduleInput) => Promise<void>; readonly onCancel: () => void }): React.ReactElement {
  const [mode, setMode] = useState<InterviewScheduleInput['mode']>('VIDEO');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState<readonly InterviewParticipantOptionDto[]>([]);
  const [selectedParticipants, setSelectedParticipants] = useState<readonly string[]>([]);
  const [participantStatus, setParticipantStatus] = useState('Loading employer members…');
  const [visibilityAcknowledged, setVisibilityAcknowledged] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const token = getAccessToken();
    if (!token) { setParticipantStatus('Sign in to select participants.'); return; }
    void listInterviewParticipantOptions(token, employerId, abort.signal).then(({ participants }) => {
      if (!abort.signal.aborted) { setParticipants(participants ?? []); setParticipantStatus(participants?.length ? '' : 'No eligible employer members to add.'); }
    }).catch(() => { if (!abort.signal.aborted) setParticipantStatus('Employer members could not be loaded.'); });
    return () => abort.abort();
  }, [employerId]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    if (selectedParticipants.length && !visibilityAcknowledged) { setError('Confirm participant access before scheduling.'); return; }
    let window: ReturnType<typeof scheduleWindow>;
    try { window = scheduleWindow(form); } catch { setError('Choose a future date and a duration between 1 and 1440 minutes.'); return; }
    setBusy(true); setError('');
    try {
      await onSave({ ...window, mode,
        ...(selectedParticipants.length ? { participantUserIds: selectedParticipants, participantVisibilityAcknowledged: visibilityAcknowledged } : {}),
        ...(mode === 'VIDEO' ? { joiningLink: String(form.get('joiningLink')) } : {}),
        ...(mode === 'ONSITE' || form.get('locationDetail') ? { locationDetail: String(form.get('locationDetail')) } : {}),
      });
    } catch (failure) { setError(messageFor(failure, 'The interview could not be scheduled.')); }
    finally { setBusy(false); }
  }
  return <form className="role-management-form" onSubmit={(event) => { void submit(event); }}>
    <ScheduleFields />
    <label><span>Mode</span><select value={mode} onChange={(event) => setMode(event.target.value as InterviewScheduleInput['mode'])}>
      {['VIDEO', 'PHONE', 'ONSITE'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
    </select></label>
    {mode === 'VIDEO' ? <label><span>Joining link</span><input name="joiningLink" type="url" pattern="https://[^\s]+" required maxLength={512} /></label>
      : <label><span>{mode === 'ONSITE' ? 'Location' : 'Phone arrangements (optional)'}</span><input key={mode} name="locationDetail" required={mode === 'ONSITE'} maxLength={500} /></label>}
    <fieldset disabled={busy}><legend>Interview participants</legend>
      <p>Adding a participant lets that person see the candidate details shared for this interview and record a scorecard. Access ends when the assignment is removed or the interview ends.</p>
      {participantStatus ? <p role="status">{participantStatus}</p> : null}
      <p>{selectedParticipants.length} participants selected.</p>
      {participants.map((participant) => <label key={participant.userId} className="hiring-checkbox">
        <input type="checkbox" checked={selectedParticipants.includes(participant.userId)} onChange={(event) => {
          setSelectedParticipants((previous) => event.target.checked ? [...previous, participant.userId] : previous.filter((id) => id !== participant.userId));
          setVisibilityAcknowledged(false);
        }} /><span>{participant.label}</span>
      </label>)}
      {selectedParticipants.length ? <label className="hiring-checkbox"><input type="checkbox" required checked={visibilityAcknowledged}
        onChange={(event) => setVisibilityAcknowledged(event.target.checked)} /><span>I understand that the selected participants will be able to see this candidate for this interview.</span></label> : null}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save interview'}</button>
    <button disabled={busy} type="button" className="secondary" onClick={onCancel}>Close form</button>
  </form>;
}

function OfferForm({ onSave, onCancel }: { readonly onSave: (input: OfferInput) => Promise<void>; readonly onCancel: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const expiry = new Date(String(form.get('expiry')));
    const amount = Number(form.get('amount'));
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
      setError('Enter a valid amount and a future expiry.'); return;
    }
    setBusy(true); setError('');
    try {
      await onSave({ compensationCurrency: String(form.get('currency')).toUpperCase(), compensationAmount: amount,
        compensationPeriod: String(form.get('period')) as OfferInput['compensationPeriod'],
        offerExpiresAt: expiry.toISOString(),
        ...(form.get('joiningDate') ? { joiningDate: String(form.get('joiningDate')) } : {}),
        ...(form.get('conditions') ? { conditions: String(form.get('conditions')) } : {}),
      });
    } catch (failure) { setError(messageFor(failure, 'The offer could not be sent.')); }
    finally { setBusy(false); }
  }
  return <form className="role-management-form" onSubmit={(event) => { void submit(event); }}>
    <label><span>Currency</span><input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} /></label>
    <label><span>Amount</span><input name="amount" type="number" required min={0} max={1_000_000_000} step="0.01" /></label>
    <label><span>Period</span><select name="period" required defaultValue=""><option value="" disabled>Select period</option>
      {['HOUR', 'MONTH', 'YEAR', 'TOTAL_STIPEND'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
    </select></label>
    <label><span>Joining date (optional)</span><input name="joiningDate" type="date" /></label>
    <label><span>Expiry (local time)</span><input name="expiry" type="datetime-local" required /></label>
    <label><span>Conditions (optional)</span><textarea name="conditions" maxLength={4000} /></label>
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send offer'}</button>
    <button type="button" disabled={busy} className="secondary" onClick={onCancel}>Close form</button>
  </form>;
}

const loadInterviews = async (token: string, employerId: string, signal?: AbortSignal) => (await listEmployerInterviews(token, employerId, signal)).interviews;
const loadOffers = async (token: string, employerId: string, signal?: AbortSignal) => (await listEmployerOffers(token, employerId, signal)).offers;

function useEmployerList<T>(employerId: string, loader: (token: string, id: string, signal?: AbortSignal) => Promise<readonly T[]>) {
  const [result, setResult] = useState<{ employerId: string; rows: readonly T[] }>({ employerId, rows: [] });
  const [status, setStatus] = useState('Loading…');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); setLoading(false); return; }
    setLoading(true);
    try {
      const rows = await loader(token, employerId, signal);
      if (current !== sequence.current || signal?.aborted) return;
      if (!Array.isArray(rows)) throw new Error('Invalid hiring list response');
      setResult({ employerId, rows }); setStatus('');
    } finally { if (current === sequence.current && !signal?.aborted) setLoading(false); }
  }, [employerId, loader]);
  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal).catch(() => { if (!abort.signal.aborted) setStatus('Records could not be loaded. Please refresh.'); });
    return () => { abort.abort(); sequence.current++; };
  }, [reload]);
  async function act(operation: (token: string) => Promise<unknown>, message: string): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      await operation(token);
      try { await reload(); setStatus(message); }
      catch { setResult({ employerId, rows: [] }); setStatus(`${message} Refresh to update the list.`); }
    } catch (failure) { setStatus(messageFor(failure, 'That change could not be saved.')); throw failure; }
    finally { setBusy(false); }
  }
  return { rows: result.employerId === employerId ? result.rows : [], status, loading, busy, act };
}

export function EmployerInterviewsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const { rows, status, loading, busy, act } = useEmployerList(employerId, loadInterviews);
  const [selected, setSelected] = useState<{ id: string; kind: 'outcome' | 'reschedule' } | null>(null);
  const interviews = [...rows].sort((a, b) => (a.scheduledStart ? Date.parse(a.scheduledStart) : Infinity) - (b.scheduledStart ? Date.parse(b.scheduledStart) : Infinity));
  const selectedInterview = rows.find((item) => item.id === selected?.id && !item.consentRevoked && !item.closedAt);
  async function change(id: string, toState: InterviewStateInput['toState']): Promise<void> {
    if (toState === 'CANCELLED' && !window.confirm('Cancel this interview?')) return;
    await act((token) => updateInterviewState(token, employerId, id, { toState }), 'Interview updated.').catch(() => undefined);
  }
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>Interviews</h1><p>Scheduled interviews, in start-time order. Times are shown in your local timezone.</p></div></div>
    <section className="role-card role-wide">
      {status ? <p role="status">{status}</p> : null}
      {!loading && !status && rows.length === 0 ? <p>No interviews are scheduled.</p> : null}
      {rows.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr>{['Candidate', 'Opportunity', 'Round', 'Mode', 'Start', 'End', 'State', 'Outcomes', 'Actions'].map((title) => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{interviews.map((item) => <tr key={item.id}>
          <td><CandidateIdentity item={item} /></td><td>{item.title || 'NA'}</td><td>{item.roundNumber}</td><td>{humanise(item.mode)}</td>
          <td>{formatDateTime(item.scheduledStart)}</td><td>{formatDateTime(item.scheduledEnd)}</td><td>{humanise(item.state)}</td><td>{item.outcomeCount}</td>
          <td>{!item.consentRevoked && !item.closedAt ? <div className="hiring-actions">
            {['SCHEDULED', 'RESCHEDULED'].includes(item.state) ? <>
              <button disabled={busy} onClick={() => setSelected({ id: item.id, kind: 'reschedule' })}>Reschedule</button>
              <button disabled={busy} onClick={() => { void change(item.id, 'COMPLETED'); }}>Mark completed</button>
              <button disabled={busy} onClick={() => { void change(item.id, 'NO_SHOW'); }}>Mark no show</button>
              <button className="secondary" disabled={busy} onClick={() => { void change(item.id, 'CANCELLED'); }}>Cancel interview</button>
            </> : null}
            {item.state === 'COMPLETED' ? <button disabled={busy} onClick={() => setSelected({ id: item.id, kind: 'outcome' })}>Record outcome</button> : null}
          </div> : <span className="hiring-meta">Closed</span>}</td>
        </tr>)}</tbody>
      </table></div> : null}
    </section>
    {selected && selectedInterview ? <section className="role-card role-wide">
      <h2>{selected.kind === 'outcome' ? 'Record outcome' : 'Reschedule interview'}</h2><p><CandidateIdentity item={selectedInterview} /></p>
      <InterviewActionForm key={`${selected.id}-${selected.kind}`} kind={selected.kind} onCancel={() => setSelected(null)} onSave={async (body) => {
        await act((token) => selected.kind === 'outcome'
          ? submitInterviewOutcome(token, employerId, selected.id, body as InterviewOutcomeInput)
          : updateInterviewState(token, employerId, selected.id, body as InterviewStateInput), 'Interview updated.');
        setSelected(null);
      }} />
    </section> : null}
  </section>;
}

export function InterviewActionForm({ kind, onSave, onCancel }: {
  readonly kind: 'outcome' | 'reschedule'; readonly onSave: (body: InterviewOutcomeInput | InterviewStateInput) => Promise<void>; readonly onCancel: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    let body: InterviewOutcomeInput | InterviewStateInput;
    if (kind === 'reschedule') {
      try { body = { toState: 'RESCHEDULED', ...scheduleWindow(form) }; }
      catch { setError('Choose a future date and a duration between 1 and 1440 minutes.'); return; }
    } else {
      body = { recommendation: String(form.get('recommendation')) as InterviewOutcomeInput['recommendation'],
        ...(form.get('overallRating') ? { overallRating: Number(form.get('overallRating')) } : {}),
        strengths: String(form.get('strengths')), concerns: String(form.get('concerns')), notes: String(form.get('notes')) };
    }
    setBusy(true); setError('');
    try { await onSave(body); } catch { setError('The change could not be saved.'); } finally { setBusy(false); }
  }
  return <form className="role-management-form" onSubmit={(event) => { void submit(event); }}>
    {kind === 'reschedule' ? <ScheduleFields /> : <>
      <p>Submitting again replaces your previous outcome for this interview.</p>
      <label><span>Recommendation</span><select name="recommendation" required defaultValue=""><option value="" disabled>Select recommendation</option>
        {['STRONG_YES', 'YES', 'NEUTRAL', 'NO', 'STRONG_NO'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
      </select></label>
      <label><span>Interview rating (optional, 1–5)</span><input name="overallRating" type="number" min={1} max={5} step={1} /></label>
      <label><span>Strengths</span><textarea name="strengths" maxLength={2000} /></label>
      <label><span>Concerns</span><textarea name="concerns" maxLength={2000} /></label>
      <label><span>Notes</span><textarea name="notes" maxLength={4000} /></label>
    </>}
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={busy} type="submit">Save changes</button><button disabled={busy} type="button" className="secondary" onClick={onCancel}>Close form</button>
  </form>;
}

function offerResponse(item: EmployerOfferDto): string {
  if (item.state === 'ACCEPTED' || item.state === 'DECLINED') return humanise(item.state);
  if (item.state === 'EXTENDED') return item.offerExpiresAt && Date.parse(item.offerExpiresAt) <= Date.now() ? 'Expired without response' : 'Awaiting response';
  if (item.state === 'EXPIRED') return 'Expired without response';
  if (item.state === 'WITHDRAWN') return 'Withdrawn without response';
  return 'Not requested';
}

export function EmployerOffersPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const { rows, status, loading, busy, act } = useEmployerList(employerId, loadOffers);
  async function withdraw(id: string): Promise<void> {
    if (!window.confirm('Withdraw this offer? The candidate will no longer be able to accept it.')) return;
    await act((token) => withdrawEmployerOffer(token, employerId, id), 'Offer withdrawn.').catch(() => undefined);
  }
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>Offers</h1><p>Offer dates and candidate responses.</p></div></div>
    <section className="role-card role-wide">
      {status ? <p role="status">{status}</p> : null}
      {!loading && !status && rows.length === 0 ? <p>No offers have been sent. Nothing is scheduled.</p> : null}
      {rows.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr>{['Candidate', 'Opportunity', 'State', 'Joining date', 'Expiry', 'Response state', 'Actions'].map((title) => <th key={title}>{title}</th>)}</tr></thead>
        <tbody>{rows.map((item) => <tr key={item.id}>
          <td><CandidateIdentity item={item} /></td><td>{item.title || 'NA'}</td><td>{humanise(item.state)}</td>
          <td>{item.joiningDate ? formatDate(item.joiningDate.slice(0, 10) + 'T00:00:00') : 'NA'}</td><td>{formatDateTime(item.offerExpiresAt)}</td><td>{offerResponse(item)}</td>
          <td>{!item.consentRevoked && !item.closedAt && ['DRAFT', 'EXTENDED'].includes(item.state)
            ? <button className="secondary" disabled={busy} onClick={() => { void withdraw(item.id); }}>Withdraw offer</button> : 'NA'}</td>
        </tr>)}</tbody>
      </table></div> : null}
    </section>
  </section>;
}

export function EmployerHiringAnalyticsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [result, setResult] = useState<{ employerId: string; analytics: HiringAnalyticsDto } | null>(null);
  const [status, setStatus] = useState('Loading hiring analytics…');
  useEffect(() => {
    const abort = new AbortController();
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    void getEmployerHiringAnalytics(token, employerId, abort.signal).then(({ analytics }) => {
      if (!abort.signal.aborted) { setResult({ employerId, analytics }); setStatus(''); }
    }).catch(() => { if (!abort.signal.aborted) setStatus('Hiring analytics could not be loaded.'); });
    return () => abort.abort();
  }, [employerId]);
  const analytics = result?.employerId === employerId ? result.analytics : null;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>Hiring reports</h1><p>All submitted applications for your employer. No candidate identities are included.</p></div></div>
    {status ? <p role="status">{status}</p> : null}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📨" tone="blue" label="Applications" value={analytics?.applicationCount ?? 'NA'} />
      <V2Stat icon="⏱" tone="amber" label="Mean days to first offer" value={analytics?.meanTimeToOfferDays == null ? 'NA' : analytics.meanTimeToOfferDays.toFixed(1)} />
      <V2Stat icon="📄" tone="green" label="Applications with timed offers" value={analytics?.timedOfferCount ?? 'NA'} />
    </div>
    <section className="role-card role-wide"><h2>Applications by stage</h2>
      <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>Stage</th><th>Current applications</th><th>Ever reached</th></tr></thead>
        <tbody>{(analytics?.stages ?? ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'].map((stage) => ({ stage, count: 'NA', reached: 'NA' }))).map((item) => <tr key={item.stage}><td>{humanise(item.stage)}</td><td>{item.count}</td><td>{item.reached}</td></tr>)}</tbody>
      </table></div>
    </section>
    <section className="role-card role-wide"><h2>Stage conversion</h2><p>Among applications that entered a stage, the share that also reached the next named stage. Skipped stages are not inferred; these are lifetime figures, not a forecast.</p>
      {analytics ? <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>From</th><th>To</th><th>Entered</th><th>Progressed</th><th>Conversion</th></tr></thead>
        <tbody>{analytics.conversions.map((item) => <tr key={item.from}><td>{humanise(item.from)}</td><td>{humanise(item.to)}</td><td>{item.entrants}</td><td>{item.progressed}</td><td>{item.rate === null ? 'NA' : `${(item.rate * 100).toFixed(1)}%`}</td></tr>)}</tbody>
      </table></div> : <p>NA</p>}
      <p>Time-to-offer runs from application submission to the first extended offer, using records with valid timestamps.</p>
    </section>
    <section className="role-card role-wide"><h2>Per-opportunity funnel</h2>
      {analytics?.opportunities.length ? <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>Opportunity</th><th>Applications</th>{analytics.opportunities[0]?.funnel.map((item) => <th key={item.stage}>{humanise(item.stage)}</th>)}</tr></thead>
        <tbody>{analytics.opportunities.map((item, index) => <tr key={index}><td>{item.title}</td><td>{item.applicationCount}</td>{item.funnel.map((stage) => <td key={stage.stage}>{stage.count}</td>)}</tr>)}</tbody>
      </table></div> : <p>{analytics ? 'No opportunities to report yet.' : 'NA'}</p>}
    </section>
  </section>;
}

type EmployerApplicantStateFilter = 'INTERVIEW' | 'OFFER';

export function EmployerApplicantsPage({ employerId, applicationStateFilter }: { readonly employerId: string; readonly applicationStateFilter?: EmployerApplicantStateFilter }): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  const [selectedOpportunity, setSelectedOpportunity] = useState<string>('');
  const [applicants, setApplicants] = useState<readonly EmployerApplicantDto[]>([]);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    void listEmployerOpportunities(token, employerId)
      .then((response) => {
        setOpportunities(response.opportunities);
        const published = response.opportunities.find((item) => item.lifecycleState === 'PUBLISHED');
        if (published) setSelectedOpportunity(published.id);
        setStatus(response.opportunities.length ? '' : 'Create and publish an opportunity first.');
      })
      .catch(() => setStatus('Your opportunities could not be loaded.'));
  }, [employerId]);

  const reloadApplicants = async (opportunityId: string): Promise<void> => {
    const token = getAccessToken();
    if (!token || !opportunityId) return;
    const response = await listEmployerApplicants(token, employerId, opportunityId);
    setApplicants(response.applications);
    setStatus(response.applications.length ? '' : 'No applications for this opportunity yet.');
  };
  useEffect(() => { void reloadApplicants(selectedOpportunity).catch(() => setStatus('Applicants could not be loaded.')); }, [selectedOpportunity]);

  async function move(applicationId: string, toState: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await transitionApplication(token, employerId, applicationId, toState);
      setStatus(`Moved to ${humanise(toState)}.`);
      await reloadApplicants(selectedOpportunity);
    } catch (error) {
      setStatus(messageFor(error, 'That change could not be saved.'));
    }
  }

  const [action, setAction] = useState<{ kind: 'interview' | 'offer' | 'feedback'; applicant: EmployerApplicantDto } | null>(null);

  async function saveFeedback(reasonCodes: readonly string[], note: string): Promise<void> {
    const token = getAccessToken();
    if (!token || !action) throw new Error('Unavailable');
    await releaseCandidateFeedback(token, employerId, action.applicant.id, reasonCodes, note || undefined);
    setAction(null);
    // Reload first: reloadApplicants recomputes the status line, so a confirmation set
    // before it would be wiped a moment later.
    await reloadApplicants(selectedOpportunity).catch(() => undefined);
    setStatus('Feedback shared with the candidate.');
  }

  async function saveInterview(input: InterviewScheduleInput): Promise<void> {
    const token = getAccessToken();
    if (!token || !action) throw new Error('Unavailable');
    await scheduleInterview(token, employerId, action.applicant.id, input);
    setAction(null);
    await reloadApplicants(selectedOpportunity).catch(() => setStatus('Interview saved. Refresh to update the list.'));
  }

  async function saveOffer(input: OfferInput): Promise<void> {
    const token = getAccessToken();
    if (!token || !action) throw new Error('Unavailable');
    await extendOffer(token, employerId, action.applicant.id, input);
    setAction(null);
    await reloadApplicants(selectedOpportunity).catch(() => setStatus('Offer sent. Refresh to update the list.'));
  }

  const visibleApplicants = applicationStateFilter ? applicants.filter((item) => item.state === applicationStateFilter) : applicants;

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Applicants</span>
      <h1>Applicants</h1>
      <p>Move candidates through your process. Everything here is a real record, and every change is logged.</p>
    </div></div>

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="blue" value={visibleApplicants.length} label="Applicants shown" />
      <V2Stat icon="⭐" tone="purple" value={visibleApplicants.filter((item) => /shortlist/i.test(item.state)).length} label="Shortlisted" />
      <V2Stat icon="📅" tone="amber" value={visibleApplicants.reduce((sum, item) => sum + item.interviewCount, 0)} label="Interviews" />
      <V2Stat icon="🏁" tone="green" value={visibleApplicants.filter((item) => item.offerState).length} label="With offers" />
    </div>

    <section className="role-card role-wide">
      <label className="student-form-field"><span>Opportunity</span>
        <select value={selectedOpportunity} onChange={(event) => { setAction(null); setApplicants([]); setSelectedOpportunity(event.target.value); }}>
          <option value="">Select an opportunity</option>
          {opportunities.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.referenceCode} ({item.applicationCount})</option>)}
        </select>
      </label>
      {applicationStateFilter ? <p className="hiring-meta">Application state filter: <span className={`hiring-state state-${applicationStateFilter.toLowerCase()}`}>{humanise(applicationStateFilter)}</span></p> : null}
      {status ? <p role="status">{status}</p> : null}
    </section>

    <section className="role-card role-wide">
      {visibleApplicants.length === 0
        ? <p>No applications to show.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Candidate</th><th>Stage</th><th>Applied</th><th>Interviews</th><th>Offer</th><th>Next step</th></tr></thead>
          <tbody>{visibleApplicants.map((item) => <tr key={item.id}>
            <td><CandidateIdentity item={item} /></td>
            <td><span className={`hiring-state state-${item.state.toLowerCase()}`}>{humanise(item.state)}</span></td>
            <td>{formatDate(item.submittedAt)}</td>
            <td>{item.interviewCount}</td>
            <td>{item.offerState ? humanise(item.offerState) : '—'}</td>
            <td>{item.closedAt || item.consentRevoked
              ? <div className="hiring-actions">
                <span className="hiring-meta">Closed</span>
                {item.state === 'REJECTED' && !item.consentRevoked
                  ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'feedback', applicant: item })}>Share feedback</button>
                  : null}
              </div>
              : <div className="hiring-actions">
                {(PIPELINE_NEXT[item.state] ?? []).map((next) => <button key={next} type="button" className={next === 'REJECTED' ? 'secondary' : undefined} onClick={() => { void move(item.id, next); }}>{humanise(next)}</button>)}
                {item.state === 'INTERVIEW' ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'interview', applicant: item })}>Schedule interview</button> : null}
                {item.state === 'OFFER' && !item.offerState ? <button type="button" onClick={() => setAction({ kind: 'offer', applicant: item })}>Send offer</button> : null}
              </div>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {action && !action.applicant.consentRevoked ? <section className="role-card role-wide">
      <h2>{action.kind === 'interview' ? 'Schedule interview' : action.kind === 'offer' ? 'Send offer' : 'Share feedback with this candidate'}</h2>
      <p><CandidateIdentity item={action.applicant} /></p>
      {action.kind === 'interview'
        ? <InterviewForm employerId={employerId} onSave={saveInterview} onCancel={() => setAction(null)} />
        : action.kind === 'offer'
          ? <OfferForm onSave={saveOffer} onCancel={() => setAction(null)} />
          : <FeedbackForm employerId={employerId} onSave={saveFeedback} onCancel={() => setAction(null)} />}
    </section> : null}
  </section>;
}

/**
 * Choosing what a rejected candidate gets told.
 *
 * Deliberately separate from the rejection itself: the reason an employer recorded for
 * their own team stays private, and this is a second, considered act. Nothing is shared
 * unless someone picks a reason and presses the button.
 */
export function FeedbackForm({ employerId, onSave, onCancel }: {
  readonly employerId: string;
  readonly onSave: (reasonCodes: readonly string[], note: string) => Promise<void>;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [reasons, setReasons] = useState<readonly CandidateFeedbackReasonDto[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    void listCandidateFeedbackReasons(token, employerId)
      .then((response) => setReasons(response.reasons))
      .catch(() => setStatus('The feedback options could not be loaded.'));
  }, [employerId]);

  function toggle(code: string): void {
    setSelected((current) => current.includes(code)
      ? current.filter((item) => item !== code)
      : current.length >= 4 ? current : [...current, code]);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!selected.length) return setStatus('Choose at least one reason.');
    setSaving(true);
    try {
      await onSave(selected, note.trim());
    } catch (error) {
      setStatus(messageFor(error, 'That feedback could not be shared.'));
    } finally { setSaving(false); }
  }

  return <form onSubmit={(event) => { void submit(event); }} className="student-form">
    <p>Pick up to four reasons. The candidate sees exactly these words, your optional note, and nothing else — your internal notes stay private.</p>
    {reasons.length === 0 ? <p role="status">{status || 'Loading options…'}</p> : null}
    <ul className="check-stack">
      {reasons.map((reason) => <li key={reason.code}>
        <label>
          <input
            type="checkbox"
            checked={selected.includes(reason.code)}
            disabled={!selected.includes(reason.code) && selected.length >= 4}
            onChange={() => toggle(reason.code)}
          />
          {' '}{reason.studentLabel}
        </label>
      </li>)}
    </ul>
    <label className="student-form-field"><span>Note to the candidate (optional)</span>
      <textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
    </label>
    {status && reasons.length ? <p role="status">{status}</p> : null}
    <div className="hiring-actions">
      <button type="submit" disabled={saving || !selected.length}>Share with candidate</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
