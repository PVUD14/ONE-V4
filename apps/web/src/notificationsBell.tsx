import { useEffect, useRef, useState } from 'react';
import { Bell, MessageSquare } from 'lucide-react';
import { getProtectedAccessToken, listMyNotifications, listStudentExams, markAllNotificationsRead } from './api.js';

interface DerivedNotification {
  readonly id: string;
  readonly text: string;
  readonly actionable: boolean;
  /** INST-06: a college announcement, shown in its own list with who it is from. */
  readonly announcement?: { readonly title: string; readonly body: string; readonly from: string };
}

/** "From your faculty · Section X, Local College" — only what the server sent; nothing invented. */
function announcementSource(data: Record<string, string> | undefined): string {
  const from = data?.['from'];
  const audience = data?.['audience'];
  const institution = data?.['institutionName'];
  const parts = [from ? `From ${from}` : '', [audience, audience !== institution ? institution : ''].filter(Boolean).join(', ')].filter(Boolean);
  return parts.join(' · ') || 'From your college';
}

/**
 * The student notification bell: the persistent per-user feed (assignments,
 * reopenings, published results — the same feed the mobile app consumes),
 * merged with live derived state such as an attempt currently in progress.
 * Opening the flyout marks the feed read. Degrades to an empty inbox when
 * signed out or when the API is unreachable.
 */
export function StudentNotificationsBell(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [items, setItems] = useState<readonly DerivedNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) { setItems([]); setUnread(0); return; }
    const abort = new AbortController();
    Promise.allSettled([
      listMyNotifications(token, abort.signal),
      listStudentExams(token, abort.signal),
    ]).then(([feed, exams]) => {
      const merged: DerivedNotification[] = [];
      if (exams.status === 'fulfilled') {
        for (const exam of exams.value.assessments) {
          if (exam.openAttemptId) {
            merged.push({ id: `${exam.id}-open`, text: `Attempt in progress: ${exam.title} — resume before ${new Date(exam.endsAt).toLocaleString()}.`, actionable: true });
          }
        }
      }
      if (feed.status === 'fulfilled') {
        setUnread(feed.value.unreadCount);
        for (const note of feed.value.notifications.slice(0, 20)) {
          merged.push({
            id: note.id, text: `${note.title} — ${note.body}`, actionable: note.readAt === null,
            ...(note.kind === 'ANNOUNCEMENT' ? { announcement: { title: note.title, body: note.body, from: announcementSource(note.data) } } : {}),
          });
        }
      } else {
        setUnread(0);
      }
      setItems(merged);
    }).catch(() => { setItems([]); setUnread(0); });
    return () => abort.abort();
  }, [token]);

  useEffect(() => {
    if (!open || !token || unread === 0) return;
    // Opening the flyout acknowledges the feed; the in-progress reminder is
    // derived live and reappears on the next load regardless.
    markAllNotificationsRead(token).then(() => setUnread(0)).catch(() => undefined);
  }, [open, token, unread]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const liveActionable = items.filter((item) => item.id.endsWith('-open')).length;
  const announcements = items.filter((item) => item.announcement);
  const others = items.filter((item) => !item.announcement);
  const badgeCount = unread + liveActionable;

  return (
    <div className="notify-bell" ref={containerRef}>
      <button className="icon-button notification" type="button" aria-label="Notifications" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <Bell size={18} />
        {badgeCount > 0 ? <span>{badgeCount}</span> : null}
      </button>
      {open ? (
        <div className="notify-flyout" role="dialog" aria-label="Notifications">
          <strong>Notifications</strong>
          {announcements.length ? (
            <>
              <strong>Announcements</strong>
              <ul aria-label="Announcements">
                {announcements.map((item) => <li key={item.id} className={item.actionable ? 'actionable' : ''}>
                  {item.announcement!.title} — {item.announcement!.body}<br /><small>{item.announcement!.from}</small>
                </li>)}
              </ul>
            </>
          ) : null}
          {others.length ? (
            <ul>
              {others.map((item) => <li key={item.id} className={item.actionable ? 'actionable' : ''}>{item.text}</li>)}
            </ul>
          ) : null}
          {items.length ? null : (
            <p>You&apos;re all caught up — nothing needs your attention.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The student messages flyout. There is no messaging backend yet, so this is
 * an honest empty inbox rather than a dead button or a fake unread badge.
 */
export function StudentMessagesFlyout(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  return (
    <div className="notify-bell" ref={containerRef}>
      <button className="icon-button" type="button" aria-label="Messages" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <MessageSquare size={18} />
      </button>
      {open ? (
        <div className="notify-flyout" role="dialog" aria-label="Messages">
          <strong>Messages</strong>
          <p>No messages yet. Conversations with your placement cell and recruiters will arrive here once messaging launches.</p>
        </div>
      ) : null}
    </div>
  );
}
