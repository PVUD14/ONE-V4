/**
 * Pure contracts and validation for learner-facing, non-assessment content.
 *
 * Practice assessments remain owned by @planthepath/assessments. This domain
 * covers reusable learner resources and keeps persistence, transport, and any
 * future generation provider outside the contract layer.
 */

export const LEARNER_CONTENT_TYPES = [
  'PRACTICE',
  'COMPANY_PREP',
  'CAREER_TOOL',
  'SCHOLARSHIP',
  'RESUME_BUILDER',
] as const;

export const LEARNER_CONTENT_SOURCES = ['SEEDED', 'AUTHORED'] as const;

/** Matches the established content_revisions lifecycle from migration 0004. */
export const LEARNER_CONTENT_REVIEW_STATES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const;

export type LearnerContentType = (typeof LEARNER_CONTENT_TYPES)[number];
export type LearnerContentSource = (typeof LEARNER_CONTENT_SOURCES)[number];
export type LearnerContentReviewState = (typeof LEARNER_CONTENT_REVIEW_STATES)[number];

export const LEARNER_CONTENT_REVIEW_QUEUE_STATES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
] as const satisfies readonly LearnerContentReviewState[];

export type LearnerContentReviewQueueState = (typeof LEARNER_CONTENT_REVIEW_QUEUE_STATES)[number];

export const LEARNER_CONTENT_SEED_KEYS = [
  'PRACTICE_PROBLEM_SOLVING',
  'COMPANY_RESEARCH_CHECKLIST',
  'INTERVIEW_EVIDENCE_PLANNER',
  'SCHOLARSHIP_APPLICATION_CHECKLIST',
  'EVIDENCE_FIRST_RESUME_OUTLINE',
] as const;

export type LearnerContentSeedKey = (typeof LEARNER_CONTENT_SEED_KEYS)[number];

export interface LearnerContentSeed {
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly sortOrder: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Fixed local fixtures used by the non-AI D3 pipeline. */
export const LEARNER_CONTENT_SEEDS: Readonly<Record<LearnerContentSeedKey, LearnerContentSeed>> = {
  PRACTICE_PROBLEM_SOLVING: {
    contentType: 'PRACTICE',
    title: 'Problem-solving practice guide',
    summary: 'A repeatable structure for working through practice problems.',
    content: { steps: ['Restate the problem', 'List known constraints', 'Choose an approach', 'Check the result'] },
    sortOrder: 10,
    metadata: { locale: 'en-IN', seedVersion: 'd3-v1' },
  },
  COMPANY_RESEARCH_CHECKLIST: {
    contentType: 'COMPANY_PREP',
    title: 'Company research checklist',
    summary: 'A checklist for preparing from verified company and role information.',
    content: { checklist: ['Read the role description', 'Review the official company site', 'Prepare role-specific questions'] },
    sortOrder: 20,
    metadata: { locale: 'en-IN', seedVersion: 'd3-v1' },
  },
  INTERVIEW_EVIDENCE_PLANNER: {
    contentType: 'CAREER_TOOL',
    title: 'Interview evidence planner',
    summary: 'A worksheet for selecting evidence before an interview.',
    content: { sections: ['Situation', 'Action', 'Result', 'Verification'] },
    sortOrder: 30,
    metadata: { locale: 'en-IN', seedVersion: 'd3-v1' },
  },
  SCHOLARSHIP_APPLICATION_CHECKLIST: {
    contentType: 'SCHOLARSHIP',
    title: 'Scholarship application checklist',
    summary: 'A safety-first checklist for checking eligibility and official deadlines.',
    content: { checklist: ['Confirm eligibility', 'Verify the official deadline', 'Collect required documents'] },
    sortOrder: 40,
    metadata: { locale: 'en-IN', seedVersion: 'd3-v1' },
  },
  EVIDENCE_FIRST_RESUME_OUTLINE: {
    contentType: 'RESUME_BUILDER',
    title: 'Evidence-first resume outline',
    summary: 'A resume outline that keeps claims connected to verifiable work.',
    content: { sections: ['Summary', 'Skills', 'Verified projects', 'Education'] },
    sortOrder: 50,
    metadata: { locale: 'en-IN', seedVersion: 'd3-v1' },
  },
};

export function learnerContentSeed(seedKey: LearnerContentSeedKey): LearnerContentSeed {
  const seed = LEARNER_CONTENT_SEEDS[seedKey];
  if (!seed) throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content seed is not supported.');
  return seed;
}

export interface LearnerContentDraftInput {
  readonly id: string;
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary?: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly source: LearnerContentSource;
  readonly generatorVersion?: string | null;
  readonly promptVersion?: string | null;
  readonly generatedAt?: Date | null;
  readonly createdByUserId: string;
  readonly sortOrder?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class LearnerContentRuleError extends Error {
  constructor(readonly code: 'INVALID_CONTENT' | 'INVALID_PROVENANCE' | 'INVALID_TRANSITION', message: string) {
    super(message);
    this.name = 'LearnerContentRuleError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertLearnerContentDraft(input: LearnerContentDraftInput): void {
  if (!uuidPattern.test(input.id) || !uuidPattern.test(input.createdByUserId)) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content and author identifiers must be UUIDs.');
  }
  if (!LEARNER_CONTENT_TYPES.includes(input.contentType)) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content type is not supported.');
  }
  if (!LEARNER_CONTENT_SOURCES.includes(input.source)) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content source is not supported.');
  }
  const titleLength = input.title.trim().length;
  if (titleLength < 1 || titleLength > 200) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content title must contain 1 to 200 characters.');
  }
  if (input.summary != null && (input.summary.trim().length < 1 || input.summary.length > 1000)) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content summary must contain 1 to 1000 characters when provided.');
  }
  if (!isJsonObject(input.content) || !isJsonObject(input.metadata ?? {})) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content and metadata must be JSON objects.');
  }
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    throw new LearnerContentRuleError('INVALID_CONTENT', 'Learner content sort order must be an integer from 0 to 1000000.');
  }
  if (input.generatorVersion != null || input.promptVersion != null || input.generatedAt != null) {
    throw new LearnerContentRuleError(
      'INVALID_PROVENANCE',
      'Seeded and authored content cannot claim generated-content provenance.',
    );
  }
}

const reviewTransitions: Readonly<Record<LearnerContentReviewState, readonly LearnerContentReviewState[]>> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'],
  CHANGES_REQUESTED: ['IN_REVIEW', 'ARCHIVED'],
  APPROVED: ['CHANGES_REQUESTED', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

/** D4 can reuse this lifecycle while adding reviewer actions and authorization. */
export function assertLearnerContentReviewTransition(
  from: LearnerContentReviewState,
  to: LearnerContentReviewState,
): void {
  if (!reviewTransitions[from].includes(to)) {
    throw new LearnerContentRuleError('INVALID_TRANSITION', `Learner content cannot move from ${from} to ${to}.`);
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
