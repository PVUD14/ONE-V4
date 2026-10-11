/**
 * The Momentum building blocks of the institution homes (re-skin phase 6): page head, KPI tiles,
 * cards, figure rows, tiles and the "all clear" state, after the approved institution pages
 * (unified/college-admin.html; 06-screens/placement-officer.html, lecturer.html,
 * department-head.html).
 *
 * They exist so the four homes and the department overview share one look and one set of rules
 * rather than four copies. Each block draws only what it is given: a caller leaves a block out
 * when its data does not exist, and nothing here invents a value or prints a placeholder. Counts
 * of people go through <SmallCount> (via PeopleCount); counts of records (queues, units, drives)
 * are drawn as they are. Styles live in styles/institution-home.css, scoped under `.ih`.
 */
import React from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import { SmallCount, isSmallCount, partitionNeedsRanges, type SuppressibleCount } from '../momentum/smallCount.js';
import { CountUp } from '../momentum/useCountUp.js';
import { studentActivationLabels, type DepartmentOverviewDto, type ExamNotAttemptedDto, type StudentActivationState } from '../api.js';
import { BandClimb, bandCount, bandMonthLabel, type BandAggregate } from '../momentum/bandClimb.js';

export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Today in words, for the page eyebrow: "Saturday, 10 October 2026". */
export function todayLabel(now = new Date()): string {
  return now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function initialsOf(name: string): string {
  return name.split(/[\s@._-]+/).filter((word) => /^[A-Za-z0-9]/.test(word)).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || '·';
}

/** A count of people: "<5" under five (never counted up), a range when asked, else the count-up number. */
export function PeopleCount({ value, range = false }: { readonly value: SuppressibleCount; readonly range?: boolean }): React.ReactElement {
  if (range || isSmallCount(value)) return <SmallCount value={value} range={range} />;
  const shown = typeof value === 'number' ? value : (value!.value !== undefined ? value!.value : value!.count) ?? 0;
  return <CountUp value={shown} />;
}

/** A count of records (queue items, units, drives): shown as it is. */
export function RecordCount({ value }: { readonly value: number }): React.ReactElement {
  return <CountUp value={value} />;
}

export function IhPage({ eyebrow, title, summary, actions, children, className, head }: {
  readonly eyebrow?: string | null; readonly title: string; readonly summary: React.ReactNode; readonly actions?: React.ReactNode; readonly children: React.ReactNode;
  /** Extra classes on the page root (the business homes add `bh`). */
  readonly className?: string;
  /** Replaces the title block (the growth home opens with its hero instead). */
  readonly head?: React.ReactNode;
}): React.ReactElement {
  return <div className={`pilot pilot-embed ih${className ? ` ${className}` : ''}`}>
    {head ?? <header className="ih-title">
      <div className="ih-title-text">
        <div className="ih-eyebrow">{[eyebrow, todayLabel()].filter(Boolean).join(' · ')}</div>
        <h1>{title}</h1>
        <p className="ih-sub">{summary}</p>
      </div>
      {actions ? <div className="ih-ta">{actions}</div> : null}
    </header>}
    {children}
  </div>;
}

export interface IhKpiItem {
  readonly key: string;
  readonly icon: IconName;
  readonly value: React.ReactNode;
  readonly label: string;
  readonly note?: React.ReactNode;
  readonly tone?: 'ok';
}

export function IhKpis({ items }: { readonly items: readonly (IhKpiItem | null | false)[] }): React.ReactElement | null {
  const shown = items.filter((item): item is IhKpiItem => Boolean(item));
  if (!shown.length) return null;
  return <div className="ih-kpis" style={{ '--n': shown.length } as React.CSSProperties}>
    {shown.map((item, index) => <div key={item.key} className={`ih-kpi ih-a ih-rise${item.tone === 'ok' ? ' ok' : ''}`} style={{ '--k': index } as React.CSSProperties}>
      <span className="ih-ki"><Icon name={item.icon} size={20} /></span>
      <div><b className="ih-kv">{item.value}</b><span className="ih-kl">{item.label}</span>{item.note ? <small>{item.note}</small> : null}</div>
    </div>)}
  </div>;
}

export function IhLink({ label, onClick }: { readonly label: string; readonly onClick: () => void }): React.ReactElement {
  return <button type="button" className="ih-lnk" onClick={onClick}>{label} <Icon name="arrow-right" size={16} /></button>;
}

export function IhCard({ title, link, aside, className, children, labelledBy }: {
  readonly title: string; readonly link?: { readonly label: string; readonly onClick: () => void } | null; readonly aside?: React.ReactNode;
  readonly className?: string; readonly children: React.ReactNode; readonly labelledBy?: string;
}): React.ReactElement {
  const id = labelledBy ?? `ih-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return <section className={`ih-card ih-a ih-rise${className ? ` ${className}` : ''}`} aria-labelledby={id}>
    <div className="ih-ch"><h2 id={id}>{title}</h2>{aside ? <span className="ih-ch-aside">{aside}</span> : null}{link ? <IhLink label={link.label} onClick={link.onClick} /> : null}</div>
    {children}
  </section>;
}

/** A plain one-line note under a card's content (the approved `.note`), with a lock for privacy notes. */
export function IhNote({ children, icon = 'lock' }: { readonly children: React.ReactNode; readonly icon?: IconName }): React.ReactElement {
  return <p className="ih-note"><Icon name={icon} size={16} /><span>{children}</span></p>;
}

/** Label / value rows (the approved `.rows`). */
export function IhRows({ rows }: { readonly rows: readonly (readonly [string, React.ReactNode, ('ok' | 'warn' | undefined)?])[] }): React.ReactElement {
  return <dl className="ih-rows">{rows.map(([label, value, tone]) => <div key={label} className={tone ?? undefined}><dt><i aria-hidden="true" />{label}</dt><dd className="num">{value}</dd></div>)}</dl>;
}

/** The calm "nothing waiting" state (the approved `.clear`). */
export function IhClear({ title, line }: { readonly title: string; readonly line: React.ReactNode }): React.ReactElement {
  return <div className="ih-clear"><span className="ih-cbx" aria-hidden="true"><Icon name="check" size={20} /></span><div><b>{title}</b><small>{line}</small></div></div>;
}

/** Figure tiles with no size cue (pipeline stages, structure counts). */
export function IhTiles({ tiles, columns }: {
  readonly tiles: readonly { readonly key: string; readonly value: React.ReactNode; readonly label: string; readonly icon?: IconName; readonly muted?: boolean }[];
  readonly columns?: number;
}): React.ReactElement {
  return <div className="ih-tiles" style={columns ? { '--cols': columns } as React.CSSProperties : undefined}>
    {tiles.map((tile, index) => <div key={tile.key} className={`ih-tile${tile.muted ? ' z' : ''}`} style={{ '--k': index } as React.CSSProperties}>
      {tile.icon ? <Icon name={tile.icon} size={16} /> : null}
      <span className="ih-tile-l">{tile.label}</span>
      <b className="num">{tile.value}</b>
    </div>)}
  </div>;
}

/** An insight line inside a card (the approved `.cins`). */
export function IhInsight({ icon, title, line, warm = false }: { readonly icon: IconName; readonly title: React.ReactNode; readonly line?: React.ReactNode; readonly warm?: boolean }): React.ReactElement {
  return <div className="ih-ins"><span className={`ih-ci${warm ? ' warm' : ''}`}><Icon name={icon} size={16} /></span><div><b>{title}</b>{line ? <small>{line}</small> : null}</div></div>;
}

export function IhAvatar({ name }: { readonly name: string }): React.ReactElement {
  return <span className="ih-av" aria-hidden="true">{initialsOf(name)}</span>;
}

// --- Staff actions (tasks, interventions, meetings) ------------------------------------------

/** Staff-action states that still need someone to act (as the server counts open work). */
export const OPEN_ACTION_STATES: ReadonlySet<string> = new Set(['DRAFT', 'OPEN', 'IN_PROGRESS', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED']);

export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
}

export function shortTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
}

// --- Shared cards ---------------------------------------------------------------------------

/** The verification queue as the approved card draws it: calm when empty, the count when not. */
export function VerificationBlock({ pending }: { readonly pending: number }): React.ReactElement {
  if (pending === 0) return <IhClear title="All clear" line="No records are waiting for a decision." />;
  return <div className="ih-wait"><b className="num">{pending}</b><span>{pending === 1 ? 'record is' : 'records are'} waiting for a decision</span></div>;
}

/**
 * A cohort's band distribution as a card: the climb, the "need more evidence" insight from the
 * Not Enough Evidence band, and the privacy line. Callers render it only when the distribution
 * was read; a withheld distribution says so in words.
 */
export function CohortBandsCard({ title, aggregate, month, link, range = false, action }: {
  readonly title: string; readonly aggregate: BandAggregate; readonly month: string | null;
  readonly link?: { readonly label: string; readonly onClick: () => void } | null; readonly range?: boolean; readonly action?: React.ReactNode;
}): React.ReactElement {
  const monthLabel = bandMonthLabel(month);
  const notEnough = aggregate.suppressed ? null : bandCount(aggregate, 'NOT_ENOUGH_EVIDENCE');
  return <IhCard title={title} className="ih-cohort-card" link={link ?? null}
    aside={<span className="tag t-mute"><Icon name="lock" size={16} className="tag-icon" />Aggregated · advisory</span>}>
    <div className="ih-cohort">
      <div className="ih-cohort-climb">
        {monthLabel ? <p className="ih-lead">Each student's band at the end of {monthLabel}.</p> : null}
        <BandClimb aggregate={aggregate} month={month} range={range} />
      </div>
      {notEnough || action ? <div className="ih-cohort-side">
        {notEnough ? <IhInsight icon="evidence" warm title={<><SmallCount value={notEnough} range={range} /> need more evidence</>} line="Suggest an assessment or a lesson" /> : null}
        {action}
      </div> : null}
    </div>
    <IhNote>Bands come only from verified evidence records. They are advisory, never a score, and are never shared with employers.</IhNote>
  </IhCard>;
}

// --- Cards shared by the institution homes and the department overview -------------------------

type NotAttempted = ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string };
const activationStates: readonly StudentActivationState[] = ['ACTIVATED', 'INVITED', 'EXPIRED', 'BOUNCED', 'NOT_INVITED'];

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** A department overview only when it has the shape the server sends (a stubbed or failed read is null). */
export function validOverview(response: DepartmentOverviewDto | null | undefined): DepartmentOverviewDto | null {
  return response && response.students && response.staffActions && response.activation && Array.isArray(response.batches) ? response : null;
}

/** The students who have not attempted an assigned assessment, by name (staff with record access only). */
export function NeedsAttentionCard({ entries, onOpen }: { readonly entries: readonly NotAttempted[]; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title="Students needing attention" link={{ label: 'View all', onClick: onOpen }}>
    {entries.length ? <ul className="ih-list">{entries.slice(0, 5).map((entry) => <li key={entry.institutionStudentId} className="ih-li">
      <IhAvatar name={entry.studentName} />
      <div className="ih-li-t"><b>{entry.studentName}</b><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
      {shortDate(entry.endsAt) ? <span className="tag t-warn"><i />Due {shortDate(entry.endsAt)}</span> : null}
    </li>)}</ul>
      : <p className="ih-empty"><b>Nobody needs attention right now.</b> Every assigned assessment has been attempted.</p>}
  </IhCard>;
}

/** Activation as the approved card draws it; parts become ranges when a small group could be subtracted from the roster. */
export function ActivationCard({ activation, onOpen }: { readonly activation: Readonly<Record<StudentActivationState, number>>; readonly onOpen: () => void }): React.ReactElement {
  const parts = activationStates.map((state) => activation[state] ?? 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  const ranged = partitionNeedsRanges(parts);
  const exactBar = !ranged && parts.every((value) => value === 0 || !isSmallCount(value));
  return <IhCard title="Student activation" link={{ label: 'View students', onClick: onOpen }}>
    <div className="ih-act"><b className="num"><PeopleCount value={activation.ACTIVATED ?? 0} range={ranged} /></b><span>of <SmallCount value={total} /> on the roster activated</span></div>
    {exactBar && total > 0 ? <div className="ih-abar" aria-hidden="true">{activationStates.map((state) => activation[state] ? <i key={state} className={state === 'ACTIVATED' ? 'ok' : state === 'NOT_INVITED' ? 'warn' : ''} style={{ flex: activation[state] }} /> : null)}</div> : null}
    <IhRows rows={activationStates.map((state) => [studentActivationLabels[state], <SmallCount key={state} value={activation[state] ?? 0} range={ranged} />, state === 'ACTIVATED' ? 'ok' : state === 'NOT_INVITED' ? 'warn' : undefined] as const)} />
    {ranged ? <IhNote icon="info">Groups under five read “&lt;5”, and the others are shown as ranges so no small group can be worked out from the roster total.</IhNote> : null}
  </IhCard>;
}

/**
 * The batches of the reader's scope with their students. The batch totals sit beside the overview's
 * own totals, so each column becomes ranges when a small batch could be subtracted from it. The
 * per-batch band mix of the approved page is not drawn: no read returns bands per batch in one call.
 */
export function BatchTable({ overview, onOpen, linkLabel = 'Reports' }: { readonly overview: DepartmentOverviewDto; readonly onOpen: () => void; readonly linkLabel?: string }): React.ReactElement {
  const batches = overview.batches;
  const rangeStudents = partitionNeedsRanges(batches.map((batch) => batch.students), overview.students.onRoster);
  const rangeCurrent = partitionNeedsRanges(batches.map((batch) => batch.current), overview.students.current);
  const rangeActivated = partitionNeedsRanges(batches.map((batch) => batch.activated), overview.activation.ACTIVATED);
  return <IhCard title="Cohort by batch" aside={`${batches.length} ${plural(batches.length, 'batch', 'batches')}`} link={{ label: linkLabel, onClick: onOpen }}>
    <div className="ih-table-wrap"><table className="ih-table"><caption className="sr-only">Students by batch</caption>
      <thead><tr><th scope="col">Batch</th><th scope="col">Program</th><th scope="col" className="r">Students</th><th scope="col" className="r">Enrolled now</th><th scope="col" className="r">Activated</th></tr></thead>
      <tbody>{batches.map((batch) => <tr key={batch.id}>
        <th scope="row"><b>{batch.name}</b></th><td className="ih-muted">{batch.parentName ?? ''}</td>
        <td className="r num"><SmallCount value={batch.students} range={rangeStudents} /></td>
        <td className="r num"><SmallCount value={batch.current} range={rangeCurrent} /></td>
        <td className="r num"><SmallCount value={batch.activated} range={rangeActivated} /></td>
      </tr>)}</tbody>
    </table></div>
    <IhNote icon="info">{rangeStudents || rangeCurrent || rangeActivated
      ? 'Counts under five read “<5”; where a small batch could be worked out from the totals, the other batches show ranges.'
      : 'Counts under five read “<5”.'}</IhNote>
  </IhCard>;
}

