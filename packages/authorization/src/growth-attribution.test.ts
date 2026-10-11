/**
 * GROWTH-07 attribution rules: the vocabulary pinned to 0110, credit from the onboarding candidate,
 * the dispute window, decisions and who may make them, reassignment refusals and the self-dealing guard.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_DISPUTE_STATEMENT_MAX,
  growthAttributionAdminEndReasons,
  growthAttributionBases,
  growthAttributionEndReasons,
  growthAttributionFromCandidate,
  growthAttributionReassignReasons,
  growthDisputeDecisionEffect,
  growthDisputeDecisionReasons,
  growthDisputeRoleFor,
  growthDisputeWindowEnds,
  growthDisputeWindowOpen,
  growthLeaverSettlementEnds,
  growthSelfDealing,
  growthTeamForOrganizationKind,
  readGrowthDisputeNote,
  readGrowthDisputeStatement,
  refuseGrowthAttributionChange,
  refuseGrowthDisputeDecision,
} from './index.js';

const migration = readFileSync(new URL('../../persistence/drizzle/0110_growth_attribution.sql', import.meta.url), 'utf8');
const day = 24 * 60 * 60 * 1000;

describe('growth attribution vocabulary', () => {
  it('matches the migration word for word', () => {
    for (const basis of growthAttributionBases) expect(migration).toContain(`'${basis}'`);
    expect(migration).toContain(`reason_code IN (${growthAttributionReassignReasons.map((r) => `'${r}'`).join(', ')})`);
    expect(migration).toContain(`ended_reason_code IN (${growthAttributionEndReasons.map((r) => `'${r}'`).join(', ')})`);
    expect(migration).toContain(`decision_reason_code IN (${growthDisputeDecisionReasons.map((r) => `'${r}'`).join(', ')})`);
    expect(migration).toContain("interval '90 days'");
    expect(migration).toContain('BETWEEN 1 AND 2000');
    for (const reason of growthAttributionAdminEndReasons) expect(growthAttributionEndReasons).toContain(reason);
  });

  it('maps an organisation kind to the team that may be credited for it', () => {
    expect(growthTeamForOrganizationKind('INSTITUTION')).toBe('COLLEGE_PARTNERSHIPS');
    expect(growthTeamForOrganizationKind('EMPLOYER')).toBe('EMPLOYER_PARTNERSHIPS');
  });
});

describe('credit from the onboarding candidate (design §8.3)', () => {
  it('credits the referrer, else the lead owner, opens a dispute on a conflict and writes nothing for house', () => {
    expect(growthAttributionFromCandidate('REFERRAL_LINK', { referrerUserId: 'r', leadOwnerUserId: 'r' })).toEqual({ kind: 'ATTRIBUTE', basis: 'REFERRAL_LINK', beneficiaryUserId: 'r' });
    expect(growthAttributionFromCandidate('LEAD_OWNER_AT_HANDOFF', { referrerUserId: null, leadOwnerUserId: 'o' })).toEqual({ kind: 'ATTRIBUTE', basis: 'LEAD_OWNER_AT_HANDOFF', beneficiaryUserId: 'o' });
    expect(growthAttributionFromCandidate('CONFLICT', { referrerUserId: 'r', leadOwnerUserId: 'o' })).toEqual({ kind: 'DISPUTE', claimantUserId: 'r', respondentUserId: 'o' });
    expect(growthAttributionFromCandidate('HOUSE', { referrerUserId: null, leadOwnerUserId: null })).toEqual({ kind: 'NONE' });
  });

  it('never credits someone the candidate does not name', () => {
    expect(growthAttributionFromCandidate('REFERRAL_LINK', { referrerUserId: null, leadOwnerUserId: 'o' })).toEqual({ kind: 'NONE' });
    expect(growthAttributionFromCandidate('CONFLICT', { referrerUserId: 'r', leadOwnerUserId: 'r' })).toEqual({ kind: 'NONE' });
  });
});

describe('the dispute window and the leaver settlement', () => {
  const handoff = new Date('2026-01-01T00:00:00Z');
  it('is open for 90 days from the handoff and closed after', () => {
    expect(growthDisputeWindowEnds(handoff).toISOString()).toBe(new Date(handoff.getTime() + 90 * day).toISOString());
    expect(growthDisputeWindowOpen(handoff, new Date(handoff.getTime() + 90 * day))).toBe(true);
    expect(growthDisputeWindowOpen(handoff, new Date(handoff.getTime() + 90 * day + 1))).toBe(false);
    expect(growthDisputeWindowOpen(null, handoff)).toBe(false);
  });
  it('ends a leaver settlement 90 days after leaving', () => {
    expect(growthLeaverSettlementEnds(handoff).getTime() - handoff.getTime()).toBe(90 * day);
  });
});

describe('dispute decisions', () => {
  const claim = { origin: 'CLAIM' as const, attributionId: 'a', claimantUserId: 'c', respondentUserId: 'b' };
  it('upheld credits the claimant and ends the disputed row; rejected changes nothing', () => {
    expect(growthDisputeDecisionEffect(claim, 'UPHELD')).toEqual({ creditUserId: 'c', endsAttribution: true });
    expect(growthDisputeDecisionEffect(claim, 'REJECTED')).toEqual({ creditUserId: null, endsAttribution: false });
  });
  it('a claim on a house organisation ends nothing', () => {
    expect(growthDisputeDecisionEffect({ ...claim, attributionId: null, respondentUserId: null }, 'UPHELD')).toEqual({ creditUserId: 'c', endsAttribution: false });
  });
  it('an onboarding conflict credits the referrer when upheld and the lead owner when rejected', () => {
    const conflict = { origin: 'ONBOARDING_CONFLICT' as const, attributionId: null, claimantUserId: 'r', respondentUserId: 'o' };
    expect(growthDisputeDecisionEffect(conflict, 'UPHELD').creditUserId).toBe('r');
    expect(growthDisputeDecisionEffect(conflict, 'REJECTED').creditUserId).toBe('o');
  });
  it('a disputant (either side) can never decide; a decided dispute stays decided', () => {
    expect(refuseGrowthDisputeDecision('c', { state: 'OPEN', claimantUserId: 'c', respondentUserId: 'b' })).toBe('GROWTH_SELF_DEALING_REFUSED');
    expect(refuseGrowthDisputeDecision('b', { state: 'OPEN', claimantUserId: 'c', respondentUserId: 'b' })).toBe('GROWTH_SELF_DEALING_REFUSED');
    expect(refuseGrowthDisputeDecision('x', { state: 'UPHELD', claimantUserId: 'c', respondentUserId: 'b' })).toBe('GROWTH_DISPUTE_DECIDED');
    expect(refuseGrowthDisputeDecision('x', { state: 'OPEN', claimantUserId: 'c', respondentUserId: null })).toBeNull();
  });
  it('tells a party their side and nobody else anything', () => {
    expect(growthDisputeRoleFor('c', { claimantUserId: 'c', respondentUserId: 'b' })).toBe('CLAIMANT');
    expect(growthDisputeRoleFor('b', { claimantUserId: 'c', respondentUserId: 'b' })).toBe('RESPONDENT');
    expect(growthDisputeRoleFor('x', { claimantUserId: 'c', respondentUserId: 'b' })).toBeNull();
  });
});

describe('reassignment and the self-dealing guard (design §8.5, §8.6)', () => {
  const base = { actorUserId: 'admin', currentBeneficiaryUserId: 'b', newBeneficiaryUserId: 'n', ended: false, disputeOpen: false };
  it('allows an admin who is neither party', () => {
    expect(refuseGrowthAttributionChange(base)).toBeNull();
    expect(refuseGrowthAttributionChange({ ...base, newBeneficiaryUserId: null })).toBeNull();
  });
  it('refuses credit moved to or from the admin, an ended row, an open dispute and no change', () => {
    expect(refuseGrowthAttributionChange({ ...base, actorUserId: 'n' })).toBe('GROWTH_SELF_DEALING_REFUSED');
    expect(refuseGrowthAttributionChange({ ...base, actorUserId: 'b' })).toBe('GROWTH_SELF_DEALING_REFUSED');
    expect(refuseGrowthAttributionChange({ ...base, ended: true })).toBe('GROWTH_ATTRIBUTION_ENDED');
    expect(refuseGrowthAttributionChange({ ...base, disputeOpen: true })).toBe('GROWTH_DISPUTE_OPEN');
    expect(refuseGrowthAttributionChange({ ...base, newBeneficiaryUserId: 'b' })).toBe('GROWTH_ATTRIBUTION_UNCHANGED');
  });
  it('compares people, so any party is refused', () => {
    expect(growthSelfDealing('u', ['x', null, 'u'])).toBe(true);
    expect(growthSelfDealing('u', [null, undefined, 'x'])).toBe(false);
  });
});

describe('statements and notes', () => {
  it('trims a statement and refuses empty or over-long ones', () => {
    expect(readGrowthDisputeStatement('  I met the principal twice.  ')).toBe('I met the principal twice.');
    expect(readGrowthDisputeStatement('   ')).toBeNull();
    expect(readGrowthDisputeStatement('x'.repeat(GROWTH_DISPUTE_STATEMENT_MAX + 1))).toBeNull();
    expect(readGrowthDisputeStatement(42)).toBeNull();
  });
  it('requires a note with OTHER and caps it', () => {
    expect(readGrowthDisputeNote(undefined, 'OTHER')).toBeUndefined();
    expect(readGrowthDisputeNote(undefined, 'CLAIMANT_DID_THE_WORK')).toBeNull();
    expect(readGrowthDisputeNote(' both visited ', 'OTHER')).toBe('both visited');
    expect(readGrowthDisputeNote('x'.repeat(1001), 'OTHER')).toBeUndefined();
  });
});
