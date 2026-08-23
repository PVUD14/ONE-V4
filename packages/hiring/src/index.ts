import { createHash } from 'node:crypto';

/**
 * Pure hiring domain rules: application, interview and offer lifecycles, material
 * term-change detection, and eligibility evaluation.
 *
 * Deliberately free of database and transport concerns so the rules can be tested
 * exhaustively without Postgres, mirroring the shape of @planthepath/career-readiness.
 * Persistence enforces the same invariants structurally; this module is what produces
 * a useful error before the database has to reject anything.
 */

export type ApplicationState =
  | 'DRAFT' | 'APPLIED' | 'SCREENING' | 'SHORTLISTED' | 'ASSESSMENT'
  | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';

export type InterviewState = 'SCHEDULED' | 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type OfferState = 'DRAFT' | 'EXTENDED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

/** Who is attempting the change. Authorization of the identity happens upstream. */
export type HiringActor = 'STUDENT' | 'EMPLOYER';

export type HiringRuleCode =
  | 'INVALID_TRANSITION'
  | 'APPLICATION_CLOSED'
  | 'ACTOR_NOT_PERMITTED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_REVOKED'
  | 'OPPORTUNITY_NOT_OPEN'
  | 'DEADLINE_PASSED'
  | 'OFFER_NOT_ACCEPTED'
  | 'TERMS_ACKNOWLEDGEMENT_REQUIRED';

export class HiringRuleError extends Error {
  constructor(readonly code: HiringRuleCode, message: string) {
    super(message);
    this.name = 'HiringRuleError';
  }
}

export const TERMINAL_APPLICATION_STATES: readonly ApplicationState[] = ['HIRED', 'REJECTED', 'WITHDRAWN'];

export function isTerminalApplicationState(state: ApplicationState): boolean {
  return TERMINAL_APPLICATION_STATES.includes(state);
}

/**
 * The employer pipeline is ordered. Skipping ahead is allowed (an employer may
 * shortlist straight from Applied), but moving backwards is not: it would silently
 * invalidate interviews and offers already recorded against the later stage.
 */
const EMPLOYER_PIPELINE: readonly ApplicationState[] = [
  'APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER',
];

interface TransitionRule {
  readonly to: ApplicationState;
  readonly actor: HiringActor;
}

/** Transitions that are not simple forward movement through the pipeline. */
const EXPLICIT_TRANSITIONS: readonly TransitionRule[] = [
  { to: 'APPLIED', actor: 'STUDENT' },     // submitting a draft
  { to: 'WITHDRAWN', actor: 'STUDENT' },   // student pulls out
  { to: 'REJECTED', actor: 'EMPLOYER' },   // employer declines at any open stage
  { to: 'HIRED', actor: 'EMPLOYER' },      // only from OFFER, and only once accepted
];

export interface ApplicationTransitionInput {
  readonly from: ApplicationState;
  readonly to: ApplicationState;
  readonly actor: HiringActor;
  /** Required when moving to HIRED: hiring is a consequence of an accepted offer. */
  readonly offerState?: OfferState;
  /** Set when the employer changed material terms and the student has not re-consented. */
  readonly pendingTermsAcknowledgement?: boolean;
  readonly consentRevoked?: boolean;
}

/**
 * Throws HiringRuleError when a transition is not permitted. Returning void rather
 * than a boolean keeps the reason attached to the failure for the API error contract.
 */
export function assertApplicationTransition(input: ApplicationTransitionInput): void {
  const { from, to, actor } = input;

  if (from === to) {
    throw new HiringRuleError('INVALID_TRANSITION', `Application is already ${from}.`);
  }
  if (isTerminalApplicationState(from)) {
    throw new HiringRuleError('APPLICATION_CLOSED', `A ${from} application cannot change state.`);
  }
  if (input.consentRevoked && actor === 'EMPLOYER') {
    throw new HiringRuleError('CONSENT_REVOKED', 'The student has revoked consent for this application.');
  }

  // Student-owned transitions.
  if (to === 'APPLIED') {
    if (actor !== 'STUDENT') throw new HiringRuleError('ACTOR_NOT_PERMITTED', 'Only the student can submit an application.');
    if (from !== 'DRAFT') throw new HiringRuleError('INVALID_TRANSITION', 'Only a draft application can be submitted.');
    return;
  }
  if (to === 'WITHDRAWN') {
    if (actor !== 'STUDENT') throw new HiringRuleError('ACTOR_NOT_PERMITTED', 'Only the student can withdraw an application.');
    return;
  }

  // Everything below is employer-driven and requires a submitted application.
  if (actor !== 'EMPLOYER') {
    throw new HiringRuleError('ACTOR_NOT_PERMITTED', `A student cannot move an application to ${to}.`);
  }
  if (from === 'DRAFT') {
    throw new HiringRuleError('INVALID_TRANSITION', 'An unsubmitted application is not visible to the employer.');
  }

  if (to === 'REJECTED') return;

  if (to === 'HIRED') {
    if (from !== 'OFFER') throw new HiringRuleError('INVALID_TRANSITION', 'Only an application at offer stage can be marked hired.');
    if (input.offerState !== 'ACCEPTED') throw new HiringRuleError('OFFER_NOT_ACCEPTED', 'The offer must be accepted before the application is marked hired.');
    return;
  }

  const fromIndex = EMPLOYER_PIPELINE.indexOf(from);
  const toIndex = EMPLOYER_PIPELINE.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) {
    throw new HiringRuleError('INVALID_TRANSITION', `${from} cannot move to ${to}.`);
  }
  if (toIndex <= fromIndex) {
    throw new HiringRuleError('INVALID_TRANSITION', `An application cannot move backwards from ${from} to ${to}.`);
  }
  // Advancing someone who owes an acknowledgement would progress them against terms
  // they have not accepted.
  if (input.pendingTermsAcknowledgement) {
    throw new HiringRuleError('TERMS_ACKNOWLEDGEMENT_REQUIRED', 'The applicant has not acknowledged the updated terms.');
  }
}

export function canTransitionApplication(input: ApplicationTransitionInput): boolean {
  try {
    assertApplicationTransition(input);
    return true;
  } catch {
    return false;
  }
}

/** States from which an employer may still act. */
export function openApplicationStates(): readonly ApplicationState[] {
  return ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'];
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ApplySubmissionInput {
  readonly opportunityLifecycleState: string;
  readonly applicationDeadline?: Date | null;
  readonly now: Date;
  readonly consentGranted: boolean;
}

/** Guards submission itself, which the transition table cannot express. */
export function assertCanSubmitApplication(input: ApplySubmissionInput): void {
  if (input.opportunityLifecycleState !== 'PUBLISHED') {
    throw new HiringRuleError('OPPORTUNITY_NOT_OPEN', 'This opportunity is not open for applications.');
  }
  if (input.applicationDeadline && input.now > input.applicationDeadline) {
    throw new HiringRuleError('DEADLINE_PASSED', 'The application deadline for this opportunity has passed.');
  }
  if (!input.consentGranted) {
    throw new HiringRuleError('CONSENT_REQUIRED', 'Applying requires explicit consent to share your profile with this employer.');
  }
}

// ---------------------------------------------------------------------------
// Interview and offer lifecycles
// ---------------------------------------------------------------------------

const INTERVIEW_TRANSITIONS: Readonly<Record<InterviewState, readonly InterviewState[]>> = {
  SCHEDULED: ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  RESCHEDULED: ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function assertInterviewTransition(from: InterviewState, to: InterviewState): void {
  if (!INTERVIEW_TRANSITIONS[from].includes(to)) {
    throw new HiringRuleError('INVALID_TRANSITION', `An interview cannot move from ${from} to ${to}.`);
  }
}

const OFFER_TRANSITIONS: Readonly<Record<OfferState, readonly OfferState[]>> = {
  DRAFT: ['EXTENDED', 'WITHDRAWN'],
  EXTENDED: ['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export interface OfferTransitionInput {
  readonly from: OfferState;
  readonly to: OfferState;
  readonly actor: HiringActor;
}

export function assertOfferTransition(input: OfferTransitionInput): void {
  const { from, to, actor } = input;
  if (!OFFER_TRANSITIONS[from].includes(to)) {
    throw new HiringRuleError('INVALID_TRANSITION', `An offer cannot move from ${from} to ${to}.`);
  }
  // Accepting or declining belongs to the candidate; extending and withdrawing to the employer.
  const studentOwned: readonly OfferState[] = ['ACCEPTED', 'DECLINED'];
  if (studentOwned.includes(to) && actor !== 'STUDENT') {
    throw new HiringRuleError('ACTOR_NOT_PERMITTED', `Only the candidate can move an offer to ${to}.`);
  }
  if (!studentOwned.includes(to) && actor !== 'EMPLOYER') {
    throw new HiringRuleError('ACTOR_NOT_PERMITTED', `Only the employer can move an offer to ${to}.`);
  }
}

export function isOfferExpired(offerExpiresAt: Date | null | undefined, now: Date): boolean {
  return offerExpiresAt != null && now > offerExpiresAt;
}

// ---------------------------------------------------------------------------
// Material terms
// ---------------------------------------------------------------------------

/**
 * Fields whose change alters what an applicant agreed to. Editorial fields (title
 * wording, summary, responsibilities prose) are intentionally excluded: forcing
 * re-acknowledgement for a typo fix trains people to click through the ones that matter.
 */
export interface MaterialTerms {
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly compensationDisclosed: boolean;
  readonly compensationCurrency: string | null;
  readonly compensationMin: string | null;
  readonly compensationMax: string | null;
  readonly compensationPeriod: string | null;
  readonly durationMonths: number | null;
  readonly applicationDeadline: string | null;
  readonly joiningConditions: string | null;
}

const MATERIAL_TERM_KEYS: readonly (keyof MaterialTerms)[] = [
  'employmentType', 'workMode', 'locationCity', 'compensationDisclosed',
  'compensationCurrency', 'compensationMin', 'compensationMax', 'compensationPeriod',
  'durationMonths', 'applicationDeadline', 'joiningConditions',
];

/** Stable across key ordering so the hash depends on values, not object shape. */
export function materialTermsHash(terms: MaterialTerms): string {
  const canonical = MATERIAL_TERM_KEYS.map((key) => `${key}=${JSON.stringify(terms[key] ?? null)}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function materialTermsChanged(previous: MaterialTerms, next: MaterialTerms): boolean {
  return materialTermsHash(previous) !== materialTermsHash(next);
}

/** The specific fields that differ, for the notification sent to affected applicants. */
export function changedMaterialTerms(previous: MaterialTerms, next: MaterialTerms): readonly string[] {
  return MATERIAL_TERM_KEYS.filter((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null));
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type EligibilityRuleType =
  | 'MIN_CGPA' | 'MAX_BACKLOGS' | 'GRADUATION_YEAR' | 'DEPARTMENT'
  | 'PROGRAM' | 'INSTITUTION' | 'WORK_AUTHORIZATION' | 'CUSTOM';

export type EligibilityComparator = 'GTE' | 'LTE' | 'EQ' | 'IN' | 'NOT_IN';

export interface EligibilityRule {
  readonly ruleType: EligibilityRuleType;
  readonly comparator: EligibilityComparator;
  readonly valueNumeric?: number | null;
  readonly valueText?: string | null;
  readonly isBlocking: boolean;
}

export interface StudentEligibilityFacts {
  readonly cgpa?: number | null;
  readonly activeBacklogs?: number | null;
  readonly graduationYear?: number | null;
  readonly departmentName?: string | null;
  readonly programName?: string | null;
  readonly institutionId?: string | null;
  readonly workAuthorization?: string | null;
}

export interface EligibilityOutcome {
  readonly eligible: boolean;
  readonly blockingFailures: readonly EligibilityRuleType[];
  readonly advisoryFailures: readonly EligibilityRuleType[];
  /** Blocking rules that could not be evaluated because the fact is missing. */
  readonly undeterminable: readonly EligibilityRuleType[];
}

function factFor(rule: EligibilityRule, facts: StudentEligibilityFacts): number | string | null | undefined {
  switch (rule.ruleType) {
    case 'MIN_CGPA': return facts.cgpa;
    case 'MAX_BACKLOGS': return facts.activeBacklogs;
    case 'GRADUATION_YEAR': return facts.graduationYear;
    case 'DEPARTMENT': return facts.departmentName;
    case 'PROGRAM': return facts.programName;
    case 'INSTITUTION': return facts.institutionId;
    case 'WORK_AUTHORIZATION': return facts.workAuthorization;
    case 'CUSTOM': return undefined;
  }
}

function satisfies(rule: EligibilityRule, fact: number | string): boolean {
  const list = (rule.valueText ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  switch (rule.comparator) {
    case 'GTE': return typeof fact === 'number' && rule.valueNumeric != null && fact >= rule.valueNumeric;
    case 'LTE': return typeof fact === 'number' && rule.valueNumeric != null && fact <= rule.valueNumeric;
    case 'EQ':
      if (rule.valueNumeric != null) return typeof fact === 'number' && fact === rule.valueNumeric;
      return String(fact).toLowerCase() === (rule.valueText ?? '').trim().toLowerCase();
    case 'IN': return list.includes(String(fact).toLowerCase());
    case 'NOT_IN': return !list.includes(String(fact).toLowerCase());
  }
}

/**
 * Fails closed: a blocking rule whose fact is unknown makes the student ineligible
 * rather than quietly passing. A missing CGPA must never read as a high CGPA.
 * CUSTOM rules are never auto-evaluated and always require human review.
 */
export function evaluateEligibility(
  rules: readonly EligibilityRule[],
  facts: StudentEligibilityFacts,
): EligibilityOutcome {
  const blockingFailures: EligibilityRuleType[] = [];
  const advisoryFailures: EligibilityRuleType[] = [];
  const undeterminable: EligibilityRuleType[] = [];

  for (const rule of rules) {
    const fact = factFor(rule, facts);
    if (fact === undefined || fact === null || fact === '') {
      if (rule.isBlocking) undeterminable.push(rule.ruleType);
      else advisoryFailures.push(rule.ruleType);
      continue;
    }
    if (satisfies(rule, fact)) continue;
    if (rule.isBlocking) blockingFailures.push(rule.ruleType);
    else advisoryFailures.push(rule.ruleType);
  }

  return {
    eligible: blockingFailures.length === 0 && undeterminable.length === 0,
    blockingFailures,
    advisoryFailures,
    undeterminable,
  };
}

// ---------------------------------------------------------------------------
// Employer visibility
// ---------------------------------------------------------------------------

export interface ApplicantVisibilityInput {
  readonly viewerEmployerId: string;
  readonly applicationEmployerId: string;
  readonly applicationState: ApplicationState;
  readonly consentRevokedAt?: Date | null;
}

/**
 * An employer sees an applicant only through an application they own, that the
 * student actually submitted, and for which consent still stands.
 */
export function canEmployerViewApplicant(input: ApplicantVisibilityInput): boolean {
  if (input.viewerEmployerId !== input.applicationEmployerId) return false;
  if (input.applicationState === 'DRAFT') return false;
  if (input.consentRevokedAt) return false;
  return true;
}
