/**
 * ONE · Shared — how a missing or withheld figure looks, on every portal.
 *
 * The product rule is that a widget never disappears because its data is missing: its slot
 * says NA (no source yet), "<5" (a group too small to show), "Withheld" (a total that would
 * reveal a small group) or "Too few answers". Rendered as big bold values those slots read as
 * a broken page. These components keep every slot — and its exact honest text — but present
 * it calmly:
 *
 *  - NaValue / NaReason: a missing value in a muted, smaller style with a one-line reason;
 *  - PilotStat / PilotKpi: the pilot's stat tiles, using NaValue for a missing value;
 *  - NaSlotStrip: a group whose slots are all missing collapses into one compact strip that
 *    still names every slot ("Mock interviews · NA") above a single explanation line;
 *  - SuppressedChart: a chart with any missing point draws no line (a flat or broken line
 *    would read as zero) and shows a calm empty state inside the same frame and title;
 *  - CountBars: a compact label / bar / count table for small series, suppressed cells muted;
 *  - SuppressionNote: the single caption a table carries when it holds withheld cells.
 *
 * Nothing here computes or invents a figure: callers pass the text the server sent, and a
 * suppressed count is never turned back into a number (the bar only draws a shown count).
 * Styles live in the "NA / suppressed-count presentation" block at the end of styles.css.
 */
import type { ReactNode } from 'react';

export type MissingKind = 'na' | 'suppressed' | 'withheld' | 'few';

/** Which kind of missing figure a rendered value is, or null when it is a real value. */
export function missingKind(value: unknown): MissingKind | null {
  if (value === null || value === undefined) return 'na';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === 'NA') return 'na';
  if (/^<\s?\d/.test(text)) return 'suppressed';
  if (text === 'Withheld') return 'withheld';
  if (text === 'Too few answers') return 'few';
  return null;
}

export function isMissing(value: unknown): boolean {
  return missingKind(value) !== null;
}

/** True when there is at least one value and every one of them is missing. */
export function allMissing(values: readonly unknown[]): boolean {
  return values.length > 0 && values.every(isMissing);
}

/** A value as sent; a missing one is muted and keeps its exact text (null reads NA). */
export function NaValue({ value }: { readonly value: ReactNode }): React.ReactElement {
  const kind = missingKind(value);
  if (!kind) return <>{value}</>;
  return <span className="na-value" data-na={kind}>{value ?? 'NA'}</span>;
}

/** The one muted line that says why a slot is empty. */
export function NaReason({ children }: { readonly children: ReactNode }): React.ReactElement {
  return <small className="na-reason">{children}</small>;
}

/** A pilot hero stat (icon tile, value, label); a missing value is muted and may carry a reason. */
export function PilotStat({ icon, tone, value, label, reason }: {
  readonly icon: ReactNode; readonly tone: string; readonly value: ReactNode; readonly label: string; readonly reason?: string;
}): React.ReactElement {
  const missing = isMissing(value);
  return <div className="pilot-stat" data-na={missing ? 'true' : undefined}>
    <span className={`pilot-tile ${missing ? 'na-tile' : tone}`}>{icon}</span>
    <div><b><NaValue value={value} /></b><small>{label}</small>{missing && reason ? <NaReason>{reason}</NaReason> : null}</div>
  </div>;
}

/** A pilot KPI card (the staff dashboards' top row); a missing value is muted with a reason. */
export function PilotKpi({ icon, tone, value, label, reason }: {
  readonly icon: ReactNode; readonly tone: string; readonly value: ReactNode; readonly label: string; readonly reason?: string;
}): React.ReactElement {
  const missing = isMissing(value);
  return <section className="pilot-card pilot-kpi" data-na={missing ? 'true' : undefined}>
    <span className={`pilot-tile ${missing ? 'na-tile' : tone}`}>{icon}</span>
    <div><b><NaValue value={value} /></b><small>{label}</small>{missing && reason ? <NaReason>{reason}</NaReason> : null}</div>
  </section>;
}

export interface NaSlot {
  readonly label: string;
  /** What the slot would show; defaults to NA. Pass the server's text ("<5", "Withheld"). */
  readonly value?: ReactNode;
}

/**
 * One labelled slot as a chip: "Mock Interviews · NA". The dot is drawn by CSS, so the text is
 * the label, a space and the value exactly as sent.
 */
export function NaSlotChip({ label, value }: NaSlot): React.ReactElement {
  return <li className="na-slot"><span className="na-slot-label">{label}</span>{' '}<span className="na-slot-value"><NaValue value={value ?? 'NA'} /></span></li>;
}

/**
 * A group of slots with nothing to show, as one compact strip: every slot stays visible and
 * labelled, and one line explains why. With `title` it is a whole card (heading and NA chip);
 * without, it sits inside an existing card in place of the empty widgets.
 */
export function NaSlotStrip({ title, slots, reason, label, card = true, className = '', action }: {
  readonly title?: string;
  readonly slots: readonly NaSlot[];
  readonly reason: ReactNode;
  /** Accessible name for the slot list; defaults to the title. */
  readonly label?: string;
  /** Render as its own pilot card (default) or bare, inside a card the caller already has. */
  readonly card?: boolean;
  readonly className?: string;
  readonly action?: ReactNode;
}): React.ReactElement {
  const listLabel = label ?? title ?? 'Unavailable figures';
  const body = <>
    {title ? <div className="pilot-card-head"><h2>{title}</h2>{action ?? <span className="pilot-chip slate">NA</span>}</div> : null}
    <ul className="na-strip-slots" aria-label={listLabel}>
      {slots.map((slot, index) => <NaSlotChip key={`${slot.label}:${index}`} label={slot.label} value={slot.value} />)}
    </ul>
    <p className="na-reason">{reason}</p>
  </>;
  return card
    ? <section className={`pilot-card na-strip ${className}`.trim()} data-na-strip="true">{body}</section>
    : <div className={`na-strip na-strip--inline ${className}`.trim()} data-na-strip="true">{body}</div>;
}

/**
 * A chart frame that only draws when every point is a shown number. A suppressed or missing
 * point would have to be drawn as zero — a misleading line — so the frame shows `note`
 * instead, keeping the widget, its title and its height.
 */
export function SuppressedChart({ points, note, label, height = 96, children }: {
  readonly points: readonly (number | null | undefined)[];
  readonly note: string;
  readonly label: string;
  readonly height?: number;
  readonly children: ReactNode;
}): React.ReactElement {
  const drawable = points.length > 0 && points.every((point) => typeof point === 'number');
  if (drawable) return <>{children}</>;
  return <div className="na-chart-empty" data-chart-state="empty" role="note" aria-label={`${label}: ${note}`} style={{ minHeight: height }}>
    <span className="na-chart-axis" aria-hidden="true" />
    <p>{note}</p>
  </div>;
}

export interface CountBarRow {
  readonly label: string;
  /** The text the server sent: a number as a string, "<5", "Withheld" or "NA". */
  readonly display: string;
  /** The shown count, or null when it is suppressed or missing (no bar is drawn). */
  readonly value: number | null;
}

/**
 * A compact label / bar / count table for a short series. Bars scale over shown counts only.
 * When no row has a shown count there is nothing to compare, so the series becomes one strip
 * that still names every row with its value, above `emptyReason`.
 */
export function CountBars({ rows, label, labelHeading, valueHeading, emptyReason }: {
  readonly rows: readonly CountBarRow[]; readonly label: string; readonly labelHeading: string; readonly valueHeading: string;
  readonly emptyReason: string;
}): React.ReactElement {
  if (rows.length && rows.every((row) => row.value === null)) {
    return <NaSlotStrip card={false} label={label} slots={rows.map((row) => ({ label: row.label, value: row.display }))} reason={emptyReason} />;
  }
  const max = Math.max(1, ...rows.map((row) => row.value ?? 0));
  return <table className="na-count-table" aria-label={label}>
    <thead><tr><th scope="col">{labelHeading}</th><th scope="col"><span className="sr-only">Bar</span></th><th scope="col">{valueHeading}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={`${row.label}:${index}`} data-na={row.value === null ? 'true' : undefined}>
      <th scope="row">{row.label}</th>
      <td className="na-count-bar"><span className="na-count-track" aria-hidden="true">{row.value === null ? null : <i style={{ width: `${(row.value / max) * 100}%` }} />}</span></td>
      <td className="na-count-value"><NaValue value={row.display} /></td>
    </tr>)}</tbody>
  </table>;
}

/** The single caption under a table that holds withheld cells. */
export function SuppressionNote({ children }: { readonly children: ReactNode }): React.ReactElement {
  return <p className="na-caption">{children}</p>;
}
