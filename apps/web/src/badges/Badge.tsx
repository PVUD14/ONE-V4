/**
 * Momentum badges: one badge in its earned, locked or in-progress state, and the shelf that
 * lists them. Rendered from the catalogue (badges.json) and the approved art.
 *
 * The state always comes from the caller, which must take it from the backend: these
 * components never infer a badge from other data. The backend records no badges today, so no
 * screen mounts them yet; the guide forbids placeholders, and a shelf with nothing real to show
 * renders nothing at all.
 *
 *  - earned: the static earned art. When `newlyEarned`, the one-shot unlock plays once (and only
 *    once on this device), never under reduced motion.
 *  - in progress: the earned art fills the mould from the base to --p = done ÷ target, with the
 *    real count beside it ("4 of 7 days"). Badges with no meter (the band-based ones, and single
 *    events) have no in-progress state and show as locked with their criterion.
 *  - locked: the empty mould, with its criterion.
 *
 * Who sees what: `owner` (the student) sees everything. `employer` and `shared-profile` see only
 * earned badges the student chose to share, and never a band-based badge (First Climb, Ready For
 * Next Step) — readiness is never shown to an employer.
 */
import { useEffect, useState } from 'react';
import { badgeById, isBandBased, type BadgeDefinition } from './catalogue.js';
import { loadBadgeArt } from './art.js';
import './badges.css';

export type BadgeState =
  | { readonly status: 'earned'; readonly earnedOn?: string | undefined }
  | { readonly status: 'progress'; readonly done: number }
  | { readonly status: 'locked' };

export interface BadgeEntry {
  readonly id: string;
  readonly state: BadgeState;
  /** The student chose to show this badge on shared surfaces. */
  readonly shared?: boolean | undefined;
  /** Earned since the student last saw it: the unlock plays once. */
  readonly newlyEarned?: boolean | undefined;
}

export type BadgeAudience = 'owner' | 'employer' | 'shared-profile';

type Resolved = { readonly kind: 'earned' } | { readonly kind: 'progress'; readonly done: number; readonly target: number; readonly unit: string } | { readonly kind: 'locked' };

/** The state as drawn: progress without a meter is drawn locked; counts are whole and bounded. */
export function resolveBadgeState(badge: BadgeDefinition, state: BadgeState): Resolved {
  if (state.status === 'earned') return { kind: 'earned' };
  if (state.status === 'progress' && badge.progress.meter && badge.files.progress) {
    const target = badge.progress.target;
    const done = Math.max(0, Math.min(target, Math.floor(Number.isFinite(state.done) ? state.done : 0)));
    return { kind: 'progress', done, target, unit: badge.progress.unit };
  }
  return { kind: 'locked' };
}

/** --p for the in-progress art: done ÷ target, between 0 and 1. */
export function badgeFill(done: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(1, done / target));
}

/** The entries an audience may see. Employers and shared profiles get shared, earned, non-band badges only. */
export function visibleBadgesFor(audience: BadgeAudience, entries: readonly BadgeEntry[]): readonly BadgeEntry[] {
  return entries.filter((entry) => {
    const badge = badgeById(entry.id);
    if (!badge) return false;
    if (audience === 'owner') return true;
    return !isBandBased(badge) && entry.state.status === 'earned' && entry.shared === true;
  });
}

const order: Record<Resolved['kind'], number> = { earned: 0, progress: 1, locked: 2 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const unlockedKey = 'one.badges.unlockPlayed';

function unlockAlreadyPlayed(id: string): boolean {
  try { return (JSON.parse(window.localStorage.getItem(unlockedKey) ?? '[]') as string[]).includes(id); } catch { return false; }
}

function rememberUnlockPlayed(id: string): void {
  try {
    const played = new Set(JSON.parse(window.localStorage.getItem(unlockedKey) ?? '[]') as string[]);
    played.add(id);
    window.localStorage.setItem(unlockedKey, JSON.stringify([...played]));
  } catch { /* storage unavailable: it may play again on another visit, never twice in one mount */ }
}

/** Whether to play the unlock: newly earned, motion allowed, and not already played here. Decided once per mount. */
function useUnlockOnce(id: string, eligible: boolean): boolean {
  const [play] = useState(() => eligible && !prefersReducedMotion() && !unlockAlreadyPlayed(id));
  useEffect(() => { if (play) rememberUnlockPlayed(id); }, [id, play]);
  return play;
}

export function badgeLabel(badge: BadgeDefinition, resolved: Resolved): string {
  if (resolved.kind === 'earned') return `${badge.name} badge, earned`;
  if (resolved.kind === 'progress') return `${badge.name} badge, in progress: ${resolved.done} of ${resolved.target} ${resolved.unit}`;
  return `${badge.name} badge, locked. ${badge.criterion}`;
}

export function Badge({ entry, size = 96, index = 0 }: { readonly entry: BadgeEntry; readonly size?: number; readonly index?: number }): React.ReactElement | null {
  const badge = badgeById(entry.id);
  const resolved = badge ? resolveBadgeState(badge, entry.state) : null;
  const unlocking = useUnlockOnce(entry.id, Boolean(entry.newlyEarned) && resolved?.kind === 'earned');
  const file = !badge || !resolved ? null
    : resolved.kind === 'earned' ? (unlocking ? badge.files.animated : badge.files.earned)
      : resolved.kind === 'progress' ? badge.files.progress! : badge.files.locked;
  const [markup, setMarkup] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return undefined;
    let active = true;
    loadBadgeArt(file).then((svg) => { if (active) setMarkup(svg); }, () => { if (active) setMarkup(''); });
    return () => { active = false; };
  }, [file]);
  if (!badge || !resolved) return null;
  const style = {
    width: size,
    height: Math.round((size * 138) / 124),
    '--bk': index,
    ...(resolved.kind === 'progress' ? { '--p': badgeFill(resolved.done, resolved.target).toFixed(3) } : {}),
  } as React.CSSProperties;
  return <span
    className={`one-badge one-badge-${resolved.kind}${unlocking ? ' is-unlocking' : ''}`}
    role="img"
    aria-label={badgeLabel(badge, resolved)}
    data-badge={badge.id}
    data-state={resolved.kind}
    style={style}
    // The art is the approved SVG from the repository, prepared by art.ts; it carries no user data.
    dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
  />;
}

function detailFor(badge: BadgeDefinition, resolved: Resolved): string {
  if (resolved.kind === 'progress') return `${resolved.done} of ${resolved.target} ${resolved.unit}`;
  if (resolved.kind === 'locked') return badge.criterion;
  return badge.evidenceNeeded[0] ?? badge.criterion;
}

/**
 * The shelf: earned first, then in progress, then locked. `audience` is required so every caller
 * decides who is looking. Nothing to show renders nothing, never an empty or placeholder shelf.
 */
export function BadgeShelf({ entries, audience, limit, size = 96, label = 'Badges' }: {
  readonly entries: readonly BadgeEntry[];
  readonly audience: BadgeAudience;
  readonly limit?: number;
  readonly size?: number;
  readonly label?: string;
}): React.ReactElement | null {
  const rows = visibleBadgesFor(audience, entries)
    .map((entry) => ({ entry, badge: badgeById(entry.id)! }))
    .map((row) => ({ ...row, resolved: resolveBadgeState(row.badge, row.entry.state) }))
    .sort((a, b) => order[a.resolved.kind] - order[b.resolved.kind]);
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  if (shown.length === 0) return null;
  return <ul className="one-badge-shelf" aria-label={label}>
    {shown.map(({ entry, badge, resolved }, index) => <li key={badge.id}>
      <Badge entry={entry} size={size} index={index} />
      <span className="one-badge-name">{badge.name}</span>
      <span className="one-badge-detail">{detailFor(badge, resolved)}</span>
      {resolved.kind === 'earned' && entry.state.status === 'earned' && entry.state.earnedOn ? <em className="one-badge-when">Earned {entry.state.earnedOn}</em> : null}
    </li>)}
  </ul>;
}
