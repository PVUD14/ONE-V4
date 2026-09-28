/**
 * Tests for the lesson editor's content rules (OPS-09c): reading a pilot-shaped lesson body as an
 * English base lesson, carrying keys the editor does not own, what a draft and a submission must
 * hold for a base lesson and for a variant, and — the acceptance item — that lesson prerequisite
 * cycles are rejected through the existing acyclic check. Also that what a publish writes to
 * `lesson_versions` holds only the text learners read.
 */
import { describe, expect, it } from 'vitest';
import {
  composeLessonBody,
  LESSON_BASE_VARIANT,
  LESSON_LANGUAGES,
  lessonGraphProblems,
  lessonVariantLabel,
  publishedLessonBody,
  readLessonDraftFields,
  readLessonIdentity,
  sameLessonVariant,
  validateLessonDraft,
  type LessonDraftFields,
  type LessonIdentity,
} from '../src/index.js';

const TOPIC = '5f0c7c3e-8d3a-4b8e-9d7c-1a2b3c4d5e6f';
const BASE_ID = '6a1d8d4f-9e4b-4c9f-8e8d-2b3c4d5e6f70';

const base: LessonIdentity = { stableKey: 'synthetic-lesson', variantOf: null, variant: LESSON_BASE_VARIANT, basedOnRevision: null };
const variant: LessonIdentity = { stableKey: 'synthetic-lesson', variantOf: BASE_ID, variant: { language: 'te', level: 'FOUNDATION', style: 'WORKED_EXAMPLE' }, basedOnRevision: 2 };

const complete = (over: Partial<LessonDraftFields> = {}): LessonDraftFields => ({
  title: 'Synthetic lesson',
  summary: 'Synthetic summary a learner reads.',
  practice: 'Synthetic practice prompt.',
  moduleKey: 'synthetic-module',
  topicId: TOPIC,
  prerequisites: ['synthetic-earlier'],
  licenceLabel: 'AI8HT-Owned',
  attribution: null,
  basis: 'Synthetic basis',
  ...over,
});

describe('reading bodies', () => {
  it('reads a pilot lesson body as an English base lesson with its text', () => {
    const pilot = {
      id: '22000000-0000-4000-8000-000000000001', stableKey: 'write-for-action', title: 'Write for action', topicId: TOPIC,
      body: { summary: 'Frame a message.', practice: 'Rewrite a follow-up.' }, prerequisiteLessonIds: [],
    };
    expect(readLessonIdentity(pilot)).toEqual({ stableKey: 'write-for-action', variantOf: null, variant: LESSON_BASE_VARIANT, basedOnRevision: null });
    expect(readLessonDraftFields(pilot)).toMatchObject({ title: 'Write for action', summary: 'Frame a message.', practice: 'Rewrite a follow-up.', topicId: TOPIC, moduleKey: null, prerequisites: [], licenceLabel: null });
  });

  it('composes a body that carries unowned keys, drops the pilot id list, and keeps a variant free of structure', () => {
    const previous = { id: 'pilot-id', prerequisiteLessonIds: ['x'], provenance: { source: 'AGENT_DRAFTED' }, expertCheck: 'Native speaker to check.' };
    const composed = composeLessonBody(previous, base, complete());
    expect(composed).toMatchObject({ schema: 'lesson/v1', id: 'pilot-id', expertCheck: 'Native speaker to check.', moduleKey: 'synthetic-module', prerequisites: ['synthetic-earlier'], body: { summary: 'Synthetic summary a learner reads.' } });
    expect(composed).not.toHaveProperty('prerequisiteLessonIds');
    const rendered = composeLessonBody({}, variant, complete());
    expect(rendered).toMatchObject({ variantOf: BASE_ID, variant: { language: 'te', level: 'FOUNDATION', style: 'WORKED_EXAMPLE' }, basedOnRevision: 2, moduleKey: null, topicId: null, prerequisites: [] });
    expect(readLessonIdentity(rendered)).toEqual(variant);
    expect(lessonVariantLabel(variant.variant)).toBe('te/FOUNDATION/WORKED_EXAMPLE');
    expect(sameLessonVariant(variant.variant, { language: 'te', level: 'FOUNDATION', style: 'WORKED_EXAMPLE' })).toBe(true);
    expect(LESSON_LANGUAGES[0]).toBe('en');
  });
});

describe('validation', () => {
  it('accepts a complete base lesson and a complete variant for submission', () => {
    expect(validateLessonDraft(base, complete(), true)).toEqual([]);
    expect(validateLessonDraft(variant, complete({ moduleKey: null, topicId: null, prerequisites: [] }), true)).toEqual([]);
  });

  it('lets a draft be incomplete but asks a submission for summary, module, skill and licence', () => {
    const draft = complete({ summary: '', moduleKey: null, topicId: null, licenceLabel: null, prerequisites: [] });
    expect(validateLessonDraft(base, draft, false)).toEqual([]);
    expect(validateLessonDraft(base, draft, true)).toEqual(expect.arrayContaining(['LESSON_SUMMARY_MISSING', 'LESSON_MODULE_MISSING', 'LESSON_TOPIC_MISSING', 'LESSON_LICENCE_MISSING']));
    expect(validateLessonDraft(base, complete({ licenceLabel: 'CC-BY-4.0' }), true)).toEqual(['LESSON_ATTRIBUTION_MISSING']);
  });

  it('refuses a non-English base lesson, structure on a variant, bad keys and duplicates', () => {
    expect(validateLessonDraft({ ...base, variant: { ...LESSON_BASE_VARIANT, language: 'hi' } }, complete(), false)).toContain('LESSON_BASE_LANGUAGE_INVALID');
    expect(validateLessonDraft(variant, complete(), false)).toContain('LESSON_VARIANT_STRUCTURE_INVALID');
    expect(validateLessonDraft({ ...base, stableKey: 'Bad Key' }, complete(), false)).toContain('LESSON_KEY_INVALID');
    expect(validateLessonDraft(base, complete({ prerequisites: ['a-lesson', 'a-lesson'] }), false)).toContain('LESSON_PREREQUISITE_DUPLICATE');
    expect(validateLessonDraft(base, complete({ prerequisites: ['synthetic-lesson'] }), false)).toContain('LESSON_PREREQUISITE_SELF');
    expect(validateLessonDraft(base, complete({ title: '' }), false)).toContain('LESSON_TITLE_INVALID');
    expect(validateLessonDraft(base, complete({ summary: 'x'.repeat(1001) }), false)).toContain('LESSON_SUMMARY_TOO_LONG');
  });
});

describe('prerequisite graph (acceptance: cycles are rejected)', () => {
  const graph = new Map<string, readonly string[]>([
    ['lesson-a', []],
    ['lesson-b', ['lesson-a']],
    ['lesson-c', ['lesson-b']],
  ]);

  it('accepts a DAG and names unknown prerequisites', () => {
    expect(lessonGraphProblems(graph, 'lesson-d', ['lesson-c'])).toEqual([]);
    expect(lessonGraphProblems(graph, 'lesson-d', ['lesson-x'])).toEqual(['LESSON_PREREQUISITE_UNKNOWN:lesson-x']);
  });

  it('rejects a cycle closed through other lessons', () => {
    expect(lessonGraphProblems(graph, 'lesson-a', ['lesson-c'])).toEqual(['LESSON_PREREQUISITE_CYCLE']);
    expect(lessonGraphProblems(graph, 'lesson-b', ['lesson-b'])).toEqual(['LESSON_PREREQUISITE_SELF']);
  });
});

describe('what a publish writes for learners', () => {
  it('is the text only, in the pilot shape', () => {
    expect(publishedLessonBody(complete())).toEqual({ summary: 'Synthetic summary a learner reads.', practice: 'Synthetic practice prompt.' });
    expect(publishedLessonBody(complete({ practice: null }))).toEqual({ summary: 'Synthetic summary a learner reads.' });
    expect(() => publishedLessonBody(complete({ summary: '' }))).toThrow();
  });
});
