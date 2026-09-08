import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { getAccessToken } from './auth.js';
import { V2Stat } from './dashboardsV2.js';
import {
  listEmployerInterviews, listEmployerOffers, updateInterviewState, submitInterviewOutcome,
  withdrawEmployerOffer, revokeInstitutionVisibility, getEmployerHiringAnalytics,
  type EmployerInterviewDto, type EmployerOfferDto, type InterviewScheduleInput,
  type InterviewStateInput, type InterviewOutcomeInput, type OfferInput, type HiringAnalyticsDto,
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
  listStudentApplications,
  listStudentOffers,
  publishOpportunity,
  respondToOffer,
  scheduleInterview,
  transitionApplication,
  withdrawApplication,
  type EligibilityDto,
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
      {status ? <p role="status">{status}</p> : null}
      {applications.length === 0
        ? <p>When you apply to an opportunity it will appear here, with the stage it has reached.</p>
        : <div className="data-table-wrap"><table>
          <thead><tr><th>Role</th><th>Company</th><th>Stage</th><th>Applied</th><th>Institution sharing</th><th>Action</th></tr></thead>
          <tbody>{applications.map((item) => <tr key={item.id}>
            <td>{item.title}</td>
            <td>{item.employerName}</td>
            <td><span className={`hiring-state state-${item.state.toLowerCase()}`}>{humanise(item.state)}</span>
              {item.termsAcknowledgementPending ? <span className="hiring-tag warn">Terms changed</span> : null}</td>
            <td>{formatDate(item.submittedAt)}</td>
            <td>{item.institutionVisibilityGrantedAt && !item.institutionVisibilityRevokedAt
              ? <button type="button" className="secondary" disabled={revoking} onClick={() => { void revokeVisibility(item.id); }}>Stop institution sharing</button>
              : <span>{item.institutionVisibilityRevokedAt ? 'Sharing stopped' : 'Not shared'}</span>}</td>
            <td>{item.closedAt
              ? <span className="hiring-meta">Closed</span>
              : <button type="button" className="secondary" onClick={() => { void withdraw(item.id); }}>Withdraw</button>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <StudentOffersPanel onChanged={() => { void reload(); }} />
  </div>;
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
function CandidateIdentity({ item }: { readonly item: Pick<EmployerApplicantDto, 'consentRevoked' | 'candidateName' | 'candidateEmail' | 'institutionStudentId'> }): React.ReactElement {
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

function InterviewForm({ onSave, onCancel }: { readonly onSave: (input: InterviewScheduleInput) => Promise<void>; readonly onCancel: () => void }): React.ReactElement {
  const [mode, setMode] = useState<InterviewScheduleInput['mode']>('VIDEO');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    let window: ReturnType<typeof scheduleWindow>;
    try { window = scheduleWindow(form); } catch { setError('Choose a future date and a duration between 1 and 1440 minutes.'); return; }
    setBusy(true); setError('');
    try {
      await onSave({ ...window, mode,
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

function InterviewActionForm({ kind, onSave, onCancel }: {
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

export function EmployerApplicantsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
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

  const [action, setAction] = useState<{ kind: 'interview' | 'offer'; applicant: EmployerApplicantDto } | null>(null);

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

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Applicants</span>
      <h1>Applicants</h1>
      <p>Move candidates through your process. Everything here is a real record, and every change is logged.</p>
    </div></div>

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="blue" value={applicants.length} label="Applicants shown" />
      <V2Stat icon="⭐" tone="purple" value={applicants.filter((item) => /shortlist/i.test(item.state)).length} label="Shortlisted" />
      <V2Stat icon="📅" tone="amber" value={applicants.reduce((sum, item) => sum + item.interviewCount, 0)} label="Interviews" />
      <V2Stat icon="🏁" tone="green" value={applicants.filter((item) => item.offerState).length} label="With offers" />
    </div>

    <section className="role-card role-wide">
      <label className="student-form-field"><span>Opportunity</span>
        <select value={selectedOpportunity} onChange={(event) => { setAction(null); setApplicants([]); setSelectedOpportunity(event.target.value); }}>
          <option value="">Select an opportunity</option>
          {opportunities.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.referenceCode} ({item.applicationCount})</option>)}
        </select>
      </label>
      {status ? <p role="status">{status}</p> : null}
    </section>

    <section className="role-card role-wide">
      {applicants.length === 0
        ? <p>No applications to show.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Candidate</th><th>Stage</th><th>Applied</th><th>Interviews</th><th>Offer</th><th>Next step</th></tr></thead>
          <tbody>{applicants.map((item) => <tr key={item.id}>
            <td><CandidateIdentity item={item} /></td>
            <td><span className={`hiring-state state-${item.state.toLowerCase()}`}>{humanise(item.state)}</span></td>
            <td>{formatDate(item.submittedAt)}</td>
            <td>{item.interviewCount}</td>
            <td>{item.offerState ? humanise(item.offerState) : '—'}</td>
            <td>{item.closedAt || item.consentRevoked
              ? <span className="hiring-meta">Closed</span>
              : <div className="hiring-actions">
                {(PIPELINE_NEXT[item.state] ?? []).map((next) => <button key={next} type="button" className={next === 'REJECTED' ? 'secondary' : undefined} onClick={() => { void move(item.id, next); }}>{humanise(next)}</button>)}
                {item.state === 'INTERVIEW' ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'interview', applicant: item })}>Schedule interview</button> : null}
                {item.state === 'OFFER' && !item.offerState ? <button type="button" onClick={() => setAction({ kind: 'offer', applicant: item })}>Send offer</button> : null}
              </div>}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {action && !action.applicant.consentRevoked ? <section className="role-card role-wide">
      <h2>{action.kind === 'interview' ? 'Schedule interview' : 'Send offer'}</h2>
      <p><CandidateIdentity item={action.applicant} /></p>
      {action.kind === 'interview'
        ? <InterviewForm onSave={saveInterview} onCancel={() => setAction(null)} />
        : <OfferForm onSave={saveOffer} onCancel={() => setAction(null)} />}
    </section> : null}
  </section>;
}
