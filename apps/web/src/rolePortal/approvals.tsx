/**
 * ONE · Role portal — Operations Settings: Approvals (OPS-02, Appendix 1 §5.4).
 *
 * The queue of dual-control requests for high-risk actions, with decision buttons for
 * approvers and an Execute button for a requester whose request was approved, plus the
 * confirm dialog the high-risk buttons elsewhere open to file a request.
 *
 * The server decides everything — who may approve, the solo safeguard, expiry and the
 * payload binding. This screen shows what the server says and never guesses: the Execute
 * button replays the stored payload to the action's own endpoint with the approvalId.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  changeAiFeatureLimits,
  decideOperationApproval,
  enableAiFeature,
  getApprovalPolicy,
  getProtectedAccessToken,
  grantStaffCapability,
  listOperationApprovals,
  publishCareerRequirementSet,
  publishBankQuestionRevision,
  publishEditorLessonRevision,
  publishSkillRevision,
  publishStatusNoticeTemplate,
  releasePrivacyHold,
  requestOperationApproval,
  setFeatureFlagState,
  supersedeOutboxBacklog,
  transitionOrganizationVerification,
} from '../api.js';
import type { ApprovalPolicyDto, HighRiskActionKey, OperationApprovalDto, OperationApprovalQueueDto } from '../api.js';
import { purgeInstitutionOffboarding } from '../api/institutionContract.js';
import { clearCollegePayment, formatPaise } from '../api/collegePayments.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const noteLimit = 500;
const states = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'EXECUTED', label: 'Executed' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: '', label: 'All' },
] as const;

/** A plain sentence for the action; identifiers are never shown. */
export function describeApproval(approval: OperationApprovalDto): string {
  const summary = approval.summary;
  switch (approval.actionKey) {
    case 'ORGANIZATION_SUSPEND': return `Suspend ${summary.organizationName ?? 'NA'}`;
    case 'FEATURE_FLAG_HIGH_RISK_CHANGE': return `${summary.enabled ? 'Enable' : 'Disable'} flag ${summary.flagKey ?? 'NA'}`;
    case 'OUTBOX_BACKLOG_SUPERSEDE': return `Supersede pending events older than ${summary.olderThan ? new Date(summary.olderThan).toLocaleString() : 'NA'} (up to ${summary.limit ?? 'NA'})`;
    case 'PRIVACY_HOLD_RELEASE': return `Release a legal hold (${summary.holdReason ?? 'NA'})`;
    case 'CAPABILITY_GRANT_HIGH_RISK': return `Grant ${summary.capability ?? 'NA'} to ${summary.memberEmail ?? 'NA'}`;
    case 'CAREER_REQUIREMENT_SET_PUBLISH':
      return `Publish requirement set v${summary.careerSetVersion ?? 'NA'} for ${summary.careerRoleCatalogueCode ? `${summary.careerRoleCatalogueCode} ` : ''}${summary.careerRoleTitle ?? 'NA'} as ${summary.releaseLabel === 'VERIFIED' ? 'Verified' : 'Not yet verified'}`;
    case 'CONTENT_SKILL_PUBLISH':
      return `Publish revision ${summary.skillRevision ?? 'NA'} of the skill ${summary.skillName ?? 'NA'} (${summary.skillKey ?? 'NA'})`;
    case 'CONTENT_QUESTION_PUBLISH':
      return `Publish revision ${summary.questionRevision ?? 'NA'} of the question ${summary.questionKey ?? 'NA'} to the readiness check`;
    case 'CONTENT_LESSON_PUBLISH':
      return `Publish revision ${summary.lessonRevision ?? 'NA'} of the lesson ${summary.lessonKey ?? 'NA'} (${summary.lessonVariant ?? 'NA'})`;
    case 'COMMS_TEMPLATE_PUBLISH':
      return `Publish version ${summary.commsTemplateVersion ?? 'NA'} of the status notice template ${summary.commsTemplateKey ?? 'NA'}`;
    case 'AI_FEATURE_ENABLE':
      return `Switch on the AI feature ${summary.aiFeatureKey ?? 'NA'} (model ${summary.aiModel ?? 'NA'}, prompt ${summary.aiPromptKey ?? 'NA'} v${summary.aiPromptVersion ?? 'NA'})`;
    case 'AI_FEATURE_LIMITS_RAISE':
      return `Raise the limits of the AI feature ${summary.aiFeatureKey ?? 'NA'} to ${summary.aiCap ?? 'NA'} per ${summary.aiCapWindow === 'MONTH' ? 'month' : 'day'}, input up to ${summary.aiMaxInputChars ?? 'NA'} characters`;
    case 'INSTITUTION_DATA_PURGE':
      return `Delete the records of ${summary.organizationName ?? 'NA'}, which has left ONE`;
    case 'INSTITUTION_PAYMENT_CLEARANCE':
      return `Record as cleared on ${summary.paymentClearedOn ?? 'NA'}: ${summary.organizationName ?? 'NA'}'s ${(summary.paymentInstrument ?? 'NA').replaceAll('_', ' ').toLowerCase()} ${summary.paymentReference ?? 'NA'} of ${typeof summary.paymentAmountPaise === 'number' ? formatPaise(summary.paymentAmountPaise) : 'NA'} for ${summary.paymentStudentsPaid ?? 'NA'} students, received ${summary.paymentReceivedOn ?? 'NA'}`;
  }
}

const stateTone = (state: OperationApprovalDto['state']): 'success' | 'warning' | 'neutral' | 'info' =>
  state === 'APPROVED' || state === 'EXECUTED' ? 'success' : state === 'PENDING' ? 'warning' : state === 'REJECTED' ? 'neutral' : 'info';

/** Carry out an approved request through the action's own endpoint, with the stored payload. */
async function executeApproval(token: string, approval: OperationApprovalDto): Promise<void> {
  const payload = approval.payload;
  const reasonCode = String(payload.reasonCode);
  const approvalId = approval.id;
  switch (approval.actionKey) {
    case 'ORGANIZATION_SUSPEND':
      await transitionOrganizationVerification(token, String(payload.organizationId), 'SUSPENDED', { reasonCode, approvalId }); return;
    case 'FEATURE_FLAG_HIGH_RISK_CHANGE':
      await setFeatureFlagState(token, String(payload.key), payload.enabled === true, reasonCode, approvalId); return;
    case 'OUTBOX_BACKLOG_SUPERSEDE':
      await supersedeOutboxBacklog(token, { olderThan: String(payload.olderThan), limit: Number(payload.limit), reasonCode, approvalId }); return;
    case 'PRIVACY_HOLD_RELEASE':
      await releasePrivacyHold(token, String(payload.holdId), { reasonCode, approvalId }); return;
    case 'CAPABILITY_GRANT_HIGH_RISK':
      await grantStaffCapability(token, String(payload.membershipId), {
        capability: String(payload.capability), reasonCode, ...(typeof payload.note === 'string' ? { note: payload.note } : {}), approvalId,
      }); return;
    case 'CAREER_REQUIREMENT_SET_PUBLISH':
      await publishCareerRequirementSet(token, String(payload.setId), { releaseLabel: String(payload.releaseLabel), reasonCode, approvalId }); return;
    case 'CONTENT_SKILL_PUBLISH':
      await publishSkillRevision(token, String(payload.revisionId), { reasonCode, approvalId }); return;
    case 'CONTENT_QUESTION_PUBLISH':
      await publishBankQuestionRevision(token, String(payload.revisionId), { reasonCode, approvalId }); return;
    case 'CONTENT_LESSON_PUBLISH':
      await publishEditorLessonRevision(token, String(payload.revisionId), { reasonCode, approvalId }); return;
    case 'COMMS_TEMPLATE_PUBLISH':
      await publishStatusNoticeTemplate(token, String(payload.templateId), { reasonCode, approvalId }); return;
    case 'AI_FEATURE_ENABLE':
      await enableAiFeature(token, String(payload.featureKey), { reasonCode, approvalId }); return;
    case 'AI_FEATURE_LIMITS_RAISE':
      await changeAiFeatureLimits(token, String(payload.featureKey), {
        cap: Number(payload.cap), capWindow: payload.capWindow === 'MONTH' ? 'MONTH' : 'DAY', maxInputChars: Number(payload.maxInputChars), reasonCode, approvalId,
      }); return;
    case 'INSTITUTION_DATA_PURGE':
      await purgeInstitutionOffboarding(token, String(payload.offboardingId), { reasonCode, approvalId }); return;
    case 'INSTITUTION_PAYMENT_CLEARANCE':
      await clearCollegePayment(token, String(payload.paymentId), { clearedOn: String(payload.clearedOn), reasonCode, approvalId }); return;
  }
}

export function OperationsApprovalsPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<string>('PENDING');
  const [queue, setQueue] = useState<OperationApprovalQueueDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [deciding, setDeciding] = useState<{ readonly approval: OperationApprovalDto; readonly decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [executing, setExecuting] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    listOperationApprovals(token, state || undefined, null, controller.signal)
      .then((result) => { setQueue(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load approvals.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, state, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1>Approvals</h1>
    <p>High-risk actions — suspending an organisation, high-risk feature flags, superseding the event backlog, releasing a legal hold, granting high-risk capabilities and publishing a career requirement set — need a second person&apos;s approval. An approval is bound to the exact action, expires after 24 hours and is used once, by the person who asked.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The approvals queue is for staff who can perform or approve high-risk actions. Your access has not changed."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const approvals = queue?.approvals ?? [];
  const execute = async (approval: OperationApprovalDto): Promise<void> => {
    setExecuting(approval.id);
    try {
      await executeApproval(token, approval);
      setNotice(`Done: ${describeApproval(approval)}.`);
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The approved action could not be carried out.'));
    } finally {
      setExecuting('');
    }
  };

  return <section className="role-module role-module--dense">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🛡️" tone="teal" value={queue ? queue.approverCount : 'NA'} label="People who can approve" />
      <V2Stat icon="⏳" tone="amber" value={queue ? (queue.soloSafeguardActive ? 'On' : 'Off') : 'NA'} label="Solo safeguard" />
      <V2Stat icon="📋" tone="blue" value={queue ? approvals.length : 'NA'} label="Requests in this view" />
      <V2Stat icon="👤" tone="purple" value={queue ? (queue.viewerIsApprover ? 'Approver' : 'Requester') : 'NA'} label="Your part" />
    </div>
    {queue?.soloSafeguardActive ? <p className="role-wide">Only one person can approve right now, so they may approve their own request 15 minutes after filing it. Each such approval is marked SOLO in the audit record; this switches off by itself when a second approver exists.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><h2>Requests</h2>
      <label className="role-local-search"><span>Show</span>
        <select value={state} onChange={(event) => setState(event.target.value)} aria-label="Approval state">
          {states.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
        </select></label>
      {loading && !queue ? <p>Loading approvals…</p> : null}
      {!loading && queue && !approvals.length ? <V2EmptyState icon="✅" title="Nothing here"
        note={state === 'PENDING' ? 'No high-risk action is waiting for a decision.' : 'No requests match this view.'} /> : null}
      {approvals.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Action</th><th>Requested by</th><th>Reason</th><th>State</th><th>Expires</th><th>Decision</th><th>Actions</th></tr></thead>
        <tbody>{approvals.map((approval) => <tr key={approval.id}>
          <td><strong>{approval.actionLabel}</strong><br />{describeApproval(approval)}{approval.note ? <><br /><small>{approval.note}</small></> : null}</td>
          <td>{approval.requestedBy.email}{approval.requestedBy.isSelf ? <><br /><small>You</small></> : null}<br /><small>{new Date(approval.requestedAt).toLocaleString()}</small></td>
          <td>{approval.reasonCode}</td>
          <td><StatusBadge label={approval.state} tone={stateTone(approval.state)} /></td>
          <td>{new Date(approval.expiresAt).toLocaleString()}</td>
          <td>{approval.decidedBy
            ? <>{approval.decidedBy.email} · {approval.decisionReasonCode}{approval.mode === 'SOLO' ? <><br /><StatusBadge label="SOLO" tone="warning" /></> : null}
              {approval.soloNotice === 'NOT_DELIVERED' ? <><br /><small>Notice not delivered — no email sender is configured.</small></> : null}
              {approval.soloNotice === 'QUEUED' ? <><br /><small>Notice queued for email delivery.</small></> : null}</>
            : 'None yet'}</td>
          <td><div className="role-actions">
            {approval.canApprove ? <button type="button" className="pilot-btn" onClick={() => setDeciding({ approval, decision: 'APPROVE' })}>Approve…</button> : null}
            {approval.canReject ? <button type="button" className="secondary" onClick={() => setDeciding({ approval, decision: 'REJECT' })}>Reject…</button> : null}
            {approval.approveRefusal === 'APPROVAL_SOLO_COOLING_OFF'
              ? <small>You can approve your own request from {new Date(approval.coolingOffEndsAt).toLocaleTimeString()} (solo).</small> : null}
            {approval.canExecute ? <button type="button" className="pilot-btn" disabled={executing === approval.id}
              onClick={() => void execute(approval)}>{executing === approval.id ? 'Working…' : 'Execute'}</button> : null}
          </div></td>
        </tr>)}</tbody></table></div> : null}
    </section>
    {deciding && queue ? <DecisionDialog token={token} approval={deciding.approval} decision={deciding.decision}
      reasons={queue.decisionReasons[deciding.decision]} onCancel={() => setDeciding(null)}
      onDone={(message) => { setDeciding(null); setNotice(message); setReload((value) => value + 1); }} /> : null}
  </section>;
}

function DecisionDialog({ token, approval, decision, reasons, onCancel, onDone }: {
  readonly token: string; readonly approval: OperationApprovalDto; readonly decision: 'APPROVE' | 'REJECT';
  readonly reasons: readonly string[]; readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const approve = decision === 'APPROVE';
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      const result = await decideOperationApproval(token, approval.id, { decision, reasonCode, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(`${approve ? 'Approved' : 'Rejected'}: ${describeApproval(approval)}.${result.approval.mode === 'SOLO' ? ' Recorded as a SOLO approval.' : ''}`);
    } catch (cause) {
      setError(formatApiError(cause, 'The decision could not be recorded.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="approval-decision-title">
      <h2 id="approval-decision-title">{approve ? 'Approve' : 'Reject'}: {approval.actionLabel}</h2>
      <dl>
        <div><dt>Action</dt><dd>{describeApproval(approval)}</dd></div>
        <div><dt>Requested by</dt><dd>{approval.requestedBy.email}</dd></div>
        <div><dt>Reason given</dt><dd>{approval.reasonCode}</dd></div>
        {approval.requestedBy.isSelf && approve ? <div><dt>Solo</dt><dd>You are approving your own request as the only approver. It will be marked SOLO in the audit record.</dd></div> : null}
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Note (optional, {noteLimit} characters) — do not include personal data</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : approve ? 'Confirm approval' : 'Confirm rejection'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/**
 * The confirm dialog every high-risk button opens: it says approval is required,
 * collects the reason code from the server's list for the action, and files the
 * request. The action itself happens later, from the Approvals queue.
 */
export function RequestApprovalDialog({ token, actionKey, payload, title, details, reasons: fixedReasons, onCancel, onFiled }: {
  readonly token: string;
  readonly actionKey: HighRiskActionKey;
  /** The action's payload without its reason code. */
  readonly payload: Record<string, unknown>;
  readonly title: string;
  readonly details: readonly (readonly [string, string])[];
  /** Reason codes, when the caller already has the list; otherwise loaded from the policy. */
  readonly reasons?: readonly string[];
  readonly onCancel: () => void;
  readonly onFiled: (message: string) => void;
}): React.ReactElement {
  const [policy, setPolicy] = useState<ApprovalPolicyDto | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, [policy]);
  useEffect(() => {
    const controller = new AbortController();
    getApprovalPolicy(token, controller.signal)
      .then(setPolicy)
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load the approval policy.')); });
    return () => controller.abort();
  }, [token]);
  const reasons = fixedReasons ?? policy?.actions?.find((action) => action.actionKey === actionKey)?.reasons ?? [];
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await requestOperationApproval(token, { actionKey, payload: { ...payload, reasonCode }, ...(note.trim() ? { note: note.trim() } : {}) });
      onFiled(`Approval requested: ${title}. It will run once approved — carry it out from Settings → Approvals.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The approval request could not be filed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="approval-request-title">
      <h2 id="approval-request-title">{title}</h2>
      <dl>
        {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        <div><dt>Approval</dt><dd>High-risk action: approval required from a second person with Approve High-Risk before it can run.
          {policy?.soloSafeguardActive ? ' Only one approver exists, so you may approve it yourself after 15 minutes; it will be marked SOLO.' : ''}</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Note (optional, {noteLimit} characters) — do not include personal data</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Filing…' : 'Request approval'}</button>
        </div>
      </form>
    </section>
  </div>;
}
