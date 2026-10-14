/**
 * Momentum badges: the catalogue, the three states, the one-shot unlock, and the privacy rule
 * that band-based badges (First Climb, Ready For Next Step) never reach an employer or a shared
 * profile. Also pins that no screen mounts a badge yet: the backend records none, and the guide
 * forbids placeholders.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { badgeCatalogue, badgeById, isBandBased } from './catalogue.js';
import { hasBadgeArt, prepareBadgeMarkup } from './art.js';
import { Badge, BadgeShelf, badgeFill, resolveBadgeState, visibleBadgesFor, type BadgeEntry } from './Badge.js';

function mockMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') ? reduced : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('badge catalogue', () => {
  it('carries the sixteen approved badges, each with its art on disk', () => {
    expect(badgeCatalogue).toHaveLength(16);
    for (const badge of badgeCatalogue) {
      expect(hasBadgeArt(badge.files.earned)).toBe(true);
      expect(hasBadgeArt(badge.files.locked)).toBe(true);
      expect(hasBadgeArt(badge.files.animated)).toBe(true);
      if (badge.progress.meter) expect(badge.files.progress && hasBadgeArt(badge.files.progress)).toBe(true);
      else expect(badge.files.progress).toBeNull();
    }
  });

  it('keeps exactly the band-based badges private, with no meter', () => {
    const banded = badgeCatalogue.filter(isBandBased).map((badge) => badge.id);
    expect(banded).toEqual(['first-climb', 'ready-for-next-step']);
    for (const id of banded) expect(badgeById(id)!.progress.meter).toBe(false);
  });

  it('ships no fictional sample state', () => {
    const json = readFileSync(join(process.cwd(), 'src', 'badges', 'badges.json'), 'utf8');
    expect(json).not.toMatch(/Arjun|Lakeview|"demo"/);
  });
});

describe('badge states', () => {
  it('fills in-progress art to done ÷ target and labels the real count', async () => {
    render(<Badge entry={{ id: 'streak-7', state: { status: 'progress', done: 4 } }} />);
    const badge = screen.getByRole('img', { name: 'Streak 7 badge, in progress: 4 of 7 days' });
    expect(badge).toHaveAttribute('data-state', 'progress');
    expect(badge.style.getPropertyValue('--p')).toBe('0.571');
    await waitFor(() => expect(badge.querySelector('svg')).not.toBeNull());
    // The baked demonstration value is stripped, so the real --p applies.
    expect(badge.querySelector('svg')!.getAttribute('style')).toBeNull();
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('bounds the count and the fill', () => {
    const badge = badgeById('practice-10')!;
    expect(resolveBadgeState(badge, { status: 'progress', done: 14 })).toEqual({ kind: 'progress', done: 10, target: 10, unit: 'practice sets' });
    expect(resolveBadgeState(badge, { status: 'progress', done: -2 })).toMatchObject({ done: 0 });
    expect(badgeFill(3, 0)).toBe(0);
    expect(badgeFill(9, 3)).toBe(1);
  });

  it('never draws a meter on a band-based or single-event badge: it shows locked with its criterion', () => {
    render(<Badge entry={{ id: 'first-climb', state: { status: 'progress', done: 1 } }} />);
    const badge = screen.getByRole('img', { name: /First Climb badge, locked/ });
    expect(badge).toHaveAttribute('data-state', 'locked');
    expect(badge.style.getPropertyValue('--p')).toBe('');
    expect(resolveBadgeState(badgeById('interview-bound')!, { status: 'progress', done: 1 })).toEqual({ kind: 'locked' });
  });

  it('draws locked badges with their criterion', () => {
    render(<Badge entry={{ id: 'peer-mentor', state: { status: 'locked' } }} />);
    expect(screen.getByRole('img', { name: 'Peer Mentor badge, locked. 3 different students mark your practice answers or feedback as helpful.' })).toBeInTheDocument();
  });
});

describe('unlock animation', () => {
  it('plays once when newly earned, using the layered art without its looping style', async () => {
    mockMotion(false);
    const entry: BadgeEntry = { id: 'on-a-roll', state: { status: 'earned' }, newlyEarned: true };
    const { unmount } = render(<Badge entry={entry} />);
    const badge = screen.getByRole('img', { name: 'On a Roll badge, earned' });
    expect(badge).toHaveClass('is-unlocking');
    await waitFor(() => expect(badge.querySelector('.bd-face')).not.toBeNull());
    expect(badge.innerHTML).not.toContain('@keyframes');
    unmount();
    render(<Badge entry={entry} />);
    expect(screen.getByRole('img', { name: 'On a Roll badge, earned' })).not.toHaveClass('is-unlocking');
  });

  it('shows the earned art at once under reduced motion', () => {
    mockMotion(true);
    render(<Badge entry={{ id: 'on-a-roll', state: { status: 'earned' }, newlyEarned: true }} />);
    expect(screen.getByRole('img', { name: 'On a Roll badge, earned' })).not.toHaveClass('is-unlocking');
  });
});

describe('who sees which badges', () => {
  const entries: BadgeEntry[] = [
    { id: 'first-climb', state: { status: 'earned', earnedOn: '19 Sep' }, shared: true },
    { id: 'ready-for-next-step', state: { status: 'earned' }, shared: true },
    { id: 'evidence-builder', state: { status: 'earned' }, shared: true },
    { id: 'on-a-roll', state: { status: 'earned' }, shared: false },
    { id: 'streak-7', state: { status: 'progress', done: 4 }, shared: true },
    { id: 'peer-mentor', state: { status: 'locked' } },
  ];

  it('never shows a band-based badge to an employer or on a shared profile, even when marked shared', () => {
    for (const audience of ['employer', 'shared-profile'] as const) {
      expect(visibleBadgesFor(audience, entries).map((entry) => entry.id)).toEqual(['evidence-builder']);
      cleanup();
      render(<BadgeShelf entries={entries} audience={audience} />);
      const shelf = screen.getByRole('list', { name: 'Badges' });
      expect(within(shelf).queryByText('First Climb')).not.toBeInTheDocument();
      expect(within(shelf).queryByText('Ready For Next Step')).not.toBeInTheDocument();
      expect(within(shelf).getAllByRole('listitem')).toHaveLength(1);
    }
  });

  it('shows the student everything, earned first, then in progress, then locked', () => {
    render(<BadgeShelf entries={[...entries].reverse()} audience="owner" />);
    const names = within(screen.getByRole('list', { name: 'Badges' })).getAllByRole('listitem').map((item) => item.querySelector('.one-badge-name')!.textContent);
    expect(names.slice(0, 4).sort()).toEqual(['Evidence Builder', 'First Climb', 'On a Roll', 'Ready For Next Step']);
    expect(names.slice(4)).toEqual(['Streak 7', 'Peer Mentor']);
    expect(screen.getByText('4 of 7 days')).toBeInTheDocument();
    expect(screen.getByText('Earned 19 Sep')).toBeInTheDocument();
  });

  it('renders nothing when there is nothing real to show, and ignores unknown ids', () => {
    const { container } = render(<BadgeShelf entries={[{ id: 'not-a-badge', state: { status: 'earned' } }]} audience="owner" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('art preparation', () => {
  it('strips the root label, the baked fill and any looping keyframes', () => {
    const prepared = prepareBadgeMarkup('<svg class="bd" role="img" aria-label="X badge" style="--p:0.57" viewBox="0 0 1 1"><title>X</title><style>@keyframes L{}</style><style>.bd-fill{}</style><g/></svg>');
    expect(prepared).toBe('<svg class="bd" viewBox="0 0 1 1" aria-hidden="true" focusable="false"><style>.bd-fill{}</style><g/></svg>');
  });
});

describe('no screen shows badges yet', () => {
  // When the backend records badges and a screen shows them, this pin is replaced by that screen's tests.
  it('is imported by no application module: the backend records no badges', () => {
    const src = join(process.cwd(), 'src');
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.replace(/\\/g, '/').startsWith('badges/'));
    const importers = files.filter((file) => /from '\.{1,2}\/(?:\.\.\/)*badges\//.test(readFileSync(join(src, file), 'utf8')));
    expect(importers).toEqual([]);
  });
});
