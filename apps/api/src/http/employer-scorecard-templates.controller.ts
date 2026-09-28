/**
 * Scorecard templates (EMP-09): an employer's named sets of interview criteria with guidance,
 * which a job's interview stage points at so every interviewer on that stage judges the same
 * things.
 *
 * A template is never edited — changing criteria means creating a new template and choosing it on
 * the stage in a new job version — so a scorecard always refers to exactly what its interviewer
 * saw. Retiring only stops a template being chosen again. Preparing templates is drafting-level
 * work (Appendix 2 §5.1: a PENDING or UNDER_REVIEW employer may prepare jobs), carries no
 * candidate data, and every write is audited with the organisation under its row lock.
 * Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InterviewInputError, parseScorecardTemplateInput, scorecardTemplateRetireReasonCodes } from '@planthepath/hiring/src/interview-scheduling.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_ID_GENERATOR, API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, safeError, type ApiIdGenerator, type ProtectedHttpRequest } from './api-security.js';
import { employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';
import { lockEmployerForWrite, readScorecardTemplates, rejectUnknownFields } from './interview-scheduling.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}
function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
function conflict(code: string, correlationId: string): ConflictException {
  return new ConflictException({ error: { code, message: 'Request could not be completed', correlationId } });
}

@Controller('/api/v1')
export class EmployerScorecardTemplatesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The employer's templates, live ones first, each with its criteria in order (at most 200). */
  @Get('/employers/:employerId/scorecard-templates')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerMemberRoles);
    const templates = await readScorecardTemplates(this.db, sql`t.employer_id = ${employerId}::uuid`);
    return { templates, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/scorecard-templates')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerMemberRoles);
    let input: ReturnType<typeof parseScorecardTemplateInput>;
    try {
      input = parseScorecardTemplateInput(body);
    } catch (error) {
      if (error instanceof InterviewInputError) throw badRequest(error.code, context.correlationId);
      throw error;
    }
    const actorId = context.authorization.principal.userId;
    const templateId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.draft', context.correlationId);
      const taken = await tx.execute(sql`
        SELECT 1 FROM interview_scorecard_templates WHERE employer_id = ${employerId}::uuid AND lower(name) = lower(${input.name}) AND retired_at IS NULL
      `) as QueryResult<unknown>;
      if (taken.rows.length) throw conflict('SCORECARD_TEMPLATE_NAME_TAKEN', context.correlationId);
      await tx.execute(sql`
        INSERT INTO interview_scorecard_templates (id, employer_id, name, guidance, created_by_user_id)
        VALUES (${templateId}::uuid, ${employerId}::uuid, ${input.name}, ${input.guidance}, ${actorId}::uuid)
      `);
      await tx.execute(sql`
        INSERT INTO interview_scorecard_criteria (id, template_id, position, label, guidance)
        VALUES ${sql.join(input.criteria.map((criterion, index) => sql`(${this.ids.uuid()}::uuid, ${templateId}::uuid, ${index + 1}, ${criterion.label}, ${criterion.guidance})`), sql`, `)}
      `);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${actorId}::uuid, 'interview.scorecard_template.created', 'interview_scorecard_template', ${templateId}::uuid,
          ${employerId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify({ criteriaCount: input.criteria.length })}::jsonb)
      `);
    });
    const [template] = await readScorecardTemplates(this.db, sql`t.id = ${templateId}::uuid`);
    return { template, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/scorecard-templates/:templateId/retire')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async retire(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('templateId') templateId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerMemberRoles);
    if (!uuidPattern.test(templateId)) throw forbidden(context.correlationId);
    rejectUnknownFields(body, ['reasonCode'], context.correlationId);
    const reasonCode = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).reasonCode : undefined;
    if (typeof reasonCode !== 'string' || !(scorecardTemplateRetireReasonCodes as readonly string[]).includes(reasonCode)) throw badRequest('INVALID_REASONCODE', context.correlationId);
    const actorId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'jobs.draft', context.correlationId);
      const found = await tx.execute(sql`
        SELECT retired_at FROM interview_scorecard_templates WHERE id = ${templateId}::uuid AND employer_id = ${employerId}::uuid FOR UPDATE
      `) as QueryResult<{ retired_at: Date | null }>;
      const [row] = found.rows;
      if (!row) throw forbidden(context.correlationId);
      if (row.retired_at != null) throw conflict('SCORECARD_TEMPLATE_RETIRED', context.correlationId);
      await tx.execute(sql`
        UPDATE interview_scorecard_templates SET retired_at = now(), retired_by_user_id = ${actorId}::uuid
        WHERE id = ${templateId}::uuid AND employer_id = ${employerId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${actorId}::uuid, 'interview.scorecard_template.retired', 'interview_scorecard_template', ${templateId}::uuid,
          ${employerId}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify({ reasonCode })}::jsonb)
      `);
    });
    const [template] = await readScorecardTemplates(this.db, sql`t.id = ${templateId}::uuid`);
    return { template, correlationId: context.correlationId };
  }
}
