/**
 * Small layout helpers for the demo site's extra portals (lecturer, operations,
 * growth, graduate). They only compose the pilot's existing classes - pilot.css and
 * pilotComponents.tsx stay untouched - so these portals look exactly like the
 * student, placement-officer and employer pilots they sit beside.
 */
import type { LucideIcon } from 'lucide-react';

export type KpiItem = readonly [label: string, value: string | number, tone: string, icon: LucideIcon];

export function KpiRow({ items }: { readonly items: readonly KpiItem[] }): React.ReactElement {
  const columns = items.length >= 5 ? 'cols-5' : items.length === 4 ? 'cols-4' : items.length === 3 ? 'cols-3' : 'cols-2';
  return <div className={`pilot-row ${columns}`}>
    {items.map(([label, value, tone, Icon]) => (
      <section key={label} className="pilot-card pilot-kpi">
        <span className={`pilot-tile ${tone}`}><Icon size={17} /></span>
        <div><b>{value}</b><small>{label}</small></div>
      </section>
    ))}
  </div>;
}

export function PageHead({ title, detail, children }: { readonly title: string; readonly detail: string; readonly children?: React.ReactNode }): React.ReactElement {
  return <div className="pilot-page-head">
    <div className="pilot-greeting"><h1>{title}</h1><p>{detail}</p></div>
    {children ? <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>{children}</div> : null}
  </div>;
}

export function Funnel({ rows, tone = '' }: { readonly rows: readonly { readonly label: string; readonly value: number }[]; readonly tone?: string }): React.ReactElement {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return <div className="pilot-funnel">
    {rows.map((row) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        <div className={`pilot-bar ${tone}`}><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
        <span className="num">{row.value}</span>
      </div>
    ))}
  </div>;
}

export function Person({ initials, name, detail }: { readonly initials: string; readonly name: string; readonly detail?: string }): React.ReactElement {
  return <div className="pilot-person">
    <span className="pilot-avatar">{initials}</span>
    <span><strong>{name}</strong>{detail ? <small>{detail}</small> : null}</span>
  </div>;
}

/** Stops the pilot's click fallback from also opening a generic dialog for a wired control. */
export function wired(action: () => void): (event: React.MouseEvent) => void {
  return (event) => { event.stopPropagation(); action(); };
}

export function initialsOf(name: string): string {
  return name.replace(/^(Prof\.|Dr\.|Mr\.|Ms\.)\s+/, '').split(/\s+/).map((word) => word[0] ?? '').join('').slice(0, 2).toUpperCase();
}
