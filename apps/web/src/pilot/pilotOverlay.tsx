import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Bell, CalendarDays, CheckCircle2, MessageSquare, Search, X } from 'lucide-react';
import { pilotTodayPlan, pilotUpcoming } from './pilotData.js';

/**
 * The pilot's interaction layer: one modal, one toast, and a delegated click
 * fallback so that no visible control is ever dead in a client demo.
 *
 * Buttons with a bespoke behaviour (advancing an applicant, posting a role)
 * call stopPropagation and handle themselves; everything else bubbles to the
 * shell where the label and surrounding card decide which sample dialog opens.
 * Exports and downloads produce real sample files; forms end in a toast.
 */

export interface ModalState {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: React.ReactNode;
}

interface OverlayApi {
  openModal(modal: ModalState): void;
  closeModal(): void;
  toast(message: string): void;
}

const OverlayContext = createContext<OverlayApi | null>(null);

export function useOverlay(): OverlayApi {
  const api = useContext(OverlayContext);
  if (!api) throw new Error('useOverlay must be used inside PilotOverlayProvider');
  return api;
}

export function PilotOverlayProvider({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMessage(message);
    toastTimer.current = setTimeout(() => setToastMessage(null), 3200);
  }, []);
  const openModal = useCallback((next: ModalState) => setModal(next), []);
  const closeModal = useCallback(() => setModal(null), []);

  useEffect(() => {
    if (!modal) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  return <OverlayContext.Provider value={{ openModal, closeModal, toast }}>
    {children}
    {modal ? (
      <div className="pilot-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <div className="pilot-modal" role="dialog" aria-modal="true" aria-label={modal.title}>
          <div className="pilot-modal-head">
            <div>
              <h2>{modal.title}</h2>
              {modal.subtitle ? <small>{modal.subtitle}</small> : null}
            </div>
            <button type="button" className="pilot-icon-button" aria-label="Close dialog" onClick={closeModal}><X size={16} /></button>
          </div>
          <div className="pilot-modal-body">{modal.body}</div>
        </div>
      </div>
    ) : null}
    {toastMessage ? <div className="pilot-toast" role="status">{toastMessage}</div> : null}
  </OverlayContext.Provider>;
}

// --- Building blocks used by modal bodies ------------------------------------

export interface OverlayField {
  readonly label: string;
  readonly name?: string;
  readonly type?: 'text' | 'email' | 'number' | 'date' | 'time' | 'select' | 'textarea';
  readonly value?: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

export function OverlayForm({ fields, submitLabel, success, onSubmit }: {
  readonly fields: readonly OverlayField[];
  readonly submitLabel: string;
  readonly success: string;
  readonly onSubmit?: (values: Readonly<Record<string, string>>) => void;
}): React.ReactElement {
  const overlay = useOverlay();
  return <form onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values: Record<string, string> = {};
    for (const field of fields) { const key = field.name ?? field.label; values[key] = String(data.get(key) ?? ''); }
    onSubmit?.(values);
    overlay.closeModal();
    overlay.toast(success);
  }}>
    {fields.map((field) => {
      const name = field.name ?? field.label;
      return (
        <label key={name} className="pilot-field">
          <span>{field.label}</span>
          {field.type === 'textarea' ? <textarea name={name} rows={3} defaultValue={field.value} placeholder={field.placeholder} />
            : field.type === 'select' ? <select name={name} defaultValue={field.value}>{(field.options ?? []).map((option) => <option key={option}>{option}</option>)}</select>
            : <input name={name} type={field.type ?? 'text'} defaultValue={field.value} placeholder={field.placeholder} />}
        </label>
      );
    })}
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn ghost" onClick={overlay.closeModal}>Cancel</button>
      <button type="submit" className="pilot-btn">{submitLabel}</button>
    </div>
  </form>;
}

export function DetailRows({ rows }: { readonly rows: readonly (readonly [string, string])[] }): React.ReactElement {
  return <div className="pilot-detail-rows">
    {rows.map(([label, value]) => (
      <div key={label}><small>{label}</small><strong>{value}</strong></div>
    ))}
  </div>;
}

export interface ListRow {
  readonly title: string;
  readonly detail?: string;
  readonly trailing?: string;
}

/** A ready-made modal body listing the full dataset behind a "View All" control. */
export function listModal(title: string, subtitle: string, rows: readonly ListRow[]): ModalState {
  return {
    title, subtitle, body: <div className="pilot-list">
      {rows.map((row) => (
        <div key={row.title} className="pilot-list-row" style={{ padding: '9px 2px' }}>
          <CheckCircle2 size={15} color="#1f55e5" style={{ flexShrink: 0 }} />
          <div className="grow"><strong style={{ fontSize: 12.5 }}>{row.title}</strong>{row.detail ? <small>{row.detail}</small> : null}</div>
          {row.trailing ? <small style={{ whiteSpace: 'nowrap' }}>{row.trailing}</small> : null}
        </div>
      ))}
    </div>,
  };
}

/** Generates and downloads a real CSV so exports behave like the full product. */
export function downloadCsv(filename: string, rows: readonly (readonly string[])[]): void {
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function LaunchBody({ context, action }: { readonly context: string; readonly action: string }): React.ReactElement {
  const overlay = useOverlay();
  return <div>
    <p className="pilot-modal-text">You&apos;re about to open <strong>{context}</strong>. The pilot walks through it with sample content.</p>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn ghost" onClick={overlay.closeModal}>Not now</button>
      <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); overlay.toast(`${context} opened in sample mode.`); }}>{action}</button>
    </div>
  </div>;
}

function InfoBody({ label, context }: { readonly label: string; readonly context: string }): React.ReactElement {
  const overlay = useOverlay();
  return <div>
    <p className="pilot-modal-text"><strong>{label}</strong> expands <strong>{context}</strong> to the complete list with filters, sorting and history. The pilot keeps this preview to the sample rows already on the page.</p>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn" onClick={overlay.closeModal}>Got it</button>
    </div>
  </div>;
}

// --- Shell-level config: persona-specific notifications, messages, search ----

export interface SearchEntry {
  readonly label: string;
  readonly detail: string;
  readonly navKey?: string;
}

export interface PilotShellConfig {
  readonly pageTitle: string;
  readonly notifications: readonly (readonly [string, string])[];
  readonly notificationsBody?: React.ReactNode;
  readonly messages: readonly (readonly [string, string])[];
  readonly searchIndex: readonly SearchEntry[];
  readonly onNavigate?: (pageKey: string) => void;
  readonly identityCard?: ModalState;
}

function SearchBody({ config }: { readonly config: PilotShellConfig }): React.ReactElement {
  const overlay = useOverlay();
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const results = trimmed
    ? config.searchIndex.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(trimmed)).slice(0, 8)
    : config.searchIndex.slice(0, 5);
  return <div>
    <label className="pilot-field">
      <span>Search</span>
      <input autoFocus type="text" placeholder="Pages, courses, companies, people…" value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
    </label>
    {results.length === 0 ? <p className="pilot-modal-text">No sample results for &ldquo;{query}&rdquo;.</p> : (
      <div className="pilot-list">
        {results.map((entry) => (
          <div key={`${entry.label}-${entry.detail}`} className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <Search size={14} color="#5d6b82" style={{ flexShrink: 0 }} />
            <div className="grow"><strong style={{ fontSize: 12.5 }}>{entry.label}</strong><small>{entry.detail}</small></div>
            {entry.navKey && config.onNavigate ? (
              <button type="button" className="pilot-btn ghost small"
                onClick={() => { config.onNavigate?.(entry.navKey ?? ''); overlay.closeModal(); }}>Open</button>
            ) : null}
          </div>
        ))}
      </div>
    )}
  </div>;
}

function shellModal(kind: 'notifications' | 'messages' | 'search', config: PilotShellConfig): ModalState {
  if (kind === 'search') {
    return { title: 'Search', subtitle: 'Searches the pilot sample data', body: <SearchBody config={config} /> };
  }
  if (kind === 'messages') {
    return {
      title: 'Messages', subtitle: `${config.messages.length} conversations`, body: <div className="pilot-list">
        {config.messages.map(([from, preview]) => (
          <div key={from} className="pilot-list-row" style={{ alignItems: 'flex-start' }}>
            <span className="pilot-tile blue"><MessageSquare size={15} /></span>
            <div className="grow"><strong>{from}</strong><small>{preview}</small></div>
          </div>
        ))}
      </div>,
    };
  }
  if (config.notificationsBody) {
    return { title: 'Notifications', subtitle: 'Dismiss, mark read, or clear', body: config.notificationsBody };
  }
  return {
    title: 'Notifications', subtitle: `${config.notifications.length} unread`, body: <div className="pilot-list">
      {config.notifications.map(([text, when]) => (
        <div key={text} className="pilot-list-row" style={{ alignItems: 'flex-start' }}>
          <span className="pilot-tile amber"><Bell size={15} /></span>
          <div className="grow"><strong style={{ fontWeight: 600, fontSize: 12.5 }}>{text}</strong><small>{when}</small></div>
        </div>
      ))}
    </div>,
  };
}

// --- The delegated fallback ---------------------------------------------------

function contextOf(button: HTMLElement, fallback: string): string {
  const row = button.closest('.pilot-list-row, tr, .pilot-course-card, .pilot-step-card, .pilot-cat, .pilot-stat, .pilot-tool-card');
  const rowTitle = row?.querySelector('strong')?.textContent?.trim();
  if (rowTitle) return rowTitle;
  const card = button.closest('section');
  const cardTitle = card?.querySelector('h2')?.textContent?.trim();
  return cardTitle || fallback;
}

function modalForAction(label: string, context: string): ModalState | { readonly toastOnly: string } | { readonly download: true } {
  const lower = label.toLowerCase();
  if (/download|export|pdf|csv/.test(lower)) return { download: true };
  if (/share|sync|copy/.test(lower)) {
    return { toastOnly: `${context}: ${label.toLowerCase()} completed (sample).` };
  }
  if (/apply/.test(lower)) {
    return {
      title: `Apply — ${context}`, subtitle: 'Sample application', body: <OverlayForm
        fields={[
          { label: 'Applying as', value: 'Arjun Reddy · VIT Chennai' },
          { label: 'Resume', type: 'select', value: 'Software Engineer Resume (score 78)', options: ['Software Engineer Resume (score 78)', 'Internship Resume (score 72)', 'Campus Placement Resume (score 68)'] },
          { label: 'Cover note', type: 'textarea', placeholder: 'A short note to the recruiter (optional)' },
        ]}
        submitLabel="Submit Application" success={`Application submitted for ${context} (sample).`} />,
    };
  }
  if (/register|enroll|enrol/.test(lower)) {
    return {
      title: `Register — ${context}`, subtitle: 'Sample registration', body: <OverlayForm
        fields={[
          { label: 'Registering as', value: 'Arjun Reddy · VIT2027-0412' },
          { label: 'Confirmation email', type: 'email', value: 'demo.student@uat.example.test' },
        ]}
        submitLabel="Confirm Registration" success={`Registered for ${context} (sample).`} />,
    };
  }
  if (/schedule|reschedule/.test(lower)) {
    return {
      title: `${label} — ${context}`, subtitle: 'Sample scheduling', body: <OverlayForm
        fields={[
          { label: 'Date', type: 'date', value: '2026-05-26' },
          { label: 'Time', type: 'time', value: '14:00' },
          { label: 'Mode', type: 'select', value: 'Video', options: ['Video', 'Phone', 'In person'] },
        ]}
        submitLabel="Save Schedule" success={`${context} scheduled (sample).`} />,
    };
  }
  if (/invite|add /.test(lower)) {
    return {
      title: label, subtitle: `For ${context}`, body: <OverlayForm
        fields={[
          { label: 'Title', placeholder: 'Give it a name' },
          { label: 'Details', type: 'textarea', placeholder: 'A short description…' },
        ]}
        submitLabel="Save" success={`${label} saved (sample).`} />,
    };
  }
  if (/start|continue|resume|open|launch|practi[cs]e|attempt|take|join|begin|play|prepare|try|explore/.test(lower)) {
    return { title: context, subtitle: label, body: <LaunchBody context={context} action={label} /> };
  }
  if (/edit|update|change|manage|settings|customi[sz]e|goal|filter|sort|preference|retry|get feedback|need help|chat/.test(lower)) {
    return {
      title: `${label} — ${context}`, subtitle: 'Sample form', body: <OverlayForm
        fields={[
          { label: 'Name', value: context },
          { label: 'Status', type: 'select', value: 'Active', options: ['Active', 'Paused', 'Archived'] },
          { label: 'Notes', type: 'textarea', placeholder: 'What would you like to change?' },
        ]}
        submitLabel="Save Changes" success={`${context} updated (sample).`} />,
    };
  }
  if (/view full plan|full plan/.test(lower)) {
    return {
      title: "Today's Plan", subtitle: `${pilotTodayPlan.length} tasks · ${pilotTodayPlan.reduce((sum, task) => sum + task.minutes, 0)} min total`, body: <div className="pilot-list">
        {pilotTodayPlan.map((task) => (
          <div key={task.title} className="pilot-list-row" style={{ padding: '9px 2px' }}>
            <CheckCircle2 size={15} color={task.done ? '#0d6b4f' : '#c2ccda'} style={{ flexShrink: 0 }} />
            <div className="grow"><strong style={{ fontSize: 12.5 }}>{task.title}</strong></div>
            <small>{task.minutes} min</small>
          </div>
        ))}
      </div>,
    };
  }
  if (/view calendar|calendar/.test(lower)) {
    return {
      title: 'Calendar', subtitle: 'Coming up this week', body: <div className="pilot-list">
        {pilotUpcoming.map((item) => (
          <div key={item.title} className="pilot-list-row">
            <span className="pilot-tile blue"><CalendarDays size={15} /></span>
            <div className="grow"><strong>{item.title}</strong><small>{item.when}</small></div>
          </div>
        ))}
      </div>,
    };
  }
  return { title: context, subtitle: label, body: <InfoBody label={label} context={context} /> };
}

export function usePilotClickFallback(config: PilotShellConfig): (event: React.MouseEvent<HTMLElement>) => void {
  const overlay = useOverlay();
  return useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.pilot-search')) { overlay.openModal(shellModal('search', config)); return; }
    if (target.closest('.pilot-user') && config.identityCard) { overlay.openModal(config.identityCard); return; }
    const button = target.closest('button');
    if (!button || button.closest('.pilot-modal-backdrop')) return;
    const aria = button.getAttribute('aria-label') ?? '';
    if (/notification/i.test(aria)) { overlay.openModal(shellModal('notifications', config)); return; }
    if (/message/i.test(aria)) { overlay.openModal(shellModal('messages', config)); return; }
    const label = (aria || button.textContent || '').replace(/\s+/g, ' ').trim();
    if (!label) return;
    const context = contextOf(button, config.pageTitle);
    const result = modalForAction(label, context);
    if ('toastOnly' in result) { overlay.toast(result.toastOnly); return; }
    if ('download' in result) {
      const filename = `${context.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-sample.csv`;
      downloadCsv(filename, [
        ['ONE by Ai8ht — sample export', ''],
        ['Context', context],
        ['Generated from', 'Pilot preview (sample data only)'],
      ]);
      overlay.toast(`${filename} downloaded (sample data).`);
      return;
    }
    overlay.openModal(result);
  }, [overlay, config]);
}

export function PilotTabs({ labels, active, onChange }: {
  readonly labels: readonly string[];
  readonly active: number;
  readonly onChange: (index: number) => void;
}): React.ReactElement {
  return <div className="pilot-tabs">
    {labels.map((tab, index) => (
      <button key={tab} type="button" className={`pilot-tab ${index === active ? 'active' : ''}`}
        onClick={(event) => { event.stopPropagation(); onChange(index); }}>{tab}</button>
    ))}
  </div>;
}
