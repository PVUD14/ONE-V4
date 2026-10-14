/**
 * ONE · Pilot-parity — Shared
 *
 * The ring, list and tile cards for figures that have no source yet, and the navigation
 * helper. Momentum re-skin (owner decision, 2026-10-11): a card with nothing to show is
 * hidden, never drawn as "NA" (naState.tsx).
 */
import { NaSlotStrip } from '../naState.js';

export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function NaRingRailCard({ title, center, legend, reason = 'Not recorded yet — these figures appear once ONE records them.' }: {
  readonly title: string; readonly center: string; readonly legend: readonly string[]; readonly reason?: string;
}): React.ReactElement | null {
  // Nothing to draw: every slot has no source, so the strip (and with it the card) is hidden.
  return <NaSlotStrip title={title} slots={[{ label: center }, ...legend.map((label) => ({ label }))]} reason={reason} />;
}

/** A list card whose source is not live: hidden in the re-skin (it had only a "not live yet" note). */
export function NaListCard(_props: { readonly title: string; readonly note: string }): React.ReactElement | null {
  return null;
}

/** Course-style tiles with no source yet: one strip with a chip per slot instead of a row of empty tiles. */
export function NaCourseTiles({ title, slots, reason }: { readonly title: string; readonly slots: readonly string[]; readonly reason: string }): React.ReactElement | null {
  return <NaSlotStrip title={title} slots={slots.map((label) => ({ label }))} reason={reason} />;
}

// --- Practice ----------------------------------------------------------------
