/**
 * ONE · API client — Operations question bank editor (OPS-09b).
 *
 * Readiness-check questions and their revisions from draft through review (which is also the
 * rights review, and writes the option tags and the hint ladder) to a publish. Every publish
 * needs an approval (Settings → Approvals); without one the server answers 403
 * APPROVAL_REQUIRED and nothing changes. The server withholds answer keys from anyone without
 * Content Edit or Content Review; this client never asks for them separately.
 */
import { requestJson } from './http.js';

export type BankQuestionRevisionState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export type BankQuestionStatus = 'LIVE' | 'PENDING';
export type BankQuestionListFilter = BankQuestionStatus | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'AWAITING_PUBLISH';

export interface QuestionBankPolicyDto {
  readonly viewer: { readonly edit: boolean; readonly review: boolean; readonly publish: boolean; readonly answerKeys: boolean; readonly userId: string };
  readonly optionIds: readonly string[];
  readonly difficulties: readonly { readonly difficulty: string; readonly meaning: string }[];
  readonly hintLevels: readonly { readonly level: number; readonly name: string; readonly meaning: string }[];
  readonly licences: readonly { readonly licence: string; readonly attributionRequired: boolean }[];
  readonly transitions: Readonly<Record<BankQuestionRevisionState, readonly BankQuestionRevisionState[]>>;
  readonly reasons: {
    readonly create: readonly string[];
    readonly revise: readonly string[];
    readonly save: readonly string[];
    readonly transition: Readonly<Record<string, readonly string[]>>;
    readonly rights: readonly string[];
    readonly publish: readonly string[];
  };
  readonly limits: {
    readonly prompt: number; readonly optionText: number; readonly optionsMin: number; readonly optionsMax: number; readonly explanation: number;
    readonly rationale: number; readonly hint: number; readonly attribution: number; readonly basis: number; readonly note: number;
  };
  readonly correlationId: string;
}

export interface BankQuestionTopicDto {
  readonly id: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: 'LIVE' | 'PENDING' | 'RETIRED';
}

export interface BankQuestionSummaryDto {
  readonly questionId: string;
  readonly stableKey: string;
  readonly topic: BankQuestionTopicDto | null;
  readonly status: BankQuestionStatus;
  readonly publishedVersion: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: BankQuestionRevisionState } | null;
  readonly difficulty: string | null;
  readonly promptExcerpt: string;
  readonly optionCount: number;
  readonly taggedOptionCount: number;
  readonly hintsComplete: boolean;
}

export interface QuestionBankSummaryDto {
  readonly live: number;
  readonly pending: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly awaitingPublish: number;
}

export interface BankQuestionOptionDto {
  readonly id: string;
  readonly text: string;
  readonly misconception: { readonly codeId: string; readonly rationale: string } | null;
}

export interface BankQuestionFieldsDto {
  readonly topicId: string | null;
  readonly prompt: string;
  readonly options: readonly BankQuestionOptionDto[];
  /** Null when withheld from this viewer, or not yet chosen. */
  readonly correctOptionId: string | null;
  readonly explanation: string | null;
  readonly difficulty: string | null;
  readonly hints: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

export interface BankQuestionRevisionDto {
  readonly id: string;
  readonly revision: number;
  readonly state: BankQuestionRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly fields: BankQuestionFieldsDto;
  readonly answerKeyWithheld: boolean;
  readonly topic: BankQuestionTopicDto | null;
  readonly tags: readonly { readonly optionId: string; readonly code: string; readonly codeVersion: number; readonly codeTitle: string; readonly codeState: string; readonly tagState: string }[];
  readonly ladder: { readonly source: string; readonly state: string; readonly generatorVersion: string | null; readonly promptVersion: string | null; readonly generatedAt: string | null } | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface BankQuestionDetailDto extends BankQuestionSummaryDto {
  readonly current: BankQuestionRevisionDto | null;
  readonly open: BankQuestionRevisionDto | null;
  readonly versions: readonly { readonly version: number; readonly publishedAt: string; readonly superseded: boolean }[];
  readonly misconceptionChoices: readonly { readonly id: string; readonly code: string; readonly version: number; readonly title: string; readonly state: string }[];
  readonly publishNeedsApproval: boolean;
  readonly history: readonly {
    readonly revision: number; readonly action: string; readonly fromState: string; readonly toState: string;
    readonly reasonCode: string; readonly actorEmail: string; readonly occurredAt: string;
  }[];
}

export interface BankQuestionListDto {
  readonly questions: readonly BankQuestionSummaryDto[];
  readonly nextCursor: string | null;
  readonly summary: QuestionBankSummaryDto;
  readonly correlationId: string;
}

export interface BankQuestionDraftInputDto {
  readonly topicKey: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string; readonly misconceptionCodeId?: string; readonly rationale?: string }[];
  readonly correctOptionId: string | null;
  readonly explanation?: string;
  readonly difficulty: string | null;
  readonly hints: readonly string[];
  readonly licenceLabel: string | null;
  readonly attribution?: string;
  readonly basis?: string;
  readonly reasonCode: string;
}

const base = '/api/v1/operations/question-bank';
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
type QuestionEnvelope = { readonly question: BankQuestionDetailDto; readonly correlationId: string };

export function getQuestionBankPolicy(token: string, signal?: AbortSignal): Promise<QuestionBankPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...signalOf(signal) });
}

export function listBankQuestions(token: string, filters: { readonly q?: string; readonly filter?: string } = {}, cursor?: string | null, signal?: AbortSignal): Promise<BankQuestionListDto> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.filter) query.set('filter', filters.filter);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`${base}/questions${suffix}`, { token, ...signalOf(signal) });
}

export function getBankQuestion(token: string, questionId: string, signal?: AbortSignal): Promise<QuestionEnvelope> {
  return requestJson(`${base}/questions/${encodeURIComponent(questionId)}`, { token, ...signalOf(signal) });
}

export function createBankQuestion(token: string, body: { readonly stableKey: string; readonly topicKey: string; readonly prompt: string; readonly reasonCode: string }): Promise<QuestionEnvelope> {
  return requestJson(`${base}/questions`, { token, method: 'POST', body });
}

export function startBankQuestionRevision(token: string, questionId: string, body: { readonly reasonCode: string }): Promise<QuestionEnvelope> {
  return requestJson(`${base}/questions/${encodeURIComponent(questionId)}/revisions`, { token, method: 'POST', body });
}

export function saveBankQuestionDraft(token: string, revisionId: string, body: BankQuestionDraftInputDto): Promise<QuestionEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/draft`, { token, method: 'POST', body });
}

export function transitionBankQuestionRevision(token: string, revisionId: string, body: {
  readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string; readonly rightsReasonCode?: string; readonly note?: string;
}): Promise<QuestionEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/transition`, { token, method: 'POST', body });
}

/** Only from the Approvals queue, with the approved payload: every question publish needs an approval. */
export function publishBankQuestionRevision(token: string, revisionId: string, body: { readonly reasonCode: string; readonly approvalId?: string }): Promise<QuestionEnvelope> {
  return requestJson(`${base}/revisions/${encodeURIComponent(revisionId)}/publish`, { token, method: 'POST', body });
}
