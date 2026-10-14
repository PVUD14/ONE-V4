/**
 * Lead register rules (GROWTH-03): the vocabulary pinned to the migration, identifier
 * normalisation for the duplicate check, the disclosure rule for duplicates, and who may claim,
 * reassign, write contacts or see them unmasked.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_CONTACT_NOTICE_TEXT,
  GROWTH_CONTACT_NOTICE_VERSION,
  growthContactBases,
  growthContactRoles,
  growthContactSourcesByBasis,
  growthDuplicateDisclosure,
  growthLeadReasons,
  growthLeadSources,
  growthLeadStages,
  growthOwningMembership,
  isGrowthContactSourceFor,
  isGrowthLeadStale,
  normaliseAisheCode,
  normaliseLeadName,
  normaliseWebsiteDomain,
  refuseGrowthContactWrite,
  refuseGrowthLeadClaim,
  refuseGrowthLeadPrivacyWrite,
  refuseGrowthLeadReassign,
  seesGrowthContactsInFull,
  type GrowthLeadCaller,
  type GrowthLeadFacts,
} from './index.js';

const migration = readFileSync(new URL('../../persistence/drizzle/0100_growth_leads.sql', import.meta.url), 'utf8');

describe('the vocabulary matches the database', () => {
  it('lists every source, role, basis and stage the CHECKs accept', () => {
    for (const value of [...growthLeadSources, ...growthContactRoles, ...growthContactBases, ...growthLeadStages.COLLEGE, ...growthLeadStages.EMPLOYER]) {
      expect(migration).toContain(`'${value}'`);
    }
    for (const sources of Object.values(growthContactSourcesByBasis)) for (const source of sources) expect(migration).toContain(`'${source}'`);
    for (const reason of [...growthLeadReasons.removeContact, ...growthLeadReasons.adminRemoveContact]) expect(migration).toContain(`'${reason}'`);
    for (const reason of growthLeadReasons.doNotContact) expect(migration).toContain(`'${reason}'`);
    expect(GROWTH_CONTACT_NOTICE_VERSION).toMatch(/^[a-z0-9.-]{3,40}$/);
    expect(GROWTH_CONTACT_NOTICE_VERSION).toContain('draft');
  });

  it('allows a source only under the basis it belongs to', () => {
    expect(isGrowthContactSourceFor('PROVIDED_BY_PERSON', 'BUSINESS_CARD')).toBe(true);
    expect(isGrowthContactSourceFor('PROVIDED_BY_PERSON', 'OFFICIAL_WEBSITE')).toBe(false);
    expect(isGrowthContactSourceFor('PUBLIC_INSTITUTIONAL_LISTING', 'OFFICIAL_WEBSITE')).toBe(true);
    expect(isGrowthContactSourceFor('INTRODUCED_BY_COLLEAGUE', 'MEETING')).toBe(false);
  });
});

describe('identifiers for the duplicate check', () => {
  it('reduces a website to its host', () => {
    expect(normaliseWebsiteDomain('https://www.Acme.co.in/careers?x=1')).toBe('acme.co.in');
    expect(normaliseWebsiteDomain('acme.com')).toBe('acme.com');
    expect(normaliseWebsiteDomain('http://jobs.acme.com:8080/')).toBe('jobs.acme.com');
    expect(normaliseWebsiteDomain('hr@acme.com')).toBe('acme.com');
    for (const bad of ['', 'acme', 'https://', '<script>.com', 'a b.com', 42, null]) expect(normaliseWebsiteDomain(bad)).toBeNull();
  });

  it('accepts only AISHE institution codes', () => {
    expect(normaliseAisheCode(' c-12345 ')).toBe('C-12345');
    expect(normaliseAisheCode('U-0123')).toBe('U-0123');
    for (const bad of ['C12345', 'X-1', 'C-', 'C-123456789', 7]) expect(normaliseAisheCode(bad)).toBeNull();
  });

  it('normalises names for the possible-duplicate flag the way the database does', () => {
    expect(normaliseLeadName('St. Joseph\'s College (Autonomous)')).toBe('stjosephscollegeautonomous');
    expect(migration).toContain("regexp_replace(lower(name), '[^a-z0-9]', '', 'g')");
  });
});

const executiveCaller: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['m-exec'], allLeadRegionIds: [], unownedLeadRegionIds: ['r-1'], workingRegionIds: ['r-1'] },
  memberships: [{ membershipId: 'm-exec', role: 'GROWTH_EXECUTIVE', teams: ['COLLEGE_PARTNERSHIPS'] }],
};
const managerCaller: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['m-mgr', 'm-report'], allLeadRegionIds: ['r-1'], unownedLeadRegionIds: ['r-1'], workingRegionIds: ['r-1'] },
  memberships: [{ membershipId: 'm-mgr', role: 'GROWTH_MANAGER', teams: ['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'] }],
};
const lead = (overrides: Partial<GrowthLeadFacts> = {}): GrowthLeadFacts => ({
  kind: 'COLLEGE', ownerMembershipId: null, regionIds: ['r-1'], doNotContact: false, open: true, ...overrides,
});

describe('claiming', () => {
  it('lets the first person on the matching team claim an unowned lead in their region', () => {
    expect(refuseGrowthLeadClaim(executiveCaller, lead())).toBeNull();
    expect(growthOwningMembership(executiveCaller, 'COLLEGE')).toBe('m-exec');
  });

  it('refuses an owned, do-not-contact, closed, out-of-region or wrong-team lead', () => {
    expect(refuseGrowthLeadClaim(executiveCaller, lead({ ownerMembershipId: 'm-exec' }))).toBe('GROWTH_LEAD_ALREADY_OWNED');
    expect(refuseGrowthLeadClaim(executiveCaller, lead({ doNotContact: true }))).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
    expect(refuseGrowthLeadClaim(executiveCaller, lead({ open: false }))).toBe('GROWTH_LEAD_CLOSED');
    expect(refuseGrowthLeadClaim(executiveCaller, lead({ regionIds: ['r-2'] }))).toBe('GROWTH_LEAD_NOT_FOUND');
    expect(refuseGrowthLeadClaim(executiveCaller, lead({ kind: 'EMPLOYER' }))).toBe('GROWTH_TEAM_MISMATCH');
    expect(growthOwningMembership(executiveCaller, 'EMPLOYER')).toBeNull();
  });
});

describe('reassigning', () => {
  it('is a manager\'s act within their regions or for their reports', () => {
    expect(refuseGrowthLeadReassign(managerCaller, lead({ ownerMembershipId: 'm-peer' }))).toBeNull();
    expect(refuseGrowthLeadReassign(managerCaller, lead({ ownerMembershipId: 'm-report', regionIds: ['r-9'] }))).toBeNull();
    expect(refuseGrowthLeadReassign(managerCaller, lead({ ownerMembershipId: 'm-peer', regionIds: ['r-9'] }))).toBe('GROWTH_LEAD_NOT_FOUND');
  });

  it('is refused to an executive, and on a do-not-contact or closed lead', () => {
    expect(refuseGrowthLeadReassign(executiveCaller, lead({ ownerMembershipId: 'm-exec' }))).toBe('GROWTH_NOT_REGION_MANAGER');
    expect(refuseGrowthLeadReassign(managerCaller, lead({ ownerMembershipId: 'm-peer', doNotContact: true }))).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
    expect(refuseGrowthLeadReassign(managerCaller, lead({ ownerMembershipId: 'm-peer', open: false }))).toBe('GROWTH_LEAD_CLOSED');
  });
});

describe('contacts', () => {
  it('are written only by the owner, on a contactable lead', () => {
    expect(refuseGrowthContactWrite(executiveCaller, lead({ ownerMembershipId: 'm-exec' }))).toBeNull();
    expect(refuseGrowthContactWrite(managerCaller, lead({ ownerMembershipId: 'm-peer' }))).toBe('GROWTH_NOT_LEAD_OWNER');
    expect(refuseGrowthContactWrite(executiveCaller, lead({ ownerMembershipId: 'm-exec', doNotContact: true }))).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
  });

  it('are seen in full by the owner only (O-9)', () => {
    expect(seesGrowthContactsInFull(executiveCaller, lead({ ownerMembershipId: 'm-exec' }))).toBe(true);
    expect(seesGrowthContactsInFull(managerCaller, lead({ ownerMembershipId: 'm-report' }))).toBe(false);
    expect(seesGrowthContactsInFull(executiveCaller, lead())).toBe(false);
  });

  it('may be removed by the owner or the region manager, never by a colleague', () => {
    expect(refuseGrowthLeadPrivacyWrite(executiveCaller, lead({ ownerMembershipId: 'm-exec' }))).toBeNull();
    expect(refuseGrowthLeadPrivacyWrite(managerCaller, lead({ ownerMembershipId: 'm-peer' }))).toBeNull();
    // A do-not-contact lead still lets its manager remove a contact (the privacy right outlives outreach).
    expect(refuseGrowthLeadPrivacyWrite(managerCaller, lead({ ownerMembershipId: 'm-peer', doNotContact: true }))).toBeNull();
    const colleague: GrowthLeadCaller = { ...executiveCaller, scope: { ...executiveCaller.scope, kind: 'PERSON', allLeadRegionIds: [] } as GrowthLeadCaller['scope'] };
    expect(refuseGrowthLeadPrivacyWrite(colleague, lead({ ownerMembershipId: 'm-peer' }))).toBe('GROWTH_LEAD_NOT_FOUND');
  });
});

describe('duplicates and staleness', () => {
  it('names the owner of a duplicate only to someone who could see it', () => {
    expect(growthDuplicateDisclosure(executiveCaller.scope, { ownerMembershipId: 'm-exec', regionIds: ['r-9'] })).toBe('NAMED');
    expect(growthDuplicateDisclosure(executiveCaller.scope, { ownerMembershipId: null, regionIds: ['r-1'] })).toBe('NAMED');
    expect(growthDuplicateDisclosure(executiveCaller.scope, { ownerMembershipId: 'm-peer', regionIds: ['r-1'] })).toBe('ANONYMOUS');
    expect(growthDuplicateDisclosure(executiveCaller.scope, { ownerMembershipId: 'm-peer', regionIds: ['r-2'] })).toBe('ANONYMOUS');
    expect(growthDuplicateDisclosure(managerCaller.scope, { ownerMembershipId: 'm-peer', regionIds: ['r-1'] })).toBe('NAMED');
  });

  it('calls a lead stale after 90 days without activity', () => {
    const now = new Date();
    expect(isGrowthLeadStale(new Date(now.getTime() - 89 * 86_400_000), now)).toBe(false);
    expect(isGrowthLeadStale(new Date(now.getTime() - 91 * 86_400_000), now)).toBe(true);
  });
});

describe('the contact notice', () => {
  it('serves exactly the words of the legal draft, which says DRAFT and names its version', () => {
    const draft = readFileSync(new URL('../../../docs/legal/growth-lead-contact-notice-DRAFT-for-legal-review.md', import.meta.url), 'utf8');
    expect(draft.startsWith('# DRAFT — FOR LEGAL REVIEW — NOT PUBLISHED')).toBe(true);
    expect(draft).toContain(GROWTH_CONTACT_NOTICE_VERSION);
    for (const line of GROWTH_CONTACT_NOTICE_TEXT) expect(draft).toContain(line);
    // The notice states the retention period the sweep enforces.
    expect(GROWTH_CONTACT_NOTICE_TEXT.join(' ')).toContain('24 months');
  });
});
