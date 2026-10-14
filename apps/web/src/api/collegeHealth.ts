/**
 * ONE · API client — Operations college health (Analytics) and college account fields
 * (Organization Detail), OPS-14.
 *
 * Every count of people arrives already suppressed by the server: below 5 it carries no
 * value. Contacts arrive masked; the full value comes only from `revealCollegeContact`,
 * which the server audits with the reason given. Its own file keeps the parallel OPS goals
 * out of each other's way; api.ts re-exports it.
 */
import { requestJson } from './http.js';

/** A count of people: below 5 it is suppressed and carries no value. */
export type CollegePeopleCountDto =
  | { readonly suppressed: true; readonly value: null }
  | { readonly suppressed: false; readonly value: number };

/** A population split into two cells; the total is withheld when it would reveal a hidden cell. */
export interface CollegeSplitDto {
  readonly total: CollegePeopleCountDto;
  readonly yes: CollegePeopleCountDto;
  readonly no: CollegePeopleCountDto;
}

export interface CollegeHealthWindowsDto {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly month: string;
  readonly monthStart: string;
  readonly monthEnd: string;
}

export interface CollegeHealthRowDto {
  readonly id: string;
  readonly name: string;
  readonly verificationState: string;
  readonly active: boolean;
  readonly renewalDate: string | null;
  readonly students: CollegeSplitDto;
  readonly weeklyActiveLearners: CollegePeopleCountDto;
  readonly staff: CollegeSplitDto;
  readonly openSupportCases: number;
  readonly overdueSupportCases: number;
}

export interface CollegeHealthListResponseDto {
  readonly health: {
    readonly generatedAt: string;
    readonly windows: CollegeHealthWindowsDto;
    readonly colleges: readonly CollegeHealthRowDto[];
    readonly collegesCapped: boolean;
    readonly totals: { readonly colleges: number; readonly renewingWithin90Days: number; readonly withoutRenewalDate: number; readonly openSupportCases: number };
  };
  readonly correlationId: string;
}

export interface CollegeReadinessBandsDto {
  readonly suppressed: boolean;
  readonly cohortSize: number | null;
  readonly cohortSizeSuppressed: boolean;
  readonly bands: readonly { readonly band: string; readonly count: number | null; readonly suppressed: boolean }[];
}

export interface CollegeHealthDetailResponseDto {
  readonly detail: {
    readonly generatedAt: string;
    readonly windows: CollegeHealthWindowsDto;
    readonly college: CollegeHealthRowDto;
    readonly weeklyActiveTrend: readonly { readonly weekStart: string; readonly learners: CollegePeopleCountDto }[];
    readonly assessments: { readonly attempts: CollegePeopleCountDto; readonly students: CollegePeopleCountDto };
    readonly staffActionsOpened: CollegePeopleCountDto;
    readonly readinessBands: CollegeReadinessBandsDto;
    readonly readinessMovement: { readonly available: false; readonly reason: 'NOT_COMPUTED' };
  };
  readonly correlationId: string;
}

export interface CollegeContactDto {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addedAt: string;
}

export interface CollegeAccountDto {
  readonly institution: { readonly id: string; readonly name: string; readonly verificationState: string; readonly active: boolean };
  readonly account: {
    readonly renewalDate: string | null;
    readonly contractReference: string | null;
    readonly accountOwner: { readonly membershipId: string; readonly email: string; readonly role: string; readonly active: boolean } | null;
    readonly version: number;
    readonly updatedAt: string;
  } | null;
  readonly contacts: readonly CollegeContactDto[];
  readonly contactLimit: number;
}

export interface CollegeAccountPolicyDto {
  readonly contactRoles: readonly string[];
  readonly reasons: { readonly update: readonly string[]; readonly addContact: readonly string[]; readonly removeContact: readonly string[]; readonly reveal: readonly string[] };
  readonly owners: readonly { readonly membershipId: string; readonly email: string; readonly role: string }[];
  readonly correlationId: string;
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
const accountPath = (id: string) => `/api/v1/operations/college-accounts/${encodeURIComponent(id)}`;

export function getCollegeHealthList(token: string, signal?: AbortSignal): Promise<CollegeHealthListResponseDto> {
  return requestJson('/api/v1/operations/analytics/colleges', { token, ...signalOf(signal) });
}

export function getCollegeHealthDetail(token: string, collegeId: string, signal?: AbortSignal): Promise<CollegeHealthDetailResponseDto> {
  return requestJson(`/api/v1/operations/analytics/colleges/${encodeURIComponent(collegeId)}`, { token, ...signalOf(signal) });
}

export function getCollegeAccountPolicy(token: string, signal?: AbortSignal): Promise<CollegeAccountPolicyDto> {
  return requestJson('/api/v1/operations/college-accounts/policy', { token, ...signalOf(signal) });
}

export function getCollegeAccount(token: string, collegeId: string, signal?: AbortSignal): Promise<{ readonly account: CollegeAccountDto; readonly correlationId: string }> {
  return requestJson(accountPath(collegeId), { token, ...signalOf(signal) });
}

export function updateCollegeAccount(token: string, collegeId: string, body: {
  readonly reasonCode: string; readonly note?: string; readonly expectedVersion: number | null;
  readonly renewalDate?: string | null; readonly contractReference?: string | null; readonly accountOwnerMembershipId?: string | null;
}): Promise<{ readonly account: CollegeAccountDto; readonly correlationId: string }> {
  return requestJson(accountPath(collegeId), { token, method: 'PATCH', body });
}

export function addCollegeContact(token: string, collegeId: string, body: {
  readonly reasonCode: string; readonly note?: string; readonly role: string; readonly name: string; readonly email?: string; readonly phone?: string;
}): Promise<{ readonly contactId: string; readonly account: CollegeAccountDto; readonly correlationId: string }> {
  return requestJson(`${accountPath(collegeId)}/contacts`, { token, method: 'POST', body });
}

export function removeCollegeContact(token: string, collegeId: string, contactId: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{ readonly account: CollegeAccountDto; readonly correlationId: string }> {
  return requestJson(`${accountPath(collegeId)}/contacts/${encodeURIComponent(contactId)}/remove`, { token, method: 'POST', body });
}

export function revealCollegeContact(token: string, collegeId: string, contactId: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{ readonly contact: { readonly email: string | null; readonly phone: string | null }; readonly correlationId: string }> {
  return requestJson(`${accountPath(collegeId)}/contacts/${encodeURIComponent(contactId)}/reveal`, { token, method: 'POST', body });
}
