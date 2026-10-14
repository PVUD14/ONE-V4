/**
 * ONE · Operations — college data-processing terms and college exits (INST-18).
 *
 * Two sections of the existing Organizations screen (no navigation change):
 *  - Institution data-processing terms: publish a version (immutable once published; its
 *    legal-review state travels with it, so a draft is shown to colleges as a draft) and see how
 *    many colleges accepted each. The committed starting text is
 *    docs/legal/institution-data-processing-terms-DRAFT-for-legal-review.md.
 *  - College exits: the runbook — record the notice, end the college's use of ONE, cancel while the
 *    90-day retention period runs, dry-run the deletion, and file the INSTITUTION_DATA_PURGE approval
 *    request. The deletion itself is executed from Settings → Approvals once a second person has
 *    approved it, like every other high-risk action.
 *
 * Both are collapsed until opened, so the Organizations screen makes no extra request unless asked.
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken } from '../api.js';
import type { OrganizationManagementDto } from '../api.js';
import {
  getInstitutionPurgePreview,
  listOperatorInstitutionDataTerms,
  listOperatorInstitutionOffboardings,
  publishOperatorInstitutionDataTerms,
  recordInstitutionOffboardingNotice,
  stepInstitutionOffboarding,
  type InstitutionPurgePreviewDto,
  type OperatorInstitutionDataTermsVersionDto,
  type OperatorInstitutionOffboardingDto,
  type OperatorOffboardingPolicyDto,
} from '../api/institutionContract.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

interface Draft { version: string; title: string; body: string; legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW' | 'LEGAL_APPROVED'; legalReviewReference: string; requiresReacceptance: boolean; changeSummary: string }
const emptyDraft: Draft = { version: '', title: '', body: '', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: '', requiresReacceptance: true, changeSummary: '' };

export function InstitutionDataTermsOperationsSection(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<readonly OperatorInstitutionDataTermsVersionDto[] | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token || !open) return;
    const controller = new AbortController();
    listOperatorInstitutionDataTerms(token, controller.signal).then(({ versions: loaded }) => { if (!controller.signal.aborted) { setVersions(loaded); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'College data-processing terms could not be loaded.')); });
    return () => controller.abort();
  }, [token, open, reload]);

  if (!token) return null;
  if (!open) {
    return <section className="role-card role-wide" aria-label="Institution data-processing terms">
      <h2>Institution data-processing terms</h2>
      <p>Versions of the terms every college’s owner accepts before more students are added.</p>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>Manage college data terms</button>
    </section>;
  }

  async function publish(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const { version } = await publishOperatorInstitutionDataTerms(token!, {
        version: draft.version.trim(), title: draft.title.trim(), body: draft.body, legalReviewState: draft.legalReviewState,
        ...(draft.legalReviewState === 'LEGAL_APPROVED' ? { legalReviewReference: draft.legalReviewReference.trim() } : {}),
        requiresReacceptance: draft.requiresReacceptance,
        ...(draft.changeSummary.trim() ? { changeSummary: draft.changeSummary.trim() } : {}),
        reasonCode: 'TERMS_PUBLISHED',
      });
      setNotice(`Version ${version.version} is published.${version.requiresReacceptance ? ' Every college’s owner must accept it before the college adds more students.' : ''}`);
      setDraft(emptyDraft);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The terms version could not be published.'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide" aria-label="Institution data-processing terms">
    <h2>Institution data-processing terms</h2>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {versions && !versions.length ? <p>No college data-processing terms have been published. Colleges add students without accepting any terms until a version is published.</p> : null}
    {versions && versions.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Version</th><th>Title</th><th>Legal review</th><th>Needs acceptance</th><th>Published</th><th>Colleges accepted</th></tr></thead>
      <tbody>{versions.map((item) => <tr key={item.version}>
        <td>{item.version}</td><td>{item.title}</td>
        <td>{item.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW' ? <StatusBadge label="Draft — pending legal review" tone="warning" /> : <StatusBadge label={item.legalReviewReference ? `Reviewed: ${item.legalReviewReference}` : 'Reviewed'} tone="success" />}</td>
        <td>{item.requiresReacceptance ? 'Yes' : 'No'}</td>
        <td>{formatDate(item.publishedAt)}</td>
        <td>{item.acceptedBy}</td>
      </tr>)}</tbody>
    </table></div> : null}
    <form className="role-management-form" aria-label="Publish college data terms" onSubmit={(event) => void publish(event)}>
      <p className="hiring-meta">Published versions cannot be changed. A version that needs acceptance stops each college adding students until its owner accepts; nothing already in place is affected.</p>
      <label><span>Version</span><input value={draft.version} maxLength={64} required onChange={(event) => setDraft((value) => ({ ...value, version: event.target.value }))} /></label>
      <label><span>Title</span><input value={draft.title} maxLength={200} required onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} /></label>
      <label><span>Terms text</span><textarea value={draft.body} rows={10} maxLength={60000} required onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))} /></label>
      <label><span>Legal review</span><select value={draft.legalReviewState} onChange={(event) => setDraft((value) => ({ ...value, legalReviewState: event.target.value as Draft['legalReviewState'] }))}>
        <option value="DRAFT_FOR_LEGAL_REVIEW">Draft — pending legal review</option>
        <option value="LEGAL_APPROVED">Reviewed and approved</option>
      </select></label>
      {draft.legalReviewState === 'LEGAL_APPROVED' ? <label><span>Who approved it, and where it is recorded</span><input value={draft.legalReviewReference} maxLength={200} required
        onChange={(event) => setDraft((value) => ({ ...value, legalReviewReference: event.target.value }))} /></label> : null}
      <label><span>Colleges must accept this version</span><input type="checkbox" checked={draft.requiresReacceptance}
        onChange={(event) => setDraft((value) => ({ ...value, requiresReacceptance: event.target.checked }))} /></label>
      <label><span>What changed</span><input value={draft.changeSummary} maxLength={2000} onChange={(event) => setDraft((value) => ({ ...value, changeSummary: event.target.value }))} /></label>
      <button type="submit" disabled={busy}>Publish version</button>
    </form>
  </section>;
}

// --- College exits ------------------------------------------------------------------

const stateLabels: Readonly<Record<string, string>> = { NOTICE: 'Notice recorded', ENDED: 'Ended — retention running', CANCELLED: 'Cancelled', PURGED: 'Records deleted' };
const reasonLabels: Readonly<Record<string, string>> = {
  CONTRACT_ENDED: 'Agreement ended', COLLEGE_REQUESTED_EXIT: 'The college asked to leave', NON_RENEWAL: 'Not renewed',
  NOTICE_PERIOD_COMPLETE: 'Notice period complete', COLLEGE_CONFIRMED_EXIT: 'The college confirmed its exit',
  COLLEGE_RENEWED: 'The college renewed', COLLEGE_WITHDREW_NOTICE: 'The college withdrew its notice', ENTERED_IN_ERROR: 'Recorded in error',
};
const day = (value: string | null, missing = 'Not yet'): string => (value ? formatDate(value) : missing);

export function CollegeExitsSection({ organizations }: { readonly organizations: readonly OrganizationManagementDto[] }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [open, setOpen] = useState(false);
  const [exits, setExits] = useState<readonly OperatorInstitutionOffboardingDto[] | null>(null);
  const [policy, setPolicy] = useState<OperatorOffboardingPolicyDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState({ institutionId: '', reasonCode: '' });
  const [pending, setPending] = useState<{ readonly exit: OperatorInstitutionOffboardingDto; readonly step: 'end' | 'cancel'; readonly reasonCode: string } | null>(null);
  const [preview, setPreview] = useState<{ readonly exit: OperatorInstitutionOffboardingDto; readonly preview: InstitutionPurgePreviewDto } | null>(null);
  const [purging, setPurging] = useState<OperatorInstitutionOffboardingDto | null>(null);

  useEffect(() => {
    if (!token || !open) return;
    const controller = new AbortController();
    listOperatorInstitutionOffboardings(token, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) { setExits(loaded.offboardings); setPolicy(loaded.policy); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'College exits could not be loaded.')); });
    return () => controller.abort();
  }, [token, open, reload]);

  if (!token) return null;
  if (!open) {
    return <section className="role-card role-wide" aria-label="College exits">
      <h2>College exits</h2>
      <p>Record a college’s exit notice, end its use of ONE, reverse it within the retention period, and delete its records after.</p>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>Manage college exits</button>
    </section>;
  }

  const colleges = organizations.filter((org) => org.kind === 'INSTITUTION');
  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      setNotice(await work());
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The step could not be completed.'));
    } finally {
      setBusy(false);
    }
  }
  const recordNotice = (event: React.FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const { offboarding } = await recordInstitutionOffboardingNotice(token!, form.institutionId, form.reasonCode);
      setForm({ institutionId: '', reasonCode: '' });
      return `Exit notice recorded for ${offboarding.institutionName}. Its owner can now take the exit export from Settings.`;
    });
  };
  const confirmStep = (): void => {
    if (!pending) return;
    const { exit, step, reasonCode } = pending;
    void run(async () => {
      const { offboarding } = await stepInstitutionOffboarding(token!, exit.id, step, reasonCode);
      setPending(null);
      return step === 'end'
        ? `${offboarding.institutionName} has stopped using ONE: ${offboarding.changes.relationships} student links and ${offboarding.changes.memberships} staff memberships ended. Reversible until ${day(offboarding.retentionEndsAt)}.`
        : `The exit of ${offboarding.institutionName} is cancelled; ${offboarding.changes.restored} links and memberships restored.`;
    });
  };
  const dryRun = (exit: OperatorInstitutionOffboardingDto): void => {
    void run(async () => {
      const loaded = await getInstitutionPurgePreview(token!, exit.id);
      setPreview({ exit: loaded.offboarding, preview: loaded.preview });
      return `Dry run for ${exit.institutionName}: nothing was deleted.`;
    });
  };
  const stepReasons = pending && policy ? policy.reasons[pending.step === 'end' ? 'END' : 'CANCEL'] : [];

  return <section className="role-card role-wide" aria-label="College exits">
    <h2>College exits</h2>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <p className="hiring-meta">Ending an exit ends every current student link and staff membership and takes the college out of the directory; it can be reversed {policy?.retentionDays != null ? `for ${policy.retentionDays} days` : 'during the retention period'}. Students keep their accounts and their own records. Deleting the college’s records needs a second person’s approval and waits for the retention period.</p>
    <form className="role-management-form" aria-label="Record an exit notice" onSubmit={recordNotice}>
      <label><span>College</span><select value={form.institutionId} required onChange={(event) => setForm((value) => ({ ...value, institutionId: event.target.value }))}>
        <option value="">Choose a college</option>
        {colleges.map((org) => <option key={org.id} value={org.id}>{org.profile.displayName || org.legalName}</option>)}
      </select></label>
      <label><span>Reason</span><select value={form.reasonCode} required onChange={(event) => setForm((value) => ({ ...value, reasonCode: event.target.value }))}>
        <option value="">Choose a reason</option>
        {(policy?.reasons.NOTICE ?? []).map((code) => <option key={code} value={code}>{reasonLabels[code] ?? code}</option>)}
      </select></label>
      <button type="submit" disabled={busy || !form.institutionId || !form.reasonCode}>Record exit notice</button>
    </form>
    {exits && !exits.length ? <p>No college has an exit on record.</p> : null}
    {exits && exits.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">College exits</caption>
      <thead><tr><th>College</th><th>State</th><th>Notice</th><th>Ended</th><th>Retention ends</th><th>Exit export taken</th><th>Changes</th><th>Actions</th></tr></thead>
      <tbody>{exits.map((exit) => <tr key={exit.id}>
        <th scope="row">{exit.institutionName}</th>
        <td><StatusBadge label={stateLabels[exit.state] ?? exit.state} tone={exit.state === 'PURGED' ? 'neutral' : exit.state === 'CANCELLED' ? 'info' : 'warning'} /></td>
        <td>{day(exit.noticeAt)}</td><td>{day(exit.endedAt)}</td><td>{day(exit.retentionEndsAt)}</td><td>{day(exit.exitExportLastTakenAt, 'Not taken')}</td>
        <td>{exit.changes.relationships} student links, {exit.changes.memberships} staff{exit.changes.restored ? `, ${exit.changes.restored} restored` : ''}</td>
        <td><div className="role-record-actions">
          {exit.state === 'NOTICE' ? <button type="button" className="secondary" disabled={busy} onClick={() => setPending({ exit, step: 'end', reasonCode: '' })}>End…</button> : null}
          {exit.state === 'NOTICE' || (exit.state === 'ENDED' && !exit.retentionElapsed)
            ? <button type="button" className="secondary" disabled={busy} onClick={() => setPending({ exit, step: 'cancel', reasonCode: '' })}>Cancel exit…</button> : null}
          {exit.state !== 'PURGED' && exit.state !== 'CANCELLED' ? <button type="button" className="secondary" disabled={busy} onClick={() => dryRun(exit)}>Dry run</button> : null}
          {exit.state === 'ENDED' && exit.retentionElapsed ? <button type="button" disabled={busy} onClick={() => setPurging(exit)}>Request deletion…</button> : null}
        </div></td>
      </tr>)}</tbody>
    </table></div> : null}
    {pending ? <div role="dialog" aria-label={pending.step === 'end' ? 'End the exit' : 'Cancel the exit'} className="role-card">
      <h3>{pending.step === 'end' ? `End ${pending.exit.institutionName}’s use of ONE` : `Cancel the exit of ${pending.exit.institutionName}`}</h3>
      <p>{pending.step === 'end'
        ? 'Every current student link and staff membership ends now, pending invitations are withdrawn and each activated student is told. You can reverse this within the retention period.'
        : 'Every link and membership the exit ended is restored as it was, and each student whose link comes back is told. Withdrawn invitations are not revived; the college resends them.'}</p>
      <label><span>Reason</span><select value={pending.reasonCode} onChange={(event) => setPending((value) => (value ? { ...value, reasonCode: event.target.value } : value))}>
        <option value="">Choose a reason</option>
        {stepReasons.map((code) => <option key={code} value={code}>{reasonLabels[code] ?? code}</option>)}
      </select></label>
      <div className="role-record-actions">
        <button type="button" disabled={busy || !pending.reasonCode} onClick={confirmStep}>{pending.step === 'end' ? 'End now' : 'Cancel the exit'}</button>
        <button type="button" className="secondary" onClick={() => setPending(null)}>Back</button>
      </div>
    </div> : null}
    {preview ? <div aria-label="Deletion dry run" className="role-card">
      <h3>Dry run: {preview.exit.institutionName}</h3>
      <p>{preview.preview.studentsUnderHold > 0
        ? `${preview.preview.studentsUnderHold} of its students ${preview.preview.studentsUnderHold === 1 ? 'is' : 'are'} under a legal hold, so the deletion is refused until the hold is released.`
        : 'No legal hold covers its students.'}</p>
      <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Rows the deletion would remove and keep</caption>
        <thead><tr><th>Table</th><th>Rows</th><th>At deletion</th></tr></thead>
        <tbody>
          {Object.entries(preview.preview.deletes).map(([table, rows]) => <tr key={'d:' + table}><td>{table}</td><td>{rows}</td><td>Deleted</td></tr>)}
          {Object.entries(preview.preview.keeps).map(([table, rows]) => <tr key={'k:' + table}><td>{table}</td><td>{rows}</td><td>Kept</td></tr>)}
        </tbody>
      </table></div>
      <button type="button" className="secondary" onClick={() => setPreview(null)}>Close</button>
    </div> : null}
    {purging ? <RequestApprovalDialog token={token} actionKey="INSTITUTION_DATA_PURGE" payload={{ offboardingId: purging.id }}
      title={`Delete the records of ${purging.institutionName}`} reasons={policy?.purgeReasons ?? []}
      details={[['College', purging.institutionName], ['Ended', day(purging.endedAt)], ['Retention ended', day(purging.retentionEndsAt)],
        ['Effect', 'Deletes the college’s own records (roster, staff actions, assessments, settings). Students’ accounts and records stay. Execute it from Settings → Approvals once approved.']]}
      onCancel={() => setPurging(null)} onFiled={(message) => { setPurging(null); setNotice(message); }} /> : null}
  </section>;
}
