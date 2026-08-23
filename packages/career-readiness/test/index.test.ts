import { describe, expect, it } from 'vitest';
import {
  assertAcyclicPrerequisites,
  assertContentTransition,
  assertReleaseManifestEligible,
  calculateAdvisoryReadiness,
  deterministicPackageIdentity,
  mayCreateNotificationCommand,
  careerNextActions,
  careerTargetProgress,
  computeCareerGap,
  projectTopicMastery,
  recommendRoadmapActions,
  selectQuestionsDeterministically,
  submitAttemptOnce,
  toLearnerQuestionDto,
  type ImportPackageManifest,
  type MasteryProjection,
  type ProtectedQuestionVersion,
  type SourceRecordEvidence,
} from '../src/index.js';

const releasedRecord: SourceRecordEvidence = {
  sourceRepository: 'PlanThePath', sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  sourcePath: 'content/career-readiness.json', sourceRecordId: 'lesson-1', sourceHash: 'a'.repeat(64),
  transformVersion: 'v1', licenseLabel: 'PlanThePath-Owned', attributionRequired: false,
  rightsState: 'APPROVED', smeState: 'APPROVED', qualityState: 'APPROVED', mappingState: 'MAPPED',
  duplicateState: 'UNIQUE', releaseState: 'RELEASED', rejectionReasonCodes: [],
};

describe('governed import and content release', () => {
  it('creates the same package ID for semantically identical manifests', () => {
    const manifest: ImportPackageManifest = {
      sourceRepository: 'PlanThePath', sourceCommit: releasedRecord.sourceCommit, transformVersion: 'v1',
      sourcePaths: ['content/career-readiness.json'], checksums: { 'content/career-readiness.json': 'b'.repeat(64) },
      recordCounts: { lessons: 1 }, records: [releasedRecord],
    };
    expect(deterministicPackageIdentity(manifest)).toBe(deterministicPackageIdentity({ ...manifest, recordCounts: { lessons: 1 } }));
  });

  it('fails closed when any record has unclear rights', () => {
    expect(() => assertReleaseManifestEligible([{ ...releasedRecord, rightsState: 'PENDING', releaseState: 'QUARANTINED' }])).toThrow('ineligible');
  });

  it('prevents author self-approval and publication without a manifest', () => {
    expect(() => assertContentTransition({ from: 'IN_REVIEW', to: 'APPROVED', authorUserId: 'same', actorUserId: 'same' })).toThrow('cannot approve');
    expect(() => assertContentTransition({ from: 'APPROVED', to: 'PUBLISHED', authorUserId: 'author', actorUserId: 'release' })).toThrow('release manifest');
  });
});

describe('learning and assessment integrity', () => {
  const questions: readonly ProtectedQuestionVersion[] = [1, 2, 3].map((number) => ({
    id: `question-${number}`, topicId: 'communication', prompt: `Prompt ${number}`,
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'b', publishedRevision: 1,
  }));

  it('rejects self edges and cycles', () => {
    expect(() => assertAcyclicPrerequisites(['a'], [{ lessonId: 'a', prerequisiteLessonId: 'a' }])).toThrow('itself');
    expect(() => assertAcyclicPrerequisites(['a', 'b'], [
      { lessonId: 'a', prerequisiteLessonId: 'b' }, { lessonId: 'b', prerequisiteLessonId: 'a' },
    ])).toThrow('cycle');
  });

  it('selects deterministically without exposing answer keys', () => {
    expect(selectQuestionsDeterministically(questions, 2, 'attempt-seed')).toEqual(selectQuestionsDeterministically(questions, 2, 'attempt-seed'));
    expect(toLearnerQuestionDto(questions[0]!)).not.toHaveProperty('correctOptionId');
  });

  it('submits once and treats the same idempotency key as a replay', () => {
    const submitted = submitAttemptOnce({ attempt: { attemptId: 'attempt', status: 'IN_PROGRESS' }, questions,
      selectedOptions: { 'question-1': 'b' }, idempotencyKey: 'submit:key:1', submittedAt: '2026-08-18T12:00:00.000Z' });
    expect(submitted.correctCount).toBe(1);
    expect(submitAttemptOnce({ attempt: submitted, questions, selectedOptions: {}, idempotencyKey: 'submit:key:1', submittedAt: '2026-08-18T12:01:00.000Z' })).toBe(submitted);
    expect(() => submitAttemptOnce({ attempt: submitted, questions, selectedOptions: {}, idempotencyKey: 'submit:key:2', submittedAt: '2026-08-18T12:01:00.000Z' })).toThrow('already submitted');
  });
});

describe('evidence, advisory readiness, roadmap and notification policy', () => {
  it('rebuilds transparent bands and explainable actions from active evidence', () => {
    const evidence = [
      { id: 'e1', topicId: 'communication', demonstrated: 1, possible: 1 },
      { id: 'e2', topicId: 'communication', demonstrated: 1, possible: 1 },
      { id: 'e3', topicId: 'professionalism', demonstrated: 1, possible: 1 },
      { id: 'e4', topicId: 'professionalism', demonstrated: 0, possible: 1 },
    ].map((entry) => ({ ...entry, subjectUserId: 'student', evidenceType: 'TOPIC_DEMONSTRATION' as const,
      sourceAggregateType: 'attempt', sourceAggregateId: entry.id, contentVersion: 'pilot-v1', occurredAt: '2026-08-18T12:00:00.000Z' }));
    const projections = projectTopicMastery(evidence);
    const readiness = calculateAdvisoryReadiness(projections);
    expect(readiness.band).toBe('DEVELOPING');
    expect(readiness.advisory).toBe(true);
    expect(readiness.employerVisible).toBe(false);
    expect(recommendRoadmapActions(projections)).toEqual(expect.arrayContaining([
      expect.objectContaining({ topicId: 'professionalism', reasonCode: 'MASTERY_DEVELOPING' }),
    ]));
  });

  it('honors channel, purpose, quiet hours and frequency caps', () => {
    const preference = { emailEnabled: true, quietHoursStartMinute: 22 * 60, quietHoursEndMinute: 7 * 60, dailyCap: 2 };
    expect(mayCreateNotificationCommand({ preference, localMinuteOfDay: 23 * 60, sentToday: 0, legalPurpose: 'assessment reminder' }).reason).toBe('QUIET_HOURS');
    expect(mayCreateNotificationCommand({ preference, localMinuteOfDay: 12 * 60, sentToday: 2, legalPurpose: 'assessment reminder' }).reason).toBe('FREQUENCY_CAP');
    expect(mayCreateNotificationCommand({ preference, localMinuteOfDay: 12 * 60, sentToday: 0, legalPurpose: 'assessment reminder' }).allowed).toBe(true);
  });
});

describe('career gap', () => {
  const requirements = [
    { topicId: 'siem', requirementLevel: 'ESSENTIAL' as const, targetMastery: 0.8 },
    { topicId: 'networking', requirementLevel: 'ESSENTIAL' as const, targetMastery: 0.7 },
    { topicId: 'communication', requirementLevel: 'IMPORTANT' as const, targetMastery: 0.6 },
    { topicId: 'scripting', requirementLevel: 'HELPFUL' as const, targetMastery: 0.5 },
  ];

  function projection(topicId: string, ratio: number, band: MasteryProjection['band']): MasteryProjection {
    return { topicId, evidenceIds: ['e1', 'e2'], algorithmVersion: 'career-readiness-mastery-v1', band, ratio };
  }

  it('reports a requirement with no evidence as unknown, never as missing', () => {
    const gap = computeCareerGap(requirements, []);
    expect(gap.requirementsUnknown).toBe(4);
    expect(gap.items.every((item) => item.status === 'UNKNOWN')).toBe(true);
    // Nothing has been measured, so nothing can be claimed to be absent.
    expect(gap.items.some((item) => item.status === 'MISSING')).toBe(false);
    expect(gap.items.every((item) => item.observedMastery === null)).toBe(true);
  });

  it('treats insufficient evidence as unknown rather than as a low score', () => {
    const gap = computeCareerGap(requirements, [projection('siem', 0.2, 'NOT_ENOUGH_EVIDENCE')]);
    const siem = gap.items.find((item) => item.topicId === 'siem');
    expect(siem?.status).toBe('UNKNOWN');
    expect(siem?.observedMastery).toBeNull();
  });

  it('separates met, partial and missing', () => {
    const gap = computeCareerGap(requirements, [
      projection('siem', 0.85, 'DEMONSTRATED'),
      projection('networking', 0.5, 'DEVELOPING'),
      projection('communication', 0.1, 'DEVELOPING'),
    ]);
    const byTopic = Object.fromEntries(gap.items.map((item) => [item.topicId, item]));
    expect(byTopic.siem?.status).toBe('MET');
    expect(byTopic.networking?.status).toBe('PARTIAL');
    expect(byTopic.communication?.status).toBe('MISSING');
    expect(gap.requirementsMet).toBe(1);
  });

  it('ranks unmet essentials first and pushes satisfied requirements to the end', () => {
    const gap = computeCareerGap(requirements, [
      projection('siem', 0.9, 'DEMONSTRATED'),
      projection('scripting', 0.05, 'DEVELOPING'),
    ]);
    // An unmet essential leads; the satisfied essential sorts behind even an
    // unmet optional, because this ranks what to do next.
    expect(gap.items[0]?.requirementLevel).toBe('ESSENTIAL');
    expect(gap.items[0]?.status).not.toBe('MET');
    expect(gap.items[gap.items.length - 1]?.topicId).toBe('siem');
    expect(gap.items[gap.items.length - 1]?.status).toBe('MET');
  });

  it('is deterministic for the same inputs', () => {
    const first = computeCareerGap(requirements, [projection('siem', 0.4, 'DEVELOPING')]);
    const second = computeCareerGap([...requirements].reverse(), [projection('siem', 0.4, 'DEVELOPING')]);
    expect(first.items.map((item) => item.topicId)).toEqual(second.items.map((item) => item.topicId));
  });

  it('suggests demonstrating what is unknown and closing what fell short', () => {
    const gap = computeCareerGap(requirements, [
      projection('siem', 0.1, 'DEVELOPING'),
      projection('networking', 0.65, 'PROGRESSING'),
    ]);
    const actions = careerNextActions(gap, 3);
    expect(actions).toHaveLength(3);
    const bySiem = actions.find((action) => action.topicId === 'siem');
    expect(bySiem?.actionCode).toBe('CLOSE_GAP');
    expect(actions.find((action) => action.topicId === 'communication')?.actionCode).toBe('DEMONSTRATE_TOPIC');
    expect(actions.find((action) => action.topicId === 'networking')?.actionCode).toBe('DEEPEN_TOPIC');
  });

  it('never suggests something already satisfied', () => {
    const gap = computeCareerGap(
      [{ topicId: 'siem', requirementLevel: 'ESSENTIAL', targetMastery: 0.5 }],
      [projection('siem', 0.9, 'DEMONSTRATED')],
    );
    expect(careerNextActions(gap)).toEqual([]);
  });

  it('reports progress only over what could be evaluated', () => {
    const gap = computeCareerGap(requirements, [
      projection('siem', 0.9, 'DEMONSTRATED'),
      projection('networking', 0.1, 'DEVELOPING'),
    ]);
    const progress = careerTargetProgress(gap);
    expect(progress.evaluated).toBe(2);
    expect(progress.met).toBe(1);
    expect(progress.unknown).toBe(2);
    // 1 of 2 measurable, not 1 of 4; unknowns are reported, never averaged in.
    expect(progress.percentOfEvaluated).toBe(50);
  });

  it('declines to state a percentage when nothing could be evaluated', () => {
    expect(careerTargetProgress(computeCareerGap(requirements, [])).percentOfEvaluated).toBeNull();
  });
});
