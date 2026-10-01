/**
 * Growth → Leads (GROWTH-03; design §5, §13, §14.1): the lead register for a growth person.
 *
 * List, detail, create, claim, reassign (managers), add a contact, record the contact notice,
 * remove a contact, reveal a masked contact (non-owners, audited) and set do-not-contact. Every
 * read is composed from the one scope rule (`growthScopeFor` → `growthScopePredicate`); a lead
 * outside the caller's scope answers 404, never 403, so its existence is not disclosed.
 *
 * Only an ACTIVE growth membership admits the caller. Operators work leads from Operations
 * (operations-growth-leads.controller.ts), never here.
 *
 * Design: docs/architecture/growth-leads-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, HttpException, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  GROWTH_CONTACT_NOTICE_TEXT,
  GROWTH_CONTACT_NOTICE_VERSION,
  GROWTH_CONTACT_PURPOSE,
  GROWTH_LEAD_CONTACT_LIMIT,
  growthContactRoles,
  growthContactSourcesByBasis,
  growthLeadKinds,
  growthLeadReasons,
  growthLeadSources,
  growthLeadStages,
  growthOwningMembership,
  growthTeamForLeadKind,
  growthWorkspaceRole,
  refuseGrowthContactReveal,
  refuseGrowthContactWrite,
  refuseGrowthLeadClaim,
  refuseGrowthLeadPrivacyWrite,
  refuseGrowthLeadReassign,
  type GrowthLeadCaller,
  type GrowthLeadRefusal,
} from '@planthepath/authorization/src/index.js';
import { growthScopePredicate } from '@planthepath/persistence/src/growth-territories.js';
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
import { conflict, forbidden, mapGrowthWriteError, notFound, platformOrganizationId, readObject, readReason, readUuid, type QueryResult } from './growth-http.js';
import {
  addContact,
  assertReassignTarget,
  changeOwner,
  createLead,
  leadDetailDto,
  listLeads,
  loadGrowthLeadCaller,
  loadLead,
  recordNotice,
  removeContact,
  revealContact,
  setDoNotContact,
  type LeadView,
  type WriteContext,
} from './growth-leads-service.js';
import { readContactInput, readLeadInput, readLeadQuery } from './growth-leads-input.js';

const refusalStatus: Readonly<Record<GrowthLeadRefusal, 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN'>> = {
  GROWTH_LEAD_NOT_FOUND: 'NOT_FOUND',
  GROWTH_LEAD_ALREADY_OWNED: 'CONFLICT',
  GROWTH_LEAD_DO_NOT_CONTACT: 'CONFLICT',
  GROWTH_LEAD_CLOSED: 'CONFLICT',
  GROWTH_TEAM_MISMATCH: 'FORBIDDEN',
  GROWTH_NOT_LEAD_OWNER: 'FORBIDDEN',
  GROWTH_NOT_REGION_MANAGER: 'FORBIDDEN',
};

export function growthRefusalError(refusal: GrowthLeadRefusal, correlationId: string): HttpException {
  const status = refusalStatus[refusal];
  if (status === 'NOT_FOUND') return notFound(refusal, correlationId);
  if (status === 'CONFLICT') return conflict(refusal, correlationId);
  return forbidden(refusal, correlationId);
}

/** Trigger refusals → domain codes (the database decides a race). */
export const leadTriggerMessages: Readonly<Record<string, string>> = {
  'do-not-contact lead cannot be claimed': 'GROWTH_LEAD_DO_NOT_CONTACT',
  'is do-not-contact: no contact may be added': 'GROWTH_LEAD_DO_NOT_CONTACT',
  'growth lead owner must be an ACTIVE growth membership': 'GROWTH_TEAM_MISMATCH',
  'district does not belong to its state': 'GROWTH_DISTRICT_STATE_MISMATCH',
};

export function growthLeadVocabulary(): Record<string, unknown> {
  return {
    kinds: growthLeadKinds, stages: growthLeadStages, sources: growthLeadSources, contactRoles: growthContactRoles,
    contactSourcesByBasis: growthContactSourcesByBasis, reasons: growthLeadReasons, contactLimit: GROWTH_LEAD_CONTACT_LIMIT,
    purpose: GROWTH_CONTACT_PURPOSE,
    notice: { version: GROWTH_CONTACT_NOTICE_VERSION, status: 'DRAFT_FOR_LEGAL_REVIEW', text: GROWTH_CONTACT_NOTICE_TEXT },
  };
}

@Controller('/api/v1/growth/leads')
export class GrowthLeadsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/vocabulary')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async vocabulary(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    return { ...growthLeadVocabulary(), correlationId };
  }

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, caller } = await this.require(request);
    const parsed = readLeadQuery(query, correlationId);
    const page = await listLeads(this.db, { scope: caller.scope, caller, kind: parsed.kind, view: parsed.view as LeadView, search: parsed.search, cursor: parsed.cursor, now: new Date() });
    return { ...page, correlationId };
  }

  @Get('/:leadId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller } = await this.require(request);
    const loaded = await this.visible(this.db, readUuid(leadId, correlationId), caller, correlationId);
    return { lead: await leadDetailDto(this.db, loaded, caller, new Date()), correlationId };
  }

  /** Who a manager may hand this lead to: active people on the matching team in their regions or reporting to them. */
  @Get('/:leadId/reassign-options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reassignOptions(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller } = await this.require(request);
    const loaded = await this.visible(this.db, readUuid(leadId, correlationId), caller, correlationId);
    const refusal = refuseGrowthLeadReassign(caller, loaded.facts);
    if (refusal) throw growthRefusalError(refusal, correlationId);
    const regions = caller.scope.kind === 'PERSON' ? caller.scope.allLeadRegionIds : [];
    const reports = caller.scope.kind === 'PERSON' ? caller.scope.ownerMembershipIds : [];
    const candidates = await this.db.execute(sql`
      SELECT DISTINCT m.id, u.email, m.role FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = ${growthTeamForLeadKind(loaded.row.kind)}
      WHERE m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
        AND (${reports.length ? sql`m.id IN (${sql.join(reports.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`FALSE`}
          OR ${regions.length ? sql`EXISTS (SELECT 1 FROM growth_territory_assignments a WHERE a.membership_id = m.id AND a.ended_at IS NULL
                AND a.region_id IN (${sql.join(regions.map((id) => sql`${id}::uuid`), sql`, `)}))` : sql`FALSE`})
      ORDER BY u.email LIMIT 200
    `) as QueryResult<{ id: string; email: string; role: string }>;
    return { options: candidates.rows.map((row) => ({ membershipId: row.id, email: row.email, role: row.role })), correlationId };
  }

  @Post()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const input = readLeadInput(body, correlationId);
    const id = await this.db.transaction((tx) => createLead(tx, ctx, caller, input))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { unique: 'GROWTH_LEAD_DUPLICATE', messages: leadTriggerMessages }); });
    const loaded = (await loadLead(this.db, id))!;
    return { lead: await leadDetailDto(this.db, loaded, caller, new Date()), correlationId };
  }

  @Post('/:leadId/claim')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async claim(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    await this.db.transaction(async (tx) => {
      // First claim wins: the row lock serialises two claims, and the second sees an owner. The
      // loser worked the region the lead is in, so "already claimed" discloses nothing they could
      // not see a moment ago; someone outside the region still gets 404.
      const loaded = await loadLead(tx, id, true);
      if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
      const inMyRegion = caller.scope.kind === 'PERSON' && loaded.facts.regionIds.some((region) => caller.scope.kind === 'PERSON' && caller.scope.unownedLeadRegionIds.includes(region));
      if (loaded.facts.ownerMembershipId !== null && inMyRegion && !caller.memberships.some((membership) => membership.membershipId === loaded.facts.ownerMembershipId)) {
        throw conflict('GROWTH_LEAD_ALREADY_OWNED', correlationId);
      }
      await this.visible(tx, id, caller, correlationId);
      const refusal = refuseGrowthLeadClaim(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      const owner = growthOwningMembership(caller, loaded.row.kind)!;
      await changeOwner(tx, ctx, { leadId: id, from: null, to: owner, reasonCode: 'CLAIMED', eventType: 'growth.lead.claimed' });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: leadTriggerMessages }); });
    return this.detail(request, id);
  }

  @Post('/:leadId/reassign')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reassign(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['toMembershipId', 'reasonCode'], correlationId);
    const to = raw.toMembershipId === null ? null : readUuid(raw.toMembershipId, correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.reassign, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthLeadReassign(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      if (to === loaded.row.owner_membership_id) throw conflict('GROWTH_LEAD_OWNER_UNCHANGED', correlationId);
      if (to) await assertReassignTarget(tx, loaded.row.kind, to, correlationId);
      await changeOwner(tx, ctx, { leadId: id, from: loaded.row.owner_membership_id, to, reasonCode, eventType: 'growth.lead.reassigned' });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: leadTriggerMessages }); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addContact(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const input = readContactInput(body, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthContactWrite(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      await addContact(tx, ctx, id, input);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: leadTriggerMessages }); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts/:contactId/notice')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async notice(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Param('contactId') contactId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const contact = readUuid(contactId, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthContactWrite(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      await recordNotice(tx, ctx, id, contact);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts/:contactId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeContact(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const contact = readUuid(contactId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.removeContact, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthLeadPrivacyWrite(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      await removeContact(tx, ctx, id, contact, reasonCode);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts/:contactId/reveal')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reveal(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const contact = readUuid(contactId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.revealContact, correlationId);
    const revealed = await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId);
      const refusal = refuseGrowthContactReveal(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      return revealContact(tx, ctx, id, contact, reasonCode);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { contact: revealed, correlationId };
  }

  @Post('/:leadId/do-not-contact')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async doNotContact(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.doNotContact, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthLeadPrivacyWrite(caller, loaded.facts);
      if (refusal) throw growthRefusalError(refusal, correlationId);
      await setDoNotContact(tx, ctx, id, reasonCode);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return this.detail(request, id);
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller }> {
    const context = requireTrustedAuthorization(request);
    if (!growthWorkspaceRole(context.authorization.memberships)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const userId = context.authorization.principal.userId;
    const caller = await loadGrowthLeadCaller(this.db, { userId, growthAdmin: false });
    return { correlationId: context.correlationId, userId, caller };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly caller: GrowthLeadCaller; readonly ctx: WriteContext }> {
    const { correlationId, userId, caller } = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return { correlationId, caller, ctx: { actorUserId: userId, organizationId, correlationId, uuid: () => this.ids.uuid() } };
  }

  /** The lead when the caller's scope includes it; otherwise 404, so its existence is not disclosed. */
  private async visible(runner: Pick<PersistenceDb, 'execute'>, leadId: string, caller: GrowthLeadCaller, correlationId: string, lock = false) {
    const loaded = await loadLead(runner, leadId, lock);
    if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    const scoped = await runner.execute(sql`SELECT 1 FROM growth_leads l WHERE l.id = ${leadId}::uuid AND ${growthScopePredicate(caller.scope, 'l')}`) as QueryResult<unknown>;
    if (!scoped.rows.length) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    return loaded;
  }
}

