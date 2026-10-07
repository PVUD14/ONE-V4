/**
 * The tutor hint policy (ENG-22, `tutor-hint-policy-v1`) — pure.
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
 * Design: docs/architecture/tutor-hints-table-design.md (Decisions 2 and 6).
 */

export const TUTOR_HINT_POLICY_VERSION = 'tutor-hint-policy-v1' as const;

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
 * no AI reaches a real student, so only a deployment that declares itself the sandbox of sample
 * data may serve it. ENG-25 adds the live path for real students behind per-college flags.
 */
export type TutorAudience = 'SANDBOX' | 'NONE';

export function tutorAudienceFromEnvironment(env: Readonly<Record<string, string | undefined>>): TutorAudience {
  return env.ONE_AI_TUTOR_AUDIENCE === 'sandbox' && env.ONE_SANDBOX === 'true' && env.NODE_ENV !== 'production' ? 'SANDBOX' : 'NONE';
}

export const TUTOR_REFUSAL_REASONS = [
  'ASSESSMENT_MODE', 'OFF', 'NO_CONSENT', 'LANGUAGE_NOT_SUPPORTED', 'NO_LADDER', 'HINTS_USED', 'PENDING', 'DAILY_LIMIT',
] as const;
export type TutorRefusalReason = (typeof TUTOR_REFUSAL_REASONS)[number];

export interface TutorHintPolicyInput {
  /** The learning session mode the question is served in. */
  readonly sessionMode: string;
  readonly audience: TutorAudience;
  /** The `tutor.hint` policy row is enabled (and the kill switch released — `loadAiFeaturePolicy` folds it in). */
  readonly featureEnabled: boolean;
  readonly killSwitchEngaged: boolean;
  /** The student holds `ai-tutoring` (ENG-01), read on this request. */
  readonly consented: boolean;
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
  if (input.audience !== 'SANDBOX' || !input.featureEnabled || input.killSwitchEngaged) return refuse('OFF');
  if (!input.consented) return refuse('NO_CONSENT');
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
