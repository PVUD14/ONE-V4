/**
 * College health and account fields (OPS-14, Appendix 1 §3 Customer success, §5.3, §5.5).
 *
 * Who may read college health (ANALYTICS_VIEW) and who may read or change a college's
 * account fields (ACCOUNT_MANAGE); the reason codes each account write may carry; the
 * contact vocabulary and field rules the 0078 CHECKs mirror; and how the college list is
 * ordered without letting a suppressed count's true size leak through its position.
 * Pure functions, so the API, the persistence layer and the unit tests read one rule.
 *
 * Design: docs/architecture/institution-accounts-table-design.md
 */
import { hasInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';
import type { SuppressedCount } from './aggregate-suppression.js';

/** Aggregate college health (Appendix 1 §6.2): OPERATIONS_ADMIN and the super admin by baseline. */
export function canViewCollegeHealth(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'ANALYTICS_VIEW');
}

/** College account fields, read and write (OPS-01 D4: a module's reads share its write capability). */
export function canManageCollegeAccount(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'ACCOUNT_MANAGE');
}

// ---------------------------------------------------------------------------
// Reason codes (§5.3): defined in code, per write
// ---------------------------------------------------------------------------

export const collegeAccountUpdateReasons = ['NEW_CONTRACT', 'RENEWAL_AGREED', 'OWNER_HANDOVER', 'CORRECTION'] as const;
export const collegeContactAddReasons = ['NEW_CONTACT', 'CONTACT_REPLACED', 'CORRECTION'] as const;
export const collegeContactRemoveReasons = ['CONTACT_LEFT', 'CONTACT_REPLACED', 'PRIVACY_REQUEST', 'CORRECTION'] as const;
/** Why an operator needs a contact's full email and phone; the reveal is audited with this code. */
export const collegeContactRevealReasons = ['RENEWAL_OUTREACH', 'SUPPORT_FOLLOW_UP', 'ONBOARDING', 'ESCALATION'] as const;

// ---------------------------------------------------------------------------
// Fields (mirrored by the 0078 CHECKs)
// ---------------------------------------------------------------------------

export const collegeContactRoles = ['PRINCIPAL', 'PLACEMENT_OFFICER', 'ACADEMIC_COORDINATOR', 'IT_CONTACT', 'ACCOUNTS', 'OTHER'] as const;
export type CollegeContactRole = (typeof collegeContactRoles)[number];

/** A sanity bound on live contacts per college, checked under the account row lock. */
export const collegeContactLimit = 10;

/** An identifier for the paper agreement: no spaces, commas or currency symbols, so no amount fits. */
const contractReferencePattern = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const phonePattern = /^\+?[0-9 ()-]{6,24}$/;

export function isValidContractReference(value: string): boolean {
  return contractReferencePattern.test(value);
}

/** A real calendar date between 2000-01-01 and 2100-12-31, as YYYY-MM-DD. */
export function isValidRenewalDate(value: string): boolean {
  const match = isoDatePattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The stored form of a contact email (lower case), or null when it is not an address. */
export function normaliseContactEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

/** The stored form of a contact phone, or null when it is not a phone number. */
export function normaliseContactPhone(value: string): string | null {
  const phone = value.trim();
  return phonePattern.test(phone) && /\d{4}/.test(phone.replace(/\D/g, '')) ? phone : null;
}

// ---------------------------------------------------------------------------
// Ordering without disclosure
// ---------------------------------------------------------------------------

export interface CollegeHealthSortable {
  readonly name: string;
  readonly renewalDate: string | null;
  readonly weeklyActiveLearners: SuppressedCount;
}

/** Shown counts first, largest first; suppressed ones after, by name, never by true size. */
function compareActivity(a: CollegeHealthSortable, b: CollegeHealthSortable): number {
  const av = a.weeklyActiveLearners.suppressed ? null : a.weeklyActiveLearners.value;
  const bv = b.weeklyActiveLearners.suppressed ? null : b.weeklyActiveLearners.value;
  if (av !== null && bv !== null && av !== bv) return bv - av;
  if (av !== null && bv === null) return -1;
  if (av === null && bv !== null) return 1;
  return 0;
}

function compareName(a: CollegeHealthSortable, b: CollegeHealthSortable): number {
  return a.name.localeCompare(b.name);
}

/**
 * Renewal date soonest first (unset last), then activity, then name. The input must
 * already be suppressed: this sees only what may leave the server.
 */
export function sortCollegesByRenewal<T extends CollegeHealthSortable>(colleges: readonly T[]): T[] {
  return [...colleges].sort((a, b) => {
    if (a.renewalDate !== b.renewalDate) {
      if (a.renewalDate === null) return 1;
      if (b.renewalDate === null) return -1;
      return a.renewalDate < b.renewalDate ? -1 : 1;
    }
    return compareActivity(a, b) || compareName(a, b);
  });
}

/** Activity first (suppressed after shown, by name), then renewal date, then name. */
export function sortCollegesByActivity<T extends CollegeHealthSortable>(colleges: readonly T[]): T[] {
  return [...colleges].sort((a, b) => {
    const activity = compareActivity(a, b);
    if (activity) return activity;
    const aSuppressed = a.weeklyActiveLearners.suppressed;
    // Within the suppressed group the order is by name only, so it says nothing about size.
    if (aSuppressed) return compareName(a, b);
    if (a.renewalDate !== b.renewalDate) {
      if (a.renewalDate === null) return 1;
      if (b.renewalDate === null) return -1;
      return a.renewalDate < b.renewalDate ? -1 : 1;
    }
    return compareName(a, b);
  });
}
