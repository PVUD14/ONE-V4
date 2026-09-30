/**
 * Operations Security — the incident register and breach clocks (OPS-16, Appendix 1 §3 Security,
 * §5.2, §5.3).
 *
 * INCIDENT_MANAGE covers the register: declare an incident, work it through the state machine,
 * re-grade and reclassify it, keep its timeline, name the organisations it affects, and record when
 * a person reported a breach to the Data Protection Board and told the affected people. Every
 * write carries a reason code from the lists in packages/authorization and writes its timeline,
 * audit and (for declarations and state changes) outbox rows in one transaction. The breach clock
 * is computed on the database clock; its period comes from the plan and is labelled as pending
 * legal confirmation. Nothing here contacts the Board or any other external party.
 *
 * Design: docs/architecture/incident-register-table-design.md
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  breachBoardClockHours,
  breachClockBasis,
  breachClockBasisText,
  containsContactDetails,
  hasInternalCapability,
  incidentBoardNotifiedReasons,
  incidentCategories,
  incidentCategoryReasons,
  incidentCloseFromOpenReasons,
  incidentDeclareReasons,
  incidentNoteReasons,
  incidentOrganizationAddReasons,
  incidentOrganizationRemoveReasons,
  incidentSeverities,
  incidentSeverityReasons,
  incidentStates,
  incidentTransitionReasons,
  incidentTransitions,
  incidentUsersNotifiedReasons,
  isIncidentState,
  refuseIncidentReclassification,
  refuseIncidentTransition,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentState,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  addIncidentNote,
  addIncidentOrganization,
  changeIncidentCategory,
  changeIncidentSeverity,
  declareIncident,
  IncidentError,
  listIncidents,
  loadIncident,
  loadIncidentOrganizations,
  loadIncidentTimeline,
  recordIncidentNotification,
  recordIncidentRead,
  removeIncidentOrganization,
  searchIncidentOrganizations,
  summariseIncidents,
  transitionIncident,
  type IncidentView,
} from '@planthepath/persistence/src/incidents.js';
import { listStatusNotices } from '@planthepath/persistence/src/status-notices.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const boardReferencePattern = /^[A-Za-z0-9._:/-]{3,64}$/;
const defaultLimit = 50;
const maxLimit = 200;
const views: readonly IncidentView[] = ['ACTIVE', 'ALL', ...incidentStates];

@Controller('/api/v1/operations/incidents')
export class OperationsIncidentsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the register's forms need: vocabularies, transitions, reason codes and the clock's basis. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    return {
      categories: incidentCategories,
      severities: incidentSeverities,
      states: incidentStates,
      transitions: incidentTransitions,
      breachClock: { hours: breachBoardClockHours, basis: breachClockBasis, basisText: breachClockBasisText },
      reasons: {
        declare: incidentDeclareReasons,
        transition: incidentTransitionReasons,
        closeFromOpen: incidentCloseFromOpenReasons,
        severity: incidentSeverityReasons,
        category: incidentCategoryReasons,
        note: incidentNoteReasons,
        organizationAdd: incidentOrganizationAddReasons,
        organizationRemove: incidentOrganizationRemoveReasons,
        boardNotified: incidentBoardNotifiedReasons,
        usersNotified: incidentUsersNotifiedReasons,
      },
      correlationId,
    };
  }

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    rejectUnknown(query, ['view', 'category', 'limit', 'cursor'], correlationId);
    const view = optionalEnum(query.view, views, 'INCIDENT_VIEW_INVALID', correlationId) ?? 'ACTIVE';
    const category = optionalEnum(query.category, incidentCategories, 'INCIDENT_CATEGORY_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listIncidents(this.db, { view, ...(category ? { category } : {}), limit, ...(cursor ? { cursor: { declaredAt: cursor.at, id: cursor.id } } : {}) });
    return {
      incidents: page.incidents,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.declaredAt, page.nextCursor.id) : null,
      summary: await summariseIncidents(this.db),
      correlationId,
    };
  }

  @Post()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async declare(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const raw = readObject(body, ['title', 'summary', 'category', 'severity', 'detectedAt', 'reasonCode'], correlationId);
    const title = requireIncidentText(raw.title, 120, 'INCIDENT_TITLE_INVALID', correlationId);
    const summary = requireIncidentText(raw.summary, 1000, 'INCIDENT_SUMMARY_INVALID', correlationId);
    const category = requireEnum(raw.category, incidentCategories, 'INCIDENT_CATEGORY_INVALID', correlationId);
    const severity = requireEnum(raw.severity, incidentSeverities, 'INCIDENT_SEVERITY_INVALID', correlationId);
    const detectedAt = requireIso(raw.detectedAt, 'INCIDENT_DETECTED_AT_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentDeclareReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      const { id } = await declareIncident(this.db, { title, summary, category, severity, detectedAt, reasonCode, actorUserId: actor.userId, correlationId });
      return { incident: await loadIncident(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Colleges and employers to add to an incident, by name (at least 2 characters, at most 20 results). */
  @Get('/organization-options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async organizationOptions(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    rejectUnknown(query, ['q'], correlationId);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q.length < 2 || q.length > 120) throw badRequest('INCIDENT_SEARCH_TOO_SHORT', correlationId);
    return { organizations: await searchIncidentOrganizations(this.db, q), correlationId };
  }

  @Get('/:incidentId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const detail = await this.detailDto(id);
    if (!detail) throw new NotFoundException(domainError('INCIDENT_NOT_FOUND', correlationId));
    await recordIncidentRead(this.db, { actorUserId: actor.userId, incidentId: id, correlationId });
    return { ...detail, correlationId };
  }

  @Post('/:incidentId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['toState', 'reasonCode', 'note'], correlationId);
    if (!isIncidentState(raw.toState)) throw badRequest('INCIDENT_STATE_INVALID', correlationId);
    const toState: IncidentState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const note = optionalIncidentText(raw.note, 500, 'INCIDENT_NOTE_INVALID', correlationId);
    try {
      await transitionIncident(this.db, {
        incidentId: id, toState, reasonCode, note, actorUserId: actor.userId, correlationId,
        refuse: (current) => refuseIncidentTransition({ from: current.state, to: toState, reasonCode, category: current.category, boardNotified: current.boardNotified, usersNotified: current.usersNotified }),
      });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:incidentId/severity')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async severity(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['severity', 'reasonCode'], correlationId);
    const severity = requireEnum(raw.severity, incidentSeverities, 'INCIDENT_SEVERITY_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentSeverityReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await changeIncidentSeverity(this.db, { incidentId: id, severity: severity as IncidentSeverity, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:incidentId/category')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async category(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['category', 'reasonCode'], correlationId);
    const category = requireEnum(raw.category, incidentCategories, 'INCIDENT_CATEGORY_INVALID', correlationId) as IncidentCategory;
    const reasonCode = requireEnum(raw.reasonCode, incidentCategoryReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await changeIncidentCategory(this.db, {
        incidentId: id, category, reasonCode, actorUserId: actor.userId, correlationId,
        refuse: (current) => refuseIncidentReclassification({ from: current.category, to: category, state: current.state, boardNotified: current.boardNotified, usersNotified: current.usersNotified }),
      });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:incidentId/notes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async note(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['note', 'reasonCode'], correlationId);
    const note = requireIncidentText(raw.note, 500, 'INCIDENT_NOTE_INVALID', correlationId, 1);
    const reasonCode = requireEnum(raw.reasonCode, incidentNoteReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await addIncidentNote(this.db, { incidentId: id, note, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:incidentId/organizations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addOrganization(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['organizationId', 'reasonCode'], correlationId);
    const organizationId = requireUuid(raw.organizationId, correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentOrganizationAddReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await addIncidentOrganization(this.db, { incidentId: id, organizationId, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // The path parameter is not called organizationId: that name selects the caller's membership
  // in api-security, and an operator is not a member of the college.
  @Post('/:incidentId/organizations/:affectedOrgId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeOrganization(
    @Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Param('affectedOrgId') organizationId: string, @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const orgId = requireUuid(organizationId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentOrganizationRemoveReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await removeIncidentOrganization(this.db, { incidentId: id, organizationId: orgId, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Record that a person reported the breach to the Data Protection Board. ONE sends nothing. */
  @Post('/:incidentId/board-notification')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async boardNotification(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['notifiedAt', 'reasonCode', 'reference'], correlationId);
    const notifiedAt = requireIso(raw.notifiedAt, 'INCIDENT_NOTIFIED_AT_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentBoardNotifiedReasons, 'REASON_CODE_INVALID', correlationId);
    let reference: string | null = null;
    if (raw.reference !== undefined && raw.reference !== null && raw.reference !== '') {
      if (typeof raw.reference !== 'string' || !boardReferencePattern.test(raw.reference.trim())) throw badRequest('INCIDENT_BOARD_REFERENCE_INVALID', correlationId);
      reference = raw.reference.trim();
    }
    try {
      await recordIncidentNotification(this.db, { incidentId: id, audience: 'BOARD', notifiedAt, reference, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Record that the affected people were told, and when. */
  @Post('/:incidentId/users-notification')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async usersNotification(@Req() request: ProtectedHttpRequest, @Param('incidentId') incidentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(incidentId, correlationId);
    const raw = readObject(body, ['notifiedAt', 'reasonCode'], correlationId);
    const notifiedAt = requireIso(raw.notifiedAt, 'INCIDENT_NOTIFIED_AT_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, incidentUsersNotifiedReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await recordIncidentNotification(this.db, { incidentId: id, audience: 'USERS', notifiedAt, reasonCode, actorUserId: actor.userId, correlationId });
      return { ...(await this.detailDto(id)), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'INCIDENT_MANAGE')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  private async detailDto(incidentId: string): Promise<Record<string, unknown> | null> {
    const incident = await loadIncident(this.db, incidentId);
    if (!incident) return null;
    const [timeline, organizations, notices] = await Promise.all([
      loadIncidentTimeline(this.db, incidentId),
      loadIncidentOrganizations(this.db, incidentId),
      listStatusNotices(this.db, { incidentId, limit: 50 }),
    ]);
    return {
      incident,
      allowedTransitions: incidentTransitions[incident.state],
      timeline,
      organizations,
      // Notices sent about this incident: counts per state only, never a recipient list.
      notices: notices.notices.map((notice) => ({
        id: notice.id, state: notice.state, templateKey: notice.template.templateKey, templateVersion: notice.template.version,
        subject: notice.template.subject, approvedBy: notice.approvedBy, approvedAt: notice.approvedAt, approveMode: notice.approveMode, sentAt: notice.sentAt,
        recipientCount: notice.recipientCount, organizationCount: notice.organizationCount, email: notice.email,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof IncidentError) {
    if (error.code.endsWith('_NOT_FOUND')) return new NotFoundException(domainError(error.code, correlationId));
    if (['INCIDENT_CLOSED', 'INCIDENT_BOARD_ALREADY_NOTIFIED', 'INCIDENT_USERS_ALREADY_NOTIFIED', 'INCIDENT_ORGANIZATION_ALREADY_ADDED',
      'INCIDENT_BREACH_ALREADY_NOTIFIED', 'INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING'].includes(error.code)) {
      return new ConflictException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('INCIDENT_REJECTED', correlationId);
}

function rejectUnknown(raw: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function requireUuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  return requireEnum(value, allowed, code, correlationId);
}

/** Free text on an incident: bounded, and never an email address or a phone number (§5.5). */
function requireIncidentText(value: unknown, max: number, code: string, correlationId: string, min = 3): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  if (containsContactDetails(text)) throw badRequest('INCIDENT_TEXT_PERSONAL_DATA', correlationId);
  return text;
}

function optionalIncidentText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireIncidentText(value, max, code, correlationId, 1);
}

function requireIso(value: unknown, code: string, correlationId: string): string {
  if (typeof value !== 'string' || !isoPattern.test(value) || Number.isNaN(Date.parse(value))) throw badRequest(code, correlationId);
  return value;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('INCIDENT_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly at: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('INCIDENT_CURSOR_INVALID', correlationId);
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!at || !id || rest.length || Number.isNaN(Date.parse(at)) || !uuidPattern.test(id)) throw badRequest('INCIDENT_CURSOR_INVALID', correlationId);
  return { at, id };
}
