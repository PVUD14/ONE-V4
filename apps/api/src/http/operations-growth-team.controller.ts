/**
 * Operations → Settings → Growth team (GROWTH-01, ADR-040).
 *
 * A GROWTH_ADMIN holder invites growth people (executives and regional managers) with a
 * required staff type, sets their team and manager, changes their staff type with a reason,
 * and ends their membership. It is a section of Settings, not a navigation item.
 *
 * Decisions this file carries:
 *  - Access is the GROWTH_ADMIN capability (baseline for the super admin, grantable to an
 *    operations admin). A growth person holds no capability, so no route here admits one.
 *  - Nobody administers their own growth membership (pure rule in packages/authorization,
 *    repeated by the database for team rows and staff types).
 *  - Invitations reuse the invitations table (kind STAFF) and the one acceptance path; the
 *    staff type travels on the invitation (the database refuses a growth invitation without
 *    one) and acceptance writes the first growth_staff_types row.
 *  - Email follows the staff-invitation pattern (EMP-02): sent through the configured
 *    invitation mail sink; with none, the invitation is recorded NOT_CONFIGURED and the
 *    response says so. Production email is hard gate HG-7.
 *  - A change of team, manager or type is an end plus a new row; every write is one
 *    transaction with its audit rows and outbox events.
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  canAdministerGrowthTeam,
  growthRoles,
  growthStaffTypes,
  growthTeamReasons,
  growthTeams,
  isGrowthRole,
  isGrowthStaffType,
  isGrowthTeam,
  refuseGrowthTeamChange,
  type GrowthAdministrationRefusal,
  type GrowthRole,
  type GrowthStaffType,
  type GrowthTeam,
} from '@planthepath/authorization/src/index.js';
import { digestInvitationToken, generateInvitationToken } from '@planthepath/identity/src/invitation-token.js';
import { buildInvitationUrl, PermanentMailRejection, type InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { API_INVITATION_MAIL_SINK } from './operations-institution-onboarding.controller.js';

type QueryResult<T> = { rows: T[] };
type Actor = Awaited<ReturnType<typeof loadCallerCapabilityContext>>;
type DeliveryOutcome = 'SENT' | 'NOT_CONFIGURED' | 'FAILED' | 'BOUNCED';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@ \t\r\n]+@[^@ \t\r\n]+\.[^@ \t\r\n]+$/;
const listCap = 200;
const invitationTemplateId = '27000000-0000-4000-8000-000000000091';
const invitationTemplateKey = 'growth-team-invitation';
const invitationSubject = 'ONE Growth team invitation';
const roleLabels: Readonly<Record<GrowthRole, string>> = { GROWTH_EXECUTIVE: 'a growth executive', GROWTH_MANAGER: 'a regional growth manager' };

const refusalStatus: Readonly<Record<GrowthAdministrationRefusal, number>> = {
  FORBIDDEN: 403,
  GROWTH_SELF_CHANGE_REFUSED: 403,
  GROWTH_NOT_A_GROWTH_MEMBERSHIP: 400,
  MEMBERSHIP_NOT_ACTIVE: 409,
};

type TargetRow = { readonly id: string; readonly user_id: string; readonly role: string; readonly state: string; readonly organization_kind: string; readonly organization_id: string };

@Controller('/api/v1/operations/growth-team')
export class OperationsGrowthTeamController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_INVITATION_MAIL_SINK) private readonly invitationMailSink?: InvitationMailSink,
  ) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const members = await this.db.execute(sql`
      SELECT m.id, m.user_id, u.email, m.role, m.state::text AS state, m.created_at
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      JOIN users u ON u.id = m.user_id
      WHERE m.role IN (${roleList()})
      ORDER BY (m.state = 'ACTIVE') DESC, u.email, m.role, m.id
      LIMIT ${listCap + 1}
    `) as QueryResult<{ id: string; user_id: string; email: string; role: GrowthRole; state: string; created_at: Date | string }>;
    const page = members.rows.slice(0, listCap);
    const details = await this.memberDetails(this.db, page.map((row) => row.id));
    const invitations = await this.db.execute(sql`
      SELECT i.id, i.email, i.role, i.growth_staff_type, i.created_at, i.expires_at, i.delivery_state
      FROM invitations i JOIN organizations o ON o.id = i.organization_id AND o.kind = 'PLATFORM'
      WHERE i.kind = 'STAFF' AND i.role IN (${roleList()}) AND i.state = 'PENDING' AND i.expires_at > now()
      ORDER BY i.created_at DESC, i.id
      LIMIT ${listCap}
    `) as QueryResult<{ id: string; email: string; role: GrowthRole; growth_staff_type: GrowthStaffType; created_at: Date | string; expires_at: Date | string; delivery_state: string }>;
    const managers = await this.db.execute(sql`
      SELECT m.id, u.email FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
      WHERE m.role = 'GROWTH_MANAGER' AND m.state = 'ACTIVE'
      ORDER BY u.email, m.id
      LIMIT ${listCap}
    `) as QueryResult<{ id: string; email: string }>;
    return {
      members: page.map((row) => ({
        membershipId: row.id,
        email: row.email,
        role: row.role,
        state: row.state,
        joinedAt: iso(row.created_at),
        isSelf: row.user_id === actor.userId,
        ...(details.get(row.id) ?? { staffType: null, teams: [] }),
      })),
      invitations: invitations.rows.map((row) => ({
        id: row.id, email: row.email, role: row.role, staffType: row.growth_staff_type,
        createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), delivery: { state: row.delivery_state },
      })),
      truncated: members.rows.length > listCap,
      managers: managers.rows.map((row) => ({ membershipId: row.id, email: row.email })),
      vocabulary: { roles: growthRoles, teams: growthTeams, staffTypes: growthStaffTypes, reasons: growthTeamReasons },
      correlationId,
    };
  }

  @Post('/invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async invite(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const raw = readObject(body, ['email', 'role', 'staffType'], correlationId);
    const email = readEmail(raw.email, correlationId);
    if (typeof raw.role !== 'string' || !isGrowthRole(raw.role)) throw badRequest('GROWTH_ROLE_INVALID', correlationId);
    const role = raw.role;
    if (raw.staffType === undefined || raw.staffType === null || raw.staffType === '') throw badRequest('GROWTH_STAFF_TYPE_REQUIRED', correlationId);
    if (!isGrowthStaffType(raw.staffType)) throw badRequest('GROWTH_STAFF_TYPE_INVALID', correlationId);
    const staffType = raw.staffType;

    const invitationId = this.ids.uuid();
    const commandId = this.ids.uuid();
    const token = generateInvitationToken();
    await this.db.transaction(async (tx) => {
      const platform = await tx.execute(sql`
        SELECT id FROM organizations WHERE kind = 'PLATFORM' ORDER BY created_at, id LIMIT 1 FOR NO KEY UPDATE
      `) as QueryResult<{ id: string }>;
      const organizationId = platform.rows[0]?.id;
      if (!organizationId) throw new NotFoundException(domainError('GROWTH_PLATFORM_NOT_FOUND', correlationId));
      const self = await tx.execute(sql`SELECT 1 FROM users WHERE id = ${actor.userId}::uuid AND lower(email) = ${email}`) as QueryResult<unknown>;
      if (self.rows.length) throw new ForbiddenException(domainError('GROWTH_SELF_CHANGE_REFUSED', correlationId));
      const existing = await tx.execute(sql`
        SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId}::uuid AND lower(u.email) = ${email} AND m.role = ${role}
        LIMIT 1
      `) as QueryResult<unknown>;
      // Any state: a person whose membership in this role ended is reinstated by an operator,
      // not by a second invitation that acceptance could not honour.
      if (existing.rows.length) throw conflict('GROWTH_MEMBER_ALREADY_EXISTS', correlationId);
      await tx.execute(sql`
        UPDATE invitations SET state = 'EXPIRED', updated_at = now()
        WHERE organization_id = ${organizationId}::uuid AND lower(email) = ${email} AND state = 'PENDING' AND expires_at <= now()
      `);
      const pending = await tx.execute(sql`
        SELECT 1 FROM invitations WHERE organization_id = ${organizationId}::uuid AND lower(email) = ${email} AND state = 'PENDING' LIMIT 1
      `) as QueryResult<unknown>;
      if (pending.rows.length) throw conflict('GROWTH_INVITATION_ALREADY_PENDING', correlationId);
      await tx.execute(sql`
        INSERT INTO invitations (id, kind, email, token_hash, invited_by_user_id, organization_id, role, scope_organization_id, expires_at, delivery_state, growth_staff_type)
        VALUES (${invitationId}::uuid, 'STAFF', ${email}, ${digestInvitationToken(token)}, ${actor.userId}::uuid, ${organizationId}::uuid, ${role},
                ${organizationId}::uuid, now() + interval '14 days', ${this.invitationMailSink ? 'NOT_SENT' : 'NOT_CONFIGURED'}, ${staffType})
      `);
      await this.writeDeliveryCommand(tx, { invitationId, commandId, role, actorUserId: actor.userId, organizationId, correlationId });
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'identity.invitation.created', resourceType: 'invitation', resourceId: invitationId,
        organizationId, correlationId, context: { role, staffType, source: 'GROWTH_TEAM' } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'invitation', aggregateId: invitationId, eventType: 'identity.invitation.created',
        payload: { invitationId }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId, 'GROWTH_INVITATION_ALREADY_PENDING'); });

    const delivery = await this.deliver({ invitationId, commandId, email, role, token, correlationId });
    return { invitation: { id: invitationId, email, role, staffType, state: 'PENDING', delivery: { state: delivery } }, correlationId };
  }

  @Post('/invitations/:invitationId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(@Req() request: ProtectedHttpRequest, @Param('invitationId') invitationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const id = readUuid(invitationId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTeamReasons.revokeInvitation, correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT i.role, i.state, i.organization_id FROM invitations i JOIN organizations o ON o.id = i.organization_id AND o.kind = 'PLATFORM'
        WHERE i.id = ${id}::uuid AND i.kind = 'STAFF' AND i.role IN (${roleList()})
        FOR UPDATE OF i
      `) as QueryResult<{ role: GrowthRole; state: string; organization_id: string }>;
      const row = found.rows[0];
      if (!row) throw new NotFoundException(domainError('GROWTH_INVITATION_NOT_FOUND', correlationId));
      if (row.state !== 'PENDING') throw conflict('GROWTH_INVITATION_NOT_PENDING', correlationId);
      await tx.execute(sql`
        UPDATE invitations SET state = 'REVOKED', revoked_at = now(), reason_code = ${reasonCode}, updated_at = now()
        WHERE id = ${id}::uuid AND state = 'PENDING'
      `);
      await tx.execute(sql`UPDATE notification_commands SET state = 'CANCELLED' WHERE destination_ref = ${`invitation:${id}`} AND state = 'PENDING'`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'identity.invitation.revoked', resourceType: 'invitation', resourceId: id,
        organizationId: row.organization_id, correlationId, context: { role: row.role, reasonCode, source: 'GROWTH_TEAM' } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'invitation', aggregateId: id, eventType: 'identity.invitation.revoked',
        payload: { invitationId: id }, actorUserId: actor.userId, organizationId: row.organization_id, correlationId });
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { invitation: { id, state: 'REVOKED' }, correlationId };
  }

  @Post('/:membershipId/teams')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async setTeam(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const id = readUuid(membershipId, correlationId);
    const raw = readObject(body, ['team', 'managerMembershipId', 'reasonCode'], correlationId);
    if (!isGrowthTeam(raw.team)) throw badRequest('GROWTH_TEAM_INVALID', correlationId);
    const team = raw.team;
    const managerId = raw.managerMembershipId === undefined || raw.managerMembershipId === null ? null : readUuid(String(raw.managerMembershipId), correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTeamReasons.joinTeam, correlationId);
    const member = await this.db.transaction(async (tx) => {
      const target = await this.lockTarget(tx, id, actor, correlationId);
      if (managerId) {
        const manager = await tx.execute(sql`
          SELECT m.role, m.state::text AS state FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
          WHERE m.id = ${managerId}::uuid
        `) as QueryResult<{ role: string; state: string }>;
        const row = manager.rows[0];
        if (managerId === id || !row || row.role !== 'GROWTH_MANAGER' || row.state !== 'ACTIVE') throw badRequest('GROWTH_MANAGER_INVALID', correlationId);
      }
      const live = await tx.execute(sql`
        SELECT id, manager_membership_id FROM growth_team_members
        WHERE membership_id = ${id}::uuid AND team = ${team} AND left_at IS NULL
        FOR UPDATE
      `) as QueryResult<{ id: string; manager_membership_id: string | null }>;
      const current = live.rows[0];
      if (current && current.manager_membership_id === managerId) throw conflict('GROWTH_TEAM_UNCHANGED', correlationId);
      if (current) await this.leaveTeam(tx, { rowId: current.id, membershipId: id, team, reasonCode, actorUserId: actor.userId, organizationId: target.organization_id, correlationId });
      const rowId = this.ids.uuid();
      await tx.execute(sql`
        INSERT INTO growth_team_members (id, membership_id, team, manager_membership_id, joined_by_user_id, reason_code)
        VALUES (${rowId}::uuid, ${id}::uuid, ${team}, ${managerId}::uuid, ${actor.userId}::uuid, ${reasonCode})
      `);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.team_member.joined', resourceType: 'organization_membership', resourceId: id,
        organizationId: target.organization_id, correlationId, context: { team, reasonCode, teamMemberId: rowId, managerMembershipId: managerId, targetUserId: target.user_id } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_team_member', aggregateId: rowId, eventType: 'growth.team_member.joined',
        payload: { membershipId: id, team }, actorUserId: actor.userId, organizationId: target.organization_id, correlationId });
      return this.memberDto(tx, id, actor.userId);
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { member, correlationId };
  }

  @Post('/:membershipId/teams/:team/end')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async endTeam(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Param('team') teamParam: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const id = readUuid(membershipId, correlationId);
    if (!isGrowthTeam(teamParam)) throw badRequest('GROWTH_TEAM_INVALID', correlationId);
    const team = teamParam;
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTeamReasons.leaveTeam, correlationId);
    const member = await this.db.transaction(async (tx) => {
      const target = await this.lockTarget(tx, id, actor, correlationId);
      const live = await tx.execute(sql`
        SELECT id FROM growth_team_members WHERE membership_id = ${id}::uuid AND team = ${team} AND left_at IS NULL FOR UPDATE
      `) as QueryResult<{ id: string }>;
      if (!live.rows[0]) throw new NotFoundException(domainError('GROWTH_TEAM_NOT_HELD', correlationId));
      await this.leaveTeam(tx, { rowId: live.rows[0].id, membershipId: id, team, reasonCode, actorUserId: actor.userId, organizationId: target.organization_id, correlationId });
      return this.memberDto(tx, id, actor.userId);
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { member, correlationId };
  }

  @Post('/:membershipId/staff-type')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async setStaffType(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const id = readUuid(membershipId, correlationId);
    const raw = readObject(body, ['staffType', 'reasonCode'], correlationId);
    if (raw.staffType === undefined || raw.staffType === null || raw.staffType === '') throw badRequest('GROWTH_STAFF_TYPE_REQUIRED', correlationId);
    if (!isGrowthStaffType(raw.staffType)) throw badRequest('GROWTH_STAFF_TYPE_INVALID', correlationId);
    const staffType = raw.staffType;
    const member = await this.db.transaction(async (tx) => {
      const target = await this.lockTarget(tx, id, actor, correlationId);
      const live = await tx.execute(sql`
        SELECT id, staff_type FROM growth_staff_types WHERE membership_id = ${id}::uuid AND ended_at IS NULL FOR UPDATE
      `) as QueryResult<{ id: string; staff_type: GrowthStaffType }>;
      const current = live.rows[0];
      // The first type of a membership made outside the invitation path is INITIAL_TYPE; every
      // later change says why.
      const reasonCode = readReason(raw.reasonCode, current ? growthTeamReasons.changeStaffType : growthTeamReasons.initialStaffType, correlationId);
      if (current && current.staff_type === staffType) throw conflict('GROWTH_STAFF_TYPE_UNCHANGED', correlationId);
      if (current) {
        await tx.execute(sql`
          UPDATE growth_staff_types SET ended_at = now(), ended_by_user_id = ${actor.userId}::uuid, ended_reason_code = ${reasonCode}
          WHERE id = ${current.id}::uuid AND ended_at IS NULL
        `);
        await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.staff_type.ended', resourceType: 'organization_membership', resourceId: id,
          organizationId: target.organization_id, correlationId, context: { staffType: current.staff_type, reasonCode, staffTypeId: current.id, targetUserId: target.user_id } });
      }
      const rowId = this.ids.uuid();
      await tx.execute(sql`
        INSERT INTO growth_staff_types (id, membership_id, staff_type, set_by_user_id, reason_code)
        VALUES (${rowId}::uuid, ${id}::uuid, ${staffType}, ${actor.userId}::uuid, ${reasonCode})
      `);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.staff_type.set', resourceType: 'organization_membership', resourceId: id,
        organizationId: target.organization_id, correlationId, context: { staffType, reasonCode, staffTypeId: rowId, targetUserId: target.user_id, ...(current ? { previousStaffType: current.staff_type } : {}) } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_staff_type', aggregateId: rowId, eventType: 'growth.staff_type.set',
        payload: { membershipId: id, staffType }, actorUserId: actor.userId, organizationId: target.organization_id, correlationId });
      return this.memberDto(tx, id, actor.userId);
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { member, correlationId };
  }

  @Post('/:membershipId/end')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async endMembership(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireGrowthAdmin(request);
    const id = readUuid(membershipId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTeamReasons.endMembership, correlationId);
    const member = await this.db.transaction(async (tx) => {
      const target = await this.lockTarget(tx, id, actor, correlationId);
      // The database ends the live team rows in the same statement (0091); the staff type is
      // kept, because it records how the person was engaged.
      await tx.execute(sql`UPDATE organization_memberships SET state = 'ENDED', updated_at = now() WHERE id = ${id}::uuid`);
      await writeAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'organization_membership.ended', resourceType: 'organization_membership', resourceId: id,
        organizationId: target.organization_id, correlationId, context: { role: target.role, reasonCode, endedUserId: target.user_id, source: 'GROWTH_TEAM' } });
      await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'organization_membership', aggregateId: id, eventType: 'organization_membership.ended',
        payload: { membershipId: id, role: target.role }, actorUserId: actor.userId, organizationId: target.organization_id, correlationId });
      return this.memberDto(tx, id, actor.userId);
    }).catch((error: unknown) => { throw mapWriteError(error, correlationId); });
    return { member, correlationId };
  }

  private async requireGrowthAdmin(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canAdministerGrowthTeam(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  /** Lock the target membership and apply the pure administration rule to it. */
  private async lockTarget(tx: PersistenceDb, membershipId: string, actor: Actor, correlationId: string): Promise<TargetRow> {
    const found = await tx.execute(sql`
      SELECT m.id, m.user_id, m.role, m.state::text AS state, o.kind::text AS organization_kind, m.organization_id
      FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.id = ${membershipId}::uuid
      FOR UPDATE OF m
    `) as QueryResult<TargetRow>;
    const row = found.rows[0];
    if (!row) throw new NotFoundException(domainError('GROWTH_MEMBER_NOT_FOUND', correlationId));
    const refusal = refuseGrowthTeamChange({ actor, target: { userId: row.user_id, role: row.role, state: row.state, organizationKind: row.organization_kind } });
    if (refusal) throw refusalError(refusal, correlationId);
    return row;
  }

  private async leaveTeam(tx: PersistenceDb, input: { rowId: string; membershipId: string; team: GrowthTeam; reasonCode: string; actorUserId: string; organizationId: string; correlationId: string }): Promise<void> {
    await tx.execute(sql`
      UPDATE growth_team_members SET left_at = now(), left_by_user_id = ${input.actorUserId}::uuid, left_reason_code = ${input.reasonCode}
      WHERE id = ${input.rowId}::uuid AND left_at IS NULL
    `);
    await writeAudit(tx, { id: this.ids.uuid(), actorUserId: input.actorUserId, action: 'growth.team_member.left', resourceType: 'organization_membership', resourceId: input.membershipId,
      organizationId: input.organizationId, correlationId: input.correlationId, context: { team: input.team, reasonCode: input.reasonCode, teamMemberId: input.rowId } });
    await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_team_member', aggregateId: input.rowId, eventType: 'growth.team_member.left',
      payload: { membershipId: input.membershipId, team: input.team }, actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId });
  }

  private async memberDto(tx: PersistenceDb, membershipId: string, actorUserId: string): Promise<Record<string, unknown>> {
    const found = await tx.execute(sql`
      SELECT m.id, m.user_id, u.email, m.role, m.state::text AS state, m.created_at
      FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ${membershipId}::uuid
    `) as QueryResult<{ id: string; user_id: string; email: string; role: string; state: string; created_at: Date | string }>;
    const row = found.rows[0]!;
    const details = await this.memberDetails(tx, [membershipId]);
    return {
      membershipId: row.id, email: row.email, role: row.role, state: row.state, joinedAt: iso(row.created_at), isSelf: row.user_id === actorUserId,
      ...(details.get(membershipId) ?? { staffType: null, teams: [] }),
    };
  }

  /** Live teams (with manager) and the live staff type, for a bounded set of memberships. */
  private async memberDetails(runner: PersistenceDb, membershipIds: readonly string[]): Promise<Map<string, { staffType: { staffType: string; effectiveFrom: string | null } | null; teams: Record<string, unknown>[] }>> {
    const details = new Map<string, { staffType: { staffType: string; effectiveFrom: string | null } | null; teams: Record<string, unknown>[] }>();
    if (!membershipIds.length) return details;
    for (const id of membershipIds) details.set(id, { staffType: null, teams: [] });
    const idList = sql.join(membershipIds.map((id) => sql`${id}::uuid`), sql`, `);
    const teams = await runner.execute(sql`
      SELECT t.membership_id, t.team, t.joined_at, t.reason_code, t.manager_membership_id, mu.email AS manager_email
      FROM growth_team_members t
      LEFT JOIN organization_memberships mm ON mm.id = t.manager_membership_id
      LEFT JOIN users mu ON mu.id = mm.user_id
      WHERE t.left_at IS NULL AND t.membership_id IN (${idList})
      ORDER BY t.team
    `) as QueryResult<{ membership_id: string; team: string; joined_at: Date | string; reason_code: string; manager_membership_id: string | null; manager_email: string | null }>;
    for (const row of teams.rows) {
      details.get(row.membership_id)!.teams.push({
        team: row.team, joinedAt: iso(row.joined_at), reasonCode: row.reason_code,
        manager: row.manager_membership_id ? { membershipId: row.manager_membership_id, email: row.manager_email } : null,
      });
    }
    const types = await runner.execute(sql`
      SELECT membership_id, staff_type, effective_from FROM growth_staff_types WHERE ended_at IS NULL AND membership_id IN (${idList})
    `) as QueryResult<{ membership_id: string; staff_type: string; effective_from: Date | string }>;
    for (const row of types.rows) details.get(row.membership_id)!.staffType = { staffType: row.staff_type, effectiveFrom: iso(row.effective_from) };
    return details;
  }

  private async writeDeliveryCommand(tx: PersistenceDb, input: { invitationId: string; commandId: string; role: GrowthRole; actorUserId: string; organizationId: string; correlationId: string }): Promise<void> {
    await tx.execute(sql`
      INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
      VALUES (${invitationTemplateId}::uuid, ${invitationTemplateKey}, 1, 'en-IN', ${invitationSubject},
              'Invitation link is rendered only in the ephemeral local/test delivery sink.', ${input.actorUserId}::uuid, now())
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO notification_commands
        (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
      VALUES (${input.commandId}::uuid, ${input.actorUserId}::uuid, ${invitationTemplateId}::uuid, 'EMAIL', 'transactional growth team invitation',
              ${`invitation:${input.invitationId}`}, ${JSON.stringify({ invitationId: input.invitationId, role: input.role })}::jsonb,
              ${`growth-team:${input.invitationId}`}, 'PENDING', now() + interval '14 days', ${input.correlationId})
    `);
    await writeOutbox(tx, { id: this.ids.uuid(), aggregateType: 'notification_command', aggregateId: input.commandId, eventType: 'notification.delivery.requested',
      payload: { commandId: input.commandId, templateId: invitationTemplateId, channel: 'EMAIL' }, actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId });
  }

  /** Send after the invitation is committed. A failed send never undoes the invitation. */
  private async deliver(input: { invitationId: string; commandId: string; email: string; role: GrowthRole; token: string; correlationId: string }): Promise<DeliveryOutcome> {
    if (!this.invitationMailSink) return 'NOT_CONFIGURED';
    const textBody = [
      `AI8HT has invited you to join the ONE Growth team as ${roleLabels[input.role]}.`,
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
          VALUES (${this.ids.uuid()}::uuid, ${input.commandId}::uuid, 1, 'MAILPIT', ${delivered.providerReference ?? null}, 'SUCCEEDED')
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
          VALUES (${this.ids.uuid()}::uuid, ${input.commandId}::uuid, 1, 'MAILPIT', ${bounced ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE'}, ${bounced ? 'PERMANENT_REJECTION' : 'SINK_UNAVAILABLE'})
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

function roleList(): SQL {
  return sql.join(growthRoles.map((role) => sql`${role}`), sql`, `);
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

function refusalError(refusal: GrowthAdministrationRefusal, correlationId: string): Error {
  const status = refusalStatus[refusal];
  if (status === 403) return new ForbiddenException(refusal === 'FORBIDDEN' ? safeError('FORBIDDEN', correlationId) : domainError(refusal, correlationId));
  if (status === 409) return conflict(refusal, correlationId);
  return badRequest(refusal, correlationId);
}

/** HTTP refusals pass through; a unique-index race becomes a 409; nothing else leaks. */
function mapWriteError(error: unknown, correlationId: string, uniqueCode = 'GROWTH_CHANGE_CONFLICT'): Error {
  if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) return error;
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  if (code === '23505') return conflict(uniqueCode, correlationId);
  return badRequest('GROWTH_CHANGE_REJECTED', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  return raw;
}

function readUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value;
}

function readEmail(value: unknown, correlationId: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!emailPattern.test(normalized) || normalized.length > 254) throw badRequest('GROWTH_EMAIL_INVALID', correlationId);
  return normalized;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
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
