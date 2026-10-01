/**
 * The student's résumé generator (RESUME-GEN): what they can put on a résumé, a preview, saved versions and
 * the PDF of a version. Everything is the caller's own — `/students/me/...`, no student identifier in any
 * path, every query scoped by the principal — and a résumé id that is not theirs answers 403, as documents
 * do. Nothing here reads readiness, and nothing returned carries a band, a score, a stage or mastery.
 *
 * The PDF is laid out in the request from the saved version (resume-pdf.ts): synchronous rendering of text
 * the student reviewed, not a model call. Design: docs/architecture/student-resumes-table-design.md.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpException, HttpStatus, Inject, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR, API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError,
  type ApiIdGenerator, type ProtectedHttpRequest,
} from './api-security.js';
import {
  LABEL_PENDING, LABEL_SELF_DECLARED, RESUME_LIMITS, RESUME_TEMPLATE_INFO, ResumeInputError, buildResumeContent, contentHash,
  draftToSelections, periodOf, qualificationTitle, readResumeDraft, resultText, resumeChecks, skillBasis, verificationLabel,
  type ResumeContentV1, type ResumeDraft,
} from '../resume/resume-content.js';
import { readResumeSources } from '../resume/resume-sources.js';
import { renderResumePdf } from '../resume/resume-pdf.js';

type QueryResult<T> = { rows: T[] };
type Row = Record<string, unknown>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** At most this many résumés per student, versions per résumé, saves and PDFs per student per hour. */
export const MAX_RESUMES = 20;
export const MAX_VERSIONS = 50;
export const SAVES_PER_HOUR = 30;
export const RENDERS_PER_HOUR = 60;

interface PdfResponse { setHeader(name: string, value: string): void; send(body: Buffer): void }

@Controller('/api/v1/students/me')
export class StudentResumesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** Everything the student may choose from, each item with the label it would carry, and the templates. */
  @Get('/resume-sources')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async sources(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const sources = await readResumeSources(this.db, userId);
    return {
      sources: {
        header: { fullName: sources.fullName, email: sources.email || null, headline: sources.headline, summary: sources.summary, portfolioUrl: sources.portfolioUrl },
        qualifications: sources.qualifications.map((q) => ({
          id: q.id, title: qualificationTitle(q.qualificationType, q.programmeName), institution: q.institutionName,
          period: periodOf(q.startedOn, q.completedOn), ...verificationLabel(q),
          terms: q.terms.flatMap((t) => {
            const result = resultText(t);
            return result ? [{ id: t.id, label: t.label, result, ...verificationLabel({ state: t.state, issuerName: q.issuerName }) }] : [];
          }),
        })),
        skills: sources.skills.map((s) => ({ topicId: s.topicId, name: s.name, basis: skillBasis(s) })),
        // Documents' verification state is set by the student themselves, so a certificate is always self-declared.
        certificates: sources.certificates.map((c) => ({ id: c.id, title: c.title, description: c.description, verification: LABEL_SELF_DECLARED })),
        careerTargets: sources.careerTargets,
        labels: { selfDeclared: LABEL_SELF_DECLARED, pending: LABEL_PENDING },
      },
      templates: RESUME_TEMPLATE_INFO,
      limits: RESUME_LIMITS,
      correlationId,
    };
  }

  /** Resolves a draft into the résumé and its checks. Writes nothing. */
  @Post('/resumes/preview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async preview(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const draft = readDraft(body, correlationId);
    const content = await this.build(userId, draft, correlationId);
    return { content, checks: resumeChecks(content), correlationId };
  }

  @Get('/resumes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const rows = await this.run(sql`
      SELECT r.id, r.title, r.created_at, r.updated_at, v.version_number, v.template_key, v.created_at AS version_created_at,
             (SELECT count(*)::int FROM student_resume_versions c WHERE c.resume_id = r.id) AS version_count
      FROM student_resumes r
      JOIN LATERAL (SELECT * FROM student_resume_versions x WHERE x.resume_id = r.id ORDER BY x.version_number DESC LIMIT 1) v ON true
      WHERE r.student_user_id = ${userId}::uuid
      ORDER BY r.updated_at DESC, r.id`);
    return { resumes: rows.map(listItem), limits: { resumes: MAX_RESUMES, versions: MAX_VERSIONS }, correlationId };
  }

  @Post('/resumes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const draft = readDraft(body, correlationId);
    const content = await this.build(userId, draft, correlationId);
    const resumeId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      // One save at a time per student, so two tabs cannot both take the last slot.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'student-resume:' + userId}))`);
      await assertSaveAllowed(tx, userId, correlationId);
      const count = await tx.execute(sql`SELECT count(*)::int AS n FROM student_resumes WHERE student_user_id = ${userId}::uuid`) as QueryResult<{ n: number }>;
      if (Number(count.rows[0]?.n ?? 0) >= MAX_RESUMES) throw limitReached('RESUME_LIMIT_REACHED', correlationId);
      await tx.execute(sql`INSERT INTO student_resumes (id, student_user_id, title) VALUES (${resumeId}::uuid, ${userId}::uuid, ${draft.title})`);
      await insertVersion(tx, this.ids.uuid(), resumeId, userId, 1, draft, content);
      await audit(tx, this.ids.uuid(), userId, 'resume.created', resumeId, correlationId);
    });
    return { ...(await this.detail(userId, resumeId, correlationId)), correlationId };
  }

  @Get('/resumes/:resumeId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async get(@Req() request: ProtectedHttpRequest, @Param('resumeId') resumeId: string): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    return { ...(await this.detail(userId, requireUuid(resumeId, correlationId), correlationId)), correlationId };
  }

  @Post('/resumes/:resumeId/versions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async saveVersion(@Req() request: ProtectedHttpRequest, @Param('resumeId') resumeId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const id = requireUuid(resumeId, correlationId);
    const draft = readDraft(body, correlationId);
    const content = await this.build(userId, draft, correlationId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'student-resume:' + userId}))`);
      const owned = await tx.execute(sql`SELECT id FROM student_resumes WHERE id = ${id}::uuid AND student_user_id = ${userId}::uuid FOR UPDATE`) as QueryResult<Row>;
      if (owned.rows.length !== 1) throw forbidden(correlationId);
      await assertSaveAllowed(tx, userId, correlationId);
      const next = await tx.execute(sql`SELECT coalesce(max(version_number), 0) + 1 AS next FROM student_resume_versions WHERE resume_id = ${id}::uuid`) as QueryResult<{ next: number }>;
      const versionNumber = Number(next.rows[0]?.next ?? 1);
      if (versionNumber > MAX_VERSIONS) throw limitReached('VERSION_LIMIT_REACHED', correlationId);
      await insertVersion(tx, this.ids.uuid(), id, userId, versionNumber, draft, content);
      await tx.execute(sql`UPDATE student_resumes SET title = ${draft.title}, updated_at = greatest(now(), created_at) WHERE id = ${id}::uuid AND student_user_id = ${userId}::uuid`);
      await audit(tx, this.ids.uuid(), userId, 'resume.version_saved', id, correlationId);
    });
    return { ...(await this.detail(userId, id, correlationId)), correlationId };
  }

  @Get('/resumes/:resumeId/versions/:version/pdf')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async pdf(@Req() request: ProtectedHttpRequest, @Param('resumeId') resumeId: string, @Param('version') version: string, @Res() response: PdfResponse): Promise<void> {
    const { userId, correlationId } = context(request);
    const id = requireUuid(resumeId, correlationId);
    if (!/^[1-9][0-9]{0,2}$/.test(version)) throw forbidden(correlationId);
    const rows = await this.run(sql`
      SELECT r.title, v.content FROM student_resume_versions v JOIN student_resumes r ON r.id = v.resume_id AND r.student_user_id = v.student_user_id
      WHERE v.resume_id = ${id}::uuid AND v.student_user_id = ${userId}::uuid AND v.version_number = ${Number(version)}`);
    const [row] = rows;
    if (!row) throw forbidden(correlationId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'student-resume-pdf:' + userId}))`);
      const used = await tx.execute(sql`
        SELECT count(*)::int AS n FROM audit_events
        WHERE actor_user_id = ${userId}::uuid AND action = 'resume.pdf_rendered' AND occurred_at > now() - interval '1 hour'`) as QueryResult<{ n: number }>;
      if (Number(used.rows[0]?.n ?? 0) >= RENDERS_PER_HOUR) throw limitReached('PDF_RATE_LIMITED', correlationId);
      await audit(tx, this.ids.uuid(), userId, 'resume.pdf_rendered', id, correlationId);
    });
    const bytes = await renderResumePdf(row.content as ResumeContentV1);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="${pdfFilename(String(row.title), Number(version))}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Correlation-Id', correlationId);
    response.send(bytes);
  }

  @Delete('/resumes/:resumeId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async remove(@Req() request: ProtectedHttpRequest, @Param('resumeId') resumeId: string): Promise<Record<string, unknown>> {
    const { userId, correlationId } = context(request);
    const id = requireUuid(resumeId, correlationId);
    await this.db.transaction(async (tx) => {
      const gone = await tx.execute(sql`DELETE FROM student_resumes WHERE id = ${id}::uuid AND student_user_id = ${userId}::uuid RETURNING id`) as QueryResult<Row>;
      if (gone.rows.length !== 1) throw forbidden(correlationId);
      await audit(tx, this.ids.uuid(), userId, 'resume.deleted', id, correlationId);
    });
    return { deleted: true, correlationId };
  }

  // -------------------------------------------------------------------------

  private async run(query: ReturnType<typeof sql>): Promise<Row[]> {
    return ((await this.db.execute(query)) as QueryResult<Row>).rows;
  }

  private async build(userId: string, draft: ResumeDraft, correlationId: string): Promise<ResumeContentV1> {
    const content = buildResumeContent(await readResumeSources(this.db, userId), draft, new Date());
    if (Buffer.byteLength(JSON.stringify(content)) > RESUME_LIMITS.contentBytes
      || Buffer.byteLength(JSON.stringify(draftToSelections(draft))) > RESUME_LIMITS.selectionsBytes) {
      throw new BadRequestException({ error: { code: 'RESUME_TOO_LARGE', message: 'Request could not be processed', correlationId } });
    }
    return content;
  }

  private async detail(userId: string, resumeId: string, correlationId: string): Promise<Record<string, unknown>> {
    const resume = await this.run(sql`SELECT id, title, created_at, updated_at FROM student_resumes WHERE id = ${resumeId}::uuid AND student_user_id = ${userId}::uuid`);
    const [row] = resume;
    if (!row) throw forbidden(correlationId);
    const versions = await this.run(sql`
      SELECT version_number, template_key, selections, content, created_at FROM student_resume_versions
      WHERE resume_id = ${resumeId}::uuid AND student_user_id = ${userId}::uuid ORDER BY version_number DESC`);
    const latest = versions[0];
    const content = latest?.content as ResumeContentV1 | undefined;
    return {
      resume: {
        id: String(row.id), title: String(row.title), createdAt: row.created_at, updatedAt: row.updated_at,
        versions: versions.map((v) => ({ versionNumber: Number(v.version_number), template: String(v.template_key), createdAt: v.created_at })),
        latest: latest && content ? {
          versionNumber: Number(latest.version_number), template: String(latest.template_key), createdAt: latest.created_at,
          selections: latest.selections, content, checks: resumeChecks(content),
        } : null,
      },
    };
  }
}

function context(request: ProtectedHttpRequest): { readonly userId: string; readonly correlationId: string } {
  const trusted = requireTrustedAuthorization(request);
  return { userId: trusted.authorization.principal.userId, correlationId: trusted.correlationId };
}

function readDraft(body: unknown, correlationId: string): ResumeDraft {
  try {
    return readResumeDraft(body);
  } catch (error) {
    if (error instanceof ResumeInputError) {
      throw new BadRequestException({ error: { code: error.code, ...(error.field ? { field: error.field } : {}), message: 'Request could not be processed', correlationId } });
    }
    throw error;
  }
}

async function assertSaveAllowed(tx: Pick<PersistenceDb, 'execute'>, userId: string, correlationId: string): Promise<void> {
  const recent = await tx.execute(sql`
    SELECT count(*)::int AS n FROM student_resume_versions
    WHERE student_user_id = ${userId}::uuid AND created_at > now() - interval '1 hour'`) as QueryResult<{ n: number }>;
  if (Number(recent.rows[0]?.n ?? 0) >= SAVES_PER_HOUR) throw limitReached('SAVE_RATE_LIMITED', correlationId);
}

async function insertVersion(tx: Pick<PersistenceDb, 'execute'>, id: string, resumeId: string, userId: string, versionNumber: number, draft: ResumeDraft, content: ResumeContentV1): Promise<void> {
  await tx.execute(sql`
    INSERT INTO student_resume_versions (id, resume_id, student_user_id, version_number, template_key, selections, content, content_hash)
    VALUES (${id}::uuid, ${resumeId}::uuid, ${userId}::uuid, ${versionNumber}, ${draft.template},
      ${JSON.stringify(draftToSelections(draft))}::jsonb, ${JSON.stringify(content)}::jsonb, ${contentHash(content)})`);
}

async function audit(tx: Pick<PersistenceDb, 'execute'>, id: string, userId: string, action: string, resumeId: string, correlationId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
    VALUES (${id}::uuid, ${userId}::uuid, ${action}, 'student_resume', ${resumeId}, 'SUCCESS', ${correlationId})`);
}

function listItem(row: Row): Record<string, unknown> {
  return {
    id: String(row.id), title: String(row.title), createdAt: row.created_at, updatedAt: row.updated_at,
    latestVersion: Number(row.version_number), template: String(row.template_key), latestSavedAt: row.version_created_at,
    versionCount: Number(row.version_count),
  };
}

/** A filename from the title: letters, digits, spaces and dashes only, so the header cannot be broken. */
export function pdfFilename(title: string, version: number): string {
  const base = title.normalize('NFKD').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'resume';
  return `${base}-v${version}.pdf`;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

function limitReached(code: string, correlationId: string): HttpException {
  return new HttpException({ error: { code, message: 'Request could not be completed', correlationId } }, HttpStatus.TOO_MANY_REQUESTS);
}
