/**
 * EMP-05: the opportunity lifecycle table, the editable states, the reason-code lists and the
 * term-change classification, tested without a database.
 */
import { describe, expect, it } from 'vitest';
import { HiringRuleError } from '../src/index.js';
import {
  availableLifecycleActions,
  canEditOpportunity,
  classifyTermChange,
  isLiveOpportunityState,
  lifecycleReasonRequired,
  opportunityLifecycleReasonCodes,
  opportunityLifecycleTarget,
} from '../src/opportunity-lifecycle.js';

const states = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'PAUSED', 'CLOSED', 'WITHDRAWN', 'ARCHIVED'] as const;

describe('opportunity lifecycle', () => {
  it.each([
    ['PUBLISHED', 'PAUSE', 'PAUSED'],
    ['PUBLISHED', 'CLOSE', 'CLOSED'],
    ['PAUSED', 'CLOSE', 'CLOSED'],
    ['PAUSED', 'REOPEN', 'PUBLISHED'],
    ['CLOSED', 'REOPEN', 'PUBLISHED'],
    ['DRAFT', 'WITHDRAW', 'WITHDRAWN'],
    ['PUBLISHED', 'WITHDRAW', 'WITHDRAWN'],
    ['PAUSED', 'WITHDRAW', 'WITHDRAWN'],
    ['CLOSED', 'WITHDRAW', 'WITHDRAWN'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(opportunityLifecycleTarget(from, action)).toBe(to);
  });

  it('refuses every other combination with a stable code', () => {
    const allowed = new Set(['PUBLISHED:PAUSE', 'PUBLISHED:CLOSE', 'PAUSED:CLOSE', 'PAUSED:REOPEN', 'CLOSED:REOPEN',
      'DRAFT:WITHDRAW', 'PUBLISHED:WITHDRAW', 'PAUSED:WITHDRAW', 'CLOSED:WITHDRAW']);
    for (const from of states) {
      for (const action of ['PAUSE', 'CLOSE', 'REOPEN', 'WITHDRAW'] as const) {
        if (allowed.has(`${from}:${action}`)) continue;
        expect(() => opportunityLifecycleTarget(from, action)).toThrow(HiringRuleError);
        try { opportunityLifecycleTarget(from, action); } catch (error) {
          expect((error as HiringRuleError).code).toBe('OPPORTUNITY_TRANSITION_NOT_ALLOWED');
        }
      }
    }
  });

  it('treats WITHDRAWN as terminal and never reopens a draft', () => {
    expect(availableLifecycleActions('WITHDRAWN')).toEqual([]);
    expect(availableLifecycleActions('DRAFT')).toEqual(['WITHDRAW']);
    expect(availableLifecycleActions('PUBLISHED')).toEqual(['PAUSE', 'CLOSE', 'WITHDRAW']);
    expect(availableLifecycleActions('PAUSED')).toEqual(['CLOSE', 'REOPEN', 'WITHDRAW']);
    expect(availableLifecycleActions('CLOSED')).toEqual(['REOPEN', 'WITHDRAW']);
  });

  it('accepts a new version in every state but withdrawn, archived and pending review', () => {
    expect(states.filter(canEditOpportunity)).toEqual(['DRAFT', 'PUBLISHED', 'PAUSED', 'CLOSED']);
    expect(states.filter(isLiveOpportunityState)).toEqual(['PUBLISHED', 'PAUSED', 'CLOSED']);
  });

  it('requires a reason code for close and withdraw only, from fixed lists', () => {
    expect(lifecycleReasonRequired('CLOSE')).toBe(true);
    expect(lifecycleReasonRequired('WITHDRAW')).toBe(true);
    expect(lifecycleReasonRequired('PAUSE')).toBe(false);
    expect(lifecycleReasonRequired('REOPEN')).toBe(false);
    for (const codes of Object.values(opportunityLifecycleReasonCodes)) {
      for (const code of codes) expect(code).toMatch(/^[A-Z0-9_:-]{3,64}$/);
    }
    // The deadline job's code is not offered to people.
    expect(Object.values(opportunityLifecycleReasonCodes).flat()).not.toContain('DEADLINE_PASSED');
  });
});

describe('term-change classification', () => {
  it('treats an editorial-only edit as no change to applicants', () => {
    expect(classifyTermChange([])).toEqual({ material: false, acknowledgementRequired: false });
  });

  it.each(['compensationMin', 'locationCity', 'workMode', 'employmentType', 'eligibility', 'durationMonths', 'joiningConditions'])(
    'requires acknowledgement when %s changes', (field) => {
      expect(classifyTermChange([field])).toEqual({ material: true, acknowledgementRequired: true });
    });

  it('records a deadline-only change without blocking applicants', () => {
    expect(classifyTermChange(['applicationDeadline'])).toEqual({ material: true, acknowledgementRequired: false });
    expect(classifyTermChange(['applicationDeadline', 'compensationMin'])).toEqual({ material: true, acknowledgementRequired: true });
  });
});
