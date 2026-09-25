/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Academic records: a student declares, the issuing institution verifies.
 *
 * Design frozen in docs/architecture/academic-records-table-design.md. Two of its
 * resolutions are visible in the routes below:
 *
 *   Only the issuing institution may verify. The institution routes are scoped by
 *   `institutionId` and the update is additionally scoped by `q.institution_id`, so a
 *   second institution cannot verify a record it did not issue.
 *
 *   Verification is permanent. There is no un-verify route, and the trigger in 0070
 *   refuses one at the database if anybody writes it later.
 *
 * Read access to another person's record is deliberately absent here: institution
 * staff read the verification queue for their own institution, which is the narrowest
 * read that lets them do the job, and nothing exposes a student's record by id.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  AcademicRecordError,
  declareQualification,
  declareTerm,
  decideTermVerification,
  listAcademicRecords,
  listVerificationQueue,
  searchInstitutions,
  submitTermForVerification,
  verificationQueueSummary,
  type ResultScale,
} from '@planthepath/persistence/src/academic-records.js';
import {
  commitResultsImport,
  previewResultsImport,
  ResultsImportRejected,
} from '@planthepath/persistence/src/academic-results-import.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeFor } from './institution-student-scope.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Same set staff_actions uses for ACADEMIC_VERIFICATION; Faculty included by design. */
const verificationRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];

/**
 * Bulk results upload is a registrar's act: the office, or a head of department for their
 * own department (INST-04 design). Faculty and placement admins confirm one at a time.
 */
const resultsImportRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'DEPARTMENT_HEAD'];
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

const qualificationTypes = ['BTECH', 'BE', 'BSC', 'BA', 'BCOM', 'BBA', 'BCA', 'MBBS', 'BDS', 'DIPLOMA',
  'MTECH', 'ME', 'MBA', 'MSC', 'MA', 'MCOM', 'MCA', 'PHD', 'OTHER'];
const resultScales: readonly ResultScale[] = ['CGPA_10', 'GPA_4', 'PERCENTAGE', 'LETTER', 'PASS_FAIL'];

@Controller('/api/v1')
export class AcademicRecordsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('/students/me/academic-records')
  @UseGuards(ProtectedApiAuthenticationGuard)
  mine(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    return listAcademicRecords(this.pool, requireLearnerId(request));
  }

  @Post('/students/me/academic-records/qualifications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addQualification(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const studentUserId = requireLearnerId(request);
    try {
      const created = await declareQualification(this.pool, { ...readQualification(body), studentUserId });
      return { ...created, ...(await listAcademicRecords(this.pool, studentUserId)) };
    } catch (error) {
      throw mapAcademicError(error);
    }
  }

  @Post('/students/me/academic-records/qualifications/:qualificationId/terms')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addTerm(
    @Req() request: ProtectedHttpRequest,
    @Param('qualificationId') qualificationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const studentUserId = requireLearnerId(request);
    try {
      const created = await declareTerm(this.pool, {
        ...readTerm(body), studentUserId, qualificationId: requireUuid(qualificationId),
      });
      return { ...created, ...(await listAcademicRecords(this.pool, studentUserId)) };
    } catch (error) {
      throw mapAcademicError(error);
    }
  }

  @Post('/students/me/academic-records/terms/:termId/submit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submit(@Req() request: ProtectedHttpRequest, @Param('termId') termId: string): Promise<Record<string, unknown>> {
    const studentUserId = requireLearnerId(request);
    try {
      await submitTermForVerification(this.pool, { studentUserId, termId: requireUuid(termId) });
    } catch (error) {
      throw mapAcademicError(error);
    }
    return listAcademicRecords(this.pool, studentUserId);
  }

  /**
   * Institutions a student can name as the issuer of a qualification.
   *
   * Without this there is no way to set `institutionId` except by already knowing a UUID,
   * which is why nobody who has left an institution has ever been able to ask it to verify
   * anything. Identity only: name and place, nothing an institution did not publish.
   */
  @Get('/institutions/directory')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async directory(@Req() request: ProtectedHttpRequest, @Query('q') query?: string): Promise<Record<string, unknown>> {
    requireLearnerId(request);
    return { institutions: await searchInstitutions(this.pool, typeof query === 'string' ? query : '') };
  }

  @Get('/institutions/:institutionId/academic-verification-queue')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async queue(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    requireInstitutionStaff(request, id);
    const page = readPage(limit, after);
    const scope = await institutionStudentScopeFor(this.pool, request, id, verificationRoles);
    return queuePage(await listVerificationQueue(this.pool, id, scope, page), page.limit);
  }

  /** Counts for the dashboards, over the same scoped rows as the queue. */
  @Get('/institutions/:institutionId/academic-verification-summary')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async summary(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    requireInstitutionStaff(request, id);
    const scope = await institutionStudentScopeFor(this.pool, request, id, verificationRoles);
    return { summary: await verificationQueueSummary(this.pool, id, scope) };
  }

  @Post('/institutions/:institutionId/academic-verification/:termId/decide')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decide(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('termId') termId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const reviewerUserId = requireInstitutionStaff(request, id);
    const term = requireUuid(termId);
    // A reviewer may only decide a term they can see in their own queue (INST-02 scope).
    // Checked before the body is read, so an out-of-scope caller learns nothing more.
    const scope = await institutionStudentScopeFor(this.pool, request, id, verificationRoles);
    if (scope.kind !== 'INSTITUTION' && !(await termInScope(this.pool, id, scope, term))) throw safeForbidden();
    const { decision, reasonCode } = readDecision(body);
    try {
      await decideTermVerification(this.pool, {
        institutionId: id, reviewerUserId, termId: term, decision, reasonCode, correlationId: correlationIdOf(request),
      });
    } catch (error) {
      throw mapAcademicError(error);
    }
    const page = readPage(undefined, undefined);
    return queuePage(await listVerificationQueue(this.pool, id, scope, page), page.limit);
  }

  /**
   * Bulk results upload, step one: a validated preview with row-level issues. Nothing is
   * written except the audit row. The digest it returns is what commit must match.
   */
  @Post('/institutions/:institutionId/academic-results-imports/preview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async previewResults(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireInstitutionStaff(request, id, resultsImportRoles);
    const input = readResultsUpload(body, false);
    const scope = await institutionStudentScopeFor(this.pool, request, id, resultsImportRoles);
    try {
      const preview = await previewResultsImport(this.pool, {
        institutionId: id, scope, csv: input.csv, filename: input.filename, actorUserId, correlationId: correlationIdOf(request),
      });
      return { preview };
    } catch (error) {
      throw mapAcademicError(error);
    }
  }

  /**
   * Step two: commit exactly the preview the uploader saw. Invalid rows write nothing;
   * a changed evaluation writes nothing and asks for a fresh preview; conflicts are
   * reported and left as they are.
   */
  @Post('/institutions/:institutionId/academic-results-imports/commit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async commitResults(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireInstitutionStaff(request, id, resultsImportRoles);
    const input = readResultsUpload(body, true);
    const scope = await institutionStudentScopeFor(this.pool, request, id, resultsImportRoles);
    try {
      const committed = await commitResultsImport(this.pool, {
        institutionId: id, scope, csv: input.csv, filename: input.filename, previewDigest: input.previewDigest ?? '',
        reasonCode: input.reasonCode ?? '', actorUserId, correlationId: correlationIdOf(request),
      });
      return { import: { reference: committed.reference, created: committed.created, confirmed: committed.confirmed,
        counts: committed.evaluation.counts, rows: committed.evaluation.rows } };
    } catch (error) {
      if (error instanceof ResultsImportRejected) {
        const payload = { error: { code: error.code }, preview: error.evaluation };
        throw error.code === 'RESULTS_IMPORT_STALE' ? new ConflictException(payload) : new BadRequestException(payload);
      }
      if (error instanceof AcademicRecordError && error.code === 'RESULTS_IMPORT_STALE') {
        throw new ConflictException({ error: { code: error.code } });
      }
      throw mapAcademicError(error);
    }
  }
}

function queuePage(queue: readonly Record<string, unknown>[], limit: number): Record<string, unknown> {
  return { queue, nextCursor: queue.length === limit ? queue[queue.length - 1]?.['termId'] ?? null : null };
}

async function termInScope(pool: Pool, institutionId: string, scope: InstitutionStudentScope, termId: string): Promise<boolean> {
  // Page through the scoped queue rather than widening it: the queue is the definition of
  // what this reader may decide.
  let after: string | null = null;
  for (;;) {
    const page = await listVerificationQueue(pool, institutionId, scope, { limit: 200, after });
    if (page.some((item) => item['termId'] === termId)) return true;
    if (page.length < 200) return false;
    after = page[page.length - 1]?.['termId'] as string;
  }
}

function readPage(limit: string | undefined, after: string | undefined): { readonly limit: number; readonly after: string | null } {
  let size = 50;
  if (limit !== undefined) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw safeBadRequest();
    size = Number(limit);
  }
  return { limit: size, after: after === undefined || after === '' ? null : requireUuid(after) };
}

function readResultsUpload(body: unknown, commit: boolean): { csv: string; filename: string; previewDigest?: string; reasonCode?: string } {
  const raw = readObject(body);
  const allowed = commit ? ['csv', 'filename', 'previewDigest', 'reasonCode'] : ['csv', 'filename'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw safeBadRequest();
  const csv = raw.csv;
  if (typeof csv !== 'string' || csv.length === 0 || csv.length > 512_000) throw safeBadRequest();
  const filename = optionalText(raw.filename, 160) ?? 'results.csv';
  if (!commit) return { csv, filename };
  const previewDigest = raw.previewDigest;
  if (typeof previewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(previewDigest)) throw safeBadRequest();
  const reasonCode = raw.reasonCode;
  if (typeof reasonCode !== 'string' || !reasonCodePattern.test(reasonCode)) throw safeBadRequest();
  return { csv, filename, previewDigest, reasonCode };
}

function correlationIdOf(request: ProtectedHttpRequest): string {
  return request.planThePath?.correlationId ?? 'academic-records';
}

function requireLearnerId(request: ProtectedHttpRequest): string {
  const id = request.planThePath?.authorization?.principal.userId;
  if (!id) throw safeForbidden();
  return id;
}

/**
 * An active staff membership scoped to this institution. Both the organization and
 * the scope must match, so a membership in one institution cannot act on another.
 */
function requireInstitutionStaff(request: ProtectedHttpRequest, institutionId: string, roles: readonly string[] = verificationRoles): string {
  const authorization = request.planThePath?.authorization;
  const userId = authorization?.principal.userId;
  const permitted = (authorization?.memberships ?? []).some((membership) => (
    membership.state === 'ACTIVE'
    && roles.includes(membership.role)
    && membership.organizationId === institutionId
    && membership.scope.organizationId === institutionId
  ));
  if (!userId || !permitted) throw safeForbidden();
  return userId;
}

function readQualification(body: unknown): {
  readonly institutionId: string | null;
  readonly institutionNameDeclared: string | null;
  readonly qualificationType: string;
  readonly programmeName: string;
  readonly startedOn: string | null;
  readonly completedOn: string | null;
  readonly awarded: boolean;
} {
  const raw = readObject(body);
  const institutionId = optionalUuid(raw.institutionId);
  const institutionNameDeclared = optionalText(raw.institutionNameDeclared, 200);
  // Exactly one identifies the issuer: a ONE organization, or a name we will never
  // treat as verified.
  if ((institutionId === null) === (institutionNameDeclared === null)) throw safeBadRequest();
  const qualificationType = raw.qualificationType;
  if (typeof qualificationType !== 'string' || !qualificationTypes.includes(qualificationType)) throw safeBadRequest();
  const programmeName = optionalText(raw.programmeName, 200);
  if (!programmeName) throw safeBadRequest();
  return {
    institutionId,
    institutionNameDeclared,
    qualificationType,
    programmeName,
    startedOn: optionalDate(raw.startedOn),
    completedOn: optionalDate(raw.completedOn),
    awarded: raw.awarded === true,
  };
}

function readTerm(body: unknown): {
  readonly sequence: number;
  readonly label: string;
  readonly resultValue: number | null;
  readonly resultScale: ResultScale | null;
  readonly resultLetter: string | null;
  readonly backlogCount: number | null;
  readonly evidenceDocumentVersionId: string | null;
} {
  const raw = readObject(body);
  const sequence = raw.sequence;
  if (!Number.isInteger(sequence) || (sequence as number) < 1 || (sequence as number) > 30) throw safeBadRequest();
  const label = optionalText(raw.label, 80);
  if (!label) throw safeBadRequest();

  const resultScale = raw.resultScale === undefined || raw.resultScale === null
    ? null
    : resultScales.includes(raw.resultScale as ResultScale) ? raw.resultScale as ResultScale : null;
  if (raw.resultScale !== undefined && raw.resultScale !== null && resultScale === null) throw safeBadRequest();

  const resultValue = raw.resultValue === undefined || raw.resultValue === null ? null : Number(raw.resultValue);
  if (resultValue !== null && !Number.isFinite(resultValue)) throw safeBadRequest();
  const resultLetter = optionalText(raw.resultLetter, 16);
  // The value/scale pairing is a database constraint; rejecting it here too means the
  // caller gets a field error rather than a generic write failure.
  if ((resultValue !== null || resultLetter !== null) && resultScale === null) throw safeBadRequest();

  const backlogCount = raw.backlogCount === undefined || raw.backlogCount === null ? null : Number(raw.backlogCount);
  if (backlogCount !== null && (!Number.isInteger(backlogCount) || backlogCount < 0)) throw safeBadRequest();

  return {
    sequence: sequence as number,
    label,
    resultValue,
    resultScale,
    resultLetter,
    backlogCount,
    evidenceDocumentVersionId: optionalUuid(raw.evidenceDocumentVersionId),
  };
}

function readDecision(body: unknown): { decision: 'VERIFIED' | 'REJECTED'; reasonCode: string } {
  const raw = readObject(body);
  if (Object.keys(raw).some((key) => key !== 'decision' && key !== 'reasonCode')) throw safeBadRequest();
  const { decision, reasonCode } = raw;
  if (decision !== 'VERIFIED' && decision !== 'REJECTED') throw safeBadRequest();
  // Section 5.4: every verification decision carries a reason code.
  if (typeof reasonCode !== 'string' || !reasonCodePattern.test(reasonCode)) throw safeBadRequest();
  return { decision, reasonCode };
}

function readObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw safeBadRequest();
  return body as Record<string, unknown>;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw safeBadRequest();
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Mirrors the database's formula-injection guard: these strings reach CSV exports.
  if (/^[=+@-]/.test(trimmed)) throw safeBadRequest();
  return trimmed;
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw safeBadRequest();
  return value;
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw safeBadRequest();
  }
  return value;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw safeBadRequest();
  return value;
}

function mapAcademicError(error: unknown): BadRequestException | NotFoundException {
  if (error instanceof AcademicRecordError) {
    if (error.code.endsWith('NOT_FOUND')) return new NotFoundException({ error: { code: error.code } });
    return new BadRequestException({ error: { code: error.code } });
  }
  return safeBadRequest();
}

function safeBadRequest(): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
}

function safeForbidden(): ForbiddenException {
  return new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
}
