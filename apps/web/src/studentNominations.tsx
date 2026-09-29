/**
 * ONE · Student — placement-office nominations (INST-14).
 *
 * The student's college may put them forward for one of its campus drives. This card, on the
 * student's existing Applications page (no navigation change), shows each nomination: who nominated
 * them (the college and the nominator's role), for which employer and job, why, the college's note,
 * and — before they answer — exactly what opting in would share with the employer (the same
 * preview as applying, EMP-07). Opting in is applying, with that reviewed snapshot; declining is
 * recorded and never shown to the employer, and the college sees only "not opted in". Withdrawing
 * the application later withdraws the consent. Nothing is invented: a missing date reads NA.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { ApiRequestError } from './api.js';
import { previewApplication, type ApplicationPreviewDto, type SnapshotChoicesInput } from './api/hiring.js';
import { venueModeLabels } from './api/campusDrives.js';
import { acceptNomination, declineNomination, listMyNominations, studentNominationLabels, type StudentNominationDto } from './api/nominations.js';
import { SnapshotSummary } from './applicationSnapshotView.js';

const reasonWords: Readonly<Record<string, string>> = {
  MEETS_ELIGIBILITY: 'You meet the role\'s eligibility rules',
  PLACEMENT_OFFICE_SHORTLIST: 'The placement office shortlisted you',
  STUDENT_EXPRESSED_INTEREST: 'You told the placement office you were interested',
};

const nominationErrors: Readonly<Record<string, string>> = {
  NOMINATION_REVIEW_REQUIRED: 'Review what would be shared before opting in.',
  NOMINATION_NOT_OPEN: 'This nomination can no longer be answered.',
  NOMINATION_CLOSED: 'The campus drive for this nomination has ended.',
  ALREADY_APPLIED: 'You have already applied to this role.',
  PLACEMENT_POLICY_ONE_OFFER: 'Your college allows one accepted offer per student, and you already hold one, so you cannot apply through its campus drive.',
  SNAPSHOT_CHANGED: 'Something you would share changed after you reviewed it. Check it again, then opt in.',
  ELIGIBILITY_NOT_MET: 'You do not meet a rule this employer requires. Open the role under Opportunities to see which.',
  ELIGIBILITY_UNKNOWN: 'ONE cannot confirm a rule this employer requires yet. Open the role under Opportunities to see what is missing.',
  RESUME_NOT_AVAILABLE: 'That résumé cannot be attached. Choose another, or opt in without one.',
};

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code && nominationErrors[error.code]) return nominationErrors[error.code]!;
  return fallback;
}
function formatWhen(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function StudentNominationsCard({ onChanged }: { readonly onChanged?: () => void }): React.ReactElement | null {
  const [nominations, setNominations] = useState<readonly StudentNominationDto[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ readonly nomination: StudentNominationDto; readonly preview: ApplicationPreviewDto | null; readonly choices: SnapshotChoicesInput; readonly previewError: string } | null>(null);
  const [share, setShare] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const controller = new AbortController();
    listMyNominations(token, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setNominations(response.nominations ?? []); setLoadError(''); }
    }).catch(() => { if (!controller.signal.aborted) setLoadError('Your nominations could not be loaded.'); });
    return () => controller.abort();
  }, [reload]);

  // No nominations at all: the card stays out of the way of the applications list.
  if (!loadError && (!nominations || nominations.length === 0)) return null;

  async function review(nomination: StudentNominationDto, choices: SnapshotChoicesInput = {}): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setShare(false);
    setOpen({ nomination, preview: null, choices, previewError: '' });
    try {
      const response = await previewApplication(token, nomination.opportunity.id, choices);
      setOpen({ nomination, preview: response.preview, choices, previewError: '' });
    } catch (error) {
      setOpen({ nomination, preview: null, choices, previewError: messageFor(error, 'What you would share could not be shown right now.') });
    }
  }

  async function optIn(): Promise<void> {
    const token = getAccessToken();
    if (!token || !open?.preview) return;
    setBusy(true); setStatus('');
    try {
      await acceptNomination(token, open.nomination.id, { institutionVisibilityGranted: share, choices: open.choices, reviewedSnapshotHash: open.preview.snapshotHash });
      setStatus(`You opted in. Your application to ${open.nomination.opportunity.employerName} is under Your applications below.`);
      setOpen(null); setReload((value) => value + 1); onChanged?.();
    } catch (error) {
      setStatus(messageFor(error, 'Your answer could not be saved.'));
      if (error instanceof ApiRequestError && error.code === 'SNAPSHOT_CHANGED') await review(open.nomination, open.choices);
    } finally { setBusy(false); }
  }

  async function decline(nomination: StudentNominationDto): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true); setStatus('');
    try {
      await declineNomination(token, nomination.id);
      setStatus(`You declined. ${nomination.opportunity.employerName} is not told, and your college sees only that you did not opt in. You can still opt in while the drive is open.`);
      setOpen(null); setReload((value) => value + 1);
    } catch (error) {
      setStatus(messageFor(error, 'Your answer could not be saved.'));
    } finally { setBusy(false); }
  }

  return <section className="card wide-card" aria-label="Nominations from your college">
    <h2>Nominations from your college</h2>
    <p>Your college's placement office can put you forward for a campus drive. Nothing about you is shared with the employer unless you opt in, and you can decline without any effect on your standing.</p>
    {status ? <p role="status">{status}</p> : null}
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : <ul className="hiring-list">
      {(nominations ?? []).map((nomination) => <li key={nomination.id} className="hiring-list-item">
        <div>
          <h3>{nomination.opportunity.title ?? 'Untitled role'} · {nomination.opportunity.employerName}</h3>
          <p className="hiring-meta">Nominated by {nomination.nominatedBy.label}, {nomination.institutionName} · {formatWhen(nomination.nominatedAt)}</p>
          <p className="hiring-meta">Why: {reasonWords[nomination.reasonCode] ?? 'Chosen by your placement office'}{nomination.note ? ` · "${nomination.note}"` : ''}</p>
          <p className="hiring-meta">Drive: {formatWhen(nomination.drive.scheduledStartAt)}{nomination.drive.venueMode ? ` · ${venueModeLabels[nomination.drive.venueMode]}` : ''} · applications close {formatWhen(nomination.opportunity.applicationDeadline)}</p>
          {nomination.blocksYou ? <p className="hiring-tag warn">Your college's one-offer policy stops you applying through this drive, because you already hold an accepted offer.</p> : null}
          {nomination.alreadyApplied ? <p className="hiring-tag">You have already applied to this role yourself.</p> : null}
        </div>
        <div className="hiring-actions">
          <span className="hiring-tag">{studentNominationLabels[nomination.state]}</span>
          {nomination.canRespond && !nomination.blocksYou && !nomination.alreadyApplied
            ? <button type="button" disabled={busy} onClick={() => { void review(nomination); }}>Review and decide</button> : null}
          {nomination.canRespond && nomination.state === 'INVITED'
            ? <button type="button" className="secondary" disabled={busy} onClick={() => { void decline(nomination); }}>Decline</button> : null}
        </div>
      </li>)}
    </ul>}

    {open ? <div className="role-management-form" aria-label="Opt in to nomination">
      <h3>What {open.nomination.opportunity.employerName} would see if you opt in</h3>
      <p className="hiring-consent-note">Opting in applies to this role for you, sharing this copy of your profile with {open.nomination.opportunity.employerName} for this role only. It never includes readiness, marks or your photo. Your college sees that you opted in; it follows your application only if you also share it below. You can withdraw at any time from Your applications, which ends the employer's access.</p>
      {open.previewError ? <p className="form-error" role="alert">{open.previewError}</p> : null}
      {!open.preview && !open.previewError ? <p role="status">Preparing what the employer will see…</p> : null}
      {open.preview ? <>
        <SnapshotSummary snapshot={open.preview.snapshot} audience="student" />
        <label className="student-form-field"><span>Résumé to attach</span>
          <select value={open.choices.resumeDocumentId ?? ''} disabled={busy} onChange={(event) => {
            void review(open.nomination, event.target.value ? { resumeDocumentId: event.target.value } : {});
          }}>
            <option value="">No résumé</option>
            {open.preview.resumeOptions.map((option) => <option key={option.documentId} value={option.documentId}>{option.title} — {option.filename} (version {option.versionNumber})</option>)}
          </select>
        </label>
        <label className="hiring-checkbox"><input type="checkbox" checked={share} disabled={busy} onChange={(event) => setShare(event.target.checked)} />
          <span>Also share this application's employer, role, stage, key dates and offer response with my college while our relationship is active (optional).</span></label>
      </> : null}
      <div className="hiring-actions">
        <button type="button" disabled={busy || !open.preview} onClick={() => { void optIn(); }}>Opt in and share my profile</button>
        {open.nomination.state === 'INVITED' ? <button type="button" className="secondary" disabled={busy} onClick={() => { void decline(open.nomination); }}>Decline</button> : null}
        <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(null)}>Not now</button>
      </div>
    </div> : null}
  </section>;
}
