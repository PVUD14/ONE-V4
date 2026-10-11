/**
 * How eligibility rules, their outcomes and a job's stages read to a person (EMP-06).
 *
 * One wording for every screen that shows a rule — the student's opportunity detail, the
 * employer's Opportunity Detail and editor, the Applicants flags and the new-terms card — so a
 * rule never says one thing to the student and another to the employer. A college is shown by
 * its name (the server's displayValue), never its identifier.
 */
import type { EligibilityBasis, EligibilityRuleDto, SelectionStageDto } from './api/hiring.js';

const years = (text: string | null) => (text ?? '').split(',').map((part) => part.trim()).filter(Boolean).join(', ');

/** "Minimum CGPA 7 (10-point scale)", "At most 1 active backlog", "Department: CSE, ECE". */
export function describeEligibilityRule(rule: EligibilityRuleDto): string {
  const value = rule.displayValue ?? (rule.valueNumeric != null ? String(rule.valueNumeric) : rule.valueText ?? '');
  const not = rule.comparator === 'NOT_IN';
  switch (rule.ruleType) {
    case 'MIN_CGPA': return `Minimum CGPA ${value} (10-point scale)`;
    case 'MAX_BACKLOGS': return rule.valueNumeric === 0 ? 'No active backlogs' : `At most ${value} active backlog${rule.valueNumeric === 1 ? '' : 's'}`;
    case 'GRADUATION_YEAR':
      if (rule.comparator === 'GTE') return `Graduating in ${value} or later`;
      if (rule.comparator === 'LTE') return `Graduated in ${value} or earlier`;
      return `${not ? 'Not graduating in' : 'Graduating in'} ${rule.valueText ? years(rule.valueText) : value}`;
    case 'DEPARTMENT': return `${not ? 'Department not' : 'Department'}: ${value}`;
    case 'PROGRAM': return `${not ? 'Programme not' : 'Programme'}: ${value}`;
    case 'INSTITUTION': return `${not ? 'College not' : 'College'}: ${value}`;
    case 'WORK_AUTHORIZATION': return `Work authorisation: ${value}`;
    case 'CUSTOM': return value;
    default: return value;
  }
}

export const basisLabels: Readonly<Record<EligibilityBasis, string>> = {
  VERIFIED: 'verified by the college',
  INSTITUTION_RECORD: 'from the college record',
  SELF_REPORTED: 'self-reported',
};

/** Why a rule could not be checked, said as what would fix it. */
export function unknownReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'SCALE_NOT_COMPARABLE': return 'Your results are letter grades or pass/fail, which cannot be compared with this rule.';
    case 'NOT_RECORDED_BY_ONE': return 'ONE does not record this; the employer will check it with you.';
    default: return 'This is not on your record yet. Ask your college to add your results to ONE.';
  }
}

export const stageKindLabels: Readonly<Record<string, string>> = {
  SCREENING: 'Screening', ASSESSMENT: 'Assessment', INTERVIEW: 'Interview', GROUP_DISCUSSION: 'Group discussion', OFFER: 'Offer',
};

/**
 * The job's stages still ahead of an application in `state`, in order: what the pipeline offers
 * next. A stage maps to an application state; the pipeline only moves forward.
 */
const PIPELINE: readonly string[] = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'];
export function stagesAhead(stages: readonly SelectionStageDto[], state: string): SelectionStageDto[] {
  const current = PIPELINE.indexOf(state);
  if (current < 0) return [];
  const seen = new Set<string>();
  // One button per state ahead, labelled by the first stage that moves there.
  return stages.filter((stage) => {
    const target = stage.applicationState ?? '';
    if (PIPELINE.indexOf(target) <= current || seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

/** The job's stages an application in `state` is at, e.g. "Technical interview / HR interview". */
export function stagesAt(stages: readonly SelectionStageDto[], state: string): string {
  return stages.filter((stage) => stage.applicationState === state).map((stage) => stage.label).join(' / ');
}
