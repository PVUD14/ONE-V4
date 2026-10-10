/**
 * ONE · Role portal — Institution — placement-office nominations for one campus drive (INST-14).
 *
 * Shown in a drive's details on the existing campus drive section (the placement officer's
 * Dashboard, the admin's Placement page); no navigation item is added (HG-3). The placement office
 * builds the eligible list — every current student in its scope with the job's eligibility outcome
 * only (eligible, does not meet a rule, cannot confirm), never figures and never anything from
 * applications a student has not shared — and nominates eligible students with a reason and an
 * optional note to them. Each student decides; nothing about them reaches the employer unless they
 * opt in. The college sees "opted in" or "not opted in" (a decline reads the same as no answer),
 * and a summary in which any group under five reads <5.
 *
 * The server decides who may nominate (`canNominate`) and who may be withdrawn (`canCancel`).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { getProtectedAccessToken, suppressedCountLabel } from '../api.js';
import { reasonLabel } from '../api/campusDrives.js';
import {
  cancelNomination,
  collegeResponseLabels,
  listDriveNominations,
  listNominationCandidates,
  nominateStudents,
  nominationCancelReasons,
  nominationEligibilityLabels,
  nominationReasons,
  type CollegeNominationDto,
  type CollegeNominationsDto,
  type NominationCandidateDto,
} from '../api/nominations.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

const skippedWords: Readonly<Record<string, string>> = {
  ALREADY_NOMINATED: 'already nominated', NOT_ELIGIBLE: 'not eligible', NOT_IN_SCOPE: 'not a current student in your scope',
};

export function DriveNominationsPanel({ institutionId, driveId }: { readonly institutionId: string; readonly driveId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<CollegeNominationsDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [picking, setPicking] = useState<{ readonly candidates: readonly NominationCandidateDto[]; readonly nextCursor: string | null } | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [cancelling, setCancelling] = useState<CollegeNominationDto | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listDriveNominations(token, institutionId, driveId, undefined, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setData(response); setLoadError(''); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Nominations could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId, driveId, reload]);

  if (!token) return <p role="status">Sign in to see nominations.</p>;

  async function loadMore(): Promise<void> {
    if (!token || !data?.nextCursor) return;
    try {
      const more = await listDriveNominations(token, institutionId, driveId, data.nextCursor);
      setData({ ...more, nominations: [...data.nominations, ...(more.nominations ?? [])] });
    } catch (cause) { setError(formatApiError(cause, 'More nominations could not be loaded.')); }
  }

  async function openPicker(cursor?: string): Promise<void> {
    if (!token) return;
    setError('');
    try {
      const page = await listNominationCandidates(token, institutionId, driveId, cursor);
      setPicking({ candidates: [...(cursor && picking ? picking.candidates : []), ...(page.candidates ?? [])], nextCursor: page.nextCursor ?? null });
    } catch (cause) { setError(formatApiError(cause, 'The eligible list could not be loaded.')); }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const reasonCode = String(form.get('reasonCode') ?? '');
    const note = String(form.get('note') ?? '').trim();
    if (!chosen.size) { setError('Choose at least one eligible student.'); return; }
    if (!reasonCode) { setError('Choose a reason.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await nominateStudents(token, institutionId, driveId, { studentUserIds: [...chosen], reasonCode, ...(note ? { note } : {}) });
      const skipped = (result.skipped ?? []).map((row) => skippedWords[row.code] ?? 'skipped');
      setNotice(`${result.created.length} student${result.created.length === 1 ? '' : 's'} nominated. Each decides whether to opt in; the employer sees only those who do.`
        + (skipped.length ? ` ${skipped.length} skipped (${[...new Set(skipped)].join(', ')}).` : ''));
      setPicking(null); setChosen(new Set()); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The nominations could not be made.')); } finally { setBusy(false); }
  }

  async function confirmCancel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !cancelling) return;
    const reasonCode = String(new FormData(event.currentTarget).get('reasonCode') ?? '');
    if (!reasonCode) { setError('Choose a reason.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await cancelNomination(token, institutionId, driveId, cancelling.id, cancelling.revision, reasonCode);
      setNotice(`The nomination of ${cancelling.studentName} was withdrawn.`);
      setCancelling(null); setReload((value) => value + 1);
    } catch (cause) { setError(formatApiError(cause, 'The nomination could not be withdrawn.')); } finally { setBusy(false); }
  }

  function toggle(studentUserId: string): void {
    const next = new Set(chosen);
    if (next.has(studentUserId)) next.delete(studentUserId); else next.add(studentUserId);
    setChosen(next);
  }

  const selectable = (picking ? picking.candidates : []).filter((row) => row.eligibility === 'ELIGIBLE' && !row.nomination);
  return <div aria-label="Nominations">
    <h3>Nominations</h3>
    <p className="hiring-meta">Put eligible students forward for this drive. Nothing about a student reaches the employer unless they opt in; a student who declines is not singled out — you see only whether they opted in.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : !data ? <p role="status">Loading nominations…</p> : <>
      <p>Nominated: {suppressedCountLabel(data.summary.nominated)} · Opted in: {suppressedCountLabel(data.summary.optedIn)} · Not opted in: {suppressedCountLabel(data.summary.notOptedIn)}
        <span className="hiring-meta"> · any group under five reads &lt;5</span></p>
      {data.nominations.length
        ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Nominated students">
          <thead><tr><th>Student</th><th>College ID</th><th>Response</th><th>Reason</th><th>Nominated</th><th>Action</th></tr></thead>
          <tbody>{data.nominations.map((row) => <tr key={row.id}>
            <td>{row.studentName}</td><td>{row.institutionStudentId ?? 'NA'}</td>
            <td><span className="hiring-tag">{collegeResponseLabels[row.response]}</span>{row.cancelReasonCode ? <span className="hiring-meta"> · {reasonLabel(row.cancelReasonCode)}</span> : null}</td>
            <td>{reasonLabel(row.reasonCode)}</td>
            <td>{row.nominatedAt ? formatDate(row.nominatedAt) : 'NA'}</td>
            <td>{row.canCancel ? <button type="button" className="secondary" disabled={busy} onClick={() => { setCancelling(row); setError(''); }}>Withdraw nomination</button> : <span className="hiring-meta">—</span>}</td>
          </tr>)}</tbody>
        </table></div>
        : <p>No student has been nominated for this drive.</p>}
      {data.nextCursor ? <button type="button" className="secondary" onClick={() => { void loadMore(); }}>Show more</button> : null}
      {data.canNominate && !picking ? <button type="button" disabled={busy} onClick={() => { void openPicker(); }}>Nominate students</button> : null}
      {!data.canNominate && data.drive.live ? <p className="hiring-meta">Nominating needs a placement role for the whole college.</p> : null}
      {!data.drive.live ? <p className="hiring-meta">This drive is not open for applications, so no one can be nominated for it.</p> : null}
    </>}

    {cancelling ? <form className="role-management-form" aria-label="Withdraw nomination" onSubmit={(event) => { void confirmCancel(event); }}>
      <p>Withdraw the nomination of {cancelling.studentName}? They are told it was withdrawn; nothing was shared with the employer.</p>
      <label><span>Reason</span><select name="reasonCode" defaultValue="">
        <option value="">Choose a reason</option>
        {nominationCancelReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select></label>
      <div className="hiring-actions"><button type="submit" disabled={busy}>Confirm: withdraw</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setCancelling(null)}>Back</button></div>
    </form> : null}

    {picking ? <form className="role-management-form" aria-label="Nominate students" onSubmit={(event) => { void submit(event); }}>
      <h3>Eligible list</h3>
      <p className="hiring-meta">Each student's result against this job's eligibility rules, from their academic records. Only eligible students can be nominated. Whether a student has applied or holds an offer is not shown here: that is theirs to share.</p>
      {picking.candidates.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Eligible list">
        <thead><tr><th>Choose</th><th>Student</th><th>College ID</th><th>Department</th><th>Batch</th><th>Eligibility</th><th>Nomination</th></tr></thead>
        <tbody>{picking.candidates.map((row) => {
          const canChoose = row.eligibility === 'ELIGIBLE' && !row.nomination;
          return <tr key={row.studentUserId}>
            <td><input type="checkbox" aria-label={`Nominate ${row.fullName}`} disabled={!canChoose || busy} checked={chosen.has(row.studentUserId)} onChange={() => toggle(row.studentUserId)} /></td>
            <td>{row.fullName}</td><td>{row.institutionStudentId ?? 'NA'}</td><td>{row.department ?? 'NA'}</td><td>{row.batch ?? 'NA'}</td>
            <td>{nominationEligibilityLabels[row.eligibility]}</td>
            <td>{row.nomination ? collegeResponseLabels[row.nomination.response] : '—'}</td>
          </tr>;
        })}</tbody>
      </table></div> : <p>No current students are in your scope.</p>}
      {picking.nextCursor ? <button type="button" className="secondary" onClick={() => { void openPicker(picking.nextCursor ?? undefined); }}>Show more students</button> : null}
      <div className="hiring-actions">
        <button type="button" className="secondary" disabled={busy || !selectable.length} onClick={() => setChosen(new Set(selectable.map((row) => row.studentUserId)))}>Choose every eligible student shown</button>
      </div>
      <label><span>Reason</span><select name="reasonCode" defaultValue="">
        <option value="">Choose a reason</option>
        {nominationReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select></label>
      <label><span>Note to the students (optional)</span><textarea name="note" maxLength={500} /></label>
      <div className="hiring-actions">
        <button type="submit" disabled={busy || !chosen.size}>{`Nominate ${chosen.size} student${chosen.size === 1 ? '' : 's'}`}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setPicking(null); setChosen(new Set()); }}>Back</button>
      </div>
    </form> : null}
  </div>;
}
