/**
 * Hiring notifications (EMP-08): telling a student about their own application, and an employer
 * about an answer to its offer.
 *
 * The employer and student controllers write hiring events to the outbox in the transaction that
 * makes the change; the ADR-028 local dispatcher hands each one here. Under a consumer receipt and
 * in one transaction the consumer reads the application at consume time, writes the in-app
 * notification and its delivery row (primary key: event + recipient, so a notice can never be
 * written twice), and — for offers — queues the expiry reminder. Email leaves after that commit,
 * one claimed row at a time, and never undoes the in-app notice; with no mail sink configured
 * (HG-7) it is recorded NOT_CONFIGURED, never faked. Nothing here runs in a request handler.
 *
 * A notice carries only what the recipient may already see: job title, employer name, stage,
 * interview round, mode and time, and the offer deadline. Never a readiness band or score, a
 * reason code or private note, another candidate, or an internal identifier.
 * Design: docs/architecture/hiring-notification-deliveries-table-design.md.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { applicationHasLiveApplicantGrant } from './employer-authentication.js';
import { PermanentMailRejection, type InvitationMailSink, type MailAttachment } from './invitation-mail.js';
import { loadInterviewCalendar } from './interview-calendar-source.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

export const HIRING_NOTIFICATION_CONSUMER = 'hiring-notifications';
export const OFFER_EXPIRY_REMINDER_REQUESTED = 'offer.expiry_reminder.requested';
/** EMP-10: one message in an application's conversation. */
export const APPLICATION_MESSAGE_SENT = 'application.message.sent';
export const HIRING_TEMPLATE_VERSION = 1;
/** How long before an offer expires the one reminder is sent. */
export const OFFER_REMINDER_LEAD_HOURS = 24;

const stageStates = ['SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const;
type StageState = (typeof stageStates)[number];

/** Every outbox event type this consumer receives. */
export const HIRING_NOTIFICATION_EVENT_TYPES: readonly string[] = [
  ...stageStates.map((state) => `application.${state.toLowerCase()}`),
  'application.terms_change.recorded',
  'interview.scheduled',
  'interview.state_changed',
  'offer.extended',
  'offer.withdrawn',
  OFFER_EXPIRY_REMINDER_REQUESTED,
  'offer.accepted',
  'offer.declined',
  APPLICATION_MESSAGE_SENT,
];

export type HiringNotificationKind =
  | 'APPLICATION_STAGE_CHANGED' | 'APPLICATION_TERMS_CHANGED' | 'INTERVIEW_SCHEDULED' | 'INTERVIEW_CHANGED'
  | 'OFFER_EXTENDED' | 'OFFER_WITHDRAWN' | 'OFFER_EXPIRING' | 'OFFER_RESPONDED'
  | 'EMPLOYER_MESSAGE' | 'CANDIDATE_MESSAGE';

/** The kinds that are in-app only, for employer members: they never email and use no template. */
type InAppOnlyKind = 'OFFER_RESPONDED' | 'CANDIDATE_MESSAGE';
type EmailedKind = Exclude<HiringNotificationKind, InAppOnlyKind>;

// Fixed template row ids, one per kind that emails (the body is rendered by renderHiringEmail).
const templateIds: Readonly<Record<EmailedKind, string>> = {
  APPLICATION_STAGE_CHANGED: '26000000-0000-4000-8000-000000059001',
  APPLICATION_TERMS_CHANGED: '26000000-0000-4000-8000-000000059002',
  INTERVIEW_SCHEDULED: '26000000-0000-4000-8000-000000059003',
  INTERVIEW_CHANGED: '26000000-0000-4000-8000-000000059004',
  OFFER_EXTENDED: '26000000-0000-4000-8000-000000059005',
  OFFER_WITHDRAWN: '26000000-0000-4000-8000-000000059006',
  OFFER_EXPIRING: '26000000-0000-4000-8000-000000059007',
  EMPLOYER_MESSAGE: '26000000-0000-4000-8000-000000067001',
};

export function hiringTemplateKey(kind: HiringNotificationKind): string {
  return `hiring-${kind.toLowerCase().replace(/_/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Rendering (version 1). Pure, so the wording is tested without a database.
// ---------------------------------------------------------------------------

export interface HiringNoticeFacts {
  readonly kind: HiringNotificationKind;
  readonly employerName: string;
  readonly opportunityTitle: string;
  /** APPLICATION_STAGE_CHANGED: the stage the application moved to. */
  readonly stage?: StageState;
  /** INTERVIEW_*: the interview as it stands. */
  readonly interview?: { readonly roundNumber: number; readonly mode: string; readonly scheduledStart: Date | null };
  /** INTERVIEW_CHANGED: what happened to it. */
  readonly interviewChange?: 'RESCHEDULED' | 'CANCELLED';
  /** OFFER_EXTENDED / OFFER_EXPIRING: the response deadline. */
  readonly offerExpiresAt?: Date | null;
  /** OFFER_RESPONDED (employer notice). */
  readonly offerResponse?: 'ACCEPTED' | 'DECLINED';
  readonly referenceCode?: string | null;
  /**
   * EMP-09: who reads an INTERVIEW_* notice. The candidate (default) or a member of the interview
   * panel; a panel notice names the job and never the candidate.
   */
  readonly audience?: 'CANDIDATE' | 'PANEL';
}

const modeLabels: Readonly<Record<string, string>> = { ONSITE: 'on site', VIDEO: 'video', PHONE: 'phone' };

/** A time as the recipient reads it, in their notification timezone (default Asia/Kolkata). */
export function formatNoticeTime(value: Date, timeZone: string | null | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-IN', { ...options, timeZone: timeZone || 'Asia/Kolkata' }).format(value);
  } catch {
    return new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'Asia/Kolkata' }).format(value);
  }
}

/** Version 1 of the in-app notice. The email is built from it by {@link renderHiringEmail}. */
export function renderHiringNotice(facts: HiringNoticeFacts, timeZone?: string | null): { readonly title: string; readonly body: string } {
  const employer = facts.employerName;
  const job = facts.opportunityTitle;
  const round = facts.interview ? `round ${facts.interview.roundNumber}` : 'an interview';
  const mode = facts.interview ? modeLabels[facts.interview.mode] ?? 'interview' : 'interview';
  const when = facts.interview?.scheduledStart ? formatNoticeTime(facts.interview.scheduledStart, timeZone) : 'a time to be confirmed';
  const deadline = facts.offerExpiresAt ? formatNoticeTime(facts.offerExpiresAt, timeZone) : null;
  const reference = facts.referenceCode ? ` (${facts.referenceCode})` : '';
  let title: string;
  let body: string;
  switch (facts.kind) {
    case 'APPLICATION_STAGE_CHANGED': {
      title = `Application update: ${job}`;
      const stageBodies: Readonly<Record<StageState, string>> = {
        SCREENING: `${employer} is reviewing your application for ${job}.`,
        SHORTLISTED: `${employer} shortlisted you for ${job}.`,
        ASSESSMENT: `${employer} moved your application for ${job} to the assessment stage.`,
        INTERVIEW: `${employer} moved your application for ${job} to the interview stage. Your interview details appear under Applications once it is scheduled.`,
        OFFER: `${employer} moved your application for ${job} to the offer stage.`,
        HIRED: `${employer} has marked you as hired for ${job}. Congratulations.`,
        REJECTED: `${employer} has decided not to take your application for ${job} further. If they share feedback, it will appear under Applications.`,
      };
      body = stageBodies[facts.stage ?? 'SCREENING'];
      break;
    }
    case 'APPLICATION_TERMS_CHANGED':
      title = `The terms changed: ${job}`;
      body = `${employer} changed the terms of ${job} after you applied. Review them under Applications and accept or decline; your application waits until you answer.`;
      break;
    case 'INTERVIEW_SCHEDULED':
      if (facts.audience === 'PANEL') {
        title = `Interview panel: ${job}`;
        body = `You are on the panel for ${round} (${mode}) for ${job} on ${when}. The candidate brief and how to join are under My Interviews.`;
        break;
      }
      title = `Interview scheduled: ${job}`;
      body = `${employer} scheduled ${round} (${mode}) for ${job} on ${when}. The location or joining link, and what to prepare, are under Applications.`;
      break;
    case 'INTERVIEW_CHANGED':
      if (facts.audience === 'PANEL') {
        if (facts.interviewChange === 'CANCELLED') {
          title = `Panel interview cancelled: ${job}`;
          body = `${capitalise(round)} for ${job}, which you were on the panel for, was cancelled.`;
        } else {
          title = `Panel interview moved: ${job}`;
          body = `${capitalise(round)} (${mode}) for ${job}, which you are on the panel for, moved to ${when}. The details are under My Interviews.`;
        }
        break;
      }
      if (facts.interviewChange === 'CANCELLED') {
        title = `Interview cancelled: ${job}`;
        body = `${employer} cancelled ${round} for ${job}. If they reschedule, you will be told here.`;
      } else {
        title = `Interview rescheduled: ${job}`;
        body = `${employer} moved ${round} (${mode}) for ${job} to ${when}. The details are under Applications.`;
      }
      break;
    case 'OFFER_EXTENDED':
      title = `Offer from ${employer}`;
      body = deadline
        ? `${employer} made you an offer for ${job}. Accept or decline it under Applications by ${deadline}.`
        : `${employer} made you an offer for ${job}. Accept or decline it under Applications.`;
      break;
    case 'OFFER_WITHDRAWN':
      title = `Offer withdrawn: ${job}`;
      body = `${employer} withdrew its offer for ${job}.`;
      break;
    case 'OFFER_EXPIRING':
      title = `Offer expires soon: ${job}`;
      body = `Your offer from ${employer} for ${job} expires on ${deadline ?? 'its deadline'}. Accept or decline it under Applications before then.`;
      break;
    // EMP-10: never the text of the message — an email can be forwarded, and the text may carry
    // contact details. The employer's notice never names the candidate (it outlives the grant).
    case 'EMPLOYER_MESSAGE':
      title = `Message from ${employer}`;
      body = `${employer} sent you a message about ${job}. Read and reply under Applications.`;
      break;
    case 'CANDIDATE_MESSAGE':
      title = `Candidate message: ${job}`;
      body = `A candidate replied about ${job}${reference}. Open Messages to read it.`;
      break;
    case 'OFFER_RESPONDED':
      title = facts.offerResponse === 'ACCEPTED' ? `Offer accepted: ${job}` : `Offer declined: ${job}`;
      body = facts.offerResponse === 'ACCEPTED'
        ? `A candidate accepted your offer for ${job}${reference}. Open Offers to see it and record the hire.`
        : `A candidate declined your offer for ${job}${reference}. Open Offers to see it.`;
      break;
  }
  return { title: truncate(title, 160), body: truncate(body, 500) };
}

/** Version 1 of every hiring email: the notice itself, plus where to act and who sent it. */
export function renderHiringEmail(notice: { readonly title: string; readonly body: string }): { readonly subject: string; readonly textBody: string } {
  return {
    subject: truncate(notice.title, 200),
    textBody: [
      notice.title,
      notice.body,
      'Sign in to ONE to see the details. You can turn hiring emails off in your notification settings; the notice stays in your ONE notifications.',
    ].join('\n\n'),
  };
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// The consumer
// ---------------------------------------------------------------------------

export type HiringNotificationOutcome = 'NOTIFIED' | 'NOT_APPLICABLE' | 'NOT_FOUND';

export interface HiringEmailCounts { readonly sent: number; readonly failed: number; readonly bounced: number }

/** Outbox consumer for every type in {@link HIRING_NOTIFICATION_EVENT_TYPES}. */
export async function consumeHiringNotificationEvent(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
  deps: { readonly mailSink?: InvitationMailSink },
): Promise<{ readonly executed: boolean; readonly outcome?: HiringNotificationOutcome; readonly recipients?: number; readonly emails?: HiringEmailCounts }> {
  if (!HIRING_NOTIFICATION_EVENT_TYPES.includes(event.eventType) || event.eventVersion !== 1) {
    throw new Error('event is outside the hiring notification consumer contract');
  }
  const result = await handleEventIdempotently(db, {
    consumerName: HIRING_NOTIFICATION_CONSUMER,
    eventId: event.eventId,
    failureClass: 'HIRING_NOTIFICATION_FAILED',
    effect: (tx) => notify(tx, event, Boolean(deps.mailSink)),
  });
  if (!result.executed || !result.result) return { executed: false };
  const { outcome, recipients } = result.result;
  let emails: HiringEmailCounts | undefined;
  if (outcome === 'NOTIFIED' && deps.mailSink) {
    // EMP-09: an interview email carries the calendar invite for the revision the event names.
    const attachments = await interviewAttachments(db, event);
    emails = await deliverHiringEmails(db, event.eventId, deps.mailSink, event.correlationId, attachments);
  }
  return { executed: true, outcome, recipients, ...(emails ? { emails } : {}) };
}

type ApplicationContext = {
  application_id: string;
  student_user_id: string;
  employer_id: string;
  employer_name: string;
  title: string;
  reference_code: string | null;
  timezone: string | null;
};

const applicationContextColumns = sql`
  a.id AS application_id, a.student_user_id, a.employer_id, org.legal_name AS employer_name, v.title, o.reference_code, np.timezone`;
const applicationContextJoins = sql`
  JOIN organizations org ON org.id = a.employer_id
  JOIN opportunities o ON o.id = a.opportunity_id
  JOIN opportunity_versions v ON v.id = a.applied_version_id
  LEFT JOIN notification_preferences np ON np.user_id = a.student_user_id`;

function payloadUuid(event: IntegrationEventEnvelope, key: string): string {
  const value = event.payload[key];
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`invalid hiring event field ${key}`);
  return value;
}

async function notify(tx: PersistenceDb, event: IntegrationEventEnvelope, sinkConfigured: boolean): Promise<{ outcome: HiringNotificationOutcome; recipients: number }> {
  const type = event.eventType;
  const none = (outcome: HiringNotificationOutcome) => ({ outcome, recipients: 0 });

  if (type === APPLICATION_MESSAGE_SENT) return messageNotice(tx, event, sinkConfigured);

  if (type.startsWith('application.') && type !== 'application.terms_change.recorded') {
    const stage = String(event.payload.toState ?? '') as StageState;
    if (!stageStates.includes(stage) || type !== `application.${stage.toLowerCase()}`) throw new Error('invalid application stage event');
    const context = await loadApplication(tx, payloadUuid(event, 'applicationId'));
    if (!context) return none('NOT_FOUND');
    return studentNotice(tx, event, context, { kind: 'APPLICATION_STAGE_CHANGED', stage }, sinkConfigured);
  }

  if (type === 'application.terms_change.recorded') {
    // A deadline-only change asks nothing of the applicant (EMP-05 decision 2).
    if (event.payload.acknowledgement !== 'REQUIRED') return none('NOT_APPLICABLE');
    const applicationId = payloadUuid(event, 'applicationId');
    const pending = await tx.execute(sql`
      SELECT 1 FROM opportunity_term_change_acknowledgements
      WHERE application_id = ${applicationId}::uuid AND to_version_id = ${payloadUuid(event, 'toVersionId')}::uuid
        AND acknowledgement_required AND acknowledged_at IS NULL AND declined_at IS NULL
    `) as QueryResult<unknown>;
    // Already answered (a later change settles earlier ones): nothing to ask any more.
    if (!pending.rows.length) return none('NOT_APPLICABLE');
    const context = await loadApplication(tx, applicationId);
    if (!context) return none('NOT_FOUND');
    return studentNotice(tx, event, context, { kind: 'APPLICATION_TERMS_CHANGED' }, sinkConfigured);
  }

  if (type === 'interview.scheduled' || type === 'interview.state_changed') {
    let change: 'RESCHEDULED' | 'CANCELLED' | undefined;
    if (type === 'interview.state_changed') {
      const toState = event.payload.toState;
      if (toState !== 'RESCHEDULED' && toState !== 'CANCELLED') return none('NOT_APPLICABLE');
      change = toState;
    }
    const interviewId = payloadUuid(event, 'interviewId');
    const found = await tx.execute(sql`
      SELECT ${applicationContextColumns}, i.round_number, i.mode, i.scheduled_start
      FROM interviews i JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      ${applicationContextJoins}
      WHERE i.id = ${interviewId}::uuid
    `) as QueryResult<ApplicationContext & { round_number: number; mode: string; scheduled_start: Date | string | null }>;
    const row = found.rows[0];
    if (!row) return none('NOT_FOUND');
    const interview = { roundNumber: Number(row.round_number), mode: row.mode, scheduledStart: row.scheduled_start ? new Date(row.scheduled_start) : null };
    const facts: StudentFacts = change
      ? { kind: 'INTERVIEW_CHANGED', interview, interviewChange: change }
      : { kind: 'INTERVIEW_SCHEDULED', interview };
    const student = await studentNotice(tx, event, row, facts, sinkConfigured);
    // EMP-09: everyone on the panel hears about it too, once each.
    const panel = await panelNotices(tx, event, row, interviewId, facts, sinkConfigured);
    const recipients = student.recipients + panel;
    return { outcome: recipients ? 'NOTIFIED' : 'NOT_APPLICABLE', recipients };
  }

  // Offers.
  const offerId = payloadUuid(event, 'offerId');
  const found = await tx.execute(sql`
    SELECT ${applicationContextColumns}, off.state AS offer_state, off.offer_expires_at, off.created_by_user_id,
           (off.offer_expires_at > now()) AS not_expired
    FROM offers off JOIN applications a ON a.id = off.application_id AND a.employer_id = off.employer_id
    ${applicationContextJoins}
    WHERE off.id = ${offerId}::uuid
  `) as QueryResult<ApplicationContext & { offer_state: string; offer_expires_at: Date | string | null; created_by_user_id: string; not_expired: boolean | null }>;
  const offer = found.rows[0];
  if (!offer) return none('NOT_FOUND');
  const offerExpiresAt = offer.offer_expires_at ? new Date(offer.offer_expires_at) : null;

  if (type === 'offer.extended') {
    await queueOfferExpiryReminder(tx, offerId, offer.employer_id, event.correlationId);
    return studentNotice(tx, event, offer, { kind: 'OFFER_EXTENDED', offerExpiresAt }, sinkConfigured);
  }
  if (type === 'offer.withdrawn') return studentNotice(tx, event, offer, { kind: 'OFFER_WITHDRAWN' }, sinkConfigured);
  if (type === OFFER_EXPIRY_REMINDER_REQUESTED) {
    // Answered, withdrawn or already lapsed: there is nothing left to remind anyone about.
    if (offer.offer_state !== 'EXTENDED' || offer.not_expired !== true) return none('NOT_APPLICABLE');
    return studentNotice(tx, event, offer, { kind: 'OFFER_EXPIRING', offerExpiresAt }, sinkConfigured);
  }
  // offer.accepted / offer.declined: an in-app notice to the employer, naming no candidate.
  const recipients = await employerOfferRecipients(tx, offer.employer_id, offer.created_by_user_id);
  if (!recipients.length) return none('NOT_APPLICABLE');
  const notice = renderHiringNotice({
    kind: 'OFFER_RESPONDED', employerName: offer.employer_name, opportunityTitle: offer.title,
    offerResponse: type === 'offer.accepted' ? 'ACCEPTED' : 'DECLINED', referenceCode: offer.reference_code,
  });
  const written = await writeNotices(tx, {
    eventId: event.eventId, applicationId: offer.application_id, kind: 'OFFER_RESPONDED', recipientKind: 'EMPLOYER_MEMBER',
    recipientIds: recipients, notice, data: { screen: 'offers', opportunityTitle: offer.title }, email: false, sinkConfigured,
  });
  return { outcome: written ? 'NOTIFIED' : 'NOT_APPLICABLE', recipients: written };
}

/** The template row names who approved the wording: the employer member whose action sent it. */
async function ensureHiringTemplate(tx: Executor, event: IntegrationEventEnvelope, kind: EmailedKind): Promise<void> {
  const approver = event.actorId;
  if (!approver) throw new Error('hiring event has no actor');
  await tx.execute(sql`
    INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
    VALUES (${templateIds[kind]}::uuid, ${hiringTemplateKey(kind)}, ${HIRING_TEMPLATE_VERSION}, 'en-IN', '{title}',
            'Rendered by the hiring notification consumer: the in-app notice title and body, then where to act and how to turn hiring emails off.',
            ${approver}::uuid, now())
    ON CONFLICT DO NOTHING
  `);
}

/**
 * EMP-09: an in-app notice and an email to each active panellist of the interview — assigned, not
 * removed, still an active member of that employer, and an active account — each in their own
 * timezone. The notice names the job, never the candidate: the brief in ONE is where the person
 * is shown, and only while the candidate's grant is live.
 */
async function panelNotices(
  tx: PersistenceDb, event: IntegrationEventEnvelope, context: ApplicationContext, interviewId: string, facts: StudentFacts, sinkConfigured: boolean,
): Promise<number> {
  const panel = await tx.execute(sql`
    SELECT DISTINCT p.participant_user_id, np.timezone
    FROM interview_participants p
    JOIN interviews i ON i.id = p.interview_id
    JOIN organization_memberships m ON m.user_id = p.participant_user_id AND m.organization_id = i.employer_id
      AND m.scope_organization_id = i.employer_id AND m.scope_employer_id = i.employer_id AND m.state = 'ACTIVE'
    JOIN users u ON u.id = p.participant_user_id AND u.state = 'ACTIVE'
    LEFT JOIN notification_preferences np ON np.user_id = p.participant_user_id
    WHERE p.interview_id = ${interviewId}::uuid AND p.removed_at IS NULL
    ORDER BY p.participant_user_id
  `) as QueryResult<{ participant_user_id: string; timezone: string | null }>;
  if (!panel.rows.length) return 0;
  const kind = facts.kind as EmailedKind;
  await ensureHiringTemplate(tx, event, kind);
  let written = 0;
  for (const member of panel.rows) {
    const notice = renderHiringNotice({ ...facts, audience: 'PANEL', employerName: context.employer_name, opportunityTitle: context.title }, member.timezone);
    written += await writeNotices(tx, {
      eventId: event.eventId, applicationId: context.application_id, kind, recipientKind: 'EMPLOYER_MEMBER', recipientIds: [member.participant_user_id], notice,
      data: { screen: 'my-interviews', employerName: context.employer_name, opportunityTitle: context.title }, email: true, sinkConfigured,
    });
  }
  return written;
}

/**
 * EMP-10: a message in an application's conversation. Read at consume time: nothing is sent for a
 * message that has been erased or read already, when the employer's grant is no longer live, or when
 * an earlier message from the same side is still unread — five messages in a row make one notice.
 * An employer's message tells the student (in-app and email) unless they muted the conversation; a
 * student's reply tells the members who have written in it (in-app only).
 */
async function messageNotice(tx: PersistenceDb, event: IntegrationEventEnvelope, sinkConfigured: boolean): Promise<{ outcome: HiringNotificationOutcome; recipients: number }> {
  const none = (outcome: HiringNotificationOutcome) => ({ outcome, recipients: 0 });
  const found = await tx.execute(sql`
    SELECT ${applicationContextColumns}, m.sender_side, m.erased_at, m.read_at, t.id AS thread_id, t.student_muted_at, t.started_by_user_id,
           ${applicationHasLiveApplicantGrant('a')} AS grant_live,
           EXISTS (SELECT 1 FROM application_messages earlier
             WHERE earlier.thread_id = m.thread_id AND earlier.sender_side = m.sender_side AND earlier.read_at IS NULL
               AND earlier.erased_at IS NULL AND (earlier.sent_at, earlier.id) < (m.sent_at, m.id)) AS earlier_unread
    FROM application_messages m
    JOIN application_message_threads t ON t.id = m.thread_id
    JOIN applications a ON a.id = t.application_id
    ${applicationContextJoins}
    WHERE m.id = ${payloadUuid(event, 'messageId')}::uuid AND t.application_id = ${payloadUuid(event, 'applicationId')}::uuid
  `) as QueryResult<ApplicationContext & { sender_side: 'EMPLOYER' | 'STUDENT'; erased_at: unknown; read_at: unknown; thread_id: string;
    student_muted_at: unknown; started_by_user_id: string; grant_live: boolean; earlier_unread: boolean }>;
  const row = found.rows[0];
  if (!row) return none('NOT_FOUND');
  if (row.erased_at != null || row.read_at != null || row.grant_live !== true || row.earlier_unread) return none('NOT_APPLICABLE');

  if (row.sender_side === 'EMPLOYER') {
    if (row.student_muted_at != null) return none('NOT_APPLICABLE');
    return studentNotice(tx, event, row, { kind: 'EMPLOYER_MESSAGE' }, sinkConfigured);
  }
  const recipients = await messageRecipients(tx, row.employer_id, row.thread_id, row.started_by_user_id);
  if (!recipients.length) return none('NOT_APPLICABLE');
  const notice = renderHiringNotice({ kind: 'CANDIDATE_MESSAGE', employerName: row.employer_name, opportunityTitle: row.title, referenceCode: row.reference_code });
  const written = await writeNotices(tx, {
    eventId: event.eventId, applicationId: row.application_id, kind: 'CANDIDATE_MESSAGE', recipientKind: 'EMPLOYER_MEMBER',
    recipientIds: recipients, notice, data: { screen: 'messages', opportunityTitle: row.title }, email: false, sinkConfigured,
  });
  return { outcome: written ? 'NOTIFIED' : 'NOT_APPLICABLE', recipients: written };
}

/**
 * Who hears that a candidate replied: the active members who have written in the conversation;
 * otherwise the member who started it, if still active; otherwise the employer's active owners and admins.
 */
async function messageRecipients(tx: Executor, employerId: string, threadId: string, starterUserId: string): Promise<string[]> {
  const members = await tx.execute(sql`
    SELECT DISTINCT m.user_id,
           EXISTS (SELECT 1 FROM application_messages sent WHERE sent.thread_id = ${threadId}::uuid AND sent.sender_side = 'EMPLOYER'
             AND sent.sender_user_id = m.user_id) AS wrote,
           (m.user_id = ${starterUserId}::uuid) AS started,
           (m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN')) AS manages
    FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.organization_id = ${employerId}::uuid AND m.scope_organization_id = ${employerId}::uuid AND m.scope_employer_id = ${employerId}::uuid
      AND m.state = 'ACTIVE' AND m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
  `) as QueryResult<{ user_id: string; wrote: boolean; started: boolean; manages: boolean }>;
  const pick = (test: (row: { wrote: boolean; started: boolean; manages: boolean }) => boolean) =>
    [...new Set(members.rows.filter(test).map((row) => row.user_id))].sort();
  const writers = pick((row) => row.wrote);
  if (writers.length) return writers;
  const starter = pick((row) => row.started);
  if (starter.length) return starter;
  return pick((row) => row.manages);
}

/** The calendar invite for an interview event's revision, as an email attachment; none for other events. */
async function interviewAttachments(db: PersistenceDb, event: IntegrationEventEnvelope): Promise<readonly MailAttachment[]> {
  if (event.eventType !== 'interview.scheduled' && event.eventType !== 'interview.state_changed') return [];
  const revisionId = typeof event.payload.revisionId === 'string' ? payloadUuid(event, 'revisionId') : null;
  const file = await loadInterviewCalendar(db, { interviewId: payloadUuid(event, 'interviewId'), revisionId, reader: 'EMAIL' });
  return file ? [file] : [];
}

async function loadApplication(tx: Executor, applicationId: string): Promise<ApplicationContext | undefined> {
  const found = await tx.execute(sql`
    SELECT ${applicationContextColumns} FROM applications a ${applicationContextJoins}
    WHERE a.id = ${applicationId}::uuid AND a.state <> 'DRAFT'
  `) as QueryResult<ApplicationContext>;
  return found.rows[0];
}

type StudentFacts = Omit<HiringNoticeFacts, 'employerName' | 'opportunityTitle'>;

async function studentNotice(
  tx: PersistenceDb, event: IntegrationEventEnvelope, context: ApplicationContext, facts: StudentFacts, sinkConfigured: boolean,
): Promise<{ outcome: HiringNotificationOutcome; recipients: number }> {
  const notice = renderHiringNotice({ ...facts, employerName: context.employer_name, opportunityTitle: context.title }, context.timezone);
  const kind = facts.kind as EmailedKind;
  await ensureHiringTemplate(tx, event, kind);
  const written = await writeNotices(tx, {
    eventId: event.eventId, applicationId: context.application_id, kind, recipientKind: 'STUDENT', recipientIds: [context.student_user_id], notice,
    data: { screen: kind.startsWith('OFFER') ? 'offers' : 'applications', employerName: context.employer_name, opportunityTitle: context.title },
    email: true, sinkConfigured,
  });
  return { outcome: written ? 'NOTIFIED' : 'NOT_APPLICABLE', recipients: written };
}

/**
 * Write each recipient's in-app notification and delivery row in one statement. A deleted account
 * gets nothing. The email is requested only for students, and recorded SKIPPED for an account that
 * is not active or has email turned off, NOT_CONFIGURED when no sender exists, otherwise PENDING.
 */
async function writeNotices(tx: Executor, input: {
  readonly eventId: string; readonly applicationId: string; readonly kind: HiringNotificationKind;
  readonly recipientKind: 'STUDENT' | 'EMPLOYER_MEMBER'; readonly recipientIds: readonly string[];
  readonly notice: { readonly title: string; readonly body: string }; readonly data: Record<string, string>;
  readonly email: boolean; readonly sinkConfigured: boolean;
}): Promise<number> {
  const ids = sql.join(input.recipientIds.map((id) => sql`${id}::uuid`), sql`, `);
  const templateKey = input.email ? hiringTemplateKey(input.kind) : null;
  const templateVersion = input.email ? HIRING_TEMPLATE_VERSION : null;
  const inserted = await tx.execute(sql`
    WITH recipients AS (
      SELECT u.id FROM users u WHERE u.id IN (${ids}) AND u.state <> 'DELETED'
    ), notes AS (
      INSERT INTO user_notifications (id, user_id, kind, title, body, data)
      SELECT gen_random_uuid(), r.id, ${input.kind}, ${input.notice.title}, ${input.notice.body}, ${JSON.stringify(input.data)}::jsonb
      FROM recipients r
      RETURNING id, user_id
    )
    INSERT INTO hiring_notification_deliveries (source_event_id, recipient_user_id, recipient_kind, application_id, kind, notification_id,
                                                email_template_key, email_template_version, email_state)
    SELECT ${input.eventId}::uuid, n.user_id, ${input.recipientKind}, ${input.applicationId}::uuid, ${input.kind}, n.id,
           ${templateKey}, ${templateVersion}::integer,
           CASE WHEN NOT ${input.email}::boolean THEN 'NOT_REQUESTED'
                WHEN u.state <> 'ACTIVE' OR coalesce(np.email_enabled, true) = false THEN 'SKIPPED'
                WHEN NOT ${input.sinkConfigured}::boolean THEN 'NOT_CONFIGURED'
                ELSE 'PENDING' END
    FROM notes n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN notification_preferences np ON np.user_id = n.user_id
    RETURNING recipient_user_id
  `) as QueryResult<{ recipient_user_id: string }>;
  return inserted.rows.length;
}

/**
 * Who hears that a candidate answered an offer: the member who extended it while they are still an
 * active member of that employer; otherwise the employer's active owners and admins.
 */
async function employerOfferRecipients(tx: Executor, employerId: string, creatorUserId: string): Promise<string[]> {
  const members = await tx.execute(sql`
    SELECT DISTINCT m.user_id, (m.user_id = ${creatorUserId}::uuid) AS is_creator
    FROM organization_memberships m JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.organization_id = ${employerId}::uuid AND m.scope_employer_id = ${employerId}::uuid AND m.state = 'ACTIVE'
      AND (m.user_id = ${creatorUserId}::uuid AND m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
           OR m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN'))
  `) as QueryResult<{ user_id: string; is_creator: boolean }>;
  const creator = members.rows.filter((row) => row.is_creator).map((row) => row.user_id);
  return creator.length ? creator : [...new Set(members.rows.map((row) => row.user_id))].sort();
}

/**
 * Queue the one expiry reminder, available 24 hours before the offer expires (ADR-028: the outbox
 * is the scheduler). occurred_at is the same moment, so the dispatcher's maximum event age counts
 * from when the reminder is due. An offer expiring sooner than that gets none: its offer notice
 * already states the deadline.
 */
async function queueOfferExpiryReminder(tx: Executor, offerId: string, employerId: string, correlationId: string): Promise<void> {
  const eventId = randomUUID();
  const payload = { offerId };
  validateOutboxWriteInput({ id: eventId, aggregateType: 'offer', aggregateId: offerId, eventType: OFFER_EXPIRY_REMINDER_REQUESTED,
    eventVersion: 1, payload, organizationId: employerId, correlationId });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id, occurred_at, available_at)
    SELECT ${eventId}::uuid, 'offer', ${offerId}, ${OFFER_EXPIRY_REMINDER_REQUESTED}, 1, ${JSON.stringify(payload)}::jsonb,
           off.created_by_user_id, off.employer_id, ${correlationId},
           off.offer_expires_at - make_interval(hours => ${OFFER_REMINDER_LEAD_HOURS}), off.offer_expires_at - make_interval(hours => ${OFFER_REMINDER_LEAD_HOURS})
    FROM offers off
    WHERE off.id = ${offerId}::uuid AND off.state = 'EXTENDED'
      AND off.offer_expires_at - make_interval(hours => ${OFFER_REMINDER_LEAD_HOURS}) > now()
  `);
}

/**
 * Send every PENDING email of one event, one recipient at a time. Each is claimed PENDING → SENDING
 * by a conditional update, so two workers never send the same one; the outcome is recorded per
 * recipient. A failure is recorded and never undoes anything else.
 */
export async function deliverHiringEmails(
  db: PersistenceDb, eventId: string, mailSink: InvitationMailSink, correlationId: string, attachments: readonly MailAttachment[] = [],
): Promise<HiringEmailCounts> {
  const counts = { sent: 0, failed: 0, bounced: 0 };
  for (;;) {
    const claimed = await db.execute(sql`
      UPDATE hiring_notification_deliveries d SET email_state = 'SENDING', email_attempted_at = now()
      FROM users u, user_notifications n
      WHERE d.source_event_id = ${eventId}::uuid AND u.id = d.recipient_user_id AND n.id = d.notification_id
        AND d.recipient_user_id = (
          SELECT recipient_user_id FROM hiring_notification_deliveries
          WHERE source_event_id = ${eventId}::uuid AND email_state = 'PENDING'
          ORDER BY recipient_user_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND d.email_state = 'PENDING'
      RETURNING d.recipient_user_id, u.email, n.title, n.body
    `) as QueryResult<{ recipient_user_id: string; email: string; title: string; body: string }>;
    const recipient = claimed.rows[0];
    if (!recipient) break;
    const email = renderHiringEmail({ title: recipient.title, body: recipient.body });
    let outcome: 'SENT' | 'FAILED' | 'BOUNCED' = 'SENT';
    try {
      await mailSink.send({ toEmail: recipient.email, subject: email.subject, textBody: email.textBody, invitationId: eventId, correlationId,
        ...(attachments.length ? { attachments } : {}) });
    } catch (error) {
      outcome = error instanceof PermanentMailRejection ? 'BOUNCED' : 'FAILED';
    }
    await db.execute(sql`
      UPDATE hiring_notification_deliveries SET email_state = ${outcome}
      WHERE source_event_id = ${eventId}::uuid AND recipient_user_id = ${recipient.recipient_user_id}::uuid AND email_state = 'SENDING'
    `);
    if (outcome === 'SENT') counts.sent += 1; else if (outcome === 'BOUNCED') counts.bounced += 1; else counts.failed += 1;
  }
  return counts;
}
