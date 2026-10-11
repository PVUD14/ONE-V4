/**
 * Which rendering of a lesson a student reads — pure (ENG-16).
 *
 * Why this exists: OPS-09c lets operators publish a lesson's variants (another language, level or
 * style) as their own reviewed content, but left serving them to ENG-16. A student chooses a
 * language; this decides, for one lesson, whether they read a published variant in that language
 * or the English lesson with a notice saying why. Only the words change: the lesson's id, topic and
 * prerequisites stay the base lesson's, so completion and its evidence never depend on language.
 *
 * Inputs are only ever PUBLISHED variant revisions (the persistence layer reads nothing else), so
 * an unpublished draft cannot be chosen here. Nothing is translated or generated.
 *
 * Design: docs/architecture/lesson-language-serving-design.md
 */
import {
  LESSON_BASE_LANGUAGE,
  LESSON_LANGUAGE_NAMES,
  LESSON_LANGUAGES,
  LESSON_LEVELS,
  LESSON_STYLES,
  isLessonLanguage,
  readLessonDraftFields,
  readLessonIdentity,
  type LessonLanguage,
  type LessonVariantMetadata,
} from './lesson-editor.js';

export const LESSON_RENDERING_POLICY_VERSION = 'lesson-rendering-v1' as const;

/** Offered to every student whatever is published: English, and the pilot's second language. */
export const LESSON_LANGUAGES_ALWAYS_OFFERED: readonly LessonLanguage[] = ['en', 'te'];

/** Each language in its own script, for the student's language picker. */
export const LESSON_LANGUAGE_NATIVE_NAMES: Readonly<Record<LessonLanguage, string>> = {
  en: 'English', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', mr: 'मराठी', bn: 'বাংলা',
  gu: 'ગુજરાતી', pa: 'ਪੰਜਾਬੀ', or: 'ଓଡ଼ିଆ',
};

export type LessonLanguageNotice = 'TRANSLATION_MISSING' | 'TRANSLATION_OUTDATED';

export interface LessonLanguageOption {
  readonly language: LessonLanguage;
  readonly name: string;
  readonly nativeName: string;
}

export function lessonLanguageOption(language: LessonLanguage): LessonLanguageOption {
  return { language, name: LESSON_LANGUAGE_NAMES[language], nativeName: LESSON_LANGUAGE_NATIVE_NAMES[language] };
}

/**
 * The languages a student may choose: English, Telugu, every language with a published variant,
 * and the student's current choice (so a choice whose only variant was archived still shows as
 * selected). In the vocabulary's order.
 */
export function offeredLessonLanguages(published: readonly string[], selected: LessonLanguage | null): readonly LessonLanguageOption[] {
  const wanted = new Set<string>([...LESSON_LANGUAGES_ALWAYS_OFFERED, ...published, ...(selected ? [selected] : [])]);
  return LESSON_LANGUAGES.filter((language) => wanted.has(language)).map(lessonLanguageOption);
}

/** Whether a student may choose `language` now. */
export function canChooseLessonLanguage(language: unknown, published: readonly string[]): language is LessonLanguage {
  return isLessonLanguage(language) && (LESSON_LANGUAGES_ALWAYS_OFFERED.includes(language) || published.includes(language));
}

/** A stored preference read tolerantly: anything unknown is English. */
export function readLessonLanguage(value: unknown): LessonLanguage {
  return isLessonLanguage(value) ? value : LESSON_BASE_LANGUAGE;
}

/** The latest PUBLISHED revision of one variant entity. */
export interface PublishedLessonVariant {
  readonly revision: number;
  readonly body: unknown;
}

/** The lesson as the catalogue holds it: its current version and the base body's triple. */
export interface LessonRenderingBase {
  readonly version: number;
  readonly title: string;
  readonly body: { readonly summary?: string; readonly practice?: string };
  readonly variant: LessonVariantMetadata;
}

export interface LessonRendering {
  readonly language: LessonLanguage;
  readonly title: string;
  readonly body: { readonly summary?: string; readonly practice?: string };
  readonly languageNotice: LessonLanguageNotice | null;
}

const rank = <T>(list: readonly T[], value: T): number => {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
};

/**
 * The deterministic preference among published variants in the chosen language: the base's own
 * level and style first, then its level, then STANDARD, then vocabulary order.
 */
function preference(base: LessonVariantMetadata, variant: LessonVariantMetadata): readonly number[] {
  return [
    variant.level === base.level && variant.style === base.style ? 0 : 1,
    variant.level === base.level ? 0 : 1,
    variant.level === 'STANDARD' ? 0 : 1,
    rank(LESSON_LEVELS, variant.level),
    rank(LESSON_STYLES, variant.style),
  ];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * What one student reads for one lesson. `variants` are the latest PUBLISHED revisions of the
 * lesson's variants (any language; others are ignored). English, or no published rendering in the
 * chosen language, gives the English lesson — the latter with TRANSLATION_MISSING. A rendering
 * written for an older version of the lesson is served with TRANSLATION_OUTDATED.
 */
export function chooseLessonRendering(input: {
  readonly base: LessonRenderingBase;
  readonly language: LessonLanguage;
  readonly variants: readonly PublishedLessonVariant[];
}): LessonRendering {
  const english: LessonRendering = { language: LESSON_BASE_LANGUAGE, title: input.base.title, body: input.base.body, languageNotice: null };
  if (input.language === LESSON_BASE_LANGUAGE) return english;
  const candidates = input.variants
    .map((variant) => ({ variant, identity: readLessonIdentity(variant.body), fields: readLessonDraftFields(variant.body) }))
    .filter(({ identity, fields }) => identity.variantOf !== null && identity.variant.language === input.language && fields.title && fields.summary)
    .sort((left, right) => compare(preference(input.base.variant, left.identity.variant), preference(input.base.variant, right.identity.variant))
      || right.variant.revision - left.variant.revision);
  const chosen = candidates[0];
  if (!chosen) return { ...english, languageNotice: 'TRANSLATION_MISSING' };
  const outdated = chosen.identity.basedOnRevision !== null && chosen.identity.basedOnRevision < input.base.version;
  return {
    language: input.language,
    title: chosen.fields.title,
    body: chosen.fields.practice ? { summary: chosen.fields.summary, practice: chosen.fields.practice } : { summary: chosen.fields.summary },
    languageNotice: outdated ? 'TRANSLATION_OUTDATED' : null,
  };
}
