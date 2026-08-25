import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { getProtectedAccessToken, listStudentExams } from './api.js';

interface DerivedNotification {
  readonly id: string;
  readonly text: string;
  readonly actionable: boolean;
}

/**
 * The student notification bell, fed by real account state instead of a
 * hardcoded count: assigned assessments not yet taken, attempts in progress,
 * and freshly published results. Degrades to an empty inbox when signed out
 * or when the API is unreachable.
 */
export function StudentNotificationsBell(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [items, setItems] = useState<readonly DerivedNotification[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) { setItems([]); return; }
    const abort = new AbortController();
    listStudentExams(token, abort.signal).then((response) => {
      const now = Date.now();
      const derived: DerivedNotification[] = [];
      for (const exam of response.assessments) {
        const windowOpen = now >= Date.parse(exam.startsAt) && now <= Date.parse(exam.endsAt);
        if (exam.openAttemptId) {
          derived.push({ id: `${exam.id}-open`, text: `Attempt in progress: ${exam.title} — resume before ${new Date(exam.endsAt).toLocaleString()}.`, actionable: true });
        } else if (windowOpen && exam.attemptsUsed < exam.attemptsAllowed) {
          derived.push({ id: `${exam.id}-due`, text: `Assessment assigned: ${exam.title} — open until ${new Date(exam.endsAt).toLocaleString()}.`, actionable: true });
        }
        if (exam.latestResult) {
          derived.push({ id: `${exam.id}-result`, text: `Result published: ${exam.title} — ${exam.latestResult.percentage}%.`, actionable: false });
        }
      }
      setItems(derived);
    }).catch(() => setItems([]));
    return () => abort.abort();
  }, [token]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const actionableCount = items.filter((item) => item.actionable).length;

  return (
    <div className="notify-bell" ref={containerRef}>
      <button className="icon-button notification" type="button" aria-label="Notifications" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <Bell size={18} />
        {actionableCount > 0 ? <span>{actionableCount}</span> : null}
      </button>
      {open ? (
        <div className="notify-flyout" role="dialog" aria-label="Notifications">
          <strong>Notifications</strong>
          {items.length ? (
            <ul>
              {items.map((item) => <li key={item.id} className={item.actionable ? 'actionable' : ''}>{item.text}</li>)}
            </ul>
          ) : (
            <p>You&apos;re all caught up — nothing needs your attention.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
