import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LearnerContentRuleError,
  assertLearnerContentDraft,
  assertLearnerContentReviewTransition,
  type LearnerContentDraftInput,
} from '../src/index.js';

function draft(overrides: Partial<LearnerContentDraftInput> = {}): LearnerContentDraftInput {
  return {
    id: randomUUID(),
    contentType: 'CAREER_TOOL',
    title: 'Interview evidence planner',
    summary: 'A structured preparation resource.',
    content: { sections: [{ heading: 'Evidence', prompts: ['Choose one verified example.'] }] },
    source: 'AUTHORED',
    createdByUserId: randomUUID(),
    ...overrides,
  };
}

describe('learner content contracts', () => {
  it('accepts seeded and authored non-assessment drafts without generated provenance', () => {
    expect(() => assertLearnerContentDraft(draft({ source: 'SEEDED' }))).not.toThrow();
    expect(() => assertLearnerContentDraft(draft({ source: 'AUTHORED' }))).not.toThrow();
  });

  it('rejects unsupported content types and sources', () => {
    expect(() => assertLearnerContentDraft(draft({ contentType: 'VIDEO' as never }))).toThrow(LearnerContentRuleError);
    expect(() => assertLearnerContentDraft(draft({ source: 'GENERATED' as never }))).toThrow(LearnerContentRuleError);
  });

  it('rejects generated provenance for currently allowed origins', () => {
    expect(() => assertLearnerContentDraft(draft({ generatorVersion: 'future-v1' }))).toThrow(/cannot claim generated-content provenance/);
    expect(() => assertLearnerContentDraft(draft({ promptVersion: 'future-prompt-v1' }))).toThrow(/cannot claim generated-content provenance/);
    expect(() => assertLearnerContentDraft(draft({ generatedAt: new Date() }))).toThrow(/cannot claim generated-content provenance/);
  });

  it('uses the established governed review path to publication', () => {
    expect(() => assertLearnerContentReviewTransition('DRAFT', 'IN_REVIEW')).not.toThrow();
    expect(() => assertLearnerContentReviewTransition('IN_REVIEW', 'APPROVED')).not.toThrow();
    expect(() => assertLearnerContentReviewTransition('APPROVED', 'PUBLISHED')).not.toThrow();
  });

  it('rejects review shortcuts and reopening archived content', () => {
    expect(() => assertLearnerContentReviewTransition('DRAFT', 'PUBLISHED')).toThrow(/cannot move/);
    expect(() => assertLearnerContentReviewTransition('ARCHIVED', 'DRAFT')).toThrow(/cannot move/);
  });
});
