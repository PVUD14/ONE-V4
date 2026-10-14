/**
 * ONE · Employer portal — campus drives for one job (EMP-11, ADR-038).
 *
 * A section of the existing Opportunity Detail page (no navigation item is added, HG-3). The
 * employer asks a college's placement office to run this job as a campus drive, sees the
 * college's decision, reasons and confirmed schedule, answers a change request, and cancels or
 * completes the drive. Only the college can approve: nothing here can make a drive live.
 * The server decides which actions exist (availableActions); this page only offers them.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  campusDriveEmployerCancelReasons,
  campusDriveStateLabels,
  getCampusDriveHistory,
  listCampusDriveInstitutions,
  listEmployerCampusDrives,
  moveEmployerCampusDrive,
  reasonLabel,
  requestCampusDrive,
  venueModeLabels,
  type CampusDriveDto,
  type CampusDriveHistoryDto,
  type VenueMode,
} from '../api/campusDrives.js';
import { formatApiError } from './shared.js';
import { formatDateTime } from '../dates.js';

/** A time as local words; with no time, the given honest phrase ("Not set", "Not yet"), never "NA". */
function formatWhen(value: string | null | undefined, missing = 'Not recorded'): string {
  if (!value) return missing;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? missing : formatDateTime(date);
}
function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
const stateTone: Readonly<Record<string, string>> = {
  REQUESTED: 'state-applied', CHANGES_REQUESTED: 'state-screening', APPROVED: 'state-shortlisted', SCHEDULED: 'state-interview',
  REJECTED: 'state-rejected', COMPLETED: 'state-hired', CANCELLED: 'state-withdrawn',
};

export function EmployerCampusDrivesSection({ employerId, opportunityId, token, lifecycleState }: {
  readonly employerId: string; readonly opportunityId: string; readonly token: string; readonly lifecycleState: string;
}): React.ReactElement {
  const [drives, setDrives] = useState<readonly CampusDriveDto[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [query, setQuery] = useState('');
  const [colleges, setColleges] = useState<readonly { readonly id: string; readonly name: string; readonly city: string | null }[]>([]);
  const [collegeId, setCollegeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<{ readonly drive: CampusDriveDto; readonly action: 'CANCEL' | 'COMPLETE' | 'RESUBMIT' } | null>(null);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<{ readonly driveId: string; readonly rows: readonly CampusDriveHistoryDto[] } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listEmployerCampusDrives(token, employerId, opportunityId, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setDrives(response.drives ?? []); setLoadError(''); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Campus drives could not be loaded.')); });
    return () => controller.abort();
  }, [token, employerId, opportunityId, reload]);

  async function searchColleges(): Promise<void> {
    setError('');
    try {
      const response = await listCampusDriveInstitutions(token, employerId, query);
      setColleges(response.institutions);
      setCollegeId(response.institutions[0]?.id ?? '');
      if (!response.institutions.length) setError('No verified college in ONE matches that name.');
    } catch (cause) { setError(formatApiError(cause, 'Colleges could not be searched.')); }
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!collegeId) { setError('Choose a college.'); return; }
    const form = new FormData(event.currentTarget);
    const start = localToIso(String(form.get('proposedStartAt') ?? ''));
    const end = localToIso(String(form.get('proposedEndAt') ?? ''));
    const venue = String(form.get('venueMode') ?? '');
    const note = String(form.get('note') ?? '').trim();
    setBusy(true); setError(''); setNotice('');
    try {
      await requestCampusDrive(token, employerId, opportunityId, {
        institutionId: collegeId, ...(start ? { proposedStartAt: start } : {}), ...(end ? { proposedEndAt: end } : {}),
        ...(venue ? { venueMode: venue as VenueMode } : {}), ...(note ? { note } : {}),
      });
      setNotice('Request sent. The college\'s placement office decides; students there see this job only once they approve.');
      setRequesting(false); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The drive could not be requested.')); } finally { setBusy(false); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!acting) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { revision: acting.drive.revision };
    if (acting.action === 'CANCEL') {
      if (!reason) { setError('Choose a reason.'); return; }
      body.reasonCode = reason;
    }
    if (acting.action === 'RESUBMIT') {
      const start = localToIso(String(form.get('proposedStartAt') ?? ''));
      const end = localToIso(String(form.get('proposedEndAt') ?? ''));
      const venue = String(form.get('venueMode') ?? '');
      if (start) body.proposedStartAt = start;
      if (end) body.proposedEndAt = end;
      if (venue) body.venueMode = venue;
    }
    const note = String(form.get('note') ?? '').trim();
    if (note) body.note = note;
    setBusy(true); setError(''); setNotice('');
    try {
      const path = acting.action === 'CANCEL' ? 'cancel' : acting.action === 'COMPLETE' ? 'complete' : 'resubmit';
      const result = await moveEmployerCampusDrive(token, employerId, acting.drive.id, path, body);
      setNotice(`Drive at ${result.drive.institutionName}: ${campusDriveStateLabels[result.drive.state].toLowerCase()}.`);
      setActing(null); setReason(''); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'That change could not be made.')); } finally { setBusy(false); }
  }

  async function showHistory(driveId: string): Promise<void> {
    if (history?.driveId === driveId) { setHistory(null); return; }
    try { setHistory({ driveId, rows: (await getCampusDriveHistory(token, { employerId }, driveId)).history }); } catch (cause) { setError(formatApiError(cause, 'The history could not be loaded.')); }
  }

  const canRequest = ['DRAFT', 'PUBLISHED', 'PAUSED'].includes(lifecycleState);
  return <section className="role-card role-wide" aria-label="Campus drives">
    <div className="role-section-title"><h2>Campus drives</h2>
      {canRequest ? <button type="button" className="secondary" disabled={busy} onClick={() => { setRequesting((value) => !value); setError(''); }}>{requesting ? 'Cancel request' : 'Request a campus drive'}</button> : null}</div>
    <p>A college's placement office approves a drive before its students can see this job. Their placement rules, such as one offer per student, apply to everyone who applies through it.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    {requesting ? <form className="role-management-form" aria-label="Request a campus drive" onSubmit={(event) => { void submitRequest(event); }}>
      <label><span>Find a college</span><input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder="College name" /></label>
      <button type="button" className="secondary" disabled={busy} onClick={() => { void searchColleges(); }}>Search</button>
      {colleges.length ? <label><span>College</span><select value={collegeId} onChange={(event) => setCollegeId(event.target.value)}>
        {colleges.map((college) => <option key={college.id} value={college.id}>{college.name}{college.city ? ` · ${college.city}` : ''}</option>)}
      </select></label> : null}
      <label><span>Proposed start (optional)</span><input name="proposedStartAt" type="datetime-local" /></label>
      <label><span>Proposed end (optional)</span><input name="proposedEndAt" type="datetime-local" /></label>
      <label><span>Where</span><select name="venueMode" defaultValue="">
        <option value="">Not decided</option>
        {(Object.keys(venueModeLabels) as VenueMode[]).map((mode) => <option key={mode} value={mode}>{venueModeLabels[mode]}</option>)}
      </select></label>
      <label><span>Note to the placement office (optional)</span><textarea name="note" maxLength={1000} /></label>
      <button type="submit" disabled={busy || !collegeId}>Send request</button>
    </form> : null}

    {loadError ? <p className="form-error" role="alert">{loadError}</p>
      : !drives ? <p role="status">Loading campus drives…</p>
        : !drives.length ? <p>No campus drives for this job yet.</p>
          : <div className="role-record-table-wrap"><table className="role-record-table">
            <thead><tr><th>College</th><th>State</th><th>Proposed</th><th>Confirmed</th><th>College's note</th><th>Applications</th><th>Action</th></tr></thead>
            <tbody>{drives.map((drive) => <tr key={drive.id}>
              <td>{drive.institutionName}</td>
              <td><span className={`hiring-state ${stateTone[drive.state] ?? ''}`}>{campusDriveStateLabels[drive.state]}</span>
                {drive.state === 'REQUESTED' && lifecycleState === 'PUBLISHED' ? <span className="hiring-meta"> Not visible to the college's students until approved.</span> : null}
                {drive.state === 'APPROVED' || drive.state === 'SCHEDULED' ? (lifecycleState === 'PUBLISHED'
                  ? <span className="hiring-meta"> Live for the college's students.</span>
                  : <span className="hiring-meta"> Publish the job for students to see it.</span>) : null}</td>
              <td>{formatWhen(drive.proposedStartAt, 'Not set')}{drive.venueMode ? ` · ${venueModeLabels[drive.venueMode]}` : ''}</td>
              <td>{formatWhen(drive.scheduledStartAt, 'Not yet')}</td>
              <td>{drive.decision ? `${drive.decision.reasonCode ? `${reasonLabel(drive.decision.reasonCode)}. ` : ''}${drive.decision.note ?? ''}` || 'None' : 'None'}
                {drive.closeReasonCode ? <span className="hiring-meta"> Cancelled: {reasonLabel(drive.closeReasonCode)}</span> : null}</td>
              <td>{drive.applicationCount ?? 0}</td>
              <td><div className="hiring-actions">
                {drive.availableActions.includes('RESUBMIT') ? <button type="button" disabled={busy} onClick={() => { setActing({ drive, action: 'RESUBMIT' }); setError(''); }}>Send changes</button> : null}
                {drive.availableActions.includes('COMPLETE') ? <button type="button" className="secondary" disabled={busy} onClick={() => { setActing({ drive, action: 'COMPLETE' }); setError(''); }}>Mark complete</button> : null}
                {drive.availableActions.includes('CANCEL') ? <button type="button" className="secondary" disabled={busy} onClick={() => { setActing({ drive, action: 'CANCEL' }); setReason(''); setError(''); }}>Cancel drive</button> : null}
                <button type="button" className="secondary" onClick={() => { void showHistory(drive.id); }}>{history?.driveId === drive.id ? 'Hide history' : 'History'}</button>
              </div></td>
            </tr>)}</tbody>
          </table></div>}

    {acting ? <form className="role-management-form" aria-label={`${acting.action === 'CANCEL' ? 'Cancel' : acting.action === 'COMPLETE' ? 'Complete' : 'Resubmit'} campus drive`} onSubmit={(event) => { void confirm(event); }}>
      <p>{acting.action === 'CANCEL' ? `Cancel the drive at ${acting.drive.institutionName}. Its students stop seeing this job through it; applications already made carry on.`
        : acting.action === 'COMPLETE' ? `Mark the drive at ${acting.drive.institutionName} complete. The college then sees its results.`
          : `Send revised details to ${acting.drive.institutionName}'s placement office.`}</p>
      {acting.action === 'CANCEL' ? <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">Choose a reason</option>
        {campusDriveEmployerCancelReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select></label> : null}
      {acting.action === 'RESUBMIT' ? <>
        <label><span>Proposed start</span><input name="proposedStartAt" type="datetime-local" /></label>
        <label><span>Proposed end</span><input name="proposedEndAt" type="datetime-local" /></label>
        <label><span>Where</span><select name="venueMode" defaultValue={acting.drive.venueMode ?? ''}>
          <option value="">Not decided</option>
          {(Object.keys(venueModeLabels) as VenueMode[]).map((mode) => <option key={mode} value={mode}>{venueModeLabels[mode]}</option>)}
        </select></label>
      </> : null}
      <label><span>Note (optional)</span><textarea name="note" maxLength={1000} /></label>
      <div className="hiring-actions">
        <button type="submit" disabled={busy}>Confirm</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setActing(null)}>Back</button>
      </div>
    </form> : null}

    {history ? <div aria-label="Drive history"><h3>History</h3><ol className="hiring-stages">
      {history.rows.map((row, index) => <li key={index}>{formatWhen(row.at)} — {row.actorSide === 'EMPLOYER' ? 'You' : 'The college'}: {campusDriveStateLabels[row.toState]}
        {row.reasonCode ? ` (${reasonLabel(row.reasonCode)})` : ''}{row.note ? ` — ${row.note}` : ''}</li>)}
    </ol></div> : null}
  </section>;
}
