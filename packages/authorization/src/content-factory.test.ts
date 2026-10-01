/**
 * Content factory rules (ENG-23): drafts are an author's request (CONTENT_EDIT), answer checks a
 * reviewer's (CONTENT_REVIEW) and visible only to answer-key holders; every request carries a
 * reason code for its kind; each kind runs exactly one AI feature.
 */
import { describe, expect, it } from 'vitest';
import {
  canReadContentFactory,
  canSeeAnswerChecks,
  contentFactoryCapability,
  contentFactoryFeatureKeys,
  contentFactoryKinds,
  contentFactoryReasons,
  refuseContentDraftRequest,
} from './content-factory.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const editor = withGrants('editor', ['CONTENT_EDIT']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const publisher = withGrants('publisher', ['CONTENT_PUBLISH']);
const plain = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

describe('who asks for what', () => {
  it('drafts need CONTENT_EDIT; an answer check needs CONTENT_REVIEW', () => {
    expect(contentFactoryCapability('LESSON')).toBe('CONTENT_EDIT');
    expect(contentFactoryCapability('LESSON_VARIANT')).toBe('CONTENT_EDIT');
    expect(contentFactoryCapability('QUESTION')).toBe('CONTENT_EDIT');
    expect(contentFactoryCapability('ANSWER_CHECK')).toBe('CONTENT_REVIEW');
    expect(refuseContentDraftRequest({ actor: editor, kind: 'LESSON', reasonCode: 'NEW_LESSON' })).toBeNull();
    expect(refuseContentDraftRequest({ actor: reviewer, kind: 'LESSON', reasonCode: 'NEW_LESSON' })).toBe('FORBIDDEN');
    expect(refuseContentDraftRequest({ actor: publisher, kind: 'QUESTION', reasonCode: 'NEW_QUESTION' })).toBe('FORBIDDEN');
    expect(refuseContentDraftRequest({ actor: reviewer, kind: 'ANSWER_CHECK', reasonCode: 'ANSWER_KEY_CHECK' })).toBeNull();
    expect(refuseContentDraftRequest({ actor: editor, kind: 'ANSWER_CHECK', reasonCode: 'ANSWER_KEY_CHECK' })).toBe('FORBIDDEN');
    expect(refuseContentDraftRequest({ actor: withGrants('s', ['CONTENT_EDIT'], 'SUSPENDED'), kind: 'LESSON', reasonCode: 'NEW_LESSON' })).toBe('FORBIDDEN');
  });

  it('refuses an unknown kind and a reason code from another kind', () => {
    expect(refuseContentDraftRequest({ actor: editor, kind: 'ESSAY', reasonCode: 'NEW_LESSON' })).toBe('AI_DRAFT_KIND_INVALID');
    expect(refuseContentDraftRequest({ actor: editor, kind: 'LESSON', reasonCode: 'NEW_LANGUAGE' })).toBe('REASON_CODE_INVALID');
    expect(refuseContentDraftRequest({ actor: editor, kind: 'LESSON_VARIANT', reasonCode: 'NEW_LANGUAGE' })).toBeNull();
  });

  it('every kind has reasons and exactly one feature; lessons and variants share the lesson feature', () => {
    for (const kind of contentFactoryKinds) expect(contentFactoryReasons[kind].length).toBeGreaterThan(0);
    expect(contentFactoryFeatureKeys).toEqual({
      LESSON: 'content.lesson-draft', LESSON_VARIANT: 'content.lesson-draft', QUESTION: 'content.item-draft', ANSWER_CHECK: 'content.answer-check',
    });
  });
});

describe('who sees what', () => {
  it('content and catalogue staff see the factory; only answer-key holders see answer checks', () => {
    for (const actor of [editor, reviewer, publisher, withGrants('c', ['CATALOGUE_MANAGE'])]) expect(canReadContentFactory(actor)).toBe(true);
    expect(canReadContentFactory(plain)).toBe(false);
    expect(canSeeAnswerChecks(editor)).toBe(true);
    expect(canSeeAnswerChecks(reviewer)).toBe(true);
    expect(canSeeAnswerChecks(publisher)).toBe(false);
  });
});
