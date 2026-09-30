/**
 * ONE · Role portal — Operations Settings: status communications (OPS-16).
 *
 * Lives under the existing Settings label (Appendix 1 §4.2), after Approvals and Staff. Two parts:
 *  - Templates: draft a new version of a status-notice template; ask a second person to approve it
 *    (Settings → Approvals, OPS-02 dual control, the solo safeguard when only one approver exists);
 *    publish it once approved.
 *  - Notices: draft a notice for an incident from a published version, have a person other than its
 *    drafter approve it for sending (the sole approver may approve their own after the cooling-off,
 *    marked Solo), or withdraw it. There is no free text: a notice is only ever an approved template version. It
 *    reaches the administrators of the incident's affected organisations — never students — and
 *    email is shown as not sent while no mail service is configured.
 * The server decides every rule, including the rate limit; this screen shows what it says.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  approveStatusNotice,
  draftStatusNotice,
  draftStatusNoticeTemplate,
  getCommunicationsPolicy,
  getProtectedAccessToken,
  listStatusNotices,
  listStatusNoticeTemplates,
  publishStatusNoticeTemplate,
  requestOperationApproval,
  withdrawStatusNotice,
  withdrawStatusNoticeTemplate,
} from '../api.js';
import type { CommunicationsPolicyDto, StatusNoticeDto, StatusNoticeTemplateDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { emailSummary } from './incidents.js';

const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');

type Action =
  | { readonly kind: 'requestApproval'; readonly template: StatusNoticeTemplateDto }
  | { readonly kind: 'publish'; readonly template: StatusNoticeTemplateDto }
  | { readonly kind: 'withdrawTemplate'; readonly template: StatusNoticeTemplateDto }
  | { readonly kind: 'approveNotice'; readonly notice: StatusNoticeDto }
  | { readonly kind: 'withdrawNotice'; readonly notice: StatusNoticeDto };

export function OperationsCommunicationsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<CommunicationsPolicyDto | null>(null);
  const [templates, setTemplates] = useState<readonly StatusNoticeTemplateDto[] | null>(null);
  const [notices, setNotices] = useState<readonly StatusNoticeDto[] | null>(null);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [draft, setDraft] = useState({ templateKey: '', subject: '', body: '', reasonCode: '' });
  const [noticeDraft, setNoticeDraft] = useState({ incidentId: '', templateId: '', reasonCode: '' });
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    Promise.all([
      getCommunicationsPolicy(token, controller.signal),
      listStatusNoticeTemplates(token, undefined, null, controller.signal),
      listStatusNotices(token, undefined, null, controller.signal),
    ])
      .then(([loadedPolicy, loadedTemplates, loadedNotices]) => {
        setPolicy(loadedPolicy); setTemplates(loadedTemplates.templates ?? []); setNotices(loadedNotices.notices ?? []); setError(''); setForbiddenReference('');
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load status communications.'));
      });
    return () => controller.abort();
  }, [token, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1>Status communications</h1>
    <p>Status notices tell the administrators of the colleges and employers an incident affects what is happening. A notice is only ever an approved template version — never free text — and it never reaches students. Each template version needs a second person&apos;s approval before it can be used, and every notice is a draft until a person approves it for sending.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted" note="Status communications are for staff who hold Communications Templates. Your access has not changed." hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }
  if (!policy?.reasons || !templates || !notices) {
    return <section className="role-module role-module--dense">{heading}
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading status communications…</p>}</section>;
  }

  const published = templates.filter((template) => template.state === 'PUBLISHED');
  const refresh = (message: string): void => { setAction(null); setNotice(message); setReload((value) => value + 1); };

  const submitTemplate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!draft.templateKey || !draft.subject.trim() || !draft.body.trim() || !draft.reasonCode) { setError('Fill in the key, subject, body and a reason code.'); return; }
    setBusy(true);
    try {
      const result = await draftStatusNoticeTemplate(token, { templateKey: draft.templateKey.trim(), subject: draft.subject.trim(), body: draft.body.trim(), reasonCode: draft.reasonCode });
      setDraft({ templateKey: '', subject: '', body: '', reasonCode: '' });
      setError('');
      refresh(`Drafted ${result.template.templateKey} version ${result.template.version}. Ask for approval before it can be used.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The template version could not be drafted.'));
    } finally { setBusy(false); }
  };

  const submitNotice = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!noticeDraft.incidentId || !noticeDraft.templateId || !noticeDraft.reasonCode) { setError('Choose an incident, a published template and a reason code.'); return; }
    setBusy(true);
    try {
      await draftStatusNotice(token, noticeDraft);
      setNoticeDraft({ incidentId: '', templateId: '', reasonCode: '' });
      setError('');
      refresh('Notice drafted. It is not sent until a person approves it for sending.');
    } catch (cause) {
      setError(formatApiError(cause, 'The notice could not be drafted.'));
    } finally { setBusy(false); }
  };

  return <section className="role-module role-module--dense" aria-label="Status communications">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📝" tone="amber" value={templates.filter((template) => template.state === 'DRAFT').length} label="Template drafts in this view" />
      <V2Stat icon="✅" tone="teal" value={published.length} label="Published template versions in this view" />
      <V2Stat icon="📤" tone="blue" value={notices.filter((item) => item.state === 'DRAFT' || item.state === 'QUEUED').length} label="Notices not yet sent in this view" />
      <V2Stat icon="🚨" tone="purple" value={policy.incidents.length} label="Open incidents" />
    </div>
    {policy.soloSafeguardActive ? <p className="role-wide"><StatusBadge label="Solo safeguard active" tone="info" /> Only one person can approve. They may approve their own request after a 15-minute cooling-off period; the approval is marked Solo.</p> : null}
    <p className="role-wide"><small>Rate limit: one notice per incident every {policy.rateLimit.minimumSpacingMinutes} minutes, at most {policy.rateLimit.dailyLimit} in 24 hours.</small></p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    <section className="role-card role-wide"><h2>Templates</h2>
      {templates.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Template</th><th>Wording</th><th>State</th><th>Drafted</th><th>Approval</th><th>Actions</th></tr></thead>
        <tbody>{templates.map((template) => <tr key={template.id}>
          <td><strong>{template.templateKey}</strong><br /><small>Version {template.version}</small></td>
          <td>{template.subject}<br /><small>{template.body}</small></td>
          <td><StatusBadge label={label(template.state)} tone={template.state === 'PUBLISHED' ? 'success' : template.state === 'DRAFT' ? 'warning' : 'neutral'} /></td>
          <td>{when(template.draftedAt)}<br /><small>{template.draftedBy.email}{template.draftedBy.isSelf ? ' (you)' : ''}</small></td>
          <td>{template.state === 'PUBLISHED' ? `Approved by ${template.approvedBy ?? 'NA'}${template.publishMode === 'SOLO' ? ' (solo)' : ''}` : template.approval ? label(template.approval.state) : 'Not requested'}</td>
          <td>
            {template.canRequestApproval ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'requestApproval', template })}>Ask for approval…</button> : null}
            {template.canPublish ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'publish', template })}>Publish…</button> : null}
            {template.state === 'DRAFT' ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'withdrawTemplate', template })}>Withdraw…</button> : null}
          </td>
        </tr>)}</tbody></table></div> : <V2EmptyState icon="📝" title="No templates yet" note="Draft the first status notice template below." />}
      <form onSubmit={(event) => void submitTemplate(event)} noValidate aria-label="Draft a template version">
        <h3>Draft a template version</h3>
        <p>Using an existing key drafts its next version. The wording is sent exactly as written.</p>
        <label><span>Template key (lowercase letters, digits and hyphens) <em>required</em></span>
          <input value={draft.templateKey} maxLength={49} onChange={(event) => setDraft({ ...draft, templateKey: event.target.value })} /></label>
        <label><span>Subject (160 characters) <em>required</em></span>
          <input value={draft.subject} maxLength={160} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} /></label>
        <label><span>Body (500 characters) <em>required</em></span>
          <textarea value={draft.body} maxLength={500} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={draft.reasonCode} onChange={(event) => setDraft({ ...draft, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.templateDraft.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <button type="submit" disabled={busy || !draft.templateKey || !draft.subject.trim() || !draft.body.trim() || !draft.reasonCode}>Draft version</button>
      </form>
    </section>

    <section className="role-card role-wide"><h2>Notices</h2>
      {notices.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Incident</th><th>Notice</th><th>State</th><th>Approved</th><th>Sent</th><th>Reached</th><th>Email</th><th>Actions</th></tr></thead>
        <tbody>{notices.map((item) => <tr key={item.id}>
          <td><strong>{item.incident.reference}</strong><br /><small>{item.incident.title}</small></td>
          <td>{item.template.subject}<br /><small>{item.template.templateKey} v{item.template.version}</small></td>
          <td><StatusBadge label={label(item.state)} tone={item.state === 'SENT' ? 'success' : item.state === 'WITHDRAWN' ? 'neutral' : 'warning'} /></td>
          <td>{item.approvedAt ? `${when(item.approvedAt)} by ${item.approvedBy ?? 'NA'}${item.approveMode === 'SOLO' ? ' (solo)' : ''}` : 'NA'}</td>
          <td>{when(item.sentAt)}</td>
          <td>{item.recipientCount === null ? 'NA' : `${item.recipientCount} admins in ${item.organizationCount ?? 0} organisations`}</td>
          <td>{item.state === 'SENT' ? emailSummary(item.email) : 'NA'}</td>
          <td>{item.state === 'DRAFT' ? <>
            {!item.draftedBySelf
              ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'approveNotice', notice: item })}>Approve for sending…</button>
              : policy.noticeSoloSafeguardActive
                ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'approveNotice', notice: item })}>Approve for sending (solo)…</button>
                : <small>You drafted this notice, so another person approves it.</small>}
            <button type="button" className="secondary" onClick={() => setAction({ kind: 'withdrawNotice', notice: item })}>Withdraw…</button>
          </> : null}</td>
        </tr>)}</tbody></table></div> : <V2EmptyState icon="📤" title="No notices yet" note="Draft a notice for an open incident below." />}
      <form onSubmit={(event) => void submitNotice(event)} noValidate aria-label="Draft a notice">
        <h3>Draft a notice</h3>
        {!published.length ? <p>No template version is published yet. A notice can only use a published version.</p> : null}
        {!policy.incidents.length ? <p>No open incident. Incidents are declared under Security.</p> : null}
        <label><span>Incident <em>required</em></span>
          <select value={noticeDraft.incidentId} onChange={(event) => setNoticeDraft({ ...noticeDraft, incidentId: event.target.value })}>
            <option value="">Choose…</option>
            {policy.incidents.map((incident) => <option key={incident.id} value={incident.id}>{incident.reference} — {incident.title} ({incident.affectedOrganizationsCount} affected organisations)</option>)}
          </select></label>
        <label><span>Published template version <em>required</em></span>
          <select value={noticeDraft.templateId} onChange={(event) => setNoticeDraft({ ...noticeDraft, templateId: event.target.value })}>
            <option value="">Choose…</option>
            {published.map((template) => <option key={template.id} value={template.id}>{template.templateKey} v{template.version} — {template.subject}</option>)}
          </select></label>
        <label><span>Reason code <em>required</em></span>
          <select value={noticeDraft.reasonCode} onChange={(event) => setNoticeDraft({ ...noticeDraft, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.noticeDraft.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <button type="submit" disabled={busy || !noticeDraft.incidentId || !noticeDraft.templateId || !noticeDraft.reasonCode}>Draft notice</button>
      </form>
    </section>

    {action ? <CommunicationsActionDialog token={token} policy={policy} action={action} onCancel={() => setAction(null)} onDone={refresh} /> : null}
  </section>;
}

/** Every write opens this dialog: the reason code is required, and it says whether approval is needed. */
function CommunicationsActionDialog({ token, policy, action, onCancel, onDone }: {
  readonly token: string; readonly policy: CommunicationsPolicyDto; readonly action: Action; readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reasons = (() => {
    switch (action.kind) {
      case 'requestApproval': case 'publish': return policy.reasons.templatePublish;
      case 'withdrawTemplate': return policy.reasons.templateWithdraw;
      case 'approveNotice': return policy.reasons.noticeApprove;
      case 'withdrawNotice': return policy.reasons.noticeWithdraw;
    }
  })();
  const title = (() => {
    switch (action.kind) {
      case 'requestApproval': return `Ask for approval of ${action.template.templateKey} version ${action.template.version}`;
      case 'publish': return `Publish ${action.template.templateKey} version ${action.template.version}`;
      case 'withdrawTemplate': return `Withdraw ${action.template.templateKey} version ${action.template.version}`;
      case 'approveNotice': return `Approve the notice on ${action.notice.incident.reference} for sending`;
      case 'withdrawNotice': return `Withdraw the notice on ${action.notice.incident.reference}`;
    }
  })();
  const approvalLine = action.kind === 'requestApproval'
    ? `Required: a second person with Approve High Risk decides in Settings → Approvals.${policy.soloSafeguardActive ? ' Only one approver exists, so the solo safeguard applies (15-minute cooling-off, marked Solo).' : ''}`
    : action.kind === 'publish'
      ? `Approved by a second person; publishing uses that approval once.`
      : action.kind === 'approveNotice'
        ? `This is the approval: the notice is sent by the background worker to the administrators of ${action.notice.incident.reference}'s affected organisations, from the approved wording only.${action.notice.draftedBySelf
          ? ` You drafted it and are the only person who can approve notices, so the solo safeguard applies: it can be approved from ${when(action.notice.soloApprovalAvailableAt)} (${policy.soloCoolingOffMinutes ?? 15}-minute cooling-off) and is marked Solo.`
          : ''}`
        : 'Not required. Recorded with your reason.';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      switch (action.kind) {
        case 'requestApproval':
          await requestOperationApproval(token, { actionKey: 'COMMS_TEMPLATE_PUBLISH', payload: { templateId: action.template.id, reasonCode } });
          onDone('Approval requested. It appears in Settings → Approvals.'); break;
        case 'publish':
          await publishStatusNoticeTemplate(token, action.template.id, { reasonCode, ...(action.template.approval ? { approvalId: action.template.approval.id } : {}) });
          onDone(`${action.template.templateKey} version ${action.template.version} published.`); break;
        case 'withdrawTemplate':
          await withdrawStatusNoticeTemplate(token, action.template.id, { reasonCode });
          onDone('Template version withdrawn.'); break;
        case 'approveNotice':
          await approveStatusNotice(token, action.notice.id, { reasonCode });
          onDone('Notice approved for sending. The background worker sends it shortly.'); break;
        case 'withdrawNotice':
          await withdrawStatusNotice(token, action.notice.id, { reasonCode });
          onDone('Notice withdrawn.'); break;
      }
    } catch (cause) {
      setError(cause instanceof ApiRequestError && cause.status === 429
        ? `Rate limit: a notice for this incident was approved in the last ${policy.rateLimit.minimumSpacingMinutes} minutes, or ${policy.rateLimit.dailyLimit} in the last day. Reference: ${cause.correlationId}`
        : cause instanceof ApiRequestError && cause.code === 'STATUS_NOTICE_SELF_APPROVAL_REFUSED'
          ? `You drafted this notice and someone else can approve it, so they must. Reference: ${cause.correlationId}`
          : cause instanceof ApiRequestError && cause.code === 'STATUS_NOTICE_SOLO_COOLING_OFF'
            ? `The solo cooling-off has not passed: you can approve your own notice from ${when(action.kind === 'approveNotice' ? action.notice.soloApprovalAvailableAt : null)}. Reference: ${cause.correlationId}`
            : formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };

  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="communications-action-title">
      <h2 id="communications-action-title">{title}</h2>
      <dl><div><dt>Approval</dt><dd>{approvalLine}</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : 'Confirm'}</button>
        </div>
      </form>
    </section>
  </div>;
}
