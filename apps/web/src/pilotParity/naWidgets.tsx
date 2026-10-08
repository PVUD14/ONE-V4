/**
 * ONE · Pilot-parity — Shared
 *
 * The NA ring, list and tile cards, and the navigation helper. The pilot
 * composition is kept and the missing engine is stated, never hidden: a card with
 * nothing to show is a compact strip that still names every slot (naState.tsx).
 */
import { NaSlotStrip } from '../naState.js';

export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function NaRingRailCard({ title, center, legend, reason = 'Not recorded yet — these figures appear once ONE records them.' }: {
  readonly title: string; readonly center: string; readonly legend: readonly string[]; readonly reason?: string;
}): React.ReactElement {
  // Nothing to draw: an empty ring with a column of NA reads as broken, so every slot (the ring's
  // centre figure and each legend entry) stays as a labelled NA chip above one reason line.
  return <NaSlotStrip title={title} slots={[{ label: center }, ...legend.map((label) => ({ label }))]} reason={reason} />;
}

export function NaListCard({ title, note }: { readonly title: string; readonly note: string }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>{note}</p>
  </section>;
}

/** Course-style tiles with no source yet: one strip with a chip per slot instead of a row of empty tiles. */
export function NaCourseTiles({ title, slots, reason }: { readonly title: string; readonly slots: readonly string[]; readonly reason: string }): React.ReactElement {
  return <NaSlotStrip title={title} slots={slots.map((label) => ({ label }))} reason={reason} />;
}

// --- Practice ----------------------------------------------------------------
