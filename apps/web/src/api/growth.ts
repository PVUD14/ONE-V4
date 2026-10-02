/**
 * ONE · API client — Growth portal (GROWTH-01, ADR-040).
 *
 * The growth person's own workspace read, and the Operations → Settings "Growth team"
 * section a GROWTH_ADMIN holder uses to invite growth people, set their team, manager and
 * staff type, and end their membership. The server decides everything.
 */
import { requestJson } from './http.js';

export type GrowthRoleDto = 'GROWTH_EXECUTIVE' | 'GROWTH_MANAGER';
export type GrowthStaffTypeDto = 'EMPLOYEE' | 'CONTRACTOR';

export interface GrowthMeDto {
  readonly role: GrowthRoleDto;
  readonly staffType: GrowthStaffTypeDto | null;
  /** GROWTH-03: open leads the person owns. */
  readonly openLeads?: number;
  /** GROWTH-06: the person's visits this IST month, and open follow-ups due today or earlier. */
  readonly visitsThisMonth?: number;
  readonly followUpsDue?: number;
  readonly teams: readonly { readonly team: string; readonly joinedAt: string; readonly manager: { readonly email: string } | null }[];
  readonly correlationId: string;
}

export function getGrowthMe(token: string, signal?: AbortSignal): Promise<GrowthMeDto> {
  return requestJson('/api/v1/growth/me', { token, ...(signal ? { signal } : {}) });
}

export interface GrowthTeamMemberDto {
  readonly membershipId: string;
  readonly email: string;
  readonly role: GrowthRoleDto;
  readonly state: string;
  readonly joinedAt: string | null;
  readonly isSelf: boolean;
  readonly staffType: { readonly staffType: GrowthStaffTypeDto; readonly effectiveFrom: string | null } | null;
  readonly teams: readonly {
    readonly team: string;
    readonly joinedAt: string | null;
    readonly reasonCode: string;
    readonly manager: { readonly membershipId: string; readonly email: string | null } | null;
  }[];
}

export interface GrowthTeamDirectoryDto {
  readonly members: readonly GrowthTeamMemberDto[];
  readonly invitations: readonly {
    readonly id: string; readonly email: string; readonly role: GrowthRoleDto; readonly staffType: GrowthStaffTypeDto;
    readonly createdAt: string | null; readonly expiresAt: string | null; readonly delivery: { readonly state: string };
  }[];
  readonly truncated: boolean;
  readonly managers: readonly { readonly membershipId: string; readonly email: string }[];
  readonly vocabulary: {
    readonly roles: readonly string[];
    readonly teams: readonly string[];
    readonly staffTypes: readonly string[];
    readonly reasons: {
      readonly joinTeam: readonly string[];
      readonly leaveTeam: readonly string[];
      readonly endMembership: readonly string[];
      readonly revokeInvitation: readonly string[];
      readonly initialStaffType: readonly string[];
      readonly changeStaffType: readonly string[];
    };
  };
  readonly correlationId: string;
}

const teamPath = '/api/v1/operations/growth-team';

export function listGrowthTeam(token: string, signal?: AbortSignal): Promise<GrowthTeamDirectoryDto> {
  return requestJson(teamPath, { token, ...(signal ? { signal } : {}) });
}

export function inviteGrowthPerson(
  token: string, body: { readonly email: string; readonly role: string; readonly staffType: string },
): Promise<{ readonly invitation: { readonly id: string; readonly state: string; readonly delivery: { readonly state: string } }; readonly correlationId: string }> {
  return requestJson(`${teamPath}/invitations`, { token, method: 'POST', body });
}

export function revokeGrowthInvitation(token: string, invitationId: string, body: { readonly reasonCode: string }): Promise<{ readonly correlationId: string }> {
  return requestJson(`${teamPath}/invitations/${encodeURIComponent(invitationId)}/revoke`, { token, method: 'POST', body });
}

export function setGrowthTeam(
  token: string, membershipId: string, body: { readonly team: string; readonly managerMembershipId: string | null; readonly reasonCode: string },
): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/teams`, { token, method: 'POST', body });
}

export function endGrowthTeam(token: string, membershipId: string, team: string, body: { readonly reasonCode: string }): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/teams/${encodeURIComponent(team)}/end`, { token, method: 'POST', body });
}

export function setGrowthStaffType(
  token: string, membershipId: string, body: { readonly staffType: string; readonly reasonCode: string },
): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/staff-type`, { token, method: 'POST', body });
}

export function endGrowthMembership(token: string, membershipId: string, body: { readonly reasonCode: string }): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/end`, { token, method: 'POST', body });
}

// ---------------------------------------------------------------------------
// GROWTH-02: territories and regions
// ---------------------------------------------------------------------------

export interface GrowthTerritoryAreaDto {
  readonly stateCode: string;
  readonly stateName: string;
  readonly districtCode: number | null;
  readonly districtName: string | null;
}

/** `GET /api/v1/growth/territory`: the regions the signed-in growth person works today. */
export interface GrowthTerritoryDto {
  readonly role: GrowthRoleDto;
  readonly regions: readonly {
    readonly id: string;
    readonly name: string;
    readonly myRole: 'EXECUTIVE' | 'MANAGER';
    readonly since: string | null;
    readonly areas: readonly GrowthTerritoryAreaDto[];
    readonly people: readonly { readonly email: string; readonly role: 'EXECUTIVE' | 'MANAGER'; readonly since: string }[];
    /** GROWTH-03: open, unowned, contactable leads in the region. */
    readonly unownedLeads?: number;
  }[];
  readonly correlationId: string;
}

export function getGrowthTerritory(token: string, signal?: AbortSignal): Promise<GrowthTerritoryDto> {
  return requestJson('/api/v1/growth/territory', { token, ...(signal ? { signal } : {}) });
}

export interface GrowthDistrictImportReportDto {
  readonly filename: string;
  readonly fileProblems: readonly string[];
  readonly rowCount: number;
  readonly counts: { readonly new: number; readonly unchanged: number; readonly renamed: number; readonly errors: number };
  readonly rows: readonly {
    readonly line: number; readonly districtCode: number | null; readonly districtName: string | null; readonly stateCode: string | null;
    readonly status: 'NEW' | 'UNCHANGED' | 'RENAMED' | 'ERROR'; readonly issues: readonly string[]; readonly previousName?: string;
  }[];
  readonly committable: boolean;
  readonly digest: string;
}

/** `GET /api/v1/operations/growth-territories`: Operations → Settings → Growth set-up. */
export interface GrowthSetupDto {
  readonly states: readonly { readonly code: string; readonly name: string; readonly kind: 'STATE' | 'UNION_TERRITORY'; readonly districtCount: number }[];
  readonly regions: readonly {
    readonly id: string; readonly name: string; readonly createdAt: string | null; readonly reasonCode: string;
    readonly retiredAt: string | null; readonly retiredReasonCode: string | null;
    readonly areas: readonly (GrowthTerritoryAreaDto & { readonly id: string; readonly addedAt: string | null; readonly reasonCode: string })[];
    readonly assignments: readonly {
      readonly id: string; readonly membershipId: string; readonly email: string; readonly role: 'EXECUTIVE' | 'MANAGER';
      readonly startsAt: string | null; readonly reasonCode: string; readonly membershipState: string;
    }[];
  }[];
  readonly truncated: boolean;
  readonly people: readonly { readonly membershipId: string; readonly email: string; readonly role: GrowthRoleDto }[];
  readonly lastImport: {
    readonly id: string; readonly filename: string; readonly rowCount: number; readonly created: number; readonly renamed: number;
    readonly unchanged: number; readonly reasonCode: string; readonly importedAt: string | null; readonly importedBy: string;
  } | null;
  readonly vocabulary: {
    readonly assignmentRoles: readonly string[];
    readonly reasons: {
      readonly createRegion: readonly string[]; readonly retireRegion: readonly string[]; readonly addArea: readonly string[];
      readonly removeArea: readonly string[]; readonly startAssignment: readonly string[]; readonly endAssignment: readonly string[];
      readonly importDistricts: readonly string[];
    };
  };
  readonly limits: { readonly importRows: number; readonly importCharacters: number };
  readonly correlationId: string;
}

const territoryPath = '/api/v1/operations/growth-territories';

export function getGrowthSetup(token: string, signal?: AbortSignal): Promise<GrowthSetupDto> {
  return requestJson(territoryPath, { token, ...(signal ? { signal } : {}) });
}

export function listGrowthDistricts(token: string, stateCode: string, signal?: AbortSignal): Promise<{
  readonly stateCode: string; readonly districts: readonly { readonly code: number; readonly name: string; readonly region: { readonly id: string; readonly name: string } | null }[];
}> {
  return requestJson(`${territoryPath}/districts?state=${encodeURIComponent(stateCode)}`, { token, ...(signal ? { signal } : {}) });
}

export function previewGrowthDistrictImport(token: string, body: { readonly filename: string; readonly content: string }): Promise<{ readonly preview: GrowthDistrictImportReportDto }> {
  return requestJson(`${territoryPath}/district-imports/preview`, { token, method: 'POST', body });
}

export function commitGrowthDistrictImport(
  token: string, body: { readonly filename: string; readonly content: string; readonly previewDigest: string; readonly reasonCode: string },
): Promise<{ readonly import: { readonly id: string; readonly rowCount: number; readonly counts: GrowthDistrictImportReportDto['counts'] } }> {
  return requestJson(`${territoryPath}/district-imports/commit`, { token, method: 'POST', body });
}

export function createGrowthRegion(token: string, body: { readonly name: string; readonly reasonCode: string }): Promise<{ readonly region: { readonly id: string } }> {
  return requestJson(`${territoryPath}/regions`, { token, method: 'POST', body });
}

export function retireGrowthRegion(token: string, regionId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/retire`, { token, method: 'POST', body });
}

export function addGrowthRegionArea(token: string, regionId: string, body: { readonly stateCode: string; readonly districtCode: number | null; readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/areas`, { token, method: 'POST', body });
}

export function removeGrowthRegionArea(token: string, regionId: string, areaId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/areas/${encodeURIComponent(areaId)}/remove`, { token, method: 'POST', body });
}

export function assignGrowthTerritory(token: string, regionId: string, body: { readonly membershipId: string; readonly role: string; readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/assignments`, { token, method: 'POST', body });
}

export function endGrowthTerritoryAssignment(token: string, regionId: string, assignmentId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/assignments/${encodeURIComponent(assignmentId)}/end`, { token, method: 'POST', body });
}

// ---------------------------------------------------------------------------
// GROWTH-03: the lead register, contacts and the privacy paths
// ---------------------------------------------------------------------------

export type GrowthLeadKindDto = 'COLLEGE' | 'EMPLOYER';
export type GrowthLeadViewDto = 'ALL' | 'MINE' | 'UNOWNED' | 'NEEDS_OWNER';

export interface GrowthLeadSummaryDto {
  readonly id: string;
  readonly kind: GrowthLeadKindDto;
  readonly name: string;
  readonly area: { readonly stateCode: string | null; readonly stateName: string | null; readonly districtCode: number | null; readonly districtName: string | null; readonly city: string | null };
  readonly aisheCode: string | null;
  readonly websiteDomain: string | null;
  readonly owner: { readonly email: string | null; readonly isMe: boolean } | null;
  readonly needsNewOwner: boolean;
  readonly stage: string;
  readonly lostReasonCode: string | null;
  readonly source: string;
  readonly possibleDuplicate: boolean;
  readonly doNotContact: { readonly at: string | null; readonly reasonCode: string | null } | null;
  readonly handedOff: boolean;
  readonly liveContacts: number;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly stale: boolean;
  readonly version: number;
}

export interface GrowthLeadContactDto {
  readonly id: string;
  readonly role: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly masked: boolean;
  readonly permissionBasis: string;
  readonly source: string;
  readonly notice: { readonly givenAt: string | null; readonly version: string | null } | null;
  readonly addedAt: string | null;
}

export interface GrowthLeadDetailDto extends GrowthLeadSummaryDto {
  readonly contactsShownInFull: boolean;
  readonly contacts: readonly GrowthLeadContactDto[];
  readonly removedContacts: number;
  readonly ownerHistory: readonly { readonly reasonCode: string; readonly at: string | null; readonly from: string | null; readonly to: string | null }[];
  readonly stageHistory: readonly { readonly from: string | null; readonly to: string; readonly reasonCode: string | null; readonly at: string | null }[];
}

export interface GrowthLeadVocabularyDto {
  readonly kinds: readonly GrowthLeadKindDto[];
  readonly stages: Readonly<Record<GrowthLeadKindDto, readonly string[]>>;
  readonly sources: readonly string[];
  readonly contactRoles: readonly string[];
  readonly contactSourcesByBasis: Readonly<Record<string, readonly string[]>>;
  readonly reasons: Readonly<Record<'reassign' | 'adminReassign' | 'removeContact' | 'adminRemoveContact' | 'revealContact' | 'doNotContact', readonly string[]>>;
  readonly contactLimit: number;
  readonly purpose: string;
  readonly notice: { readonly version: string; readonly status: string; readonly text: readonly string[] };
}

export interface GrowthLeadPageDto { readonly leads: readonly GrowthLeadSummaryDto[]; readonly nextCursor: string | null }

export interface GrowthLeadQuery { readonly kind?: GrowthLeadKindDto; readonly view?: GrowthLeadViewDto; readonly q?: string; readonly cursor?: string }

function leadQueryString(query: GrowthLeadQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

const leadsPath = '/api/v1/growth/leads';
const opsLeadsPath = '/api/v1/operations/growth-leads';

export function getGrowthLeadVocabulary(token: string, signal?: AbortSignal): Promise<GrowthLeadVocabularyDto> {
  return requestJson(`${leadsPath}/vocabulary`, { token, ...(signal ? { signal } : {}) });
}

export function listGrowthLeads(token: string, query: GrowthLeadQuery, signal?: AbortSignal): Promise<GrowthLeadPageDto> {
  return requestJson(`${leadsPath}${leadQueryString(query)}`, { token, ...(signal ? { signal } : {}) });
}

export function getGrowthLead(token: string, leadId: string, signal?: AbortSignal): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}`, { token, ...(signal ? { signal } : {}) });
}

export interface NewGrowthLeadBody {
  readonly kind: GrowthLeadKindDto; readonly name: string; readonly stateCode?: string | null; readonly districtCode?: number | null;
  readonly city?: string | null; readonly aisheCode?: string | null; readonly websiteDomain?: string | null; readonly source: string;
}

export function createGrowthLead(token: string, body: NewGrowthLeadBody): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(leadsPath, { token, method: 'POST', body });
}

export function claimGrowthLead(token: string, leadId: string): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/claim`, { token, method: 'POST', body: {} });
}

export function getGrowthLeadReassignOptions(token: string, leadId: string, operations = false): Promise<{ readonly options: readonly { readonly membershipId: string; readonly email: string; readonly role: string }[] }> {
  return requestJson(`${operations ? opsLeadsPath : leadsPath}/${encodeURIComponent(leadId)}/reassign-options`, { token });
}

export function reassignGrowthLead(token: string, leadId: string, body: { readonly toMembershipId: string | null; readonly reasonCode: string }, operations = false): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${operations ? opsLeadsPath : leadsPath}/${encodeURIComponent(leadId)}/reassign`, { token, method: 'POST', body });
}

export interface NewGrowthContactBody {
  readonly role: string; readonly fullName: string; readonly email: string | null; readonly phone: string | null;
  readonly permissionBasis: string; readonly source: string; readonly noticeGiven: boolean;
}

export function addGrowthLeadContact(token: string, leadId: string, body: NewGrowthContactBody): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/contacts`, { token, method: 'POST', body });
}

export function recordGrowthContactNotice(token: string, leadId: string, contactId: string): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/contacts/${encodeURIComponent(contactId)}/notice`, { token, method: 'POST', body: {} });
}

export function removeGrowthLeadContact(token: string, leadId: string, contactId: string, body: { readonly reasonCode: string }, operations = false): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${operations ? opsLeadsPath : leadsPath}/${encodeURIComponent(leadId)}/contacts/${encodeURIComponent(contactId)}/remove`, { token, method: 'POST', body });
}

export function revealGrowthLeadContact(token: string, leadId: string, contactId: string, body: { readonly reasonCode: string }, operations = false): Promise<{ readonly contact: { readonly fullName: string; readonly email: string | null; readonly phone: string | null } }> {
  return requestJson(`${operations ? opsLeadsPath : leadsPath}/${encodeURIComponent(leadId)}/contacts/${encodeURIComponent(contactId)}/reveal`, { token, method: 'POST', body });
}

export function setGrowthLeadDoNotContact(token: string, leadId: string, body: { readonly reasonCode: string }, operations = false): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${operations ? opsLeadsPath : leadsPath}/${encodeURIComponent(leadId)}/do-not-contact`, { token, method: 'POST', body });
}

export function listOperationsGrowthLeads(token: string, query: GrowthLeadQuery, signal?: AbortSignal): Promise<GrowthLeadPageDto & { readonly vocabulary: GrowthLeadVocabularyDto }> {
  return requestJson(`${opsLeadsPath}${leadQueryString(query)}`, { token, ...(signal ? { signal } : {}) });
}

export function getOperationsGrowthLead(token: string, leadId: string, signal?: AbortSignal): Promise<{ readonly lead: GrowthLeadDetailDto }> {
  return requestJson(`${opsLeadsPath}/${encodeURIComponent(leadId)}`, { token, ...(signal ? { signal } : {}) });
}

export interface GrowthContactLookupMatchDto {
  readonly contactId: string; readonly leadId: string; readonly organisation: string; readonly kind: string; readonly contactRole: string;
  readonly fullName: string | null; readonly email: string | null; readonly phone: string | null; readonly permissionBasis: string; readonly source: string;
  readonly noticeGivenAt: string | null; readonly noticeVersion: string | null; readonly addedAt: string; readonly removedAt: string | null;
  readonly removedReasonCode: string | null; readonly leadDoNotContact: boolean;
}

const privacyContactsPath = '/api/v1/operations/privacy/growth-contacts';

export function lookupGrowthContacts(token: string, body: { readonly email?: string; readonly phone?: string; readonly reference: string }): Promise<{ readonly matches: readonly GrowthContactLookupMatchDto[] }> {
  return requestJson(`${privacyContactsPath}/lookup`, { token, method: 'POST', body });
}

export function eraseGrowthContacts(token: string, body: { readonly email?: string; readonly phone?: string; readonly reference: string; readonly doNotContact: boolean }): Promise<{ readonly removed: number; readonly doNotContactLeads: number }> {
  return requestJson(`${privacyContactsPath}/erase`, { token, method: 'POST', body });
}

// ---------------------------------------------------------------------------
// GROWTH-06: field work. Every write carries an Idempotency-Key, so a retried click or a resend
// lands once; the server answers a replay with what the first send produced.
// ---------------------------------------------------------------------------

export type GrowthActivityKindDto = 'VISIT' | 'CALL' | 'MEETING' | 'NOTE';

export interface GrowthActivityDto {
  readonly id: string;
  readonly leadId: string;
  readonly leadName: string;
  readonly leadKind: GrowthLeadKindDto;
  readonly kind: GrowthActivityKindDto;
  readonly outcome: string | null;
  readonly contact: { readonly id: string; readonly role: string | null; readonly fullName: string | null } | null;
  readonly notes: string | null;
  readonly notesErased: boolean;
  readonly author: { readonly email: string; readonly isMe: boolean };
  readonly occurredAt: string | null;
  readonly receivedAt: string | null;
  /** Present only for the author and their manager (design §14.3); absent for everyone else. */
  readonly location?: { readonly latitude: number; readonly longitude: number; readonly accuracyM: number } | null;
  readonly locationRemoved?: { readonly at: string | null; readonly reasonCode: string } | null;
}

export interface GrowthFollowUpDto {
  readonly id: string;
  readonly leadId: string;
  readonly leadName: string;
  readonly leadKind: GrowthLeadKindDto;
  readonly title: string | null;
  readonly titleErased: boolean;
  readonly dueOn: string;
  readonly state: 'OPEN' | 'DONE' | 'CANCELLED';
  readonly overdue: boolean;
  readonly dueToday: boolean;
  readonly assignee: { readonly email: string; readonly isMe: boolean };
  readonly activityId: string | null;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly cancelReasonCode: string | null;
}

export interface GrowthFieldVocabularyDto {
  readonly kinds: readonly GrowthActivityKindDto[];
  readonly outcomes: readonly string[];
  readonly cancelReasons: readonly string[];
  readonly notesMax: number;
  readonly titleMax: number;
  readonly reportMaxAgeDays: number;
  readonly locationRetentionDays: number;
  readonly listLimit: number;
  readonly locationNotice: { readonly version: string; readonly status: string; readonly text: readonly string[] };
}

export interface GrowthFieldDto {
  readonly view: 'MINE' | 'TEAM';
  readonly canSeeTeam: boolean;
  readonly today: string;
  readonly counts: {
    readonly visitsThisMonth: number; readonly activitiesThisMonth: number; readonly metThisMonth: number;
    readonly followUpsOverdue: number; readonly followUpsDueToday: number; readonly followUpsOpen: number;
  };
  readonly followUps: readonly GrowthFollowUpDto[];
  readonly activities: readonly GrowthActivityDto[];
  readonly vocabulary: GrowthFieldVocabularyDto;
}

export interface GrowthLeadFieldDto {
  readonly leadId: string;
  readonly canLog: boolean;
  readonly activities: readonly GrowthActivityDto[];
  readonly followUps: readonly GrowthFollowUpDto[];
  readonly vocabulary: GrowthFieldVocabularyDto;
}

export interface NewGrowthActivityBody {
  readonly kind: GrowthActivityKindDto;
  readonly outcome?: string | null;
  readonly contactId?: string | null;
  readonly notes?: string | null;
  readonly occurredAt: string;
}

export function getGrowthField(token: string, view: 'MINE' | 'TEAM', signal?: AbortSignal): Promise<GrowthFieldDto> {
  return requestJson(`/api/v1/growth/field?view=${view}`, { token, ...(signal ? { signal } : {}) });
}

export function getGrowthLeadField(token: string, leadId: string, signal?: AbortSignal): Promise<GrowthLeadFieldDto> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/field`, { token, ...(signal ? { signal } : {}) });
}

export function logGrowthActivity(token: string, leadId: string, body: NewGrowthActivityBody, idempotencyKey: string): Promise<{ readonly activity: GrowthActivityDto; readonly idempotentReplay: boolean }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/activities`, { token, method: 'POST', body, idempotencyKey });
}

export function addGrowthFollowUp(token: string, leadId: string, body: { readonly title: string; readonly dueOn: string; readonly activityId?: string | null }, idempotencyKey: string): Promise<{ readonly followUp: GrowthFollowUpDto }> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/follow-ups`, { token, method: 'POST', body, idempotencyKey });
}

export function completeGrowthFollowUp(token: string, followUpId: string, idempotencyKey: string): Promise<{ readonly followUp: GrowthFollowUpDto }> {
  return requestJson(`/api/v1/growth/follow-ups/${encodeURIComponent(followUpId)}/complete`, { token, method: 'POST', body: {}, idempotencyKey });
}

export function cancelGrowthFollowUp(token: string, followUpId: string, body: { readonly reasonCode: string }, idempotencyKey: string): Promise<{ readonly followUp: GrowthFollowUpDto }> {
  return requestJson(`/api/v1/growth/follow-ups/${encodeURIComponent(followUpId)}/cancel`, { token, method: 'POST', body, idempotencyKey });
}

export function removeGrowthActivityLocation(token: string, activityId: string): Promise<{ readonly activity: GrowthActivityDto }> {
  return requestJson(`/api/v1/growth/activities/${encodeURIComponent(activityId)}/remove-location`, { token, method: 'POST', body: {} });
}

// ---------------------------------------------------------------------------
// GROWTH-04: the college pipeline and the operations handoff. Stage moves carry the stage the
// person saw, so a move made against a stage that has since changed is refused, not applied.
// ---------------------------------------------------------------------------

export interface GrowthMilestoneDto {
  readonly code: string;
  readonly state: 'REACHED' | 'NOT_REACHED' | 'NA';
  readonly at: string | null;
  readonly note?: string;
  /** STUDENTS_ACTIVATING only: a suppressed count (fewer than 5 is never a number). */
  readonly count?: { readonly suppressed: boolean; readonly value: number | null };
  /** GROWTH-05, employer leads: FIRST_JOB_PUBLISHED carries PUBLISHED_NOW; CAMPUS_DRIVE a count per drive state. Counts of records, never people. */
  readonly counts?: Readonly<Record<string, number>>;
}

/** GROWTH-05: an access request linked to an employer lead — its time, state and whose referral, nothing the requester typed. */
export interface GrowthLeadAccessRequestDto {
  readonly receivedAt: string | null;
  readonly state: 'PENDING' | 'ONBOARDED' | 'DECLINED' | 'SPAM';
  readonly referral: 'YOU' | 'ANOTHER_TEAM_MEMBER' | null;
}

export interface GrowthHandoffRequestDto {
  readonly id: string;
  readonly state: 'REQUESTED' | 'LINKED' | 'DECLINED';
  readonly requestedAt: string | null;
  readonly requestedBy: string | null;
  readonly contractReferenceReported: string;
  readonly contactsMarked: number;
  readonly decidedAt: string | null;
  readonly declineReasonCode: string | null;
  readonly contactsCarried: number | null;
  readonly contactsErased: number | null;
}

export interface GrowthLeadPipelineDto {
  readonly leadId: string;
  readonly kind: GrowthLeadKindDto;
  readonly stage: string;
  readonly lostReasonCode: string | null;
  readonly canMove: boolean;
  readonly nextStages: readonly string[];
  readonly canRequestHandoff: boolean;
  readonly handoffRequests: readonly GrowthHandoffRequestDto[];
  readonly milestones: readonly GrowthMilestoneDto[] | null;
  /** GROWTH-05: employer leads only (empty for colleges); absent from an older server. */
  readonly accessRequests?: readonly GrowthLeadAccessRequestDto[];
  readonly vocabulary: {
    readonly reasons: { readonly backward: readonly string[]; readonly hold: readonly string[]; readonly lost: readonly string[] };
    readonly declineReasons: readonly string[];
    readonly milestones: readonly string[];
  };
}

export function getGrowthLeadPipeline(token: string, leadId: string, signal?: AbortSignal): Promise<GrowthLeadPipelineDto> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/pipeline`, { token, ...(signal ? { signal } : {}) });
}

export function moveGrowthLeadStage(token: string, leadId: string, body: { readonly fromStage: string; readonly toStage: string; readonly reasonCode?: string }, idempotencyKey: string): Promise<GrowthLeadPipelineDto> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/stage`, { token, method: 'POST', body, idempotencyKey });
}

export function requestGrowthHandoff(token: string, leadId: string, body: { readonly contractReference: string; readonly contactIds: readonly string[] }, idempotencyKey: string): Promise<GrowthLeadPipelineDto> {
  return requestJson(`${leadsPath}/${encodeURIComponent(leadId)}/handoff`, { token, method: 'POST', body, idempotencyKey });
}

export interface GrowthHandoffQueueItemDto extends GrowthHandoffRequestDto {
  readonly leadId: string;
  readonly leadName: string;
  readonly owner: string | null;
  readonly area: { readonly city: string | null; readonly stateName: string | null; readonly districtName: string | null };
  readonly aisheCode: string | null;
  readonly contacts: readonly { readonly id: string; readonly role: string; readonly accountRole: string; readonly fullName: string; readonly email: string | null; readonly phone: string | null }[];
}

const handoffsPath = '/api/v1/operations/growth-handoffs';

export function listGrowthHandoffs(token: string, signal?: AbortSignal): Promise<{ readonly requests: readonly GrowthHandoffQueueItemDto[]; readonly declineReasons: readonly string[] }> {
  return requestJson(handoffsPath, { token, ...(signal ? { signal } : {}) });
}

export function linkGrowthHandoff(token: string, leadId: string, body: { readonly organizationId: string }): Promise<{ readonly linked: { readonly contactsCarried: number; readonly contactsErased: number; readonly contactsOverLimit: number } }> {
  return requestJson(`${handoffsPath}/${encodeURIComponent(leadId)}/link`, { token, method: 'POST', body });
}

export function declineGrowthHandoff(token: string, leadId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${handoffsPath}/${encodeURIComponent(leadId)}/decline`, { token, method: 'POST', body });
}

// ---------------------------------------------------------------------------
// GROWTH-05: employer referral links. The link is the public access-request form's path and the
// code; it carries nothing about the person. Creating and revoking need the server.
// ---------------------------------------------------------------------------

export interface GrowthReferralCodeDto {
  readonly id: string;
  readonly code: string;
  readonly linkPath: string;
  readonly createdAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReasonCode: string | null;
  readonly referrals: { readonly pending: number; readonly onboarded: number; readonly closed: number };
}

export interface GrowthReferralCodesDto {
  readonly eligible: boolean;
  readonly codes: readonly GrowthReferralCodeDto[];
  readonly limits: { readonly liveCodesPerPerson: number; readonly createdPerDay: number; readonly referralsPerCodePerDay: number };
}

const referralPath = '/api/v1/growth/referral-codes';

export function listGrowthReferralCodes(token: string, signal?: AbortSignal): Promise<GrowthReferralCodesDto> {
  return requestJson(referralPath, { token, ...(signal ? { signal } : {}) });
}

export function createGrowthReferralCode(token: string, idempotencyKey: string): Promise<{ readonly code: GrowthReferralCodeDto | null; readonly codes: readonly GrowthReferralCodeDto[] }> {
  return requestJson(referralPath, { token, method: 'POST', body: {}, idempotencyKey });
}

export function revokeGrowthReferralCode(token: string, codeId: string): Promise<{ readonly codes: readonly GrowthReferralCodeDto[] }> {
  return requestJson(`${referralPath}/${encodeURIComponent(codeId)}/revoke`, { token, method: 'POST', body: {} });
}

/** Operations: open employer leads for linking an access request to one (OPS_ORG_MANAGE). */
export interface GrowthEmployerLeadOptionDto {
  readonly leadId: string;
  readonly name: string;
  readonly websiteDomain: string | null;
  readonly stage: string;
  readonly ownerEmail: string | null;
}

export function searchGrowthEmployerLeads(token: string, query: string, signal?: AbortSignal): Promise<{ readonly leads: readonly GrowthEmployerLeadOptionDto[] }> {
  return requestJson(`/api/v1/operations/growth-employer-leads?q=${encodeURIComponent(query)}`, { token, ...(signal ? { signal } : {}) });
}

export function setEmployerAccessRequestGrowthLead(token: string, requestId: string, leadId: string | null): Promise<{ readonly linked: { readonly requestId: string; readonly leadId: string | null } }> {
  return requestJson(`/api/v1/operations/employer-access-requests/${encodeURIComponent(requestId)}/growth-lead`, { token, method: 'POST', body: { leadId } });
}

// ---------------------------------------------------------------------------
// GROWTH-07: attribution — who is credited, disputes, reassignment (design §8). No amount anywhere.
// ---------------------------------------------------------------------------

export type GrowthOrganizationKindDto = 'INSTITUTION' | 'EMPLOYER';

export interface GrowthCreditDto {
  readonly attributionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationKind: GrowthOrganizationKindDto;
  readonly basis: string;
  readonly since: string | null;
  readonly endedAt: string | null;
  readonly endedReasonCode: string | null;
  readonly disputeOpen: boolean;
  /** Never an amount: commission is not built for colleges yet, and employer commission is on hold (D11). */
  readonly commission: 'NOT_BUILT' | 'EMPLOYER_ON_HOLD';
}

export interface GrowthMyDisputeDto {
  readonly disputeId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationKind: GrowthOrganizationKindDto;
  readonly origin: 'CLAIM' | 'ONBOARDING_CONFLICT';
  readonly state: 'OPEN' | 'UPHELD' | 'REJECTED';
  readonly role: 'CLAIMANT' | 'RESPONDENT' | null;
  readonly openedAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionReasonCode: string | null;
  /** The claimant's own statement; always null for the respondent. */
  readonly statement: string | null;
}

export interface GrowthDisputableDto {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationKind: GrowthOrganizationKindDto;
  readonly handedOffAt: string | null;
  readonly windowEndsAt: string | null;
  readonly disputeOpen: boolean;
}

export interface GrowthAttributionsDto {
  readonly credited: readonly GrowthCreditDto[];
  readonly disputes: readonly GrowthMyDisputeDto[];
  readonly disputable: readonly GrowthDisputableDto[];
  readonly windowDays: number;
}

export function getGrowthAttributions(token: string, signal?: AbortSignal): Promise<GrowthAttributionsDto> {
  return requestJson('/api/v1/growth/attributions', { token, ...(signal ? { signal } : {}) });
}

export function openGrowthAttributionDispute(token: string, body: { readonly organizationId: string; readonly statement: string }): Promise<GrowthAttributionsDto & { readonly disputeId: string }> {
  return requestJson('/api/v1/growth/attribution-disputes', { token, method: 'POST', body });
}

export interface GrowthAdminAttributionDto {
  readonly attributionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationKind: GrowthOrganizationKindDto;
  readonly beneficiary: { readonly userId: string; readonly email: string; readonly active: boolean };
  readonly leaver: { readonly leftAt: string | null; readonly settlementEndsAt: string | null } | null;
  readonly basis: string;
  readonly reasonCode: string;
  readonly lead: { readonly leadId: string; readonly name: string | null } | null;
  readonly since: string | null;
  readonly endedAt: string | null;
  readonly endedReasonCode: string | null;
  readonly endedBy: string | null;
  readonly createdBy: string;
  readonly disputeOpen: boolean;
}

export interface GrowthAdminDisputeDto {
  readonly disputeId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationKind: GrowthOrganizationKindDto;
  readonly origin: 'CLAIM' | 'ONBOARDING_CONFLICT';
  readonly currentBasis: string | null;
  readonly claimant: { readonly userId: string; readonly email: string };
  readonly respondent: { readonly userId: string; readonly email: string | null } | null;
  readonly statement: string | null;
  readonly openedAt: string | null;
  readonly openedBy: string;
  readonly state: 'OPEN' | 'UPHELD' | 'REJECTED';
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionReasonCode: string | null;
  readonly decisionNote: string | null;
  readonly evidence: { readonly handedOffAt: string | null; readonly onboardingCandidate: string | null; readonly leadName: string | null };
}

export interface GrowthAdminAttributionsDto {
  readonly attributions: readonly GrowthAdminAttributionDto[];
  readonly counts: { readonly live: number; readonly beneficiaryLeft: number; readonly ended: number; readonly openDisputes: number };
  readonly vocabulary: { readonly reassignReasons: readonly string[]; readonly endReasons: readonly string[]; readonly decisionReasons: readonly string[]; readonly outcomes: readonly string[] };
}

const attributionAdminPath = '/api/v1/operations/growth-attribution';

export function listGrowthAdminAttributions(token: string, query: { readonly view: 'LIVE' | 'LEFT' | 'ENDED'; readonly q?: string }, signal?: AbortSignal): Promise<GrowthAdminAttributionsDto> {
  const params = new URLSearchParams({ view: query.view, ...(query.q ? { q: query.q } : {}) });
  return requestJson(`${attributionAdminPath}?${params.toString()}`, { token, ...(signal ? { signal } : {}) });
}

export function listGrowthAdminDisputes(token: string, state: 'OPEN' | 'DECIDED', signal?: AbortSignal): Promise<{ readonly disputes: readonly GrowthAdminDisputeDto[] }> {
  return requestJson(`${attributionAdminPath}/disputes?state=${state}`, { token, ...(signal ? { signal } : {}) });
}

export function getGrowthAttributionReassignOptions(token: string, kind: GrowthOrganizationKindDto): Promise<{ readonly options: readonly { readonly userId: string; readonly email: string }[] }> {
  return requestJson(`${attributionAdminPath}/reassign-options?kind=${kind}`, { token });
}

export function decideGrowthAttributionDispute(token: string, disputeId: string, body: { readonly outcome: string; readonly reasonCode: string; readonly note?: string }): Promise<unknown> {
  return requestJson(`${attributionAdminPath}/disputes/${encodeURIComponent(disputeId)}/decide`, { token, method: 'POST', body });
}

export function reassignGrowthAttribution(token: string, attributionId: string, body: { readonly toUserId: string; readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${attributionAdminPath}/${encodeURIComponent(attributionId)}/reassign`, { token, method: 'POST', body });
}

export function endGrowthAttribution(token: string, attributionId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${attributionAdminPath}/${encodeURIComponent(attributionId)}/end`, { token, method: 'POST', body });
}
