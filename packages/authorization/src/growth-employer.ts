/**
 * Employer pipeline rules (GROWTH-05; design §7, §8.3): referral codes, the referral a public
 * access request may carry, the domain match between a request and an employer lead, the credit
 * candidate recorded at onboarding, and the employer milestones' vocabulary.
 *
 * Why this exists: the public form, the growth routes, the Operations queue and both clients must
 * agree on what a well-formed code is, what a referral link looks like and how credit is decided,
 * and the migration's CHECKs repeat the parts that protect the public form and the onboarding
 * record. Pure functions, no I/O.
 *
 * Design: docs/architecture/growth-employer-pipeline-table-design.md
 */
import { growthOwningMembership, normaliseWebsiteDomain, type GrowthLeadCaller } from './growth-leads.js';

/** 31 characters with nothing that reads as another (no 0, O, 1, I or L). */
export const GROWTH_REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const GROWTH_REFERRAL_CODE_LENGTH = 10;
/** The same pattern as 0109's CHECK on growth_referral_codes.code. */
export const growthReferralCodePattern = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;

/** Abuse limits (design §3, §4). The first two are enforced by 0109's trigger; the third by the public route. */
export const growthReferralLimits = { liveCodesPerPerson: 3, createdPerDay: 5, referralsPerCodePerDay: 20 } as const;

export const growthReferralRevokeReasons = ['OWNER_REVOKED', 'OWNER_LEFT', 'LEFT_EMPLOYER_TEAM'] as const;
export type GrowthReferralRevokeReason = (typeof growthReferralRevokeReasons)[number];

/** The public form's path; the link carries the code and nothing else. */
export const GROWTH_REFERRAL_FORM_PATH = '/employer-access';

export function growthReferralLinkPath(code: string): string {
  return `${GROWTH_REFERRAL_FORM_PATH}?ref=${encodeURIComponent(code)}`;
}

/**
 * A `ref` from the public form reduced to a well-formed code, or null. Anything else — a number, an
 * object, an empty or over-long string, a character outside the alphabet — is malformed and is
 * ignored by the form exactly like an unknown code.
 */
export function normaliseGrowthReferralRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.trim().toUpperCase();
  return growthReferralCodePattern.test(code) ? code : null;
}

/** A new code from a uniform random index source (the API passes `crypto.randomInt`). */
export function generateGrowthReferralCode(randomIndex: (exclusiveMax: number) => number): string {
  let code = '';
  for (let index = 0; index < GROWTH_REFERRAL_CODE_LENGTH; index += 1) {
    const position = randomIndex(GROWTH_REFERRAL_CODE_ALPHABET.length);
    if (!Number.isInteger(position) || position < 0 || position >= GROWTH_REFERRAL_CODE_ALPHABET.length) throw new RangeError('random index out of range');
    code += GROWTH_REFERRAL_CODE_ALPHABET[position];
  }
  return code;
}

/** The membership a referral code is created under: the caller's employer-team membership, or null. */
export function growthReferralMembership(caller: GrowthLeadCaller): string | null {
  return growthOwningMembership(caller, 'EMPLOYER');
}

/**
 * The hosts an access request can match an employer lead's `website_domain` on (design §5): the
 * email's domain and the website's host, normalised the way leads are (lower case, no `www.`).
 */
export function growthAccessRequestHosts(request: { readonly emailDomain: string; readonly websiteUrl: string }): readonly string[] {
  const hosts = [normaliseWebsiteDomain(request.emailDomain), normaliseWebsiteDomain(request.websiteUrl)].filter((host): host is string => host !== null);
  return [...new Set(hosts)];
}

export const growthEmployerCandidateBases = ['REFERRAL_LINK', 'LEAD_OWNER_AT_HANDOFF', 'CONFLICT', 'HOUSE'] as const;
export type GrowthEmployerCandidateBasis = (typeof growthEmployerCandidateBases)[number];

/**
 * Design §8.3, applied at onboarding: a referral first; otherwise the linked lead's owner; when both
 * exist and name different people, a conflict (GROWTH-07 writes no attribution and opens a dispute);
 * neither is "house". Compared on the user, so a person who holds two memberships is one person.
 */
export function growthEmployerCandidateBasis(input: { readonly referrerUserId: string | null; readonly leadOwnerUserId: string | null }): GrowthEmployerCandidateBasis {
  if (input.referrerUserId && input.leadOwnerUserId && input.referrerUserId !== input.leadOwnerUserId) return 'CONFLICT';
  if (input.referrerUserId) return 'REFERRAL_LINK';
  if (input.leadOwnerUserId) return 'LEAD_OWNER_AT_HANDOFF';
  return 'HOUSE';
}

/** The derived milestones of an employer lead, in the order the screens show them (design §7.1). */
export const growthEmployerMilestones = [
  'ACCESS_REQUESTED', 'ONBOARDED', 'VERIFIED', 'TERMS_ACCEPTED', 'FIRST_JOB_PUBLISHED', 'CAMPUS_DRIVE', 'SUSPENDED',
] as const;
export type GrowthEmployerMilestone = (typeof growthEmployerMilestones)[number];

/** Whose referral brought an access request, as a growth person may be told it: never who else. */
export function growthReferralSeenBy(viewerUserId: string, referrerUserId: string | null): 'YOU' | 'ANOTHER_TEAM_MEMBER' | null {
  if (!referrerUserId) return null;
  return referrerUserId === viewerUserId ? 'YOU' : 'ANOTHER_TEAM_MEMBER';
}
