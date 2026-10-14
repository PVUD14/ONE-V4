/**
 * Operations college health (Analytics) and college account fields (Organization Detail)
 * — OPS-14, Appendix 1 §3 Customer success, §4.2, §5.2–5.7.
 *
 * `/operations/analytics/colleges`: a bounded, suppressed summary per college and one
 * college's view, needing ANALYTICS_VIEW. Aggregates only: no student is named, every count
 * of people below 5 is suppressed in the persistence layer before it reaches this file, and
 * so, like the Overview and role demand, the read writes no audit row.
 *
 * `/operations/college-accounts`: renewal date, contract reference, AI8HT account owner and
 * the college's contacts, needing ACCOUNT_MANAGE for reads and writes. Every write carries
 * a reason code from packages/authorization, rejects unknown fields, and writes its audit
 * row in the same transaction. Contacts are masked; the full value comes only from an
 * audited, reason-coded reveal. None of these actions is high-risk under §5.4, so none
 * goes through dual control.
 *
 * Design: docs/architecture/institution-accounts-table-design.md
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
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  canManageCollegeAccount,
  canViewCollegeHealth,
  collegeAccountUpdateReasons,
  collegeContactAddReasons,
  collegeContactRemoveReasons,
  collegeContactRevealReasons,
  collegeContactRoles,
  isValidContractReference,
  isValidRenewalDate,
  normaliseContactEmail,
  normaliseContactPhone,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import { readCollegeHealthDetail, readCollegeHealthList } from '@planthepath/persistence/src/college-health.js';
import {
  addCollegeContact,
  CollegeAccountError,
  listCollegeAccountOwnerOptions,
  loadCollegeAccount,
  removeCollegeContact,
  revealCollegeContact,
  updateCollegeAccount,
  type CollegeAccountPatch,
} from '@planthepath/persistence/src/institution-accounts.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

// Route parameters are `collegeId`, never `institutionId`: the authentication guard treats an
// `institutionId` parameter as the organisation the caller acts inside and demands a membership
// there, which an AI8HT operator never has.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noteLimit = 500;

async function requireCapability(db: PersistenceDb, request: ProtectedHttpRequest, allowed: (actor: Actor) => boolean): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
  const context = requireTrustedAuthorization(request);
  const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(db));
  if (!allowed(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  return { correlationId: context.correlationId, actor };
}

@Controller('/api/v1/operations/analytics/colleges')
export class OperationsCollegeHealthController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await requireCapability(this.db, request, canViewCollegeHealth);
    // One bounded summary; a parameter is a mistake, not a filter to ignore.
    if (Object.keys(query ?? {}).length) throw badRequest('INVALID_REQUEST', correlationId);
    try {
      return { health: await readCollegeHealthList(this.db), correlationId };
    } catch {
      // Never forward database or driver text to the browser.
      throw new InternalServerErrorException(domainError('COLLEGE_HEALTH_UNAVAILABLE', correlationId));
    }
  }

  @Get('/:collegeId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await requireCapability(this.db, request, canViewCollegeHealth);
    if (Object.keys(query ?? {}).length) throw badRequest('INVALID_REQUEST', correlationId);
    if (!uuidPattern.test(institutionId)) throw badRequest('COLLEGE_ID_INVALID', correlationId);
    let detail;
    try {
      detail = await readCollegeHealthDetail(this.db, institutionId.toLowerCase());
    } catch {
      throw new InternalServerErrorException(domainError('COLLEGE_HEALTH_UNAVAILABLE', correlationId));
    }
    if (!detail) throw new NotFoundException(domainError('COLLEGE_NOT_FOUND', correlationId));
    return { detail, correlationId };
  }
}

@Controller('/api/v1/operations/college-accounts')
export class OperationsCollegeAccountsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the account forms need: vocabularies, reason codes and who may own an account. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await requireCapability(this.db, request, canManageCollegeAccount);
    if (Object.keys(query ?? {}).length) throw badRequest('INVALID_REQUEST', correlationId);
    return {
      contactRoles: collegeContactRoles,
      reasons: { update: collegeAccountUpdateReasons, addContact: collegeContactAddReasons, removeContact: collegeContactRemoveReasons, reveal: collegeContactRevealReasons },
      owners: await listCollegeAccountOwnerOptions(this.db),
      correlationId,
    };
  }

  @Get('/:collegeId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async read(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await requireCapability(this.db, request, canManageCollegeAccount);
    if (Object.keys(query ?? {}).length) throw badRequest('INVALID_REQUEST', correlationId);
    const id = requireUuid(institutionId, 'COLLEGE_ID_INVALID', correlationId);
    const account = await loadCollegeAccount(this.db, id).catch(() => { throw badRequest('COLLEGE_ACCOUNT_REJECTED', correlationId); });
    if (!account) throw new NotFoundException(domainError('COLLEGE_NOT_FOUND', correlationId));
    return { account, correlationId };
  }

  @Patch('/:collegeId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async update(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await requireCapability(this.db, request, canManageCollegeAccount);
    const id = requireUuid(institutionId, 'COLLEGE_ID_INVALID', correlationId);
    const raw = readObject(body, ['reasonCode', 'note', 'expectedVersion', 'renewalDate', 'contractReference', 'accountOwnerMembershipId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, collegeAccountUpdateReasons, 'REASON_CODE_INVALID', correlationId);
    const note = optionalNote(raw.note, correlationId);
    let expectedVersion: number | null = null;
    if (raw.expectedVersion !== undefined && raw.expectedVersion !== null) {
      if (typeof raw.expectedVersion !== 'number' || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 1) throw badRequest('EXPECTED_VERSION_INVALID', correlationId);
      expectedVersion = raw.expectedVersion;
    }
    const patch: { -readonly [K in keyof CollegeAccountPatch]: CollegeAccountPatch[K] } = {};
    if (raw.renewalDate !== undefined) {
      if (raw.renewalDate !== null && (typeof raw.renewalDate !== 'string' || !isValidRenewalDate(raw.renewalDate))) throw badRequest('RENEWAL_DATE_INVALID', correlationId);
      patch.renewalDate = raw.renewalDate;
    }
    if (raw.contractReference !== undefined) {
      if (raw.contractReference !== null && (typeof raw.contractReference !== 'string' || !isValidContractReference(raw.contractReference))) throw badRequest('CONTRACT_REFERENCE_INVALID', correlationId);
      patch.contractReference = raw.contractReference;
    }
    if (raw.accountOwnerMembershipId !== undefined) {
      patch.accountOwnerMembershipId = raw.accountOwnerMembershipId === null ? null : requireUuid(raw.accountOwnerMembershipId, 'ACCOUNT_OWNER_INVALID', correlationId);
    }
    if (!Object.keys(patch).length) throw badRequest('NO_FIELDS_TO_CHANGE', correlationId);
    try {
      await updateCollegeAccount(this.db, { institutionId: id, actorUserId: actor.userId, reasonCode, note, correlationId, patch, expectedVersion });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return { account: await loadCollegeAccount(this.db, id), correlationId };
  }

  @Post('/:collegeId/contacts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addContact(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await requireCapability(this.db, request, canManageCollegeAccount);
    const id = requireUuid(institutionId, 'COLLEGE_ID_INVALID', correlationId);
    const raw = readObject(body, ['reasonCode', 'note', 'role', 'name', 'email', 'phone'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, collegeContactAddReasons, 'REASON_CODE_INVALID', correlationId);
    const note = optionalNote(raw.note, correlationId);
    const role = requireEnum(raw.role, collegeContactRoles, 'CONTACT_ROLE_INVALID', correlationId);
    if (typeof raw.name !== 'string' || raw.name.trim().length < 1 || raw.name.trim().length > 120) throw badRequest('CONTACT_NAME_INVALID', correlationId);
    const email = raw.email === undefined || raw.email === null || raw.email === '' ? null : typeof raw.email === 'string' ? normaliseContactEmail(raw.email) : null;
    if (raw.email !== undefined && raw.email !== null && raw.email !== '' && email === null) throw badRequest('CONTACT_EMAIL_INVALID', correlationId);
    const phone = raw.phone === undefined || raw.phone === null || raw.phone === '' ? null : typeof raw.phone === 'string' ? normaliseContactPhone(raw.phone) : null;
    if (raw.phone !== undefined && raw.phone !== null && raw.phone !== '' && phone === null) throw badRequest('CONTACT_PHONE_INVALID', correlationId);
    if (!email && !phone) throw badRequest('CONTACT_CHANNEL_REQUIRED', correlationId);
    let contactId: string;
    try {
      contactId = await addCollegeContact(this.db, { institutionId: id, actorUserId: actor.userId, reasonCode, note, correlationId, role, name: raw.name.trim(), email, phone });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return { contactId, account: await loadCollegeAccount(this.db, id), correlationId };
  }

  @Post('/:collegeId/contacts/:contactId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeContact(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await requireCapability(this.db, request, canManageCollegeAccount);
    const id = requireUuid(institutionId, 'COLLEGE_ID_INVALID', correlationId);
    const contact = requireUuid(contactId, 'CONTACT_ID_INVALID', correlationId);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, collegeContactRemoveReasons, 'REASON_CODE_INVALID', correlationId);
    const note = optionalNote(raw.note, correlationId);
    try {
      await removeCollegeContact(this.db, { institutionId: id, contactId: contact, actorUserId: actor.userId, reasonCode, note, correlationId });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return { account: await loadCollegeAccount(this.db, id), correlationId };
  }

  @Post('/:collegeId/contacts/:contactId/reveal')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revealContact(@Req() request: ProtectedHttpRequest, @Param('collegeId') institutionId: string, @Param('contactId') contactId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await requireCapability(this.db, request, canManageCollegeAccount);
    const id = requireUuid(institutionId, 'COLLEGE_ID_INVALID', correlationId);
    const contact = requireUuid(contactId, 'CONTACT_ID_INVALID', correlationId);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, collegeContactRevealReasons, 'REASON_CODE_INVALID', correlationId);
    const note = optionalNote(raw.note, correlationId);
    try {
      const revealed = await revealCollegeContact(this.db, { institutionId: id, contactId: contact, actorUserId: actor.userId, reasonCode, note, correlationId });
      return { contact: revealed, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
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
  if (error instanceof CollegeAccountError) {
    if (error.code.endsWith('_NOT_FOUND')) return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'COLLEGE_ACCOUNT_VERSION_CONFLICT' || error.code === 'COLLEGE_CONTACT_LIMIT_REACHED') return new ConflictException(domainError(error.code, correlationId));
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('COLLEGE_ACCOUNT_REJECTED', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  return raw;
}

function requireUuid(value: unknown, code: string, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest(code, correlationId);
  return value.toLowerCase();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

function optionalNote(value: unknown, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > noteLimit) throw badRequest('NOTE_INVALID', correlationId);
  return value.trim() || null;
}
