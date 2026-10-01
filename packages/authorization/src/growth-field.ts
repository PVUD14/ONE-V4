/**
 * Field work rules (GROWTH-06; design §14): visits, calls, meetings and notes, follow-ups, the
 * optional visit location, and the clock rules for reports that may arrive late from a phone.
 *
 * Why this exists: the API, the web Field page and the phone must agree on the same vocabulary
 * and the same decisions — who may log work on a lead, who may see where a visit was logged, when
 * a device-reported time is too old or in the future, and how a location is rounded — and the
 * database CHECKs repeat the vocabulary. Pure functions, no I/O.
 *
 * Design: docs/architecture/growth-field-work-table-design.md
 */
import { canSeeGrowthLead, refuseGrowthLeadReassign, type GrowthLeadCaller, type GrowthLeadFacts } from './growth-leads.js';

export const growthActivityKinds = ['VISIT', 'CALL', 'MEETING', 'NOTE'] as const;
export type GrowthActivityKind = (typeof growthActivityKinds)[number];

export const growthActivityOutcomes = ['MET', 'NOT_AVAILABLE', 'RESCHEDULED', 'DECLINED', 'INTERESTED'] as const;
export type GrowthActivityOutcome = (typeof growthActivityOutcomes)[number];

/** The in-person kinds, the only ones a location may be attached to. */
export const growthLocatableActivityKinds: readonly GrowthActivityKind[] = ['VISIT', 'MEETING'];

export const growthFollowUpCancelReasons = ['NO_LONGER_NEEDED', 'LEAD_LOST', 'DUPLICATE', 'REASSIGNED', 'OTHER'] as const;
export const growthLocationErasedReasons = ['RETENTION_EXPIRED', 'AUTHOR_REMOVED', 'ACCOUNT_ERASED'] as const;

export const GROWTH_ACTIVITY_NOTES_MAX = 2000;
export const GROWTH_FOLLOW_UP_TITLE_MAX = 280;
/** Design §14.2: a report more than this many days old is refused. */
export const GROWTH_REPORT_MAX_AGE_DAYS = 7;
/** Phone-clock skew tolerated before a report counts as "in the future" (table design §2). */
export const GROWTH_REPORT_CLOCK_SKEW_MS = 5 * 60_000;
/** O-23: a visit location is erased this many days after the visit was received. */
export const GROWTH_LOCATION_RETENTION_DAYS = 180;
/** Design §14.3: about 100 m. */
export const GROWTH_LOCATION_DECIMALS = 3;
export const GROWTH_LOCATION_ACCURACY_MAX_M = 50_000;
/** A follow-up is due no earlier than this many days back (an offline one) and no later than a year ahead. */
export const GROWTH_FOLLOW_UP_DUE_PAST_DAYS = 7;
export const GROWTH_FOLLOW_UP_DUE_FUTURE_DAYS = 366;
export const GROWTH_FIELD_LIST_LIMIT = 100;

/** The location notice version shown before the first location request, until legal review publishes one (HG-6). */
export const GROWTH_LOCATION_NOTICE_VERSION = 'draft-2026-10';

/**
 * The field-staff location notice (design §14.3). DRAFT for legal review: the same words are in
 * docs/legal/growth-field-location-notice-DRAFT-for-legal-review.md, and publishing them is HG-6.
 */
export const GROWTH_LOCATION_NOTICE_TEXT = [
  'Attaching your location to a visit is optional. A visit without a location is a complete visit.',
  'ONE reads your phone\'s approximate location only at the moment you tap "Attach my location", and never in the background.',
  'It is stored rounded to about 100 metres, with the accuracy your phone reported, beside that one visit.',
  'Only you and your manager can see it. It shows that the visit was logged at or near the organisation\'s area.',
  'It is never used for attendance, pay, performance ratings or discipline.',
  'It is erased automatically 180 days after the visit was logged. You can remove it from any of your visits sooner, and it is included when you ask for a copy of your data.',
] as const;

export function isGrowthActivityKind(value: unknown): value is GrowthActivityKind {
  return typeof value === 'string' && (growthActivityKinds as readonly string[]).includes(value);
}

export function isGrowthActivityOutcome(value: unknown): value is GrowthActivityOutcome {
  return typeof value === 'string' && (growthActivityOutcomes as readonly string[]).includes(value);
}

/** A note is the only kind without an outcome; every other kind must say how it went. */
export function growthActivityNeedsOutcome(kind: GrowthActivityKind): boolean {
  return kind !== 'NOTE';
}

export function growthActivityAllowsLocation(kind: GrowthActivityKind): boolean {
  return growthLocatableActivityKinds.includes(kind);
}

export type GrowthReportTimeRefusal = 'GROWTH_REPORT_TOO_OLD' | 'GROWTH_REPORT_IN_FUTURE';

/**
 * Design §14.2: `occurredAt` is stored as the device reported it, but a report more than 7 days old
 * or in the future (beyond a few minutes of clock skew) is refused. `now` is the server's clock; the
 * database trigger repeats the rule on its own clock.
 */
export function refuseGrowthReportTime(occurredAt: Date, now: Date): GrowthReportTimeRefusal | null {
  if (occurredAt.getTime() > now.getTime() + GROWTH_REPORT_CLOCK_SKEW_MS) return 'GROWTH_REPORT_IN_FUTURE';
  if (occurredAt.getTime() < now.getTime() - GROWTH_REPORT_MAX_AGE_DAYS * 86_400_000) return 'GROWTH_REPORT_TOO_OLD';
  return null;
}

/** Rounds a coordinate to 3 decimal places (about 110 m), half away from zero like Postgres numeric. */
export function roundGrowthCoordinate(value: number): number {
  const factor = 10 ** GROWTH_LOCATION_DECIMALS;
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export interface GrowthLocationInput { readonly latitude: number; readonly longitude: number; readonly accuracyM: number }

/** A location as the phone reported it, rounded; null when it is not a plausible one. */
export function readGrowthLocation(value: unknown): GrowthLocationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['latitude', 'longitude', 'accuracyM'].includes(key))) return null;
  const { latitude, longitude, accuracyM } = raw;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || typeof accuracyM !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracyM)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracyM < 0 || accuracyM > GROWTH_LOCATION_ACCURACY_MAX_M) return null;
  return { latitude: roundGrowthCoordinate(latitude), longitude: roundGrowthCoordinate(longitude), accuracyM: Math.round(accuracyM) };
}

/** The IST calendar date (YYYY-MM-DD) of an instant: India has one time zone and no daylight saving. */
export function istDate(instant: Date): string {
  return new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export type GrowthDueDateRefusal = 'GROWTH_FOLLOW_UP_DUE_INVALID' | 'GROWTH_FOLLOW_UP_DUE_TOO_EARLY' | 'GROWTH_FOLLOW_UP_DUE_TOO_LATE';

/** A follow-up's due date: a real calendar date, from 7 days back to 366 days ahead of today in IST. */
export function refuseGrowthFollowUpDue(dueOn: unknown, now: Date): GrowthDueDateRefusal | null {
  if (typeof dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return 'GROWTH_FOLLOW_UP_DUE_INVALID';
  const parsed = new Date(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueOn) return 'GROWTH_FOLLOW_UP_DUE_INVALID';
  const today = new Date(`${istDate(now)}T00:00:00Z`).getTime();
  const days = Math.round((parsed.getTime() - today) / 86_400_000);
  if (days < -GROWTH_FOLLOW_UP_DUE_PAST_DAYS) return 'GROWTH_FOLLOW_UP_DUE_TOO_EARLY';
  if (days > GROWTH_FOLLOW_UP_DUE_FUTURE_DAYS) return 'GROWTH_FOLLOW_UP_DUE_TOO_LATE';
  return null;
}

export type GrowthFieldRefusal =
  | 'GROWTH_LEAD_NOT_FOUND'
  | 'GROWTH_LEAD_DO_NOT_CONTACT'
  | 'GROWTH_LEAD_CLOSED'
  | 'GROWTH_NOT_LEAD_OWNER'
  | 'GROWTH_NOT_FOLLOW_UP_ASSIGNEE'
  | 'GROWTH_NOT_ACTIVITY_AUTHOR';

const owns = (caller: GrowthLeadCaller, lead: GrowthLeadFacts): boolean =>
  lead.ownerMembershipId !== null && caller.memberships.some((membership) => membership.membershipId === lead.ownerMembershipId);

/**
 * Log an activity or add a follow-up (table design §4): the lead's owner, or a manager who could
 * reassign it; only on an open lead that is not do-not-contact. An executive claims first.
 */
export function refuseGrowthFieldWrite(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthFieldRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  if (lead.doNotContact) return 'GROWTH_LEAD_DO_NOT_CONTACT';
  if (!lead.open) return 'GROWTH_LEAD_CLOSED';
  if (owns(caller, lead)) return null;
  return refuseGrowthLeadReassign(caller, lead) === null ? null : 'GROWTH_NOT_LEAD_OWNER';
}

/** The membership a field write is recorded through: the one owning the lead, else the caller's manager membership. */
export function growthFieldAuthorMembership(caller: GrowthLeadCaller, lead: GrowthLeadFacts): string | null {
  const owning = caller.memberships.find((membership) => membership.membershipId === lead.ownerMembershipId);
  if (owning) return owning.membershipId;
  return (caller.memberships.find((membership) => membership.role === 'GROWTH_MANAGER') ?? caller.memberships[0])?.membershipId ?? null;
}

/** Whether the caller holds the membership, or manages it (a GROWTH_MANAGER whose scope includes it as a report). */
export function isSelfOrManagedGrowthMembership(caller: GrowthLeadCaller, membershipId: string): boolean {
  if (caller.memberships.some((membership) => membership.membershipId === membershipId)) return true;
  if (caller.scope.kind !== 'PERSON') return false;
  return caller.memberships.some((membership) => membership.role === 'GROWTH_MANAGER') && caller.scope.ownerMembershipIds.includes(membershipId);
}

/**
 * O-23 / design §14.3: a visit's location is visible to the person who logged it and to their
 * manager only — not to another executive who can see the lead, not to a growth admin.
 */
export function seesGrowthActivityLocation(caller: GrowthLeadCaller, authorMembershipId: string): boolean {
  return isSelfOrManagedGrowthMembership(caller, authorMembershipId);
}

/** Done or cancelled by the assignee, or by the assignee's manager. */
export function refuseGrowthFollowUpClose(caller: GrowthLeadCaller, assigneeMembershipId: string): GrowthFieldRefusal | null {
  return isSelfOrManagedGrowthMembership(caller, assigneeMembershipId) ? null : 'GROWTH_NOT_FOLLOW_UP_ASSIGNEE';
}

/** Only the author removes a location: it is their data. */
export function refuseGrowthLocationRemoval(caller: GrowthLeadCaller, authorMembershipId: string): GrowthFieldRefusal | null {
  return caller.memberships.some((membership) => membership.membershipId === authorMembershipId) ? null : 'GROWTH_NOT_ACTIVITY_AUTHOR';
}
