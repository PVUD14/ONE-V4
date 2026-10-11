/**
 * Attribution: who is credited for a college or an employer, the disputes about it, reassignment,
 * leavers and the self-dealing guard (GROWTH-07; design §8).
 *
 * Why one module: the college link (GROWTH-04), the employer onboarding (GROWTH-05), the growth
 * person's Commission page, the growth admin's section and the verification route all read or write
 * the same rows and must agree on them. Every write here runs inside the caller's transaction with
 * its audit row and outbox event. A change of credit is always an end plus a new row.
 *
 * Nothing here computes, stores or returns an amount (rates are GROWTH-09, the ledger GROWTH-11),
 * and nothing returns a student.
 *
 * Design: docs/architecture/growth-attribution-table-design.md
 */
import { sql } from 'drizzle-orm';
import {
  growthAttributionFromCandidate,
  growthDisputeDecisionEffect,
  growthDisputeRoleFor,
  growthDisputeWindowEnds,
  growthLeaverSettlementEnds,
  growthSelfDealing,
  growthTeamForOrganizationKind,
  refuseGrowthAttributionChange,
  refuseGrowthDisputeDecision,
  type GrowthDisputeDecisionReason,
  type GrowthDisputeOutcome,
  type GrowthEmployerCandidateBasis,
  type GrowthOrganizationKind,
} from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { conflict, forbidden, iso, notFound, writeGrowthAudit, writeGrowthOutbox, type QueryResult } from './growth-http.js';
import type { WriteContext } from './growth-leads-service.js';

type Runner = Pick<PersistenceDb, 'execute'>;

export const SELF_DEALING_CODE = 'GROWTH_SELF_DEALING_REFUSED';

async function audit(tx: Runner, ctx: WriteContext, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action, resourceType, resourceId, organizationId: ctx.organizationId, correlationId: ctx.correlationId, context });
}

async function outbox(tx: Runner, ctx: WriteContext, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType, aggregateId, eventType, payload, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
}

// ---------------------------------------------------------------------------
// The self-dealing guard (design §8.6)
// ---------------------------------------------------------------------------

/** The live beneficiary and both parties of the open dispute of an organisation. */
export async function organizationParties(runner: Runner, organizationId: string): Promise<readonly string[]> {
  const found = await runner.execute(sql`SELECT growth_organization_parties(${organizationId}::uuid) AS user_id`) as QueryResult<{ user_id: string }>;
  return found.rows.map((row) => row.user_id);
}

/** Refuses an operator who is a party to the organisation's credit (verification and the like). */
export async function refuseSelfDealing(runner: Runner, actorUserId: string, organizationId: string, correlationId: string): Promise<void> {
  if (growthSelfDealing(actorUserId, await organizationParties(runner, organizationId))) throw forbidden(SELF_DEALING_CODE, correlationId);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface NewAttribution {
  readonly organizationId: string; readonly organizationKind: GrowthOrganizationKind; readonly beneficiaryUserId: string;
  readonly basis: 'LEAD_OWNER_AT_HANDOFF' | 'REFERRAL_LINK' | 'DISPUTE_DECISION' | 'MANUAL_CORRECTION';
  readonly reasonCode: string; readonly leadId: string | null; readonly sourceHandoffRequestId?: string | null;
  readonly sourceAccessRequestId?: string | null; readonly disputeId?: string | null; readonly supersedesId?: string | null;
  /** A SQL expression for a dispute decision's date (design §8.4), so the original instant is kept exactly; otherwise now(). */
  readonly effectiveFrom?: ReturnType<typeof sql> | null;
}

async function insertAttribution(tx: Runner, ctx: WriteContext, input: NewAttribution): Promise<string> {
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_attributions (id, organization_id, organization_kind, beneficiary_user_id, basis, reason_code, lead_id,
      source_handoff_request_id, source_access_request_id, dispute_id, supersedes_id, effective_from, created_by_user_id, correlation_id)
    VALUES (${id}::uuid, ${input.organizationId}::uuid, ${input.organizationKind}, ${input.beneficiaryUserId}::uuid, ${input.basis}, ${input.reasonCode},
            ${input.leadId}::uuid, ${input.sourceHandoffRequestId ?? null}::uuid, ${input.sourceAccessRequestId ?? null}::uuid,
            ${input.disputeId ?? null}::uuid, ${input.supersedesId ?? null}::uuid,
            ${input.effectiveFrom ?? sql`now()`},
            ${ctx.actorUserId}::uuid, ${ctx.correlationId})
  `);
  await audit(tx, ctx, 'growth.attribution.created', 'growth_attribution', id, {
    organizationId: input.organizationId, organizationKind: input.organizationKind, basis: input.basis, reasonCode: input.reasonCode,
    beneficiaryUserId: input.beneficiaryUserId, supersedesId: input.supersedesId ?? null, disputeId: input.disputeId ?? null,
  });
  await outbox(tx, ctx, 'growth.attribution.created', 'growth_attribution', id, { attributionId: id, organizationId: input.organizationId, basis: input.basis });
  return id;
}

async function endAttributionRow(tx: Runner, ctx: WriteContext, input: { readonly attributionId: string; readonly organizationId: string; readonly reasonCode: string }): Promise<void> {
  await tx.execute(sql`
    UPDATE growth_attributions SET ended_at = now(), ended_reason_code = ${input.reasonCode}, ended_by_user_id = ${ctx.actorUserId}::uuid
    WHERE id = ${input.attributionId}::uuid AND ended_at IS NULL
  `);
  await audit(tx, ctx, 'growth.attribution.ended', 'growth_attribution', input.attributionId, { organizationId: input.organizationId, reasonCode: input.reasonCode });
  await outbox(tx, ctx, 'growth.attribution.ended', 'growth_attribution', input.attributionId, { attributionId: input.attributionId, organizationId: input.organizationId, reasonCode: input.reasonCode });
}

/** Attribution is written only at an organisation's first handoff: never where any history exists. */
async function hasAttributionHistory(tx: Runner, organizationId: string): Promise<boolean> {
  const found = await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM growth_attributions WHERE organization_id = ${organizationId}::uuid)
        OR EXISTS (SELECT 1 FROM growth_attribution_disputes WHERE organization_id = ${organizationId}::uuid) AS taken
  `) as QueryResult<{ taken: boolean }>;
  return Boolean(found.rows[0]?.taken);
}

/** GROWTH-04's link (design §8.2): the lead's owner at the link, LEAD_OWNER_AT_HANDOFF; none for house. */
export async function attributeCollegeHandoff(tx: Runner, ctx: WriteContext, input: {
  readonly requestId: string; readonly leadId: string; readonly organizationId: string; readonly ownerUserId: string | null;
}): Promise<string | null> {
  if (!input.ownerUserId || await hasAttributionHistory(tx, input.organizationId)) return null;
  return insertAttribution(tx, ctx, {
    organizationId: input.organizationId, organizationKind: 'INSTITUTION', beneficiaryUserId: input.ownerUserId,
    basis: 'LEAD_OWNER_AT_HANDOFF', reasonCode: 'COLLEGE_HANDOFF_LINKED', leadId: input.leadId, sourceHandoffRequestId: input.requestId,
  });
}

/**
 * GROWTH-05's onboarding (design §8.3), at the employer's first onboarding only: the referrer or the
 * lead owner is credited; a conflict writes no attribution and opens a dispute; house writes nothing.
 */
export async function attributeEmployerOnboarding(tx: Runner, ctx: WriteContext, input: {
  readonly requestId: string; readonly organizationId: string; readonly leadId: string | null; readonly candidate: GrowthEmployerCandidateBasis;
  readonly referrerUserId: string | null; readonly leadOwnerUserId: string | null;
}): Promise<{ readonly attributionId: string | null; readonly disputeId: string | null; readonly firstHandoff: boolean }> {
  const earlier = await tx.execute(sql`
    SELECT 1 FROM growth_employer_onboardings WHERE organization_id = ${input.organizationId}::uuid AND access_request_id <> ${input.requestId}::uuid LIMIT 1
  `) as QueryResult<unknown>;
  if (earlier.rows.length || await hasAttributionHistory(tx, input.organizationId)) return { attributionId: null, disputeId: null, firstHandoff: false };
  const decided = growthAttributionFromCandidate(input.candidate, input);
  if (decided.kind === 'ATTRIBUTE') {
    const attributionId = await insertAttribution(tx, ctx, {
      organizationId: input.organizationId, organizationKind: 'EMPLOYER', beneficiaryUserId: decided.beneficiaryUserId,
      basis: decided.basis, reasonCode: 'EMPLOYER_ONBOARDED', leadId: input.leadId, sourceAccessRequestId: input.requestId,
    });
    return { attributionId, disputeId: null, firstHandoff: true };
  }
  if (decided.kind === 'DISPUTE') {
    const disputeId = ctx.uuid();
    await tx.execute(sql`
      INSERT INTO growth_attribution_disputes (id, organization_id, organization_kind, origin, claimant_user_id, respondent_user_id,
        source_access_request_id, opened_by_user_id, correlation_id)
      VALUES (${disputeId}::uuid, ${input.organizationId}::uuid, 'EMPLOYER', 'ONBOARDING_CONFLICT', ${decided.claimantUserId}::uuid,
              ${decided.respondentUserId}::uuid, ${input.requestId}::uuid, ${ctx.actorUserId}::uuid, ${ctx.correlationId})
    `);
    await audit(tx, ctx, 'growth.attribution_dispute.opened', 'growth_attribution_dispute', disputeId, {
      organizationId: input.organizationId, origin: 'ONBOARDING_CONFLICT', claimantUserId: decided.claimantUserId, respondentUserId: decided.respondentUserId,
    });
    await outbox(tx, ctx, 'growth.attribution_dispute.opened', 'growth_attribution_dispute', disputeId, { disputeId, organizationId: input.organizationId, origin: 'ONBOARDING_CONFLICT' });
    return { attributionId: null, disputeId, firstHandoff: true };
  }
  return { attributionId: null, disputeId: null, firstHandoff: true };
}

// ---------------------------------------------------------------------------
// A growth person: their credit, their disputes, and what they may dispute
// ---------------------------------------------------------------------------

const growthRoles = sql`('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')`;

type DisputableRow = { id: string; legal_name: string; kind: GrowthOrganizationKind; handed_off_at: Date; dispute_open: boolean; credited_to_me: boolean };

/** Organisations handed off in the last 90 days that the person worked on (design §8.4), on the database clock. */
async function disputableOrganizations(runner: Runner, userId: string, organizationId: string | null): Promise<readonly DisputableRow[]> {
  const found = await runner.execute(sql`
    WITH recent AS (
      SELECT organization_id AS id FROM growth_handoff_requests WHERE state = 'LINKED' AND decided_at > now() - interval '90 days'
      UNION SELECT organization_id FROM growth_employer_onboardings WHERE recorded_at > now() - interval '90 days'
    )
    SELECT o.id, o.legal_name, o.kind::text AS kind, growth_organization_handed_off_at(o.id) AS handed_off_at,
           EXISTS (SELECT 1 FROM growth_attribution_disputes d WHERE d.organization_id = o.id AND d.state = 'OPEN') AS dispute_open,
           EXISTS (SELECT 1 FROM growth_attributions a WHERE a.organization_id = o.id AND a.ended_at IS NULL AND a.beneficiary_user_id = ${userId}::uuid) AS credited_to_me
    FROM recent JOIN organizations o ON o.id = recent.id
    WHERE (${organizationId}::uuid IS NULL OR o.id = ${organizationId}::uuid)
      AND growth_organization_handed_off_at(o.id) > now() - interval '90 days'
      AND growth_user_worked_on(${userId}::uuid, o.id)
    ORDER BY handed_off_at DESC, o.id LIMIT 100
  `) as QueryResult<DisputableRow>;
  return found.rows;
}

export async function growthAttributionsFor(runner: Runner, userId: string): Promise<Record<string, unknown>> {
  const credited = await runner.execute(sql`
    SELECT a.id, a.organization_id, a.organization_kind, o.legal_name, a.basis, a.effective_from, a.ended_at, a.ended_reason_code,
           EXISTS (SELECT 1 FROM growth_attribution_disputes d WHERE d.organization_id = a.organization_id AND d.state = 'OPEN') AS dispute_open
    FROM growth_attributions a JOIN organizations o ON o.id = a.organization_id
    WHERE a.beneficiary_user_id = ${userId}::uuid
    ORDER BY (a.ended_at IS NOT NULL), a.effective_from DESC, a.id LIMIT 200
  `) as QueryResult<{ id: string; organization_id: string; organization_kind: GrowthOrganizationKind; legal_name: string; basis: string; effective_from: Date; ended_at: Date | null; ended_reason_code: string | null; dispute_open: boolean }>;
  const disputes = await runner.execute(sql`
    SELECT d.id, d.organization_id, d.organization_kind, o.legal_name, d.origin, d.state, d.opened_at, d.decided_at, d.decision_reason_code,
           d.claimant_user_id, d.respondent_user_id, d.statement
    FROM growth_attribution_disputes d JOIN organizations o ON o.id = d.organization_id
    WHERE d.claimant_user_id = ${userId}::uuid OR d.respondent_user_id = ${userId}::uuid
    ORDER BY d.opened_at DESC, d.id LIMIT 100
  `) as QueryResult<{ id: string; organization_id: string; organization_kind: string; legal_name: string; origin: string; state: string; opened_at: Date; decided_at: Date | null; decision_reason_code: string | null; claimant_user_id: string; respondent_user_id: string | null; statement: string | null }>;
  const disputable = await disputableOrganizations(runner, userId, null);
  return {
    credited: credited.rows.map((row) => ({
      attributionId: row.id, organizationId: row.organization_id, organizationName: row.legal_name, organizationKind: row.organization_kind,
      basis: row.basis, since: iso(row.effective_from), endedAt: iso(row.ended_at), endedReasonCode: row.ended_reason_code,
      disputeOpen: Boolean(row.dispute_open),
      // No amount anywhere in this goal: the ledger and rates are later goals, and employer commission is on hold (D11).
      commission: row.organization_kind === 'EMPLOYER' ? 'EMPLOYER_ON_HOLD' : 'NOT_BUILT',
    })),
    disputes: disputes.rows.map((row) => {
      const role = growthDisputeRoleFor(userId, { claimantUserId: row.claimant_user_id, respondentUserId: row.respondent_user_id });
      return {
        disputeId: row.id, organizationId: row.organization_id, organizationName: row.legal_name, organizationKind: row.organization_kind,
        origin: row.origin, state: row.state, role, openedAt: iso(row.opened_at), decidedAt: iso(row.decided_at), decisionReasonCode: row.decision_reason_code,
        // The claimant sees their own case; the respondent is told a dispute exists, never what it says.
        statement: role === 'CLAIMANT' ? row.statement : null,
      };
    }),
    disputable: disputable.filter((row) => !row.credited_to_me).map((row) => ({
      organizationId: row.id, organizationName: row.legal_name, organizationKind: row.kind, handedOffAt: iso(row.handed_off_at),
      windowEndsAt: iso(growthDisputeWindowEnds(new Date(row.handed_off_at))), disputeOpen: Boolean(row.dispute_open),
    })),
    windowDays: 90,
  };
}

/** A growth person's claim (design §8.4). Refusals never say whether an organisation exists for someone who did not work on it. */
export async function openClaim(tx: Runner, ctx: WriteContext, input: { readonly organizationId: string; readonly statement: string }): Promise<string> {
  await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${input.organizationId}::uuid FOR SHARE`);
  const [eligible] = await disputableOrganizations(tx, ctx.actorUserId, input.organizationId);
  if (!eligible) {
    const worked = await tx.execute(sql`SELECT growth_user_worked_on(${ctx.actorUserId}::uuid, ${input.organizationId}::uuid) AS worked`) as QueryResult<{ worked: boolean }>;
    if (worked.rows[0]?.worked) throw conflict('GROWTH_DISPUTE_WINDOW_CLOSED', ctx.correlationId);
    throw notFound('GROWTH_DISPUTE_NOT_ELIGIBLE', ctx.correlationId);
  }
  if (eligible.credited_to_me) throw conflict('GROWTH_ALREADY_CREDITED', ctx.correlationId);
  if (eligible.dispute_open) throw conflict('GROWTH_DISPUTE_ALREADY_OPEN', ctx.correlationId);
  const live = (await tx.execute(sql`
    SELECT id, beneficiary_user_id FROM growth_attributions WHERE organization_id = ${input.organizationId}::uuid AND ended_at IS NULL FOR UPDATE
  `) as QueryResult<{ id: string; beneficiary_user_id: string }>).rows[0];
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_attribution_disputes (id, organization_id, organization_kind, origin, attribution_id, claimant_user_id, respondent_user_id,
      statement, opened_by_user_id, correlation_id)
    VALUES (${id}::uuid, ${input.organizationId}::uuid, ${eligible.kind}, 'CLAIM', ${live?.id ?? null}::uuid, ${ctx.actorUserId}::uuid,
            ${live?.beneficiary_user_id ?? null}::uuid, ${input.statement}, ${ctx.actorUserId}::uuid, ${ctx.correlationId})
  `);
  // The statement is in the row only; the audit row says that one was made, not what it says.
  await audit(tx, ctx, 'growth.attribution_dispute.opened', 'growth_attribution_dispute', id, {
    organizationId: input.organizationId, origin: 'CLAIM', attributionId: live?.id ?? null, respondentUserId: live?.beneficiary_user_id ?? null, statementLength: input.statement.length,
  });
  await outbox(tx, ctx, 'growth.attribution_dispute.opened', 'growth_attribution_dispute', id, { disputeId: id, organizationId: input.organizationId, origin: 'CLAIM' });
  return id;
}

// ---------------------------------------------------------------------------
// Growth admin (GROWTH_ADMIN): decide, reassign, end, and the reads behind them
// ---------------------------------------------------------------------------

type DisputeRow = {
  id: string; organization_id: string; organization_kind: GrowthOrganizationKind; origin: 'CLAIM' | 'ONBOARDING_CONFLICT'; attribution_id: string | null;
  claimant_user_id: string; respondent_user_id: string | null; state: string;
}

export async function decideDispute(tx: Runner, ctx: WriteContext, input: {
  readonly disputeId: string; readonly outcome: GrowthDisputeOutcome; readonly reasonCode: GrowthDisputeDecisionReason; readonly note: string | null;
}): Promise<Record<string, unknown>> {
  const dispute = (await tx.execute(sql`
    SELECT id, organization_id, organization_kind, origin, attribution_id, claimant_user_id, respondent_user_id, state
    FROM growth_attribution_disputes WHERE id = ${input.disputeId}::uuid FOR UPDATE
  `) as QueryResult<DisputeRow>).rows[0];
  if (!dispute) throw notFound('GROWTH_DISPUTE_NOT_FOUND', ctx.correlationId);
  const refusal = refuseGrowthDisputeDecision(ctx.actorUserId, { state: dispute.state, claimantUserId: dispute.claimant_user_id, respondentUserId: dispute.respondent_user_id });
  if (refusal === SELF_DEALING_CODE) throw forbidden(refusal, ctx.correlationId);
  if (refusal) throw conflict(refusal, ctx.correlationId);

  const effect = growthDisputeDecisionEffect({ origin: dispute.origin, attributionId: dispute.attribution_id, claimantUserId: dispute.claimant_user_id, respondentUserId: dispute.respondent_user_id }, input.outcome);
  let disputed: { id: string; lead_id: string | null } | undefined;
  if (dispute.attribution_id) {
    disputed = (await tx.execute(sql`
      SELECT id, lead_id FROM growth_attributions WHERE id = ${dispute.attribution_id}::uuid FOR UPDATE
    `) as QueryResult<{ id: string; lead_id: string | null }>).rows[0];
  }
  if (effect.endsAttribution && disputed) {
    await endAttributionRow(tx, ctx, { attributionId: disputed.id, organizationId: dispute.organization_id, reasonCode: 'DISPUTE_DECISION' });
  }
  let resultingId: string | null = null;
  if (effect.creditUserId) {
    // Effective from the original date (design §8.4): the disputed row's, or the handoff's.
    const anchor = disputed
      ? sql`(SELECT effective_from FROM growth_attributions WHERE id = ${disputed.id}::uuid)`
      : sql`coalesce(growth_organization_handed_off_at(${dispute.organization_id}::uuid), now())`;
    const lead = disputed?.lead_id ?? (await tx.execute(sql`
      SELECT id FROM growth_leads WHERE organization_id = ${dispute.organization_id}::uuid ORDER BY created_at, id LIMIT 1
    `) as QueryResult<{ id: string }>).rows[0]?.id ?? null;
    resultingId = await insertAttribution(tx, ctx, {
      organizationId: dispute.organization_id, organizationKind: dispute.organization_kind, beneficiaryUserId: effect.creditUserId,
      basis: 'DISPUTE_DECISION', reasonCode: 'DISPUTE_DECIDED', leadId: lead, disputeId: dispute.id, supersedesId: effect.endsAttribution ? disputed?.id ?? null : null,
      effectiveFrom: anchor,
    });
  }
  await tx.execute(sql`
    UPDATE growth_attribution_disputes
    SET state = ${input.outcome}, decided_by_user_id = ${ctx.actorUserId}::uuid, decided_at = now(), decision_reason_code = ${input.reasonCode},
        decision_note = ${input.note}, resulting_attribution_id = ${resultingId}::uuid
    WHERE id = ${dispute.id}::uuid
  `);
  await audit(tx, ctx, 'growth.attribution_dispute.decided', 'growth_attribution_dispute', dispute.id, {
    organizationId: dispute.organization_id, outcome: input.outcome, reasonCode: input.reasonCode, endedAttributionId: effect.endsAttribution ? disputed?.id ?? null : null,
    resultingAttributionId: resultingId, creditedUserId: effect.creditUserId,
  });
  await outbox(tx, ctx, 'growth.attribution_dispute.decided', 'growth_attribution_dispute', dispute.id, {
    disputeId: dispute.id, organizationId: dispute.organization_id, outcome: input.outcome, reasonCode: input.reasonCode,
  });
  return { disputeId: dispute.id, outcome: input.outcome, resultingAttributionId: resultingId };
}

type AttributionRow = { id: string; organization_id: string; organization_kind: GrowthOrganizationKind; beneficiary_user_id: string; lead_id: string | null; ended_at: Date | null; dispute_open: boolean };

async function lockAttribution(tx: Runner, attributionId: string, correlationId: string): Promise<AttributionRow> {
  const row = (await tx.execute(sql`
    SELECT a.id, a.organization_id, a.organization_kind, a.beneficiary_user_id, a.lead_id, a.ended_at,
           EXISTS (SELECT 1 FROM growth_attribution_disputes d WHERE d.organization_id = a.organization_id AND d.state = 'OPEN') AS dispute_open
    FROM growth_attributions a WHERE a.id = ${attributionId}::uuid FOR UPDATE OF a
  `) as QueryResult<AttributionRow>).rows[0];
  if (!row) throw notFound('GROWTH_ATTRIBUTION_NOT_FOUND', correlationId);
  return row;
}

function refuse(code: ReturnType<typeof refuseGrowthAttributionChange>, correlationId: string): void {
  if (code === SELF_DEALING_CODE) throw forbidden(code, correlationId);
  if (code) throw conflict(code, correlationId);
}

/** A growth admin moves credit (design §8.5): affects only what is earned after now. */
export async function reassignAttribution(tx: Runner, ctx: WriteContext, input: {
  readonly attributionId: string; readonly toUserId: string; readonly reasonCode: string;
}): Promise<string> {
  const row = await lockAttribution(tx, input.attributionId, ctx.correlationId);
  refuse(refuseGrowthAttributionChange({
    actorUserId: ctx.actorUserId, currentBeneficiaryUserId: row.beneficiary_user_id, newBeneficiaryUserId: input.toUserId,
    ended: row.ended_at !== null, disputeOpen: Boolean(row.dispute_open),
  }), ctx.correlationId);
  const target = await tx.execute(sql`
    SELECT 1 FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = ${growthTeamForOrganizationKind(row.organization_kind)}
    WHERE m.user_id = ${input.toUserId}::uuid AND m.state = 'ACTIVE' AND m.role IN ${growthRoles} LIMIT 1
  `) as QueryResult<unknown>;
  if (!target.rows.length) throw conflict('GROWTH_ATTRIBUTION_TARGET_INVALID', ctx.correlationId);
  await endAttributionRow(tx, ctx, { attributionId: row.id, organizationId: row.organization_id, reasonCode: 'REASSIGNED' });
  const id = await insertAttribution(tx, ctx, {
    organizationId: row.organization_id, organizationKind: row.organization_kind, beneficiaryUserId: input.toUserId,
    basis: 'MANUAL_CORRECTION', reasonCode: input.reasonCode, leadId: row.lead_id, supersedesId: row.id,
  });
  await audit(tx, ctx, 'growth.attribution.reassigned', 'growth_attribution', id, {
    organizationId: row.organization_id, fromAttributionId: row.id, fromUserId: row.beneficiary_user_id, toUserId: input.toUserId, reasonCode: input.reasonCode,
  });
  return id;
}

/** A growth admin ends credit with no successor: nobody should have it, or the organisation left ONE. */
export async function endAttribution(tx: Runner, ctx: WriteContext, input: { readonly attributionId: string; readonly reasonCode: string }): Promise<void> {
  const row = await lockAttribution(tx, input.attributionId, ctx.correlationId);
  refuse(refuseGrowthAttributionChange({
    actorUserId: ctx.actorUserId, currentBeneficiaryUserId: row.beneficiary_user_id, newBeneficiaryUserId: null,
    ended: row.ended_at !== null, disputeOpen: Boolean(row.dispute_open),
  }), ctx.correlationId);
  await endAttributionRow(tx, ctx, { attributionId: row.id, organizationId: row.organization_id, reasonCode: input.reasonCode });
}

const attributionAdminColumns = sql`
  a.id, a.organization_id, a.organization_kind, o.legal_name, a.beneficiary_user_id, bu.email AS beneficiary_email, a.basis, a.reason_code,
  a.lead_id, l.name AS lead_name, a.effective_from, a.ended_at, a.ended_reason_code, eu.email AS ended_by_email, cu.email AS created_by_email,
  a.supersedes_id, a.dispute_id,
  EXISTS (SELECT 1 FROM organization_memberships m JOIN organizations p ON p.id = m.organization_id AND p.kind = 'PLATFORM'
          WHERE m.user_id = a.beneficiary_user_id AND m.state = 'ACTIVE' AND m.role IN ${growthRoles}) AS beneficiary_active,
  (SELECT max(e.occurred_at) FROM growth_leaver_events e WHERE e.user_id = a.beneficiary_user_id AND e.event = 'LEFT') AS left_at,
  EXISTS (SELECT 1 FROM growth_attribution_disputes d WHERE d.organization_id = a.organization_id AND d.state = 'OPEN') AS dispute_open`;

const attributionAdminFrom = sql`
  FROM growth_attributions a JOIN organizations o ON o.id = a.organization_id JOIN users bu ON bu.id = a.beneficiary_user_id
  JOIN users cu ON cu.id = a.created_by_user_id LEFT JOIN users eu ON eu.id = a.ended_by_user_id LEFT JOIN growth_leads l ON l.id = a.lead_id`;

type AdminAttributionRow = {
  id: string; organization_id: string; organization_kind: string; legal_name: string; beneficiary_user_id: string; beneficiary_email: string;
  basis: string; reason_code: string; lead_id: string | null; lead_name: string | null; effective_from: Date; ended_at: Date | null;
  ended_reason_code: string | null; ended_by_email: string | null; created_by_email: string; supersedes_id: string | null; dispute_id: string | null;
  beneficiary_active: boolean; left_at: Date | null; dispute_open: boolean;
}

function adminAttributionDto(row: AdminAttributionRow): Record<string, unknown> {
  const left = !row.beneficiary_active;
  return {
    attributionId: row.id, organizationId: row.organization_id, organizationName: row.legal_name, organizationKind: row.organization_kind,
    beneficiary: { userId: row.beneficiary_user_id, email: row.beneficiary_email, active: Boolean(row.beneficiary_active) },
    // A leaver's credit stays; what they would earn after leaving goes to nobody until reassigned (design §8.5).
    leaver: left ? { leftAt: iso(row.left_at), settlementEndsAt: row.left_at ? iso(growthLeaverSettlementEnds(new Date(row.left_at))) : null } : null,
    basis: row.basis, reasonCode: row.reason_code, lead: row.lead_id ? { leadId: row.lead_id, name: row.lead_name } : null,
    since: iso(row.effective_from), endedAt: iso(row.ended_at), endedReasonCode: row.ended_reason_code, endedBy: row.ended_by_email,
    createdBy: row.created_by_email, supersedesId: row.supersedes_id, disputeId: row.dispute_id, disputeOpen: Boolean(row.dispute_open),
  };
}

export type AdminAttributionView = 'LIVE' | 'LEFT' | 'ENDED';

export async function adminAttributions(runner: Runner, input: { readonly view: AdminAttributionView; readonly search: string | null }): Promise<Record<string, unknown>> {
  const term = input.search ? `%${input.search.toLowerCase()}%` : null;
  const found = await runner.execute(sql`
    SELECT * FROM (SELECT ${attributionAdminColumns} ${attributionAdminFrom}) a
    WHERE (${input.view} <> 'LIVE' OR a.ended_at IS NULL)
      AND (${input.view} <> 'LEFT' OR (a.ended_at IS NULL AND NOT a.beneficiary_active))
      AND (${input.view} <> 'ENDED' OR a.ended_at IS NOT NULL)
      AND (${term}::text IS NULL OR lower(a.legal_name) LIKE ${term} OR lower(a.beneficiary_email) LIKE ${term})
    ORDER BY a.effective_from DESC, a.id LIMIT 100
  `) as QueryResult<AdminAttributionRow>;
  const counts = (await runner.execute(sql`
    SELECT count(*) FILTER (WHERE a.ended_at IS NULL)::int AS live,
           count(*) FILTER (WHERE a.ended_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM organization_memberships m JOIN organizations p ON p.id = m.organization_id AND p.kind = 'PLATFORM'
             WHERE m.user_id = a.beneficiary_user_id AND m.state = 'ACTIVE' AND m.role IN ${growthRoles}))::int AS left_count,
           count(*) FILTER (WHERE a.ended_at IS NOT NULL)::int AS ended,
           (SELECT count(*)::int FROM growth_attribution_disputes WHERE state = 'OPEN') AS open_disputes
    FROM growth_attributions a
  `) as QueryResult<{ live: number; left_count: number; ended: number; open_disputes: number }>).rows[0];
  return {
    attributions: found.rows.map(adminAttributionDto),
    counts: { live: Number(counts?.live ?? 0), beneficiaryLeft: Number(counts?.left_count ?? 0), ended: Number(counts?.ended ?? 0), openDisputes: Number(counts?.open_disputes ?? 0) },
  };
}

type AdminDisputeRow = {
  id: string; organization_id: string; organization_kind: string; legal_name: string; origin: string; attribution_id: string | null;
  claimant_user_id: string; claimant_email: string; respondent_user_id: string | null; respondent_email: string | null; statement: string | null;
  opened_at: Date; opened_by_email: string; state: string; decided_at: Date | null; decided_by_email: string | null; decision_reason_code: string | null;
  decision_note: string | null; resulting_attribution_id: string | null; handed_off_at: Date | null; candidate_basis: string | null; current_basis: string | null;
  lead_name: string | null;
}

export async function adminDisputes(runner: Runner, input: { readonly state: 'OPEN' | 'DECIDED'; readonly organizationId?: string }): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT d.id, d.organization_id, d.organization_kind, o.legal_name, d.origin, d.attribution_id, d.claimant_user_id, cu.email AS claimant_email,
           d.respondent_user_id, ru.email AS respondent_email, d.statement, d.opened_at, ou.email AS opened_by_email, d.state, d.decided_at,
           du.email AS decided_by_email, d.decision_reason_code, d.decision_note, d.resulting_attribution_id,
           growth_organization_handed_off_at(d.organization_id) AS handed_off_at,
           (SELECT eo.candidate_basis FROM growth_employer_onboardings eo WHERE eo.access_request_id = d.source_access_request_id) AS candidate_basis,
           (SELECT a.basis FROM growth_attributions a WHERE a.id = d.attribution_id) AS current_basis,
           (SELECT l.name FROM growth_leads l WHERE l.organization_id = d.organization_id ORDER BY l.created_at LIMIT 1) AS lead_name
    FROM growth_attribution_disputes d JOIN organizations o ON o.id = d.organization_id
    JOIN users cu ON cu.id = d.claimant_user_id LEFT JOIN users ru ON ru.id = d.respondent_user_id
    JOIN users ou ON ou.id = d.opened_by_user_id LEFT JOIN users du ON du.id = d.decided_by_user_id
    WHERE (${input.organizationId ?? null}::uuid IS NOT NULL AND d.organization_id = ${input.organizationId ?? null}::uuid)
       OR (${input.organizationId ?? null}::uuid IS NULL AND ((${input.state} = 'OPEN' AND d.state = 'OPEN') OR (${input.state} = 'DECIDED' AND d.state <> 'OPEN')))
    ORDER BY d.opened_at ${input.state === 'OPEN' && !input.organizationId ? sql`ASC` : sql`DESC`}, d.id LIMIT 100
  `) as QueryResult<AdminDisputeRow>;
  return found.rows.map((row) => ({
    disputeId: row.id, organizationId: row.organization_id, organizationName: row.legal_name, organizationKind: row.organization_kind,
    origin: row.origin, attributionId: row.attribution_id, currentBasis: row.current_basis,
    claimant: { userId: row.claimant_user_id, email: row.claimant_email },
    respondent: row.respondent_user_id ? { userId: row.respondent_user_id, email: row.respondent_email } : null,
    statement: row.statement, openedAt: iso(row.opened_at), openedBy: row.opened_by_email, state: row.state,
    decidedAt: iso(row.decided_at), decidedBy: row.decided_by_email, decisionReasonCode: row.decision_reason_code, decisionNote: row.decision_note,
    resultingAttributionId: row.resulting_attribution_id,
    evidence: { handedOffAt: iso(row.handed_off_at), onboardingCandidate: row.candidate_basis, leadName: row.lead_name },
  }));
}

/** Every attribution row and dispute of one organisation: who was credited when, and why. */
export async function organizationAttributionHistory(runner: Runner, organizationId: string, correlationId: string): Promise<Record<string, unknown>> {
  const org = (await runner.execute(sql`
    SELECT id, legal_name, kind::text AS kind, growth_organization_handed_off_at(id) AS handed_off_at FROM organizations WHERE id = ${organizationId}::uuid AND kind IN ('INSTITUTION', 'EMPLOYER')
  `) as QueryResult<{ id: string; legal_name: string; kind: string; handed_off_at: Date | null }>).rows[0];
  if (!org) throw notFound('ORGANIZATION_NOT_FOUND', correlationId);
  const rows = await runner.execute(sql`
    SELECT ${attributionAdminColumns} ${attributionAdminFrom} WHERE a.organization_id = ${organizationId}::uuid ORDER BY a.created_at, a.id
  `) as QueryResult<AdminAttributionRow>;
  return {
    organization: { organizationId: org.id, name: org.legal_name, kind: org.kind, handedOffAt: iso(org.handed_off_at) },
    attributions: rows.rows.map(adminAttributionDto),
    disputes: await adminDisputes(runner, { state: 'OPEN', organizationId }),
  };
}

export async function reassignOptions(runner: Runner, kind: GrowthOrganizationKind): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT DISTINCT u.id, u.email FROM organization_memberships m
    JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = ${growthTeamForOrganizationKind(kind)}
    WHERE m.state = 'ACTIVE' AND m.role IN ${growthRoles}
    ORDER BY u.email LIMIT 200
  `) as QueryResult<{ id: string; email: string }>;
  return found.rows.map((row) => ({ userId: row.id, email: row.email }));
}
