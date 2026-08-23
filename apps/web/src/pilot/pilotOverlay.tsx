import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Bell, CalendarDays, MessageSquare, X } from 'lucide-react';
import { pilotScores, pilotUpcoming } from './pilotData.js';

/**
 * The pilot's interaction layer: one modal, one toast, and a delegated click
 * fallback so that no visible control is ever dead in a client demo.
 *
 * Buttons with a bespoke behaviour (advancing an applicant, applying to a role)
 * call stopPropagation and handle themselves; everything else bubbles to the
 * shell where the label and surrounding card decide which sample dialog opens.
 * Nothing here talks to the API - every submit ends in a toast, every dialog
 * says what the control does in the full product.
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
  readonly type?: 'text' | 'email' | 'date' | 'time' | 'select' | 'textarea';
  readonly value?: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
}

export function OverlayForm({ fields, submitLabel, success, onSubmit }: {
  readonly fields: readonly OverlayField[];
  readonly submitLabel: string;
  readonly success: string;
  readonly onSubmit?: () => void;
}): React.ReactElement {
  const overlay = useOverlay();
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit?.(); overlay.closeModal(); overlay.toast(success); }}>
    {fields.map((field) => (
      <label key={field.label} className="pilot-field">
        <span>{field.label}</span>
        {field.type === 'textarea' ? <textarea rows={3} defaultValue={field.value} placeholder={field.placeholder} />
          : field.type === 'select' ? <select defaultValue={field.value}>{(field.options ?? []).map((option) => <option key={option}>{option}</option>)}</select>
          : <input type={field.type ?? 'text'} defaultValue={field.value} placeholder={field.placeholder} />}
      </label>
    ))}
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

function LaunchBody({ context, action }: { readonly context: string; readonly action: string }): React.ReactElement {
  const overlay = useOverlay();
  return <div>
    <p className="pilot-modal-text">You&apos;re about to open <strong>{context}</strong>. In the full product this launches the live experience; the pilot walks through it with sample content.</p>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn ghost" onClick={overlay.closeModal}>Not now</button>
      <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); overlay.toast(`${context} opened in sample mode.`); }}>{action}</button>
    </div>
  </div>;
}

function InfoBody({ label, context }: { readonly label: string; readonly context: string }): React.ReactElement {
  const overlay = useOverlay();
  return <div>
    <p className="pilot-modal-text">In the full product, <strong>{label}</strong> opens the complete view for <strong>{context}</strong> — live data, filters and history included. The pilot shows this preview with sample data only.</p>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn" onClick={overlay.closeModal}>Got it</button>
    </div>
  </div>;
}

// --- Canned dialogs for the shell's own controls -----------------------------

const NOTIFICATIONS = [
  ['Aptitude Mock Test opens tomorrow at 10:00 AM', '2h ago'],
  ['Your application moved to Shortlisted at Zenvia Labs', 'Yesterday'],
  ['New course recommended: Operating Systems Basics', '2 days ago'],
] as const;

const MESSAGES = [
  ['Placement Cell', 'Reminder: registrations for the Kortex drive close Friday.'],
  ['Mentor - Kavya', 'Great progress on the SQL module. Try the practice set next.'],
] as const;

function cannedShellModal(kind: 'notifications' | 'messages' | 'search'): ModalState {
  if (kind === 'search') {
    return {
      title: 'Search', subtitle: 'Sample search across the pilot', body: <div>
        <label className="pilot-field"><span>What are you looking for?</span><input type="text" placeholder="Courses, tests, roles, companies…" /></label>
        <p className="pilot-modal-text">Search in the full product covers courses, assessments, opportunities and people. The pilot ships with sample content only.</p>
      </div>,
    };
  }
  if (kind === 'messages') {
    return {
      title: 'Messages', subtitle: '2 conversations', body: <div className="pilot-list">
        {MESSAGES.map(([from, preview]) => (
          <div key={from} className="pilot-list-row" style={{ alignItems: 'flex-start' }}>
            <span className="pilot-tile blue"><MessageSquare size={15} /></span>
            <div className="grow"><strong>{from}</strong><small>{preview}</small></div>
          </div>
        ))}
      </div>,
    };
  }
  return {
    title: 'Notifications', subtitle: '3 unread', body: <div className="pilot-list">
      {NOTIFICATIONS.map(([text, when]) => (
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

function modalForAction(label: string, context: string): ModalState | { readonly toastOnly: string } {
  const lower = label.toLowerCase();
  if (/download|export|pdf|share|sync|copy/.test(lower)) {
    return { toastOnly: `${context}: ${label.toLowerCase()} prepared — the pilot does not generate real files.` };
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
  if (/post a role|post role|extend offer|assign|invite|add /.test(lower)) {
    return {
      title: label, subtitle: `For ${context}`, body: <OverlayForm
        fields={[
          { label: 'Title', placeholder: 'e.g. Graduate Software Engineer' },
          { label: 'Details', type: 'textarea', placeholder: 'A short description…' },
          { label: 'Visibility', type: 'select', value: 'Draft', options: ['Draft', 'Publish now'] },
        ]}
        submitLabel="Save" success={`${label} saved (sample).`} />,
    };
  }
  if (/start|continue|resume|open|launch|practi[cs]e|attempt|take|join|begin|play|prepare|try|explore/.test(lower)) {
    return { title: context, subtitle: label, body: <LaunchBody context={context} action={label} /> };
  }
  if (/edit|update|change|manage|settings|customi[sz]e|goal|filter|sort|preference|complete profile|review|retry|get feedback|need help|chat/.test(lower)) {
    return {
      title: `${label} — ${context}`, subtitle: 'Sample form', body: <OverlayForm
        fields={[
          { label: 'Name', value: context },
          { label: 'Notes', type: 'textarea', placeholder: 'What would you like to change?' },
        ]}
        submitLabel="Save Changes" success={`${context} updated (sample).`} />,
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
  if (/full report|analytics|full plan|performance/.test(lower)) {
    return {
      title: 'Career Readiness Report', subtitle: 'Sample breakdown', body: <div>
        {pilotScores.map((score) => (
          <div key={score.label} className="pilot-skill">
            <header><b>{score.label}</b><span>{score.value}/100 · {score.band}</span></header>
            <div className={`pilot-bar thin ${score.tone}`}><i style={{ width: `${score.value}%` }} /></div>
          </div>
        ))}
        <p className="pilot-modal-text" style={{ marginTop: 10 }}>The full report adds question-level analysis, percentile ranks and a personalised improvement plan.</p>
      </div>,
    };
  }
  return { title: context, subtitle: label, body: <InfoBody label={label} context={context} /> };
}

export function usePilotClickFallback(pageTitle: string): (event: React.MouseEvent<HTMLElement>) => void {
  const overlay = useOverlay();
  return useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.pilot-search')) { overlay.openModal(cannedShellModal('search')); return; }
    const button = target.closest('button');
    if (!button || button.closest('.pilot-modal-backdrop')) return;
    const aria = button.getAttribute('aria-label') ?? '';
    if (/notification/i.test(aria)) { overlay.openModal(cannedShellModal('notifications')); return; }
    if (/message/i.test(aria)) { overlay.openModal(cannedShellModal('messages')); return; }
    const label = (aria || button.textContent || '').replace(/\s+/g, ' ').trim();
    if (!label) return;
    const result = modalForAction(label, contextOf(button, pageTitle));
    if ('toastOnly' in result) overlay.toast(result.toastOnly);
    else overlay.openModal(result);
  }, [overlay, pageTitle]);
}

export function PilotTabs({ labels }: { readonly labels: readonly string[] }): React.ReactElement {
  const [active, setActive] = useState(0);
  return <div className="pilot-tabs">
    {labels.map((tab, index) => (
      <button key={tab} type="button" className={`pilot-tab ${index === active ? 'active' : ''}`}
        onClick={(event) => { event.stopPropagation(); setActive(index); }}>{tab}</button>
    ))}
  </div>;
}
