/**
 * Calendar invites for interviews (EMP-09): an RFC 5545 .ics for one interview, as it stood at one
 * schedule revision.
 *
 * METHOD:PUBLISH with STATUS:CANCELLED for a cancellation: REQUEST and CANCEL need an ORGANIZER
 * mailbox that receives replies, and ONE has no sending domain until hard gate HG-7. Google
 * Calendar, Outlook and Apple Calendar import a PUBLISH event and replace it when one with the same
 * UID and a higher SEQUENCE arrives, so SEQUENCE is the revision number less one. The UID is a hash
 * of the interview id, so the id itself never leaves ONE.
 * Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
 */
import { createHash } from 'node:crypto';

export const INTERVIEW_CALENDAR_CONTENT_TYPE = 'text/calendar; charset=utf-8; method=PUBLISH';
const UID_DOMAIN = 'one.ai8ht.pro';
const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

export function interviewCalendarUid(interviewId: string): string {
  const digest = createHash('sha256').update(`one-interview:${interviewId.toLowerCase()}`).digest('hex').slice(0, 32);
  return `${digest}@${UID_DOMAIN}`;
}

/** A plain ASCII filename a phone or mail client will keep: the job title and the round. */
export function interviewCalendarFilename(title: string, roundNumber: number): string {
  const slug = title.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'interview';
  return `interview-${slug}-round-${roundNumber}.ics`;
}

const modeWords: Readonly<Record<string, string>> = { VIDEO: 'Video', PHONE: 'Phone', ONSITE: 'On-site' };

export interface InterviewCalendarFacts {
  readonly employerName: string;
  readonly title: string;
  readonly roundNumber: number;
  readonly stageLabel: string | null;
  readonly mode: string;
  readonly state: string;
  /**
   * Whether the reader may see how to join: the joining link, the location and what to prepare.
   * True for a download inside ONE by the student or an assigned panellist with a live grant;
   * false for an emailed invite (EMP-08 keeps those out of email) and for a cancellation.
   */
  readonly includeAccess: boolean;
  readonly joiningLink: string | null;
  readonly locationDetail: string | null;
  readonly preparationNote: string | null;
}

export interface InterviewCalendarText {
  readonly summary: string;
  readonly description: string;
  readonly location: string | null;
  readonly url: string | null;
}

/** The words of the invite. The candidate's name never appears: the panel reads it in ONE. */
export function describeInterviewForCalendar(facts: InterviewCalendarFacts): InterviewCalendarText {
  const round = facts.stageLabel ?? `round ${facts.roundNumber}`;
  const cancelled = facts.state === 'CANCELLED';
  const summary = `${cancelled ? 'Cancelled: ' : ''}Interview: ${facts.title} with ${facts.employerName} (${round})`;
  const access = facts.includeAccess && !cancelled;
  const lines: string[] = [];
  if (cancelled) lines.push('This interview was cancelled.');
  lines.push(`${modeWords[facts.mode] ?? 'An'} interview (${round}) for ${facts.title} with ${facts.employerName}.`);
  if (access) {
    if (facts.joiningLink) lines.push(`Join: ${facts.joiningLink}`);
    if (facts.locationDetail) lines.push(`${facts.mode === 'ONSITE' ? 'Where' : 'Arrangements'}: ${facts.locationDetail}`);
    if (facts.preparationNote) lines.push(`Prepare: ${facts.preparationNote}`);
    lines.push('Sign in to ONE to see any change to this interview.');
  } else {
    lines.push('Sign in to ONE for the joining link or location, what to prepare and any change to this interview.');
  }
  const location = access ? (facts.mode === 'ONSITE' ? facts.locationDetail : facts.joiningLink ?? facts.locationDetail) : null;
  return { summary, description: lines.join('\n'), location: location ?? null, url: access ? facts.joiningLink : null };
}

export interface InterviewCalendarInput extends InterviewCalendarText {
  readonly uid: string;
  readonly sequence: number;
  /** When this revision was recorded, on the database clock. */
  readonly stamp: Date;
  readonly start: Date;
  readonly end: Date | null;
  readonly cancelled: boolean;
}

export function buildInterviewCalendar(input: InterviewCalendarInput): string {
  const end = input.end ?? new Date(input.start.getTime() + DEFAULT_LENGTH_MS);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI8HT//ONE Interviews//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uriValue(input.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    `DTSTAMP:${utc(input.stamp)}`,
    `DTSTART:${utc(input.start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    `DESCRIPTION:${escapeText(input.description)}`,
    ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
    ...(input.url ? [`URL:${uriValue(input.url)}`] : []),
    `STATUS:${input.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `TRANSP:${input.cancelled ? 'TRANSPARENT' : 'OPAQUE'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function utc(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** RFC 5545 §3.3.11 TEXT: escape backslash, semicolon and comma; a line break becomes \n. */
function escapeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** A URI or UID value is not escaped, but it may never break a line. */
function uriValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/** RFC 5545 §3.1: at most 75 octets per line; continue with CRLF and one space; never split a character. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = 75;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74; // the leading space of a continuation line counts
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
