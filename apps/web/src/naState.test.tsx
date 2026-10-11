/**
 * The shared "no data" presentation (naState.tsx), Momentum re-skin rule (owner decision
 * 2026-10-11): a figure with no source is hidden - a tile, chip or strip that would only say NA
 * is not drawn, and a missing value in a sentence reads "Not recorded" - while real suppression
 * (<5, Withheld, Too few answers) keeps its exact text, muted. A chart with any withheld point
 * draws no line; a series with no shown count becomes a labelled strip; and the student Practice
 * and Company Prep pages never say NA.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2Stat } from './dashboardsV2.js';
import { CountBars, NaSlotStrip, NaValue, PilotKpi, SuppressedChart, allMissing, missingKind } from './naState.js';
import { StudentCompanyPrepPage, StudentPracticePage } from './pilotParity/student.js';

vi.mock('./api.js', async (original) => ({
  ...await original<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(() => null),
}));

afterEach(cleanup);

describe('missing values', () => {
  it('classifies only the honest placeholders as missing, never a real figure', () => {
    expect(missingKind('NA')).toBe('na');
    expect(missingKind(null)).toBe('na');
    expect(missingKind('<5')).toBe('suppressed');
    expect(missingKind('<5 offers')).toBe('suppressed');
    expect(missingKind('Withheld')).toBe('withheld');
    expect(missingKind('Too few answers')).toBe('few');
    expect(missingKind('0')).toBeNull();
    expect(missingKind(0)).toBeNull();
    expect(missingKind('12')).toBeNull();
    expect(allMissing([])).toBe(false);
    expect(allMissing(['NA', '<5'])).toBe(true);
    expect(allMissing(['NA', '1'])).toBe(false);
  });

  it('keeps a suppressed value muted with its exact text, and says "Not recorded" for no source', () => {
    render(<p><NaValue value="<5" /> <NaValue value="12" /> <NaValue value={null} /></p>);
    expect(screen.getByText('<5')).toHaveClass('na-value');
    expect(screen.getByText('<5')).toHaveAttribute('data-na', 'suppressed');
    expect(screen.getByText('Not recorded')).toHaveAttribute('data-na', 'na');
    expect(screen.queryByText('NA')).toBeNull();
    expect(screen.getByText(/12/)).not.toHaveClass('na-value');
  });

  it('gives a suppressed stat tile its muted value and one reason line; hides a tile with no source', () => {
    render(<>
      <V2Stat icon="x" tone="blue" value="Too few answers" label="Offer acceptance" reason="Shown at 5+ answers each way" />
      <V2Stat icon="x" tone="blue" value={12} label="Applications" reason="Too few to show" />
      <PilotKpi icon={null} tone="blue" value="NA" label="Students Placed" reason="Not for your role" />
    </>);
    expect(screen.getByText('Too few answers')).toHaveClass('na-value');
    expect(screen.getByText('Shown at 5+ answers each way')).toHaveClass('na-reason');
    expect(screen.queryByText('Too few to show')).toBeNull();
    expect(screen.queryByText('Students Placed')).toBeNull();
    expect(screen.queryByText('Not for your role')).toBeNull();
  });
});

describe('an all-missing group', () => {
  it('keeps every suppressed slot labelled under one explanation, and leaves out slots with no source', () => {
    render(<NaSlotStrip title="Company prep" slots={[{ label: 'Target Companies' }, { label: 'Mock Interviews' }, { label: 'Offers', value: '<5' }]}
      reason="Fewer than 5 offers so far." />);
    const slots = within(screen.getByRole('list', { name: 'Company prep' })).getAllByRole('listitem');
    expect(slots.map((slot) => slot.textContent)).toEqual(['Offers <5']);
    expect(screen.getByRole('heading', { name: 'Company prep' })).toBeInTheDocument();
    expect(screen.getAllByText('Fewer than 5 offers so far.')).toHaveLength(1);
  });

  it('is not drawn at all when no slot has a source', () => {
    const { container } = render(<NaSlotStrip title="Company prep" slots={[{ label: 'Target Companies' }, { label: 'Mock Interviews', value: 'NA' }]}
      reason="Company prep is not live yet." />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('a chart with withheld points', () => {
  const line = <svg data-testid="line"><polyline points="0,0 1,1" /></svg>;

  it('shows the empty state, not a line, when every point is withheld', () => {
    render(<SuppressedChart label="Offers Trend" points={[null, null, null]} note="Not enough data yet — shown once there are 5 or more.">{line}</SuppressedChart>);
    expect(screen.queryByTestId('line')).toBeNull();
    expect(screen.getByRole('note', { name: /Offers Trend/ })).toHaveTextContent('Not enough data yet — shown once there are 5 or more.');
  });

  it('draws no line when even one point is withheld, since it would have to be drawn as zero', () => {
    render(<SuppressedChart label="Offers Trend" points={[7, null, 9]} note="Not enough data yet.">{line}</SuppressedChart>);
    expect(screen.queryByTestId('line')).toBeNull();
  });

  it('draws the chart when every point is shown', () => {
    render(<SuppressedChart label="Offers Trend" points={[7, 0, 9]} note="Not enough data yet.">{line}</SuppressedChart>);
    expect(screen.getByTestId('line')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('a short series', () => {
  it('draws a bar only for a shown count and mutes the withheld one', () => {
    const { container } = render(<CountBars label="Monthly trend" labelHeading="Month" valueHeading="Students" emptyReason="None yet."
      rows={[{ label: '2026-08', display: '<5', value: null }, { label: '2026-09', display: '52', value: 52 }]} />);
    const table = screen.getByRole('table', { name: 'Monthly trend' });
    expect(within(within(table).getByRole('row', { name: /2026-08/ })).getByText('<5')).toHaveClass('na-value');
    expect(within(table).getByRole('row', { name: /2026-09/ })).toHaveTextContent('52');
    expect(container.querySelectorAll('.na-count-track i')).toHaveLength(1);
  });

  it('becomes a labelled strip when no count is shown', () => {
    render(<CountBars label="Monthly trend" labelHeading="Month" valueHeading="Students" emptyReason="Every month had fewer than 5."
      rows={[{ label: '2026-08', display: '<5', value: null }, { label: '2026-09', display: '<5', value: null }]} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Monthly trend' })).getAllByRole('listitem').map((slot) => slot.textContent)).toEqual(['2026-08 <5', '2026-09 <5']);
    expect(screen.getByText('Every month had fewer than 5.')).toBeInTheDocument();
  });
});

describe('student pages with no source yet', () => {
  it('Practice hides every figure that has no source, and never says NA or invents a figure', () => {
    const { container } = render(<StudentPracticePage />);
    for (const name of ['Practice figures', 'Continue Practicing', 'Recommended for You', 'Practice Overview']) {
      expect(screen.queryByRole('list', { name })).toBeNull();
    }
    expect(container.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(document.querySelector('.pilot-course-card')).toBeNull();
  });

  it('Company Prep hides its figures that have no source, and never says NA', () => {
    const { container } = render(<StudentCompanyPrepPage />);
    expect(screen.queryByRole('list', { name: 'Company prep figures' })).toBeNull();
    expect(container.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });
});
