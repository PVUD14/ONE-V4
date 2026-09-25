/**
 * The jobs console's access rule and reason codes (OPS-04): OPS_JOBS_REPLAY opens the
 * console for the three platform roles, and never for an inactive membership or an
 * institution role; replay reasons come from a fixed list.
 */
import { describe, expect, it } from 'vitest';
import { hasInternalCapability } from './internal-capabilities.js';
import { isOutboxReplayReason, outboxReplayReasons } from './jobs-console.js';

const context = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('jobs console access (OPS_JOBS_REPLAY)', () => {
  it('is granted by the baseline of each platform role', () => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) {
      expect(hasInternalCapability(context(role), 'OPS_JOBS_REPLAY'), role).toBe(true);
    }
  });

  it('is denied to an institution admin, even with a stray grant', () => {
    expect(hasInternalCapability(context('INSTITUTION_ADMIN', 'ACTIVE', ['OPS_JOBS_REPLAY']), 'OPS_JOBS_REPLAY')).toBe(false);
  });

  it('is denied to an inactive platform membership', () => {
    for (const state of ['SUSPENDED', 'ENDED', 'PENDING']) {
      expect(hasInternalCapability(context('OPERATIONS_ADMIN', state), 'OPS_JOBS_REPLAY'), state).toBe(false);
    }
  });
});

describe('replay reason codes', () => {
  it('are a fixed list of well-formed codes', () => {
    expect(outboxReplayReasons.length).toBeGreaterThan(0);
    for (const reason of outboxReplayReasons) expect(reason).toMatch(/^[A-Z0-9_:-]{3,64}$/);
  });

  it('accept only listed values', () => {
    expect(isOutboxReplayReason('TRANSIENT_FAILURE_RESOLVED')).toBe(true);
    expect(isOutboxReplayReason('OPS_TEST')).toBe(false);
    expect(isOutboxReplayReason(undefined)).toBe(false);
  });
});
