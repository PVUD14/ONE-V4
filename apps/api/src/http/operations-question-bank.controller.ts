/**
 * Operations Content Management — the question bank editor (OPS-09b, Appendix 1 §3 Content,
 * §4.2, §5.3, §5.4).
 *
 * Readiness-check questions are versioned content revisions taken from draft through review —
 * which includes the rights review, and writes the option tags (ENG-07) and the hint ladder
 * (0061) — to a publish that writes the learner-facing question version and the grading-only
 * answer key through a release manifest. The author, every editor and the submitter never review
 * or publish their own revision; publishing needs CONTENT_PUBLISH and, because the readiness check
 * draws from every published question, a second person's approval. Every write carries a reason
 * code from packages/authorization and writes its audit row (and events) in one transaction.
 *
 * Answer keys (the correct option, the explanation and the tags that reveal wrong options) are
 * returned only to CONTENT_EDIT or CONTENT_REVIEW. Nothing here is a learner route.
 *
 * Design: docs/architecture/question-bank-editor-design.md
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
  canReadQuestionBank,
  canSeeAnswerKeys,
  hasInternalCapability,
  questionBankReasons,
  questionPublishReasons,
  questionRevisionTransitions,
  questionTransitionCapability,
  refuseQuestionPublish,
  refuseQuestionTransition,
  resolveInternalCapability,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  createQuestion,
  HINT_LEVELS,
  listQuestions,
  loadQuestion,
  publishQuestionRevision,
  QUESTION_ATTRIBUTION_MAX,
  QUESTION_BASIS_MAX,
  QUESTION_DIFFICULTIES,
  QUESTION_DIFFICULTY_MEANINGS,
  QUESTION_EXPLANATION_MAX,
  QUESTION_HINT_MAX,
  QUESTION_LICENCES,
  QUESTION_LICENCES_REQUIRING_ATTRIBUTION,
  QUESTION_OPTION_IDS,
  QUESTION_OPTION_TEXT_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN,
  QUESTION_PROMPT_MAX,
  QUESTION_RATIONALE_MAX,
  QUESTION_STABLE_KEY_PATTERN,
  QuestionBankError,
  QuestionBankRefused,
  saveQuestionDraft,
  startQuestionRevision,
  summariseQuestionBank,
  transitionQuestionRevision,
  type QuestionActor,
  type QuestionDifficulty,
  type QuestionDraftInput,
  type QuestionLicence,
  type QuestionListFilter,
  type QuestionOptionFields,
} from '@planthepath/persistence/src/question-bank.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const topicKeyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;
const listFilters: readonly QuestionListFilter[] = ['LIVE', 'PENDING', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'AWAITING_PUBLISH'];

@Controller('/api/v1/operations/question-bank')
export class OperationsQuestionBankController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Vocabularies, reason codes and the viewer's powers. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    return {
      viewer: {
        edit: hasInternalCapability(actor, 'CONTENT_EDIT'),
        review: hasInternalCapability(actor, 'CONTENT_REVIEW'),
        publish: hasInternalCapability(actor, 'CONTENT_PUBLISH'),
        answerKeys: canSeeAnswerKeys(actor),
        userId: actor.userId,
      },
      optionIds: QUESTION_OPTION_IDS,
      difficulties: QUESTION_DIFFICULTIES.map((difficulty) => ({ difficulty, meaning: QUESTION_DIFFICULTY_MEANINGS[difficulty] })),
      hintLevels: HINT_LEVELS,
      licences: QUESTION_LICENCES.map((licence) => ({ licence, attributionRequired: QUESTION_LICENCES_REQUIRING_ATTRIBUTION.includes(licence) })),
      transitions: questionRevisionTransitions,
      reasons: { ...questionBankReasons, publish: questionPublishReasons },
      limits: {
        prompt: QUESTION_PROMPT_MAX, optionText: QUESTION_OPTION_TEXT_MAX, optionsMin: QUESTION_OPTIONS_MIN, optionsMax: QUESTION_OPTIONS_MAX,
        explanation: QUESTION_EXPLANATION_MAX, rationale: QUESTION_RATIONALE_MAX, hint: QUESTION_HINT_MAX,
        attribution: QUESTION_ATTRIBUTION_MAX, basis: QUESTION_BASIS_MAX, note: noteLimit,
      },
      correlationId,
    };
  }

  @Get('/questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['q', 'filter', 'limit', 'cursor'], correlationId);
    const q = optionalText(query.q, 120, 'QUESTION_SEARCH_INVALID', correlationId);
    const filter = query.filter === undefined || query.filter === '' ? undefined : requireEnum(query.filter, listFilters, 'QUESTION_FILTER_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listQuestions(this.db, { ...(q ? { q } : {}), ...(filter ? { filter } : {}), limit, ...(cursor ? { cursor } : {}) });
    return {
      questions: page.questions,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      summary: await summariseQuestionBank(this.db),
      correlationId,
    };
  }

  @Get('/questions/:questionId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('questionId') questionId: string): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const question = await loadQuestion(this.db, requireUuid(questionId, correlationId), { answerKeys: canSeeAnswerKeys(actor) });
    if (!question) throw new NotFoundException(domainError('QUESTION_NOT_FOUND', correlationId));
    return { question, correlationId };
  }

  @Post('/questions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const raw = readObject(body, ['stableKey', 'topicKey', 'prompt', 'reasonCode'], correlationId);
    if (typeof raw.stableKey !== 'string' || !QUESTION_STABLE_KEY_PATTERN.test(raw.stableKey)) throw badRequest('QUESTION_KEY_INVALID', correlationId);
    if (typeof raw.topicKey !== 'string' || !topicKeyPattern.test(raw.topicKey)) throw badRequest('QUESTION_TOPIC_INVALID', correlationId);
    const prompt = requireBlock(raw.prompt, 1, QUESTION_PROMPT_MAX, 'QUESTION_PROMPT_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, questionBankReasons.create, 'REASON_CODE_INVALID', correlationId);
    try {
      const created = await createQuestion(this.db, { stableKey: raw.stableKey, topicKey: raw.topicKey, prompt, reasonCode, actor: this.questionActor(actor, 'CONTENT_EDIT', correlationId) });
      return { question: await loadQuestion(this.db, created.questionId, { answerKeys: true }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/questions/:questionId/revisions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revise(@Req() request: ProtectedHttpRequest, @Param('questionId') questionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(questionId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, questionBankReasons.revise, 'REASON_CODE_INVALID', correlationId);
    try {
      await startQuestionRevision(this.db, { questionId: id, reasonCode, actor: this.questionActor(actor, 'CONTENT_EDIT', correlationId) });
      return { question: await loadQuestion(this.db, id, { answerKeys: true }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/revisions/:revisionId/draft')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async save(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['topicKey', 'prompt', 'options', 'correctOptionId', 'explanation', 'difficulty', 'hints', 'licenceLabel', 'attribution', 'basis', 'reasonCode'], correlationId);
    requireEnum(raw.reasonCode, questionBankReasons.save, 'REASON_CODE_INVALID', correlationId);
    const draft = readDraft(raw, correlationId);
    try {
      const saved = await saveQuestionDraft(this.db, { revisionId: id, draft, actor: this.questionActor(actor, 'CONTENT_EDIT', correlationId) });
      return { question: await loadQuestion(this.db, saved.questionId, { answerKeys: true }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/revisions/:revisionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['toState', 'reasonCode', 'rightsReasonCode', 'note'], correlationId);
    if (raw.toState !== 'IN_REVIEW' && raw.toState !== 'CHANGES_REQUESTED' && raw.toState !== 'APPROVED') throw badRequest('QUESTION_STATE_INVALID', correlationId);
    const toState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const rightsReasonCode = raw.rightsReasonCode === undefined || raw.rightsReasonCode === null ? null : typeof raw.rightsReasonCode === 'string' ? raw.rightsReasonCode : '';
    const note = optionalText(raw.note, noteLimit, 'QUESTION_NOTE_INVALID', correlationId);
    if (!hasInternalCapability(actor, questionTransitionCapability(toState))) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    try {
      const moved = await transitionQuestionRevision(this.db, {
        revisionId: id, toState, reasonCode, rightsReasonCode, note, actor: this.questionActor(actor, questionTransitionCapability(toState), correlationId),
        refuse: ({ from, contributorUserIds }) => refuseQuestionTransition({ actor, from, to: toState, reasonCode, rightsReasonCode, contributorUserIds }),
      });
      return { question: await loadQuestion(this.db, moved.questionId, { answerKeys: canSeeAnswerKeys(actor) }), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Publish an approved revision. Every question publish changes readiness inputs today, so it
   * needs an approval for exactly this revision, its content hash and this reason.
   */
  @Post('/revisions/:revisionId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publish(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, questionPublishReasons, 'REASON_CODE_INVALID', correlationId);
    const approvalId = readApprovalId(body, correlationId) ?? null;
    try {
      const published = await publishQuestionRevision(this.db, {
        revisionId: id, reasonCode, approvalId,
        approvalPayload: (contentHash) => approvalPayloads.CONTENT_QUESTION_PUBLISH({ revisionId: id, contentHash, reasonCode }),
        actor: this.questionActor(actor, 'CONTENT_PUBLISH', correlationId),
        refuse: ({ contributorUserIds }) => refuseQuestionPublish({ actor, contributorUserIds }),
      });
      return {
        question: await loadQuestion(this.db, published.questionId, { answerKeys: canSeeAnswerKeys(actor) }),
        approval: published.approval ? { id: published.approval.approvalId, mode: published.approval.mode } : null,
        correlationId,
      };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private questionActor(actor: Actor, capability: InternalCapability, correlationId: string): QuestionActor {
    return { userId: actor.userId, breakGlass: resolveInternalCapability(actor, capability) === 'BREAK_GLASS', correlationId };
  }

  private async require(request: ProtectedHttpRequest, capability: InternalCapability): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, capability)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  private async requireReader(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canReadQuestionBank(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function readDraft(raw: Record<string, unknown>, correlationId: string): QuestionDraftInput {
  if (typeof raw.topicKey !== 'string' || !topicKeyPattern.test(raw.topicKey)) throw badRequest('QUESTION_TOPIC_INVALID', correlationId);
  const prompt = requireBlock(raw.prompt, 1, QUESTION_PROMPT_MAX, 'QUESTION_PROMPT_INVALID', correlationId);
  const optionsRaw = raw.options === undefined ? [] : raw.options;
  if (!Array.isArray(optionsRaw) || optionsRaw.length > QUESTION_OPTIONS_MAX) throw badRequest('QUESTION_OPTIONS_INVALID', correlationId);
  const options: QuestionOptionFields[] = optionsRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest('QUESTION_OPTIONS_INVALID', correlationId);
    const option = entry as Record<string, unknown>;
    rejectUnknown(option, ['id', 'text', 'misconceptionCodeId', 'rationale'], correlationId);
    if (option.id !== QUESTION_OPTION_IDS[index]) throw badRequest('QUESTION_OPTIONS_INVALID', correlationId);
    const text = optionalBlock(option.text, QUESTION_OPTION_TEXT_MAX, 'QUESTION_OPTIONS_INVALID', correlationId) ?? '';
    const codeId = option.misconceptionCodeId === undefined || option.misconceptionCodeId === null || option.misconceptionCodeId === '' ? null : requireUuid(option.misconceptionCodeId, correlationId);
    const rationale = optionalBlock(option.rationale, QUESTION_RATIONALE_MAX, 'QUESTION_RATIONALE_INVALID', correlationId);
    if (codeId && !rationale) throw badRequest('QUESTION_RATIONALE_INVALID', correlationId);
    return { id: option.id as string, text, misconception: codeId ? { codeId, rationale: rationale! } : null };
  });
  const correctOptionId = raw.correctOptionId === undefined || raw.correctOptionId === null || raw.correctOptionId === ''
    ? null : requireEnum(raw.correctOptionId, options.map((option) => option.id), 'QUESTION_CORRECT_OPTION_INVALID', correlationId);
  const difficulty = raw.difficulty === undefined || raw.difficulty === null || raw.difficulty === ''
    ? null : requireEnum(raw.difficulty, QUESTION_DIFFICULTIES, 'QUESTION_DIFFICULTY_INVALID', correlationId) as QuestionDifficulty;
  const hintsRaw = raw.hints === undefined ? ['', '', '', ''] : raw.hints;
  if (!Array.isArray(hintsRaw) || hintsRaw.length !== 4) throw badRequest('QUESTION_HINTS_INVALID', correlationId);
  const hints = hintsRaw.map((hint) => optionalBlock(hint, QUESTION_HINT_MAX, 'QUESTION_HINTS_INVALID', correlationId) ?? '') as [string, string, string, string];
  const licenceLabel = raw.licenceLabel === undefined || raw.licenceLabel === null || raw.licenceLabel === ''
    ? null : requireEnum(raw.licenceLabel, QUESTION_LICENCES, 'QUESTION_LICENCE_INVALID', correlationId) as QuestionLicence;
  return {
    topicKey: raw.topicKey, prompt, options, correctOptionId,
    explanation: optionalBlock(raw.explanation, QUESTION_EXPLANATION_MAX, 'QUESTION_EXPLANATION_INVALID', correlationId),
    difficulty, hints, licenceLabel,
    attribution: optionalText(raw.attribution, QUESTION_ATTRIBUTION_MAX, 'QUESTION_ATTRIBUTION_INVALID', correlationId),
    basis: optionalBlock(raw.basis, QUESTION_BASIS_MAX, 'QUESTION_BASIS_INVALID', correlationId),
  };
}

function domainError(code: string, correlationId: string, problems?: readonly string[]): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(problems?.length ? { problems } : {}) } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof QuestionBankRefused) {
    if (error.code === 'APPROVAL_REQUIRED') return approvalRequired(correlationId);
    if (error.code === 'FORBIDDEN' || error.code === 'QUESTION_SELF_REVIEW_REFUSED' || error.code === 'QUESTION_SELF_PUBLISH_REFUSED') {
      return new ForbiddenException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  if (error instanceof QuestionBankError) {
    if (error.code === 'QUESTION_NOT_FOUND' || error.code === 'QUESTION_REVISION_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'QUESTION_INVALID' || error.code === 'QUESTION_TOPIC_UNKNOWN' || error.code === 'QUESTION_MISCONCEPTION_NOT_PUBLISHED') {
      return new BadRequestException(domainError(error.code, correlationId, error.problems));
    }
    if (error.code === 'QUESTION_BANK_REJECTED') return badRequest(error.code, correlationId);
    return new ConflictException(domainError(error.code, correlationId));
  }
  // Never forward database or driver text to the browser.
  return badRequest('QUESTION_BANK_REJECTED', correlationId);
}

function rejectUnknown(raw: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function requireUuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

/** One line: runs of spaces collapse. */
function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim().replace(/[ \t]+/g, ' ');
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

/** A block of text (a prompt, an option, a hint): trimmed, inner layout kept. */
function requireBlock(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireText(value, 1, max, code, correlationId);
}

function optionalBlock(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireBlock(value, 1, max, code, correlationId);
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const limit = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw badRequest('LIMIT_INVALID', correlationId);
  return limit;
}

function encodeCursor(cursor: { readonly key: string; readonly id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly key: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 400) throw badRequest('CURSOR_INVALID', correlationId);
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { key?: unknown; id?: unknown };
    if (typeof parsed.key !== 'string' || parsed.key.length > 200 || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) throw new Error('shape');
    return { key: parsed.key, id: parsed.id };
  } catch {
    throw badRequest('CURSOR_INVALID', correlationId);
  }
}
