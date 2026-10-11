/**
 * The tutor hint policy (ENG-22, `tutor-hint-policy-v2` since ENG-25) — pure.
 *
 * Why this exists: whether a student may ask the AI tutor for a hint is a product rule with several
 * parts (where the tutor exists, who has agreed to it, which deployment may serve it, which languages
 * were evaluated, the four-step ladder, a daily cap). Written once here, the API refuses for exactly
 * the reasons the screens explain, and the worker re-checks the same rules before any model call.
 *
 * The ladder is ENG-15's: level 1 nudge, 2 strategy, 3 worked step, 4 near solution; one level per
 * request; an AI hint *is* the next level, so the 0047 assisted rule (level 3 or more) applies to it
 * unchanged. Nothing here reads readiness, a score or a model number.
 *
 * v2 (ENG-25) adds the pilot audience: for real students of a college, the tutor also needs the college
 * switched on and the student's recorded group to be the tutor group. The sandbox's rules are v1's.
 *
 * Design: docs/architecture/tutor-hints-table-design.md (Decisions 2 and 6),
 * docs/architecture/tutor-rollout-design.md (Decision 1).
 */

export const TUTOR_HINT_POLICY_VERSION = 'tutor-hint-policy-v2' as const;

/** The AI feature and the prompt it runs (ENG-21's registration; the evaluation is bound to both). */
export const TUTOR_HINT_FEATURE_KEY = 'tutor.hint' as const;
export const TUTOR_HINT_PROMPT = { key: 'tutor-hint', version: 2 } as const;

export const MAX_TUTOR_HINT_LEVEL = 4;

/** AI hints one student may request in a database day. Fallbacks count: the request is what was spent. */
export const TUTOR_HINTS_PER_STUDENT_PER_DAY = 20;

/** How long a request may stay unanswered before the screen shows the human hint instead. */
export const TUTOR_HINT_PENDING_SECONDS = 45;

/** The languages the evaluation set covered (ENG-21). The tutor writes in no other. */
export const TUTOR_LANGUAGES = ['en', 'te', 'hi'] as const;
export type TutorLanguage = (typeof TUTOR_LANGUAGES)[number];

export function isTutorLanguage(value: unknown): value is TutorLanguage {
  return typeof value === 'string' && (TUTOR_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Where the tutor may appear. Practice on a learning step is LEARN / PRACTICE / REVIEW; a placement
 * sitting (DIAGNOSTIC), a readiness check (ASSESSMENT) or a college exam measures the student, and
 * the tutor is off there.
 */
export const TUTOR_SESSION_MODES = ['LEARN', 'PRACTICE', 'REVIEW'] as const;

/**
 * Which deployment the tutor may serve. Until HG-6 (the privacy notice names the inference venue)
 * no AI reaches a real student. SANDBOX: a deployment that declares itself the sandbox of sample data
 * (ENG-22). PILOT: a deployment that declares it serves the tutor pilot (ENG-25) — there the tutor also
 * needs the student's college switched on and the student in the tutor group. NONE: no tutor at all.
 */
export type TutorAudience = 'SANDBOX' | 'PILOT' | 'NONE';

export function tutorAudienceFromEnvironment(env: Readonly<Record<string, string | undefined>>): TutorAudience {
  if (env.ONE_AI_TUTOR_AUDIENCE === 'sandbox' && env.ONE_SANDBOX === 'true' && env.NODE_ENV !== 'production') return 'SANDBOX';
  if (env.ONE_AI_TUTOR_AUDIENCE === 'pilot') return 'PILOT';
  return 'NONE';
}

/** A student's recorded group in their college's tutor experiment (ENG-25). */
export type TutorGroup = 'TUTOR' | 'NO_TUTOR';

export const TUTOR_REFUSAL_REASONS = [
  'ASSESSMENT_MODE', 'OFF', 'COLLEGE_OFF', 'NO_CONSENT', 'NO_TUTOR_GROUP', 'LANGUAGE_NOT_SUPPORTED', 'NO_LADDER', 'HINTS_USED', 'PENDING', 'DAILY_LIMIT',
] as const;
export type TutorRefusalReason = (typeof TUTOR_REFUSAL_REASONS)[number];

/**
 * The reasons a student's screen may be given. The pilot's own reasons (college off, no-tutor group) are
 * shown as OFF, so a student outside the tutor group sees exactly what an AI-off student sees — no AI
 * control, and no sign that a group exists (tutor-rollout-design.md, Decision 6).
 */
export type TutorVisibleReason = Exclude<TutorRefusalReason, 'COLLEGE_OFF' | 'NO_TUTOR_GROUP'>;

export function visibleTutorReason(reason: TutorRefusalReason): TutorVisibleReason {
  return reason === 'COLLEGE_OFF' || reason === 'NO_TUTOR_GROUP' ? 'OFF' : reason;
}

export interface TutorHintPolicyInput {
  /** The learning session mode the question is served in. */
  readonly sessionMode: string;
  readonly audience: TutorAudience;
  /** The `tutor.hint` policy row is enabled (and the kill switch released — `loadAiFeaturePolicy` folds it in). */
  readonly featureEnabled: boolean;
  readonly killSwitchEngaged: boolean;
  /** The student holds `ai-tutoring` (ENG-01), read on this request. */
  readonly consented: boolean;
  /** PILOT only: the tutor is switched on for the step's college (ENG-25). Absent means no. */
  readonly collegeEnabled?: boolean;
  /** PILOT only: the student's recorded group in that college's experiment; absent or null means none. */
  readonly group?: TutorGroup | null;
  /** The student's lesson language (ENG-16). */
  readonly language: string;
  /** The question has a PUBLISHED hint ladder to ground on and to fall back to. */
  readonly ladderPublished: boolean;
  /** Levels already shown for this question (0–4). */
  readonly currentLevel: number;
  /** An AI hint for this question is still being written (inside the pending window). */
  readonly pending: boolean;
  /** AI hints this student requested today. */
  readonly requestedToday: number;
}

export type TutorHintDecision =
  | { readonly allowed: true; readonly level: 1 | 2 | 3 | 4; readonly language: TutorLanguage; readonly policyVersion: typeof TUTOR_HINT_POLICY_VERSION }
  | { readonly allowed: false; readonly reason: TutorRefusalReason; readonly policyVersion: typeof TUTOR_HINT_POLICY_VERSION };

/**
 * Whether the student may ask the AI tutor for the next hint on this question, and at which level.
 * The order is the order a student is told why: where they are, whether AI is on for them at all,
 * then what is specific to this question and to today.
 */
export function decideTutorHintRequest(input: TutorHintPolicyInput): TutorHintDecision {
  const refuse = (reason: TutorRefusalReason): TutorHintDecision => ({ allowed: false, reason, policyVersion: TUTOR_HINT_POLICY_VERSION });
  if (!(TUTOR_SESSION_MODES as readonly string[]).includes(input.sessionMode)) return refuse('ASSESSMENT_MODE');
  if (input.audience === 'NONE' || !input.featureEnabled || input.killSwitchEngaged) return refuse('OFF');
  const pilot = input.audience === 'PILOT';
  if (pilot && input.collegeEnabled !== true) return refuse('COLLEGE_OFF');
  if (!input.consented) return refuse('NO_CONSENT');
  if (pilot && input.group !== 'TUTOR') return refuse('NO_TUTOR_GROUP');
  if (!isTutorLanguage(input.language)) return refuse('LANGUAGE_NOT_SUPPORTED');
  if (!input.ladderPublished) return refuse('NO_LADDER');
  if (!Number.isInteger(input.currentLevel) || input.currentLevel < 0 || input.currentLevel >= MAX_TUTOR_HINT_LEVEL) return refuse('HINTS_USED');
  if (input.pending) return refuse('PENDING');
  if (!Number.isInteger(input.requestedToday) || input.requestedToday < 0 || input.requestedToday >= TUTOR_HINTS_PER_STUDENT_PER_DAY) return refuse('DAILY_LIMIT');
  return { allowed: true, level: (input.currentLevel + 1) as 1 | 2 | 3 | 4, language: input.language, policyVersion: TUTOR_HINT_POLICY_VERSION };
}

/** A hint level makes a right answer assisted from level 3 (0047, ENG-15) — the same for AI and human hints. */
export function tutorHintMakesAssisted(level: number): boolean {
  return level >= 3;
}
