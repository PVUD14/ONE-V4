import { describe, expect, it } from 'vitest';
import type { AccountState } from './domain/identity/models.js';

describe('API foundation', () => {
  it('executes tests against the typed domain foundation', () => {
    const activeState: AccountState = 'ACTIVE';

    expect(activeState).toBe('ACTIVE');
  });
});
