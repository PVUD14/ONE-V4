/**
 * One calendar per person, gathered from what the product already records.
 *
 * Nothing here stores a date. Interviews, exam windows, staff-assigned tasks and roadmap
 * deadlines are all written elsewhere by the features that own them; this reads them back
 * for whoever is signed in and merges them into a single ordered list, plus an iCalendar
 * download for people who live in Outlook or Google Calendar.
 *
 * Every source is scoped by the same rule the owning feature uses, and two of those rules
 * are worth stating out loud because getting them wrong would leak something:
 *
 *   A staff action reaches a student's calendar only when its visibility is
 *   SUBJECT_VISIBLE. A STAFF_ONLY intervention is written *about* a student and must never
 *   appear *to* them.
 *
 *   An employer sees an interview only where they are still an active participant, which
 *   is the same narrow rule that stops an interviewer browsing the wider pipeline.
 */
import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };

export type CalendarEntryKind = 'INTERVIEW' | 'EXAM' | 'TASK' | 'MEETING' | 'ROADMAP';

export interface CalendarEntry {
  readonly id: string;
  readonly kind: CalendarEntryKind;
  readonly title: string;
  readonly detail: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly location: string | null;
  readonly joinUrl: string | null;
  /** Which portal the entry belongs to, so a client can group without re-deriving it. */
  readonly audience: 'STUDENT' | 'EMPLOYER' | 'STAFF';
}

/** A window wider than a year is a report, not a calendar, and would scan the whole table. */
const MAX_RANGE_DAYS = 400;
const DEFAULT_PAST_DAYS = 7;
const DEFAULT_FUTURE_DAYS = 60;

@Controller('/api/v1')
export class CalendarController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/me/calendar')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async calendar(@Req() request: ProtectedHttpRequest, @Query('from') from?: string, @Query('to') to?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const range = resolveRange(from, to);
    const entries = await this.collect(context, range);
    return { entries, range: { from: range.from.toISOString(), to: range.to.toISOString() }, correlationId: context.correlationId };
  }

  /**
   * The same entries as an iCalendar file.
   *
   * This is a download, not a subscription: it is served on the authenticated route like
   * everything else, so importing it gives a snapshot. A live subscribable feed needs a
   * URL a calendar client can fetch without a bearer token, and that token machinery is
   * being built once for shareable links rather than twice.
   */
  @Get('/me/calendar.ics')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async calendarFeed(@Req() request: ProtectedHttpRequest, @Query('from') from?: string, @Query('to') to?: string): Promise<string> {
    const context = requireTrustedAuthorization(request);
    const range = resolveRange(from, to);
    const entries = await this.collect(context, range);
    return renderCalendar(entries);
  }

  private async collect(context: ReturnType<typeof requireTrustedAuthorization>, range: { from: Date; to: Date }): Promise<readonly CalendarEntry[]> {
    const userId = context.authorization.principal.userId;
    const employerIds = context.authorization.memberships
      .filter((membership) => membership.state === 'ACTIVE' && membership.scope.employerId)
      .map((membership) => membership.scope.employerId as string);
    const staffMembershipIds = context.authorization.memberships
      .filter((membership) => membership.state === 'ACTIVE' && membership.scope.institutionId)
      .map((membership) => membership.id);

    const [studentEntries, employerEntries, staffEntries] = await Promise.all([
      this.studentEntries(userId, range),
      employerIds.length ? this.employerEntries(userId, employerIds, range) : Promise.resolve([]),
      staffMembershipIds.length ? this.staffEntries(staffMembershipIds, range) : Promise.resolve([]),
    ]);

    return [...studentEntries, ...employerEntries, ...staffEntries]
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title));
  }

  private async studentEntries(userId: string, range: { from: Date; to: Date }): Promise<readonly CalendarEntry[]> {
    const interviews = await this.db.execute(sql`
      SELECT i.id, i.scheduled_start, i.scheduled_end, i.mode, i.location_detail, i.joining_link,
             i.round_number, v.title, org.legal_name AS employer_name
      FROM interviews i
      JOIN applications a ON a.id = i.application_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN organizations org ON org.id = a.employer_id
      WHERE a.student_user_id = ${userId}::uuid
        AND i.state IN ('SCHEDULED','RESCHEDULED')
        AND i.scheduled_start BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;

    const exams = await this.db.execute(sql`
      SELECT d.id, d.title, d.starts_at, d.ends_at, d.duration_seconds, s.name AS subject_name
      FROM exam_assignments x
      JOIN exam_definitions d ON d.id = x.definition_id
      JOIN exam_subjects s ON s.id = d.subject_id
      WHERE x.student_user_id = ${userId}::uuid
        AND d.lifecycle_state = 'PUBLISHED'
        AND d.ends_at BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;

    // SUBJECT_VISIBLE only: a STAFF_ONLY action is written about a student, not to them.
    const tasks = await this.db.execute(sql`
      SELECT a.id, a.title, a.note, a.action_type, a.due_at, a.scheduled_start_at, a.scheduled_end_at,
             org.legal_name AS institution_name
      FROM staff_actions a
      JOIN organizations org ON org.id = a.institution_id
      WHERE a.subject_student_user_id = ${userId}::uuid
        AND a.visibility = 'SUBJECT_VISIBLE'
        AND a.archived_at IS NULL
        AND a.state IN ('OPEN','IN_PROGRESS','UNDER_REVIEW','CHANGES_REQUESTED')
        AND COALESCE(a.scheduled_start_at, a.due_at) BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;

    const roadmap = await this.db.execute(sql`
      SELECT r.id, r.action_code, r.due_at, t.name AS topic_name
      FROM roadmap_actions r
      JOIN taxonomy_nodes t ON t.id = r.topic_id
      WHERE r.subject_user_id = ${userId}::uuid
        AND r.state IN ('RECOMMENDED','ACCEPTED','IN_PROGRESS')
        AND r.due_at BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;

    return [
      ...interviews.rows.map((row): CalendarEntry => ({
        id: String(row.id), kind: 'INTERVIEW', audience: 'STUDENT',
        title: `Interview · ${String(row.title)}`,
        detail: `Round ${Number(row.round_number)} with ${String(row.employer_name)} · ${humanMode(String(row.mode))}`,
        startsAt: isoOf(row.scheduled_start), endsAt: row.scheduled_end ? isoOf(row.scheduled_end) : null,
        location: row.location_detail ? String(row.location_detail) : null,
        joinUrl: row.joining_link ? String(row.joining_link) : null,
      })),
      ...exams.rows.map((row): CalendarEntry => ({
        id: String(row.id), kind: 'EXAM', audience: 'STUDENT',
        title: `Exam closes · ${String(row.title)}`,
        // Stated on the entry because a phone reminder is exactly where someone would
        // otherwise try to start one.
        detail: `${String(row.subject_name)} · ${Math.round(Number(row.duration_seconds) / 60)} min · taken on a laptop`,
        startsAt: isoOf(row.starts_at), endsAt: isoOf(row.ends_at),
        location: null, joinUrl: null,
      })),
      ...tasks.rows.map((row): CalendarEntry => ({
        id: String(row.id), kind: row.action_type === 'MEETING' ? 'MEETING' : 'TASK', audience: 'STUDENT',
        title: String(row.title),
        detail: `${String(row.institution_name)}${row.note ? ` · ${String(row.note)}` : ''}`,
        startsAt: isoOf(row.scheduled_start_at ?? row.due_at),
        endsAt: row.scheduled_end_at ? isoOf(row.scheduled_end_at) : null,
        location: null, joinUrl: null,
      })),
      ...roadmap.rows.map((row): CalendarEntry => ({
        id: String(row.id), kind: 'ROADMAP', audience: 'STUDENT',
        title: `${humanAction(String(row.action_code))} · ${String(row.topic_name)}`,
        detail: 'Suggested next step', startsAt: isoOf(row.due_at), endsAt: null,
        location: null, joinUrl: null,
      })),
    ];
  }

  private async employerEntries(userId: string, employerIds: readonly string[], range: { from: Date; to: Date }): Promise<readonly CalendarEntry[]> {
    const rows = await this.db.execute(sql`
      SELECT i.id, i.scheduled_start, i.scheduled_end, i.mode, i.location_detail, i.joining_link,
             i.round_number, v.title, p.participant_role
      FROM interviews i
      JOIN interview_participants p ON p.interview_id = i.id
        AND p.participant_user_id = ${userId}::uuid AND p.removed_at IS NULL
      JOIN applications a ON a.id = i.application_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      -- EMP-03: an interviewer of a suspended, rejected or unverified employer no longer
      -- sees that employer's interview slots.
      JOIN organizations employer_org ON employer_org.id = i.employer_id
        AND employer_org.verification_state = 'VERIFIED' AND employer_org.active
      WHERE i.employer_id IN (${sql.join(employerIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND i.state IN ('SCHEDULED','RESCHEDULED')
        AND i.scheduled_start BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;
    // No candidate name: an interviewer's calendar entry is about the slot, and the
    // consented identity lives behind the interview screen that already checks for it.
    return rows.rows.map((row): CalendarEntry => ({
      id: String(row.id), kind: 'INTERVIEW', audience: 'EMPLOYER',
      title: `Interview · ${String(row.title)}`,
      detail: `Round ${Number(row.round_number)} · you are ${humanRole(String(row.participant_role))} · ${humanMode(String(row.mode))}`,
      startsAt: isoOf(row.scheduled_start), endsAt: row.scheduled_end ? isoOf(row.scheduled_end) : null,
      location: row.location_detail ? String(row.location_detail) : null,
      joinUrl: row.joining_link ? String(row.joining_link) : null,
    }));
  }

  private async staffEntries(membershipIds: readonly string[], range: { from: Date; to: Date }): Promise<readonly CalendarEntry[]> {
    const rows = await this.db.execute(sql`
      SELECT a.id, a.title, a.note, a.action_type, a.due_at, a.scheduled_start_at, a.scheduled_end_at
      FROM staff_actions a
      WHERE a.assigned_to_membership_id IN (${sql.join(membershipIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND a.archived_at IS NULL
        AND a.state IN ('OPEN','IN_PROGRESS','UNDER_REVIEW','CHANGES_REQUESTED')
        AND COALESCE(a.scheduled_start_at, a.due_at) BETWEEN ${range.from.toISOString()} AND ${range.to.toISOString()}
    `) as QueryResult<Record<string, unknown>>;
    return rows.rows.map((row): CalendarEntry => ({
      id: String(row.id), kind: row.action_type === 'MEETING' ? 'MEETING' : 'TASK', audience: 'STAFF',
      title: String(row.title), detail: row.note ? String(row.note) : null,
      startsAt: isoOf(row.scheduled_start_at ?? row.due_at),
      endsAt: row.scheduled_end_at ? isoOf(row.scheduled_end_at) : null,
      location: null, joinUrl: null,
    }));
  }
}

function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const now = Date.now();
  const start = parseDate(from) ?? new Date(now - DEFAULT_PAST_DAYS * 86400000);
  const end = parseDate(to) ?? new Date(now + DEFAULT_FUTURE_DAYS * 86400000);
  if (end <= start) return { from: start, to: new Date(start.getTime() + DEFAULT_FUTURE_DAYS * 86400000) };
  const capped = Math.min(end.getTime(), start.getTime() + MAX_RANGE_DAYS * 86400000);
  return { from: start, to: new Date(capped) };
}

/** An unparseable range falls back to the default window rather than failing the request. */
function parseDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function humanMode(mode: string): string {
  return mode === 'ONSITE' ? 'in person' : mode === 'VIDEO' ? 'video call' : 'phone call';
}

function humanRole(role: string): string {
  return role.toLowerCase().replace(/_/g, ' ');
}

function humanAction(code: string): string {
  return code === 'COMPLETE_LESSON' ? 'Finish lesson'
    : code === 'RETRY_PRACTICE' ? 'Practise again'
      : 'Review evidence';
}

// ---------------------------------------------------------------------------
// iCalendar rendering
// ---------------------------------------------------------------------------

/** RFC 5545 escaping: these four characters are structural inside a property value. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Content lines are folded at 75 octets, per RFC 5545. Outlook in particular drops an
 * event whose line runs long, which looks exactly like data loss to whoever is affected.
 */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  for (let index = 75; index < line.length; index += 74) parts.push(` ${line.slice(index, index + 74)}`);
  return parts.join('\r\n');
}

export function renderCalendar(entries: readonly CalendarEntry[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI8HT//ONE//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:ONE',
  ];
  for (const entry of entries) {
    const description = [entry.detail, entry.joinUrl].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${entry.kind.toLowerCase()}-${entry.id}@one.ai8ht.pro`,
      `DTSTAMP:${stamp(now.toISOString())}`,
      `DTSTART:${stamp(entry.startsAt)}`,
      // A deadline has no duration: a point in time gets a zero-length event rather than
      // an invented hour that would block out someone's afternoon.
      ...(entry.endsAt ? [`DTEND:${stamp(entry.endsAt)}`] : [`DTEND:${stamp(entry.startsAt)}`]),
      fold(`SUMMARY:${escapeText(entry.title)}`),
      ...(description ? [fold(`DESCRIPTION:${escapeText(description)}`)] : []),
      ...(entry.location ? [fold(`LOCATION:${escapeText(entry.location)}`)] : []),
      ...(entry.joinUrl ? [fold(`URL:${entry.joinUrl}`)] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
