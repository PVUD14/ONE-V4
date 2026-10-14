// Tests for <BandClimb> and the range rule: a band distribution is four bands and never a score;
// a band under five is the uniform hatched block (no proportional step, bar or height); the mix
// bar and the cohort total appear only when nothing could be worked out from them.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { BandClimb, bandMonthLabel } from './bandClimb.js';
import { partitionNeedsRanges, rangeCountText } from './smallCountRule.js';
import { SmallCount } from './smallCount.js';

afterEach(cleanup);

const band = (code: string, count: number | null) => ({ band: code, count, suppressed: count === null });
const shownAll = { suppressed: false, cohortSize: 30, cohortSizeSuppressed: false, bands: [
  band('NOT_ENOUGH_EVIDENCE', 5), band('DEVELOPING', 8), band('PROGRESSING', 11), band('READY_FOR_NEXT_STEP', 6)] };
const withSmall = { suppressed: false, cohortSize: null, cohortSizeSuppressed: true, bands: [
  band('NOT_ENOUGH_EVIDENCE', null), band('DEVELOPING', 14), band('PROGRESSING', 9), band('READY_FOR_NEXT_STEP', null)] };

describe('<BandClimb>', () => {
  it('draws the four bands in order with their counts, the mix bar and the published total when nothing is suppressed', () => {
    const { container } = render(<BandClimb aggregate={shownAll} month="2026-09" />);
    const steps = within(screen.getByRole('list', { name: /Readiness bands, September 2026/ })).getAllByRole('listitem');
    expect(steps.map((step) => step.getAttribute('data-band'))).toEqual(['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP']);
    expect(steps[1]).toHaveTextContent('8students');
    expect(container.querySelector('.bclimb-stack')).not.toBeNull();
    expect(screen.getByText(/students with a band in September 2026/)).toHaveTextContent('30 students with a band');
    // Step height is band order (the --i custom property), never the head count.
    expect(steps.map((step) => (step as HTMLElement).style.getPropertyValue('--i'))).toEqual(['1', '2', '3', '4']);
    expect(container.textContent).not.toMatch(/%|score|average/i);
  });

  it('draws a suppressed band as the fixed hatched block, with no mix bar and no total', () => {
    const { container } = render(<BandClimb aggregate={withSmall} month="2026-09" />);
    const steps = within(screen.getByRole('list', { name: /Readiness bands/ })).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('<5');
    expect(steps[0]!.querySelector('.sc-hatch--step')).not.toBeNull();
    expect(steps[0]!.querySelector('.bclimb-bar')).toBeNull();
    expect(steps[1]!.querySelector('.bclimb-bar')).not.toBeNull();
    // Every hatched block is the same element with no size of its own.
    for (const hatch of container.querySelectorAll('.sc-hatch')) expect((hatch as HTMLElement).getAttribute('style')).toBeNull();
    expect(container.querySelector('.bclimb-stack')).toBeNull();
    expect(screen.queryByText(/students with a band/)).not.toBeInTheDocument();
    expect(screen.getByText(/Step height shows band order, not head count/)).toBeInTheDocument();
  });

  it('says in words that a distribution under five is withheld, and draws nothing', () => {
    const { container } = render(<BandClimb aggregate={{ suppressed: true, cohortSize: 0, cohortSizeSuppressed: true, bands: [] }} month="2026-09" />);
    expect(screen.getByText(/Fewer than five students had a band in September 2026/)).toBeInTheDocument();
    expect(container.querySelector('.bclimb-steps')).toBeNull();
  });

  it('shows ranges and no total or mix bar where another level\'s total is on the same view', () => {
    const { container } = render(<BandClimb aggregate={shownAll} month="2026-09" range />);
    const steps = within(screen.getByRole('list', { name: /Readiness bands/ })).getAllByRole('listitem');
    expect(steps.map((step) => step.querySelector('b')!.textContent)).toEqual(['5–9', '5–9', '10–14', '5–9']);
    expect(container.querySelector('.bclimb-stack')).toBeNull();
    expect(screen.queryByText(/students with a band/)).not.toBeInTheDocument();
  });

  it('names a reporting month in words', () => {
    expect(bandMonthLabel('2026-09')).toBe('September 2026');
    expect(bandMonthLabel(null)).toBeNull();
    expect(bandMonthLabel('not-a-month')).toBeNull();
  });
});

describe('no revealing totals', () => {
  it('draws a count of five or more as a five-wide range, and a small count as <5', () => {
    expect(rangeCountText(5)).toBe('5–9');
    expect(rangeCountText(32)).toBe('30–34');
    expect(rangeCountText(4)).toBe('<5');
    expect(rangeCountText({ suppressed: true, value: null })).toBe('<5');
    render(<p><SmallCount value={12} range /> <SmallCount value={3} range /></p>);
    expect(screen.getByText('10–14')).toHaveAttribute('data-range', 'true');
    expect(screen.getByText('<5')).toHaveAttribute('data-suppressed', 'true');
  });

  it('asks for ranges exactly when the small parts of a partition hold fewer than five people', () => {
    // 32 activated of 33: subtracting the exact 32 would reveal the single student left.
    expect(partitionNeedsRanges([32, 0, 0, 0, 1])).toBe(true);
    // Small parts that together hold five or more reveal only a group of five or more.
    expect(partitionNeedsRanges([20, 3, 2])).toBe(false);
    // Nothing small, nothing to hide.
    expect(partitionNeedsRanges([20, 9])).toBe(false);
    // A visible total beyond the listed parts counts as one more part (students without a batch).
    expect(partitionNeedsRanges([14, 11], 27)).toBe(true);
    expect(partitionNeedsRanges([14, 11], 25)).toBe(false);
    // A part the server withheld has no known size, so it always means ranges.
    expect(partitionNeedsRanges([{ suppressed: false, value: 14 }, { suppressed: true, value: null }])).toBe(true);
  });
});
