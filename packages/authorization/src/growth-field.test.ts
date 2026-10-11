/**
 * Field work rules (GROWTH-06): the vocabulary pinned to migration 0103, the report-time rule
 * (older than 7 days or in the future is refused), location rounding to 3 decimal places, the
 * follow-up due-date window, who may log work, and who may see a visit's location.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_LOCATION_NOTICE_TEXT,
  GROWTH_LOCATION_NOTICE_VERSION,
  growthActivityAllowsLocation,
  growthActivityKinds,
  growthActivityNeedsOutcome,
  growthActivityOutcomes,
  growthFieldAuthorMembership,
  growthFollowUpCancelReasons,
  growthLocationErasedReasons,
  istDate,
  readGrowthLocation,
  refuseGrowthFieldWrite,
  refuseGrowthFollowUpClose,
  refuseGrowthFollowUpDue,
  refuseGrowthLocationRemoval,
  refuseGrowthReportTime,
  roundGrowthCoordinate,
  seesGrowthActivityLocation,
  type GrowthLeadCaller,
  type GrowthLeadFacts,
} from './index.js';

const migration = readFileSync(new URL('../../persistence/drizzle/0103_growth_field_work.sql', import.meta.url), 'utf8');
const notice = readFileSync(new URL('../../../docs/legal/growth-field-location-notice-DRAFT-for-legal-review.md', import.meta.url), 'utf8');

const region = 'region-ka';
const executive: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['exec'], allLeadRegionIds: [], unownedLeadRegionIds: [region], workingRegionIds: [region] },
  memberships: [{ membershipId: 'exec', role: 'GROWTH_EXECUTIVE', teams: ['COLLEGE_PARTNERSHIPS'] }],
};
const otherExecutive: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['other'], allLeadRegionIds: [], unownedLeadRegionIds: [region], workingRegionIds: [region] },
  memberships: [{ membershipId: 'other', role: 'GROWTH_EXECUTIVE', teams: ['COLLEGE_PARTNERSHIPS'] }],
};
const manager: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['mgr', 'exec'], allLeadRegionIds: [region], unownedLeadRegionIds: [region], workingRegionIds: [region] },
  memberships: [{ membershipId: 'mgr', role: 'GROWTH_MANAGER', teams: ['COLLEGE_PARTNERSHIPS'] }],
};
const otherManager: GrowthLeadCaller = {
  scope: { kind: 'PERSON', ownerMembershipIds: ['mgr2'], allLeadRegionIds: ['region-tn'], unownedLeadRegionIds: ['region-tn'], workingRegionIds: ['region-tn'] },
  memberships: [{ membershipId: 'mgr2', role: 'GROWTH_MANAGER', teams: ['COLLEGE_PARTNERSHIPS'] }],
};
const admin: GrowthLeadCaller = { scope: { kind: 'ALL' }, memberships: [] };
const lead = (overrides: Partial<GrowthLeadFacts> = {}): GrowthLeadFacts => ({
  kind: 'COLLEGE', ownerMembershipId: 'exec', regionIds: [region], doNotContact: false, open: true, ...overrides,
});

describe('the vocabulary matches the database', () => {
  it('lists every kind, outcome and reason the CHECKs accept', () => {
    for (const value of [...growthActivityKinds, ...growthActivityOutcomes, ...growthFollowUpCancelReasons, ...growthLocationErasedReasons]) {
      expect(migration).toContain(`'${value}'`);
    }
  });

  it('stores coordinates at 3 decimal places in the column type itself', () => {
    expect(migration).toMatch(/location_latitude numeric\(6,\s*3\)/);
    expect(migration).toMatch(/location_longitude numeric\(7,\s*3\)/);
  });

  it('serves the location notice word for word as the legal draft, labelled DRAFT', () => {
    expect(GROWTH_LOCATION_NOTICE_VERSION).toMatch(/^draft-/);
    expect(notice).toContain('DRAFT');
    for (const line of GROWTH_LOCATION_NOTICE_TEXT) expect(notice).toContain(line);
  });
});

describe('kinds, outcomes and where a location may go', () => {
  it('needs an outcome for everything but a note', () => {
    expect(growthActivityKinds.filter(growthActivityNeedsOutcome)).toEqual(['VISIT', 'CALL', 'MEETING']);
  });

  it('allows a location on in-person kinds only', () => {
    expect(growthActivityKinds.filter(growthActivityAllowsLocation)).toEqual(['VISIT', 'MEETING']);
  });
});

describe('the report time (design §14.2)', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  it('accepts a report from just now, and from six days ago', () => {
    expect(refuseGrowthReportTime(now, now)).toBeNull();
    expect(refuseGrowthReportTime(new Date(now.getTime() - 6 * 86_400_000), now)).toBeNull();
  });
  it('refuses a report more than 7 days old', () => {
    expect(refuseGrowthReportTime(new Date(now.getTime() - 7 * 86_400_000 - 1000), now)).toBe('GROWTH_REPORT_TOO_OLD');
  });
  it('tolerates a few minutes of phone-clock skew but refuses a report in the future', () => {
    expect(refuseGrowthReportTime(new Date(now.getTime() + 60_000), now)).toBeNull();
    expect(refuseGrowthReportTime(new Date(now.getTime() + 6 * 60_000), now)).toBe('GROWTH_REPORT_IN_FUTURE');
    expect(refuseGrowthReportTime(new Date(now.getTime() + 86_400_000), now)).toBe('GROWTH_REPORT_IN_FUTURE');
  });
});

describe('location precision (design §14.3)', () => {
  it('rounds to 3 decimal places', () => {
    expect(roundGrowthCoordinate(12.971_598_7)).toBe(12.972);
    expect(roundGrowthCoordinate(77.594_562_3)).toBe(77.595);
    expect(roundGrowthCoordinate(-33.868_49)).toBe(-33.868);
    expect(roundGrowthCoordinate(-0.0001)).toBe(0);
  });
  it('reads a plausible location and refuses anything else', () => {
    expect(readGrowthLocation({ latitude: 12.9715987, longitude: 77.5945623, accuracyM: 412.6 })).toEqual({ latitude: 12.972, longitude: 77.595, accuracyM: 413 });
    expect(readGrowthLocation({ latitude: 91, longitude: 0, accuracyM: 10 })).toBeNull();
    expect(readGrowthLocation({ latitude: 0, longitude: 181, accuracyM: 10 })).toBeNull();
    expect(readGrowthLocation({ latitude: 0, longitude: 0, accuracyM: -1 })).toBeNull();
    expect(readGrowthLocation({ latitude: 0, longitude: 0, accuracyM: 60_000 })).toBeNull();
    expect(readGrowthLocation({ latitude: 0, longitude: 0 })).toBeNull();
    expect(readGrowthLocation({ latitude: 0, longitude: 0, accuracyM: 5, altitude: 3 })).toBeNull();
    expect(readGrowthLocation({ latitude: Number.NaN, longitude: 0, accuracyM: 5 })).toBeNull();
    expect(readGrowthLocation('12.97,77.59')).toBeNull();
  });
});

describe('follow-up due dates', () => {
  const now = new Date('2026-10-01T20:00:00Z'); // 02:00 on 2 October in India
  it('takes today from the Indian calendar', () => {
    expect(istDate(now)).toBe('2026-10-02');
  });
  it('accepts a week back to a year ahead and refuses the rest', () => {
    expect(refuseGrowthFollowUpDue('2026-10-02', now)).toBeNull();
    expect(refuseGrowthFollowUpDue('2026-09-25', now)).toBeNull();
    expect(refuseGrowthFollowUpDue('2026-09-24', now)).toBe('GROWTH_FOLLOW_UP_DUE_TOO_EARLY');
    expect(refuseGrowthFollowUpDue('2027-10-03', now)).toBeNull();
    expect(refuseGrowthFollowUpDue('2027-10-04', now)).toBe('GROWTH_FOLLOW_UP_DUE_TOO_LATE');
    expect(refuseGrowthFollowUpDue('2026-02-30', now)).toBe('GROWTH_FOLLOW_UP_DUE_INVALID');
    expect(refuseGrowthFollowUpDue('tomorrow', now)).toBe('GROWTH_FOLLOW_UP_DUE_INVALID');
  });
});

describe('who may log field work (table design §4)', () => {
  it('lets the owner and a manager of the region log; an executive who does not own it must claim first', () => {
    expect(refuseGrowthFieldWrite(executive, lead())).toBeNull();
    expect(refuseGrowthFieldWrite(manager, lead())).toBeNull();
    expect(refuseGrowthFieldWrite(otherExecutive, lead({ ownerMembershipId: null }))).toBe('GROWTH_NOT_LEAD_OWNER');
    expect(refuseGrowthFieldWrite(otherExecutive, lead())).toBe('GROWTH_LEAD_NOT_FOUND');
    expect(refuseGrowthFieldWrite(otherManager, lead())).toBe('GROWTH_LEAD_NOT_FOUND');
  });
  it('refuses a do-not-contact or closed lead', () => {
    expect(refuseGrowthFieldWrite(executive, lead({ doNotContact: true }))).toBe('GROWTH_LEAD_DO_NOT_CONTACT');
    expect(refuseGrowthFieldWrite(executive, lead({ open: false }))).toBe('GROWTH_LEAD_CLOSED');
  });
  it('records the write through the owning membership, or a manager membership', () => {
    expect(growthFieldAuthorMembership(executive, lead())).toBe('exec');
    expect(growthFieldAuthorMembership(manager, lead())).toBe('mgr');
  });
});

describe('who may see a visit location (O-23)', () => {
  it('shows it to the author and their manager only', () => {
    expect(seesGrowthActivityLocation(executive, 'exec')).toBe(true);
    expect(seesGrowthActivityLocation(manager, 'exec')).toBe(true);
    expect(seesGrowthActivityLocation(otherExecutive, 'exec')).toBe(false);
    expect(seesGrowthActivityLocation(otherManager, 'exec')).toBe(false);
    expect(seesGrowthActivityLocation(admin, 'exec')).toBe(false);
  });
  it('lets only the author remove it, and the assignee or their manager close a follow-up', () => {
    expect(refuseGrowthLocationRemoval(executive, 'exec')).toBeNull();
    expect(refuseGrowthLocationRemoval(manager, 'exec')).toBe('GROWTH_NOT_ACTIVITY_AUTHOR');
    expect(refuseGrowthFollowUpClose(executive, 'exec')).toBeNull();
    expect(refuseGrowthFollowUpClose(manager, 'exec')).toBeNull();
    expect(refuseGrowthFollowUpClose(otherExecutive, 'exec')).toBe('GROWTH_NOT_FOLLOW_UP_ASSIGNEE');
  });
});
