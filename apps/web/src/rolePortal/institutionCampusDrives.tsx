/**
 * ONE · Role portal — Institution — campus drive approvals and placement policies (EMP-11).
 *
 * The placement office decides which employers' jobs reach its students: approve (optionally
 * with a confirmed date), ask for changes, or decline — each refusal with a reason — then
 * schedule, cancel or complete. It also sets the college's placement policy (one offer per
 * student) enforced at apply for applications that come through its drives. No navigation item
 * is added (HG-3): the placement officer finds these on the Dashboard, the admin on Placement
 * (drives) and Settings (policies).
 *
 * The server decides who may act (institution-wide owners, admins and placement admins; the
 * list says `canDecide`) and which actions exist per drive. Results show suppressed counts once a
 * drive is complete, and names only for students who shared that application with the college.
 * Nothing is invented: a missing date reads NA; pay never appears.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { getProtectedAccessToken, suppressedCountLabel } from '../api.js';
import {
  campusDriveChangeReasons,
  campusDriveInstitutionCancelReasons,
  campusDriveRejectReasons,
  campusDriveStateLabels,
  getCampusDriveHistory,
  getCampusDriveResults,
  listInstitutionCampusDrives,
  listPlacementPolicies,
  moveInstitutionCampusDrive,
  placementPolicyRetireReasons,
  reasonLabel,
  retirePlacementPolicy,
  setPlacementPolicy,
  venueModeLabels,
  type CampusDriveAction,
  type CampusDriveDto,
  type CampusDriveHistoryDto,
  type CampusDriveResultsDto,
  type CampusDriveState,
  type PlacementPolicyDto,
  type VenueMode,
} from '../api/campusDrives.js';
import { applicationStageLabels, offerResponseLabels } from './institutionDepartment.js';
import { formatApiError } from './shared.js';

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function localToIso(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

type CollegeAction = Exclude<CampusDriveAction, 'RESUBMIT'>;
const actionLabels: Readonly<Record<CollegeAction, string>> = {
  APPROVE: 'Approve', REQUEST_CHANGES: 'Ask for changes', REJECT: 'Decline', SCHEDULE: 'Set date', COMPLETE: 'Mark complete', CANCEL: 'Withdraw approval',
};
const actionPaths: Readonly<Record<CollegeAction, 'approve' | 'reject' | 'request-changes' | 'schedule' | 'cancel' | 'complete'>> = {
  APPROVE: 'approve', REQUEST_CHANGES: 'request-changes', REJECT: 'reject', SCHEDULE: 'schedule', COMPLETE: 'complete', CANCEL: 'cancel',
};
const actionReasons: Partial<Record<CollegeAction, readonly string[]>> = {
  REJECT: campusDriveRejectReasons, REQUEST_CHANGES: campusDriveChangeReasons, CANCEL: campusDriveInstitutionCancelReasons,
};
const actionExplanations: Readonly<Record<CollegeAction, string>> = {
  APPROVE: 'Your students will see this job and can apply while it is open. Your placement policy applies to everyone who applies through the drive.',
  REQUEST_CHANGES: 'The employer is asked to revise the request. Nothing reaches your students meanwhile.',
  REJECT: 'The request is declined. The employer sees your reason.',
  SCHEDULE: 'Confirm or move the date of this drive.',
  COMPLETE: 'The drive ends: your students no longer see the job through it, and its results become available.',
  CANCEL: 'Your approval is withdrawn: your students no longer see the job through this drive. Applications already made carry on.',
};
const filters: readonly (CampusDriveState | '')[] = ['', 'REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'REJECTED', 'CANCELLED'];

/** Drive requests and decisions for one college. */
export function CampusDriveApprovalsSection({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<CampusDriveState | ''>('');
  const [page, setPage] = useState<{ drives: readonly CampusDriveDto[]; canDecide: boolean; nextCursor: string | null } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [acting, setActing] = useState<{ readonly drive: CampusDriveDto; readonly action: CollegeAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ readonly driveId: string; readonly history: readonly CampusDriveHistoryDto[]; readonly results: CampusDriveResultsDto | null; readonly resultsError: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listInstitutionCampusDrives(token, institutionId, state ? { state } : {}, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setPage({ drives: response.drives ?? [], canDecide: response.canDecide === true, nextCursor: response.nextCursor ?? null }); setLoadError(''); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Campus drives could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId, state, reload]);

  if (!token) return <p role="status">Sign in to see campus drives.</p>;

  async function loadMore(): Promise<void> {
    if (!page?.nextCursor || !token) return;
    try {
      const more = await listInstitutionCampusDrives(token, institutionId, { ...(state ? { state } : {}), cursor: page.nextCursor });
      setPage({ drives: [...page.drives, ...(more.drives ?? [])], canDecide: more.canDecide === true, nextCursor: more.nextCursor ?? null });
    } catch (cause) { setError(formatApiError(cause, 'More drives could not be loaded.')); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!acting || !token) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { revision: acting.drive.revision };
    const reasons = actionReasons[acting.action];
    if (reasons) {
      const reason = String(form.get('reasonCode') ?? '');
      if (!reason) { setError('Choose a reason.'); return; }
      body.reasonCode = reason;
    }
    if (acting.action === 'APPROVE' || acting.action === 'SCHEDULE') {
      const start = localToIso(form.get('scheduledStartAt'));
      const end = localToIso(form.get('scheduledEndAt'));
      if (acting.action === 'SCHEDULE' && !start) { setError('Choose the date and time the drive starts.'); return; }
      if (start) body.scheduledStartAt = start;
      if (end) body.scheduledEndAt = end;
      const venue = String(form.get('venueMode') ?? '');
      if (venue) body.venueMode = venue;
      body.offerHoldersEligible = form.get('offerHoldersEligible') === 'on';
    }
    const note = String(form.get('note') ?? '').trim();
    if (note && acting.action !== 'SCHEDULE') body.note = note;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await moveInstitutionCampusDrive(token, institutionId, acting.drive.id, actionPaths[acting.action], body);
      setNotice(`${result.drive.employerName} · ${result.drive.opportunityTitle ?? 'Untitled'}: ${campusDriveStateLabels[result.drive.state].toLowerCase()}.`);
      setActing(null); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'That decision could not be recorded.')); } finally { setBusy(false); }
  }

  async function toggleDetail(drive: CampusDriveDto): Promise<void> {
    if (!token) return;
    if (open?.driveId === drive.id) { setOpen(null); return; }
    try {
      const history = (await getCampusDriveHistory(token, { institutionId }, drive.id)).history;
      let results: CampusDriveResultsDto | null = null;
      let resultsError = '';
      if (!['REQUESTED', 'CHANGES_REQUESTED', 'REJECTED'].includes(drive.state)) {
        try { results = (await getCampusDriveResults(token, institutionId, drive.id)).results; } catch (cause) { resultsError = formatApiError(cause, 'Results could not be loaded.'); }
      }
      setOpen({ driveId: drive.id, history, results, resultsError });
    } catch (cause) { setError(formatApiError(cause, 'This drive could not be opened.')); }
  }

  const drives = page?.drives ?? [];
  const waiting = drives.filter((drive) => drive.state === 'REQUESTED').length;
  return <section className="role-card role-wide" aria-label="Campus drive approvals">
    <div className="role-section-title"><h2>Campus drive approvals</h2>
      <label className="student-form-field"><span>Show</span><select value={state} onChange={(event) => { setState(event.target.value as CampusDriveState | ''); setOpen(null); }}>
        {filters.map((value) => <option key={value || 'all'} value={value}>{value ? campusDriveStateLabels[value] : 'All drives'}</option>)}
      </select></label></div>
    <p>Employers ask to run a job as a campus drive. It reaches your students only once you approve it.{page && !page.canDecide ? ' You can see drives; deciding them needs a placement role for the whole college.' : ''}</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadError ? <p className="form-error" role="alert">{loadError}</p>
      : !page ? <p role="status">Loading campus drives…</p>
        : !drives.length ? <p>{state ? `No drives are ${campusDriveStateLabels[state].toLowerCase()}.` : 'No employer has asked for a campus drive yet.'}</p>
          : <>
            {!state && waiting ? <p className="hiring-tag warn">{waiting} request{waiting === 1 ? '' : 's'} awaiting your decision.</p> : null}
            <div className="role-record-table-wrap"><table className="role-record-table">
              <thead><tr><th>Employer</th><th>Job</th><th>State</th><th>Proposed</th><th>Confirmed</th><th>Employer's note</th><th>Action</th></tr></thead>
              <tbody>{drives.map((drive) => <tr key={drive.id}>
                <td>{drive.employerName}{drive.employerInGoodStanding ? null : <span className="hiring-tag warn">Not currently verified</span>}</td>
                <td>{drive.opportunityTitle ?? 'Untitled'}<span className="hiring-meta"> · closes {formatWhen(drive.applicationDeadline)}</span></td>
                <td><span className="hiring-tag">{campusDriveStateLabels[drive.state]}</span>
                  {drive.offerHoldersEligible ? <span className="hiring-meta"> · open to offer holders</span> : null}</td>
                <td>{formatWhen(drive.proposedStartAt)}{drive.venueMode ? ` · ${venueModeLabels[drive.venueMode]}` : ''}</td>
                <td>{formatWhen(drive.scheduledStartAt)}</td>
                <td>{drive.employerNote ?? 'NA'}</td>
                <td><div className="hiring-actions">
                  {drive.availableActions.filter((action): action is CollegeAction => action !== 'RESUBMIT').map((action) => <button key={action} type="button"
                    className={action === 'APPROVE' ? undefined : 'secondary'} disabled={busy} onClick={() => { setActing({ drive, action }); setError(''); }}>{actionLabels[action]}</button>)}
                  <button type="button" className="secondary" onClick={() => { void toggleDetail(drive); }}>{open?.driveId === drive.id ? 'Hide details' : 'Details'}</button>
                </div></td>
              </tr>)}</tbody>
            </table></div>
            {page.nextCursor ? <button type="button" className="secondary" onClick={() => { void loadMore(); }}>Show more</button> : null}
          </>}

    {acting ? <form className="role-management-form" aria-label={`${actionLabels[acting.action]} campus drive`} onSubmit={(event) => { void confirm(event); }}>
      <h3>{actionLabels[acting.action]}: {acting.drive.employerName} · {acting.drive.opportunityTitle ?? 'Untitled'}</h3>
      <p>{actionExplanations[acting.action]}</p>
      {actionReasons[acting.action] ? <label><span>Reason</span><select name="reasonCode" defaultValue="">
        <option value="">Choose a reason</option>
        {actionReasons[acting.action]!.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select></label> : null}
      {acting.action === 'APPROVE' || acting.action === 'SCHEDULE' ? <>
        <label><span>{acting.action === 'APPROVE' ? 'Confirmed start (optional)' : 'Confirmed start'}</span><input name="scheduledStartAt" type="datetime-local" /></label>
        <label><span>Confirmed end (optional)</span><input name="scheduledEndAt" type="datetime-local" /></label>
        <label><span>Where</span><select name="venueMode" defaultValue={acting.drive.venueMode ?? ''}>
          <option value="">As proposed</option>
          {(Object.keys(venueModeLabels) as VenueMode[]).map((mode) => <option key={mode} value={mode}>{venueModeLabels[mode]}</option>)}
        </select></label>
        <label className="hiring-checkbox"><input type="checkbox" name="offerHoldersEligible" defaultChecked={acting.drive.offerHoldersEligible} />
          <span>Open to students who already hold an offer (an exception to your one-offer policy, if that policy allows exceptions)</span></label>
      </> : null}
      {acting.action !== 'SCHEDULE' ? <label><span>Note to the employer (optional)</span><textarea name="note" maxLength={1000} /></label> : null}
      <div className="hiring-actions">
        <button type="submit" disabled={busy}>{`Confirm: ${actionLabels[acting.action].toLowerCase()}`}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setActing(null)}>Back</button>
      </div>
    </form> : null}

    {open ? <div aria-label="Drive details">
      <h3>History</h3>
      <ol className="hiring-stages">{open.history.map((row, index) => <li key={index}>{formatWhen(row.at)} — {row.actorSide === 'EMPLOYER' ? 'Employer' : 'Your college'}: {campusDriveStateLabels[row.toState]}
        {row.reasonCode ? ` (${reasonLabel(row.reasonCode)})` : ''}{row.note ? ` — ${row.note}` : ''}</li>)}</ol>
      {open.resultsError ? <p className="form-error" role="alert">{open.resultsError}</p> : null}
      {open.results ? <DriveResults results={open.results} /> : null}
    </div> : null}
  </section>;
}

function DriveResults({ results }: { readonly results: CampusDriveResultsDto }): React.ReactElement {
  return <div aria-label="Drive results">
    <h3>Results</h3>
    {results.counts
      ? <p>Applied through the drive: {suppressedCountLabel(results.counts.applied)} · Offered: {suppressedCountLabel(results.counts.offered)} · Selected: {suppressedCountLabel(results.counts.selected)}</p>
      : <p className="hiring-meta">Counts appear once the drive is complete.</p>}
    <p className="hiring-meta">Named below only where the student chose to share that application with the college. Any group under five reads &lt;5. Offer pay is never shown.</p>
    {results.named.length
      ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Shared drive applications">
        <thead><tr><th>Student</th><th>College ID</th><th>Stage</th><th>Offer</th></tr></thead>
        <tbody>{results.named.map((row, index) => <tr key={index}>
          <td>{row.fullName}</td><td>{row.institutionStudentId ?? 'NA'}</td>
          <td>{applicationStageLabels[row.applicationState as keyof typeof applicationStageLabels] ?? row.applicationState}</td>
          <td>{row.offerState ? offerResponseLabels[row.offerState as keyof typeof offerResponseLabels] ?? row.offerState : 'NA'}</td>
        </tr>)}</tbody>
      </table></div>
      : <p>No student has shared an application from this drive with the college.</p>}
  </div>;
}

/** The college's placement policies: what is in force, set one, retire one (with a reason). */
export function PlacementPoliciesSection({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<{ policies: readonly PlacementPolicyDto[]; canManage: boolean } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retiring, setRetiring] = useState<PlacementPolicyDto | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listPlacementPolicies(token, institutionId, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setData({ policies: response.policies ?? [], canManage: response.canManage === true }); setLoadError(''); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Placement policies could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);

  if (!token) return <p role="status">Sign in to see placement policies.</p>;

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const note = String(form.get('note') ?? '').trim();
    setBusy(true); setError(''); setNotice('');
    try {
      await setPlacementPolicy(token, institutionId, { policyType: 'ONE_OFFER_PER_STUDENT', allowDriveExceptions: form.get('allowDriveExceptions') === 'on', ...(note ? { note } : {}) });
      setNotice('One offer per student is now in force for applications through your campus drives.');
      setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The policy could not be set.')); } finally { setBusy(false); }
  }

  async function retire(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!retiring || !token) return;
    const reason = String(new FormData(event.currentTarget).get('reasonCode') ?? '');
    if (!reason) { setError('Choose a reason.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await retirePlacementPolicy(token, institutionId, retiring.id, reason as typeof placementPolicyRetireReasons[number]);
      setNotice('Policy retired. It no longer applies to new drive applications.');
      setRetiring(null); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The policy could not be retired.')); } finally { setBusy(false); }
  }

  const active = (data ? data.policies : []).find((policy) => policy.state === 'ACTIVE') ?? null;
  return <section className="role-card role-wide" aria-label="Placement policies">
    <h2>Placement policies</h2>
    <p>Your rules for students applying through your campus drives. They never apply to jobs a student finds outside your drives.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : !data ? <p role="status">Loading placement policies…</p> : <>
      {active
        ? <div>
          <p><strong>One offer per student</strong> — in force since {formatWhen(active.effectiveFrom)}{active.effectiveTo ? ` until ${formatWhen(active.effectiveTo)}` : ''}.
            {active.allowDriveExceptions ? ' Drives you mark as open to offer holders are exempt.' : ' No exceptions.'}</p>
          <p className="hiring-meta">A student who has accepted an offer cannot apply through your drives, and is told why before they try.{active.note ? ` Your note to students: "${active.note}"` : ''}</p>
          {data.canManage ? <button type="button" className="secondary" disabled={busy} onClick={() => setRetiring(active)}>Retire this policy</button> : null}
        </div>
        : <p>No placement policy is in force. Students may apply through your drives whatever offers they hold.</p>}
      {retiring ? <form className="role-management-form" aria-label="Retire placement policy" onSubmit={(event) => { void retire(event); }}>
        <label><span>Reason</span><select name="reasonCode" defaultValue="">
          <option value="">Choose a reason</option>
          {placementPolicyRetireReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
        </select></label>
        <div className="hiring-actions"><button type="submit" disabled={busy}>Confirm: retire</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setRetiring(null)}>Back</button></div>
      </form> : null}
      {!active && data.canManage ? <form className="role-management-form" aria-label="Set placement policy" onSubmit={(event) => { void create(event); }}>
        <p><strong>One offer per student</strong>: a student who has accepted an offer cannot apply through your campus drives.</p>
        <label className="hiring-checkbox"><input type="checkbox" name="allowDriveExceptions" /><span>Allow exceptions for drives I mark as open to offer holders</span></label>
        <label><span>Note shown to students (optional)</span><textarea name="note" maxLength={500} /></label>
        <button type="submit" disabled={busy}>Put this policy in force</button>
      </form> : null}
      {!data.canManage ? <p className="hiring-meta">Setting policies needs a placement role for the whole college.</p> : null}
      {data.policies.some((policy) => policy.state === 'RETIRED') ? <details><summary>Earlier policies</summary><ul className="role-check-list">
        {data.policies.filter((policy) => policy.state === 'RETIRED').map((policy) => <li key={policy.id}>One offer per student · {formatWhen(policy.effectiveFrom)} to {formatWhen(policy.retiredAt)} · {reasonLabel(policy.retireReasonCode)}</li>)}
      </ul></details> : null}
    </>}
  </section>;
}
