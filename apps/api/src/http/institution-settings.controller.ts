/**
 * Institution settings, programme grading scales, the academic calendar and staff
 * preferences (INST-05, defect I-6).
 *
 * Design: docs/architecture/institution-settings-table-design.md.
 *
 * Decisions this file carries:
 *  - The college profile is two sources. Everything Operations verifies an institution
 *    against (legal name, display name, website, address, contact email, institution type)
 *    is read from organization_profiles and never written here; naming one of those fields
 *    is refused and changes nothing, as EMP-04 does for employers. The college writes only
 *    its own description and placement contact email, in institution_settings.
 *  - Grading scales are per programme with no default. A programme without a scale is
 *    returned with gradingScale null, which every screen shows as NA.
 *  - Owners and admins write; every institution staff role reads. Staff preferences are
 *    the caller's own notification_preferences row (0004), readable and writable by any
 *    institution staff member for themselves only.
 *  - Every write is one transaction with its audit row, carrying before and after values.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTeachingAssignmentSql } from '@planthepath/persistence/src/institution-scope.js';
import { institutionResultScales, loadInstitutionProgrammeScales, loadProgrammeGradingScale, numericScaleMaximum, type InstitutionResultScale } from '@planthepath/persistence/src/institution-grading-scales.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';

type Rows<T> = { rows: T[] };
type TrustedContext = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const formulaStart = /^[=+@-]/;
const adminRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const staffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];

/** What the college's owners and admins write. */
export const institutionEditableFields = ['about', 'placementContactEmail'] as const;
/** What Operations verifies an institution against. Named in a college request, it is refused. */
export const institutionOperationsControlledFields = [
  'legalName', 'displayName', 'websiteUrl', 'countryCode', 'stateOrProvince', 'city', 'postalCode',
  'addressLine1', 'addressLine2', 'primaryContactEmail', 'institutionType',
] as const;
export const academicTermKinds = ['TERM', 'EXAMINATIONS', 'BREAK'] as const;
/** The schema defaults of notification_preferences (0004), returned when a person has no row yet. */
export const notificationPreferenceDefaults = { emailEnabled: true, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3 } as const;

interface Authority {
  readonly context: TrustedContext;
  readonly institutionId: string;
  readonly admin: boolean;
}

interface TermRow extends Record<string, unknown> {
  id: string; name: string; kind: string; starts_on: string; ends_on: string; unit_id: string | null; unit_kind: string | null; unit_name: string | null;
  current: boolean; archived_at: Date | string | null; archive_reason_code: string | null; updated_at: Date | string;
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionSettingsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/institutions/:institutionId/settings')
  async read(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const authority = requireStaff(request, institutionId);
    return { settings: await this.loadSettings(authority), correlationId: authority.context.correlationId };
  }

  @Post('/institutions/:institutionId/settings')
  async update(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const changes = readCollegeChanges(body, context.correlationId);
    const actor = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      const before = await tx.execute(sql`
        SELECT about_text, placement_contact_email FROM institution_settings WHERE institution_id = ${id}::uuid FOR UPDATE
      `) as Rows<{ about_text: string | null; placement_contact_email: string | null }>;
      const current = before.rows[0] ?? { about_text: null, placement_contact_email: null };
      const about = changes.has('about') ? changes.get('about')! : current.about_text;
      const email = changes.has('placementContactEmail') ? changes.get('placementContactEmail')! : current.placement_contact_email;
      await tx.execute(sql`
        INSERT INTO institution_settings (institution_id, about_text, placement_contact_email, updated_by_user_id)
        VALUES (${id}::uuid, ${about}, ${email}, ${actor}::uuid)
        ON CONFLICT (institution_id) DO UPDATE SET about_text = EXCLUDED.about_text, placement_contact_email = EXCLUDED.placement_contact_email,
          updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: actor, action: 'institution.settings.updated', resourceType: 'institution_settings', resourceId: id,
        organizationId: id, correlationId: context.correlationId,
        context: { changedFields: institutionEditableFields.filter((field) => changes.has(field)) },
      });
    });
    return { settings: await this.loadSettings(authority), correlationId: context.correlationId };
  }

  /** Set (create or replace) one programme's grading scale. */
  @Post('/institutions/:institutionId/grading-scales')
  async setScale(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const input = readScaleInput(body, context.correlationId);
    const actor = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      const unit = await tx.execute(sql`
        SELECT id FROM institution_units WHERE id = ${input.programUnitId}::uuid AND institution_id = ${id}::uuid AND kind = 'PROGRAM'
      `) as Rows<{ id: string }>;
      if (!unit.rows[0]) throw invalid('INVALID_GRADING_SCALE_PROGRAMME', context.correlationId, 'programUnitId');
      const before = await tx.execute(sql`
        SELECT result_scale, pass_threshold::text AS pass_threshold FROM institution_grading_scales
        WHERE institution_id = ${id}::uuid AND program_unit_id = ${input.programUnitId}::uuid FOR UPDATE
      `) as Rows<{ result_scale: string; pass_threshold: string | null }>;
      await tx.execute(sql`
        INSERT INTO institution_grading_scales (id, institution_id, program_unit_id, result_scale, pass_threshold, created_by_user_id, updated_by_user_id)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${input.programUnitId}::uuid, ${input.scale}, ${input.passThreshold}::numeric, ${actor}::uuid, ${actor}::uuid)
        ON CONFLICT (institution_id, program_unit_id) DO UPDATE SET result_scale = EXCLUDED.result_scale, pass_threshold = EXCLUDED.pass_threshold,
          updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `);
      const previous = before.rows[0];
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: actor, action: 'institution.grading_scale.set', resourceType: 'institution_unit', resourceId: input.programUnitId,
        organizationId: id, correlationId: context.correlationId,
        context: {
          programUnitId: input.programUnitId,
          before: previous ? { scale: previous.result_scale, passThreshold: previous.pass_threshold === null ? null : Number(previous.pass_threshold) } : null,
          after: { scale: input.scale, passThreshold: input.passThreshold },
        },
      });
    });
    return { gradingScale: await loadProgrammeGradingScale(this.db, id, input.programUnitId), correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/grading-scales/:programUnitId/remove')
  async removeScale(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('programUnitId') programUnitIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const programUnitId = requireUuid(programUnitIdParam, context.correlationId);
    const reasonCode = readReason(readBody(body, new Set(['reasonCode']), context.correlationId).reasonCode, context.correlationId);
    await this.db.transaction(async (tx) => {
      const removed = await tx.execute(sql`
        DELETE FROM institution_grading_scales WHERE institution_id = ${id}::uuid AND program_unit_id = ${programUnitId}::uuid
        RETURNING result_scale, pass_threshold::text AS pass_threshold
      `) as Rows<{ result_scale: string; pass_threshold: string | null }>;
      const previous = removed.rows[0];
      if (!previous) throw new ConflictException(errorBody('GRADING_SCALE_NOT_SET', context.correlationId));
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: context.authorization.principal.userId, action: 'institution.grading_scale.removed', resourceType: 'institution_unit',
        resourceId: programUnitId, organizationId: id, correlationId: context.correlationId,
        context: { reasonCode, programUnitId, before: { scale: previous.result_scale, passThreshold: previous.pass_threshold === null ? null : Number(previous.pass_threshold) } },
      });
    });
    return { gradingScale: null, correlationId: context.correlationId };
  }

  /** The academic calendar, earliest first. Any institution staff member reads it. */
  @Get('/institutions/:institutionId/academic-terms')
  async listTerms(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('state') stateParam?: string,
    @Query('from') fromParam?: string,
    @Query('to') toParam?: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const authority = requireStaff(request, institutionId);
    const { context, institutionId: id } = authority;
    const state = stateParam === undefined || stateParam === '' ? 'LIVE' : stateParam;
    if (!['LIVE', 'ARCHIVED', 'ALL'].includes(state)) throw invalid('INVALID_QUERY', context.correlationId, 'state');
    const from = readQueryDate(fromParam, 'from', context.correlationId);
    const to = readQueryDate(toParam, 'to', context.correlationId);
    if (from && to && to < from) throw invalid('INVALID_QUERY', context.correlationId, 'to');
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    const rows = await this.db.execute(sql`
      ${termSelect(id)}
        AND (${state}::text = 'ALL' OR (${state}::text = 'LIVE' AND t.archived_at IS NULL) OR (${state}::text = 'ARCHIVED' AND t.archived_at IS NOT NULL))
        AND (${from}::date IS NULL OR t.ends_on >= ${from}::date)
        AND (${to}::date IS NULL OR t.starts_on <= ${to}::date)
        AND (${cursor?.[0] ?? null}::date IS NULL OR (t.starts_on, t.id) > (${cursor?.[0] ?? null}::date, ${cursor?.[1] ?? null}::uuid))
      ORDER BY t.starts_on, t.id
      LIMIT ${limit + 1}
    `) as Rows<TermRow>;
    const page = rows.rows.slice(0, limit);
    const units = authority.admin ? await this.db.execute(sql`
      SELECT id, kind::text AS kind, name FROM institution_units
      WHERE institution_id = ${id}::uuid AND kind IN ('PROGRAM', 'BATCH') ORDER BY kind, lower(name), id LIMIT 500
    `) as Rows<{ id: string; kind: string; name: string }> : { rows: [] };
    return {
      terms: page.map(mapTerm),
      nextCursor: rows.rows.length > limit ? encodeCursor([page.at(-1)!.starts_on, page.at(-1)!.id]) : null,
      canEdit: authority.admin,
      options: { kinds: academicTermKinds, units: units.rows },
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/academic-terms')
  async createTerm(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const input = readTermInput(body, true, context.correlationId);
    const termId = this.ids.uuid();
    const actor = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await assertTermUnit(tx, id, input.unitId ?? null, context.correlationId);
      await tx.execute(sql`
        INSERT INTO institution_academic_terms (id, institution_id, name, kind, starts_on, ends_on, unit_id, created_by_user_id, updated_by_user_id)
        VALUES (${termId}::uuid, ${id}::uuid, ${input.name!}, ${input.kind!}, ${input.startsOn!}::date, ${input.endsOn!}::date, ${input.unitId ?? null}::uuid, ${actor}::uuid, ${actor}::uuid)
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: actor, action: 'institution.academic_term.created', resourceType: 'institution_academic_term', resourceId: termId,
        organizationId: id, correlationId: context.correlationId, context: { after: input },
      });
    }).catch((error: unknown) => { throw mapTermWriteError(error, context.correlationId); });
    return { term: mapTerm(await this.loadTerm(id, termId)), correlationId: context.correlationId };
  }

  @Patch('/institutions/:institutionId/academic-terms/:termId')
  async updateTerm(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('termId') termIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const termId = requireUuid(termIdParam, context.correlationId);
    const input = readTermInput(body, false, context.correlationId);
    const actor = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT name, kind, starts_on::text AS starts_on, ends_on::text AS ends_on, unit_id, archived_at
        FROM institution_academic_terms WHERE id = ${termId}::uuid AND institution_id = ${id}::uuid FOR UPDATE
      `) as Rows<{ name: string; kind: string; starts_on: string; ends_on: string; unit_id: string | null; archived_at: Date | null }>;
      const current = found.rows[0];
      if (!current) throw forbidden(context.correlationId);
      if (current.archived_at) throw new ConflictException(errorBody('ACADEMIC_TERM_ARCHIVED', context.correlationId));
      const next = {
        name: input.name ?? current.name,
        kind: input.kind ?? current.kind,
        startsOn: input.startsOn ?? current.starts_on,
        endsOn: input.endsOn ?? current.ends_on,
        unitId: input.unitId === undefined ? current.unit_id : input.unitId,
      };
      validateWindow(next.startsOn, next.endsOn, context.correlationId);
      await assertTermUnit(tx, id, next.unitId, context.correlationId);
      await tx.execute(sql`
        UPDATE institution_academic_terms
        SET name = ${next.name}, kind = ${next.kind}, starts_on = ${next.startsOn}::date, ends_on = ${next.endsOn}::date, unit_id = ${next.unitId}::uuid,
            updated_by_user_id = ${actor}::uuid, updated_at = now()
        WHERE id = ${termId}::uuid
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: actor, action: 'institution.academic_term.updated', resourceType: 'institution_academic_term', resourceId: termId,
        organizationId: id, correlationId: context.correlationId,
        context: { before: { name: current.name, kind: current.kind, startsOn: current.starts_on, endsOn: current.ends_on, unitId: current.unit_id }, after: next },
      });
    }).catch((error: unknown) => { throw mapTermWriteError(error, context.correlationId); });
    return { term: mapTerm(await this.loadTerm(id, termId)), correlationId: context.correlationId };
  }

  @Post('/institutions/:institutionId/academic-terms/:termId/archive')
  async archiveTerm(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('termId') termIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const authority = requireAdmin(request, institutionId);
    const { context, institutionId: id } = authority;
    const termId = requireUuid(termIdParam, context.correlationId);
    const reasonCode = readReason(readBody(body, new Set(['reasonCode']), context.correlationId).reasonCode, context.correlationId);
    const actor = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT archived_at FROM institution_academic_terms WHERE id = ${termId}::uuid AND institution_id = ${id}::uuid FOR UPDATE
      `) as Rows<{ archived_at: Date | null }>;
      if (!found.rows[0]) throw forbidden(context.correlationId);
      if (found.rows[0].archived_at) throw new ConflictException(errorBody('ACADEMIC_TERM_ARCHIVED', context.correlationId));
      await tx.execute(sql`
        UPDATE institution_academic_terms
        SET archived_at = now(), archived_by_user_id = ${actor}::uuid, archive_reason_code = ${reasonCode}, updated_by_user_id = ${actor}::uuid, updated_at = now()
        WHERE id = ${termId}::uuid
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: actor, action: 'institution.academic_term.archived', resourceType: 'institution_academic_term', resourceId: termId,
        organizationId: id, correlationId: context.correlationId, context: { reasonCode },
      });
    });
    return { term: mapTerm(await this.loadTerm(id, termId)), correlationId: context.correlationId };
  }

  /** The caller's own staff profile and notification preferences in this institution. */
  @Get('/institutions/:institutionId/staff-profile')
  async staffProfile(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const authority = requireStaff(request, institutionId);
    return { staffProfile: await this.loadStaffProfile(authority), correlationId: authority.context.correlationId };
  }

  @Post('/institutions/:institutionId/staff-profile/notification-preferences')
  async setPreferences(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const authority = requireStaff(request, institutionId);
    const { context, institutionId: id } = authority;
    const input = readPreferenceInput(body, context.correlationId);
    const userId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO notification_preferences (user_id) VALUES (${userId}::uuid) ON CONFLICT (user_id) DO NOTHING`);
      const before = await tx.execute(sql`
        SELECT email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap FROM notification_preferences WHERE user_id = ${userId}::uuid FOR UPDATE
      `) as Rows<PreferenceRow>;
      const after = await tx.execute(sql`
        UPDATE notification_preferences
        SET email_enabled = coalesce(${input.emailEnabled ?? null}::boolean, email_enabled),
            quiet_hours_start_minute = coalesce(${input.quietHoursStartMinute ?? null}::int, quiet_hours_start_minute),
            quiet_hours_end_minute = coalesce(${input.quietHoursEndMinute ?? null}::int, quiet_hours_end_minute),
            daily_cap = coalesce(${input.dailyCap ?? null}::int, daily_cap),
            updated_at = now()
        WHERE user_id = ${userId}::uuid
        RETURNING email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap
      `) as Rows<PreferenceRow>;
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId: userId, action: 'user.notification_preferences.updated', resourceType: 'user', resourceId: userId,
        organizationId: id, correlationId: context.correlationId,
        context: { before: before.rows[0] ? mapPreferences(before.rows[0]) : null, after: mapPreferences(after.rows[0]!) },
      });
    });
    return { staffProfile: await this.loadStaffProfile(authority), correlationId: context.correlationId };
  }

  private async loadSettings(authority: Authority): Promise<Record<string, unknown>> {
    const id = authority.institutionId;
    const rows = await this.db.execute(sql`
      SELECT o.legal_name, o.verification_state::text AS verification_state, (p.organization_id IS NOT NULL) AS has_profile,
             p.display_name, p.website_url, p.country_code, p.state_or_province, p.city, p.postal_code, p.address_line_1, p.address_line_2,
             p.primary_contact_email, p.institution_type::text AS institution_type,
             s.about_text, s.placement_contact_email, s.updated_at AS settings_updated_at
      FROM organizations o
      LEFT JOIN organization_profiles p ON p.organization_id = o.id
      LEFT JOIN institution_settings s ON s.institution_id = o.id
      WHERE o.id = ${id}::uuid AND o.kind = 'INSTITUTION'
    `) as Rows<Record<string, string | boolean | Date | null>>;
    const row = rows.rows[0];
    if (!row) throw forbidden(authority.context.correlationId);
    const programmes = await loadInstitutionProgrammeScales(this.db, id);
    return {
      profile: {
        legalName: row.legal_name,
        verificationState: row.verification_state,
        profileSetUp: row.has_profile,
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
      college: {
        about: row.about_text,
        placementContactEmail: row.placement_contact_email,
        updatedAt: row.settings_updated_at ? new Date(row.settings_updated_at as Date | string).toISOString() : null,
      },
      programmes,
      canEdit: authority.admin,
      editableFields: institutionEditableFields,
      operationsControlledFields: institutionOperationsControlledFields,
      options: { scales: institutionResultScales, numericScaleMaximum },
    };
  }

  private async loadStaffProfile(authority: Authority): Promise<Record<string, unknown>> {
    const id = authority.institutionId;
    const userId = authority.context.authorization.principal.userId;
    const [user, memberships, assignments, preferences] = await Promise.all([
      this.db.execute(sql`
        SELECT u.email, coalesce(p.display_name, o.legal_name) AS institution_name
        FROM users u, organizations o LEFT JOIN organization_profiles p ON p.organization_id = o.id
        WHERE u.id = ${userId}::uuid AND o.id = ${id}::uuid
      `) as Promise<Rows<{ email: string; institution_name: string }>>,
      this.db.execute(sql`
        SELECT m.role, dept.name AS department_name, batch.name AS batch_name
        FROM organization_memberships m
        LEFT JOIN institution_units dept ON dept.id = m.scope_department_unit_id
        LEFT JOIN institution_units batch ON batch.id = m.scope_batch_unit_id
        WHERE m.user_id = ${userId}::uuid AND m.organization_id = ${id}::uuid AND m.scope_institution_id = ${id}::uuid AND m.state = 'ACTIVE'
          AND m.role = ANY(${`{${staffRoles.join(',')}}`}::text[])
        ORDER BY m.role
      `) as Promise<Rows<{ role: string; department_name: string | null; batch_name: string | null }>>,
      this.db.execute(sql`
        SELECT unit.name AS unit_name, subject.name AS subject_name, fta.subject_code, fta.academic_term
        FROM faculty_teaching_assignments fta
        JOIN organization_memberships fm ON fm.id = fta.faculty_membership_id
        JOIN institution_units unit ON unit.id = fta.unit_id
        LEFT JOIN exam_subjects subject ON subject.id = fta.subject_id
        WHERE fta.institution_id = ${id}::uuid AND fm.user_id = ${userId}::uuid AND fm.state = 'ACTIVE' AND ${activeTeachingAssignmentSql('fta')}
        ORDER BY unit.name, fta.academic_term, fta.id
        LIMIT 200
      `) as Promise<Rows<{ unit_name: string; subject_name: string | null; subject_code: string | null; academic_term: string }>>,
      this.db.execute(sql`
        SELECT email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap FROM notification_preferences WHERE user_id = ${userId}::uuid
      `) as Promise<Rows<PreferenceRow>>,
    ]);
    const person = user.rows[0];
    if (!person) throw forbidden(authority.context.correlationId);
    return {
      email: person.email,
      institutionName: person.institution_name,
      roles: memberships.rows.map((row) => ({ role: row.role, department: row.department_name, batch: row.batch_name })),
      teachingAssignments: assignments.rows.map((row) => ({ unit: row.unit_name, subject: row.subject_name ?? row.subject_code, academicTerm: row.academic_term })),
      notificationPreferences: preferences.rows[0] ? mapPreferences(preferences.rows[0]) : null,
      notificationDefaults: notificationPreferenceDefaults,
      // ONE sends institution staff no reminder emails yet; the screen says so.
      staffRemindersLive: false,
    };
  }

  private async loadTerm(institutionId: string, termId: string): Promise<TermRow> {
    const rows = await this.db.execute(sql`${termSelect(institutionId)} AND t.id = ${termId}::uuid`) as Rows<TermRow>;
    return rows.rows[0]!;
  }
}

interface PreferenceRow extends Record<string, unknown> { email_enabled: boolean; quiet_hours_start_minute: number; quiet_hours_end_minute: number; daily_cap: number }

function mapPreferences(row: PreferenceRow): Record<string, unknown> {
  return { emailEnabled: row.email_enabled, quietHoursStartMinute: row.quiet_hours_start_minute, quietHoursEndMinute: row.quiet_hours_end_minute, dailyCap: row.daily_cap };
}

function termSelect(institutionId: string) {
  return sql`
    SELECT t.id, t.name, t.kind, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, t.unit_id, unit.kind::text AS unit_kind, unit.name AS unit_name,
           (t.archived_at IS NULL AND t.starts_on <= current_date AND t.ends_on >= current_date) AS current,
           t.archived_at, t.archive_reason_code, t.updated_at
    FROM institution_academic_terms t
    LEFT JOIN institution_units unit ON unit.id = t.unit_id
    WHERE t.institution_id = ${institutionId}::uuid`;
}

function mapTerm(row: TermRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    unit: row.unit_id ? { id: row.unit_id, kind: row.unit_kind, name: row.unit_name } : null,
    current: row.current,
    archived: row.archived_at !== null,
    archiveReasonCode: row.archive_reason_code,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function assertTermUnit(db: PersistenceDb, institutionId: string, unitId: string | null, correlationId: string): Promise<void> {
  if (!unitId) return;
  const unit = await db.execute(sql`
    SELECT id FROM institution_units WHERE id = ${unitId}::uuid AND institution_id = ${institutionId}::uuid AND kind IN ('PROGRAM', 'BATCH')
  `) as Rows<{ id: string }>;
  if (!unit.rows[0]) throw invalid('INVALID_ACADEMIC_TERM_UNIT', correlationId, 'unitId');
}

function membershipsIn(context: TrustedContext, id: string) {
  return context.authorization.memberships.filter((membership) => membership.state === 'ACTIVE'
    && membership.organizationId === id && membership.scope.organizationId === id && membership.scope.institutionId === id);
}

function requireStaff(request: ProtectedHttpRequest, institutionId: string): Authority {
  const context = requireTrustedAuthorization(request);
  const id = requireUuid(institutionId, context.correlationId);
  const memberships = membershipsIn(context, id);
  if (!memberships.some((membership) => staffRoles.includes(membership.role))) throw forbidden(context.correlationId);
  return { context, institutionId: id, admin: memberships.some((membership) => adminRoles.includes(membership.role)) };
}

function requireAdmin(request: ProtectedHttpRequest, institutionId: string): Authority {
  const authority = requireStaff(request, institutionId);
  if (!authority.admin) throw forbidden(authority.context.correlationId);
  return authority;
}

/**
 * Parse the college's change set. Operations-controlled fields are refused by name before
 * anything else, so "change our display name" always gets the same plain refusal.
 */
function readCollegeChanges(body: unknown, correlationId: string): Map<typeof institutionEditableFields[number], string | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  const source = body as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some((key) => (institutionOperationsControlledFields as readonly string[]).includes(key))) {
    throw new ForbiddenException(errorBody('INSTITUTION_PROFILE_FIELD_OPERATIONS_CONTROLLED', correlationId));
  }
  const unknownKey = keys.find((key) => !(institutionEditableFields as readonly string[]).includes(key));
  if (unknownKey) throw invalid('UNKNOWN_FIELD', correlationId, unknownKey);
  if (!keys.length) throw invalid('INVALID_REQUEST', correlationId);
  const changes = new Map<typeof institutionEditableFields[number], string | null>();
  for (const field of institutionEditableFields) {
    if (!Object.hasOwn(source, field)) continue;
    const value = source[field];
    if (value !== null && typeof value !== 'string') throw invalid('INSTITUTION_SETTINGS_INVALID', correlationId, field);
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) { changes.set(field, null); continue; }
    if (field === 'about' && (text.length > 2000 || formulaStart.test(text))) throw invalid('INSTITUTION_SETTINGS_INVALID', correlationId, field);
    if (field === 'placementContactEmail' && (text.length > 254 || !emailPattern.test(text))) throw invalid('INSTITUTION_SETTINGS_INVALID', correlationId, field);
    changes.set(field, field === 'placementContactEmail' ? text.toLowerCase() : text);
  }
  return changes;
}

function readScaleInput(body: unknown, correlationId: string): { programUnitId: string; scale: InstitutionResultScale; passThreshold: number | null } {
  const source = readBody(body, new Set(['programUnitId', 'scale', 'passThreshold']), correlationId);
  const programUnitId = source.programUnitId;
  if (typeof programUnitId !== 'string' || !uuidPattern.test(programUnitId)) throw invalid('INVALID_GRADING_SCALE', correlationId, 'programUnitId');
  const scale = source.scale;
  if (typeof scale !== 'string' || !(institutionResultScales as readonly string[]).includes(scale)) throw invalid('INVALID_GRADING_SCALE', correlationId, 'scale');
  const threshold = source.passThreshold;
  const maximum = numericScaleMaximum[scale as InstitutionResultScale];
  if (threshold === undefined || threshold === null) return { programUnitId: programUnitId.toLowerCase(), scale: scale as InstitutionResultScale, passThreshold: null };
  if (maximum === undefined) throw invalid('GRADING_SCALE_THRESHOLD_NOT_APPLICABLE', correlationId, 'passThreshold');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > maximum
    || Math.round(threshold * 1000) !== threshold * 1000) throw invalid('INVALID_GRADING_SCALE', correlationId, 'passThreshold');
  return { programUnitId: programUnitId.toLowerCase(), scale: scale as InstitutionResultScale, passThreshold: threshold };
}

function readTermInput(body: unknown, create: boolean, correlationId: string): { name?: string; kind?: string; startsOn?: string; endsOn?: string; unitId?: string | null } {
  const source = readBody(body, new Set(['name', 'kind', 'startsOn', 'endsOn', 'unitId']), correlationId);
  if (!create && !Object.keys(source).length) throw invalid('INVALID_REQUEST', correlationId);
  const result: { name?: string; kind?: string; startsOn?: string; endsOn?: string; unitId?: string | null } = {};
  if (create || Object.hasOwn(source, 'name')) {
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    if (!name || name.length > 60 || formulaStart.test(name)) throw invalid('INVALID_ACADEMIC_TERM', correlationId, 'name');
    result.name = name;
  }
  if (create || Object.hasOwn(source, 'kind')) {
    if (typeof source.kind !== 'string' || !(academicTermKinds as readonly string[]).includes(source.kind)) throw invalid('INVALID_ACADEMIC_TERM', correlationId, 'kind');
    result.kind = source.kind;
  }
  for (const field of ['startsOn', 'endsOn'] as const) {
    if (!create && !Object.hasOwn(source, field)) continue;
    const value = source[field];
    if (typeof value !== 'string' || !isRealDate(value)) throw invalid('INVALID_ACADEMIC_TERM', correlationId, field);
    result[field] = value;
  }
  if (Object.hasOwn(source, 'unitId')) {
    const unitId = source.unitId;
    if (unitId === null || unitId === '') result.unitId = null;
    else if (typeof unitId === 'string' && uuidPattern.test(unitId)) result.unitId = unitId.toLowerCase();
    else throw invalid('INVALID_ACADEMIC_TERM_UNIT', correlationId, 'unitId');
  }
  if (result.startsOn && result.endsOn) validateWindow(result.startsOn, result.endsOn, correlationId);
  return result;
}

function validateWindow(startsOn: string, endsOn: string, correlationId: string): void {
  if (endsOn < startsOn) throw invalid('INVALID_ACADEMIC_TERM_WINDOW', correlationId, 'endsOn');
  const days = (Date.parse(endsOn + 'T00:00:00Z') - Date.parse(startsOn + 'T00:00:00Z')) / 86_400_000;
  if (days > 400) throw invalid('INVALID_ACADEMIC_TERM_WINDOW', correlationId, 'endsOn');
}

function readPreferenceInput(body: unknown, correlationId: string): { emailEnabled?: boolean; quietHoursStartMinute?: number; quietHoursEndMinute?: number; dailyCap?: number } {
  const source = readBody(body, new Set(['emailEnabled', 'quietHoursStartMinute', 'quietHoursEndMinute', 'dailyCap']), correlationId);
  if (!Object.keys(source).length) throw invalid('INVALID_REQUEST', correlationId);
  const result: { emailEnabled?: boolean; quietHoursStartMinute?: number; quietHoursEndMinute?: number; dailyCap?: number } = {};
  if (Object.hasOwn(source, 'emailEnabled')) {
    if (typeof source.emailEnabled !== 'boolean') throw invalid('INVALID_NOTIFICATION_PREFERENCES', correlationId, 'emailEnabled');
    result.emailEnabled = source.emailEnabled;
  }
  const integer = (field: 'quietHoursStartMinute' | 'quietHoursEndMinute' | 'dailyCap', max: number) => {
    if (!Object.hasOwn(source, field)) return;
    const value = source[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw invalid('INVALID_NOTIFICATION_PREFERENCES', correlationId, field);
    result[field] = value;
  };
  integer('quietHoursStartMinute', 1439);
  integer('quietHoursEndMinute', 1439);
  integer('dailyCap', 20);
  return result;
}

function isRealDate(value: string): boolean {
  return datePattern.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function readQueryDate(value: string | undefined, field: string, correlationId: string): string | null {
  if (value === undefined || value === '') return null;
  if (!isRealDate(value)) throw invalid('INVALID_QUERY', correlationId, field);
  return value;
}

function readBody(body: unknown, allowed: ReadonlySet<string>, correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  const source = body as Record<string, unknown>;
  const unknownKey = Object.keys(source).find((key) => !allowed.has(key));
  if (unknownKey) throw invalid('UNKNOWN_FIELD', correlationId, unknownKey);
  return source;
}

function readReason(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !reasonPattern.test(value)) throw invalid('INVALID_REASON_CODE', correlationId, 'reasonCode');
  return value;
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('INVALID_QUERY', correlationId, 'limit');
  return limit;
}

function readCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && isRealDate(parsed[0])
      && typeof parsed[1] === 'string' && uuidPattern.test(parsed[1])) return [parsed[0], parsed[1]];
  } catch { /* fall through */ }
  throw invalid('INVALID_QUERY', correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

/** HTTP refusals pass through; a duplicate live name is a conflict; anything else is a plain validation failure. */
function mapTermWriteError(error: unknown, correlationId: string): Error {
  if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException) return error;
  if (isUniqueViolation(error)) return new ConflictException(errorBody('ACADEMIC_TERM_NAME_TAKEN', correlationId, 'name'));
  return invalid('INVALID_ACADEMIC_TERM', correlationId);
}

function errorBody(code: string, correlationId: string, field?: string) {
  return { error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } };
}

function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException(errorBody(code, correlationId, field));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

async function writeAudit(db: PersistenceDb, input: { id: string; actorUserId: string; action: string; resourceType: string; resourceId: string; organizationId: string; correlationId: string; context: Record<string, unknown> }): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}
