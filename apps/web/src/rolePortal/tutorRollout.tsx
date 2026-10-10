/**
 * "Tutor by college" panel on AI Operations (ENG-25): the AI tutor per college, and the pilot's two groups.
 *
 * Why it exists: for real students the tutor is a pilot, switched on one college at a time, with the
 * consenting students of each college split at random into a tutor group and a no-tutor group so the pilot
 * can be evaluated. Operators see every college's state, each experiment's two group sizes and their
 * practice counters (groups under five withheld, never a student), and switch a college on — which files an
 * approval bound to the tutor's model, prompt and passing evaluation, carried out from Settings → Approvals —
 * or off, immediately. The server decides every rule; this panel shows what it says. A section of the existing
 * AI Operations page; no navigation change, no new styles.
 *
 * Design: docs/architecture/tutor-rollout-design.md
 */
import { useEffect, useRef, useState } from 'react';
import {
  disableTutorForCollege,
  getAiOperationsPolicy,
  listTutorColleges,
  type TutorCollegeDto,
  type TutorCollegesDto,
  type TutorGroupSummaryDto,
  type TutorPilotMetricKey,
} from '../api/aiOperations.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';

const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const METRIC_LABELS: readonly (readonly [TutorPilotMetricKey, string])[] = [
  ['STEPS_STARTED', 'Steps started'], ['QUESTIONS_ANSWERED', 'Questions answered'], ['QUESTIONS_CORRECT', 'Answered right'],
  ['ANSWERS_ASSISTED', 'Right after hint 3 or 4'], ['STEPS_COMPLETED', 'Steps completed'], ['WRITTEN_HINTS_SHOWN', 'Written hints shown'],
  ['TUTOR_HINTS_REQUESTED', 'AI hints asked for'], ['TUTOR_HINTS_SHOWN', 'AI hints shown'], ['TUTOR_HINTS_FALLBACK', 'AI hints replaced by the written hint'],
];

function assignedText(group: TutorGroupSummaryDto): string {
  return group.assigned.suppressed || group.assigned.value === null ? '<5' : group.assigned.value.toLocaleString();
}

function metricText(group: TutorGroupSummaryDto, key: TutorPilotMetricKey): string {
  return group.metrics ? group.metrics[key].toLocaleString() : 'Withheld (<5)';
}

type Dialog = { readonly kind: 'on' | 'off'; readonly college: TutorCollegeDto };

export function TutorCollegesPanel({ token }: { readonly token: string }): React.ReactElement {
  const [list, setList] = useState<TutorCollegesDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reasons, setReasons] = useState<{ readonly enable: readonly string[]; readonly disable: readonly string[] }>({ enable: [], disable: [] });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(false);
    listTutorColleges(token, controller.signal)
      // A response without the list is shown as NA, never guessed at.
      .then((loaded) => { if (!Array.isArray(loaded?.colleges) || !loaded.status) throw new Error('unexpected tutor colleges response'); setList(loaded); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof Error && cause.message === 'unexpected tutor colleges response') setUnavailable(true);
        else setError(formatApiError(cause, 'Unable to load the tutor by college.'));
      });
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    const controller = new AbortController();
    // The reason codes come from the AI Operations policy.
    getAiOperationsPolicy(token, controller.signal)
      .then((policy) => setReasons({ enable: policy.reasons.tutorCollegeEnable ?? [], disable: policy.reasons.tutorCollegeDisable ?? [] }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  const status = list?.status;
  const viewer = list?.viewer ?? { canStop: false, canConfigure: false };
  const blockers: string[] = status ? [
    ...(status.featureRegistered ? [] : ['the tutor feature (tutor.hint) is not registered on this server']),
    ...(status.evaluationPasses ? [] : ['no passing evaluation is recorded for the tutor’s current model and prompt']),
    ...(status.killSwitchEngaged ? ['the kill switch is engaged'] : []),
  ] : [];
  const done = (message: string): void => { setDialog(null); setNotice(message); setError(''); setReload((value) => value + 1); };

  return <section className="role-card role-wide" aria-label="Tutor by college"><h2>Tutor by college</h2>
    <p>For real students the AI tutor is a pilot, switched on one college at a time. In a switched-on college, each student who agrees to AI tutoring is placed once, at random, in the tutor group or the no-tutor group, so the pilot can compare them. The no-tutor group sees ONE exactly as it is with AI off. Groups of fewer than five students are shown as &lt;5 with their counts withheld; no student is ever named here.</p>
    {status ? <dl>
      <div><dt>This server serves the tutor pilot</dt><dd>{status.pilotAudience ? 'Yes' : 'No — set on the server by Divakar (ONE_AI_TUTOR_AUDIENCE=pilot)'}</dd></div>
      <div><dt>Tutor feature (tutor.hint)</dt><dd>{status.featureRegistered ? (status.featureEnabled ? 'On' : 'Off') : 'NA — not registered'}</dd></div>
      <div><dt>Passing evaluation</dt><dd>{status.evaluationPasses ? 'Recorded' : 'None recorded'}</dd></div>
    </dl> : null}
    {blockers.length ? <p><small>No college can be switched on while {blockers.join(', and ')}.</small></p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {unavailable ? <p>NA — the tutor by college could not be read right now.</p> : null}
    {list === null && !error && !unavailable ? <p>Loading the tutor by college…</p> : null}
    {list && !list.colleges.length ? <V2EmptyState icon="🏫" title="No colleges yet" note="Colleges appear here once they are added in Operations → Organizations." /> : null}
    {list && list.colleges.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>College</th><th>Tutor</th><th>Tutor group</th><th>No-tutor group</th><th>Actions</th></tr></thead>
      <tbody>{list.colleges.map((college) => <tr key={college.institutionId}>
        <td><strong>{college.institutionName}</strong>{college.rollout ? <><br /><small>Experiment since {when(college.rollout.createdAt)} · {college.rollout.tutorSharePercent}% tutor group · {college.rollout.assignmentMethod}</small></> : null}</td>
        <td><StatusBadge label={college.rollout?.enabled ? 'On' : 'Off'} tone={college.rollout?.enabled ? 'success' : 'neutral'} />
          {college.rollout ? <><br /><small>Last changed {when(college.rollout.changedAt)}{college.rollout.lastReasonCode ? ` · ${college.rollout.lastReasonCode}` : ''}</small>
            {college.rollout.enabledModel ? <><br /><small>Approved for {college.rollout.enabledModel}, prompt {college.rollout.enabledPrompt ?? 'NA'}</small></> : null}</> : <><br /><small>Never switched on</small></>}</td>
        {(['TUTOR', 'NO_TUTOR'] as const).map((name) => <td key={name}>{college.rollout ? <GroupCell group={college.rollout.groups[name]} days={list.days} /> : 'NA'}</td>)}
        <td><div className="role-actions">
          {viewer.canStop && college.rollout?.enabled ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: 'off', college })}>Switch off…</button> : null}
          {viewer.canConfigure && !college.rollout?.enabled ? <button type="button" className="secondary" disabled={blockers.length > 0}
            onClick={() => setDialog({ kind: 'on', college })}>Switch on…</button> : null}
        </div></td>
      </tr>)}</tbody></table></div> : null}
    {dialog?.kind === 'on' ? <RequestApprovalDialog token={token} actionKey="AI_TUTOR_COLLEGE_ENABLE" payload={{ institutionId: dialog.college.institutionId }}
      {...(reasons.enable.length ? { reasons: reasons.enable } : {})}
      title={`Switch the AI tutor on for ${dialog.college.institutionName}`}
      details={[['Who gets it', 'Students of this college who agree to AI tutoring and are placed in the tutor group. Placement is at random, once, and recorded.'],
        ['Also needed', 'The tutor feature switched on, the kill switch released, and this server set to serve the pilot.'],
        ['Approval', 'Bound to the tutor’s current model, prompt and passing evaluation — a later change needs a new approval.']]}
      onCancel={() => setDialog(null)} onFiled={done} /> : null}
    {dialog?.kind === 'off' ? <SwitchOffDialog college={dialog.college} reasons={reasons.disable}
      onCancel={() => setDialog(null)}
      onConfirm={async (reasonCode) => { await disableTutorForCollege(token, dialog.college.institutionId, { reasonCode }); done(`The AI tutor is switched off for ${dialog.college.institutionName}.`); }} /> : null}
  </section>;
}

function GroupCell({ group, days }: { readonly group: TutorGroupSummaryDto; readonly days: number }): React.ReactElement {
  return <>
    <strong>{assignedText(group)}</strong> students
    {group.metrics ? <details><summary>Last {days} days</summary><dl>
      {METRIC_LABELS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{metricText(group, key)}</dd></div>)}
    </dl></details> : <><br /><small>Counts withheld (&lt;5 students)</small></>}
  </>;
}

function SwitchOffDialog({ college, reasons, onCancel, onConfirm }: {
  readonly college: TutorCollegeDto; readonly reasons: readonly string[]; readonly onCancel: () => void; readonly onConfirm: (reasonCode: string) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await onConfirm(reasonCode);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be made.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="tutor-off-title">
      <h2 id="tutor-off-title">Switch the AI tutor off for {college.institutionName}</h2>
      <dl>
        <div><dt>Effect</dt><dd>Its students see no AI tutor from their next screen; a hint being written is replaced by the written hint.</dd></div>
        <div><dt>The groups</dt><dd>Stay recorded. Switching on again keeps every student in the same group.</dd></div>
        <div><dt>Approval</dt><dd>Not needed — takes effect immediately.</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : 'Switch off'}</button>
        </div>
      </form>
    </section>
  </div>;
}
