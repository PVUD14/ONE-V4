/**
 * ONE · Role portal — Operations: AI Operations console (OPS-12).
 *
 * Replaces the read-only status page under the existing AI Operations label (Appendix 1 §4.2; no
 * navigation change). Shows every AI feature with its switch, model, prompt version, cap and usage,
 * outcomes and failure classes, tokens in and out, usage over time and by organisation (groups under
 * 5 people withheld), prompt versions, and evaluation records — every figure from ONE AI
 * Orchestration's own tables, or NA. Cost is always NA: no price table exists.
 *
 * Stopping — a feature, the assistant, or everything through the global kill switch — is immediate
 * and needs only a reason. Switching on and widening a limit file an approval (Settings → Approvals)
 * and switching a feature on also needs a passing evaluation for its current model and prompt. The
 * assistant's server switch (ASSISTANT_ENABLED) is shown, never changed here. The server decides
 * every rule; this screen shows what it says. Within the AI hold: nothing here calls a model.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  changeAiFeatureLimits,
  disableAiAssistant,
  disableAiFeature,
  engageAiKillSwitch,
  getAiOperationsPolicy,
  getAiOperationsSummary,
  getProtectedAccessToken,
  listAiEvaluations,
  listAiUsage,
  listAiUsageByOrganization,
  recordAiEvaluation,
} from '../api.js';
import type {
  AiEvaluationDto,
  AiEvaluationMetricDto,
  AiFeatureDto,
  AiOperationsPolicyDto,
  AiOperationsSummaryDto,
  AiOrganizationUsageDto,
  AiPeriod,
  AiUsagePointDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { RequestApprovalDialog } from './approvals.js';

const noteLimit = 500;
const number = (value: number | null | undefined): string => (value === null || value === undefined ? 'NA' : value.toLocaleString());
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const windowLabel = (window: AiPeriod): string => (window === 'DAY' ? 'day' : 'month');

/** Lowering is ordinary; any increase, or a window change, needs an approval (the server decides the same). */
export function classifyLimits(current: { cap: number; capWindow: AiPeriod; maxInputChars: number }, next: { cap: number; capWindow: AiPeriod; maxInputChars: number }): 'UNCHANGED' | 'LOWER' | 'RAISE' {
  if (next.capWindow !== current.capWindow || next.cap > current.cap || next.maxInputChars > current.maxInputChars) return 'RAISE';
  if (next.cap === current.cap && next.maxInputChars === current.maxInputChars) return 'UNCHANGED';
  return 'LOWER';
}

type Dialog =
  | { readonly kind: 'engage' }
  | { readonly kind: 'release' }
  | { readonly kind: 'assistant-off' }
  | { readonly kind: 'assistant-on' }
  | { readonly kind: 'feature-off'; readonly feature: AiFeatureDto }
  | { readonly kind: 'feature-on'; readonly feature: AiFeatureDto }
  | { readonly kind: 'limits'; readonly feature: AiFeatureDto }
  | { readonly kind: 'limits-raise'; readonly feature: AiFeatureDto; readonly next: { cap: number; capWindow: AiPeriod; maxInputChars: number } }
  | { readonly kind: 'evaluation' };

export function OperationsAiOperationsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [period, setPeriod] = useState<AiPeriod>('DAY');
  const [policy, setPolicy] = useState<AiOperationsPolicyDto | null>(null);
  const [summary, setSummary] = useState<AiOperationsSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getAiOperationsPolicy(token, controller.signal).then(setPolicy).catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    getAiOperationsSummary(token, period, controller.signal)
      .then((result) => { setSummary(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load AI Operations.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, period, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Platform operations</span><h1>AI Operations</h1>
    <p>Every AI feature, its switch, cap and usage, and the evaluations that let it reach students — read from ONE AI Orchestration&apos;s own records. The AI hold is in force: no model provider is connected and nothing here runs a model. Stopping AI is immediate; switching anything on needs a second person&apos;s approval.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted" note="AI Operations is for staff who hold AI Operations View. Your access has not changed." hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const viewer = policy?.viewer ?? { canStop: false, canConfigure: false };
  const features = summary?.features ?? [];
  const killEngaged = summary?.killSwitch?.enabled ?? false;
  const done = (message: string): void => { setDialog(null); setNotice(message); setError(''); setReload((value) => value + 1); };

  return <section className="role-module role-module--dense" aria-label="AI Operations">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🛑" tone="amber" value={summary ? (summary.killSwitch ? (killEngaged ? 'Engaged' : 'Released') : 'NA') : 'NA'} label="Global AI kill switch" />
      <V2Stat icon="🤖" tone="teal" value={summary ? `${features.filter((feature) => feature.effectiveEnabled).length} of ${features.length}` : 'NA'} label="AI features running" />
      <V2Stat icon="✅" tone="blue" value={summary ? number(summary.totals.succeeded) : 'NA'} label={`Generations this ${windowLabel(period)}`} />
      <V2Stat icon="💸" tone="purple" value="NA" label="Cost (no price table)" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    <section className="role-card role-wide"><h2>Global AI kill switch</h2>
      <p>On means every AI feature and the in-app assistant are stopped. Engaging it switches every feature and the assistant off in one action, at once, with no approval. Releasing it needs a second person, and switches nothing back on.</p>
      {summary ? <p><StatusBadge label={killEngaged ? 'Engaged — AI stopped' : 'Released'} tone={killEngaged ? 'danger' : 'neutral'} /> <small>Last changed {when(summary.killSwitch?.lastChangedAt)}{summary.killSwitch?.lastReasonCode ? ` · ${summary.killSwitch.lastReasonCode}` : ''}</small></p> : null}
      {loading && !summary ? <p>Loading AI Operations…</p> : null}
      {summary && viewer.canStop ? <div className="role-actions">
        {killEngaged
          ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'release' })}>Release kill switch…</button>
          : <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: 'engage' })}>Engage kill switch…</button>}
      </div> : null}
    </section>

    <section className="role-card role-wide"><h2>In-app assistant</h2>
      <p>The assistant answers only when the server switch is on, a provider key is configured, the console switch is on and the kill switch is released. The server switch (ASSISTANT_ENABLED) is set on the server by Divakar and is never changed from here.</p>
      {summary ? <dl>
        <div><dt>Server switch (ASSISTANT_ENABLED)</dt><dd>{summary.assistant.serverSwitch ? 'On' : 'Off'}</dd></div>
        <div><dt>Provider key configured</dt><dd>{summary.assistant.providerKeyConfigured ? 'Yes' : 'No'}</dd></div>
        <div><dt>Console switch</dt><dd>{summary.assistant.consoleSwitch ? 'On' : 'Off'} <small>(last changed {when(summary.assistantFlag?.lastChangedAt)})</small></dd></div>
        <div><dt>Answering now</dt><dd><StatusBadge label={summary.assistant.answering ? 'Answering' : 'Off'} tone={summary.assistant.answering ? 'warning' : 'neutral'} /></dd></div>
      </dl> : null}
      {summary && viewer.canStop ? <div className="role-actions">
        {summary.assistant.consoleSwitch
          ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: 'assistant-off' })}>Switch assistant off…</button>
          : <button type="button" className="secondary" onClick={() => setDialog({ kind: 'assistant-on' })}>Switch assistant on…</button>}
      </div> : null}
    </section>

    <section className="role-card role-wide"><h2>AI features</h2>
      <label className="role-local-search"><span>Usage period</span>
        <select aria-label="Usage period" value={period} onChange={(event) => setPeriod(event.target.value === 'MONTH' ? 'MONTH' : 'DAY')}>
          <option value="DAY">Today</option><option value="MONTH">This month</option>
        </select></label>
      {summary && !features.length ? <V2EmptyState icon="🤖" title="No AI feature is registered"
        note="The AI hold is in force (ADR-030): no feature has been built on ONE AI Orchestration yet. Each one appears here when it is registered — switched off, with its own cap." /> : null}
      {features.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Feature</th><th>State</th><th>Model and prompt</th><th>Cap</th><th>Evaluation</th><th>Outcomes</th><th>Tokens in / out</th><th>Cost</th><th>Actions</th></tr></thead>
        <tbody>{features.map((feature) => <tr key={feature.featureKey}>
          <td><strong>{feature.featureKey}</strong><br /><small>{feature.description}</small></td>
          <td><StatusBadge label={feature.effectiveEnabled ? 'On' : feature.enabled ? 'Stopped by kill switch' : 'Off'} tone={feature.effectiveEnabled ? 'success' : 'neutral'} /></td>
          <td>{feature.model}<br /><small>{feature.prompt ? `Prompt ${feature.prompt.key} v${feature.prompt.version}` : 'Prompt: NA (not declared)'}</small></td>
          <td>{number(feature.usedInWindow)} of {number(feature.cap)} this {windowLabel(feature.capWindow)}<br /><small>Input up to {number(feature.maxInputChars)} characters</small></td>
          <td><StatusBadge label={feature.evaluation.state === 'NONE' ? 'None recorded' : feature.evaluation.state} tone={feature.evaluation.state === 'PASS' ? 'success' : feature.evaluation.state === 'FAIL' ? 'danger' : 'neutral'} />
            <br /><small>{when(feature.evaluation.decidedAt)}</small></td>
          <td>{number(feature.outcomes.succeeded)} succeeded<br />{number(feature.outcomes.refused)} refused · {number(feature.outcomes.failed)} failed</td>
          <td>{number(feature.tokens.input)} / {number(feature.tokens.output)}</td>
          <td>NA</td>
          <td><div className="role-actions">
            {viewer.canStop && feature.enabled ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: 'feature-off', feature })}>Switch off…</button> : null}
            {viewer.canConfigure && !feature.enabled ? <button type="button" className="secondary" disabled={killEngaged || feature.evaluation.state !== 'PASS'}
              onClick={() => setDialog({ kind: 'feature-on', feature })}>Switch on…</button> : null}
            {viewer.canConfigure && !feature.enabled && feature.evaluation.state !== 'PASS' ? <small>Needs a passing evaluation for {feature.model}{feature.prompt ? ` and prompt v${feature.prompt.version}` : ' and a declared prompt'}.</small> : null}
            {viewer.canConfigure && killEngaged && !feature.enabled ? <small>The kill switch is engaged.</small> : null}
            {viewer.canConfigure ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'limits', feature })}>Change limits…</button> : null}
          </div></td>
        </tr>)}</tbody></table></div> : null}
      {summary ? <p><small>{summary.cost.text}</small></p> : null}
    </section>

    <section className="role-card role-wide"><h2>Refusals and failures by class</h2>
      {summary && !summary.failureClasses.length ? <p>No refusals or failures this {windowLabel(period)}.</p> : null}
      {summary?.failureClasses?.length ? <table className="role-record-table"><thead><tr><th>Feature</th><th>Outcome</th><th>Class</th><th>Count</th></tr></thead>
        <tbody>{summary.failureClasses.map((row) => <tr key={`${row.featureKey}-${row.outcome}-${row.failureClass}`}><td>{row.featureKey}</td><td>{row.outcome}</td><td>{row.failureClass}</td><td>{number(row.count)}</td></tr>)}</tbody></table> : null}
    </section>

    <AiUsagePanel token={token} features={features} />
    <AiOrganizationUsagePanel token={token} period={period} />

    <section className="role-card role-wide"><h2>Prompt versions</h2>
      <p>Prompts live in code and are never edited in place. A feature is evaluated, and switched on, for one exact prompt version.</p>
      <h3>Registered in code</h3>
      {summary && !summary.prompts.registered.length ? <p>None yet — no feature has a prompt while the AI hold is in force.</p> : null}
      {summary?.prompts.registered.length ? <ul>{summary.prompts.registered.map((prompt) => <li key={`${prompt.key}@${prompt.version}`}>{prompt.key} v{prompt.version} — {prompt.purpose}</li>)}</ul> : null}
      <h3>Declared by features</h3>
      {summary && !summary.prompts.declared.length ? <p>No feature declares a prompt.</p> : null}
      {summary?.prompts.declared.length ? <ul>{summary.prompts.declared.map((prompt) => <li key={prompt.featureKey}>{prompt.featureKey}: {prompt.key} v{prompt.version}{prompt.registered ? '' : ' (not in the code registry)'}</li>)}</ul> : null}
      <h3>Run in the last 30 days</h3>
      {summary && !summary.prompts.inUse.length ? <p>No prompt has run in the last 30 days.</p> : null}
      {summary?.prompts.inUse.length ? <table className="role-record-table"><thead><tr><th>Prompt</th><th>Version</th><th>Generations</th><th>Last used</th></tr></thead>
        <tbody>{summary.prompts.inUse.map((prompt) => <tr key={`${prompt.key}@${prompt.version}`}><td>{prompt.key}{prompt.registered ? '' : ' (not in the code registry)'}</td><td>{prompt.version}</td><td>{number(prompt.generations)}</td><td>{when(prompt.lastUsedAt)}</td></tr>)}</tbody></table> : null}
    </section>

    <AiEvaluationsPanel token={token} canRecord={viewer.canConfigure && features.length > 0} reload={reload} onRecord={() => setDialog({ kind: 'evaluation' })} />

    {dialog && policy ? <AiDialogs token={token} dialog={dialog} policy={policy} features={features} onCancel={() => setDialog(null)} onDone={done} onLimitsRaise={(feature, next) => setDialog({ kind: 'limits-raise', feature, next })} /> : null}
  </section>;
}

function AiDialogs({ token, dialog, policy, features, onCancel, onDone, onLimitsRaise }: {
  readonly token: string; readonly dialog: Dialog; readonly policy: AiOperationsPolicyDto; readonly features: readonly AiFeatureDto[];
  readonly onCancel: () => void; readonly onDone: (message: string) => void;
  readonly onLimitsRaise: (feature: AiFeatureDto, next: { cap: number; capWindow: AiPeriod; maxInputChars: number }) => void;
}): React.ReactElement {
  switch (dialog.kind) {
    case 'engage':
      return <ReasonDialog title="Engage the global AI kill switch" reasons={policy.reasons.killSwitchEngage} confirm="Engage kill switch"
        details={[['Effect', 'Every AI feature and the in-app assistant are switched off now, in one action.'], ['Approval', 'Not needed — stopping AI takes effect immediately.']]}
        onCancel={onCancel} onConfirm={async (reasonCode) => {
          const result = await engageAiKillSwitch(token, { reasonCode });
          onDone(`Kill switch engaged. ${result.featuresSwitchedOff} feature(s) switched off${result.assistantSwitchedOff ? ', and the assistant' : ''}.`);
        }} />;
    case 'release':
      return <RequestApprovalDialog token={token} actionKey="FEATURE_FLAG_HIGH_RISK_CHANGE" payload={{ key: policy.flags.killSwitch, enabled: false }} reasons={policy.reasons.flagChange}
        title="Release the global AI kill switch" details={[['Effect', 'AI may run again, but nothing is switched back on: each feature and the assistant must be switched on separately.']]}
        onCancel={onCancel} onFiled={onDone} />;
    case 'assistant-off':
      return <ReasonDialog title="Switch the in-app assistant off" reasons={policy.reasons.assistantDisable} confirm="Switch assistant off"
        details={[['Effect', 'The assistant stops answering on the next message. No restart is needed.'], ['Approval', 'Not needed — takes effect immediately.']]}
        onCancel={onCancel} onConfirm={async (reasonCode) => { await disableAiAssistant(token, { reasonCode }); onDone('The assistant is switched off.'); }} />;
    case 'assistant-on':
      return <RequestApprovalDialog token={token} actionKey="FEATURE_FLAG_HIGH_RISK_CHANGE" payload={{ key: policy.flags.assistant, enabled: true }} reasons={policy.reasons.flagChange}
        title="Switch the in-app assistant on" details={[['Also needed', 'ASSISTANT_ENABLED=true and a provider key on the server. This console never sets either.']]}
        onCancel={onCancel} onFiled={onDone} />;
    case 'feature-off':
      return <ReasonDialog title={`Switch off ${dialog.feature.featureKey}`} reasons={policy.reasons.disable} confirm="Switch off"
        details={[['Effect', 'The next call to this feature is refused, in every process.'], ['Approval', 'Not needed — takes effect immediately.']]}
        onCancel={onCancel} onConfirm={async (reasonCode) => { await disableAiFeature(token, dialog.feature.featureKey, { reasonCode }); onDone(`${dialog.feature.featureKey} is switched off.`); }} />;
    case 'feature-on':
      return <RequestApprovalDialog token={token} actionKey="AI_FEATURE_ENABLE" payload={{ featureKey: dialog.feature.featureKey }} reasons={policy.reasons.enable}
        title={`Switch on ${dialog.feature.featureKey}`}
        details={[['Model', dialog.feature.model], ['Prompt', dialog.feature.prompt ? `${dialog.feature.prompt.key} v${dialog.feature.prompt.version}` : 'NA'],
          ['Evaluation', `PASS recorded ${when(dialog.feature.evaluation.decidedAt)} — the approval is bound to this model, prompt and evaluation`]]}
        onCancel={onCancel} onFiled={onDone} />;
    case 'limits':
      return <LimitsDialog token={token} feature={dialog.feature} policy={policy} onCancel={onCancel} onDone={onDone} onRaise={(next) => onLimitsRaise(dialog.feature, next)} />;
    case 'limits-raise':
      return <RequestApprovalDialog token={token} actionKey="AI_FEATURE_LIMITS_RAISE" payload={{ featureKey: dialog.feature.featureKey, ...dialog.next }} reasons={policy.reasons.limitsRaise}
        title={`Raise the limits of ${dialog.feature.featureKey}`}
        details={[['From', `${dialog.feature.cap} per ${windowLabel(dialog.feature.capWindow)}, input up to ${dialog.feature.maxInputChars} characters`],
          ['To', `${dialog.next.cap} per ${windowLabel(dialog.next.capWindow)}, input up to ${dialog.next.maxInputChars} characters`]]}
        onCancel={onCancel} onFiled={onDone} />;
    case 'evaluation':
      return <EvaluationDialog token={token} features={features} policy={policy} onCancel={onCancel} onDone={onDone} />;
  }
}

/** A confirm dialog for an immediate change: it says what happens and needs a reason code. */
function ReasonDialog({ title, details, reasons, confirm, onCancel, onConfirm }: {
  readonly title: string; readonly details: readonly (readonly [string, string])[]; readonly reasons: readonly string[]; readonly confirm: string;
  readonly onCancel: () => void; readonly onConfirm: (reasonCode: string) => Promise<void>;
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
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="ai-reason-title">
      <h2 id="ai-reason-title">{title}</h2>
      <dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : confirm}</button>
        </div>
      </form>
    </section>
  </div>;
}

function LimitsDialog({ token, feature, policy, onCancel, onDone, onRaise }: {
  readonly token: string; readonly feature: AiFeatureDto; readonly policy: AiOperationsPolicyDto;
  readonly onCancel: () => void; readonly onDone: (message: string) => void; readonly onRaise: (next: { cap: number; capWindow: AiPeriod; maxInputChars: number }) => void;
}): React.ReactElement {
  const [cap, setCap] = useState(String(feature.cap));
  const [capWindow, setCapWindow] = useState<AiPeriod>(feature.capWindow);
  const [maxInputChars, setMaxInputChars] = useState(String(feature.maxInputChars));
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = { cap: Number(cap), capWindow, maxInputChars: Number(maxInputChars) };
  const valid = Number.isInteger(next.cap) && next.cap >= 1 && next.cap <= policy.bounds.maxCap
    && Number.isInteger(next.maxInputChars) && next.maxInputChars >= policy.bounds.minInputChars && next.maxInputChars <= policy.bounds.maxInputChars;
  const change = valid ? classifyLimits(feature, next) : 'UNCHANGED';
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (change === 'RAISE') { onRaise(next); return; }
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await changeAiFeatureLimits(token, feature.featureKey, { ...next, reasonCode });
      onDone(`The limits of ${feature.featureKey} were lowered.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The limits could not be changed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="ai-limits-title">
      <h2 id="ai-limits-title">Change the limits of {feature.featureKey}</h2>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Cap (generations per window)</span><input type="number" min={1} max={policy.bounds.maxCap} value={cap} onChange={(event) => setCap(event.target.value)} /></label>
        <label><span>Window</span><select value={capWindow} onChange={(event) => setCapWindow(event.target.value === 'MONTH' ? 'MONTH' : 'DAY')}>
          {policy.bounds.capWindows.map((value) => <option key={value} value={value}>{value === 'DAY' ? 'Per day' : 'Per month'}</option>)}</select></label>
        <label><span>Largest prompt (characters)</span><input type="number" min={policy.bounds.minInputChars} max={policy.bounds.maxInputChars} value={maxInputChars} onChange={(event) => setMaxInputChars(event.target.value)} /></label>
        <p role="note">{!valid ? 'Enter a whole-number cap and an input limit within the allowed range.'
          : change === 'RAISE' ? 'This widens the limits (a higher cap or input limit, or a different window): it needs approval from a second person.'
            : change === 'LOWER' ? 'This lowers the limits: no approval is needed and it takes effect immediately.' : 'These are the current limits.'}</p>
        {change === 'LOWER' ? <label><span>Reason code <em>required</em></span>
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {policy.reasons.limitsLower.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || change === 'UNCHANGED' || (change === 'LOWER' && !reasonCode)}>{change === 'RAISE' ? 'Continue to approval' : busy ? 'Saving…' : 'Lower limits'}</button>
        </div>
      </form>
    </section>
  </div>;
}

interface MetricDraft { name: string; value: string; threshold: string; comparator: 'AT_LEAST' | 'AT_MOST' }

function EvaluationDialog({ token, features, policy, onCancel, onDone }: {
  readonly token: string; readonly features: readonly AiFeatureDto[]; readonly policy: AiOperationsPolicyDto;
  readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const first = features[0];
  const [featureKey, setFeatureKey] = useState(first?.featureKey ?? '');
  const selected = features.find((feature) => feature.featureKey === featureKey);
  const [providerKey, setProviderKey] = useState('');
  const [model, setModel] = useState(first?.model ?? '');
  const [promptKey, setPromptKey] = useState(first?.prompt?.key ?? '');
  const [promptVersion, setPromptVersion] = useState(first?.prompt ? String(first.prompt.version) : '');
  const [setKey, setSetKey] = useState('');
  const [setVersion, setSetVersion] = useState('1');
  const [metrics, setMetrics] = useState<readonly MetricDraft[]>([{ name: '', value: '', threshold: '', comparator: 'AT_LEAST' }]);
  const [decision, setDecision] = useState<'PASS' | 'FAIL' | ''>('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choose = (key: string): void => {
    setFeatureKey(key);
    const feature = features.find((entry) => entry.featureKey === key);
    setModel(feature?.model ?? '');
    setPromptKey(feature?.prompt?.key ?? '');
    setPromptVersion(feature?.prompt ? String(feature.prompt.version) : '');
  };
  const update = (index: number, patch: Partial<MetricDraft>): void => setMetrics(metrics.map((metric, position) => (position === index ? { ...metric, ...patch } : metric)));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!decision || !reasonCode) { setError('Choose a decision and a reason code.'); return; }
    const parsed: AiEvaluationMetricDto[] = metrics.map((metric) => ({ name: metric.name.trim(), value: Number(metric.value), threshold: Number(metric.threshold), comparator: metric.comparator }));
    if (parsed.some((metric) => !metric.name || metric.value === undefined || Number.isNaN(metric.value) || Number.isNaN(metric.threshold))) { setError('Every metric needs a name, a value and a threshold.'); return; }
    setBusy(true);
    try {
      await recordAiEvaluation(token, {
        featureKey, providerKey: providerKey.trim(), model: model.trim(), promptKey: promptKey.trim(), promptVersion: Number(promptVersion),
        evaluationSetKey: setKey.trim(), evaluationSetVersion: Number(setVersion), metrics: parsed, decision, reasonCode, ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(`Evaluation recorded: ${decision} for ${featureKey} on ${model.trim()}.`);
    } catch (cause) {
      setError(formatApiError(cause, 'The evaluation could not be recorded.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="ai-evaluation-title">
      <h2 id="ai-evaluation-title">Record an evaluation</h2>
      <p>Record the result of a benchmark run elsewhere. Nothing is run from here. A PASS must meet every threshold it records; a record is never edited — record a later one to overturn it.</p>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Feature</span><select value={featureKey} onChange={(event) => choose(event.target.value)}>
          {features.map((feature) => <option key={feature.featureKey} value={feature.featureKey}>{feature.featureKey}</option>)}</select></label>
        {selected ? <p><small>Currently runs {selected.model}{selected.prompt ? `, prompt ${selected.prompt.key} v${selected.prompt.version}` : ', no declared prompt'}.</small></p> : null}
        <label><span>Provider (where the model was served)</span><input value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="bedrock" /></label>
        <label><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <label><span>Prompt key</span><input value={promptKey} onChange={(event) => setPromptKey(event.target.value)} /></label>
        <label><span>Prompt version</span><input type="number" min={1} value={promptVersion} onChange={(event) => setPromptVersion(event.target.value)} /></label>
        <label><span>Evaluation set</span><input value={setKey} onChange={(event) => setSetKey(event.target.value)} placeholder="summary.benchmark" /></label>
        <label><span>Evaluation set version</span><input type="number" min={1} value={setVersion} onChange={(event) => setSetVersion(event.target.value)} /></label>
        <fieldset><legend>Metrics</legend>
          {metrics.map((metric, index) => <div key={index} className="role-actions">
            <label><span>Metric {index + 1} name</span><input value={metric.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="task_accuracy" /></label>
            <label><span>Value</span><input type="number" step="any" value={metric.value} onChange={(event) => update(index, { value: event.target.value })} /></label>
            <label><span>Threshold</span><input type="number" step="any" value={metric.threshold} onChange={(event) => update(index, { threshold: event.target.value })} /></label>
            <label><span>Meets when</span><select value={metric.comparator} onChange={(event) => update(index, { comparator: event.target.value === 'AT_MOST' ? 'AT_MOST' : 'AT_LEAST' })}>
              <option value="AT_LEAST">at least the threshold</option><option value="AT_MOST">at most the threshold</option></select></label>
            {metrics.length > 1 ? <button type="button" className="secondary" onClick={() => setMetrics(metrics.filter((_, position) => position !== index))}>Remove metric {index + 1}</button> : null}
          </div>)}
          {metrics.length < policy.bounds.maxMetrics ? <button type="button" className="secondary" onClick={() => setMetrics([...metrics, { name: '', value: '', threshold: '', comparator: 'AT_LEAST' }])}>Add metric</button> : null}
        </fieldset>
        <label><span>Decision <em>required</em></span><select value={decision} onChange={(event) => setDecision(event.target.value === 'PASS' ? 'PASS' : event.target.value === 'FAIL' ? 'FAIL' : '')}>
          <option value="">Choose…</option>{policy.decisions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Reason code <em>required</em></span><select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
          <option value="">Choose a reason…</option>{policy.reasons.evaluation.map((reason) => <option key={reason} value={reason}>{reason}</option>)}</select></label>
        <label><span>Note (optional, {noteLimit} characters) — do not include personal data or model output</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !decision || !reasonCode || !featureKey}>{busy ? 'Saving…' : 'Record evaluation'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function AiUsagePanel({ token, features }: { readonly token: string; readonly features: readonly AiFeatureDto[] }): React.ReactElement {
  const [granularity, setGranularity] = useState<AiPeriod>('DAY');
  const [featureKey, setFeatureKey] = useState('');
  const [points, setPoints] = useState<readonly AiUsagePointDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listAiUsage(token, granularity, featureKey || undefined, controller.signal)
      .then((result) => { setPoints(result.points); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load usage.')); });
    return () => controller.abort();
  }, [token, granularity, featureKey]);
  return <section className="role-card role-wide"><h2>Usage over time</h2>
    <div className="role-actions">
      <label className="role-local-search"><span>By</span><select aria-label="Usage granularity" value={granularity} onChange={(event) => setGranularity(event.target.value === 'MONTH' ? 'MONTH' : 'DAY')}>
        <option value="DAY">Day (last 31 days)</option><option value="MONTH">Month (last 12 months)</option></select></label>
      <label className="role-local-search"><span>Feature</span><select aria-label="Usage feature" value={featureKey} onChange={(event) => setFeatureKey(event.target.value)}>
        <option value="">All features</option>{features.map((feature) => <option key={feature.featureKey} value={feature.featureKey}>{feature.featureKey}</option>)}</select></label>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {points === null && !error ? <p>Loading usage…</p> : null}
    {points && !points.length ? <p>No generations in this period.</p> : null}
    {points?.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Period</th><th>Feature</th><th>Succeeded</th><th>Refused</th><th>Failed</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead>
      <tbody>{points.map((point) => <tr key={`${point.period}-${point.featureKey}`}><td>{point.period}</td><td>{point.featureKey}</td><td>{number(point.succeeded)}</td>
        <td>{number(point.refused)}</td><td>{number(point.failed)}</td><td>{number(point.inputTokens)}</td><td>{number(point.outputTokens)}</td><td>NA</td></tr>)}</tbody></table></div> : null}
  </section>;
}

function AiOrganizationUsagePanel({ token, period }: { readonly token: string; readonly period: AiPeriod }): React.ReactElement {
  const [rows, setRows] = useState<readonly AiOrganizationUsageDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listAiUsageByOrganization(token, period, controller.signal)
      .then((result) => { setRows(result.organizations); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load usage by organisation.')); });
    return () => controller.abort();
  }, [token, period]);
  const cell = (row: AiOrganizationUsageDto, value: number | null): string => (row.suppressed ? '<5' : number(value));
  return <section className="role-card role-wide"><h2>Usage by organisation</h2>
    <p><small>Where fewer than 5 people stand behind a row, its figures show &lt;5. A person in two organisations is counted in each.</small></p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {rows === null && !error ? <p>Loading usage by organisation…</p> : null}
    {rows && !rows.length ? <p>No generations this {windowLabel(period)}.</p> : null}
    {rows?.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Organisation</th><th>People</th><th>Succeeded</th><th>Refused</th><th>Failed</th><th>Tokens in / out</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.organizationName ?? 'none'}-${index}`}>
        <td>{row.noSubject ? 'Not about a person' : row.organizationName ?? 'No organisation'}</td>
        <td>{row.noSubject ? 'NA' : cell(row, row.people)}</td><td>{cell(row, row.succeeded)}</td><td>{cell(row, row.refused)}</td><td>{cell(row, row.failed)}</td>
        <td>{row.suppressed ? '<5' : `${number(row.inputTokens)} / ${number(row.outputTokens)}`}</td>
      </tr>)}</tbody></table></div> : null}
  </section>;
}

function AiEvaluationsPanel({ token, canRecord, reload, onRecord }: { readonly token: string; readonly canRecord: boolean; readonly reload: number; readonly onRecord: () => void }): React.ReactElement {
  const [rows, setRows] = useState<readonly AiEvaluationDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listAiEvaluations(token, {}, controller.signal)
      .then((result) => { setRows(result.evaluations); setNextCursor(result.nextCursor); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load evaluations.')); });
    return () => controller.abort();
  }, [token, reload]);
  const more = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listAiEvaluations(token, { cursor: nextCursor });
      setRows([...(rows ?? []), ...page.evaluations]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more evaluations.'));
    }
  };
  return <section className="role-card role-wide"><div className="role-section-title"><h2>Evaluations</h2>
    {canRecord ? <button type="button" className="pilot-btn" onClick={onRecord}>Record evaluation…</button> : null}</div>
    <p>A feature is switched on only with a passing evaluation for its current model and prompt version. The latest record for a combination is its verdict.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {rows === null && !error ? <p>Loading evaluations…</p> : null}
    {rows && !rows.length ? <V2EmptyState icon="🧪" title="No evaluations recorded" note="No model has been benchmarked for any feature yet." /> : null}
    {rows?.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Feature</th><th>Model and prompt</th><th>Evaluation set</th><th>Metrics</th><th>Decision</th><th>Recorded</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td>{row.featureKey}</td>
        <td>{row.model}<br /><small>{row.promptKey} v{row.promptVersion} · served by {row.providerKey}</small></td>
        <td>{row.evaluationSetKey} v{row.evaluationSetVersion}</td>
        <td><ul>{row.metrics.map((metric) => <li key={metric.name}>{metric.name}: {metric.value} ({metric.comparator === 'AT_LEAST' ? '≥' : '≤'} {metric.threshold})</li>)}</ul></td>
        <td><StatusBadge label={row.decision} tone={row.decision === 'PASS' ? 'success' : 'danger'} />{row.current ? <><br /><small>Current verdict</small></> : <><br /><small>Superseded</small></>}</td>
        <td>{row.decidedBy}<br /><small>{when(row.decidedAt)} · {row.reasonCode}</small></td>
      </tr>)}</tbody></table></div> : null}
    {nextCursor ? <button type="button" className="secondary" onClick={() => void more()}>Load more</button> : null}
  </section>;
}
