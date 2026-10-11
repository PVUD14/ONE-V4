/**
 * Who in growth sees which region, and so which leads (GROWTH-02; design §4.2).
 *
 * One pure function, `growthScopeFor`, the way `institution-scope.ts` does it for colleges
 * (INST-02): every growth read composes its predicate from it, and no controller writes its
 * own. Its inputs are the rows as they stand now — live territory assignments, live team
 * rows, ACTIVE memberships — loaded in one place (packages/persistence/src/growth-scope.ts),
 * so visibility follows today's assignment with nothing cached.
 *
 * Also here: the territory vocabulary (the 36 ISO 3166-2:IN codes the migration seeds,
 * reason codes) and the area rules the database enforces, in pure form for the screens.
 *
 * Design: docs/architecture/growth-territories-table-design.md
 */
import { hasInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** ISO 3166-2:IN as amended to 2023-11-23. The migration (0099) seeds exactly these. */
export const indianStateCodes = [
  'IN-AP', 'IN-AR', 'IN-AS', 'IN-BR', 'IN-CG', 'IN-GA', 'IN-GJ', 'IN-HR', 'IN-HP', 'IN-JH', 'IN-KA', 'IN-KL',
  'IN-MP', 'IN-MH', 'IN-MN', 'IN-ML', 'IN-MZ', 'IN-NL', 'IN-OD', 'IN-PB', 'IN-RJ', 'IN-SK', 'IN-TN', 'IN-TS',
  'IN-TR', 'IN-UP', 'IN-UK', 'IN-WB',
  'IN-AN', 'IN-CH', 'IN-DH', 'IN-DL', 'IN-JK', 'IN-LA', 'IN-LD', 'IN-PY',
] as const;
export type IndianStateCode = (typeof indianStateCodes)[number];

export function isIndianStateCode(value: unknown): value is IndianStateCode {
  return typeof value === 'string' && (indianStateCodes as readonly string[]).includes(value);
}

export const growthAssignmentRoles = ['EXECUTIVE', 'MANAGER'] as const;
export type GrowthAssignmentRole = (typeof growthAssignmentRoles)[number];

export function isGrowthAssignmentRole(value: unknown): value is GrowthAssignmentRole {
  return typeof value === 'string' && (growthAssignmentRoles as readonly string[]).includes(value);
}

/** Reason codes, in code so the audit trail is comparable. The database CHECKs repeat them. */
export const growthTerritoryReasons = {
  createRegion: ['NEW_REGION', 'REORGANISATION', 'CORRECTION'],
  retireRegion: ['REORGANISATION', 'NO_LONGER_WORKED', 'CORRECTION'],
  addArea: ['NEW_COVERAGE', 'TERRITORY_CHANGE', 'CORRECTION'],
  removeArea: ['TERRITORY_CHANGE', 'REGION_RETIRING', 'CORRECTION'],
  startAssignment: ['NEW_ASSIGNMENT', 'TERRITORY_CHANGE', 'COVERAGE', 'CORRECTION'],
  endAssignment: ['TERRITORY_CHANGE', 'WORKLOAD', 'LEFT_REGION', 'CORRECTION'],
  importDistricts: ['INITIAL_IMPORT', 'LGD_UPDATE', 'CORRECTION'],
} as const;

/** A region's name: 2–60 characters, a name rather than a sentence. */
export const growthRegionNamePattern = /^[A-Za-z0-9][A-Za-z0-9 &()./-]*$/;
export function isGrowthRegionName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 60 && growthRegionNamePattern.test(value);
}

/** Territory set-up is GROWTH_ADMIN work, from Operations. */
export function canAdministerGrowthTerritory(actor: InternalCapabilityContext): boolean {
  return hasInternalCapability(actor, 'GROWTH_ADMIN');
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/** A live region area: a whole state (`districtCode` null) or one district of it. */
export interface GrowthRegionArea {
  readonly regionId: string;
  readonly stateCode: string;
  readonly districtCode: number | null;
}

/** Where a lead (or anything placed) is: its district, or only its state, or nothing. */
export interface GrowthArea {
  readonly stateCode: string | null;
  readonly districtCode: number | null;
}

/**
 * The regions that cover an area. A district is covered by a region holding that district or
 * the whole state; a state-only area only by a region holding the whole state (the narrower
 * reading, decided in the table design §7); an area with no state by none.
 */
export function regionsCoveringArea(area: GrowthArea, areas: readonly GrowthRegionArea[]): readonly string[] {
  if (!area.stateCode) return [];
  const covering = areas.filter((live) => live.stateCode === area.stateCode
    && (live.districtCode === null || (area.districtCode !== null && live.districtCode === area.districtCode)));
  return [...new Set(covering.map((live) => live.regionId))].sort();
}

export type GrowthAreaRefusal =
  | 'GROWTH_AREA_TAKEN'       // the same state or district is live in a region already
  | 'GROWTH_AREA_CONFLICT'    // a whole state and a district of it would live in different regions
  | 'GROWTH_AREA_REDUNDANT';  // ... or in the same region, which says the same thing twice

/** The database's area rules, in pure form: why adding `candidate` beside `live` is refused, or null. */
export function refuseGrowthArea(candidate: GrowthRegionArea, live: readonly GrowthRegionArea[]): GrowthAreaRefusal | null {
  const sameState = live.filter((area) => area.stateCode === candidate.stateCode);
  if (sameState.some((area) => area.districtCode === candidate.districtCode)) return 'GROWTH_AREA_TAKEN';
  const opposite = sameState.filter((area) => (area.districtCode === null) !== (candidate.districtCode === null));
  if (opposite.some((area) => area.regionId !== candidate.regionId)) return 'GROWTH_AREA_CONFLICT';
  if (opposite.length) return 'GROWTH_AREA_REDUNDANT';
  return null;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface GrowthScopeMembership {
  readonly membershipId: string;
  readonly role: string;
  readonly state: string;
  readonly organizationKind: string;
}

export interface GrowthScopeAssignment {
  readonly membershipId: string;
  readonly regionId: string;
  readonly role: GrowthAssignmentRole;
  /** Live assignments only matter; an ended one is passed through and ignored. */
  readonly ended: boolean;
}

export interface GrowthScopeTeamRow {
  readonly memberMembershipId: string;
  readonly managerMembershipId: string | null;
  readonly left: boolean;
}

export interface GrowthScopeInput {
  /** GROWTH_ADMIN, resolved by the caller through the capability model. */
  readonly growthAdmin: boolean;
  readonly memberships: readonly GrowthScopeMembership[];
  readonly assignments: readonly GrowthScopeAssignment[];
  readonly teamRows: readonly GrowthScopeTeamRow[];
}

/**
 * ALL: every growth record (a GROWTH_ADMIN holder). NONE: nothing. PERSON:
 *  - `ownerMembershipIds`: leads owned by these memberships (own, and for a manager, their reports);
 *  - `allLeadRegionIds`: every lead, owned or not, in these regions (a manager's regions);
 *  - `unownedLeadRegionIds`: unowned leads in these regions (an executive's regions, and a
 *    manager's, which `allLeadRegionIds` already covers);
 *  - `workingRegionIds`: the regions the person works today, for the Territory page.
 */
export type GrowthScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'NONE' }
  | {
    readonly kind: 'PERSON';
    readonly ownerMembershipIds: readonly string[];
    readonly allLeadRegionIds: readonly string[];
    readonly unownedLeadRegionIds: readonly string[];
    readonly workingRegionIds: readonly string[];
  };

const sorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();

export function growthScopeFor(input: GrowthScopeInput): GrowthScope {
  if (input.growthAdmin) return { kind: 'ALL' };
  const active = input.memberships.filter((membership) => membership.state === 'ACTIVE' && membership.organizationKind === 'PLATFORM'
    && (membership.role === 'GROWTH_EXECUTIVE' || membership.role === 'GROWTH_MANAGER'));
  if (!active.length) return { kind: 'NONE' };
  const own = new Set(active.map((membership) => membership.membershipId));
  const managerIds = new Set(active.filter((membership) => membership.role === 'GROWTH_MANAGER').map((membership) => membership.membershipId));
  const executiveIds = new Set(active.filter((membership) => membership.role === 'GROWTH_EXECUTIVE').map((membership) => membership.membershipId));
  const live = input.assignments.filter((assignment) => !assignment.ended);
  const managed = live.filter((assignment) => assignment.role === 'MANAGER' && managerIds.has(assignment.membershipId)).map((assignment) => assignment.regionId);
  const worked = live.filter((assignment) => assignment.role === 'EXECUTIVE' && executiveIds.has(assignment.membershipId)).map((assignment) => assignment.regionId);
  const reports = input.teamRows
    .filter((row) => !row.left && row.managerMembershipId !== null && managerIds.has(row.managerMembershipId))
    .map((row) => row.memberMembershipId);
  return {
    kind: 'PERSON',
    ownerMembershipIds: sorted([...own, ...reports]),
    allLeadRegionIds: sorted(managed),
    unownedLeadRegionIds: sorted([...worked, ...managed]),
    workingRegionIds: sorted([...worked, ...managed]),
  };
}

/** What a scope needs to know about a lead to decide whether it is visible. */
export interface GrowthScopedRecord {
  readonly ownerMembershipId: string | null;
  /** The regions covering the record's area today (`regionsCoveringArea`). */
  readonly regionIds: readonly string[];
}

export function isVisibleInGrowthScope(scope: GrowthScope, record: GrowthScopedRecord): boolean {
  if (scope.kind === 'ALL') return true;
  if (scope.kind === 'NONE') return false;
  if (record.ownerMembershipId !== null && scope.ownerMembershipIds.includes(record.ownerMembershipId)) return true;
  if (record.regionIds.some((region) => scope.allLeadRegionIds.includes(region))) return true;
  return record.ownerMembershipId === null && record.regionIds.some((region) => scope.unownedLeadRegionIds.includes(region));
}
