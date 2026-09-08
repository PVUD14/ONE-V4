import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  HiringRuleError,
  assertApplicationTransition,
  assertCanSubmitApplication,
  assertOfferTransition,
  evaluateEligibility,
  isOfferExpired,
  type EligibilityRule,
  type OfferState,
  type StudentEligibilityFacts,
} from '@planthepath/hiring';
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

  @Get('/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOpportunities(@Req() request: ProtectedHttpRequest, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const search = typeof q === 'string' && q.trim().length > 0 ? `%${q.trim().slice(0, 80)}%` : null;

    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.published_at,
             org.legal_name AS employer_name,
             v.id AS version_id, v.title, v.summary, v.employment_type, v.work_mode,
             v.location_city, v.compensation_disclosed, v.compensation_currency,
             v.compensation_min, v.compensation_max, v.compensation_period,
             v.duration_months, v.application_deadline,
             (SELECT count(*) FROM applications a
               WHERE a.opportunity_id = o.id AND a.student_user_id = ${studentUserId}::uuid AND a.closed_at IS NULL) AS already_applied
      FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      JOIN organizations org ON org.id = o.employer_id
      WHERE o.lifecycle_state = 'PUBLISHED'
        AND (v.application_deadline IS NULL OR v.application_deadline > now())
        AND ${visibleToStudent(studentUserId)}
        AND (${search}::text IS NULL OR v.title ILIKE ${search} OR org.legal_name ILIKE ${search})
      ORDER BY o.published_at DESC NULLS LAST
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;

    return { opportunities: rows.rows.map(mapOpportunitySummary), correlationId: context.correlationId };
  }

  @Get('/opportunities/:opportunityId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getOpportunity(@Req() request: ProtectedHttpRequest, @Param('opportunityId') opportunityId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const id = requireUuid(opportunityId, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.lifecycle_state, o.published_at,
             org.legal_name AS employer_name,
             v.id AS version_id, v.title, v.summary, v.responsibilities, v.employment_type,
             v.work_mode, v.location_city, v.location_region, v.location_country,
             v.positions_available, v.duration_months, v.compensation_disclosed,
             v.compensation_currency, v.compensation_min, v.compensation_max,
             v.compensation_period, v.joining_conditions, v.application_deadline
      FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      JOIN organizations org ON org.id = o.employer_id
      WHERE o.id = ${id}::uuid
        AND o.lifecycle_state = 'PUBLISHED'
        AND ${visibleToStudent(studentUserId)}
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);

    const versionId = String(row.version_id);
    const [skills, stages, rules] = await Promise.all([
      this.db.execute(sql`SELECT skill_name, requirement_level FROM opportunity_skill_requirements WHERE opportunity_version_id = ${versionId}::uuid ORDER BY requirement_level, lower(skill_name)`) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`SELECT stage_order, stage_kind, label, detail FROM opportunity_selection_stages WHERE opportunity_version_id = ${versionId}::uuid ORDER BY stage_order`) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`SELECT rule_type, comparator, value_numeric, value_text, is_blocking FROM opportunity_eligibility_rules WHERE opportunity_version_id = ${versionId}::uuid`) as Promise<QueryResult<Record<string, unknown>>>,
    ]);

    const facts = await this.readEligibilityFacts(studentUserId);
    const eligibility = evaluateEligibility(rules.rows.map(mapEligibilityRule), facts);

    return {
      opportunity: {
        ...mapOpportunitySummary(row),
        responsibilities: row.responsibilities ?? null,
        locationRegion: row.location_region ?? null,
        locationCountry: row.location_country ?? null,
        positionsAvailable: row.positions_available ?? null,
        joiningConditions: row.joining_conditions ?? null,
        skills: skills.rows.map((s) => ({ name: s.skill_name, level: s.requirement_level })),
        selectionStages: stages.rows.map((s) => ({ order: s.stage_order, kind: s.stage_kind, label: s.label, detail: s.detail ?? null })),
      },
      eligibility: {
        eligible: eligibility.eligible,
        blockingFailures: eligibility.blockingFailures,
        advisoryFailures: eligibility.advisoryFailures,
        // Surfaced separately so the UI can say "we cannot confirm this yet" rather
        // than telling a student they do not qualify on missing data.
        needsMoreInformation: eligibility.undeterminable,
      },
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
               WHERE t.application_id = a.id AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS pending_terms
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
      const versionId = String(opportunity.current_version_id);

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
      await this.writeAudit(studentUserId, 'application.submitted', 'application', applicationId, context.correlationId, tx);
      if (input.institutionVisibilityGranted) {
        await this.writeAudit(studentUserId, 'application.institution_visibility_granted', 'application', applicationId, context.correlationId, tx);
      }
      await this.writeOutbox('application', applicationId, 'application.submitted', {
        applicationId, opportunityId: input.opportunityId, employerId,
      }, studentUserId, employerId, context.correlationId, tx);

      return { application: { id: applicationId, state: 'APPLIED' }, correlationId: context.correlationId };
    });
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

  private async readEligibilityFacts(studentUserId: string): Promise<StudentEligibilityFacts> {
    const rows = await this.db.execute(sql`
      SELECT isp.institution_id,
             dept.name AS department_name,
             prog.name AS program_name,
             extract(year FROM isp.expected_graduation_date)::int AS graduation_year
      FROM institution_student_profiles isp
      LEFT JOIN institution_units dept ON dept.id = isp.department_unit_id
      LEFT JOIN institution_units prog ON prog.id = isp.program_unit_id
      WHERE isp.student_user_id = ${studentUserId}::uuid AND isp.status = 'ACTIVE'
      ORDER BY isp.updated_at DESC
      LIMIT 1
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) return {};
    return {
      institutionId: row.institution_id ? String(row.institution_id) : null,
      departmentName: row.department_name ? String(row.department_name) : null,
      programName: row.program_name ? String(row.program_name) : null,
      graduationYear: row.graduation_year == null ? null : Number(row.graduation_year),
      // CGPA and backlogs are not modelled yet; evaluateEligibility fails these closed
      // rather than assuming the student qualifies.
    };
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
function visibleToStudent(studentUserId: string) {
  return sql`EXISTS (
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
  )`;
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
  };
}

function mapEligibilityRule(row: Record<string, unknown>): EligibilityRule {
  return {
    ruleType: row.rule_type as EligibilityRule['ruleType'],
    comparator: row.comparator as EligibilityRule['comparator'],
    valueNumeric: row.value_numeric == null ? null : Number(row.value_numeric),
    valueText: row.value_text == null ? null : String(row.value_text),
    isBlocking: Boolean(row.is_blocking),
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

function readDecision(body: unknown, correlationId: string): 'ACCEPT' | 'DECLINE' {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const value = (body as Record<string, unknown>).decision;
  if (value !== 'ACCEPT' && value !== 'DECLINE') throw badRequest('INVALID_DECISION', correlationId);
  return value;
}

function readApplyInput(body: unknown, correlationId: string): { opportunityId: string; consentGranted: boolean; institutionVisibilityGranted: boolean } {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const record = body as Record<string, unknown>;
  const opportunityId = typeof record.opportunityId === 'string' ? record.opportunityId : '';
  if (!uuidPattern.test(opportunityId)) throw badRequest('INVALID_OPPORTUNITY_ID', correlationId);
  if (record.institutionVisibilityGranted !== undefined && typeof record.institutionVisibilityGranted !== 'boolean') {
    throw badRequest('INVALID_INSTITUTION_VISIBILITY_CONSENT', correlationId);
  }
  return { opportunityId, consentGranted: record.consentGranted === true, institutionVisibilityGranted: record.institutionVisibilityGranted === true };
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
