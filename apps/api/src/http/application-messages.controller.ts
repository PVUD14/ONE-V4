/**
 * Application-bound messages (EMP-10): one conversation per application between the candidate and
 * the employer's team, inside ONE, so neither side has to swap personal numbers early.
 *
 * Employer routes run requireActiveEmployer (action `candidates`: active membership in a verified,
 * active employer) and then the one live-grant predicate (EMP-SR-01) on every request — a withdrawal,
 * close, revoked sharing, expiry or deletion request stops the employer on the next request, and a
 * send share-locks the grant so a racing withdrawal waits for it or wins. An employer may start a
 * conversation from SHORTLISTED onward (decision 10.2 #8). The student reads their own conversation
 * always (read-only once the grant ends), replies while it is live, mutes notices and reports a
 * message into a trust case. Text only (≤ 2,000 characters), links flagged, no attachments, rate
 * limited, unknown fields refused, every write audited, notices only through the outbox (EMP-08).
 * Employers never see a report, a mute, a recruiter's identity on the student side, or readiness.
 * Design: docs/architecture/application-messages-table-design.md.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant, assertEmployerApplicationAccess } from '@planthepath/persistence/src/employer-authentication.js';
import {
  MessageInputError,
  assertOnlyFields,
  canEmployerMessage,
  containsLink,
  messageLimits,
  readMessageBody,
  readReportReason,
  readReportStatement,
  reportSeverity,
} from '@planthepath/hiring/src/application-messages.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerInGoodStandingSql, employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };
type Db = Pick<PersistenceDb, 'execute'>;
type Side = 'EMPLOYER' | 'STUDENT';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

type MessageRow = {
  id: string;
  sender_side: Side;
  sender_user_id: string;
  body: string | null;
  contains_link: boolean;
  sent_at: Date | string;
  read_at: Date | string | null;
  reported_at: Date | string | null;
  erased_at: Date | string | null;
}

@Controller('/api/v1')
export class ApplicationMessagesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // Employer
  // -------------------------------------------------------------------------

  /** The Messages inbox: conversations whose candidate still shares their details, newest first. */
  @Get('/employers/:employerId/message-threads')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async inbox(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string,
    @Query('limit') limitParam?: string, @Query('cursor') cursorParam?: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    const after = cursor ? sql`AND (t.last_message_at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``;
    const rows = await this.db.execute(sql`
      SELECT t.id, t.application_id, t.started_at, t.last_message_at, a.state AS application_state, a.opportunity_id,
             v.title, o.reference_code, isp.full_name,
             (SELECT count(*) FROM application_messages m WHERE m.thread_id = t.id AND m.sender_side = 'STUDENT' AND m.read_at IS NULL AND m.erased_at IS NULL)::int AS unread,
             (SELECT count(*) FROM application_messages m WHERE m.thread_id = t.id)::int AS message_count,
             (SELECT m.sender_side FROM application_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_from
      FROM application_message_threads t
      JOIN applications a ON a.id = t.application_id AND a.employer_id = t.employer_id
      JOIN opportunities o ON o.id = a.opportunity_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      LEFT JOIN LATERAL (SELECT p.full_name FROM institution_student_profiles p
        WHERE p.student_user_id = a.student_user_id AND p.status = 'ACTIVE' ORDER BY p.created_at LIMIT 1) isp ON true
      WHERE t.employer_id = ${employerId}::uuid AND a.consent_revoked_at IS NULL AND ${applicationHasLiveApplicantGrant('a')}
        ${after}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ${limit + 1}
    `) as QueryResult<Record<string, unknown>>;
    const unique = rows.rows;
    const page = unique.slice(0, limit);
    const withheld = await this.db.execute(sql`
      SELECT count(*)::int AS count FROM application_message_threads t JOIN applications a ON a.id = t.application_id
      WHERE t.employer_id = ${employerId}::uuid AND NOT (a.consent_revoked_at IS NULL AND ${applicationHasLiveApplicantGrant('a')})
    `) as QueryResult<{ count: number }>;
    await writeAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'application.message_threads.viewed', 'organization', employerId,
      employerId, context.correlationId, { threads: page.length });
    const last = page.at(-1);
    return {
      threads: page.map((row) => ({
        applicationId: row.application_id,
        opportunityId: row.opportunity_id,
        title: row.title,
        referenceCode: row.reference_code ?? null,
        candidateName: row.full_name ?? null,
        applicationState: row.application_state,
        startedAt: iso(row.started_at),
        lastMessageAt: iso(row.last_message_at),
        lastFrom: row.last_from ?? null,
        messageCount: Number(row.message_count ?? 0),
        unreadCount: Number(row.unread ?? 0),
      })),
      // Conversations whose candidate no longer shares their details: counted, never listed.
      withheldCount: Number(withheld.rows[0]?.count ?? 0),
      nextCursor: unique.length > limit && last ? writeCursor(iso(last.last_message_at)!, String(last.id)) : null,
      correlationId: context.correlationId,
    };
  }

  /** One application's conversation for the employer, while the grant is live. Marks the candidate's messages read. */
  @Get('/employers/:employerId/applications/:applicationId/messages')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async employerConversation(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string,
    @Query('limit') limitParam?: string, @Query('before') beforeParam?: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const limit = readLimit(limitParam, context.correlationId);
    const before = readCursor(beforeParam, context.correlationId);
    const actorId = context.authorization.principal.userId;
    await requireLiveGrant(this.db, employerId, id, context.correlationId);

    const application = await this.db.execute(sql`
      SELECT a.id, a.state, a.closed_at, v.title FROM applications a JOIN opportunity_versions v ON v.id = a.applied_version_id
      WHERE a.id = ${id}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<{ id: string; state: string; closed_at: unknown; title: string }>;
    const [row] = application.rows;
    if (!row) throw forbidden(context.correlationId);
    const thread = await readThread(this.db, id);
    const page = thread ? await readMessages(this.db, thread.id, limit, before) : { messages: [], hasEarlier: false };
    if (thread) {
      const read = await markRead(this.db, thread.id, 'STUDENT');
      if (read > 0) await writeAudit(this.db, this.ids.uuid(), actorId, 'application.messages.read', 'application', id, employerId, context.correlationId, { messages: read });
    }
    await writeAudit(this.db, this.ids.uuid(), actorId, 'application.messages.viewed', 'application', id, employerId, context.correlationId, {});
    const open = row.closed_at == null && canEmployerMessage(row.state);
    return {
      conversation: {
        applicationId: id,
        applicationState: row.state,
        title: row.title,
        started: thread != null,
        startedAt: thread ? iso(thread.started_at) : null,
        canSend: open,
        // Why the composer is closed, in the client's words; null when it is open.
        sendBlockedReason: open ? null : row.closed_at != null ? 'APPLICATION_CLOSED' : 'NOT_SHORTLISTED',
        messages: page.messages.map((message) => ({
          id: message.id,
          from: message.sender_side,
          mine: message.sender_user_id === actorId,
          body: message.body,
          containsLink: message.contains_link,
          sentAt: iso(message.sent_at),
          readAt: iso(message.read_at),
          erased: message.erased_at != null,
        })),
        hasEarlier: page.hasEarlier,
      },
      correlationId: context.correlationId,
    };
  }

  /** The employer writes: starts the conversation from SHORTLISTED onward, or continues it. */
  @Post('/employers/:employerId/applications/:applicationId/messages')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async employerSend(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string,
    @Body() rawBody: unknown): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const text = parseInput(() => readMessageBody(assertOnlyFields(rawBody, ['body']).body), context.correlationId);
    const actorId = context.authorization.principal.userId;

    const sent = await this.db.transaction(async (tx) => {
      // The grant is share-locked, so a withdrawal or deletion racing this send waits for it or wins.
      await requireLiveGrant(tx, employerId, id, context.correlationId, true);
      const application = await tx.execute(sql`
        SELECT id, state, closed_at, student_user_id, opportunity_id FROM applications
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid FOR SHARE
      `) as QueryResult<{ id: string; state: string; closed_at: unknown; student_user_id: string; opportunity_id: string }>;
      const [row] = application.rows;
      if (!row) throw forbidden(context.correlationId);
      if (row.closed_at != null || !canEmployerMessage(row.state)) throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);

      let thread = await readThread(tx, id, true);
      let started = false;
      if (!thread) {
        const recent = await count(tx, sql`SELECT count(*)::int AS count FROM application_message_threads
          WHERE employer_id = ${employerId}::uuid AND started_at > now() - interval '24 hours'`);
        if (recent >= messageLimits.employerNewThreadsPerDay) throw rateLimited('MESSAGE_RATE_LIMITED', context.correlationId);
        await tx.execute(sql`
          INSERT INTO application_message_threads (id, application_id, employer_id, student_user_id, opportunity_id, started_by_user_id)
          VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${employerId}::uuid, ${row.student_user_id}::uuid, ${row.opportunity_id}::uuid, ${actorId}::uuid)
          ON CONFLICT (application_id) DO NOTHING
        `);
        thread = await readThread(tx, id, true);
        started = true;
      }
      if (!thread) throw forbidden(context.correlationId);
      await enforceThreadLimits(tx, thread.id, 'EMPLOYER', context.correlationId);
      const employerRecent = await count(tx, sql`SELECT count(*)::int AS count FROM application_messages m
        JOIN application_message_threads t ON t.id = m.thread_id
        WHERE t.employer_id = ${employerId}::uuid AND m.sender_side = 'EMPLOYER' AND m.sent_at > now() - interval '1 hour'`);
      if (employerRecent >= messageLimits.employerPerHour) throw rateLimited('MESSAGE_RATE_LIMITED', context.correlationId);

      const message = await insertMessage(tx, this.ids.uuid(), thread.id, 'EMPLOYER', actorId, text);
      await writeAudit(tx, this.ids.uuid(), actorId, 'application.message.sent', 'application', id, employerId, context.correlationId,
        { side: 'EMPLOYER', started, containsLink: message.contains_link, length: text.length });
      await writeOutbox(tx, this.ids.uuid(), id, message.id, actorId, employerId, context.correlationId);
      return message;
    });
    return {
      message: { id: sent.id, from: 'EMPLOYER', mine: true, body: sent.body, containsLink: sent.contains_link, sentAt: iso(sent.sent_at), readAt: null, erased: false },
      correlationId: context.correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // Student
  // -------------------------------------------------------------------------

  /** The student's own conversation for one application. Readable after the grant ends; marks the employer's messages read. */
  @Get('/students/me/applications/:applicationId/messages')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async studentConversation(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string,
    @Query('limit') limitParam?: string, @Query('before') beforeParam?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const limit = readLimit(limitParam, context.correlationId);
    const before = readCursor(beforeParam, context.correlationId);
    const application = await readStudentApplication(this.db, id, studentId);
    if (!application) throw forbidden(context.correlationId);
    const thread = await readThread(this.db, id);
    const page = thread ? await readMessages(this.db, thread.id, limit, before) : { messages: [], hasEarlier: false };
    if (thread) {
      const read = await markRead(this.db, thread.id, 'EMPLOYER');
      if (read > 0) await writeAudit(this.db, this.ids.uuid(), studentId, 'application.messages.read', 'application', id, application.employer_id, context.correlationId, { messages: read });
    }
    const canReply = thread != null && application.reply_open === true;
    return {
      conversation: {
        applicationId: id,
        employerName: application.employer_name,
        title: application.title,
        started: thread != null,
        startedAt: thread ? iso(thread.started_at) : null,
        muted: thread?.student_muted_at != null,
        canReply,
        replyBlockedReason: canReply ? null : thread == null ? 'NOT_STARTED' : 'ACCESS_ENDED',
        messages: page.messages.map((message) => ({
          id: message.id,
          from: message.sender_side,
          mine: message.sender_side === 'STUDENT',
          body: message.body,
          containsLink: message.contains_link,
          sentAt: iso(message.sent_at),
          readAt: iso(message.read_at),
          erased: message.erased_at != null,
          reportedAt: message.sender_side === 'EMPLOYER' ? iso(message.reported_at) : null,
        })),
        hasEarlier: page.hasEarlier,
      },
      correlationId: context.correlationId,
    };
  }

  /** The student replies, once the employer has started the conversation and while the grant is live. */
  @Post('/students/me/applications/:applicationId/messages')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async studentSend(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() rawBody: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const text = parseInput(() => readMessageBody(assertOnlyFields(rawBody, ['body']).body), context.correlationId);

    const sent = await this.db.transaction(async (tx) => {
      const application = await tx.execute(sql`
        SELECT id, employer_id, closed_at FROM applications
        WHERE id = ${id}::uuid AND student_user_id = ${studentId}::uuid AND state <> 'DRAFT' FOR SHARE
      `) as QueryResult<{ id: string; employer_id: string; closed_at: unknown }>;
      const [row] = application.rows;
      if (!row) throw forbidden(context.correlationId);
      const thread = await readThread(tx, id, true);
      if (!thread) throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);
      // No message without a live grant, on either side: the employer could not read it anyway.
      if (row.closed_at != null) throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);
      try {
        await assertEmployerApplicationAccess(tx, { employerId: row.employer_id, applicationIds: [id], lockForMutation: true });
      } catch {
        throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);
      }
      const standing = await tx.execute(sql`SELECT ${employerInGoodStandingSql(sql`${row.employer_id}::uuid`)} AS ok`) as QueryResult<{ ok: boolean }>;
      if (standing.rows[0]?.ok !== true) throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);

      await enforceThreadLimits(tx, thread.id, 'STUDENT', context.correlationId);
      const studentRecent = await count(tx, sql`SELECT count(*)::int AS count FROM application_messages
        WHERE sender_user_id = ${studentId}::uuid AND sender_side = 'STUDENT' AND sent_at > now() - interval '1 hour'`);
      if (studentRecent >= messageLimits.studentPerHour) throw rateLimited('MESSAGE_RATE_LIMITED', context.correlationId);

      const message = await insertMessage(tx, this.ids.uuid(), thread.id, 'STUDENT', studentId, text);
      await writeAudit(tx, this.ids.uuid(), studentId, 'application.message.sent', 'application', id, row.employer_id, context.correlationId,
        { side: 'STUDENT', containsLink: message.contains_link, length: text.length });
      await writeOutbox(tx, this.ids.uuid(), id, message.id, studentId, row.employer_id, context.correlationId);
      return message;
    });
    return {
      message: { id: sent.id, from: 'STUDENT', mine: true, body: sent.body, containsLink: sent.contains_link, sentAt: iso(sent.sent_at), readAt: null, erased: false, reportedAt: null },
      correlationId: context.correlationId,
    };
  }

  /** Mute or unmute notices for one conversation. Messages still arrive; the employer is not told. */
  @Post('/students/me/applications/:applicationId/messages/mute')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async mute(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() rawBody: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const muted = parseInput(() => {
      const value = assertOnlyFields(rawBody, ['muted']).muted;
      if (typeof value !== 'boolean') throw new MessageInputError('INVALID_MUTED');
      return value;
    }, context.correlationId);
    const application = await readStudentApplication(this.db, id, studentId);
    if (!application) throw forbidden(context.correlationId);
    const updated = await this.db.transaction(async (tx) => {
      const changed = await tx.execute(sql`
        UPDATE application_message_threads
        SET student_muted_at = CASE WHEN ${muted}::boolean THEN coalesce(student_muted_at, greatest(now(), started_at)) ELSE NULL END
        WHERE application_id = ${id}::uuid AND student_user_id = ${studentId}::uuid
        RETURNING student_muted_at
      `) as QueryResult<{ student_muted_at: unknown }>;
      if (!changed.rows.length) throw badRequest('MESSAGING_NOT_AVAILABLE', context.correlationId);
      await writeAudit(tx, this.ids.uuid(), studentId, muted ? 'application.messages.muted' : 'application.messages.unmuted', 'application', id,
        application.employer_id, context.correlationId, {});
      return changed.rows[0]!;
    });
    return { conversation: { applicationId: id, muted: updated.student_muted_at != null }, correlationId: context.correlationId };
  }

  /**
   * The student reports one of the employer's messages. Opens a trust case (or adds to the one the
   * student already has open for this conversation) with the conversation and the message as
   * evidence. Not a penalty, and never shown to the employer.
   */
  @Post('/students/me/applications/:applicationId/messages/:messageId/report')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async report(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Param('messageId') messageId: string,
    @Body() rawBody: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const reported = requireUuid(messageId, context.correlationId);
    const { reason, statement } = parseInput(() => {
      const body = assertOnlyFields(rawBody, ['reasonCode', 'statement']);
      return { reason: readReportReason(body.reasonCode), statement: readReportStatement(body.statement) };
    }, context.correlationId);

    const reportedAt = await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT m.id, m.sender_side, m.reported_at, m.erased_at, t.id AS thread_id, t.employer_id
        FROM application_messages m JOIN application_message_threads t ON t.id = m.thread_id
        WHERE m.id = ${reported}::uuid AND t.application_id = ${id}::uuid AND t.student_user_id = ${studentId}::uuid
        FOR UPDATE OF m
      `) as QueryResult<{ id: string; sender_side: Side; reported_at: unknown; erased_at: unknown; thread_id: string; employer_id: string }>;
      const [message] = found.rows;
      if (!message) throw forbidden(context.correlationId);
      if (message.sender_side !== 'EMPLOYER' || message.erased_at != null) throw badRequest('MESSAGE_NOT_REPORTABLE', context.correlationId);
      if (message.reported_at != null) throw badRequest('MESSAGE_ALREADY_REPORTED', context.correlationId);

      const open = await tx.execute(sql`
        SELECT c.id FROM trust_cases c
        WHERE c.reported_by_user_id = ${studentId}::uuid AND c.state NOT IN ('CLOSED', 'DISMISSED')
          AND EXISTS (SELECT 1 FROM trust_case_evidence e WHERE e.case_id = c.id
            AND e.evidence_kind = 'APPLICATION_MESSAGE_THREAD' AND e.reference_id = ${message.thread_id})
        ORDER BY c.opened_at DESC LIMIT 1 FOR UPDATE
      `) as QueryResult<{ id: string }>;
      const severity = reportSeverity(reason);
      let caseId = open.rows[0]?.id;
      if (caseId) {
        if (severity === 'HIGH') {
          await tx.execute(sql`UPDATE trust_cases SET severity = 'HIGH', version = version + 1 WHERE id = ${caseId}::uuid AND severity IN ('LOW', 'MEDIUM')`);
        }
      } else {
        caseId = this.ids.uuid();
        // A report is not a penalty (0032, spec 38): the case is opened and nothing else happens.
        await tx.execute(sql`
          INSERT INTO trust_cases (id, case_type, subject_kind, subject_organization_id, organization_id, reported_by_user_id, severity)
          VALUES (${caseId}::uuid, 'EMPLOYER_ACCOUNTABILITY', 'ORGANIZATION', ${message.employer_id}::uuid, ${message.employer_id}::uuid, ${studentId}::uuid, ${severity})
        `);
        await tx.execute(sql`
          INSERT INTO trust_case_evidence (id, case_id, evidence_kind, reference_id, added_by_user_id)
          VALUES (${this.ids.uuid()}::uuid, ${caseId}::uuid, 'APPLICATION_MESSAGE_THREAD', ${message.thread_id}, ${studentId}::uuid)
        `);
        await writeAudit(tx, this.ids.uuid(), studentId, 'trust.case.opened', 'trust_case', caseId, message.employer_id, context.correlationId,
          { caseType: 'EMPLOYER_ACCOUNTABILITY', subjectKind: 'ORGANIZATION', source: 'APPLICATION_MESSAGE_REPORT' });
      }
      await tx.execute(sql`
        INSERT INTO trust_case_evidence (id, case_id, evidence_kind, reference_id, added_by_user_id)
        VALUES (${this.ids.uuid()}::uuid, ${caseId}::uuid, 'APPLICATION_MESSAGE', ${message.id}, ${studentId}::uuid)
      `);
      if (statement) {
        await tx.execute(sql`
          INSERT INTO trust_case_evidence (id, case_id, evidence_kind, reference_id, statement, added_by_user_id)
          VALUES (${this.ids.uuid()}::uuid, ${caseId}::uuid, 'REPORTER_STATEMENT', ${`message:${message.id}`}, ${statement}, ${studentId}::uuid)
        `);
      }
      const marked = await tx.execute(sql`
        UPDATE application_messages SET reported_at = greatest(now(), sent_at), report_reason_code = ${reason}, trust_case_id = ${caseId}::uuid
        WHERE id = ${message.id}::uuid AND reported_at IS NULL
        RETURNING reported_at
      `) as QueryResult<{ reported_at: Date | string }>;
      await writeAudit(tx, this.ids.uuid(), studentId, 'application.message.reported', 'application', id, message.employer_id, context.correlationId,
        { reasonCode: reason, statement: statement != null });
      return marked.rows[0]!.reported_at;
    });
    return { report: { messageId: reported, reportedAt: iso(reportedAt) }, correlationId: context.correlationId };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readStudentApplication(db: Db, applicationId: string, studentId: string) {
  const rows = await db.execute(sql`
    SELECT a.id, a.employer_id, org.legal_name AS employer_name, v.title,
           (a.closed_at IS NULL AND ${applicationHasLiveApplicantGrant('a')} AND ${employerInGoodStandingSql(sql`a.employer_id`)}) AS reply_open
    FROM applications a
    JOIN organizations org ON org.id = a.employer_id
    JOIN opportunity_versions v ON v.id = a.applied_version_id
    WHERE a.id = ${applicationId}::uuid AND a.student_user_id = ${studentId}::uuid AND a.state <> 'DRAFT'
  `) as QueryResult<{ id: string; employer_id: string; employer_name: string; title: string; reply_open: boolean }>;
  return rows.rows[0];
}

async function readThread(db: Db, applicationId: string, lock = false) {
  const rows = await db.execute(sql`
    SELECT id, started_at, student_muted_at FROM application_message_threads WHERE application_id = ${applicationId}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}
  `) as QueryResult<{ id: string; started_at: Date | string; student_muted_at: unknown }>;
  return rows.rows[0];
}

/** A page of messages, newest `limit` before the cursor, returned oldest first. */
async function readMessages(db: Db, threadId: string, limit: number, before: Cursor | null): Promise<{ messages: MessageRow[]; hasEarlier: boolean }> {
  const earlier = before ? sql`AND (sent_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)` : sql``;
  const rows = await db.execute(sql`
    SELECT id, sender_side, sender_user_id, body, contains_link, sent_at, read_at, reported_at, erased_at
    FROM application_messages WHERE thread_id = ${threadId}::uuid ${earlier}
    ORDER BY sent_at DESC, id DESC LIMIT ${limit + 1}
  `) as QueryResult<MessageRow>;
  return { messages: rows.rows.slice(0, limit).reverse(), hasEarlier: rows.rows.length > limit };
}

/** The reader has seen the other side's messages; the time is set once (0067 trigger). */
async function markRead(db: Db, threadId: string, otherSide: Side): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE application_messages SET read_at = greatest(now(), sent_at)
    WHERE thread_id = ${threadId}::uuid AND sender_side = ${otherSide} AND read_at IS NULL AND erased_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return rows.rows.length;
}

/** Per-thread brakes, exact because the caller holds the thread row lock. */
async function enforceThreadLimits(tx: Db, threadId: string, side: Side, correlationId: string): Promise<void> {
  const recent = await count(tx, sql`SELECT count(*)::int AS count FROM application_messages
    WHERE thread_id = ${threadId}::uuid AND sender_side = ${side} AND sent_at > now() - interval '1 hour'`);
  if (recent >= messageLimits.perThreadSidePerHour) throw rateLimited('MESSAGE_RATE_LIMITED', correlationId);
  if (side === 'EMPLOYER') {
    const unanswered = await count(tx, sql`SELECT count(*)::int AS count FROM application_messages m
      WHERE m.thread_id = ${threadId}::uuid AND m.sender_side = 'EMPLOYER'
        AND m.sent_at >= coalesce((SELECT max(s.sent_at) FROM application_messages s WHERE s.thread_id = ${threadId}::uuid AND s.sender_side = 'STUDENT'), '-infinity'::timestamptz)`);
    if (unanswered >= messageLimits.employerUnansweredInARow) throw rateLimited('MESSAGE_AWAITING_REPLY', correlationId);
  }
}

async function insertMessage(tx: Db, id: string, threadId: string, side: Side, senderId: string, body: string) {
  const rows = await tx.execute(sql`
    INSERT INTO application_messages (id, thread_id, sender_side, sender_user_id, body, contains_link)
    VALUES (${id}::uuid, ${threadId}::uuid, ${side}, ${senderId}::uuid, ${body}, ${containsLink(body)})
    RETURNING id, body, contains_link, sent_at
  `) as QueryResult<{ id: string; body: string; contains_link: boolean; sent_at: Date | string }>;
  await tx.execute(sql`UPDATE application_message_threads SET last_message_at = greatest(last_message_at, now()) WHERE id = ${threadId}::uuid`);
  return rows.rows[0]!;
}

async function count(db: Db, query: SQL): Promise<number> {
  const rows = await db.execute(query) as QueryResult<{ count: number }>;
  return Number(rows.rows[0]?.count ?? 0);
}

async function requireLiveGrant(db: Db, employerId: string, applicationId: string, correlationId: string, lock = false): Promise<void> {
  try {
    await assertEmployerApplicationAccess(db, { employerId, applicationIds: [applicationId], lockForMutation: lock });
  } catch {
    throw forbidden(correlationId);
  }
}

async function writeAudit(db: Db, id: string, actorUserId: string, action: string, resourceType: string, resourceId: string,
  organizationId: string, correlationId: string, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, ${organizationId}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(detail)}::jsonb)
  `);
}

/** One outbox row per message, committed with it. The payload never carries the text. */
async function writeOutbox(db: Db, id: string, applicationId: string, messageId: string, actorUserId: string, employerId: string, correlationId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${id}::uuid, 'application', ${applicationId}, 'application.message.sent', ${JSON.stringify({ applicationId, messageId })}::jsonb,
      ${actorUserId}::uuid, ${employerId}::uuid, ${correlationId})
  `);
}

interface Cursor { readonly at: string; readonly id: string }

function writeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

function readCursor(value: string | undefined, correlationId: string): Cursor | null {
  if (value == null || value === '') return null;
  try {
    if (value.length > 200) throw new Error('long');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at)) || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) throw new Error('shape');
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch {
    throw badRequest('INVALID_CURSOR', correlationId);
  }
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value == null || value === '') return DEFAULT_PAGE;
  if (!/^\d{1,3}$/.test(value)) throw badRequest('INVALID_LIMIT', correlationId);
  const limit = Number(value);
  if (limit < 1 || limit > MAX_PAGE) throw badRequest('INVALID_LIMIT', correlationId);
  return limit;
}

function parseInput<T>(read: () => T, correlationId: string): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof MessageInputError) throw badRequest(error.code, correlationId);
    throw error;
  }
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function safeMessageError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safeMessageError(code, correlationId));
}

function rateLimited(code: string, correlationId: string): HttpException {
  return new HttpException(safeMessageError(code, correlationId), HttpStatus.TOO_MANY_REQUESTS);
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
