/**
 * Interview scheduling essentials (EMP-09), shared by the employer hiring routes: the schedule
 * revision every change writes, the organisation lock every candidate write takes, who may see a
 * joining link, and scorecards recorded against the interview's stage template.
 *
 * Kept out of employer-hiring.controller.ts so the rules sit in one place the recruiter and
 * participant routes both call. Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  InterviewInputError,
  assertRatingsFollowTemplate,
  parseCriterionRatings,
  type CriterionRatingInput,
} from '@planthepath/hiring/src/interview-scheduling.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant } from '@planthepath/persistence/src/employer-authentication.js';
import { safeError } from './api-security.js';
import { employerStateRefusal, type EmployerAction, type EmployerVerificationState } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

export const scheduleInterviewFields = [
  'mode', 'scheduledStart', 'scheduledEnd', 'locationDetail', 'joiningLink', 'preparationNote',
  'participantUserIds', 'participantVisibilityAcknowledged', 'selectionStageId',
] as const;
export const interviewStateFields = ['toState', 'reasonCode', 'note', 'reason', 'scheduledStart', 'scheduledEnd', 'mode', 'locationDetail', 'joiningLink'] as const;

function hiringBadRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}

/** Unknown fields are refused, never ignored (Appendix 2 §6.1). */
export function rejectUnknownFields(body: unknown, allowed: readonly string[], correlationId: string): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw hiringBadRequest('UNKNOWN_FIELD', correlationId);
}

/**
 * The §5.1 state rule inside the write transaction, holding the organisation row FOR SHARE: a
 * suspension waits for this write, or this write waits for it and is refused (EMP-SR-15).
 */
export async function lockEmployerForWrite(tx: Executor, employerId: string, action: EmployerAction, correlationId: string): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT verification_state, active FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER' FOR SHARE
  `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
  const [row] = rows.rows;
  if (!row) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  const refusal = employerStateRefusal({ verificationState: row.verification_state, active: row.active }, action);
  if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });
}

export type ScheduleChangeKind = 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

/**
 * Append the interview as it now stands to its history, numbered after the last revision. Runs in
 * the transaction that changed the interview, after the change, so the row copies what was written.
 */
export async function writeScheduleRevision(tx: Executor, input: {
  readonly id: string; readonly interviewId: string; readonly employerId: string; readonly changeKind: ScheduleChangeKind;
  readonly reasonCode: string | null; readonly note: string | null; readonly actorId: string;
}): Promise<{ readonly id: string; readonly revisionNumber: number }> {
  const rows = await tx.execute(sql`
    INSERT INTO interview_schedule_revisions (id, interview_id, employer_id, revision_number, change_kind, mode, scheduled_start, scheduled_end,
                                              location_detail, joining_link, reason_code, note, actor_user_id)
    SELECT ${input.id}::uuid, i.id, i.employer_id,
           coalesce((SELECT max(r.revision_number) FROM interview_schedule_revisions r WHERE r.interview_id = i.id), 0) + 1,
           ${input.changeKind}, i.mode, i.scheduled_start, i.scheduled_end, i.location_detail, i.joining_link,
           ${input.reasonCode}, ${input.note}, ${input.actorId}::uuid
    FROM interviews i WHERE i.id = ${input.interviewId}::uuid AND i.employer_id = ${input.employerId}::uuid
    RETURNING revision_number
  `) as QueryResult<{ revision_number: number }>;
  const [row] = rows.rows;
  if (!row) throw new Error('interview vanished inside its own write');
  return { id: input.id, revisionNumber: Number(row.revision_number) };
}

/**
 * Who may see an interview's joining link (EMP-09): the member who scheduled it and its active
 * panellists, and only while the candidate's grant is live. The student sees their own through the
 * student routes. `interviewAlias` and `applicationAlias` name the query's interviews and
 * applications rows.
 */
export function joiningLinkVisibleSql(actorId: string, interviewAlias = 'i', applicationAlias = 'a'): SQL {
  const interview = sql.raw(interviewAlias);
  return sql`((${interview}.created_by_user_id = ${actorId}::uuid
      OR EXISTS (SELECT 1 FROM interview_participants link_viewer
        WHERE link_viewer.interview_id = ${interview}.id AND link_viewer.participant_user_id = ${actorId}::uuid AND link_viewer.removed_at IS NULL))
    AND ${applicationHasLiveApplicantGrant(applicationAlias)})`;
}

export interface ScorecardTemplateView {
  readonly id: string;
  readonly name: string;
  readonly guidance: string | null;
  readonly retiredAt: string | null;
  readonly createdAt: string | null;
  readonly criteria: readonly { readonly id: string; readonly position: number; readonly label: string; readonly guidance: string | null }[];
}

/** Templates with their criteria in order. */
export async function readScorecardTemplates(db: Executor, where: SQL): Promise<ScorecardTemplateView[]> {
  const rows = await db.execute(sql`
    SELECT t.id, t.name, t.guidance, t.retired_at, t.created_at,
           coalesce((SELECT json_agg(json_build_object('id', c.id, 'position', c.position, 'label', c.label, 'guidance', c.guidance) ORDER BY c.position)
                     FROM interview_scorecard_criteria c WHERE c.template_id = t.id), '[]'::json) AS criteria
    FROM interview_scorecard_templates t
    WHERE ${where}
    ORDER BY t.retired_at IS NOT NULL, lower(t.name), t.id
    LIMIT 200
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.map((row) => ({
    id: String(row.id), name: String(row.name), guidance: row.guidance == null ? null : String(row.guidance),
    retiredAt: isoOrNull(row.retired_at), createdAt: isoOrNull(row.created_at),
    criteria: (Array.isArray(row.criteria) ? row.criteria as Record<string, unknown>[] : []).map((criterion) => ({
      id: String(criterion.id), position: Number(criterion.position), label: String(criterion.label),
      guidance: criterion.guidance == null ? null : String(criterion.guidance),
    })),
  }));
}

export function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parse the ratings on a scorecard body, as a 400 on bad input. */
export function readCriterionRatings(body: unknown, correlationId: string): CriterionRatingInput[] | undefined {
  try {
    return parseCriterionRatings(typeof body === 'object' && body !== null ? (body as Record<string, unknown>).criteria : undefined);
  } catch (error) {
    if (error instanceof InterviewInputError) throw hiringBadRequest(error.code, correlationId);
    throw error;
  }
}

/**
 * Record one person's scorecard for an interview, against the interview's template if it has one:
 * every criterion rated exactly once, or no criteria at all when it has none. A second submission
 * corrects the first, replacing its ratings in the same transaction. `guard` is the condition the
 * interview row must still meet at write time (the participant route passes its assignment check).
 * Nothing here sums or ranks the ratings.
 */
export async function recordScorecard(tx: Executor, input: {
  readonly outcomeId: string; readonly interviewId: string; readonly employerId: string; readonly actorId: string;
  readonly recommendation: string; readonly rating: number | null; readonly strengths: string | null; readonly concerns: string | null; readonly notes: string | null;
  readonly criteria: readonly CriterionRatingInput[] | undefined; readonly guard: SQL; readonly correlationId: string;
}): Promise<boolean> {
  const template = await tx.execute(sql`
    SELECT i.scorecard_template_id,
           coalesce((SELECT array_agg(c.id::text ORDER BY c.position) FROM interview_scorecard_criteria c WHERE c.template_id = i.scorecard_template_id), '{}') AS criterion_ids
    FROM interviews i WHERE i.id = ${input.interviewId}::uuid AND i.employer_id = ${input.employerId}::uuid
  `) as QueryResult<{ scorecard_template_id: string | null; criterion_ids: string[] }>;
  const [row] = template.rows;
  if (!row) return false;
  const templateId = row.scorecard_template_id;
  if (templateId) {
    if (!input.criteria) throw hiringBadRequest('SCORECARD_CRITERIA_REQUIRED', input.correlationId);
    try {
      assertRatingsFollowTemplate(input.criteria, row.criterion_ids);
    } catch (error) {
      if (error instanceof InterviewInputError) throw hiringBadRequest(error.code, input.correlationId);
      throw error;
    }
  } else if (input.criteria) {
    throw hiringBadRequest('SCORECARD_TEMPLATE_NOT_SET', input.correlationId);
  }
  const saved = await tx.execute(sql`
    INSERT INTO interview_outcomes (id, interview_id, submitted_by_user_id, recommendation, overall_rating, strengths, concerns, notes, scorecard_template_id)
    SELECT ${input.outcomeId}::uuid, i.id, ${input.actorId}::uuid, ${input.recommendation}, ${input.rating}, ${input.strengths}, ${input.concerns}, ${input.notes}, i.scorecard_template_id
    FROM interviews i WHERE i.id = ${input.interviewId}::uuid AND i.employer_id = ${input.employerId}::uuid AND ${input.guard}
    ON CONFLICT (interview_id, submitted_by_user_id) DO UPDATE SET
      recommendation = EXCLUDED.recommendation, overall_rating = EXCLUDED.overall_rating,
      strengths = EXCLUDED.strengths, concerns = EXCLUDED.concerns, notes = EXCLUDED.notes,
      scorecard_template_id = EXCLUDED.scorecard_template_id, submitted_at = now()
    RETURNING id
  `) as QueryResult<{ id: string }>;
  const outcome = saved.rows[0];
  if (!outcome) return false;
  await tx.execute(sql`DELETE FROM interview_outcome_criterion_ratings WHERE outcome_id = ${outcome.id}::uuid`);
  if (templateId && input.criteria?.length) {
    await tx.execute(sql`
      INSERT INTO interview_outcome_criterion_ratings (outcome_id, criterion_id, template_id, rating, note)
      VALUES ${sql.join(input.criteria.map((criterion) => sql`(${outcome.id}::uuid, ${criterion.criterionId}::uuid, ${templateId}::uuid, ${criterion.rating}, ${criterion.note})`), sql`, `)}
    `);
  }
  return true;
}

/** The slice of the HTTP response a calendar download writes. */
export interface CalendarResponse {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/** An .ics as an attachment, never cached: it can carry a joining link. */
export function sendCalendar(response: CalendarResponse, file: { readonly filename: string; readonly contentType: string; readonly content: string }): void {
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.send(file.content);
}
