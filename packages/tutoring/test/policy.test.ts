/**
 * The tutor hint policy (ENG-22): where the tutor exists, who may use it, the four-step ladder and
 * the daily cap — every refusal reason, in the order a student is told why.
 */
import { describe, expect, it } from 'vitest';
import {
  TUTOR_HINTS_PER_STUDENT_PER_DAY,
  decideTutorHintRequest,
  tutorAudienceFromEnvironment,
  tutorHintMakesAssisted,
  type TutorHintPolicyInput,
} from '../src/index.js';

const open: TutorHintPolicyInput = {
  sessionMode: 'PRACTICE', audience: 'SANDBOX', featureEnabled: true, killSwitchEngaged: false, consented: true,
  language: 'en', ladderPublished: true, currentLevel: 0, pending: false, requestedToday: 0,
};
const reason = (change: Partial<TutorHintPolicyInput>) => {
  const decision = decideTutorHintRequest({ ...open, ...change });
  return decision.allowed ? 'ALLOWED' : decision.reason;
};

describe('tutor-hint-policy-v2', () => {
  it('allows the next ladder level, one at a time, in the student\'s language', () => {
    expect(decideTutorHintRequest(open)).toEqual({ allowed: true, level: 1, language: 'en', policyVersion: 'tutor-hint-policy-v2' });
    expect(decideTutorHintRequest({ ...open, currentLevel: 3, language: 'te' })).toMatchObject({ allowed: true, level: 4, language: 'te' });
  });

  it('is off in assessment mode: placement, readiness check and exam', () => {
    for (const mode of ['DIAGNOSTIC', 'ASSESSMENT', 'EXAM', '']) expect(reason({ sessionMode: mode })).toBe('ASSESSMENT_MODE');
    for (const mode of ['LEARN', 'PRACTICE', 'REVIEW']) expect(reason({ sessionMode: mode })).toBe('ALLOWED');
  });

  it('is off unless the deployment is the sandbox, the feature is on and the kill switch is released', () => {
    expect(reason({ audience: 'NONE' })).toBe('OFF');
    expect(reason({ featureEnabled: false })).toBe('OFF');
    expect(reason({ killSwitchEngaged: true })).toBe('OFF');
  });

  it('needs the ai-tutoring consent', () => {
    expect(reason({ consented: false })).toBe('NO_CONSENT');
  });

  it('writes only in the languages the evaluation covered', () => {
    for (const language of ['ta', 'kn', 'fr', '']) expect(reason({ language })).toBe('LANGUAGE_NOT_SUPPORTED');
    for (const language of ['en', 'te', 'hi']) expect(reason({ language })).toBe('ALLOWED');
  });

  it('needs a published ladder to ground on and to fall back to', () => {
    expect(reason({ ladderPublished: false })).toBe('NO_LADDER');
  });

  it('stops after level 4 and while a hint is still being written', () => {
    expect(reason({ currentLevel: 4 })).toBe('HINTS_USED');
    expect(reason({ currentLevel: -1 })).toBe('HINTS_USED');
    expect(reason({ pending: true })).toBe('PENDING');
  });

  it('caps each student per day', () => {
    expect(TUTOR_HINTS_PER_STUDENT_PER_DAY).toBe(20);
    expect(reason({ requestedToday: 19 })).toBe('ALLOWED');
    expect(reason({ requestedToday: 20 })).toBe('DAILY_LIMIT');
  });

  it('gives the reason a student is told first: where they are, then whether AI is on for them at all', () => {
    expect(reason({ sessionMode: 'ASSESSMENT', audience: 'NONE', consented: false })).toBe('ASSESSMENT_MODE');
    expect(reason({ audience: 'NONE', consented: false, requestedToday: 99 })).toBe('OFF');
    expect(reason({ consented: false, language: 'ta' })).toBe('NO_CONSENT');
  });

  it('counts an AI hint as assisted exactly like the human ladder: from level 3', () => {
    expect([1, 2, 3, 4].map(tutorHintMakesAssisted)).toEqual([false, false, true, true]);
  });
});

describe('the tutor audience', () => {
  it('is the sandbox only when the deployment says so twice and is not production', () => {
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'sandbox', ONE_SANDBOX: 'true', NODE_ENV: 'development' })).toBe('SANDBOX');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'sandbox', ONE_SANDBOX: 'true' })).toBe('SANDBOX');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'sandbox', ONE_SANDBOX: 'true', NODE_ENV: 'production' })).toBe('NONE');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'sandbox' })).toBe('NONE');
    expect(tutorAudienceFromEnvironment({ ONE_SANDBOX: 'true' })).toBe('NONE');
    expect(tutorAudienceFromEnvironment({ ONE_AI_TUTOR_AUDIENCE: 'students', ONE_SANDBOX: 'true' })).toBe('NONE');
    expect(tutorAudienceFromEnvironment({})).toBe('NONE');
  });
});
