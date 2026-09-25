import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Optional, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { digestInvitationToken, generateInvitationToken } from '@planthepath/identity/src/invitation-token.js';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { institutionStudentScopeSql } from '@planthepath/persistence/src/institution-scope.js';
import { buildInvitationUrl, type InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { createStudentInvitation, loadStudentActivations, resendStudentInvitations, revokePendingStudentInvitations, summariseActivations } from '@planthepath/persistence/src/student-invitations.js';
import { describeInstitutionStudentScope, institutionStudentScopeFor } from './institution-student-scope.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };
type OrganizationKind = 'INSTITUTION' | 'EMPLOYER';
type VerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
type InstitutionType = 'UNIVERSITY' | 'ENGINEERING_COLLEGE' | 'ARTS_SCIENCE_COLLEGE' | 'BUSINESS_SCHOOL' | 'POLYTECHNIC' | 'OTHER';
type UnitKind = 'DEPARTMENT' | 'PROGRAM' | 'BATCH' | 'SECTION' | 'CAMPUS';
type RelationshipEndState = 'TRANSFERRED' | 'GRADUATED' | 'ENDED' | 'REVOKED';
type InvitationRole = 'INSTITUTION_ADMIN' | 'EMPLOYER_ADMIN' | 'PLACEMENT_ADMIN' | 'DEPARTMENT_HEAD' | 'FACULTY_LECTURER';

export const API_INVITATION_MAIL_SINK = Symbol('API_INVITATION_MAIL_SINK');

// Delivery moved to packages/persistence so the outbox worker can send student invitations;
// re-exported so existing API callers keep their imports.
export { createConfiguredInvitationMailSink, LoopbackSmtpInvitationMailSink, type InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@ \t\r\n]+@[^@ \t\r\n]+\.[^@ \t\r\n]+$/;
const countryPattern = /^[A-Z]{2}$/;
const platformMutationRoles: readonly string[] = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'];
const institutionAdminRoles: readonly string[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const institutionStaffRoles: readonly string[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const institutionAssignableRoles = ['PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'] as const;
const adminInvitationTemplateId = '26000000-0000-4000-8000-000000000004';
const staffInvitationTemplateId = '26000000-0000-4000-8000-000000000005';

@Controller('/api/v1')
export class OperationsInstitutionOnboardingController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_INVITATION_MAIL_SINK) private readonly invitationMailSink?: InvitationMailSink,
  ) {}

  @Get('/operations/organizations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOrganizations(@Req() request: ProtectedHttpRequest, @Query('q') q?: string, @Query('kind') kind?: string, @Query('verification') verification?: string): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const rows = await this.db.execute(sql`
      SELECT o.id, o.kind, o.legal_name, o.verification_state, o.active, o.created_at, o.updated_at,
             p.display_name, p.website_url, p.country_code, p.state_or_province, p.city, p.postal_code,
             p.address_line_1, p.address_line_2, p.primary_contact_email, p.institution_type,
             inv.id AS initial_invitation_id, inv.email AS initial_invitation_email, inv.state AS initial_invitation_state
      FROM organizations o
      LEFT JOIN organization_profiles p ON p.organization_id = o.id
      LEFT JOIN LATERAL (
        SELECT id, email, state
        FROM invitations
        WHERE organization_id = o.id
          AND role IN ('INSTITUTION_OWNER','INSTITUTION_ADMIN','EMPLOYER_OWNER','EMPLOYER_ADMIN')
        ORDER BY created_at DESC
        LIMIT 1
      ) inv ON true
      WHERE o.kind IN ('INSTITUTION','EMPLOYER')
        AND (${kind ?? null}::text IS NULL OR o.kind = ${kind ?? null}::organization_kind)
        AND (${verification ?? null}::text IS NULL OR o.verification_state = ${verification ?? null}::verification_state)
        AND (${q ?? null}::text IS NULL OR lower(o.legal_name) LIKE '%' || lower(${q ?? null}) || '%' OR lower(coalesce(p.display_name,'')) LIKE '%' || lower(${q ?? null}) || '%')
      ORDER BY o.updated_at DESC, o.legal_name
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { organizations: rows.rows.map(mapOrganizationRow), correlationId: context.correlationId };
  }

  @Post('/operations/organizations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createOrganization(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const input = readOrganizationInput(body, true, context.correlationId);
    const organizationId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO organizations (id, kind, legal_name, verification_state)
        VALUES (${organizationId}::uuid, ${input.kind}::organization_kind, ${input.legalName}, 'PENDING')
      `);
      if (!input.profile) throw forbidden(context.correlationId);
      await upsertOrganizationProfile(tx, organizationId, input.profile);
      await writeAudit(tx, {
        id: this.ids.uuid(),
        actorUserId: context.authorization.principal.userId,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organizationId,
        organizationId,
        correlationId: context.correlationId,
      });
      await writeOutbox(tx, {
        id: this.ids.uuid(),
        aggregateType: 'organization',
        aggregateId: organizationId,
        eventType: 'organization.created',
        payload: { organizationId, kind: input.kind },
        actorUserId: context.authorization.principal.userId,
        organizationId,
        correlationId: context.correlationId,
      });
    });
    return this.getOrganizationById(request, organizationId);
  }

  @Get('/operations/organizations/:targetOrganizationId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getOrganizationById(@Req() request: ProtectedHttpRequest, @Param('targetOrganizationId') organizationId: string): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const id = requireUuid(organizationId, context.correlationId);
    const result = await this.db.execute(sql`
      SELECT o.id, o.kind, o.legal_name, o.verification_state, o.active, o.created_at, o.updated_at,
             p.display_name, p.website_url, p.country_code, p.state_or_province, p.city, p.postal_code,
             p.address_line_1, p.address_line_2, p.primary_contact_email, p.institution_type
      FROM organizations o
      LEFT JOIN organization_profiles p ON p.organization_id = o.id
      WHERE o.id = ${id}::uuid AND o.kind IN ('INSTITUTION','EMPLOYER')
    `) as QueryResult<Record<string, unknown>>;
    const [row] = result.rows;
    if (!row) throw forbidden(context.correlationId);
    const audit = await this.db.execute(sql`
      SELECT action, outcome, correlation_id, occurred_at
      FROM audit_events
      WHERE organization_id = ${id}::uuid
      ORDER BY occurred_at DESC
      LIMIT 25
    `) as QueryResult<Record<string, unknown>>;
    return { organization: mapOrganizationRow(row), activity: audit.rows, correlationId: context.correlationId };
  }

  @Patch('/operations/organizations/:targetOrganizationId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateOrganization(@Req() request: ProtectedHttpRequest, @Param('targetOrganizationId') organizationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const id = requireUuid(organizationId, context.correlationId);
    const input = readOrganizationInput(body, false, context.correlationId);
    await this.db.transaction(async (tx) => {
      if (input.legalName) {
        const updated = await tx.execute(sql`
          UPDATE organizations SET legal_name = ${input.legalName}, updated_at = now()
          WHERE id = ${id}::uuid AND kind IN ('INSTITUTION','EMPLOYER')
          RETURNING id
        `) as QueryResult<{ id: string }>;
        if (updated.rows.length !== 1) throw new Error('organization not found');
      }
      if (input.profile) await upsertOrganizationProfile(tx, id, input.profile);
      await writeAudit(tx, {
        id: this.ids.uuid(),
        actorUserId: context.authorization.principal.userId,
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: id,
        organizationId: id,
        correlationId: context.correlationId,
      });
      await writeOutbox(tx, {
        id: this.ids.uuid(),
        aggregateType: 'organization',
        aggregateId: id,
        eventType: 'organization.updated',
        payload: { organizationId: id },
        actorUserId: context.authorization.principal.userId,
        organizationId: id,
        correlationId: context.correlationId,
      });
    });
    return this.getOrganizationById(request, id);
  }

  @Post('/operations/organizations/:targetOrganizationId/verification')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionVerification(@Req() request: ProtectedHttpRequest, @Param('targetOrganizationId') organizationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const id = requireUuid(organizationId, context.correlationId);
    const toState = readEnum(readString(body, 'toState', context.correlationId), ['UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'], context.correlationId);
    const reasonCode = readOptionalString(body, 'reasonCode') ?? 'OPERATIONS_REVIEW';
    if (!/^[A-Z0-9_:-]{3,64}$/.test(reasonCode)) throw forbidden(context.correlationId);
    await this.db.transaction(async (tx) => {
      const current = await tx.execute(sql`SELECT verification_state FROM organizations WHERE id = ${id}::uuid AND kind IN ('INSTITUTION','EMPLOYER') FOR UPDATE`) as QueryResult<{ verification_state: VerificationState }>;
      const [row] = current.rows;
      if (!row || !isAllowedVerificationTransition(row.verification_state, toState)) throw new Error('invalid verification transition');
      await tx.execute(sql`UPDATE organizations SET verification_state = ${toState}::verification_state, active = ${toState !== 'SUSPENDED'}, updated_at = now() WHERE id = ${id}::uuid`);
      await tx.execute(sql`
        INSERT INTO organization_verification_events (id, organization_id, from_state, to_state, reason_code, actor_user_id, correlation_id)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${row.verification_state}::verification_state, ${toState}::verification_state, ${reasonCode}, ${context.authorization.principal.userId}::uuid, ${context.correlationId})
      `);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'organization.verification_transitioned', resourceType: 'organization', resourceId: id, organizationId: id, correlationId: context.correlationId, context: { toState, reasonCode } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'organization', aggregateId: id, eventType: 'organization.verification_transitioned', payload: { organizationId: id, toState }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return this.getOrganizationById(request, id);
  }

  @Post('/operations/organizations/:targetOrganizationId/initial-admin-invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async inviteInitialAdmin(@Req() request: ProtectedHttpRequest, @Param('targetOrganizationId') organizationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const id = requireUuid(organizationId, context.correlationId);
    const email = normalizeEmail(readString(body, 'email', context.correlationId), context.correlationId);
    const org = await this.db.execute(sql`SELECT kind FROM organizations WHERE id = ${id}::uuid AND kind IN ('INSTITUTION','EMPLOYER')`) as QueryResult<{ kind: OrganizationKind }>;
    const [row] = org.rows;
    if (!row) throw forbidden(context.correlationId);
    const role = row.kind === 'INSTITUTION' ? 'INSTITUTION_ADMIN' : 'EMPLOYER_ADMIN';
    const invitation = await this.createScopedInvitation({
      actorUserId: context.authorization.principal.userId,
      organizationId: id,
      email,
      role,
      scopeInstitutionId: row.kind === 'INSTITUTION' ? id : null,
      scopeEmployerId: row.kind === 'EMPLOYER' ? id : null,
      templateId: adminInvitationTemplateId,
      legalPurpose: 'transactional organization administrator invitation',
      dedupePrefix: 'initial-admin',
      correlationId: context.correlationId,
    });
    return { invitation: { id: invitation.id, email, role, state: 'PENDING', tokenPreviewAvailable: false }, correlationId: context.correlationId };
  }

  @Get('/operations/users-access')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listUsersAccess(@Req() request: ProtectedHttpRequest, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const search = q?.trim() || null;
    const rows = await this.db.execute(sql`
      SELECT u.id, u.email, u.external_subject IS NOT NULL AS identity_linked, u.state, u.created_at, u.updated_at,
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
               'organizationId', m.organization_id,
               'organizationLegalName', o.legal_name,
               'organizationKind', o.kind,
               'role', m.role,
               'state', m.state,
               'scopeOrganizationId', m.scope_organization_id,
               'scopeInstitutionId', m.scope_institution_id,
               'scopeDepartmentUnitId', m.scope_department_unit_id,
               'scopeBatchUnitId', m.scope_batch_unit_id,
               'scopeEmployerId', m.scope_employer_id
             )) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS memberships,
             count(DISTINCT ir.id) AS student_relationship_count,
             COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
               'institutionId', ir.institution_id,
               'state', ir.state,
               'effectiveFrom', ir.effective_from,
               'effectiveTo', ir.effective_to
             )) FILTER (WHERE ir.id IS NOT NULL), '[]'::jsonb) AS student_relationships
      FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id
      LEFT JOIN organizations o ON o.id = m.organization_id
      LEFT JOIN institution_relationships ir ON ir.student_user_id = u.id
      WHERE ${search}::text IS NULL
        OR lower(u.email) LIKE '%' || lower(${search}) || '%'
        OR u.id::text = ${search}
      GROUP BY u.id, u.email, u.external_subject, u.state, u.created_at, u.updated_at
      ORDER BY u.updated_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { users: rows.rows.map(mapUserAccessRow), correlationId: context.correlationId };
  }

  @Get('/operations/invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listInvitationInventory(@Req() request: ProtectedHttpRequest, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const search = q?.trim() || null;
    const rows = await this.db.execute(sql`
      SELECT i.id, i.email, i.organization_id, o.legal_name AS organization_legal_name, o.kind AS organization_kind,
             i.role, i.state, i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
             nc.id AS notification_command_id, nc.state AS notification_state, nc.destination_ref,
             nda.provider_kind, nda.provider_reference, nda.outcome AS delivery_outcome
      FROM invitations i
      LEFT JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN notification_commands nc ON nc.destination_ref = 'invitation:' || i.id::text
      LEFT JOIN LATERAL (
        SELECT provider_kind, provider_reference, outcome
        FROM notification_delivery_attempts nda_inner
        WHERE nda_inner.command_id = nc.id
        ORDER BY nda_inner.attempt DESC
        LIMIT 1
      ) nda ON true
      WHERE ${search}::text IS NULL
        OR lower(i.email) LIKE '%' || lower(${search}) || '%'
        OR i.id::text = ${search}
        OR lower(coalesce(o.legal_name,'')) LIKE '%' || lower(${search}) || '%'
      ORDER BY i.created_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { invitations: rows.rows.map(mapInvitationInventoryRow), correlationId: context.correlationId };
  }

  @Get('/operations/organizations/:targetOrganizationId/onboarding-status')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async onboardingStatus(@Req() request: ProtectedHttpRequest, @Param('targetOrganizationId') organizationId: string): Promise<Record<string, unknown>> {
    const context = requireOperations(request);
    const id = requireUuid(organizationId, context.correlationId);
    const result = await this.db.execute(sql`
      SELECT o.verification_state,
             p.organization_id IS NOT NULL AS has_profile,
             EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id=o.id AND i.role IN ('INSTITUTION_ADMIN','INSTITUTION_OWNER','EMPLOYER_ADMIN','EMPLOYER_OWNER')) AS has_initial_admin_invitation,
             EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=o.id AND m.role IN ('INSTITUTION_ADMIN','INSTITUTION_OWNER','EMPLOYER_ADMIN','EMPLOYER_OWNER') AND m.state='ACTIVE') AS has_active_admin
      FROM organizations o
      LEFT JOIN organization_profiles p ON p.organization_id=o.id
      WHERE o.id=${id}::uuid AND o.kind IN ('INSTITUTION','EMPLOYER')
    `) as QueryResult<Record<string, unknown>>;
    const [row] = result.rows;
    if (!row) throw forbidden(context.correlationId);
    return { status: row, correlationId: context.correlationId };
  }

  @Get('/institutions/:institutionId/units')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listUnits(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const context = requireInstitutionStaff(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const units = await this.db.execute(sql`SELECT id, institution_id, kind, name, parent_unit_id, created_at, updated_at FROM institution_units WHERE institution_id=${id}::uuid ORDER BY kind, name`) as QueryResult<Record<string, unknown>>;
    return { units: units.rows.map(mapUnitRow), correlationId: context.correlationId };
  }

  @Get('/institutions/:institutionId/staff-role-assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listStaffRoleAssignments(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const invitations = await this.db.execute(sql`
      SELECT i.id, i.email, i.role, i.state, i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
             nc.id AS notification_command_id, nc.state AS notification_state,
             nda.provider_kind, nda.provider_reference, nda.outcome AS delivery_outcome
      FROM invitations i
      LEFT JOIN notification_commands nc ON nc.destination_ref = 'invitation:' || i.id::text
      LEFT JOIN LATERAL (
        SELECT provider_kind, provider_reference, outcome
        FROM notification_delivery_attempts nda_inner
        WHERE nda_inner.command_id = nc.id
        ORDER BY nda_inner.attempt DESC
        LIMIT 1
      ) nda ON true
      WHERE i.organization_id = ${id}::uuid AND i.role IN ('PLACEMENT_ADMIN','DEPARTMENT_HEAD','FACULTY_LECTURER')
      ORDER BY i.created_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    const memberships = await this.db.execute(sql`
      SELECT m.id, m.user_id, u.email, m.role, m.state, m.created_at, m.updated_at
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${id}::uuid
        AND m.scope_institution_id = ${id}::uuid
        AND m.role IN ('PLACEMENT_ADMIN','DEPARTMENT_HEAD','FACULTY_LECTURER')
      ORDER BY m.updated_at DESC, u.email
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { staff: { invitations: invitations.rows.map(mapStaffInvitationRow), memberships: memberships.rows.map(mapStaffMembershipRow), unavailableActions: ['revoke', 'resend', 'endMembership'] }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/units')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createUnit(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const kind = readEnum(readString(body, 'kind', context.correlationId), ['DEPARTMENT', 'PROGRAM', 'BATCH', 'SECTION', 'CAMPUS'], context.correlationId);
    const name = bounded(readString(body, 'name', context.correlationId), 1, 120, context.correlationId);
    const parentUnitId = readOptionalUuid(body, 'parentUnitId', context.correlationId);
    const unitId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO institution_units (id, institution_id, kind, name, parent_unit_id) VALUES (${unitId}::uuid, ${id}::uuid, ${kind}::institution_unit_kind, ${name}, ${parentUnitId ?? null}::uuid)`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.unit.created', resourceType: 'institution_unit', resourceId: unitId, organizationId: id, correlationId: context.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_unit', aggregateId: unitId, eventType: 'institution.unit.created', payload: { unitId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return { unit: { id: unitId, institutionId: id, kind, name, parentUnitId: parentUnitId ?? null }, correlationId: context.correlationId };
  }

  @Get('/institutions/:institutionId/students')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listStudents(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireInstitutionStaff(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const scope = await institutionStudentScopeFor(this.db, request, id, institutionStaffRoles);
    const rows = await this.db.execute(sql`
      SELECT sp.*, u.email, ir.id AS relationship_id, ir.state AS relationship_state, ir.effective_from, ir.effective_to
      FROM institution_student_profiles sp
      JOIN users u ON u.id=sp.student_user_id
      LEFT JOIN LATERAL (
        SELECT id, state, effective_from, effective_to
        FROM institution_relationships
        WHERE institution_id=sp.institution_id AND student_user_id=sp.student_user_id
        ORDER BY effective_from DESC
        LIMIT 1
      ) ir ON true
      WHERE sp.institution_id=${id}::uuid
        AND ${institutionStudentScopeSql(scope, 'sp')}
        AND (${q ?? null}::text IS NULL OR lower(sp.full_name) LIKE '%' || lower(${q ?? null}) || '%' OR lower(sp.institution_student_id) LIKE '%' || lower(${q ?? null}) || '%' OR lower(u.email) LIKE '%' || lower(${q ?? null}) || '%')
      ORDER BY sp.updated_at DESC, sp.full_name
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    const activations = await loadStudentActivations(this.db, id, rows.rows.map((row) => String(row.student_user_id)));
    const students = rows.rows.map((row) => ({ ...mapStudentRow(row), activation: activations.get(String(row.student_user_id)) ?? null }));
    return {
      students,
      // Server-computed over the same rows, so the Dashboard's counts cannot disagree with this list.
      activationSummary: summariseActivations([...activations.values()]),
      scope: await describeInstitutionStudentScope(this.db, request, id, institutionStaffRoles, scope),
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/students')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addStudent(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const input = readStudentInput(body, context.correlationId);
    const userId = this.ids.uuid();
    const profileId = this.ids.uuid();
    const relationshipId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      const existing = await tx.execute(sql`SELECT id FROM users WHERE lower(email)=lower(${input.email}) FOR UPDATE`) as QueryResult<{ id: string }>;
      if (existing.rows[0]) throw conflict('STUDENT_EMAIL_ALREADY_EXISTS', context.correlationId, 'email');
      const existingStudentId = await tx.execute(sql`SELECT id FROM institution_student_profiles WHERE institution_id=${id}::uuid AND lower(institution_student_id)=lower(${input.institutionStudentId}) FOR UPDATE`) as QueryResult<{ id: string }>;
      if (existingStudentId.rows[0]) throw conflict('INSTITUTION_STUDENT_ID_ALREADY_EXISTS', context.correlationId, 'institutionStudentId');
      validateDateWindow(input.academicStartDate ?? null, input.expectedGraduationDate ?? null, context.correlationId);
      await validateStudentUnitScope(tx, id, input, context.correlationId);
      await tx.execute(sql`INSERT INTO users (id, email, state) VALUES (${userId}::uuid, ${input.email}, 'INVITED')`);
      await tx.execute(sql`
        INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, department_unit_id, program_unit_id, batch_unit_id, section_unit_id, academic_start_date, expected_graduation_date, status)
        VALUES (${profileId}::uuid, ${id}::uuid, ${userId}::uuid, ${input.institutionStudentId}, ${input.fullName}, ${input.departmentUnitId ?? null}::uuid, ${input.programUnitId ?? null}::uuid, ${input.batchUnitId ?? null}::uuid, ${input.sectionUnitId ?? null}::uuid, ${input.academicStartDate ?? null}::date, ${input.expectedGraduationDate ?? null}::date, 'INVITED')
      `);
      await tx.execute(sql`INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from) VALUES (${relationshipId}::uuid, ${id}::uuid, ${userId}::uuid, 'ACTIVE', now())`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.student_profile.created', resourceType: 'institution_student_profile', resourceId: profileId, organizationId: id, correlationId: context.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_student_profile', aggregateId: profileId, eventType: 'institution.student_profile.created', payload: { profileId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_relationship', aggregateId: relationshipId, eventType: 'institution.relationship.created', payload: { relationshipId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
      // INST-01: the student is invited in the same transaction; the email is sent off the request path.
      await createStudentInvitation(tx, { invitationId: this.ids.uuid(), institutionId: id, studentUserId: userId, email: input.email,
        invitedByUserId: context.authorization.principal.userId, outboxEventId: this.ids.uuid(), auditId: this.ids.uuid(), correlationId: context.correlationId });
    });
    return { student: { id: profileId, institutionId: id, institutionStudentId: input.institutionStudentId, fullName: input.fullName, relationshipId, activation: 'INVITED' }, correlationId: context.correlationId };
  }

  @Patch('/institutions/:institutionId/units/:unitId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateUnit(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('unitId') unitId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const unit = requireUuid(unitId, context.correlationId);
    const name = bounded(readString(body, 'name', context.correlationId), 1, 120, context.correlationId);
    await this.db.transaction(async (tx) => {
      const updated = await tx.execute(sql`UPDATE institution_units SET name=${name}, updated_at=now() WHERE id=${unit}::uuid AND institution_id=${id}::uuid RETURNING id`) as QueryResult<{ id: string }>;
      if (updated.rows.length !== 1) throw new Error('unit not found');
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.unit.updated', resourceType: 'institution_unit', resourceId: unit, organizationId: id, correlationId: context.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_unit', aggregateId: unit, eventType: 'institution.unit.updated', payload: { unitId: unit }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return { unit: { id: unit, institutionId: id, name }, correlationId: context.correlationId };
  }

  @Get('/institutions/:institutionId/students/:studentProfileId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getStudent(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentProfileId') studentProfileId: string): Promise<Record<string, unknown>> {
    const context = requireInstitutionStaff(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const profileId = requireUuid(studentProfileId, context.correlationId);
    const scope = await institutionStudentScopeFor(this.db, request, id, institutionStaffRoles);
    const rows = await this.db.execute(sql`
      SELECT sp.*, u.email, ir.id AS relationship_id, ir.state AS relationship_state, ir.effective_from, ir.effective_to
      FROM institution_student_profiles sp
      JOIN users u ON u.id=sp.student_user_id
      LEFT JOIN LATERAL (
        SELECT id, state, effective_from, effective_to FROM institution_relationships
        WHERE institution_id=sp.institution_id AND student_user_id=sp.student_user_id
        ORDER BY effective_from DESC LIMIT 1
      ) ir ON true
      WHERE sp.institution_id=${id}::uuid AND sp.id=${profileId}::uuid
        AND ${institutionStudentScopeSql(scope, 'sp')}
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    return { student: mapStudentRow(row), correlationId: context.correlationId };
  }

  @Patch('/institutions/:institutionId/students/:studentProfileId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateStudent(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentProfileId') studentProfileId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const profileId = requireUuid(studentProfileId, context.correlationId);
    const input = readStudentPatch(body, context.correlationId);
    await this.db.transaction(async (tx) => {
      const existing = await tx.execute(sql`
        SELECT academic_start_date, expected_graduation_date
        FROM institution_student_profiles
        WHERE id=${profileId}::uuid AND institution_id=${id}::uuid
        FOR UPDATE
      `) as QueryResult<{ academic_start_date: string | null; expected_graduation_date: string | null }>;
      const current = existing.rows[0];
      if (!current) throw forbidden(context.correlationId);
      const nextStart = Object.hasOwn(input, 'academicStartDate') ? input.academicStartDate ?? null : current.academic_start_date;
      const nextGraduation = Object.hasOwn(input, 'expectedGraduationDate') ? input.expectedGraduationDate ?? null : current.expected_graduation_date;
      validateDateWindow(nextStart, nextGraduation, context.correlationId);
      await validateStudentUnitScope(tx, id, input, context.correlationId);
      const updated = await tx.execute(sql`
        UPDATE institution_student_profiles
        SET full_name=coalesce(${input.fullName ?? null}, full_name),
            department_unit_id=CASE WHEN ${Object.hasOwn(input, 'departmentUnitId')} THEN ${input.departmentUnitId ?? null}::uuid ELSE department_unit_id END,
            program_unit_id=CASE WHEN ${Object.hasOwn(input, 'programUnitId')} THEN ${input.programUnitId ?? null}::uuid ELSE program_unit_id END,
            batch_unit_id=CASE WHEN ${Object.hasOwn(input, 'batchUnitId')} THEN ${input.batchUnitId ?? null}::uuid ELSE batch_unit_id END,
            section_unit_id=CASE WHEN ${Object.hasOwn(input, 'sectionUnitId')} THEN ${input.sectionUnitId ?? null}::uuid ELSE section_unit_id END,
            academic_start_date=CASE WHEN ${Object.hasOwn(input, 'academicStartDate')} THEN ${input.academicStartDate ?? null}::date ELSE academic_start_date END,
            expected_graduation_date=CASE WHEN ${Object.hasOwn(input, 'expectedGraduationDate')} THEN ${input.expectedGraduationDate ?? null}::date ELSE expected_graduation_date END,
            updated_at=now()
        WHERE id=${profileId}::uuid AND institution_id=${id}::uuid
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (updated.rows.length !== 1) throw new Error('student profile not found');
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.student_profile.updated', resourceType: 'institution_student_profile', resourceId: profileId, organizationId: id, correlationId: context.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_student_profile', aggregateId: profileId, eventType: 'institution.student_profile.updated', payload: { profileId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return this.getStudent(request, id, profileId);
  }

  @Post('/institutions/:institutionId/students/:studentProfileId/relationship')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async endStudentRelationship(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('studentProfileId') studentProfileId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const profileId = requireUuid(studentProfileId, context.correlationId);
    const state = readEnum(readString(body, 'state', context.correlationId), ['TRANSFERRED', 'GRADUATED', 'ENDED', 'REVOKED'], context.correlationId);
    const effectiveTo = readOptionalDateTime(body, 'effectiveTo', context.correlationId) ?? new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const profile = await tx.execute(sql`SELECT student_user_id FROM institution_student_profiles WHERE id=${profileId}::uuid AND institution_id=${id}::uuid FOR UPDATE`) as QueryResult<{ student_user_id: string }>;
      const studentUserId = profile.rows[0]?.student_user_id;
      if (!studentUserId) throw new Error('student profile not found');
      const rel = await tx.execute(sql`
        UPDATE institution_relationships
        SET state=${state}::relationship_state, effective_to=${effectiveTo}, updated_at=now()
        WHERE id = (
          SELECT id FROM institution_relationships
          WHERE institution_id=${id}::uuid AND student_user_id=${studentUserId}::uuid AND effective_to IS NULL
          ORDER BY effective_from DESC LIMIT 1
        )
        RETURNING id
      `) as QueryResult<{ id: string }>;
      const relationshipId = rel.rows[0]?.id;
      if (!relationshipId) throw new Error('current relationship not found');
      await tx.execute(sql`UPDATE institution_student_profiles SET status=${state}::roster_student_status, updated_at=now() WHERE id=${profileId}::uuid`);
      // A student whose relationship ended must not be able to activate into it afterwards.
      await revokePendingStudentInvitations(tx, { institutionId: id, studentUserId, reasonCode: `RELATIONSHIP_${state}` });
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.relationship.ended', resourceType: 'institution_relationship', resourceId: relationshipId, organizationId: id, correlationId: context.correlationId, context: { state } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_relationship', aggregateId: relationshipId, eventType: 'institution.relationship.ended', payload: { relationshipId, state }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return this.getStudent(request, id, profileId);
  }

  /**
   * Resend student invitations (INST-01): one student, several, or every student still waiting
   * (INVITED, EXPIRED, BOUNCED or never invited). Requires a reason code; activated students and
   * students without a current relationship are skipped, never re-invited.
   */
  @Post('/institutions/:institutionId/student-invitations/resend')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async resendStudentInvitations(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const input = requireObject(body, 'request');
    const reasonCode = typeof input.reasonCode === 'string' ? input.reasonCode : '';
    if (!/^[A-Z0-9_:-]{3,64}$/.test(reasonCode)) throw badRequest('INVALID_REASON_CODE', context.correlationId, 'reasonCode');
    const all = input.all === true;
    const rawIds = input.studentUserIds;
    if (all === Array.isArray(rawIds)) throw badRequest('INVALID_RESEND_TARGET', context.correlationId, 'studentUserIds');
    let studentUserIds: string[];
    if (all) {
      const waiting = await this.db.execute(sql`
        SELECT p.student_user_id FROM institution_student_profiles p JOIN users u ON u.id = p.student_user_id
        WHERE p.institution_id = ${id}::uuid AND u.state = 'INVITED' LIMIT 2000
      `) as QueryResult<{ student_user_id: string }>;
      studentUserIds = waiting.rows.map((row) => row.student_user_id);
    } else {
      const list = rawIds as unknown[];
      if (list.length === 0 || list.length > 500) throw badRequest('INVALID_RESEND_TARGET', context.correlationId, 'studentUserIds');
      studentUserIds = [...new Set(list.map((value) => requireUuid(typeof value === 'string' ? value : '', context.correlationId)))];
    }
    const result = await this.db.transaction((tx) => resendStudentInvitations(tx, {
      institutionId: id, studentUserIds, actorUserId: context.authorization.principal.userId, reasonCode,
      correlationId: context.correlationId, newId: () => this.ids.uuid(),
    }));
    return { resend: result, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/staff-role-assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assignStaffRole(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const input = requireObject(body, 'request');
    if (typeof input.userId === 'string') throw forbidden(context.correlationId);
    const email = normalizeEmail(readString(body, 'email', context.correlationId), context.correlationId);
    const actor = await this.db.execute(sql`
      SELECT email
      FROM users
      WHERE id=${context.authorization.principal.userId}::uuid
      LIMIT 1
    `) as QueryResult<{ email: string }>;
    const actorEmail = actor.rows[0]?.email ? normalizeEmail(actor.rows[0].email, context.correlationId) : null;
    if (!actorEmail || email === actorEmail) throw forbidden(context.correlationId);
    const role = readEnum(readString(body, 'role', context.correlationId), institutionAssignableRoles, context.correlationId);
    const pendingInvitation = await this.db.execute(sql`
      SELECT id, state, role, expires_at
      FROM invitations
      WHERE organization_id=${id}::uuid AND lower(email)=lower(${email}) AND state='PENDING' AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `) as QueryResult<{ id: string; state: string; role: string; expires_at: Date | string }>;
    if (pendingInvitation.rows[0]) {
      return {
        invitation: {
          id: pendingInvitation.rows[0].id,
          email,
          role: pendingInvitation.rows[0].role,
          state: pendingInvitation.rows[0].state,
          expiresAt: new Date(pendingInvitation.rows[0].expires_at).toISOString(),
          tokenPreviewAvailable: false,
        },
        code: 'STAFF_INVITATION_ALREADY_PENDING',
        correlationId: context.correlationId,
      };
    }
    const invitation = await this.createScopedInvitation({
      actorUserId: context.authorization.principal.userId,
      organizationId: id,
      email,
      role,
      scopeInstitutionId: id,
      scopeEmployerId: null,
      templateId: staffInvitationTemplateId,
      legalPurpose: 'transactional institution staff invitation',
      dedupePrefix: 'institution-staff',
      correlationId: context.correlationId,
    });
    return { invitation: { id: invitation.id, email, role, state: 'PENDING', delivery: { state: this.invitationMailSink ? 'PENDING' : 'NOT_CONFIGURED' }, tokenPreviewAvailable: false }, correlationId: context.correlationId };
  }

  private async createScopedInvitation(input: {
    readonly actorUserId: string;
    readonly organizationId: string;
    readonly email: string;
    readonly role: InvitationRole;
    readonly scopeInstitutionId: string | null;
    readonly scopeEmployerId: string | null;
    readonly templateId: string;
    readonly legalPurpose: string;
    readonly dedupePrefix: string;
    readonly correlationId: string;
  }): Promise<{ readonly id: string; readonly notificationCommandId: string }> {
    const token = generateInvitationToken();
    const tokenHash = digestInvitationToken(token);
    const invitationId = this.ids.uuid();
    const notificationCommandId = this.ids.uuid();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000);
    const subject = input.role === 'EMPLOYER_ADMIN' ? 'ONE employer administrator invitation' : 'ONE institution administrator invitation';
    const invitationUrl = buildInvitationUrl(token);
    const textBody = [
      'You have been invited to administer a ONE organization.',
      `Open this invitation link with the identity whose verified email is ${input.email}:`,
      invitationUrl,
      'This invitation is single-use and expires in 14 days.',
    ].join('\n\n');
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO invitations (id, email, token_hash, invited_by_user_id, organization_id, role, scope_organization_id, scope_institution_id, scope_employer_id, expires_at)
        VALUES (${invitationId}::uuid, ${input.email}, ${tokenHash}, ${input.actorUserId}::uuid, ${input.organizationId}::uuid, ${input.role}, ${input.organizationId}::uuid,
                ${input.scopeInstitutionId}::uuid, ${input.scopeEmployerId}::uuid, ${expiresAt})
      `);
      await ensureInvitationNotificationTemplate(tx, input.templateId, input.actorUserId, subject);
      await tx.execute(sql`
        INSERT INTO notification_commands
          (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
        VALUES (${notificationCommandId}::uuid, ${input.actorUserId}::uuid, ${input.templateId}::uuid, 'EMAIL', ${input.legalPurpose},
                ${`invitation:${invitationId}`}, ${JSON.stringify({ invitationId, role: input.role })}::jsonb,
                ${`${input.dedupePrefix}:${input.organizationId}:${input.email}:${input.role}`}, 'PENDING', ${expiresAt}, ${input.correlationId})
      `);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: input.actorUserId, action: 'identity.invitation.created', resourceType: 'invitation', resourceId: invitationId, organizationId: input.organizationId, correlationId: input.correlationId });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'invitation', aggregateId: invitationId, eventType: 'identity.invitation.created', payload: { invitationId }, actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId });
      // The command above is what the automation worker delivers, and the worker is
      // driven by this event -- not by identity.invitation.created, which announces
      // that an invitation exists and has no delivery consumer. Without this line the
      // worker runs, drains the outbox and delivers no invitation at all.
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'notification_command', aggregateId: notificationCommandId, eventType: 'notification.delivery.requested', payload: { commandId: notificationCommandId, templateId: input.templateId, channel: 'EMAIL' }, actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId });
    });
    if (this.invitationMailSink) {
      const delivered = await this.invitationMailSink.send({ toEmail: input.email, subject, textBody, invitationId, correlationId: input.correlationId });
      await this.db.execute(sql`
        UPDATE notification_commands SET state='DISPATCHED' WHERE id=${notificationCommandId}::uuid AND state='PENDING'
      `);
      await this.db.execute(sql`
        UPDATE notification_commands SET state='DELIVERED' WHERE id=${notificationCommandId}::uuid AND state='DISPATCHED'
      `);
      await this.db.execute(sql`
        INSERT INTO notification_delivery_attempts (id, command_id, attempt, provider_kind, provider_reference, outcome)
        VALUES (${this.ids.uuid()}::uuid, ${notificationCommandId}::uuid, 1, 'MAILPIT', ${delivered.providerReference ?? null}, 'SUCCEEDED')
      `);
    }
    return { id: invitationId, notificationCommandId };
  }

  @Post('/institutions/:institutionId/student-imports')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async previewRosterImport(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const filename = bounded(readString(body, 'filename', context.correlationId), 1, 160, context.correlationId);
    const csv = readString(body, 'csv', context.correlationId);
    const rows = parseRosterCsv(csv, context.correlationId);
    const importId = this.ids.uuid();
    const evaluated = await evaluateRosterRows(this.db, id, rows);
    const accepted = evaluated.filter((row) => row.state === 'VALID' || row.state === 'WARNING').length;
    const rejected = evaluated.filter((row) => row.state === 'REJECTED').length;
    const warnings = evaluated.filter((row) => row.state === 'WARNING').length;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO student_roster_imports (id, institution_id, actor_user_id, state, source_filename, row_count, accepted_count, warning_count, rejected_count, correlation_id)
        VALUES (${importId}::uuid, ${id}::uuid, ${context.authorization.principal.userId}::uuid, 'VALIDATED', ${filename}, ${evaluated.length}, ${accepted}, ${warnings}, ${rejected}, ${context.correlationId})
      `);
      for (const row of evaluated) {
        const issuesSql = row.issues.length
          ? sql`ARRAY[${sql.join(row.issues.map((issue) => sql`${issue}`), sql`, `)}]::text[]`
          : sql`ARRAY[]::text[]`;
        const persistedEmail = row.issues.includes('malformed_email') ? null : row.email;
        await tx.execute(sql`
          INSERT INTO student_roster_import_rows (id, import_id, row_number, state, institution_student_id, full_name, email, department, program, batch, section, department_unit_id, program_unit_id, batch_unit_id, section_unit_id, issues)
          VALUES (${this.ids.uuid()}::uuid, ${importId}::uuid, ${row.rowNumber}, ${row.state}::roster_import_row_state, ${row.institutionStudentId}, ${row.fullName}, ${persistedEmail}, ${row.department}, ${row.program}, ${row.batch}, ${row.section}, ${row.departmentUnitId ?? null}::uuid, ${row.programUnitId ?? null}::uuid, ${row.batchUnitId ?? null}::uuid, ${row.sectionUnitId ?? null}::uuid, ${issuesSql})
        `);
      }
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.roster_import.validated', resourceType: 'student_roster_import', resourceId: importId, organizationId: id, correlationId: context.correlationId, context: { rowCount: evaluated.length, accepted, rejected } });
    });
    return { import: { id: importId, rowCount: evaluated.length, acceptedCount: accepted, warningCount: warnings, rejectedCount: rejected, rows: evaluated }, correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/student-imports/:importId/commit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async commitRosterImport(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('importId') importIdParam: string): Promise<Record<string, unknown>> {
    const context = requireInstitutionAdmin(request, institutionId);
    const id = requireUuid(institutionId, context.correlationId);
    const importId = requireUuid(importIdParam, context.correlationId);
    let committed = 0;
    await this.db.transaction(async (tx) => {
      const importRows = await tx.execute(sql`
        SELECT row_number, institution_student_id, full_name, email, department_unit_id, program_unit_id, batch_unit_id, section_unit_id
        FROM student_roster_import_rows r
        JOIN student_roster_imports i ON i.id=r.import_id
        WHERE r.import_id=${importId}::uuid AND i.institution_id=${id}::uuid AND i.state='VALIDATED' AND r.state='VALID'
        ORDER BY r.row_number
        FOR UPDATE
      `) as QueryResult<{ row_number: number; institution_student_id: string; full_name: string; email: string; department_unit_id: string | null; program_unit_id: string | null; batch_unit_id: string | null; section_unit_id: string | null }>;
      for (const row of importRows.rows) {
        const userId = this.ids.uuid();
        const profileId = this.ids.uuid();
        const relationshipId = this.ids.uuid();
        await tx.execute(sql`INSERT INTO users (id, email, state) VALUES (${userId}::uuid, ${row.email}, 'INVITED')`);
        await tx.execute(sql`
          INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, department_unit_id, program_unit_id, batch_unit_id, section_unit_id, status)
          VALUES (${profileId}::uuid, ${id}::uuid, ${userId}::uuid, ${row.institution_student_id}, ${row.full_name}, ${row.department_unit_id}::uuid, ${row.program_unit_id}::uuid, ${row.batch_unit_id}::uuid, ${row.section_unit_id}::uuid, 'INVITED')
        `);
        await tx.execute(sql`INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from) VALUES (${relationshipId}::uuid, ${id}::uuid, ${userId}::uuid, 'ACTIVE', now())`);
        await tx.execute(sql`UPDATE student_roster_import_rows SET state='COMMITTED', created_profile_id=${profileId}::uuid WHERE import_id=${importId}::uuid AND row_number=${row.row_number}`);
        await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'institution_student_profile', aggregateId: profileId, eventType: 'institution.student_profile.created', payload: { profileId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
        // One invitation and one delivery event per committed row; nothing is sent inside the import.
        await createStudentInvitation(tx, { invitationId: this.ids.uuid(), institutionId: id, studentUserId: userId, email: row.email,
          invitedByUserId: context.authorization.principal.userId, outboxEventId: this.ids.uuid(), auditId: this.ids.uuid(), correlationId: context.correlationId });
        committed += 1;
      }
      await tx.execute(sql`UPDATE student_roster_imports SET state='COMMITTED', committed_at=now() WHERE id=${importId}::uuid AND institution_id=${id}::uuid AND state='VALIDATED'`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.roster_import.committed', resourceType: 'student_roster_import', resourceId: importId, organizationId: id, correlationId: context.correlationId, context: { committed } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'student_roster_import', aggregateId: importId, eventType: 'institution.roster_import.committed', payload: { importId }, actorUserId: context.authorization.principal.userId, organizationId: id, correlationId: context.correlationId });
    });
    return { import: { id: importId, committedCount: committed }, correlationId: context.correlationId };
  }
}

function requireOperations(request: ProtectedHttpRequest): ReturnType<typeof requireTrustedAuthorization> {
  const context = requireTrustedAuthorization(request);
  if (!context.authorization.memberships.some((membership) => membership.state === 'ACTIVE' && platformMutationRoles.includes(membership.role))) throw forbidden(context.correlationId);
  return context;
}

function requireInstitutionAdmin(request: ProtectedHttpRequest, institutionId: string): ReturnType<typeof requireTrustedAuthorization> {
  return requireInstitutionRole(request, institutionId, institutionAdminRoles);
}

function requireInstitutionStaff(request: ProtectedHttpRequest, institutionId: string): ReturnType<typeof requireTrustedAuthorization> {
  return requireInstitutionRole(request, institutionId, institutionStaffRoles);
}

function requireInstitutionRole(request: ProtectedHttpRequest, institutionId: string, roles: readonly string[]): ReturnType<typeof requireTrustedAuthorization> {
  const context = requireTrustedAuthorization(request);
  const id = requireUuid(institutionId, context.correlationId);
  if (!context.authorization.memberships.some((membership) => (
    membership.organizationId === id
    && membership.scope.organizationId === id
    && membership.scope.institutionId === id
    && membership.state === 'ACTIVE'
    && roles.includes(membership.role)
  ))) throw forbidden(context.correlationId);
  return context;
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

function conflict(code: string, correlationId: string, field?: string): ConflictException {
  return new ConflictException(safeOperationError(code, correlationId, field));
}

function badRequest(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException(safeOperationError(code, correlationId, field));
}

function safeOperationError(code: string, correlationId: string, field?: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string; readonly field?: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } };
}

function validateDateWindow(academicStartDate: string | null | undefined, expectedGraduationDate: string | null | undefined, correlationId: string): void {
  if (academicStartDate && expectedGraduationDate && expectedGraduationDate < academicStartDate) {
    throw badRequest('INVALID_ACADEMIC_DATE_WINDOW', correlationId, 'expectedGraduationDate');
  }
}

async function validateStudentUnitScope(
  db: PersistenceDb,
  institutionId: string,
  input: { readonly departmentUnitId?: string | null; readonly programUnitId?: string | null; readonly batchUnitId?: string | null; readonly sectionUnitId?: string | null },
  correlationId: string,
): Promise<void> {
  const checks: readonly { readonly field: 'departmentUnitId' | 'programUnitId' | 'batchUnitId' | 'sectionUnitId'; readonly kind: UnitKind }[] = [
    { field: 'departmentUnitId', kind: 'DEPARTMENT' },
    { field: 'programUnitId', kind: 'PROGRAM' },
    { field: 'batchUnitId', kind: 'BATCH' },
    { field: 'sectionUnitId', kind: 'SECTION' },
  ];
  for (const check of checks) {
    const value = input[check.field];
    if (!value) continue;
    const found = await db.execute(sql`
      SELECT id
      FROM institution_units
      WHERE id=${value}::uuid AND institution_id=${institutionId}::uuid AND kind=${check.kind}
      LIMIT 1
    `) as QueryResult<{ id: string }>;
    if (!found.rows[0]) throw badRequest('INVALID_ACADEMIC_UNIT_SCOPE', correlationId, check.field);
  }
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function readOrganizationInput(body: unknown, requireKind: boolean, correlationId: string): { kind?: OrganizationKind; legalName?: string; profile?: Record<string, string | null> } {
  const source = requireObject(body, 'request');
  const kindValue = source.kind;
  const kind = typeof kindValue === 'string' ? readEnum(kindValue, ['INSTITUTION', 'EMPLOYER'], correlationId) : undefined;
  if (requireKind && !kind) throw forbidden(correlationId);
  const legalName = typeof source.legalName === 'string' ? bounded(source.legalName.trim(), 1, 180, correlationId) : undefined;
  if (requireKind && !legalName) throw forbidden(correlationId);
  const hasProfile = Object.hasOwn(source, 'profile') || requireKind;
  const profile = hasProfile ? requireObject(source.profile ?? {}, 'profile') : undefined;
  const normalizedProfile: Record<string, string | null> = {
    displayName: optionalBounded(profile?.displayName, 160, correlationId),
    websiteUrl: normalizeUrl(profile?.websiteUrl, correlationId),
    countryCode: normalizeCountry(profile?.countryCode, requireKind, correlationId),
    stateOrProvince: optionalBounded(profile?.stateOrProvince, 120, correlationId),
    city: optionalBounded(profile?.city, 120, correlationId),
    postalCode: optionalBounded(profile?.postalCode, 32, correlationId),
    addressLine1: optionalBounded(profile?.addressLine1, 180, correlationId),
    addressLine2: optionalBounded(profile?.addressLine2, 180, correlationId),
    primaryContactEmail: typeof profile?.primaryContactEmail === 'string' && profile.primaryContactEmail.trim() ? normalizeEmail(profile.primaryContactEmail, correlationId) : null,
    institutionType: typeof profile?.institutionType === 'string' && profile.institutionType.trim() ? readEnum(profile.institutionType, ['UNIVERSITY', 'ENGINEERING_COLLEGE', 'ARTS_SCIENCE_COLLEGE', 'BUSINESS_SCHOOL', 'POLYTECHNIC', 'OTHER'], correlationId) : null,
  };
  return { ...(kind ? { kind } : {}), ...(legalName ? { legalName } : {}), ...(hasProfile ? { profile: normalizedProfile } : {}) };
}

async function upsertOrganizationProfile(db: PersistenceDb, organizationId: string, profile: Record<string, string | null>): Promise<void> {
  const countryCode = profile.countryCode ?? 'IN';
  await db.execute(sql`
    INSERT INTO organization_profiles (organization_id, display_name, website_url, country_code, state_or_province, city, postal_code, address_line_1, address_line_2, primary_contact_email, institution_type)
    VALUES (${organizationId}::uuid, ${profile.displayName}, ${profile.websiteUrl}, ${countryCode}, ${profile.stateOrProvince}, ${profile.city}, ${profile.postalCode}, ${profile.addressLine1}, ${profile.addressLine2}, ${profile.primaryContactEmail}, ${profile.institutionType}::institution_type)
    ON CONFLICT (organization_id) DO UPDATE SET
      display_name=EXCLUDED.display_name,
      website_url=EXCLUDED.website_url,
      country_code=EXCLUDED.country_code,
      state_or_province=EXCLUDED.state_or_province,
      city=EXCLUDED.city,
      postal_code=EXCLUDED.postal_code,
      address_line_1=EXCLUDED.address_line_1,
      address_line_2=EXCLUDED.address_line_2,
      primary_contact_email=EXCLUDED.primary_contact_email,
      institution_type=EXCLUDED.institution_type,
      updated_at=now()
  `);
}

async function ensureInvitationNotificationTemplate(db: PersistenceDb, templateId: string, actorUserId: string, subject: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
    VALUES (${templateId}::uuid, ${templateId === adminInvitationTemplateId ? 'organization-admin-invitation' : 'institution-staff-invitation'},
            1, 'en-IN', ${subject}, 'Invitation link is rendered only in the ephemeral local/test delivery sink.', ${actorUserId}::uuid, now())
    ON CONFLICT (stable_key, version, locale) DO NOTHING
  `);
}

async function writeAudit(db: PersistenceDb, input: { id: string; actorUserId: string; action: string; resourceType: string; resourceId: string; organizationId: string; correlationId: string; context?: Record<string, unknown> }): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${input.context ?? {}}::jsonb)
  `);
}

async function writeOutbox(db: PersistenceDb, input: { id: string; aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; actorUserId: string; organizationId: string; correlationId: string }): Promise<void> {
  validateOutboxWriteInput({ ...input, eventVersion: 1 });
  await db.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${input.id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${input.payload}::jsonb, ${input.actorUserId}::uuid, ${input.organizationId}::uuid, ${input.correlationId})
  `);
}

function isAllowedVerificationTransition(from: VerificationState, to: VerificationState): boolean {
  return (
    (from === 'PENDING' && to === 'UNDER_REVIEW')
    || (from === 'UNDER_REVIEW' && ['VERIFIED', 'REJECTED'].includes(to))
    || (from === 'VERIFIED' && to === 'SUSPENDED')
    || (from === 'SUSPENDED' && ['UNDER_REVIEW', 'VERIFIED'].includes(to))
  );
}

function readStudentInput(body: unknown, correlationId: string): { institutionStudentId: string; fullName: string; email: string; departmentUnitId?: string; programUnitId?: string; batchUnitId?: string; sectionUnitId?: string; academicStartDate?: string; expectedGraduationDate?: string } {
  const source = requireObject(body, 'student');
  const departmentUnitId = readOptionalUuid(source, 'departmentUnitId', correlationId);
  const programUnitId = readOptionalUuid(source, 'programUnitId', correlationId);
  const batchUnitId = readOptionalUuid(source, 'batchUnitId', correlationId);
  const sectionUnitId = readOptionalUuid(source, 'sectionUnitId', correlationId);
  const academicStartDate = readOptionalDate(source, 'academicStartDate', correlationId);
  const expectedGraduationDate = readOptionalDate(source, 'expectedGraduationDate', correlationId);
  const input: { institutionStudentId: string; fullName: string; email: string; departmentUnitId?: string; programUnitId?: string; batchUnitId?: string; sectionUnitId?: string; academicStartDate?: string; expectedGraduationDate?: string } = {
    institutionStudentId: bounded(readString(source, 'institutionStudentId', correlationId), 1, 64, correlationId),
    fullName: bounded(readString(source, 'fullName', correlationId), 1, 160, correlationId),
    email: normalizeEmail(readString(source, 'email', correlationId), correlationId),
  };
  if (departmentUnitId) input.departmentUnitId = departmentUnitId;
  if (programUnitId) input.programUnitId = programUnitId;
  if (batchUnitId) input.batchUnitId = batchUnitId;
  if (sectionUnitId) input.sectionUnitId = sectionUnitId;
  if (academicStartDate) input.academicStartDate = academicStartDate;
  if (expectedGraduationDate) input.expectedGraduationDate = expectedGraduationDate;
  return input;
}

function readStudentPatch(body: unknown, correlationId: string): { fullName?: string; departmentUnitId?: string | null; programUnitId?: string | null; batchUnitId?: string | null; sectionUnitId?: string | null; academicStartDate?: string | null; expectedGraduationDate?: string | null } {
  const source = requireObject(body, 'student');
  const patch: { fullName?: string; departmentUnitId?: string | null; programUnitId?: string | null; batchUnitId?: string | null; sectionUnitId?: string | null; academicStartDate?: string | null; expectedGraduationDate?: string | null } = {};
  if (typeof source.fullName === 'string') patch.fullName = bounded(source.fullName, 1, 160, correlationId);
  if ('departmentUnitId' in source) patch.departmentUnitId = source.departmentUnitId === null ? null : readOptionalUuid(source, 'departmentUnitId', correlationId) ?? null;
  if ('programUnitId' in source) patch.programUnitId = source.programUnitId === null ? null : readOptionalUuid(source, 'programUnitId', correlationId) ?? null;
  if ('batchUnitId' in source) patch.batchUnitId = source.batchUnitId === null ? null : readOptionalUuid(source, 'batchUnitId', correlationId) ?? null;
  if ('sectionUnitId' in source) patch.sectionUnitId = source.sectionUnitId === null ? null : readOptionalUuid(source, 'sectionUnitId', correlationId) ?? null;
  if ('academicStartDate' in source) patch.academicStartDate = source.academicStartDate === null ? null : readOptionalDate(source, 'academicStartDate', correlationId) ?? null;
  if ('expectedGraduationDate' in source) patch.expectedGraduationDate = source.expectedGraduationDate === null ? null : readOptionalDate(source, 'expectedGraduationDate', correlationId) ?? null;
  return patch;
}

function readOptionalDateTime(source: unknown, field: string, correlationId: string): string | undefined {
  const object = requireObject(source, field);
  const value = object[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw forbidden(correlationId);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw forbidden(correlationId);
  return parsed.toISOString();
}

interface ParsedRosterRow {
  readonly rowNumber: number;
  readonly institutionStudentId: string;
  readonly fullName: string;
  readonly email: string;
  readonly department: string | null;
  readonly program: string | null;
  readonly batch: string | null;
  readonly section: string | null;
}

interface EvaluatedRosterRow extends ParsedRosterRow {
  readonly state: 'VALID' | 'WARNING' | 'REJECTED';
  readonly issues: readonly string[];
  readonly departmentUnitId: string | null;
  readonly programUnitId: string | null;
  readonly batchUnitId: string | null;
  readonly sectionUnitId: string | null;
}

function parseRosterCsv(csv: string, correlationId: string): readonly ParsedRosterRow[] {
  if (csv.length > 512_000) throw forbidden(correlationId);
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2 || lines.length > 501) throw forbidden(correlationId);
  const header = parseCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const required = ['institution_student_id', 'full_name', 'email', 'department', 'program', 'batch', 'section'];
  if (header.length > 16 || !required.every((column) => header.includes(column))) throw forbidden(correlationId);
  return lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    if (cells.length > 16) throw forbidden(correlationId);
    const row = Object.fromEntries(header.map((column, columnIndex) => [column, sanitizeCsvCell(cells[columnIndex] ?? '')]));
    return {
      rowNumber: index + 2,
      institutionStudentId: row.institution_student_id ?? '',
      fullName: row.full_name ?? '',
      email: row.email ?? '',
      department: row.department || null,
      program: row.program || null,
      batch: row.batch || null,
      section: row.section || null,
    };
  });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function sanitizeCsvCell(value: string): string {
  const trimmed = value.trim();
  return /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : trimmed;
}

async function evaluateRosterRows(db: PersistenceDb, institutionId: string, rows: readonly ParsedRosterRow[]): Promise<readonly EvaluatedRosterRow[]> {
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  const evaluated: EvaluatedRosterRow[] = [];
  const units = await db.execute(sql`SELECT id, kind, lower(name) AS name FROM institution_units WHERE institution_id=${institutionId}::uuid`) as QueryResult<{ id: string; kind: UnitKind; name: string }>;
  const unitNames = {
    DEPARTMENT: new Map(units.rows.filter((unit) => unit.kind === 'DEPARTMENT').map((unit) => [unit.name, unit.id])),
    PROGRAM: new Map(units.rows.filter((unit) => unit.kind === 'PROGRAM').map((unit) => [unit.name, unit.id])),
    BATCH: new Map(units.rows.filter((unit) => unit.kind === 'BATCH').map((unit) => [unit.name, unit.id])),
    SECTION: new Map(units.rows.filter((unit) => unit.kind === 'SECTION').map((unit) => [unit.name, unit.id])),
  };
  for (const row of rows) {
    const issues: string[] = [];
    const normalizedId = row.institutionStudentId.trim();
    const normalizedName = row.fullName.trim();
    const normalizedEmail = row.email.trim().toLowerCase();
    if (!normalizedId) issues.push('missing_student_id');
    if (!normalizedName) issues.push('missing_full_name');
    if (!emailPattern.test(normalizedEmail)) issues.push('malformed_email');
    if (seenIds.has(normalizedId.toLowerCase())) issues.push('duplicate_student_id_in_file');
    if (seenEmails.has(normalizedEmail)) issues.push('duplicate_email_in_file');
    seenIds.add(normalizedId.toLowerCase());
    seenEmails.add(normalizedEmail);
    const departmentUnitId = row.department ? unitNames.DEPARTMENT.get(row.department.toLowerCase()) ?? null : null;
    const programUnitId = row.program ? unitNames.PROGRAM.get(row.program.toLowerCase()) ?? null : null;
    const batchUnitId = row.batch ? unitNames.BATCH.get(row.batch.toLowerCase()) ?? null : null;
    const sectionUnitId = row.section ? unitNames.SECTION.get(row.section.toLowerCase()) ?? null : null;
    if (row.department && !departmentUnitId) issues.push('unknown_department');
    if (row.program && !programUnitId) issues.push('unknown_program');
    if (row.batch && !batchUnitId) issues.push('unknown_batch');
    if (row.section && !sectionUnitId) issues.push('unknown_section');
    const existing = await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM institution_student_profiles WHERE institution_id=${institutionId}::uuid AND lower(institution_student_id)=lower(${normalizedId})) AS student_id_exists,
             EXISTS (SELECT 1 FROM users WHERE lower(email)=lower(${normalizedEmail})) AS email_exists
    `) as QueryResult<{ student_id_exists: boolean; email_exists: boolean }>;
    if (existing.rows[0]?.student_id_exists) issues.push('student_id_already_exists');
    if (existing.rows[0]?.email_exists) issues.push('email_already_exists');
    evaluated.push({
      ...row,
      institutionStudentId: normalizedId,
      fullName: normalizedName,
      email: normalizedEmail,
      state: issues.length ? 'REJECTED' : 'VALID',
      issues,
      departmentUnitId,
      programUnitId,
      batchUnitId,
      sectionUnitId,
    });
  }
  return evaluated;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForbiddenException(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function readString(source: unknown, field: string, correlationId: string): string {
  const object = requireObject(source, field);
  const value = object[field];
  if (typeof value !== 'string' || !value.trim()) throw forbidden(correlationId);
  return value.trim();
}

function readOptionalString(source: unknown, field: string): string | undefined {
  const object = requireObject(source, field);
  const value = object[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalUuid(source: unknown, field: string, correlationId: string): string | undefined {
  const object = requireObject(source, field);
  const value = object[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw forbidden(correlationId);
  return requireUuid(value, correlationId);
}

function readOptionalDate(source: unknown, field: string, correlationId: string): string | undefined {
  const object = requireObject(source, field);
  const value = object[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw forbidden(correlationId);
  return value;
}

function readEnum<T extends string>(value: string, allowed: readonly T[], correlationId: string): T {
  if (!allowed.includes(value as T)) throw forbidden(correlationId);
  return value as T;
}

function bounded(value: string, min: number, max: number, correlationId: string): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw forbidden(correlationId);
  return trimmed;
}

function optionalBounded(value: unknown, max: number, correlationId: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > max) throw forbidden(correlationId);
  return trimmed;
}

function normalizeCountry(value: unknown, required: boolean, correlationId: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    if (required) throw forbidden(correlationId);
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!countryPattern.test(normalized)) throw forbidden(correlationId);
  return normalized;
}

function normalizeUrl(value: unknown, correlationId: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw forbidden(correlationId);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw forbidden(correlationId);
  return parsed.toString();
}

function normalizeEmail(value: string, correlationId: string): string {
  const normalized = value.trim().toLowerCase();
  if (!emailPattern.test(normalized) || normalized.length > 254) throw forbidden(correlationId);
  return normalized;
}

function mapOrganizationRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    legalName: row.legal_name,
    verificationState: row.verification_state,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profile: {
      displayName: row.display_name,
      websiteUrl: row.website_url,
      countryCode: row.country_code,
      stateOrProvince: row.state_or_province,
      city: row.city,
      postalCode: row.postal_code,
      addressLine1: row.address_line_1,
      addressLine2: row.address_line_2,
      primaryContactEmail: row.primary_contact_email,
      institutionType: row.institution_type,
    },
    initialAdminInvitation: row.initial_invitation_id ? { id: row.initial_invitation_id, email: row.initial_invitation_email, state: row.initial_invitation_state } : null,
  };
}

function mapUnitRow(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, institutionId: row.institution_id, kind: row.kind, name: row.name, parentUnitId: row.parent_unit_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapStudentRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    institutionId: row.institution_id,
    studentUserId: row.student_user_id,
    institutionStudentId: row.institution_student_id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    relationship: row.relationship_id ? { id: row.relationship_id, state: row.relationship_state, effectiveFrom: row.effective_from, effectiveTo: row.effective_to } : null,
    units: { departmentUnitId: row.department_unit_id, programUnitId: row.program_unit_id, batchUnitId: row.batch_unit_id, sectionUnitId: row.section_unit_id },
  };
}

function mapUserAccessRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    verifiedEmail: row.email,
    identityLinkStatus: row.identity_linked ? 'LINKED' : 'UNLINKED',
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberships: row.memberships ?? [],
    studentRelationshipCount: Number(row.student_relationship_count ?? 0),
    studentRelationships: row.student_relationships ?? [],
  };
}

function mapInvitationInventoryRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    recipientEmail: row.email,
    organization: row.organization_id ? {
      id: row.organization_id,
      legalName: row.organization_legal_name,
      kind: row.organization_kind,
    } : null,
    role: row.role,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    delivery: row.notification_command_id ? {
      commandId: row.notification_command_id,
      state: row.notification_state,
      destinationRef: row.destination_ref,
      providerKind: row.provider_kind,
      providerReference: row.provider_reference,
      outcome: row.delivery_outcome,
    } : null,
  };
}

function mapStaffInvitationRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    delivery: row.notification_command_id ? {
      commandId: row.notification_command_id,
      state: row.notification_state,
      providerKind: row.provider_kind,
      providerReference: row.provider_reference,
      outcome: row.delivery_outcome,
    } : null,
  };
}

function mapStaffMembershipRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
