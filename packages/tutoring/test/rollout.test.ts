/**
 * The tutor pilot's group assignment and gates (ENG-25): the same inputs always give the same group, the
 * split is balanced on synthetic students, and the pilot audience needs the college switched on, the
 * consent and the tutor group — with the pilot's own reasons shown to a student as plain OFF.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TUTOR_ASSIGNMENT_METHOD,
  assignTutorGroup,
  decideTutorHintRequest,
  newTutorAssignmentSeed,
  tutorAssignmentBucket,
  tutorAudienceFromEnvironment,
  tutorGroupForBucket,
  visibleTutorReason,
  type TutorHintPolicyInput,
} from '../src/index.js';

const SEED = '0123456789abcdef0123456789abcdef';
const EXPERIMENT = '6f1c2a4e-0b7d-4c55-9a1e-3d2f8b7c6a50';
const STUDENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('sha256-bucket-v1', () => {
  it('is reproducible: the same seed, experiment and student give the same bucket and group, whatever the case or call', () => {
    const first = assignTutorGroup({ seed: SEED, experimentId: EXPERIMENT, subjectUserId: STUDENT });
    expect(first.method).toBe(TUTOR_ASSIGNMENT_METHOD);
    for (let run = 0; run < 5; run += 1) expect(assignTutorGroup({ seed: SEED, experimentId: EXPERIMENT, subjectUserId: STUDENT })).toEqual(first);
    expect(assignTutorGroup({ seed: SEED, experimentId: EXPERIMENT.toUpperCase(), subjectUserId: STUDENT.toUpperCase() })).toEqual(first);
    expect(first.bucket).toBeGreaterThanOrEqual(0);
    expect(first.bucket).toBeLessThan(10_000);
    expect(first.group).toBe(tutorGroupForBucket(first.bucket));
  });

  it('is pinned: a known input gives a known bucket, so a change to the formula is caught here', () => {
    // sha256("0123456789abcdef0123456789abcdef:6f1c2a4e-…:9a8b7c6d-…") starts e15da5c8; 0xe15da5c8 mod 10000 = 888.
    expect(tutorAssignmentBucket({ seed: SEED, experimentId: EXPERIMENT, subjectUserId: STUDENT })).toBe(888);
    expect(assignTutorGroup({ seed: SEED, experimentId: EXPERIMENT, subjectUserId: STUDENT }).group).toBe('TUTOR');
    expect(tutorGroupForBucket(0)).toBe('TUTOR');
    expect(tutorGroupForBucket(4999)).toBe('TUTOR');
    expect(tutorGroupForBucket(5000)).toBe('NO_TUTOR');
    expect(tutorGroupForBucket(9999)).toBe('NO_TUTOR');
  });

  it('depends on the seed and the experiment: experiments are independent', () => {
    const students = Array.from({ length: 400 }, () => randomUUID());
    const groupsA = students.map((id) => assignTutorGroup({ seed: SEED, experimentId: EXPERIMENT, subjectUserId: id }).group);
    const groupsB = students.map((id) => assignTutorGroup({ seed: newTutorAssignmentSeed(), experimentId: EXPERIMENT, subjectUserId: id }).group);
    const groupsC = students.map((id) => assignTutorGroup({ seed: SEED, experimentId: randomUUID(), subjectUserId: id }).group);
    const agree = (left: string[], right: string[]) => left.filter((group, index) => group === right[index]).length / left.length;
    // Independent fair coins agree about half the time; identical assignments would agree always.
    expect(agree(groupsA, groupsB)).toBeGreaterThan(0.38);
    expect(agree(groupsA, groupsB)).toBeLessThan(0.62);
    expect(agree(groupsA, groupsC)).toBeGreaterThan(0.38);
    expect(agree(groupsA, groupsC)).toBeLessThan(0.62);
  });

  it('is balanced on synthetic students: about half in each group, and buckets spread evenly', () => {
    const students = Array.from({ length: 2000 }, () => randomUUID());
    const seed = newTutorAssignmentSeed();
    const buckets = students.map((id) => tutorAssignmentBucket({ seed, experimentId: EXPERIMENT, subjectUserId: id }));
    const tutorShare = buckets.filter((bucket) => tutorGroupForBucket(bucket) === 'TUTOR').length / students.length;
    expect(tutorShare).toBeGreaterThan(0.45);
    expect(tutorShare).toBeLessThan(0.55);
    // Chi-square over ten equal bucket ranges: 9 degrees of freedom, 27.88 is the 0.001 critical value.
    const deciles = Array.from({ length: 10 }, () => 0);
    for (const bucket of buckets) deciles[Math.floor(bucket / 1000)]! += 1;
    const expected = students.length / 10;
    const chiSquare = deciles.reduce((sum, observed) => sum + ((observed - expected) ** 2) / expected, 0);
    expect(chiSquare).toBeLessThan(27.88);
  });

  it('refuses a malformed seed or id rather than guess', () => {
    expect(() => tutorAssignmentBucket({ seed: 'short', experimentId: EXPERIMENT, subjectUserId: STUDENT })).toThrow(/seed/u);
    expect(() => tutorAssignmentBucket({ seed: SEED.toUpperCase(), experimentId: EXPERIMENT, subjectUserId: STUDENT })).toThrow(/seed/u);
    expect(() => tutorAssignmentBucket({ seed: SEED, experimentId: 'nope', subjectUserId: STUDENT })).toThrow();
    expect(newTutorAssignmentSeed()).toMatch(/^[0-9a-f]{32}$/u);
    expect(newTutorAssignmentSeed()).not.toBe(newTutorAssignmentSeed());
  });
});

describe('the pilot audience in tutor-hint-policy-v2', () => {
  const open: TutorHintPolicyInput = {
    sessionMode: 'PRACTICE', audience: 'PILOT', featureEnabled: true, killSwitchEngaged: false, consented: true,
    collegeEnabled: true, group: 'TUTOR', language: 'en', ladderPublished: true, currentLevel: 0, pending: false, requestedToday: 0,
  };
  const reason = (change: Partial<TutorHintPolicyInput>) => {
    const decision = decideTutorHintRequest({ ...open, ...change });
    return decision.allowed ? 'ALLOWED' : decision.reason;
  };

  it('is declared by the deployment, in any environment, separately from the sandbox', () => {
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'pilot', NODE_ENV: 'production' })).toBe('PILOT');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'Pilot' })).toBe('NONE');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'sandbox', ONE_SANDBOX: 'true' })).toBe('SANDBOX');
  });

  it('serves a consenting student of a switched-on college in the tutor group, with the feature on and the kill switch released', () => {
    expect(decideTutorHintRequest(open)).toMatchObject({ allowed: true, level: 1, policyVersion: 'tutor-hint-policy-v2' });
  });

  it('college gate: refused when the college is not switched on, or the student has no college', () => {
    expect(reason({ collegeEnabled: false })).toBe('COLLEGE_OFF');
    const { collegeEnabled: _college, ...noCollege } = open;
    expect(decideTutorHintRequest(noCollege)).toMatchObject({ allowed: false, reason: 'COLLEGE_OFF' });
  });

  it('consent gate: refused without ai-tutoring, before any group is consulted', () => {
    expect(reason({ consented: false })).toBe('NO_CONSENT');
    expect(reason({ consented: false, group: null })).toBe('NO_CONSENT');
  });

  it('group gate: the no-tutor group, or no recorded group, is refused', () => {
    expect(reason({ group: 'NO_TUTOR' })).toBe('NO_TUTOR_GROUP');
    expect(reason({ group: null })).toBe('NO_TUTOR_GROUP');
    const { group: _group, ...noGroup } = open;
    expect(decideTutorHintRequest(noGroup)).toMatchObject({ allowed: false, reason: 'NO_TUTOR_GROUP' });
  });

  it('kill switch and feature switch still stop everything, whatever the college and group', () => {
    expect(reason({ killSwitchEngaged: true })).toBe('OFF');
    expect(reason({ featureEnabled: false })).toBe('OFF');
    expect(reason({ audience: 'NONE' })).toBe('OFF');
  });

  it('the sandbox keeps ENG-22\'s rules: no college or group needed there', () => {
    expect(reason({ audience: 'SANDBOX', collegeEnabled: false, group: null })).toBe('ALLOWED');
  });

  it('shows a student the pilot\'s reasons as OFF, so the no-tutor group looks exactly like AI off', () => {
    expect(visibleTutorReason('COLLEGE_OFF')).toBe('OFF');
    expect(visibleTutorReason('NO_TUTOR_GROUP')).toBe('OFF');
    for (const kept of ['OFF', 'NO_CONSENT', 'DAILY_LIMIT', 'PENDING'] as const) expect(visibleTutorReason(kept)).toBe(kept);
  });
});
