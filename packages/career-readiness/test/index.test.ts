import { describe, expect, it } from 'vitest';
import {
  assertAcyclicPrerequisites,
  assertContentTransition,
  assertReleaseManifestEligible,
  calculateAdvisoryReadiness,
  deterministicPackageIdentity,
  mayCreateNotificationCommand,
  projectTopicMastery,
  recommendRoadmapActions,
  selectQuestionsDeterministically,
  submitAttemptOnce,
  toLearnerQuestionDto,
  type ImportPackageManifest,
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
