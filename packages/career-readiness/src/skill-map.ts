/**
 * The skill map's content rules — pure (OPS-09a).
 *
 * Why this exists: a skill is a TOPIC node whose content (name, what it looks like at each of
 * the four levels, its prerequisites, its rights) is a versioned content revision body. These
 * functions read, normalise and validate that body and check the prerequisite graph, with no
 * database, so the API, the persistence layer and the tests apply one set of rules. The graph
 * check is the existing `assertAcyclicPrerequisites`, keyed on stable keys.
 *
 * Levels are descriptors of what a learner can do. Nothing here is a score, and no level maps
 * to a readiness value.
 *
 * Design: docs/architecture/skill-map-editor-design.md
 */
import { assertAcyclicPrerequisites } from './index.js';

export const SKILL_MAP_BODY_SCHEMA = 'skill-map/v1';

/** The four levels, in order (Appendix 1, OPS-09a). */
export const SKILL_LEVELS = ['AWARE', 'GUIDED', 'INDEPENDENT', 'TROUBLESHOOT'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export const SKILL_LEVEL_MEANINGS: Readonly<Record<SkillLevel, string>> = {
  AWARE: 'Knows what it is and when it matters',
  GUIDED: 'Does it with help, a checklist or a runbook',
  INDEPENDENT: 'Does it unaided on ordinary cases',
  TROUBLESHOOT: 'Diagnoses and fixes it when it goes wrong',
};

/** Licences a skill's text may carry. The CC licences require attribution. */
export const SKILL_LICENCES = ['AI8HT-Owned', 'CC-BY-4.0', 'CC-BY-SA-4.0'] as const;
export type SkillLicence = (typeof SKILL_LICENCES)[number];
export const SKILL_LICENCES_REQUIRING_ATTRIBUTION: readonly SkillLicence[] = ['CC-BY-4.0', 'CC-BY-SA-4.0'];

export const SKILL_STABLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
export const SKILL_NAME_MAX = 160;
export const SKILL_DESCRIPTION_MAX = 1000;
export const SKILL_LEVEL_MAX = 500;
export const SKILL_PREREQUISITES_MAX = 20;
export const SKILL_ATTRIBUTION_MAX = 300;
export const SKILL_BASIS_MAX = 2000;

/** The part of a skill's body the editor owns. Other keys in a body are carried unchanged. */
export interface SkillDraftFields {
  readonly name: string;
  readonly description: string;
  readonly levels: Readonly<Record<SkillLevel, string>>;
  readonly prerequisites: readonly string[];
  readonly licenceLabel: SkillLicence | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/[ \t]+/g, ' ') : '');
const orNull = (value: string): string | null => (value ? value : null);

/**
 * Read the editor's fields out of any stored body, tolerating older shapes: the pilot's topic
 * bodies and ENG-11's pending-topic bodies have no levels or rights, and a test fixture may be
 * `{}`. The node's own name and description fill a body that lacks them.
 */
export function readSkillDraftFields(body: unknown, fallback: { readonly name: string; readonly description: string }): SkillDraftFields {
  const raw = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const levelsRaw = (raw.levels && typeof raw.levels === 'object' ? raw.levels : {}) as Record<string, unknown>;
  const rights = (raw.rights && typeof raw.rights === 'object' ? raw.rights : {}) as Record<string, unknown>;
  const licence = clean(rights.licenceLabel);
  return {
    name: clean(raw.name) || fallback.name,
    description: clean(raw.description) || fallback.description,
    levels: Object.fromEntries(SKILL_LEVELS.map((level) => [level, clean(levelsRaw[level])])) as Record<SkillLevel, string>,
    prerequisites: Array.isArray(raw.prerequisites) ? raw.prerequisites.filter((key): key is string => typeof key === 'string') : [],
    licenceLabel: (SKILL_LICENCES as readonly string[]).includes(licence) ? (licence as SkillLicence) : null,
    attribution: orNull(clean(rights.attribution)),
    basis: orNull(clean(raw.basis)),
  };
}

/**
 * The body to store: the previous body with the editor's fields replaced. Keys the editor does
 * not own (ENG-11's expertCheck, packKey and provenance) are carried so a reviewer still sees them.
 */
export function composeSkillBody(previous: unknown, stableKey: string, fields: SkillDraftFields): Record<string, unknown> {
  const base = (previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...(previous as Record<string, unknown>) } : {});
  return {
    ...base,
    schema: SKILL_MAP_BODY_SCHEMA,
    stableKey,
    name: fields.name,
    description: fields.description,
    levels: Object.fromEntries(SKILL_LEVELS.map((level) => [level, fields.levels[level] ?? ''])),
    prerequisites: [...fields.prerequisites],
    rights: { licenceLabel: fields.licenceLabel, attribution: fields.attribution },
    basis: fields.basis,
  };
}

/**
 * Problems with a draft, as stable codes. `forSubmission` adds what review needs: all four
 * levels, a licence, and attribution when the licence asks for it. Graph rules (known keys,
 * cycles) are `skillMapGraphProblems`, which needs the rest of the map.
 */
export function validateSkillDraft(stableKey: string, fields: SkillDraftFields, forSubmission: boolean): readonly string[] {
  const problems: string[] = [];
  if (!SKILL_STABLE_KEY_PATTERN.test(stableKey)) problems.push('SKILL_KEY_INVALID');
  if (fields.name.length < 1 || fields.name.length > SKILL_NAME_MAX) problems.push('SKILL_NAME_INVALID');
  if (fields.description.length < 1 || fields.description.length > SKILL_DESCRIPTION_MAX) problems.push('SKILL_DESCRIPTION_INVALID');
  for (const level of SKILL_LEVELS) {
    const text = fields.levels[level] ?? '';
    if (text.length > SKILL_LEVEL_MAX) problems.push(`SKILL_LEVEL_TOO_LONG:${level}`);
    else if (forSubmission && !text) problems.push(`SKILL_LEVEL_MISSING:${level}`);
  }
  if (fields.prerequisites.length > SKILL_PREREQUISITES_MAX) problems.push('SKILL_PREREQUISITES_TOO_MANY');
  if (new Set(fields.prerequisites).size !== fields.prerequisites.length) problems.push('SKILL_PREREQUISITE_DUPLICATE');
  if (fields.prerequisites.includes(stableKey)) problems.push('SKILL_PREREQUISITE_SELF');
  if (fields.prerequisites.some((key) => !SKILL_STABLE_KEY_PATTERN.test(key))) problems.push('SKILL_PREREQUISITE_KEY_INVALID');
  if (fields.attribution !== null && fields.attribution.length > SKILL_ATTRIBUTION_MAX) problems.push('SKILL_ATTRIBUTION_INVALID');
  if (fields.basis !== null && fields.basis.length > SKILL_BASIS_MAX) problems.push('SKILL_BASIS_INVALID');
  if (forSubmission) {
    if (!fields.licenceLabel) problems.push('SKILL_LICENCE_MISSING');
    else if (SKILL_LICENCES_REQUIRING_ATTRIBUTION.includes(fields.licenceLabel) && !fields.attribution) problems.push('SKILL_ATTRIBUTION_MISSING');
  }
  return problems;
}

/**
 * Whether the map stays a DAG of known skills with `stableKey`'s prerequisites replaced by
 * `prerequisites`. `graph` holds every other skill that may be required (live or pending) with
 * the prerequisites of the version being checked against. Returns stable codes; empty is fine.
 */
export function skillMapGraphProblems(
  graph: ReadonlyMap<string, readonly string[]>,
  stableKey: string,
  prerequisites: readonly string[],
): readonly string[] {
  const unknown = prerequisites.filter((key) => key !== stableKey && !graph.has(key));
  if (unknown.length) return unknown.map((key) => `SKILL_PREREQUISITE_UNKNOWN:${key}`);
  const merged = new Map(graph);
  merged.set(stableKey, prerequisites);
  const ids = [...merged.keys()];
  const known = new Set(ids);
  // Another skill's stored prerequisite may name a key that is no longer requirable (retired);
  // that edge is theirs to fix and cannot close a cycle through this skill, so it is left out.
  const edges = [...merged.entries()].flatMap(([key, requires]) => requires
    .filter((required) => known.has(required))
    .map((required) => ({ lessonId: key, prerequisiteLessonId: required })));
  try {
    assertAcyclicPrerequisites(ids, edges);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/itself/.test(message)) return ['SKILL_PREREQUISITE_SELF'];
    return ['SKILL_PREREQUISITE_CYCLE'];
  }
}
