/**
 * The public profile: the student's controls, and the one route in ONE that serves
 * somebody who is not signed in.
 *
 * Decision in docs/architecture/ADR-031-public-profile-share-links.md.
 *
 * Read that file before adding anything here. Until this controller existed, every path in
 * the product required a verified principal, and that property is the reason a leaked URL
 * has never reached a record. `publicProfile` and `publicPhoto` below are the exceptions,
 * and they are deliberately the narrowest shape that makes the feature possible:
 *
 *   They take a token and return one page. There is no listing, no search, no id-based
 *   lookup, and nothing that accepts a student identifier.
 *
 *   Unknown, expired and revoked tokens are indistinguishable — all 404, with the same
 *   body — so the route cannot be walked to discover which tokens are real.
 *
 *   Responses carry `X-Robots-Tag: noindex`. A token is unguessable, but a link pasted
 *   somewhere crawlable should not turn a student into a search result.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Header, Inject,
  NotFoundException, Optional, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  COVER_KEYS,
  DEFAULT_LINK_DAYS,
  MAX_LINK_DAYS,
  PublicProfileError,
  createShareLink,
  digestShareToken,
  getLiveShareLink,
  resolvePublicProfile,
  revokeShareLink,
  updateShareLink,
  type CoverKey,
  type ShareLinkRecord,
  type ShareSections,
} from '@planthepath/persistence/src/public-profile.js';
import { PG_POOL } from '../persistence.provider.js';
import {
  API_FILE_STORAGE,
  API_FILE_SCANNER,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ProtectedHttpRequest,
} from './api-security.js';
import type { FileStorage } from '../storage/file-storage.js';

/**
 * 30 bytes of randomness, base64url. Long enough that guessing is hopeless and short
 * enough to paste into a message without wrapping.
 */
const TOKEN_BYTES = 30;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/png', 'image/jpeg'];

interface FileScanner { scan(bytes: Buffer): Promise<'CLEAN' | 'INFECTED' | 'SCAN_FAILED'>; }

@Controller('/api/v1')
export class PublicProfileController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // Optional for the same reason documents are: without a configured store and scanner
    // the photo routes report themselves unavailable rather than storing something
    // nobody has looked at.
    @Optional() @Inject(API_FILE_STORAGE) private readonly storage: FileStorage | undefined,
    @Optional() @Inject(API_FILE_SCANNER) private readonly scanner: FileScanner | undefined,
  ) {}

  // -------------------------------------------------------------------------
  // Unauthenticated. The only two routes in the product that are.
  // -------------------------------------------------------------------------

  @Get('/public/profiles/:token')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Cache-Control', 'private, max-age=60')
  async publicProfile(@Param('token') token: string): Promise<Record<string, unknown>> {
    const page = await resolvePublicProfile(
      this.pool,
      safeDigest(token),
      (studentUserId) => `/api/v1/public/profiles/${token}/photo?v=${studentUserId.slice(0, 8)}`,
    );
    // One shape of failure for every reason: not a token, no such token, expired, revoked,
    // account suspended. A caller learns nothing from the difference.
    if (!page) throw new NotFoundException({ error: { code: 'PROFILE_NOT_AVAILABLE' } });
    return { profile: page };
  }

  @Get('/public/profiles/:token/photo')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async publicPhoto(@Param('token') token: string, @Res() response: PhotoResponse): Promise<void> {
    const digest = safeDigest(token);
    const rows = await this.pool.query(
      `SELECT p.storage_key, p.content_type
       FROM public_profile_links l
       JOIN student_profile_photos p ON p.student_user_id = l.student_user_id
       WHERE l.token_digest = $1 AND l.revoked_at IS NULL AND l.expires_at > now()
         AND l.show_photo`,
      [digest],
    );
    const photo = rows.rows[0] as { storage_key: string; content_type: string } | undefined;
    if (!photo || !this.storage) throw new NotFoundException({ error: { code: 'PROFILE_NOT_AVAILABLE' } });
    const bytes = await this.storage.get(photo.storage_key);
    response.setHeader('Content-Type', photo.content_type);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.send(bytes);
  }

  // -------------------------------------------------------------------------
  // The student's own controls. Authenticated like everything else.
  // -------------------------------------------------------------------------

  @Get('/students/me/public-profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async mine(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const link = await getLiveShareLink(this.pool, context.authorization.principal.userId);
    const photo = await this.pool.query(
      'SELECT content_type, uploaded_at FROM student_profile_photos WHERE student_user_id = $1',
      [context.authorization.principal.userId],
    );
    return {
      // The raw token is not here. It was shown once, when the link was created; we hold
      // only its digest and could not return it even if this route wanted to.
      link: link ? toLinkView(link) : null,
      hasPhoto: photo.rows.length > 0,
      correlationId: context.correlationId,
    };
  }

  @Post('/students/me/public-profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publish(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const input = readPublishInput(body, context.correlationId);
    // base64url so the token survives being pasted into a URL, a message or a CV.
    const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');
    // Publishing revokes the old link and issues a new one. Wrapped, so a failure between
    // the two cannot leave a student with nothing live after their old address was killed.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const link = await createShareLink(client, {
        studentUserId: context.authorization.principal.userId,
        linkId: randomUUID(),
        tokenDigest: digestShareToken(rawToken),
        ...(input.days === undefined ? {} : { days: input.days }),
        ...(input.coverKey === undefined ? {} : { coverKey: input.coverKey }),
        ...(input.sections === undefined ? {} : { sections: input.sections }),
      });
      await client.query('COMMIT');
      // The only time the raw token is ever returned. Publishing again issues a new one
      // and kills this address.
      return { link: { ...toLinkView(link), token: rawToken }, correlationId: context.correlationId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw profileFailure(error, context.correlationId);
    } finally {
      client.release();
    }
  }

  @Post('/students/me/public-profile/settings')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async update(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const input = readPublishInput(body, context.correlationId);
    try {
      const link = await updateShareLink(this.pool, {
        studentUserId: context.authorization.principal.userId,
        ...(input.coverKey === undefined ? {} : { coverKey: input.coverKey }),
        ...(input.sections === undefined ? {} : { sections: input.sections }),
        ...(input.days === undefined ? {} : { extendDays: input.days }),
      });
      return { link: toLinkView(link), correlationId: context.correlationId };
    } catch (error) {
      throw profileFailure(error, context.correlationId);
    }
  }

  @Delete('/students/me/public-profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const revoked = await revokeShareLink(this.pool, context.authorization.principal.userId);
    // Revoking something already revoked is success, not an error: the student wanted it
    // off, and it is off.
    return { revoked, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // The photo
  // -------------------------------------------------------------------------

  @Post('/students/me/profile-photo')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async uploadPhoto(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const userId = context.authorization.principal.userId;
    const input = readPhotoInput(body, context.correlationId);

    // Both or neither, exactly as documents behave: without a scanner we refuse rather
    // than store something nobody has looked at.
    if (!this.storage || !this.scanner) throw badRequest('PHOTO_STORAGE_UNAVAILABLE', context.correlationId);

    const verdict = await this.scanner.scan(input.bytes);
    if (verdict === 'INFECTED') throw badRequest('FILE_INFECTED', context.correlationId);
    if (verdict !== 'CLEAN') throw badRequest('FILE_SCAN_UNAVAILABLE', context.correlationId);

    const storageKey = `profile-photos/${userId}/${randomUUID()}`;
    await this.storage.put(storageKey, input.bytes);
    await this.pool.query(
      `INSERT INTO student_profile_photos (student_user_id, storage_key, content_type, byte_size)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_user_id) DO UPDATE
         SET storage_key = EXCLUDED.storage_key, content_type = EXCLUDED.content_type,
             byte_size = EXCLUDED.byte_size, uploaded_at = now()`,
      [userId, storageKey, input.contentType, input.bytes.byteLength],
    );
    return { uploaded: true, correlationId: context.correlationId };
  }

  @Get('/students/me/profile-photo')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async myPhoto(@Req() request: ProtectedHttpRequest, @Res() response: PhotoResponse): Promise<void> {
    const context = requireTrustedAuthorization(request);
    const rows = await this.pool.query(
      'SELECT storage_key, content_type FROM student_profile_photos WHERE student_user_id = $1',
      [context.authorization.principal.userId],
    );
    const photo = rows.rows[0] as { storage_key: string; content_type: string } | undefined;
    if (!photo || !this.storage) throw new NotFoundException({ error: { code: 'NO_PHOTO' } });
    const bytes = await this.storage.get(photo.storage_key);
    response.setHeader('Content-Type', photo.content_type);
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.send(bytes);
  }

  @Delete('/students/me/profile-photo')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async deletePhoto(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await this.pool.query('DELETE FROM student_profile_photos WHERE student_user_id = $1', [
      context.authorization.principal.userId,
    ]);
    return { removed: true, correlationId: context.correlationId };
  }
}

interface PhotoResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

function toLinkView(link: ShareLinkRecord): Record<string, unknown> {
  return {
    id: link.id,
    coverKey: link.coverKey,
    sections: link.sections,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    lastViewedAt: link.lastViewedAt,
    expired: link.expiresAt.getTime() <= Date.now(),
  };
}

/**
 * A token that is not even the right shape still costs a hash, so that a malformed token
 * and a well-formed unknown one take the same path.
 */
function safeDigest(token: string): string {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? digestShareToken(token) : digestShareToken(' invalid');
}

function readPublishInput(body: unknown, correlationId: string): {
  readonly days?: number;
  readonly coverKey?: CoverKey;
  readonly sections?: Partial<ShareSections>;
} {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
  const raw = body as Record<string, unknown>;

  let days: number | undefined;
  if (raw.days !== undefined && raw.days !== null) {
    days = Number(raw.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_LINK_DAYS) throw badRequest('INVALID_DAYS', correlationId);
  }

  let coverKey: CoverKey | undefined;
  if (raw.coverKey !== undefined && raw.coverKey !== null) {
    if (typeof raw.coverKey !== 'string' || !COVER_KEYS.includes(raw.coverKey as CoverKey)) {
      throw badRequest('INVALID_COVER', correlationId);
    }
    coverKey = raw.coverKey as CoverKey;
  }

  let sections: Partial<ShareSections> | undefined;
  if (raw.sections !== undefined && raw.sections !== null) {
    if (typeof raw.sections !== 'object' || Array.isArray(raw.sections)) throw badRequest('INVALID_SECTIONS', correlationId);
    const entries = Object.entries(raw.sections as Record<string, unknown>);
    // Only known section names, and only booleans. An unknown key is a caller guessing at
    // a field we have not agreed to publish.
    const allowed = new Set<keyof ShareSections>([
      'showPhoto', 'showHeadline', 'showCity', 'showInstitution', 'showEducation',
      'showSelfReported', 'showAssessments', 'showLearning', 'showCertificates',
      'showSkills', 'showPortfolio',
    ]);
    for (const [key, value] of entries) {
      if (!allowed.has(key as keyof ShareSections) || typeof value !== 'boolean') {
        throw badRequest('INVALID_SECTIONS', correlationId);
      }
    }
    sections = Object.fromEntries(entries) as Partial<ShareSections>;
  }

  return {
    ...(days === undefined ? {} : { days }),
    ...(coverKey === undefined ? {} : { coverKey }),
    ...(sections === undefined ? {} : { sections }),
  };
}

function readPhotoInput(body: unknown, correlationId: string): { readonly bytes: Buffer; readonly contentType: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
  const raw = body as Record<string, unknown>;
  const contentType = typeof raw.contentType === 'string' ? raw.contentType : '';
  if (!PHOTO_TYPES.includes(contentType)) throw badRequest('INVALID_CONTENTTYPE', correlationId);
  if (typeof raw.data !== 'string' || raw.data.length === 0) throw badRequest('INVALID_DATA', correlationId);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.data, 'base64');
  } catch {
    throw badRequest('INVALID_DATA', correlationId);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) throw badRequest('PHOTO_TOO_LARGE', correlationId);
  return { bytes, contentType };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, correlationId } });
}

function profileFailure(error: unknown, correlationId: string): Error {
  if (error instanceof PublicProfileError) return badRequest(error.code, correlationId);
  return new ForbiddenException({ error: { code: 'PROFILE_ACTION_FAILED', correlationId } });
}

export { DEFAULT_LINK_DAYS };
