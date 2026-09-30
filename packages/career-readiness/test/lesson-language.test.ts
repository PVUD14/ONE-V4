/**
 * Tests for which rendering of a lesson a student reads (ENG-16): English stays English; a published
 * variant in the chosen language is served with the base's identity untouched; no variant falls back
 * to English with a notice; an outdated one is served with a notice; the choice among several is
 * deterministic; and which languages a student may choose. All text is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  canChooseLessonLanguage,
  chooseLessonRendering,
  offeredLessonLanguages,
  readLessonLanguage,
  type LessonRenderingBase,
  type PublishedLessonVariant,
} from '../src/index.js';

const BASE_ID = '6a1d8d4f-9e4b-4c9f-8e8d-2b3c4d5e6f70';
const base: LessonRenderingBase = {
  version: 2, title: 'Synthetic base title', body: { summary: 'Synthetic base summary', practice: 'Synthetic base practice' },
  variant: { language: 'en', level: 'STANDARD', style: 'EXPLANATION' },
};

function variant(over: { language?: string; level?: string; style?: string; basedOnRevision?: number; title?: string; practice?: string | null; revision?: number } = {}): PublishedLessonVariant {
  return {
    revision: over.revision ?? 1,
    body: {
      schema: 'lesson/v1', stableKey: 'synthetic-lesson', variantOf: BASE_ID,
      variant: { language: over.language ?? 'te', level: over.level ?? 'STANDARD', style: over.style ?? 'EXPLANATION' },
      basedOnRevision: over.basedOnRevision ?? 2,
      title: over.title ?? 'సింథటిక్ శీర్షిక', body: { summary: 'సింథటిక్ సారాంశం', practice: over.practice === undefined ? 'సింథటిక్ అభ్యాసం' : over.practice },
      rights: { licenceLabel: 'AI8HT-Owned', attribution: null },
    },
  };
}

describe('choosing a lesson rendering', () => {
  it('serves English to an English reader, with no notice, whatever is published', () => {
    expect(chooseLessonRendering({ base, language: 'en', variants: [variant()] })).toEqual({
      language: 'en', title: base.title, body: base.body, languageNotice: null,
    });
  });

  it('serves a published variant in the chosen language: only the words change', () => {
    expect(chooseLessonRendering({ base, language: 'te', variants: [variant({ language: 'hi', title: 'Synthetic Hindi title' }), variant()] })).toEqual({
      language: 'te', title: 'సింథటిక్ శీర్షిక', body: { summary: 'సింథటిక్ సారాంశం', practice: 'సింథటిక్ అభ్యాసం' }, languageNotice: null,
    });
    expect(chooseLessonRendering({ base, language: 'te', variants: [variant({ practice: null })] }).body).toEqual({ summary: 'సింథటిక్ సారాంశం' });
  });

  it('falls back to English with a notice when nothing is published in the chosen language', () => {
    for (const variants of [[], [variant({ language: 'hi' })]]) {
      expect(chooseLessonRendering({ base, language: 'te', variants })).toEqual({
        language: 'en', title: base.title, body: base.body, languageNotice: 'TRANSLATION_MISSING',
      });
    }
  });

  it('never serves a body that is not a variant or has no text', () => {
    const notAVariant: PublishedLessonVariant = { revision: 1, body: { ...(variant().body as object), variantOf: null } };
    const empty: PublishedLessonVariant = { revision: 1, body: { ...(variant().body as object), body: { summary: '' } } };
    expect(chooseLessonRendering({ base, language: 'te', variants: [notAVariant, empty] }).languageNotice).toBe('TRANSLATION_MISSING');
  });

  it('serves a rendering written for an older version of the lesson, and says so', () => {
    expect(chooseLessonRendering({ base, language: 'te', variants: [variant({ basedOnRevision: 1 })] })).toMatchObject({
      language: 'te', title: 'సింథటిక్ శీర్షిక', languageNotice: 'TRANSLATION_OUTDATED',
    });
  });

  it('chooses deterministically: the base’s level and style first, then its level, then STANDARD', () => {
    const exact = variant({ title: 'exact' });
    const sameLevel = variant({ style: 'SUMMARY', title: 'same level' });
    const foundation = variant({ level: 'FOUNDATION', style: 'EXPLANATION', title: 'foundation' });
    const advanced = variant({ level: 'ADVANCED', style: 'EXPLANATION', title: 'advanced' });
    const pick = (variants: PublishedLessonVariant[]) => chooseLessonRendering({ base, language: 'te', variants }).title;
    expect(pick([advanced, foundation, sameLevel, exact])).toBe('exact');
    expect(pick([advanced, foundation, sameLevel])).toBe('same level');
    expect(pick([advanced, foundation])).toBe('foundation');
    expect(pick([foundation, advanced])).toBe('foundation');
  });
});

describe('the languages a student may choose', () => {
  it('always offers English and Telugu, adds languages with published variants and the current choice, in vocabulary order', () => {
    expect(offeredLessonLanguages([], null).map((option) => option.language)).toEqual(['en', 'te']);
    expect(offeredLessonLanguages(['ta', 'hi'], 'kn').map((option) => option.language)).toEqual(['en', 'hi', 'te', 'ta', 'kn']);
    expect(offeredLessonLanguages([], null)[1]).toEqual({ language: 'te', name: 'Telugu', nativeName: 'తెలుగు' });
  });

  it('lets a student choose only an offered language', () => {
    expect(canChooseLessonLanguage('te', [])).toBe(true);
    expect(canChooseLessonLanguage('en', [])).toBe(true);
    expect(canChooseLessonLanguage('hi', [])).toBe(false);
    expect(canChooseLessonLanguage('hi', ['hi'])).toBe(true);
    expect(canChooseLessonLanguage('xx', ['xx'])).toBe(false);
    expect(canChooseLessonLanguage(3, [])).toBe(false);
  });

  it('reads an unknown stored value as English', () => {
    expect(readLessonLanguage('te')).toBe('te');
    expect(readLessonLanguage(null)).toBe('en');
    expect(readLessonLanguage('klingon')).toBe('en');
  });
});
