/**
 * Growth → Field (GROWTH-06; design §14): visits, calls, meetings and notes, follow-ups, and the
 * optional visit location, for a growth person on the web Field page and the phone.
 *
 * Every write requires an `Idempotency-Key` and is recorded in `idempotency_records` inside its own
 * transaction, so the phone's offline queue can resend until it gets an answer and the write lands
 * once (growth-idempotency.ts). A visit's location is shown to its author and their manager only.
 * Every read is scoped by the one scope rule; a lead outside the caller's scope answers 404.
 *
 * Only an ACTIVE growth membership admits the caller.
 *
 * Design: docs/architecture/growth-field-work-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, HttpException, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  GROWTH_ACTIVITY_NOTES_MAX,
  GROWTH_FIELD_LIST_LIMIT,
  GROWTH_FOLLOW_UP_TITLE_MAX,
  GROWTH_LOCATION_NOTICE_TEXT,
  GROWTH_LOCATION_NOTICE_VERSION,
  GROWTH_LOCATION_RETENTION_DAYS,
  GROWTH_REPORT_MAX_AGE_DAYS,
  growthActivityAllowsLocation,
  growthActivityKinds,
  growthActivityNeedsOutcome,
  growthActivityOutcomes,
  growthFieldAuthorMembership,
  growthFollowUpCancelReasons,
  growthWorkspaceRole,
  isGrowthActivityKind,
  isGrowthActivityOutcome,
  readGrowthLocation,
  refuseGrowthFieldWrite,
  refuseGrowthFollowUpClose,
  refuseGrowthFollowUpDue,
  refuseGrowthLocationRemoval,
  refuseGrowthReportTime,
  type GrowthFieldRefusal,
  type GrowthLeadCaller,
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
import { badRequest, conflict, databaseErrorText, forbidden, notFound, platformOrganizationId, readObject, readReason, readUuid, type QueryResult } from './growth-http.js';
import { readGrowthIdempotencyKey, runGrowthIdempotent } from './growth-idempotency.js';
import { loadGrowthLeadCaller, loadLead, type WriteContext } from './growth-leads-service.js';
import {
  activityDto,
  addFollowUp,
  closeFollowUp,
  fieldMemberships,
  fieldPage,
  followUpDto,
  leadFieldWork,
  loadActivity,
  loadFollowUp,
  logActivity,
  removeActivityLocation,
  type NewActivityInput,
} from './growth-field-service.js';

const refusalStatus: Readonly<Record<GrowthFieldRefusal, 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN'>> = {
  GROWTH_LEAD_NOT_FOUND: 'NOT_FOUND',
  GROWTH_LEAD_DO_NOT_CONTACT: 'CONFLICT',
  GROWTH_LEAD_CLOSED: 'CONFLICT',
  GROWTH_NOT_LEAD_OWNER: 'FORBIDDEN',
  GROWTH_NOT_FOLLOW_UP_ASSIGNEE: 'FORBIDDEN',
  GROWTH_NOT_ACTIVITY_AUTHOR: 'FORBIDDEN',
};

function fieldRefusal(refusal: GrowthFieldRefusal, correlationId: string): HttpException {
  const status = refusalStatus[refusal];
  return status === 'NOT_FOUND' ? notFound(refusal, correlationId) : status === 'CONFLICT' ? conflict(refusal, correlationId) : forbidden(refusal, correlationId);
}

/** The database's own refusals (its clock and its row state decide a race) → domain codes; never driver text. */
function mapFieldError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const { message } = databaseErrorText(error);
  if (message.includes('more than 7 days old')) return badRequest('GROWTH_REPORT_TOO_OLD', correlationId);
  if (message.includes('report is in the future')) return badRequest('GROWTH_REPORT_IN_FUTURE', correlationId);
  if (message.includes('do-not-contact')) return conflict('GROWTH_LEAD_DO_NOT_CONTACT', correlationId);
  if (message.includes('contact must belong to the same lead')) return badRequest('GROWTH_CONTACT_NOT_ON_LEAD', correlationId);
  if (message.includes('activity must belong to the same lead')) return badRequest('GROWTH_ACTIVITY_NOT_ON_LEAD', correlationId);
  if (message.includes('due date is out of range')) return badRequest('GROWTH_FOLLOW_UP_DUE_OUT_OF_RANGE', correlationId);
  return badRequest('GROWTH_CHANGE_REJECTED', correlationId);
}

const text = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max && !/[<>]/.test(trimmed) ? trimmed : undefined;
};

/** The activity as sent. The report-time rule is applied at write time, so a replay of an accepted report is never refused as stale. */
export function readActivityInput(body: unknown, correlationId: string): NewActivityInput {
  const raw = readObject(body, ['kind', 'outcome', 'contactId', 'notes', 'occurredAt', 'location'], correlationId);
  if (!isGrowthActivityKind(raw.kind)) throw badRequest('GROWTH_ACTIVITY_KIND_INVALID', correlationId);
  const kind = raw.kind;
  let outcome: string | null = null;
  if (growthActivityNeedsOutcome(kind)) {
    if (!isGrowthActivityOutcome(raw.outcome)) throw badRequest('GROWTH_ACTIVITY_OUTCOME_REQUIRED', correlationId);
    outcome = raw.outcome;
  } else if (raw.outcome !== undefined && raw.outcome !== null) {
    throw badRequest('GROWTH_ACTIVITY_OUTCOME_NOT_ALLOWED', correlationId);
  }
  const contactId = raw.contactId === undefined || raw.contactId === null ? null : readUuid(raw.contactId, correlationId);
  const notes = text(raw.notes, GROWTH_ACTIVITY_NOTES_MAX);
  if (notes === undefined) throw badRequest('GROWTH_ACTIVITY_NOTES_INVALID', correlationId);
  if (kind === 'NOTE' && !notes) throw badRequest('GROWTH_ACTIVITY_NOTES_REQUIRED', correlationId);
  if (typeof raw.occurredAt !== 'string' || raw.occurredAt.length > 40 || Number.isNaN(Date.parse(raw.occurredAt))) {
    throw badRequest('GROWTH_ACTIVITY_TIME_INVALID', correlationId);
  }
  const occurredAt = new Date(raw.occurredAt);
  let location = null;
  if (raw.location !== undefined && raw.location !== null) {
    if (!growthActivityAllowsLocation(kind)) throw badRequest('GROWTH_LOCATION_NOT_ALLOWED', correlationId);
    location = readGrowthLocation(raw.location);
    if (!location) throw badRequest('GROWTH_LOCATION_INVALID', correlationId);
  }
  return { kind, outcome, contactId, notes, occurredAt, location };
}

export function growthFieldVocabulary(): Record<string, unknown> {
  return {
    kinds: growthActivityKinds, outcomes: growthActivityOutcomes, cancelReasons: growthFollowUpCancelReasons,
    notesMax: GROWTH_ACTIVITY_NOTES_MAX, titleMax: GROWTH_FOLLOW_UP_TITLE_MAX, reportMaxAgeDays: GROWTH_REPORT_MAX_AGE_DAYS,
    locationRetentionDays: GROWTH_LOCATION_RETENTION_DAYS, listLimit: GROWTH_FIELD_LIST_LIMIT,
    locationNotice: { version: GROWTH_LOCATION_NOTICE_VERSION, status: 'DRAFT_FOR_LEGAL_REVIEW', text: GROWTH_LOCATION_NOTICE_TEXT },
  };
}

@Controller('/api/v1/growth')
export class GrowthFieldController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The Field page: `view=MINE` (default) or `view=TEAM` (managers: their own and their reports' work). */
  @Get('/field')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async field(@Req() request: ProtectedHttpRequest, @Query('view') view: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller } = await this.require(request);
    const which = view === undefined || view === '' ? 'MINE' : view === 'MINE' || view === 'TEAM' ? view : null;
    if (!which) throw badRequest('GROWTH_FIELD_VIEW_INVALID', correlationId);
    const manages = caller.memberships.some((membership) => membership.role === 'GROWTH_MANAGER');
    if (which === 'TEAM' && !manages) throw forbidden('GROWTH_NOT_MANAGER', correlationId);
    const page = await fieldPage(this.db, caller, fieldMemberships(caller, which));
    return { view: which, canSeeTeam: manages, ...page, vocabulary: growthFieldVocabulary(), correlationId };
  }

  @Get('/leads/:leadId/field')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async leadField(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller } = await this.require(request);
    const id = readUuid(leadId, correlationId);
    const loaded = await this.visible(this.db, id, caller, correlationId);
    return {
      leadId: id, canLog: refuseGrowthFieldWrite(caller, loaded.facts) === null,
      ...await leadFieldWork(this.db, id, caller), vocabulary: growthFieldVocabulary(), correlationId,
    };
  }

  @Post('/leads/:leadId/activities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async logActivity(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx, userId } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, true);
    const id = readUuid(leadId, correlationId);
    const input = readActivityInput(body, correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId, route: 'activity.log', target: id, key, body, recordId: this.ids.uuid(), correlationId,
    }, 'growth_activity', async () => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthFieldWrite(caller, loaded.facts);
      if (refusal) throw fieldRefusal(refusal, correlationId);
      const timeRefusal = refuseGrowthReportTime(input.occurredAt, new Date());
      if (timeRefusal) throw badRequest(timeRefusal, correlationId);
      return logActivity(tx, ctx, { leadId: id, authorMembershipId: growthFieldAuthorMembership(caller, loaded.facts)!, activity: input });
    })).catch((error: unknown) => { throw mapFieldError(error, correlationId); });
    const row = (await loadActivity(this.db, result.resourceId))!;
    return { activity: activityDto(row, caller), idempotentReplay: result.replay, correlationId };
  }

  @Post('/leads/:leadId/follow-ups')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addFollowUp(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx, userId } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, true);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['title', 'dueOn', 'activityId'], correlationId);
    const title = text(raw.title, GROWTH_FOLLOW_UP_TITLE_MAX);
    if (!title) throw badRequest('GROWTH_FOLLOW_UP_TITLE_INVALID', correlationId);
    if (typeof raw.dueOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dueOn)) throw badRequest('GROWTH_FOLLOW_UP_DUE_INVALID', correlationId);
    const activityId = raw.activityId === undefined || raw.activityId === null ? null : readUuid(raw.activityId, correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId, route: 'follow_up.add', target: id, key, body, recordId: this.ids.uuid(), correlationId,
    }, 'growth_follow_up', async () => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const refusal = refuseGrowthFieldWrite(caller, loaded.facts);
      if (refusal) throw fieldRefusal(refusal, correlationId);
      const dueRefusal = refuseGrowthFollowUpDue(raw.dueOn, new Date());
      if (dueRefusal) throw badRequest(dueRefusal, correlationId);
      return addFollowUp(tx, ctx, { leadId: id, assigneeMembershipId: growthFieldAuthorMembership(caller, loaded.facts)!, title, dueOn: raw.dueOn as string, activityId });
    })).catch((error: unknown) => { throw mapFieldError(error, correlationId); });
    const row = (await loadFollowUp(this.db, result.resourceId))!;
    return { followUp: followUpDto(row, caller), idempotentReplay: result.replay, correlationId };
  }

  @Post('/follow-ups/:followUpId/complete')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async complete(@Req() request: ProtectedHttpRequest, @Param('followUpId') followUpId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    readObject(body ?? {}, [], this.correlation(request));
    return this.close(request, followUpId, 'DONE', null, body ?? {});
  }

  @Post('/follow-ups/:followUpId/cancel')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async cancel(@Req() request: ProtectedHttpRequest, @Param('followUpId') followUpId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const correlationId = this.correlation(request);
    const raw = readObject(body, ['reasonCode'], correlationId);
    return this.close(request, followUpId, 'CANCELLED', readReason(raw.reasonCode, growthFollowUpCancelReasons, correlationId), body);
  }

  /** The author removes the location from one of their own activities (AUTHOR_REMOVED). */
  @Post('/activities/:activityId/remove-location')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeLocation(@Req() request: ProtectedHttpRequest, @Param('activityId') activityId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const id = readUuid(activityId, correlationId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM growth_activities WHERE id = ${id}::uuid FOR UPDATE`);
      const row = await loadActivity(tx, id);
      // Someone who may not see where the visit was logged learns nothing about it.
      if (!row || refuseGrowthLocationRemoval(caller, row.author_membership_id)) throw notFound('GROWTH_ACTIVITY_NOT_FOUND', correlationId);
      await removeActivityLocation(tx, ctx, id);
    }).catch((error: unknown) => { throw mapFieldError(error, correlationId); });
    return { activity: activityDto((await loadActivity(this.db, id))!, caller), correlationId };
  }

  // -------------------------------------------------------------------------

  private async close(request: ProtectedHttpRequest, followUpId: string, state: 'DONE' | 'CANCELLED', reasonCode: string | null, body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx, userId } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, true);
    const id = readUuid(followUpId, correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId, route: state === 'DONE' ? 'follow_up.complete' : 'follow_up.cancel', target: id, key, body, recordId: this.ids.uuid(), correlationId,
    }, 'growth_follow_up', async () => {
      const row = await loadFollowUp(tx, id, true);
      if (!row) throw notFound('GROWTH_FOLLOW_UP_NOT_FOUND', correlationId);
      const refusal = refuseGrowthFollowUpClose(caller, row.assignee_membership_id);
      // A follow-up of someone the caller does not manage is not disclosed.
      if (refusal) throw notFound('GROWTH_FOLLOW_UP_NOT_FOUND', correlationId);
      await closeFollowUp(tx, ctx, { followUpId: id, leadId: row.lead_id, state, reasonCode });
      return id;
    })).catch((error: unknown) => { throw mapFieldError(error, correlationId); });
    const row = (await loadFollowUp(this.db, result.resourceId))!;
    return { followUp: followUpDto(row, caller), idempotentReplay: result.replay, correlationId };
  }

  private correlation(request: ProtectedHttpRequest): string {
    return requireTrustedAuthorization(request).correlationId;
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller }> {
    const context = requireTrustedAuthorization(request);
    if (!growthWorkspaceRole(context.authorization.memberships)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const userId = context.authorization.principal.userId;
    const caller = await loadGrowthLeadCaller(this.db, { userId, growthAdmin: false });
    if (!caller.memberships.length) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, userId, caller };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller; readonly ctx: WriteContext }> {
    const { correlationId, userId, caller } = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return { correlationId, userId, caller, ctx: { actorUserId: userId, organizationId, correlationId, uuid: () => this.ids.uuid() } };
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
