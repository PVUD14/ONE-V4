/**
 * Operations Support — the support case desk and the minimised account lookup (OPS-05,
 * Appendix 1 §3 Support, §5.2, §5.3, §5.5).
 *
 * SUPPORT_CASES covers the case desk: log a call or email as a case, work it through the
 * state machine, add notes, assign it, resolve and close it. SUPPORT_ACCOUNT_LOOKUP
 * covers the account view: masked contacts, memberships, invitations, open cases and a
 * short audit timeline, with the full contact behind a separate, reason-coded, audited
 * reveal. Every write carries a reason code from the lists in packages/authorization and
 * writes its history, audit and outbox rows in one transaction; reads of personal data
 * are audited as `*.viewed` / `*.searched`.
 *
 * Deliberately absent: attachments, email ingestion, impersonation ("view as user"),
 * academic records, documents and assistant conversations.
 *
 * Design: docs/architecture/support-cases-table-design.md
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
import { sql } from 'drizzle-orm';
import {
  hasInternalCapability,
  isEligibleSupportAssignee,
  isSupportCaseState,
  refuseSupportCaseTransition,
  supportCaseAssignReasons,
  supportCaseCategories,
  supportCaseChannels,
  supportCaseNoteReasons,
  supportCaseOpenReasons,
  supportCaseSeverities,
  supportCaseSlaHours,
  supportCaseTransitionReasons,
  supportCaseTransitions,
  supportContactRevealReasons,
  type InternalCapability,
  type InternalCapabilityContext,
  type SupportCaseCategory,
  type SupportCaseChannel,
  type SupportCaseSeverity,
  type SupportCaseState,
} from '@planthepath/authorization/src/index.js';
import {
  addSupportCaseNote,
  assignSupportCase,
  listSupportCases,
  loadSupportAccount,
  loadSupportCase,
  openSupportCase,
  recordSupportRead,
  revealSupportAccountContact,
  searchSupportAccounts,
  summariseSupportCases,
  SupportDeskError,
  transitionSupportCase,
  type SupportCaseView,
} from '@planthepath/persistence/src/support-cases.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };
type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const correlationPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const defaultLimit = 50;
const maxLimit = 200;
const summaryLimit = 500;
const caseNoteLimit = 2000;
const views: readonly SupportCaseView[] = ['ACTIVE', 'ALL', 'OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'];

@Controller('/api/v1/operations/support')
export class OperationsSupportController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the desk's forms need: the vocabularies, reason codes, SLA targets and assignees. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireAny(request, ['SUPPORT_CASES', 'SUPPORT_ACCOUNT_LOOKUP']);
    const cases = hasInternalCapability(actor, 'SUPPORT_CASES');
    return {
      viewer: { cases, accountLookup: hasInternalCapability(actor, 'SUPPORT_ACCOUNT_LOOKUP') },
      channels: supportCaseChannels,
      categories: supportCaseCategories,
      severities: supportCaseSeverities,
      slaHours: supportCaseSlaHours,
      transitions: supportCaseTransitions,
      reasons: {
        open: supportCaseOpenReasons,
        transition: supportCaseTransitionReasons,
        note: supportCaseNoteReasons,
        assign: supportCaseAssignReasons,
        reveal: supportContactRevealReasons,
      },
      assignees: cases ? await this.eligibleAssignees(actor.userId) : [],
      correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // Cases
  // -------------------------------------------------------------------------

  @Get('/cases')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    rejectUnknown(query, ['view', 'severity', 'category', 'assignee', 'subjectUserId', 'overdue', 'limit', 'cursor'], correlationId);
    const view = optionalEnum(query.view, views, 'SUPPORT_VIEW_INVALID', correlationId) ?? 'ACTIVE';
    const severity = optionalEnum(query.severity, supportCaseSeverities, 'SUPPORT_SEVERITY_INVALID', correlationId);
    const category = optionalEnum(query.category, supportCaseCategories, 'SUPPORT_CATEGORY_INVALID', correlationId);
    const assignee = optionalEnum(query.assignee, ['ME', 'UNASSIGNED'] as const, 'SUPPORT_ASSIGNEE_FILTER_INVALID', correlationId);
    const subjectUserId = query.subjectUserId === undefined || query.subjectUserId === '' ? undefined : requireUuid(query.subjectUserId, correlationId);
    if (query.overdue !== undefined && query.overdue !== '' && query.overdue !== 'true' && query.overdue !== 'false') throw badRequest('SUPPORT_OVERDUE_FILTER_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listSupportCases(this.db, {
      filters: {
        view, ...(severity ? { severity } : {}), ...(category ? { category } : {}), ...(assignee ? { assignee } : {}),
        ...(subjectUserId ? { subjectUserId } : {}), overdueOnly: query.overdue === 'true',
      },
      viewerUserId: actor.userId, limit, ...(cursor ? { cursor: { openedAt: cursor.at, id: cursor.id } } : {}),
    });
    return {
      cases: page.cases.map((row) => ({ ...row, assignee: row.assignee ? { email: row.assignee.email, isSelf: row.assignee.userId === actor.userId } : null })),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.openedAt, page.nextCursor.id) : null,
      summary: await summariseSupportCases(this.db, actor.userId),
      correlationId,
    };
  }

  @Post('/cases')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async open(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    const raw = readObject(body, ['channel', 'category', 'severity', 'summary', 'reasonCode', 'subjectUserId', 'organizationId', 'assignToMe'], correlationId);
    const channel = requireEnum(raw.channel, supportCaseChannels, 'SUPPORT_CHANNEL_INVALID', correlationId);
    const category = requireEnum(raw.category, supportCaseCategories, 'SUPPORT_CATEGORY_INVALID', correlationId);
    const severity = requireEnum(raw.severity, supportCaseSeverities, 'SUPPORT_SEVERITY_INVALID', correlationId);
    const summary = requireText(raw.summary, 3, summaryLimit, 'SUPPORT_SUMMARY_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, supportCaseOpenReasons, 'REASON_CODE_INVALID', correlationId);
    const subjectUserId = raw.subjectUserId === undefined || raw.subjectUserId === null ? null : requireUuid(raw.subjectUserId, correlationId);
    const organizationId = raw.organizationId === undefined || raw.organizationId === null ? null : requireUuid(raw.organizationId, correlationId);
    if (raw.assignToMe !== undefined && typeof raw.assignToMe !== 'boolean') throw badRequest('INVALID_REQUEST', correlationId);
    try {
      const { id } = await openSupportCase(this.db, {
        channel: channel as SupportCaseChannel, category: category as SupportCaseCategory, severity: severity as SupportCaseSeverity,
        summary, reasonCode, subjectUserId, organizationId, assignToUserId: raw.assignToMe === true ? actor.userId : null,
        actorUserId: actor.userId, correlationId,
      });
      return { case: await this.caseDto(id, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Get('/cases/:caseId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    const id = requireUuid(caseId, correlationId);
    const found = await this.caseDto(id, actor);
    if (!found) throw new NotFoundException(domainError('SUPPORT_CASE_NOT_FOUND', correlationId));
    // The summary and notes may be about a person: reading them is audited (§5.2).
    await recordSupportRead(this.db, { actorUserId: actor.userId, action: 'operations.support_case.viewed', resourceType: 'support_case', resourceId: id, correlationId });
    return { case: found, correlationId };
  }

  @Post('/cases/:caseId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    const id = requireUuid(caseId, correlationId);
    const raw = readObject(body, ['toState', 'reasonCode', 'note'], correlationId);
    if (!isSupportCaseState(raw.toState)) throw badRequest('SUPPORT_STATE_INVALID', correlationId);
    const toState: SupportCaseState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const note = optionalText(raw.note, caseNoteLimit, 'SUPPORT_NOTE_INVALID', correlationId);
    try {
      await transitionSupportCase(this.db, {
        caseId: id, toState, reasonCode, note, actorUserId: actor.userId, correlationId,
        allowed: (from) => {
          const refusal = refuseSupportCaseTransition(from, toState, reasonCode);
          if (refusal === 'REASON_CODE_INVALID') throw badRequest('REASON_CODE_INVALID', correlationId);
          return refusal === null;
        },
      });
      return { case: await this.caseDto(id, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/cases/:caseId/notes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async note(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    const id = requireUuid(caseId, correlationId);
    const raw = readObject(body, ['note', 'reasonCode', 'linkedCorrelationId'], correlationId);
    const note = requireText(raw.note, 1, caseNoteLimit, 'SUPPORT_NOTE_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, supportCaseNoteReasons, 'REASON_CODE_INVALID', correlationId);
    let linkedCorrelationId: string | null = null;
    if (raw.linkedCorrelationId !== undefined && raw.linkedCorrelationId !== null && raw.linkedCorrelationId !== '') {
      if (typeof raw.linkedCorrelationId !== 'string' || !correlationPattern.test(raw.linkedCorrelationId.trim())) throw badRequest('SUPPORT_REFERENCE_INVALID', correlationId);
      linkedCorrelationId = raw.linkedCorrelationId.trim();
    }
    try {
      await addSupportCaseNote(this.db, { caseId: id, note, reasonCode, linkedCorrelationId, actorUserId: actor.userId, correlationId });
      return { case: await this.caseDto(id, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/cases/:caseId/assign')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assign(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_CASES');
    const id = requireUuid(caseId, correlationId);
    const raw = readObject(body, ['assigneeUserId', 'reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, supportCaseAssignReasons, 'REASON_CODE_INVALID', correlationId);
    const assigneeUserId = raw.assigneeUserId === null ? null : requireUuid(raw.assigneeUserId, correlationId);
    if (assigneeUserId && !(await this.eligibleAssignees(actor.userId)).some((person) => person.userId === assigneeUserId)) {
      throw badRequest('SUPPORT_ASSIGNEE_NOT_ELIGIBLE', correlationId);
    }
    try {
      await assignSupportCase(this.db, { caseId: id, assigneeUserId, reasonCode, actorUserId: actor.userId, correlationId });
      return { case: await this.caseDto(id, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  @Get('/accounts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async searchAccounts(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_ACCOUNT_LOOKUP');
    rejectUnknown(query, ['q', 'limit', 'cursor'], correlationId);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    // There is no "list every account": a lookup starts from something the caller said.
    const kind = uuidPattern.test(q) ? 'ID' as const : emailPattern.test(q) ? 'EMAIL' as const : q.length >= 3 && q.length <= 254 ? 'PARTIAL' as const : null;
    if (!kind) throw badRequest('SUPPORT_SEARCH_TOO_SHORT', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await searchSupportAccounts(this.db, {
      query: { kind, value: kind === 'ID' ? q.toLowerCase() : q }, limit, ...(cursor ? { cursor: { createdAt: cursor.at, id: cursor.id } } : {}),
    });
    // The search text is not copied into audit: it is often an address.
    await recordSupportRead(this.db, {
      actorUserId: actor.userId, action: 'operations.support_account.searched', resourceType: 'support_account', resourceId: 'search', correlationId,
      context: { queryKind: kind, resultCount: page.accounts.length },
    });
    return {
      accounts: page.accounts,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.createdAt, page.nextCursor.id) : null,
      correlationId,
    };
  }

  @Get('/accounts/:userId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async account(@Req() request: ProtectedHttpRequest, @Param('userId') userId: string): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_ACCOUNT_LOOKUP');
    const id = requireUuid(userId, correlationId).toLowerCase();
    const view = await loadSupportAccount(this.db, id);
    if (!view) throw new NotFoundException(domainError('SUPPORT_ACCOUNT_NOT_FOUND', correlationId));
    await recordSupportRead(this.db, { actorUserId: actor.userId, action: 'operations.support_account.viewed', resourceType: 'support_account', resourceId: id, correlationId });
    return { ...view, canOpenCase: hasInternalCapability(actor, 'SUPPORT_CASES'), correlationId };
  }

  @Post('/accounts/:userId/contact-reveal')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reveal(@Req() request: ProtectedHttpRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'SUPPORT_ACCOUNT_LOOKUP');
    const id = requireUuid(userId, correlationId).toLowerCase();
    const raw = readObject(body, ['reasonCode', 'caseId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, supportContactRevealReasons, 'REASON_CODE_INVALID', correlationId);
    const caseId = raw.caseId === undefined || raw.caseId === null ? null : requireUuid(raw.caseId, correlationId);
    try {
      const contact = await revealSupportAccountContact(this.db, { userId: id, reasonCode, caseId, actorUserId: actor.userId, correlationId });
      return { contact, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest, capability: InternalCapability): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    return this.requireAny(request, [capability]);
  }

  private async requireAny(request: ProtectedHttpRequest, capabilities: readonly InternalCapability[]): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!capabilities.some((capability) => hasInternalCapability(actor, capability))) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
    return { correlationId: context.correlationId, actor };
  }

  /** People who may be given a case: ACTIVE platform staff holding SUPPORT_CASES. */
  private async eligibleAssignees(viewerUserId: string): Promise<readonly { readonly userId: string; readonly email: string; readonly isSelf: boolean }[]> {
    const result = await this.db.execute(sql`
      SELECT u.id AS user_id, u.email, m.role, m.state::text AS state,
             COALESCE(array_agg(c.capability) FILTER (WHERE c.id IS NOT NULL), '{}') AS grants
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
      LEFT JOIN membership_capabilities c ON c.membership_id = m.id AND c.revoked_at IS NULL
      WHERE m.state = 'ACTIVE'
      GROUP BY u.id, u.email, m.id, m.role, m.state
    `) as QueryResult<{ user_id: string; email: string; role: string; state: string; grants: string[] }>;
    const byUser = new Map<string, { email: string; memberships: { role: string; state: string; grants: string[] }[] }>();
    for (const row of result.rows) {
      const entry = byUser.get(row.user_id) ?? { email: row.email, memberships: [] };
      entry.memberships.push({ role: row.role, state: row.state, grants: row.grants });
      byUser.set(row.user_id, entry);
    }
    return [...byUser.entries()]
      .filter(([, entry]) => isEligibleSupportAssignee(entry.memberships))
      .map(([userId, entry]) => ({ userId, email: entry.email, isSelf: userId === viewerUserId }))
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  private async caseDto(caseId: string, actor: Actor): Promise<Record<string, unknown> | null> {
    const found = await loadSupportCase(this.db, caseId);
    if (!found) return null;
    const { assignee, ...rest } = found;
    return {
      ...rest,
      assignee: assignee ? { userId: assignee.userId, email: assignee.email, isSelf: assignee.userId === actor.userId } : null,
      allowedTransitions: supportCaseTransitions[found.state],
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
  if (error instanceof SupportDeskError) {
    if (error.code.endsWith('_NOT_FOUND')) return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'SUPPORT_ACCOUNT_DELETED' || error.code === 'SUPPORT_CASE_CLOSED') return new ConflictException(domainError(error.code, correlationId));
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('SUPPORT_CASE_REJECTED', correlationId);
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

function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, 1, max, code, correlationId);
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('SUPPORT_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly at: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('SUPPORT_CURSOR_INVALID', correlationId);
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!at || !id || rest.length || Number.isNaN(Date.parse(at)) || !uuidPattern.test(id)) throw badRequest('SUPPORT_CURSOR_INVALID', correlationId);
  return { at, id };
}
