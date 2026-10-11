/**
 * Operations Content Management — content bulk import (OPS-09d, Appendix 1 §3 Content, §4.2, §5.3).
 *
 * An operator with CONTENT_EDIT uploads a CSV or JSON file of skills, questions, lessons or lesson
 * variants. Preview returns a row-level validation report and a digest; commit writes exactly that
 * previewed file, all rows or none, each row landing as a DRAFT authored by the importer through the
 * editors' own functions. Nothing is published, and the importer can never review or publish what
 * they imported (the editors' contributor rule).
 *
 * Deliberately absent: any student data, any row text in a response (so never an answer key), any
 * path out of DRAFT, and any model call.
 *
 * Design: docs/architecture/content-bulk-import-design.md
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
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  canImportContent,
  contentImportReasons,
  isContentImportReason,
  resolveInternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  commitContentImport,
  CONTENT_IMPORT_COLUMNS,
  CONTENT_IMPORT_FILENAME_MAX,
  CONTENT_IMPORT_FORMATS,
  CONTENT_IMPORT_KINDS,
  CONTENT_IMPORT_MAX_CHARACTERS,
  CONTENT_IMPORT_MAX_ROWS,
  isContentImportFormat,
  isContentImportKind,
  parseContentImportFile,
  type ContentImportParsed,
  ContentImportRejected,
  previewContentImport,
  type ContentImportActor,
} from '@planthepath/persistence/src/content-import.js';
import type { TransactionalRunner } from '@planthepath/persistence/src/skill-map.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const previewFields = ['kind', 'format', 'filename', 'content'] as const;
const commitFields = [...previewFields, 'previewDigest', 'reasonCode'] as const;

@Controller('/api/v1/operations/content-imports')
export class OperationsContentImportController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** The kinds, their fields, the caps and the reason codes. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    return {
      kinds: CONTENT_IMPORT_KINDS.map((kind) => ({ kind, required: CONTENT_IMPORT_COLUMNS[kind].required, optional: CONTENT_IMPORT_COLUMNS[kind].optional })),
      formats: CONTENT_IMPORT_FORMATS,
      limits: { rows: CONTENT_IMPORT_MAX_ROWS, characters: CONTENT_IMPORT_MAX_CHARACTERS, filename: CONTENT_IMPORT_FILENAME_MAX },
      reasons: contentImportReasons,
      correlationId,
    };
  }

  /** Step one: the row-level validation report and its digest. No content is written. */
  @Post('/preview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async preview(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const upload = readUpload(body, false, correlationId);
    try {
      const report = await previewContentImport(this.runner(), { parsed: upload.parsed, filename: upload.filename, actor: importActor(actor, correlationId) });
      return { preview: report, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Step two: commit exactly the previewed file. A file problem or an invalid row answers 400 and a
   * changed evaluation 409, each with the fresh report; in every refusal nothing is written.
   */
  @Post('/commit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async commit(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const upload = readUpload(body, true, correlationId);
    try {
      const committed = await commitContentImport(this.runner(), {
        parsed: upload.parsed, filename: upload.filename, previewDigest: upload.previewDigest!, reasonCode: upload.reasonCode!,
        actor: importActor(actor, correlationId),
      });
      return {
        import: { reference: committed.reference, kind: committed.report.kind, created: committed.createdKeys.length, keys: committed.createdKeys },
        correlationId,
      };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private runner(): TransactionalRunner {
    return this.db as unknown as TransactionalRunner;
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canImportContent(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

function importActor(actor: Actor, correlationId: string): ContentImportActor {
  return { userId: actor.userId, breakGlass: resolveInternalCapability(actor, 'CONTENT_EDIT') === 'BREAK_GLASS', correlationId };
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function readUpload(body: unknown, commit: boolean, correlationId: string): {
  readonly parsed: ContentImportParsed; readonly filename: string; readonly previewDigest?: string; readonly reasonCode?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  const allowed: readonly string[] = commit ? commitFields : previewFields;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  if (!isContentImportKind(raw.kind)) throw badRequest('IMPORT_KIND_INVALID', correlationId, 'kind');
  if (!isContentImportFormat(raw.format)) throw badRequest('IMPORT_FORMAT_INVALID', correlationId, 'format');
  if (typeof raw.content !== 'string' || raw.content.length === 0) throw badRequest('IMPORT_FILE_EMPTY', correlationId, 'content');
  if (raw.content.length > CONTENT_IMPORT_MAX_CHARACTERS) throw badRequest('IMPORT_FILE_TOO_LARGE', correlationId, 'content');
  const filename = raw.filename === undefined || raw.filename === null || raw.filename === ''
    ? (raw.format === 'CSV' ? 'import.csv' : 'import.json')
    : typeof raw.filename === 'string' && raw.filename.trim().length >= 1 && raw.filename.trim().length <= CONTENT_IMPORT_FILENAME_MAX
      ? raw.filename.trim()
      : null;
  if (filename === null) throw badRequest('IMPORT_FILENAME_INVALID', correlationId, 'filename');
  const parsed = parseContentImportFile(raw.kind, raw.format, raw.content);
  if (!commit) return { parsed, filename };
  if (typeof raw.previewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.previewDigest)) throw badRequest('PREVIEW_DIGEST_REQUIRED', correlationId, 'previewDigest');
  if (!isContentImportReason(raw.reasonCode)) throw badRequest('REASON_CODE_INVALID', correlationId, 'reasonCode');
  return { parsed, filename, previewDigest: raw.previewDigest, reasonCode: raw.reasonCode };
}

function domainError(code: string, correlationId: string, field?: string): { error: Record<string, unknown> } {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(field ? { field } : {}) } };
}

function badRequest(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId, field));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ContentImportRejected) {
    const payload = { ...domainError(error.code, correlationId), preview: error.report };
    return error.code === 'IMPORT_STALE' ? new ConflictException(payload) : new BadRequestException(payload);
  }
  // Never forward database or driver text to the browser.
  return badRequest('IMPORT_REJECTED', correlationId);
}
