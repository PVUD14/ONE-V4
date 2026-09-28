import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
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
import { writeOpportunityDeadlineCloseRequested } from '@planthepath/persistence/src/opportunity-deadlines.js';
import { loadInterviewCalendar } from '@planthepath/persistence/src/interview-calendar-source.js';
import { interviewCancelReasonCodes, interviewRescheduleReasonCodes, isAcceptableJoiningLink } from '@planthepath/hiring/src/interview-scheduling.js';
import {
  interviewStateFields,
  isoOrNull,
  joiningLinkVisibleSql,
  lockEmployerForWrite,
  readCriterionRatings,
  readScorecardTemplates,
  recordScorecard,
  rejectUnknownFields,
  scheduleInterviewFields,
  sendCalendar,
  writeScheduleRevision,
  type CalendarResponse,
} from './interview-scheduling.js';
import { selectionStagesOf } from './opportunity-requirements.js';
import { opportunityHasAudienceSql } from './campus-drives.js';
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
      SELECT o.id, o.reference_code, o.lifecycle_state, o.published_at, o.closed_at, o.updated_at,
             v.title, v.employment_type, v.work_mode, v.location_city, v.application_deadline, v.version_number,
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
    // success while silently going nowhere, so it is refused. EMP-11: a campus drive that is
    // pending or live counts; until the college approves it the job reaches nobody, and the
    // employer's drive list says so.
    const audiences = await this.db.execute(sql`SELECT (CASE WHEN ${opportunityHasAudienceSql(id)} THEN 1 ELSE 0 END)::int AS count`) as QueryResult<{ count: number }>;
    if ((audiences.rows[0]?.count ?? 0) === 0) throw badRequest('AUDIENCE_REQUIRED', context.correlationId);

    await this.recordReviewSignals(id, employerId, context.authorization.principal.userId, context.correlationId);

    const actorId = context.authorization.principal.userId;
    // The state is checked again in the UPDATE itself, holding a share lock on the
    // organisation row, so a suspension committing after the route guard cannot be
    // overtaken by this publish (suspension pauses published jobs in its own transaction).
    // EMP-05: the UPDATE also requires the job still to be a draft or paused (a close or
    // withdraw may have landed since it was read) and its deadline not to have passed; the
    // audit, outbox and deadline-close rows commit with it.
    await this.db.transaction(async (tx) => {
      const published = await tx.execute(sql`
        UPDATE opportunities SET lifecycle_state = 'PUBLISHED', published_at = coalesce(published_at, now()), updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
          AND lifecycle_state IN ('DRAFT', 'PAUSED')
          AND NOT EXISTS (SELECT 1 FROM opportunity_versions dv WHERE dv.id = opportunities.current_version_id AND dv.application_deadline <= now())
          AND EXISTS (SELECT 1 FROM organizations org WHERE org.id = ${employerId}::uuid AND org.kind = 'EMPLOYER'
            AND org.verification_state = 'VERIFIED' AND org.active FOR SHARE)
        RETURNING id, current_version_id
      `) as QueryResult<{ id: string; current_version_id: string }>;
      if (published.rows.length !== 1) throw await this.publishRefusal(tx, employerId, id, context.correlationId);
      await this.writeAudit(actorId, 'opportunity.published', 'opportunity', id, context.correlationId, tx, employerId);
      await this.writeOutbox('opportunity', id, 'opportunity.published', { opportunityId: id, employerId }, actorId, employerId, context.correlationId, tx);
      const versionId = published.rows[0]!.current_version_id;
      if (versionId) {
        await writeOpportunityDeadlineCloseRequested(tx, { eventId: this.ids.uuid(), opportunityId: id, versionId, actorUserId: actorId, employerId, correlationId: context.correlationId });
      }
    });
    return { opportunity: { id, lifecycleState: 'PUBLISHED' }, correlationId: context.correlationId };
  }

  /** Why a guarded publish UPDATE changed nothing: a passed deadline or a state change say so; anything else stays 403. */
  private async publishRefusal(tx: Pick<PersistenceDb, 'execute'>, employerId: string, opportunityId: string, correlationId: string): Promise<Error> {
    const rows = await tx.execute(sql`
      SELECT o.lifecycle_state, (v.application_deadline IS NOT NULL AND v.application_deadline <= now()) AS deadline_passed,
             EXISTS (SELECT 1 FROM organizations org WHERE org.id = o.employer_id AND org.kind = 'EMPLOYER' AND org.verification_state = 'VERIFIED' AND org.active) AS good_standing
      FROM opportunities o LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.id = ${opportunityId}::uuid AND o.employer_id = ${employerId}::uuid
    `) as QueryResult<{ lifecycle_state: string; deadline_passed: boolean; good_standing: boolean }>;
    const [row] = rows.rows;
    if (!row || !row.good_standing) return forbidden(correlationId);
    if (row.lifecycle_state !== 'DRAFT' && row.lifecycle_state !== 'PAUSED') return badRequest('OPPORTUNITY_NOT_PUBLISHABLE', correlationId);
    if (row.deadline_passed) return badRequest('OPPORTUNITY_DEADLINE_PASSED', correlationId);
    return forbidden(correlationId);
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
             (SELECT o2.state FROM offers o2 WHERE o2.application_id = a.id AND o2.state IN ('DRAFT','EXTENDED','ACCEPTED') LIMIT 1) AS offer_state,
             EXISTS (SELECT 1 FROM opportunity_term_change_acknowledgements t WHERE t.application_id = a.id AND t.acknowledgement_required
               AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS terms_pending,
             ev.eligible AS eligibility_eligible, ev.outcomes AS eligibility_outcomes, ev.flag_count AS eligibility_flag_count,
             ev.self_reported_count AS eligibility_self_reported_count, ev.evaluated_at AS eligibility_evaluated_at,
             ev.trigger AS eligibility_trigger, ev.version_number AS eligibility_version_number
      FROM applications a
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN institution_student_profiles isp ON isp.student_user_id = a.student_user_id AND isp.status = 'ACTIVE'
      -- EMP-06: the latest frozen eligibility evaluation (outcome and basis only, never figures).
      LEFT JOIN LATERAL (
        SELECT e.eligible, e.outcomes, e.flag_count, e.self_reported_count, e.evaluated_at, e.trigger, ev_v.version_number
        FROM application_eligibility_evaluations e JOIN opportunity_versions ev_v ON ev_v.id = e.opportunity_version_id
        WHERE e.application_id = a.id ORDER BY ev_v.version_number DESC LIMIT 1
      ) ev ON true
      WHERE a.opportunity_id = ${id}::uuid
        AND a.employer_id = ${employerId}::uuid
        AND a.state <> 'DRAFT'
      ORDER BY a.updated_at DESC
      LIMIT 500
    `) as QueryResult<Record<string, unknown>>;
    // EMP-06: the job's stages, in order, as the pipeline's template (current version).
    const stages = await this.db.execute(sql`
      SELECT st.id, st.stage_order, st.stage_kind, st.label, st.detail, st.scorecard_template_id, t.name AS scorecard_template_name FROM opportunities o
      JOIN opportunity_selection_stages st ON st.opportunity_version_id = o.current_version_id
      LEFT JOIN interview_scorecard_templates t ON t.id = st.scorecard_template_id
      WHERE o.id = ${id}::uuid AND o.employer_id = ${employerId}::uuid ORDER BY st.stage_order
    `) as QueryResult<Record<string, unknown>>;
    return { applications: rows.rows.map(mapApplicantRow), stages: selectionStagesOf(stages.rows), correlationId: context.correlationId };
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
    const row = rows.rows[0]!;
    // EMP-09: the scorecard the panellist fills in, criteria and guidance, as the stage set it.
    const [template] = row.scorecard_template_id
      ? await readScorecardTemplates(this.db, sql`t.id = ${String(row.scorecard_template_id)}::uuid AND t.employer_id = ${employerId}::uuid`)
      : [];
    return { interview: { ...mapParticipantInterview(row), stageLabel: row.stage_label ?? null, scorecardTemplate: template ?? null }, correlationId: context.correlationId };
  }

  /** EMP-09: an assigned panellist's calendar invite; the link and location only while the candidate's grant is live. */
  @Get('/employers/:employerId/my-interviews/:interviewId/calendar')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async myInterviewCalendar(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string,
    @Res() response: CalendarResponse): Promise<void> {
    const context = await this.requireInterviewParticipant(request, employerId, interviewId);
    const file = await loadInterviewCalendar(this.db, { interviewId, reader: 'PANEL' });
    if (!file) throw new NotFoundException(safeHiringError('CALENDAR_NOT_AVAILABLE', context.correlationId));
    sendCalendar(response, file);
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
    // EMP-09: the ratings of the interview's scorecard template, when it has one.
    const criteria = readCriterionRatings(body, context.correlationId);
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
      const saved = await recordScorecard(tx, {
        outcomeId: this.ids.uuid(), interviewId, employerId, actorId, recommendation, rating, strengths, concerns, notes, criteria,
        guard: activeInterviewAssignment(actorId), correlationId: context.correlationId,
      });
      if (!saved) throw forbidden(context.correlationId);
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
        i.scorecard_template_id, st.label AS stage_label,
        a.consent_revoked_at, a.closed_at, v.title, v.summary, v.responsibilities,
        ${applicationHasLiveApplicantGrant('a')} AS candidate_access,
        u.email AS student_email, isp.full_name, isp.institution_student_id
      FROM interviews i
      JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id AND v.opportunity_id = a.opportunity_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN opportunity_selection_stages st ON st.id = i.selection_stage_id
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
             ${joiningLinkVisibleSql(context.authorization.principal.userId)} AS link_visible,
             o.id AS opportunity_id, o.reference_code,
             v.title, st.label AS stage_label, t.id AS scorecard_template_id, t.name AS scorecard_template_name,
             last_change.change_kind AS last_change_kind, last_change.reason_code AS last_change_reason_code, last_change.recorded_at AS last_change_at,
             u.email AS student_email, isp.full_name, isp.institution_student_id,
             (SELECT count(*) FROM interview_outcomes io WHERE io.interview_id = i.id) AS outcome_count
      FROM interviews i
      JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      JOIN opportunities o ON o.id = a.opportunity_id AND o.employer_id = i.employer_id
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN users u ON u.id = a.student_user_id
      LEFT JOIN opportunity_selection_stages st ON st.id = i.selection_stage_id
      LEFT JOIN interview_scorecard_templates t ON t.id = i.scorecard_template_id
      LEFT JOIN LATERAL (SELECT r.change_kind, r.reason_code, r.recorded_at FROM interview_schedule_revisions r
        WHERE r.interview_id = i.id ORDER BY r.revision_number DESC LIMIT 1) last_change ON true
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

    rejectUnknownFields(body, scheduleInterviewFields, context.correlationId);
    const mode = readEnum(body, 'mode', interviewModes, context.correlationId);
    const scheduledStart = readRequiredIsoDate(body, 'scheduledStart', context.correlationId);
    const scheduledEnd = readOptionalIsoDate(body, 'scheduledEnd', context.correlationId);
    if (scheduledEnd && scheduledEnd <= scheduledStart) throw badRequest('INVALID_SCHEDULE', context.correlationId);
    const locationDetail = readOptionalSafeText(body, 'locationDetail', 500, context.correlationId);
    const joiningLink = readOptionalHttpsUrl(body, 'joiningLink', context.correlationId);
    if (mode === 'ONSITE' && !locationDetail) throw badRequest('LOCATION_REQUIRED', context.correlationId);
    // EMP-08: what the candidate should prepare, shown to them as written in their interview view.
    const preparationNote = readOptionalSafeText(body, 'preparationNote', 1000, context.correlationId);
    // EMP-09: the job stage this interview is for; its scorecard template is copied onto it.
    const selectionStageId = readOptionalUuid(body, 'selectionStageId', context.correlationId);

    const record = body as Record<string, unknown>;
    const suppliedParticipants = record.participantUserIds ?? [];
    if (!Array.isArray(suppliedParticipants) || suppliedParticipants.length > 20 || suppliedParticipants.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
      throw badRequest('INVALID_PARTICIPANTS', context.correlationId);
    }
    const participantIds = [...new Set(suppliedParticipants as string[])];
    if (participantIds.length && record.participantVisibilityAcknowledged !== true) throw badRequest('PARTICIPANT_VISIBILITY_REQUIRED', context.correlationId);
    return this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'candidates', context.correlationId);
      const lockedApplication = await tx.execute(sql`
        SELECT id FROM applications WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
          AND consent_revoked_at IS NULL AND closed_at IS NULL AND state <> 'DRAFT' FOR UPDATE
      `) as QueryResult<{ id: string }>;
      if (lockedApplication.rows.length !== 1) throw forbidden(context.correlationId);
      await this.requireLiveGrant(employerId, [id], context.correlationId, tx);
      let scorecardTemplateId: string | null = null;
      if (selectionStageId) {
        // An interview or group-discussion stage of the job as it stands now (the pipeline's stages).
        const stage = await tx.execute(sql`
          SELECT st.id, st.scorecard_template_id FROM applications a
          JOIN opportunities o ON o.id = a.opportunity_id AND o.employer_id = a.employer_id
          JOIN opportunity_selection_stages st ON st.opportunity_version_id = o.current_version_id
          WHERE a.id = ${id}::uuid AND st.id = ${selectionStageId}::uuid AND st.stage_kind IN ('INTERVIEW', 'GROUP_DISCUSSION')
        `) as QueryResult<{ id: string; scorecard_template_id: string | null }>;
        if (!stage.rows[0]) throw badRequest('INVALID_SELECTIONSTAGEID', context.correlationId);
        scorecardTemplateId = stage.rows[0].scorecard_template_id;
      }
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
        INSERT INTO interviews (id, application_id, employer_id, round_number, mode, state, scheduled_start, scheduled_end, location_detail, joining_link, preparation_note, created_by_user_id,
                                selection_stage_id, scorecard_template_id)
        VALUES (${interviewId}::uuid, ${id}::uuid, ${employerId}::uuid, ${nextRound.rows[0]?.next ?? 1}, ${mode}, 'SCHEDULED', ${scheduledStart}::timestamptz, ${scheduledEnd}::timestamptz, ${locationDetail}, ${joiningLink}, ${preparationNote}, ${context.authorization.principal.userId}::uuid,
                ${selectionStageId}::uuid, ${scorecardTemplateId}::uuid)
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
      // EMP-09: revision 1 of the interview's history, which its calendar invite is built from.
      const revision = await writeScheduleRevision(tx, { id: this.ids.uuid(), interviewId, employerId, changeKind: 'SCHEDULED', reasonCode: null, note: null, actorId: context.authorization.principal.userId });
      await this.writeAudit(context.authorization.principal.userId, 'interview.scheduled', 'interview', interviewId, context.correlationId, tx, employerId);
      await this.writeOutbox('interview', interviewId, 'interview.scheduled', { interviewId, applicationId: id, revisionId: revision.id }, context.authorization.principal.userId, employerId, context.correlationId, tx);

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
    const actorId = context.authorization.principal.userId;
    rejectUnknownFields(body, interviewStateFields, context.correlationId);
    const toState = readEnum(body, 'toState', ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const, context.correlationId);
    // EMP-09: why it moved or was cancelled (a fixed list), and an internal note never shown to
    // the candidate. `reason` is the note's earlier name and is still accepted.
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const allowedReasons: readonly string[] = toState === 'RESCHEDULED' ? interviewRescheduleReasonCodes : toState === 'CANCELLED' ? interviewCancelReasonCodes : [];
    const suppliedReason = record.reasonCode === undefined || record.reasonCode === null ? null : record.reasonCode;
    if (suppliedReason !== null && (typeof suppliedReason !== 'string' || !allowedReasons.includes(suppliedReason))) throw badRequest('INVALID_REASONCODE', context.correlationId);
    const reasonCode = suppliedReason as string | null;
    const note = readOptionalSafeText(body, 'note', 1000, context.correlationId) ?? readOptionalSafeText(body, 'reason', 1000, context.correlationId);

    const scheduledStart = toState === 'RESCHEDULED' ? readRequiredIsoDate(body, 'scheduledStart', context.correlationId) : null;
    const scheduledEnd = toState === 'RESCHEDULED' ? readRequiredIsoDate(body, 'scheduledEnd', context.correlationId) : null;
    if (scheduledStart && scheduledEnd && scheduledEnd <= scheduledStart) throw badRequest('INVALID_SCHEDULE', context.correlationId);
    // A reschedule may also change how the interview happens. Given a new mode, the location and
    // link are exactly what the body says; otherwise an absent field keeps its value and null clears it.
    const touchesHow = record.mode !== undefined || record.locationDetail !== undefined || record.joiningLink !== undefined;
    if (toState !== 'RESCHEDULED' && (touchesHow || record.scheduledStart !== undefined || record.scheduledEnd !== undefined)) {
      throw badRequest('UNKNOWN_FIELD', context.correlationId);
    }
    const newMode = toState === 'RESCHEDULED' && record.mode !== undefined ? readEnum(body, 'mode', interviewModes, context.correlationId) : null;
    const locationDetail = readOptionalSafeText(body, 'locationDetail', 500, context.correlationId);
    const joiningLink = readOptionalHttpsUrl(body, 'joiningLink', context.correlationId);
    if (newMode === 'ONSITE' && !locationDetail) throw badRequest('LOCATION_REQUIRED', context.correlationId);
    await assertEmployerState(this.db, employerId, 'candidates', context.correlationId);
    if ((toState === 'RESCHEDULED' || toState === 'CANCELLED') && reasonCode === null) throw badRequest('REASON_CODE_REQUIRED', context.correlationId);

    // EMP-08/EMP-09: the change, its history row, its audit row and the event that tells the
    // candidate and the panel commit together, under the organisation and interview locks.
    return this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'candidates', context.correlationId);
      const rows = await tx.execute(sql`
        SELECT i.id, i.state, i.mode, i.location_detail, i.joining_link, a.id AS application_id,
               ${applicationHasLiveApplicantGrant('a')} AS candidate_access, now() AS db_now
        FROM interviews i JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
        WHERE i.id = ${id}::uuid AND i.employer_id = ${employerId}::uuid
        FOR UPDATE OF i
      `) as QueryResult<Record<string, unknown>>;
      const [interview] = rows.rows;
      if (!interview) throw forbidden(context.correlationId);
      // Rescheduling, completing or marking a no-show acts on the candidate and needs a live
      // grant (EMP-SR-01), share-locked for the rest of the write. Cancelling does not: it only
      // stands the employer down, carries nothing about the person, and must stay possible after
      // a withdrawal or rejection so a slot is not left hanging over someone who has gone.
      if (toState !== 'CANCELLED') {
        if (interview.candidate_access !== true) throw forbidden(context.correlationId);
        await this.requireLiveGrant(employerId, [String(interview.application_id)], context.correlationId, tx);
      }
      try {
        assertInterviewTransition(String(interview.state) as never, toState as never);
      } catch (error) {
        throw ruleFailure(error, context.correlationId);
      }
      // Judged on the database clock, never this process's.
      if (scheduledStart && new Date(scheduledStart) <= new Date(interview.db_now as string | Date)) throw badRequest('SCHEDULE_IN_PAST', context.correlationId);
      const mode = newMode ?? String(interview.mode);
      const keep = (field: 'locationDetail' | 'joiningLink', given: string | null, current: unknown): string | null =>
        toState !== 'RESCHEDULED' || (newMode === null && record[field] === undefined) ? (current == null ? null : String(current)) : given;
      const nextLocation = keep('locationDetail', locationDetail, interview.location_detail);
      const nextLink = keep('joiningLink', joiningLink, interview.joining_link);
      if (mode === 'ONSITE' && !nextLocation) throw badRequest('LOCATION_REQUIRED', context.correlationId);

      await tx.execute(sql`
        UPDATE interviews SET state = ${toState}, cancellation_reason = ${toState === 'CANCELLED' ? note : null},
          scheduled_start = coalesce(${scheduledStart}::timestamptz, scheduled_start),
          scheduled_end = coalesce(${scheduledEnd}::timestamptz, scheduled_end),
          mode = ${mode}, location_detail = ${nextLocation}, joining_link = ${nextLink}, updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
      `);
      const revision = await writeScheduleRevision(tx, { id: this.ids.uuid(), interviewId: id, employerId, changeKind: toState, reasonCode, note, actorId });
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${actorId}::uuid, ${`interview.${toState.toLowerCase()}`}, 'interview', ${id}::uuid, ${employerId}::uuid, 'SUCCESS',
          ${context.correlationId}, ${JSON.stringify({ reasonCode, revisionNumber: revision.revisionNumber, modeChanged: newMode !== null && newMode !== interview.mode })}::jsonb)
      `);
      await this.writeOutbox('interview', id, 'interview.state_changed', { interviewId: id, toState, revisionId: revision.id }, actorId, employerId, context.correlationId, tx);
      return { interview: { id, state: toState, revisionNumber: revision.revisionNumber }, correlationId: context.correlationId };
    });
  }

  /**
   * EMP-09: an interview's schedule history, oldest first — each change, who made it, when and
   * why. It names no candidate, so it needs no applicant grant; the joining link follows the same
   * rule as the list.
   */
  @Get('/employers/:employerId/interviews/:interviewId/history')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async interviewHistory(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const id = requireUuid(interviewId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT r.revision_number, r.change_kind, r.reason_code, r.note, r.mode, r.scheduled_start, r.scheduled_end, r.location_detail,
             r.joining_link, r.recorded_at, actor.email AS actor_email,
             ${joiningLinkVisibleSql(context.authorization.principal.userId)} AS link_visible
      FROM interviews i
      JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
      JOIN interview_schedule_revisions r ON r.interview_id = i.id AND r.employer_id = i.employer_id
      JOIN users actor ON actor.id = r.actor_user_id
      WHERE i.id = ${id}::uuid AND i.employer_id = ${employerId}::uuid
      ORDER BY r.revision_number
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    if (!rows.rows.length) throw forbidden(context.correlationId);
    return {
      revisions: rows.rows.map((row) => ({
        revisionNumber: Number(row.revision_number), changeKind: row.change_kind, reasonCode: row.reason_code ?? null, note: row.note ?? null,
        mode: row.mode, scheduledStart: isoOrNull(row.scheduled_start), scheduledEnd: isoOrNull(row.scheduled_end),
        locationDetail: row.location_detail ?? null, joiningLink: row.link_visible === true ? row.joining_link ?? null : null,
        actorLabel: row.actor_email, recordedAt: isoOrNull(row.recorded_at),
      })),
      correlationId: context.correlationId,
    };
  }

  /**
   * EMP-09: every scorecard on an interview, per interviewer, with each criterion's rating as the
   * stage's template defined it. A judgement about a named person: it needs the live grant, and
   * reading it is audited. Nothing is summed, averaged or ranked (Appendix 2 §5.3).
   */
  @Get('/employers/:employerId/interviews/:interviewId/scorecards')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async interviewScorecards(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('interviewId') interviewId: string): Promise<Record<string, unknown>> {
    const context = await this.requireEmployer(request, employerId, employerManageRoles, 'candidates');
    const id = requireUuid(interviewId, context.correlationId);
    const found = await this.db.execute(sql`
      SELECT i.application_id, i.scorecard_template_id FROM interviews i WHERE i.id = ${id}::uuid AND i.employer_id = ${employerId}::uuid
    `) as QueryResult<{ application_id: string; scorecard_template_id: string | null }>;
    const [interview] = found.rows;
    if (!interview) throw forbidden(context.correlationId);
    await this.requireLiveGrant(employerId, [interview.application_id], context.correlationId);
    const [template] = interview.scorecard_template_id
      ? await readScorecardTemplates(this.db, sql`t.id = ${interview.scorecard_template_id}::uuid AND t.employer_id = ${employerId}::uuid`)
      : [];
    const cards = await this.db.execute(sql`
      SELECT o.recommendation, o.overall_rating, o.strengths, o.concerns, o.notes, o.submitted_at, u.email AS submitted_by,
             coalesce((SELECT json_agg(json_build_object('criterionId', c.id, 'label', c.label, 'rating', r.rating, 'note', r.note) ORDER BY c.position)
                       FROM interview_outcome_criterion_ratings r JOIN interview_scorecard_criteria c ON c.id = r.criterion_id
                       WHERE r.outcome_id = o.id), '[]'::json) AS ratings
      FROM interview_outcomes o JOIN users u ON u.id = o.submitted_by_user_id
      WHERE o.interview_id = ${id}::uuid
      ORDER BY o.submitted_at, o.id
      LIMIT 50
    `) as QueryResult<Record<string, unknown>>;
    await this.writeAudit(context.authorization.principal.userId, 'interview.scorecards.viewed', 'interview', id, context.correlationId, this.db, employerId);
    return {
      template: template ?? null,
      scorecards: cards.rows.map((row) => ({
        submittedBy: row.submitted_by, recommendation: row.recommendation, overallRating: row.overall_rating ?? null,
        strengths: row.strengths ?? null, concerns: row.concerns ?? null, notes: row.notes ?? null, submittedAt: isoOrNull(row.submitted_at),
        ratings: Array.isArray(row.ratings) ? row.ratings : [],
      })),
      correlationId: context.correlationId,
    };
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
    const criteria = readCriterionRatings(body, context.correlationId);
    const actorId = context.authorization.principal.userId;

    // One scorecard per interviewer is a unique index; a second submission is a correction
    // rather than an error. EMP-09: under the organisation lock, against the stage template.
    await this.db.transaction(async (tx) => {
      await lockEmployerForWrite(tx, employerId, 'candidates', context.correlationId);
      const rows = await tx.execute(sql`SELECT id, application_id FROM interviews WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid FOR SHARE`) as QueryResult<{ id: string; application_id: string }>;
      if (rows.rows.length !== 1) throw forbidden(context.correlationId);
      // A scorecard is a judgement about a named person; it needs their live grant.
      await this.requireLiveGrant(employerId, [rows.rows[0]!.application_id], context.correlationId, tx);
      const saved = await recordScorecard(tx, {
        outcomeId: this.ids.uuid(), interviewId: id, employerId, actorId, recommendation, rating, strengths, concerns, notes, criteria,
        guard: sql`true`, correlationId: context.correlationId,
      });
      if (!saved) throw forbidden(context.correlationId);
      await this.writeAudit(actorId, 'interview.outcome_recorded', 'interview', id, context.correlationId, tx, employerId);
    });
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
    // EMP-05: an offer is progress too; it waits until the applicant accepts the job's changed terms.
    if (Number(application.pending_terms ?? 0) > 0) throw badRequest('TERMS_ACKNOWLEDGEMENT_REQUIRED', context.correlationId);

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

    // EMP-08: the withdrawal, its audit row and the event that tells the candidate commit together.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE offers SET state = 'WITHDRAWN', withdrawn_at = now(), updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
      `);
      await this.writeAudit(context.authorization.principal.userId, 'offer.withdrawn', 'offer', id, context.correlationId, tx);
      await this.writeOutbox('offer', id, 'offer.withdrawn', { offerId: id }, context.authorization.principal.userId, employerId, context.correlationId, tx);
    });
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
    await recordOpportunityReviewSignals(this.db, (write) => this.db.transaction(write), this.ids, { opportunityId, employerId, actorId, correlationId });
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
               WHERE t.application_id = a.id AND t.acknowledgement_required
                 AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS pending_terms
      FROM applications a
      WHERE a.id = ${applicationId}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(correlationId);
    return row;
  }

  private async insertVersion(opportunityId: string, versionId: string, versionNumber: number, input: OpportunityVersionInput, actorId: string): Promise<void> {
    await insertOpportunityVersion(this.db, { opportunityId, versionId, versionNumber, input, actorId });
  }

  private async writeAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string, db: Pick<PersistenceDb, 'execute'> = this.db, organizationId: string | null = null): Promise<void> {
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, ${organizationId}::uuid, 'SUCCESS', ${correlationId})
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
 * Review evidence for the current version (0018): detected, stored and audited, never used to
 * reject. Exported so a new version (EMP-05) records its signals inside its own transaction:
 * `read` runs the detection query and `write` supplies the transaction for the inserts.
 */
export async function recordOpportunityReviewSignals(
  read: Pick<PersistenceDb, 'execute'>,
  write: (effect: (tx: Pick<PersistenceDb, 'execute'>) => Promise<void>) => Promise<void>,
  ids: ApiIdGenerator,
  input: { readonly opportunityId: string; readonly employerId: string; readonly actorId: string; readonly correlationId: string },
): Promise<readonly string[]> {
  const { opportunityId, employerId, actorId, correlationId } = input;
  const rows = await read.execute(sql`
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
  await write(async (tx) => {
    for (const signal of signals) {
      await tx.execute(sql`
          INSERT INTO opportunity_review_signals (id, opportunity_id, employer_id, opportunity_version_id, signal_code, detector_version)
          VALUES (${ids.uuid()}::uuid, ${opportunityId}::uuid, ${employerId}::uuid, ${String(row.id)}::uuid, ${signal}, ${OPPORTUNITY_DETECTOR_VERSION})
          ON CONFLICT (opportunity_version_id, signal_code, detector_version) DO UPDATE SET last_detected_at = now()
        `);
    }
    if (signals.length) {
      await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          VALUES (${ids.uuid()}::uuid, ${actorId}::uuid, 'opportunity.review_requested', 'opportunity', ${opportunityId}::uuid,
            ${employerId}::uuid, 'SUCCESS', ${correlationId},
            ${JSON.stringify({ versionId: row.id, signals, detectorVersion: OPPORTUNITY_DETECTOR_VERSION })}::jsonb)
        `);
    }
  });
  return signals;
}

/** The fields material_terms_hash covers, from a version body. */
export function materialTermsOf(input: OpportunityVersionInput): MaterialTerms {
  return {
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
}

/** Insert one immutable version row. Shared by job creation and EMP-05's new versions. */
export async function insertOpportunityVersion(db: Pick<PersistenceDb, 'execute'>, version: {
  readonly opportunityId: string; readonly versionId: string; readonly versionNumber: number; readonly input: OpportunityVersionInput; readonly actorId: string;
}): Promise<void> {
  const { opportunityId, versionId, versionNumber, input, actorId } = version;
  await db.execute(sql`
    INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, summary, responsibilities, employment_type, work_mode, location_city, positions_available, duration_months, compensation_disclosed, compensation_currency, compensation_min, compensation_max, compensation_period, joining_conditions, application_deadline, material_terms_hash, created_by_user_id)
    VALUES (${versionId}::uuid, ${opportunityId}::uuid, ${versionNumber}, ${input.title}, ${input.summary}, ${input.responsibilities}, ${input.employmentType}, ${input.workMode}, ${input.locationCity}, ${input.positionsAvailable}, ${input.durationMonths}, ${input.compensationDisclosed}, ${input.compensationCurrency}, ${input.compensationMin}, ${input.compensationMax}, ${input.compensationPeriod}, ${input.joiningConditions}, ${input.applicationDeadline}::timestamptz, ${materialTermsHash(materialTermsOf(input))}, ${actorId}::uuid)
  `);
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

/** Every field of a version: what a new job and a new version of a job (EMP-05) both carry. */
export type OpportunityVersionInput = Omit<OpportunityInput, 'referenceCode'>;

/** The field names a version body may carry; EMP-05's versions route rejects any other. */
export const opportunityVersionFields = [
  'title', 'summary', 'responsibilities', 'employmentType', 'workMode', 'locationCity', 'positionsAvailable', 'durationMonths',
  'compensationDisclosed', 'compensationCurrency', 'compensationMin', 'compensationMax', 'compensationPeriod',
  'joiningConditions', 'applicationDeadline',
] as const;

function readOpportunityInput(body: unknown, correlationId: string): OpportunityInput {
  const version = readOpportunityVersionInput(body, correlationId);
  return { referenceCode: readRequiredSafeText(body, 'referenceCode', 64, correlationId), ...version };
}

export function readOpportunityVersionInput(body: unknown, correlationId: string): OpportunityVersionInput {
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
    closedAt: row.closed_at ?? null,
    versionNumber: row.version_number == null ? null : Number(row.version_number),
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
    // EMP-05: the job's terms changed after they applied and they have not accepted yet.
    termsAcknowledgementPending: row.terms_pending === true,
    eligibility: mapApplicantEligibility(row),
    updatedAt: row.updated_at,
  };
}

/**
 * EMP-06: what the employer is told about an applicant's eligibility — each rule's outcome and
 * whether it rested on a verified, institution or self-reported fact, frozen when they applied
 * (or accepted a version whose eligibility changed). Candidate data: withheld with the person
 * when there is no live grant (EMP-SR-01). Null when the job had no rules to evaluate.
 */
function mapApplicantEligibility(row: Record<string, unknown>): Record<string, unknown> | null {
  const consentRevoked = row.consent_revoked_at != null;
  if (consentRevoked || row.candidate_access !== true || row.eligibility_outcomes == null) return null;
  return {
    eligible: row.eligibility_eligible === true,
    evaluatedAt: row.eligibility_evaluated_at,
    trigger: row.eligibility_trigger,
    versionNumber: row.eligibility_version_number == null ? null : Number(row.eligibility_version_number),
    flagCount: Number(row.eligibility_flag_count ?? 0),
    selfReportedCount: Number(row.eligibility_self_reported_count ?? 0),
    outcomes: Array.isArray(row.eligibility_outcomes) ? row.eligibility_outcomes : [],
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
    // EMP-09: the link only for the member who scheduled it and the panel, while the grant is live.
    joiningLink: row.link_visible === true ? row.joining_link ?? null : null,
    joiningLinkWithheld: row.joining_link != null && row.link_visible !== true,
    stageLabel: row.stage_label ?? null,
    scorecardTemplate: row.scorecard_template_id ? { id: row.scorecard_template_id, name: row.scorecard_template_name } : null,
    lastChange: row.last_change_kind ? { kind: row.last_change_kind, reasonCode: row.last_change_reason_code ?? null, at: isoOrNull(row.last_change_at) } : null,
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
  // EMP-09: plain https with a host and no embedded credentials.
  if (!isAcceptableJoiningLink(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
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
