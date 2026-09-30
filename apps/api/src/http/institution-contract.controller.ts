/**
 * The college's side of its contract (INST-18): its data-processing terms, its exit, and the exit
 * export.
 *
 * Design: docs/architecture/institution-contract-lifecycle-design.md.
 *
 * Decisions this file carries:
 *  - Owners and admins read the terms and the exit; only an owner accepts terms (the goal: "accepted
 *    by an owner") and only an owner takes the exit export.
 *  - The exit export exists only while an exit notice is open (state NOTICE), so the largest read in
 *    the product exists only for the moment it is for. It is not behind INST-08's analytics
 *    capability, which ADR-018 and 0031 keep from owners: this is the controller taking back its own
 *    records, not analytics.
 *  - Every file goes through INST-08's writer, audit-before-send and daily allowance. Counselling notes
 *    (INST-11) never ride along: they are a separate section, released only on an explicit flag with a
 *    reason from a fixed list, under their own audit action.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  institutionExitCounsellingReasons,
  institutionExitExportAuditAction,
  institutionExitExportExclusions,
  institutionExitExportParts,
  institutionExitExportReasons,
  institutionExitExportSections,
  isInstitutionExitExportSection,
  type InstitutionExitExportSection,
} from '@planthepath/authorization/src/index.js';
import {
  InstitutionContractError,
  acceptInstitutionDataTerms,
  countInstitutionExitExport,
  readInstitutionDataTermsStatus,
  readInstitutionExitExportPart,
  readLatestInstitutionOffboarding,
  type InstitutionOffboardingView,
} from '@planthepath/persistence/src/institution-contract.js';
import { InstitutionExportError, recordInstitutionExport } from '@planthepath/persistence/src/institution-exports.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { PG_POOL } from '../persistence.provider.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, type ProtectedHttpRequest } from './api-security.js';
import { toCsv } from './institution-export-csv.js';

type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const readerRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'] as const;
const ownerRoles = ['INSTITUTION_OWNER'] as const;

interface ExportResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ExportResponse;
  send(body: string): void;
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionContractController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** The terms, their status for this college, and whether the caller may accept. */
  @Get('/institutions/:institutionId/data-terms')
  async readTerms(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, owner } = requireMember(request, institutionId, readerRoles);
    return { terms: await readInstitutionDataTermsStatus(this.db, institutionId), canAccept: owner, correlationId: context.correlationId };
  }

  /** An owner accepts the current version. A repeat is answered with the same status. */
  @Post('/institutions/:institutionId/data-terms/accept')
  async acceptTerms(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context } = requireMember(request, institutionId, ownerRoles);
    const { correlationId } = context;
    const raw = readBody(body, ['version'], correlationId);
    if (typeof raw.version !== 'string' || !versionPattern.test(raw.version)) throw failure(HttpStatus.BAD_REQUEST, 'INSTITUTION_DATA_TERMS_VERSION_INVALID', correlationId);
    try {
      await acceptInstitutionDataTerms(this.db, { institutionId, version: raw.version, actorUserId: context.authorization.principal.userId, correlationId });
    } catch (error) {
      throw contractFailure(error, correlationId);
    }
    return { terms: await readInstitutionDataTermsStatus(this.db, institutionId), canAccept: true, correlationId };
  }

  /**
   * The college's exit, if any, and — while a notice is open — the export's sections with their row
   * counts and parts, and what the export never contains.
   */
  @Get('/institutions/:institutionId/exit')
  async readExit(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const { context, owner } = requireMember(request, institutionId, readerRoles);
    const offboarding = await readLatestInstitutionOffboarding(this.db, institutionId);
    const open = offboarding?.state === 'NOTICE';
    const counts = open ? await countInstitutionExitExport(this.pool, institutionId) : null;
    return {
      exit: offboarding ? collegeView(offboarding) : null,
      export: {
        available: open && owner,
        sections: counts ? institutionExitExportSections.map((section) => ({ section, rows: counts[section], parts: institutionExitExportParts(counts[section]) })) : [],
        restricted: counts ? { section: 'counselling-notes', rows: counts['counselling-notes'], parts: institutionExitExportParts(counts['counselling-notes']), reasons: institutionExitCounsellingReasons } : null,
        reasons: institutionExitExportReasons,
        excluded: institutionExitExportExclusions,
      },
      correlationId: context.correlationId,
    };
  }

  /** One file of the exit export: one part of one section, audited before it is sent. */
  @Post('/institutions/:institutionId/exit-export/:section')
  async exportSection(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('section') sectionParam: string,
    @Body() body: unknown, @Res() response: ExportResponse): Promise<void> {
    const { context } = requireMember(request, institutionId, ownerRoles);
    const { correlationId } = context;
    if (!isInstitutionExitExportSection(sectionParam)) throw failure(HttpStatus.NOT_FOUND, 'EXIT_EXPORT_SECTION_NOT_FOUND', correlationId);
    const section: InstitutionExitExportSection = sectionParam;
    const restricted = section === 'counselling-notes';
    const raw = readBody(body, restricted ? ['reasonCode', 'part', 'includeRestrictedCounsellingNotes'] : ['reasonCode', 'part'], correlationId);
    if (restricted) {
      if (raw.includeRestrictedCounsellingNotes !== true) throw failure(HttpStatus.BAD_REQUEST, 'COUNSELLING_EXPORT_CONFIRMATION_REQUIRED', correlationId);
      if (typeof raw.reasonCode !== 'string' || !(institutionExitCounsellingReasons as readonly string[]).includes(raw.reasonCode)) {
        throw failure(HttpStatus.BAD_REQUEST, 'COUNSELLING_EXPORT_REASON_INVALID', correlationId);
      }
    } else if (typeof raw.reasonCode !== 'string' || !(institutionExitExportReasons as readonly string[]).includes(raw.reasonCode)) {
      throw failure(HttpStatus.BAD_REQUEST, 'REASON_CODE_REQUIRED', correlationId);
    }
    const reasonCode = raw.reasonCode as string;
    const part = raw.part === undefined ? 1 : raw.part;
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 1 || part > 10_000) throw failure(HttpStatus.BAD_REQUEST, 'EXIT_EXPORT_PART_INVALID', correlationId);

    const offboarding = await readLatestInstitutionOffboarding(this.db, institutionId);
    if (offboarding?.state !== 'NOTICE') throw failure(HttpStatus.CONFLICT, 'EXIT_NOT_IN_NOTICE', correlationId);

    let file: { readonly header: readonly string[]; readonly rows: readonly (readonly (string | number | boolean | null)[])[] };
    try {
      file = await recordInstitutionExport(this.pool, {
        institutionId, actorUserId: context.authorization.principal.userId, correlationId,
        action: institutionExitExportAuditAction(section), exportId: randomUUID(),
        produce: async (client) => {
          // The exit must still be open inside the transaction that records the export.
          const still = await client.query<{ state: string }>(
            `SELECT state FROM institution_offboardings WHERE institution_id = $1 AND state IN ('NOTICE', 'ENDED') FOR SHARE`, [institutionId]);
          if (still.rows[0]?.state !== 'NOTICE') throw new InstitutionContractError('EXIT_NOT_IN_NOTICE');
          const counts = await countInstitutionExitExport(client, institutionId);
          const parts = institutionExitExportParts(counts[section]);
          if (part > parts) throw new InstitutionContractError('EXIT_EXPORT_PART_INVALID');
          const result = await readInstitutionExitExportPart(client, institutionId, section, part);
          // Build the document now, so a forbidden header fails before the audit row is written.
          toCsv(result.header, result.rows);
          return {
            result,
            context: { kind: 'EXIT_EXPORT', section, part, parts, rowCount: result.rows.length, reasonCode, offboardingId: offboarding.id,
              ...(restricted ? { restrictedCounsellingNotes: true } : {}) },
          };
        },
      });
    } catch (error) {
      if (error instanceof InstitutionExportError && error.code === 'EXPORT_RATE_LIMITED') throw failure(HttpStatus.TOO_MANY_REQUESTS, 'EXPORT_RATE_LIMITED', correlationId);
      if (error instanceof InstitutionContractError && error.code === 'EXIT_NOT_IN_NOTICE') throw failure(HttpStatus.CONFLICT, error.code, correlationId);
      if (error instanceof InstitutionContractError && error.code === 'EXIT_EXPORT_PART_INVALID') throw failure(HttpStatus.BAD_REQUEST, error.code, correlationId);
      throw failure(HttpStatus.INTERNAL_SERVER_ERROR, 'EXPORT_FAILED', correlationId);
    }
    const document = toCsv(file.header, file.rows);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="one-exit-${section}-part-${part}-${new Date().toISOString().slice(0, 10)}.csv"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Correlation-Id', correlationId);
    response.status(HttpStatus.OK).send(document);
  }
}

/** What the college sees of its exit: the dates and states, no operator identities, no deletion counts. */
function collegeView(offboarding: InstitutionOffboardingView): Record<string, unknown> {
  return {
    state: offboarding.state,
    noticeAt: offboarding.noticeAt,
    endedAt: offboarding.endedAt,
    retentionEndsAt: offboarding.retentionEndsAt,
    cancelledAt: offboarding.cancelledAt,
    purgedAt: offboarding.purgedAt,
    exitExportLastTakenAt: offboarding.exitExportLastTakenAt,
  };
}

function requireMember(request: ProtectedHttpRequest, institutionId: string, roles: readonly string[]): { readonly context: Context; readonly owner: boolean } {
  const context = requireTrustedAuthorization(request);
  if (!uuidPattern.test(institutionId)) throw failure(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', context.correlationId);
  const own = context.authorization.memberships.filter((membership) => membership.organizationId === institutionId
    && membership.scope.organizationId === institutionId && membership.scope.institutionId === institutionId && membership.state === 'ACTIVE');
  if (!own.some((membership) => roles.includes(membership.role))) throw failure(HttpStatus.FORBIDDEN, 'FORBIDDEN', context.correlationId);
  return { context, owner: own.some((membership) => membership.role === 'INSTITUTION_OWNER') };
}

function readBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw failure(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', correlationId);
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw failure(HttpStatus.BAD_REQUEST, 'UNKNOWN_FIELD', correlationId);
  return body as Record<string, unknown>;
}

function contractFailure(error: unknown, correlationId: string): HttpException {
  if (error instanceof InstitutionContractError) {
    if (error.code === 'INSTITUTION_DATA_TERMS_NOT_PUBLISHED' || error.code === 'INSTITUTION_DATA_TERMS_VERSION_NOT_CURRENT') return failure(HttpStatus.CONFLICT, error.code, correlationId);
    if (error.code === 'INSTITUTION_NOT_FOUND') return failure(HttpStatus.NOT_FOUND, error.code, correlationId);
    return failure(HttpStatus.BAD_REQUEST, error.code, correlationId);
  }
  return failure(HttpStatus.INTERNAL_SERVER_ERROR, 'REQUEST_FAILED', correlationId);
}

const plainMessages: Readonly<Record<string, string>> = {
  FORBIDDEN: 'Access denied',
  INSTITUTION_DATA_TERMS_NOT_PUBLISHED: 'No data-processing terms have been published yet',
  INSTITUTION_DATA_TERMS_VERSION_NOT_CURRENT: 'A newer version of the terms has been published; review it before accepting',
  EXIT_NOT_IN_NOTICE: 'The exit export is available only while an exit notice is open for your college',
  EXIT_EXPORT_SECTION_NOT_FOUND: 'That part of the exit export does not exist',
  EXIT_EXPORT_PART_INVALID: 'That file number does not exist for this section',
  COUNSELLING_EXPORT_CONFIRMATION_REQUIRED: 'Counselling notes are restricted; confirm that you are asking for them',
  COUNSELLING_EXPORT_REASON_INVALID: 'Counselling notes are released only with one of the listed reasons',
  REASON_CODE_REQUIRED: 'Choose a reason for this export',
  EXPORT_RATE_LIMITED: 'You have reached the daily export limit; try again tomorrow',
};

function failure(status: HttpStatus, code: string, correlationId: string): HttpException {
  const body = { error: { code, message: plainMessages[code] ?? 'Request could not be processed', correlationId } };
  if (status === HttpStatus.FORBIDDEN) return new ForbiddenException(body);
  if (status === HttpStatus.BAD_REQUEST) return new BadRequestException(body);
  if (status === HttpStatus.NOT_FOUND) return new NotFoundException(body);
  if (status === HttpStatus.CONFLICT) return new ConflictException(body);
  return new HttpException(body, status);
}
