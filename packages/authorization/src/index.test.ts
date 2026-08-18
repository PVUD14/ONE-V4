import { describe, expect, it } from 'vitest';
import {
  canEmployerReadApplicant,
  canInstitutionReadStudentActivity,
  canonicalInstitutionRelationshipPolicy,
  institutionRelationshipAuthorizesActivity,
  type TemporalInstitutionScope,
} from './index.js';

describe('temporal institution authorization', () => {
  const from = new Date('2025-06-01T00:00:00.000Z');
  const to = new Date('2026-06-01T00:00:00.000Z');
  const oneMsBeforeTo = new Date(to.getTime() - 1);

  function scope(relationshipState: TemporalInstitutionScope['relationshipState'], effectiveTo?: Date): TemporalInstitutionScope {
    return {
      institutionId: 'college-a',
      relationshipState,
      effectiveFrom: from,
      ...(effectiveTo ? { effectiveTo } : {}),
    };
  }

  it('documents the canonical exclusive effective_to boundary', () => {
    expect(canonicalInstitutionRelationshipPolicy.effectiveToBoundary).toBe('exclusive');
  });

  it.each([
    ['before effective_from', scope('ACTIVE', to), new Date('2025-05-31T23:59:59.999Z'), false],
    ['exactly effective_from', scope('ACTIVE', to), from, true],
    ['inside active window', scope('ACTIVE', to), new Date('2025-12-01T00:00:00.000Z'), true],
    ['immediately before effective_to', scope('ACTIVE', to), oneMsBeforeTo, true],
    ['exactly effective_to', scope('ACTIVE', to), to, false],
    ['after effective_to', scope('ACTIVE', to), new Date('2026-06-01T00:00:00.001Z'), false],
    ['continuing active without effective_to', scope('ACTIVE'), new Date('2026-07-01T00:00:00.000Z'), true],
    ['transferred historical access before effective_to', scope('TRANSFERRED', to), oneMsBeforeTo, true],
    ['transferred post-end denial', scope('TRANSFERRED', to), to, false],
    ['transferred missing effective_to fails closed', scope('TRANSFERRED'), new Date('2025-12-01T00:00:00.000Z'), false],
    ['graduated historical access before effective_to', scope('GRADUATED', to), oneMsBeforeTo, true],
    ['graduated post-end denial', scope('GRADUATED', to), to, false],
    ['graduated missing effective_to fails closed', scope('GRADUATED'), new Date('2025-12-01T00:00:00.000Z'), false],
    ['revoked denies inside prior window', scope('REVOKED', to), new Date('2025-12-01T00:00:00.000Z'), false],
    ['pending denies inside window', scope('PENDING', to), new Date('2025-12-01T00:00:00.000Z'), false],
    ['ended remains denied pending explicit historical policy', scope('ENDED', to), new Date('2025-12-01T00:00:00.000Z'), false],
  ])('%s', (_name, candidateScope, activityAt, expected) => {
    expect(institutionRelationshipAuthorizesActivity(candidateScope, activityAt)).toBe(expected);
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
