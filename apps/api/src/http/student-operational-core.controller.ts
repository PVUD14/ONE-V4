import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dangerousSpreadsheetPrefix = /^[=+@-]/;
const allowedDocumentTypes = ['RESUME', 'CERTIFICATE', 'TRANSCRIPT', 'PORTFOLIO', 'OTHER'] as const;
const allowedVisibilityStates = ['PRIVATE', 'INSTITUTION_VISIBLE', 'EMPLOYER_DISCOVERY'] as const;
// What a student may say about their own document: no more than "self-reported" or "please verify".
// VERIFIED and REJECTED are decisions; only a recorded institution verifier can make them (0107).
const studentVerificationStates = ['SELF_REPORTED', 'PENDING_VERIFICATION'] as const;
const decidedVerificationStates = ['VERIFIED', 'REJECTED'] as const;
const allowedOpportunitySources = ['UAT_REFERENCE', 'CAREER_READINESS_CATALOG', 'EMPLOYER_GRANT'] as const;

@Controller('/api/v1')
export class StudentOperationalCoreController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/students/me/profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getProfile(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT u.id AS user_id, u.email, sp.target_career, sp.career_interests, sp.profile_headline,
             sp.profile_summary, sp.portfolio_url, sp.visibility_state, sp.employer_discovery_enabled, sp.updated_at
      FROM users u
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = ${context.authorization.principal.userId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    return { profile: mapProfile(row), correlationId: context.correlationId };
  }

  @Patch('/students/me/profile')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateProfile(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const input = readProfileInput(body, context.correlationId);
    await this.db.execute(sql`
      INSERT INTO student_profiles (user_id, target_career, career_interests, profile_headline, profile_summary, portfolio_url, visibility_state, employer_discovery_enabled, updated_at)
      VALUES (
        ${context.authorization.principal.userId}::uuid,
        ${input.targetCareer},
        ARRAY[${sql.join(input.careerInterests.map((interest) => sql`${interest}`), sql`, `)}]::text[],
        ${input.profileHeadline},
        ${input.profileSummary},
        ${input.portfolioUrl},
        ${input.visibilityState},
        ${input.employerDiscoveryEnabled},
        now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        target_career = EXCLUDED.target_career,
        career_interests = EXCLUDED.career_interests,
        profile_headline = EXCLUDED.profile_headline,
        profile_summary = EXCLUDED.profile_summary,
        portfolio_url = EXCLUDED.portfolio_url,
        visibility_state = EXCLUDED.visibility_state,
        employer_discovery_enabled = EXCLUDED.employer_discovery_enabled,
        updated_at = now()
    `);
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.profile.updated', 'student_profile', context.authorization.principal.userId, context.correlationId);
    return this.getProfile(request);
  }

  @Get('/students/me/documents')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listDocuments(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT d.id, d.title, d.document_type, d.description, d.verification_state, d.verified_at, d.archived_at, d.created_at, d.updated_at,
             v.version_number, f.original_filename, f.byte_size, f.content_type
      FROM student_document_metadata d
      LEFT JOIN student_document_versions v ON v.id = d.current_version_id
      LEFT JOIN readable_stored_files f ON f.id = v.file_id
      WHERE d.student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY d.archived_at NULLS FIRST, d.updated_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { documents: rows.rows.map(mapDocument), storage: { fileStorage: 'AVAILABLE', message: 'Files are scanned for malware before they are stored.' }, correlationId: context.correlationId };
  }

  @Post('/students/me/documents')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createDocument(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const input = readDocumentInput(body, context.correlationId);
    const id = this.ids.uuid();
    await this.db.execute(sql`
      INSERT INTO student_document_metadata (id, student_user_id, title, document_type, description, verification_state)
      VALUES (${id}::uuid, ${context.authorization.principal.userId}::uuid, ${input.title}, ${input.documentType}, ${input.description}, ${input.verificationState ?? 'SELF_REPORTED'})
    `);
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.document_metadata.created', 'student_document_metadata', id, context.correlationId);
    return this.getDocument(request, id);
  }

  @Get('/students/me/documents/:documentId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getDocument(@Req() request: ProtectedHttpRequest, @Param('documentId') documentId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(documentId, context.correlationId);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT d.id, d.title, d.document_type, d.description, d.verification_state, d.verified_at, d.archived_at, d.created_at, d.updated_at,
             v.version_number, f.original_filename, f.byte_size, f.content_type
      FROM student_document_metadata d
      LEFT JOIN student_document_versions v ON v.id = d.current_version_id
      LEFT JOIN readable_stored_files f ON f.id = v.file_id
      WHERE d.id = ${id}::uuid AND d.student_user_id = ${context.authorization.principal.userId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    return { document: mapDocument(row), correlationId: context.correlationId };
  }

  @Patch('/students/me/documents/:documentId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateDocument(@Req() request: ProtectedHttpRequest, @Param('documentId') documentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(documentId, context.correlationId);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const input = readDocumentInput(body, context.correlationId);
    const requested = input.verificationState;
    // One statement, so a decision recorded between a read and a write is never overwritten.
    // An undecided document is the student's to edit; a VERIFIED one is frozen; a REJECTED one
    // changes only when the student explicitly asks again (or withdraws), which clears the decision.
    // The subquery in RETURNING sees the row as it was before this statement.
    const updated = await this.db.execute(sql`
      UPDATE student_document_metadata d
      SET title = ${input.title}, document_type = ${input.documentType}, description = ${input.description},
          verification_state = coalesce(${requested}::text, d.verification_state),
          verified_by_user_id = CASE WHEN ${requested}::text IS NULL THEN d.verified_by_user_id END,
          verified_at = CASE WHEN ${requested}::text IS NULL THEN d.verified_at END,
          verification_institution_id = CASE WHEN ${requested}::text IS NULL THEN d.verification_institution_id END,
          updated_at = now()
      WHERE d.id = ${id}::uuid AND d.student_user_id = ${context.authorization.principal.userId}::uuid AND d.archived_at IS NULL
        AND (d.verification_state IN ('SELF_REPORTED','PENDING_VERIFICATION')
             OR (d.verification_state = 'REJECTED' AND ${requested}::text IS NOT NULL))
      RETURNING d.id, d.verification_state,
        (SELECT p.verification_state FROM student_document_metadata p WHERE p.id = d.id) AS previous_state
    `) as QueryResult<{ id: string; verification_state: string; previous_state: string }>;
    const [changed] = updated.rows;
    if (!changed) {
      if (await isDecidedOwnDocument(this.db, id, context.authorization.principal.userId)) throw decided(context.correlationId);
      throw forbidden(context.correlationId);
    }
    const stateChange = changed.previous_state === changed.verification_state
      ? {}
      : { verificationState: { from: changed.previous_state, to: changed.verification_state } };
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.document_metadata.updated', 'student_document_metadata', id, context.correlationId, stateChange);
    return this.getDocument(request, id);
  }

  @Delete('/students/me/documents/:documentId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async archiveDocument(@Req() request: ProtectedHttpRequest, @Param('documentId') documentId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(documentId, context.correlationId);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const updated = await this.db.execute(sql`
      UPDATE student_document_metadata
      SET archived_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND student_user_id = ${context.authorization.principal.userId}::uuid AND archived_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (updated.rows.length !== 1) throw forbidden(context.correlationId);
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.document_metadata.archived', 'student_document_metadata', id, context.correlationId);
    return { archived: true, documentId: id, correlationId: context.correlationId };
  }

  @Get('/students/me/saved-opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listSavedOpportunities(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT id, opportunity_ref, title, organization_name, source, notes, created_at, updated_at, archived_at
      FROM student_saved_opportunities
      WHERE student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY archived_at NULLS FIRST, updated_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { savedOpportunities: rows.rows.map(mapSavedOpportunity), correlationId: context.correlationId };
  }

  @Post('/students/me/saved-opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async saveOpportunity(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const input = readSavedOpportunityInput(body, context.correlationId);
    const id = this.ids.uuid();
    await this.db.execute(sql`
      INSERT INTO student_saved_opportunities (id, student_user_id, opportunity_ref, title, organization_name, source, notes)
      VALUES (${id}::uuid, ${context.authorization.principal.userId}::uuid, ${input.opportunityRef}, ${input.title}, ${input.organizationName}, ${input.source}, ${input.notes})
      ON CONFLICT (student_user_id, lower(opportunity_ref)) WHERE archived_at IS NULL DO UPDATE SET
        title = EXCLUDED.title,
        organization_name = EXCLUDED.organization_name,
        source = EXCLUDED.source,
        notes = EXCLUDED.notes,
        updated_at = now()
    `);
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.saved_opportunity.saved', 'student_saved_opportunity', context.authorization.principal.userId, context.correlationId);
    return this.listSavedOpportunities(request);
  }

  @Delete('/students/me/saved-opportunities/:savedOpportunityId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeSavedOpportunity(@Req() request: ProtectedHttpRequest, @Param('savedOpportunityId') savedOpportunityId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(savedOpportunityId, context.correlationId);
    await requireStudentRelationship(this.db, context.authorization.principal.userId, context.correlationId);
    const updated = await this.db.execute(sql`
      UPDATE student_saved_opportunities
      SET archived_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND student_user_id = ${context.authorization.principal.userId}::uuid AND archived_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (updated.rows.length !== 1) throw forbidden(context.correlationId);
    await writeStudentAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'student.saved_opportunity.archived', 'student_saved_opportunity', id, context.correlationId);
    return { removed: true, savedOpportunityId: id, correlationId: context.correlationId };
  }
}

/**
 * The caller is a student: a current relationship, or (INST-10, decision 10.2 #12) one they left
 * by graduating, transferring or ending. Every route behind this reads or writes only the caller's
 * own rows, and leaving college does not take those away. REVOKED — a roster link the college
 * withdrew as a mistake — and a person who was never rostered are still refused.
 */
async function requireStudentRelationship(db: PersistenceDb, userId: string, correlationId: string): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id
    FROM institution_relationships
    WHERE student_user_id = ${userId}::uuid
      AND (
        (state IN ('ACTIVE','VERIFIED') AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now()))
        OR state IN ('GRADUATED','TRANSFERRED','ENDED')
      )
    LIMIT 1
  `) as QueryResult<{ id: string }>;
  if (rows.rows.length !== 1) throw forbidden(correlationId);
}

function readProfileInput(body: unknown, correlationId: string): {
  targetCareer: string | null;
  careerInterests: readonly string[];
  profileHeadline: string | null;
  profileSummary: string | null;
  portfolioUrl: string | null;
  visibilityState: string;
  employerDiscoveryEnabled: boolean;
} {
  return {
    targetCareer: readOptionalText(body, 'targetCareer', 120, correlationId),
    careerInterests: readTextArray(body, 'careerInterests', 12, 80, correlationId),
    profileHeadline: readOptionalText(body, 'profileHeadline', 160, correlationId),
    profileSummary: readOptionalText(body, 'profileSummary', 2000, correlationId),
    portfolioUrl: readOptionalHttpsUrl(body, 'portfolioUrl', correlationId),
    visibilityState: readEnum(readOptionalText(body, 'visibilityState', 64, correlationId) ?? 'PRIVATE', allowedVisibilityStates, correlationId),
    employerDiscoveryEnabled: readOptionalBoolean(body, 'employerDiscoveryEnabled') ?? false,
  };
}

function readDocumentInput(body: unknown, correlationId: string): {
  title: string;
  documentType: string;
  description: string | null;
  /** null when the body does not set it: a create starts SELF_REPORTED, an update keeps the current state. */
  verificationState: (typeof studentVerificationStates)[number] | null;
} {
  return {
    title: readRequiredSafeText(body, 'title', 160, correlationId),
    documentType: readEnum(readRequiredSafeText(body, 'documentType', 64, correlationId), allowedDocumentTypes, correlationId),
    description: readOptionalText(body, 'description', 1000, correlationId),
    verificationState: readStudentVerificationState(body, correlationId),
  };
}

function readStudentVerificationState(body: unknown, correlationId: string): (typeof studentVerificationStates)[number] | null {
  const value = readOptionalText(body, 'verificationState', 64, correlationId);
  if (value === null) return null;
  if ((decidedVerificationStates as readonly string[]).includes(value)) {
    throw new BadRequestException({
      error: {
        code: 'DOCUMENT_VERIFICATION_STATE_NOT_ALLOWED',
        message: 'A document can be self-reported or sent for verification. Only the institution can verify or reject it.',
        correlationId,
      },
    });
  }
  return readEnum(value, studentVerificationStates, correlationId);
}

async function isDecidedOwnDocument(db: PersistenceDb, documentId: string, studentUserId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM student_document_metadata
    WHERE id = ${documentId}::uuid AND student_user_id = ${studentUserId}::uuid AND archived_at IS NULL
      AND verification_state IN ('VERIFIED','REJECTED')
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.length === 1;
}

function decided(correlationId: string): ConflictException {
  return new ConflictException({
    error: {
      code: 'DOCUMENT_VERIFICATION_DECIDED',
      message: 'The institution has already decided on this document, so it cannot be changed. Add a new document instead.',
      correlationId,
    },
  });
}

function readSavedOpportunityInput(body: unknown, correlationId: string): {
  opportunityRef: string;
  title: string;
  organizationName: string | null;
  source: string;
  notes: string | null;
} {
  return {
    opportunityRef: readRequiredSafeText(body, 'opportunityRef', 128, correlationId),
    title: readRequiredSafeText(body, 'title', 200, correlationId),
    organizationName: readOptionalSafeText(body, 'organizationName', 200, correlationId),
    source: readEnum(readOptionalText(body, 'source', 64, correlationId) ?? 'UAT_REFERENCE', allowedOpportunitySources, correlationId),
    notes: readOptionalText(body, 'notes', 1000, correlationId),
  };
}

function readRequiredSafeText(body: unknown, field: string, max: number, correlationId: string): string {
  const value = readOptionalText(body, field, max, correlationId);
  if (!value || dangerousSpreadsheetPrefix.test(value)) throw forbidden(correlationId);
  return value;
}

function readOptionalSafeText(body: unknown, field: string, max: number, correlationId: string): string | null {
  const value = readOptionalText(body, field, max, correlationId);
  if (value && dangerousSpreadsheetPrefix.test(value)) throw forbidden(correlationId);
  return value;
}

function readOptionalText(body: unknown, field: string, max: number, correlationId: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw forbidden(correlationId);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw forbidden(correlationId);
  return trimmed;
}

function readOptionalHttpsUrl(body: unknown, field: string, correlationId: string): string | null {
  const value = readOptionalText(body, field, 256, correlationId);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('bad url');
    return parsed.toString();
  } catch {
    throw forbidden(correlationId);
  }
}

function readTextArray(body: unknown, field: string, maxItems: number, maxLength: number, correlationId: string): readonly string[] {
  if (!body || typeof body !== 'object') return [];
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw forbidden(correlationId);
  return value.map((item) => {
    if (typeof item !== 'string') throw forbidden(correlationId);
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxLength || dangerousSpreadsheetPrefix.test(trimmed)) throw forbidden(correlationId);
    return trimmed;
  });
}

function readOptionalBoolean(body: unknown, field: string): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : null;
}

function readEnum<T extends readonly string[]>(value: string, allowed: T, correlationId: string): T[number] {
  if (!allowed.includes(value)) throw forbidden(correlationId);
  return value as T[number];
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function mapProfile(row: Record<string, unknown>): Record<string, unknown> {
  return {
    userId: row.user_id,
    verifiedEmail: row.email,
    targetCareer: row.target_career ?? null,
    careerInterests: row.career_interests ?? [],
    profileHeadline: row.profile_headline ?? null,
    profileSummary: row.profile_summary ?? null,
    portfolioUrl: row.portfolio_url ?? null,
    visibilityState: row.visibility_state ?? 'PRIVATE',
    employerDiscoveryEnabled: row.employer_discovery_enabled ?? false,
    updatedAt: row.updated_at ?? null,
  };
}

function mapDocument(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    documentType: row.document_type,
    description: row.description ?? null,
    verificationState: row.verification_state,
    // When an institution decided; never who. Null for every self-reported or pending document.
    verifiedAt: row.verified_at ?? null,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Populated only from readable_stored_files, so a pending or infected upload
    // never appears here as an attached file.
    file: row.original_filename
      ? {
        versionNumber: Number(row.version_number),
        filename: row.original_filename,
        byteSize: Number(row.byte_size),
        contentType: row.content_type,
      }
      : null,
  };
}

function mapSavedOpportunity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    opportunityRef: row.opportunity_ref,
    title: row.title,
    organizationName: row.organization_name ?? null,
    source: row.source,
    notes: row.notes ?? null,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function writeStudentAudit(db: PersistenceDb, id: string, actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string, auditContext: Record<string, unknown> = {}): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(auditContext)}::jsonb)
  `);
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
