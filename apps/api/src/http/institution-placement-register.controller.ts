/**
 * Placement register, statistics and drive categories (INST-12).
 *
 * The placement office reports placements to management each season. This controller gives it:
 *
 * - statistics by department and batch — eligible, applied, shortlisted, with an offer, placed,
 *   placement percentage and offers per placed student — as of the end of the last ended month,
 *   from applications students chose to share with the college (ADR-019), through the one
 *   suppression helper (a two-way table with its margins, `suppressGroupedPartition`);
 * - the register — employers engaged (approved drives, jobs addressed to the college) and the drive
 *   calendar with outcomes for completed drives, counted over shared applications only;
 * - the college's own drive categories (Dream, Core, Mass…), set in Settings and attached to drives.
 *
 * Readers: owner, admin, placement admin, department head, each within their INST-02 scope; faculty
 * have no placement role. Writers (categories): EMP-11's deciders — owner, admin or placement admin
 * with an institution-wide write scope. There is no unit filter on the statistics: a filtered
 * aggregate beside an unfiltered one can be differenced. No query selects an offer's terms
 * (ADR-024); readiness is not read (ADR-020). Categories are never shown to employers or students.
 * Design: docs/architecture/placement-register-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  canAddressInstitutionAudience,
  placementStatistics,
  publishedSubtotal,
  suppressAggregateTable,
  suppressedMonthlyCounts,
  type InstitutionStudentScope,
  type PlacementStatisticsRow,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { describeInstitutionStudentScope, institutionStaffScopeMemberships, institutionStudentScopeFor, institutionStudentWriteScopeFor } from './institution-student-scope.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type Rows<T> = { rows: T[] };
type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Who may read the register and statistics. Faculty have no placement role. */
export const placementRegisterReaderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'] as const;
/** Who may manage categories — and only with an institution-wide write scope (EMP-11's deciders). */
const categoryManagerRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN'] as const;
export const driveCategoryRetireReasonCodes = ['NO_LONGER_USED', 'RENAMED', 'SET_IN_ERROR'] as const;
/** Keeps Settings a short list rather than a taxonomy. */
const maximumActiveCategories = 20;
/** Application stages at or past the shortlist. */
const shortlistStages = ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'];
/** Drives the college approved: the ones that engage an employer and belong on the calendar. */
const engagedDriveStates = ['APPROVED', 'SCHEDULED', 'COMPLETED'];
const trendMonths = 6;

export interface DriveCategoryRef {
  readonly id: string;
  readonly name: string;
  readonly retired: boolean;
}

/** The current category of each drive, for the college side only. */
export async function loadDriveCategories(db: Executor, institutionId: string, driveIds: readonly string[]): Promise<Map<string, DriveCategoryRef>> {
  if (driveIds.length === 0) return new Map();
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (x.campus_drive_id) x.campus_drive_id, c.id, c.name, c.state
    FROM campus_drive_category_assignments x
    LEFT JOIN institution_drive_categories c ON c.id = x.category_id AND c.institution_id = x.institution_id
    WHERE x.institution_id = ${institutionId}::uuid AND x.campus_drive_id = ANY(${`{${driveIds.join(',')}}`}::uuid[])
    ORDER BY x.campus_drive_id, x.created_at DESC, x.id DESC
  `) as Rows<{ campus_drive_id: string; id: string | null; name: string | null; state: string | null }>;
  const map = new Map<string, DriveCategoryRef>();
  for (const row of rows.rows) if (row.id && row.name) map.set(row.campus_drive_id, { id: row.id, name: row.name, retired: row.state !== 'ACTIVE' });
  return map;
}

/**
 * True when a relationship with the college authorised activity at `at` — the relationship
 * policy's historical rule (current, or graduated / transferred before `effective_to`).
 */
function authorisedAt(institutionId: string, student: SQL, at: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM institution_relationships ar
    WHERE ar.institution_id = ${institutionId}::uuid AND ar.student_user_id = ${student}
      AND (ar.state IN ('VERIFIED', 'ACTIVE') OR (ar.state IN ('TRANSFERRED', 'GRADUATED') AND ar.effective_to IS NOT NULL))
      AND ar.effective_from <= ${at} AND (ar.effective_to IS NULL OR ar.effective_to > ${at}))`;
}

/**
 * Eligible students: on the roster in the reader's scope, account active, with a relationship that
 * began before `periodEnd` and is current now or ended in graduation (a season is reported after the
 * batch leaves). Transferred, ended and revoked students are not counted.
 */
function populationCte(institutionId: string, scope: InstitutionStudentScope, periodEnd: SQL): SQL {
  return sql`population AS (
    SELECT sp.student_user_id, sp.department_unit_id, sp.batch_unit_id
    FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
    WHERE sp.institution_id = ${institutionId}::uuid AND u.state = 'ACTIVE'
      AND ${institutionStudentScopeSql(scope, 'sp')}
      AND EXISTS (SELECT 1 FROM institution_relationships r
        WHERE r.institution_id = sp.institution_id AND r.student_user_id = sp.student_user_id AND r.effective_from < ${periodEnd}
          AND ((r.state IN ('ACTIVE', 'VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
            OR (r.state = 'GRADUATED' AND r.effective_to IS NOT NULL)))
  )`;
}

/** Applications shared with the college now (consent honoured as of the request), submitted before `periodEnd` inside the relationship. */
function sharedBefore(institutionId: string, periodEnd: SQL): SQL {
  return sql`a.state <> 'DRAFT'
    AND a.institution_visibility_granted_at IS NOT NULL AND a.institution_visibility_revoked_at IS NULL
    AND a.submitted_at < ${periodEnd} AND ${authorisedAt(institutionId, sql`a.student_user_id`, sql`a.submitted_at`)}`;
}

function countView(count: SuppressedCount): SuppressedCount {
  return count.suppressed ? { suppressed: true, value: null } : { suppressed: false, value: count.value };
}

function rowView(row: PlacementStatisticsRow): Record<string, unknown> {
  return {
    eligible: countView(row.eligible),
    notShared: countView(row.notShared),
    applied: countView(row.applied),
    shortlisted: countView(row.shortlisted),
    withOffer: countView(row.withOffer),
    placed: countView(row.placed),
    placementPercentage: row.placementPercentage,
    offersPerPlacedStudent: row.offersPerPlacedStudent,
  };
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionPlacementRegisterController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /**
   * Statistics by department and batch, as of the end of the last ended month, for the reader's
   * whole scope. Every count is suppressed (cells, row totals, column totals, grand total), and the
   * offers trend gives one suppressed count per ended month.
   */
  @Get('/institutions/:institutionId/placement-statistics')
  async statistics(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const scope = await institutionStudentScopeFor(this.db, request, id, placementRegisterReaderRoles);
    const period = await this.period();
    const periodEnd = sql`${period.periodEnd}::timestamptz`;
    const facts = await this.db.execute(sql`
      WITH ${populationCte(id, scope, periodEnd)}
      SELECT p.student_user_id, p.department_unit_id, p.batch_unit_id, a.id AS application_id,
        (EXISTS (SELECT 1 FROM application_state_history h
            WHERE h.application_id = a.id AND h.to_state = ANY(${`{${shortlistStages.join(',')}}`}::text[])
              AND h.occurred_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`h.occurred_at`)})
          OR (a.state = ANY(${`{${shortlistStages.join(',')}}`}::text[]) AND a.updated_at < ${periodEnd}
              AND ${authorisedAt(id, sql`a.student_user_id`, sql`a.updated_at`)})) AS reached_shortlist,
        (SELECT count(*) FROM offers f
          WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state <> 'DRAFT'
            AND f.extended_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.extended_at`)})::int AS offers,
        (EXISTS (SELECT 1 FROM offers f
            WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state = 'ACCEPTED'
              AND f.responded_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.responded_at`)})
          OR (a.state = 'HIRED' AND a.closed_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`a.closed_at`)})) AS placed
      FROM population p
      LEFT JOIN applications a ON a.student_user_id = p.student_user_id AND ${sharedBefore(id, periodEnd)}
    `) as Rows<{ student_user_id: string; department_unit_id: string | null; batch_unit_id: string | null; application_id: string | null; reached_shortlist: boolean | null; offers: number | null; placed: boolean | null }>;

    const groupKey = (row: { department_unit_id: string | null; batch_unit_id: string | null }) => `${row.department_unit_id ?? ''}|${row.batch_unit_id ?? ''}`;
    const students = new Map<string, { group: string; applications: { reachedShortlist: boolean; offerExtended: boolean; placed: boolean; offers: number }[] }>();
    for (const row of facts.rows) {
      const entry = students.get(row.student_user_id) ?? { group: groupKey(row), applications: [] };
      if (row.application_id) {
        const offers = Number(row.offers ?? 0);
        entry.applications.push({ reachedShortlist: row.reached_shortlist === true, offerExtended: offers > 0, placed: row.placed === true, offers });
      }
      students.set(row.student_user_id, entry);
    }
    const groupKeys = [...new Set([...students.values()].map((student) => student.group))];
    const unitIds = [...new Set(groupKeys.flatMap((key) => key.split('|')).filter(Boolean))];
    const units = unitIds.length ? await this.db.execute(sql`
      SELECT id, name FROM institution_units WHERE institution_id = ${id}::uuid AND id = ANY(${`{${unitIds.join(',')}}`}::uuid[])
    `) as Rows<{ id: string; name: string }> : { rows: [] };
    const unitName = new Map(units.rows.map((unit) => [unit.id, unit.name]));
    const described = groupKeys.map((key) => {
      const [department, batch] = key.split('|');
      return {
        key,
        department: department ? { id: department, name: unitName.get(department) ?? 'NA' } : null,
        batch: batch ? { id: batch, name: unitName.get(batch) ?? 'NA' } : null,
      };
    }).sort((a, b) => (a.department?.name ?? '￿').localeCompare(b.department?.name ?? '￿')
      || (a.batch?.name ?? '￿').localeCompare(b.batch?.name ?? '￿') || a.key.localeCompare(b.key));
    const result = placementStatistics(described.map((group) => group.key), [...students.values()]);
    const rowFor = new Map(result.groups.map((group) => [group.key, group.row]));

    const trend = await this.db.execute(sql`
      WITH ${populationCte(id, scope, periodEnd)},
      months AS (
        SELECT generate_series(${periodEnd} - make_interval(months => ${trendMonths}), ${periodEnd} - interval '1 month', interval '1 month') AS month_start
      )
      SELECT to_char(m.month_start AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
        (SELECT count(*) FROM offers f
          JOIN applications a ON a.id = f.application_id AND a.employer_id = f.employer_id
          JOIN population p ON p.student_user_id = a.student_user_id
          WHERE ${sharedBefore(id, periodEnd)} AND f.state <> 'DRAFT'
            AND f.extended_at >= m.month_start AND f.extended_at < m.month_start + interval '1 month'
            AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.extended_at`)})::int AS offers
      FROM months m ORDER BY m.month_start
    `) as Rows<{ month: string; offers: number }>;

    return {
      asOf: { month: period.month, lastDay: period.lastDay },
      scope: await describeInstitutionStudentScope(this.db, request, id, placementRegisterReaderRoles, scope),
      overall: rowView(result.overall),
      groups: described.map((group) => ({ department: group.department, batch: group.batch, ...rowView(rowFor.get(group.key)!) })),
      offersByMonth: suppressedMonthlyCounts(trend.rows.map((row) => ({ month: row.month, count: Number(row.offers) })))
        .map((entry) => ({ month: entry.month, offers: countView(entry.count) })),
      correlationId: context.correlationId,
    };
  }

  /**
   * The register: employers engaged and the drive calendar with outcomes. Outcomes appear only once a
   * drive is complete (EMP-11's rule) and count only applications through the drive that students
   * shared with the college, of eligible students in the reader's scope.
   */
  @Get('/institutions/:institutionId/placement-register')
  async register(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const scope = await institutionStudentScopeFor(this.db, request, id, placementRegisterReaderRoles);
    const engaged = `{${engagedDriveStates.join(',')}}`;
    const [driveEngagement, jobEngagement] = await Promise.all([
      this.db.execute(sql`
        SELECT cd.employer_id, emp.legal_name, cd.state, count(*)::int AS drives, max(coalesce(cd.closed_at, cd.decided_at, cd.updated_at)) AS last_at
        FROM campus_drives cd JOIN organizations emp ON emp.id = cd.employer_id AND emp.kind = 'EMPLOYER'
        WHERE cd.institution_id = ${id}::uuid AND cd.state = ANY(${engaged}::text[])
        GROUP BY cd.employer_id, emp.legal_name, cd.state
      `) as Promise<Rows<{ employer_id: string; legal_name: string; state: string; drives: number; last_at: Date | string | null }>>,
      this.db.execute(sql`
        SELECT o.employer_id, emp.legal_name, count(DISTINCT o.id)::int AS jobs, max(o.published_at) AS last_at
        FROM opportunity_audiences aud
        JOIN opportunities o ON o.id = aud.opportunity_id
        JOIN organizations emp ON emp.id = o.employer_id AND emp.kind = 'EMPLOYER'
        WHERE aud.institution_id = ${id}::uuid AND aud.audience_kind IN ('INSTITUTION', 'INSTITUTION_UNIT') AND o.published_at IS NOT NULL
        GROUP BY o.employer_id, emp.legal_name
      `) as Promise<Rows<{ employer_id: string; legal_name: string; jobs: number; last_at: Date | string | null }>>,
    ]);
    const employers = new Map<string, { name: string; drives: Record<string, number>; jobsAddressedToCollege: number; lastEngagedAt: number }>();
    const employerEntry = (employerId: string, name: string) => {
      const entry = employers.get(employerId) ?? { name, drives: { APPROVED: 0, SCHEDULED: 0, COMPLETED: 0 }, jobsAddressedToCollege: 0, lastEngagedAt: 0 };
      employers.set(employerId, entry);
      return entry;
    };
    for (const row of driveEngagement.rows) {
      const entry = employerEntry(row.employer_id, row.legal_name);
      entry.drives[row.state] = Number(row.drives);
      if (row.last_at) entry.lastEngagedAt = Math.max(entry.lastEngagedAt, new Date(row.last_at).getTime());
    }
    for (const row of jobEngagement.rows) {
      const entry = employerEntry(row.employer_id, row.legal_name);
      entry.jobsAddressedToCollege = Number(row.jobs);
      if (row.last_at) entry.lastEngagedAt = Math.max(entry.lastEngagedAt, new Date(row.last_at).getTime());
    }

    const drives = await this.db.execute(sql`
      SELECT cd.id, cd.state, cd.scheduled_start_at, cd.scheduled_end_at, cd.proposed_start_at, cd.venue_mode, cd.closed_at, cd.decided_at,
             emp.legal_name AS employer_name, v.title AS opportunity_title
      FROM campus_drives cd
      JOIN organizations emp ON emp.id = cd.employer_id
      JOIN opportunities o ON o.id = cd.opportunity_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE cd.institution_id = ${id}::uuid AND cd.state = ANY(${engaged}::text[])
      ORDER BY coalesce(cd.scheduled_start_at, cd.proposed_start_at, cd.decided_at, cd.created_at) DESC, cd.id DESC
      LIMIT 200
    `) as Rows<{ id: string; state: string; scheduled_start_at: Date | string | null; scheduled_end_at: Date | string | null; proposed_start_at: Date | string | null;
      venue_mode: string | null; closed_at: Date | string | null; decided_at: Date | string | null; employer_name: string; opportunity_title: string | null }>;
    const completedIds = drives.rows.filter((row) => row.state === 'COMPLETED').map((row) => row.id);
    const outcomes = completedIds.length ? await this.db.execute(sql`
      WITH ${populationCte(id, scope, sql`now()`)},
      shared AS (
        SELECT l.campus_drive_id, a.student_user_id,
          EXISTS (SELECT 1 FROM offers f WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state <> 'DRAFT'
            AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.extended_at`)}) AS offered,
          (EXISTS (SELECT 1 FROM offers f WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state = 'ACCEPTED'
              AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.responded_at`)})
            OR (a.state = 'HIRED' AND ${authorisedAt(id, sql`a.student_user_id`, sql`a.closed_at`)})) AS placed
        FROM campus_drive_applications l
        JOIN applications a ON a.id = l.application_id
        JOIN population p ON p.student_user_id = a.student_user_id
        WHERE l.campus_drive_id = ANY(${`{${completedIds.join(',')}}`}::uuid[]) AND ${sharedBefore(id, sql`now()`)}
      )
      SELECT campus_drive_id, student_user_id, bool_or(offered) AS offered, bool_or(placed) AS placed
      FROM shared GROUP BY campus_drive_id, student_user_id
    `) as Rows<{ campus_drive_id: string; student_user_id: string; offered: boolean; placed: boolean }> : { rows: [] };
    const categories = await loadDriveCategories(this.db, id, drives.rows.map((row) => row.id));

    return {
      employers: [...employers.values()].sort((a, b) => b.lastEngagedAt - a.lastEngagedAt || a.name.localeCompare(b.name)).map((entry) => ({
        name: entry.name,
        drives: { approved: entry.drives.APPROVED ?? 0, scheduled: entry.drives.SCHEDULED ?? 0, completed: entry.drives.COMPLETED ?? 0 },
        jobsAddressedToCollege: entry.jobsAddressedToCollege,
        lastEngagedAt: entry.lastEngagedAt ? new Date(entry.lastEngagedAt).toISOString() : null,
      })),
      drives: drives.rows.map((row) => {
        let outcome: Record<string, unknown> | null = null;
        if (row.state === 'COMPLETED') {
          const people = outcomes.rows.filter((entry) => entry.campus_drive_id === row.id);
          const table = suppressAggregateTable([
            { key: 'APPLIED_ONLY', count: people.filter((entry) => !entry.offered && !entry.placed).length },
            { key: 'OFFERED_NOT_PLACED', count: people.filter((entry) => entry.offered && !entry.placed).length },
            { key: 'PLACED', count: people.filter((entry) => entry.placed).length },
          ]);
          outcome = {
            studentsSharing: countView(table.suppressed ? { suppressed: true, value: null } : table.total),
            withOffer: countView(publishedSubtotal(table, ['OFFERED_NOT_PLACED', 'PLACED'])),
            placed: countView(publishedSubtotal(table, ['PLACED'])),
          };
        }
        const category = categories.get(row.id) ?? null;
        return {
          id: row.id,
          employerName: row.employer_name,
          opportunityTitle: row.opportunity_title ?? null,
          state: row.state,
          scheduledStartAt: iso(row.scheduled_start_at),
          scheduledEndAt: iso(row.scheduled_end_at),
          proposedStartAt: iso(row.proposed_start_at),
          venueMode: row.venue_mode ?? null,
          closedAt: iso(row.closed_at),
          category,
          outcome,
        };
      }),
      correlationId: context.correlationId,
    };
  }

  @Get('/institutions/:institutionId/drive-categories')
  async categories(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, id } = this.reader(request, institutionId);
    const rows = await this.db.execute(sql`
      SELECT id, name, description, rank, state, created_at, retired_at, retire_reason_code FROM institution_drive_categories
      WHERE institution_id = ${id}::uuid
      ORDER BY (state = 'ACTIVE') DESC, rank, lower(name), id
      LIMIT 200
    `) as Rows<{ id: string; name: string; description: string | null; rank: number; state: string; created_at: Date | string; retired_at: Date | string | null; retire_reason_code: string | null }>;
    return {
      categories: rows.rows.map((row) => ({
        id: row.id, name: row.name, description: row.description ?? null, rank: Number(row.rank), state: row.state,
        createdAt: iso(row.created_at), retiredAt: iso(row.retired_at), retireReasonCode: row.retire_reason_code ?? null,
      })),
      canManage: await this.canManage(request, id),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/drive-categories')
  async createCategory(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.manager(request, institutionId);
    const record = bodyRecord(body, ['name', 'description', 'rank'], context.correlationId);
    const name = readText(record, 'name', 40, context.correlationId);
    if (!name) throw invalid('INVALID_FIELD', context.correlationId, 'name');
    const description = readText(record, 'description', 200, context.correlationId);
    const rank = record.rank === undefined || record.rank === null ? 10 : record.rank;
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 20) throw invalid('INVALID_FIELD', context.correlationId, 'rank');
    const categoryId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      // Serialise category writes per college so the active-count limit holds.
      await tx.execute(sql`SELECT id FROM organizations WHERE id = ${id}::uuid FOR UPDATE`);
      const active = await tx.execute(sql`
        SELECT count(*)::int AS active, bool_or(lower(name) = lower(${name})) AS taken
        FROM institution_drive_categories WHERE institution_id = ${id}::uuid AND state = 'ACTIVE'
      `) as Rows<{ active: number; taken: boolean | null }>;
      if (active.rows[0]?.taken) throw new ConflictException(error('DRIVE_CATEGORY_EXISTS', context.correlationId));
      if (Number(active.rows[0]?.active ?? 0) >= maximumActiveCategories) throw new ConflictException(error('DRIVE_CATEGORY_LIMIT', context.correlationId));
      await tx.execute(sql`
        INSERT INTO institution_drive_categories (id, institution_id, name, description, rank, created_by_user_id)
        VALUES (${categoryId}::uuid, ${id}::uuid, ${name}, ${description}, ${rank}, ${context.authorization.principal.userId}::uuid)
      `);
      await this.audit(tx, context, id, 'institution.drive_category.created', 'institution_drive_category', categoryId, { rank, nameLength: name.length });
    });
    return { category: { id: categoryId, name, description, rank, state: 'ACTIVE' }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/drive-categories/:categoryId/retire')
  async retireCategory(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('categoryId') categoryId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.manager(request, institutionId);
    const category = requireUuid(categoryId, context.correlationId);
    const record = bodyRecord(body, ['reasonCode'], context.correlationId);
    const reasonCode = record.reasonCode;
    if (typeof reasonCode !== 'string' || !(driveCategoryRetireReasonCodes as readonly string[]).includes(reasonCode)) throw invalid('INVALID_REASON_CODE', context.correlationId, 'reasonCode');
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT state FROM institution_drive_categories WHERE id = ${category}::uuid AND institution_id = ${id}::uuid FOR UPDATE
      `) as Rows<{ state: string }>;
      if (!found.rows[0]) throw forbidden(context.correlationId);
      if (found.rows[0].state !== 'ACTIVE') throw invalid('DRIVE_CATEGORY_NOT_ACTIVE', context.correlationId);
      await tx.execute(sql`
        UPDATE institution_drive_categories SET state = 'RETIRED', retired_at = now(),
          retired_by_user_id = ${context.authorization.principal.userId}::uuid, retire_reason_code = ${reasonCode}
        WHERE id = ${category}::uuid
      `);
      await this.audit(tx, context, id, 'institution.drive_category.retired', 'institution_drive_category', category, { reasonCode });
    });
    return { category: { id: category, state: 'RETIRED' }, correlationId: context.correlationId };
  }

  /** Label a drive with one of the college's active categories, or clear it (`categoryId: null`). */
  @Post('/institutions/:institutionId/campus-drives/:driveId/category')
  async setDriveCategory(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('driveId') driveId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id } = await this.manager(request, institutionId);
    const drive = requireUuid(driveId, context.correlationId);
    const record = bodyRecord(body, ['categoryId'], context.correlationId);
    if (!('categoryId' in record)) throw invalid('INVALID_FIELD', context.correlationId, 'categoryId');
    const raw = record.categoryId;
    if (raw !== null && (typeof raw !== 'string' || !uuidPattern.test(raw))) throw invalid('INVALID_FIELD', context.correlationId, 'categoryId');
    const categoryId = raw === null ? null : raw.toLowerCase();
    const category = await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT id FROM campus_drives WHERE id = ${drive}::uuid AND institution_id = ${id}::uuid FOR UPDATE`) as Rows<{ id: string }>;
      if (!locked.rows[0]) throw forbidden(context.correlationId);
      if (categoryId) {
        const available = await tx.execute(sql`
          SELECT 1 FROM institution_drive_categories WHERE id = ${categoryId}::uuid AND institution_id = ${id}::uuid AND state = 'ACTIVE' FOR SHARE
        `) as Rows<unknown>;
        if (available.rows.length !== 1) throw invalid('DRIVE_CATEGORY_UNAVAILABLE', context.correlationId, 'categoryId');
      }
      const current = await tx.execute(sql`
        SELECT category_id FROM campus_drive_category_assignments WHERE campus_drive_id = ${drive}::uuid
        ORDER BY created_at DESC, id DESC LIMIT 1
      `) as Rows<{ category_id: string | null }>;
      const previous = current.rows[0]?.category_id ?? null;
      if (previous !== categoryId) {
        await tx.execute(sql`
          INSERT INTO campus_drive_category_assignments (id, campus_drive_id, institution_id, category_id, assigned_by_user_id)
          VALUES (${this.ids.uuid()}::uuid, ${drive}::uuid, ${id}::uuid, ${categoryId}::uuid, ${context.authorization.principal.userId}::uuid)
        `);
        await this.audit(tx, context, id, 'campus_drive.category_set', 'campus_drive', drive, { categoryId, previousCategoryId: previous });
      }
      return (await loadDriveCategories(tx, id, [drive])).get(drive) ?? null;
    });
    return { category, correlationId: context.correlationId };
  }

  /** The period: the first instant of the current UTC month, from the database clock. */
  private async period(): Promise<{ periodEnd: string; month: string; lastDay: string }> {
    const rows = await this.db.execute(sql`
      SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS period_end,
             to_char((t - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
             to_char((t - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day
      FROM (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS t) boundary
    `) as Rows<{ period_end: string; month: string; last_day: string }>;
    const row = rows.rows[0]!;
    return { periodEnd: row.period_end, month: row.month, lastDay: row.last_day };
  }

  private async audit(tx: Executor, context: Context, institutionId: string, action: string, resourceType: string, resourceId: string, detail: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid,
              ${institutionId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify(detail)}::jsonb)
    `);
  }

  private reader(request: ProtectedHttpRequest, institutionId: string): { context: Context; id: string } {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    if (institutionStaffScopeMemberships(request, id, placementRegisterReaderRoles).length === 0) throw forbidden(context.correlationId);
    return { context, id };
  }

  private async manager(request: ProtectedHttpRequest, institutionId: string): Promise<{ context: Context; id: string }> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(institutionId, context.correlationId);
    if (institutionStaffScopeMemberships(request, id, categoryManagerRoles).length === 0) throw forbidden(context.correlationId);
    if (!await this.canManage(request, id)) {
      throw new ForbiddenException({ error: { code: 'INSTITUTION_WIDE_SCOPE_REQUIRED', message: 'Access denied', correlationId: context.correlationId } });
    }
    return { context, id };
  }

  private async canManage(request: ProtectedHttpRequest, institutionId: string): Promise<boolean> {
    if (institutionStaffScopeMemberships(request, institutionId, categoryManagerRoles).length === 0) return false;
    const scope = await institutionStudentWriteScopeFor(this.db, request, institutionId, categoryManagerRoles);
    return canAddressInstitutionAudience(scope, null);
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function bodyRecord(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid('UNKNOWN_FIELD', correlationId);
  return record;
}
function readText(record: Record<string, unknown>, field: string, max: number, correlationId: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid('INVALID_FIELD', correlationId, field);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max || /^[=+@-]/.test(trimmed)) throw invalid('INVALID_FIELD', correlationId, field);
  return trimmed;
}
function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}
function error(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}
function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}
function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
