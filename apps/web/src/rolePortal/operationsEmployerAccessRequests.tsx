/**
 * ONE · Operations — employer access requests (EMP-04).
 *
 * The queue behind the public "request employer access" form, shown as a section of the
 * existing Organizations screen (no navigation change). Each request is what an anonymous
 * visitor typed, so the queue shows the signals a reviewer needs — whether the email is on
 * the website's domain, whether it is webmail, how often it was sent, which existing
 * employers it might be — and says plainly that no email has been confirmed (there is no
 * production sender yet, HG-7).
 *
 * Deciding never creates or verifies anything: "Onboarded" links the request to an employer
 * the operator created with the Add Organization form above, which starts unverified.
 * Declined and spam need a reason from the server's fixed list.
 */
import { useEffect, useState } from 'react';
import {
  decideEmployerAccessRequest,
  getProtectedAccessToken,
  listEmployerAccessRequests,
  type EmployerAccessRequestDto,
  type EmployerAccessRequestQueueDto,
  type OrganizationManagementDto,
} from '../api.js';
import { formatApiError } from './shared.js';

type Decision = 'ONBOARDED' | 'DECLINED' | 'SPAM';

const reasonLabels: Readonly<Record<string, string>> = {
  ORGANISATION_CREATED: 'Organisation created for this request',
  EXISTING_ORGANISATION: 'Already on ONE',
  NOT_AN_EMPLOYER: 'Not an employer',
  COULD_NOT_CONFIRM: 'Could not confirm the company',
  DUPLICATE_REQUEST: 'Duplicate request',
  OUT_OF_SCOPE: 'Out of scope',
  BULK_SUBMISSION: 'Bulk submission',
  FAKE_DETAILS: 'Fake details',
  ABUSIVE_CONTENT: 'Abusive content',
};
const decisionLabels: Readonly<Record<Decision, string>> = { ONBOARDED: 'Mark onboarded', DECLINED: 'Decline', SPAM: 'Mark as spam' };

function formatDate(value: string | null): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function EmployerAccessRequestsSection({ organizations }: { readonly organizations: readonly OrganizationManagementDto[] }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [queue, setQueue] = useState<EmployerAccessRequestQueueDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<{ readonly request: EmployerAccessRequestDto; readonly decision: Decision } | null>(null);
  const [reason, setReason] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listEmployerAccessRequests(token, { state: 'PENDING' }, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) { setQueue(loaded); setLoadError(''); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Employer access requests could not be loaded.')); });
    return () => controller.abort();
  }, [token, reload]);

  if (!token) return null;
  const employers = organizations.filter((org) => org.kind === 'EMPLOYER');

  function start(request: EmployerAccessRequestDto, decision: Decision): void {
    setPending({ request, decision }); setReason(''); setError(''); setNotice('');
    setOrganizationId(decision === 'ONBOARDED' ? request.possibleMatches[0]?.organizationId ?? '' : '');
  }

  async function confirm(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!pending || !reason || (pending.decision === 'ONBOARDED' && !organizationId)) return;
    setBusy(true); setError('');
    try {
      await decideEmployerAccessRequest(token!, pending.request.id, {
        decision: pending.decision, reasonCode: reason, ...(pending.decision === 'ONBOARDED' ? { organizationId } : {}),
      });
      setNotice(pending.decision === 'ONBOARDED'
        ? `${pending.request.companyName} is linked to its employer record. Verification is still a separate step.`
        : `The request from ${pending.request.companyName} was closed.`);
      setPending(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'That decision could not be recorded.'));
    } finally {
      setBusy(false);
    }
  }

  const requests = queue?.requests ?? [];
  return <section className="role-card role-wide" aria-label="Employer access requests">
    <h2>Employer access requests</h2>
    <p>Sent from the public "Request employer access" form. Nothing has been created for these companies. To onboard one, add it with Add Organization, then mark the request onboarded; verify it separately.</p>
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    {pending ? <form className="role-management-form" aria-label="Confirm access request decision" onSubmit={(event) => void confirm(event)}>
      <h3>{decisionLabels[pending.decision]}: {pending.request.companyName}</h3>
      {pending.decision === 'ONBOARDED' ? <label><span>Employer organisation *</span>
        <select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} required>
          <option value="">Choose the employer you created</option>
          {employers.map((org) => <option key={org.id} value={org.id}>{org.legalName} ({org.verificationState})</option>)}
        </select></label> : null}
      <label><span>Reason *</span><select value={reason} onChange={(event) => setReason(event.target.value)} required>
        <option value="">Choose a reason</option>
        {(queue?.reasonCodes[pending.decision] ?? []).map((code) => <option key={code} value={code}>{reasonLabels[code] ?? code}</option>)}
      </select></label>
      <div className="hiring-actions">
        <button type="submit" disabled={busy || !reason || (pending.decision === 'ONBOARDED' && !organizationId)}>{decisionLabels[pending.decision]}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
      </div>
    </form> : null}

    {queue === null && !loadError ? <p role="status">Loading employer access requests…</p> : null}
    {queue !== null && requests.length === 0 ? <p>No pending employer access requests.</p> : null}
    {requests.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <caption className="sr-only">Pending employer access requests</caption>
      <thead><tr><th>Company</th><th>Requested by</th><th>Checks</th><th>Possible matches</th><th>Received</th><th>Actions</th></tr></thead>
      <tbody>{requests.map((request) => <tr key={request.id} className="role-record-row">
        <th scope="row"><strong>{request.companyName}</strong><small>{request.websiteUrl}</small></th>
        <td>{request.requesterName}<br /><small>{request.workEmail}</small></td>
        <td><ul className="role-check-list">
          <li>{request.emailMatchesWebsite ? 'Email is on the website domain' : 'Email is not on the website domain'}</li>
          {request.freeMail ? <li>Personal webmail address</li> : null}
          <li>Email not confirmed — confirm with the requester before onboarding</li>
          {request.submissionCount > 1 ? <li>Sent {request.submissionCount} times</li> : null}
        </ul></td>
        <td>{request.possibleMatches.length ? request.possibleMatches.map((match) => <div key={match.organizationId}>{match.legalName} ({match.verificationState})</div>) : 'None'}</td>
        <td>{formatDate(request.createdAt)}</td>
        <td><div className="role-record-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => start(request, 'ONBOARDED')}>Mark onboarded</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => start(request, 'DECLINED')}>Decline</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => start(request, 'SPAM')}>Spam</button>
        </div></td>
      </tr>)}</tbody>
    </table></div> : null}
    {queue?.nextCursor ? <p>Showing the 50 most recent pending requests.</p> : null}
  </section>;
}
