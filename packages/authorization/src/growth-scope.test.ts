/**
 * Growth scope and territory rules (GROWTH-02, design §4.2).
 *
 * Exhaustive over the cases that decide whose pipeline a growth person sees: role, membership
 * state, live and ended assignments, team reporting lines, owned and unowned records, and the
 * three kinds of area (district, state only, none). Also pins the state vocabulary to the
 * migration's seed, so the two lists cannot drift.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canAdministerGrowthTerritory,
  growthScopeFor,
  growthTerritoryReasons,
  indianStateCodes,
  isGrowthRegionName,
  isIndianStateCode,
  isVisibleInGrowthScope,
  refuseGrowthArea,
  regionsCoveringArea,
  type GrowthRegionArea,
  type GrowthScope,
  type GrowthScopeInput,
} from './index.js';

const exec = { membershipId: 'm-exec', role: 'GROWTH_EXECUTIVE', state: 'ACTIVE', organizationKind: 'PLATFORM' };
const mgr = { membershipId: 'm-mgr', role: 'GROWTH_MANAGER', state: 'ACTIVE', organizationKind: 'PLATFORM' };
const none: Omit<GrowthScopeInput, 'memberships'> = { growthAdmin: false, assignments: [], teamRows: [] };

const areas: readonly GrowthRegionArea[] = [
  { regionId: 'r-south', stateCode: 'IN-KA', districtCode: null },
  { regionId: 'r-tn-north', stateCode: 'IN-TN', districtCode: 603 },
  { regionId: 'r-tn-south', stateCode: 'IN-TN', districtCode: 610 },
];

describe('the state vocabulary', () => {
  it('lists the 36 ISO 3166-2:IN subdivisions, 28 states and 8 union territories, as the migration seeds them', () => {
    expect(indianStateCodes).toHaveLength(36);
    expect(new Set(indianStateCodes).size).toBe(36);
    const sqlText = readFileSync(new URL('../../persistence/drizzle/0099_growth_territories.sql', import.meta.url), 'utf8');
    const seeded = [...sqlText.matchAll(/\('(IN-[A-Z]{2})', '[^']+', '(STATE|UNION_TERRITORY)'\)/g)];
    expect(seeded.map((match) => match[1]).sort()).toEqual([...indianStateCodes].sort());
    expect(seeded.filter((match) => match[2] === 'STATE')).toHaveLength(28);
    expect(seeded.filter((match) => match[2] === 'UNION_TERRITORY')).toHaveLength(8);
    // The 2023 changes are in; the retired codes are not.
    for (const code of ['IN-OD', 'IN-CG', 'IN-TS', 'IN-UK', 'IN-DH', 'IN-LA']) expect(isIndianStateCode(code)).toBe(true);
    for (const code of ['IN-OR', 'IN-CT', 'IN-TG', 'IN-UT', 'IN-DN', 'IN-DD', 'KA', 'in-ka']) expect(isIndianStateCode(code)).toBe(false);
  });

  it('accepts region names, never sentences or markup', () => {
    for (const name of ['South-1', 'NCR', 'Tamil Nadu (North)', 'A&N']) expect(isGrowthRegionName(name)).toBe(true);
    for (const name of ['', 'X', ' South', '<b>South</b>', 'a'.repeat(61), 'South;DROP', 7]) expect(isGrowthRegionName(name)).toBe(false);
  });

  it('keeps reason codes as fixed lists that never include the database-only MEMBERSHIP_ENDED', () => {
    for (const list of Object.values(growthTerritoryReasons)) {
      expect(list.length).toBeGreaterThan(0);
      expect(list as readonly string[]).not.toContain('MEMBERSHIP_ENDED');
    }
  });
});

describe('territory set-up is GROWTH_ADMIN work', () => {
  it('admits the super admin by baseline and an operations admin only with a grant', () => {
    expect(canAdministerGrowthTerritory({ memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] })).toBe(true);
    expect(canAdministerGrowthTerritory({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['GROWTH_ADMIN'] }] })).toBe(true);
    expect(canAdministerGrowthTerritory({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: [] }] })).toBe(false);
    expect(canAdministerGrowthTerritory({ memberships: [{ role: 'GROWTH_MANAGER', state: 'ACTIVE', grants: ['GROWTH_ADMIN'] }] })).toBe(false);
    expect(canAdministerGrowthTerritory({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'SUSPENDED', grants: ['GROWTH_ADMIN'] }] })).toBe(false);
  });
});

describe('which regions cover an area', () => {
  it('covers a district by its district region or its whole-state region', () => {
    expect(regionsCoveringArea({ stateCode: 'IN-KA', districtCode: 555 }, areas)).toEqual(['r-south']);
    expect(regionsCoveringArea({ stateCode: 'IN-TN', districtCode: 603 }, areas)).toEqual(['r-tn-north']);
    expect(regionsCoveringArea({ stateCode: 'IN-TN', districtCode: 999 }, areas)).toEqual([]);
  });

  it('covers a state-only area only by a whole-state region, never by every district region of that state', () => {
    expect(regionsCoveringArea({ stateCode: 'IN-KA', districtCode: null }, areas)).toEqual(['r-south']);
    expect(regionsCoveringArea({ stateCode: 'IN-TN', districtCode: null }, areas)).toEqual([]);
  });

  it('covers an area with no state by no region', () => {
    expect(regionsCoveringArea({ stateCode: null, districtCode: null }, areas)).toEqual([]);
    expect(regionsCoveringArea({ stateCode: null, districtCode: 603 }, areas)).toEqual([]);
  });
});

describe('the area rules the database enforces', () => {
  it('refuses an area already live in a region', () => {
    expect(refuseGrowthArea({ regionId: 'r-other', stateCode: 'IN-KA', districtCode: null }, areas)).toBe('GROWTH_AREA_TAKEN');
    expect(refuseGrowthArea({ regionId: 'r-other', stateCode: 'IN-TN', districtCode: 603 }, areas)).toBe('GROWTH_AREA_TAKEN');
  });

  it('refuses a whole state and a district of it in different regions, either way round', () => {
    expect(refuseGrowthArea({ regionId: 'r-other', stateCode: 'IN-KA', districtCode: 555 }, areas)).toBe('GROWTH_AREA_CONFLICT');
    expect(refuseGrowthArea({ regionId: 'r-other', stateCode: 'IN-TN', districtCode: null }, areas)).toBe('GROWTH_AREA_CONFLICT');
  });

  it('refuses the same combination inside one region as redundant', () => {
    expect(refuseGrowthArea({ regionId: 'r-south', stateCode: 'IN-KA', districtCode: 555 }, areas)).toBe('GROWTH_AREA_REDUNDANT');
    const single: GrowthRegionArea[] = [{ regionId: 'r-tn', stateCode: 'IN-TN', districtCode: 603 }];
    expect(refuseGrowthArea({ regionId: 'r-tn', stateCode: 'IN-TN', districtCode: null }, single)).toBe('GROWTH_AREA_REDUNDANT');
  });

  it('allows a new district of a district-split state, and any area of an uncovered state', () => {
    expect(refuseGrowthArea({ regionId: 'r-tn-south', stateCode: 'IN-TN', districtCode: 611 }, areas)).toBeNull();
    expect(refuseGrowthArea({ regionId: 'r-tn-north', stateCode: 'IN-TN', districtCode: 612 }, areas)).toBeNull();
    expect(refuseGrowthArea({ regionId: 'r-west', stateCode: 'IN-MH', districtCode: null }, areas)).toBeNull();
  });
});

describe('growthScopeFor', () => {
  it('gives a GROWTH_ADMIN holder everything, whatever else they hold', () => {
    expect(growthScopeFor({ ...none, growthAdmin: true, memberships: [] })).toEqual({ kind: 'ALL' });
  });

  it('gives nothing to someone with no ACTIVE growth membership of the platform', () => {
    expect(growthScopeFor({ ...none, memberships: [] })).toEqual({ kind: 'NONE' });
    expect(growthScopeFor({ ...none, memberships: [{ ...exec, state: 'SUSPENDED' }] })).toEqual({ kind: 'NONE' });
    expect(growthScopeFor({ ...none, memberships: [{ ...exec, state: 'ENDED' }] })).toEqual({ kind: 'NONE' });
    expect(growthScopeFor({ ...none, memberships: [{ ...exec, organizationKind: 'INSTITUTION' }] })).toEqual({ kind: 'NONE' });
    expect(growthScopeFor({ ...none, memberships: [{ ...exec, role: 'OPERATIONS_ADMIN' }] })).toEqual({ kind: 'NONE' });
  });

  it('gives an executive their own leads and the unowned leads of the regions they work today', () => {
    const scope = growthScopeFor({ ...none, memberships: [exec], assignments: [
      { membershipId: 'm-exec', regionId: 'r-south', role: 'EXECUTIVE', ended: false },
      { membershipId: 'm-exec', regionId: 'r-old', role: 'EXECUTIVE', ended: true },
    ] });
    expect(scope).toEqual({ kind: 'PERSON', ownerMembershipIds: ['m-exec'], allLeadRegionIds: [], unownedLeadRegionIds: ['r-south'], workingRegionIds: ['r-south'] });
  });

  it('gives a manager every lead of their regions, their reports\' leads and their own', () => {
    const scope = growthScopeFor({ ...none, memberships: [mgr], assignments: [
      { membershipId: 'm-mgr', regionId: 'r-tn-north', role: 'MANAGER', ended: false },
      { membershipId: 'm-exec', regionId: 'r-south', role: 'EXECUTIVE', ended: false },
    ], teamRows: [
      { memberMembershipId: 'm-exec', managerMembershipId: 'm-mgr', left: false },
      { memberMembershipId: 'm-former', managerMembershipId: 'm-mgr', left: true },
      { memberMembershipId: 'm-other', managerMembershipId: 'm-someone-else', left: false },
    ] });
    expect(scope).toEqual({ kind: 'PERSON', ownerMembershipIds: ['m-exec', 'm-mgr'], allLeadRegionIds: ['r-tn-north'], unownedLeadRegionIds: ['r-tn-north'], workingRegionIds: ['r-tn-north'] });
  });

  it('ignores an assignment whose role does not match the membership, and assignments of other people', () => {
    const scope = growthScopeFor({ ...none, memberships: [exec], assignments: [
      { membershipId: 'm-exec', regionId: 'r-x', role: 'MANAGER', ended: false },
      { membershipId: 'm-someone', regionId: 'r-y', role: 'EXECUTIVE', ended: false },
    ] });
    expect(scope).toMatchObject({ kind: 'PERSON', allLeadRegionIds: [], unownedLeadRegionIds: [], workingRegionIds: [] });
  });

  it('follows today\'s assignment: ending it removes the region at once, and a suspended membership sees nothing', () => {
    const assigned: GrowthScopeInput = { ...none, memberships: [exec], assignments: [{ membershipId: 'm-exec', regionId: 'r-south', role: 'EXECUTIVE', ended: false }] };
    expect(growthScopeFor(assigned)).toMatchObject({ workingRegionIds: ['r-south'] });
    expect(growthScopeFor({ ...assigned, assignments: [{ ...assigned.assignments[0]!, ended: true }] })).toMatchObject({ workingRegionIds: [] });
    expect(growthScopeFor({ ...assigned, memberships: [{ ...exec, state: 'SUSPENDED' }] })).toEqual({ kind: 'NONE' });
  });

  it('works as the union for a person holding both growth roles', () => {
    const scope = growthScopeFor({ ...none, memberships: [exec, mgr], assignments: [
      { membershipId: 'm-exec', regionId: 'r-a', role: 'EXECUTIVE', ended: false },
      { membershipId: 'm-mgr', regionId: 'r-b', role: 'MANAGER', ended: false },
    ] });
    expect(scope).toEqual({ kind: 'PERSON', ownerMembershipIds: ['m-exec', 'm-mgr'], allLeadRegionIds: ['r-b'], unownedLeadRegionIds: ['r-a', 'r-b'], workingRegionIds: ['r-a', 'r-b'] });
  });
});

describe('isVisibleInGrowthScope', () => {
  const executive: GrowthScope = { kind: 'PERSON', ownerMembershipIds: ['m-exec'], allLeadRegionIds: [], unownedLeadRegionIds: ['r-south'], workingRegionIds: ['r-south'] };
  const manager: GrowthScope = { kind: 'PERSON', ownerMembershipIds: ['m-mgr', 'm-exec'], allLeadRegionIds: ['r-south'], unownedLeadRegionIds: ['r-south'], workingRegionIds: ['r-south'] };

  const cases: readonly [string, { ownerMembershipId: string | null; regionIds: readonly string[] }, boolean, boolean][] = [
    // label, record, executive sees, manager sees
    ['own lead in own region', { ownerMembershipId: 'm-exec', regionIds: ['r-south'] }, true, true],
    ['own lead outside every region', { ownerMembershipId: 'm-exec', regionIds: ['r-north'] }, true, true],
    ['own lead with no area', { ownerMembershipId: 'm-exec', regionIds: [] }, true, true],
    ['unowned lead in own region', { ownerMembershipId: null, regionIds: ['r-south'] }, true, true],
    ['unowned lead in another region', { ownerMembershipId: null, regionIds: ['r-north'] }, false, false],
    ['unowned lead with no area', { ownerMembershipId: null, regionIds: [] }, false, false],
    ['a colleague\'s lead in own region', { ownerMembershipId: 'm-peer', regionIds: ['r-south'] }, false, true],
    ['a colleague\'s lead elsewhere', { ownerMembershipId: 'm-peer', regionIds: ['r-north'] }, false, false],
    ['a report\'s lead elsewhere', { ownerMembershipId: 'm-exec', regionIds: ['r-north'] }, true, true],
  ];

  for (const [label, record, executiveSees, managerSees] of cases) {
    it(`${label}: executive ${executiveSees ? 'sees' : 'does not see'}, manager ${managerSees ? 'sees' : 'does not see'}`, () => {
      expect(isVisibleInGrowthScope(executive, record)).toBe(executiveSees);
      expect(isVisibleInGrowthScope(manager, record)).toBe(managerSees);
      expect(isVisibleInGrowthScope({ kind: 'ALL' }, record)).toBe(true);
      expect(isVisibleInGrowthScope({ kind: 'NONE' }, record)).toBe(false);
    });
  }
});
