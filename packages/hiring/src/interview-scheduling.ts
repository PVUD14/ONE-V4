/**
 * Interview scheduling rules (EMP-09): the reason codes a reschedule or cancellation must carry,
 * which joining links are acceptable, and scorecard templates and the ratings recorded against
 * them. Pure, so the API and its tests share one definition.
 * Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
 */

/** Why an interview moved (Appendix 2 §5.7). Never shown to the candidate. */
export const interviewRescheduleReasonCodes = [
  'CANDIDATE_REQUESTED', 'INTERVIEWER_UNAVAILABLE', 'SCHEDULING_CONFLICT', 'LOGISTICS_CHANGED', 'TECHNICAL_ISSUE',
] as const;
/** Why an interview was cancelled. Never shown to the candidate. */
export const interviewCancelReasonCodes = [
  'CANDIDATE_REQUESTED', 'CANDIDATE_WITHDREW', 'INTERVIEWER_UNAVAILABLE', 'POSITION_FILLED', 'PROCESS_CHANGED', 'SCHEDULED_IN_ERROR',
] as const;
/** Why a scorecard template was retired. */
export const scorecardTemplateRetireReasonCodes = ['NO_LONGER_USED', 'REPLACED', 'CREATED_IN_ERROR'] as const;

export const MAX_SCORECARD_CRITERIA = 12;

export class InterviewInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InterviewInputError';
  }
}

const spreadsheetPrefix = /^[=+@-]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A joining link must be plain https with a host and no embedded credentials, at most 512
 * characters (the interviews CHECK). Anything else is refused rather than repaired.
 */
export function isAcceptableJoiningLink(value: string): boolean {
  if (value.length > 512 || !/^https:\/\/[^\s]+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export interface ScorecardCriterionInput { readonly label: string; readonly guidance: string | null }
export interface ScorecardTemplateInput { readonly name: string; readonly guidance: string | null; readonly criteria: readonly ScorecardCriterionInput[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, code: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InterviewInputError(code);
    return null;
  }
  if (typeof value !== 'string') throw new InterviewInputError(code);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new InterviewInputError(code);
    return null;
  }
  if (trimmed.length > max || spreadsheetPrefix.test(trimmed)) throw new InterviewInputError(code);
  return trimmed;
}

/** A new template: a name, optional guidance and 1–12 criteria with distinct labels. */
export function parseScorecardTemplateInput(body: unknown): ScorecardTemplateInput {
  const code = 'INVALID_SCORECARD_TEMPLATE';
  if (!isRecord(body)) throw new InterviewInputError(code);
  for (const key of Object.keys(body)) if (!['name', 'guidance', 'criteria'].includes(key)) throw new InterviewInputError(code);
  const name = text(body.name, 120, code, true)!;
  const guidance = text(body.guidance, 2000, code, false);
  const criteriaCode = 'INVALID_SCORECARD_CRITERIA';
  if (!Array.isArray(body.criteria) || body.criteria.length < 1 || body.criteria.length > MAX_SCORECARD_CRITERIA) throw new InterviewInputError(criteriaCode);
  const criteria = body.criteria.map((entry): ScorecardCriterionInput => {
    if (!isRecord(entry)) throw new InterviewInputError(criteriaCode);
    for (const key of Object.keys(entry)) if (!['label', 'guidance'].includes(key)) throw new InterviewInputError(criteriaCode);
    return { label: text(entry.label, 120, criteriaCode, true)!, guidance: text(entry.guidance, 1000, criteriaCode, false) };
  });
  const labels = new Set<string>();
  for (const criterion of criteria) {
    const key = criterion.label.toLowerCase();
    if (labels.has(key)) throw new InterviewInputError('DUPLICATE_SCORECARD_CRITERION');
    labels.add(key);
  }
  return { name, guidance, criteria };
}

export interface CriterionRatingInput { readonly criterionId: string; readonly rating: number; readonly note: string | null }

/**
 * The per-criterion ratings on a scorecard, or undefined when the body has none. A rating is a
 * whole number from 1 to 5; nothing sums or averages them (Appendix 2 §5.3).
 */
export function parseCriterionRatings(value: unknown): CriterionRatingInput[] | undefined {
  if (value === undefined) return undefined;
  const code = 'INVALID_CRITERIA';
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCORECARD_CRITERIA) throw new InterviewInputError(code);
  return value.map((entry): CriterionRatingInput => {
    if (!isRecord(entry)) throw new InterviewInputError(code);
    for (const key of Object.keys(entry)) if (!['criterionId', 'rating', 'note'].includes(key)) throw new InterviewInputError(code);
    if (typeof entry.criterionId !== 'string' || !uuidPattern.test(entry.criterionId)) throw new InterviewInputError(code);
    const rating = entry.rating;
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new InterviewInputError(code);
    return { criterionId: entry.criterionId.toLowerCase(), rating, note: text(entry.note, 1000, code, false) };
  });
}

/** Every criterion of the template rated exactly once, and nothing else. */
export function assertRatingsFollowTemplate(ratings: readonly CriterionRatingInput[], criterionIds: readonly string[]): void {
  const expected = new Set(criterionIds.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  for (const rating of ratings) {
    if (!expected.has(rating.criterionId) || seen.has(rating.criterionId)) throw new InterviewInputError('SCORECARD_CRITERIA_MISMATCH');
    seen.add(rating.criterionId);
  }
  if (seen.size !== expected.size) throw new InterviewInputError('SCORECARD_CRITERIA_MISMATCH');
}
