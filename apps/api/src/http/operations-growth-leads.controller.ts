/**
 * Operations → Settings → Growth leads (GROWTH-03; design §3.5, §5.4, §13.4) — the growth admin's
 * view of the lead register, and the Privacy console's growth-contact lookup and erasure.
 *
 * GROWTH_ADMIN: list and open any lead (contacts masked), reveal a contact with a reason (audited),
 * reassign anywhere with a reason, set do-not-contact, and remove a contact (including on a
 * person's privacy request). PRIVACY_REQUESTS: look a contact up by email or phone — the answer to
 * the person's access request — and erase every matching contact, optionally stopping all contact
 * with their organisations.
 *
 * Sections of existing Operations screens (Settings, Privacy); no navigation item (O-24).
 *
 * Design: docs/architecture/growth-leads-table-design.md §6.4, §7
 */
import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  growthLeadReasons,
  growthTeamForLeadKind,
  hasInternalCapability,
  refuseGrowthTeamChange,
} from '@planthepath/authorization/src/index.js';
import {
  eraseGrowthContacts,
  growthContactLookupHash,
  lookupGrowthContacts,
  readGrowthContactLookupKey,
} from '@planthepath/persistence/src/growth-leads.js';
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
import { badRequest, conflict, mapGrowthWriteError, notFound, platformOrganizationId, readObject, readReason, readUuid, writeGrowthAudit, writeGrowthOutbox, type QueryResult } from './growth-http.js';
import { leadTriggerMessages, growthLeadVocabulary } from './growth-leads.controller.js';
import { readLeadQuery } from './growth-leads-input.js';
import {
  assertReassignTarget,
  changeOwner,
  leadDetailDto,
  listLeads,
  loadLead,
  removeContact,
  revealContact,
  setDoNotContact,
  type LeadView,
  type WriteContext,
} from './growth-leads-service.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = Awaited<ReturnType<typeof loadCallerCapabilityContext>>;

const referencePattern = /^[A-Za-z0-9_:-]{3,64}$/;

@Controller('/api/v1/operations/growth-leads')
export class OperationsGrowthLeadsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const parsed = readLeadQuery(query, correlationId);
    if (parsed.view === 'MINE') throw badRequest('GROWTH_LEAD_VIEW_INVALID', correlationId);
    const page = await listLeads(this.db, { scope: { kind: 'ALL' }, caller: null, kind: parsed.kind, view: parsed.view as LeadView, search: parsed.search, cursor: parsed.cursor, now: new Date() });
    return { ...page, vocabulary: growthLeadVocabulary(), correlationId };
  }

  @Get('/:leadId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const loaded = await loadLead(this.db, readUuid(leadId, correlationId));
    if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    // An operator is never the owner: contacts stay masked unless revealed with a reason.
    return { lead: await leadDetailDto(this.db, loaded, null, new Date()), correlationId };
  }

  @Get('/:leadId/reassign-options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reassignOptions(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const loaded = await loadLead(this.db, readUuid(leadId, correlationId));
    if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    const candidates = await this.db.execute(sql`
      SELECT DISTINCT m.id, u.email, m.role FROM organization_memberships m
      JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = ${growthTeamForLeadKind(loaded.row.kind)}
      WHERE m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
      ORDER BY u.email LIMIT 200
    `) as QueryResult<{ id: string; email: string; role: string }>;
    return { options: candidates.rows.map((row) => ({ membershipId: row.id, email: row.email, role: row.role })), correlationId };
  }

  @Post('/:leadId/reassign')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reassign(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['toMembershipId', 'reasonCode'], correlationId);
    const to = raw.toMembershipId === null ? null : readUuid(raw.toMembershipId, correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.adminReassign, correlationId);
    await this.db.transaction(async (tx) => {
      const loaded = await loadLead(tx, id, true);
      if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
      if (loaded.facts.doNotContact) throw conflict('GROWTH_LEAD_DO_NOT_CONTACT', correlationId);
      if (!loaded.facts.open) throw conflict('GROWTH_LEAD_CLOSED', correlationId);
      if (to === loaded.row.owner_membership_id) throw conflict('GROWTH_LEAD_OWNER_UNCHANGED', correlationId);
      if (to) {
        // Nobody hands a lead to their own growth membership.
        const target = await tx.execute(sql`
          SELECT m.user_id, m.role, m.state::text AS state, o.kind::text AS organization_kind FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.id = ${to}::uuid
        `) as QueryResult<{ user_id: string; role: string; state: string; organization_kind: string }>;
        const row = target.rows[0];
        if (!row) throw badRequest('GROWTH_REASSIGN_TARGET_INVALID', correlationId);
        const refusal = refuseGrowthTeamChange({ actor, target: { userId: row.user_id, role: row.role, state: row.state, organizationKind: row.organization_kind } });
        if (refusal === 'GROWTH_SELF_CHANGE_REFUSED') throw new ForbiddenException({ error: { code: refusal, message: 'The request could not be completed.', correlationId } });
        if (refusal) throw badRequest('GROWTH_REASSIGN_TARGET_INVALID', correlationId);
        await assertReassignTarget(tx, loaded.row.kind, to, correlationId);
      }
      await changeOwner(tx, ctx, { leadId: id, from: loaded.row.owner_membership_id, to, reasonCode, eventType: 'growth.lead.reassigned' });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: leadTriggerMessages }); });
    return this.detail(request, id);
  }

  @Post('/:leadId/do-not-contact')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async doNotContact(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.doNotContact, correlationId);
    await this.db.transaction(async (tx) => {
      if (!(await loadLead(tx, id, true))) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
      await setDoNotContact(tx, ctx, id, reasonCode);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts/:contactId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeContact(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const contact = readUuid(contactId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.adminRemoveContact, correlationId);
    await this.db.transaction(async (tx) => {
      if (!(await loadLead(tx, id, true))) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
      await removeContact(tx, ctx, id, contact, reasonCode);
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return this.detail(request, id);
  }

  @Post('/:leadId/contacts/:contactId/reveal')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reveal(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(leadId, correlationId);
    const contact = readUuid(contactId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthLeadReasons.revealContact, correlationId);
    const revealed = await this.db.transaction((tx) => revealContact(tx, ctx, id, contact, reasonCode))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { contact: revealed, correlationId };
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'GROWTH_ADMIN')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor; readonly ctx: WriteContext }> {
    const { correlationId, actor } = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return { correlationId, actor, ctx: { actorUserId: actor.userId, organizationId, correlationId, uuid: () => this.ids.uuid() } };
  }
}

/**
 * Operations → Privacy → Growth lead contacts (PRIVACY_REQUESTS). A contact is not a ONE user,
 * so their rights requests arrive by email and are answered here: lookup is the export answer,
 * erase removes every matching contact. Both are audited with the request reference and a hash
 * of the key, never the email or phone itself.
 */
@Controller('/api/v1/operations/privacy/growth-contacts')
export class OperationsGrowthContactsPrivacyController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Post('/lookup')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async lookup(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor, organizationId } = await this.require(request);
    const raw = readObject(body, ['email', 'phone', 'reference'], correlationId);
    const key = readGrowthContactLookupKey(raw);
    if (!key) throw badRequest('GROWTH_CONTACT_LOOKUP_KEY_INVALID', correlationId);
    const reference = readReference(raw.reference, correlationId);
    const matches = await this.db.transaction(async (tx) => {
      const found = await lookupGrowthContacts(tx, key);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'operations.growth_contacts.looked_up', resourceType: 'privacy_request',
        resourceId: reference, organizationId, correlationId, context: { reference, keyKind: 'email' in key ? 'EMAIL' : 'PHONE', keyHash: growthContactLookupHash(key), matches: found.length } });
      return found;
    });
    return { matches, correlationId };
  }

  @Post('/erase')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async erase(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor, organizationId } = await this.require(request);
    const raw = readObject(body, ['email', 'phone', 'reference', 'doNotContact'], correlationId);
    const key = readGrowthContactLookupKey({ email: raw.email, phone: raw.phone });
    if (!key) throw badRequest('GROWTH_CONTACT_LOOKUP_KEY_INVALID', correlationId);
    const reference = readReference(raw.reference, correlationId);
    if (typeof raw.doNotContact !== 'boolean') throw badRequest('INVALID_REQUEST', correlationId);
    const doNotContact = raw.doNotContact;
    const result = await this.db.transaction(async (tx) => {
      const erased = await eraseGrowthContacts(tx, { key, actorUserId: actor.userId, doNotContact });
      for (const removed of erased.removed) {
        await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.lead_contact.removed', resourceType: 'growth_lead_contact',
          resourceId: removed.contactId, organizationId, correlationId, context: { leadId: removed.leadId, reasonCode: 'PRIVACY_REQUEST', reference } });
        await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_lead_contact', aggregateId: removed.contactId, eventType: 'growth.lead_contact.removed',
          payload: { leadId: removed.leadId, contactId: removed.contactId, reasonCode: 'PRIVACY_REQUEST' }, actorUserId: actor.userId, organizationId, correlationId });
      }
      for (const leadId of erased.doNotContactLeadIds) {
        await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.lead.do_not_contact_set', resourceType: 'growth_lead',
          resourceId: leadId, organizationId, correlationId, context: { reasonCode: 'PERSON_REQUEST', reference } });
        await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_lead', aggregateId: leadId, eventType: 'growth.lead.do_not_contact_set',
          payload: { leadId, reasonCode: 'PERSON_REQUEST' }, actorUserId: actor.userId, organizationId, correlationId });
      }
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'operations.growth_contacts.erased', resourceType: 'privacy_request',
        resourceId: reference, organizationId, correlationId,
        context: { reference, keyKind: 'email' in key ? 'EMAIL' : 'PHONE', keyHash: growthContactLookupHash(key), removed: erased.removed.length, doNotContactLeads: erased.doNotContactLeadIds.length } });
      return erased;
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { removed: result.removed.length, doNotContactLeads: result.doNotContactLeadIds.length, correlationId };
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor; readonly organizationId: string }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'PRIVACY_REQUESTS')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', context.correlationId);
    return { correlationId: context.correlationId, actor, organizationId };
  }
}

function readReference(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !referencePattern.test(value)) throw badRequest('PRIVACY_REFERENCE_REQUIRED', correlationId);
  return value;
}
