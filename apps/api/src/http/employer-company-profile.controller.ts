/**
 * The employer's company profile (EMP-04): what students see about who is hiring.
 *
 * Design: docs/architecture/employer-access-requests-table-design.md, Part 1.
 *
 * The profile is one row of organization_profiles (0005), shared with Operations. The rule
 * is by field, not by state: every field Operations verifies an employer against — legal
 * name, display name, website, address, contact email — stays Operations-only, so a
 * verified record cannot quietly stop describing the company that was verified. The
 * employer's owner and admins write only the student-facing description added in 0041:
 * about, industry, company size band and careers page. Naming any Operations-controlled
 * field, the legal name first, is refused and changes nothing.
 *
 * Decisions this file carries:
 *  - Reads and writes are the `organisation.manage` action group of requireActiveEmployer
 *    (Appendix 2 §5.1: "company profile, team"): a PENDING or UNDER_REVIEW employer can set
 *    its profile up before verification; a SUSPENDED or REJECTED one can neither read nor
 *    write it. Owners and admins edit; recruiters read (§5.1 role matrix: "view").
 *  - The careers page must sit on the Operations-held website's host or a subdomain of it,
 *    and the about text goes through the same payment-demand detector as job text at publish
 *    (§5.8), because students read both.
 *  - A missing profile row is Operations' to create; the employer write answers 409 rather
 *    than inventing a country for it.
 *  - Every write is one transaction with its audit row and outbox event, and re-reads the
 *    organisation's state under a row lock, as team changes do.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { detectOpportunitySignals } from '@planthepath/hiring/src/review-signals.js';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { assertEmployerState, employerMemberRoles, employerStateRefusal, requireEmployerMembership, type EmployerVerificationState } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };

export const companyIndustries = [
  'SOFTWARE_AND_IT_SERVICES', 'FINANCIAL_SERVICES', 'MANUFACTURING', 'ENGINEERING_AND_CONSTRUCTION',
  'HEALTHCARE_AND_LIFE_SCIENCES', 'CONSULTING_AND_PROFESSIONAL_SERVICES', 'RETAIL_AND_CONSUMER', 'EDUCATION',
  'MEDIA_AND_COMMUNICATIONS', 'ENERGY_AND_UTILITIES', 'LOGISTICS_AND_TRANSPORT', 'GOVERNMENT_AND_PUBLIC_SECTOR',
  'NON_PROFIT', 'OTHER',
] as const;
export const companySizeBands = ['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5001+'] as const;

/** What the employer's owner and admins may write. Order is the order changes are audited in. */
const employerEditableFields = ['about', 'industry', 'companySizeBand', 'careersPageUrl'] as const;
type EditableField = typeof employerEditableFields[number];
/** What Operations verifies against. Named in an employer request, it is refused. */
export const operationsControlledFields = [
  'legalName', 'displayName', 'websiteUrl', 'countryCode', 'stateOrProvince', 'city', 'postalCode',
  'addressLine1', 'addressLine2', 'primaryContactEmail',
] as const;
const profileEditorRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'] as const;
const columnFor: Readonly<Record<EditableField, string>> = {
  about: 'about_text', industry: 'industry', companySizeBand: 'company_size_band', careersPageUrl: 'careers_page_url',
};

interface ProfileRow {
  readonly legal_name: string;
  readonly verification_state: EmployerVerificationState;
  readonly has_profile: boolean;
  readonly display_name: string | null;
  readonly website_url: string | null;
  readonly country_code: string | null;
  readonly state_or_province: string | null;
  readonly city: string | null;
  readonly postal_code: string | null;
  readonly primary_contact_email: string | null;
  readonly about_text: string | null;
  readonly industry: string | null;
  readonly company_size_band: string | null;
  readonly careers_page_url: string | null;
  readonly updated_at: Date | string | null;
}

@Controller('/api/v1')
export class EmployerCompanyProfileController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/employers/:employerId/company-profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async read(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, employerMemberRoles);
    await assertEmployerState(this.db, employerId, 'organisation.manage', context.correlationId);
    const row = await this.load(employerId);
    if (!row) throw new ForbiddenException(domainError('FORBIDDEN', context.correlationId));
    return { companyProfile: present(row, mayEdit(context.authorization.memberships, employerId)), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/company-profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async update(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, profileEditorRoles);
    const { correlationId } = context;
    const changes = readChanges(body, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    const actorUserId = context.authorization.principal.userId;

    await this.db.transaction(async (tx) => {
      // Re-read the state under a row lock: a suspension landing mid-request changes nothing.
      const org = await tx.execute(sql`
        SELECT verification_state, active FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER' FOR NO KEY UPDATE
      `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
      const state = org.rows[0];
      if (!state) throw new ForbiddenException(domainError('FORBIDDEN', correlationId));
      const refusal = employerStateRefusal({ verificationState: state.verification_state, active: state.active }, 'organisation.manage');
      if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });

      const current = await tx.execute(sql`
        SELECT website_url FROM organization_profiles WHERE organization_id = ${employerId}::uuid FOR UPDATE
      `) as QueryResult<{ website_url: string | null }>;
      const profile = current.rows[0];
      if (!profile) throw new ConflictException(domainError('COMPANY_PROFILE_NOT_SET_UP', correlationId));
      const careers = changes.get('careersPageUrl');
      if (typeof careers === 'string' && !onWebsiteDomain(careers, profile.website_url)) {
        throw badRequest('COMPANY_PROFILE_CAREERS_URL_OFF_DOMAIN', correlationId);
      }

      const assignments = [...changes.entries()].map(([field, value]) => sql`${sql.raw(columnFor[field])} = ${value}`);
      await tx.execute(sql`
        UPDATE organization_profiles SET ${sql.join(assignments, sql`, `)}, updated_at = now()
        WHERE organization_id = ${employerId}::uuid
      `);
      const changedFields = employerEditableFields.filter((field) => changes.has(field));
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, 'organization.company_profile.updated', 'organization', ${employerId}, ${employerId}::uuid,
                'SUCCESS', ${correlationId}, ${JSON.stringify({ changedFields, source: 'EMPLOYER' })}::jsonb)
      `);
      const outbox = { id: this.ids.uuid(), aggregateType: 'organization', aggregateId: employerId, eventType: 'organization.company_profile.updated',
        payload: { organizationId: employerId }, actorUserId, organizationId: employerId, correlationId };
      validateOutboxWriteInput({ ...outbox, eventVersion: 1 });
      await tx.execute(sql`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
        VALUES (${outbox.id}::uuid, ${outbox.aggregateType}, ${outbox.aggregateId}, ${outbox.eventType}, 1, ${JSON.stringify(outbox.payload)}::jsonb,
                ${actorUserId}::uuid, ${employerId}::uuid, ${correlationId})
      `);
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });

    const row = await this.load(employerId);
    return { companyProfile: present(row!, true), correlationId };
  }

  private async load(employerId: string): Promise<ProfileRow | null> {
    const rows = await this.db.execute(sql`
      SELECT o.legal_name, o.verification_state, (p.organization_id IS NOT NULL) AS has_profile,
             p.display_name, p.website_url, p.country_code, p.state_or_province, p.city, p.postal_code, p.primary_contact_email,
             p.about_text, p.industry, p.company_size_band, p.careers_page_url, p.updated_at
      FROM organizations o LEFT JOIN organization_profiles p ON p.organization_id = o.id
      WHERE o.id = ${employerId}::uuid AND o.kind = 'EMPLOYER'
    `) as unknown as QueryResult<ProfileRow>;
    return rows.rows[0] ?? null;
  }
}

/** Display only; the server re-checks the role on every write. */
function mayEdit(memberships: ReturnType<typeof requireEmployerMembership>['authorization']['memberships'], employerId: string): boolean {
  return memberships.some((membership) => membership.organizationId === employerId && membership.scope.employerId === employerId
    && membership.state === 'ACTIVE' && (profileEditorRoles as readonly string[]).includes(membership.role));
}

function present(row: ProfileRow, canEdit: boolean): Record<string, unknown> {
  return {
    legalName: row.legal_name,
    verificationState: row.verification_state,
    profileSetUp: row.has_profile,
    displayName: row.display_name,
    websiteUrl: row.website_url,
    countryCode: row.country_code,
    stateOrProvince: row.state_or_province,
    city: row.city,
    postalCode: row.postal_code,
    primaryContactEmail: row.primary_contact_email,
    about: row.about_text,
    industry: row.industry,
    companySizeBand: row.company_size_band,
    careersPageUrl: row.careers_page_url,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    canEdit,
    editableFields: employerEditableFields,
    operationsControlledFields,
    options: { industries: companyIndustries, sizeBands: companySizeBands },
  };
}

/**
 * Parse the employer's change set. Operations-controlled fields are refused by name before
 * anything else, so the answer to "change my legal name" is always the same plain refusal.
 */
function readChanges(body: unknown, correlationId: string): Map<EditableField, string | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.some((key) => (operationsControlledFields as readonly string[]).includes(key))) {
    throw new ForbiddenException(domainError('COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED', correlationId));
  }
  if (!keys.length || keys.some((key) => !(employerEditableFields as readonly string[]).includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  const changes = new Map<EditableField, string | null>();
  for (const field of employerEditableFields) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field];
    if (value !== null && typeof value !== 'string') throw badRequest('COMPANY_PROFILE_INVALID', correlationId);
    const text = typeof value === 'string' ? value.trim() : '';
    changes.set(field, text ? validate(field, text, correlationId) : null);
  }
  return changes;
}

function validate(field: EditableField, value: string, correlationId: string): string {
  switch (field) {
    case 'about': {
      if (value.length > 2000) throw badRequest('COMPANY_PROFILE_INVALID', correlationId);
      const signals = detectOpportunitySignals({ text: value, crossEmployerDuplicate: false, currency: 'INR', period: 'YEAR', min: '1', max: '1' });
      if (signals.includes('APPLICANT_PAYMENT_DEMAND')) throw badRequest('COMPANY_PROFILE_PAYMENT_DEMAND', correlationId);
      return value;
    }
    case 'industry':
      if (!(companyIndustries as readonly string[]).includes(value)) throw badRequest('COMPANY_PROFILE_INVALID', correlationId);
      return value;
    case 'companySizeBand':
      if (!(companySizeBands as readonly string[]).includes(value)) throw badRequest('COMPANY_PROFILE_INVALID', correlationId);
      return value;
    case 'careersPageUrl':
      if (value.length > 256 || !/^https:\/\/[^\s]+$/i.test(value) || !parseHost(value)) throw badRequest('COMPANY_PROFILE_INVALID', correlationId);
      return value;
  }
}

function parseHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * The careers page is on the website's host or a subdomain of it. The website's leading
 * `www.` is not part of the company's domain, so careers.example.com matches www.example.com.
 */
export function onWebsiteDomain(careersUrl: string, websiteUrl: string | null): boolean {
  const careersHost = parseHost(careersUrl);
  const websiteHost = websiteUrl ? parseHost(websiteUrl) : null;
  if (!careersHost || !websiteHost) return false;
  const base = websiteHost.startsWith('www.') ? websiteHost.slice(4) : websiteHost;
  return careersHost === websiteHost || careersHost === base || careersHost.endsWith('.' + base);
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

/** HTTP refusals pass through; a constraint violation is a validation failure; nothing else leaks. */
function mapWriteError(error: unknown, correlationId: string): Error {
  if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException) return error;
  return badRequest('COMPANY_PROFILE_INVALID', correlationId);
}
