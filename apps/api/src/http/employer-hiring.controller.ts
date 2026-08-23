import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  HiringRuleError,
  assertApplicationTransition,
  assertInterviewTransition,
  assertOfferTransition,
  materialTermsHash,
  type ApplicationState,
  type MaterialTerms,
  type OfferState,
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

/** Roles that may publish opportunities and move candidates through the pipeline. */
const employerManageRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;
/**
 * Roles that may additionally record interview feedback. HIRING_MANAGER and
 * INTERVIEWER are listed because the domain defines them, but the membership trigger
 * does not yet accept those roles, so they cannot be provisioned today.
 */
const employerInterviewRoles = [...employerManageRoles, 'HIRING_MANAGER', 'INTERVIEWER'] as const;

const employmentTypes = ['INTERNSHIP', 'FULL_TIME', 'PART_TIME', 'APPRENTICESHIP', 'CONTRACT'] as const;
const workModes = ['ONSITE', 'HYBRID', 'REMOTE'] as const;
const compensationPeriods = ['HOUR', 'MONTH', 'YEAR', 'TOTAL_STIPEND'] as const;
const interviewModes = ['ONSITE', 'VIDEO', 'PHONE'] as const;
const recommendations = ['STRONG_YES', 'YES', 'NEUTRAL', 'NO', 'STRONG_NO'] as const;
const audienceKinds = ['PUBLIC', 'INSTITUTION', 'INSTITUTION_UNIT', 'INVITE_ONLY'] as const;

/**
 * Employer-facing hiring surface. Every route is scoped to an employer the caller
 * holds an active membership in; the composite foreign keys in 0007 make it
 * structurally impossible to reach another employer's records even if that check
 * were bypassed.
 */
@Controller('/api/v1')
export class EmployerHiringController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // Opportunities
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createOpportunity(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const input = readOpportunityInput(body, context.correlationId);
    const actorId = context.authorization.principal.userId;

    const opportunityId = this.ids.uuid();
    const versionId = this.ids.uuid();

    const created = await this.db.execute(sql`
      INSERT INTO opportunities (id, employer_id, created_by_user_id, reference_code, lifecycle_state)
      VALUES (${opportunityId}::uuid, ${employerId}::uuid, ${actorId}::uuid, ${input.referenceCode}, 'DRAFT')
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (created.rows.length !== 1) throw badRequest('DUPLICATE_REFERENCE_CODE', context.correlationId);

    await this.insertVersion(opportunityId, versionId, 1, input, actorId);
    await this.db.execute(sql`UPDATE opportunities SET current_version_id = ${versionId}::uuid, updated_at = now() WHERE id = ${opportunityId}::uuid`);

    await this.writeAudit(actorId, 'opportunity.created', 'opportunity', opportunityId, context.correlationId);
    return { opportunity: { id: opportunityId, versionId, lifecycleState: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOpportunities(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerInterviewRoles);
    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.lifecycle_state, o.published_at, o.updated_at,
             v.title, v.employment_type, v.work_mode, v.location_city, v.application_deadline,
             (SELECT count(*) FROM applications a WHERE a.opportunity_id = o.id AND a.state <> 'DRAFT') AS application_count,
             (SELECT count(*) FROM applications a WHERE a.opportunity_id = o.id AND a.closed_at IS NULL AND a.state <> 'DRAFT') AS open_count
      FROM opportunities o
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.employer_id = ${employerId}::uuid
      ORDER BY o.updated_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { opportunities: rows.rows.map(mapEmployerOpportunity), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/audiences')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addAudience(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    await this.requireOwnedOpportunity(employerId, id, context.correlationId);
    const kind = readEnum(body, 'audienceKind', audienceKinds, context.correlationId);
    const institutionId = readOptionalUuid(body, 'institutionId', context.correlationId);
    const unitId = readOptionalUuid(body, 'institutionUnitId', context.correlationId);

    await this.db.execute(sql`
      INSERT INTO opportunity_audiences (id, opportunity_id, audience_kind, institution_id, institution_unit_id)
      VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${kind}, ${institutionId}::uuid, ${unitId}::uuid)
      ON CONFLICT DO NOTHING
    `);
    await this.writeAudit(context.authorization.principal.userId, 'opportunity.audience_added', 'opportunity', id, context.correlationId);
    return { ok: true, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publishOpportunity(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    const opportunity = await this.requireOwnedOpportunity(employerId, id, context.correlationId);

    if (String(opportunity.lifecycle_state) !== 'DRAFT' && String(opportunity.lifecycle_state) !== 'PAUSED') {
      throw badRequest('OPPORTUNITY_NOT_PUBLISHABLE', context.correlationId);
    }
    // An opportunity with no audience reaches nobody. Publishing it would look like
    // success while silently going nowhere, so it is refused.
    const audiences = await this.db.execute(sql`SELECT count(*)::int AS count FROM opportunity_audiences WHERE opportunity_id = ${id}::uuid`) as QueryResult<{ count: number }>;
    if ((audiences.rows[0]?.count ?? 0) === 0) throw badRequest('AUDIENCE_REQUIRED', context.correlationId);

    await this.db.execute(sql`
      UPDATE opportunities SET lifecycle_state = 'PUBLISHED', published_at = coalesce(published_at, now()), updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    await this.writeAudit(context.authorization.principal.userId, 'opportunity.published', 'opportunity', id, context.correlationId);
    await this.writeOutbox('opportunity', id, 'opportunity.published', { opportunityId: id, employerId }, context.authorization.principal.userId, employerId, context.correlationId);
    return { opportunity: { id, lifecycleState: 'PUBLISHED' }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Applicant pipeline
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/opportunities/:opportunityId/applications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listApplicants(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerInterviewRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    await this.requireOwnedOpportunity(employerId, id, context.correlationId);

    // Drafts are never visible. Withdrawn candidates stay listed so the employer knows
    // to stop scheduling, but their identifying fields are withheld once consent ends.
    const rows = await this.db.execute(sql`
      SELECT a.id, a.state, a.submitted_at, a.updated_at, a.closed_at, a.consent_revoked_at,
             u.email AS student_email, isp.full_name, isp.institution_student_id,
             (SELECT count(*) FROM interviews i WHERE i.application_id = a.id AND i.state <> 'CANCELLED') AS interview_count,
             (SELECT o2.state FROM offers o2 WHERE o2.application_id = a.id AND o2.state IN ('DRAFT','EXTENDED','ACCEPTED') LIMIT 1) AS offer_state
      FROM applications a
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN institution_student_profiles isp ON isp.student_user_id = a.student_user_id AND isp.status = 'ACTIVE'
      WHERE a.opportunity_id = ${id}::uuid
        AND a.employer_id = ${employerId}::uuid
        AND a.state <> 'DRAFT'
      ORDER BY a.updated_at DESC
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    return { applications: rows.rows.map(mapApplicantRow), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/applications/:applicationId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionApplication(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const toState = readEnum(body, 'toState', ['SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const, context.correlationId);
    const reasonCode = readOptionalSafeText(body, 'reasonCode', 64, context.correlationId);
    const note = readOptionalSafeText(body, 'note', 2000, context.correlationId);
    const actorId = context.authorization.principal.userId;

    const application = await this.requireOwnedApplication(employerId, id, context.correlationId);
    const from = String(application.state) as ApplicationState;

    try {
      // exactOptionalPropertyTypes forbids an explicit undefined, so offerState is
      // only present when an offer actually exists.
      assertApplicationTransition({
        from,
        to: toState as ApplicationState,
        actor: 'EMPLOYER',
        pendingTermsAcknowledgement: Number(application.pending_terms ?? 0) > 0,
        consentRevoked: application.consent_revoked_at != null,
        ...(application.offer_state ? { offerState: String(application.offer_state) as OfferState } : {}),
      });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const closes = toState === 'HIRED' || toState === 'REJECTED';
    await this.db.execute(sql`
      UPDATE applications
      SET state = ${toState},
          closed_at = ${closes ? sql`now()` : sql`NULL`},
          rejection_reason_code = ${toState === 'REJECTED' ? reasonCode : null},
          updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    await this.db.execute(sql`
      INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role, reason_code, note)
      VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${from}, ${toState}, ${actorId}::uuid, 'EMPLOYER', ${reasonCode}, ${note})
    `);
    // A closed application ends the employer's consented view of the student.
    if (closes) {
      await this.db.execute(sql`
        UPDATE employer_applicant_access_grants SET revoked_at = now()
        WHERE employer_id = ${employerId}::uuid
          AND student_user_id = ${String(application.student_user_id)}::uuid
          AND opportunity_id = ${String(application.opportunity_id)}::uuid
          AND revoked_at IS NULL
      `);
    }
    await this.writeAudit(actorId, `application.${toState.toLowerCase()}`, 'application', id, context.correlationId);
    await this.writeOutbox('application', id, `application.${toState.toLowerCase()}`, { applicationId: id, fromState: from, toState }, actorId, employerId, context.correlationId);

    return { application: { id, state: toState }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Interviews
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/applications/:applicationId/interviews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async scheduleInterview(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const application = await this.requireOwnedApplication(employerId, id, context.correlationId);
    if (application.consent_revoked_at != null) throw badRequest('CONSENT_REVOKED', context.correlationId);
    if (application.closed_at != null) throw badRequest('APPLICATION_CLOSED', context.correlationId);

    const mode = readEnum(body, 'mode', interviewModes, context.correlationId);
    const scheduledStart = readRequiredIsoDate(body, 'scheduledStart', context.correlationId);
    const scheduledEnd = readOptionalIsoDate(body, 'scheduledEnd', context.correlationId);
    const locationDetail = readOptionalSafeText(body, 'locationDetail', 500, context.correlationId);
    const joiningLink = readOptionalHttpsUrl(body, 'joiningLink', context.correlationId);
    if (mode === 'ONSITE' && !locationDetail) throw badRequest('LOCATION_REQUIRED', context.correlationId);

    const interviewId = this.ids.uuid();
    const nextRound = await this.db.execute(sql`
      SELECT coalesce(max(round_number), 0) + 1 AS next FROM interviews WHERE application_id = ${id}::uuid
    `) as QueryResult<{ next: number }>;

    await this.db.execute(sql`
      INSERT INTO interviews (id, application_id, employer_id, round_number, mode, state, scheduled_start, scheduled_end, location_detail, joining_link, created_by_user_id)
      VALUES (${interviewId}::uuid, ${id}::uuid, ${employerId}::uuid, ${nextRound.rows[0]?.next ?? 1}, ${mode}, 'SCHEDULED', ${scheduledStart}::timestamptz, ${scheduledEnd}::timestamptz, ${locationDetail}, ${joiningLink}, ${context.authorization.principal.userId}::uuid)
    `);
    await this.writeAudit(context.authorization.principal.userId, 'interview.scheduled', 'interview', interviewId, context.correlationId);
    await this.writeOutbox('interview', interviewId, 'interview.scheduled', { interviewId, applicationId: id }, context.authorization.principal.userId, employerId, context.correlationId);

    return { interview: { id: interviewId, state: 'SCHEDULED', roundNumber: nextRound.rows[0]?.next ?? 1 }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/interviews/:interviewId/state')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateInterviewState(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(interviewId, context.correlationId);
    const toState = readEnum(body, 'toState', ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const, context.correlationId);
    const reason = readOptionalSafeText(body, 'reason', 1000, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT id, state FROM interviews WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [interview] = rows.rows;
    if (!interview) throw forbidden(context.correlationId);

    try {
      assertInterviewTransition(String(interview.state) as never, toState as never);
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    await this.db.execute(sql`
      UPDATE interviews SET state = ${toState}, cancellation_reason = ${toState === 'CANCELLED' ? reason : null}, updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    await this.writeAudit(context.authorization.principal.userId, `interview.${toState.toLowerCase()}`, 'interview', id, context.correlationId);
    return { interview: { id, state: toState }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/interviews/:interviewId/outcome')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submitOutcome(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerInterviewRoles);
    const id = requireUuid(interviewId, context.correlationId);
    const recommendation = readEnum(body, 'recommendation', recommendations, context.correlationId);
    const rating = readOptionalRating(body, context.correlationId);
    const strengths = readOptionalSafeText(body, 'strengths', 2000, context.correlationId);
    const concerns = readOptionalSafeText(body, 'concerns', 2000, context.correlationId);
    const notes = readOptionalSafeText(body, 'notes', 4000, context.correlationId);
    const actorId = context.authorization.principal.userId;

    const rows = await this.db.execute(sql`SELECT id FROM interviews WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid`) as QueryResult<{ id: string }>;
    if (rows.rows.length !== 1) throw forbidden(context.correlationId);

    // One scorecard per interviewer is a unique index; a second submission is a
    // correction rather than an error.
    await this.db.execute(sql`
      INSERT INTO interview_outcomes (id, interview_id, submitted_by_user_id, recommendation, overall_rating, strengths, concerns, notes)
      VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${actorId}::uuid, ${recommendation}, ${rating}, ${strengths}, ${concerns}, ${notes})
      ON CONFLICT (interview_id, submitted_by_user_id) DO UPDATE SET
        recommendation = EXCLUDED.recommendation,
        overall_rating = EXCLUDED.overall_rating,
        strengths = EXCLUDED.strengths,
        concerns = EXCLUDED.concerns,
        notes = EXCLUDED.notes,
        submitted_at = now()
    `);
    await this.writeAudit(actorId, 'interview.outcome_recorded', 'interview', id, context.correlationId);
    return { ok: true, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/applications/:applicationId/offers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async extendOffer(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const application = await this.requireOwnedApplication(employerId, id, context.correlationId);
    if (application.consent_revoked_at != null) throw badRequest('CONSENT_REVOKED', context.correlationId);
    if (String(application.state) !== 'OFFER') throw badRequest('APPLICATION_NOT_AT_OFFER_STAGE', context.correlationId);

    const currency = readRequiredCurrency(body, context.correlationId);
    const amount = readRequiredAmount(body, context.correlationId);
    const period = readEnum(body, 'compensationPeriod', compensationPeriods, context.correlationId);
    const expiresAt = readRequiredIsoDate(body, 'offerExpiresAt', context.correlationId);
    const joiningDate = readOptionalIsoDate(body, 'joiningDate', context.correlationId);
    const conditions = readOptionalSafeText(body, 'conditions', 4000, context.correlationId);
    const actorId = context.authorization.principal.userId;

    try {
      assertOfferTransition({ from: 'DRAFT', to: 'EXTENDED', actor: 'EMPLOYER' });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const offerId = this.ids.uuid();
    const inserted = await this.db.execute(sql`
      INSERT INTO offers (id, application_id, employer_id, state, compensation_currency, compensation_amount, compensation_period, joining_date, offer_expires_at, conditions, extended_at, created_by_user_id)
      VALUES (${offerId}::uuid, ${id}::uuid, ${employerId}::uuid, 'EXTENDED', ${currency}, ${amount}, ${period}, ${joiningDate}::date, ${expiresAt}::timestamptz, ${conditions}, now(), ${actorId}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (inserted.rows.length !== 1) throw badRequest('ACTIVE_OFFER_EXISTS', context.correlationId);

    await this.writeAudit(actorId, 'offer.extended', 'offer', offerId, context.correlationId);
    await this.writeOutbox('offer', offerId, 'offer.extended', { offerId, applicationId: id }, actorId, employerId, context.correlationId);
    return { offer: { id: offerId, state: 'EXTENDED' }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/offers/:offerId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdrawOffer(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('offerId') offerId: string): Promise<Record<string, unknown>> {
    const context = this.requireEmployer(request, employerId, employerManageRoles);
    const id = requireUuid(offerId, context.correlationId);
    const rows = await this.db.execute(sql`SELECT id, state FROM offers WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid`) as QueryResult<Record<string, unknown>>;
    const [offer] = rows.rows;
    if (!offer) throw forbidden(context.correlationId);

    try {
      assertOfferTransition({ from: String(offer.state) as never, to: 'WITHDRAWN', actor: 'EMPLOYER' });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    await this.db.execute(sql`
      UPDATE offers SET state = 'WITHDRAWN', withdrawn_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    await this.writeAudit(context.authorization.principal.userId, 'offer.withdrawn', 'offer', id, context.correlationId);
    return { offer: { id, state: 'WITHDRAWN' }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireEmployer(request: ProtectedHttpRequest, employerId: string, roles: readonly string[]): ReturnType<typeof requireTrustedAuthorization> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(employerId, context.correlationId);
    const permitted = context.authorization.memberships.some((membership) => (
      membership.organizationId === id
      && membership.scope.organizationId === id
      && membership.scope.employerId === id
      && membership.state === 'ACTIVE'
      && roles.includes(membership.role)
    ));
    if (!permitted) throw forbidden(context.correlationId);
    return context;
  }

  private async requireOwnedOpportunity(employerId: string, opportunityId: string, correlationId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.execute(sql`
      SELECT id, lifecycle_state, current_version_id FROM opportunities
      WHERE id = ${opportunityId}::uuid AND employer_id = ${employerId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(correlationId);
    return row;
  }

  private async requireOwnedApplication(employerId: string, applicationId: string, correlationId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.execute(sql`
      SELECT a.id, a.state, a.student_user_id, a.opportunity_id, a.consent_revoked_at, a.closed_at,
             (SELECT o.state FROM offers o WHERE o.application_id = a.id AND o.state IN ('DRAFT','EXTENDED','ACCEPTED') LIMIT 1) AS offer_state,
             (SELECT count(*) FROM opportunity_term_change_acknowledgements t
               WHERE t.application_id = a.id AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS pending_terms
      FROM applications a
      WHERE a.id = ${applicationId}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(correlationId);
    return row;
  }

  private async insertVersion(opportunityId: string, versionId: string, versionNumber: number, input: OpportunityInput, actorId: string): Promise<void> {
    const terms: MaterialTerms = {
      employmentType: input.employmentType,
      workMode: input.workMode,
      locationCity: input.locationCity,
      compensationDisclosed: input.compensationDisclosed,
      compensationCurrency: input.compensationCurrency,
      compensationMin: input.compensationMin,
      compensationMax: input.compensationMax,
      compensationPeriod: input.compensationPeriod,
      durationMonths: input.durationMonths,
      applicationDeadline: input.applicationDeadline,
      joiningConditions: input.joiningConditions,
    };
    await this.db.execute(sql`
      INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, summary, responsibilities, employment_type, work_mode, location_city, positions_available, duration_months, compensation_disclosed, compensation_currency, compensation_min, compensation_max, compensation_period, joining_conditions, application_deadline, material_terms_hash, created_by_user_id)
      VALUES (${versionId}::uuid, ${opportunityId}::uuid, ${versionNumber}, ${input.title}, ${input.summary}, ${input.responsibilities}, ${input.employmentType}, ${input.workMode}, ${input.locationCity}, ${input.positionsAvailable}, ${input.durationMonths}, ${input.compensationDisclosed}, ${input.compensationCurrency}, ${input.compensationMin}, ${input.compensationMax}, ${input.compensationPeriod}, ${input.joiningConditions}, ${input.applicationDeadline}::timestamptz, ${materialTermsHash(terms)}, ${actorId}::uuid)
    `);
  }

  private async writeAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, 'SUCCESS', ${correlationId})
    `);
  }

  private async writeOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>, actorUserId: string, organizationId: string, correlationId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, actor_user_id, organization_id, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${aggregateType}, ${aggregateId}, ${eventType}, ${JSON.stringify(payload)}::jsonb, ${actorUserId}::uuid, ${organizationId}::uuid, ${correlationId})
    `);
  }
}

interface OpportunityInput {
  readonly referenceCode: string;
  readonly title: string;
  readonly summary: string | null;
  readonly responsibilities: string | null;
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly positionsAvailable: number | null;
  readonly durationMonths: number | null;
  readonly compensationDisclosed: boolean;
  readonly compensationCurrency: string | null;
  readonly compensationMin: string | null;
  readonly compensationMax: string | null;
  readonly compensationPeriod: string | null;
  readonly joiningConditions: string | null;
  readonly applicationDeadline: string | null;
}

function readOpportunityInput(body: unknown, correlationId: string): OpportunityInput {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const employmentType = readEnum(body, 'employmentType', employmentTypes, correlationId);
  const workMode = readEnum(body, 'workMode', workModes, correlationId);
  const locationCity = readOptionalSafeText(body, 'locationCity', 120, correlationId);
  if (workMode !== 'REMOTE' && !locationCity) throw badRequest('LOCATION_REQUIRED', correlationId);

  const compensationDisclosed = (body as Record<string, unknown>).compensationDisclosed === true;
  const compensationCurrency = compensationDisclosed ? readRequiredCurrency(body, correlationId) : null;
  const compensationMin = compensationDisclosed ? readRequiredAmount(body, correlationId) : null;
  const compensationMax = readOptionalAmount(body, 'compensationMax', correlationId);
  const compensationPeriod = compensationDisclosed ? readEnum(body, 'compensationPeriod', compensationPeriods, correlationId) : null;

  return {
    referenceCode: readRequiredSafeText(body, 'referenceCode', 64, correlationId),
    title: readRequiredSafeText(body, 'title', 200, correlationId),
    summary: readOptionalText(body, 'summary', 2000, correlationId),
    responsibilities: readOptionalText(body, 'responsibilities', 8000, correlationId),
    employmentType,
    workMode,
    locationCity,
    positionsAvailable: readOptionalPositiveInt(body, 'positionsAvailable', 10000, correlationId),
    durationMonths: readOptionalPositiveInt(body, 'durationMonths', 120, correlationId),
    compensationDisclosed,
    compensationCurrency,
    compensationMin,
    compensationMax,
    compensationPeriod,
    joiningConditions: readOptionalText(body, 'joiningConditions', 2000, correlationId),
    applicationDeadline: readOptionalIsoDate(body, 'applicationDeadline', correlationId),
  };
}

function mapEmployerOpportunity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    referenceCode: row.reference_code,
    lifecycleState: row.lifecycle_state,
    title: row.title ?? null,
    employmentType: row.employment_type ?? null,
    workMode: row.work_mode ?? null,
    locationCity: row.location_city ?? null,
    applicationDeadline: row.application_deadline ?? null,
    publishedAt: row.published_at ?? null,
    applicationCount: Number(row.application_count ?? 0),
    openApplicationCount: Number(row.open_count ?? 0),
  };
}

function mapApplicantRow(row: Record<string, unknown>): Record<string, unknown> {
  // Once consent is revoked the employer keeps the fact of the application, for their
  // own pipeline hygiene and for audit, but loses the person behind it.
  const consentRevoked = row.consent_revoked_at != null;
  return {
    id: row.id,
    state: row.state,
    consentRevoked,
    candidateName: consentRevoked ? null : (row.full_name ?? null),
    candidateEmail: consentRevoked ? null : row.student_email,
    institutionStudentId: consentRevoked ? null : (row.institution_student_id ?? null),
    submittedAt: row.submitted_at ?? null,
    closedAt: row.closed_at ?? null,
    interviewCount: Number(row.interview_count ?? 0),
    offerState: row.offer_state ?? null,
    updatedAt: row.updated_at,
  };
}

function readEnum<T extends readonly string[]>(body: unknown, field: string, allowed: T, correlationId: string): T[number] {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readRequiredSafeText(body: unknown, field: string, max: number, correlationId: string): string {
  const value = readOptionalSafeText(body, field, max, correlationId);
  if (!value) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readOptionalSafeText(body: unknown, field: string, max: number, correlationId: string): string | null {
  const value = readOptionalText(body, field, max, correlationId);
  if (value != null && dangerousSpreadsheetPrefix.test(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readOptionalText(body: unknown, field: string, max: number, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readOptionalPositiveInt(body: unknown, field: string, max: number, correlationId: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readRequiredCurrency(body: unknown, correlationId: string): string {
  const value = readRequiredSafeText(body, 'compensationCurrency', 3, correlationId);
  if (!/^[A-Z]{3}$/.test(value)) throw badRequest('INVALID_COMPENSATIONCURRENCY', correlationId);
  return value;
}

function readRequiredAmount(body: unknown, correlationId: string): string {
  const amount = readOptionalAmount(body, 'compensationAmount', correlationId) ?? readOptionalAmount(body, 'compensationMin', correlationId);
  if (amount == null) throw badRequest('INVALID_COMPENSATION_AMOUNT', correlationId);
  return amount;
}

function readOptionalAmount(body: unknown, field: string, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value.toFixed(2);
}

function readOptionalRating(body: unknown, correlationId: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).overallRating;
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw badRequest('INVALID_OVERALLRATING', correlationId);
  return value;
}

function readRequiredIsoDate(body: unknown, field: string, correlationId: string): string {
  const value = readOptionalIsoDate(body, field, correlationId);
  if (!value) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readOptionalIsoDate(body: unknown, field: string, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return new Date(value).toISOString();
}

function readOptionalHttpsUrl(body: unknown, field: string, correlationId: string): string | null {
  const value = readOptionalText(body, field, 512, correlationId);
  if (value == null) return null;
  if (!/^https:\/\/[^\s]+$/i.test(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function readOptionalUuid(body: unknown, field: string, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function safeHiringError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}

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
