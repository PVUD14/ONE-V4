/**
 * <SmallCount>: how an aggregate count of people is drawn on every portal (product rule 3).
 *
 * A count under five, or one the server withheld, reads "<5" and nothing else: no count-up, no
 * proportional bar, step or height. In a chart the slot instead takes the uniform hatched
 * "suppressed" block from the approved institution screens (06-screens/README-institution.md),
 * the same size whatever the hidden value, so the drawing gives nothing away either.
 *
 * The text rule lives in ./smallCountRule.ts; styles are in styles/components.css (.small-count,
 * .sc-hatch, .sc-legend).
 */
import React from 'react';
import { isSmallCount, rangeCountText, smallCountText, SMALL_COUNT_TEXT, type SuppressibleCount } from './smallCountRule.js';

export { isSmallCount, isSmallCountText, partitionNeedsRanges, rangeCountText, shownCount, smallCountText, SMALL_COUNT_TEXT, SMALL_COUNT_THRESHOLD, type SuppressibleCount } from './smallCountRule.js';

const SMALL_COUNT_TITLE = 'Fewer than 5 — withheld so no one can be singled out';
const RANGE_TITLE = 'Shown as a range so a smaller group cannot be worked out from the total';

export interface SmallCountProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'title'> {
  readonly value: SuppressibleCount;
  /**
   * `text` (default): the count, or "<5".
   * `chart`: for a bar, funnel or step — a shown count is drawn by the caller, a small count is the
   * uniform hatched block followed by "<5".
   */
  readonly variant?: 'text' | 'chart';
  /** Formats a shown count (defaults to String). */
  readonly format?: (value: number) => string;
  /**
   * Draw a count of five or more as a five-wide range ("5–9") — where an exact figure next to a
   * visible total would let a hidden "<5" group be worked out (see partitionNeedsRanges).
   */
  readonly range?: boolean;
}

export function SmallCount({ value, variant = 'text', format, range = false, className, ...rest }: SmallCountProps): React.ReactElement {
  const extra = className ? ` ${className}` : '';
  if (range && !isSmallCount(value)) return <span {...rest} className={`small-count is-range${extra}`} title={RANGE_TITLE} data-range="true">{rangeCountText(value)}</span>;
  if (!isSmallCount(value)) return <span {...rest} className={`small-count${extra}`}>{smallCountText(value, format)}</span>;
  if (variant === 'chart') {
    return <span {...rest} className={`small-count is-suppressed sc-chart${extra}`} title={SMALL_COUNT_TITLE} data-suppressed="true">
      <SuppressedBlock /><span className="sc-text">{SMALL_COUNT_TEXT}</span>
    </span>;
  }
  return <span {...rest} className={`small-count is-suppressed${extra}`} title={SMALL_COUNT_TITLE} data-suppressed="true">{SMALL_COUNT_TEXT}</span>;
}

/**
 * The uniform hatched block that stands in for a suppressed value inside a chart: one fixed size,
 * dashed outline, diagonal hatching. `shape="bar"` fills a bar track's width-independent slot;
 * `shape="step"` is the 22px block used for climb steps and band cells.
 */
export function SuppressedBlock({ shape = 'bar' }: { readonly shape?: 'bar' | 'step' }): React.ReactElement {
  return <i className={`sc-hatch sc-hatch--${shape}`} aria-hidden="true" data-suppressed="true" />;
}

/** The one-line legend a chart carries when it holds a hatched block. */
export function SuppressedLegend({ children }: { readonly children?: React.ReactNode }): React.ReactElement {
  return <p className="sc-legend"><i className="sc-hatch sc-hatch--legend" aria-hidden="true" />
    <span>{children ?? 'Hatched: fewer than 5, withheld. Its size shows nothing about the count.'}</span></p>;
}
