import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { detectOpportunitySignals, OPPORTUNITY_DETECTOR_VERSION } from '@planthepath/hiring/src/review-signals.js';
import { summarizeHiringAnalytics, type HiringAggregateRow } from '@planthepath/hiring/src/analytics.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { applicationHasLiveApplicantGrant, assertEmployerApplicationAccess } from '@planthepath/persistence/src/employer-authentication.js';
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
import {
  assertEmployerState,
  employerStateRefusal,
  readEmployerOrganisationState,
  requireActiveEmployer,
  requireEmployerMembership,
  type EmployerAction,
} from './employer-organisation-state.js';

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

/** Dependency injection keeps this named, single-interview guard portable. */
export function createInterviewParticipantGuard(db: Pick<PersistenceDb, 'execute'>) {
  return async function requireInterviewParticipant(request: ProtectedHttpRequest, employerId: string, interviewId: string) {
    const context = requireTrustedAuthorization(request);
    requireUuid(employerId, context.correlationId);
    requireUuid(interviewId, context.correlationId);
    const actorId = context.authorization.principal.userId;
    if (!context.authorization.memberships.some((membership) => membership.state === 'ACTIVE'
      && membership.organizationId === employerId && membership.scope.organizationId === employerId
      && membership.scope.employerId === employerId)) throw forbidden(context.correlationId);
    // Assigned interviewers act for the employer too: a suspended, rejected or unverified
    // organisation's interviewers are refused like its recruiters (Appendix 2 §5.1).
    await assertEmployerState(db, employerId, 'candidates', context.correlationId);
    const rows = await db.execute(sql`
      SELECT i.id FROM interviews i
      WHERE i.id = ${interviewId}::uuid AND i.employer_id = ${employerId}::uuid
        AND ${activeInterviewAssignment(actorId)}
    `) as QueryResult<{ id: string }>;
    if (rows.rows.length !== 1) throw forbidden(context.correlationId);
    return context;
  };
}

/** Shared by the guard and data statements so revocation is rechecked on each query. */
function activeInterviewAssignment(actorId: string) {
  return sql`i.state IN ('SCHEDULED', 'RESCHEDULED')
    AND i.scheduled_start IS NOT NULL
    AND (i.scheduled_end IS NULL OR i.scheduled_end > clock_timestamp())
    AND EXISTS (SELECT 1 FROM interview_participants p
      WHERE p.interview_id = i.id AND p.participant_user_id = ${actorId}::uuid AND p.removed_at IS NULL)
    AND EXISTS (SELECT 1 FROM organization_memberships m JOIN organizations org ON org.id = m.organization_id
      WHERE m.user_id = ${actorId}::uuid AND m.organization_id = i.employer_id AND org.kind = 'EMPLOYER'
        AND org.verification_state = 'VERIFIED' AND org.active
        AND m.scope_organization_id = i.employer_id AND m.scope_employer_id = i.employer_id AND m.state = 'ACTIVE')`;
}

/**
 * Employer-facing hiring surface. Every route is scoped to an employer the caller
 * holds an active membership in; the composite foreign keys in 0007 make it
 * structurally impossible to reach another employer's records even if that check
 * were bypassed.
 */
@Controller('/api/v1')
export class EmployerHiringController {
  private readonly requireInterviewParticipant: ReturnType<typeof createInterviewParticipantGuard>;
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) { this.requireInterviewParticipant = createInterviewParticipantGuard(db); }

  // -------------------------------------------------------------------------
  // Organisation state
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/organisation-status')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async organisationStatus(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    // Every member may read their own organisation's state, in every state: it is what the
    // plain status page shows a suspended or rejected employer.
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'organisation.status');
    const state = await readEmployerOrganisationState(this.db, employerId);
    if (!state) throw forbidden(context.correlationId);
    return {
      organisation: {
        verificationState: state.verificationState,
        active: state.active,
        canDraft: employerStateRefusal(state, 'jobs.draft') === null,
        canPublish: employerStateRefusal(state, 'jobs.publish') === null,
        canReachCandidates: employerStateRefusal(state, 'candidates') === null,
      },
      correlationId: context.correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // Opportunities
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createOpportunity(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'jobs.draft');
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

    await this.recordReviewSignals(opportunityId, employerId, actorId, context.correlationId);

    await this.writeAudit(actorId, 'opportunity.created', 'opportunity', opportunityId, context.correlationId);
    return { opportunity: { id: opportunityId, versionId, lifecycleState: 'DRAFT' }, correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/opportunities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOpportunities(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'jobs.draft');
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
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'jobs.draft');
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
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'jobs.publish');
    const id = requireUuid(opportunityId, context.correlationId);
    const opportunity = await this.requireOwnedOpportunity(employerId, id, context.correlationId);

    if (String(opportunity.lifecycle_state) !== 'DRAFT' && String(opportunity.lifecycle_state) !== 'PAUSED') {
      throw badRequest('OPPORTUNITY_NOT_PUBLISHABLE', context.correlationId);
    }
    // An opportunity with no audience reaches nobody. Publishing it would look like
    // success while silently going nowhere, so it is refused.
    const audiences = await this.db.execute(sql`SELECT count(*)::int AS count FROM opportunity_audiences WHERE opportunity_id = ${id}::uuid`) as QueryResult<{ count: number }>;
    if ((audiences.rows[0]?.count ?? 0) === 0) throw badRequest('AUDIENCE_REQUIRED', context.correlationId);

    await this.recordReviewSignals(id, employerId, context.authorization.principal.userId, context.correlationId);

    // The state is checked again in the UPDATE itself, holding a share lock on the
    // organisation row, so a suspension committing after the route guard cannot be
    // overtaken by this publish (suspension pauses published jobs in its own transaction).
    const published = await this.db.execute(sql`
      UPDATE opportunities SET lifecycle_state = 'PUBLISHED', published_at = coalesce(published_at, now()), updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
        AND EXISTS (SELECT 1 FROM organizations org WHERE org.id = ${employerId}::uuid AND org.kind = 'EMPLOYER'
          AND org.verification_state = 'VERIFIED' AND org.active FOR SHARE)
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (published.rows.length !== 1) throw forbidden(context.correlationId);
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
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'candidates');
    const id = requireUuid(opportunityId, context.correlationId);
    await this.requireOwnedOpportunity(employerId, id, context.correlationId);

    // Drafts are never visible. Withdrawn, closed and otherwise ungranted candidates stay
    // listed so the employer knows to stop scheduling, but their identifying fields are
    // withheld once the student's grant is no longer live (EMP-SR-01).
    const rows = await this.db.execute(sql`
      SELECT a.id, a.state, a.submitted_at, a.updated_at, a.closed_at, a.consent_revoked_at,
             ${applicationHasLiveApplicantGrant('a')} AS candidate_access,
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
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
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
    await this.db.transaction(async (tx) => {
      // The grant is checked at request time and share-locked, so a withdrawal or deletion
      // that ends it cannot interleave with this move.
      await this.requireLiveGrant(employerId, [id], context.correlationId, tx);
      await tx.execute(sql`
        UPDATE applications
        SET state = ${toState},
            closed_at = ${closes ? sql`now()` : sql`NULL`},
            rejection_reason_code = ${toState === 'REJECTED' ? reasonCode : null},
            updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role, reason_code, note)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${from}, ${toState}, ${actorId}::uuid, 'EMPLOYER', ${reasonCode}, ${note})
      `);
      // A closed application ends the employer's consented view of the student.
      if (closes) {
        await tx.execute(sql`
          UPDATE employer_applicant_access_grants SET revoked_at = now()
          WHERE employer_id = ${employerId}::uuid
            AND student_user_id = ${String(application.student_user_id)}::uuid
            AND opportunity_id = ${String(application.opportunity_id)}::uuid
            AND revoked_at IS NULL
        `);
      }
      await this.writeAudit(actorId, `application.${toState.toLowerCase()}`, 'application', id, context.correlationId, tx);
      await this.writeOutbox('application', id, `application.${toState.toLowerCase()}`, { applicationId: id, fromState: from, toState }, actorId, employerId, context.correlationId, tx);
    });

    return { application: { id, state: toState }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Candidate feedback
  //
  // Releasing feedback is a separate act from rejecting. applications.rejection_reason_code
  // and application_state_history.note were written for the employer's own team and stay
  // private; nothing here reads them. Design in
  // docs/architecture/candidate-feedback-release-table-design.md.
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/candidate-feedback-reasons')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async feedbackReasons(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const rows = await this.db.execute(sql`
      SELECT code, student_label, category FROM candidate_feedback_reasons
      WHERE active ORDER BY sort_order, code
    `) as QueryResult<Record<string, unknown>>;
    return {
      reasons: rows.rows.map((row) => ({ code: row.code, studentLabel: row.student_label, category: row.category })),
      correlationId: context.correlationId,
    };
  }

  @Post('/employers/:employerId/applications/:applicationId/feedback')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async releaseFeedback(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const id = requireUuid(applicationId, context.correlationId);
    const reasonCodes = readFeedbackReasonCodes(body, context.correlationId);
    const note = readOptionalSafeText(body, 'note', 1000, context.correlationId);
    const actorId = context.authorization.principal.userId;

    // No live grant is required here, deliberately (EMP-SR-01). Feedback is only released
    // on a REJECTED application, and rejecting is what revokes the grant, so requiring one
    // would make the route unreachable. Nothing flows to the employer: the response echoes
    // only what the employer sent, and the release goes to the candidate.
    const application = await this.requireOwnedApplication(employerId, id, context.correlationId);
    // Feedback on a live application would become a back channel for negotiating, and
    // feedback after HIRED is a different conversation entirely.
    if (String(application.state) !== 'REJECTED') throw badRequest('FEEDBACK_REQUIRES_REJECTED_APPLICATION', context.correlationId);

    const known = await this.db.execute(sql`
      SELECT code FROM candidate_feedback_reasons
      WHERE active AND code IN (${sql.join(reasonCodes.map((code) => sql`${code}`), sql`, `)})
    `) as QueryResult<{ code: string }>;
    if (known.rows.length !== reasonCodes.length) throw badRequest('UNKNOWN_FEEDBACK_REASON', context.correlationId);

    const releaseId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      // A correction supersedes rather than overwrites: once a person has been told why
      // they were rejected, un-telling them is not a state this product represents.
      await tx.execute(sql`
        UPDATE application_feedback_releases SET superseded_at = now()
        WHERE application_id = ${id}::uuid AND superseded_at IS NULL
      `);
      await tx.execute(sql`
        INSERT INTO application_feedback_releases (id, application_id, employer_id, released_by_user_id, note)
        VALUES (${releaseId}::uuid, ${id}::uuid, ${employerId}::uuid, ${actorId}::uuid, ${note})
      `);
      for (const code of reasonCodes) {
        await tx.execute(sql`
          INSERT INTO application_feedback_release_reasons (release_id, reason_code)
          VALUES (${releaseId}::uuid, ${code})
        `);
      }
      await this.writeAudit(actorId, 'application.feedback.released', 'application', id, context.correlationId, tx);
      // The payload carries no reason code and no note: the outbox is a transport that
      // crosses service boundaries, and what an employer said about a named person
      // does not belong in it.
      await this.writeOutbox('application', id, 'application.feedback.released', { applicationId: id, releaseId }, actorId, employerId, context.correlationId, tx);
    });

    return { feedback: { id: releaseId, applicationId: id, reasonCodes, note }, correlationId: context.correlationId };
  }

  // -------------------------------------------------------------------------
  // Interviews
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/my-interviews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listMyInterviews(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'candidates');
    const rows = await this.readParticipantInterviews(context.authorization.principal.userId, employerId);
    return { interviews: rows.rows.map(mapParticipantInterview), correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/my-interviews/:interviewId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getMyInterview(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string): Promise<Record<string, unknown>> {
    const context = await this.requireInterviewParticipant(request, employerId, interviewId);
    const rows = await this.readParticipantInterviews(context.authorization.principal.userId, employerId, interviewId);
    // Without a live grant the brief keeps the slot and the role but loses the person, the
    // same withholding a withdrawn candidate already gets (EMP-SR-01, mapCandidateFields).
    if (rows.rows.length !== 1) throw forbidden(context.correlationId);
    return { interview: mapParticipantInterview(rows.rows[0]!), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/my-interviews/:interviewId/outcome')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submitMyOutcome(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireInterviewParticipant(request, employerId, interviewId);
    const actorId = context.authorization.principal.userId;
    const recommendation = readEnum(body, 'recommendation', recommendations, context.correlationId);
    const rating = readOptionalRating(body, context.correlationId);
    const strengths = readOptionalSafeText(body, 'strengths', 2000, context.correlationId);
    const concerns = readOptionalSafeText(body, 'concerns', 2000, context.correlationId);
    const notes = readOptionalSafeText(body, 'notes', 4000, context.correlationId);
    await this.db.transaction(async (tx) => {
      // Lock the authorization rows: removal, suspension, cancellation and consent
      // revocation cannot race a scorecard into an already-revoked scope.
      const locked = await tx.execute(sql`
        SELECT i.id, a.id AS application_id FROM interviews i
        JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
        JOIN interview_participants p ON p.interview_id = i.id AND p.participant_user_id = ${actorId}::uuid AND p.removed_at IS NULL
        JOIN organization_memberships m ON m.user_id = ${actorId}::uuid AND m.organization_id = i.employer_id
          AND m.scope_organization_id = i.employer_id AND m.scope_employer_id = i.employer_id AND m.state = 'ACTIVE'
        WHERE i.id = ${interviewId}::uuid AND i.employer_id = ${employerId}::uuid
          AND a.consent_revoked_at IS NULL AND a.closed_at IS NULL AND a.state <> 'DRAFT'
          AND ${activeInterviewAssignment(actorId)}
        FOR SHARE OF i, a, p, m
      `) as QueryResult<{ id: string; application_id: string }>;
      if (!locked.rows.length) throw forbidden(context.correlationId);
      await this.requireLiveGrant(employerId, [locked.rows[0]!.application_id], context.correlationId, tx);
      const saved = await tx.execute(sql`
        INSERT INTO interview_outcomes (id, interview_id, submitted_by_user_id, recommendation, overall_rating, strengths, concerns, notes)
        SELECT ${this.ids.uuid()}::uuid, i.id, ${actorId}::uuid, ${recommendation}, ${rating}, ${strengths}, ${concerns}, ${notes}
        FROM interviews i WHERE i.id = ${interviewId}::uuid AND i.employer_id = ${employerId}::uuid AND ${activeInterviewAssignment(actorId)}
        ON CONFLICT (interview_id, submitted_by_user_id) DO UPDATE SET
          recommendation = EXCLUDED.recommendation, overall_rating = EXCLUDED.overall_rating,
          strengths = EXCLUDED.strengths, concerns = EXCLUDED.concerns, notes = EXCLUDED.notes, submitted_at = now()
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (saved.rows.length !== 1) throw forbidden(context.correlationId);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id)
        VALUES (${this.ids.uuid()}::uuid, ${actorId}::uuid, 'interview.outcome_recorded', 'interview', ${interviewId}::uuid,
          ${employerId}::uuid, 'SUCCESS', ${context.correlationId})
      `);
    });
    return { ok: true, correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/interview-participant-options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listParticipantOptions(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const rows = await this.db.execute(sql`
      SELECT DISTINCT u.id, u.email FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${employerId}::uuid AND m.scope_organization_id = ${employerId}::uuid
        AND m.scope_employer_id = ${employerId}::uuid AND m.state = 'ACTIVE' AND u.state = 'ACTIVE'
      ORDER BY u.email LIMIT 200
    `) as QueryResult<{ id: string; email: string }>;
    return { participants: rows.rows.map((row) => ({ userId: row.id, label: row.email })), correlationId: context.correlationId };
  }

  private async readParticipantInterviews(actorId: string, employerId: string, interviewId?: string) {
    return this.db.execute(sql`
      SELECT i.id, i.round_number, i.mode, i.state, i.scheduled_start, i.scheduled_end, i.location_detail, i.joining_link,
        a.consent_revoked_at, a.closed_at, v.title, v.summary, v.responsibilities,
        ${applicationHasLiveApplicantGrant('a')} AS candidate_access,
        u.email AS student_email, isp.full_name, isp.institution_student_id
      FROM interviews i
      JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id AND v.opportunity_id = a.opportunity_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN LATERAL (SELECT full_name, institution_student_id FROM institution_student_profiles
        WHERE student_user_id = a.student_user_id AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1) isp ON true
      WHERE i.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
        ${interviewId ? sql`AND i.id = ${interviewId}::uuid` : sql``}
        AND ${activeInterviewAssignment(actorId)}
      ORDER BY i.scheduled_start, i.id LIMIT 200
    `) as Promise<QueryResult<Record<string, unknown>>>;
  }

  @Get('/employers/:employerId/interviews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listInterviews(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'candidates');
    const rows = await this.db.execute(sql`
      SELECT i.id, i.application_id, i.round_number, i.mode, i.state, i.scheduled_start, i.scheduled_end,
             i.location_detail, i.joining_link, i.created_at, i.updated_at,
             a.state AS application_state, a.submitted_at, a.closed_at, a.consent_revoked_at,
             ${applicationHasLiveApplicantGrant('a')} AS candidate_access,
             o.id AS opportunity_id, o.reference_code,
             v.title,
             u.email AS student_email, isp.full_name, isp.institution_student_id,
             (SELECT count(*) FROM interview_outcomes io WHERE io.interview_id = i.id) AS outcome_count
      FROM interviews i
      JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      JOIN opportunities o ON o.id = a.opportunity_id AND o.employer_id = i.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN institution_student_profiles isp ON isp.student_user_id = a.student_user_id AND isp.status = 'ACTIVE'
      WHERE i.employer_id = ${employerId}::uuid
        AND a.state <> 'DRAFT'
      ORDER BY i.scheduled_start ASC NULLS LAST, i.updated_at DESC
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    return { interviews: rows.rows.map(mapEmployerInterviewRow), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/applications/:applicationId/interviews')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async scheduleInterview(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const id = requireUuid(applicationId, context.correlationId);
    const application = await this.requireOwnedApplication(employerId, id, context.correlationId);
    if (application.consent_revoked_at != null) throw badRequest('CONSENT_REVOKED', context.correlationId);
    if (application.closed_at != null) throw badRequest('APPLICATION_CLOSED', context.correlationId);

    const mode = readEnum(body, 'mode', interviewModes, context.correlationId);
    const scheduledStart = readRequiredIsoDate(body, 'scheduledStart', context.correlationId);
    const scheduledEnd = readOptionalIsoDate(body, 'scheduledEnd', context.correlationId);
    if (scheduledEnd && scheduledEnd <= scheduledStart) throw badRequest('INVALID_SCHEDULE', context.correlationId);
    const locationDetail = readOptionalSafeText(body, 'locationDetail', 500, context.correlationId);
    const joiningLink = readOptionalHttpsUrl(body, 'joiningLink', context.correlationId);
    if (mode === 'ONSITE' && !locationDetail) throw badRequest('LOCATION_REQUIRED', context.correlationId);

    const record = body as Record<string, unknown>;
    const suppliedParticipants = record.participantUserIds ?? [];
    if (!Array.isArray(suppliedParticipants) || suppliedParticipants.length > 20 || suppliedParticipants.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
      throw badRequest('INVALID_PARTICIPANTS', context.correlationId);
    }
    const participantIds = [...new Set(suppliedParticipants as string[])];
    if (participantIds.length && record.participantVisibilityAcknowledged !== true) throw badRequest('PARTICIPANT_VISIBILITY_REQUIRED', context.correlationId);
    return this.db.transaction(async (tx) => {
      const lockedApplication = await tx.execute(sql`
        SELECT id FROM applications WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
          AND consent_revoked_at IS NULL AND closed_at IS NULL AND state <> 'DRAFT' FOR UPDATE
      `) as QueryResult<{ id: string }>;
      if (lockedApplication.rows.length !== 1) throw forbidden(context.correlationId);
      await this.requireLiveGrant(employerId, [id], context.correlationId, tx);
      if (participantIds.length) {
        const members = await tx.execute(sql`
          SELECT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.user_id IN (${sql.join(participantIds.map((participantId) => sql`${participantId}::uuid`), sql`, `)}) AND m.organization_id = ${employerId}::uuid
            AND m.scope_organization_id = ${employerId}::uuid AND m.scope_employer_id = ${employerId}::uuid
            AND m.state = 'ACTIVE' AND u.state = 'ACTIVE' ORDER BY m.id FOR SHARE OF m, u
        `) as QueryResult<{ user_id: string }>;
        if (new Set(members.rows.map((row) => row.user_id)).size !== participantIds.length) throw badRequest('INVALID_PARTICIPANTS', context.correlationId);
      }
      const interviewId = this.ids.uuid();
      const nextRound = await tx.execute(sql`
        SELECT coalesce(max(round_number), 0) + 1 AS next FROM interviews WHERE application_id = ${id}::uuid
      `) as QueryResult<{ next: number }>;

      await tx.execute(sql`
        INSERT INTO interviews (id, application_id, employer_id, round_number, mode, state, scheduled_start, scheduled_end, location_detail, joining_link, created_by_user_id)
        VALUES (${interviewId}::uuid, ${id}::uuid, ${employerId}::uuid, ${nextRound.rows[0]?.next ?? 1}, ${mode}, 'SCHEDULED', ${scheduledStart}::timestamptz, ${scheduledEnd}::timestamptz, ${locationDetail}, ${joiningLink}, ${context.authorization.principal.userId}::uuid)
      `);
      for (const participantId of participantIds) {
        await tx.execute(sql`
          INSERT INTO interview_participants (id, interview_id, participant_user_id, participant_role)
          VALUES (${this.ids.uuid()}::uuid, ${interviewId}::uuid, ${participantId}::uuid, 'INTERVIEWER')
        `);
      }
      if (participantIds.length) {
        await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          VALUES (${this.ids.uuid()}::uuid, ${context.authorization.principal.userId}::uuid, 'interview.participants_assigned',
            'interview', ${interviewId}::uuid, ${employerId}::uuid, 'SUCCESS', ${context.correlationId},
            ${JSON.stringify({ participantUserIds: participantIds, visibilityAcknowledged: true })}::jsonb)
        `);
      }
      await this.writeAudit(context.authorization.principal.userId, 'interview.scheduled', 'interview', interviewId, context.correlationId, tx);
      await this.writeOutbox('interview', interviewId, 'interview.scheduled', { interviewId, applicationId: id }, context.authorization.principal.userId, employerId, context.correlationId, tx);

      return { interview: { id: interviewId, state: 'SCHEDULED', roundNumber: nextRound.rows[0]?.next ?? 1 }, correlationId: context.correlationId };
    });
  }

  @Post('/employers/:employerId/interviews/:interviewId/state')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async updateInterviewState(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    // Membership first, then input, then the organisation's state: an invalid window is
    // refused before the database is touched at all.
    const context = requireEmployerMembership(request, employerId, employerManageRoles);
    const id = requireUuid(interviewId, context.correlationId);
    const toState = readEnum(body, 'toState', ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const, context.correlationId);
    const reason = readOptionalSafeText(body, 'reason', 1000, context.correlationId);

    const scheduledStart = toState === 'RESCHEDULED' ? readRequiredIsoDate(body, 'scheduledStart', context.correlationId) : null;
    const scheduledEnd = toState === 'RESCHEDULED' ? readRequiredIsoDate(body, 'scheduledEnd', context.correlationId) : null;
    if (scheduledStart && scheduledEnd && scheduledEnd <= scheduledStart) throw badRequest('INVALID_SCHEDULE', context.correlationId);
    await assertEmployerState(this.db, employerId, 'candidates', context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT i.id, i.state, ${applicationHasLiveApplicantGrant('a')} AS candidate_access
      FROM interviews i JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      WHERE i.id = ${id}::uuid AND i.employer_id = ${employerId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [interview] = rows.rows;
    if (!interview) throw forbidden(context.correlationId);
    // Rescheduling, completing or marking a no-show acts on the candidate and needs a live
    // grant (EMP-SR-01). Cancelling does not: it only stands the employer down, carries
    // nothing about the person, and must stay possible after a withdrawal or rejection so a
    // slot is not left hanging over someone who has gone.
    if (toState !== 'CANCELLED' && interview.candidate_access !== true) throw forbidden(context.correlationId);

    try {
      assertInterviewTransition(String(interview.state) as never, toState as never);
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    await this.db.execute(sql`
      UPDATE interviews SET state = ${toState}, cancellation_reason = ${toState === 'CANCELLED' ? reason : null},
        scheduled_start = coalesce(${scheduledStart}::timestamptz, scheduled_start),
        scheduled_end = coalesce(${scheduledEnd}::timestamptz, scheduled_end), updated_at = now()
      WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
    `);
    await this.writeAudit(context.authorization.principal.userId, `interview.${toState.toLowerCase()}`, 'interview', id, context.correlationId);
    return { interview: { id, state: toState }, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/interviews/:interviewId/outcome')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submitOutcome(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerInterviewRoles, 'candidates');
    const id = requireUuid(interviewId, context.correlationId);
    const recommendation = readEnum(body, 'recommendation', recommendations, context.correlationId);
    const rating = readOptionalRating(body, context.correlationId);
    const strengths = readOptionalSafeText(body, 'strengths', 2000, context.correlationId);
    const concerns = readOptionalSafeText(body, 'concerns', 2000, context.correlationId);
    const notes = readOptionalSafeText(body, 'notes', 4000, context.correlationId);
    const actorId = context.authorization.principal.userId;

    const rows = await this.db.execute(sql`SELECT id, application_id FROM interviews WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid`) as QueryResult<{ id: string; application_id: string }>;
    if (rows.rows.length !== 1) throw forbidden(context.correlationId);
    // A scorecard is a judgement about a named person; it needs their live grant.
    await this.requireLiveGrant(employerId, [rows.rows[0]!.application_id], context.correlationId);

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

  @Get('/employers/:employerId/offers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listOffers(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const rows = await this.db.execute(sql`
      SELECT off.id, off.application_id, off.state, off.compensation_currency, off.compensation_amount,
             off.compensation_period, off.joining_date, off.offer_expires_at, off.conditions,
             off.extended_at, off.responded_at, off.withdrawn_at, off.created_at, off.updated_at,
             a.state AS application_state, a.submitted_at, a.closed_at, a.consent_revoked_at,
             ${applicationHasLiveApplicantGrant('a')} AS candidate_access,
             o.id AS opportunity_id, o.reference_code,
             v.title,
             u.email AS student_email, isp.full_name, isp.institution_student_id
      FROM offers off
      JOIN applications a ON a.id = off.application_id AND a.employer_id = off.employer_id
      JOIN opportunities o ON o.id = a.opportunity_id AND o.employer_id = off.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN institution_student_profiles isp ON isp.student_user_id = a.student_user_id AND isp.status = 'ACTIVE'
      WHERE off.employer_id = ${employerId}::uuid
        AND a.state <> 'DRAFT'
      ORDER BY off.updated_at DESC
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    return { offers: rows.rows.map(mapEmployerOfferRow), correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/applications/:applicationId/offers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async extendOffer(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
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

    await this.requireLiveGrant(employerId, [id], context.correlationId);
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
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const id = requireUuid(offerId, context.correlationId);
    // No live grant is required to withdraw (EMP-SR-01): like cancelling an interview it
    // only stands the employer down, and it returns nothing about the candidate.
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

  @Get('/employers/:employerId/hiring-analytics')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async hiringAnalytics(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    // Counts per opportunity and stage only, with no row for any one person, so the
    // applicant grant does not apply here (EMP-SR-01); the organisation guard does.
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const rows = await this.db.execute(sql`
      WITH scoped AS (
        SELECT a.id, a.opportunity_id, a.state,
          ARRAY(SELECT DISTINCT stage FROM (
            SELECT h.to_state AS stage FROM application_state_history h WHERE h.application_id = a.id
            UNION SELECT a.state UNION SELECT 'APPLIED'
          ) visited ORDER BY stage) AS reached,
          (SELECT CASE WHEN min(off.extended_at) >= a.submitted_at
             THEN extract(epoch FROM (min(off.extended_at) - a.submitted_at)) / 86400.0 ELSE NULL END
           FROM offers off WHERE off.application_id = a.id AND off.employer_id = ${employerId}::uuid
          ) AS offer_days
        FROM applications a WHERE a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
      )
      SELECT o.id AS opportunity_id, coalesce(v.title, 'NA') AS title, s.state,
        coalesce(s.reached, ARRAY[]::text[]) AS reached, count(s.id) AS count,
        sum(s.offer_days) AS offer_days, count(s.offer_days) AS timed_offers
      FROM opportunities o
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      LEFT JOIN scoped s ON s.opportunity_id = o.id
      WHERE o.employer_id = ${employerId}::uuid
      GROUP BY o.id, v.title, s.state, s.reached ORDER BY v.title, o.id
    `) as QueryResult<HiringAggregateRow>;
    return { analytics: summarizeHiringAnalytics(rows.rows), correlationId: context.correlationId };
  }

  private async recordReviewSignals(opportunityId: string, employerId: string, actorId: string, correlationId: string): Promise<void> {
    const rows = await this.db.execute(sql`
      SELECT v.*,
        EXISTS (SELECT 1 FROM opportunities other JOIN opportunity_versions ov ON ov.id = other.current_version_id
          WHERE other.employer_id <> ${employerId}::uuid
            AND lower(regexp_replace(trim(ov.title), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(v.title), '\\s+', ' ', 'g'))
            AND length(trim(concat_ws(' ', v.summary, v.responsibilities))) > 0
            AND lower(regexp_replace(trim(concat_ws(' ', ov.summary, ov.responsibilities)), '\\s+', ' ', 'g')) =
                lower(regexp_replace(trim(concat_ws(' ', v.summary, v.responsibilities)), '\\s+', ' ', 'g'))
        ) AS cross_employer_duplicate
      FROM opportunities o JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.id = ${opportunityId}::uuid AND o.employer_id = ${employerId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const row = rows.rows[0];
    if (!row) throw forbidden(correlationId);
    const signals = detectOpportunitySignals({
      text: [row.title, row.summary, row.responsibilities, row.joining_conditions].filter(Boolean).join('\n'),
      crossEmployerDuplicate: row.cross_employer_duplicate === true,
      currency: row.compensation_currency == null ? null : String(row.compensation_currency),
      period: row.compensation_period == null ? null : String(row.compensation_period),
      min: row.compensation_min == null ? null : String(row.compensation_min),
      max: row.compensation_max == null ? null : String(row.compensation_max),
    });
    // Store evidence and its audit atomically; no lifecycle mutation or unregistered outbox event.
    await this.db.transaction(async (tx) => {
      for (const signal of signals) {
        await tx.execute(sql`
          INSERT INTO opportunity_review_signals (id, opportunity_id, employer_id, opportunity_version_id, signal_code, detector_version)
          VALUES (${this.ids.uuid()}::uuid, ${opportunityId}::uuid, ${employerId}::uuid, ${String(row.id)}::uuid, ${signal}, ${OPPORTUNITY_DETECTOR_VERSION})
          ON CONFLICT (opportunity_version_id, signal_code, detector_version) DO UPDATE SET last_detected_at = now()
        `);
      }
      if (signals.length) {
        await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          VALUES (${this.ids.uuid()}::uuid, ${actorId}::uuid, 'opportunity.review_requested', 'opportunity', ${opportunityId}::uuid,
            ${employerId}::uuid, 'SUCCESS', ${correlationId},
            ${JSON.stringify({ versionId: row.id, signals, detectorVersion: OPPORTUNITY_DETECTOR_VERSION })}::jsonb)
        `);
      }
    });
  }

  /** Appendix 2 §5.1 via the shared helper: membership, then active, then verification state. */
  private requireEmployer(request: ProtectedHttpRequest, employerId: string, roles: readonly string[], action: EmployerAction): Promise<ReturnType<typeof requireTrustedAuthorization>> {
    return requireActiveEmployer(this.db, request, employerId, action, roles);
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

  /**
   * EMP-SR-01: every read or write of one candidate's data needs the student's live
   * applicant-access grant at request time. The check is the shared persistence assertion;
   * any failure becomes the same safe 403 as every other refusal. Inside a transaction the
   * grant rows are share-locked for the rest of the write.
   */
  private async requireLiveGrant(employerId: string, applicationIds: readonly string[], correlationId: string, tx?: Pick<PersistenceDb, 'execute'>): Promise<void> {
    try {
      await assertEmployerApplicationAccess(tx ?? this.db, { employerId, applicationIds, lockForMutation: tx !== undefined });
    } catch {
      throw forbidden(correlationId);
    }
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
  // Once consent is revoked or the grant ends the employer keeps the fact of the
  // application, for their own pipeline hygiene and for audit, but loses the person.
  return {
    id: row.id,
    state: row.state,
    ...mapCandidateFields(row),
    submittedAt: row.submitted_at ?? null,
    closedAt: row.closed_at ?? null,
    interviewCount: Number(row.interview_count ?? 0),
    offerState: row.offer_state ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * The person behind an application is shown only while consent stands and the student's
 * applicant-access grant is live (`candidate_access`, from the shared persistence
 * predicate). `candidateAccess` tells the client why the fields are empty.
 */
function mapCandidateFields(row: Record<string, unknown>): Record<string, unknown> {
  const consentRevoked = row.consent_revoked_at != null;
  const candidateAccess = !consentRevoked && row.candidate_access === true;
  return {
    consentRevoked,
    candidateAccess,
    candidateName: candidateAccess ? (row.full_name ?? null) : null,
    candidateEmail: candidateAccess ? row.student_email : null,
    institutionStudentId: candidateAccess ? (row.institution_student_id ?? null) : null,
  };
}

function mapEmployerInterviewRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    applicationId: row.application_id,
    applicationState: row.application_state,
    opportunityId: row.opportunity_id,
    referenceCode: row.reference_code ?? null,
    title: row.title,
    ...mapCandidateFields(row),
    roundNumber: Number(row.round_number ?? 0),
    mode: row.mode,
    state: row.state,
    scheduledStart: row.scheduled_start ?? null,
    scheduledEnd: row.scheduled_end ?? null,
    locationDetail: row.location_detail ?? null,
    joiningLink: row.joining_link ?? null,
    submittedAt: row.submitted_at ?? null,
    closedAt: row.closed_at ?? null,
    outcomeCount: Number(row.outcome_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapParticipantInterview(row: Record<string, unknown>): Record<string, unknown> {
  const candidate = mapCandidateFields(row);
  return {
    id: row.id, title: row.title, roundNumber: Number(row.round_number), mode: row.mode, state: row.state,
    scheduledStart: row.scheduled_start, scheduledEnd: row.scheduled_end ?? null,
    ...candidate,
    locationDetail: candidate.candidateAccess ? row.location_detail ?? null : null,
    joiningLink: candidate.candidateAccess ? row.joining_link ?? null : null,
    summary: row.summary ?? null, responsibilities: row.responsibilities ?? null,
    canRecordOutcome: candidate.candidateAccess === true && row.closed_at == null,
  };
}

function mapEmployerOfferRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    applicationId: row.application_id,
    applicationState: row.application_state,
    opportunityId: row.opportunity_id,
    referenceCode: row.reference_code ?? null,
    title: row.title,
    ...mapCandidateFields(row),
    state: row.state,
    compensation: { currency: row.compensation_currency ?? null, amount: row.compensation_amount ?? null, period: row.compensation_period ?? null },
    joiningDate: row.joining_date ?? null,
    offerExpiresAt: row.offer_expires_at ?? null,
    conditions: row.conditions ?? null,
    extendedAt: row.extended_at ?? null,
    respondedAt: row.responded_at ?? null,
    withdrawnAt: row.withdrawn_at ?? null,
    submittedAt: row.submitted_at ?? null,
    closedAt: row.closed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readEnum<T extends readonly string[]>(body: unknown, field: string, allowed: T, correlationId: string): T[number] {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

/**
 * Reason codes on a feedback release. Capped at four because feedback a candidate can
 * act on is specific; eleven boxes ticked is a shrug with extra steps. The codes are
 * matched against the catalogue by the caller, so this only shapes the input.
 */
function readFeedbackReasonCodes(body: unknown, correlationId: string): readonly string[] {
  if (typeof body !== 'object' || body === null) throw badRequest('INVALID_BODY', correlationId);
  const value = (body as Record<string, unknown>).reasonCodes;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw badRequest('INVALID_REASONCODES', correlationId);
  const codes = [...new Set(value)];
  if (codes.length !== value.length) throw badRequest('INVALID_REASONCODES', correlationId);
  for (const code of codes) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) throw badRequest('INVALID_REASONCODES', correlationId);
  }
  return codes as readonly string[];
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
