/**
 * ONE · Application-bound messages (EMP-10) — the conversation between a candidate and the employer's
 * team, inside the application it belongs to.
 *
 * Employers see it behind their existing Messages item (an inbox of conversations whose candidate
 * still shares their details) and on Candidate Detail; students see it inside My applications, per
 * application. No navigation item is added. Every body is rendered as plain text — never a link —
 * and a message that carries a link is flagged, with a warning for the student. Students can mute a
 * conversation's notices and report an employer's message; the employer is never told about either.
 * Built only from existing v2 classes and components. Design:
 * docs/architecture/application-messages-table-design.md.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { ApiRequestError } from './api/core.js';
import {
  getEmployerConversation,
  getStudentConversation,
  listEmployerMessageThreads,
  messageReportReasons,
  muteConversation,
  reportMessage,
  sendEmployerMessage,
  sendStudentMessage,
  type ConversationMessageDto,
  type EmployerConversationDto,
  type MessageReportReason,
  type MessageThreadSummaryDto,
  type StudentConversationDto,
} from './api/hiring.js';
import { V2Chip, V2EmptyState } from './dashboardsV2.js';
import { supportCodeSuffix } from './supportCode.js';
import { formatDateTime } from './dates.js';
import { codeLabel, MISSING_TEXT } from './labels.js';

export const MESSAGE_MAX_LENGTH = 2000;

const MESSAGE_ERRORS: Readonly<Record<string, string>> = {
  MESSAGING_NOT_AVAILABLE: 'This conversation is closed: the application has ended or its details are no longer shared.',
  MESSAGE_RATE_LIMITED: 'Too many messages in a short time. Wait a while before sending more.',
  MESSAGE_AWAITING_REPLY: 'You have sent three messages without a reply. Wait for the candidate to answer before sending more.',
  INVALID_BODY: 'Write a message of up to 2,000 characters.',
  MESSAGE_ALREADY_REPORTED: 'You have already reported this message.',
  MESSAGE_NOT_REPORTABLE: 'This message cannot be reported.',
  FORBIDDEN: 'This candidate no longer shares their details with you, so the conversation is closed.',
};

function explain(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  const sentence = (error.code ? MESSAGE_ERRORS[error.code] : undefined) ?? (error.status === 403 ? MESSAGE_ERRORS.FORBIDDEN : fallback);
  return `${sentence}${supportCodeSuffix(error.correlationId)}`;
}

function when(value: string | null): string {
  if (!value) return MISSING_TEXT;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING_TEXT : formatDateTime(date);
}

function humanise(value: string): string {
  return codeLabel(value);
}

/** The messages, oldest first, as plain text. */
function MessageList({ messages, perspective, counterpart, onReport }: {
  readonly messages: readonly ConversationMessageDto[];
  readonly perspective: 'EMPLOYER' | 'STUDENT';
  readonly counterpart: string;
  readonly onReport?: (message: ConversationMessageDto) => void;
}): React.ReactElement {
  if (!messages.length) return <p className="hiring-meta">No messages yet.</p>;
  return <div className="v2-list" role="log" aria-label="Messages">
    {messages.map((message) => {
      const ours = message.from === perspective;
      const who = ours ? (perspective === 'EMPLOYER' ? (message.mine ? 'You' : 'Your team') : 'You') : counterpart;
      return <div key={message.id} className="v2-list-row" style={{ alignItems: 'flex-start' }}>
        <span className={`v2-tile ${ours ? 'blue' : 'teal'}`} aria-hidden="true">{ours ? '✉️' : '💬'}</span>
        <div className="grow">
          <strong>{who} · {when(message.sentAt)}</strong>
          {message.erased
            ? <small>This message was erased.</small>
            : <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.body}</p>}
          {message.containsLink && !message.erased
            ? <small role="note">{perspective === 'STUDENT'
              ? 'Contains a link. ONE does not check links — never pay a fee or share a password.'
              : 'Contains a link, shown to the candidate with a warning.'}</small> : null}
          {ours && message.readAt ? <small>Read {when(message.readAt)}</small> : null}
          {message.reportedAt ? <small>You reported this message.</small> : null}
        </div>
        {onReport && !ours && !message.erased && !message.reportedAt
          ? <button type="button" className="v2-btn ghost small" onClick={() => onReport(message)}>Report</button> : null}
      </div>;
    })}
  </div>;
}

function Composer({ label, onSend, disabled }: { readonly label: string; readonly onSend: (body: string) => Promise<void>; readonly disabled: boolean }): React.ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    void onSend(trimmed).then(() => setText('')).catch(() => undefined).finally(() => setBusy(false));
  }}>
    <label className="student-form-field"><span>{label}</span>
      <textarea value={text} maxLength={MESSAGE_MAX_LENGTH} rows={3} disabled={disabled || busy} onChange={(event) => setText(event.target.value)} />
    </label>
    <div className="hiring-actions">
      <button type="submit" disabled={disabled || busy || !trimmed}>Send</button>
      <span className="hiring-meta">{text.length} / {MESSAGE_MAX_LENGTH} · Text only. No attachments.</span>
    </div>
  </form>;
}

/** The employer's view of one application's conversation (Candidate Detail and Messages). */
export function EmployerConversationPanel({ employerId, applicationId, candidateName }: {
  readonly employerId: string; readonly applicationId: string; readonly candidateName?: string | null;
}): React.ReactElement {
  const [conversation, setConversation] = useState<EmployerConversationDto | null>(null);
  const [status, setStatus] = useState('Loading the conversation…');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    getEmployerConversation(token, employerId, applicationId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) { setConversation(response.conversation); setStatus(''); } })
      .catch((error: unknown) => { if (!abort.signal.aborted) { setConversation(null); setStatus(explain(error, 'The conversation could not be loaded.')); } });
    return () => abort.abort();
  }, [employerId, applicationId, reload]);

  const counterpart = candidateName ?? 'Candidate';
  return <section className="v2-card role-wide" aria-label="Messages with this candidate">
    <div className="v2-card-head"><h2>Messages</h2>{conversation ? <V2Chip tone="slate">{humanise(conversation.applicationState)}</V2Chip> : null}</div>
    {status ? <p role="status">{status}</p> : null}
    {conversation ? <>
      <p className="hiring-meta">One conversation per application, visible to your team while the candidate shares their details. Every message is recorded.</p>
      {conversation.hasEarlier ? <p className="hiring-meta">Showing the latest messages.</p> : null}
      <MessageList messages={conversation.messages} perspective="EMPLOYER" counterpart={counterpart} />
      {conversation.canSend
        ? <Composer label={conversation.started ? 'Reply' : 'Start the conversation'} disabled={false} onSend={async (body) => {
          const token = getAccessToken();
          if (!token) throw new Error('Unavailable');
          try {
            await sendEmployerMessage(token, employerId, applicationId, body);
            setStatus('Message sent.');
            setReload((value) => value + 1);
          } catch (error) {
            setStatus(explain(error, 'The message could not be sent.'));
            throw error;
          }
        }} />
        : <p className="hiring-meta">{conversation.sendBlockedReason === 'NOT_SHORTLISTED'
          ? 'You can message a candidate once you shortlist them.'
          : 'This application has ended, so the conversation is closed.'}</p>}
      <button type="button" className="v2-btn ghost small" onClick={() => setReload((value) => value + 1)}>Refresh</button>
    </> : null}
  </section>;
}

/** The recruiter portal's Messages item: conversations whose candidate still shares their details. */
export function EmployerMessagesPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [threads, setThreads] = useState<readonly MessageThreadSummaryDto[]>([]);
  const [withheld, setWithheld] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading your conversations…');
  const [selected, setSelected] = useState<MessageThreadSummaryDto | null>(null);

  async function load(next?: string): Promise<void> {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    try {
      const response = await listEmployerMessageThreads(token, employerId, next);
      setThreads((previous) => next ? [...previous, ...response.threads] : response.threads);
      setWithheld(response.withheldCount);
      setCursor(response.nextCursor);
      setStatus('');
    } catch (error) {
      setStatus(explain(error, 'Your conversations could not be loaded.'));
    }
  }
  useEffect(() => { setThreads([]); setSelected(null); void load(); }, [employerId]);

  return <>
    <section className="v2-card role-wide">
      <div className="v2-card-head"><h2>Conversations</h2><V2Chip tone="slate">{threads.length}</V2Chip></div>
      {status ? <p role="status">{status}</p> : null}
      {!status && threads.length === 0
        ? <V2EmptyState illustration="no-messages" icon="💬" title="No conversations yet"
          note="Start one from Candidate Detail once you shortlist a candidate. Conversations appear here while the candidate shares their details."
          hint="Messages stay inside ONE; nobody needs to share a personal number." />
        : <div className="v2-list">
          {threads.map((thread) => <div key={thread.applicationId} className="v2-list-row">
            <span className="v2-tile blue" aria-hidden="true">💬</span>
            <div className="grow">
              <strong>{thread.candidateName ?? 'Candidate'} · {thread.title}{thread.referenceCode ? ` (${thread.referenceCode})` : ''}</strong>
              <small>{humanise(thread.applicationState)} · {thread.messageCount} {thread.messageCount === 1 ? 'message' : 'messages'}{thread.lastMessageAt ? ` · last ${when(thread.lastMessageAt)}${thread.lastFrom === 'STUDENT' ? ' from the candidate' : ''}` : ''}</small>
            </div>
            {thread.unreadCount > 0 ? <V2Chip tone="blue">{thread.unreadCount} unread</V2Chip> : null}
            <button type="button" className="v2-btn small" aria-pressed={selected?.applicationId === thread.applicationId}
              onClick={() => setSelected(thread)}>Open</button>
          </div>)}
        </div>}
      {cursor ? <button type="button" className="v2-btn ghost small" onClick={() => { void load(cursor); }}>Show more</button> : null}
      {withheld > 0 ? <p className="hiring-meta">{withheld} {withheld === 1 ? 'conversation is' : 'conversations are'} closed because the candidate no longer shares their details.</p> : null}
    </section>
    {selected ? <EmployerConversationPanel key={selected.applicationId} employerId={employerId} applicationId={selected.applicationId} candidateName={selected.candidateName} /> : null}
  </>;
}

/** The student's conversation for one application, inside My applications. */
export function StudentConversationCard({ applicationId, onClose, onChanged }: {
  readonly applicationId: string; readonly onClose: () => void; readonly onChanged?: () => void;
}): React.ReactElement {
  const [conversation, setConversation] = useState<StudentConversationDto | null>(null);
  const [status, setStatus] = useState('Loading the conversation…');
  const [reload, setReload] = useState(0);
  const [reporting, setReporting] = useState<ConversationMessageDto | null>(null);
  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    getStudentConversation(token, applicationId, abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        setConversation(response.conversation); setStatus('');
        onChanged?.();
      })
      .catch((error: unknown) => { if (!abort.signal.aborted) setStatus(explain(error, 'The conversation could not be loaded.')); });
    return () => abort.abort();
  }, [applicationId, reload]);

  async function toggleMute(): Promise<void> {
    const token = getAccessToken();
    if (!token || !conversation) return;
    try {
      const response = await muteConversation(token, applicationId, !conversation.muted);
      setConversation({ ...conversation, muted: response.conversation.muted });
      setStatus(response.conversation.muted ? 'Muted. Messages still arrive here, but you will not be notified.' : 'Notifications are back on for this conversation.');
    } catch (error) {
      setStatus(explain(error, 'That change could not be saved.'));
    }
  }

  const employer = conversation?.employerName ?? 'The employer';
  return <section className="card wide-card" aria-label="Messages for this application">
    <div className="hiring-actions" style={{ justifyContent: 'space-between' }}>
      <h2>Messages{conversation ? `: ${conversation.title}` : ''}</h2>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
    {status ? <p role="status">{status}</p> : null}
    {conversation ? <>
      <p className="hiring-meta">Only you and {employer}'s hiring team can read this. They can see it only while you share your application with them. Never pay a fee to an employer.</p>
      {!conversation.started
        ? <p>{employer} has not started a conversation. Employers can write once they shortlist you, and you can reply here.</p>
        : <>
          <MessageList messages={conversation.messages} perspective="STUDENT" counterpart={employer} onReport={(message) => setReporting(message)} />
          {reporting ? <ReportForm applicationId={applicationId} message={reporting} onDone={(note) => { setReporting(null); setStatus(note); setReload((value) => value + 1); }}
            onCancel={() => setReporting(null)} /> : null}
          {conversation.canReply
            ? <Composer label="Reply" disabled={false} onSend={async (body) => {
              const token = getAccessToken();
              if (!token) throw new Error('Unavailable');
              try {
                await sendStudentMessage(token, applicationId, body);
                setStatus('Reply sent.');
                setReload((value) => value + 1);
              } catch (error) {
                setStatus(explain(error, 'Your reply could not be sent.'));
                throw error;
              }
            }} />
            : <p className="hiring-meta">This application has ended or is no longer shared, so you can read this conversation but not reply.</p>}
          <div className="hiring-actions">
            <button type="button" className="secondary" onClick={() => { void toggleMute(); }}>{conversation.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
            <button type="button" className="secondary" onClick={() => setReload((value) => value + 1)}>Refresh</button>
          </div>
        </>}
    </> : null}
  </section>;
}

function ReportForm({ applicationId, message, onDone, onCancel }: {
  readonly applicationId: string; readonly message: ConversationMessageDto; readonly onDone: (note: string) => void; readonly onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState<MessageReportReason | ''>('');
  const [statement, setStatement] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <form aria-label="Report this message" onSubmit={(event) => {
    event.preventDefault();
    const token = getAccessToken();
    if (!token || !reason || busy) return;
    setBusy(true);
    reportMessage(token, applicationId, message.id, reason, statement.trim() || undefined)
      .then(() => onDone('Reported. The ONE trust and safety team will review it; the employer is not told who reported it or that it was reported.'))
      .catch((failure: unknown) => setError(explain(failure, 'The report could not be sent.')))
      .finally(() => setBusy(false));
  }}>
    <h3>Report this message</h3>
    <label className="student-form-field"><span>What is wrong?</span>
      <select value={reason} onChange={(event) => setReason(event.target.value as MessageReportReason)} required>
        <option value="">Choose a reason</option>
        {messageReportReasons.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
      </select>
    </label>
    <label className="student-form-field"><span>Anything else we should know (optional)</span>
      <textarea value={statement} maxLength={1000} rows={2} onChange={(event) => setStatement(event.target.value)} />
    </label>
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <div className="hiring-actions">
      <button type="submit" disabled={!reason || busy}>Send report</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
