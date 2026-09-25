import { describe, expect, it } from 'vitest';
import {
  DELETION_GRACE_PERIOD_DAYS,
  DELETION_POLICY,
  PrivacyRuleError,
  STATUTORY_RESPONSE_PERIOD_DAYS,
  anonymisedIdentity,
  assertExportDownloadable,
  assertPrivacyTransition,
  canTransitionPrivacyRequest,
  deletionPolicyFor,
  deletionScheduledFor,
  exportExpiresAt,
  isDeletionDue,
  statutoryResponseDueAt,
  type PrivacyRequestState,
} from '../src/index.js';

function expectRule(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error('expected a PrivacyRuleError but none was thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(PrivacyRuleError);
    expect((error as PrivacyRuleError).code).toBe(code);
  }
}

describe('deletion grace period', () => {
  it('schedules deletion 30 days out', () => {
    expect(DELETION_GRACE_PERIOD_DAYS).toBe(30);
    expect(deletionScheduledFor(new Date('2026-03-01T10:00:00Z')).toISOString())
      .toBe('2026-03-31T10:00:00.000Z');
  });

  it('crosses month and year boundaries correctly', () => {
    expect(deletionScheduledFor(new Date('2026-12-20T00:00:00Z')).toISOString())
      .toBe('2027-01-19T00:00:00.000Z');
  });

  it('is not due before the period elapses', () => {
    const scheduledFor = new Date('2026-03-31T10:00:00Z');
    expect(isDeletionDue({ state: 'RECEIVED', scheduledFor, now: new Date('2026-03-30T23:59:00Z') })).toBe(false);
    expect(isDeletionDue({ state: 'RECEIVED', scheduledFor, now: new Date('2026-03-31T10:00:00Z') })).toBe(true);
  });

  it('never re-runs a request that already closed', () => {
    const scheduledFor = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-06-01T00:00:00Z');
    for (const state of ['COMPLETED', 'CANCELLED', 'REJECTED', 'FAILED'] as const) {
      expect(isDeletionDue({ state, scheduledFor, now })).toBe(false);
    }
  });
});

describe('request lifecycle', () => {
  const base = { requestType: 'EXPORT' as const, actor: 'SYSTEM' as const };

  it('runs an export through to collection', () => {
    expect(canTransitionPrivacyRequest({ ...base, from: 'RECEIVED', to: 'IN_PROGRESS' })).toBe(true);
    expect(canTransitionPrivacyRequest({ ...base, from: 'IN_PROGRESS', to: 'READY' })).toBe(true);
    expect(canTransitionPrivacyRequest({ ...base, from: 'READY', to: 'COMPLETED' })).toBe(true);
  });

  it('does not let a deletion become downloadable', () => {
    expectRule(() => assertPrivacyTransition({ requestType: 'DELETION', actor: 'SYSTEM', from: 'IN_PROGRESS', to: 'READY' }), 'INVALID_TRANSITION');
  });

  it('lets only the subject cancel, and only while it is open', () => {
    expect(canTransitionPrivacyRequest({ ...base, from: 'RECEIVED', to: 'CANCELLED', actor: 'SUBJECT' })).toBe(true);
    expectRule(() => assertPrivacyTransition({ ...base, from: 'RECEIVED', to: 'CANCELLED', actor: 'OPERATIONS' }), 'ACTOR_NOT_PERMITTED');
    expectRule(() => assertPrivacyTransition({ ...base, from: 'COMPLETED', to: 'CANCELLED', actor: 'SUBJECT' }), 'REQUEST_CLOSED');
  });

  it('lets only operations reject', () => {
    expect(canTransitionPrivacyRequest({ ...base, from: 'RECEIVED', to: 'REJECTED', actor: 'OPERATIONS' })).toBe(true);
    expectRule(() => assertPrivacyTransition({ ...base, from: 'RECEIVED', to: 'REJECTED', actor: 'SUBJECT' }), 'ACTOR_NOT_PERMITTED');
  });

  it('does not let the subject drive processing', () => {
    expectRule(() => assertPrivacyTransition({ ...base, from: 'RECEIVED', to: 'IN_PROGRESS', actor: 'SUBJECT' }), 'ACTOR_NOT_PERMITTED');
    expectRule(() => assertPrivacyTransition({ ...base, from: 'IN_PROGRESS', to: 'READY', actor: 'SUBJECT' }), 'ACTOR_NOT_PERMITTED');
  });

  it('refuses to complete a deletion while a hold is active', () => {
    expectRule(
      () => assertPrivacyTransition({ requestType: 'DELETION', actor: 'SYSTEM', from: 'IN_PROGRESS', to: 'COMPLETED', retentionHoldActive: true }),
      'RETENTION_HOLD_ACTIVE',
    );
    expect(canTransitionPrivacyRequest({ requestType: 'DELETION', actor: 'SYSTEM', from: 'IN_PROGRESS', to: 'COMPLETED' })).toBe(true);
  });

  it('treats every terminal state as final', () => {
    for (const from of ['COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'] as PrivacyRequestState[]) {
      expectRule(() => assertPrivacyTransition({ ...base, from, to: 'IN_PROGRESS' }), 'REQUEST_CLOSED');
    }
  });
});

describe('export availability', () => {
  it('allows download while ready and unexpired', () => {
    expect(() => assertExportDownloadable({
      state: 'READY', expiresAt: new Date('2026-03-10T00:00:00Z'), now: new Date('2026-03-05T00:00:00Z'),
    })).not.toThrow();
  });

  it('refuses an expired bundle', () => {
    expectRule(() => assertExportDownloadable({
      state: 'READY', expiresAt: new Date('2026-03-01T00:00:00Z'), now: new Date('2026-03-05T00:00:00Z'),
    }), 'EXPORT_EXPIRED');
  });

  it('refuses one that is not ready', () => {
    expectRule(() => assertExportDownloadable({ state: 'IN_PROGRESS', expiresAt: null, now: new Date() }), 'EXPORT_NOT_READY');
  });

  it('expires seven days after it is produced', () => {
    expect(exportExpiresAt(new Date('2026-03-01T00:00:00Z')).toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });
});

describe('deletion policy', () => {
  it('states a basis for everything it keeps', () => {
    for (const entry of DELETION_POLICY) {
      if (entry.disposition === 'ERASED') continue;
      expect(entry.basis, `${entry.category} keeps data and must say why`).toBeTruthy();
    }
  });

  it('erases what is only about the person', () => {
    for (const category of ['STUDENT_PROFILE', 'DOCUMENTS', 'NOTIFICATIONS', 'LEARNING_ACTIVITY'] as const) {
      expect(deletionPolicyFor(category).disposition).toBe('ERASED');
    }
  });

  it('detaches rather than destroys another party record', () => {
    // Employers and institutions keep what they lawfully did; the person is removed.
    for (const category of ['APPLICATIONS', 'OFFERS', 'INSTITUTION_ROSTER'] as const) {
      expect(deletionPolicyFor(category).disposition).toBe('ANONYMISED');
    }
    expect(deletionPolicyFor('AUDIT').disposition).toBe('RETAINED');
    // OPS-05: support cases keep the service record and lose the person.
    expect(deletionPolicyFor('SUPPORT_CASES').disposition).toBe('ANONYMISED');
  });

  it('covers every declared category exactly once', () => {
    const categories = DELETION_POLICY.map((entry) => entry.category);
    expect(new Set(categories).size).toBe(categories.length);
    // OPS-05 added SUPPORT_CASES and ENG-03 LEARNING_ACTIVITY: both must be declared.
    expect(categories).toHaveLength(11);
    expect(categories).toEqual(expect.arrayContaining(['SUPPORT_CASES', 'LEARNING_ACTIVITY']));
  });

  it('produces a deterministic, non-routable replacement identity', () => {
    const first = anonymisedIdentity('11111111-1111-4111-8111-111111111111');
    expect(first).toEqual(anonymisedIdentity('11111111-1111-4111-8111-111111111111'));
    expect(first.email).toMatch(/@deleted\.invalid$/);
    expect(first.email).not.toEqual(anonymisedIdentity('22222222-2222-4222-8222-222222222222').email);
  });
});

// OPS-06: the operations console prints a statutory due date only when a period is defined in
// code. None is yet, so the answer is null (shown as NA), never a guessed deadline.
describe('statutory response due dates', () => {
  it('are not defined for any request type yet', () => {
    expect(STATUTORY_RESPONSE_PERIOD_DAYS).toEqual({ EXPORT: null, DELETION: null });
    expect(statutoryResponseDueAt('EXPORT', new Date('2026-03-01T10:00:00Z'))).toBeNull();
    expect(statutoryResponseDueAt('DELETION', new Date('2026-03-01T10:00:00Z'))).toBeNull();
  });

  it('count from the real request time once a period exists', () => {
    const due = statutoryResponseDueAt('EXPORT', new Date('2026-03-01T10:00:00Z'), { EXPORT: 30, DELETION: null });
    expect(due?.toISOString()).toBe('2026-03-31T10:00:00.000Z');
  });
});
