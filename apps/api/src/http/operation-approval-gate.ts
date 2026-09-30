/**
 * Dual control at the endpoints that perform high-risk actions (OPS-02).
 *
 * Each high-risk endpoint builds its action payload with the same function the request
 * endpoint uses, so the hash an approval was granted for is the hash of what is finally
 * done. The approval itself is consumed by `consumeOperationApproval` inside the
 * action's own transaction; this file only supplies the payload shapes, reads
 * `approvalId`, and turns refusals into safe HTTP errors.
 *
 * Design: docs/architecture/high-risk-approvals-table-design.md
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { aiCapWindows, aiMaxCap, aiMaxInputChars, aiMinInputChars, type HighRiskActionKey } from '@planthepath/authorization/src/index.js';
import { OperationApprovalError } from '@planthepath/persistence/src/operation-approvals.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical payload of each action. Identifiers and enums only, plus the reason. */
export const approvalPayloads = {
  ORGANIZATION_SUSPEND: (input: { readonly organizationId: string; readonly reasonCode: string }) =>
    ({ organizationId: input.organizationId.toLowerCase(), toState: 'SUSPENDED', reasonCode: input.reasonCode }),
  FEATURE_FLAG_HIGH_RISK_CHANGE: (input: { readonly key: string; readonly enabled: boolean; readonly reasonCode: string }) =>
    ({ key: input.key, enabled: input.enabled, reasonCode: input.reasonCode }),
  OUTBOX_BACKLOG_SUPERSEDE: (input: { readonly olderThan: Date; readonly limit: number; readonly reasonCode: string }) =>
    ({ olderThan: input.olderThan.toISOString(), limit: input.limit, reasonCode: input.reasonCode }),
  PRIVACY_HOLD_RELEASE: (input: { readonly holdId: string; readonly reasonCode: string }) =>
    ({ holdId: input.holdId.toLowerCase(), reasonCode: input.reasonCode }),
  CAPABILITY_GRANT_HIGH_RISK: (input: { readonly membershipId: string; readonly capability: string; readonly reasonCode: string; readonly note?: string | undefined }) =>
    ({ membershipId: input.membershipId.toLowerCase(), capability: input.capability, reasonCode: input.reasonCode, ...(input.note ? { note: input.note } : {}) }),
  // OPS-08: the set's items are frozen once submitted (0051 trigger), so the set id binds
  // the exact content; the label the role will carry after publishing is part of the payload.
  CAREER_REQUIREMENT_SET_PUBLISH: (input: { readonly setId: string; readonly releaseLabel: string; readonly reasonCode: string }) =>
    ({ setId: input.setId.toLowerCase(), releaseLabel: input.releaseLabel, reasonCode: input.reasonCode }),
  // OPS-09a: an APPROVED revision is frozen; its content hash makes the bound payload the exact content.
  CONTENT_SKILL_PUBLISH: (input: { readonly revisionId: string; readonly contentHash: string; readonly reasonCode: string }) =>
    ({ revisionId: input.revisionId.toLowerCase(), contentHash: input.contentHash, reasonCode: input.reasonCode }),
  // OPS-09b: the same binding for a question revision — the hash covers its answer key, tags and hints.
  CONTENT_QUESTION_PUBLISH: (input: { readonly revisionId: string; readonly contentHash: string; readonly reasonCode: string }) =>
    ({ revisionId: input.revisionId.toLowerCase(), contentHash: input.contentHash, reasonCode: input.reasonCode }),
  // OPS-09c: the same binding for a lesson revision (a base lesson or a variant).
  CONTENT_LESSON_PUBLISH: (input: { readonly revisionId: string; readonly contentHash: string; readonly reasonCode: string }) =>
    ({ revisionId: input.revisionId.toLowerCase(), contentHash: input.contentHash, reasonCode: input.reasonCode }),
  // OPS-16: a status notice template version is immutable; its content hash binds the exact wording.
  COMMS_TEMPLATE_PUBLISH: (input: { readonly templateId: string; readonly contentHash: string; readonly reasonCode: string }) =>
    ({ templateId: input.templateId.toLowerCase(), contentHash: input.contentHash, reasonCode: input.reasonCode }),
  // OPS-12: switching an AI feature on is bound to the exact model, prompt version and the passing
  // evaluation the request relied on; a later FAIL, or a model or prompt change, breaks the binding.
  AI_FEATURE_ENABLE: (input: { readonly featureKey: string; readonly model: string; readonly promptKey: string; readonly promptVersion: number; readonly evaluationId: string; readonly reasonCode: string }) =>
    ({ featureKey: input.featureKey, model: input.model, promptKey: input.promptKey, promptVersion: input.promptVersion, evaluationId: input.evaluationId.toLowerCase(), reasonCode: input.reasonCode }),
  // OPS-12: widening is bound to the exact new limits.
  AI_FEATURE_LIMITS_RAISE: (input: { readonly featureKey: string; readonly cap: number; readonly capWindow: string; readonly maxInputChars: number; readonly reasonCode: string }) =>
    ({ featureKey: input.featureKey, cap: input.cap, capWindow: input.capWindow, maxInputChars: input.maxInputChars, reasonCode: input.reasonCode }),
  // INST-18: an exit's institution-owned records are deleted once; the exit id binds which college.
  INSTITUTION_DATA_PURGE: (input: { readonly offboardingId: string; readonly reasonCode: string }) =>
    ({ offboardingId: input.offboardingId.toLowerCase(), reasonCode: input.reasonCode }),
} satisfies Record<HighRiskActionKey, (input: never) => Record<string, unknown> & { reasonCode: string }>;

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

/** `approvalId` from a request body: absent, or a UUID. */
export function readApprovalId(body: unknown, correlationId: string): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).approvalId;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new BadRequestException(domainError('APPROVAL_ID_INVALID', correlationId));
  return value.toLowerCase();
}

/** 403 APPROVAL_REQUIRED: the one answer a high-risk action gives without an approval. */
export function approvalRequired(correlationId: string): ForbiddenException {
  return new ForbiddenException(domainError('APPROVAL_REQUIRED', correlationId));
}

/** An approvalId sent with a change that does not need one is a mistake worth naming. */
export function approvalNotRequired(correlationId: string): BadRequestException {
  return new BadRequestException(domainError('APPROVAL_NOT_REQUIRED', correlationId));
}

/** Map an approval refusal to its HTTP form, or return null if the error is not one. */
export function approvalHttpError(error: unknown, correlationId: string): HttpException | null {
  if (!(error instanceof OperationApprovalError)) return null;
  switch (error.code) {
    case 'APPROVAL_NOT_FOUND':
    case 'APPROVAL_TARGET_NOT_FOUND':
      return new NotFoundException(domainError(error.code, correlationId));
    case 'APPROVAL_NOT_PENDING':
      return new ConflictException(domainError(error.code, correlationId));
    case 'APPROVAL_NOT_REQUIRED':
      return new BadRequestException(domainError(error.code, correlationId));
    default:
      return new ForbiddenException(domainError(error.code, correlationId));
  }
}

/** OPS-12: new AI limits from a request, within 0033's bounds. */
export function readAiLimits(payload: Record<string, unknown>, correlationId: string): { readonly cap: number; readonly capWindow: 'DAY' | 'MONTH'; readonly maxInputChars: number } {
  const { cap, capWindow, maxInputChars } = payload;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > aiMaxCap) throw new BadRequestException(domainError('AI_CAP_INVALID', correlationId));
  if (typeof capWindow !== 'string' || !(aiCapWindows as readonly string[]).includes(capWindow)) throw new BadRequestException(domainError('AI_CAP_WINDOW_INVALID', correlationId));
  if (typeof maxInputChars !== 'number' || !Number.isInteger(maxInputChars) || maxInputChars < aiMinInputChars || maxInputChars > aiMaxInputChars) {
    throw new BadRequestException(domainError('AI_INPUT_LIMIT_INVALID', correlationId));
  }
  return { cap, capWindow: capWindow as 'DAY' | 'MONTH', maxInputChars };
}
