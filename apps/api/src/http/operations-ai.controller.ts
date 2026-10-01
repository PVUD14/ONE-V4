/**
 * Operations AI Operations console (OPS-12, Appendix 1 §3 AI operations, §5.4).
 *
 * Reads usage, outcomes, failure classes, tokens, prompt versions and evaluation records from ONE
 * AI Orchestration's own tables (AI_OPS_VIEW); cost is NA because no price table exists. Writes:
 * switch a feature off, engage the global kill switch, switch the in-app assistant off — immediate,
 * no approval (AI_OPS_CONFIGURE or OPS_FLAGS_MANAGE); switch a feature on and widen its limits —
 * AI_OPS_CONFIGURE plus an OPS-02 approval, and for switching on a passing evaluation for the
 * current model and prompt version; record an evaluation (AI_OPS_CONFIGURE). Every write is audited
 * with its reason code. Releasing the kill switch and switching the assistant on are high-risk flag
 * changes through the existing feature-flag endpoint and its approval.
 *
 * Nothing here calls a model or the inference endpoint (CLAUDE.md: no request handler does). ENG-20
 * adds the endpoint's status to the summary — configured, host, model, key set or not (never the
 * key), and reachability from the latest `ai:probe` row. The assistant's server switch
 * (ASSISTANT_ENABLED) is shown, never changed.
 *
 * Design: docs/architecture/ai-evaluations-table-design.md
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
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  aiAssistantDisableReasons,
  aiAssistantFlagKey,
  aiCapWindows,
  aiConfigureIsBreakGlass,
  aiCostBasis,
  aiCostBasisText,
  aiEvaluationDecisions,
  aiEvaluationRecordReasons,
  aiFeatureDisableReasons,
  aiFeatureEnableReasons,
  aiKillSwitchEngageReasons,
  aiKillSwitchFlagKey,
  aiLimitsLowerReasons,
  aiLimitsRaiseReasons,
  aiMaxCap,
  aiMaxInputChars,
  aiMaxMetrics,
  aiMinInputChars,
  aiStopIsBreakGlass,
  approvalRequestReasons,
  canConfigureAi,
  canStopAi,
  canViewAiOperations,
  readAiEvaluationMetrics,
  readEngineHealthWindowDays,
  aggregateSuppressionThreshold,
  type AiEvaluationDecision,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  AiOperationsError,
  changeAiFeatureLimits,
  disableAiAssistant,
  disableAiFeature,
  enableAiFeature,
  engageAiKillSwitch,
  listAiEvaluations,
  listAiUsageByOrganization,
  listAiUsageSeries,
  loadAiInferenceStatus,
  loadAiOperationsSummary,
  recordAiEvaluation,
  type AiActor,
  type AiPeriod,
} from '@planthepath/persistence/src/ai-operations.js';
import { loadMasteryShadowHealth, loadPlannerHealth } from '@planthepath/persistence/src/engine-health.js';
import {
  TUTOR_REVIEW_APPROVE_REASONS,
  TUTOR_REVIEW_REJECT_REASONS,
  TUTOR_REVIEW_VIEWS,
  TutorHintReviewError,
  listTutorHintsForReview,
  reviewTutorHint,
  type TutorReviewListView,
} from '@planthepath/persistence/src/tutor-hints.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, readAiLimits, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const featureKeyPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const providerKeyPattern = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const periods: readonly AiPeriod[] = ['DAY', 'MONTH'];
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;

/**
 * The assistant's server switch, read the way AssistantService reads it. Only whether each is set
 * leaves the server — never a value.
 */
export function assistantServerConfiguration(env: NodeJS.ProcessEnv = process.env): { readonly serverSwitch: boolean; readonly providerKeyConfigured: boolean } {
  return { serverSwitch: env.ASSISTANT_ENABLED === 'true', providerKeyConfigured: Boolean(env.ANTHROPIC_API_KEY) };
}

@Controller('/api/v1/operations/ai')
export class OperationsAiController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the screen's forms need: reason codes, bounds, what the caller may do, and the cost basis. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireView(request);
    return {
      reasons: {
        disable: aiFeatureDisableReasons,
        enable: aiFeatureEnableReasons,
        limitsLower: aiLimitsLowerReasons,
        limitsRaise: aiLimitsRaiseReasons,
        killSwitchEngage: aiKillSwitchEngageReasons,
        assistantDisable: aiAssistantDisableReasons,
        evaluation: aiEvaluationRecordReasons,
        // Releasing the kill switch and switching the assistant on are FEATURE_FLAG_HIGH_RISK_CHANGE requests.
        flagChange: approvalRequestReasons.FEATURE_FLAG_HIGH_RISK_CHANGE,
      },
      bounds: { capWindows: aiCapWindows, maxCap: aiMaxCap, minInputChars: aiMinInputChars, maxInputChars: aiMaxInputChars, maxMetrics: aiMaxMetrics },
      decisions: aiEvaluationDecisions,
      flags: { killSwitch: aiKillSwitchFlagKey, assistant: aiAssistantFlagKey },
      viewer: { canStop: canStopAi(actor), canConfigure: canConfigureAi(actor) },
      cost: { basis: aiCostBasis, text: aiCostBasisText },
      correlationId,
    };
  }

  @Get('/summary')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async summary(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireView(request);
    rejectUnknown(query, ['period'], correlationId);
    const period = readPeriod(query.period, correlationId) ?? 'DAY';
    const summary = await loadAiOperationsSummary(this.db, { period });
    const server = assistantServerConfiguration();
    const killEngaged = summary.killSwitch?.enabled ?? false;
    const consoleSwitch = summary.assistantFlag?.enabled ?? false;
    return {
      ...summary,
      assistant: {
        ...server,
        consoleSwitch,
        killSwitchEngaged: killEngaged,
        answering: server.serverSwitch && server.providerKeyConfigured && consoleSwitch && !killEngaged,
      },
      inference: await loadAiInferenceStatus(this.db),
      cost: { value: null, basis: aiCostBasis, text: aiCostBasisText },
      correlationId,
    };
  }

  /**
   * OPS-13: how the adaptive engine decides — planner decisions per day and the override rate
   * (learning_decisions), and the mastery shadow comparison (learner_skill_state against the live
   * bands, adaptive-learning holders only). Aggregates only; groups under five are withheld.
   * Design: docs/architecture/engine-health-panels-design.md
   */
  @Get('/engine-health')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async engineHealth(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireView(request);
    rejectUnknown(query, ['days'], correlationId);
    const days = readEngineHealthWindowDays(query.days);
    if (days === null) throw badRequest('ENGINE_HEALTH_DAYS_INVALID', correlationId);
    const [planner, masteryShadow] = [await loadPlannerHealth(this.db, days), await loadMasteryShadowHealth(this.db)];
    return { planner, masteryShadow, suppressionThreshold: aggregateSuppressionThreshold, correlationId };
  }

  @Get('/usage')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async usage(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireView(request);
    rejectUnknown(query, ['granularity', 'featureKey'], correlationId);
    const granularity = readPeriod(query.granularity, correlationId) ?? 'DAY';
    const featureKey = optionalFeatureKey(query.featureKey, correlationId);
    return { granularity, points: await listAiUsageSeries(this.db, { granularity, ...(featureKey ? { featureKey } : {}) }), correlationId };
  }

  @Get('/usage/organizations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async usageByOrganization(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireView(request);
    rejectUnknown(query, ['period'], correlationId);
    const period = readPeriod(query.period, correlationId) ?? 'MONTH';
    return { period, organizations: await listAiUsageByOrganization(this.db, { period }), suppressionThreshold: 5, correlationId };
  }

  @Get('/evaluations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async evaluations(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireView(request);
    rejectUnknown(query, ['featureKey', 'limit', 'cursor'], correlationId);
    const featureKey = optionalFeatureKey(query.featureKey, correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listAiEvaluations(this.db, { ...(featureKey ? { featureKey } : {}), limit, ...(cursor ? { cursor } : {}) });
    return { evaluations: page.evaluations, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null, correlationId };
  }

  @Post('/evaluations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async recordEvaluation(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireConfigure(request);
    const raw = readObject(body, ['featureKey', 'providerKey', 'model', 'promptKey', 'promptVersion', 'evaluationSetKey', 'evaluationSetVersion', 'metrics', 'decision', 'reasonCode', 'note'], correlationId);
    const featureKey = requireFeatureKey(raw.featureKey, correlationId);
    if (typeof raw.providerKey !== 'string' || !providerKeyPattern.test(raw.providerKey)) throw badRequest('AI_PROVIDER_KEY_INVALID', correlationId);
    if (typeof raw.model !== 'string' || raw.model.trim().length < 1 || raw.model.length > 200 || raw.model.trim() !== raw.model) throw badRequest('AI_MODEL_INVALID', correlationId);
    if (typeof raw.promptKey !== 'string' || !featureKeyPattern.test(raw.promptKey)) throw badRequest('AI_PROMPT_KEY_INVALID', correlationId);
    const promptVersion = requireVersion(raw.promptVersion, 'AI_PROMPT_VERSION_INVALID', correlationId);
    if (typeof raw.evaluationSetKey !== 'string' || !featureKeyPattern.test(raw.evaluationSetKey)) throw badRequest('AI_EVALUATION_SET_INVALID', correlationId);
    const evaluationSetVersion = requireVersion(raw.evaluationSetVersion, 'AI_EVALUATION_SET_INVALID', correlationId);
    if (raw.decision !== 'PASS' && raw.decision !== 'FAIL') throw badRequest('AI_EVALUATION_DECISION_INVALID', correlationId);
    const decision: AiEvaluationDecision = raw.decision;
    const reasonCode = readReason(raw.reasonCode, aiEvaluationRecordReasons, correlationId);
    const note = readNote(raw.note, correlationId);
    const metrics = readAiEvaluationMetrics(raw.metrics, decision);
    if ('refusal' in metrics) throw badRequest(metrics.refusal, correlationId);
    try {
      const evaluation = await recordAiEvaluation(this.db, this.aiActor(actor, correlationId, 'CONFIGURE'), {
        featureKey, providerKey: raw.providerKey, model: raw.model, promptKey: raw.promptKey, promptVersion, evaluationSetKey: raw.evaluationSetKey,
        evaluationSetVersion, metrics: metrics.metrics, decision, reasonCode, ...(note ? { note } : {}),
      });
      return { evaluation, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Switch one feature off. Immediate; no approval. */
  @Post('/features/:featureKey/disable')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async disable(@Req() request: ProtectedHttpRequest, @Param('featureKey') featureKey: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireStop(request);
    const key = requireFeatureKey(featureKey, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, aiFeatureDisableReasons, correlationId);
    try {
      await disableAiFeature(this.db, this.aiActor(actor, correlationId, 'STOP'), { featureKey: key, reasonCode });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return this.afterWrite(correlationId);
  }

  /** Switch one feature on: a passing evaluation, the kill switch released, and an approval. */
  @Post('/features/:featureKey/enable')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async enable(@Req() request: ProtectedHttpRequest, @Param('featureKey') featureKey: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireConfigure(request);
    const key = requireFeatureKey(featureKey, correlationId);
    const raw = readObject(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = readReason(raw.reasonCode, aiFeatureEnableReasons, correlationId);
    const approvalId = readApprovalId(raw, correlationId);
    try {
      await enableAiFeature(this.db, this.aiActor(actor, correlationId, 'CONFIGURE'), {
        featureKey: key, reasonCode, approvalId,
        approvalPayload: (facts) => approvalPayloads.AI_FEATURE_ENABLE({
          featureKey: facts.featureKey, model: facts.model, promptKey: facts.promptKey, promptVersion: facts.promptVersion,
          evaluationId: facts.passingEvaluationId, reasonCode,
        }),
      });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return this.afterWrite(correlationId);
  }

  /** Change the cap, window and input limit. Lowering is immediate; widening needs an approval. */
  @Post('/features/:featureKey/limits')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async limits(@Req() request: ProtectedHttpRequest, @Param('featureKey') featureKey: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireConfigure(request);
    const key = requireFeatureKey(featureKey, correlationId);
    const raw = readObject(body, ['cap', 'capWindow', 'maxInputChars', 'reasonCode', 'approvalId'], correlationId);
    const next = readAiLimits(raw, correlationId);
    if (typeof raw.reasonCode !== 'string' || !/^[A-Z0-9_:-]{3,64}$/.test(raw.reasonCode)) throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const approvalId = readApprovalId(raw, correlationId);
    try {
      const result = await changeAiFeatureLimits(this.db, this.aiActor(actor, correlationId, 'CONFIGURE'), {
        featureKey: key, next, reasonCode, approvalId,
        approvalPayload: () => approvalPayloads.AI_FEATURE_LIMITS_RAISE({ featureKey: key, ...next, reasonCode }),
      });
      return { ...(await this.afterWrite(correlationId)), change: result.change };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Engage the global kill switch: every feature and the assistant off, in one action. No approval. */
  @Post('/kill-switch/engage')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async engage(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireStop(request);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, aiKillSwitchEngageReasons, correlationId);
    try {
      const result = await engageAiKillSwitch(this.db, this.aiActor(actor, correlationId, 'STOP'), { reasonCode });
      return { ...(await this.afterWrite(correlationId)), featuresSwitchedOff: result.featuresSwitchedOff.length, assistantSwitchedOff: result.assistantSwitchedOff };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Switch the in-app assistant off without a restart. Switching it on is a flag approval plus the server variable. */
  @Post('/assistant/disable')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async disableAssistant(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireStop(request);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, aiAssistantDisableReasons, correlationId);
    try {
      await disableAiAssistant(this.db, this.aiActor(actor, correlationId, 'STOP'), { reasonCode });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return this.afterWrite(correlationId);
  }

  /**
   * ENG-22: tutor hints for staff review — a daily random sample of DRAFT hints, the refused ones with the
   * guard's findings, or recent verdicts. The question and the hint, never who the student was.
   * Design: docs/architecture/tutor-hints-table-design.md (Decision 8).
   */
  @Get('/tutor-hints')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async tutorHints(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireView(request);
    rejectUnknown(query, ['view', 'limit'], correlationId);
    const view = (query.view ?? 'sample') as string;
    if (!(TUTOR_REVIEW_VIEWS as readonly string[]).includes(view)) throw badRequest('TUTOR_REVIEW_VIEW_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const listed = await listTutorHintsForReview(this.db, { view: view as TutorReviewListView, limit });
    return {
      view, ...listed,
      reasons: { approve: TUTOR_REVIEW_APPROVE_REASONS, reject: TUTOR_REVIEW_REJECT_REASONS },
      viewer: { canReview: canConfigureAi(actor) },
      correlationId,
    };
  }

  /** ENG-22: a staff verdict on one tutor hint — DRAFT to PUBLISHED (approve) or REJECTED, once, with a reason. */
  @Post('/tutor-hints/:tutorHintId/review')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reviewTutorHint(@Req() request: ProtectedHttpRequest, @Param('tutorHintId') tutorHintId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireConfigure(request);
    if (!uuidPattern.test(tutorHintId)) throw badRequest('INVALID_REQUEST', correlationId);
    const raw = readObject(body, ['verdict', 'reasonCode'], correlationId);
    if (raw.verdict !== 'APPROVE' && raw.verdict !== 'REJECT') throw badRequest('TUTOR_REVIEW_VERDICT_INVALID', correlationId);
    const reasons: readonly string[] = raw.verdict === 'APPROVE' ? TUTOR_REVIEW_APPROVE_REASONS : TUTOR_REVIEW_REJECT_REASONS;
    const reasonCode = readReason(raw.reasonCode, reasons, correlationId);
    try {
      const reviewed = await reviewTutorHint(this.db, this.aiActor(actor, correlationId, 'CONFIGURE'), { tutorHintId, verdict: raw.verdict, reasonCode });
      return { tutorHint: reviewed, correlationId };
    } catch (error) {
      if (error instanceof TutorHintReviewError) {
        if (error.code === 'NOT_FOUND') throw new NotFoundException(domainError('TUTOR_HINT_NOT_FOUND', correlationId));
        if (error.code === 'INVALID_REASON') throw badRequest('REASON_CODE_INVALID', correlationId);
        throw new ConflictException(domainError(error.code === 'ALREADY_REVIEWED' ? 'TUTOR_HINT_ALREADY_REVIEWED' : 'TUTOR_HINT_NOT_REVIEWABLE', correlationId));
      }
      throw mapError(error, correlationId);
    }
  }

  private async afterWrite(correlationId: string): Promise<Record<string, unknown>> {
    const summary = await loadAiOperationsSummary(this.db, { period: 'DAY' });
    return { killSwitch: summary.killSwitch, assistantFlag: summary.assistantFlag, features: summary.features, correlationId };
  }

  private aiActor(actor: Actor, correlationId: string, kind: 'STOP' | 'CONFIGURE'): AiActor {
    return { userId: actor.userId, correlationId, breakGlass: kind === 'STOP' ? aiStopIsBreakGlass(actor) : aiConfigureIsBreakGlass(actor) };
  }

  private async caller(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    return { correlationId: context.correlationId, actor };
  }

  private async requireView(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const caller = await this.caller(request);
    if (!canViewAiOperations(caller.actor)) throw new ForbiddenException(safeError('FORBIDDEN', caller.correlationId));
    return caller;
  }

  private async requireStop(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const caller = await this.caller(request);
    if (!canStopAi(caller.actor)) throw new ForbiddenException(safeError('FORBIDDEN', caller.correlationId));
    return caller;
  }

  private async requireConfigure(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const caller = await this.caller(request);
    if (!canConfigureAi(caller.actor)) throw new ForbiddenException(safeError('FORBIDDEN', caller.correlationId));
    return caller;
  }
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
  if (error instanceof AiOperationsError) {
    switch (error.code) {
      case 'AI_FEATURE_NOT_FOUND': return new NotFoundException(domainError(error.code, correlationId));
      case 'APPROVAL_REQUIRED': return new ForbiddenException(domainError(error.code, correlationId));
      case 'AI_LIMITS_UNCHANGED':
      case 'REASON_CODE_INVALID':
      case 'APPROVAL_NOT_REQUIRED':
        return badRequest(error.code, correlationId);
      default: return new ConflictException(domainError(error.code, correlationId));
    }
  }
  // Never forward database or driver text to the browser.
  return badRequest('AI_OPERATION_REJECTED', correlationId);
}

function rejectUnknown(query: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  return raw;
}

function readPeriod(value: unknown, correlationId: string): AiPeriod | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(periods as readonly string[]).includes(value)) throw badRequest('AI_PERIOD_INVALID', correlationId);
  return value as AiPeriod;
}

function requireFeatureKey(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !featureKeyPattern.test(value)) throw badRequest('AI_FEATURE_KEY_INVALID', correlationId);
  return value;
}

function optionalFeatureKey(value: unknown, correlationId: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return requireFeatureKey(value, correlationId);
}

function requireVersion(value: unknown, code: string, correlationId: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) throw badRequest(code, correlationId);
  return value;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
  return value;
}

function readNote(value: unknown, correlationId: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > noteLimit) throw badRequest('NOTE_INVALID', correlationId);
  return value.trim() || undefined;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('AI_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(position: { readonly at: string; readonly id: string }): string {
  return Buffer.from(position.at + '|' + position.id, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly at: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('AI_CURSOR_INVALID', correlationId);
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!at || !id || rest.length || Number.isNaN(Date.parse(at)) || !uuidPattern.test(id)) throw badRequest('AI_CURSOR_INVALID', correlationId);
  return { at, id };
}
