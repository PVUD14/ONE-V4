/**
 * Tutor / no-tutor group assignment for the tutor pilot (ENG-25, `sha256-bucket-v1`) — pure.
 *
 * Why this exists: the pilot compares students who had the tutor with comparable students who did not.
 * The split must be random, reproducible by anyone holding the experiment's recorded seed, and impossible
 * to re-roll. A student's group is a function of (seed, experiment id, student id) only. Migration 0116's
 * `tutor_assignment_bucket()` is the SQL twin of `tutorAssignmentBucket`; the database recomputes every
 * recorded assignment with it, and a test holds the two to the same answer.
 *
 * Nothing here reads readiness or produces a number about a student's ability: the bucket is a coin.
 *
 * Design: docs/architecture/tutor-rollout-design.md (Decision 3). Decision: ADR-051.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { TutorGroup } from './policy.js';

export const TUTOR_ASSIGNMENT_METHOD = 'sha256-bucket-v1' as const;
/** v1's split: half the consenting students of a college are in the tutor group. */
export const TUTOR_SHARE_BASIS_POINTS = 5000;
export const TUTOR_BUCKETS = 10_000;

/** A fresh experiment seed: 128 random bits as 32 lower-case hex characters. Recorded, never changed. */
export function newTutorAssignmentSeed(): string {
  return randomBytes(16).toString('hex');
}

const HEX_SEED = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The student's bucket, 0–9999: the first four bytes of sha256(seed:experiment:student), big-endian, mod 10000. */
export function tutorAssignmentBucket(input: { readonly seed: string; readonly experimentId: string; readonly subjectUserId: string }): number {
  if (!HEX_SEED.test(input.seed)) throw new Error('a tutor assignment seed is 32 lower-case hex characters');
  if (!UUID.test(input.experimentId) || !UUID.test(input.subjectUserId)) throw new Error('a tutor assignment needs an experiment id and a student id');
  const digest = createHash('sha256').update(`${input.seed}:${input.experimentId.toLowerCase()}:${input.subjectUserId.toLowerCase()}`, 'utf8').digest();
  return digest.readUInt32BE(0) % TUTOR_BUCKETS;
}

/** The group a bucket falls in, for a split in basis points. */
export function tutorGroupForBucket(bucket: number, tutorShareBasisPoints: number = TUTOR_SHARE_BASIS_POINTS): TutorGroup {
  return bucket < tutorShareBasisPoints ? 'TUTOR' : 'NO_TUTOR';
}

/** The whole assignment: the same inputs always give the same bucket and group. */
export function assignTutorGroup(input: {
  readonly seed: string; readonly experimentId: string; readonly subjectUserId: string; readonly tutorShareBasisPoints?: number;
}): { readonly method: typeof TUTOR_ASSIGNMENT_METHOD; readonly bucket: number; readonly group: TutorGroup } {
  const bucket = tutorAssignmentBucket(input);
  return { method: TUTOR_ASSIGNMENT_METHOD, bucket, group: tutorGroupForBucket(bucket, input.tutorShareBasisPoints ?? TUTOR_SHARE_BASIS_POINTS) };
}

/** The pilot counters (0116's CHECK lists the same keys). No student, question or readiness in any of them. */
export const TUTOR_PILOT_METRICS = [
  'STEPS_STARTED', 'QUESTIONS_ANSWERED', 'QUESTIONS_CORRECT', 'ANSWERS_ASSISTED', 'STEPS_COMPLETED',
  'WRITTEN_HINTS_SHOWN', 'TUTOR_HINTS_REQUESTED', 'TUTOR_HINTS_SHOWN', 'TUTOR_HINTS_FALLBACK',
] as const;
export type TutorPilotMetric = (typeof TUTOR_PILOT_METRICS)[number];
