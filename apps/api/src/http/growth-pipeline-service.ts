/**
 * The college pipeline: stage moves, the handoff request, the operator's link and decline, and the
 * derived milestones (GROWTH-04; design §6).
 *
 * Why one module: the growth routes and the Operations handoff queue write the same rows — the
 * lead's stage and its history, the handoff request, the contacts that move to the college's
 * account — and must do it in one transaction each with their audit rows and events. The derived
 * milestones are read here from their source tables, every time, so they cannot drift.
 *
 * Nothing here creates, verifies or changes an organisation. Nothing returns a student, a name of
 * a student, an amount or a contract's content; the student-activation count is suppressed below 5.
 *
 * Design: docs/architecture/growth-college-pipeline-table-design.md
 */
import { sql } from 'drizzle-orm';
import {
  collegeContactLimit,
  growthContactRoleOnAccount,
  growthResumeStage,
  maskEmail,
  maskPhone,
  suppressSmallCount,
  type GrowthCollegeMilestone,
} from '@planthepath/authorization/src/index.js';
import { readInstitutionDataTermsStatus } from '@planthepath/persistence/src/institution-contract.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { conflict, forbidden, iso, notFound, writeGrowthAudit, writeGrowthOutbox, type QueryResult } from './growth-http.js';
import type { LeadRow, WriteContext } from './growth-leads-service.js';
import { attributeCollegeHandoff, SELF_DEALING_CODE } from './growth-attribution-service.js';

type Runner = Pick<PersistenceDb, 'execute'>;

/** The reason code recorded on a contact carried to the college's account by the link (not offered to operators by hand). */
export const GROWTH_HANDOFF_CONTACT_REASON = 'ONBOARDING';

async function audit(tx: Runner, ctx: WriteContext, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>, organizationId?: string): Promise<void> {
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action, resourceType, resourceId, organizationId: organizationId ?? ctx.organizationId, correlationId: ctx.correlationId, context });
}

async function outbox(tx: Runner, ctx: WriteContext, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType, aggregateId, eventType, payload, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
}

export async function stageHistory(runner: Runner, leadId: string): Promise<readonly { readonly from: string | null; readonly to: string }[]> {
  const found = await runner.execute(sql`
    SELECT from_stage, to_stage FROM growth_lead_stage_history WHERE lead_id = ${leadId}::uuid ORDER BY occurred_at, id
  `) as QueryResult<{ from_stage: string | null; to_stage: string }>;
  return found.rows.map((row) => ({ from: row.from_stage, to: row.to_stage }));
}

/**
 * Applies one stage move to a locked lead. `to` is a stage, or RESUME (back to the stage held
 * before ON_HOLD). The caller has checked the machine and who may move it.
 */
export async function applyStageMove(tx: Runner, ctx: WriteContext, input: {
  readonly lead: LeadRow; readonly to: string; readonly reasonCode: string | null;
}): Promise<string> {
  let target = input.to;
  let reason = input.reasonCode;
  if (input.to === 'RESUME') {
    target = growthResumeStage(await stageHistory(tx, input.lead.id)) ?? 'IDENTIFIED';
    reason = 'RESUMED';
  }
  await tx.execute(sql`
    UPDATE growth_leads SET stage = ${target}, lost_reason_code = ${target === 'LOST' ? reason : null}, last_activity_at = now()
    WHERE id = ${input.lead.id}::uuid
  `);
  await tx.execute(sql`
    INSERT INTO growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${input.lead.id}::uuid, ${input.lead.stage}, ${target}, ${reason}, ${ctx.actorUserId}::uuid)
  `);
  await audit(tx, ctx, 'growth.lead.stage_moved', 'growth_lead', input.lead.id, { from: input.lead.stage, to: target, reasonCode: reason });
  await outbox(tx, ctx, 'growth.lead.stage_moved', 'growth_lead', input.lead.id, { leadId: input.lead.id, toStage: target });
  return input.lead.id;
}

/** The handoff request, its marked contacts and the stage move to HANDOFF_REQUESTED, together. */
export async function createHandoffRequest(tx: Runner, ctx: WriteContext, input: {
  readonly lead: LeadRow; readonly requestedByMembershipId: string; readonly contractReference: string; readonly contactIds: readonly string[];
}): Promise<string> {
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_handoff_requests (id, lead_id, requested_by_user_id, requested_by_membership_id, contract_reference_reported)
    VALUES (${id}::uuid, ${input.lead.id}::uuid, ${ctx.actorUserId}::uuid, ${input.requestedByMembershipId}::uuid, ${input.contractReference})
  `);
  for (const contactId of input.contactIds) {
    await tx.execute(sql`INSERT INTO growth_handoff_request_contacts (request_id, contact_id) VALUES (${id}::uuid, ${contactId}::uuid)`);
  }
  await tx.execute(sql`UPDATE growth_leads SET stage = 'HANDOFF_REQUESTED', last_activity_at = now() WHERE id = ${input.lead.id}::uuid`);
  await tx.execute(sql`
    INSERT INTO growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${input.lead.id}::uuid, ${input.lead.stage}, 'HANDOFF_REQUESTED', NULL, ${ctx.actorUserId}::uuid)
  `);
  await audit(tx, ctx, 'growth.handoff.requested', 'growth_handoff_request', id, { leadId: input.lead.id, contactsMarked: input.contactIds.length });
  await outbox(tx, ctx, 'growth.handoff.requested', 'growth_handoff_request', id, { requestId: id, leadId: input.lead.id });
  return id;
}

interface RequestRow {
  readonly id: string; readonly lead_id: string; readonly state: string; readonly requested_at: Date; readonly contract_reference_reported: string;
  readonly decided_at: Date | null; readonly decline_reason_code: string | null; readonly organization_id: string | null;
  readonly contacts_carried: number | null; readonly contacts_erased: number | null; readonly requester_email: string | null; readonly marked: number;
}

const requestColumns = sql`
  r.id, r.lead_id, r.state, r.requested_at, r.contract_reference_reported, r.decided_at, r.decline_reason_code, r.organization_id,
  r.contacts_carried, r.contacts_erased, ru.email AS requester_email,
  (SELECT count(*)::int FROM growth_handoff_request_contacts hc WHERE hc.request_id = r.id) AS marked`;

function requestDto(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id, state: row.state, requestedAt: iso(row.requested_at), requestedBy: row.requester_email,
    contractReferenceReported: row.contract_reference_reported, contactsMarked: Number(row.marked),
    decidedAt: iso(row.decided_at), declineReasonCode: row.decline_reason_code,
    contactsCarried: row.contacts_carried === null ? null : Number(row.contacts_carried),
    contactsErased: row.contacts_erased === null ? null : Number(row.contacts_erased),
  };
}

export async function handoffRequestsForLead(runner: Runner, leadId: string): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT ${requestColumns} FROM growth_handoff_requests r JOIN users ru ON ru.id = r.requested_by_user_id
    WHERE r.lead_id = ${leadId}::uuid ORDER BY r.requested_at DESC, r.id DESC LIMIT 20
  `) as unknown as QueryResult<RequestRow>;
  return found.rows.map(requestDto);
}

type MilestoneState = 'REACHED' | 'NOT_REACHED' | 'NA';
interface Milestone { readonly code: GrowthCollegeMilestone; readonly state: MilestoneState; readonly at: string | null; readonly note?: string; readonly count?: unknown }

/**
 * The derived milestones of a handed-off college (design §6.1), read from their source tables now.
 * Null for a lead that is not linked to an organisation.
 */
export async function collegeMilestones(runner: Runner, lead: { readonly id: string; readonly organization_id: string | null }): Promise<readonly Milestone[] | null> {
  const org = lead.organization_id;
  if (!org) return null;
  const one = async <T>(query: ReturnType<typeof sql>): Promise<T | undefined> => ((await runner.execute(query)) as QueryResult<T>).rows[0];
  const linked = await one<{ decided_at: Date }>(sql`SELECT decided_at FROM growth_handoff_requests WHERE lead_id = ${lead.id}::uuid AND state = 'LINKED'`);
  const account = await one<{ contract_reference: string | null }>(sql`SELECT contract_reference FROM institution_accounts WHERE institution_id = ${org}::uuid`);
  const verification = await one<{ verified_now: boolean; first_at: Date | null }>(sql`
    SELECT (o.verification_state::text = 'VERIFIED') AS verified_now,
           (SELECT min(e.occurred_at) FROM organization_verification_events e WHERE e.organization_id = o.id AND e.to_state::text = 'VERIFIED') AS first_at
    FROM organizations o WHERE o.id = ${org}::uuid`);
  const admin = await one<{ at: Date | null }>(sql`
    SELECT min(accepted_at) AS at FROM invitations
    WHERE organization_id = ${org}::uuid AND role = 'INSTITUTION_ADMIN' AND state::text = 'ACCEPTED'`);
  const terms = await readInstitutionDataTermsStatus(runner as PersistenceDb, org);
  const roster = await one<{ at: Date | null }>(sql`
    SELECT min(r.created_at) AS at FROM institution_relationships r
    WHERE r.institution_id = ${org}::uuid
      AND EXISTS (SELECT 1 FROM institution_student_profiles p WHERE p.institution_id = r.institution_id AND p.student_user_id = r.student_user_id)`);
  const activated = await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM invitations WHERE organization_id = ${org}::uuid AND kind = 'STUDENT' AND state::text = 'ACCEPTED'`);
  const exited = await one<{ at: Date | null }>(sql`
    SELECT max(ended_at) AS at FROM institution_offboardings WHERE institution_id = ${org}::uuid AND state IN ('ENDED', 'PURGED')`);
  const activatedCount = suppressSmallCount(Number(activated?.n ?? 0));
  return [
    { code: 'HANDED_OFF', state: linked ? 'REACHED' : 'NOT_REACHED', at: iso(linked?.decided_at ?? null) },
    { code: 'CONTRACT_RECORDED', state: account?.contract_reference ? 'REACHED' : 'NOT_REACHED', at: null },
    { code: 'VERIFIED', state: verification?.verified_now ? 'REACHED' : 'NOT_REACHED', at: verification?.verified_now ? iso(verification.first_at) : null },
    { code: 'ADMIN_JOINED', state: admin?.at ? 'REACHED' : 'NOT_REACHED', at: iso(admin?.at ?? null) },
    terms.status === 'NO_TERMS_PUBLISHED'
      ? { code: 'DATA_TERMS_ACCEPTED', state: 'NA', at: null, note: 'No data-processing terms are published yet.' }
      : { code: 'DATA_TERMS_ACCEPTED', state: terms.status === 'ACCEPTED' ? 'REACHED' : 'NOT_REACHED', at: terms.status === 'ACCEPTED' ? terms.latestAcceptance?.acceptedAt ?? null : null },
    { code: 'FIRST_ROSTER', state: roster?.at ? 'REACHED' : 'NOT_REACHED', at: iso(roster?.at ?? null) },
    // A milestone only, never a list or a name; fewer than 5 is shown as "<5" (design §6.1).
    { code: 'STUDENTS_ACTIVATING', state: activatedCount.suppressed ? 'NOT_REACHED' : 'REACHED', at: null, count: activatedCount },
    { code: 'FIRST_PAYMENT_CLEARED', state: 'NA', at: null, note: 'College payments are not recorded in ONE yet.' },
    { code: 'EXITED', state: exited?.at ? 'REACHED' : 'NOT_REACHED', at: iso(exited?.at ?? null) },
  ];
}

// ---------------------------------------------------------------------------
// Operations: the queue, the link and the decline
// ---------------------------------------------------------------------------

export async function handoffQueue(runner: Runner): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT ${requestColumns}, l.name AS lead_name, l.city, s.name AS state_name, d.name AS district_name, l.aishe_code, ou.email AS owner_email
    FROM growth_handoff_requests r
    JOIN users ru ON ru.id = r.requested_by_user_id
    JOIN growth_leads l ON l.id = r.lead_id
    LEFT JOIN growth_states s ON s.code = l.state_code
    LEFT JOIN growth_districts d ON d.lgd_code = l.district_code
    LEFT JOIN organization_memberships om ON om.id = l.owner_membership_id
    LEFT JOIN users ou ON ou.id = om.user_id
    WHERE r.state = 'REQUESTED'
    ORDER BY r.requested_at, r.id LIMIT 100
  `) as unknown as QueryResult<RequestRow & { lead_name: string; city: string | null; state_name: string | null; district_name: string | null; aishe_code: string | null; owner_email: string | null }>;
  const result: Record<string, unknown>[] = [];
  for (const row of found.rows) {
    // The operator sees who and how to reach them only masked; the full values move server-side at link.
    const contacts = await runner.execute(sql`
      SELECT c.id, c.contact_role, c.full_name, c.email, c.phone FROM growth_handoff_request_contacts hc
      JOIN growth_lead_contacts c ON c.id = hc.contact_id WHERE hc.request_id = ${row.id}::uuid AND c.removed_at IS NULL ORDER BY c.created_at, c.id
    `) as QueryResult<{ id: string; contact_role: string; full_name: string; email: string | null; phone: string | null }>;
    result.push({
      ...requestDto(row), leadId: row.lead_id, leadName: row.lead_name, owner: row.owner_email,
      area: { city: row.city, stateName: row.state_name, districtName: row.district_name }, aisheCode: row.aishe_code,
      contacts: contacts.rows.map((contact) => ({
        id: contact.id, role: contact.contact_role, accountRole: growthContactRoleOnAccount(contact.contact_role), fullName: contact.full_name,
        email: maskEmail(contact.email), phone: maskPhone(contact.phone),
      })),
    });
  }
  return result;
}

export async function linkHandoff(tx: Runner, ctx: WriteContext, input: { readonly leadId: string; readonly organizationId: string }): Promise<Record<string, unknown>> {
  const request = (await tx.execute(sql`
    SELECT id FROM growth_handoff_requests WHERE lead_id = ${input.leadId}::uuid AND state = 'REQUESTED' FOR UPDATE
  `) as QueryResult<{ id: string }>).rows[0];
  if (!request) throw notFound('GROWTH_HANDOFF_NOT_FOUND', ctx.correlationId);
  const lead = (await tx.execute(sql`
    SELECT l.owner_membership_id, m.user_id AS owner_user_id FROM growth_leads l
    LEFT JOIN organization_memberships m ON m.id = l.owner_membership_id WHERE l.id = ${input.leadId}::uuid FOR UPDATE OF l
  `) as QueryResult<{ owner_membership_id: string | null; owner_user_id: string | null }>).rows[0]!;
  // GROWTH-07 self-dealing guard (design §8.6): the link credits the lead's owner, so the owner never links it.
  if (lead.owner_user_id === ctx.actorUserId) throw forbidden(SELF_DEALING_CODE, ctx.correlationId);
  const org = (await tx.execute(sql`SELECT kind::text AS kind FROM organizations WHERE id = ${input.organizationId}::uuid FOR SHARE`) as QueryResult<{ kind: string }>).rows[0];
  if (!org) throw notFound('ORGANIZATION_NOT_FOUND', ctx.correlationId);
  if (org.kind !== 'INSTITUTION') throw conflict('GROWTH_HANDOFF_NOT_AN_INSTITUTION', ctx.correlationId);
  const taken = await tx.execute(sql`SELECT 1 FROM growth_leads WHERE organization_id = ${input.organizationId}::uuid`) as QueryResult<unknown>;
  if (taken.rows.length) throw conflict('GROWTH_ORGANIZATION_ALREADY_LINKED', ctx.correlationId);

  // Contacts: the marked, still-live ones go to the college's account (OPS-14), up to its limit.
  await tx.execute(sql`
    INSERT INTO institution_accounts (institution_id, updated_by_user_id) VALUES (${input.organizationId}::uuid, ${ctx.actorUserId}::uuid)
    ON CONFLICT (institution_id) DO NOTHING
  `);
  await tx.execute(sql`SELECT 1 FROM institution_accounts WHERE institution_id = ${input.organizationId}::uuid FOR UPDATE`);
  const live = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM institution_account_contacts WHERE institution_id = ${input.organizationId}::uuid AND removed_at IS NULL
  `) as QueryResult<{ n: number }>).rows[0]?.n ?? 0;
  const marked = await tx.execute(sql`
    SELECT c.id, c.contact_role, c.full_name, c.email, c.phone FROM growth_handoff_request_contacts hc
    JOIN growth_lead_contacts c ON c.id = hc.contact_id
    WHERE hc.request_id = ${request.id}::uuid AND c.removed_at IS NULL ORDER BY c.created_at, c.id
  `) as QueryResult<{ id: string; contact_role: string; full_name: string; email: string | null; phone: string | null }>;
  const room = Math.max(0, collegeContactLimit - Number(live));
  const carried = marked.rows.slice(0, room);
  for (const contact of carried) {
    const accountContactId = ctx.uuid();
    const role = growthContactRoleOnAccount(contact.contact_role);
    await tx.execute(sql`
      INSERT INTO institution_account_contacts (id, institution_id, contact_role, full_name, email, phone, added_by_user_id, added_reason_code)
      VALUES (${accountContactId}::uuid, ${input.organizationId}::uuid, ${role}, ${contact.full_name}, ${contact.email}, ${contact.phone},
              ${ctx.actorUserId}::uuid, ${GROWTH_HANDOFF_CONTACT_REASON})
    `);
    // The same audit action OPS-14 writes for a contact added by hand, with where it came from.
    await audit(tx, ctx, 'operations.institution_account.contact_added', 'institution_account_contact', accountContactId, {
      reasonCode: GROWTH_HANDOFF_CONTACT_REASON, role, fields: [contact.email ? 'email' : null, contact.phone ? 'phone' : null].filter(Boolean), source: 'growth_handoff', leadId: input.leadId,
    }, input.organizationId);
  }
  // Every lead copy goes: carried ones now live on the account; the rest would otherwise be kept for ever
  // (a handed-off lead is outside the 24-month sweep).
  const erased = await tx.execute(sql`
    UPDATE growth_lead_contacts SET removed_at = now(), removed_by_user_id = ${ctx.actorUserId}::uuid, removed_reason_code = 'HANDED_OVER',
      full_name = NULL, email = NULL, phone = NULL
    WHERE lead_id = ${input.leadId}::uuid AND removed_at IS NULL RETURNING id
  `) as QueryResult<{ id: string }>;

  await tx.execute(sql`
    UPDATE growth_handoff_requests
    SET state = 'LINKED', decided_by_user_id = ${ctx.actorUserId}::uuid, organization_id = ${input.organizationId}::uuid,
        owner_membership_id_at_link = ${lead.owner_membership_id}::uuid, owner_user_id_at_link = ${lead.owner_user_id}::uuid,
        contacts_carried = ${carried.length}, contacts_erased = ${erased.rows.length}
    WHERE id = ${request.id}::uuid
  `);
  await tx.execute(sql`UPDATE growth_leads SET organization_id = ${input.organizationId}::uuid, last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  // GROWTH-07 (design §8.2): the college is credited to the lead's owner at this moment; nobody when unowned.
  const attributionId = await attributeCollegeHandoff(tx, ctx, { requestId: request.id, leadId: input.leadId, organizationId: input.organizationId, ownerUserId: lead.owner_user_id });
  await audit(tx, ctx, 'operations.growth_handoff.linked', 'growth_handoff_request', request.id, {
    leadId: input.leadId, organizationId: input.organizationId, ownerMembershipIdAtLink: lead.owner_membership_id,
    contactsCarried: carried.length, contactsErased: erased.rows.length, contactsOverLimit: marked.rows.length - carried.length, attributionId,
  });
  await outbox(tx, ctx, 'growth.lead.handed_off', 'growth_lead', input.leadId, { leadId: input.leadId, organizationId: input.organizationId });
  return { requestId: request.id, contactsCarried: carried.length, contactsErased: erased.rows.length, contactsOverLimit: marked.rows.length - carried.length, attributionId };
}

export async function declineHandoff(tx: Runner, ctx: WriteContext, input: { readonly leadId: string; readonly reasonCode: string }): Promise<string> {
  const request = (await tx.execute(sql`
    SELECT id FROM growth_handoff_requests WHERE lead_id = ${input.leadId}::uuid AND state = 'REQUESTED' FOR UPDATE
  `) as QueryResult<{ id: string }>).rows[0];
  if (!request) throw notFound('GROWTH_HANDOFF_NOT_FOUND', ctx.correlationId);
  await tx.execute(sql`SELECT 1 FROM growth_leads WHERE id = ${input.leadId}::uuid FOR UPDATE`);
  await tx.execute(sql`
    UPDATE growth_handoff_requests SET state = 'DECLINED', decided_by_user_id = ${ctx.actorUserId}::uuid, decline_reason_code = ${input.reasonCode}
    WHERE id = ${request.id}::uuid
  `);
  await tx.execute(sql`UPDATE growth_leads SET stage = 'NEGOTIATION', last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  await tx.execute(sql`
    INSERT INTO growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${input.leadId}::uuid, 'HANDOFF_REQUESTED', 'NEGOTIATION', ${input.reasonCode}, ${ctx.actorUserId}::uuid)
  `);
  await audit(tx, ctx, 'operations.growth_handoff.declined', 'growth_handoff_request', request.id, { leadId: input.leadId, reasonCode: input.reasonCode });
  await outbox(tx, ctx, 'growth.handoff.declined', 'growth_handoff_request', request.id, { requestId: request.id, leadId: input.leadId, reasonCode: input.reasonCode });
  return request.id;
}
