// Tests for the small-count rule and <SmallCount>: every count under five reads "<5", and a
// suppressed value in a chart is the uniform hatched block, never a proportional bar.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SmallCount, SuppressedBlock, SuppressedLegend, isSmallCount, isSmallCountText, shownCount, smallCountText, SMALL_COUNT_TEXT } from './smallCount.js';

describe('small-count rule', () => {
  it('reads <5 for every count under five, zero included, and for the server suppressed shapes', () => {
    for (const value of [0, 1, 2, 3, 4]) expect(smallCountText(value)).toBe('<5');
    expect(smallCountText(null)).toBe('<5');
    expect(smallCountText({ suppressed: true, value: null })).toBe('<5');
    expect(smallCountText({ suppressed: true, count: null })).toBe('<5');
    expect(smallCountText({ suppressed: false, value: null })).toBe('<5');
    // A count that slipped through unsuppressed still never shows as 0-4.
    expect(smallCountText({ suppressed: false, value: 3 })).toBe('<5');
    expect(smallCountText({ suppressed: false, count: 2 })).toBe('<5');
  });

  it('shows five and above as the number, formatted by the caller', () => {
    expect(smallCountText(5)).toBe('5');
    expect(smallCountText({ suppressed: false, value: 1234 }, (value) => value.toLocaleString('en-IN'))).toBe('1,234');
    expect(shownCount({ suppressed: false, value: 12 })).toBe(12);
    expect(shownCount({ suppressed: false, value: 4 })).toBeNull();
    expect(isSmallCount(5)).toBe(false);
    expect(isSmallCount(4)).toBe(true);
  });

  it('recognises the small-count text and nothing else', () => {
    expect(isSmallCountText(SMALL_COUNT_TEXT)).toBe(true);
    expect(isSmallCountText(' <5 ')).toBe(true);
    expect(isSmallCountText('5')).toBe(false);
    expect(isSmallCountText('Withheld')).toBe(false);
    expect(isSmallCountText(4)).toBe(false);
  });
});

describe('<SmallCount>', () => {
  it('renders <5 for a small count, marked suppressed, and the value otherwise', () => {
    render(<p><SmallCount value={{ suppressed: true, value: null }} /> and <SmallCount value={42} /></p>);
    const small = screen.getByText('<5');
    expect(small).toHaveClass('small-count', 'is-suppressed');
    expect(small).toHaveAttribute('data-suppressed', 'true');
    expect(screen.getByText('42')).not.toHaveClass('is-suppressed');
  });

  it('never renders the hidden number', () => {
    const { container } = render(<SmallCount value={{ suppressed: false, value: 3 }} />);
    expect(container.textContent).toBe('<5');
  });

  it('in a chart, draws the one fixed hatched block with <5 — no width, height or step taken from the value', () => {
    const { container } = render(<div><SmallCount value={1} variant="chart" /><SmallCount value={4} variant="chart" /></div>);
    const blocks = container.querySelectorAll('.sc-hatch');
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toHaveClass('sc-hatch--bar');
      expect(block.getAttribute('style')).toBeNull();
      expect(block).toHaveAttribute('aria-hidden', 'true');
    }
    expect(container.textContent).toBe('<5<5');
  });

  it('exposes the hatched block and its legend for charts that draw their own rows', () => {
    const { container } = render(<div><SuppressedBlock shape="step" /><SuppressedLegend /></div>);
    expect(container.querySelector('.sc-hatch--step')).not.toBeNull();
    expect(screen.getByText(/fewer than 5, withheld/)).toBeInTheDocument();
  });
});
