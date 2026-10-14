/**
 * ONE · Operations — employer terms versions (EMP-16).
 *
 * A section of the existing Organizations screen (no navigation change). Operations publish a
 * version of the employer terms here; every employer must accept a version that requires
 * acceptance before its next publish. A version is immutable once published. The legal-review
 * state travels with the text: a draft is shown to employers as "Draft — pending legal review",
 * and a reviewed version must say whose review it was. The committed starting text is
 * docs/legal/employer-terms-DRAFT-for-legal-review.md.
 *
 * Collapsed until opened, so the Organizations screen makes no extra request unless asked.
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken } from '../api.js';
import { listOperatorEmployerTerms, publishOperatorEmployerTerms, type OperatorEmployerTermsVersionDto } from '../api/employerTerms.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

interface Draft { version: string; title: string; body: string; legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW' | 'LEGAL_APPROVED'; legalReviewReference: string; requiresReacceptance: boolean; changeSummary: string }
const emptyDraft: Draft = { version: '', title: '', body: '', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: '', requiresReacceptance: true, changeSummary: '' };

export function EmployerTermsSection(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<readonly OperatorEmployerTermsVersionDto[] | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token || !open) return;
    const controller = new AbortController();
    listOperatorEmployerTerms(token, controller.signal).then(({ versions: loaded }) => { if (!controller.signal.aborted) { setVersions(loaded); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Employer terms could not be loaded.')); });
    return () => controller.abort();
  }, [token, open, reload]);

  if (!token) return null;
  if (!open) {
    return <section className="role-card role-wide" aria-label="Employer terms">
      <h2>Employer terms</h2>
      <p>Versions of the terms every employer accepts before publishing.</p>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>Manage employer terms</button>
    </section>;
  }

  async function publish(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const { version } = await publishOperatorEmployerTerms(token!, {
        version: draft.version.trim(), title: draft.title.trim(), body: draft.body, legalReviewState: draft.legalReviewState,
        ...(draft.legalReviewState === 'LEGAL_APPROVED' ? { legalReviewReference: draft.legalReviewReference.trim() } : {}),
        requiresReacceptance: draft.requiresReacceptance,
        ...(draft.changeSummary.trim() ? { changeSummary: draft.changeSummary.trim() } : {}),
        reasonCode: 'TERMS_PUBLISHED',
      });
      setNotice(`Version ${version.version} is published.${version.requiresReacceptance ? ' Every employer must accept it before its next publish.' : ''}`);
      setDraft(emptyDraft);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The terms version could not be published.'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide" aria-label="Employer terms">
    <h2>Employer terms</h2>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {versions && !versions.length ? <p>No employer terms have been published. Employers publish jobs without accepting any terms until a version is published.</p> : null}
    {versions && versions.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Version</th><th>Title</th><th>Legal review</th><th>Needs acceptance</th><th>Published</th><th>Employers accepted</th></tr></thead>
      <tbody>{versions.map((item) => <tr key={item.version}>
        <td>{item.version}</td><td>{item.title}</td>
        <td>{item.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW' ? <StatusBadge label="Draft — pending legal review" tone="warning" /> : <StatusBadge label={item.legalReviewReference ? `Reviewed: ${item.legalReviewReference}` : 'Reviewed'} tone="success" />}</td>
        <td>{item.requiresReacceptance ? 'Yes' : 'No'}</td>
        <td>{formatDate(item.publishedAt)}</td>
        <td>{item.acceptedBy}</td>
      </tr>)}</tbody>
    </table></div> : null}
    <form className="role-management-form" aria-label="Publish employer terms" onSubmit={(event) => void publish(event)}>
      <p className="hiring-meta">Published versions cannot be changed. A version that needs acceptance stops every employer publishing until an owner accepts it; jobs already live are not affected.</p>
      <label><span>Version</span><input value={draft.version} maxLength={64} required onChange={(event) => setDraft((value) => ({ ...value, version: event.target.value }))} /></label>
      <label><span>Title</span><input value={draft.title} maxLength={200} required onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} /></label>
      <label><span>Terms text</span><textarea value={draft.body} rows={10} maxLength={60000} required onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))} /></label>
      <label><span>Legal review</span><select value={draft.legalReviewState} onChange={(event) => setDraft((value) => ({ ...value, legalReviewState: event.target.value as Draft['legalReviewState'] }))}>
        <option value="DRAFT_FOR_LEGAL_REVIEW">Draft — pending legal review</option>
        <option value="LEGAL_APPROVED">Reviewed and approved</option>
      </select></label>
      {draft.legalReviewState === 'LEGAL_APPROVED' ? <label><span>Who approved it, and where it is recorded</span><input value={draft.legalReviewReference} maxLength={200} required
        onChange={(event) => setDraft((value) => ({ ...value, legalReviewReference: event.target.value }))} /></label> : null}
      <label><span>Employers must accept this version</span><input type="checkbox" checked={draft.requiresReacceptance}
        onChange={(event) => setDraft((value) => ({ ...value, requiresReacceptance: event.target.checked }))} /></label>
      <label><span>What changed</span><input value={draft.changeSummary} maxLength={2000} onChange={(event) => setDraft((value) => ({ ...value, changeSummary: event.target.value }))} /></label>
      <button type="submit" disabled={busy}>Publish version</button>
    </form>
  </section>;
}
