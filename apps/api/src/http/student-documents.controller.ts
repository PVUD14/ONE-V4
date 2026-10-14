import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Req, Res, ServiceUnavailableException, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import type { FileScanner } from '../storage/clamav.js';
import type { FileStorage } from '../storage/file-storage.js';
import {
  API_FILE_SCANNER,
  API_FILE_STORAGE,
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 20 * 1024 * 1024;

/** Must match the stored_files_content_type_ck allowlist exactly. */
const ALLOWED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * Student document upload and download.
 *
 * Bytes are scanned before they are ever written to the store, so an infected file
 * never exists at a readable path even briefly. Downloads read through the
 * readable_stored_files view, which is the single place the STORED + CLEAN +
 * not-deleted rule lives.
 */
@Controller('/api/v1')
export class StudentDocumentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_FILE_STORAGE) private readonly storage?: FileStorage,
    @Optional() @Inject(API_FILE_SCANNER) private readonly scanner?: FileScanner,
  ) {}

  @Post('/students/me/documents/:documentId/file')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async upload(@Req() request: ProtectedHttpRequest, @Param('documentId') documentId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(documentId, context.correlationId);
    const { storage, scanner } = this.requireFileServices(context.correlationId);

    const contentType = headerValue(request, 'content-type').split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = ALLOWED_CONTENT_TYPES[contentType];
    if (!extension) throw new UnsupportedMediaTypeException(safeDocumentError('UNSUPPORTED_FILE_TYPE', context.correlationId));

    const filename = sanitiseFilename(headerValue(request, 'x-filename') || `document.${extension}`);
    if (!filename) throw badRequest('INVALID_FILENAME', context.correlationId);

    const owned = await this.db.execute(sql`
      SELECT id, verification_state FROM student_document_metadata
      WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid AND archived_at IS NULL
    `) as QueryResult<{ id: string; verification_state: string }>;
    if (owned.rows.length !== 1) throw forbidden(context.correlationId);
    // A decision covers the file it was taken on (0107). A new file goes on a new document, or, after a
    // rejection, follows the student asking again; it never silently inherits the decision.
    if (owned.rows[0]?.verification_state === 'VERIFIED' || owned.rows[0]?.verification_state === 'REJECTED') {
      throw new ConflictException({ error: { code: 'DOCUMENT_VERIFICATION_DECIDED', message: 'The institution has already decided on this document, so its file cannot be replaced.', correlationId: context.correlationId } });
    }

    const bytes = await readBody(request, MAX_BYTES, context.correlationId);
    if (bytes.length === 0) throw badRequest('EMPTY_FILE', context.correlationId);

    // Scan first. Nothing reaches the store until a clean verdict comes back.
    const verdict = await scanner.scan(bytes);
    const fileId = this.ids.uuid();

    if (verdict.state !== 'CLEAN') {
      // Recorded even though no bytes are kept: an infected or unscannable upload is
      // exactly the event an operator needs to be able to find later.
      await this.db.execute(sql`
        INSERT INTO stored_files (id, storage_key, original_filename, content_type, byte_size, checksum_sha256, upload_state, scan_state, scan_engine, scan_completed_at, uploaded_by_user_id, deleted_at)
        VALUES (${fileId}::uuid, ${`quarantine/${fileId}`}, ${filename}, ${contentType}, ${bytes.length}, ${sha256(bytes)}, 'STORED', ${verdict.state}, ${scanner.engine}, now(), ${studentUserId}::uuid, now())
      `);
      await this.db.execute(sql`
        INSERT INTO file_scan_events (id, file_id, scan_state, engine, signature_reference, detail)
        VALUES (${this.ids.uuid()}::uuid, ${fileId}::uuid, ${verdict.state}, ${scanner.engine},
                ${verdict.state === 'INFECTED' ? verdict.signature : null},
                ${verdict.state === 'SCAN_FAILED' ? verdict.reason : null})
      `);
      await this.writeAudit(studentUserId, verdict.state === 'INFECTED' ? 'document.upload_rejected_infected' : 'document.upload_rejected_unscannable', 'stored_file', fileId, context.correlationId);

      if (verdict.state === 'INFECTED') throw badRequest('FILE_REJECTED_MALWARE', context.correlationId);
      throw new ServiceUnavailableException(safeDocumentError('FILE_SCAN_UNAVAILABLE', context.correlationId));
    }

    const nextVersion = await this.db.execute(sql`
      SELECT coalesce(max(version_number), 0) + 1 AS next FROM student_document_versions WHERE document_id = ${id}::uuid
    `) as QueryResult<{ next: number }>;
    const versionNumber = Number(nextVersion.rows[0]?.next ?? 1);
    const storageKey = `students/${studentUserId}/${id}/v${versionNumber}-${randomUUID()}.${extension}`;

    await storage.put(storageKey, bytes);
    try {
      await this.db.execute(sql`
        INSERT INTO stored_files (id, storage_provider, storage_bucket, storage_key, original_filename, content_type, byte_size, checksum_sha256, upload_state, scan_state, scan_engine, scan_completed_at, uploaded_by_user_id)
        VALUES (${fileId}::uuid, ${storage.provider}, ${storage.bucket ?? null}, ${storageKey}, ${filename}, ${contentType}, ${bytes.length}, ${sha256(bytes)}, 'STORED', 'CLEAN', ${scanner.engine}, now(), ${studentUserId}::uuid)
      `);
      const versionId = this.ids.uuid();
      await this.db.execute(sql`
        INSERT INTO student_document_versions (id, document_id, version_number, file_id, created_by_user_id)
        VALUES (${versionId}::uuid, ${id}::uuid, ${versionNumber}, ${fileId}::uuid, ${studentUserId}::uuid)
      `);
      await this.db.execute(sql`
        UPDATE student_document_metadata SET current_version_id = ${versionId}::uuid, updated_at = now()
        WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
      `);
      await this.db.execute(sql`
        INSERT INTO file_scan_events (id, file_id, scan_state, engine)
        VALUES (${this.ids.uuid()}::uuid, ${fileId}::uuid, 'CLEAN', ${scanner.engine})
      `);
      await this.writeAudit(studentUserId, 'document.file_uploaded', 'stored_file', fileId, context.correlationId);
    } catch (error) {
      // Never leave bytes on disk that no row points at.
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }

    return { file: { id: fileId, versionNumber, filename, byteSize: bytes.length }, correlationId: context.correlationId };
  }

  @Get('/students/me/documents/:documentId/file')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async download(@Req() request: ProtectedHttpRequest, @Param('documentId') documentId: string, @Res() response: DownloadResponse): Promise<void> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(documentId, context.correlationId);
    const { storage } = this.requireFileServices(context.correlationId);

    // readable_stored_files is the only path to bytes; pending and infected rows
    // are simply not in it.
    const rows = await this.db.execute(sql`
      SELECT f.storage_key, f.original_filename, f.content_type, f.byte_size
      FROM student_document_metadata d
      JOIN student_document_versions v ON v.id = d.current_version_id
      JOIN readable_stored_files f ON f.id = v.file_id
      WHERE d.id = ${id}::uuid AND d.student_user_id = ${studentUserId}::uuid AND d.archived_at IS NULL
    `) as QueryResult<Record<string, unknown>>;
    const [file] = rows.rows;
    if (!file) throw forbidden(context.correlationId);

    const bytes = await storage.get(String(file.storage_key));
    await this.writeAudit(studentUserId, 'document.file_downloaded', 'student_document', id, context.correlationId);

    response.setHeader('Content-Type', String(file.content_type));
    response.setHeader('Content-Length', String(bytes.length));
    // attachment, not inline: never render an uploaded document in the site's origin.
    response.setHeader('Content-Disposition', `attachment; filename="${asciiFilename(String(file.original_filename))}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }

  private requireFileServices(correlationId: string): { storage: FileStorage; scanner: FileScanner } {
    if (!this.storage || !this.scanner) {
      throw new ServiceUnavailableException(safeDocumentError('FILE_STORAGE_NOT_CONFIGURED', correlationId));
    }
    return { storage: this.storage, scanner: this.scanner };
  }

  private async writeAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, 'SUCCESS', ${correlationId})
    `);
  }
}

interface DownloadResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

/** Streams the request body, refusing anything over the limit without buffering it. */
function readBody(request: ProtectedHttpRequest, limit: number, correlationId: string): Promise<Buffer> {
  const stream = request as unknown as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof stream.on !== 'function') return Promise.resolve(Buffer.alloc(0));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        stream.destroy?.();
        reject(badRequest('FILE_TOO_LARGE', correlationId));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => reject(badRequest('UPLOAD_FAILED', correlationId)));
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function headerValue(request: ProtectedHttpRequest, name: string): string {
  const raw = request.headers?.[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return typeof raw === 'string' ? raw : '';
}

/** Strips any path component; the stored name is a label, never a path. */
function sanitiseFilename(value: string): string {
  const base = value.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.length > 0 && cleaned.length <= 255 ? cleaned : '';
}

/** Content-Disposition must not carry quotes or non-ASCII into the header. */
function asciiFilename(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function safeDocumentError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safeDocumentError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
