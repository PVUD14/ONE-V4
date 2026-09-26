/**
 * ONE · Employer portal — Opportunity Detail (EMP-05).
 *
 * The screen behind the employer navigation's existing "Opportunity Detail" label, which
 * rendered the same list as "Opportunities" until jobs could be changed after publishing. It
 * shows one job: its state and what it allows, its audience, its applicants, the current
 * version's terms, the version history, and the actions — edit (a new version), pause, close,
 * reopen and withdraw, with a reason from the server's fixed list where one is needed.
 *
 * The server decides everything: which actions exist in this state (availableActions), whether
 * an edit moved a term applicants applied under, and who must accept it. This page only says
 * what happened. Nothing is invented: a job with no deadline says "No deadline", a missing
 * value says "NA".
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, getProtectedAccessToken } from '../api.js';
import {
  changeOpportunityLifecycle,
  createOpportunityVersion,
  getEmployerOpportunity,
  listEmployerOpportunities,
  type EmployerOpportunityDetailDto,
  type EmployerOpportunityDto,
  type OpportunityLifecycleAction,
  type OpportunityVersionHistoryDto,
  type OpportunityVersionTermsDto,
} from '../api/hiring.js';
import { V2Stat, V2EmptyState } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { formatApiError } from './shared.js';

const actionLabels: Readonly<Record<OpportunityLifecycleAction, string>> = {
  PAUSE: 'Pause', CLOSE: 'Close', REOPEN: 'Reopen', WITHDRAW: 'Withdraw',
};
const actionExplanations: Readonly<Record<OpportunityLifecycleAction, string>> = {
  PAUSE: 'Students stop seeing the job and cannot apply. Your applicants carry on. Reopen it when you are ready.',
  CLOSE: 'No more applications. You keep working with the applicants you have.',
  REOPEN: 'Students who match its audience can see the job and apply again.',
  WITHDRAW: 'The job is removed for good. Every open application has to be decided first.',
};
const reasonLabels: Readonly<Record<string, string>> = {
  HIRING_ON_HOLD: 'Hiring is on hold',
  REVIEWING_APPLICANTS: 'Reviewing the applicants we have',
  UPDATING_DETAILS: 'Updating the job details',
  POSITION_FILLED: 'Position filled',
  ENOUGH_APPLICANTS: 'We have enough applicants',
  ROLE_CANCELLED: 'The role was cancelled',
  POSTED_IN_ERROR: 'Posted in error',
  DUPLICATE_POSTING: 'Duplicate posting',
  TERMS_INCORRECT: 'The terms were wrong',
  DEADLINE_PASSED: 'The deadline passed',
};
/** Names for the terms the server reports as changed. */
export const termLabels: Readonly<Record<string, string>> = {
  employmentType: 'Employment type', workMode: 'Work mode', locationCity: 'Location', compensationDisclosed: 'Pay shown',
  compensationCurrency: 'Pay currency', compensationMin: 'Pay', compensationMax: 'Pay (upper)', compensationPeriod: 'Pay period',
  durationMonths: 'Duration', applicationDeadline: 'Deadline', joiningConditions: 'Joining conditions', eligibility: 'Eligibility',
};
const stateNotes: Readonly<Record<string, string>> = {
  DRAFT: 'Not visible to students yet. Publish it from Opportunities.',
  PUBLISHED: 'Live: students who match its audience can see it and apply.',
  PAUSED: 'Hidden from students; no new applications. Your applicants carry on.',
  CLOSED: 'Closed to new applications. Your applicants carry on.',
  WITHDRAWN: 'Withdrawn. This job cannot come back.',
};

function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
function formatDate(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleString();
}
function pay(version: OpportunityVersionTermsDto): string {
  if (!version.compensationDisclosed || !version.compensationMin || !version.compensationCurrency) return 'Not disclosed';
  const period = version.compensationPeriod === 'TOTAL_STIPEND' ? 'total' : (version.compensationPeriod ?? '').toLowerCase();
  const upper = version.compensationMax ? `–${Number(version.compensationMax).toLocaleString()}` : '';
  return `${version.compensationCurrency} ${Number(version.compensationMin).toLocaleString()}${upper}${period ? ` / ${period}` : ''}`;
}
function changeSummary(version: OpportunityVersionHistoryDto): string {
  if (version.change === 'INITIAL') return 'First version';
  if (version.change === 'EDITORIAL') return 'Wording only';
  return version.changedTerms.map((term) => termLabels[term] ?? term).join(', ');
}
/** An ISO timestamp as the value a datetime-local input takes, in the viewer's time. */
function toLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function selectedFromLocation(): string | null {
  try { return new URLSearchParams(window.location.search).get('opportunity'); } catch { return null; }
}

export function EmployerOpportunityDetailPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [jobs, setJobs] = useState<readonly EmployerOpportunityDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromLocation());
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listEmployerOpportunities(token, employerId, controller.signal).then(({ opportunities }) => {
      if (controller.signal.aborted) return;
      setJobs(opportunities);
      setSelected((current) => current && opportunities.some((job) => job.id === current) ? current : opportunities[0]?.id ?? null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof ApiRequestError && cause.code === 'EMPLOYER_ORGANISATION_INACTIVE'
        ? `Your employer account is suspended or was not approved, so your jobs are not available. Reference: ${cause.correlationId}`
        : formatApiError(cause, 'Your jobs could not be loaded.'));
    });
    return () => controller.abort();
  }, [token, employerId]);

  const subtitle = 'One job: its state, its versions and what you can do with it.';
  if (!token) return <StaffPilotWrap title="Opportunity Detail" subtitle="Sign in with an employer identity to manage your jobs."><p role="status">You are not signed in.</p></StaffPilotWrap>;
  if (error) return <StaffPilotWrap title="Opportunity Detail" subtitle={subtitle}><p className="form-error" role="alert">{error}</p></StaffPilotWrap>;
  if (!jobs) return <StaffPilotWrap title="Opportunity Detail" subtitle={subtitle}><p role="status">Loading your jobs…</p></StaffPilotWrap>;
  if (!jobs.length || !selected) {
    return <StaffPilotWrap title="Opportunity Detail" subtitle={subtitle}>
      <div className="role-wide"><V2EmptyState icon="💼" title="No jobs yet" note="Create a job under Opportunities; its details, versions and actions appear here." /></div>
    </StaffPilotWrap>;
  }
  return <StaffPilotWrap title="Opportunity Detail" subtitle={subtitle}>
    <section className="role-card role-wide">
      <label className="student-form-field"><span>Job</span>
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {jobs.map((job) => <option key={job.id} value={job.id}>{`${job.title ?? 'Untitled'} · ${job.referenceCode} · ${humanise(job.lifecycleState)}`}</option>)}
        </select></label>
    </section>
    <OpportunityDetail key={selected} employerId={employerId} opportunityId={selected} token={token}
      onChanged={(id, lifecycleState) => setJobs((current) => current?.map((job) => job.id === id ? { ...job, lifecycleState } : job) ?? current)} />
  </StaffPilotWrap>;
}

function OpportunityDetail({ employerId, opportunityId, token, onChanged }: {
  readonly employerId: string; readonly opportunityId: string; readonly token: string;
  readonly onChanged: (id: string, lifecycleState: string) => void;
}): React.ReactElement {
  const [detail, setDetail] = useState<{ opportunity: EmployerOpportunityDetailDto; currentVersion: OpportunityVersionTermsDto | null; versions: readonly OpportunityVersionHistoryDto[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<OpportunityLifecycleAction | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getEmployerOpportunity(token, employerId, opportunityId, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setDetail(response); setLoadError('');
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'This job could not be loaded.')); });
    return () => controller.abort();
  }, [token, employerId, opportunityId, reload]);

  if (loadError) return <p className="form-error" role="alert">{loadError}</p>;
  if (!detail) return <p role="status">Loading the job…</p>;
  const { opportunity, currentVersion, versions } = detail;

  async function act(action: OpportunityLifecycleAction): Promise<void> {
    const reasons = opportunity.reasonCodes[action] ?? [];
    if ((action === 'CLOSE' || action === 'WITHDRAW') && !reason) { setError('Choose a reason.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await changeOpportunityLifecycle(token, employerId, opportunityId, action, reasons.length && reason ? reason : undefined);
      onChanged(opportunityId, result.opportunity.lifecycleState);
      setNotice(`Job ${humanise(result.opportunity.lifecycleState).toLowerCase()}.`);
      setPending(null); setReason(''); setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'That change could not be made.'));
    } finally { setBusy(false); }
  }

  async function saveVersion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!currentVersion) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const number = (name: string) => text(name) ? Number(text(name)) : null;
    const disclosed = form.get('compensationDisclosed') === 'on';
    const deadline = text('applicationDeadline');
    const body: Record<string, unknown> = {
      expectedCurrentVersionId: currentVersion.id,
      title: text('title'),
      summary: text('summary') || null,
      responsibilities: text('responsibilities') || null,
      employmentType: text('employmentType'),
      workMode: text('workMode'),
      locationCity: text('locationCity') || null,
      positionsAvailable: number('positionsAvailable'),
      durationMonths: number('durationMonths'),
      compensationDisclosed: disclosed,
      ...(disclosed ? {
        compensationCurrency: text('compensationCurrency'),
        compensationMin: number('compensationMin'),
        compensationMax: number('compensationMax'),
        compensationPeriod: text('compensationPeriod'),
      } : {}),
      joiningConditions: text('joiningConditions') || null,
      applicationDeadline: deadline ? new Date(deadline).toISOString() : null,
    };
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await createOpportunityVersion(token, employerId, opportunityId, body);
      const asked = result.applicants.acknowledgementsRequired;
      setNotice(result.version.change === 'EDITORIAL'
        ? `Saved as version ${result.version.versionNumber}. Only the wording changed, so applicants are not asked anything.`
        : `Saved as version ${result.version.versionNumber}. Changed: ${result.version.changedTerms.map((term) => termLabels[term] ?? term).join(', ')}. `
          + (asked ? `${asked} applicant${asked === 1 ? '' : 's'} must accept the new terms before you can move them on.` : 'No applicant has to accept anything.'));
      setEditing(false); setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The new version could not be saved.'));
    } finally { setBusy(false); }
  }

  const last = opportunity.lastLifecycleChange;
  return <>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="💼" tone="blue" value={humanise(opportunity.lifecycleState)} label="State" />
      <V2Stat icon="📥" tone="green" value={opportunity.applicationCount} label="Applications" />
      <V2Stat icon="🔄" tone="purple" value={opportunity.openApplicationCount} label="Open applications" />
      <V2Stat icon="✍️" tone="amber" value={opportunity.awaitingAcknowledgementCount} label="Awaiting new-terms acceptance" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    <section className="role-card role-wide" aria-label="Job state">
      <div className="role-section-title"><h2>{currentVersion?.title ?? 'Untitled'}</h2>
        <span className={`hiring-state state-${opportunity.lifecycleState.toLowerCase()}`}>{humanise(opportunity.lifecycleState)}</span></div>
      <p>{stateNotes[opportunity.lifecycleState] ?? humanise(opportunity.lifecycleState)}</p>
      <p className="hiring-meta">Reference {opportunity.referenceCode} · Published {formatDate(opportunity.publishedAt)}{opportunity.closedAt ? ` · Closed ${formatDate(opportunity.closedAt)}` : ''}</p>
      {last ? <p className="hiring-meta">Last change: {humanise(last.action.replace('opportunity.', ''))} on {formatDate(last.occurredAt)}
        {last.reasonCode ? ` — ${reasonLabels[last.reasonCode] ?? humanise(last.reasonCode)}` : ''}{last.trigger === 'DEADLINE' ? ' (automatically, at the deadline)' : ''}</p> : null}
      <p className="hiring-meta">Audience: {opportunity.audiences.length
        ? opportunity.audiences.map((audience) => audience.kind === 'PUBLIC' ? 'All students' : [audience.institutionName, audience.unitName].filter(Boolean).join(' · ') || humanise(audience.kind)).join('; ')
        : 'None yet — nobody can see this job.'}</p>
      {opportunity.awaitingAcknowledgementCount > 0 ? <p className="hiring-tag warn">{opportunity.awaitingAcknowledgementCount} applicant(s) have not yet accepted the changed terms; they stay where they are until they do.</p> : null}

      <div className="hiring-actions" role="group" aria-label="Job actions">
        {opportunity.canEdit ? <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing((value) => !value); setPending(null); }}>{editing ? 'Cancel edit' : 'Edit job'}</button> : null}
        {opportunity.availableActions.map((action) => <button key={action} type="button" className={action === 'WITHDRAW' ? 'secondary' : undefined} disabled={busy}
          onClick={() => { setPending(action); setReason(''); setEditing(false); setError(''); }}>{actionLabels[action]}</button>)}
      </div>
      {pending ? <div className="role-management-form" aria-label={`${actionLabels[pending]} job`}>
        <p>{actionExplanations[pending]}</p>
        {(opportunity.reasonCodes[pending] ?? []).length ? <label><span>{pending === 'PAUSE' ? 'Reason (optional)' : 'Reason'}</span>
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="">{pending === 'PAUSE' ? 'No reason given' : 'Choose a reason'}</option>
            {(opportunity.reasonCodes[pending] ?? []).map((code) => <option key={code} value={code}>{reasonLabels[code] ?? humanise(code)}</option>)}
          </select></label> : null}
        <div className="hiring-actions">
          <button type="button" disabled={busy} onClick={() => { void act(pending); }}>{`Confirm: ${actionLabels[pending].toLowerCase()}`}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
        </div>
      </div> : null}
    </section>

    {editing && currentVersion ? <form className="role-card role-wide role-management-form" aria-label="Edit job" onSubmit={(event) => { void saveVersion(event); }}>
      <h2>Edit job — saves version {currentVersion.versionNumber + 1}</h2>
      <p>Earlier versions stay as they were. If you change pay, location, work mode, employment type, duration, joining conditions or eligibility, everyone who has applied is asked to accept the new terms before you can move them on. A new deadline alone is recorded without asking them.</p>
      <label><span>Title</span><input name="title" required maxLength={200} defaultValue={currentVersion.title} /></label>
      <label><span>Summary</span><textarea name="summary" maxLength={2000} defaultValue={currentVersion.summary ?? ''} /></label>
      <label><span>Responsibilities</span><textarea name="responsibilities" maxLength={8000} defaultValue={currentVersion.responsibilities ?? ''} /></label>
      <label><span>Employment type</span><select name="employmentType" defaultValue={currentVersion.employmentType}>
        {['INTERNSHIP', 'FULL_TIME', 'PART_TIME', 'APPRENTICESHIP', 'CONTRACT'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
      </select></label>
      <label><span>Work mode</span><select name="workMode" defaultValue={currentVersion.workMode}>
        {['ONSITE', 'HYBRID', 'REMOTE'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
      </select></label>
      <label><span>Location</span><input name="locationCity" maxLength={120} defaultValue={currentVersion.locationCity ?? ''} /></label>
      <label><span>Positions</span><input name="positionsAvailable" type="number" min={1} defaultValue={currentVersion.positionsAvailable ?? ''} /></label>
      <label><span>Duration (months)</span><input name="durationMonths" type="number" min={1} max={120} defaultValue={currentVersion.durationMonths ?? ''} /></label>
      <label className="hiring-checkbox"><input type="checkbox" name="compensationDisclosed" defaultChecked={currentVersion.compensationDisclosed} /><span>Show the pay on the listing</span></label>
      <label><span>Currency</span><input name="compensationCurrency" maxLength={3} defaultValue={currentVersion.compensationCurrency ?? 'INR'} /></label>
      <label><span>Amount</span><input name="compensationMin" type="number" min={0} step={100} defaultValue={currentVersion.compensationMin ?? ''} /></label>
      <label><span>Up to (optional)</span><input name="compensationMax" type="number" min={0} step={100} defaultValue={currentVersion.compensationMax ?? ''} /></label>
      <label><span>Per</span><select name="compensationPeriod" defaultValue={currentVersion.compensationPeriod ?? 'MONTH'}>
        {['HOUR', 'MONTH', 'YEAR', 'TOTAL_STIPEND'].map((value) => <option key={value} value={value}>{humanise(value)}</option>)}
      </select></label>
      <label><span>Joining conditions</span><textarea name="joiningConditions" maxLength={2000} defaultValue={currentVersion.joiningConditions ?? ''} /></label>
      <label><span>Application deadline</span><input name="applicationDeadline" type="datetime-local" defaultValue={toLocalInput(currentVersion.applicationDeadline)} /></label>
      <button type="submit" disabled={busy}>Save new version</button>
    </form> : null}

    {currentVersion ? <section className="role-card role-wide" aria-label="Current terms">
      <h2>Current terms · version {currentVersion.versionNumber}</h2>
      <div className="role-record-table-wrap"><table className="role-record-table"><tbody>
        <tr><th scope="row">Employment type</th><td>{humanise(currentVersion.employmentType)}</td></tr>
        <tr><th scope="row">Work mode</th><td>{humanise(currentVersion.workMode)}</td></tr>
        <tr><th scope="row">Location</th><td>{currentVersion.locationCity ?? 'NA'}</td></tr>
        <tr><th scope="row">Pay</th><td>{pay(currentVersion)}</td></tr>
        <tr><th scope="row">Duration</th><td>{currentVersion.durationMonths ? `${currentVersion.durationMonths} months` : 'NA'}</td></tr>
        <tr><th scope="row">Deadline</th><td>{currentVersion.applicationDeadline ? formatDate(currentVersion.applicationDeadline) : 'No deadline'}</td></tr>
        <tr><th scope="row">Joining conditions</th><td>{currentVersion.joiningConditions ?? 'NA'}</td></tr>
      </tbody></table></div>
    </section> : null}

    <section className="role-card role-wide" aria-label="Version history">
      <h2>Version history</h2>
      <p>Every edit is a new version; nothing is overwritten. Applicants stay bound to the version they applied to until they accept a newer one.</p>
      <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Version</th><th>Saved</th><th>Title</th><th>What changed</th></tr></thead>
        <tbody>{versions.map((version) => <tr key={version.id}>
          <td>{version.versionNumber}{version.isCurrent ? <span className="hiring-meta"> · current</span> : null}</td>
          <td>{formatDate(version.createdAt)}</td>
          <td>{version.title}</td>
          <td>{version.change === 'MATERIAL' ? <span className="hiring-tag warn">{changeSummary(version)}</span> : changeSummary(version)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
  </>;
}
