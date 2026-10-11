/**
 * Lead register rules (GROWTH-03; design §5 and §13).
 *
 * The vocabulary the database CHECKs repeat, and the pure decisions the API and both clients
 * share: who may claim, reassign, add a contact or see it unmasked; how a website or AISHE code
 * is normalised before the duplicate check; how much of a duplicate is disclosed; when a lead is
 * stale; and when its contacts' retention has run out. The scope itself is `growth-scope.ts`.
 *
 * Design: docs/architecture/growth-leads-table-design.md
 */
import { isVisibleInGrowthScope, type GrowthScope } from './growth-scope.js';

export const growthLeadKinds = ['COLLEGE', 'EMPLOYER'] as const;
export type GrowthLeadKind = (typeof growthLeadKinds)[number];

export const growthLeadStages: Readonly<Record<GrowthLeadKind, readonly string[]>> = {
  COLLEGE: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'PROPOSAL_SHARED', 'NEGOTIATION', 'AGREEMENT_SIGNED_REPORTED', 'HANDOFF_REQUESTED', 'ON_HOLD', 'LOST'],
  EMPLOYER: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'INTERESTED', 'ACCESS_REQUEST_INVITED', 'ON_HOLD', 'LOST'],
};

export const growthLeadSources = ['FIELD_VISIT', 'REFERRAL_LINK', 'INBOUND_ACCESS_REQUEST', 'EVENT', 'PUBLIC_DIRECTORY', 'INTRODUCTION', 'OTHER'] as const;
export const growthContactRoles = ['PRINCIPAL', 'DIRECTOR', 'CHAIRMAN_OR_TRUSTEE', 'PLACEMENT_OFFICER', 'HR', 'TALENT_ACQUISITION', 'FOUNDER', 'OTHER'] as const;

/** Design §13.2 (O-21 interim rule): the only bases, and the sources each allows. */
export const growthContactSourcesByBasis = {
  PROVIDED_BY_PERSON: ['BUSINESS_CARD', 'MEETING', 'EMAIL_FROM_PERSON', 'ACCESS_REQUEST_FORM'],
  PUBLIC_INSTITUTIONAL_LISTING: ['OFFICIAL_WEBSITE'],
  INTRODUCED_BY_COLLEAGUE: ['COLLEAGUE_INTRODUCTION'],
} as const;
export type GrowthContactBasis = keyof typeof growthContactSourcesByBasis;
export const growthContactBases = Object.keys(growthContactSourcesByBasis) as GrowthContactBasis[];

/** The notice version recorded on a contact until legal review publishes one (HG-6). */
export const GROWTH_CONTACT_NOTICE_VERSION = 'draft-2026-10';

/**
 * The contact notice a growth person gives or sends at first contact (design §13.3). DRAFT for
 * legal review: the same words are in docs/legal/growth-lead-contact-notice-DRAFT-for-legal-review.md,
 * and publishing them is hard gate HG-6. The screens show the DRAFT label with it.
 */
export const GROWTH_CONTACT_NOTICE_TEXT = [
  'AI8HT runs ONE, a platform that helps colleges prepare their students for work and helps employers hire them.',
  'We hold your name and your work contact details only to contact you about your organisation partnering with ONE.',
  'We got them from you, from your organisation\'s official listing, or from a colleague at your organisation who passed them on for this purpose.',
  'We do not use them for marketing campaigns, do not share them outside AI8HT and do not buy or combine them with other data.',
  'We keep them while we are in touch with your organisation and erase them 24 months after our last contact, or sooner if you ask.',
  'To see what we hold, have it corrected or erased, or ask us not to contact you again, write to the privacy contact named in this notice.',
] as const;

/** The one purpose stated on every contact form and in the notice (design §13.1). */
export const GROWTH_CONTACT_PURPOSE = 'To contact this person about their organisation partnering with AI8HT\'s ONE platform.';

export const growthLeadReasons = {
  reassign: ['TERRITORY_CHANGE', 'WORKLOAD', 'INACTIVITY', 'CORRECTION'],
  adminReassign: ['TERRITORY_CHANGE', 'WORKLOAD', 'INACTIVITY', 'DISPUTE_DECISION', 'CORRECTION'],
  removeContact: ['OWNER_REMOVED', 'WRONG_DETAILS', 'LEFT_ORGANISATION'],
  adminRemoveContact: ['WRONG_DETAILS', 'LEFT_ORGANISATION', 'PRIVACY_REQUEST'],
  revealContact: ['MANAGER_REVIEW', 'REASSIGNMENT_HANDOVER', 'DATA_CORRECTION'],
  doNotContact: ['ORGANISATION_DECLINED', 'PERSON_REQUEST', 'PRIVACY_REQUEST', 'LEGAL'],
} as const;

/** Design §5.2: at most this many live contacts per lead (code, not CHECK, as OPS-14). */
export const GROWTH_LEAD_CONTACT_LIMIT = 10;
/** O-10: a lead with no activity for this many days is stale to its owner and manager. */
export const GROWTH_LEAD_STALE_DAYS = 90;
/** D12: contacts of a lead with no activity for this many months are erased by the daily sweep. */
export const GROWTH_CONTACT_RETENTION_MONTHS = 24;

export function isGrowthLeadKind(value: unknown): value is GrowthLeadKind {
  return typeof value === 'string' && (growthLeadKinds as readonly string[]).includes(value);
}

export function isGrowthContactBasis(value: unknown): value is GrowthContactBasis {
  return typeof value === 'string' && (growthContactBases as readonly string[]).includes(value);
}

export function isGrowthContactSourceFor(basis: GrowthContactBasis, source: unknown): boolean {
  return typeof source === 'string' && (growthContactSourcesByBasis[basis] as readonly string[]).includes(source);
}

/** The team whose members may own a lead of this kind. */
export function growthTeamForLeadKind(kind: GrowthLeadKind): 'COLLEGE_PARTNERSHIPS' | 'EMPLOYER_PARTNERSHIPS' {
  return kind === 'COLLEGE' ? 'COLLEGE_PARTNERSHIPS' : 'EMPLOYER_PARTNERSHIPS';
}

/** `C-12345`, `U-0123`, `S-9`: the AISHE institution code, upper-cased; null when it is not one. */
export function normaliseAisheCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/\s+/g, '');
  return /^(C|U|S)-[0-9]{1,8}$/.test(code) ? code : null;
}

/**
 * A website or address reduced to its lower-case host, without scheme, `www.`, port, path or
 * query; null when no plausible host remains. `https://www.Acme.co.in/careers` → `acme.co.in`.
 */
export function normaliseWebsiteDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '').replace(/^[^@/]*@/, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  if (host.length > 253) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host) ? host : null;
}

/** The normalised name used for the possible-duplicate flag (letters and digits, lower case). */
export function normaliseLeadName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface GrowthLeadFacts {
  readonly kind: GrowthLeadKind;
  readonly ownerMembershipId: string | null;
  readonly regionIds: readonly string[];
  readonly doNotContact: boolean;
  readonly open: boolean;
}

export interface GrowthLeadCaller {
  readonly scope: GrowthScope;
  /** The caller's ACTIVE growth memberships with the teams each is on today. */
  readonly memberships: readonly { readonly membershipId: string; readonly role: string; readonly teams: readonly string[] }[];
}

const owns = (caller: GrowthLeadCaller, lead: GrowthLeadFacts): boolean =>
  lead.ownerMembershipId !== null && caller.memberships.some((membership) => membership.membershipId === lead.ownerMembershipId);

/** The membership through which the caller may own a lead of this kind (a live matching team row), or null. */
export function growthOwningMembership(caller: GrowthLeadCaller, kind: GrowthLeadKind): string | null {
  const team = growthTeamForLeadKind(kind);
  const eligible = caller.memberships.filter((membership) => membership.teams.includes(team));
  // A person holding both roles owns as the executive, the field role.
  return (eligible.find((membership) => membership.role === 'GROWTH_EXECUTIVE') ?? eligible[0])?.membershipId ?? null;
}

export function canSeeGrowthLead(caller: GrowthLeadCaller, lead: GrowthLeadFacts): boolean {
  return isVisibleInGrowthScope(caller.scope, { ownerMembershipId: lead.ownerMembershipId, regionIds: lead.regionIds });
}

/** O-9: the owner sees their own leads' contacts in full; everyone else sees them masked. */
export function seesGrowthContactsInFull(caller: GrowthLeadCaller, lead: GrowthLeadFacts): boolean {
  return owns(caller, lead);
}

export type GrowthLeadRefusal =
  | 'GROWTH_LEAD_NOT_FOUND'
  | 'GROWTH_LEAD_ALREADY_OWNED'
  | 'GROWTH_LEAD_DO_NOT_CONTACT'
  | 'GROWTH_LEAD_CLOSED'
  | 'GROWTH_TEAM_MISMATCH'
  | 'GROWTH_NOT_LEAD_OWNER'
  | 'GROWTH_NOT_REGION_MANAGER';

/** Claim: an unowned, open, contactable lead in the caller's scope, by someone on the matching team. */
export function refuseGrowthLeadClaim(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthLeadRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  if (lead.ownerMembershipId !== null) return 'GROWTH_LEAD_ALREADY_OWNED';
  if (lead.doNotContact) return 'GROWTH_LEAD_DO_NOT_CONTACT';
  if (!lead.open) return 'GROWTH_LEAD_CLOSED';
  if (!growthOwningMembership(caller, lead.kind)) return 'GROWTH_TEAM_MISMATCH';
  return null;
}

/**
 * Reassign (design §5.4): a manager, for a lead in a region they manage or owned by one of their
 * reports. (A growth admin reassigns anywhere from Operations; that route does not use this.)
 */
export function refuseGrowthLeadReassign(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthLeadRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  if (lead.doNotContact) return 'GROWTH_LEAD_DO_NOT_CONTACT';
  if (!lead.open) return 'GROWTH_LEAD_CLOSED';
  if (caller.scope.kind !== 'PERSON') return 'GROWTH_NOT_REGION_MANAGER';
  const managesRegion = lead.regionIds.some((region) => caller.scope.kind === 'PERSON' && caller.scope.allLeadRegionIds.includes(region));
  const managesOwner = lead.ownerMembershipId !== null && !owns(caller, lead) && caller.scope.ownerMembershipIds.includes(lead.ownerMembershipId)
    && caller.memberships.some((membership) => membership.role === 'GROWTH_MANAGER');
  return managesRegion || managesOwner ? null : 'GROWTH_NOT_REGION_MANAGER';
}

/** Adding a contact or recording a notice is the owner's work, on a contactable lead. */
export function refuseGrowthContactWrite(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthLeadRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  if (!owns(caller, lead)) return 'GROWTH_NOT_LEAD_OWNER';
  if (lead.doNotContact) return 'GROWTH_LEAD_DO_NOT_CONTACT';
  return null;
}

/** Removing a contact or setting do-not-contact: the owner, or a manager of the lead's region or owner. */
export function refuseGrowthLeadPrivacyWrite(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthLeadRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  if (owns(caller, lead)) return null;
  return refuseGrowthLeadReassign(caller, { ...lead, doNotContact: false, open: true }) === null ? null : 'GROWTH_NOT_LEAD_OWNER';
}

/** Reveal is for someone who can see the lead but is not its owner (the owner already sees it). */
export function refuseGrowthContactReveal(caller: GrowthLeadCaller, lead: GrowthLeadFacts): GrowthLeadRefusal | null {
  if (!canSeeGrowthLead(caller, lead)) return 'GROWTH_LEAD_NOT_FOUND';
  return null;
}

/**
 * Design §5.3: a duplicate names the existing lead's owner only to someone whose scope includes
 * that lead; anyone else learns only that it exists, so the check cannot browse pipelines.
 */
export function growthDuplicateDisclosure(scope: GrowthScope, existing: { readonly ownerMembershipId: string | null; readonly regionIds: readonly string[] }): 'NAMED' | 'ANONYMOUS' {
  return isVisibleInGrowthScope(scope, existing) ? 'NAMED' : 'ANONYMOUS';
}

export function isGrowthLeadStale(lastActivityAt: Date, now: Date): boolean {
  return now.getTime() - lastActivityAt.getTime() > GROWTH_LEAD_STALE_DAYS * 86_400_000;
}
