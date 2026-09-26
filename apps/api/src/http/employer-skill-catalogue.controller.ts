/**
 * The ONE skill catalogue as a recruiter picks from it (EMP-06 step 6).
 *
 * A job's skills were free text; OPS-08 built the job-role catalogue, whose published
 * requirement sets name taxonomy topics. A catalogue skill is one of those topics, and a job may
 * map to a catalogue role, so EMP-13 can later match consented evidence per required skill
 * without guessing from a name. This route only lists; choosing happens in a new job version.
 *
 * Reading is drafting-level (any employer that may draft a job may look), and the list carries
 * no candidate data. Keyset-paginated by name (default 50, maximum 200).
 */
import { BadRequestException, Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { requireActiveEmployer } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const employerManageRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}

@Controller('/api/v1')
export class EmployerSkillCatalogueController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/employers/:employerId/skill-catalogue')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(
    @Req() request: ProtectedHttpRequest,
    @Param('employerId') employerId: string,
    @Query('q') q?: string,
    @Query('careerRoleId') careerRoleId?: string,
    @Query('limit') limit?: string,
    @Query('after') after?: string,
  ): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerManageRoles);
    const correlationId = context.correlationId;
    if (q !== undefined && (typeof q !== 'string' || q.length > 80)) throw badRequest('INVALID_QUERY', correlationId);
    if (careerRoleId !== undefined && (typeof careerRoleId !== 'string' || !uuidPattern.test(careerRoleId))) throw badRequest('INVALID_CAREERROLEID', correlationId);
    if (after !== undefined && (typeof after !== 'string' || after.length < 1 || after.length > 200)) throw badRequest('INVALID_CURSOR', correlationId);
    let pageSize = 50;
    if (limit !== undefined) {
      if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw badRequest('INVALID_LIMIT', correlationId);
      pageSize = Number(limit);
    }
    const search = q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const cursor = after ?? null;

    // A catalogue skill: an active topic that an active role's live requirement set names.
    const skills = await this.db.execute(sql`
      SELECT n.id, n.name FROM taxonomy_nodes n
      WHERE n.active
        AND EXISTS (SELECT 1 FROM career_role_requirements r JOIN career_roles cr ON cr.id = r.career_role_id AND cr.active
                    WHERE r.topic_id = n.id AND (${careerRoleId ?? null}::uuid IS NULL OR r.career_role_id = ${careerRoleId ?? null}::uuid))
        AND (${search}::text IS NULL OR n.name ILIKE ${search})
        AND (${cursor}::text IS NULL OR lower(n.name) > lower(${cursor}::text))
      ORDER BY lower(n.name), n.id
      LIMIT ${pageSize + 1}
    `) as QueryResult<{ id: string; name: string }>;
    const roles = await this.db.execute(sql`
      SELECT cr.id, coalesce(cr.catalogue_code, cr.code) AS code, coalesce(cr.catalogue_title, cr.title) AS title, cr.family
      FROM career_roles cr
      WHERE cr.active AND (${search}::text IS NULL OR coalesce(cr.catalogue_title, cr.title) ILIKE ${search} OR coalesce(cr.catalogue_code, cr.code) ILIKE ${search})
      ORDER BY lower(coalesce(cr.catalogue_title, cr.title)), cr.id
      LIMIT ${pageSize}
    `) as QueryResult<Record<string, unknown>>;

    const page = skills.rows.slice(0, pageSize);
    return {
      skills: page.map((row) => ({ taxonomyTopicId: row.id, name: row.name })),
      nextCursor: skills.rows.length > pageSize ? page.at(-1)?.name ?? null : null,
      careerRoles: roles.rows.map((row) => ({ id: row.id, code: row.code, title: row.title, family: row.family })),
      correlationId,
    };
  }
}
