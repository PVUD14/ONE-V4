/**
 * Operations Settings — approvals for high-risk actions (OPS-02, Appendix 1 §5.4).
 *
 * File a request for one exact high-risk action, list the queue, and approve or reject.
 * The action itself is still performed by its own endpoint, which consumes the approval
 * in its transaction; nothing here changes an organisation, flag, hold, backlog or grant.
 * The rules are the pure functions in packages/authorization, and the 0038 trigger
 * repeats them for any other writer.
 *
 * Design: docs/architecture/high-risk-approvals-table-design.md
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  classifyAiLimitsChange,
  refuseAiFeatureEnable,
  approvalDecisionReasons,
  careerReleaseLabels,
  approvalRequestReasons,
  decideApproval,
  hasInternalCapability,
  highRiskActionKeys,
  highRiskActions,
  isHighRiskActionKey,
  isHighRiskFlagChange,
  isHighRiskInternalCapability,
  isInternalCapability,
  refuseApprovalRequest,
  refuseCommsTemplatePublishRequest,
  refuseInternalCapabilityGrant,
  refuseLessonPublish,
  refuseQuestionPublish,
  refuseSkillPublish,
  type ApprovalDecision,
  type HighRiskActionKey,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import { loadRequirementSetForPublish } from '@planthepath/persistence/src/career-catalogue.js';
import { loadSkillRevisionForPublish } from '@planthepath/persistence/src/skill-map.js';
import { loadQuestionRevisionForPublish } from '@planthepath/persistence/src/question-bank.js';
import { loadLessonRevisionForPublish } from '@planthepath/persistence/src/lesson-editor.js';
import { loadStatusNoticeTemplate } from '@planthepath/persistence/src/status-notices.js';
import { loadAiPolicyFacts } from '@planthepath/persistence/src/ai-operations.js';
import {
  countHighRiskApprovers,
  createOperationApproval,
  decideOperationApproval,
  listOperationApprovals,
  loadOperationApproval,
  OperationApprovalError,
  type ApprovalListState,
  type OperationApprovalRow,
} from '@planthepath/persistence/src/operation-approvals.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, readAiLimits } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };
type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const flagKeyPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const aiFeatureKeyPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const listStates: readonly ApprovalListState[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED'];
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;

@Controller('/api/v1/operations/approvals')
export class OperationsApprovalsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the confirm dialogs need: the actions, their reason codes, and whether solo applies. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireParticipant(request);
    const approverCount = await countHighRiskApprovers(this.db);
    return {
      actions: highRiskActionKeys.map((actionKey) => ({ actionKey, label: highRiskActions[actionKey].label, reasons: approvalRequestReasons[actionKey] })),
      decisionReasons: approvalDecisionReasons,
      approverCount,
      soloSafeguardActive: approverCount === 1,
      correlationId,
    };
  }

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireParticipant(request);
    if (Object.keys(query).some((key) => !['state', 'limit', 'cursor'].includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
    const state = readListState(query.state, correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const approver = hasInternalCapability(actor, 'APPROVE_HIGH_RISK');
    // Someone who cannot approve sees only what they asked for.
    const page = await listOperationApprovals(this.db, {
      ...(state ? { state } : {}), limit, ...(cursor ? { cursor } : {}), ...(approver ? {} : { requestedByUserId: actor.userId }),
    });
    const approverCount = await countHighRiskApprovers(this.db);
    return {
      approvals: page.approvals.map((row) => toApprovalDto(row, actor, approverCount)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      decisionReasons: approvalDecisionReasons,
      approverCount,
      soloSafeguardActive: approverCount === 1,
      viewerIsApprover: approver,
      correlationId,
    };
  }

  @Post()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireParticipant(request);
    const raw = readObject(body, ['actionKey', 'payload', 'note'], correlationId);
    if (!isHighRiskActionKey(raw.actionKey)) throw badRequest('APPROVAL_ACTION_INVALID', correlationId);
    const actionKey = raw.actionKey;
    if (refuseApprovalRequest(actor, actionKey)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    const note = readNote(raw.note, correlationId);
    const payload = readObject(raw.payload, payloadFields[actionKey], correlationId);
    const reasonCode = payload.reasonCode;
    if (typeof reasonCode !== 'string' || !approvalRequestReasons[actionKey].includes(reasonCode)) throw badRequest('REASON_CODE_INVALID', correlationId);
    try {
      const { targetId, canonical } = await this.validateTarget(actionKey, payload, reasonCode, actor, correlationId);
      const { id } = await createOperationApproval(this.db, {
        actionKey, targetId, payload: canonical, requestedByUserId: actor.userId, ...(note ? { note } : {}), correlationId,
      });
      const approverCount = await countHighRiskApprovers(this.db);
      const created = (await loadOperationApproval(this.db, id))!;
      return { approval: toApprovalDto(created, actor, approverCount), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:approvalId/decision')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decide(@Req() request: ProtectedHttpRequest, @Param('approvalId') approvalId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const correlationId = context.correlationId;
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'APPROVE_HIGH_RISK')) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (!uuidPattern.test(approvalId)) throw badRequest('INVALID_REQUEST', correlationId);
    const raw = readObject(body, ['decision', 'reasonCode', 'note'], correlationId);
    if (raw.decision !== 'APPROVE' && raw.decision !== 'REJECT') throw badRequest('APPROVAL_DECISION_INVALID', correlationId);
    const decision: ApprovalDecision = raw.decision;
    const reasons: readonly string[] = approvalDecisionReasons[decision];
    if (typeof raw.reasonCode !== 'string' || !reasons.includes(raw.reasonCode)) throw badRequest('REASON_CODE_INVALID', correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const decided = await decideOperationApproval(this.db, {
        approvalId: approvalId.toLowerCase(), actorUserId: actor.userId, decision, reasonCode: raw.reasonCode, ...(note ? { note } : {}), correlationId,
        decide: (facts) => decideApproval({ actor, decision, approval: facts, approverCount: facts.approverCount }),
      });
      return { approval: toApprovalDto(decided, actor, await countHighRiskApprovers(this.db)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Anyone who may perform a high-risk action or approve one. Reading the queue is
   * narrower than that for non-approvers: they see only their own requests.
   */
  private async requireParticipant(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    const participant = hasInternalCapability(actor, 'APPROVE_HIGH_RISK')
      || highRiskActionKeys.some((key) => hasInternalCapability(actor, highRiskActions[key].capability));
    if (!participant) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  /**
   * The target must exist and the change must really be high-risk, so the queue holds
   * only real decisions. Returns the canonical payload the executing endpoint will
   * rebuild from its own request.
   */
  private async validateTarget(
    actionKey: HighRiskActionKey, payload: Record<string, unknown>, reasonCode: string, actor: Actor, correlationId: string,
  ): Promise<{ readonly targetId: string; readonly canonical: Record<string, unknown> & { readonly reasonCode: string } }> {
    switch (actionKey) {
      case 'ORGANIZATION_SUSPEND': {
        const organizationId = requireUuidField(payload.organizationId, correlationId);
        const found = await this.db.execute(sql`
          SELECT verification_state FROM organizations WHERE id = ${organizationId}::uuid AND kind IN ('INSTITUTION','EMPLOYER')
        `) as QueryResult<{ verification_state: string }>;
        if (!found.rows[0]) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (found.rows[0].verification_state !== 'VERIFIED') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        return { targetId: organizationId, canonical: approvalPayloads.ORGANIZATION_SUSPEND({ organizationId, reasonCode }) };
      }
      case 'FEATURE_FLAG_HIGH_RISK_CHANGE': {
        if (typeof payload.key !== 'string' || !flagKeyPattern.test(payload.key)) throw badRequest('FEATURE_FLAG_KEY_INVALID', correlationId);
        if (typeof payload.enabled !== 'boolean') throw badRequest('FEATURE_FLAG_STATE_INVALID', correlationId);
        const key = payload.key;
        const enabled = payload.enabled;
        const found = await this.db.execute(sql`
          SELECT enabled, high_risk_direction FROM feature_flags WHERE key = ${key}
        `) as QueryResult<{ enabled: boolean; high_risk_direction: string | null }>;
        const flag = found.rows[0];
        if (!flag) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (!isHighRiskFlagChange(flag.high_risk_direction, enabled)) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        return { targetId: key, canonical: approvalPayloads.FEATURE_FLAG_HIGH_RISK_CHANGE({ key, enabled, reasonCode }) };
      }
      case 'OUTBOX_BACKLOG_SUPERSEDE': {
        if (typeof payload.olderThan !== 'string' || Number.isNaN(Date.parse(payload.olderThan))) throw badRequest('OUTBOX_CUTOFF_INVALID', correlationId);
        const limit = payload.limit === undefined ? 10_000 : payload.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100_000) throw badRequest('OUTBOX_LIMIT_INVALID', correlationId);
        return { targetId: 'backlog', canonical: approvalPayloads.OUTBOX_BACKLOG_SUPERSEDE({ olderThan: new Date(payload.olderThan), limit, reasonCode }) };
      }
      case 'PRIVACY_HOLD_RELEASE': {
        const holdId = requireUuidField(payload.holdId, correlationId);
        const found = await this.db.execute(sql`
          SELECT 1 FROM data_retention_holds WHERE id = ${holdId}::uuid AND released_at IS NULL
        `) as QueryResult<Record<string, unknown>>;
        if (!found.rows[0]) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        return { targetId: holdId, canonical: approvalPayloads.PRIVACY_HOLD_RELEASE({ holdId, reasonCode }) };
      }
      case 'CAPABILITY_GRANT_HIGH_RISK': {
        const membershipId = requireUuidField(payload.membershipId, correlationId);
        if (!isInternalCapability(payload.capability)) throw badRequest('CAPABILITY_INVALID', correlationId);
        const capability = payload.capability;
        if (!isHighRiskInternalCapability(capability)) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        const note = readNote(payload.note, correlationId);
        const found = await this.db.execute(sql`
          SELECT m.user_id, m.role, m.state::text AS state, o.kind::text AS organization_kind,
                 COALESCE(array_agg(c.capability) FILTER (WHERE c.id IS NOT NULL), '{}') AS grants
          FROM organization_memberships m
          JOIN organizations o ON o.id = m.organization_id
          LEFT JOIN membership_capabilities c ON c.membership_id = m.id AND c.revoked_at IS NULL
          WHERE m.id = ${membershipId}::uuid
          GROUP BY m.id, o.kind
        `) as QueryResult<{ user_id: string; role: string; state: string; organization_kind: string; grants: string[] }>;
        const target = found.rows[0];
        if (!target) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        // Every ordinary grant rule applies at request time too (self-grant, eligibility,
        // active, already held), so a request that could never execute is not filed.
        const refusal = refuseInternalCapabilityGrant({
          actor, capability, withApproval: true,
          target: { userId: target.user_id, role: target.role, state: target.state, organizationKind: target.organization_kind, grants: target.grants },
        });
        if (refusal) throw new HttpException(domainError(refusal, correlationId), refusal === 'CAPABILITY_SELF_CHANGE_REFUSED' || refusal === 'FORBIDDEN' ? 403 : refusal === 'CAPABILITY_ALREADY_HELD' ? 409 : 400);
        return { targetId: membershipId, canonical: approvalPayloads.CAPABILITY_GRANT_HIGH_RISK({ membershipId, capability, reasonCode, note }) };
      }
      case 'CAREER_REQUIREMENT_SET_PUBLISH': {
        const setId = requireUuidField(payload.setId, correlationId);
        if (typeof payload.releaseLabel !== 'string' || !(careerReleaseLabels as readonly string[]).includes(payload.releaseLabel)) {
          throw badRequest('CAREER_RELEASE_LABEL_INVALID', correlationId);
        }
        const set = await loadRequirementSetForPublish(this.db, setId);
        if (!set) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        // Only a set someone other than its author has reviewed can be put to an approver.
        if (set.state !== 'REVIEWED') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        return { targetId: setId, canonical: approvalPayloads.CAREER_REQUIREMENT_SET_PUBLISH({ setId, releaseLabel: payload.releaseLabel, reasonCode }) };
      }
      case 'CONTENT_SKILL_PUBLISH': {
        // OPS-09a: only an approved skill revision whose publish changes readiness inputs, and
        // only by someone who wrote none of it (they will execute it).
        const revisionId = requireUuidField(payload.revisionId, correlationId);
        const revision = await loadSkillRevisionForPublish(this.db, revisionId);
        if (!revision) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (revision.state !== 'APPROVED') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        if (!revision.needsApproval) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        const refusal = refuseSkillPublish({ actor, contributorUserIds: revision.contributorUserIds });
        if (refusal) throw new ForbiddenException(domainError(refusal, correlationId));
        return { targetId: revisionId, canonical: approvalPayloads.CONTENT_SKILL_PUBLISH({ revisionId, contentHash: revision.contentHash, reasonCode }) };
      }
      case 'CONTENT_QUESTION_PUBLISH': {
        // OPS-09b: only an approved question revision, and only by someone who wrote, edited and
        // submitted none of it (they will execute it).
        const revisionId = requireUuidField(payload.revisionId, correlationId);
        const revision = await loadQuestionRevisionForPublish(this.db, revisionId);
        if (!revision) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (revision.state !== 'APPROVED') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        if (!revision.needsApproval) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        const refusal = refuseQuestionPublish({ actor, contributorUserIds: revision.contributorUserIds });
        if (refusal) throw new ForbiddenException(domainError(refusal, correlationId));
        return { targetId: revisionId, canonical: approvalPayloads.CONTENT_QUESTION_PUBLISH({ revisionId, contentHash: revision.contentHash, reasonCode }) };
      }
      case 'CONTENT_LESSON_PUBLISH': {
        // OPS-09c: only an approved lesson revision whose publish changes completion evidence, and
        // only by someone who neither wrote, edited or submitted it nor approved it (they will execute it).
        const revisionId = requireUuidField(payload.revisionId, correlationId);
        const revision = await loadLessonRevisionForPublish(this.db, revisionId);
        if (!revision) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (revision.state !== 'APPROVED') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        if (!revision.needsApproval) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        const refusal = refuseLessonPublish({ actor, contributorUserIds: revision.contributorUserIds, approverUserId: revision.approverUserId });
        if (refusal) throw new ForbiddenException(domainError(refusal, correlationId));
        return { targetId: revisionId, canonical: approvalPayloads.CONTENT_LESSON_PUBLISH({ revisionId, contentHash: revision.contentHash, reasonCode }) };
      }
      case 'COMMS_TEMPLATE_PUBLISH': {
        // OPS-16: only a draft status notice template version, and only by its author, so the
        // approver (never the requester, except under the solo safeguard) is never the author.
        const templateId = requireUuidField(payload.templateId, correlationId);
        const template = await loadStatusNoticeTemplate(this.db, templateId);
        if (!template) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        const refusal = refuseCommsTemplatePublishRequest({ actorUserId: actor.userId, authorUserId: template.draftedBy.userId, state: template.state });
        if (refusal === 'COMMS_TEMPLATE_NOT_DRAFT') throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        if (refusal) throw new ForbiddenException(domainError(refusal, correlationId));
        return { targetId: templateId, canonical: approvalPayloads.COMMS_TEMPLATE_PUBLISH({ templateId, contentHash: template.contentHash, reasonCode }) };
      }
      case 'AI_FEATURE_ENABLE': {
        // OPS-12: only a feature that could be switched on the moment it is approved — kill switch
        // released, prompt declared, passing evaluation for its current model and prompt. The server
        // binds the model, prompt version and evaluation from the database, not from the request.
        if (typeof payload.featureKey !== 'string' || !aiFeatureKeyPattern.test(payload.featureKey)) throw badRequest('AI_FEATURE_KEY_INVALID', correlationId);
        const facts = await loadAiPolicyFacts(this.db, payload.featureKey);
        if (!facts) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        const refusal = refuseAiFeatureEnable({
          enabled: facts.enabled, killSwitchEngaged: facts.killSwitchEngaged,
          promptDeclared: facts.promptKey !== null && facts.promptVersion !== null, evaluationPasses: facts.passingEvaluationId !== null,
        });
        if (refusal === 'AI_FEATURE_ALREADY_ENABLED') throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        if (refusal) throw new ConflictException(domainError(refusal, correlationId));
        return {
          targetId: facts.featureKey,
          canonical: approvalPayloads.AI_FEATURE_ENABLE({
            featureKey: facts.featureKey, model: facts.model, promptKey: facts.promptKey!, promptVersion: facts.promptVersion!,
            evaluationId: facts.passingEvaluationId!, reasonCode,
          }),
        };
      }
      case 'AI_FEATURE_LIMITS_RAISE': {
        // OPS-12: only a change that actually widens (any increase, or a window change).
        if (typeof payload.featureKey !== 'string' || !aiFeatureKeyPattern.test(payload.featureKey)) throw badRequest('AI_FEATURE_KEY_INVALID', correlationId);
        const next = readAiLimits(payload, correlationId);
        const facts = await loadAiPolicyFacts(this.db, payload.featureKey);
        if (!facts) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (classifyAiLimitsChange({ cap: facts.cap, capWindow: facts.capWindow, maxInputChars: facts.maxInputChars }, next) !== 'RAISE') {
          throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
        }
        return { targetId: facts.featureKey, canonical: approvalPayloads.AI_FEATURE_LIMITS_RAISE({ featureKey: facts.featureKey, ...next, reasonCode }) };
      }
      case 'INSTITUTION_DATA_PURGE': {
        // INST-18: only an ended exit whose 90-day retention period has passed (database clock); a
        // request before then would expire unused, and a purge is never early.
        const offboardingId = requireUuidField(payload.offboardingId, correlationId);
        const found = await this.db.execute(sql`
          SELECT state, (retention_ends_at IS NOT NULL AND now() >= retention_ends_at) AS retention_elapsed
          FROM institution_offboardings WHERE id = ${offboardingId}::uuid
        `) as QueryResult<{ state: string; retention_elapsed: boolean }>;
        const offboarding = found.rows[0];
        if (!offboarding) throw new OperationApprovalError('APPROVAL_TARGET_NOT_FOUND');
        if (offboarding.state !== 'ENDED' || !offboarding.retention_elapsed) throw badRequest('APPROVAL_TARGET_STATE_INVALID', correlationId);
        return { targetId: offboardingId, canonical: approvalPayloads.INSTITUTION_DATA_PURGE({ offboardingId, reasonCode }) };
      }
    }
  }
}

/** Fields each action's payload may carry; anything else is rejected. */
const payloadFields: Readonly<Record<HighRiskActionKey, readonly string[]>> = {
  ORGANIZATION_SUSPEND: ['organizationId', 'reasonCode'],
  FEATURE_FLAG_HIGH_RISK_CHANGE: ['key', 'enabled', 'reasonCode'],
  OUTBOX_BACKLOG_SUPERSEDE: ['olderThan', 'limit', 'reasonCode'],
  PRIVACY_HOLD_RELEASE: ['holdId', 'reasonCode'],
  CAPABILITY_GRANT_HIGH_RISK: ['membershipId', 'capability', 'reasonCode', 'note'],
  CAREER_REQUIREMENT_SET_PUBLISH: ['setId', 'releaseLabel', 'reasonCode'],
  CONTENT_SKILL_PUBLISH: ['revisionId', 'reasonCode'],
  CONTENT_QUESTION_PUBLISH: ['revisionId', 'reasonCode'],
  CONTENT_LESSON_PUBLISH: ['revisionId', 'reasonCode'],
  COMMS_TEMPLATE_PUBLISH: ['templateId', 'reasonCode'],
  AI_FEATURE_ENABLE: ['featureKey', 'reasonCode'],
  AI_FEATURE_LIMITS_RAISE: ['featureKey', 'cap', 'capWindow', 'maxInputChars', 'reasonCode'],
  INSTITUTION_DATA_PURGE: ['offboardingId', 'reasonCode'],
};

/**
 * What the queue shows. Internal identifiers stay in `payload` for the Execute button;
 * the summary carries only names an operator recognises, and never a hold's subject.
 */
function toApprovalDto(row: OperationApprovalRow, actor: Actor, approverCount: number): Record<string, unknown> {
  const facts = {
    state: row.storedState, requestedByUserId: row.requestedByUserId, expired: row.expired, coolingOffElapsed: row.coolingOffElapsed,
    subjectUserId: row.actionKey === 'CAPABILITY_GRANT_HIGH_RISK' ? row.memberUserId : null,
  };
  const approve = decideApproval({ actor, decision: 'APPROVE', approval: facts, approverCount });
  const reject = decideApproval({ actor, decision: 'REJECT', approval: facts, approverCount });
  const own = row.requestedByUserId === actor.userId;
  const payload = row.payload;
  return {
    id: row.id,
    actionKey: row.actionKey,
    actionLabel: highRiskActions[row.actionKey].label,
    state: row.state,
    payload,
    summary: {
      organizationName: row.organizationName,
      flagKey: row.actionKey === 'FEATURE_FLAG_HIGH_RISK_CHANGE' ? payload.key ?? null : null,
      enabled: row.actionKey === 'FEATURE_FLAG_HIGH_RISK_CHANGE' ? payload.enabled ?? null : null,
      capability: row.actionKey === 'CAPABILITY_GRANT_HIGH_RISK' ? payload.capability ?? null : null,
      memberEmail: row.memberEmail,
      holdReason: row.holdReason,
      olderThan: row.actionKey === 'OUTBOX_BACKLOG_SUPERSEDE' ? payload.olderThan ?? null : null,
      limit: row.actionKey === 'OUTBOX_BACKLOG_SUPERSEDE' ? payload.limit ?? null : null,
      careerRoleTitle: row.careerRoleTitle,
      careerRoleCatalogueCode: row.careerRoleCatalogueCode,
      careerSetVersion: row.careerSetVersion,
      releaseLabel: row.actionKey === 'CAREER_REQUIREMENT_SET_PUBLISH' ? payload.releaseLabel ?? null : null,
      skillName: row.skillName,
      skillKey: row.skillKey,
      skillRevision: row.skillRevision,
      questionKey: row.questionKey,
      questionRevision: row.questionRevision,
      lessonKey: row.lessonKey,
      lessonVariant: row.lessonVariant,
      lessonRevision: row.lessonRevision,
      commsTemplateKey: row.commsTemplateKey,
      commsTemplateVersion: row.commsTemplateVersion,
      // OPS-12: the AI feature and what the approval binds (no identifiers beyond the feature key).
      aiFeatureKey: row.actionKey === 'AI_FEATURE_ENABLE' || row.actionKey === 'AI_FEATURE_LIMITS_RAISE' ? payload.featureKey ?? null : null,
      aiModel: row.actionKey === 'AI_FEATURE_ENABLE' ? payload.model ?? null : null,
      aiPromptKey: row.actionKey === 'AI_FEATURE_ENABLE' ? payload.promptKey ?? null : null,
      aiPromptVersion: row.actionKey === 'AI_FEATURE_ENABLE' ? payload.promptVersion ?? null : null,
      aiCap: row.actionKey === 'AI_FEATURE_LIMITS_RAISE' ? payload.cap ?? null : null,
      aiCapWindow: row.actionKey === 'AI_FEATURE_LIMITS_RAISE' ? payload.capWindow ?? null : null,
      aiMaxInputChars: row.actionKey === 'AI_FEATURE_LIMITS_RAISE' ? payload.maxInputChars ?? null : null,
    },
    reasonCode: row.reasonCode,
    note: row.note,
    requestedBy: { email: row.requesterEmail, isSelf: own },
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    coolingOffEndsAt: row.coolingOffEndsAt,
    decidedBy: row.deciderEmail ? { email: row.deciderEmail, isSelf: row.decidedByUserId === actor.userId } : null,
    decidedAt: row.decidedAt,
    decisionReasonCode: row.decisionReasonCode,
    mode: row.decidedAt ? (row.solo ? 'SOLO' : 'DUAL') : null,
    soloNotice: row.soloNoticeState,
    executedAt: row.executedAt,
    canApprove: !('refusal' in approve),
    canReject: !('refusal' in reject),
    approveRefusal: 'refusal' in approve ? approve.refusal : null,
    canExecute: own && row.state === 'APPROVED' && hasInternalCapability(actor, highRiskActions[row.actionKey].capability),
  };
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  // Never forward database or driver text to the browser.
  return badRequest('APPROVAL_REQUEST_REJECTED', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  return raw;
}

function requireUuidField(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}

function readNote(value: unknown, correlationId: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > noteLimit) throw badRequest('NOTE_INVALID', correlationId);
  return value.trim() || undefined;
}

function readListState(value: unknown, correlationId: string): ApprovalListState | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(listStates as readonly string[]).includes(value)) throw badRequest('APPROVAL_STATE_INVALID', correlationId);
  return value as ApprovalListState;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('APPROVAL_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(position: { readonly requestedAt: string; readonly id: string }): string {
  return Buffer.from(position.requestedAt + '|' + position.id, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly requestedAt: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('APPROVAL_CURSOR_INVALID', correlationId);
  const [requestedAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!requestedAt || !id || rest.length || Number.isNaN(Date.parse(requestedAt)) || !uuidPattern.test(id)) {
    throw badRequest('APPROVAL_CURSOR_INVALID', correlationId);
  }
  return { requestedAt, id };
}
