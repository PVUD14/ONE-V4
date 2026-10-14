/**
 * Consented skill evidence on an application (EMP-13, ADR-043): the student's control and the
 * employer's Evidence panel.
 *
 * Student: `GET|PUT /students/me/applications/:applicationId/evidence` — which of their own verified
 * evidence matches the job's skills, what is shared now, and a replace-the-set write. Revoking is
 * always allowed; adding needs the flag, an open application and a live grant.
 *
 * Employer: `GET /employers/:employerId/applications/:applicationId/evidence` — per job skill, the
 * items the student shares (type, source, date, unaided) or none. Runs the candidate view's three
 * checks in order (EMP-03 organisation, the application is this employer's, the EMP-SR-01 live
 * grant), then the flag; every read that returns evidence is audited. No totals, no scores, no
 * stages, no identifiers: see skill-evidence.ts.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant, assertEmployerApplicationAccess } from '@planthepath/persistence/src/employer-authentication.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';
import {
  EvidenceShareError,
  readEvidenceChoices,
  readEvidenceRecordIds,
  readSharedEvidence,
  replaceEvidenceShares,
  skillEvidenceEnabled,
} from './skill-evidence.js';

type QueryResult<T> = { rows: T[] };
type Db = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('/api/v1')
export class SkillEvidenceController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The student's own view: what they may share for this application, and what they share now. */
  @Get('/students/me/applications/:applicationId/evidence')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async studentEvidence(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const application = await readOwnApplication(this.db, id, studentUserId);
    if (!application) throw forbidden(context.correlationId);
    return { evidence: await this.studentView(this.db, application, studentUserId), correlationId: context.correlationId };
  }

  /**
   * Replaces what is shared on this application with `evidenceRecordIds`. Items left out are revoked
   * at once; the employer's next request no longer returns them.
   */
  @Put('/students/me/applications/:applicationId/evidence')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async shareEvidence(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', context.correlationId);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'evidenceRecordIds')) throw badRequest('UNKNOWN_FIELD', context.correlationId);
    if (!Array.isArray(record.evidenceRecordIds)) throw badRequest('INVALID_EVIDENCE_SELECTION', context.correlationId);
    const evidenceIds = readEvidenceRecordIds(record.evidenceRecordIds);
    if (evidenceIds === null) throw badRequest('INVALID_EVIDENCE_SELECTION', context.correlationId);

    const evidence = await this.db.transaction(async (tx) => {
      // The application row is the lock: two changes from two tabs apply one after the other.
      const locked = await tx.execute(sql`
        SELECT id FROM applications WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid AND state <> 'DRAFT' FOR UPDATE
      `) as QueryResult<{ id: string }>;
      if (locked.rows.length !== 1) throw forbidden(context.correlationId);
      const application = await readOwnApplication(tx, id, studentUserId);
      if (!application) throw forbidden(context.correlationId);
      const enabled = await skillEvidenceEnabled(tx);
      let changed: { added: number; revoked: number };
      try {
        changed = await replaceEvidenceShares(tx, this.ids, {
          applicationId: id, studentUserId, versionId: application.versionId, evidenceIds, via: 'APPLICATION',
          allowAdding: enabled && application.open,
        });
      } catch (error) {
        if (error instanceof EvidenceShareError) {
          // Adding is what was refused; say why in the terms the student can act on.
          const code = error.code === 'TOO_MANY_EVIDENCE_SHARES' ? error.code
            : !enabled ? 'EVIDENCE_SHARING_UNAVAILABLE' : !application.open ? 'APPLICATION_CLOSED' : error.code;
          throw badRequest(code, context.correlationId);
        }
        throw error;
      }
      if (changed.added) await writeAudit(tx, this.ids.uuid(), studentUserId, 'application.evidence_shared', id, application.employerId, context.correlationId, { items: changed.added });
      if (changed.revoked) await writeAudit(tx, this.ids.uuid(), studentUserId, 'application.evidence_share_revoked', id, application.employerId, context.correlationId, { items: changed.revoked });
      return this.studentView(tx, application, studentUserId, enabled);
    });
    return { evidence, correlationId: context.correlationId };
  }

  /** The employer's Evidence panel for one application. */
  @Get('/employers/:employerId/applications/:applicationId/evidence')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async employerEvidence(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    try {
      await assertEmployerApplicationAccess(this.db, { employerId, applicationIds: [id] });
    } catch {
      throw forbidden(context.correlationId);
    }
    const rows = await this.db.execute(sql`
      SELECT a.student_user_id, a.applied_version_id FROM applications a
      WHERE a.id = ${id}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<{ student_user_id: string; applied_version_id: string }>;
    const [application] = rows.rows;
    if (!application) throw forbidden(context.correlationId);
    // Dark until HG-4 is approved: nothing is read, so nothing is audited.
    if (!(await skillEvidenceEnabled(this.db))) return { evidence: { available: false, skills: [] }, correlationId: context.correlationId };

    const skills = await readSharedEvidence(this.db, { applicationId: id, studentUserId: application.student_user_id, versionId: application.applied_version_id });
    await writeAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'application.evidence_viewed', id, employerId, context.correlationId,
      { skillsWithEvidence: skills.filter((skill) => skill.items.length > 0).map((skill) => skill.name) });
    return {
      evidence: {
        available: true,
        skills: skills.map((skill) => ({
          name: skill.name, level: skill.level, catalogue: skill.catalogue,
          items: skill.items.map((item) => ({ type: item.type, source: item.source, occurredAt: item.occurredAt, unaided: item.unaided, sharedAt: item.sharedAt })),
        })),
      },
      correlationId: context.correlationId,
    };
  }

  private async studentView(db: Db, application: OwnApplication, studentUserId: string, enabledKnown?: boolean): Promise<Record<string, unknown>> {
    const enabled = enabledKnown ?? await skillEvidenceEnabled(db);
    const skills = await readEvidenceChoices(db, { studentUserId, versionId: application.versionId, applicationId: application.id });
    // With the flag off only what is already shared is listed, so it can still be taken back.
    const shown = enabled ? skills : skills.map((skill) => ({ ...skill, items: skill.items.filter((item) => item.shared) }));
    return {
      available: enabled,
      canShare: enabled && application.open,
      employerName: application.employerName,
      skills: shown,
    };
  }
}

interface OwnApplication {
  readonly id: string;
  readonly versionId: string;
  readonly employerId: string;
  readonly employerName: string;
  /** Still in progress, not withdrawn, and the employer's grant is live. */
  readonly open: boolean;
}

async function readOwnApplication(db: Db, id: string, studentUserId: string): Promise<OwnApplication | null> {
  const rows = await db.execute(sql`
    SELECT a.id, a.applied_version_id, a.employer_id, org.legal_name AS employer_name,
           (a.closed_at IS NULL AND a.consent_revoked_at IS NULL AND ${applicationHasLiveApplicantGrant('a')}) AS open
    FROM applications a JOIN organizations org ON org.id = a.employer_id
    WHERE a.id = ${id}::uuid AND a.student_user_id = ${studentUserId}::uuid AND a.state <> 'DRAFT'
  `) as QueryResult<Record<string, unknown>>;
  const [row] = rows.rows;
  if (!row) return null;
  return { id: String(row.id), versionId: String(row.applied_version_id), employerId: String(row.employer_id), employerName: String(row.employer_name), open: row.open === true };
}

async function writeAudit(db: Db, id: string, actorUserId: string, action: string, applicationId: string, organizationId: string, correlationId: string, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actorUserId}::uuid, ${action}, 'application', ${applicationId}::uuid, ${organizationId}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(detail)}::jsonb)
  `);
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
