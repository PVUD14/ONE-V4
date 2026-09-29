/**
 * Institution CSV exports (INST-08, defect I-9).
 *
 * Design: docs/architecture/institution-exports-design.md. Four exports — roster with
 * activation state, readiness band distribution, one assessment's results, staff-action
 * summary — each gated by the INSTITUTION_ANALYTICS capability (ADR-018), limited to the
 * write scope of the memberships holding it, audited before the file is sent, rate-limited
 * and size-capped. Aggregates cover one ended calendar month and go through the shared
 * suppression rule (INST-SR-01); formula injection is encoded on output (INST-SR-13); no
 * internal identifier, numeric readiness or compensation field is ever written.
 *
 * Every export is a POST: it writes an audit row and needs a reason code, which does not
 * belong in a URL.
 *
 * INST-13 adds a fifth, the accreditation outcomes file, on the same gate, scope, limits and
 * audit: graduates by department, programme and year with placed (INST-12's rule), higher studies
 * and entrepreneurship (self-reported, 0083), suppressed, as of the last month end, NA wherever ONE
 * holds nothing. Design: docs/architecture/accreditation-outcome-exports-design.md.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, ForbiddenException, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  canAddressInstitutionAudience,
  institutionExportAuditActions,
  institutionExportMaxRows,
  institutionExportMemberships,
  institutionExportScope,
  institutionReportingMonth,
  type InstitutionExportCandidateMembership,
  type InstitutionExportKind,
  type InstitutionStudentScope,
} from '@planthepath/authorization/src/index.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { generateInstitutionAggregateReport } from '@planthepath/persistence/src/career-readiness.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { loadInstitutionUnitTree } from '@planthepath/persistence/src/institution-scope.js';
import {
  InstitutionExportError,
  exportAssessmentResultRows,
  exportRosterRows,
  exportStaffActionSummary,
  institutionAssessmentTitle,
  institutionUnitName,
  loadInstitutionAnalyticsGrants,
  recordDeniedInstitutionExport,
  recordInstitutionExport,
} from '@planthepath/persistence/src/institution-exports.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, requireTrustedAuthorization, type ProtectedHttpRequest } from './api-security.js';
import { toCsv, type CsvValue } from './institution-export-csv.js';
import { loadAccreditationOutcomes } from './accreditation-outcomes.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const monthPattern = /^\d{4}-\d{2}$/;
const suppressedLabel = '<5';

const activationLabels: Readonly<Record<string, string>> = {
  ACTIVATED: 'Activated', INVITED: 'Invited', EXPIRED: 'Expired', BOUNCED: 'Bounced', NOT_INVITED: 'Not invited',
};
const relationshipLabels: Readonly<Record<string, string>> = { ACTIVE: 'Active', VERIFIED: 'Verified' };
const bandLabels: Readonly<Record<string, string>> = {
  NOT_ENOUGH_EVIDENCE: 'Not enough evidence', DEVELOPING: 'Developing', PROGRESSING: 'Progressing', READY_FOR_NEXT_STEP: 'Ready for next step',
};
const reportBands = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'] as const;
const actionTypeLabels: Readonly<Record<string, string>> = {
  INTERVENTION: 'Intervention', ASSIGNED_TASK: 'Assigned task', FACULTY_NOTE: 'Faculty note', ACADEMIC_VERIFICATION: 'Academic verification', MEETING: 'Meeting',
};

type Context = ReturnType<typeof requireTrustedAuthorization>;

interface ExportResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ExportResponse;
  send(body: string): void;
}

interface Authority {
  readonly context: Context;
  readonly institutionId: string;
  readonly actorUserId: string;
  readonly exporters: readonly InstitutionExportCandidateMembership[];
  readonly scope: InstitutionStudentScope;
}

interface CsvFile {
  readonly filename: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly CsvValue[])[];
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionExportsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** The roster with activation state; current relationships only; optionally one unit. */
  @Post('/institutions/:institutionId/exports/roster')
  async roster(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const authority = await this.authorise(request, institutionId, 'ROSTER');
    const input = readBody(body, ['reasonCode', 'unitId'], authority.context.correlationId);
    const unit = await this.readUnit(authority, input.unitId);
    const file = await this.record(authority, 'ROSTER', input.reasonCode, async (client) => {
      const rows = await exportRosterRows(client, { institutionId: authority.institutionId, scope: authority.scope, unitId: unit?.id ?? null, limit: institutionExportMaxRows + 1 });
      requireWithinLimit(rows.length, authority.context.correlationId);
      return {
        file: {
          filename: `one-roster-${today()}.csv`,
          header: ['Student ID', 'Full name', 'Email', 'Department', 'Programme', 'Batch', 'Section', 'Relationship', 'Activation', 'Invited on', 'Last invitation sent'],
          rows: rows.map((row) => [row.institutionStudentId, row.fullName, row.email, row.department, row.programme, row.batch, row.section,
            relationshipLabels[row.relationshipState] ?? row.relationshipState, activationLabels[row.activationState] ?? row.activationState,
            day(row.invitedAt), day(row.lastSentAt)]),
        },
        context: { rowCount: rows.length, ...(unit ? { unitId: unit.id } : {}) },
      };
    });
    send(response, file, authority.context.correlationId);
  }

  /** The readiness band distribution for one ended month: the institution report, as a file. */
  @Post('/institutions/:institutionId/exports/readiness-bands')
  async readinessBands(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const authority = await this.authorise(request, institutionId, 'READINESS_BANDS');
    const input = readBody(body, ['reasonCode', 'month'], authority.context.correlationId);
    const period = readMonth(input.month, authority.context.correlationId);
    const file = await this.record(authority, 'READINESS_BANDS', input.reasonCode, async () => {
      // The same function the Reports screen calls, so the file and the screen cannot disagree;
      // only its suppressed form ever reaches this code.
      const report = await generateInstitutionAggregateReport(this.pool, {
        institutionId: authority.institutionId, periodStart: period.periodStart, periodEnd: period.periodEnd, studentScope: authority.scope,
      }) as { reportId: string; aggregate: { suppressed: boolean; cohortSize: number | null; cohortSizeSuppressed?: boolean; bands: { band: string; count: number | null; suppressed?: boolean }[] } };
      const { aggregate } = report;
      const cells = new Map(aggregate.bands.map((entry) => [entry.band, entry]));
      const rows: CsvValue[][] = reportBands.map((band) => {
        const cell = cells.get(band);
        return [period.month, bandLabels[band], aggregate.suppressed || !cell || cell.suppressed || cell.count === null ? suppressedLabel : cell.count];
      });
      const total = aggregate.suppressed ? suppressedLabel
        : aggregate.cohortSizeSuppressed || aggregate.cohortSize === null ? 'Withheld' : aggregate.cohortSize;
      rows.push([period.month, 'All students with readiness records', total]);
      return {
        file: { filename: `one-readiness-bands-${period.month}.csv`, header: ['Month', 'Readiness band', 'Students'], rows },
        context: { month: period.month, reportId: report.reportId, rowCount: rows.length },
      };
    });
    send(response, file, authority.context.correlationId);
  }

  /** One assessment's grade sheet: completed attempts, then assigned students with none. */
  @Post('/institutions/:institutionId/exports/assessment-results')
  async assessmentResults(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const authority = await this.authorise(request, institutionId, 'ASSESSMENT_RESULTS');
    const correlationId = authority.context.correlationId;
    const input = readBody(body, ['reasonCode', 'assessmentId', 'unitId'], correlationId);
    if (typeof input.assessmentId !== 'string' || !uuidPattern.test(input.assessmentId)) throw failure(HttpStatus.BAD_REQUEST, 'ASSESSMENT_ID_INVALID', correlationId);
    const assessmentId = input.assessmentId;
    const title = await institutionAssessmentTitle(this.pool, authority.institutionId, assessmentId);
    if (title === null) throw failure(HttpStatus.NOT_FOUND, 'ASSESSMENT_NOT_FOUND', correlationId);
    const unit = await this.readUnit(authority, input.unitId);
    const file = await this.record(authority, 'ASSESSMENT_RESULTS', input.reasonCode, async (client) => {
      const rows = await exportAssessmentResultRows(client, {
        institutionId: authority.institutionId, definitionId: assessmentId, scope: authority.scope, unitId: unit?.id ?? null, limit: institutionExportMaxRows + 1,
      });
      requireWithinLimit(rows.length, correlationId);
      return {
        file: {
          filename: `one-assessment-results-${today()}.csv`,
          header: ['Assessment', 'Student ID', 'Full name', 'Attempt', 'Status', 'Auto-submitted', 'Score', 'Maximum score', 'Percentage', 'Correct', 'Wrong', 'Not attempted', 'Time taken (seconds)', 'Completed at'],
          rows: rows.map((row) => [title, row.institutionStudentId, row.fullName, row.attemptNumber, row.status, row.autoSubmitted, row.score, row.maxScore,
            row.percentage, row.correct, row.wrong, row.notAttempted, row.timeTakenSeconds, row.completedAt]),
        },
        context: { assessmentId, rowCount: rows.length, ...(unit ? { unitId: unit.id } : {}) },
      };
    });
    send(response, file, correlationId);
  }

  /** Staff actions about students in scope opened in one ended month: suppressed counts only. */
  @Post('/institutions/:institutionId/exports/staff-action-summary')
  async staffActionSummary(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const authority = await this.authorise(request, institutionId, 'STAFF_ACTION_SUMMARY');
    const input = readBody(body, ['reasonCode', 'month'], authority.context.correlationId);
    const period = readMonth(input.month, authority.context.correlationId);
    const file = await this.record(authority, 'STAFF_ACTION_SUMMARY', input.reasonCode, async (client) => {
      const summary = await exportStaffActionSummary(client, {
        institutionId: authority.institutionId, scope: authority.scope, periodStart: period.periodStart, periodEnd: period.periodEnd,
      });
      const cell = (count: { suppressed: boolean; value: number | null }): CsvValue => (count.suppressed || count.value === null ? suppressedLabel : count.value);
      const rows = summary.map((row) => [period.month, actionTypeLabels[row.actionType] ?? row.actionType, cell(row.students), cell(row.actions)]);
      return {
        file: { filename: `one-staff-actions-${period.month}.csv`, header: ['Month', 'Action type', 'Students with at least one', 'Actions opened'], rows },
        context: { month: period.month, rowCount: rows.length },
      };
    });
    send(response, file, authority.context.correlationId);
  }

  /**
   * Graduate outcomes for accreditation (INST-13): counts only, suppressed, as of the end of the last
   * ended month, over the whole export scope (no period or unit choice, so no two files can be
   * differenced). Not an official template, and the file says so first.
   */
  @Post('/institutions/:institutionId/exports/accreditation-outcomes')
  async accreditationOutcomes(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const authority = await this.authorise(request, institutionId, 'ACCREDITATION_OUTCOMES');
    const input = readBody(body, ['reasonCode'], authority.context.correlationId);
    const file = await this.record(authority, 'ACCREDITATION_OUTCOMES', input.reasonCode, async (client) => {
      const outcomes = await loadAccreditationOutcomes(drizzle(client, { schema }), authority.institutionId, authority.scope);
      const cell = (count: { suppressed: boolean; value: number | null }, total = false): CsvValue => (count.suppressed || count.value === null ? (total ? 'Withheld' : suppressedLabel) : count.value);
      const notHeld = ['NA', 'NA', 'NA'] as const;
      const note = (text: string): CsvValue[] => ['Note', null, null, null, null, null, null, null, null, null, null, null, text];
      const rows: CsvValue[][] = [
        ...accreditationNotes(today(), outcomes.asOf.lastDay).map(note),
        ...outcomes.groups.map(({ department, programme, yearOfGraduation, row }) => ['Group', department, programme, yearOfGraduation,
          cell(row.graduated, true), cell(row.placed), cell(row.higherStudies), cell(row.entrepreneurship), cell(row.noneShared), ...notHeld, null]),
        ['All graduates in scope', null, null, 'All years', cell(outcomes.overall.graduated, true), cell(outcomes.overall.placed, true),
          cell(outcomes.overall.higherStudies, true), cell(outcomes.overall.entrepreneurship, true), cell(outcomes.overall.noneShared, true), ...notHeld, null],
      ];
      requireWithinLimit(rows.length, authority.context.correlationId);
      return {
        file: { filename: `one-accreditation-outcomes-${outcomes.asOf.month}.csv`, header: accreditationHeader, rows },
        context: { month: outcomes.asOf.month, groups: outcomes.groups.length, rowCount: rows.length },
      };
    });
    send(response, file, authority.context.correlationId);
  }

  /**
   * 401 comes from the guard. Anyone who is not staff of this institution gets a plain 403;
   * institution staff without an authorising grant get 403 ANALYTICS_CAPABILITY_REQUIRED and
   * a DENIED audit row; a grant holder whose write scope is empty gets 403 SCOPE_REQUIRED.
   */
  private async authorise(request: ProtectedHttpRequest, institutionId: string, kind: InstitutionExportKind): Promise<Authority> {
    const context = requireTrustedAuthorization(request);
    const { correlationId } = context;
    if (!uuidPattern.test(institutionId)) throw failure(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', correlationId);
    const actorUserId = context.authorization.principal.userId;
    const own = context.authorization.memberships.filter((membership) => membership.organizationId === institutionId
      && membership.scope.organizationId === institutionId && membership.scope.institutionId === institutionId);
    if (!own.some((membership) => membership.state === 'ACTIVE')) throw failure(HttpStatus.FORBIDDEN, 'FORBIDDEN', correlationId);
    const grants = await loadInstitutionAnalyticsGrants(this.pool, own.map((membership) => membership.id));
    const candidates: InstitutionExportCandidateMembership[] = own.map((membership) => ({
      role: membership.role, membershipId: membership.id, organizationId: membership.organizationId,
      state: membership.state as InstitutionExportCandidateMembership['state'],
      departmentUnitId: membership.scope.departmentId ?? null, batchUnitId: membership.scope.batchId ?? null,
      analyticsGrantId: grants.get(membership.id) ?? null,
    }));
    const exporters = institutionExportMemberships(candidates, institutionId);
    if (exporters.length === 0) {
      await recordDeniedInstitutionExport(this.pool, { institutionId, actorUserId, correlationId, kind, reason: 'ANALYTICS_CAPABILITY_REQUIRED' });
      throw failure(HttpStatus.FORBIDDEN, 'ANALYTICS_CAPABILITY_REQUIRED', correlationId);
    }
    const scope = institutionExportScope(exporters, await loadInstitutionUnitTree(this.pool, institutionId));
    if (scope.kind === 'NONE') throw failure(HttpStatus.FORBIDDEN, 'SCOPE_REQUIRED', correlationId);
    return { context, institutionId, actorUserId, exporters, scope };
  }

  /** An optional unit filter: a unit of this institution, inside the caller's export scope. */
  private async readUnit(authority: Authority, value: unknown): Promise<{ readonly id: string } | null> {
    const { correlationId } = authority.context;
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw failure(HttpStatus.BAD_REQUEST, 'UNIT_ID_INVALID', correlationId);
    if ((await institutionUnitName(this.pool, authority.institutionId, value)) === null) throw failure(HttpStatus.BAD_REQUEST, 'UNIT_ID_INVALID', correlationId);
    if (!canAddressInstitutionAudience(authority.scope, value)) throw failure(HttpStatus.FORBIDDEN, 'UNIT_OUT_OF_SCOPE', correlationId);
    return { id: value };
  }

  private async record(
    authority: Authority,
    kind: InstitutionExportKind,
    reasonCode: unknown,
    produce: (client: import('pg').PoolClient) => Promise<{ readonly file: CsvFile; readonly context: Record<string, unknown> }>,
  ): Promise<CsvFile> {
    const { correlationId } = authority.context;
    if (typeof reasonCode !== 'string' || !reasonPattern.test(reasonCode)) throw failure(HttpStatus.BAD_REQUEST, 'REASON_CODE_REQUIRED', correlationId);
    try {
      return await recordInstitutionExport(this.pool, {
        institutionId: authority.institutionId, actorUserId: authority.actorUserId, correlationId,
        action: institutionExportAuditActions[kind], exportId: randomUUID(),
        produce: async (client) => {
          const { file, context } = await produce(client);
          // Build the document now, so a forbidden header fails before the audit row is written.
          toCsv(file.header, file.rows);
          return {
            result: file,
            context: {
              kind, reasonCode, ...context,
              scope: authority.scope.kind,
              anchorUnitIds: authority.exporters.flatMap((membership) => [membership.departmentUnitId, membership.batchUnitId].filter(Boolean)),
              membershipIds: authority.exporters.map((membership) => membership.membershipId),
              grantIds: authority.exporters.map((membership) => membership.analyticsGrantId),
            },
          };
        },
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof InstitutionExportError && error.code === 'EXPORT_RATE_LIMITED') throw failure(HttpStatus.TOO_MANY_REQUESTS, 'EXPORT_RATE_LIMITED', correlationId);
      throw failure(HttpStatus.INTERNAL_SERVER_ERROR, 'EXPORT_FAILED', correlationId);
    }
  }
}

/** The accreditation file's columns (INST-13). Three are NA in every row: ONE does not hold them. */
const accreditationHeader = [
  'Row', 'Department', 'Programme', 'Year of graduation', 'Graduated', 'Placed (applications shared with the college)',
  'Higher studies (self-reported)', 'Entrepreneurship (self-reported)', 'No outcome shared',
  'Graduated within normal duration', 'Qualified in national or state examinations', 'Median salary or package', 'Note',
] as const;

/** The plain statements every accreditation file opens with. */
function accreditationNotes(preparedOn: string, asOf: string): readonly string[] {
  return [
    `Prepared by ONE on ${preparedOn} from records as of ${asOf}.`,
    'Check every figure against the current official template (NAAC, NBA, NIRF or other) before any submission. ONE does not claim that this file complies with any format.',
    'Counts only: no student is named. Any count under 5 reads <5. A total reads Withheld when it is under 5 or would reveal a hidden count.',
    'Graduated: students with a recorded graduation from the college. Year of graduation is the calendar year of the recorded graduation date.',
    'Placed: graduates with an accepted offer or a hire on an application they chose to share with the college, before graduating — the same rule as the Placement statistics.',
    'Higher studies and entrepreneurship are self-reported by graduates who chose to share them with the college. Neither ONE nor the college has verified them.',
    'Each graduate is counted once: placed first, then their own report. No outcome shared means the college has no shared record — it does not mean unplaced.',
    'Graduated within normal duration and Qualified in national or state examinations: NA — ONE does not hold these records.',
    'Median salary or package: NA — ONE never gives colleges offer pay, for any student or in aggregate.',
  ];
}

function readBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', correlationId);
  const unknownKey = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknownKey) throw failure(HttpStatus.BAD_REQUEST, 'UNKNOWN_FIELD', correlationId);
  return body as Record<string, unknown>;
}

/** One whole calendar month that has ended (INST-SR-01), as YYYY-MM. */
function readMonth(value: unknown, correlationId: string): { readonly month: string; readonly periodStart: string; readonly periodEnd: string } {
  if (typeof value !== 'string' || !monthPattern.test(value)) throw failure(HttpStatus.BAD_REQUEST, 'REPORT_PERIOD_INVALID', correlationId);
  const [year, month] = [Number(value.slice(0, 4)), Number(value.slice(5, 7))];
  if (month < 1 || month > 12) throw failure(HttpStatus.BAD_REQUEST, 'REPORT_PERIOD_INVALID', correlationId);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const period = institutionReportingMonth(`${value}-01`, `${value}-${String(lastDay).padStart(2, '0')}`, today());
  if (!period) throw failure(HttpStatus.BAD_REQUEST, 'REPORT_PERIOD_INVALID', correlationId);
  return period;
}

function requireWithinLimit(rows: number, correlationId: string): void {
  if (rows > institutionExportMaxRows) throw failure(HttpStatus.UNPROCESSABLE_ENTITY, 'EXPORT_TOO_LARGE', correlationId);
}

function send(response: ExportResponse, file: CsvFile, correlationId: string): void {
  const document = toCsv(file.header, file.rows);
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Correlation-Id', correlationId);
  response.status(HttpStatus.OK).send(document);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function day(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

const plainMessages: Readonly<Record<string, string>> = {
  FORBIDDEN: 'Access denied',
  ANALYTICS_CAPABILITY_REQUIRED: 'Exports need analytics and exports access, which an owner or admin of your institution can grant',
  SCOPE_REQUIRED: 'Exports need a department on your staff membership, which an admin of your institution can set',
  UNIT_OUT_OF_SCOPE: 'That unit is outside the students you can export',
  REPORT_PERIOD_INVALID: 'An export covers one whole calendar month that has ended',
  EXPORT_TOO_LARGE: 'This export has more rows than one file allows; limit it to one department, programme, batch or section',
  EXPORT_RATE_LIMITED: 'You have reached the daily export limit; try again tomorrow',
  ASSESSMENT_NOT_FOUND: 'That assessment was not found',
};

function failure(status: HttpStatus, code: string, correlationId: string): HttpException {
  const body = { error: { code, message: plainMessages[code] ?? 'Request could not be processed', correlationId } };
  if (status === HttpStatus.FORBIDDEN) return new ForbiddenException(body);
  if (status === HttpStatus.BAD_REQUEST) return new BadRequestException(body);
  if (status === HttpStatus.NOT_FOUND) return new NotFoundException(body);
  return new HttpException(body, status);
}
