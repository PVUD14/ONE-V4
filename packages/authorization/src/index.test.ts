import { describe, expect, it } from 'vitest';
import { canEmployerReadApplicant, canInstitutionReadStudentActivity } from './index.js';

describe('temporal institution authorization', () => {
  it('denies activity after the institutional relationship ended', () => {
    expect(
      canInstitutionReadStudentActivity(
        {
          institutionId: 'college-a',
          relationshipState: 'ENDED',
          effectiveFrom: new Date('2025-06-01T00:00:00Z'),
          effectiveTo: new Date('2026-06-01T00:00:00Z'),
        },
        new Date('2026-07-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('permits activity inside an active relationship window', () => {
    expect(
      canInstitutionReadStudentActivity(
        {
          institutionId: 'college-b',
          relationshipState: 'ACTIVE',
          effectiveFrom: new Date('2026-06-02T00:00:00Z'),
        },
        new Date('2026-07-01T00:00:00Z'),
      ),
    ).toBe(true);
  });
});

describe('employer applicant authorization', () => {
  it('denies access to another employer application', () => {
    expect(
      canEmployerReadApplicant({
        employerId: 'employer-a',
        owningEmployerId: 'employer-b',
        applicationStatus: 'SCREENING',
      }),
    ).toBe(false);
  });

  it('denies access after consent is revoked', () => {
    expect(
      canEmployerReadApplicant({
        employerId: 'employer-a',
        owningEmployerId: 'employer-a',
        applicationStatus: 'WITHDRAWN',
        consentRevokedAt: new Date(),
      }),
    ).toBe(false);
  });
});
