/**
 * <BandClimb>: a cohort's readiness band distribution, drawn as the approved institution climb
 * (unified/college-admin.html "Cohort readiness", 06-screens/README-institution.md).
 *
 * It exists so every institution screen draws a band distribution the same way and cannot break
 * the two rules that govern it: readiness is four advisory bands and never a score or an average
 * (rule 1), and a group under five is "<5" with no size cue (rule 3). So:
 *   - a step's height shows band order, never head count, and the chart says so;
 *   - a band under five (or withheld by the server) is the uniform hatched block, one fixed size;
 *   - the proportional mix bar is drawn only when no band is suppressed;
 *   - the cohort total is shown only when the server published it (it withholds the total
 *     whenever the hidden bands could be worked out from it);
 *   - `range` draws shown counts as five-wide ranges, for a view that also shows another level
 *     (a department beside its institution) where exact figures could be subtracted.
 * It takes the server's suppressed aggregate and nothing else; there is no way to pass a score.
 */
import React from 'react';
import { READINESS_BAND_LABELS, READINESS_BANDS, type ReadinessBandCode } from './readinessBand.js';
import { SmallCount, SuppressedBlock, SuppressedLegend, isSmallCount, shownCount } from './smallCount.js';

/** A band distribution as the server sends it (ReadinessAggregateDto). */
export interface BandAggregate {
  readonly suppressed: boolean;
  readonly cohortSize: number | null;
  readonly cohortSizeSuppressed: boolean;
  readonly bands: readonly { readonly band: string; readonly count: number | null; readonly suppressed: boolean }[];
}

/** One band's count as the server sent it; a band the server left out is withheld. */
export function bandCount(aggregate: BandAggregate, band: ReadinessBandCode): { readonly suppressed: boolean; readonly count: number | null } {
  const entry = aggregate.bands.find((item) => item.band === band);
  return entry ? { suppressed: entry.suppressed, count: entry.count } : { suppressed: true, count: null };
}

/** The month a distribution covers, in words: "2026-09" → "September 2026". */
export function bandMonthLabel(month: string | null | undefined): string | null {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function BandClimb({ aggregate, month, range = false, compact = false }: {
  readonly aggregate: BandAggregate;
  readonly month?: string | null;
  readonly range?: boolean;
  readonly compact?: boolean;
}): React.ReactElement {
  const monthLabel = bandMonthLabel(month);
  if (aggregate.suppressed) {
    return <p className="bclimb-withheld">
      Fewer than five students had a band{monthLabel ? ` in ${monthLabel}` : ''}, so the distribution is withheld: no band can be shown without singling someone out.
    </p>;
  }
  const counts = READINESS_BANDS.map((band) => bandCount(aggregate, band));
  const anySuppressed = counts.some((entry) => isSmallCount(entry));
  const total = aggregate.cohortSizeSuppressed ? null : aggregate.cohortSize;
  return <div className={`bclimb${compact ? ' bclimb--compact' : ''}`}>
    <ol className="bclimb-steps" aria-label={`Readiness bands${monthLabel ? `, ${monthLabel}` : ''}`}>
      {READINESS_BANDS.map((band, index) => {
        const entry = counts[index]!;
        const small = isSmallCount(entry);
        const style = { '--i': index + 1, '--c': `var(--band-${index + 1})`, '--k': index } as React.CSSProperties;
        return <li key={band} className={`bclimb-s${small ? ' is-suppressed' : ''}`} style={style} data-band={band}>
          <div className="bclimb-n"><b><SmallCount value={entry} range={range} /></b><span>students</span></div>
          {small ? <SuppressedBlock shape="step" /> : <i className="bclimb-bar" aria-hidden="true" />}
          <div className="bclimb-l"><i aria-hidden="true">{index + 1}</i><span>{READINESS_BAND_LABELS[band]}</span></div>
        </li>;
      })}
    </ol>
    {/* The mix bar is proportional, so it is drawn only when every band is shown exactly. */}
    {!anySuppressed && !range ? <div className="bclimb-stack" aria-hidden="true">
      {counts.map((entry, index) => <i key={READINESS_BANDS[index]} style={{ flex: shownCount(entry) ?? 0, background: `var(--band-${index + 1})` }} />)}
    </div> : null}
    {anySuppressed
      ? <SuppressedLegend>Hatched = fewer than five, drawn at one fixed size. Step height shows band order, not head count.{range ? ' Counts of five or more are ranges, so no group can be worked out from another total.' : ''}</SuppressedLegend>
      : <p className="sc-legend bclimb-legend">Step height shows band order, not head count.{range ? ' Counts are ranges, so no group can be worked out from another total.' : ''}</p>}
    {total !== null && total !== undefined && !range ? <p className="bclimb-total"><b><SmallCount value={total} /></b> students with a band{monthLabel ? ` in ${monthLabel}` : ''}</p> : null}
  </div>;
}
