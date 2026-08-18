import { Filter, Search, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export interface PageMeta {
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
}

export function PageHeader({ meta }: { readonly meta: PageMeta }): React.ReactElement {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{meta.eyebrow}</span>
        <h1>{meta.title}</h1>
        <p>{meta.description}</p>
      </div>
    </header>
  );
}

export function SectionTitle({ title, action, onAction }: { readonly title: string; readonly action?: string; readonly onAction?: () => void }): React.ReactElement {
  const [noted, setNoted] = useState(false);
  function handleAction(): void {
    if (onAction) onAction();
    else setNoted(true);
  }
  return <div className="section-title"><h2>{title}</h2>{action ? <button type="button" onClick={handleAction}>{action}</button> : null}{noted ? <span className="inline-feedback" role="status">{action} is available as a session-local preview action.</span> : null}</div>;
}

export function MetricCard({ label, value, suffix, detail, tone = 'student' }: { readonly label: string; readonly value: string; readonly suffix?: string; readonly detail: string; readonly tone?: 'student' | 'blue' | 'amber' | 'purple' }): React.ReactElement {
  return <section className={`card metric-card ${tone}`}><span>{label}</span><strong>{value}{suffix ? <small>{suffix}</small> : null}</strong><p>{detail}</p></section>;
}

export function StatusBadge({ label, tone = 'neutral' }: { readonly label: string; readonly tone?: 'success' | 'warning' | 'neutral' | 'info' | 'danger' }): React.ReactElement {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

export function VerificationBadge({ state }: { readonly state: string }): React.ReactElement {
  const tone = state.includes('Verified') ? 'success' : state.includes('Pending') || state.includes('Review') ? 'warning' : state.includes('Self') || state.includes('Claimed') ? 'info' : 'neutral';
  return <StatusBadge label={state} tone={tone} />;
}

export function EvidenceBadge({ strength }: { readonly strength: string }): React.ReactElement {
  const tone = strength === 'Strong' ? 'success' : strength === 'Medium' ? 'info' : 'warning';
  return <StatusBadge label={`${strength} evidence`} tone={tone} />;
}

export function ProgressRing({ value, label }: { readonly value: number; readonly label: string }): React.ReactElement {
  return <div className="progress-ring" style={{ '--ring-value': `${value * 3.6}deg` } as React.CSSProperties}><strong>{value}</strong><span>{label}</span></div>;
}

export function ProgressBar({ label, value, meta }: { readonly label: string; readonly value: number; readonly meta?: string }): React.ReactElement {
  return <div className="progress-line"><div><strong>{label}</strong><span>{value}%</span></div><div className="track"><span style={{ width: `${value}%` }} /></div>{meta ? <small>{meta}</small> : null}</div>;
}

export function FilterBar({ labels, selected = [], onChange, resultLabel, onClear }: { readonly labels: readonly string[]; readonly selected?: readonly string[]; readonly onChange?: (selected: readonly string[]) => void; readonly resultLabel?: string; readonly onClear?: () => void }): React.ReactElement {
  const [active, setActive] = useState<readonly string[]>(selected);
  const current = onChange ? selected : active;
  function toggle(label: string): void {
    const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
    setActive(next);
    onChange?.(next);
  }
  function clear(): void {
    setActive([]);
    onChange?.([]);
    onClear?.();
  }
  return (
    <div className="filter-block">
      <div className="filter-row" aria-label="Filters">
        {labels.map((label) => <button key={label} type="button" className={current.includes(label) ? 'selected' : ''} aria-pressed={current.includes(label)} onClick={() => toggle(label)}><Filter size={14} />{label}</button>)}
        {current.length ? <button type="button" className="secondary clear-filters" onClick={clear}>Clear filters</button> : null}
      </div>
      {resultLabel ? <p className="result-count" role="status" aria-live="polite">{resultLabel}</p> : null}
    </div>
  );
}

export function SearchField({ label, placeholder, value, onChange }: { readonly label: string; readonly placeholder: string; readonly value?: string; readonly onChange?: (value: string) => void }): React.ReactElement {
  return (
    <label className="local-search">
      <span>{label}</span>
      <span><Search size={15} aria-hidden="true" /><input placeholder={placeholder} value={value} onChange={(event) => onChange?.(event.target.value)} /></span>
    </label>
  );
}

export function EmptyState({ icon: Icon, title, detail, action }: { readonly icon: LucideIcon; readonly title: string; readonly detail: string; readonly action?: string }): React.ReactElement {
  return (
    <section className="empty-state">
      <Icon size={24} aria-hidden="true" />
      <div><h3>{title}</h3><p>{detail}</p></div>
      {action ? <DemoAction label={action} variant="secondary" detail="This preview action is available in the local UI only. Completing it requires the configured secure backend workflow." /> : null}
    </section>
  );
}

export function DataList<T>({ items, render }: { readonly items: readonly T[]; readonly render: (item: T, index: number) => ReactNode }): React.ReactElement {
  return <div className="data-list">{items.map((item, index) => <div key={index} className="data-list-item">{render(item, index)}</div>)}</div>;
}

export function Timeline({ items }: { readonly items: readonly { readonly date: string; readonly title: string; readonly detail?: string }[] }): React.ReactElement {
  return (
    <div className="timeline-mini">
      {items.map((item) => <article key={`${item.date}-${item.title}`}><span>{item.date}</span><strong>{item.title}</strong>{item.detail ? <p>{item.detail}</p> : null}</article>)}
    </div>
  );
}

export function IllustrationPanel({ children, image }: { readonly children: ReactNode; readonly image?: string }): React.ReactElement {
  return <section className="card page-hero-panel"><div>{children}</div>{image ? <img src={image} alt="" /> : null}</section>;
}

export function DemoAction({ label, detail, variant = 'primary' }: { readonly label: string; readonly detail: string; readonly variant?: 'primary' | 'secondary' }): React.ReactElement {
  return (
    <details className="demo-action">
      <summary className={variant === 'secondary' ? 'secondary-action' : undefined}>{label}</summary>
      <div role="note">
        <strong>Secure workflow required</strong>
        <p>{detail}</p>
      </div>
    </details>
  );
}
