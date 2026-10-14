/**
 * Export applicants as CSV (EMP-17, journey J9): a section of the Applicants page, not a new
 * navigation item (HG-3), shown to owners and admins only.
 *
 * It requests nothing until the person acts. The server decides everything that matters: owners
 * and admins only, only candidates who still share their application, only what they shared,
 * contact details from Shortlisted, recorded with the reason. This panel says so plainly and
 * saves the file the server sends.
 */
import { useState, type FormEvent } from 'react';
import { getAccessToken } from '../auth.js';
import { ApiRequestError } from '../api/core.js';
import { downloadEmployerApplicantExport, employerExportReasons, saveDownloadedFile, type EmployerExportScope } from '../api/hiring.js';
import { supportCodeSuffix } from '../supportCode.js';

function exportError(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'The export could not be prepared. Try again.';
  const reference = supportCodeSuffix(error.correlationId);
  switch (error.code) {
    case 'EXPORT_RATE_LIMITED': return 'You have reached the limit of 20 exports in 24 hours. Try again later.' + reference;
    case 'EXPORT_TOO_LARGE': return 'This job has more than 5,000 applicants to export. Export Shortlisted onward instead.' + reference;
    case 'EMPLOYER_ORGANISATION_UNVERIFIED': return 'Your organisation is not verified yet, so candidate data cannot be exported.' + reference;
    case 'EMPLOYER_ORGANISATION_INACTIVE': return 'Your organisation is not active, so candidate data cannot be exported.' + reference;
    default: break;
  }
  if (error.status === 401) return 'Your session has expired. Sign in again to export.';
  if (error.status === 403) return 'Only owners and admins of your organisation can export applicants.' + reference;
  return 'The export could not be prepared. Try again.' + reference;
}

export function EmployerApplicantExportPanel({ employerId, opportunityId }: { readonly employerId: string; readonly opportunityId: string }): React.ReactElement {
  const [reasonCode, setReasonCode] = useState<string>(employerExportReasons[0][0]);
  const [scope, setScope] = useState<EmployerExportScope>('ALL_OPEN');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const file = await downloadEmployerApplicantExport(token, employerId, opportunityId, { reasonCode, scope });
      saveDownloadedFile(file);
      setNotice(`Exported as ${file.filename}. The export is recorded with your reason.`);
    } catch (cause) {
      setError(exportError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide" aria-labelledby="applicant-export-title">
    <h2 id="applicant-export-title">Export applicants</h2>
    <p>Download this job's applicants as a CSV file. It holds only candidates who still share their application with you, and only what they chose to share. Email and phone appear from Shortlisted onward. Each export is recorded with your reason, and ONE never includes readiness, scores or internal references.</p>
    <form className="role-management-form" onSubmit={(event) => void submit(event)}>
      <label><span>Applicants</span><select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as EmployerExportScope)}>
        <option value="ALL_OPEN">Every open application</option>
        <option value="SHORTLISTED_ONWARD">Shortlisted onward</option>
      </select></label>
      <label><span>Reason for this export</span><select value={reasonCode} disabled={busy} onChange={(event) => setReasonCode(event.target.value)}>
        {employerExportReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select></label>
      <button type="submit" disabled={busy}>{busy ? 'Preparing export…' : 'Export CSV'}</button>
    </form>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
