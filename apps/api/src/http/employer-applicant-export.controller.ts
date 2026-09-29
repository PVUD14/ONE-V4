/**
 * Employer applicant exports (EMP-17, journey J9): one job's applicants as a CSV file for the
 * employer's owners and admins.
 *
 * An export is the riskiest read an employer can make, because the data leaves ONE and cannot be
 * recalled. So the route applies every rule the screens apply, and then some:
 *
 *  - `requireActiveEmployer(…, 'candidates')` for owners and admins only (§5.1, decision 10.2 #10);
 *  - only applications whose applicant-access grant is live at this moment (EMP-SR-01's one
 *    predicate, on the database clock), so withdrawn, closed, expired and deleting students are
 *    never in a file, whether or not EMP-16's sweep has run yet;
 *  - only what the student shared in their frozen snapshot, with contact details from
 *    SHORTLISTED onward (EMP-07, decision 10.2 #9);
 *  - INST-08's formula-safe writer, a row cap, a per-person daily limit under an advisory lock,
 *    and an audit row with the reason code and the SHA-256 of the exact bytes, committed before
 *    the file is sent.
 *
 * No readiness, identifier, roll number, compensation or protected attribute is ever written.
 * Design: docs/architecture/employer-applicant-exports-design.md.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, ForbiddenException, HttpException, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant } from '@planthepath/persistence/src/employer-authentication.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, safeError, type ProtectedHttpRequest } from './api-security.js';
import { assertEmployerState, requireEmployerMembership } from './employer-organisation-state.js';
import {
  applicantExportRow,
  employerApplicantCsv,
  employerExportAuditAction,
  employerExportDailyLimit,
  employerExportFilename,
  employerExportMaxRows,
  employerExportReasonCodes,
  employerExportScopes,
  type EmployerExportScope,
} from './employer-applicant-export.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** §5.1: exporting applicant lists is for owners and admins; recruiters and interviewers do not. */
const exportRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'] as const;

interface ExportResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ExportResponse;
  send(body: Buffer): void;
}

class ExportRefusal extends Error {
  constructor(readonly status: HttpStatus, readonly code: string) { super(code); }
}

@Controller('/api/v1')
export class EmployerApplicantExportController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Post('/employers/:employerId/opportunities/:opportunityId/applicant-export')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async exportApplicants(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string,
    @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const context = requireEmployerMembership(request, employerId, exportRoles);
    const { correlationId } = context;
    if (!uuidPattern.test(opportunityId)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    await assertEmployerState(this.db, employerId, 'candidates', correlationId);
    const input = readInput(body, correlationId);
    const actorUserId = context.authorization.principal.userId;

    const jobs = await this.db.execute(sql`
      SELECT v.title FROM opportunities o LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.id = ${opportunityId}::uuid AND o.employer_id = ${employerId}::uuid
    `) as QueryResult<{ title: string | null }>;
    const [owned] = jobs.rows;
    if (!owned) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));

    const today = new Date().toISOString().slice(0, 10);
    const states = employerExportScopes[input.scope] as readonly string[];
    let file: { readonly document: string; readonly sha256: string };
    try {
      file = await this.db.transaction(async (tx) => {
        // One export at a time per person per employer, so two parallel requests cannot both take the last slot.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'employer-export:' + actorUserId + ':' + employerId}))`);
        const used = await tx.execute(sql`
          SELECT count(*)::int AS n FROM audit_events
          WHERE actor_user_id = ${actorUserId}::uuid AND organization_id = ${employerId}::uuid AND outcome = 'SUCCESS'
            AND action = ${employerExportAuditAction} AND occurred_at > now() - interval '24 hours'
        `) as QueryResult<{ n: number }>;
        if (Number(used.rows[0]?.n ?? 0) >= employerExportDailyLimit) throw new ExportRefusal(HttpStatus.TOO_MANY_REQUESTS, 'EXPORT_RATE_LIMITED');

        // The grant is judged here, inside the transaction that writes the audit row, on the database clock.
        const rows = await tx.execute(sql`
          SELECT a.id, a.state, a.submitted_at, s.snapshot, (s.erased_at IS NOT NULL) AS snapshot_erased
          FROM applications a
          LEFT JOIN application_profile_snapshots s ON s.application_id = a.id
          WHERE a.opportunity_id = ${opportunityId}::uuid AND a.employer_id = ${employerId}::uuid
            AND a.state IN (${sql.join(states.map((state) => sql`${state}`), sql`, `)})
            AND a.consent_revoked_at IS NULL
            AND ${applicationHasLiveApplicantGrant('a')}
          ORDER BY a.submitted_at, a.id
          LIMIT ${employerExportMaxRows + 1}
        `) as QueryResult<{ id: string; state: string; submitted_at: string | Date | null; snapshot: unknown; snapshot_erased: boolean }>;
        if (rows.rows.length > employerExportMaxRows) throw new ExportRefusal(HttpStatus.UNPROCESSABLE_ENTITY, 'EXPORT_TOO_LARGE');
        const withheld = await tx.execute(sql`
          SELECT count(*)::int AS n FROM applications a
          WHERE a.opportunity_id = ${opportunityId}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
            AND NOT (a.consent_revoked_at IS NULL AND ${applicationHasLiveApplicantGrant('a')})
        `) as QueryResult<{ n: number }>;

        const built = employerApplicantCsv(rows.rows.map((row) => applicantExportRow({
          state: row.state, submittedAt: row.submitted_at, snapshot: row.snapshot, snapshotErased: row.snapshot_erased === true,
        })));
        await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          VALUES (${randomUUID()}::uuid, ${actorUserId}::uuid, ${employerExportAuditAction}, 'opportunity', ${opportunityId}::uuid, ${employerId}::uuid,
            'SUCCESS', ${correlationId}, ${JSON.stringify({
              reasonCode: input.reasonCode, scope: input.scope, opportunityId, rowCount: rows.rows.length,
              withheldWithoutLiveGrant: Number(withheld.rows[0]?.n ?? 0), applicationIds: rows.rows.map((row) => row.id), sha256: built.sha256,
            })}::jsonb)
        `);
        return built;
      });
    } catch (error) {
      if (error instanceof ExportRefusal) throw failure(error.status, error.code, correlationId);
      if (error instanceof HttpException) throw error;
      throw failure(HttpStatus.INTERNAL_SERVER_ERROR, 'EXPORT_FAILED', correlationId);
    }

    // Only now, after the audit row has committed, does the file leave ONE.
    const bytes = Buffer.from(file.document, 'utf8');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${employerExportFilename(owned.title, today)}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('X-Export-Sha256', file.sha256);
    response.status(HttpStatus.OK).send(bytes);
  }
}

function readInput(body: unknown, correlationId: string): { readonly reasonCode: string; readonly scope: EmployerExportScope } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'reasonCode' && key !== 'scope')) throw failure(HttpStatus.BAD_REQUEST, 'UNKNOWN_FIELD', correlationId);
  if (typeof record.reasonCode !== 'string' || !(employerExportReasonCodes as readonly string[]).includes(record.reasonCode)) {
    throw failure(HttpStatus.BAD_REQUEST, 'REASON_CODE_REQUIRED', correlationId);
  }
  const scope = record.scope ?? 'ALL_OPEN';
  if (typeof scope !== 'string' || !Object.hasOwn(employerExportScopes, scope)) throw failure(HttpStatus.BAD_REQUEST, 'EXPORT_SCOPE_INVALID', correlationId);
  return { reasonCode: record.reasonCode, scope: scope as EmployerExportScope };
}

const plainMessages: Readonly<Record<string, string>> = {
  REASON_CODE_REQUIRED: 'Choose a reason for this export',
  EXPORT_SCOPE_INVALID: 'Choose which applicants to export',
  UNKNOWN_FIELD: 'Request could not be processed',
  EXPORT_TOO_LARGE: 'This job has more applicants than one file allows; export Shortlisted onward instead',
  EXPORT_RATE_LIMITED: 'You have reached the daily export limit; try again tomorrow',
};

function failure(status: HttpStatus, code: string, correlationId: string): HttpException {
  const body = { error: { code, message: plainMessages[code] ?? 'Request could not be processed', correlationId } };
  if (status === HttpStatus.BAD_REQUEST) return new BadRequestException(body);
  return new HttpException(body, status);
}
