/**
 * ONE · Role portal — Operations: adaptive engine health panels (OPS-13).
 *
 * Two sections placed inside existing screens (no navigation change): under AI Operations, how the
 * engine decides — planner decisions per day and the override rate, and the mastery shadow comparison;
 * under System Health, whether its jobs run — the last calibration run and its status, and the code
 * sandbox. Every figure is the server's; a count the server withheld (fewer than 5 people) shows <5, and
 * a figure with no source shows NA in its slot. No student, topic, institution or item is ever named.
 * Design: docs/architecture/engine-health-panels-design.md
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getEngineBehaviourHealth, getEngineJobsHealth } from '../api.js';
import type {
  CalibrationHealthDto,
  EngineBehaviourHealthDto,
  EngineHealthWindowDays,
  EngineJobsHealthDto,
  EngineSuppressedCountDto,
  MasteryShadowHealthDto,
  PlannerHealthDto,
  ShadowComparisonDto,
} from '../api.js';
import { V2Bar, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { SupportCode } from '../supportCode.js';
import { formatDateTime } from '../dates.js';
import { codeLabel } from '../labels.js';
import { NaValue } from '../naState.js';
import { SuppressedBlock, SMALL_COUNT_TEXT, shownCount, smallCountText } from '../momentum/smallCount.js';

const NA = 'NA';
const windowChoices: readonly EngineHealthWindowDays[] = [7, 14, 30];

/** A server count: NA when absent, <5 when withheld, else the value. */
export function engineCount(count: EngineSuppressedCountDto | null | undefined): string {
  if (!count) return NA;
  return smallCountText(count, (value) => value.toLocaleString());
}

const when = (value: string | null | undefined): string => (value ? formatDateTime(value) : NA);

function isPlanner(value: unknown): value is PlannerHealthDto {
  return Boolean(value) && Array.isArray((value as PlannerHealthDto).days);
}
function isShadow(value: unknown): value is MasteryShadowHealthDto {
  return Boolean(value) && typeof (value as MasteryShadowHealthDto).suppressed === 'boolean';
}
function isCalibration(value: unknown): value is CalibrationHealthDto {
  return Boolean(value) && typeof (value as CalibrationHealthDto).status === 'string';
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): {
  readonly data: T | null; readonly loading: boolean; readonly error: string; readonly forbiddenReference: string;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .then((result) => { setData(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the learning engine health panels.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, deps);
  return { data, loading, error, forbiddenReference };
}

// --- AI Operations: planner and mastery shadow --------------------------------------------------

export function EngineBehaviourPanels({ token }: { readonly token: string }): React.ReactElement {
  const [days, setDays] = useState<EngineHealthWindowDays>(14);
  const { data, loading, error, forbiddenReference } = useLoad<EngineBehaviourHealthDto>((signal) => getEngineBehaviourHealth(token, days, signal), [token, days]);
  const planner = isPlanner(data?.planner) ? data.planner : null;
  const shadow = isShadow(data?.masteryShadow) ? data.masteryShadow : null;

  return <section className="role-card role-wide" aria-label="Learning engine health"><h2>Learning engine</h2>
    <p>How the adaptive engine is deciding: the planner&apos;s next steps and how often faculty overrode them, and how the mastery model running in shadow compares with the live bands. Counts only — no student, topic or college is named, and any figure standing for fewer than 5 people shows &lt;5. Nothing here is readiness, and nothing here calls a model.</p>
    {forbiddenReference ? <p>Not permitted: these panels need AI Operations View. <SupportCode reference={forbiddenReference} /></p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loading && !data ? <p>Loading learning engine health…</p> : null}

    {/* Re-skin phase 7: a figure shows only once its panel has loaded; nothing stands in for a missing one. */}
    {planner || shadow ? <div className={`v2-row v2-cols-${[planner, planner, shadow, planner && planner.policyVersions.length].filter(Boolean).length} career-stat-strip`}>
      {planner ? <V2Stat icon="🧭" tone="blue" value={engineCount(planner.decisions)} label={`Planner decisions, last ${planner.windowDays} days`} /> : null}
      {planner ? <V2Stat icon="✋" tone="amber" value={overrideRateText(planner)} label="Faculty override rate" /> : null}
      {shadow ? <V2Stat icon="🧪" tone="purple" value={engineCount(shadow.studentsInScope)} label="Students in the mastery shadow" /> : null}
      {planner && planner.policyVersions.length ? <V2Stat icon="📐" tone="teal" value={planner.policyVersions.join(', ')} label="Planner policy in use" /> : null}
    </div> : null}

    <div className="v2-row v2-cols-2">
      <section className="role-card" aria-label="Planner decisions per day"><h3>Planner decisions per day</h3>
        <div className="role-actions">
          <label className="role-local-search"><span>Window</span>
            <select aria-label="Planner window" value={days} onChange={(event) => setDays(Number(event.target.value) as EngineHealthWindowDays)}>
              {windowChoices.map((choice) => <option key={choice} value={choice}>Last {choice} days</option>)}
            </select></label>
        </div>
        {planner ? <PlannerTable planner={planner} /> : null}
        <p><small>Source: learning_decisions. A day shows &lt;5 when fewer than 5 students stand behind it, a day with none included; the total is withheld while a small day could be worked out from it.</small></p>
      </section>
      <section className="role-card" aria-label="Mastery shadow comparison"><h3>Mastery shadow comparison</h3>
        {shadow ? <ShadowSummary shadow={shadow} /> : null}
        <p><small>Source: learner_skill_state against the live mastery bands (mastery_projections), for students who hold adaptive learning. The full shadow report, with its predictions, stays an offline command.</small></p>
      </section>
    </div>
  </section>;
}

function overrideRateText(planner: PlannerHealthDto): string {
  if (planner.overrideRate !== null) return `${(planner.overrideRate * 100).toFixed(1)}%`;
  return planner.active ? SMALL_COUNT_TEXT : 'No decisions';
}

function PlannerTable({ planner }: { readonly planner: PlannerHealthDto }): React.ReactElement {
  const peak = Math.max(0, ...planner.days.map((day) => shownCount(day.decisions) ?? 0));
  return <>
    {!planner.active ? <p><StatusBadge label="No planner decisions in this window" tone="neutral" /></p> : null}
    <dl>
      <div><dt>Decisions in the window</dt><dd><NaValue value={engineCount(planner.decisions)} /></dd></div>
      <div><dt>Overridden by faculty</dt><dd><NaValue value={engineCount(planner.overridden)} /></dd></div>
      <div><dt>Override rate</dt><dd><NaValue value={overrideRateText(planner)} /></dd></div>
    </dl>
    <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Day (UTC)</th><th>Decisions</th><th aria-hidden="true" /></tr></thead>
      <tbody>{planner.days.map((day) => <tr key={day.day}>
        <td>{day.day}</td>
        <td><NaValue value={engineCount(day.decisions)} /></td>
        {/* A small day has no proportional bar: the uniform hatched block stands in for it. */}
        <td>{shownCount(day.decisions) === null ? <SuppressedBlock /> : peak > 0 ? <V2Bar percent={(shownCount(day.decisions)! / peak) * 100} /> : null}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}

const comparisonRows: readonly [keyof ShadowComparisonDto, string][] = [
  ['pairsCompared', 'Student–topic pairs compared'],
  ['unchanged', 'Band unchanged'],
  ['movedUp', 'Would move up'],
  ['movedDown', 'Would move down'],
  ['becameNotEnoughEvidence', 'Would become "not enough evidence"'],
  ['leftNotEnoughEvidence', 'Would leave "not enough evidence"'],
  ['studentsWithAnyChange', 'Students with any change'],
];

function ShadowSummary({ shadow }: { readonly shadow: MasteryShadowHealthDto }): React.ReactElement {
  if (!shadow.consentOffered) {
    return <p><StatusBadge label="Not offered yet" tone="neutral" /> Students have not been asked for adaptive learning, so nobody is in the shadow and there are no figures to compare.</p>;
  }
  if (shadow.suppressed || !shadow.c3Adoption || !shadow.bkt) {
    return <p><StatusBadge label="Withheld" tone="neutral" /> Fewer than 5 students who hold adaptive learning have engine records, so the comparison is withheld (&lt;5).</p>;
  }
  const c3 = shadow.c3Adoption;
  const bkt = shadow.bkt;
  return <>
    <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Against the live band</th><th>Two-day evidence rule</th><th>BKT (shadow)</th></tr></thead>
      <tbody>{comparisonRows.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td><NaValue value={engineCount(c3[key])} /></td><td><NaValue value={engineCount(bkt[key])} /></td></tr>)}</tbody>
    </table></div>
    <dl>
      {shadow.coverage ? <>
        <div><dt>Engine rows needing a rebuild</dt><dd><NaValue value={engineCount(shadow.coverage.engineRowsOnOlderProjector)} /></dd></div>
        <div><dt>Live bands without an engine row</dt><dd><NaValue value={engineCount(shadow.coverage.livePairsWithoutEngineRow)} /></dd></div>
        <div><dt>Engine rows without a live band</dt><dd><NaValue value={engineCount(shadow.coverage.engineRowsWithoutLiveBand)} /></dd></div>
      </> : null}
      <div><dt>Models</dt><dd>{shadow.algorithms.live} (live) · {shadow.algorithms.engineBand} · {shadow.algorithms.shadow} (shadow)</dd></div>
    </dl>
  </>;
}

// --- System Health: calibration job and sandbox --------------------------------------------------

const calibrationStatus = {
  NO_RUN: { label: 'No run recorded', tone: 'neutral', note: 'No calibration run has been accepted and imported here. Every item keeps its provisional parameters.' },
  CURRENT: { label: 'Current', tone: 'success', note: 'The last calibration run was accepted and imported within the monthly schedule.' },
  OVERDUE: { label: 'Overdue', tone: 'warning', note: 'No run has been imported within the monthly schedule. The job may have failed, or its proposal is still waiting for review: either way nothing new was imported.' },
} as const;

export function EngineJobsPanels({ token }: { readonly token: string }): React.ReactElement {
  const { data, loading, error, forbiddenReference } = useLoad<EngineJobsHealthDto>((signal) => getEngineJobsHealth(token, signal), [token]);
  const calibration = isCalibration(data?.calibration) ? data.calibration : null;
  const status = calibration ? calibrationStatus[calibration.status] : null;
  const run = calibration?.lastRun ?? null;

  return <div className="v2-row v2-cols-2 role-wide" aria-label="Learning engine jobs">
    <section className="role-card"><h2>Item calibration job</h2>
      {forbiddenReference ? <p>Not permitted. <SupportCode reference={forbiddenReference} /></p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading && !data ? <p>Loading the calibration job…</p> : null}
      <p><StatusBadge label={status?.label ?? NA} tone={status?.tone ?? 'neutral'} /></p>
      <p>{status?.note ?? 'Calibration status is not available.'}</p>
      <dl>
        <div><dt>Last run imported</dt><dd>{when(run?.recordedAt)}{run ? ` (${run.ageDays} day${run.ageDays === 1 ? '' : 's'} ago)` : ''}</dd></div>
        <div><dt>Fitted</dt><dd>{when(run?.generatedAt)}</dd></div>
        <div><dt>Attempts exported</dt><dd>{when(run?.exportedAt)}</dd></div>
        <div><dt>Items calibrated</dt><dd>{run ? run.items.calibrated.toLocaleString() : NA}</dd></div>
        <div><dt>Items still provisional</dt><dd>{run ? run.items.provisional.toLocaleString() : NA}</dd></div>
        <div><dt>Learners read</dt><dd><NaValue value={run ? engineCount(run.learnersRead) : NA} /></dd></div>
        <div><dt>Responses read</dt><dd><NaValue value={run ? smallCountText(run.responsesRead, (value) => value.toLocaleString()) : NA} /></dd></div>
        <div><dt>Runs recorded</dt><dd>{calibration ? calibration.runsRecorded.toLocaleString() : NA}</dd></div>
        <div><dt>Algorithm</dt><dd>{run ? `${run.algorithmId} · ${run.library} · at least ${run.minResponses} responses per item` : NA}</dd></div>
      </dl>
      {run && Object.keys(run.items.provisionalByReason).length
        ? <ul className="role-check-list">{Object.entries(run.items.provisionalByReason).map(([reason, count]) => <li key={reason}>{codeLabel(reason)}: {count.toLocaleString()}</li>)}</ul>
        : null}
      <p><small>Source: item_calibration_runs and item_calibrations. Recalibrated monthly and imported only when accepted; overdue after {calibration?.overdueAfterDays ?? 38} days.</small></p>
    </section>
    <section className="role-card"><h2>Code sandbox</h2>
      <p><StatusBadge label={data?.sandbox?.state === 'NOT_BUILT' ? 'Not built' : NA} tone="neutral" /></p>
      <p>{data?.sandbox?.state === 'NOT_BUILT' ? 'The isolated code sandbox has not been built yet, so there is nothing to measure. Both figures stay NA until it exists.' : 'Sandbox status is not available.'}</p>
      <dl>
        <div><dt>Available</dt><dd>{data?.sandbox?.available === true ? 'Yes' : data?.sandbox?.available === false ? 'No' : NA}</dd></div>
        <div><dt>Rejected executions</dt><dd>{typeof data?.sandbox?.rejectedExecutions === 'number' ? data.sandbox.rejectedExecutions.toLocaleString() : NA}</dd></div>
      </dl>
      <p><small>Source: none yet.</small></p>
    </section>
  </div>;
}
