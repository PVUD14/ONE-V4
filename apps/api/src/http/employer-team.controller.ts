/**
 * Employer team management and interviewer invitations (EMP-02, defect D-2).
 *
 * Before EMP-02 an employer could not add anyone through the product: canAssignRole existed
 * in the identity service but no route used it, so the only employer user was the one
 * operations invited. These routes let an employer's owner and admins see their team,
 * invite admins and recruiters, revoke or resend an invitation, and end a membership.
 *
 * Decisions this file carries:
 *  - Team management is the `organisation.manage` action group of requireActiveEmployer
 *    (Appendix 2 §5.1: "company profile, team" is what a PENDING or UNDER_REVIEW employer may
 *    set up before verification). A SUSPENDED or REJECTED employer is refused every team
 *    route, so it cannot invite, resend or even list its team.
 *  - Who may grant what is canAssignRole from the identity service (owner → admin or
 *    recruiter; admin → recruiter). Ending a membership follows the same rule, plus an owner
 *    may end another owner; the last active owner can never be ended.
 *  - Interviewers are invited as recruiters (decision 10.2 #2). ADR-026: interviewer access
 *    comes from interview assignment, and every interviewer is an employer member. There is
 *    no "interviews only" flag; it waits for Divakar's approval.
 *  - Invitations reuse the invitations table (kind STAFF) and the one acceptance path
 *    (/invitations/accept), so acceptance creates the membership with the employer scope.
 *  - Email follows the staff-invitation pattern: sent in-request through the configured
 *    invitation mail sink. Production email is hard gate HG-7; with no sink the invitation is
 *    recorded NOT_CONFIGURED and the response says so. Nothing pretends a message was sent.
 *  - Every write is one transaction with its audit row (and outbox row where an event exists).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { digestInvitationToken, generateInvitationToken } from '@planthepath/identity/src/invitation-token.js';
import { buildInvitationUrl, mailProviderKind, PermanentMailRejection, type InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { canAssignRole } from '../application/identity-organization/services.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { assertEmployerState, employerStateRefusal, requireEmployerMembership, type EmployerVerificationState } from './employer-organisation-state.js';
import { API_INVITATION_MAIL_SINK } from './operations-institution-onboarding.controller.js';

type QueryResult<T> = { rows: T[] };

export const employerTeamRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;
export type EmployerTeamRole = typeof employerTeamRoles[number];
/** Only owners and admins manage the team (§5.1 role matrix). Recruiters are refused. */
const teamManagerRoles: readonly EmployerTeamRole[] = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'];
const roleRank: Readonly<Record<EmployerTeamRole, number>> = { EMPLOYER_OWNER: 3, EMPLOYER_ADMIN: 2, RECRUITER: 1 };

/** Fixed reason codes, so the audit trail is comparable across employers. */
export const teamReasonCodes = {
  revoke: ['SENT_IN_ERROR', 'WRONG_EMAIL', 'WRONG_ROLE', 'NO_LONGER_NEEDED'],
  resend: ['NOT_RECEIVED', 'LINK_EXPIRED', 'LINK_LOST'],
  end: ['LEFT_ORGANISATION', 'ROLE_CHANGE', 'ACCESS_NO_LONGER_NEEDED', 'SECURITY_CONCERN'],
} as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@ \t\r\n]+@[^@ \t\r\n]+\.[^@ \t\r\n]+$/;
const defaultLimit = 50;
const maxLimit = 200;
const teamInvitationTemplateId = '26000000-0000-4000-8000-000000000e02';
const teamInvitationTemplateKey = 'employer-team-invitation';
const invitationSubject = 'ONE employer team invitation';
const roleLabels: Readonly<Record<EmployerTeamRole, string>> = { EMPLOYER_OWNER: 'owner', EMPLOYER_ADMIN: 'admin', RECRUITER: 'recruiter' };

type DeliveryOutcome = 'SENT' | 'NOT_CONFIGURED' | 'FAILED' | 'BOUNCED';

/** Whether an actor may end a membership in this role: the grant rule, plus owner over owner. */
export function mayEndMembership(actorRole: EmployerTeamRole, targetRole: EmployerTeamRole): boolean {
  return canAssignRole(actorRole, targetRole) || (actorRole === 'EMPLOYER_OWNER' && targetRole === 'EMPLOYER_OWNER');
}

@Controller('/api/v1')
export class EmployerTeamController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_INVITATION_MAIL_SINK) private readonly invitationMailSink?: InvitationMailSink,
  ) {}

  @Get('/employers/:employerId/team')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async team(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actorRole, actorUserId } = this.requireTeamManager(request, employerId);
    rejectUnknown(query ?? {}, ['limit', 'cursor'], correlationId);
    const limit = readLimit(query?.limit, correlationId);
    const cursor = readCursor(query?.cursor, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);

    const members = await this.db.execute(sql`
      SELECT m.id, m.user_id, u.email, m.role, m.state, m.created_at
      FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${employerId}::uuid AND m.scope_employer_id = ${employerId}::uuid
        AND m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER') AND m.state IN ('ACTIVE', 'SUSPENDED')
        AND (${cursor ?? null}::uuid IS NULL OR m.id > ${cursor ?? null}::uuid)
      ORDER BY m.id
      LIMIT ${limit + 1}
    `) as QueryResult<{ id: string; user_id: string; email: string; role: EmployerTeamRole; state: string; created_at: Date | string }>;
    const owners = await this.db.execute(sql`
      SELECT count(*)::int AS active_owners FROM organization_memberships
      WHERE organization_id = ${employerId}::uuid AND scope_employer_id = ${employerId}::uuid
        AND role = 'EMPLOYER_OWNER' AND state = 'ACTIVE'
    `) as QueryResult<{ active_owners: number }>;
    const activeOwners = Number(owners.rows[0]?.active_owners ?? 0);
    const invitations = await this.db.execute(sql`
      SELECT id, email, role, created_at, expires_at, delivery_state, send_count, last_sent_at, (expires_at <= now()) AS expired
      FROM invitations
      WHERE organization_id = ${employerId}::uuid AND kind = 'STAFF'
        AND role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER') AND state = 'PENDING'
      ORDER BY created_at DESC, id
      LIMIT ${maxLimit + 1}
    `) as QueryResult<{ id: string; email: string; role: EmployerTeamRole; created_at: Date | string; expires_at: Date | string; delivery_state: string; send_count: number; last_sent_at: Date | string | null; expired: boolean }>;

    const memberPage = members.rows.slice(0, limit);
    return {
      team: {
        actorRole,
        invitableRoles: employerTeamRoles.filter((role) => canAssignRole(actorRole, role)),
        deliveryConfigured: Boolean(this.invitationMailSink),
        members: memberPage.map((row) => ({
          membershipId: row.id,
          email: row.email,
          role: row.role,
          state: row.state,
          since: iso(row.created_at),
          isSelf: row.user_id === actorUserId,
          canEnd: mayEndMembership(actorRole, row.role) && !(row.role === 'EMPLOYER_OWNER' && activeOwners <= 1),
        })),
        nextCursor: members.rows.length > limit ? memberPage.at(-1)!.id : null,
        invitations: invitations.rows.slice(0, maxLimit).map((row) => {
          const manageable = canAssignRole(actorRole, row.role);
          return {
            id: row.id,
            email: row.email,
            role: row.role,
            state: row.expired ? 'EXPIRED' : 'PENDING',
            createdAt: iso(row.created_at),
            expiresAt: iso(row.expires_at),
            delivery: { state: row.delivery_state, sendCount: Number(row.send_count), lastSentAt: iso(row.last_sent_at) },
            canRevoke: manageable,
            canResend: manageable,
          };
        }),
        invitationsTruncated: invitations.rows.length > maxLimit,
        reasonCodes: teamReasonCodes,
      },
      correlationId,
    };
  }

  @Post('/employers/:employerId/team-invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async invite(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actorRole, actorUserId } = this.requireTeamManager(request, employerId);
    const raw = readObject(body, ['email', 'role'], correlationId);
    const email = readEmail(raw.email, correlationId);
    const role = readRole(raw.role, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    if (!canAssignRole(actorRole, role)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));

    const invitationId = this.ids.uuid();
    const commandId = this.ids.uuid();
    const token = generateInvitationToken();
    const organisationName = await this.db.transaction(async (tx) => {
      await this.lockOrganisationForTeamChange(tx, employerId, correlationId);
      const member = await tx.execute(sql`
        SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${employerId}::uuid AND lower(u.email) = ${email} AND m.state <> 'ENDED'
          AND m.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
        LIMIT 1
      `) as QueryResult<Record<string, unknown>>;
      if (member.rows.length) throw conflict('TEAM_MEMBER_ALREADY_EXISTS', correlationId);
      // A PENDING invitation past its expiry still holds the one-pending-per-address index;
      // close it so a fresh invitation can be issued.
      await tx.execute(sql`
        UPDATE invitations SET state = 'EXPIRED', updated_at = now()
        WHERE organization_id = ${employerId}::uuid AND lower(email) = ${email} AND state = 'PENDING' AND expires_at <= now()
      `);
      const pending = await tx.execute(sql`
        SELECT 1 FROM invitations WHERE organization_id = ${employerId}::uuid AND lower(email) = ${email} AND state = 'PENDING' LIMIT 1
      `) as QueryResult<Record<string, unknown>>;
      if (pending.rows.length) throw conflict('TEAM_INVITATION_ALREADY_PENDING', correlationId);
      const org = await tx.execute(sql`SELECT legal_name FROM organizations WHERE id = ${employerId}::uuid`) as QueryResult<{ legal_name: string }>;

      await tx.execute(sql`
        INSERT INTO invitations (id, kind, email, token_hash, invited_by_user_id, organization_id, role, scope_organization_id, scope_employer_id, expires_at, delivery_state)
        VALUES (${invitationId}::uuid, 'STAFF', ${email}, ${digestInvitationToken(token)}, ${actorUserId}::uuid, ${employerId}::uuid, ${role},
                ${employerId}::uuid, ${employerId}::uuid, now() + interval '14 days', ${this.invitationMailSink ? 'NOT_SENT' : 'NOT_CONFIGURED'})
      `);
      await this.writeDeliveryCommand(tx, { invitationId, commandId, role, actorUserId, employerId, correlationId, dedupeKey: `employer-team:${employerId}:${email}:${invitationId}` });
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId, action: 'identity.invitation.created', resourceType: 'invitation', resourceId: invitationId,
        organizationId: employerId, correlationId, context: { role, source: 'EMPLOYER_TEAM' } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'invitation', aggregateId: invitationId, eventType: 'identity.invitation.created',
        payload: { invitationId }, actorUserId, organizationId: employerId, correlationId });
      return org.rows[0]?.legal_name ?? 'your employer';
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });

    const delivery = await this.deliver({ invitationId, commandId, email, role, token, organisationName, correlationId });
    return { invitation: { id: invitationId, email, role, state: 'PENDING', delivery: { state: delivery } }, correlationId };
  }

  @Post('/employers/:employerId/team-invitations/:invitationId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('invitationId') invitationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actorRole, actorUserId } = this.requireTeamManager(request, employerId);
    const id = readUuid(invitationId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, teamReasonCodes.revoke, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    await this.db.transaction(async (tx) => {
      const invitation = await this.lockTeamInvitation(tx, employerId, id, actorRole, correlationId);
      await tx.execute(sql`
        UPDATE invitations SET state = 'REVOKED', revoked_at = now(), reason_code = ${reasonCode}, updated_at = now()
        WHERE id = ${id}::uuid AND state = 'PENDING'
      `);
      await tx.execute(sql`
        UPDATE notification_commands SET state = 'CANCELLED' WHERE destination_ref = ${`invitation:${id}`} AND state = 'PENDING'
      `);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId, action: 'identity.invitation.revoked', resourceType: 'invitation', resourceId: id,
        organizationId: employerId, correlationId, context: { role: invitation.role, reasonCode, source: 'EMPLOYER_TEAM' } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'invitation', aggregateId: id, eventType: 'identity.invitation.revoked',
        payload: { invitationId: id }, actorUserId, organizationId: employerId, correlationId });
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { invitation: { id, state: 'REVOKED' }, correlationId };
  }

  @Post('/employers/:employerId/team-invitations/:invitationId/resend')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async resend(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('invitationId') invitationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actorRole, actorUserId } = this.requireTeamManager(request, employerId);
    const id = readUuid(invitationId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, teamReasonCodes.resend, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    const commandId = this.ids.uuid();
    // Resending mints a new link and restarts the 14 days: the old link stops working, so a
    // forwarded or leaked earlier email cannot be used after the resend.
    const token = generateInvitationToken();
    const { invitation, organisationName } = await this.db.transaction(async (tx) => {
      await this.lockOrganisationForTeamChange(tx, employerId, correlationId);
      const locked = await this.lockTeamInvitation(tx, employerId, id, actorRole, correlationId);
      await tx.execute(sql`
        UPDATE invitations
        SET token_hash = ${digestInvitationToken(token)}, expires_at = now() + interval '14 days', reason_code = ${reasonCode},
            delivery_state = ${this.invitationMailSink ? 'NOT_SENT' : 'NOT_CONFIGURED'}, updated_at = now()
        WHERE id = ${id}::uuid AND state = 'PENDING'
      `);
      await tx.execute(sql`
        UPDATE notification_commands SET state = 'SUPERSEDED' WHERE destination_ref = ${`invitation:${id}`} AND state = 'PENDING'
      `);
      await this.writeDeliveryCommand(tx, { invitationId: id, commandId, role: locked.role, actorUserId, employerId, correlationId, dedupeKey: `employer-team-resend:${id}:${commandId}` });
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId, action: 'identity.invitation.resent', resourceType: 'invitation', resourceId: id,
        organizationId: employerId, correlationId, context: { role: locked.role, reasonCode, source: 'EMPLOYER_TEAM' } });
      const org = await tx.execute(sql`SELECT legal_name FROM organizations WHERE id = ${employerId}::uuid`) as QueryResult<{ legal_name: string }>;
      return { invitation: locked, organisationName: org.rows[0]?.legal_name ?? 'your employer' };
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });

    const delivery = await this.deliver({ invitationId: id, commandId, email: invitation.email, role: invitation.role, token, organisationName, correlationId });
    return { invitation: { id, email: invitation.email, role: invitation.role, state: 'PENDING', delivery: { state: delivery } }, correlationId };
  }

  @Post('/employers/:employerId/team/:membershipId/end')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async endMembership(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actorRole, actorUserId } = this.requireTeamManager(request, employerId);
    const id = readUuid(membershipId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, teamReasonCodes.end, correlationId);
    await assertEmployerState(this.db, employerId, 'organisation.manage', correlationId);
    const ended = await this.db.transaction(async (tx) => {
      // Owners first, in id order, then the target: every ending takes locks in the same
      // order, so two owners ending each other cannot deadlock, and the last-owner count
      // below cannot be raced.
      const owners = await tx.execute(sql`
        SELECT id FROM organization_memberships
        WHERE organization_id = ${employerId}::uuid AND scope_employer_id = ${employerId}::uuid
          AND role = 'EMPLOYER_OWNER' AND state = 'ACTIVE'
        ORDER BY id FOR UPDATE
      `) as QueryResult<{ id: string }>;
      const target = await tx.execute(sql`
        SELECT id, user_id, role, state FROM organization_memberships
        WHERE id = ${id}::uuid AND organization_id = ${employerId}::uuid AND scope_employer_id = ${employerId}::uuid
          AND role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
        FOR UPDATE
      `) as QueryResult<{ id: string; user_id: string; role: EmployerTeamRole; state: string }>;
      const row = target.rows[0];
      if (!row) throw new NotFoundException(domainError('TEAM_MEMBER_NOT_FOUND', correlationId));
      if (!mayEndMembership(actorRole, row.role)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
      if (row.state === 'ENDED') throw conflict('TEAM_MEMBER_NOT_ACTIVE', correlationId);
      if (row.role === 'EMPLOYER_OWNER' && owners.rows.filter((owner) => owner.id !== row.id).length === 0) throw conflict('TEAM_LAST_OWNER', correlationId);
      await tx.execute(sql`UPDATE organization_memberships SET state = 'ENDED', updated_at = now() WHERE id = ${id}::uuid`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId, action: 'organization_membership.ended', resourceType: 'organization_membership', resourceId: id,
        organizationId: employerId, correlationId, context: { role: row.role, reasonCode, endedUserId: row.user_id, self: row.user_id === actorUserId } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'organization_membership', aggregateId: id, eventType: 'organization_membership.ended',
        payload: { membershipId: id, role: row.role }, actorUserId, organizationId: employerId, correlationId });
      return row;
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { member: { membershipId: id, role: ended.role, state: 'ENDED' }, correlationId };
  }

  /** §5.1 step 1 for owners and admins; the state check follows input validation. */
  private requireTeamManager(request: ProtectedHttpRequest, employerId: string): { readonly correlationId: string; readonly actorRole: EmployerTeamRole; readonly actorUserId: string } {
    const context = requireEmployerMembership(request, employerId, teamManagerRoles);
    // One person can hold two roles in the same employer; they act with the broader one.
    const actorRole = context.authorization.memberships
      .filter((membership) => membership.organizationId === employerId && membership.scope.employerId === employerId
        && membership.state === 'ACTIVE' && (employerTeamRoles as readonly string[]).includes(membership.role))
      .map((membership) => membership.role as EmployerTeamRole)
      .sort((a, b) => roleRank[b] - roleRank[a])[0]!;
    return { correlationId: context.correlationId, actorRole, actorUserId: context.authorization.principal.userId };
  }

  /**
   * Serialise team changes for this employer, so two invitations for one address cannot both
   * pass the checks, and re-read the organisation's state under the lock: an employer
   * suspended between the route's state check and this transaction sends nothing.
   * NO KEY UPDATE, so rows that merely reference the organisation are not blocked.
   */
  private async lockOrganisationForTeamChange(tx: PersistenceDb, employerId: string, correlationId: string): Promise<void> {
    const rows = await tx.execute(sql`
      SELECT verification_state, active FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER' FOR NO KEY UPDATE
    `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
    const row = rows.rows[0];
    if (!row) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    const refusal = employerStateRefusal({ verificationState: row.verification_state, active: row.active }, 'organisation.manage');
    if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });
  }

  private async lockTeamInvitation(tx: PersistenceDb, employerId: string, invitationId: string, actorRole: EmployerTeamRole, correlationId: string): Promise<{ readonly email: string; readonly role: EmployerTeamRole }> {
    const rows = await tx.execute(sql`
      SELECT email, role, state FROM invitations
      WHERE id = ${invitationId}::uuid AND organization_id = ${employerId}::uuid AND kind = 'STAFF'
        AND role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
      FOR UPDATE
    `) as QueryResult<{ email: string; role: EmployerTeamRole; state: string }>;
    const row = rows.rows[0];
    if (!row) throw new NotFoundException(domainError('TEAM_INVITATION_NOT_FOUND', correlationId));
    if (!canAssignRole(actorRole, row.role)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (row.state !== 'PENDING') throw conflict('TEAM_INVITATION_NOT_PENDING', correlationId);
    return { email: row.email, role: row.role };
  }

  private async writeDeliveryCommand(tx: PersistenceDb, input: { invitationId: string; commandId: string; role: EmployerTeamRole; actorUserId: string; employerId: string; correlationId: string; dedupeKey: string }): Promise<void> {
    await tx.execute(sql`
      INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
      VALUES (${teamInvitationTemplateId}::uuid, ${teamInvitationTemplateKey}, 1, 'en-IN', ${invitationSubject},
              'Invitation link is rendered only in the ephemeral local/test delivery sink.', ${input.actorUserId}::uuid, now())
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO notification_commands
        (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
      VALUES (${input.commandId}::uuid, ${input.actorUserId}::uuid, ${teamInvitationTemplateId}::uuid, 'EMAIL', 'transactional employer team invitation',
              ${`invitation:${input.invitationId}`}, ${JSON.stringify({ invitationId: input.invitationId, role: input.role })}::jsonb,
              ${input.dedupeKey}, 'PENDING', now() + interval '14 days', ${input.correlationId})
    `);
    // Same as the staff pattern: the worker is driven by this event, not by invitation.created.
    await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'notification_command', aggregateId: input.commandId, eventType: 'notification.delivery.requested',
      payload: { commandId: input.commandId, templateId: teamInvitationTemplateId, channel: 'EMAIL' }, actorUserId: input.actorUserId, organizationId: input.employerId, correlationId: input.correlationId });
  }

  /**
   * Send through the configured sink after the invitation is committed. A failed send never
   * undoes the invitation; it is recorded, and the owner can resend.
   */
  private async deliver(input: { invitationId: string; commandId: string; email: string; role: EmployerTeamRole; token: string; organisationName: string; correlationId: string }): Promise<DeliveryOutcome> {
    if (!this.invitationMailSink) return 'NOT_CONFIGURED';
    const providerKind = mailProviderKind(this.invitationMailSink);
    const textBody = [
      `${input.organisationName} has invited you to join its hiring team on ONE as ${roleLabels[input.role] === 'admin' ? 'an admin' : `a ${roleLabels[input.role]}`}.`,
      `Open this invitation link and sign in with the identity whose verified email is ${input.email}:`,
      buildInvitationUrl(input.token),
      'This invitation is single-use and expires in 14 days. If you were not expecting it, you can ignore it.',
    ].join('\n\n');
    try {
      const delivered = await this.invitationMailSink.send({ toEmail: input.email, subject: invitationSubject, textBody, invitationId: input.invitationId, correlationId: input.correlationId });
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE notification_commands SET state = 'DISPATCHED' WHERE id = ${input.commandId}::uuid AND state = 'PENDING'`);
        await tx.execute(sql`UPDATE notification_commands SET state = 'DELIVERED' WHERE id = ${input.commandId}::uuid AND state = 'DISPATCHED'`);
        await tx.execute(sql`
          INSERT INTO notification_delivery_attempts (id, command_id, attempt, provider_kind, provider_reference, outcome)
          VALUES (${this.ids.uuid()}::uuid, ${input.commandId}::uuid, 1, ${providerKind}, ${delivered.providerReference ?? null}, 'SUCCEEDED')
        `);
        await tx.execute(sql`
          UPDATE invitations SET delivery_state = 'SENT', send_count = send_count + 1, last_sent_at = now(), updated_at = now()
          WHERE id = ${input.invitationId}::uuid
        `);
      });
      return 'SENT';
    } catch (error) {
      const bounced = error instanceof PermanentMailRejection;
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE notification_commands SET state = 'DISPATCHED' WHERE id = ${input.commandId}::uuid AND state = 'PENDING'`);
        await tx.execute(sql`UPDATE notification_commands SET state = ${bounced ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE'} WHERE id = ${input.commandId}::uuid AND state = 'DISPATCHED'`);
        await tx.execute(sql`
          INSERT INTO notification_delivery_attempts (id, command_id, attempt, provider_kind, outcome, failure_class)
          VALUES (${this.ids.uuid()}::uuid, ${input.commandId}::uuid, 1, ${providerKind}, ${bounced ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE'}, ${bounced ? 'PERMANENT_REJECTION' : 'SINK_UNAVAILABLE'})
        `);
        await tx.execute(sql`
          UPDATE invitations SET delivery_state = ${bounced ? 'BOUNCED' : 'FAILED'}, bounced_at = ${bounced ? sql`now()` : sql`bounced_at`}, updated_at = now()
          WHERE id = ${input.invitationId}::uuid
        `);
      }).catch(() => undefined);
      return bounced ? 'BOUNCED' : 'FAILED';
    }
  }
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** safeError types only the authentication codes; these are domain codes in the same shape. */
function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function conflict(code: string, correlationId: string): ConflictException {
  return new ConflictException(domainError(code, correlationId));
}

/** HTTP refusals pass through; a unique-index race becomes the same 409; nothing else leaks. */
function mapWriteError(error: unknown, correlationId: string): Error {
  if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) return error;
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  if (code === '23505') return conflict('TEAM_INVITATION_ALREADY_PENDING', correlationId);
  return badRequest('TEAM_CHANGE_REJECTED', correlationId);
}

function rejectUnknown(source: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function readUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value;
}

function readEmail(value: unknown, correlationId: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!emailPattern.test(normalized) || normalized.length > 254) throw badRequest('TEAM_EMAIL_INVALID', correlationId);
  return normalized;
}

function readRole(value: unknown, correlationId: string): EmployerTeamRole {
  if (typeof value !== 'string' || !(employerTeamRoles as readonly string[]).includes(value)) throw badRequest('TEAM_ROLE_INVALID', correlationId);
  return value as EmployerTeamRole;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
  return value;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('TEAM_LIMIT_INVALID', correlationId);
  return parsed;
}

function readCursor(value: unknown, correlationId: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('TEAM_CURSOR_INVALID', correlationId);
  return value;
}

async function writeAudit(tx: PersistenceDb, input: { id: string; actorUserId: string; action: string; resourceType: string; resourceId: string; organizationId: string; correlationId: string; context: Record<string, unknown> }): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS',
            ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

async function writeOutbox(tx: PersistenceDb, input: { id: string; aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; actorUserId: string; organizationId: string; correlationId: string }): Promise<void> {
  validateOutboxWriteInput({ ...input, eventVersion: 1 });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${input.id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.organizationId}::uuid, ${input.correlationId})
  `);
}
