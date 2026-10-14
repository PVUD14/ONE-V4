/**
 * The planner's STUCK rule, exported for the faculty cohort view (INST-15) so both read one threshold.
 */
import { describe, expect, it } from 'vitest';
import { STUCK_MIN_ATTEMPT_DAYS, isStuckSkillState } from '../src/index.js';

describe('isStuckSkillState', () => {
  it('is stuck after attempts on two or more days with no unaided success', () => {
    expect(STUCK_MIN_ATTEMPT_DAYS).toBe(2);
    expect(isStuckSkillState({ attemptDayCount: 2, unaidedSuccessCount: 0 })).toBe(true);
    expect(isStuckSkillState({ attemptDayCount: 5, unaidedSuccessCount: 0 })).toBe(true);
  });

  it('is not stuck on a single day, or once any unaided success exists', () => {
    expect(isStuckSkillState({ attemptDayCount: 1, unaidedSuccessCount: 0 })).toBe(false);
    expect(isStuckSkillState({ attemptDayCount: 0, unaidedSuccessCount: 0 })).toBe(false);
    expect(isStuckSkillState({ attemptDayCount: 3, unaidedSuccessCount: 1 })).toBe(false);
  });
});
