/**
 * Graduates' self-reported outcomes (INST-13, 0083).
 *
 * A student tells one college they studied at that they went on to higher studies or started a
 * venture. Colleges need those figures for accreditation, and ONE holds no other source for them.
 * The declaration is the consent: nothing is shared by default, it is withdrawable at any time, and
 * no college route ever returns it — only the accreditation export reads it, as a suppressed count.
 * It is self-reported and labelled so. No detail beyond the outcome is collected.
 *
 * Which colleges: those the student holds a current (ACTIVE / VERIFIED) or GRADUATED relationship
 * with; not a college they transferred out of or were ended at. Every write is audited in the same
 * transaction. Design: docs/architecture/student-outcome-declarations-table-design.md.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { isSelfReportedOutcome, type SelfReportedOutcome } from '@planthepath/authorization/src/index.js';
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

type Executor = Pick<PersistenceDb, 'execute'>;
type Rows<T> = { rows: T[] };
type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OutcomeCollegeView {
  readonly institutionId: string;
  readonly institutionName: string;
  /** CURRENT while studying there; GRADUATED once a graduation is recorded. */
  readonly relationship: 'CURRENT' | 'GRADUATED';
  readonly graduatedOn: string | null;
  readonly declaration: { readonly id: string; readonly outcome: SelfReportedOutcome; readonly declaredAt: string } | null;
}

/** The colleges this person may declare to, each with their live declaration or none. */
async function readColleges(db: Executor, studentUserId: string): Promise<readonly OutcomeCollegeView[]> {
  const rows = await db.execute(sql`
    WITH qualifying AS (
      SELECT r.institution_id,
        bool_or(r.state IN ('ACTIVE', 'VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())) AS current,
        max(r.effective_to) FILTER (WHERE r.state = 'GRADUATED') AS graduated_on
      FROM institution_relationships r
      WHERE r.student_user_id = ${studentUserId}::uuid
        AND ((r.state IN ('ACTIVE', 'VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
          OR (r.state = 'GRADUATED' AND r.effective_to IS NOT NULL))
      GROUP BY r.institution_id
    )
    SELECT q.institution_id, o.legal_name, q.current, q.graduated_on, d.id AS declaration_id, d.outcome, d.declared_at
    FROM qualifying q
    JOIN organizations o ON o.id = q.institution_id AND o.kind = 'INSTITUTION'
    LEFT JOIN student_outcome_declarations d
      ON d.institution_id = q.institution_id AND d.student_user_id = ${studentUserId}::uuid AND d.withdrawn_at IS NULL
    ORDER BY o.legal_name, q.institution_id
    LIMIT 50
  `) as Rows<{ institution_id: string; legal_name: string; current: boolean | null; graduated_on: Date | string | null; declaration_id: string | null; outcome: string | null; declared_at: Date | string | null }>;
  return rows.rows.map((row) => ({
    institutionId: row.institution_id,
    institutionName: row.legal_name,
    // A graduate who has since re-enrolled at the same college is shown as graduated: that is what counts.
    relationship: row.graduated_on ? 'GRADUATED' : 'CURRENT',
    graduatedOn: row.graduated_on ? new Date(row.graduated_on).toISOString().slice(0, 10) : null,
    declaration: row.declaration_id && isSelfReportedOutcome(row.outcome) && row.declared_at
      ? { id: row.declaration_id, outcome: row.outcome, declaredAt: new Date(row.declared_at).toISOString() }
      : null,
  }));
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class StudentOutcomeDeclarationsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/students/me/outcome-declarations')
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    return { colleges: await readColleges(this.db, context.authorization.principal.userId), correlationId: context.correlationId };
  }

  /**
   * Share an outcome with one college. A live declaration with a different outcome is withdrawn and
   * replaced in the same transaction; the same outcome again writes nothing.
   */
  @Post('/students/me/outcome-declarations')
  async share(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const record = bodyRecord(body, ['institutionId', 'outcome'], context.correlationId);
    const institutionId = record.institutionId;
    if (typeof institutionId !== 'string' || !uuidPattern.test(institutionId)) throw invalid('INVALID_FIELD', context.correlationId, 'institutionId');
    const outcome = record.outcome;
    if (!isSelfReportedOutcome(outcome)) throw invalid('INVALID_FIELD', context.correlationId, 'outcome');
    const college = institutionId.toLowerCase();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'outcome-declaration:' + studentUserId + ':' + college}))`);
      if (!(await readColleges(tx, studentUserId)).some((entry) => entry.institutionId === college)) {
        throw new ForbiddenException({ error: { code: 'OUTCOME_COLLEGE_NOT_ELIGIBLE', message: 'You can share an outcome only with a college you study at or graduated from', correlationId: context.correlationId } });
      }
      const live = await tx.execute(sql`
        SELECT id, outcome FROM student_outcome_declarations
        WHERE student_user_id = ${studentUserId}::uuid AND institution_id = ${college}::uuid AND withdrawn_at IS NULL FOR UPDATE
      `) as Rows<{ id: string; outcome: string }>;
      const current = live.rows[0];
      if (current?.outcome === outcome) return;
      if (current) {
        await tx.execute(sql`UPDATE student_outcome_declarations SET withdrawn_at = now() WHERE id = ${current.id}::uuid AND withdrawn_at IS NULL`);
        await this.audit(tx, context, college, 'student.outcome_declaration.withdrawn', current.id, { outcome: current.outcome, replaced: true });
      }
      const id = this.ids.uuid();
      await tx.execute(sql`
        INSERT INTO student_outcome_declarations (id, student_user_id, institution_id, outcome)
        VALUES (${id}::uuid, ${studentUserId}::uuid, ${college}::uuid, ${outcome})
      `);
      await this.audit(tx, context, college, 'student.outcome_declaration.shared', id, { outcome });
    });
    return { colleges: await readColleges(this.db, studentUserId), correlationId: context.correlationId };
  }

  /** Withdraw a declaration. Only its author may; repeating it keeps the first withdrawal. */
  @Post('/students/me/outcome-declarations/:declarationId/withdraw')
  async withdraw(@Req() request: ProtectedHttpRequest, @Param('declarationId') declarationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    if (!uuidPattern.test(declarationId)) throw forbidden(context.correlationId);
    bodyRecord(body, [], context.correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT id, institution_id, outcome, withdrawn_at FROM student_outcome_declarations
        WHERE id = ${declarationId.toLowerCase()}::uuid AND student_user_id = ${studentUserId}::uuid FOR UPDATE
      `) as Rows<{ id: string; institution_id: string; outcome: string; withdrawn_at: Date | string | null }>;
      const row = found.rows[0];
      if (!row) throw forbidden(context.correlationId);
      if (row.withdrawn_at) return;
      await tx.execute(sql`UPDATE student_outcome_declarations SET withdrawn_at = now() WHERE id = ${row.id}::uuid AND withdrawn_at IS NULL`);
      await this.audit(tx, context, row.institution_id, 'student.outcome_declaration.withdrawn', row.id, { outcome: row.outcome, replaced: false });
    });
    return { colleges: await readColleges(this.db, studentUserId), correlationId: context.correlationId };
  }

  private async audit(tx: Executor, context: Context, institutionId: string, action: string, resourceId: string, detail: Record<string, unknown>): Promise<void> {
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, ${action}, 'student_outcome_declaration', ${resourceId}::uuid,
              ${institutionId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify(detail)}::jsonb)
    `);
  }
}

function bodyRecord(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalid('UNKNOWN_FIELD', correlationId);
  return record;
}
function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}
function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
