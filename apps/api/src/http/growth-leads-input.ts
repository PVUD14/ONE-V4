/**
 * Request parsing for the lead register (GROWTH-03), shared by the growth and Operations routes.
 *
 * Why this exists: a lead and a contact arrive from the web form, the phone, and (later) the
 * phone's offline queue; each must be read against the same exact field list and normalised the
 * same way (AISHE code upper-cased, website reduced to its host) before the duplicate check, or
 * the check would let `www.Acme.com` and `acme.com` through as two organisations.
 */
import {
  growthContactRoles,
  isGrowthContactBasis,
  isGrowthContactSourceFor,
  isGrowthLeadKind,
  isIndianStateCode,
  normaliseAisheCode,
  normaliseWebsiteDomain,
  growthLeadSources,
  type GrowthLeadKind,
} from '@planthepath/authorization/src/index.js';
import { badRequest, readObject } from './growth-http.js';
import { decodeLeadCursor, type NewContactInput, type NewLeadInput } from './growth-leads-service.js';

const text = (value: unknown, min: number, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length >= min && trimmed.length <= max && !/[<>]/.test(trimmed) ? trimmed : null;
};

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

export function readLeadInput(body: unknown, correlationId: string): NewLeadInput {
  const raw = readObject(body, ['kind', 'name', 'stateCode', 'districtCode', 'city', 'aisheCode', 'websiteDomain', 'source'], correlationId);
  if (!isGrowthLeadKind(raw.kind)) throw badRequest('GROWTH_LEAD_KIND_INVALID', correlationId);
  const kind: GrowthLeadKind = raw.kind;
  const name = text(raw.name, 1, 180);
  if (!name) throw badRequest('GROWTH_LEAD_NAME_INVALID', correlationId);
  const stateCode = absent(raw.stateCode) ? null : isIndianStateCode(raw.stateCode) ? raw.stateCode : undefined;
  if (stateCode === undefined) throw badRequest('GROWTH_STATE_INVALID', correlationId);
  const districtCode = absent(raw.districtCode) ? null
    : typeof raw.districtCode === 'number' && Number.isInteger(raw.districtCode) && raw.districtCode > 0 ? raw.districtCode : undefined;
  if (districtCode === undefined) throw badRequest('GROWTH_DISTRICT_INVALID', correlationId);
  if (districtCode !== null && stateCode === null) throw badRequest('GROWTH_DISTRICT_NEEDS_STATE', correlationId);
  const city = absent(raw.city) ? null : text(raw.city, 1, 120);
  if (city === null && !absent(raw.city)) throw badRequest('GROWTH_CITY_INVALID', correlationId);
  let aisheCode: string | null = null;
  if (!absent(raw.aisheCode)) {
    if (kind !== 'COLLEGE') throw badRequest('GROWTH_AISHE_FOR_COLLEGES_ONLY', correlationId);
    aisheCode = normaliseAisheCode(raw.aisheCode);
    if (!aisheCode) throw badRequest('GROWTH_AISHE_CODE_INVALID', correlationId);
  }
  let websiteDomain: string | null = null;
  if (!absent(raw.websiteDomain)) {
    websiteDomain = normaliseWebsiteDomain(raw.websiteDomain);
    if (!websiteDomain) throw badRequest('GROWTH_WEBSITE_INVALID', correlationId);
  }
  if (typeof raw.source !== 'string' || !(growthLeadSources as readonly string[]).includes(raw.source)) throw badRequest('GROWTH_LEAD_SOURCE_INVALID', correlationId);
  return { kind, name, stateCode, districtCode, city, aisheCode, websiteDomain, source: raw.source };
}

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const phonePattern = /^\+?[0-9 ()-]{6,24}$/;

/** A contact: a role, a name, an email or a phone, and a permission basis with a source that fits it. */
export function readContactInput(body: unknown, correlationId: string): NewContactInput {
  const raw = readObject(body, ['role', 'fullName', 'email', 'phone', 'permissionBasis', 'source', 'noticeGiven'], correlationId);
  if (typeof raw.role !== 'string' || !(growthContactRoles as readonly string[]).includes(raw.role)) throw badRequest('GROWTH_CONTACT_ROLE_INVALID', correlationId);
  const fullName = text(raw.fullName, 1, 120);
  if (!fullName) throw badRequest('GROWTH_CONTACT_NAME_INVALID', correlationId);
  const email = absent(raw.email) ? null : typeof raw.email === 'string' && emailPattern.test(raw.email.trim()) && raw.email.trim().length <= 254 ? raw.email.trim().toLowerCase() : undefined;
  if (email === undefined) throw badRequest('GROWTH_CONTACT_EMAIL_INVALID', correlationId);
  const phone = absent(raw.phone) ? null : typeof raw.phone === 'string' && phonePattern.test(raw.phone.trim()) ? raw.phone.trim() : undefined;
  if (phone === undefined) throw badRequest('GROWTH_CONTACT_PHONE_INVALID', correlationId);
  if (email === null && phone === null) throw badRequest('GROWTH_CONTACT_NEEDS_EMAIL_OR_PHONE', correlationId);
  // Acceptance: the permission basis is required; only the three bases of design §13.2 exist.
  if (absent(raw.permissionBasis)) throw badRequest('GROWTH_CONTACT_BASIS_REQUIRED', correlationId);
  if (!isGrowthContactBasis(raw.permissionBasis)) throw badRequest('GROWTH_CONTACT_BASIS_INVALID', correlationId);
  if (!isGrowthContactSourceFor(raw.permissionBasis, raw.source)) throw badRequest('GROWTH_CONTACT_SOURCE_INVALID', correlationId);
  if (raw.noticeGiven !== undefined && typeof raw.noticeGiven !== 'boolean') throw badRequest('INVALID_REQUEST', correlationId);
  return { role: raw.role, fullName, email, phone, permissionBasis: raw.permissionBasis, source: raw.source as string, noticeGiven: raw.noticeGiven === true };
}

const views = ['ALL', 'MINE', 'UNOWNED', 'NEEDS_OWNER'] as const;

export function readLeadQuery(query: Record<string, unknown>, correlationId: string): {
  readonly kind: GrowthLeadKind | null; readonly view: (typeof views)[number]; readonly search: string | null;
  readonly cursor: { readonly createdAt: string; readonly id: string } | null;
} {
  const kind = absent(query.kind) ? null : isGrowthLeadKind(query.kind) ? query.kind : undefined;
  if (kind === undefined) throw badRequest('GROWTH_LEAD_KIND_INVALID', correlationId);
  const view = absent(query.view) ? 'ALL' : (views as readonly unknown[]).includes(query.view) ? query.view as (typeof views)[number] : undefined;
  if (view === undefined) throw badRequest('GROWTH_LEAD_VIEW_INVALID', correlationId);
  const search = absent(query.q) ? null : text(query.q, 1, 80);
  if (search === null && !absent(query.q)) throw badRequest('GROWTH_LEAD_SEARCH_INVALID', correlationId);
  const cursor = absent(query.cursor) ? null : decodeLeadCursor(query.cursor);
  if (cursor === null && !absent(query.cursor)) throw badRequest('GROWTH_LEAD_CURSOR_INVALID', correlationId);
  return { kind, view, search, cursor };
}
