import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  ApiRequestError,
  cancelPrivacyRequest,
  downloadDataExport,
  listPrivacyRequests,
  requestAccountDeletion,
  requestDataExport,
  type PrivacyRequestDto,
} from './api.js';

/**
 * The student's own privacy controls: take a copy of your data, or ask for your
 * account to be deleted.
 *
 * Deletion is presented with its consequences and its grace period stated up front,
 * and confirmed explicitly, because it is irreversible once the period elapses.
 */

const PRIVACY_MESSAGES: Readonly<Record<string, string>> = {
  EXPORT_ALREADY_REQUESTED: 'You already have an export in progress. Download that one, or wait for it to expire.',
  DELETION_ALREADY_REQUESTED: 'You have already asked for your account to be deleted.',
  REQUEST_CLOSED: 'That request is already closed.',
  EXPORT_EXPIRED: 'That export has expired. Request a new one.',
  EXPORT_NOT_READY: 'That export is not ready yet.',
  FILE_STORAGE_NOT_CONFIGURED: 'Data exports are not switched on yet.',
  FORBIDDEN: 'You cannot act on that request.',
};

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError) || !error.code) return fallback;
  return PRIVACY_MESSAGES[error.code] ?? fallback;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function isOpen(request: PrivacyRequestDto): boolean {
  return ['RECEIVED', 'IN_PROGRESS', 'READY'].includes(request.state);
}

export function StudentPrivacyPanel(): React.ReactElement {
  const [requests, setRequests] = useState<readonly PrivacyRequestDto[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);

  // `message` wins over the computed summary, so a confirmation survives the refresh
  // that follows it instead of being overwritten a moment later.
  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listPrivacyRequests(token);
    setRequests(response.requests);
    if (message) setStatus(message);
  };
  useEffect(() => { void reload().catch(() => setStatus('Your privacy requests could not be loaded.')); }, []);

  const openExport = requests.find((item) => item.requestType === 'EXPORT' && isOpen(item));
  const openDeletion = requests.find((item) => item.requestType === 'DELETION' && isOpen(item));

  async function startExport(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    setStatus('Preparing your data…');
    try {
      await requestDataExport(token);
      await reload('Your data is ready to download.');
    } catch (error) {
      setStatus(messageFor(error, 'Your export could not be prepared.'));
    } finally {
      setBusy(false);
    }
  }

  async function download(requestId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      const blob = await downloadDataExport(token, requestId);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = 'one-data-export.json';
      link.click();
      URL.revokeObjectURL(url);
      await reload();
    } catch (error) {
      setStatus(messageFor(error, 'That export could not be downloaded.'));
    }
  }

  async function startDeletion(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      const response = await requestAccountDeletion(token);
      setConfirmingDeletion(false);
      await reload(`Your account is scheduled for deletion on ${formatDate(response.request.scheduledFor)}. You can cancel any time before then.`);
    } catch (error) {
      setStatus(messageFor(error, 'Your deletion request could not be recorded.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(requestId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await cancelPrivacyRequest(token, requestId);
      await reload('Request cancelled. Nothing has been deleted.');
    } catch (error) {
      setStatus(messageFor(error, 'That request could not be cancelled.'));
    }
  }

  return <section className="card wide-card privacy-panel">
    <span className="eyebrow">Your data</span>
    <h2>Your data and your account</h2>
    {status ? <p role="status">{status}</p> : null}

    <h3>Take a copy of your data</h3>
    <p>We will put together everything we hold about you as a file you can download. It stays available for seven days.</p>
    {openExport?.state === 'READY'
      ? <div className="hiring-actions">
        <button type="button" onClick={() => { void download(openExport.id); }}>Download your data</button>
        <span className="hiring-meta">Available until {formatDate(openExport.expiresAt)}</span>
      </div>
      : <button type="button" disabled={busy || Boolean(openExport)} onClick={() => { void startExport(); }}>
        {openExport ? 'Preparing…' : 'Prepare my data'}
      </button>}

    <h3>Delete your account</h3>
    {openDeletion
      ? <div className="privacy-scheduled" role="status">
        <p><strong>Your account is scheduled for deletion on {formatDate(openDeletion.scheduledFor)}.</strong></p>
        <p>You can still change your mind. Cancelling stops the deletion completely and nothing is removed.</p>
        <button type="button" onClick={() => { void cancel(openDeletion.id); }}>Keep my account</button>
      </div>
      : confirmingDeletion
        ? <div className="privacy-confirm" role="alertdialog" aria-label="Confirm account deletion">
          <p><strong>This removes your profile, your documents and your saved opportunities.</strong></p>
          <p>
            Records that belong to someone else are kept without you attached to them: an employer keeps the fact that
            you applied and any decision they made, your college keeps its enrolment history, and our security logs are
            kept under our retention schedule.
          </p>
          <p>Nothing happens for 30 days. You can cancel at any point in that window.</p>
          <div className="hiring-actions">
            <button type="button" disabled={busy} onClick={() => { void startDeletion(); }}>Yes, delete my account</button>
            <button type="button" className="secondary" onClick={() => setConfirmingDeletion(false)}>Cancel</button>
          </div>
        </div>
        : <>
          <p>Ask us to delete your account. Nothing is removed for 30 days, and you can change your mind at any point.</p>
          <button type="button" className="secondary" onClick={() => setConfirmingDeletion(true)}>Delete my account…</button>
        </>}

    {requests.length > 0 ? <>
      <h3>Your requests</h3>
      <div className="data-table-wrap"><table>
        <thead><tr><th>Request</th><th>Status</th><th>Asked on</th><th></th></tr></thead>
        <tbody>{requests.map((item) => <tr key={item.id}>
          <td>{item.requestType === 'EXPORT' ? 'Copy of my data' : 'Delete my account'}</td>
          <td><span className={`hiring-state state-${item.state.toLowerCase()}`}>{item.state.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span></td>
          <td>{formatDate(item.requestedAt)}</td>
          <td>{isOpen(item) ? <button type="button" className="secondary" onClick={() => { void cancel(item.id); }}>Cancel</button> : null}</td>
        </tr>)}</tbody>
      </table></div>
    </> : null}
  </section>;
}
