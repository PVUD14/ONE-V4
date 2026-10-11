/**
 * Employer dashboard summary and reports (EMP-15, Appendix 2 §4.2 Dashboard and Reports).
 *
 *   GET /employers/:employerId/summary  the Dashboard's figures, computed in SQL: open jobs, new
 *                                       applicants in the last 7 days, interviews this week, offers
 *                                       awaiting an answer, drives awaiting a college's approval,
 *                                       and the pipeline's current stage counts.
 *   GET /employers/:employerId/reports  funnel and stage drop-off by job, by college and by campus
 *                                       drive; median time to shortlist, interview, offer and hire;
 *                                       offer outcomes and acceptance rate.
 *
 * Both are the `candidates` action of requireActiveEmployer (§5.1 lists reports with candidate
 * data), for owners, admins and recruiters, and read only rows of the caller's own employer.
 *
 * The summary's counts are the employer's own work queue: each equals the number of rows the same
 * employer already sees one by one in its Opportunities, Applicants, Interviews, Offers and drive
 * lists, which is how the acceptance test reconciles them. They are therefore exact rather than
 * suppressed — withholding "2 offers awaiting an answer" would hide nothing the Offers page does
 * not show, and would leave the dashboard unable to say how much work is waiting.
 *
 * The reports are different: they break applications down by dimensions the employer does not
 * otherwise see side by side (college, drive, how long each step took), so every figure about
 * people there goes through the shared suppression rule (employer-reports.ts): a group under 5,
 * zero included, is withheld, and no row is ever one application. The college is the one the
 * student put in the application snapshot they chose to share (EMP-07), never ONE's own records;
 * an erased snapshot counts as "not stated". Readiness, eligibility figures, assessment scores and
 * protected attributes are never read. Unknown query parameters are refused, so no caller can ask
 * for a filter the report does not offer.
 *
 * "This week" is the Monday-to-Sunday week in Asia/Kolkata, computed by the database's clock, and
 * returned with the response so a client lists the same window it counted.
 */
import { BadRequestException, Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';
import { collegeGroups, durationFigure, offerOutcomes, stageTable, type CollegeCellCount, type GroupedCellCount } from './employer-reports.js';

type QueryResult<T> = { rows: T[] };

const reportTimeZone = 'Asia/Kolkata';
const applicationStates = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
/** Query parameters a client may send: the organisation hint api-security reads, nothing else. */
const allowedQuery = ['organizationId'];
/** Job and drive rows per report; the newest first. A larger employer is told the list was cut. */
const reportRowLimit = 200;

/**
 * The one partition, as SQL: where each non-draft application of the employer sits. Mirrors
 * reportCellFor in employer-reports.ts. The "from" stage of a closed application is the latest
 * transition into its closing state.
 */
function reportCellSql(alias: string) {
  return sql.raw(`CASE
    WHEN ${alias}.state IN ('APPLIED','SCREENING','SHORTLISTED','ASSESSMENT','INTERVIEW','OFFER','HIRED') THEN ${alias}.state
    ELSE 'LEFT_AT_' || coalesce((
      SELECT h.from_state FROM application_state_history h
      WHERE h.application_id = ${alias}.id AND h.to_state = ${alias}.state
        AND h.from_state IN ('APPLIED','SCREENING','SHORTLISTED','ASSESSMENT','INTERVIEW','OFFER')
      ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1), 'APPLIED')
  END`);
}

@Controller('/api/v1')
export class EmployerReportsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/employers/:employerId/summary')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async summary(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    refuseUnknownQuery(request, context.correlationId);
    const rows = await this.db.execute(sql`
      WITH week AS (
        SELECT (date_trunc('week', now() AT TIME ZONE ${reportTimeZone}) AT TIME ZONE ${reportTimeZone}) AS starts_at
      ), mine AS (
        SELECT a.id, a.state, a.submitted_at FROM applications a
        WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
      )
      SELECT
        (SELECT starts_at FROM week) AS week_starts_at,
        (SELECT starts_at + interval '7 days' FROM week) AS week_ends_at,
        (SELECT count(*)::int FROM opportunities o WHERE o.employer_id = ${employerId}::uuid AND o.lifecycle_state = 'PUBLISHED') AS open_jobs,
        (SELECT count(*)::int FROM mine WHERE mine.submitted_at >= now() - interval '7 days') AS new_applicants,
        (SELECT count(*)::int FROM interviews i JOIN mine ON mine.id = i.application_id
          WHERE i.employer_id = ${employerId}::uuid AND i.state <> 'CANCELLED'
            AND i.scheduled_start >= (SELECT starts_at FROM week) AND i.scheduled_start < (SELECT starts_at + interval '7 days' FROM week)) AS interviews_this_week,
        (SELECT count(*)::int FROM offers f JOIN mine ON mine.id = f.application_id
          WHERE f.employer_id = ${employerId}::uuid AND f.state = 'EXTENDED' AND f.offer_expires_at > now()) AS offers_pending,
        (SELECT count(*)::int FROM campus_drives d WHERE d.employer_id = ${employerId}::uuid AND d.state = 'REQUESTED') AS drives_awaiting,
        (SELECT count(*)::int FROM campus_drives d WHERE d.employer_id = ${employerId}::uuid AND d.state = 'CHANGES_REQUESTED') AS drives_changes,
        (SELECT coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb) FROM (SELECT state, count(*)::int AS n FROM mine GROUP BY state) s) AS stages
    `) as QueryResult<{
      week_starts_at: Date | string; week_ends_at: Date | string; open_jobs: number; new_applicants: number; interviews_this_week: number;
      offers_pending: number; drives_awaiting: number; drives_changes: number; stages: Record<string, number> | string;
    }>;
    const row = rows.rows[0]!;
    const stageCounts = typeof row.stages === 'string' ? JSON.parse(row.stages) as Record<string, number> : row.stages;
    const currentStages = Object.fromEntries(applicationStates.map((state) => [state, Number(stageCounts[state] ?? 0)]));
    const applicationsTotal = Object.values(currentStages).reduce((sum, value) => sum + value, 0);
    return {
      summary: {
        openJobs: row.open_jobs,
        newApplicantsLast7Days: row.new_applicants,
        interviewsThisWeek: row.interviews_this_week,
        offersPending: row.offers_pending,
        drivesAwaitingApproval: row.drives_awaiting,
        drivesChangesRequested: row.drives_changes,
        applicationsTotal,
        openApplications: applicationsTotal - currentStages.HIRED! - currentStages.REJECTED! - currentStages.WITHDRAWN!,
        hires: currentStages.HIRED,
        currentStages,
        week: { startsAt: iso(row.week_starts_at), endsAt: iso(row.week_ends_at) },
        timeZone: reportTimeZone,
      },
      correlationId: context.correlationId,
    };
  }

  @Get('/employers/:employerId/reports')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reports(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    refuseUnknownQuery(request, context.correlationId);
    const cell = reportCellSql('a');

    const overall = await this.db.execute(sql`
      SELECT ${cell} AS cell, count(*)::int AS count FROM applications a
      WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT' GROUP BY 1
    `) as QueryResult<GroupedCellCount>;

    const jobList = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.lifecycle_state, v.title FROM opportunities o
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.employer_id = ${employerId}::uuid AND o.lifecycle_state <> 'DRAFT'
      ORDER BY o.created_at DESC, o.id LIMIT ${reportRowLimit + 1}
    `) as QueryResult<{ id: string; reference_code: string | null; lifecycle_state: string; title: string | null }>;
    const jobs = jobList.rows.slice(0, reportRowLimit);
    const jobCells = jobs.length ? await this.db.execute(sql`
      SELECT a.opportunity_id AS group_id, ${cell} AS cell, count(*)::int AS count FROM applications a
      WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
        AND a.opportunity_id IN (${sql.join(jobs.map((job) => sql`${job.id}::uuid`), sql`, `)})
      GROUP BY 1, 2
    `) as QueryResult<GroupedCellCount & { group_id: string }> : { rows: [] };

    const collegeCells = await this.db.execute(sql`
      WITH mine AS (
        SELECT nullif(lower(btrim(s.snapshot #>> '{education,institutionName}')), '') AS college_key,
               btrim(s.snapshot #>> '{education,institutionName}') AS college_name,
               ${cell} AS cell
        FROM applications a
        LEFT JOIN application_profile_snapshots s ON s.application_id = a.id AND s.erased_at IS NULL
        WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
      ), names AS (
        -- One display name per college: the spelling most students used.
        SELECT college_key, mode() WITHIN GROUP (ORDER BY college_name) AS college_name
        FROM mine WHERE college_key IS NOT NULL GROUP BY college_key
      )
      SELECT m.college_key, n.college_name, m.cell, count(*)::int AS count
      FROM mine m LEFT JOIN names n ON n.college_key = m.college_key
      GROUP BY 1, 2, 3
    `) as QueryResult<{ college_key: string | null; college_name: string | null; cell: string; count: number }>;

    const driveList = await this.db.execute(sql`
      SELECT d.id, d.state, d.opportunity_id, org.legal_name AS institution_name, v.title AS opportunity_title
      FROM campus_drives d
      JOIN organizations org ON org.id = d.institution_id
      JOIN opportunities o ON o.id = d.opportunity_id AND o.employer_id = d.employer_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE d.employer_id = ${employerId}::uuid
      ORDER BY d.created_at DESC, d.id LIMIT ${reportRowLimit + 1}
    `) as QueryResult<{ id: string; state: string; opportunity_id: string; institution_name: string; opportunity_title: string | null }>;
    const drives = driveList.rows.slice(0, reportRowLimit);
    const driveCells = drives.length ? await this.db.execute(sql`
      SELECT l.campus_drive_id AS group_id, ${cell} AS cell, count(*)::int AS count
      FROM campus_drive_applications l JOIN applications a ON a.id = l.application_id AND a.opportunity_id = l.opportunity_id
      WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
        AND l.campus_drive_id IN (${sql.join(drives.map((drive) => sql`${drive.id}::uuid`), sql`, `)})
      GROUP BY 1, 2
    `) as QueryResult<GroupedCellCount & { group_id: string }> : { rows: [] };

    const timing = await this.db.execute(sql`
      WITH mine AS (
        SELECT a.id, a.submitted_at,
          (SELECT min(h.occurred_at) FROM application_state_history h WHERE h.application_id = a.id AND h.to_state = 'SHORTLISTED') AS shortlisted_at,
          (SELECT min(h.occurred_at) FROM application_state_history h WHERE h.application_id = a.id AND h.to_state = 'INTERVIEW') AS interviewed_at,
          (SELECT min(f.extended_at) FROM offers f WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state <> 'DRAFT') AS offered_at,
          (SELECT min(h.occurred_at) FROM application_state_history h WHERE h.application_id = a.id AND h.to_state = 'HIRED') AS hired_at
        FROM applications a WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT' AND a.submitted_at IS NOT NULL
      ), days AS (
        SELECT
          CASE WHEN shortlisted_at >= submitted_at THEN extract(epoch FROM shortlisted_at - submitted_at) / 86400.0 END AS shortlist,
          CASE WHEN interviewed_at >= submitted_at THEN extract(epoch FROM interviewed_at - submitted_at) / 86400.0 END AS interview,
          CASE WHEN offered_at >= submitted_at THEN extract(epoch FROM offered_at - submitted_at) / 86400.0 END AS offer,
          CASE WHEN hired_at >= submitted_at THEN extract(epoch FROM hired_at - submitted_at) / 86400.0 END AS hire
        FROM mine
      )
      SELECT count(shortlist)::int AS shortlist_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY shortlist) AS shortlist_median,
             count(interview)::int AS interview_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY interview) AS interview_median,
             count(offer)::int AS offer_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY offer) AS offer_median,
             count(hire)::int AS hire_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY hire) AS hire_median
      FROM days
    `) as QueryResult<Record<string, number | string | null>>;
    const t = timing.rows[0] ?? {};

    const offerRows = await this.db.execute(sql`
      SELECT latest.state AS cell, count(*)::int AS count FROM applications a
      JOIN LATERAL (
        SELECT f.state FROM offers f WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state <> 'DRAFT'
        ORDER BY f.created_at DESC, f.id DESC LIMIT 1
      ) latest ON true
      WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT' GROUP BY 1
    `) as QueryResult<GroupedCellCount>;

    // The read is audited against the employer, like every other view of hiring data.
    await this.db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, 'employer.reports.viewed', 'organization',
              ${employerId}::uuid, ${employerId}::uuid, 'SUCCESS', ${context.correlationId},
              ${JSON.stringify({ jobs: jobs.length, drives: drives.length })}::jsonb)
    `);

    const cellsFor = (rows: readonly (GroupedCellCount & { group_id: string })[], id: string) => rows.filter((row) => row.group_id === id);
    return {
      reports: {
        threshold: 5,
        overall: stageTable(overall.rows),
        byJob: jobs.map((job) => ({
          opportunityId: job.id, referenceCode: job.reference_code ?? null, title: job.title ?? null, lifecycleState: job.lifecycle_state,
          table: stageTable(cellsFor(jobCells.rows, job.id)),
        })),
        byJobTruncated: jobList.rows.length > reportRowLimit,
        byCollege: collegeGroups(collegeCells.rows.map((row): CollegeCellCount => ({
          collegeKey: row.college_key || null, collegeName: row.college_key ? row.college_name : null, cell: row.cell, count: row.count,
        }))),
        byDrive: drives.map((drive) => ({
          driveId: drive.id, opportunityId: drive.opportunity_id, opportunityTitle: drive.opportunity_title ?? null,
          institutionName: drive.institution_name, state: drive.state,
          table: stageTable(cellsFor(driveCells.rows, drive.id)),
        })),
        byDriveTruncated: driveList.rows.length > reportRowLimit,
        timeToStage: [
          durationFigure('SHORTLIST', t.shortlist_n ?? 0, t.shortlist_median ?? null),
          durationFigure('INTERVIEW', t.interview_n ?? 0, t.interview_median ?? null),
          durationFigure('OFFER', t.offer_n ?? 0, t.offer_median ?? null),
          durationFigure('HIRE', t.hire_n ?? 0, t.hire_median ?? null),
        ],
        offers: offerOutcomes(offerRows.rows),
      },
      correlationId: context.correlationId,
    };
  }
}

function refuseUnknownQuery(request: ProtectedHttpRequest, correlationId: string): void {
  const keys = Object.keys(request.query ?? {});
  if (keys.some((key) => !allowedQuery.includes(key))) {
    throw new BadRequestException({ error: { code: 'UNKNOWN_FIELD', message: 'Request could not be completed', correlationId } });
  }
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
