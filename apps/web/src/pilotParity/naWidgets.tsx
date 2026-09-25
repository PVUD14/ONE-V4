/**
 * ONE · Pilot-parity — Shared
 *
 * The NA ring, list and tile cards, and the navigation helper. The pilot
 * composition is kept and the missing engine is stated, never hidden.
 */
import { MultiRing } from '../pilot/pilotComponents.js';
import { BookOpen } from 'lucide-react';

export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function NaRingRailCard({ title, center, legend }: { readonly title: string; readonly center: string; readonly legend: readonly string[] }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <MultiRing segments={[]}>NA<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>{center}</div></MultiRing>
      <div className="pilot-legend" style={{ flex: 1 }}>
        {legend.map((label) => <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA</span></div>)}
      </div>
    </div>
  </section>;
}

export function NaListCard({ title, note }: { readonly title: string; readonly note: string }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>{note}</p>
  </section>;
}

export function NaCourseTiles({ title, labels }: { readonly title: string; readonly labels: readonly string[] }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <div className="pilot-row cols-5">
      {labels.map((label) => (
        <div key={label} className="pilot-course-card" style={{ opacity: .65 }}>
          <span className="pilot-tile" style={{ background: '#eef1f6', color: '#9aa5b8' }}><BookOpen size={17} /></span>
          <strong>{label}</strong>
          <small>NA — not live yet</small>
          <button type="button" className="pilot-btn ghost small" disabled>Open</button>
        </div>
      ))}
    </div>
  </section>;
}

// --- Practice ----------------------------------------------------------------
