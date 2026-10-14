/**
 * Lead pipeline rules (GROWTH-04): the vocabulary pinned to the migrations, the stage machine
 * (forward free, backward with a reason, hold and resume, lost is terminal, the handoff only by its
 * route), who may move a stage, the handoff request's preconditions and the contact role mapping.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  growthContactRoleOnAccount,
  growthHandoffDeclineReasons,
  growthNextStages,
  growthResumeStage,
  growthStageReasons,
  growthWorkingStages,
  refuseGrowthHandoffRequest,
  refuseGrowthStageMove,
  refuseGrowthStageWriter,
  type GrowthLeadCaller,
  type GrowthLeadFacts,
  type GrowthStageMove,
} from './index.js';

const leads = readFileSync(new URL('../../persistence/drizzle/0100_growth_leads.sql', import.meta.url), 'utf8');
const pipeline = readFileSync(new URL('../../persistence/drizzle/0104_growth_college_pipeline.sql', import.meta.url), 'utf8');

const move = (overrides: Partial<GrowthStageMove>): GrowthStageMove => ({
  kind: 'COLLEGE', from: 'CONTACTED', to: 'MET', reasonCode: null, doNotContact: false, handedOff: false, ...overrides,
});

describe('the vocabulary matches the database', () => {
  it('uses only stages and lost reasons the lead CHECKs accept, and the decline reasons of the handoff CHECK', () => {
    for (const stage of [...growthWorkingStages.COLLEGE, ...growthWorkingStages.EMPLOYER]) expect(leads).toContain(`'${stage}'`);
    for (const reason of growthStageReasons.lost) expect(leads).toContain(`'${reason}'`);
    for (const reason of growthHandoffDeclineReasons) expect(pipeline).toContain(`'${reason}'`);
  });
});

describe('the stage machine', () => {
  it('moves forward freely, skipping stages', () => {
    expect(refuseGrowthStageMove(move({ from: 'IDENTIFIED', to: 'MET' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'NEGOTIATION', to: 'AGREEMENT_SIGNED_REPORTED' }))).toBeNull();
  });
  it('moves backward only with a reason', () => {
    expect(refuseGrowthStageMove(move({ from: 'MEETING_SCHEDULED', to: 'CONTACTED' }))).toBe('GROWTH_STAGE_REASON_REQUIRED');
    expect(refuseGrowthStageMove(move({ from: 'MEETING_SCHEDULED', to: 'CONTACTED', reasonCode: 'MEETING_CANCELLED' }))).toBeNull();
  });
  it('enters HANDOFF_REQUESTED only through the handoff route, and never leaves it by a stage move', () => {
    expect(refuseGrowthStageMove(move({ from: 'AGREEMENT_SIGNED_REPORTED', to: 'HANDOFF_REQUESTED' }))).toBe('GROWTH_STAGE_NEEDS_HANDOFF_ROUTE');
    expect(refuseGrowthStageMove(move({ from: 'HANDOFF_REQUESTED', to: 'NEGOTIATION', reasonCode: 'CORRECTION' }))).toBe('GROWTH_STAGE_IN_HANDOFF');
  });
  it('holds with a reason and resumes only from hold', () => {
    expect(refuseGrowthStageMove(move({ to: 'ON_HOLD' }))).toBe('GROWTH_STAGE_REASON_REQUIRED');
    expect(refuseGrowthStageMove(move({ to: 'ON_HOLD', reasonCode: 'BUDGET_CYCLE' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'ON_HOLD', to: 'RESUME' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'ON_HOLD', to: 'MET' }))).toBe('GROWTH_STAGE_INVALID');
    expect(refuseGrowthStageMove(move({ from: 'MET', to: 'RESUME' }))).toBe('GROWTH_STAGE_NOT_ON_HOLD');
    expect(growthResumeStage([{ from: null, to: 'IDENTIFIED' }, { from: 'IDENTIFIED', to: 'MET' }, { from: 'MET', to: 'ON_HOLD' }])).toBe('MET');
  });
  it('loses with a reason, and a lost or handed-off lead never moves again', () => {
    expect(refuseGrowthStageMove(move({ to: 'LOST' }))).toBe('GROWTH_STAGE_REASON_REQUIRED');
    expect(refuseGrowthStageMove(move({ to: 'LOST', reasonCode: 'NO_BUDGET' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'ON_HOLD', to: 'LOST', reasonCode: 'NO_RESPONSE' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'LOST', to: 'CONTACTED', reasonCode: 'CORRECTION' }))).toBe('GROWTH_LEAD_CLOSED');
    expect(refuseGrowthStageMove(move({ handedOff: true }))).toBe('GROWTH_LEAD_CLOSED');
  });
  it('lets a do-not-contact lead only be marked lost', () => {
    expect(refuseGrowthStageMove(move({ doNotContact: true }))).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
    expect(refuseGrowthStageMove(move({ doNotContact: true, to: 'LOST', reasonCode: 'OTHER' }))).toBeNull();
  });
  it('refuses another kind\'s stages and a move to the same stage', () => {
    expect(refuseGrowthStageMove(move({ to: 'INTERESTED' }))).toBe('GROWTH_STAGE_INVALID');
    expect(refuseGrowthStageMove(move({ kind: 'EMPLOYER', from: 'MET', to: 'INTERESTED' }))).toBeNull();
    expect(refuseGrowthStageMove(move({ from: 'MET', to: 'MET' }))).toBe('GROWTH_STAGE_UNCHANGED');
  });
  it('offers the screens only moves the machine allows', () => {
    expect(growthNextStages('COLLEGE', 'LOST')).toEqual([]);
    expect(growthNextStages('COLLEGE', 'HANDOFF_REQUESTED')).toEqual([]);
    expect(growthNextStages('COLLEGE', 'ON_HOLD')).toEqual(['RESUME', 'LOST']);
    expect(growthNextStages('COLLEGE', 'MET')).not.toContain('HANDOFF_REQUESTED');
  });
});

describe('who moves a stage and asks for the handoff', () => {
  const region = 'r1';
  const owner: GrowthLeadCaller = { scope: { kind: 'PERSON', ownerMembershipIds: ['exec'], allLeadRegionIds: [], unownedLeadRegionIds: [region], workingRegionIds: [region] }, memberships: [{ membershipId: 'exec', role: 'GROWTH_EXECUTIVE', teams: ['COLLEGE_PARTNERSHIPS'] }] };
  const manager: GrowthLeadCaller = { scope: { kind: 'PERSON', ownerMembershipIds: ['mgr', 'exec'], allLeadRegionIds: [region], unownedLeadRegionIds: [region], workingRegionIds: [region] }, memberships: [{ membershipId: 'mgr', role: 'GROWTH_MANAGER', teams: ['COLLEGE_PARTNERSHIPS'] }] };
  const colleague: GrowthLeadCaller = { scope: { kind: 'PERSON', ownerMembershipIds: ['other'], allLeadRegionIds: [], unownedLeadRegionIds: [region], workingRegionIds: [region] }, memberships: [{ membershipId: 'other', role: 'GROWTH_EXECUTIVE', teams: ['COLLEGE_PARTNERSHIPS'] }] };
  const lead: GrowthLeadFacts = { kind: 'COLLEGE', ownerMembershipId: 'exec', regionIds: [region], doNotContact: false, open: true };
  it('is the owner or their region\'s manager', () => {
    expect(refuseGrowthStageWriter(owner, lead)).toBeNull();
    expect(refuseGrowthStageWriter(manager, lead)).toBeNull();
    expect(refuseGrowthStageWriter(colleague, lead)).toBe('GROWTH_LEAD_NOT_FOUND');
    expect(refuseGrowthStageWriter(colleague, { ...lead, ownerMembershipId: null })).toBe('GROWTH_NOT_LEAD_OWNER');
  });
});

describe('the handoff request', () => {
  const ready = { kind: 'COLLEGE' as const, stage: 'AGREEMENT_SIGNED_REPORTED', doNotContact: false, handedOff: false };
  it('needs a college at AGREEMENT_SIGNED_REPORTED with a reported reference in the account\'s shape', () => {
    expect(refuseGrowthHandoffRequest(ready, 'AGR/2026-014')).toBeNull();
    expect(refuseGrowthHandoffRequest({ ...ready, kind: 'EMPLOYER' }, 'X1')).toBe('GROWTH_HANDOFF_COLLEGES_ONLY');
    expect(refuseGrowthHandoffRequest({ ...ready, stage: 'NEGOTIATION' }, 'X1')).toBe('GROWTH_HANDOFF_NEEDS_AGREEMENT');
    expect(refuseGrowthHandoffRequest({ ...ready, doNotContact: true }, 'X1')).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
    expect(refuseGrowthHandoffRequest(ready, 'Rs 5,00,000')).toBe('GROWTH_CONTRACT_REFERENCE_INVALID');
    expect(refuseGrowthHandoffRequest(ready, '')).toBe('GROWTH_CONTRACT_REFERENCE_INVALID');
  });
  it('maps lead contact roles onto the account\'s roles', () => {
    expect(growthContactRoleOnAccount('PRINCIPAL')).toBe('PRINCIPAL');
    expect(growthContactRoleOnAccount('PLACEMENT_OFFICER')).toBe('PLACEMENT_OFFICER');
    expect(growthContactRoleOnAccount('CHAIRMAN_OR_TRUSTEE')).toBe('OTHER');
  });
});
