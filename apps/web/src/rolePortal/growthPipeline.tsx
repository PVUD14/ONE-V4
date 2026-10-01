/**
 * ONE · Role portal — the college pipeline on a lead (GROWTH-04; design §6), and the Operations →
 * Organizations "Growth handoffs" section.
 *
 * On a lead: the stage, the moves the server allows (a backward move, a hold and a loss each need a
 * reason), the handoff request once the agreement is reported (the contract reference the college
 * gave, and which contacts to hand over), the requests so far, and — once operations has linked the
 * college — the milestones read from Operations' own records. A milestone with no source says NA;
 * the student-activation count says "<5" below five. No student, amount or contract text appears.
 *
 * In Operations (OPS_ORG_MANAGE): the open requests, each linked to a college the operator created
 * with Add Organization above, or declined with a reason. Contacts are shown masked; the link moves
 * them to the college's account on the server.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  declineGrowthHandoff,
  getGrowthLeadPipeline,
  getProtectedAccessToken,
  linkGrowthHandoff,
  listGrowthHandoffs,
  moveGrowthLeadStage,
  requestGrowthHandoff,
  type GrowthHandoffQueueItemDto,
  type GrowthLeadContactDto,
  type GrowthLeadPipelineDto,
  type GrowthMilestoneDto,
  type OrganizationManagementDto,
} from '../api.js';
import { V2Chip } from '../dashboardsV2.js';
import { growthCodeLabel } from './growthLeads.js';
import { formatApiError } from './shared.js';

const NA = 'NA';

const milestoneLabels: Readonly<Record<string, string>> = {
  HANDED_OFF: 'Handed off to operations',
  CONTRACT_RECORDED: 'Contract recorded by operations',
  VERIFIED: 'College verified',
  ADMIN_JOINED: 'College administrator joined',
  DATA_TERMS_ACCEPTED: 'Data-processing terms accepted',
  FIRST_ROSTER: 'First students rostered',
  STUDENTS_ACTIVATING: 'Students activating',
  FIRST_PAYMENT_CLEARED: 'First payment cleared',
  EXITED: 'College left ONE',
};

function pipelineError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    if (cause.code === 'GROWTH_STAGE_CHANGED') return 'The stage changed since you opened this lead. It has been reloaded; choose again.';
    if (cause.code === 'GROWTH_STAGE_REASON_REQUIRED') return 'Choose a reason for this move.';
    if (cause.code === 'GROWTH_CONTRACT_REFERENCE_INVALID') return 'Enter the agreement reference the college gave you (letters, digits and / _ . : - only; no amounts or names).';
    if (cause.code === 'GROWTH_HANDOFF_NEEDS_AGREEMENT') return 'Report the agreement signed first.';
    if (cause.code === 'GROWTH_HANDOFF_NOT_AN_INSTITUTION') return 'A college lead can be linked only to an institution.';
    if (cause.code === 'GROWTH_ORGANIZATION_ALREADY_LINKED') return 'That organisation is already linked to another lead.';
  }
  return formatApiError(cause, fallback);
}

function milestoneValue(milestone: GrowthMilestoneDto): string {
  if (milestone.state === 'NA') return NA;
  if (milestone.code === 'STUDENTS_ACTIVATING' && milestone.count) return milestone.count.suppressed ? '<5' : String(milestone.count.value);
  if (milestone.state === 'REACHED') return milestone.at ? new Date(milestone.at).toLocaleDateString() : 'Reached';
  return 'Not yet';
}

export function LeadPipelinePanel({ leadId, token, contacts, onChanged }: {
  readonly leadId: string; readonly token: string; readonly contacts: readonly GrowthLeadContactDto[]; readonly onChanged: () => void;
}): React.ReactElement {
  const [pipeline, setPipeline] = useState<GrowthLeadPipelineDto | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [handover, setHandover] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    getGrowthLeadPipeline(token, leadId, controller.signal)
      .then((result) => {
        // An answer without the pipeline's shape is treated like no answer: nothing is guessed.
        if (!Array.isArray(result.nextStages) || !Array.isArray(result.handoffRequests) || !result.vocabulary) throw new Error('malformed pipeline');
        setPipeline(result); setError('');
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(pipelineError(cause, 'The pipeline could not be loaded.')); });
    return () => controller.abort();
  }, [leadId, token, reload]);

  if (!pipeline) return <div aria-label="Pipeline"><h3>Pipeline</h3>{error ? <p className="form-error" role="alert">{error}</p> : <p className="v2-empty">Loading…</p>}</div>;
  const working = pipeline.vocabulary.reasons;
  const reasons = target === 'LOST' ? working.lost : target === 'ON_HOLD' ? working.hold : working.backward;
  const needsReason = target === 'LOST' || target === 'ON_HOLD';

  async function submit(action: () => Promise<GrowthLeadPipelineDto>): Promise<void> {
    setBusy(true);
    try {
      setPipeline(await action());
      key.current = crypto.randomUUID();
      setTarget(''); setReason(''); setError('');
      onChanged();
    } catch (cause) {
      setError(pipelineError(cause, 'The change could not be saved.'));
      if (cause instanceof ApiRequestError && cause.code === 'GROWTH_STAGE_CHANGED') setReload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return <div aria-label="Pipeline">
    <h3>Pipeline</h3>
    <div className="v2-hero-chips">
      <V2Chip tone="blue">{growthCodeLabel(pipeline.stage)}</V2Chip>
      {pipeline.lostReasonCode ? <V2Chip tone="red">Lost: {growthCodeLabel(pipeline.lostReasonCode)}</V2Chip> : null}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {pipeline.nextStages.length ? <div className="role-actions" aria-label="Move stage">
      <label>Move to<select aria-label="Next stage" value={target} onChange={(event) => { setTarget(event.target.value); setReason(''); }}>
        <option value="">Choose…</option>
        {pipeline.nextStages.map((stage) => <option key={stage} value={stage}>{stage === 'RESUME' ? 'Resume (back to where it was)' : growthCodeLabel(stage)}</option>)}
      </select></label>
      {target && target !== 'RESUME' ? <label>Reason{needsReason ? '' : ' (needed to move back)'}<select aria-label="Stage reason" value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">{needsReason ? 'Reason…' : 'None (moving forward)'}</option>
        {reasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
      </select></label> : null}
      <button type="button" className="pilot-btn" disabled={!target || (needsReason && !reason) || busy}
        onClick={() => void submit(() => moveGrowthLeadStage(token, leadId, { fromStage: pipeline.stage, toStage: target, ...(reason ? { reasonCode: reason } : {}) }, key.current))}>Move</button>
    </div> : pipeline.stage === 'HANDOFF_REQUESTED' && !pipeline.milestones ? <p className="v2-empty">Waiting for operations to onboard the college. The stage moves again only if they decline the request.</p> : null}

    {pipeline.canRequestHandoff ? <fieldset aria-label="Request the handoff"><legend>Hand the college to operations</legend>
      <p className="v2-empty">Operations creates and verifies the college; you report the agreement and choose whom to hand over. Their contact details move to the college&apos;s account and are erased from this lead.</p>
      <div className="role-actions">
        <label>Agreement reference the college gave you<input aria-label="Agreement reference" value={reference} maxLength={64} onChange={(event) => setReference(event.target.value)} /></label>
      </div>
      {contacts.length ? <ul className="role-check-list">{contacts.map((contact) => <li key={contact.id}><label>
        <input type="checkbox" checked={handover.includes(contact.id)} onChange={(event) => setHandover(event.target.checked ? [...handover, contact.id] : handover.filter((id) => id !== contact.id))} />
        {' '}{contact.fullName} ({growthCodeLabel(contact.role)})</label></li>)}</ul> : <p className="v2-empty">No contacts to hand over.</p>}
      <button type="button" className="pilot-btn" disabled={!reference.trim() || busy}
        onClick={() => void submit(() => requestGrowthHandoff(token, leadId, { contractReference: reference.trim(), contactIds: handover }, key.current))}>Request the handoff</button>
    </fieldset> : null}

    {pipeline.handoffRequests.length ? <>
      <h4>Handoff requests</h4>
      <ul>{pipeline.handoffRequests.map((item) => <li key={item.id}>
        {item.requestedAt ? new Date(item.requestedAt).toLocaleDateString() : NA}: {growthCodeLabel(item.state)} · reference {item.contractReferenceReported}
        {item.declineReasonCode ? ` · declined: ${growthCodeLabel(item.declineReasonCode)}` : ''}
        {item.state === 'LINKED' ? ` · ${item.contactsCarried ?? 0} contact(s) moved to the college's account` : ''}
      </li>)}</ul>
    </> : null}

    {pipeline.milestones ? <>
      <h4>Onboarding</h4>
      <div className="v2-list" aria-label="Onboarding milestones">{pipeline.milestones.map((milestone) => (
        <div key={milestone.code} className="v2-list-row">
          <span className="v2-tile teal" aria-hidden="true">{milestone.state === 'REACHED' ? '✓' : milestone.state === 'NA' ? '–' : '…'}</span>
          <div className="grow"><strong>{milestoneLabels[milestone.code] ?? growthCodeLabel(milestone.code)}</strong>{milestone.note ? <small>{milestone.note}</small> : null}</div>
          <V2Chip tone={milestone.state === 'REACHED' ? 'green' : milestone.state === 'NA' ? 'slate' : 'amber'}>{milestoneValue(milestone)}</V2Chip>
        </div>
      ))}</div>
      <small>Read from operations&apos; records each time; nothing here names a student or shows an amount.</small>
    </> : null}
  </div>;
}

/** Operations → Organizations: the growth handoff queue (OPS_ORG_MANAGE). Renders nothing for anyone else. */
export function GrowthHandoffsSection({ organizations, onLinked }: { readonly organizations: readonly OrganizationManagementDto[]; readonly onLinked?: () => void }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [queue, setQueue] = useState<{ readonly requests: readonly GrowthHandoffQueueItemDto[]; readonly declineReasons: readonly string[] } | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [choice, setChoice] = useState<Readonly<Record<string, { readonly org: string; readonly reason: string }>>>({});
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    listGrowthHandoffs(token, controller.signal).then((result) => {
      if (!Array.isArray(result.requests) || !Array.isArray(result.declineReasons)) throw new Error('malformed queue');
      setQueue(result); setLoadError(false);
    })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
        else setLoadError(true);
      });
    return () => controller.abort();
  }, [token, reload]);

  if (!token || forbidden) return null;
  const institutions = organizations.filter((org) => org.kind === 'INSTITUTION');
  async function act(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      setNotice(done); setError('');
      setReload((value) => value + 1);
      onLinked?.();
    } catch (cause) {
      setError(pipelineError(cause, 'The decision could not be saved.'));
    } finally {
      setBusy(false);
    }
  }
  return <section className="role-card role-wide" aria-label="Growth handoffs">
    <h2>Growth handoffs</h2>
    <p>Colleges a growth person reports as signed. Create the college with Add Organization above (it starts pending), then link the request to it here; verification, the initial administrator and the account stay as they are. Contacts marked for handover move to the college&apos;s account and are erased from the lead.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!queue ? <p>{loadError ? 'The growth handoff queue could not be loaded. Try again shortly.' : 'Loading…'}</p> : queue.requests.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <caption className="sr-only">Open growth handoff requests</caption>
      <thead><tr><th>College lead</th><th>Requested</th><th>Agreement reference reported</th><th>Contacts to hand over</th><th>Decision</th></tr></thead>
      <tbody>{queue.requests.map((item) => {
        const picked = choice[item.leadId] ?? { org: '', reason: '' };
        return <tr key={item.id} className="role-record-row">
          <th scope="row"><strong>{item.leadName}</strong><span>{[item.area.city, item.area.districtName, item.area.stateName].filter(Boolean).join(', ') || 'Area not set'}</span>
            <small>{item.aisheCode ? `AISHE ${item.aisheCode} · ` : ''}Owner {item.owner ?? 'none'}</small></th>
          <td>{item.requestedAt ? new Date(item.requestedAt).toLocaleDateString() : NA}<br /><small>{item.requestedBy ?? NA}</small></td>
          <td>{item.contractReferenceReported}<br /><small>Confirm it by recording it on the college&apos;s account.</small></td>
          <td>{item.contacts.length ? item.contacts.map((contact) => <div key={contact.id}>{contact.fullName} · {growthCodeLabel(contact.accountRole)}<br /><small>{[contact.email, contact.phone].filter(Boolean).join(' · ')}</small></div>) : 'None'}</td>
          <td><div className="role-record-actions">
            <label><span>College</span><select aria-label={`College for ${item.leadName}`} value={picked.org} onChange={(event) => setChoice({ ...choice, [item.leadId]: { ...picked, org: event.target.value } })}>
              <option value="">Choose…</option>{institutions.map((org) => <option key={org.id} value={org.id}>{org.profile.displayName || org.legalName}</option>)}
            </select></label>
            <button type="button" disabled={!picked.org || busy} onClick={() => void act(() => linkGrowthHandoff(token, item.leadId, { organizationId: picked.org }), `${item.leadName} linked. Its contacts moved to the account.`)}>Link</button>
            <label><span>Decline reason</span><select aria-label={`Decline reason for ${item.leadName}`} value={picked.reason} onChange={(event) => setChoice({ ...choice, [item.leadId]: { ...picked, reason: event.target.value } })}>
              <option value="">Reason…</option>{queue.declineReasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
            </select></label>
            <button type="button" className="secondary" disabled={!picked.reason || busy} onClick={() => void act(() => declineGrowthHandoff(token, item.leadId, { reasonCode: picked.reason }), `${item.leadName} declined; it is back in negotiation.`)}>Decline</button>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div> : <p>No growth handoff is waiting.</p>}
  </section>;
}
