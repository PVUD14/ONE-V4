import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { externalApplicationCap, externalFields, externalInputRecord, externalRevision, ExternalApplicationInputError, type ExternalApplicationFields } from '@planthepath/hiring/src/external-applications.js';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  HiringRuleError,
  assertApplicationTransition,
  assertCanSubmitApplication,
  assertOfferTransition,
  isOfferExpired,
  type OfferState,
} from '@planthepath/hiring';
import { evaluateStudentEligibility, type RuleOutcome } from '@planthepath/hiring/src/eligibility.js';
import {
  eligibilityDisplayNames,
  mapEligibilityRuleRow,
  readEligibilityRecords,
  readVersionEligibilityRules,
  recordEligibilityEvaluation,
  studentRuleOutcomes,
} from './opportunity-requirements.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerInGoodStandingSql } from './employer-organisation-state.js';
import { readSnapshotChoices, SnapshotInputError, type SnapshotChoices } from '@planthepath/hiring/src/application-snapshot.js';
import { buildSnapshotFor, readResumeOptions, SnapshotResumeUnavailable, writeApplicationSnapshot, type BuiltSnapshot } from './application-snapshots.js';
import { loadInterviewCalendar } from '@planthepath/persistence/src/interview-calendar-source.js';
import { sendCalendar } from './interview-scheduling.js';
import { linkApplicationToCampusDrives, readListedCampusDrives, readStudentCampusDrives, visibleThroughCampusDriveSql } from './campus-drives.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dangerousSpreadsheetPrefix = /^[=+@-]/;

/**
 * Student-facing hiring surface: discover published opportunities, apply with explicit
 * consent, track applications, withdraw.
 *
 * Visibility fails closed. An opportunity is only listed when it is PUBLISHED and
 * carries an audience row the student actually matches; an opportunity with no
 * audience rows reaches nobody. INVITE_ONLY is excluded from browsing by design.
 */
@Controller('/api/v1')
export class StudentHiringController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/students/me/external-applications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listExternalApplications(@Req() request: ProtectedHttpRequest, @Query('offset') offset?: string, @Query('limit') limit?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const actor = context.authorization.principal.userId;
    const pageOffset = readExternalPage(offset, 0, 0, externalApplicationCap, context.correlationId);
    const pageLimit = readExternalPage(limit, 50, 1, 100, context.correlationId);
    const result = await this.db.execute(sql`
      SELECT (SELECT count(*)::int FROM external_applications WHERE student_user_id = ${actor}::uuid) AS total,
        coalesce((SELECT jsonb_agg(page) FROM (
          SELECT * FROM external_applications WHERE student_user_id = ${actor}::uuid
          ORDER BY applied_on DESC, id LIMIT ${pageLimit} OFFSET ${pageOffset}
        ) page), '[]'::jsonb) AS records
    `) as QueryResult<{ total: number; records: Record<string, unknown>[] }>;
    const row = result.rows[0]!;
    return { externalApplications: row.records.map(mapExternalApplication), total: row.total, offset: pageOffset, limit: pageLimit, correlationId: context.correlationId };
  }

  @Get('/students/me/external-applications/:id')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getExternalApplication(@Req() request: ProtectedHttpRequest, @Param('id') id: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    requireUuid(id, context.correlationId);
    const result = await this.db.execute(sql`SELECT * FROM external_applications WHERE id = ${id}::uuid AND student_user_id = ${context.authorization.principal.userId}::uuid`) as QueryResult<Record<string, unknown>>;
    if (!result.rows[0]) throw forbidden(context.correlationId);
    return { externalApplication: mapExternalApplication(result.rows[0]), correlationId: context.correlationId };
  }

  @Post('/students/me/external-applications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createExternalApplication(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const fields = parseExternal(() => externalFields(body), context.correlationId) as ExternalApplicationFields;
    const grant = (body as Record<string, unknown>).institutionVisibilityGranted === true;
    const actor = context.authorization.principal.userId;
    return this.db.transaction(async (tx) => {
      // Every create for this student takes this lock before counting, including concurrent requests.
      const owner = await tx.execute(sql`SELECT id FROM users WHERE id = ${actor}::uuid AND state = 'ACTIVE' FOR UPDATE`) as QueryResult<{ id: string }>;
      if (!owner.rows[0]) throw forbidden(context.correlationId);
      const count = await tx.execute(sql`SELECT count(*)::int AS count FROM external_applications WHERE student_user_id = ${actor}::uuid`) as QueryResult<{ count: number }>;
      if (count.rows[0]!.count >= externalApplicationCap) throw badRequest('EXTERNAL_APPLICATION_LIMIT', context.correlationId);
      const id = this.ids.uuid();
      const result = await tx.execute(sql`
        INSERT INTO external_applications (id, student_user_id, company_name, role_title, source_kind, applied_on, application_url, stage, institution_visibility_granted_at)
        VALUES (${id}::uuid, ${actor}::uuid, ${fields.companyName}, ${fields.roleTitle}, ${fields.sourceKind}, ${fields.appliedOn}::date,
          ${fields.applicationUrl}, ${fields.stage}, CASE WHEN ${grant} THEN now() ELSE NULL END)
        RETURNING *
      `) as QueryResult<Record<string, unknown>>;
      await this.auditExternal(tx, context, id, 'created', Object.keys(fields), 1);
      if (grant) await this.auditExternal(tx, context, id, 'institution_visibility_granted', ['institutionVisibility'], 1);
      return { externalApplication: mapExternalApplication(result.rows[0]!), correlationId: context.correlationId };
    });
  }

  @Patch('/students/me/external-applications/:id')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateExternalApplication(@Req() request: ProtectedHttpRequest, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.mutateExternalApplication(request, id, body, 'updated');
  }

  @Delete('/students/me/external-applications/:id')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async deleteExternalApplication(@Req() request: ProtectedHttpRequest, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.mutateExternalApplication(request, id, body, 'deleted');
  }

  @Post('/students/me/external-applications/:id/institution-visibility/grant')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grantExternalVisibility(@Req() request: ProtectedHttpRequest, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.mutateExternalApplication(request, id, body, 'institution_visibility_granted');
  }

  @Post('/students/me/external-applications/:id/institution-visibility/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revokeExternalVisibility(@Req() request: ProtectedHttpRequest, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.mutateExternalApplication(request, id, body, 'institution_visibility_revoked');
  }

  private async mutateExternalApplication(request: ProtectedHttpRequest, id: string, body: unknown,
    action: 'updated' | 'deleted' | 'institution_visibility_granted' | 'institution_visibility_revoked'): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    requireUuid(id, context.correlationId);
    const fields = action === 'updated' ? parseExternal(() => externalFields(body, true), context.correlationId) : {};
    const record = parseExternal(() => externalInputRecord(body, action === 'updated' ? ['revision', ...Object.keys(fields)] : ['revision']), context.correlationId);
    const revision = parseExternal(() => externalRevision(record), context.correlationId);
    const actor = context.authorization.principal.userId;
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT * FROM external_applications WHERE id = ${id}::uuid AND student_user_id = ${actor}::uuid FOR UPDATE`) as QueryResult<Record<string, unknown>>;
      const row = locked.rows[0];
      if (!row) throw forbidden(context.correlationId);
      // A repeated revoke is safe and preserves the first revocation, even after other edits.
      // A stale revoke after a new grant is rejected by the revision check below.
      if (action === 'institution_visibility_revoked' && (row.institution_visibility_granted_at == null || row.institution_visibility_revoked_at != null)) {
        return { externalApplication: mapExternalApplication(row), correlationId: context.correlationId };
      }
      if (Number(row.revision) !== revision) throw new ConflictException(safeHiringError('EXTERNAL_APPLICATION_STALE', context.correlationId));
      if (action === 'institution_visibility_granted' && row.institution_visibility_granted_at != null && row.institution_visibility_revoked_at == null) {
        return { externalApplication: mapExternalApplication(row), correlationId: context.correlationId };
      }
      if (action === 'deleted') {
        const deleted = await tx.execute(sql`DELETE FROM external_applications WHERE id = ${id}::uuid AND student_user_id = ${actor}::uuid AND revision = ${revision} RETURNING id`) as QueryResult<{ id: string }>;
        if (!deleted.rows[0]) throw new ConflictException(safeHiringError('EXTERNAL_APPLICATION_STALE', context.correlationId));
        await this.auditExternal(tx, context, id, action, [], revision);
        return { ok: true, correlationId: context.correlationId };
      }
      const columns = { companyName: 'company_name', roleTitle: 'role_title', sourceKind: 'source_kind', appliedOn: 'applied_on', applicationUrl: 'application_url', stage: 'stage' } as const;
      const changes = Object.entries(fields).map(([key, value]) => sql`${sql.identifier(columns[key as keyof typeof columns])} = ${value}`);
      if (action === 'institution_visibility_granted') changes.push(sql`institution_visibility_granted_at = clock_timestamp(), institution_visibility_revoked_at = NULL`);
      if (action === 'institution_visibility_revoked') changes.push(sql`institution_visibility_revoked_at = greatest(clock_timestamp(), institution_visibility_granted_at)`);
      const result = await tx.execute(sql`UPDATE external_applications SET ${sql.join(changes, sql`, `)}, revision = revision + 1, updated_at = clock_timestamp()
        WHERE id = ${id}::uuid AND student_user_id = ${actor}::uuid AND revision = ${revision} RETURNING *`) as QueryResult<Record<string, unknown>>;
      if (!result.rows[0]) throw new ConflictException(safeHiringError('EXTERNAL_APPLICATION_STALE', context.correlationId));
      await this.auditExternal(tx, context, id, action, action === 'updated' ? Object.keys(fields) : ['institutionVisibility'], revision + 1);
      return { externalApplication: mapExternalApplication(result.rows[0]), correlationId: context.correlationId };
    });
  }

  private async auditExternal(db: Pick<PersistenceDb, 'execute'>, context: ReturnType<typeof requireTrustedAuthorization>, id: string, action: string, changedFields: string[], revision: number): Promise<void> {
    await db.execute(sql`INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, ${`external_application.${action}`}, 'external_application',
        ${id}::uuid, 'SUCCESS', ${context.correlationId}, ${JSON.stringify({ changedFields, revision })}::jsonb)`);
  }

  @Get('/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOpportunities(@Req() request: ProtectedHttpRequest, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const search = typeof q === 'string' && q.trim().length > 0 ? `%${q.trim().slice(0, 80)}%` : null;

    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.published_at,
             org.legal_name AS employer_name, ${companyProfileColumns},
             v.id AS version_id, v.title, v.summary, v.employment_type, v.work_mode,
             v.location_city, v.compensation_disclosed, v.compensation_currency,
             v.compensation_min, v.compensation_max, v.compensation_period,
             v.duration_months, v.application_deadline,
             (SELECT count(*) FROM applications a
               WHERE a.opportunity_id = o.id AND a.student_user_id = ${studentUserId}::uuid AND a.closed_at IS NULL) AS already_applied
      FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      JOIN organizations org ON org.id = o.employer_id
      LEFT JOIN organization_profiles company ON company.organization_id = o.employer_id
      WHERE o.lifecycle_state = 'PUBLISHED'
        AND (v.application_deadline IS NULL OR v.application_deadline > now())
        AND ${visibleToStudent(studentUserId)}
        AND ${employerInGoodStanding}
        AND (${search}::text IS NULL OR v.title ILIKE ${search} OR org.legal_name ILIKE ${search})
      ORDER BY o.published_at DESC NULLS LAST
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;

    // EMP-11: which of these reach the student through a drive their college approved.
    const drives = await readListedCampusDrives(this.db, studentUserId, rows.rows.map((row) => String(row.id)));
    return {
      opportunities: rows.rows.map((row) => ({ ...mapOpportunitySummary(row), campusDrives: drives.get(String(row.id)) ?? [] })),
      correlationId: context.correlationId,
    };
  }

  @Get('/opportunities/:opportunityId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getOpportunity(@Req() request: ProtectedHttpRequest, @Param('opportunityId') opportunityId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(opportunityId, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.lifecycle_state, o.published_at,
             org.legal_name AS employer_name, ${companyProfileColumns},
             v.id AS version_id, v.title, v.summary, v.responsibilities, v.employment_type,
             v.work_mode, v.location_city, v.location_region, v.location_country,
             v.positions_available, v.duration_months, v.compensation_disclosed,
             v.compensation_currency, v.compensation_min, v.compensation_max,
             v.compensation_period, v.joining_conditions, v.application_deadline
      FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      JOIN organizations org ON org.id = o.employer_id
      LEFT JOIN organization_profiles company ON company.organization_id = o.employer_id
      WHERE o.id = ${id}::uuid
        AND o.lifecycle_state = 'PUBLISHED'
        AND ${visibleToStudent(studentUserId)}
        AND ${employerInGoodStanding}
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);

    const versionId = String(row.version_id);
    const [skills, stages, rules, records, campusDrives] = await Promise.all([
      this.db.execute(sql`SELECT skill_name, requirement_level, taxonomy_topic_id FROM opportunity_skill_requirements WHERE opportunity_version_id = ${versionId}::uuid ORDER BY requirement_level DESC, lower(skill_name)`) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`SELECT stage_order, stage_kind, label, detail FROM opportunity_selection_stages WHERE opportunity_version_id = ${versionId}::uuid ORDER BY stage_order`) as Promise<QueryResult<Record<string, unknown>>>,
      readVersionEligibilityRules(this.db, versionId),
      readEligibilityRecords(this.db, studentUserId),
      // EMP-11: the drives at the student's colleges, the placement policy in force at each, and
      // whether it would stop this student — told before they try, not only when refused.
      readStudentCampusDrives(this.db, studentUserId, id),
    ]);

    // EMP-06: the same evaluator apply enforces, from the student's own academic records.
    const eligibility = evaluateStudentEligibility(rules, records);
    const names = await eligibilityDisplayNames(this.db, rules);
    const ruleTypes = (outcomes: readonly RuleOutcome[]) => outcomes.map((outcome) => outcome.ruleType);

    return {
      opportunity: {
        ...mapOpportunitySummary(row),
        responsibilities: row.responsibilities ?? null,
        locationRegion: row.location_region ?? null,
        locationCountry: row.location_country ?? null,
        positionsAvailable: row.positions_available ?? null,
        joiningConditions: row.joining_conditions ?? null,
        skills: skills.rows.map((s) => ({ name: s.skill_name, level: s.requirement_level, catalogue: s.taxonomy_topic_id != null })),
        selectionStages: stages.rows.map((s) => ({ order: s.stage_order, kind: s.stage_kind, label: s.label, detail: s.detail ?? null })),
      },
      eligibility: {
        eligible: eligibility.eligible,
        blockingFailures: ruleTypes(eligibility.blockingFailures),
        advisoryFailures: ruleTypes(eligibility.outcomes.filter((outcome) => !outcome.isBlocking && outcome.outcome !== 'MET')),
        // Surfaced separately so the UI can say "we cannot confirm this yet" rather
        // than telling a student they do not qualify on missing data.
        needsMoreInformation: ruleTypes(eligibility.undetermined),
        // Per rule: met or not, on what basis, and the student's own value (EMP-06).
        rules: studentRuleOutcomes(eligibility, names),
      },
      campusDrives: campusDrives.map(({ id: _driveId, placementPolicy, ...drive }) => ({
        ...drive,
        placementPolicy: placementPolicy ? { policyType: placementPolicy.policyType, allowDriveExceptions: placementPolicy.allowDriveExceptions, note: placementPolicy.note } : null,
      })),
      correlationId: context.correlationId,
    };
  }

  @Get('/students/me/applications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listApplications(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const rows = await this.db.execute(sql`
      SELECT a.id, a.state, a.submitted_at, a.closed_at, a.consent_revoked_at, a.updated_at,
             a.institution_visibility_granted_at, a.institution_visibility_revoked_at,
             o.id AS opportunity_id, org.legal_name AS employer_name,
             v.title, v.employment_type, v.work_mode, v.location_city,
             (SELECT count(*) FROM opportunity_term_change_acknowledgements t
               WHERE t.application_id = a.id AND t.acknowledgement_required
                 AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS pending_terms,
             EXISTS (SELECT 1 FROM application_feedback_releases f
               WHERE f.application_id = a.id AND f.superseded_at IS NULL) AS feedback_released,
             (SELECT inst.legal_name FROM campus_drive_applications l
               JOIN campus_drives cd ON cd.id = l.campus_drive_id JOIN organizations inst ON inst.id = cd.institution_id
               WHERE l.application_id = a.id ORDER BY l.created_at, cd.id LIMIT 1) AS campus_drive_institution
      FROM applications a
      JOIN opportunities o ON o.id = a.opportunity_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN organizations org ON org.id = a.employer_id
      WHERE a.student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY a.updated_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { applications: rows.rows.map(mapApplication), correlationId: context.correlationId };
  }

  /**
   * EMP-07: what applying would share with this employer, for the student to review first. The
   * same builder apply uses, from the same records, with the student's choices (résumé, phone,
   * links); apply rebuilds it and refuses if it no longer matches the hash reviewed here. Only the
   * student's own data comes back, with the résumés they may attach.
   */
  @Post('/students/me/application-previews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async previewApplication(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const input = readSnapshotRequest(body, ['opportunityId', 'resumeDocumentId', 'contactPhone', 'links'], context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT o.id, org.legal_name AS employer_name FROM opportunities o
      JOIN organizations org ON org.id = o.employer_id
      WHERE o.id = ${input.opportunityId}::uuid AND o.lifecycle_state = 'PUBLISHED'
        AND ${visibleToStudent(studentUserId)}
        AND ${employerInGoodStanding}
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    const built = await this.buildSnapshot(this.db, studentUserId, input, context.correlationId);
    return {
      preview: {
        employerName: row.employer_name,
        snapshot: built.snapshot,
        snapshotHash: built.hash,
        resumeOptions: await readResumeOptions(this.db, studentUserId),
      },
      correlationId: context.correlationId,
    };
  }

  /** EMP-07: the student's own stored snapshot for one of their applications, exactly as shared. */
  @Get('/students/me/applications/:applicationId/snapshot')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async applicationSnapshot(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(applicationId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT a.id, s.snapshot, s.snapshot_hash, s.created_at
      FROM applications a LEFT JOIN application_profile_snapshots s ON s.application_id = a.id
      WHERE a.id = ${id}::uuid AND a.student_user_id = ${context.authorization.principal.userId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);
    return {
      snapshot: row.snapshot_hash ? { content: row.snapshot, snapshotHash: row.snapshot_hash, sharedAt: row.created_at } : null,
      correlationId: context.correlationId,
    };
  }

  private async buildSnapshot(db: Pick<PersistenceDb, 'execute'>, studentUserId: string, input: { resumeDocumentId: string | null; choices: SnapshotChoices }, correlationId: string): Promise<BuiltSnapshot> {
    try {
      return await buildSnapshotFor(db, studentUserId, input.resumeDocumentId, input.choices);
    } catch (error) {
      if (error instanceof SnapshotResumeUnavailable) throw badRequest('RESUME_NOT_AVAILABLE', correlationId);
      throw error;
    }
  }

  @Post('/students/me/applications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async apply(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const input = readApplyInput(body, context.correlationId);

    const opportunityRows = await this.db.execute(sql`
      SELECT o.id, o.employer_id, o.lifecycle_state, o.current_version_id, v.application_deadline
      FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.id = ${input.opportunityId}::uuid
        AND ${visibleToStudent(studentUserId)}
        AND ${employerInGoodStanding}
    `) as QueryResult<Record<string, unknown>>;
    const [opportunity] = opportunityRows.rows;
    if (!opportunity) throw forbidden(context.correlationId);

    try {
      assertCanSubmitApplication({
        opportunityLifecycleState: String(opportunity.lifecycle_state),
        applicationDeadline: opportunity.application_deadline ? new Date(String(opportunity.application_deadline)) : null,
        now: new Date(),
        consentGranted: input.consentGranted,
      });
      assertApplicationTransition({ from: 'DRAFT', to: 'APPLIED', actor: 'STUDENT' });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    return this.db.transaction(async (tx) => {
      const applicationId = this.ids.uuid();
      const employerId = String(opportunity.employer_id);
      // EMP-05: re-read the job under a share lock. A pause, close or withdraw, or a new
      // version, takes this row FOR UPDATE, so it either commits before this read (and the
      // application is refused, or binds to the new version) or waits for this one (and then
      // sees this application among the applicants whose terms it changes).
      // The lock is taken on the job row alone, and the version is read by the next statement,
      // so a version committed while this waited is seen (a join here would keep the old one).
      const locked = await tx.execute(sql`
        SELECT lifecycle_state, current_version_id FROM opportunities
        WHERE id = ${input.opportunityId}::uuid AND employer_id = ${employerId}::uuid
        FOR SHARE
      `) as QueryResult<{ lifecycle_state: string; current_version_id: string }>;
      const [current] = locked.rows;
      if (!current || current.lifecycle_state !== 'PUBLISHED') throw badRequest('OPPORTUNITY_NOT_OPEN', context.correlationId);
      const versionId = String(current.current_version_id);
      const deadline = await tx.execute(sql`
        SELECT (application_deadline IS NOT NULL AND application_deadline <= now()) AS deadline_passed,
          (SELECT json_agg(json_build_object('rule_type', r.rule_type, 'comparator', r.comparator, 'value_numeric', r.value_numeric,
              'value_text', r.value_text, 'is_blocking', r.is_blocking) ORDER BY r.rule_type, r.comparator, r.value_numeric NULLS FIRST, r.value_text NULLS FIRST, r.id)
            FROM opportunity_eligibility_rules r WHERE r.opportunity_version_id = ${versionId}::uuid) AS eligibility_rules
        FROM opportunity_versions WHERE id = ${versionId}::uuid
      `) as QueryResult<{ deadline_passed: boolean; eligibility_rules?: Record<string, unknown>[] | null }>;
      if (deadline.rows[0]?.deadline_passed !== false) throw badRequest('DEADLINE_PASSED', context.correlationId);

      // EMP-06: the version's blocking eligibility rules are enforced here, against the student's
      // own academic records, on the version the application binds to. A refusal names each rule
      // that stopped it; nothing is written.
      const rules = (deadline.rows[0]?.eligibility_rules ?? []).map(mapEligibilityRuleRow);
      const evaluation = rules.length ? evaluateStudentEligibility(rules, await readEligibilityRecords(tx, studentUserId)) : null;
      if (evaluation && !evaluation.eligible) {
        const names = await eligibilityDisplayNames(tx, rules);
        const failing = studentRuleOutcomes(evaluation, names).filter((outcome) => outcome.isBlocking && outcome.outcome !== 'MET');
        throw new BadRequestException({ error: {
          code: evaluation.blockingFailures.length ? 'ELIGIBILITY_NOT_MET' : 'ELIGIBILITY_UNKNOWN',
          message: 'Request could not be completed', correlationId: context.correlationId, rules: failing,
        } });
      }

      // EMP-11: a live drive at the student's college governs this application, whichever listing
      // the student used, and the college's placement policy is enforced here (decision 10.2 #11).
      // The drives are held FOR SHARE so a cancellation either lands first or waits for this.
      const drives = await readStudentCampusDrives(tx, studentUserId, input.opportunityId, true);
      const blocking = drives.find((drive) => drive.blocksYou);
      if (blocking) {
        throw new BadRequestException({ error: {
          code: 'PLACEMENT_POLICY_ONE_OFFER', message: 'Request could not be completed', correlationId: context.correlationId,
          institutionName: blocking.institutionName, policyType: blocking.placementPolicy?.policyType ?? 'ONE_OFFER_PER_STUDENT',
        } });
      }
      // Visibility again, under the drive locks: a drive cancelled since the first read no longer admits the student.
      const stillVisible = await tx.execute(sql`
        SELECT 1 FROM opportunities o WHERE o.id = ${input.opportunityId}::uuid AND ${visibleToStudent(studentUserId)}
      `) as QueryResult<Record<string, unknown>>;
      if (stillVisible.rows.length !== 1) throw forbidden(context.correlationId);

      // The partial unique index on open applications is the real guard against a
      // double submission racing this insert; ON CONFLICT keeps it a clean 200.
      const inserted = await tx.execute(sql`
        INSERT INTO applications (id, opportunity_id, employer_id, applied_version_id, student_user_id, state, consent_granted_at, submitted_at, institution_visibility_granted_at)
        VALUES (${applicationId}::uuid, ${input.opportunityId}::uuid, ${employerId}::uuid, ${versionId}::uuid, ${studentUserId}::uuid, 'APPLIED', now(), now(), CASE WHEN ${input.institutionVisibilityGranted} THEN now() ELSE NULL END)
        ON CONFLICT DO NOTHING
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (inserted.rows.length !== 1) {
        throw badRequest('ALREADY_APPLIED', context.correlationId);
      }

      await tx.execute(sql`
        INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role)
        VALUES (${this.ids.uuid()}::uuid, ${applicationId}::uuid, 'DRAFT', 'APPLIED', ${studentUserId}::uuid, 'STUDENT')
      `);
      // Consent to be seen by this employer for this opportunity, and nothing wider.
      // The unique index is partial (WHERE revoked_at IS NULL), so the conflict target
      // must repeat that predicate. DO NOTHING rather than DO UPDATE: a previously
      // revoked grant stays revoked as an audit record, and re-applying writes a new row.
      await tx.execute(sql`
        INSERT INTO employer_applicant_access_grants (id, employer_id, student_user_id, opportunity_id, granted_at)
        VALUES (${this.ids.uuid()}::uuid, ${employerId}::uuid, ${studentUserId}::uuid, ${input.opportunityId}::uuid, now())
        ON CONFLICT (employer_id, student_user_id, opportunity_id) WHERE revoked_at IS NULL DO NOTHING
      `);
      await linkApplicationToCampusDrives(tx, applicationId, input.opportunityId, drives);
      // What the employer is told about this applicant's eligibility, frozen as it stood now.
      if (evaluation) await recordEligibilityEvaluation(tx, this.ids, { applicationId, versionId, trigger: 'APPLY', evaluation });
      await this.writeAudit(studentUserId, 'application.submitted', 'application', applicationId, context.correlationId, tx);
      if (input.institutionVisibilityGranted) {
        await this.writeAudit(studentUserId, 'application.institution_visibility_granted', 'application', applicationId, context.correlationId, tx);
      }
      await this.writeOutbox('application', applicationId, 'application.submitted', {
        applicationId, opportunityId: input.opportunityId, employerId,
      }, studentUserId, employerId, context.correlationId, tx);

      // EMP-07, last in the transaction: the consented snapshot, built from the records as they stand in this transaction and
      // bound to the version applied under. When the student reviewed a preview, what is stored must
      // be exactly that; otherwise the whole transaction rolls back and they are asked to look again.
      const built = await this.buildSnapshot(tx, studentUserId, input, context.correlationId);
      if (input.reviewedSnapshotHash !== null && input.reviewedSnapshotHash !== built.hash) {
        throw new ConflictException(safeHiringError('SNAPSHOT_CHANGED', context.correlationId));
      }
      await writeApplicationSnapshot(tx, { id: this.ids.uuid(), applicationId, versionId, built });
      return { application: { id: applicationId, state: 'APPLIED' }, correlationId: context.correlationId };
    });
  }

  /**
   * Feedback an employer chose to release on a rejected application, with the topics that
   * address each reason where a mapping exists.
   *
   * Scoped to the signed-in student's own application, and reads only the release tables —
   * never applications.rejection_reason_code or application_state_history.note, which the
   * employer wrote for their own team. A reason with no mapped topic yields an empty list
   * rather than a suggestion nobody made.
   */
  @Get('/students/me/applications/:applicationId/feedback')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async applicationFeedback(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(applicationId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT f.id, f.note, f.released_at, org.legal_name AS employer_name, v.title,
             r.reason_code, cr.student_label, cr.category,
             COALESCE((
               SELECT json_agg(json_build_object('topicId', tn.id, 'name', tn.name) ORDER BY tn.name)
               FROM candidate_feedback_reason_topics rt
               JOIN taxonomy_nodes tn ON tn.id = rt.topic_id AND tn.active
               WHERE rt.reason_code = r.reason_code
             ), '[]'::json) AS topics
      FROM application_feedback_releases f
      JOIN applications a ON a.id = f.application_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN organizations org ON org.id = a.employer_id
      JOIN application_feedback_release_reasons r ON r.release_id = f.id
      JOIN candidate_feedback_reasons cr ON cr.code = r.reason_code
      WHERE f.application_id = ${id}::uuid
        AND f.superseded_at IS NULL
        AND a.student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY cr.sort_order, cr.code
    `) as QueryResult<Record<string, unknown>>;

    const [first] = rows.rows;
    if (!first) return { feedback: null, correlationId: context.correlationId };
    return {
      feedback: {
        id: first.id,
        employerName: first.employer_name,
        title: first.title,
        releasedAt: first.released_at,
        note: first.note ?? null,
        reasons: rows.rows.map((row) => ({
          code: row.reason_code,
          studentLabel: row.student_label,
          category: row.category,
          topics: Array.isArray(row.topics) ? row.topics : [],
        })),
      },
      correlationId: context.correlationId,
    };
  }

  /**
   * INST-09: share an application with the college after applying (ADR-019: consent is the
   * student's to give and withdraw, per application). Mirrors the external-application
   * grant: a stopped share can be restarted, which starts a new sharing period. An
   * unsubmitted DRAFT cannot be shared. Idempotent: sharing what is already shared writes
   * nothing. The college still sees it only while the relationship authorises it.
   */
  @Post('/students/me/applications/:applicationId/institution-visibility/grant')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grantInstitutionVisibility(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    await this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT state, institution_visibility_granted_at, institution_visibility_revoked_at FROM applications
        WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
        FOR UPDATE
      `) as QueryResult<{ state: string; institution_visibility_granted_at: Date | null; institution_visibility_revoked_at: Date | null }>;
      const row = locked.rows[0];
      if (!row || row.state === 'DRAFT') throw forbidden(context.correlationId);
      if (row.institution_visibility_granted_at !== null && row.institution_visibility_revoked_at === null) return;
      await tx.execute(sql`
        UPDATE applications SET institution_visibility_granted_at = now(), institution_visibility_revoked_at = NULL
        WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
        VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, 'application.institution_visibility_granted', 'application', ${id}::uuid, 'SUCCESS', ${context.correlationId})
      `);
    });
    return { ok: true, correlationId: context.correlationId };
  }

  @Post('/students/me/applications/:applicationId/institution-visibility/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revokeInstitutionVisibility(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    // A single atomic update preserves the first revocation timestamp on retries.
    // Closed applications are included: visibility is independent of hiring state.
    await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        UPDATE applications SET
          institution_visibility_revoked_at = CASE WHEN institution_visibility_granted_at IS NOT NULL
            THEN coalesce(institution_visibility_revoked_at, greatest(now(), institution_visibility_granted_at)) ELSE NULL END,
          updated_at = now()
        WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (rows.rows.length !== 1) throw forbidden(context.correlationId);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
        VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, 'application.institution_visibility_revoked', 'application', ${id}::uuid, 'SUCCESS', ${context.correlationId})
      `);
    });
    return { ok: true, correlationId: context.correlationId };
  }

  @Post('/students/me/applications/:applicationId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdraw(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(applicationId, context.correlationId);
    const reason = readOptionalText(body, 'reason', 1000, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT id, state, employer_id, opportunity_id FROM applications
      WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [application] = rows.rows;
    if (!application) throw forbidden(context.correlationId);

    const from = String(application.state) as Parameters<typeof assertApplicationTransition>[0]['from'];
    try {
      assertApplicationTransition({ from, to: 'WITHDRAWN', actor: 'STUDENT' });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    // Withdrawing is itself a withdrawal of consent, recorded on the application so
    // the row describes its own privacy state without consulting the grant table.
    await this.db.execute(sql`
      UPDATE applications
      SET state = 'WITHDRAWN', closed_at = now(), consent_revoked_at = now(), withdrawn_reason = ${reason}, updated_at = now()
      WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
    `);
    await this.db.execute(sql`
      INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role, note)
      VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${from}, 'WITHDRAWN', ${studentUserId}::uuid, 'STUDENT', ${reason})
    `);
    // Withdrawing ends the employer's consented view of this student.
    await this.db.execute(sql`
      UPDATE employer_applicant_access_grants
      SET revoked_at = now()
      WHERE employer_id = ${String(application.employer_id)}::uuid
        AND student_user_id = ${studentUserId}::uuid
        AND opportunity_id = ${String(application.opportunity_id)}::uuid
        AND revoked_at IS NULL
    `);
    await this.writeAudit(studentUserId, 'application.withdrawn', 'application', id, context.correlationId);
    await this.writeOutbox('application', id, 'application.withdrawn', { applicationId: id }, studentUserId, String(application.employer_id), context.correlationId);

    return { application: { id, state: 'WITHDRAWN' }, correlationId: context.correlationId };
  }

  /**
   * EMP-08: the student's own interviews, upcoming first (soonest first), then past (latest first).
   * Where and how to join is shown only while the interview is still ahead; the employer's
   * cancellation reason and interview panel stay the employer's. Per-student counts are small, so
   * a bounded list (default 50, at most 200) serves it without a cursor.
   */
  @Get('/students/me/interviews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listInterviews(@Req() request: ProtectedHttpRequest, @Query('limit') limit?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    let size = 50;
    if (limit !== undefined) {
      size = Number(limit);
      if (!/^[0-9]{1,3}$/.test(limit) || size < 1 || size > 200) throw badRequest('INVALID_LIMIT', context.correlationId);
    }
    const rows = await this.db.execute(sql`
      SELECT * FROM (
        SELECT i.id, i.round_number, i.mode, i.state, i.scheduled_start, i.scheduled_end, i.location_detail, i.joining_link,
               i.preparation_note, st.label AS stage_label,
               a.state AS application_state, org.legal_name AS employer_name, v.title,
               (i.state IN ('SCHEDULED', 'RESCHEDULED') AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL
                 AND coalesce(i.scheduled_end, i.scheduled_start + interval '1 hour') > now()) AS upcoming
        FROM interviews i
        JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
        JOIN organizations org ON org.id = a.employer_id
        JOIN opportunity_versions v ON v.id = a.applied_version_id
        LEFT JOIN opportunity_selection_stages st ON st.id = i.selection_stage_id
        WHERE a.student_user_id = ${context.authorization.principal.userId}::uuid AND a.state <> 'DRAFT'
      ) listed
      ORDER BY upcoming DESC,
               CASE WHEN upcoming THEN scheduled_start END ASC NULLS LAST,
               CASE WHEN NOT upcoming THEN scheduled_start END DESC NULLS LAST,
               id
      LIMIT ${size}
    `) as QueryResult<Record<string, unknown>>;
    return { interviews: rows.rows.map(mapStudentInterview), correlationId: context.correlationId };
  }

  /**
   * EMP-09: the calendar invite for one of the student's own interviews, while it is ahead (with
   * how to join and what to prepare) or once it is cancelled (so their calendar can drop it).
   * Past and completed interviews have none. Someone else's interview is refused like a missing one.
   */
  @Get('/students/me/interviews/:interviewId/calendar')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async interviewCalendar(@Req() request: ProtectedHttpRequest, @Param('interviewId') interviewId: string,
    @Res() response: { setHeader(name: string, value: string): void; send(body: string): void }): Promise<void> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(interviewId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT i.state, (i.state IN ('SCHEDULED', 'RESCHEDULED') AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL
               AND coalesce(i.scheduled_end, i.scheduled_start + interval '1 hour') > now()) AS upcoming
      FROM interviews i JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      WHERE i.id = ${id}::uuid AND a.student_user_id = ${context.authorization.principal.userId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<{ state: string; upcoming: boolean }>;
    const [interview] = rows.rows;
    if (!interview) throw forbidden(context.correlationId);
    const file = interview.upcoming === true || interview.state === 'CANCELLED'
      ? await loadInterviewCalendar(this.db, { interviewId: id, reader: 'STUDENT' })
      : null;
    if (!file) throw new NotFoundException({ error: { code: 'CALENDAR_NOT_AVAILABLE', message: 'Request could not be completed', correlationId: context.correlationId } });
    sendCalendar(response, file);
  }

  @Get('/students/me/offers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOffers(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const rows = await this.db.execute(sql`
      SELECT o.id, o.state, o.compensation_currency, o.compensation_amount, o.compensation_period,
             o.joining_date, o.offer_expires_at, o.conditions, o.extended_at,
             org.legal_name AS employer_name, v.title, a.id AS application_id
      FROM offers o
      JOIN applications a ON a.id = o.application_id
      JOIN organizations org ON org.id = o.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      WHERE a.student_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY o.updated_at DESC
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    return { offers: rows.rows.map(mapOffer), correlationId: context.correlationId };
  }

  @Post('/students/me/offers/:offerId/respond')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async respondToOffer(@Req() request: ProtectedHttpRequest, @Param('offerId') offerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(offerId, context.correlationId);
    const decision = readDecision(body, context.correlationId);
    const reason = readOptionalText(body, 'reason', 1000, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT o.id, o.state, o.offer_expires_at, o.employer_id, a.id AS application_id
      FROM offers o
      JOIN applications a ON a.id = o.application_id
      WHERE o.id = ${id}::uuid AND a.student_user_id = ${studentUserId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [offer] = rows.rows;
    if (!offer) throw forbidden(context.correlationId);

    // An offer past its expiry is settled by time, not by the candidate clicking.
    if (String(offer.state) === 'EXTENDED' && isOfferExpired(offer.offer_expires_at ? new Date(String(offer.offer_expires_at)) : null, new Date())) {
      await this.db.execute(sql`UPDATE offers SET state = 'EXPIRED', updated_at = now() WHERE id = ${id}::uuid AND state = 'EXTENDED'`);
      throw badRequest('OFFER_EXPIRED', context.correlationId);
    }

    const to: OfferState = decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
    try {
      assertOfferTransition({ from: String(offer.state) as OfferState, to, actor: 'STUDENT' });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    await this.db.execute(sql`
      UPDATE offers SET state = ${to}, responded_at = now(), decline_reason = ${to === 'DECLINED' ? reason : null}, updated_at = now()
      WHERE id = ${id}::uuid
    `);
    await this.writeAudit(studentUserId, to === 'ACCEPTED' ? 'offer.accepted' : 'offer.declined', 'offer', id, context.correlationId);
    await this.writeOutbox('offer', id, to === 'ACCEPTED' ? 'offer.accepted' : 'offer.declined', { offerId: id, applicationId: String(offer.application_id) }, studentUserId, String(offer.employer_id), context.correlationId);

    // Accepting does not mark the application hired. That remains the employer's
    // action, so the record reflects who actually made the hiring decision.
    return { offer: { id, state: to }, correlationId: context.correlationId };
  }

  private async writeAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string, db: Pick<PersistenceDb, 'execute'> = this.db): Promise<void> {
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, 'SUCCESS', ${correlationId})
    `);
  }

  private async writeOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>, actorUserId: string, organizationId: string, correlationId: string, db: Pick<PersistenceDb, 'execute'> = this.db): Promise<void> {
    await db.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, actor_user_id, organization_id, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${aggregateType}, ${aggregateId}, ${eventType}, ${JSON.stringify(payload)}::jsonb, ${actorUserId}::uuid, ${organizationId}::uuid, ${correlationId})
    `);
  }
}

/**
 * Audience match for a student. PUBLIC reaches everyone; INSTITUTION requires a live
 * relationship; INSTITUTION_UNIT requires the student to sit in that unit. INVITE_ONLY
 * is intentionally absent, so an invite-only posting never appears in discovery.
 */
/**
 * Students see, open and apply to jobs only from employers that are verified and active
 * (EMP-03): a suspended, rejected or unverified employer does not reach students, even
 * if one of its jobs is still marked published.
 */
const employerInGoodStanding = employerInGoodStandingSql(sql`o.employer_id`);

function visibleToStudent(studentUserId: string) {
  // EMP-11: or through a campus drive the student's college has approved (ADR-038).
  return sql`(${visibleThroughCampusDriveSql(studentUserId)} OR EXISTS (
    SELECT 1 FROM opportunity_audiences oa
    WHERE oa.opportunity_id = o.id
      AND (
        oa.audience_kind = 'PUBLIC'
        OR (oa.audience_kind = 'INSTITUTION' AND oa.institution_id IN (
              SELECT ir.institution_id FROM institution_relationships ir
              WHERE ir.student_user_id = ${studentUserId}::uuid
                AND ir.state IN ('ACTIVE','VERIFIED')
                AND ir.effective_from <= now()
                AND (ir.effective_to IS NULL OR ir.effective_to > now())))
        OR (oa.audience_kind = 'INSTITUTION_UNIT' AND oa.institution_unit_id IN (
              SELECT unnest(ARRAY[isp.department_unit_id, isp.program_unit_id, isp.batch_unit_id, isp.section_unit_id])
              FROM institution_student_profiles isp
              WHERE isp.student_user_id = ${studentUserId}::uuid AND isp.status = 'ACTIVE'))
      )
  ))`;
}

function mapOpportunitySummary(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    referenceCode: row.reference_code ?? null,
    employerName: row.employer_name,
    title: row.title,
    summary: row.summary ?? null,
    employmentType: row.employment_type,
    workMode: row.work_mode,
    locationCity: row.location_city ?? null,
    durationMonths: row.duration_months ?? null,
    applicationDeadline: row.application_deadline ?? null,
    publishedAt: row.published_at ?? null,
    compensation: row.compensation_disclosed
      ? { currency: row.compensation_currency, min: row.compensation_min, max: row.compensation_max, period: row.compensation_period }
      : null,
    alreadyApplied: row.already_applied == null ? undefined : Number(row.already_applied) > 0,
    company: mapCompany(row),
  };
}

/**
 * The company profile students see on every job (EMP-04). Only verified, active employers'
 * jobs reach students (EMP-03), so this is always a verified company's profile. Fields nobody
 * has filled are null — never invented. The Operations contact email is not included.
 */
const companyProfileColumns = sql`company.display_name AS company_display_name, company.website_url AS company_website_url,
  company.city AS company_city, company.state_or_province AS company_state_or_province, company.country_code AS company_country_code,
  company.about_text AS company_about, company.industry AS company_industry, company.company_size_band AS company_size_band,
  company.careers_page_url AS company_careers_page_url`;

function mapCompany(row: Record<string, unknown>): Record<string, unknown> {
  const value = (key: string): string | null => (typeof row[key] === 'string' && row[key] !== '' ? row[key] as string : null);
  return {
    displayName: value('company_display_name'),
    industry: value('company_industry'),
    companySizeBand: value('company_size_band'),
    about: value('company_about'),
    websiteUrl: value('company_website_url'),
    careersPageUrl: value('company_careers_page_url'),
    city: value('company_city'),
    stateOrProvince: value('company_state_or_province'),
    countryCode: value('company_country_code'),
  };
}

function mapApplication(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    state: row.state,
    opportunityId: row.opportunity_id,
    employerName: row.employer_name,
    title: row.title,
    employmentType: row.employment_type,
    workMode: row.work_mode,
    locationCity: row.location_city ?? null,
    submittedAt: row.submitted_at ?? null,
    closedAt: row.closed_at ?? null,
    consentRevokedAt: row.consent_revoked_at ?? null,
    institutionVisibilityGrantedAt: row.institution_visibility_granted_at ?? null,
    institutionVisibilityRevokedAt: row.institution_visibility_revoked_at ?? null,
    updatedAt: row.updated_at,
    termsAcknowledgementPending: Number(row.pending_terms ?? 0) > 0,
    feedbackReleased: row.feedback_released === true,
    // EMP-11: the college whose drive this application came through, if any.
    campusDrive: typeof row.campus_drive_institution === 'string' ? { institutionName: row.campus_drive_institution } : null,
  };
}

function mapOffer(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    state: row.state,
    applicationId: row.application_id,
    employerName: row.employer_name,
    title: row.title,
    compensation: { currency: row.compensation_currency, amount: row.compensation_amount, period: row.compensation_period },
    joiningDate: row.joining_date ?? null,
    offerExpiresAt: row.offer_expires_at ?? null,
    conditions: row.conditions ?? null,
    extendedAt: row.extended_at ?? null,
  };
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** EMP-08: an interview as its candidate sees it. The link and place only while it is ahead. */
function mapStudentInterview(row: Record<string, unknown>): Record<string, unknown> {
  const upcoming = row.upcoming === true;
  return {
    id: row.id,
    employerName: row.employer_name,
    title: row.title,
    roundNumber: Number(row.round_number),
    stageLabel: row.stage_label ?? null,
    applicationState: row.application_state,
    mode: row.mode,
    state: row.state,
    upcoming,
    scheduledStart: isoOrNull(row.scheduled_start),
    scheduledEnd: isoOrNull(row.scheduled_end),
    locationDetail: upcoming ? row.location_detail ?? null : null,
    joiningLink: upcoming ? row.joining_link ?? null : null,
    preparationNote: row.state === 'CANCELLED' ? null : row.preparation_note ?? null,
  };
}

function mapExternalApplication(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, companyName: row.company_name, roleTitle: row.role_title, sourceKind: row.source_kind,
    appliedOn: row.applied_on instanceof Date ? `${row.applied_on.getFullYear()}-${String(row.applied_on.getMonth() + 1).padStart(2, '0')}-${String(row.applied_on.getDate()).padStart(2, '0')}` : row.applied_on,
    applicationUrl: row.application_url, stage: row.stage, source: row.source, verificationState: row.verification_state,
    institutionVisibilityGrantedAt: row.institution_visibility_granted_at, institutionVisibilityRevokedAt: row.institution_visibility_revoked_at,
    revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function parseExternal<T>(read: () => T, correlationId: string): T {
  try { return read(); } catch (error) { if (error instanceof ExternalApplicationInputError) throw badRequest('INVALID_EXTERNAL_APPLICATION', correlationId); throw error; }
}
function readExternalPage(value: string | undefined, fallback: number, min: number, max: number, correlationId: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw badRequest('INVALID_EXTERNAL_PAGE', correlationId);
  return Number(value);
}

function readDecision(body: unknown, correlationId: string): 'ACCEPT' | 'DECLINE' {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const value = (body as Record<string, unknown>).decision;
  if (value !== 'ACCEPT' && value !== 'DECLINE') throw badRequest('INVALID_DECISION', correlationId);
  return value;
}

const applyFields = ['opportunityId', 'consentGranted', 'institutionVisibilityGranted', 'resumeDocumentId', 'contactPhone', 'links', 'reviewedSnapshotHash'];

function readApplyInput(body: unknown, correlationId: string): {
  opportunityId: string; consentGranted: boolean; institutionVisibilityGranted: boolean;
  resumeDocumentId: string | null; choices: SnapshotChoices; reviewedSnapshotHash: string | null;
} {
  const snapshot = readSnapshotRequest(body, applyFields, correlationId);
  const record = body as Record<string, unknown>;
  if (record.institutionVisibilityGranted !== undefined && typeof record.institutionVisibilityGranted !== 'boolean') {
    throw badRequest('INVALID_INSTITUTION_VISIBILITY_CONSENT', correlationId);
  }
  let reviewedSnapshotHash: string | null = null;
  if (record.reviewedSnapshotHash !== undefined && record.reviewedSnapshotHash !== null) {
    if (typeof record.reviewedSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.reviewedSnapshotHash)) throw badRequest('INVALID_SNAPSHOT_HASH', correlationId);
    reviewedSnapshotHash = record.reviewedSnapshotHash;
  }
  return { ...snapshot, consentGranted: record.consentGranted === true, institutionVisibilityGranted: record.institutionVisibilityGranted === true, reviewedSnapshotHash };
}

/** The opportunity and the student's snapshot choices, shared by preview and apply. Unknown fields are refused. */
function readSnapshotRequest(body: unknown, allowed: readonly string[], correlationId: string): { opportunityId: string; resumeDocumentId: string | null; choices: SnapshotChoices } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw badRequest('UNKNOWN_FIELD', correlationId);
  const opportunityId = typeof record.opportunityId === 'string' ? record.opportunityId : '';
  if (!uuidPattern.test(opportunityId)) throw badRequest('INVALID_OPPORTUNITY_ID', correlationId);
  let resumeDocumentId: string | null = null;
  if (record.resumeDocumentId !== undefined && record.resumeDocumentId !== null) {
    if (typeof record.resumeDocumentId !== 'string' || !uuidPattern.test(record.resumeDocumentId)) throw badRequest('INVALID_RESUME_DOCUMENT', correlationId);
    resumeDocumentId = record.resumeDocumentId;
  }
  try {
    return { opportunityId, resumeDocumentId, choices: readSnapshotChoices(record) };
  } catch (error) {
    if (error instanceof SnapshotInputError) throw badRequest(error.code, correlationId);
    throw error;
  }
}

function readOptionalText(body: unknown, field: string, max: number, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw badRequest('INVALID_FIELD', correlationId);
  if (dangerousSpreadsheetPrefix.test(value)) throw badRequest('INVALID_FIELD', correlationId);
  return value;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

/**
 * Mirrors safeOperationError in the operations controller: a stable machine-readable
 * code with a generic message, so the client can branch without the API narrating
 * internal state back to the caller.
 */
function safeHiringError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}

/** Domain rule violations are client errors with a stable code, never 500s. */
function ruleFailure(error: unknown, correlationId: string): Error {
  if (error instanceof HiringRuleError) return new BadRequestException(safeHiringError(error.code, correlationId));
  return error instanceof Error ? error : new BadRequestException(safeHiringError('INVALID_REQUEST', correlationId));
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safeHiringError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
