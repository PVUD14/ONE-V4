/**
 * The employer's Settings (EMP-16): the employer terms and their acceptance, what ONE keeps and for
 * how long, and the caller's own notification preferences.
 *
 * Design: docs/architecture/employer-terms-and-trust-participation-design.md.
 *
 * Decisions this file carries:
 *  - Reads are `organisation.manage` (§5.1 "company profile, employer terms"): a PENDING or
 *    UNDER_REVIEW employer can read and accept the terms before verification; a SUSPENDED or
 *    REJECTED one cannot. Every employer role reads; only an owner accepts (the goal: "acceptance by
 *    an owner").
 *  - An owner accepts the latest published version only, so nobody accepts text they were not shown
 *    as current. A repeat is answered with the existing record. The acceptance re-reads the
 *    organisation's state under a row lock and commits with its audit row and outbox event.
 *  - The retention section is built from the constants the code enforces, never from prose that can
 *    drift from the behaviour.
 *  - Notification preferences are the caller's own `notification_preferences` row (0004), the same
 *    row every notification consumer already reads, as institution staff have.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DELETION_GRACE_PERIOD_DAYS } from '@planthepath/privacy';
import { MESSAGE_RETENTION_DAYS_AFTER_GRANT } from '@planthepath/persistence/src/application-messages.js';
import { EmployerTermsError, acceptEmployerTerms, readEmployerTermsStatus } from '@planthepath/persistence/src/employer-terms.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_ID_GENERATOR, API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ApiIdGenerator, type ProtectedHttpRequest } from './api-security.js';
import { RESUME_LINK_SECONDS } from './employer-candidate-view.controller.js';
import { assertEmployerState, employerMemberRoles, employerStateRefusal, requireEmployerMembership, type EmployerVerificationState } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ownerRoles = ['EMPLOYER_OWNER'] as const;

/** The schema defaults of notification_preferences (0004), returned when a person has no row yet. */
const preferenceDefaults = { emailEnabled: true, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3 } as const;

interface PreferenceRow extends Record<string, unknown> { email_enabled: boolean; quiet_hours_start_minute: number; quiet_hours_end_minute: number; daily_cap: number }

/** What ONE keeps about candidates for an employer, and for how long — the enforced values. */
export const employerRetentionFacts = {
  accessEndsWhen: ['APPLICATION_CLOSED', 'CANDIDATE_WITHDREW', 'CANDIDATE_DECLINED_NEW_TERMS', 'CANDIDATE_DELETED_ACCOUNT', 'ACCESS_PERIOD_EXPIRED'],
  resumeLinkSeconds: RESUME_LINK_SECONDS,
  messageRetentionDaysAfterAccessEnds: MESSAGE_RETENTION_DAYS_AFTER_GRANT,
  candidateDeletionGraceDays: DELETION_GRACE_PERIOD_DAYS,
  heldForOpenTrustCasesAndLegalHolds: true,
} as const;

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class EmployerSettingsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/employers/:employerId/settings')
  async read(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, employerMemberRoles);
    await assertEmployerState(this.db, employerId, 'organisation.manage', context.correlationId);
    return { settings: await this.load(employerId, context.authorization.principal.userId, isOwner(context, employerId)), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/terms/accept')
  async accept(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, ownerRoles);
    const { correlationId } = context;
    const raw = readBody(body, ['version'], correlationId);
    if (typeof raw.version !== 'string' || !versionPattern.test(raw.version)) throw invalid('EMPLOYER_TERMS_VERSION_INVALID', correlationId);
    const version = raw.version;
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    const actorUserId = context.authorization.principal.userId;

    try {
      await this.db.transaction(async (tx) => {
        // Re-read the state under a row lock: a suspension landing mid-request records nothing.
        const org = await tx.execute(sql`
          SELECT verification_state, active FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER' FOR NO KEY UPDATE
        `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
        const state = org.rows[0];
        if (!state) throw new ForbiddenException(domainError('FORBIDDEN', correlationId));
        const refusal = employerStateRefusal({ verificationState: state.verification_state, active: state.active }, 'organisation.manage');
        if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });
        await acceptEmployerTerms(tx, { employerId, version, actorUserId, correlationId });
      });
    } catch (error) {
      if (error instanceof EmployerTermsError) {
        if (error.code === 'EMPLOYER_TERMS_NOT_PUBLISHED') throw new ConflictException(domainError(error.code, correlationId));
        if (error.code === 'EMPLOYER_TERMS_VERSION_NOT_CURRENT') throw new ConflictException(domainError(error.code, correlationId));
        throw invalid(error.code, correlationId);
      }
      if (error instanceof ForbiddenException) throw error;
      throw invalid('EMPLOYER_TERMS_INVALID', correlationId);
    }
    return { settings: await this.load(employerId, actorUserId, true), correlationId };
  }

  @Post('/employers/:employerId/settings/notification-preferences')
  async setPreferences(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, employerMemberRoles);
    const { correlationId } = context;
    const input = readPreferenceInput(body, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    const userId = context.authorization.principal.userId;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO notification_preferences (user_id) VALUES (${userId}::uuid) ON CONFLICT (user_id) DO NOTHING`);
      const before = await tx.execute(sql`
        SELECT email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap FROM notification_preferences WHERE user_id = ${userId}::uuid FOR UPDATE
      `) as QueryResult<PreferenceRow>;
      const after = await tx.execute(sql`
        UPDATE notification_preferences
        SET email_enabled = coalesce(${input.emailEnabled ?? null}::boolean, email_enabled),
            quiet_hours_start_minute = coalesce(${input.quietHoursStartMinute ?? null}::int, quiet_hours_start_minute),
            quiet_hours_end_minute = coalesce(${input.quietHoursEndMinute ?? null}::int, quiet_hours_end_minute),
            daily_cap = coalesce(${input.dailyCap ?? null}::int, daily_cap),
            updated_at = now()
        WHERE user_id = ${userId}::uuid
        RETURNING email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap
      `) as QueryResult<PreferenceRow>;
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${userId}::uuid, 'user.notification_preferences.updated', 'user', ${userId}, ${employerId}::uuid, 'SUCCESS', ${correlationId},
          ${JSON.stringify({ before: before.rows[0] ? mapPreferences(before.rows[0]) : null, after: mapPreferences(after.rows[0]!) })}::jsonb)
      `);
    });
    return { settings: await this.load(employerId, userId, isOwner(context, employerId)), correlationId };
  }

  private async load(employerId: string, userId: string, owner: boolean): Promise<Record<string, unknown>> {
    const [terms, preferences] = await Promise.all([
      readEmployerTermsStatus(this.db, employerId),
      this.db.execute(sql`
        SELECT email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap FROM notification_preferences WHERE user_id = ${userId}::uuid
      `) as Promise<QueryResult<PreferenceRow>>,
    ]);
    return {
      terms: { ...terms, canAccept: owner && terms.current !== null && !terms.currentVersionAccepted },
      retention: employerRetentionFacts,
      notificationPreferences: preferences.rows[0] ? mapPreferences(preferences.rows[0]) : null,
      notificationDefaults: preferenceDefaults,
    };
  }
}

function isOwner(context: ReturnType<typeof requireEmployerMembership>, employerId: string): boolean {
  return context.authorization.memberships.some((membership) => membership.organizationId === employerId && membership.scope.employerId === employerId
    && membership.state === 'ACTIVE' && membership.role === 'EMPLOYER_OWNER');
}

function mapPreferences(row: PreferenceRow): Record<string, unknown> {
  return { emailEnabled: row.email_enabled, quietHoursStartMinute: row.quiet_hours_start_minute, quietHoursEndMinute: row.quiet_hours_end_minute, dailyCap: row.daily_cap };
}

function readBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw invalid('INVALID_REQUEST', correlationId);
  return raw;
}

function readPreferenceInput(body: unknown, correlationId: string): { emailEnabled?: boolean; quietHoursStartMinute?: number; quietHoursEndMinute?: number; dailyCap?: number } {
  const source = readBody(body, ['emailEnabled', 'quietHoursStartMinute', 'quietHoursEndMinute', 'dailyCap'], correlationId);
  if (!Object.keys(source).length) throw invalid('INVALID_REQUEST', correlationId);
  const result: { emailEnabled?: boolean; quietHoursStartMinute?: number; quietHoursEndMinute?: number; dailyCap?: number } = {};
  if (Object.hasOwn(source, 'emailEnabled')) {
    if (typeof source.emailEnabled !== 'boolean') throw invalid('INVALID_NOTIFICATION_PREFERENCES', correlationId);
    result.emailEnabled = source.emailEnabled;
  }
  const integer = (field: 'quietHoursStartMinute' | 'quietHoursEndMinute' | 'dailyCap', max: number): void => {
    if (!Object.hasOwn(source, field)) return;
    const value = source[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw invalid('INVALID_NOTIFICATION_PREFERENCES', correlationId);
    result[field] = value;
  };
  integer('quietHoursStartMinute', 1439);
  integer('quietHoursEndMinute', 1439);
  integer('dailyCap', 20);
  return result;
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function invalid(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}
