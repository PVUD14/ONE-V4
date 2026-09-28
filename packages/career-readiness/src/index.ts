import { createHash } from 'node:crypto';

export type RightsReviewState = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ReviewState = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';
export type MappingState = 'UNMAPPED' | 'MAPPED' | 'REJECTED';
export type DuplicateState = 'UNCHECKED' | 'UNIQUE' | 'DUPLICATE' | 'MERGED';
export type ReleaseState = 'QUARANTINED' | 'ELIGIBLE' | 'RELEASED' | 'EXCLUDED';

export interface SourceRecordEvidence {
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceRecordId: string;
  readonly sourceHash: string;
  readonly transformVersion: string;
  readonly licenseLabel: string;
  readonly attributionRequired: boolean;
  readonly rightsState: RightsReviewState;
  readonly smeState: ReviewState;
  readonly qualityState: ReviewState;
  readonly mappingState: MappingState;
  readonly duplicateState: DuplicateState;
  readonly releaseState: ReleaseState;
  readonly rejectionReasonCodes: readonly string[];
}

export interface ImportPackageManifest {
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly transformVersion: string;
  readonly sourcePaths: readonly string[];
  readonly checksums: Readonly<Record<string, string>>;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly records: readonly SourceRecordEvidence[];
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function deterministicPackageIdentity(manifest: ImportPackageManifest): string {
  validateImportManifest(manifest);
  return `v4-${sha256Hex(stableStringify(manifest)).slice(0, 32)}`;
}

export function validateImportManifest(manifest: ImportPackageManifest): void {
  if (!/^[0-9a-f]{40}$/i.test(manifest.sourceCommit)) throw new Error('sourceCommit must be a full Git commit SHA');
  if (!/^[a-z0-9._-]{1,64}$/i.test(manifest.transformVersion)) throw new Error('transformVersion is invalid');
  if (manifest.sourcePaths.length === 0) throw new Error('sourcePaths must not be empty');
  if (new Set(manifest.sourcePaths).size !== manifest.sourcePaths.length) throw new Error('sourcePaths must be unique');
  for (const path of manifest.sourcePaths) {
    if (!manifest.checksums[path] || !/^[0-9a-f]{64}$/i.test(manifest.checksums[path])) throw new Error(`missing SHA-256 checksum for ${path}`);
  }
  const identities = new Set<string>();
  for (const record of manifest.records) {
    validateSourceRecordEvidence(record);
    const identity = `${record.sourcePath}:${record.sourceRecordId}`;
    if (identities.has(identity)) throw new Error(`duplicate source record identity ${identity}`);
    identities.add(identity);
    if (record.sourceCommit !== manifest.sourceCommit || record.sourceRepository !== manifest.sourceRepository) throw new Error('record source does not match package source');
    if (record.transformVersion !== manifest.transformVersion) throw new Error('record transform version does not match package');
  }
}

export function validateSourceRecordEvidence(record: SourceRecordEvidence): void {
  if (!/^[0-9a-f]{40}$/i.test(record.sourceCommit)) throw new Error('record sourceCommit must be a full Git commit SHA');
  if (!/^[0-9a-f]{64}$/i.test(record.sourceHash)) throw new Error('record sourceHash must be SHA-256');
  if (!record.sourceRepository || !record.sourcePath || !record.sourceRecordId || !record.licenseLabel) throw new Error('source identity and license label are required');
  for (const code of record.rejectionReasonCodes) {
    if (!/^[A-Z0-9_:-]{3,64}$/.test(code)) throw new Error(`invalid rejection reason code ${code}`);
  }
}

export function isSourceRecordReleaseEligible(record: SourceRecordEvidence): boolean {
  return record.rightsState === 'APPROVED'
    && record.smeState === 'APPROVED'
    && record.qualityState === 'APPROVED'
    && record.mappingState === 'MAPPED'
    && (record.duplicateState === 'UNIQUE' || record.duplicateState === 'MERGED')
    && record.rejectionReasonCodes.length === 0
    && (record.releaseState === 'ELIGIBLE' || record.releaseState === 'RELEASED');
}

export function assertReleaseManifestEligible(records: readonly SourceRecordEvidence[]): void {
  if (records.length === 0) throw new Error('release manifest must include at least one record');
  const blocked = records.filter((record) => !isSourceRecordReleaseEligible(record));
  if (blocked.length > 0) throw new Error(`release contains ${blocked.length} ineligible record(s)`);
}

export type ContentLifecycleState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
const allowedContentTransitions: Readonly<Record<ContentLifecycleState, readonly ContentLifecycleState[]>> = {
  DRAFT: ['IN_REVIEW'], IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'], CHANGES_REQUESTED: ['IN_REVIEW'],
  APPROVED: ['PUBLISHED'], PUBLISHED: ['ARCHIVED'], ARCHIVED: [],
};

export function assertContentTransition(input: {
  readonly from: ContentLifecycleState;
  readonly to: ContentLifecycleState;
  readonly authorUserId: string;
  readonly actorUserId: string;
  readonly releaseManifestId?: string;
}): void {
  if (!allowedContentTransitions[input.from].includes(input.to)) throw new Error(`invalid content transition ${input.from} -> ${input.to}`);
  if (input.to === 'APPROVED' && input.authorUserId === input.actorUserId) throw new Error('authors cannot approve their own content');
  if (input.to === 'PUBLISHED' && !input.releaseManifestId) throw new Error('publication requires a release manifest');
}

export interface PrerequisiteEdge { readonly lessonId: string; readonly prerequisiteLessonId: string }

export function assertAcyclicPrerequisites(lessonIds: readonly string[], edges: readonly PrerequisiteEdge[]): void {
  const known = new Set(lessonIds);
  const adjacency = new Map<string, string[]>(lessonIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.lessonId === edge.prerequisiteLessonId) throw new Error('lesson cannot require itself');
    if (!known.has(edge.lessonId) || !known.has(edge.prerequisiteLessonId)) throw new Error('prerequisite edge references an unknown lesson');
    adjacency.get(edge.lessonId)?.push(edge.prerequisiteLessonId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('prerequisite graph contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of adjacency.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of lessonIds) visit(id);
}

export interface ProtectedQuestionVersion {
  readonly id: string;
  readonly topicId: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly correctOptionId: string;
  readonly publishedRevision: number;
}

export type LearnerQuestionDto = Omit<ProtectedQuestionVersion, 'correctOptionId'>;

export function toLearnerQuestionDto(question: ProtectedQuestionVersion): LearnerQuestionDto {
  const { correctOptionId: _protectedAnswer, ...learnerQuestion } = question;
  return learnerQuestion;
}

export function selectQuestionsDeterministically(questions: readonly ProtectedQuestionVersion[], count: number, seed: string): readonly ProtectedQuestionVersion[] {
  if (!seed || seed.length > 256) throw new Error('assessment seed must be non-empty and bounded');
  if (!Number.isInteger(count) || count < 1 || count > questions.length) throw new Error('assessment question count is invalid');
  if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error('question IDs must be unique');
  return [...questions]
    .map((question) => ({ question, key: sha256Hex(`${seed}:${question.id}`) }))
    .sort((left, right) => left.key.localeCompare(right.key) || left.question.id.localeCompare(right.question.id))
    .slice(0, count).map(({ question }) => question);
}

export interface AttemptSubmission {
  readonly attemptId: string;
  readonly status: 'IN_PROGRESS' | 'SUBMITTED';
  readonly idempotencyKey?: string;
  readonly selectedOptions?: Readonly<Record<string, string>>;
  readonly submittedAt?: string;
}

export interface ScoredAttempt extends AttemptSubmission {
  readonly status: 'SUBMITTED';
  readonly idempotencyKey: string;
  readonly selectedOptions: Readonly<Record<string, string>>;
  readonly submittedAt: string;
  readonly correctCount: number;
  readonly itemCount: number;
}

export function submitAttemptOnce(input: {
  readonly attempt: AttemptSubmission;
  readonly questions: readonly ProtectedQuestionVersion[];
  readonly selectedOptions: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly submittedAt: string;
}): ScoredAttempt {
  if (input.attempt.status === 'SUBMITTED') {
    if (input.attempt.idempotencyKey === input.idempotencyKey) return input.attempt as ScoredAttempt;
    throw new Error('assessment attempt was already submitted');
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new Error('invalid submission idempotency key');
  if (!Number.isFinite(new Date(input.submittedAt).getTime())) throw new Error('submittedAt must be a valid server timestamp');
  const questionIds = new Set(input.questions.map((question) => question.id));
  if (Object.keys(input.selectedOptions).some((questionId) => !questionIds.has(questionId))) throw new Error('response references an unknown question');
  let correctCount = 0;
  for (const question of input.questions) {
    const selected = input.selectedOptions[question.id];
    if (selected && !question.options.some((option) => option.id === selected)) throw new Error('response references an unknown option');
    if (selected === question.correctOptionId) correctCount += 1;
  }
  return { attemptId: input.attempt.attemptId, status: 'SUBMITTED', idempotencyKey: input.idempotencyKey,
    selectedOptions: { ...input.selectedOptions }, submittedAt: input.submittedAt, correctCount, itemCount: input.questions.length };
}

export interface EvidenceInput {
  readonly id: string;
  readonly subjectUserId: string;
  readonly evidenceType: 'LESSON_COMPLETION' | 'ASSESSMENT_OUTCOME' | 'TOPIC_DEMONSTRATION';
  readonly topicId: string;
  readonly demonstrated: number;
  readonly possible: number;
  readonly sourceAggregateType: string;
  readonly sourceAggregateId: string;
  readonly contentVersion: string;
  readonly occurredAt: string;
  readonly supersedesEvidenceId?: string;
}

export interface MasteryProjection {
  readonly topicId: string;
  readonly evidenceIds: readonly string[];
  readonly algorithmVersion: 'career-readiness-mastery-v1';
  readonly band: 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'DEMONSTRATED';
  /**
   * Demonstrated over possible across active evidence. The band remains the thing
   * shown to people; the ratio exists so a career requirement expressed as a depth
   * can be compared against it.
   */
  readonly ratio: number;
}

export function projectTopicMastery(evidence: readonly EvidenceInput[]): readonly MasteryProjection[] {
  const active = evidence.filter((candidate) => !evidence.some((other) => other.supersedesEvidenceId === candidate.id));
  const byTopic = new Map<string, EvidenceInput[]>();
  for (const item of active) {
    if (item.possible <= 0 || item.demonstrated < 0 || item.demonstrated > item.possible) throw new Error('evidence values are invalid');
    byTopic.set(item.topicId, [...(byTopic.get(item.topicId) ?? []), item]);
  }
  return [...byTopic.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([topicId, items]) => {
    const demonstrated = items.reduce((sum, item) => sum + item.demonstrated, 0);
    const possible = items.reduce((sum, item) => sum + item.possible, 0);
    const ratio = demonstrated / possible;
    const band = items.length < 2 ? 'NOT_ENOUGH_EVIDENCE' : ratio >= 0.8 ? 'DEMONSTRATED' : ratio >= 0.6 ? 'PROGRESSING' : 'DEVELOPING';
    return { topicId, evidenceIds: items.map((item) => item.id).sort(), algorithmVersion: 'career-readiness-mastery-v1', band, ratio };
  });
}

/**
 * The readiness model this code implements, as the database names it (readiness_model_versions).
 *
 * Version 2 (migration 0030) is active: it admits institution exam evidence and still runs
 * career-readiness-mastery-v1. The literal here said v1 until ENG-04 reconciled it (ADR-034 §2);
 * snapshots were always stamped with the database's active version, so no stored row was wrong.
 * A database test asserts the active row matches this, so the two cannot drift silently.
 */
export const CAREER_READINESS_MODEL = {
  stableKey: 'career-readiness-fundamentals',
  version: 2,
  masteryAlgorithm: 'career-readiness-mastery-v1',
} as const;

export type ReadinessBand = 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'READY_FOR_NEXT_STEP';
export interface ReadinessResult {
  readonly modelVersion: 'career-readiness-fundamentals-v2';
  readonly band: ReadinessBand;
  readonly evidenceIds: readonly string[];
  readonly factors: readonly { readonly topicId: string; readonly masteryBand: MasteryProjection['band']; readonly explanation: string }[];
  readonly advisory: true;
  readonly employerVisible: false;
}

export function calculateAdvisoryReadiness(projections: readonly MasteryProjection[]): ReadinessResult {
  const evidenceIds = [...new Set(projections.flatMap((projection) => projection.evidenceIds))].sort();
  const demonstrated = projections.filter((projection) => projection.band === 'DEMONSTRATED').length;
  const progressing = projections.filter((projection) => projection.band === 'PROGRESSING').length;
  const insufficient = projections.filter((projection) => projection.band === 'NOT_ENOUGH_EVIDENCE').length;
  const band: ReadinessBand = evidenceIds.length < 4 || projections.length < 2 || insufficient > 0 ? 'NOT_ENOUGH_EVIDENCE'
    : demonstrated === projections.length ? 'READY_FOR_NEXT_STEP'
      : demonstrated + progressing === projections.length ? 'PROGRESSING' : 'DEVELOPING';
  return { modelVersion: 'career-readiness-fundamentals-v2', band, evidenceIds,
    factors: projections.map((projection) => ({ topicId: projection.topicId, masteryBand: projection.band,
      explanation: `${projection.evidenceIds.length} active evidence record(s) evaluated by ${projection.algorithmVersion}` })),
    advisory: true, employerVisible: false };
}

export interface RoadmapRecommendation {
  readonly topicId: string;
  readonly actionCode: 'COMPLETE_LESSON' | 'RETRY_PRACTICE' | 'REVIEW_EVIDENCE';
  readonly reasonCode: string;
  readonly evidenceIds: readonly string[];
  readonly policyVersion: 'career-readiness-roadmap-v1';
}

export function recommendRoadmapActions(projections: readonly MasteryProjection[]): readonly RoadmapRecommendation[] {
  return projections.filter((projection) => projection.band !== 'DEMONSTRATED').map((projection) => ({ topicId: projection.topicId,
    actionCode: projection.band === 'NOT_ENOUGH_EVIDENCE' ? 'COMPLETE_LESSON' : projection.band === 'DEVELOPING' ? 'RETRY_PRACTICE' : 'REVIEW_EVIDENCE',
    reasonCode: `MASTERY_${projection.band}`, evidenceIds: projection.evidenceIds, policyVersion: 'career-readiness-roadmap-v1' }));
}

export interface NotificationPreference {
  readonly emailEnabled: boolean;
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
  readonly dailyCap: number;
}

export function mayCreateNotificationCommand(input: {
  readonly preference: NotificationPreference;
  readonly localMinuteOfDay: number;
  readonly sentToday: number;
  readonly legalPurpose: string;
}): { readonly allowed: boolean; readonly reason: 'ALLOWED' | 'CHANNEL_DISABLED' | 'QUIET_HOURS' | 'FREQUENCY_CAP' | 'MISSING_PURPOSE' } {
  if (!input.legalPurpose.trim()) return { allowed: false, reason: 'MISSING_PURPOSE' };
  if (!input.preference.emailEnabled) return { allowed: false, reason: 'CHANNEL_DISABLED' };
  if (input.sentToday >= input.preference.dailyCap) return { allowed: false, reason: 'FREQUENCY_CAP' };
  const { quietHoursStartMinute: start, quietHoursEndMinute: end } = input.preference;
  const inQuietHours = start === end ? false : start < end
    ? input.localMinuteOfDay >= start && input.localMinuteOfDay < end
    : input.localMinuteOfDay >= start || input.localMinuteOfDay < end;
  if (inQuietHours) return { allowed: false, reason: 'QUIET_HOURS' };
  return { allowed: true, reason: 'ALLOWED' };
}

// ---------------------------------------------------------------------------
// Career targets and gaps
// ---------------------------------------------------------------------------

/**
 * The gap between what a career asks for and what a student has demonstrated.
 *
 * This is the computation behind "what should I do next?". It deliberately reports
 * three different kinds of shortfall rather than one, because "you have not shown
 * this yet" and "you tried this and fell short" call for different next steps, and
 * neither is the same as "we have nothing to go on".
 */

export type CareerRequirementLevel = 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';

/** MISSING and UNKNOWN are separate on purpose: absence of evidence is not evidence of absence. */
export type CareerGapStatus = 'MET' | 'PARTIAL' | 'MISSING' | 'UNKNOWN';

export interface CareerRequirement {
  readonly topicId: string;
  readonly requirementLevel: CareerRequirementLevel;
  /** Depth expected, as a proportion of what can be demonstrated for the topic. */
  readonly targetMastery: number;
}

export interface CareerGapItem {
  readonly topicId: string;
  readonly requirementLevel: CareerRequirementLevel;
  readonly targetMastery: number;
  readonly observedMastery: number | null;
  readonly status: CareerGapStatus;
  readonly priorityRank: number;
}

export interface CareerGap {
  readonly modelVersion: 'career-gap-v1';
  readonly items: readonly CareerGapItem[];
  readonly requirementsTotal: number;
  readonly requirementsMet: number;
  readonly requirementsUnknown: number;
}

const LEVEL_ORDER: Readonly<Record<CareerRequirementLevel, number>> = { ESSENTIAL: 0, IMPORTANT: 1, HELPFUL: 2 };
/** MET sorts last: a satisfied requirement is never the next thing to do. */
const STATUS_ORDER: Readonly<Record<CareerGapStatus, number>> = { MISSING: 0, UNKNOWN: 1, PARTIAL: 2, MET: 3 };

/** Below half the target counts as not yet started rather than partially there. */
const PARTIAL_THRESHOLD = 0.5;

export function computeCareerGap(
  requirements: readonly CareerRequirement[],
  projections: readonly MasteryProjection[],
): CareerGap {
  const byTopic = new Map(projections.map((projection) => [projection.topicId, projection]));

  const scored = requirements.map((requirement) => {
    const projection = byTopic.get(requirement.topicId);
    // No evidence, or too little to draw a conclusion from, is unknown rather than a
    // shortfall. Telling a student they lack a skill nobody has measured is wrong.
    const measurable = projection && projection.band !== 'NOT_ENOUGH_EVIDENCE';
    const observedMastery = measurable ? projection.ratio : null;
    const status: CareerGapStatus = observedMastery === null
      ? 'UNKNOWN'
      : observedMastery >= requirement.targetMastery
        ? 'MET'
        : observedMastery >= requirement.targetMastery * PARTIAL_THRESHOLD
          ? 'PARTIAL'
          : 'MISSING';
    // An unknown requirement is ranked by its full target, since the whole of it is
    // still to be shown.
    const shortfall = observedMastery === null ? requirement.targetMastery : Math.max(0, requirement.targetMastery - observedMastery);
    return { requirement, observedMastery, status, shortfall };
  });

  // Satisfied requirements sort to the end regardless of level: this is a ranking of
  // what to do next, and a met essential is not a thing to do. Among the rest, level
  // decides, so an unknown essential still outranks a missing optional.
  const satisfied = (status: CareerGapStatus): number => (status === 'MET' ? 1 : 0);
  scored.sort((left, right) => (
    satisfied(left.status) - satisfied(right.status)
    || LEVEL_ORDER[left.requirement.requirementLevel] - LEVEL_ORDER[right.requirement.requirementLevel]
    || STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || right.shortfall - left.shortfall
    // Deterministic ordering so the same inputs always produce the same advice.
    || left.requirement.topicId.localeCompare(right.requirement.topicId)
  ));

  const items = scored.map((entry, index) => ({
    topicId: entry.requirement.topicId,
    requirementLevel: entry.requirement.requirementLevel,
    targetMastery: entry.requirement.targetMastery,
    observedMastery: entry.observedMastery,
    status: entry.status,
    priorityRank: index + 1,
  }));

  return {
    modelVersion: 'career-gap-v1',
    items,
    requirementsTotal: items.length,
    requirementsMet: items.filter((item) => item.status === 'MET').length,
    requirementsUnknown: items.filter((item) => item.status === 'UNKNOWN').length,
  };
}

export type CareerNextActionCode = 'DEMONSTRATE_TOPIC' | 'CLOSE_GAP' | 'DEEPEN_TOPIC';

export interface CareerNextAction {
  readonly topicId: string;
  readonly actionCode: CareerNextActionCode;
  readonly requirementLevel: CareerRequirementLevel;
  readonly reason: CareerGapStatus;
  readonly priorityRank: number;
}

/**
 * The top few things worth doing next. Satisfied requirements are excluded, so the
 * list is always actionable rather than a progress report with actions buried in it.
 */
export function careerNextActions(gap: CareerGap, limit = 3): readonly CareerNextAction[] {
  return gap.items
    .filter((item) => item.status !== 'MET')
    .slice(0, Math.max(0, limit))
    .map((item) => ({
      topicId: item.topicId,
      actionCode: item.status === 'UNKNOWN' ? 'DEMONSTRATE_TOPIC' : item.status === 'MISSING' ? 'CLOSE_GAP' : 'DEEPEN_TOPIC',
      requirementLevel: item.requirementLevel,
      reason: item.status,
      priorityRank: item.priorityRank,
    }));
}

/**
 * Progress toward a target, counted only over requirements that could be evaluated.
 * Unknowns are reported separately rather than folded in, so the figure never implies
 * more confidence than the evidence supports.
 */
export function careerTargetProgress(gap: CareerGap): {
  readonly evaluated: number;
  readonly met: number;
  readonly unknown: number;
  readonly percentOfEvaluated: number | null;
} {
  const evaluated = gap.requirementsTotal - gap.requirementsUnknown;
  return {
    evaluated,
    met: gap.requirementsMet,
    unknown: gap.requirementsUnknown,
    percentOfEvaluated: evaluated === 0 ? null : Math.round((gap.requirementsMet / evaluated) * 100),
  };
}

// ENG-07: misconception codes, option tags and teaching strategies (pure rules).
export * from './misconceptions.js';
export * from './skill-map.js';
export * from './question-bank.js';
export * from './lesson-editor.js';
export * from './content-import.js';
