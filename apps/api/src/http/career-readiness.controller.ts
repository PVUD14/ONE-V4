import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  completeLesson,
  generateInstitutionAggregateReport,
  getLearnerCareerReadinessState,
  getPublishedCareerReadinessCatalog,
  getCareerReadinessOperationalStatus,
  listImportOperations,
  listImportSourceRecords,
  startAssessmentAttempt,
  submitAssessmentAttempt,
} from '@planthepath/persistence/src/career-readiness.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const institutionReportRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'];
const operationsRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'];

@Controller('/api/v1')
export class CareerReadinessController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('/career-readiness/catalog')
  catalog(): Promise<Record<string, unknown>> {
    return getPublishedCareerReadinessCatalog(this.pool);
  }

  @Get('/career-readiness/me')
  @UseGuards(ProtectedApiAuthenticationGuard)
  learnerState(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    return getLearnerCareerReadinessState(this.pool, requireLearnerId(request));
  }

  @Post('/career-readiness/lessons/:lessonVersionId/complete')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async completeLesson(
    @Req() request: ProtectedHttpRequest,
    @Param('lessonVersionId') lessonVersionId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await completeLesson(this.pool, { subjectUserId: requireLearnerId(request),
        lessonVersionId: requireUuid(lessonVersionId), correlationId: requireCorrelationId(request) });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  @Post('/career-readiness/assessments/:assessmentDefinitionId/attempts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async startAssessment(
    @Req() request: ProtectedHttpRequest,
    @Param('assessmentDefinitionId') assessmentDefinitionId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await startAssessmentAttempt(this.pool, { subjectUserId: requireLearnerId(request),
        assessmentDefinitionId: requireUuid(assessmentDefinitionId), correlationId: requireCorrelationId(request),
        selectionSeed: randomUUID() });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  @Post('/career-readiness/attempts/:attemptId/submit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submitAssessment(
    @Req() request: ProtectedHttpRequest,
    @Param('attemptId') attemptId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey || !idempotencyKeyPattern.test(idempotencyKey)) throw safeBadRequest();
    try {
      return await submitAssessmentAttempt(this.pool, { subjectUserId: requireLearnerId(request), attemptId: requireUuid(attemptId),
        idempotencyKey, selectedOptions: readSelectedOptions(body), correlationId: requireCorrelationId(request) });
    } catch (error) {
      throw mapDomainError(error);
    }
  }

  @Get('/operations/career-readiness/imports')
  @UseGuards(ProtectedApiAuthenticationGuard)
  importOperations(@Req() request: ProtectedHttpRequest): Promise<readonly Record<string, unknown>[]> {
    requireAnyActiveRole(request, operationsRoles);
    return listImportOperations(this.pool);
  }

  @Get('/operations/career-readiness/imports/:migrationRunId/records')
  @UseGuards(ProtectedApiAuthenticationGuard)
  importSourceRecords(
    @Req() request: ProtectedHttpRequest,
    @Param('migrationRunId') migrationRunId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    requireAnyActiveRole(request, operationsRoles);
    return listImportSourceRecords(this.pool, requireUuid(migrationRunId));
  }

  @Get('/operations/career-readiness/status')
  @UseGuards(ProtectedApiAuthenticationGuard)
  operationalStatus(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    requireAnyActiveRole(request, operationsRoles);
    return getCareerReadinessOperationalStatus(this.pool);
  }

  @Post('/institutions/:institutionId/career-readiness/reports')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async institutionReport(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('periodStart') periodStart: string,
    @Query('periodEnd') periodEnd: string,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const membership = request.planThePath?.authorization?.selectedMembership;
    if (!membership || membership.organizationId !== id || !institutionReportRoles.includes(membership.role)) throw safeForbidden();
    if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodEnd < periodStart) throw safeBadRequest();
    try {
      return await generateInstitutionAggregateReport(this.pool, { institutionId: id, periodStart, periodEnd });
    } catch {
      throw safeBadRequest();
    }
  }
}

function requireLearnerId(request: ProtectedHttpRequest): string {
  const id = request.planThePath?.authorization?.principal.userId;
  if (!id) throw safeForbidden();
  return id;
}

function requireCorrelationId(request: ProtectedHttpRequest): string {
  const value = request.planThePath?.correlationId;
  if (!value) throw safeForbidden();
  return value;
}

function requireAnyActiveRole(request: ProtectedHttpRequest, roles: readonly string[]): void {
  const memberships = request.planThePath?.authorization?.memberships ?? [];
  if (!memberships.some((membership) => membership.state === 'ACTIVE' && roles.includes(membership.role))) throw safeForbidden();
}

function readSelectedOptions(body: unknown): Readonly<Record<string, string>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw safeBadRequest();
  const selectedOptions = (body as Record<string, unknown>).selectedOptions;
  if (!selectedOptions || typeof selectedOptions !== 'object' || Array.isArray(selectedOptions)) throw safeBadRequest();
  const entries = Object.entries(selectedOptions as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 100) throw safeBadRequest();
  const output: Record<string, string> = {};
  for (const [questionId, optionId] of entries) {
    if (!uuidPattern.test(questionId) || typeof optionId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(optionId)) throw safeBadRequest();
    output[questionId] = optionId;
  }
  return output;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw safeBadRequest();
  return value;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime());
}

function mapDomainError(error: unknown): BadRequestException | ConflictException {
  const message = error instanceof Error ? error.message : '';
  if (/already submitted|attempt limit|idempotency/i.test(message)) {
    return new ConflictException({ error: { code: 'CONFLICT', message: 'Request conflicts with current state' } });
  }
  return safeBadRequest();
}

function safeBadRequest(): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
}

function safeForbidden(): ForbiddenException {
  return new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
}
