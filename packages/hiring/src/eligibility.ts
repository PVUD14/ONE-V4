/**
 * Eligibility evaluation against a student's academic record (EMP-06).
 *
 * Campus hiring runs on eligibility — minimum CGPA, backlogs, branch, graduation year — and
 * until EMP-06 nothing resolved those facts from the records ONE holds (EMPLOYER_BASELINE D-5).
 * This module is the whole evaluator, pure and free of database and transport, so every rule is
 * unit-tested: the API reads the records, this decides.
 *
 * The rules it keeps:
 *  - Prefer institution-verified records; where no verified value exists use the student's own
 *    declaration, and say so. Every outcome carries its basis (VERIFIED, INSTITUTION_RECORD or
 *    SELF_REPORTED), and anything resting on a self-reported figure is flagged to the employer.
 *  - Normalise only at comparison time. A result is compared as a 10-point equivalent using the
 *    same linear rule as asCgpa10 in packages/persistence academic-records.ts; letter and
 *    pass/fail scales cannot be ordered across institutions and are UNKNOWN, never guessed.
 *  - Unknown is not failing. A blocking rule whose fact is unknown still stops the application
 *    (fail closed: a missing CGPA must never read as a high one), but the student is told the
 *    information is missing, not that they fall short.
 *  - CUSTOM rules are never evaluated and never block; they are shown to students and flagged to
 *    the employer for a person to judge. ONE never rejects anyone automatically.
 */
import type { EligibilityComparator, EligibilityRule, EligibilityRuleType } from './index.js';

export const ELIGIBILITY_EVALUATOR_VERSION = 'emp06-eligibility-v1';

/** Where a fact came from. INSTITUTION_RECORD is the college's own roster (department, programme, expected graduation). */
export type FactBasis = 'VERIFIED' | 'INSTITUTION_RECORD' | 'SELF_REPORTED';
export type RuleOutcomeKind = 'MET' | 'NOT_MET' | 'UNKNOWN' | 'NOT_EVALUATED';
/** Why a fact is unknown, so the student is told what would fix it. */
export type UnknownReason = 'NO_RECORD' | 'SCALE_NOT_COMPARABLE' | 'NOT_RECORDED_BY_ONE';

export interface AcademicTermRecord {
  readonly sequence: number;
  readonly label: string;
  readonly resultValue: number | null;
  readonly resultScale: string | null;
  readonly backlogCount: number | null;
  readonly verificationState: string;
}

export interface AcademicQualificationRecord {
  readonly id: string;
  readonly institutionId: string | null;
  readonly completedOn: string | null;
  readonly verificationState: string;
  readonly terms: readonly AcademicTermRecord[];
}

/** The student's live relationship record at a college (institution_student_profiles). */
export interface InstitutionRecord {
  readonly institutionId: string;
  readonly departmentName: string | null;
  readonly programName: string | null;
  readonly graduationYear: number | null;
}

export interface EligibilityRecords {
  readonly institution: InstitutionRecord | null;
  /** Newest first (started_on DESC NULLS LAST, then most recently created). */
  readonly qualifications: readonly AcademicQualificationRecord[];
}

export interface ResolvedFact<T> {
  readonly value: T;
  readonly basis: FactBasis;
  /** What the student sees about their own fact, e.g. "8.2 on a 10-point CGPA (Semester 6)". */
  readonly detail: string;
}

export interface ResolvedEligibilityFacts {
  readonly cgpa10: ResolvedFact<number> | null;
  readonly cgpaUnknownReason: UnknownReason | null;
  readonly activeBacklogs: ResolvedFact<number> | null;
  readonly graduationYear: ResolvedFact<number> | null;
  readonly department: ResolvedFact<string> | null;
  readonly program: ResolvedFact<string> | null;
  readonly institutionId: ResolvedFact<string> | null;
}

const NUMERIC_SCALES: Readonly<Record<string, number>> = { CGPA_10: 10, GPA_4: 4, PERCENTAGE: 100 };
const SCALE_NAMES: Readonly<Record<string, string>> = { CGPA_10: 'a 10-point CGPA', GPA_4: 'a 4-point GPA', PERCENTAGE: 'a percentage' };

/** A 10-point equivalent for comparison only, or null where the scale cannot be ordered. */
export function cgpa10Equivalent(value: number | null, scale: string | null): number | null {
  if (value === null || scale === null) return null;
  const max = NUMERIC_SCALES[scale];
  if (!max) return null;
  return Math.round((value / max) * 10 * 1000) / 1000;
}

function usable(state: string): boolean {
  return state !== 'REJECTED';
}

/**
 * The qualification eligibility is read from: the newest one at the student's current college
 * where there is a live relationship, otherwise the newest one they have. A rejected submission
 * is never used.
 */
function primaryQualification(records: EligibilityRecords): AcademicQualificationRecord | null {
  const candidates = records.qualifications.filter((qualification) => usable(qualification.verificationState));
  if (records.institution) {
    const atCollege = candidates.find((qualification) => qualification.institutionId === records.institution!.institutionId);
    if (atCollege) return atCollege;
  }
  return candidates[0] ?? null;
}

function latestBySequence(terms: readonly AcademicTermRecord[]): AcademicTermRecord | null {
  return terms.reduce<AcademicTermRecord | null>((latest, term) => (!latest || term.sequence > latest.sequence ? term : latest), null);
}

function resolveCgpa(qualification: AcademicQualificationRecord | null): { fact: ResolvedFact<number> | null; unknown: UnknownReason | null } {
  if (!qualification) return { fact: null, unknown: 'NO_RECORD' };
  const terms = qualification.terms.filter((term) => usable(term.verificationState));
  const numeric = (term: AcademicTermRecord) => term.resultValue !== null && term.resultScale !== null && NUMERIC_SCALES[term.resultScale] !== undefined;
  const pick = (verified: boolean): AcademicTermRecord | null =>
    latestBySequence(terms.filter((term) => numeric(term) && (term.verificationState === 'VERIFIED') === verified));
  const verified = pick(true);
  const chosen = verified ?? pick(false);
  if (!chosen) {
    // Results exist but only on scales that cannot be ordered (letter grades, pass/fail).
    const anyResult = terms.some((term) => term.resultScale !== null);
    return { fact: null, unknown: anyResult ? 'SCALE_NOT_COMPARABLE' : 'NO_RECORD' };
  }
  return {
    fact: {
      value: cgpa10Equivalent(chosen.resultValue, chosen.resultScale)!,
      basis: verified ? 'VERIFIED' : 'SELF_REPORTED',
      detail: `${chosen.resultValue} on ${SCALE_NAMES[chosen.resultScale!]} (${chosen.label})`,
    },
    unknown: null,
  };
}

/**
 * Backlogs are stored per term and summed here, never stored (academic-records design,
 * resolution 4). Verified terms are used where any report a count; otherwise the student's own.
 */
function resolveBacklogs(qualification: AcademicQualificationRecord | null): ResolvedFact<number> | null {
  if (!qualification) return null;
  const counted = qualification.terms.filter((term) => usable(term.verificationState) && term.backlogCount !== null);
  const verified = counted.filter((term) => term.verificationState === 'VERIFIED');
  const used = verified.length ? verified : counted;
  if (!used.length) return null;
  const total = used.reduce((sum, term) => sum + (term.backlogCount ?? 0), 0);
  return { value: total, basis: verified.length ? 'VERIFIED' : 'SELF_REPORTED', detail: `${total} across ${used.length} term${used.length === 1 ? '' : 's'}` };
}

function qualificationBasis(qualification: AcademicQualificationRecord): FactBasis {
  return qualification.verificationState === 'VERIFIED' ? 'VERIFIED' : 'SELF_REPORTED';
}

export function resolveEligibilityFacts(records: EligibilityRecords): ResolvedEligibilityFacts {
  const qualification = primaryQualification(records);
  const cgpa = resolveCgpa(qualification);
  const institution = records.institution;
  const completedYear = qualification?.completedOn ? Number(qualification.completedOn.slice(0, 4)) : null;

  const graduationYear: ResolvedFact<number> | null = institution?.graduationYear != null
    ? { value: institution.graduationYear, basis: 'INSTITUTION_RECORD', detail: String(institution.graduationYear) }
    : qualification && completedYear && Number.isInteger(completedYear)
      ? { value: completedYear, basis: qualificationBasis(qualification), detail: String(completedYear) }
      : null;

  const institutionId: ResolvedFact<string> | null = institution
    ? { value: institution.institutionId, basis: 'INSTITUTION_RECORD', detail: 'Your college' }
    : qualification?.institutionId
      ? { value: qualification.institutionId, basis: qualificationBasis(qualification), detail: 'Your college' }
      : null;

  return {
    cgpa10: cgpa.fact,
    cgpaUnknownReason: cgpa.unknown,
    activeBacklogs: resolveBacklogs(qualification),
    graduationYear,
    department: institution?.departmentName ? { value: institution.departmentName, basis: 'INSTITUTION_RECORD', detail: institution.departmentName } : null,
    program: institution?.programName ? { value: institution.programName, basis: 'INSTITUTION_RECORD', detail: institution.programName } : null,
    institutionId,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface RuleOutcome {
  readonly ruleType: EligibilityRuleType;
  readonly comparator: EligibilityComparator;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly isBlocking: boolean;
  readonly outcome: RuleOutcomeKind;
  /** Null when there was no fact (UNKNOWN) or nothing to evaluate (CUSTOM). */
  readonly basis: FactBasis | null;
  readonly unknownReason: UnknownReason | null;
  /** The employer should look at this one: advisory and unmet, custom, or self-reported. */
  readonly flagged: boolean;
  /** The student's own fact, for the student only. Never stored or sent to an employer. */
  readonly studentValue: string | null;
}

export interface EligibilityEvaluation {
  /** Every blocking rule is met. */
  readonly eligible: boolean;
  readonly outcomes: readonly RuleOutcome[];
  readonly blockingFailures: readonly RuleOutcome[];
  /** Blocking rules that could not be decided because a fact is missing. */
  readonly undetermined: readonly RuleOutcome[];
  readonly flagCount: number;
  readonly selfReportedCount: number;
}

function listOf(valueText: string | null | undefined): string[] {
  return (valueText ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function factFor(ruleType: EligibilityRuleType, facts: ResolvedEligibilityFacts): ResolvedFact<number | string> | null {
  switch (ruleType) {
    case 'MIN_CGPA': return facts.cgpa10;
    case 'MAX_BACKLOGS': return facts.activeBacklogs;
    case 'GRADUATION_YEAR': return facts.graduationYear;
    case 'DEPARTMENT': return facts.department;
    case 'PROGRAM': return facts.program;
    case 'INSTITUTION': return facts.institutionId;
    case 'WORK_AUTHORIZATION':
    case 'CUSTOM':
      return null;
  }
}

function compare(rule: EligibilityRule, fact: number | string): boolean {
  const list = listOf(rule.valueText);
  const text = String(fact).trim().toLowerCase();
  switch (rule.comparator) {
    case 'GTE': return typeof fact === 'number' && rule.valueNumeric != null && fact >= rule.valueNumeric;
    case 'LTE': return typeof fact === 'number' && rule.valueNumeric != null && fact <= rule.valueNumeric;
    case 'EQ':
      if (rule.valueNumeric != null) return typeof fact === 'number' && fact === rule.valueNumeric;
      return text === (rule.valueText ?? '').trim().toLowerCase();
    case 'IN': return list.includes(text);
    case 'NOT_IN': return !list.includes(text);
  }
}

function evaluateRule(rule: EligibilityRule, facts: ResolvedEligibilityFacts): RuleOutcome {
  const base = {
    ruleType: rule.ruleType, comparator: rule.comparator,
    valueNumeric: rule.valueNumeric ?? null, valueText: rule.valueText ?? null,
    // CUSTOM and WORK_AUTHORIZATION never block, whatever the row says (§5.4; design doc).
    isBlocking: rule.isBlocking && rule.ruleType !== 'CUSTOM' && rule.ruleType !== 'WORK_AUTHORIZATION',
  };
  if (rule.ruleType === 'CUSTOM') {
    return { ...base, outcome: 'NOT_EVALUATED', basis: null, unknownReason: null, flagged: true, studentValue: null };
  }
  const fact = factFor(rule.ruleType, facts);
  if (!fact) {
    const unknownReason: UnknownReason = rule.ruleType === 'WORK_AUTHORIZATION' ? 'NOT_RECORDED_BY_ONE'
      : rule.ruleType === 'MIN_CGPA' ? (facts.cgpaUnknownReason ?? 'NO_RECORD') : 'NO_RECORD';
    return { ...base, outcome: 'UNKNOWN', basis: null, unknownReason, flagged: !base.isBlocking, studentValue: null };
  }
  const met = compare(rule, fact.value);
  const selfReported = fact.basis === 'SELF_REPORTED';
  return {
    ...base,
    outcome: met ? 'MET' : 'NOT_MET',
    basis: fact.basis,
    unknownReason: null,
    flagged: selfReported || (!base.isBlocking && !met),
    studentValue: fact.detail,
  };
}

export function evaluateOpportunityEligibility(rules: readonly EligibilityRule[], facts: ResolvedEligibilityFacts): EligibilityEvaluation {
  const outcomes = rules.map((rule) => evaluateRule(rule, facts));
  const blockingFailures = outcomes.filter((outcome) => outcome.isBlocking && outcome.outcome === 'NOT_MET');
  const undetermined = outcomes.filter((outcome) => outcome.isBlocking && outcome.outcome === 'UNKNOWN');
  return {
    eligible: blockingFailures.length === 0 && undetermined.length === 0,
    outcomes,
    blockingFailures,
    undetermined,
    flagCount: outcomes.filter((outcome) => outcome.flagged).length,
    selfReportedCount: outcomes.filter((outcome) => outcome.basis === 'SELF_REPORTED').length,
  };
}

/** Records to verdict in one call. */
export function evaluateStudentEligibility(rules: readonly EligibilityRule[], records: EligibilityRecords): EligibilityEvaluation {
  return evaluateOpportunityEligibility(rules, resolveEligibilityFacts(records));
}

/** What is stored and shown to an employer: the outcome and its basis, never the student's figure. */
export function employerOutcome(outcome: RuleOutcome): Omit<RuleOutcome, 'studentValue'> {
  const { studentValue: _studentValue, ...rest } = outcome;
  return rest;
}
