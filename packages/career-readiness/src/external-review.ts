/**
 * What an external faculty reviewer is shown of a draft — pure (OPS-10, ADR-037).
 *
 * Why this exists: a college faculty member reviews one assigned skill, question or lesson
 * revision. The view is a whitelist per content type, built from the editors' own readers, so a
 * field is shown only because it is named here. For a question the answer key — the correct
 * option, the explanation, the misconception tags and their rationale — and the hint ladder
 * (which can walk to the answer) are never included: Appendix 1 makes keys visible only to
 * CONTENT_EDIT and CONTENT_REVIEW. Rights, provenance, authors and operators are not the
 * reviewer's business and are left out too.
 *
 * Design: docs/architecture/external-review-assignments-table-design.md (Decision 4)
 */
import { readLessonDraftFields, readLessonIdentity, lessonVariantLabel, LESSON_LANGUAGE_NAMES } from './lesson-editor.js';
import { readQuestionDraftFields } from './question-bank.js';
import { readSkillDraftFields, SKILL_LEVELS, type SkillLevel } from './skill-map.js';

export type ExternalReviewContent =
  | {
    readonly kind: 'SKILL';
    readonly stableKey: string;
    readonly name: string;
    readonly description: string;
    readonly levels: readonly { readonly level: SkillLevel; readonly descriptor: string }[];
    readonly prerequisites: readonly string[];
    readonly basis: string | null;
  }
  | {
    readonly kind: 'QUESTION';
    readonly stableKey: string;
    readonly skill: string | null;
    readonly prompt: string;
    readonly options: readonly { readonly id: string; readonly text: string }[];
    readonly difficulty: string | null;
  }
  | {
    readonly kind: 'LESSON';
    readonly stableKey: string;
    readonly title: string;
    readonly summary: string;
    readonly practice: string | null;
    readonly variant: { readonly label: string; readonly language: string; readonly level: string; readonly style: string } | null;
    readonly prerequisites: readonly string[];
    readonly basis: string | null;
  };

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The faculty view of one revision body. `context` carries what the body names by id: the skill
 * node's name and description (a TOPIC body may lack them) and the question's skill name.
 */
export function externalReviewContent(
  entityType: 'TOPIC' | 'QUESTION' | 'LESSON',
  body: unknown,
  context: { readonly nodeName?: string; readonly nodeDescription?: string; readonly skillName?: string | null } = {},
): ExternalReviewContent {
  const stableKey = text(asRecord(body).stableKey);
  if (entityType === 'TOPIC') {
    const fields = readSkillDraftFields(body, { name: context.nodeName ?? '', description: context.nodeDescription ?? '' });
    return {
      kind: 'SKILL', stableKey, name: fields.name, description: fields.description,
      levels: SKILL_LEVELS.map((level) => ({ level, descriptor: fields.levels[level] })),
      prerequisites: [...fields.prerequisites], basis: fields.basis,
    };
  }
  if (entityType === 'QUESTION') {
    const fields = readQuestionDraftFields(body);
    return {
      kind: 'QUESTION', stableKey, skill: context.skillName ?? null, prompt: fields.prompt,
      options: fields.options.map((option) => ({ id: option.id, text: option.text })),
      difficulty: fields.difficulty,
    };
  }
  const identity = readLessonIdentity(body);
  const fields = readLessonDraftFields(body);
  return {
    kind: 'LESSON', stableKey, title: fields.title, summary: fields.summary, practice: fields.practice,
    variant: identity.variantOf ? {
      label: lessonVariantLabel(identity.variant),
      language: LESSON_LANGUAGE_NAMES[identity.variant.language],
      level: identity.variant.level,
      style: identity.variant.style,
    } : null,
    prerequisites: [...fields.prerequisites], basis: fields.basis,
  };
}

/** A one-line title for a queue row: never the question's options or any key. */
export function externalReviewTitle(entityType: 'TOPIC' | 'QUESTION' | 'LESSON', body: unknown, nodeName = ''): string {
  const raw = asRecord(body);
  const key = text(raw.stableKey);
  if (entityType === 'TOPIC') return text(raw.name) || nodeName || key;
  if (entityType === 'LESSON') {
    const identity = readLessonIdentity(body);
    const title = text(raw.title) || key;
    return identity.variantOf ? `${title} (${lessonVariantLabel(identity.variant)})` : title;
  }
  const prompt = readQuestionDraftFields(body).prompt.replace(/\s+/g, ' ');
  return prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt || key;
}
