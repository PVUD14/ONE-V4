/**
 * ONE · Role portal — Institution — Cohort announcements (INST-06)
 *
 * Compose an announcement to the students in the caller's scope, schedule or cancel it, and see
 * what was sent and how it was delivered — plus the caller's own inbox. The audiences offered are
 * exactly the ones the server says the caller may address; the server resolves recipients and
 * refuses anything else. Email delivery is shown as it really is: with no sender set up, the
 * screen says the email was not sent. Mounted on the faculty "Messages" item; the API serves
 * owners, admins, placement officers and department heads too (see the INST-06 goal report).
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  cancelInstitutionAnnouncement,
  createInstitutionAnnouncement,
  getProtectedAccessToken,
  listInstitutionAnnouncements,
  listMyNotifications,
} from '../api.js';
import type { AnnouncementAudienceDto, AnnouncementChannel, InstitutionAnnouncementDto, InstitutionAnnouncementListDto, UserNotificationDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, isInstitutionStaffWorkspace } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import { formatDateTime } from '../dates.js';
import { MISSING_TEXT } from '../labels.js';

/** Why a scheduled announcement is cancelled; recorded with it. */
export const announcementCancelReasons = [
  ['PLANS_CHANGED', 'Plans changed'],
  ['SENT_IN_ERROR', 'Sent in error'],
  ['DUPLICATE', 'Duplicate announcement'],
] as const;

const unitKindLabels: Readonly<Record<string, string>> = {
  CAMPUS: 'Campus', DEPARTMENT: 'Department', PROGRAM: 'Programme', BATCH: 'Batch', SECTION: 'Section',
};

export function audienceLabel(audience: AnnouncementAudienceDto): string {
  if (audience.unitId === null) return 'Whole institution';
  const kind = unitKindLabels[audience.kind] ?? 'Unit';
  return audience.name ? `${kind}: ${audience.name}` : kind;
}

/** " 12 Oct 2026, 10:00" when the time is recorded; nothing when it is not. */
function when(value: string | null): string {
  return value ? ` ${formatDateTime(value)}` : '';
}

export function announcementStateLabel(announcement: InstitutionAnnouncementDto): string {
  if (announcement.state === 'SENT') return `Sent${when(announcement.sentAt)}`;
  if (announcement.state === 'CANCELLED') return announcement.cancelReasonCode === 'SENDER_ACCESS_ENDED'
    ? 'Not sent: the sender no longer teaches this group' : `Cancelled${when(announcement.cancelledAt)}`;
  return announcement.scheduledFor ? `Scheduled for${when(announcement.scheduledFor)}` : 'Scheduled';
}

/** The email outcome as it really is; never claims a send that did not happen. */
export function announcementEmailSummary(announcement: InstitutionAnnouncementDto): string {
  if (!announcement.channels.includes('EMAIL')) return 'Not requested';
  const email = announcement.delivery?.email;
  if (!email) return announcement.state === 'SCHEDULED' ? 'Will be attempted when sent' : MISSING_TEXT;
  const parts = [
    email.sent ? `${email.sent} sent` : '',
    email.notConfigured ? `${email.notConfigured} not sent: no sender is set up yet` : '',
    email.pending ? `${email.pending} sending` : '',
    email.failed ? `${email.failed} failed` : '',
    email.bounced ? `${email.bounced} bounced` : '',
    email.skipped ? `${email.skipped} skipped (not activated or email turned off)` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '0 sent';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    const known: Record<string, string> = {
      ANNOUNCEMENT_RATE_LIMITED: 'You have reached the limit of announcements for today. Try again tomorrow.',
      ANNOUNCEMENT_NOT_SCHEDULED: 'This announcement has already been sent or cancelled.',
      INVALID_SCHEDULE: 'Choose a time in the future, within the next 90 days.',
      INVALID_AUDIENCE: 'Choose who the announcement is for.',
    };
    const message = error.code ? known[error.code] : undefined;
    if (message) return `${message}${supportCodeSuffix(error.correlationId)}`;
    if (error.status === 403) return `You cannot send an announcement to that group.${supportCodeSuffix(error.correlationId)}`;
  }
  return formatApiError(error, fallback);
}

const emptyForm = { audience: '', title: '', body: '', email: false, schedule: false, scheduledFor: '' };

export function InstitutionAnnouncementsPanel({ token, institutionId, noAudienceNote }: {
  readonly token: string;
  readonly institutionId: string;
  /** Said when the caller has nobody to address (for faculty: no active teaching assignment). */
  readonly noAudienceNote: string;
}): React.ReactElement {
  const [data, setData] = useState<InstitutionAnnouncementListDto | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [cancelReason, setCancelReason] = useState<string>(announcementCancelReasons[0][0]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listInstitutionAnnouncements(token, institutionId, null, controller.signal)
      .then(setData)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause, 'Unable to load announcements.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!data) return;
    setError('');
    setNotice('');
    const audience = data.audiences.find((entry) => (entry.unitId ?? 'INSTITUTION') === form.audience);
    if (!audience) { setError('Choose who the announcement is for.'); return; }
    if (form.schedule && !form.scheduledFor) { setError('Choose when to send it.'); return; }
    const channels: AnnouncementChannel[] = form.email ? ['IN_APP', 'EMAIL'] : ['IN_APP'];
    setBusy(true);
    try {
      await createInstitutionAnnouncement(token, institutionId, {
        title: form.title.trim(),
        body: form.body.trim(),
        audienceUnitId: audience.unitId,
        channels,
        ...(form.schedule ? { scheduledFor: new Date(form.scheduledFor).toISOString() } : {}),
      });
      setForm(emptyForm);
      setNotice(form.schedule
        ? 'Announcement scheduled. It goes out once, at the time you chose, unless you cancel it.'
        : 'Announcement sent. Students see it in their notifications within a minute.');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause, 'The announcement was not sent.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(announcement: InstitutionAnnouncementDto): Promise<void> {
    setError('');
    setNotice('');
    try {
      await cancelInstitutionAnnouncement(token, institutionId, announcement.id, cancelReason);
      setNotice('Announcement cancelled. It will not be sent.');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause, 'Cancelling the announcement failed.'));
    }
  }

  async function more(): Promise<void> {
    if (!data?.nextCursor) return;
    try {
      const next = await listInstitutionAnnouncements(token, institutionId, data.nextCursor);
      setData({ ...next, announcements: [...data.announcements, ...next.announcements] });
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to load more announcements.'));
    }
  }

  const announcements = data?.announcements ?? [];
  const sent = announcements.filter((entry) => entry.state === 'SENT');
  const scheduled = announcements.filter((entry) => entry.state === 'SCHEDULED');
  const reached = sent.reduce((sum, entry) => sum + (entry.delivery?.recipients ?? 0), 0);
  return <>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📣" tone="blue" value={data ? sent.length : null} label="Announcements sent" />
      <V2Stat icon="⏰" tone="purple" value={data ? scheduled.length : null} label="Scheduled" />
      <V2Stat icon="🎓" tone="green" value={data ? reached : null} label="Students reached" />
      <V2Stat icon="✉️" tone="amber" value={data ? (data.emailConfigured ? 'On' : 'Not set up') : null} label="Email delivery" />
    </div>
    {notice ? <p className="role-api-success role-wide" role="status">{notice}</p> : null}
    {error ? <p className="form-error role-wide" role="alert">{error}</p> : null}
    {!data && !error ? <p role="status">Loading announcements…</p> : null}
    {data && data.canSend ? <section className="role-card role-wide">
      <h2>New announcement</h2>
      <p>Only students currently enrolled in the group you choose receive it, in their ONE notifications. You can send up to {data.dailyLimit} a day.</p>
      <form className="role-management-form" onSubmit={(event) => void send(event)}>
        <label><span>Send to</span><select value={form.audience} required onChange={(event) => setForm((value) => ({ ...value, audience: event.target.value }))}>
          <option value="">Choose</option>
          {data.audiences.map((audience) => <option key={audience.unitId ?? 'INSTITUTION'} value={audience.unitId ?? 'INSTITUTION'}>{audienceLabel(audience)}</option>)}
        </select></label>
        <label><span>Title</span><input value={form.title} required maxLength={160} onChange={(event) => setForm((value) => ({ ...value, title: event.target.value }))} /></label>
        <label><span>Message</span><textarea value={form.body} required maxLength={500} rows={4} onChange={(event) => setForm((value) => ({ ...value, body: event.target.value }))} /></label>
        <label><input type="checkbox" checked={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.checked }))} /><span>Also send by email</span></label>
        {form.email && !data.emailConfigured ? <p>Email is not set up for ONE yet, so the email will be recorded as not sent. Students still see the announcement in ONE.</p> : null}
        <label><input type="checkbox" checked={form.schedule} onChange={(event) => setForm((value) => ({ ...value, schedule: event.target.checked }))} /><span>Schedule for later</span></label>
        {form.schedule ? <label><span>Send at</span><input type="datetime-local" value={form.scheduledFor} required onChange={(event) => setForm((value) => ({ ...value, scheduledFor: event.target.value }))} /></label> : null}
        <button type="submit" disabled={busy}>{form.schedule ? 'Schedule announcement' : 'Send announcement'}</button>
      </form>
    </section> : null}
    {data && !data.canSend ? <div className="role-wide"><V2EmptyState illustration="no-students-roster" icon="📣" title="You have nobody to send announcements to yet" note={noAudienceNote}
      hint="Ask your institution admin if this is not what you expected." /></div> : null}
    {data ? <section className="role-card role-wide">
      <h2>Sent and scheduled</h2>
      {scheduled.length ? <label><span>Reason for cancelling</span><select value={cancelReason} onChange={(event) => setCancelReason(event.target.value)}>{announcementCancelReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label> : null}
      {announcements.length === 0 ? <p>No announcements yet.</p> : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Announcements</caption>
        <thead><tr><th>Announcement</th><th>Sent to</th><th>Status</th><th>Students reached</th><th>Email</th><th>Actions</th></tr></thead>
        <tbody>{announcements.map((announcement) => <tr key={announcement.id} className="role-record-row">
          <th scope="row"><strong>{announcement.title}</strong><span>{announcement.body}</span></th>
          <td>{audienceLabel(announcement.audience)}</td>
          <td>{announcementStateLabel(announcement)}</td>
          <td>{announcement.delivery ? announcement.delivery.recipients : announcement.state === 'SENT' ? MISSING_TEXT : 'None'}</td>
          <td>{announcementEmailSummary(announcement)}</td>
          <td>{announcement.state === 'SCHEDULED' ? <button type="button" className="secondary" onClick={() => void cancel(announcement)}>Cancel</button> : 'None'}</td>
        </tr>)}</tbody></table></div>}
      {data.nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void more()}>Load more announcements</button></div> : null}
    </section> : null}
  </>;
}

/** The staff member's own notification feed, shown under Messages as their inbox. */
export function StaffInbox({ token }: { readonly token: string }): React.ReactElement {
  const [items, setItems] = useState<readonly UserNotificationDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listMyNotifications(token, controller.signal)
      .then((feed) => setItems(feed.notifications))
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [token]);
  return <section className="role-card role-wide">
    <h2>Your inbox</h2>
    {failed ? <p role="alert">Your inbox could not be loaded right now.</p> : null}
    {!items && !failed ? <p role="status">Loading your inbox…</p> : null}
    {items && items.length === 0 ? <p>Nothing in your inbox yet.</p> : null}
    {items && items.length > 0 ? <ul className="role-check-list">{items.map((item) => <li key={item.id}><strong>{item.title}</strong> — {item.body}</li>)}</ul> : null}
  </section>;
}

/** Faculty "Messages": announcements to the sections and batches they teach, and their inbox. */
export function FacultyMessagesPage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  if (!token) return <RestrictedApiState title="Messages" message="Sign in to your faculty workspace to send announcements to the students you teach." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Messages" />;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your teaching</span><h1>Messages</h1>
      <p>Send announcements to the sections and batches you teach, and read your own inbox.</p></div></div>
    <InstitutionAnnouncementsPanel key={authenticatedWorkspace.organizationId + ':' + token} token={token} institutionId={authenticatedWorkspace.organizationId}
      noAudienceNote="You can send announcements to the sections and batches you are assigned to teach. You have no active teaching assignment right now." />
    <StaffInbox token={token} />
  </section>;
}
