/**
 * Year-end batch actions (INST-10): graduate, transfer or end the relationships of a batch or a
 * list of roll numbers — preview, then commit exactly what was previewed.
 *
 * Owners and admins only, as for the per-student relationship endpoint: roster and relationship
 * writes are theirs. The target is still limited to the caller's write scope through the single
 * scope helper (INST-SR-02), so the rule is not written a second time the day a narrower role is
 * admitted. Nothing but relationship state, roster status and pending invitations changes; the
 * student keeps their account, records and consents as a former student.
 * Design: docs/architecture/institution-batch-lifecycle-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpException, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  relationshipBatchMaxStudents,
  relationshipBatchStates,
  relationshipReasonCodePattern,
  type RelationshipBatchState,
} from '@planthepath/authorization/src/index.js';
import {
  RelationshipBatchRejected,
  commitRelationshipBatch,
  previewRelationshipBatch,
  type RelationshipBatchEvaluation,
  type RelationshipBatchTarget,
} from '@planthepath/persistence/src/institution-relationship-batches.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { institutionStudentWriteScopeFor } from './institution-student-scope.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const batchRoles: readonly string[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const previewFields = new Set(['state', 'unitId', 'institutionStudentIds', 'effectiveTo']);
const commitFields = new Set([...previewFields, 'previewDigest', 'reasonCode']);

interface BatchRequest {
  readonly state: RelationshipBatchState;
  readonly target: RelationshipBatchTarget;
  readonly effectiveTo: string | null;
}

@Controller('/api/v1')
export class InstitutionRelationshipBatchesController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Post('/institutions/:institutionId/relationship-batches/preview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async preview(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id, scope } = await this.authorise(request, institutionId);
    const input = readBatch(body, previewFields, context.correlationId);
    try {
      const evaluation = await previewRelationshipBatch(this.db, { ...input, institutionId: id, scope,
        actorUserId: context.authorization.principal.userId, correlationId: context.correlationId });
      return { batch: present(evaluation), correlationId: context.correlationId };
    } catch (error) {
      throw batchError(error, context.correlationId);
    }
  }

  @Post('/institutions/:institutionId/relationship-batches/commit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async commit(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id, scope } = await this.authorise(request, institutionId);
    const input = readBatch(body, commitFields, context.correlationId);
    const record = body as Record<string, unknown>;
    const reasonCode = typeof record.reasonCode === 'string' ? record.reasonCode : '';
    if (!relationshipReasonCodePattern.test(reasonCode)) throw badRequest('REASON_CODE_REQUIRED', context.correlationId, 'reasonCode');
    const previewDigest = typeof record.previewDigest === 'string' ? record.previewDigest : '';
    if (!/^[0-9a-f]{64}$/.test(previewDigest)) throw badRequest('PREVIEW_DIGEST_REQUIRED', context.correlationId, 'previewDigest');
    try {
      const result = await commitRelationshipBatch(this.db, { ...input, institutionId: id, scope, previewDigest, reasonCode,
        actorUserId: context.authorization.principal.userId, correlationId: context.correlationId });
      return { batch: { ...present(result.evaluation), reference: result.reference, changed: result.changed, effectiveTo: result.effectiveTo }, correlationId: context.correlationId };
    } catch (error) {
      throw batchError(error, context.correlationId);
    }
  }

  private async authorise(request: ProtectedHttpRequest, institutionId: string) {
    const context = requireTrustedAuthorization(request);
    if (!uuidPattern.test(institutionId)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const member = context.authorization.memberships.some((membership) => membership.state === 'ACTIVE'
      && membership.organizationId === institutionId && membership.scope.organizationId === institutionId
      && membership.scope.institutionId === institutionId && batchRoles.includes(membership.role));
    if (!member) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const scope = await institutionStudentWriteScopeFor(this.db, request, institutionId, batchRoles);
    if (scope.kind === 'NONE') {
      throw new ForbiddenException({ error: { code: 'SCOPE_REQUIRED', message: 'A department or teaching assignment is required for this change', correlationId: context.correlationId } });
    }
    return { context, id: institutionId, scope };
  }
}

function readBatch(body: unknown, allowed: ReadonlySet<string>, correlationId: string): BatchRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_INPUT', correlationId);
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw badRequest('UNKNOWN_FIELD', correlationId, unknown);
  const state = record.state;
  if (typeof state !== 'string' || !(relationshipBatchStates as readonly string[]).includes(state)) throw badRequest('INVALID_STATE', correlationId, 'state');
  const hasUnit = record.unitId !== undefined;
  const hasIds = record.institutionStudentIds !== undefined;
  if (hasUnit === hasIds) throw badRequest('INVALID_TARGET', correlationId, 'target');
  let target: RelationshipBatchTarget;
  if (hasUnit) {
    if (typeof record.unitId !== 'string' || !uuidPattern.test(record.unitId)) throw badRequest('UNIT_ID_INVALID', correlationId, 'unitId');
    target = { unitId: record.unitId };
  } else {
    const ids = record.institutionStudentIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > relationshipBatchMaxStudents
      || ids.some((value) => typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 64)) {
      throw badRequest('INVALID_TARGET', correlationId, 'institutionStudentIds');
    }
    target = { institutionStudentIds: ids as string[] };
  }
  let effectiveTo: string | null = null;
  if (record.effectiveTo !== undefined && record.effectiveTo !== null) {
    if (typeof record.effectiveTo !== 'string' || !isoDateTimePattern.test(record.effectiveTo) || Number.isNaN(Date.parse(record.effectiveTo))) {
      throw badRequest('INVALID_EFFECTIVE_DATE', correlationId, 'effectiveTo');
    }
    effectiveTo = new Date(record.effectiveTo).toISOString();
  }
  return { state: state as RelationshipBatchState, target, effectiveTo };
}

function present(evaluation: RelationshipBatchEvaluation): Record<string, unknown> {
  return { state: evaluation.state, effectiveTo: evaluation.effectiveTo, counts: evaluation.counts, digest: evaluation.digest, rows: evaluation.rows };
}

function batchError(error: unknown, correlationId: string): Error {
  if (!(error instanceof RelationshipBatchRejected)) throw error;
  const body = (message: string) => ({ error: { code: error.code, message, correlationId },
    ...(error.evaluation ? { batch: present(error.evaluation) } : {}) });
  switch (error.code) {
    case 'EFFECTIVE_DATE_IN_FUTURE': return new BadRequestException(body('The effective date cannot be in the future. Prepare the batch now and commit it on the day.'));
    case 'UNIT_ID_INVALID': return new BadRequestException(body('That unit is not part of this institution.'));
    case 'BATCH_TOO_LARGE': return new HttpException(body(`A batch can change at most ${relationshipBatchMaxStudents} students. Choose a smaller unit.`), HttpStatus.UNPROCESSABLE_ENTITY);
    case 'BATCH_HAS_INVALID_ROWS': return new BadRequestException(body('Some rows cannot be changed. Nothing was saved.'));
    case 'NOTHING_TO_CHANGE': return new BadRequestException(body('No student in this selection has a current relationship to change.'));
    case 'BATCH_PREVIEW_STALE': return new ConflictException(body('The roster changed since the preview. Nothing was saved; preview again.'));
  }
}

function badRequest(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed.', correlationId, ...(field ? { field } : {}) } });
}
