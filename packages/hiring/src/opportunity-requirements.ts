/**
 * What a job asks for (EMP-06): its eligibility rules, required and preferred skills, and the
 * ordered selection stages — the input rules for editing them and the stage template the
 * applicant pipeline uses.
 *
 * These live per job version (0007) and change only through a new version (EMP-05), so every
 * rule here is about what a version may contain. Pure and exhaustively tested, like the rest of
 * packages/hiring; the API adds only what needs the database (a catalogue topic exists, an
 * institution is an institution).
 *
 * Fairness (Appendix 2 §5.4): the rule types are the fixed eight in the table's CHECK and no
 * more; CUSTOM and WORK_AUTHORIZATION rules can never block (ONE records no work-authorisation
 * fact, so a blocking rule would refuse everyone on missing data); and a text value that names a
 * protected attribute or an obvious proxy for one is refused, never silently stripped.
 */
import type { ApplicationState, EligibilityComparator, EligibilityRule, EligibilityRuleType } from './index.js';

export class RequirementInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RequirementInputError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const spreadsheetPrefix = /^[=+@-]/;

export const ELIGIBILITY_RULE_TYPES: readonly EligibilityRuleType[] = [
  'MIN_CGPA', 'MAX_BACKLOGS', 'GRADUATION_YEAR', 'DEPARTMENT', 'PROGRAM', 'INSTITUTION', 'WORK_AUTHORIZATION', 'CUSTOM',
];

/** Which comparators each rule type accepts; anything else is refused. */
export const ELIGIBILITY_COMPARATORS: Readonly<Record<EligibilityRuleType, readonly EligibilityComparator[]>> = {
  MIN_CGPA: ['GTE'],
  MAX_BACKLOGS: ['LTE'],
  GRADUATION_YEAR: ['EQ', 'GTE', 'LTE', 'IN', 'NOT_IN'],
  DEPARTMENT: ['EQ', 'IN', 'NOT_IN'],
  PROGRAM: ['EQ', 'IN', 'NOT_IN'],
  INSTITUTION: ['EQ', 'IN', 'NOT_IN'],
  WORK_AUTHORIZATION: ['EQ', 'IN'],
  CUSTOM: ['EQ'],
};

/** Rule types that are shown and flagged but can never stop an application. */
export const NEVER_BLOCKING_RULE_TYPES: readonly EligibilityRuleType[] = ['CUSTOM', 'WORK_AUTHORIZATION'];

export const MAX_ELIGIBILITY_RULES = 12;
export const MAX_CUSTOM_RULES = 5;
export const MAX_SKILLS = 30;
export const MAX_STAGES = 12;
const MAX_LIST_ENTRIES = 20;

/**
 * Words that name a protected attribute (gender, religion, caste, age, disability, marital
 * status, region of origin) or an obvious proxy (photo, height, weight, complexion). A rule
 * that mentions one is refused. Deliberately words, not substrings: "Stage", "Management" and
 * "B.Sc" must pass.
 */
const PROTECTED_TERMS = new RegExp('\\b(' + [
  'gender', 'genders', 'sex', 'male', 'males', 'female', 'females', 'man', 'men', 'woman', 'women', 'boy', 'boys', 'girl', 'girls',
  'transgender', 'religion', 'religions', 'religious', 'hindu', 'hindus', 'muslim', 'muslims', 'christian', 'christians', 'sikh', 'sikhs',
  'jain', 'jains', 'buddhist', 'buddhists', 'parsi', 'caste', 'castes', 'scheduled caste', 'scheduled tribe', 'obc', 'dalit', 'brahmin',
  'age', 'aged', 'ages', 'years old', 'year old', 'date of birth', 'born', 'married', 'unmarried', 'marital', 'spouse', 'pregnant', 'pregnancy',
  'disability', 'disabilities', 'disabled', 'handicap', 'handicapped', 'able-bodied', 'domicile', 'native of', 'natives', 'hometown',
  'region of origin', 'state of origin', 'place of birth', 'photo', 'photograph', 'photos', 'height', 'weight', 'complexion', 'fair skin',
].map((term) => term.replace(/[-]/g, '\\-')).join('|') + ')\\b', 'i');

export function mentionsProtectedAttribute(text: string): boolean {
  return PROTECTED_TERMS.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new RequirementInputError(code);
}

function safeText(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string') throw new RequirementInputError(code);
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < 1 || text.length > max || spreadsheetPrefix.test(text)) throw new RequirementInputError(code);
  return text;
}

/** A comma-separated list, each entry trimmed and safe; stored as "a, b". */
function textList(value: unknown, entryMax: number, code: string): string {
  if (typeof value !== 'string') throw new RequirementInputError(code);
  const entries = value.split(',').map((entry) => entry.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (!entries.length || entries.length > MAX_LIST_ENTRIES) throw new RequirementInputError(code);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.length > entryMax || spreadsheetPrefix.test(entry) || seen.has(entry.toLowerCase())) throw new RequirementInputError(code);
    seen.add(entry.toLowerCase());
  }
  const joined = entries.join(', ');
  if (joined.length > 500) throw new RequirementInputError(code);
  return joined;
}

function numberIn(value: unknown, min: number, max: number, integer: boolean, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RequirementInputError(code);
  if (integer && !Number.isInteger(value)) throw new RequirementInputError(code);
  if (!integer && Math.round(value * 100) !== value * 100) throw new RequirementInputError(code);
  return value;
}

/**
 * Parse the eligibility rules of a version. The whole list replaces the previous version's list.
 * Throws RequirementInputError with a stable code.
 */
export function parseEligibilityRules(value: unknown): EligibilityRule[] {
  const code = 'INVALID_ELIGIBILITY_RULES';
  if (!Array.isArray(value) || value.length > MAX_ELIGIBILITY_RULES) throw new RequirementInputError(code);
  const seenTypes = new Set<EligibilityRuleType>();
  let customCount = 0;
  return value.map((entry): EligibilityRule => {
    if (!isRecord(entry)) throw new RequirementInputError(code);
    rejectUnknown(entry, ['ruleType', 'comparator', 'valueNumeric', 'valueText', 'isBlocking'], code);
    const ruleType = entry.ruleType as EligibilityRuleType;
    if (!ELIGIBILITY_RULE_TYPES.includes(ruleType)) throw new RequirementInputError(code);
    const comparator = entry.comparator as EligibilityComparator;
    if (!ELIGIBILITY_COMPARATORS[ruleType].includes(comparator)) throw new RequirementInputError(code);
    if (ruleType === 'CUSTOM') {
      customCount += 1;
      if (customCount > MAX_CUSTOM_RULES) throw new RequirementInputError(code);
    } else {
      if (seenTypes.has(ruleType)) throw new RequirementInputError('DUPLICATE_ELIGIBILITY_RULE');
      seenTypes.add(ruleType);
    }
    const neverBlocks = NEVER_BLOCKING_RULE_TYPES.includes(ruleType);
    if (entry.isBlocking !== undefined && typeof entry.isBlocking !== 'boolean') throw new RequirementInputError(code);
    const isBlocking = entry.isBlocking === undefined ? !neverBlocks : entry.isBlocking;
    if (neverBlocks && isBlocking) throw new RequirementInputError('ELIGIBILITY_RULE_CANNOT_BLOCK');

    const list = comparator === 'IN' || comparator === 'NOT_IN';
    let valueNumeric: number | null = null;
    let valueText: string | null = null;
    switch (ruleType) {
      case 'MIN_CGPA':
        valueNumeric = numberIn(entry.valueNumeric, 0.01, 10, false, code);
        break;
      case 'MAX_BACKLOGS':
        valueNumeric = numberIn(entry.valueNumeric, 0, 99, true, code);
        break;
      case 'GRADUATION_YEAR':
        if (list) {
          valueText = textList(entry.valueText, 4, code);
          if (!valueText.split(', ').every((year) => /^(19[5-9]\d|20\d\d|2100)$/.test(year))) throw new RequirementInputError(code);
        } else {
          valueNumeric = numberIn(entry.valueNumeric, 1950, 2100, true, code);
        }
        break;
      case 'INSTITUTION':
        valueText = list ? textList(entry.valueText, 36, code) : safeText(entry.valueText, 36, code);
        if (!valueText.split(', ').every((id) => uuidPattern.test(id))) throw new RequirementInputError(code);
        valueText = valueText.toLowerCase();
        break;
      case 'DEPARTMENT':
      case 'PROGRAM':
      case 'WORK_AUTHORIZATION':
        valueText = list ? textList(entry.valueText, 120, code) : safeText(entry.valueText, 120, code);
        break;
      case 'CUSTOM':
        valueText = safeText(entry.valueText, 500, code);
        break;
    }
    // A numeric rule carries no text and a text rule no number; anything else is a malformed body.
    if (valueNumeric === null && entry.valueNumeric !== undefined && entry.valueNumeric !== null) throw new RequirementInputError(code);
    if (valueText === null && entry.valueText !== undefined && entry.valueText !== null) throw new RequirementInputError(code);
    if (valueText !== null && mentionsProtectedAttribute(valueText)) throw new RequirementInputError('ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE');
    return { ruleType, comparator, valueNumeric, valueText, isBlocking };
  });
}

export type SkillRequirementLevel = 'REQUIRED' | 'PREFERRED';

export interface SkillRequirementInput {
  /** Set for a free-text skill; null when the skill is a catalogue topic (the server names it). */
  readonly name: string | null;
  /** A catalogue skill: a taxonomy topic named by a published career-role requirement (OPS-08). */
  readonly taxonomyTopicId: string | null;
  readonly level: SkillRequirementLevel;
}

export function parseSkillRequirements(value: unknown): SkillRequirementInput[] {
  const code = 'INVALID_SKILLS';
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw new RequirementInputError(code);
  const names = new Set<string>();
  const topics = new Set<string>();
  return value.map((entry): SkillRequirementInput => {
    if (!isRecord(entry)) throw new RequirementInputError(code);
    rejectUnknown(entry, ['name', 'taxonomyTopicId', 'level'], code);
    if (entry.level !== 'REQUIRED' && entry.level !== 'PREFERRED') throw new RequirementInputError(code);
    const hasTopic = entry.taxonomyTopicId !== undefined && entry.taxonomyTopicId !== null;
    const hasName = entry.name !== undefined && entry.name !== null;
    // Exactly one: a catalogue skill is named by the catalogue, never by the client.
    if (hasTopic === hasName) throw new RequirementInputError(code);
    if (hasTopic) {
      if (typeof entry.taxonomyTopicId !== 'string' || !uuidPattern.test(entry.taxonomyTopicId)) throw new RequirementInputError(code);
      const topic = entry.taxonomyTopicId.toLowerCase();
      if (topics.has(topic)) throw new RequirementInputError('DUPLICATE_SKILL');
      topics.add(topic);
      return { name: null, taxonomyTopicId: topic, level: entry.level };
    }
    const name = safeText(entry.name, 120, code);
    if (names.has(name.toLowerCase())) throw new RequirementInputError('DUPLICATE_SKILL');
    names.add(name.toLowerCase());
    return { name, taxonomyTopicId: null, level: entry.level };
  });
}

export type SelectionStageKind = 'SCREENING' | 'ASSESSMENT' | 'INTERVIEW' | 'GROUP_DISCUSSION' | 'OFFER';
export const SELECTION_STAGE_KINDS: readonly SelectionStageKind[] = ['SCREENING', 'ASSESSMENT', 'INTERVIEW', 'GROUP_DISCUSSION', 'OFFER'];

/**
 * The application state a stage moves an applicant to. The pipeline states are fixed and
 * forward-only (packages/hiring assertApplicationTransition); a stage is the employer's name
 * for a step within them. A group discussion is an assessment round.
 */
export const STAGE_APPLICATION_STATE: Readonly<Record<SelectionStageKind, ApplicationState>> = {
  SCREENING: 'SCREENING', ASSESSMENT: 'ASSESSMENT', GROUP_DISCUSSION: 'ASSESSMENT', INTERVIEW: 'INTERVIEW', OFFER: 'OFFER',
};

const PIPELINE_ORDER: readonly ApplicationState[] = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'];

export function pipelineIndex(state: ApplicationState | string): number {
  return PIPELINE_ORDER.indexOf(state as ApplicationState);
}

export interface SelectionStageInput {
  readonly kind: SelectionStageKind;
  readonly label: string;
  readonly detail: string | null;
  /** EMP-09: the scorecard template an INTERVIEW or GROUP_DISCUSSION stage uses, if any. */
  readonly scorecardTemplateId: string | null;
}

/** Stage kinds whose interviews are scored, so the only ones that may carry a scorecard template. */
export const SCORED_STAGE_KINDS: readonly SelectionStageKind[] = ['INTERVIEW', 'GROUP_DISCUSSION'];

/**
 * Parse the ordered stages of a version (order = position in the list). The order must follow
 * the pipeline, because the pipeline cannot move backwards: an interview listed before the
 * screening could never be reached in that order. An offer, if listed, comes last.
 */
export function parseSelectionStages(value: unknown): SelectionStageInput[] {
  const code = 'INVALID_STAGES';
  if (!Array.isArray(value) || value.length > MAX_STAGES) throw new RequirementInputError(code);
  const stages = value.map((entry): SelectionStageInput => {
    if (!isRecord(entry)) throw new RequirementInputError(code);
    rejectUnknown(entry, ['kind', 'label', 'detail', 'scorecardTemplateId'], code);
    const kind = entry.kind as SelectionStageKind;
    if (!SELECTION_STAGE_KINDS.includes(kind)) throw new RequirementInputError(code);
    const detail = entry.detail === undefined || entry.detail === null || entry.detail === '' ? null : safeText(entry.detail, 1000, code);
    let scorecardTemplateId: string | null = null;
    if (entry.scorecardTemplateId !== undefined && entry.scorecardTemplateId !== null) {
      if (typeof entry.scorecardTemplateId !== 'string' || !uuidPattern.test(entry.scorecardTemplateId) || !SCORED_STAGE_KINDS.includes(kind)) {
        throw new RequirementInputError(code);
      }
      scorecardTemplateId = entry.scorecardTemplateId.toLowerCase();
    }
    return { kind, label: safeText(entry.label, 120, code), detail, scorecardTemplateId };
  });
  let previous = -1;
  stages.forEach((stage, index) => {
    const position = pipelineIndex(STAGE_APPLICATION_STATE[stage.kind]);
    if (position < previous) throw new RequirementInputError('STAGE_ORDER_INVALID');
    if (stage.kind === 'OFFER' && index !== stages.length - 1) throw new RequirementInputError('STAGE_ORDER_INVALID');
    previous = position;
  });
  return stages;
}

/**
 * Reason codes for a new version (Appendix 2 §5.7). Required when a live job's eligibility
 * changes, because that moves the terms every applicant applied under; optional otherwise.
 */
export const opportunityVersionReasonCodes = [
  'DETAILS_CORRECTED', 'TERMS_UPDATED', 'ELIGIBILITY_CORRECTED', 'ELIGIBILITY_RELAXED', 'ELIGIBILITY_TIGHTENED',
  'PLACEMENT_OFFICE_REQUEST', 'SKILLS_UPDATED', 'STAGES_UPDATED',
] as const;
export type OpportunityVersionReasonCode = typeof opportunityVersionReasonCodes[number];
