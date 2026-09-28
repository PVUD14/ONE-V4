/**
 * The lesson editor's content rules — pure (OPS-09c).
 *
 * Why this exists: a lesson is a versioned LESSON content revision (0004) whose body holds its
 * title, the text learners read (summary and an optional practice prompt), its module, skill and
 * prerequisites, the rights its text is under, and its variant metadata (language, level, style).
 * A variant is its own lesson entity rendering a base lesson in another language, level or style.
 * These functions read, normalise and validate that body and check the lesson prerequisite graph
 * with no database, so the API, the persistence layer and the tests apply one set of rules. The
 * graph check is the existing `assertAcyclicPrerequisites`, keyed on stable keys.
 *
 * Levels and styles are words, never numbers: nothing here is a score or maps to readiness.
 *
 * Design: docs/architecture/lesson-variant-editor-design.md
 */
import { assertAcyclicPrerequisites } from './index.js';
import { SKILL_LICENCES, SKILL_LICENCES_REQUIRING_ATTRIBUTION, type SkillLicence } from './skill-map.js';

export const LESSON_BODY_SCHEMA = 'lesson/v1';

export const LESSON_STABLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const LESSON_TITLE_MAX = 200;
export const LESSON_SUMMARY_MAX = 1000;
export const LESSON_PRACTICE_MAX = 2000;
export const LESSON_PREREQUISITES_MAX = 20;
export const LESSON_ATTRIBUTION_MAX = 300;
export const LESSON_BASIS_MAX = 2000;

/** ISO 639-1 codes. English is every base lesson's language, and ENG-16's fallback. */
export const LESSON_LANGUAGES = ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or'] as const;
export type LessonLanguage = (typeof LESSON_LANGUAGES)[number];
export const LESSON_LANGUAGE_NAMES: Readonly<Record<LessonLanguage, string>> = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali',
  gu: 'Gujarati', pa: 'Punjabi', or: 'Odia',
};
export const LESSON_BASE_LANGUAGE: LessonLanguage = 'en';

export const LESSON_LEVELS = ['FOUNDATION', 'STANDARD', 'ADVANCED'] as const;
export type LessonLevel = (typeof LESSON_LEVELS)[number];
export const LESSON_LEVEL_MEANINGS: Readonly<Record<LessonLevel, string>> = {
  FOUNDATION: 'Simpler wording and more scaffolding',
  STANDARD: 'The lesson as written for most learners',
  ADVANCED: 'Denser, assumes more background',
};

export const LESSON_STYLES = ['EXPLANATION', 'WORKED_EXAMPLE', 'STEP_BY_STEP', 'SUMMARY'] as const;
export type LessonStyle = (typeof LESSON_STYLES)[number];
export const LESSON_STYLE_MEANINGS: Readonly<Record<LessonStyle, string>> = {
  EXPLANATION: 'Explains the idea in prose',
  WORKED_EXAMPLE: 'Teaches through one complete example',
  STEP_BY_STEP: 'A numbered procedure to follow',
  SUMMARY: 'A short recap of the key points',
};

/** The same licences as the skill map and question bank. */
export const LESSON_LICENCES = SKILL_LICENCES;
export type LessonLicence = SkillLicence;
export const LESSON_LICENCES_REQUIRING_ATTRIBUTION = SKILL_LICENCES_REQUIRING_ATTRIBUTION;

export interface LessonVariantMetadata {
  readonly language: LessonLanguage;
  readonly level: LessonLevel;
  readonly style: LessonStyle;
}

/** What a body without variant metadata (the pilot's lessons) reads as. */
export const LESSON_BASE_VARIANT: LessonVariantMetadata = { language: 'en', level: 'STANDARD', style: 'EXPLANATION' };

/** The part of a lesson body the editor owns. Other keys are carried unchanged. */
export interface LessonDraftFields {
  readonly title: string;
  readonly summary: string;
  readonly practice: string | null;
  /** Base lessons only; null on a variant. */
  readonly moduleKey: string | null;
  readonly topicId: string | null;
  readonly prerequisites: readonly string[];
  readonly licenceLabel: LessonLicence | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

/** The identity part of a body: fixed at creation. */
export interface LessonIdentity {
  readonly stableKey: string;
  /** The base lesson's entity id for a variant; null for a base lesson. */
  readonly variantOf: string | null;
  readonly variant: LessonVariantMetadata;
  /** For a variant: the base lesson's published revision it renders. */
  readonly basedOnRevision: number | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/[ \t]+/g, ' ') : '');
const cleanBlock = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const orNull = (value: string): string | null => (value ? value : null);
const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  ((allowed as readonly string[]).includes(value) ? value as T : fallback);

export function isLessonLanguage(value: unknown): value is LessonLanguage {
  return typeof value === 'string' && (LESSON_LANGUAGES as readonly string[]).includes(value);
}
export function isLessonLevel(value: unknown): value is LessonLevel {
  return typeof value === 'string' && (LESSON_LEVELS as readonly string[]).includes(value);
}
export function isLessonStyle(value: unknown): value is LessonStyle {
  return typeof value === 'string' && (LESSON_STYLES as readonly string[]).includes(value);
}

/** One readable label for a variant triple, e.g. "te/STANDARD/EXPLANATION". */
export function lessonVariantLabel(variant: LessonVariantMetadata): string {
  return `${variant.language}/${variant.level}/${variant.style}`;
}

export function sameLessonVariant(left: LessonVariantMetadata, right: LessonVariantMetadata): boolean {
  return left.language === right.language && left.level === right.level && left.style === right.style;
}

/**
 * The identity of any stored lesson body. A pilot body (`{id, stableKey, title, topicId, body,
 * prerequisiteLessonIds}`) has no variant metadata and reads as an English base lesson.
 */
export function readLessonIdentity(body: unknown): LessonIdentity {
  const raw = asRecord(body);
  const variant = asRecord(raw.variant);
  const variantOf = clean(raw.variantOf);
  const based = raw.basedOnRevision;
  return {
    stableKey: clean(raw.stableKey),
    variantOf: UUID_PATTERN.test(variantOf) ? variantOf.toLowerCase() : null,
    variant: {
      language: pick(clean(variant.language), LESSON_LANGUAGES, LESSON_BASE_VARIANT.language),
      level: pick(clean(variant.level), LESSON_LEVELS, LESSON_BASE_VARIANT.level),
      style: pick(clean(variant.style), LESSON_STYLES, LESSON_BASE_VARIANT.style),
    },
    basedOnRevision: typeof based === 'number' && Number.isInteger(based) && based > 0 ? based : null,
  };
}

/** The editor's fields out of any stored body, tolerating the pilot's shape. */
export function readLessonDraftFields(body: unknown): LessonDraftFields {
  const raw = asRecord(body);
  const content = asRecord(raw.body);
  const rights = asRecord(raw.rights);
  const licence = clean(rights.licenceLabel);
  const topicId = clean(raw.topicId);
  const moduleKey = clean(raw.moduleKey);
  return {
    title: clean(raw.title),
    summary: cleanBlock(content.summary),
    practice: orNull(cleanBlock(content.practice)),
    moduleKey: orNull(moduleKey),
    topicId: UUID_PATTERN.test(topicId) ? topicId.toLowerCase() : null,
    prerequisites: Array.isArray(raw.prerequisites) ? raw.prerequisites.filter((key): key is string => typeof key === 'string') : [],
    licenceLabel: (LESSON_LICENCES as readonly string[]).includes(licence) ? licence as LessonLicence : null,
    attribution: orNull(clean(rights.attribution)),
    basis: orNull(cleanBlock(raw.basis)),
  };
}

/**
 * The body to store: the previous body with identity and editor fields replaced. Keys the
 * editor does not own (the pilot's `id`, an import pack's provenance) are carried. A variant
 * stores no module, skill or prerequisites: those are its base lesson's.
 */
export function composeLessonBody(previous: unknown, identity: LessonIdentity, fields: LessonDraftFields): Record<string, unknown> {
  const { prerequisiteLessonIds: _pilotPrerequisites, ...carried } = asRecord(previous);
  const variant = identity.variantOf !== null;
  return {
    ...carried,
    schema: LESSON_BODY_SCHEMA,
    stableKey: identity.stableKey,
    variantOf: identity.variantOf,
    variant: { language: identity.variant.language, level: identity.variant.level, style: identity.variant.style },
    basedOnRevision: variant ? identity.basedOnRevision : null,
    moduleKey: variant ? null : fields.moduleKey,
    topicId: variant ? null : fields.topicId,
    prerequisites: variant ? [] : [...fields.prerequisites],
    title: fields.title,
    body: { summary: fields.summary, practice: fields.practice },
    rights: { licenceLabel: fields.licenceLabel, attribution: fields.attribution },
    basis: fields.basis,
  };
}

/** Problems with the identity chosen at creation, as stable codes. */
export function validateLessonIdentity(identity: LessonIdentity): readonly string[] {
  const problems: string[] = [];
  if (!LESSON_STABLE_KEY_PATTERN.test(identity.stableKey)) problems.push('LESSON_KEY_INVALID');
  if (identity.variantOf === null && identity.variant.language !== LESSON_BASE_LANGUAGE) problems.push('LESSON_BASE_LANGUAGE_INVALID');
  return problems;
}

/**
 * Problems with a draft, as stable codes safe to show. `forSubmission` adds what review needs: a
 * summary, a licence (and attribution for a CC licence), and for a base lesson its module and
 * skill. Whether the module, skill and prerequisites exist, and the graph, are checked with the
 * rest of the lessons (`lessonGraphProblems` and the persistence layer).
 */
export function validateLessonDraft(identity: LessonIdentity, fields: LessonDraftFields, forSubmission: boolean): readonly string[] {
  const problems: string[] = [...validateLessonIdentity(identity)];
  const base = identity.variantOf === null;
  if (fields.title.length < 1 || fields.title.length > LESSON_TITLE_MAX) problems.push('LESSON_TITLE_INVALID');
  if (fields.summary.length > LESSON_SUMMARY_MAX) problems.push('LESSON_SUMMARY_TOO_LONG');
  if (fields.practice !== null && fields.practice.length > LESSON_PRACTICE_MAX) problems.push('LESSON_PRACTICE_TOO_LONG');
  if (base) {
    if (fields.moduleKey !== null && !LESSON_STABLE_KEY_PATTERN.test(fields.moduleKey)) problems.push('LESSON_MODULE_KEY_INVALID');
    if (fields.prerequisites.length > LESSON_PREREQUISITES_MAX) problems.push('LESSON_PREREQUISITES_TOO_MANY');
    if (new Set(fields.prerequisites).size !== fields.prerequisites.length) problems.push('LESSON_PREREQUISITE_DUPLICATE');
    if (fields.prerequisites.includes(identity.stableKey)) problems.push('LESSON_PREREQUISITE_SELF');
    if (fields.prerequisites.some((key) => !LESSON_STABLE_KEY_PATTERN.test(key))) problems.push('LESSON_PREREQUISITE_KEY_INVALID');
  } else if (fields.moduleKey !== null || fields.topicId !== null || fields.prerequisites.length) {
    problems.push('LESSON_VARIANT_STRUCTURE_INVALID');
  }
  if (fields.attribution !== null && fields.attribution.length > LESSON_ATTRIBUTION_MAX) problems.push('LESSON_ATTRIBUTION_INVALID');
  if (fields.basis !== null && fields.basis.length > LESSON_BASIS_MAX) problems.push('LESSON_BASIS_INVALID');
  if (forSubmission) {
    if (!fields.summary) problems.push('LESSON_SUMMARY_MISSING');
    if (base && !fields.moduleKey) problems.push('LESSON_MODULE_MISSING');
    if (base && !fields.topicId) problems.push('LESSON_TOPIC_MISSING');
    if (!fields.licenceLabel) problems.push('LESSON_LICENCE_MISSING');
    else if (LESSON_LICENCES_REQUIRING_ATTRIBUTION.includes(fields.licenceLabel) && !fields.attribution) problems.push('LESSON_ATTRIBUTION_MISSING');
  }
  return [...new Set(problems)];
}

/**
 * Whether the lesson graph stays a DAG of known lessons with `stableKey`'s prerequisites replaced
 * by `prerequisites`. `graph` holds every other lesson that may be required, with the
 * prerequisites of the version being checked against. Returns stable codes; empty is fine.
 */
export function lessonGraphProblems(
  graph: ReadonlyMap<string, readonly string[]>,
  stableKey: string,
  prerequisites: readonly string[],
): readonly string[] {
  const unknown = prerequisites.filter((key) => key !== stableKey && !graph.has(key));
  if (unknown.length) return unknown.map((key) => `LESSON_PREREQUISITE_UNKNOWN:${key}`);
  const merged = new Map(graph);
  merged.set(stableKey, prerequisites);
  const ids = [...merged.keys()];
  const known = new Set(ids);
  const edges = [...merged.entries()].flatMap(([key, requires]) => requires
    .filter((required) => known.has(required))
    .map((required) => ({ lessonId: key, prerequisiteLessonId: required })));
  try {
    assertAcyclicPrerequisites(ids, edges);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/itself/.test(message)) return ['LESSON_PREREQUISITE_SELF'];
    return ['LESSON_PREREQUISITE_CYCLE'];
  }
}

/**
 * What a published base revision writes to `lesson_versions.body`: the text learners read, in the
 * pilot's shape (`{summary, practice}`), and nothing else — no rights, basis or provenance.
 */
export function publishedLessonBody(fields: LessonDraftFields): { readonly summary: string; readonly practice?: string } {
  if (!fields.summary) throw new Error('only a complete lesson can be published');
  return fields.practice ? { summary: fields.summary, practice: fields.practice } : { summary: fields.summary };
}
