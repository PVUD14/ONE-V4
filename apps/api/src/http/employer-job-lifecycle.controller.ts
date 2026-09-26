/**
 * Job lifecycle after creation (EMP-05): edit as a new version, pause, close, reopen, withdraw,
 * and the applicant's side of a change to the terms they applied under.
 *
 * Before EMP-05 a job could only be created and published (EMPLOYER_BASELINE D-8). The rules:
 *
 *  - Editing never rewrites a version. It inserts the next opportunity_versions row, carries the
 *    version-scoped skills, stages and eligibility rules forward, and moves current_version_id.
 *    Old versions stay intact, and applications keep pointing at the version they applied to.
 *  - An edit that moves a material term (pay, location, work mode, employment type, duration,
 *    joining conditions, eligibility, deadline) records a row in
 *    opportunity_term_change_acknowledgements for each open applicant whose terms moved. Until
 *    the applicant accepts, the employer cannot advance them or make an offer. A deadline-only
 *    change is recorded without blocking anyone (classifyTermChange says why). Each row also
 *    writes application.terms_change.recorded for EMP-08's student notifications; nothing
 *    tells the student yet except their applications list.
 *  - Pause, close, reopen and withdraw follow packages/hiring opportunity-lifecycle. Close and
 *    withdraw need a reason code from a fixed list; pause may carry one.
 *
 * Every write here runs in one transaction that first re-reads the organisation row FOR SHARE
 * and re-applies the Appendix 2 §5.1 state rule, then locks the job FOR UPDATE, so a suspension
 * that commits mid-request either wins outright or waits for this write and then pauses the job
 * (security finding EMP-SR-15). The audit row (with organisation and reason code) and the outbox
 * rows commit with the change, and every body rejects unknown fields (EMP-SR-08).
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { validateOutboxWriteInput } from '@planthepath/persistence/src/repositories.js';
import { writeOpportunityDeadlineCloseRequested } from '@planthepath/persistence/src/opportunity-deadlines.js';
import { detectOpportunitySignals } from '@planthepath/hiring/src/review-signals.js';
import {
  HiringRuleError,
  assertApplicationTransition,
  changedMaterialTerms,
  type ApplicationState,
  type MaterialTerms,
} from '@planthepath/hiring';
import {
  ELIGIBILITY_TERM,
  availableLifecycleActions,
  canEditOpportunity,
  classifyTermChange,
  isLiveOpportunityState,
  lifecycleReasonRequired,
  opportunityLifecycleReasonCodes,
  opportunityLifecycleTarget,
  type OpportunityLifecycleAction,
} from '@planthepath/hiring/src/opportunity-lifecycle.js';
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
  employerStateRefusal,
  requireActiveEmployer,
  requireEmployerMembership,
  assertEmployerState,
  type EmployerAction,
  type EmployerVerificationState,
} from './employer-organisation-state.js';
import {
  insertOpportunityVersion,
  opportunityVersionFields,
  readOpportunityVersionInput,
  recordOpportunityReviewSignals,
  type OpportunityVersionInput,
} from './employer-hiring.controller.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const employerManageRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;

/**
 * Which §5.1 action group each lifecycle action belongs to. Pausing, closing and reopening
 * act on a job students can see, so they need a verified employer; withdrawing may also
 * discard a draft, which an unverified employer may do.
 */
const lifecycleActionGroup: Readonly<Record<OpportunityLifecycleAction, EmployerAction>> = {
  PAUSE: 'jobs.publish', CLOSE: 'jobs.publish', REOPEN: 'jobs.publish', WITHDRAW: 'jobs.draft',
};
const lifecycleAuditAction: Readonly<Record<OpportunityLifecycleAction, string>> = {
  PAUSE: 'opportunity.paused', CLOSE: 'opportunity.closed', REOPEN: 'opportunity.reopened', WITHDRAW: 'opportunity.withdrawn',
};

/** Version columns a screen needs to show or edit a version, and to compare its terms. */
const versionColumns = sql`v.id, v.version_number, v.title, v.summary, v.responsibilities, v.employment_type, v.work_mode,
  v.location_city, v.positions_available, v.duration_months, v.compensation_disclosed, v.compensation_currency,
  v.compensation_min, v.compensation_max, v.compensation_period, v.joining_conditions, v.application_deadline,
  v.material_terms_hash, v.created_at,
  coalesce((SELECT string_agg(concat_ws('|', r.rule_type, r.comparator, r.value_numeric::text, r.value_text, r.is_blocking::text), ';'
      ORDER BY r.rule_type, r.comparator, r.value_numeric, r.value_text, r.is_blocking)
    FROM opportunity_eligibility_rules r WHERE r.opportunity_version_id = v.id), '') AS eligibility_signature`;

type VersionRow = Record<string, unknown> & { id: string; version_number: number; eligibility_signature: string };

@Controller('/api/v1')
export class EmployerJobLifecycleController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // -------------------------------------------------------------------------
  // Opportunity Detail
  // -------------------------------------------------------------------------

  @Get('/employers/:employerId/opportunities/:opportunityId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async getOpportunity(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string): Promise<Record<string, unknown>> {
    // Reading the employer's own job is drafting-level, like the list (EMP-03 decision d).
    const context = await requireActiveEmployer(this.db, request, employerId, 'jobs.draft', employerManageRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    const rows = await this.db.execute(sql`
      SELECT o.id, o.reference_code, o.lifecycle_state, o.current_version_id, o.published_at, o.closed_at, o.created_at, o.updated_at,
             (SELECT count(*)::int FROM applications a WHERE a.opportunity_id = o.id AND a.state <> 'DRAFT') AS application_count,
             (SELECT count(*)::int FROM applications a WHERE a.opportunity_id = o.id AND a.state <> 'DRAFT' AND a.closed_at IS NULL) AS open_count,
             (SELECT count(DISTINCT a.id)::int FROM applications a JOIN opportunity_term_change_acknowledgements t ON t.application_id = a.id
               WHERE a.opportunity_id = o.id AND a.closed_at IS NULL AND t.acknowledgement_required
                 AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS awaiting_count
      FROM opportunities o
      WHERE o.id = ${id}::uuid AND o.employer_id = ${employerId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [opportunity] = rows.rows;
    if (!opportunity) throw forbidden(context.correlationId);

    const [versions, audiences, lastChange] = await Promise.all([
      this.db.execute(sql`SELECT ${versionColumns} FROM opportunity_versions v WHERE v.opportunity_id = ${id}::uuid ORDER BY v.version_number DESC LIMIT 200`) as Promise<QueryResult<VersionRow>>,
      this.db.execute(sql`
        SELECT oa.audience_kind, org.legal_name AS institution_name, unit.name AS unit_name
        FROM opportunity_audiences oa
        LEFT JOIN organizations org ON org.id = oa.institution_id
        LEFT JOIN institution_units unit ON unit.id = oa.institution_unit_id
        WHERE oa.opportunity_id = ${id}::uuid ORDER BY oa.created_at
      `) as Promise<QueryResult<Record<string, unknown>>>,
      // The latest lifecycle change on this job, as its audit row recorded it.
      this.db.execute(sql`
        SELECT action, context ->> 'reasonCode' AS reason_code, context ->> 'trigger' AS trigger, occurred_at
        FROM audit_events
        WHERE resource_type = 'opportunity' AND resource_id = ${id} AND organization_id = ${employerId}::uuid
          AND action IN ('opportunity.paused', 'opportunity.closed', 'opportunity.reopened', 'opportunity.withdrawn', 'opportunity.published')
        ORDER BY occurred_at DESC LIMIT 1
      `) as Promise<QueryResult<Record<string, unknown>>>,
    ]);

    const state = String(opportunity.lifecycle_state);
    const ordered = [...versions.rows].sort((a, b) => Number(a.version_number) - Number(b.version_number));
    const history = ordered.map((version, index) => {
      const previous = index > 0 ? ordered[index - 1] : undefined;
      const changed = previous ? changedTerms(previous, version) : [];
      return {
        id: version.id,
        versionNumber: Number(version.version_number),
        title: version.title,
        createdAt: version.created_at,
        isCurrent: version.id === opportunity.current_version_id,
        change: previous ? (changed.length ? 'MATERIAL' : 'EDITORIAL') : 'INITIAL',
        changedTerms: changed,
      };
    }).reverse();
    const current = versions.rows.find((version) => version.id === opportunity.current_version_id);
    const last = lastChange.rows[0];
    return {
      opportunity: {
        id: opportunity.id,
        referenceCode: opportunity.reference_code,
        lifecycleState: state,
        publishedAt: opportunity.published_at ?? null,
        closedAt: opportunity.closed_at ?? null,
        createdAt: opportunity.created_at,
        updatedAt: opportunity.updated_at,
        canEdit: canEditOpportunity(state),
        availableActions: availableLifecycleActions(state),
        reasonCodes: opportunityLifecycleReasonCodes,
        audiences: audiences.rows.map((row) => ({ kind: row.audience_kind, institutionName: row.institution_name ?? null, unitName: row.unit_name ?? null })),
        applicationCount: Number(opportunity.application_count ?? 0),
        openApplicationCount: Number(opportunity.open_count ?? 0),
        awaitingAcknowledgementCount: Number(opportunity.awaiting_count ?? 0),
        lastLifecycleChange: last ? { action: last.action, reasonCode: last.reason_code ?? null, trigger: last.trigger ?? 'EMPLOYER', occurredAt: last.occurred_at } : null,
      },
      currentVersion: current ? mapVersion(current) : null,
      versions: history,
      correlationId: context.correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // Edit: a new version
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/opportunities/:opportunityId/versions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createVersion(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    // Membership, then input, then state: malformed input is refused before any query.
    const context = requireEmployerMembership(request, employerId, employerManageRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    rejectUnknownFields(body, [...opportunityVersionFields, 'expectedCurrentVersionId'], context.correlationId);
    const expectedCurrentVersionId = readRequiredUuid(body, 'expectedCurrentVersionId', context.correlationId);
    const input = readOpportunityVersionInput(body, context.correlationId);
    if (input.applicationDeadline && Date.parse(input.applicationDeadline) <= Date.now()) throw badRequest('INVALID_APPLICATIONDEADLINE', context.correlationId);
    await assertEmployerState(this.db, employerId, 'jobs.draft', context.correlationId);
    const actorId = context.authorization.principal.userId;

    return this.db.transaction(async (tx) => {
      const opportunity = await this.lockForWrite(tx, employerId, id, 'jobs.draft', context.correlationId);
      const state = String(opportunity.lifecycle_state);
      if (!canEditOpportunity(state)) throw badRequest('OPPORTUNITY_NOT_EDITABLE', context.correlationId);
      // Students may already see a live job's text, so editing one is publishing: it needs
      // a verified employer, and it refuses a demand for payment outright (§5.8).
      const live = isLiveOpportunityState(state);
      if (live) this.assertAllowed(opportunity, 'jobs.publish', context.correlationId);
      if (opportunity.current_version_id !== expectedCurrentVersionId) {
        throw new ConflictException(safeHiringError('OPPORTUNITY_VERSION_CONFLICT', context.correlationId));
      }
      if (live && demandsPayment(input)) throw badRequest('OPPORTUNITY_PAYMENT_DEMAND', context.correlationId);

      const previous = await tx.execute(sql`SELECT ${versionColumns} FROM opportunity_versions v WHERE v.id = ${expectedCurrentVersionId}::uuid AND v.opportunity_id = ${id}::uuid`) as QueryResult<VersionRow>;
      const previousVersion = previous.rows[0];
      if (!previousVersion) throw forbidden(context.correlationId);
      const versionId = this.ids.uuid();
      const versionNumber = Number(previousVersion.version_number) + 1;
      await insertOpportunityVersion(tx, { opportunityId: id, versionId, versionNumber, input, actorId });
      // Skills, stages and eligibility belong to a version; a new version carries them forward
      // unchanged until a screen edits them (EMP-06).
      await tx.execute(sql`
        INSERT INTO opportunity_skill_requirements (id, opportunity_version_id, skill_name, requirement_level)
        SELECT gen_random_uuid(), ${versionId}::uuid, skill_name, requirement_level FROM opportunity_skill_requirements WHERE opportunity_version_id = ${expectedCurrentVersionId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO opportunity_selection_stages (id, opportunity_version_id, stage_order, stage_kind, label, detail)
        SELECT gen_random_uuid(), ${versionId}::uuid, stage_order, stage_kind, label, detail FROM opportunity_selection_stages WHERE opportunity_version_id = ${expectedCurrentVersionId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO opportunity_eligibility_rules (id, opportunity_version_id, rule_type, comparator, value_numeric, value_text, is_blocking)
        SELECT gen_random_uuid(), ${versionId}::uuid, rule_type, comparator, value_numeric, value_text, is_blocking FROM opportunity_eligibility_rules WHERE opportunity_version_id = ${expectedCurrentVersionId}::uuid
      `);
      await tx.execute(sql`UPDATE opportunities SET current_version_id = ${versionId}::uuid, updated_at = now() WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid`);
      const next = await tx.execute(sql`SELECT ${versionColumns} FROM opportunity_versions v WHERE v.id = ${versionId}::uuid`) as QueryResult<VersionRow>;
      const nextVersion = next.rows[0]!;
      const changed = changedTerms(previousVersion, nextVersion);

      const termChanges = await this.recordApplicantTermChanges(tx, { employerId, opportunityId: id, versionId, nextVersion, actorId, correlationId: context.correlationId });
      await recordOpportunityReviewSignals(tx, (effect) => effect(tx), this.ids, { opportunityId: id, employerId, actorId, correlationId: context.correlationId });

      const change = changed.length ? 'MATERIAL' : 'EDITORIAL';
      await writeAudit(tx, this.ids, {
        actorId, action: 'opportunity.version_created', resourceType: 'opportunity', resourceId: id, employerId, correlationId: context.correlationId,
        context: { versionId, versionNumber, change, changedTerms: changed, applicantsAffected: termChanges.recorded, acknowledgementsRequired: termChanges.required },
      });
      await writeOutbox(tx, this.ids, { aggregateType: 'opportunity', aggregateId: id, eventType: 'opportunity.version.created',
        payload: { opportunityId: id, employerId, versionId, change }, actorId, employerId, correlationId: context.correlationId });
      if (state === 'PUBLISHED' || state === 'PAUSED') {
        await writeOpportunityDeadlineCloseRequested(tx, { eventId: this.ids.uuid(), opportunityId: id, versionId, actorUserId: actorId, employerId, correlationId: context.correlationId });
      }
      return {
        opportunity: { id, lifecycleState: state, currentVersionId: versionId },
        version: { id: versionId, versionNumber, change, changedTerms: changed },
        applicants: { termChangesRecorded: termChanges.recorded, acknowledgementsRequired: termChanges.required },
        correlationId: context.correlationId,
      };
    });
  }

  /**
   * One row per open applicant whose terms moved, compared against the terms they last
   * accepted: the version they applied to, or the newest change they acknowledged. An
   * applicant already bound to identical terms gets nothing, even when the job's previous
   * version differed.
   */
  private async recordApplicantTermChanges(tx: Executor, input: {
    readonly employerId: string; readonly opportunityId: string; readonly versionId: string; readonly nextVersion: VersionRow; readonly actorId: string; readonly correlationId: string;
  }): Promise<{ readonly recorded: number; readonly required: number }> {
    const applicants = await tx.execute(sql`
      SELECT a.id, coalesce((
        SELECT t.to_version_id FROM opportunity_term_change_acknowledgements t JOIN opportunity_versions tv ON tv.id = t.to_version_id
        WHERE t.application_id = a.id AND t.acknowledged_at IS NOT NULL ORDER BY tv.version_number DESC LIMIT 1
      ), a.applied_version_id) AS accepted_version_id
      FROM applications a
      WHERE a.opportunity_id = ${input.opportunityId}::uuid AND a.employer_id = ${input.employerId}::uuid
        AND a.state <> 'DRAFT' AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL
      ORDER BY a.id
      FOR UPDATE OF a
    `) as QueryResult<{ id: string; accepted_version_id: string }>;
    const byAccepted = new Map<string, string[]>();
    for (const row of applicants.rows) byAccepted.set(row.accepted_version_id, [...(byAccepted.get(row.accepted_version_id) ?? []), row.id]);

    let recorded = 0;
    let required = 0;
    for (const [acceptedVersionId, applicationIds] of byAccepted) {
      const accepted = await tx.execute(sql`SELECT ${versionColumns} FROM opportunity_versions v WHERE v.id = ${acceptedVersionId}::uuid`) as QueryResult<VersionRow>;
      const acceptedVersion = accepted.rows[0];
      if (!acceptedVersion) continue;
      const classification = classifyTermChange(changedTerms(acceptedVersion, input.nextVersion));
      if (!classification.material) continue;
      const acknowledgement = classification.acknowledgementRequired ? 'REQUIRED' : 'NOT_REQUIRED';
      // Validate one representative payload; the rows below differ only in their ids.
      validateOutboxWriteInput({ id: this.ids.uuid(), aggregateType: 'application', aggregateId: applicationIds[0]!, eventType: 'application.terms_change.recorded',
        eventVersion: 1, payload: { applicationId: applicationIds[0]!, opportunityId: input.opportunityId, toVersionId: input.versionId, acknowledgement },
        actorUserId: input.actorId, organizationId: input.employerId, correlationId: input.correlationId });
      const idList = sql.join(applicationIds.map((applicationId) => sql`${applicationId}::uuid`), sql`, `);
      const inserted = await tx.execute(sql`
        INSERT INTO opportunity_term_change_acknowledgements (id, application_id, from_version_id, to_version_id, acknowledgement_required)
        SELECT gen_random_uuid(), a.id, ${acceptedVersionId}::uuid, ${input.versionId}::uuid, ${classification.acknowledgementRequired}
        FROM applications a WHERE a.id IN (${idList})
        ON CONFLICT (application_id, from_version_id, to_version_id) DO NOTHING
        RETURNING application_id
      `) as QueryResult<{ application_id: string }>;
      if (!inserted.rows.length) continue;
      const insertedIds = sql.join(inserted.rows.map((row) => sql`${row.application_id}::uuid`), sql`, `);
      await tx.execute(sql`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
        SELECT gen_random_uuid(), 'application', a.id::text, 'application.terms_change.recorded', 1,
          jsonb_build_object('applicationId', a.id, 'opportunityId', ${input.opportunityId}::text, 'toVersionId', ${input.versionId}::text, 'acknowledgement', ${acknowledgement}::text),
          ${input.actorId}::uuid, ${input.employerId}::uuid, ${input.correlationId}
        FROM applications a WHERE a.id IN (${insertedIds})
      `);
      recorded += inserted.rows.length;
      if (classification.acknowledgementRequired) required += inserted.rows.length;
    }
    return { recorded, required };
  }

  // -------------------------------------------------------------------------
  // Pause, close, reopen, withdraw
  // -------------------------------------------------------------------------

  @Post('/employers/:employerId/opportunities/:opportunityId/pause')
  @UseGuards(ProtectedApiAuthenticationGuard)
  pause(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.changeLifecycle(request, employerId, opportunityId, body, 'PAUSE');
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/close')
  @UseGuards(ProtectedApiAuthenticationGuard)
  close(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.changeLifecycle(request, employerId, opportunityId, body, 'CLOSE');
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/reopen')
  @UseGuards(ProtectedApiAuthenticationGuard)
  reopen(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.changeLifecycle(request, employerId, opportunityId, body, 'REOPEN');
  }

  @Post('/employers/:employerId/opportunities/:opportunityId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  withdraw(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('opportunityId') opportunityId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.changeLifecycle(request, employerId, opportunityId, body, 'WITHDRAW');
  }

  private async changeLifecycle(request: ProtectedHttpRequest, employerId: string, opportunityId: string, body: unknown, action: OpportunityLifecycleAction): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, employerManageRoles);
    const id = requireUuid(opportunityId, context.correlationId);
    const reasonCode = readLifecycleReason(body, action, context.correlationId);
    const group = lifecycleActionGroup[action];
    await assertEmployerState(this.db, employerId, group, context.correlationId);
    const actorId = context.authorization.principal.userId;

    return this.db.transaction(async (tx) => {
      const opportunity = await this.lockForWrite(tx, employerId, id, group, context.correlationId);
      const from = String(opportunity.lifecycle_state);
      let to: string;
      try {
        to = opportunityLifecycleTarget(from, action);
      } catch (error) {
        throw ruleFailure(error, context.correlationId);
      }
      // Withdrawing a live job must not strand anyone in the middle of a process: every open
      // applicant is decided by a person first (§5.4 — nothing rejects automatically).
      if (action === 'WITHDRAW') {
        const open = await tx.execute(sql`SELECT count(*)::int AS count FROM applications WHERE opportunity_id = ${id}::uuid AND state <> 'DRAFT' AND closed_at IS NULL`) as QueryResult<{ count: number }>;
        if ((open.rows[0]?.count ?? 0) > 0) throw badRequest('OPPORTUNITY_HAS_OPEN_APPLICATIONS', context.correlationId);
      }
      // Reopening puts the job back in front of students: it needs an audience and a
      // deadline still ahead (move the deadline with a new version first).
      if (action === 'REOPEN') {
        const checks = await tx.execute(sql`
          SELECT EXISTS (SELECT 1 FROM opportunity_audiences WHERE opportunity_id = ${id}::uuid) AS has_audience,
                 EXISTS (SELECT 1 FROM opportunity_versions v WHERE v.id = ${String(opportunity.current_version_id)}::uuid AND v.application_deadline <= now()) AS deadline_passed
        `) as QueryResult<{ has_audience: boolean; deadline_passed: boolean }>;
        if (!checks.rows[0]?.has_audience) throw badRequest('AUDIENCE_REQUIRED', context.correlationId);
        if (checks.rows[0]?.deadline_passed) throw badRequest('OPPORTUNITY_DEADLINE_PASSED', context.correlationId);
      }
      const closedAt = action === 'CLOSE' ? sql`greatest(now(), coalesce(published_at, now()))`
        : action === 'WITHDRAW' ? sql`coalesce(closed_at, greatest(now(), coalesce(published_at, now())))`
          : action === 'REOPEN' ? sql`NULL` : sql`closed_at`;
      await tx.execute(sql`
        UPDATE opportunities SET lifecycle_state = ${to}, closed_at = ${closedAt}, updated_at = now()
        WHERE id = ${id}::uuid AND employer_id = ${employerId}::uuid
      `);
      await writeAudit(tx, this.ids, {
        actorId, action: lifecycleAuditAction[action], resourceType: 'opportunity', resourceId: id, employerId, correlationId: context.correlationId,
        context: { fromState: from, toState: to, trigger: 'EMPLOYER', ...(reasonCode ? { reasonCode } : {}) },
      });
      await writeOutbox(tx, this.ids, { aggregateType: 'opportunity', aggregateId: id, eventType: 'opportunity.lifecycle.changed',
        payload: { opportunityId: id, employerId, fromState: from, toState: to, trigger: 'EMPLOYER', ...(reasonCode ? { reasonCode } : {}) },
        actorId, employerId, correlationId: context.correlationId });
      if (action === 'REOPEN') {
        await writeOpportunityDeadlineCloseRequested(tx, { eventId: this.ids.uuid(), opportunityId: id, versionId: String(opportunity.current_version_id), actorUserId: actorId, employerId, correlationId: context.correlationId });
      }
      return { opportunity: { id, lifecycleState: to, ...(reasonCode ? { reasonCode } : {}) }, correlationId: context.correlationId };
    });
  }

  /**
   * The §5.1 state rule again, now holding the organisation row FOR SHARE (a suspension
   * waits for this transaction, or this one waits for it and is refused), then the job FOR
   * UPDATE (an apply, another edit or the deadline job waits for it).
   */
  private async lockForWrite(tx: Executor, employerId: string, opportunityId: string, action: EmployerAction, correlationId: string): Promise<Record<string, unknown>> {
    const organisation = await tx.execute(sql`
      SELECT verification_state, active FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER' FOR SHARE
    `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
    const [org] = organisation.rows;
    if (!org) throw forbidden(correlationId);
    const locked = await tx.execute(sql`
      SELECT id, lifecycle_state, current_version_id FROM opportunities
      WHERE id = ${opportunityId}::uuid AND employer_id = ${employerId}::uuid FOR UPDATE
    `) as QueryResult<Record<string, unknown>>;
    const [opportunity] = locked.rows;
    if (!opportunity) throw forbidden(correlationId);
    const withState = { ...opportunity, verification_state: org.verification_state, active: org.active };
    this.assertAllowed(withState, action, correlationId);
    return withState;
  }

  private assertAllowed(locked: Record<string, unknown>, action: EmployerAction, correlationId: string): void {
    const refusal = employerStateRefusal({ verificationState: locked.verification_state as EmployerVerificationState, active: locked.active === true }, action);
    if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });
  }
}

/**
 * The applicant's side of a term change: see what moved since they applied, accept it, or
 * decline it (which withdraws the application, exactly as the withdraw route does).
 */
@Controller('/api/v1')
export class StudentTermsChangeController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/students/me/applications/:applicationId/terms-change')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async read(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(applicationId, context.correlationId);
    const studentUserId = context.authorization.principal.userId;
    const owned = await this.db.execute(sql`
      SELECT a.id, org.legal_name AS employer_name FROM applications a JOIN organizations org ON org.id = a.employer_id
      WHERE a.id = ${id}::uuid AND a.student_user_id = ${studentUserId}::uuid
    `) as QueryResult<{ id: string; employer_name: string }>;
    if (!owned.rows[0]) throw forbidden(context.correlationId);
    const pending = await readPendingTermsChange(this.db, id);
    if (!pending) return { termsChange: null, correlationId: context.correlationId };
    const [from, to] = await Promise.all([readVersion(this.db, pending.acceptedVersionId), readVersion(this.db, pending.toVersionId)]);
    if (!from || !to) return { termsChange: null, correlationId: context.correlationId };
    return {
      termsChange: {
        toVersionId: pending.toVersionId,
        employerName: owned.rows[0].employer_name,
        changedTerms: changedTerms(from, to),
        appliedTerms: studentTerms(from),
        newTerms: studentTerms(to),
      },
      correlationId: context.correlationId,
    };
  }

  @Post('/students/me/applications/:applicationId/terms-change/acknowledge')
  @UseGuards(ProtectedApiAuthenticationGuard)
  acknowledge(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.respond(request, applicationId, body, 'ACKNOWLEDGE');
  }

  @Post('/students/me/applications/:applicationId/terms-change/decline')
  @UseGuards(ProtectedApiAuthenticationGuard)
  decline(@Req() request: ProtectedHttpRequest, @Param('applicationId') applicationId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.respond(request, applicationId, body, 'DECLINE');
  }

  private async respond(request: ProtectedHttpRequest, applicationId: string, body: unknown, decision: 'ACKNOWLEDGE' | 'DECLINE'): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const id = requireUuid(applicationId, context.correlationId);
    rejectUnknownFields(body, ['toVersionId'], context.correlationId);
    const toVersionId = readRequiredUuid(body, 'toVersionId', context.correlationId);
    const studentUserId = context.authorization.principal.userId;

    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, state, employer_id, opportunity_id FROM applications
        WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
          AND state <> 'DRAFT' AND closed_at IS NULL AND consent_revoked_at IS NULL
        FOR UPDATE
      `) as QueryResult<{ id: string; state: ApplicationState; employer_id: string; opportunity_id: string }>;
      const [application] = locked.rows;
      if (!application) throw forbidden(context.correlationId);
      const pending = await readPendingTermsChange(tx, id);
      if (!pending) throw badRequest('NO_TERMS_CHANGE_PENDING', context.correlationId);
      // The employer may have changed the job again while the student was reading.
      if (pending.toVersionId !== toVersionId) throw new ConflictException(safeHiringError('TERMS_CHANGED_AGAIN', context.correlationId));

      const outcome = decision === 'ACKNOWLEDGE' ? sql`acknowledged_at = now()` : sql`declined_at = now()`;
      await tx.execute(sql`
        UPDATE opportunity_term_change_acknowledgements SET ${outcome}
        WHERE application_id = ${id}::uuid AND acknowledged_at IS NULL AND declined_at IS NULL
          AND to_version_id IN (SELECT v.id FROM opportunity_versions v WHERE v.opportunity_id = ${application.opportunity_id}::uuid
            AND v.version_number <= (SELECT version_number FROM opportunity_versions WHERE id = ${toVersionId}::uuid))
      `);
      const eventType = decision === 'ACKNOWLEDGE' ? 'application.terms_change.acknowledged' : 'application.terms_change.declined';
      await writeAudit(tx, this.ids, { actorId: studentUserId, action: eventType, resourceType: 'application', resourceId: id,
        employerId: null, correlationId: context.correlationId, context: { toVersionId } });
      await writeOutbox(tx, this.ids, { aggregateType: 'application', aggregateId: id, eventType, payload: { applicationId: id, toVersionId },
        actorId: studentUserId, employerId: application.employer_id, correlationId: context.correlationId });

      if (decision === 'DECLINE') {
        try {
          assertApplicationTransition({ from: application.state, to: 'WITHDRAWN', actor: 'STUDENT' });
        } catch (error) {
          throw ruleFailure(error, context.correlationId);
        }
        // Declining the new terms leaves the process, with the same effects as withdrawing.
        await tx.execute(sql`
          UPDATE applications SET state = 'WITHDRAWN', closed_at = now(), consent_revoked_at = now(), updated_at = now()
          WHERE id = ${id}::uuid AND student_user_id = ${studentUserId}::uuid
        `);
        await tx.execute(sql`
          INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role, reason_code)
          VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${application.state}, 'WITHDRAWN', ${studentUserId}::uuid, 'STUDENT', 'TERMS_DECLINED')
        `);
        await tx.execute(sql`
          UPDATE employer_applicant_access_grants SET revoked_at = now()
          WHERE employer_id = ${application.employer_id}::uuid AND student_user_id = ${studentUserId}::uuid
            AND opportunity_id = ${application.opportunity_id}::uuid AND revoked_at IS NULL
        `);
        await writeAudit(tx, this.ids, { actorId: studentUserId, action: 'application.withdrawn', resourceType: 'application', resourceId: id,
          employerId: null, correlationId: context.correlationId, context: { reasonCode: 'TERMS_DECLINED' } });
      }
      return {
        application: { id, state: decision === 'DECLINE' ? 'WITHDRAWN' : application.state, termsAcknowledgementPending: false },
        correlationId: context.correlationId,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The newest change the applicant still has to accept, and the terms they last accepted.
 * Only changes that require acknowledgement count; a deadline-only change never blocks.
 */
async function readPendingTermsChange(db: Executor, applicationId: string): Promise<{ readonly toVersionId: string; readonly acceptedVersionId: string } | null> {
  const rows = await db.execute(sql`
    SELECT t.to_version_id,
      coalesce((SELECT ta.to_version_id FROM opportunity_term_change_acknowledgements ta JOIN opportunity_versions tav ON tav.id = ta.to_version_id
        WHERE ta.application_id = a.id AND ta.acknowledged_at IS NOT NULL ORDER BY tav.version_number DESC LIMIT 1), a.applied_version_id) AS accepted_version_id
    FROM opportunity_term_change_acknowledgements t
    JOIN opportunity_versions tv ON tv.id = t.to_version_id
    JOIN applications a ON a.id = t.application_id
    WHERE t.application_id = ${applicationId}::uuid AND t.acknowledgement_required AND t.acknowledged_at IS NULL AND t.declined_at IS NULL
    ORDER BY tv.version_number DESC LIMIT 1
  `) as QueryResult<{ to_version_id: string; accepted_version_id: string }>;
  const [row] = rows.rows;
  return row ? { toVersionId: row.to_version_id, acceptedVersionId: row.accepted_version_id } : null;
}

async function readVersion(db: Executor, versionId: string): Promise<VersionRow | undefined> {
  const rows = await db.execute(sql`
    SELECT ${versionColumns},
      coalesce((SELECT json_agg(json_build_object('ruleType', r.rule_type, 'comparator', r.comparator, 'valueNumeric', r.value_numeric,
        'valueText', r.value_text, 'isBlocking', r.is_blocking) ORDER BY r.rule_type) FROM opportunity_eligibility_rules r WHERE r.opportunity_version_id = v.id), '[]'::json) AS eligibility
    FROM opportunity_versions v WHERE v.id = ${versionId}::uuid
  `) as QueryResult<VersionRow>;
  return rows.rows[0];
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function textOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

/** A stored version's material terms, in the same shape the hash was computed from. */
function materialTermsFromRow(row: Record<string, unknown>): MaterialTerms {
  return {
    employmentType: String(row.employment_type),
    workMode: String(row.work_mode),
    locationCity: textOrNull(row.location_city),
    compensationDisclosed: row.compensation_disclosed === true,
    compensationCurrency: textOrNull(row.compensation_currency),
    compensationMin: textOrNull(row.compensation_min),
    compensationMax: textOrNull(row.compensation_max),
    compensationPeriod: textOrNull(row.compensation_period),
    durationMonths: row.duration_months == null ? null : Number(row.duration_months),
    applicationDeadline: isoOrNull(row.application_deadline),
    joiningConditions: textOrNull(row.joining_conditions),
  };
}

/** The material fields that differ between two versions, eligibility included. */
function changedTerms(from: VersionRow, to: VersionRow): readonly string[] {
  const changed = [...changedMaterialTerms(materialTermsFromRow(from), materialTermsFromRow(to))];
  if (String(from.eligibility_signature ?? '') !== String(to.eligibility_signature ?? '')) changed.push(ELIGIBILITY_TERM);
  return changed;
}

function mapVersion(row: VersionRow): Record<string, unknown> {
  return {
    id: row.id,
    versionNumber: Number(row.version_number),
    title: row.title,
    summary: row.summary ?? null,
    responsibilities: row.responsibilities ?? null,
    employmentType: row.employment_type,
    workMode: row.work_mode,
    locationCity: row.location_city ?? null,
    positionsAvailable: row.positions_available ?? null,
    durationMonths: row.duration_months ?? null,
    compensationDisclosed: row.compensation_disclosed === true,
    compensationCurrency: row.compensation_currency ?? null,
    compensationMin: row.compensation_min ?? null,
    compensationMax: row.compensation_max ?? null,
    compensationPeriod: row.compensation_period ?? null,
    joiningConditions: row.joining_conditions ?? null,
    applicationDeadline: row.application_deadline ?? null,
    createdAt: row.created_at,
  };
}

/** What a student sees of a version's terms: the material fields and the eligibility rules. */
function studentTerms(row: VersionRow): Record<string, unknown> {
  return {
    title: row.title,
    employmentType: row.employment_type,
    workMode: row.work_mode,
    locationCity: row.location_city ?? null,
    durationMonths: row.duration_months ?? null,
    compensation: row.compensation_disclosed === true
      ? { currency: row.compensation_currency, min: row.compensation_min, max: row.compensation_max ?? null, period: row.compensation_period }
      : null,
    joiningConditions: row.joining_conditions ?? null,
    applicationDeadline: row.application_deadline ?? null,
    eligibility: Array.isArray(row.eligibility) ? row.eligibility : [],
  };
}

function demandsPayment(input: OpportunityVersionInput): boolean {
  const text = [input.title, input.summary, input.responsibilities, input.joiningConditions].filter(Boolean).join('\n');
  // Only the payment detector matters here; the other signals are review evidence, not refusals.
  return detectOpportunitySignals({ text, crossEmployerDuplicate: false, currency: 'INR', period: 'YEAR', min: '1', max: '1' }).includes('APPLICANT_PAYMENT_DEMAND');
}

function rejectUnknownFields(body: unknown, allowed: readonly string[], correlationId: string): void {
  if (body == null) return;
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest('UNKNOWN_FIELD', correlationId);
  }
}

function readLifecycleReason(body: unknown, action: OpportunityLifecycleAction, correlationId: string): string | null {
  const allowed = opportunityLifecycleReasonCodes[action] as readonly string[];
  rejectUnknownFields(body, allowed.length ? ['reasonCode'] : [], correlationId);
  const value = body == null ? undefined : (body as Record<string, unknown>).reasonCode;
  if (value === undefined || value === null || value === '') {
    if (lifecycleReasonRequired(action)) throw badRequest('REASON_CODE_REQUIRED', correlationId);
    return null;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('INVALID_REASONCODE', correlationId);
  return value;
}

function readRequiredUuid(body: unknown, field: string, correlationId: string): string {
  const value = body == null ? undefined : (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest(`INVALID_${field.toUpperCase()}`, correlationId);
  return value;
}

async function writeAudit(tx: Executor, ids: ApiIdGenerator, input: {
  readonly actorId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly employerId: string | null; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${ids.uuid()}::uuid, ${input.actorId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${input.employerId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

/** Registered events only: the payload is validated against packages/events before it is written. */
async function writeOutbox(tx: Executor, ids: ApiIdGenerator, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorId: string; readonly employerId: string; readonly correlationId: string;
}): Promise<void> {
  const id = ids.uuid();
  validateOutboxWriteInput({ id, aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, eventVersion: 1,
    payload: input.payload, actorUserId: input.actorId, organizationId: input.employerId, correlationId: input.correlationId });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
      ${input.actorId}::uuid, ${input.employerId}::uuid, ${input.correlationId})
  `);
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
