/**
 * The calendar invite for one interview at one schedule revision (EMP-09), read from the database
 * and built by the pure RFC 5545 builder in @planthepath/hiring.
 *
 * Shared by the outbox consumer, which attaches it to interview emails, and by the student and
 * panellist download routes. Who reads it decides what it carries: an emailed invite never has the
 * joining link, location or preparation note (EMP-08 keeps those out of email); a download inside
 * ONE has them while the reader may see them — the student while the interview is ahead, a
 * panellist while the candidate's applicant-access grant is live.
 * Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
 */
import { sql } from 'drizzle-orm';
import {
  INTERVIEW_CALENDAR_CONTENT_TYPE,
  buildInterviewCalendar,
  describeInterviewForCalendar,
  interviewCalendarFilename,
  interviewCalendarUid,
} from '@planthepath/hiring/src/interview-calendar.js';
import { applicationHasLiveApplicantGrant } from './employer-authentication.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

export interface InterviewCalendarFile {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

/** EMAIL: attached to a notice. STUDENT / PANEL: downloaded by that reader inside ONE. */
export type InterviewCalendarReader = 'EMAIL' | 'STUDENT' | 'PANEL';

export async function loadInterviewCalendar(db: Executor, input: {
  readonly interviewId: string;
  /** The revision an event names; the latest one when absent (a download, or an event from before 0063). */
  readonly revisionId?: string | null;
  readonly reader: InterviewCalendarReader;
}): Promise<InterviewCalendarFile | null> {
  const rows = await db.execute(sql`
    SELECT r.revision_number, r.change_kind, r.mode, r.scheduled_start, r.scheduled_end, r.location_detail, r.joining_link, r.recorded_at,
           i.round_number, i.state, i.preparation_note, st.label AS stage_label, org.legal_name AS employer_name, v.title,
           (i.state IN ('SCHEDULED', 'RESCHEDULED') AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL
             AND coalesce(i.scheduled_end, i.scheduled_start + interval '1 hour') > now()) AS upcoming,
           ${applicationHasLiveApplicantGrant('a')} AS candidate_access
    FROM interviews i
    JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
    JOIN organizations org ON org.id = i.employer_id
    JOIN opportunity_versions v ON v.id = a.applied_version_id
    LEFT JOIN opportunity_selection_stages st ON st.id = i.selection_stage_id
    JOIN LATERAL (
      SELECT * FROM interview_schedule_revisions rev
      WHERE rev.interview_id = i.id ${input.revisionId ? sql`AND rev.id = ${input.revisionId}::uuid` : sql``}
      ORDER BY rev.revision_number DESC LIMIT 1
    ) r ON true
    WHERE i.id = ${input.interviewId}::uuid
  `) as QueryResult<Record<string, unknown>>;
  const row = rows.rows[0];
  if (!row || row.scheduled_start == null) return null;
  const cancelled = row.change_kind === 'CANCELLED' || (!input.revisionId && row.state === 'CANCELLED');
  const includeAccess = input.reader === 'STUDENT' ? row.upcoming === true
    : input.reader === 'PANEL' ? row.candidate_access === true && row.upcoming === true
      : false;
  const title = String(row.title);
  const text = describeInterviewForCalendar({
    employerName: String(row.employer_name), title, roundNumber: Number(row.round_number),
    stageLabel: row.stage_label == null ? null : String(row.stage_label), mode: String(row.mode),
    state: cancelled ? 'CANCELLED' : String(row.state), includeAccess,
    joiningLink: row.joining_link == null ? null : String(row.joining_link),
    locationDetail: row.location_detail == null ? null : String(row.location_detail),
    preparationNote: row.preparation_note == null ? null : String(row.preparation_note),
  });
  return {
    filename: interviewCalendarFilename(title, Number(row.round_number)),
    contentType: INTERVIEW_CALENDAR_CONTENT_TYPE,
    content: buildInterviewCalendar({
      uid: interviewCalendarUid(input.interviewId), sequence: Number(row.revision_number) - 1,
      stamp: new Date(row.recorded_at as string | Date), start: new Date(row.scheduled_start as string | Date),
      end: row.scheduled_end == null ? null : new Date(row.scheduled_end as string | Date), cancelled, ...text,
    }),
  };
}
