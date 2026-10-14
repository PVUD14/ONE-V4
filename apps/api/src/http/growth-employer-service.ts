/**
 * The employer pipeline (GROWTH-05; design §7, §8.3): referral codes, what the public access-request
 * form records about a referral and a matching lead, the onboarding record written when operations
 * onboards a request, the operator's lead links, and the employer milestones.
 *
 * Why one module: the public form, the Operations queue and decision, and the growth routes touch the
 * same rows and must agree on them. The form's part runs inside its own transaction and inside a
 * savepoint, and nothing it does here can change the form's answer. The milestones are read from
 * their source tables every time, so they cannot drift; they select states, times and counts only —
 * never a job's content, an applicant, a candidate or a drive's college.
 *
 * Design: docs/architecture/growth-employer-pipeline-table-design.md
 */
import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  generateGrowthReferralCode,
  growthAccessRequestHosts,
  growthEmployerCandidateBasis,
  growthReferralLimits,
  growthReferralLinkPath,
  growthReferralSeenBy,
  normaliseGrowthReferralRef,
  type GrowthEmployerCandidateBasis,
  type GrowthEmployerMilestone,
} from '@planthepath/authorization/src/index.js';
import { readEmployerTermsStatus } from '@planthepath/persistence/src/employer-terms.js';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { iso, notFound, writeGrowthAudit, writeGrowthOutbox, conflict, forbidden, type QueryResult } from './growth-http.js';
import type { WriteContext } from './growth-leads-service.js';
import { attributeEmployerOnboarding, SELF_DEALING_CODE } from './growth-attribution-service.js';

type Runner = Pick<PersistenceDb, 'execute'>;
type Transactional = Runner & { transaction<T>(work: (tx: Transactional) => Promise<T>): Promise<T> };

// ---------------------------------------------------------------------------
// The public form (anonymous; no audit row is possible, so the rows and events are the record)
// ---------------------------------------------------------------------------

/**
 * Records, for a pending request the public form just saved, the referral its `ref` names (if the
 * code is live, its owner ACTIVE and under the per-code cap) and the employer lead its domain
 * matches (if exactly one open, contactable lead does). Runs in a savepoint: whatever happens here,
 * the submission and its answer are unchanged. A well-formed `ref` is looked up even when it will be
 * ignored, and a malformed one costs the same lookup, so the work does not depend on validity.
 */
export async function recordAccessRequestGrowthSignals(tx: Transactional, input: {
  readonly requestId: string; readonly ref: unknown; readonly emailDomain: string; readonly websiteUrl: string;
  readonly uuid: () => string; readonly correlationId: string;
}): Promise<void> {
  try {
    await tx.transaction(async (savepoint) => {
      const code = normaliseGrowthReferralRef(input.ref);
      const found = await savepoint.execute(sql`
        SELECT c.id, (c.revoked_at IS NULL AND m.state = 'ACTIVE') AS live,
               (SELECT count(*)::int FROM employer_access_request_referrals r
                 WHERE r.referral_code_id = c.id AND r.created_at > now() - interval '24 hours') AS recent
        FROM growth_referral_codes c JOIN organization_memberships m ON m.id = c.membership_id
        WHERE c.code = ${code ?? ''}
      `) as QueryResult<{ id: string; live: boolean; recent: number }>;
      const usable = found.rows[0];
      if (code && usable?.live && Number(usable.recent) < growthReferralLimits.referralsPerCodePerDay) {
        const inserted = await savepoint.execute(sql`
          INSERT INTO employer_access_request_referrals (access_request_id, referral_code_id)
          VALUES (${input.requestId}::uuid, ${usable.id}::uuid)
          ON CONFLICT (access_request_id) DO NOTHING RETURNING access_request_id
        `) as QueryResult<unknown>;
        if (inserted.rows.length) {
          const event = { id: input.uuid(), aggregateType: 'employer_access_request', aggregateId: input.requestId, eventType: 'growth.referral.recorded',
            payload: { requestId: input.requestId, referralCodeId: usable.id }, correlationId: input.correlationId };
          validateOutboxWriteInput({ ...event, eventVersion: 1 });
          await savepoint.execute(sql`
            INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
            VALUES (${event.id}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.eventType}, 1, ${JSON.stringify(event.payload)}::jsonb, ${event.correlationId})
          `);
        }
      }
      const hosts = growthAccessRequestHosts({ emailDomain: input.emailDomain, websiteUrl: input.websiteUrl });
      if (hosts.length) {
        const leads = await savepoint.execute(sql`
          SELECT l.id FROM growth_leads l
          WHERE l.kind = 'EMPLOYER' AND l.stage <> 'LOST' AND l.do_not_contact_at IS NULL AND l.organization_id IS NULL
            AND l.website_domain IN (${sql.join(hosts.map((host) => sql`${host}`), sql`, `)})
          LIMIT 2
        `) as QueryResult<{ id: string }>;
        if (leads.rows.length === 1) {
          await savepoint.execute(sql`
            INSERT INTO employer_access_request_leads (access_request_id, lead_id, basis)
            VALUES (${input.requestId}::uuid, ${leads.rows[0]!.id}::uuid, 'DOMAIN_MATCH')
            ON CONFLICT (access_request_id) DO NOTHING
          `);
        }
      }
    });
  } catch {
    // Deliberately silent: the referral and the lead match are extras; the request is what counts.
  }
}

// ---------------------------------------------------------------------------
// Operations: the onboarding record (inside the unchanged decision route's transaction)
// ---------------------------------------------------------------------------

export interface OnboardingRecord {
  readonly candidateBasis: GrowthEmployerCandidateBasis;
  readonly leadId: string | null;
  readonly leadLinked: boolean;
  readonly attributionId: string | null;
  readonly disputeId: string | null;
}

/**
 * Called by the decision route right after a request became ONBOARDED. Records the linked lead and
 * its owner, and the referral and its owner, as they stand now, with the §8.3 candidate; links the
 * lead to the employer when it can. An unusable lead is simply not recorded.
 *
 * GROWTH-07: at the employer's first onboarding it also writes the attribution (or, on a conflict,
 * opens a dispute), and it refuses — rolling the decision back — an operator who is the referrer or
 * the lead's owner (design §8.6): another operator must onboard it.
 */
export async function recordEmployerOnboarding(tx: Runner, input: {
  readonly requestId: string; readonly organizationId: string; readonly actorUserId: string; readonly correlationId: string; readonly uuid: () => string;
}): Promise<OnboardingRecord> {
  const lead = (await tx.execute(sql`
    SELECT l.id, l.stage, l.do_not_contact_at, l.organization_id, l.owner_membership_id, om.user_id AS owner_user_id
    FROM employer_access_request_leads el
    JOIN growth_leads l ON l.id = el.lead_id
    LEFT JOIN organization_memberships om ON om.id = l.owner_membership_id
    WHERE el.access_request_id = ${input.requestId}::uuid
    FOR UPDATE OF l
  `) as QueryResult<{ id: string; stage: string; do_not_contact_at: Date | null; organization_id: string | null; owner_membership_id: string | null; owner_user_id: string | null }>).rows[0];
  let usableLead = lead && lead.stage !== 'LOST' && lead.do_not_contact_at === null
    && (lead.organization_id === null || lead.organization_id === input.organizationId) ? lead : undefined;
  if (usableLead && usableLead.organization_id === null) {
    const taken = await tx.execute(sql`SELECT 1 FROM growth_leads WHERE organization_id = ${input.organizationId}::uuid`) as QueryResult<unknown>;
    if (taken.rows.length) usableLead = undefined;
  }
  const referral = (await tx.execute(sql`
    SELECT c.id, c.membership_id, c.user_id FROM employer_access_request_referrals r
    JOIN growth_referral_codes c ON c.id = r.referral_code_id WHERE r.access_request_id = ${input.requestId}::uuid
  `) as QueryResult<{ id: string; membership_id: string; user_id: string }>).rows[0];
  const leadOwnerUserId = usableLead?.owner_user_id ?? null;
  if (input.actorUserId === referral?.user_id || input.actorUserId === leadOwnerUserId) throw forbidden(SELF_DEALING_CODE, input.correlationId);
  const basis = growthEmployerCandidateBasis({ referrerUserId: referral?.user_id ?? null, leadOwnerUserId });
  await tx.execute(sql`
    INSERT INTO growth_employer_onboardings (access_request_id, organization_id, lead_id, lead_owner_membership_id, lead_owner_user_id,
      referral_code_id, referrer_membership_id, referrer_user_id, candidate_basis, recorded_by_user_id)
    VALUES (${input.requestId}::uuid, ${input.organizationId}::uuid, ${usableLead?.id ?? null}::uuid,
            ${usableLead?.owner_membership_id ?? null}::uuid, ${leadOwnerUserId}::uuid,
            ${referral?.id ?? null}::uuid, ${referral?.membership_id ?? null}::uuid, ${referral?.user_id ?? null}::uuid,
            ${basis}, ${input.actorUserId}::uuid)
  `);
  const leadLinked = Boolean(usableLead && usableLead.organization_id === null);
  if (usableLead && leadLinked) {
    await tx.execute(sql`UPDATE growth_leads SET organization_id = ${input.organizationId}::uuid, last_activity_at = now() WHERE id = ${usableLead.id}::uuid`);
  }
  const credit = await attributeEmployerOnboarding(tx, { actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId, uuid: input.uuid }, {
    requestId: input.requestId, organizationId: input.organizationId, leadId: leadLinked || usableLead?.organization_id === input.organizationId ? usableLead?.id ?? null : null,
    candidate: basis, referrerUserId: referral?.user_id ?? null, leadOwnerUserId,
  });
  const context = { requestId: input.requestId, organizationId: input.organizationId, leadId: usableLead?.id ?? null, leadLinked, candidateBasis: basis, referral: Boolean(referral),
    attributionId: credit.attributionId, disputeId: credit.disputeId, firstHandoff: credit.firstHandoff };
  await writeGrowthAudit(tx, { id: input.uuid(), actorUserId: input.actorUserId, action: 'operations.employer.growth_onboarding_recorded',
    resourceType: 'growth_employer_onboarding', resourceId: input.requestId, organizationId: input.organizationId, correlationId: input.correlationId, context });
  await writeGrowthOutbox(tx, { id: input.uuid(), aggregateType: 'growth_employer_onboarding', aggregateId: input.requestId, eventType: 'growth.employer.onboarded',
    payload: { requestId: input.requestId, organizationId: input.organizationId, candidateBasis: basis }, actorUserId: input.actorUserId,
    organizationId: input.organizationId, correlationId: input.correlationId });
  return { candidateBasis: basis, leadId: usableLead?.id ?? null, leadLinked, attributionId: credit.attributionId, disputeId: credit.disputeId };
}

// ---------------------------------------------------------------------------
// Operations: the queue's growth columns, the lead picker and the manual link
// ---------------------------------------------------------------------------

/** The growth facts the Operations access-request queue shows beside each request (OPS_ORG_MANAGE only). */
export const accessRequestGrowthColumns = sql`
  (SELECT json_build_object('referrerEmail', ru.email, 'codeRevoked', rc.revoked_at IS NOT NULL, 'recordedAt', rr.created_at)
     FROM employer_access_request_referrals rr JOIN growth_referral_codes rc ON rc.id = rr.referral_code_id JOIN users ru ON ru.id = rc.user_id
     WHERE rr.access_request_id = r.id) AS growth_referral,
  (SELECT json_build_object('leadId', l.id, 'name', l.name, 'websiteDomain', l.website_domain, 'stage', l.stage, 'basis', el.basis, 'ownerEmail', lu.email)
     FROM employer_access_request_leads el JOIN growth_leads l ON l.id = el.lead_id
     LEFT JOIN organization_memberships lm ON lm.id = l.owner_membership_id LEFT JOIN users lu ON lu.id = lm.user_id
     WHERE el.access_request_id = r.id) AS growth_lead,
  coalesce((
    SELECT json_agg(json_build_object('leadId', c.id, 'name', c.name, 'websiteDomain', c.website_domain, 'stage', c.stage, 'ownerEmail', c.owner_email) ORDER BY c.name)
    FROM (
      SELECT l.id, l.name, l.website_domain, l.stage, lu.email AS owner_email FROM growth_leads l
      LEFT JOIN organization_memberships lm ON lm.id = l.owner_membership_id LEFT JOIN users lu ON lu.id = lm.user_id
      WHERE l.kind = 'EMPLOYER' AND l.stage <> 'LOST' AND l.do_not_contact_at IS NULL AND l.organization_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM employer_access_request_leads el WHERE el.access_request_id = r.id AND el.lead_id = l.id)
        AND (l.website_domain = r.email_domain
          OR l.website_domain = regexp_replace(lower(substring(r.website_url from '^https://([^/:?#]+)')), '^www\\.', '')
          OR l.name_normalized = regexp_replace(lower(r.company_name), '[^a-z0-9]', '', 'g'))
      ORDER BY l.name LIMIT 5
    ) c), '[]'::json) AS growth_lead_candidates`;

export function presentAccessRequestGrowth(row: Record<string, unknown>): Record<string, unknown> {
  const referral = row.growth_referral as { referrerEmail: string; codeRevoked: boolean; recordedAt: string } | null;
  return {
    growthReferral: referral ? { referrerEmail: referral.referrerEmail, codeRevoked: referral.codeRevoked, recordedAt: iso(referral.recordedAt) } : null,
    growthLead: row.growth_lead ?? null,
    growthLeadCandidates: row.growth_lead_candidates ?? [],
  };
}

/** Open employer leads for the operator's link picker, by name or domain. */
export async function searchEmployerLeadsForOperations(runner: Runner, query: string): Promise<readonly Record<string, unknown>[]> {
  const term = query.trim().toLowerCase();
  const normalised = term.replace(/[^a-z0-9]/g, '');
  const found = await runner.execute(sql`
    SELECT l.id, l.name, l.website_domain, l.stage, lu.email AS owner_email FROM growth_leads l
    LEFT JOIN organization_memberships lm ON lm.id = l.owner_membership_id LEFT JOIN users lu ON lu.id = lm.user_id
    WHERE l.kind = 'EMPLOYER' AND l.stage <> 'LOST' AND l.do_not_contact_at IS NULL AND l.organization_id IS NULL
      AND (${normalised} = '' OR l.name_normalized LIKE '%' || ${normalised} || '%' OR l.website_domain LIKE '%' || ${term} || '%')
    ORDER BY l.name, l.id LIMIT 20
  `) as QueryResult<{ id: string; name: string; website_domain: string | null; stage: string; owner_email: string | null }>;
  return found.rows.map((row) => ({ leadId: row.id, name: row.name, websiteDomain: row.website_domain, stage: row.stage, ownerEmail: row.owner_email }));
}

/** Links (or moves, or with null removes) a pending request's growth lead. Audited with the old and new lead. */
export async function setAccessRequestLead(tx: Runner, ctx: WriteContext, input: { readonly requestId: string; readonly leadId: string | null }): Promise<Record<string, unknown>> {
  const request = (await tx.execute(sql`SELECT state FROM employer_access_requests WHERE id = ${input.requestId}::uuid FOR UPDATE`) as QueryResult<{ state: string }>).rows[0];
  if (!request) throw notFound('EMPLOYER_ACCESS_REQUEST_NOT_FOUND', ctx.correlationId);
  if (request.state !== 'PENDING') throw conflict('EMPLOYER_ACCESS_REQUEST_NOT_PENDING', ctx.correlationId);
  const before = (await tx.execute(sql`SELECT lead_id FROM employer_access_request_leads WHERE access_request_id = ${input.requestId}::uuid`) as QueryResult<{ lead_id: string }>).rows[0]?.lead_id ?? null;
  if (input.leadId === null) {
    if (before === null) return { requestId: input.requestId, leadId: null };
    await tx.execute(sql`DELETE FROM employer_access_request_leads WHERE access_request_id = ${input.requestId}::uuid`);
  } else {
    const lead = (await tx.execute(sql`
      SELECT m.user_id AS owner_user_id FROM growth_leads l LEFT JOIN organization_memberships m ON m.id = l.owner_membership_id
      WHERE l.id = ${input.leadId}::uuid AND l.kind = 'EMPLOYER' AND l.stage <> 'LOST' AND l.do_not_contact_at IS NULL AND l.organization_id IS NULL
    `) as QueryResult<{ owner_user_id: string | null }>).rows[0];
    if (!lead) throw conflict('GROWTH_EMPLOYER_LEAD_NOT_LINKABLE', ctx.correlationId);
    // GROWTH-07 (design §8.6): linking makes the lead's owner the credit candidate, so the owner never links their own.
    if (lead.owner_user_id === ctx.actorUserId) throw forbidden(SELF_DEALING_CODE, ctx.correlationId);
    if (before === input.leadId) return { requestId: input.requestId, leadId: input.leadId };
    await tx.execute(sql`
      INSERT INTO employer_access_request_leads (access_request_id, lead_id, basis, linked_by_user_id)
      VALUES (${input.requestId}::uuid, ${input.leadId}::uuid, 'OPERATOR_LINKED', ${ctx.actorUserId}::uuid)
      ON CONFLICT (access_request_id) DO UPDATE SET lead_id = EXCLUDED.lead_id, basis = 'OPERATOR_LINKED', linked_by_user_id = EXCLUDED.linked_by_user_id
    `);
  }
  const linked = input.leadId !== null;
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId,
    action: linked ? 'operations.employer_access_request.growth_lead_linked' : 'operations.employer_access_request.growth_lead_unlinked',
    resourceType: 'employer_access_request', resourceId: input.requestId, organizationId: ctx.organizationId, correlationId: ctx.correlationId,
    context: { fromLeadId: before, toLeadId: input.leadId } });
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType: 'employer_access_request', aggregateId: input.requestId,
    eventType: linked ? 'growth.employer_lead.linked' : 'growth.employer_lead.unlinked',
    payload: linked ? { requestId: input.requestId, leadId: input.leadId } : { requestId: input.requestId, leadId: before },
    actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
  return { requestId: input.requestId, leadId: input.leadId };
}

// ---------------------------------------------------------------------------
// Growth: referral codes
// ---------------------------------------------------------------------------

export async function listReferralCodes(runner: Runner, userId: string): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT c.id, c.code, c.created_at, c.revoked_at, c.revoked_reason_code,
      (SELECT count(*)::int FROM employer_access_request_referrals rr JOIN employer_access_requests r ON r.id = rr.access_request_id
        WHERE rr.referral_code_id = c.id AND r.state = 'PENDING') AS pending,
      (SELECT count(*)::int FROM employer_access_request_referrals rr JOIN employer_access_requests r ON r.id = rr.access_request_id
        WHERE rr.referral_code_id = c.id AND r.state = 'ONBOARDED') AS onboarded,
      (SELECT count(*)::int FROM employer_access_request_referrals rr JOIN employer_access_requests r ON r.id = rr.access_request_id
        WHERE rr.referral_code_id = c.id AND r.state IN ('DECLINED', 'SPAM')) AS closed
    FROM growth_referral_codes c WHERE c.user_id = ${userId}::uuid
    ORDER BY (c.revoked_at IS NULL) DESC, c.created_at DESC, c.id LIMIT 20
  `) as QueryResult<{ id: string; code: string; created_at: Date; revoked_at: Date | null; revoked_reason_code: string | null; pending: number; onboarded: number; closed: number }>;
  return found.rows.map((row) => ({
    id: row.id, code: row.code, linkPath: growthReferralLinkPath(row.code), createdAt: iso(row.created_at),
    revokedAt: iso(row.revoked_at), revokedReasonCode: row.revoked_reason_code,
    referrals: { pending: Number(row.pending), onboarded: Number(row.onboarded), closed: Number(row.closed) },
  }));
}

export async function createReferralCode(tx: Runner, ctx: WriteContext, membershipId: string): Promise<string> {
  let code = generateGrowthReferralCode(randomInt);
  // A clash in a ~49-bit space is all but impossible; look first so a clash never aborts the transaction.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await tx.execute(sql`SELECT 1 FROM growth_referral_codes WHERE code = ${code}`) as QueryResult<unknown>;
    if (!clash.rows.length) break;
    code = generateGrowthReferralCode(randomInt);
  }
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_referral_codes (id, code, membership_id, user_id) VALUES (${id}::uuid, ${code}, ${membershipId}::uuid, ${ctx.actorUserId}::uuid)
  `);
  // The audit row and event name the code by id only: the code itself is the link, not a fact to spread.
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action: 'growth.referral_code.created', resourceType: 'growth_referral_code',
    resourceId: id, organizationId: ctx.organizationId, correlationId: ctx.correlationId, context: { membershipId } });
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType: 'growth_referral_code', aggregateId: id, eventType: 'growth.referral_code.created',
    payload: { referralCodeId: id }, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
  return id;
}

export async function revokeReferralCode(tx: Runner, ctx: WriteContext, codeId: string): Promise<void> {
  const row = (await tx.execute(sql`SELECT user_id, revoked_at FROM growth_referral_codes WHERE id = ${codeId}::uuid FOR UPDATE`) as QueryResult<{ user_id: string; revoked_at: Date | null }>).rows[0];
  // Another person's code is not found, not forbidden: nobody learns whose codes exist.
  if (!row || row.user_id !== ctx.actorUserId) throw notFound('GROWTH_REFERRAL_CODE_NOT_FOUND', ctx.correlationId);
  if (row.revoked_at) throw conflict('GROWTH_REFERRAL_CODE_REVOKED', ctx.correlationId);
  await tx.execute(sql`
    UPDATE growth_referral_codes SET revoked_at = now(), revoked_reason_code = 'OWNER_REVOKED', revoked_by_user_id = ${ctx.actorUserId}::uuid WHERE id = ${codeId}::uuid
  `);
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action: 'growth.referral_code.revoked', resourceType: 'growth_referral_code',
    resourceId: codeId, organizationId: ctx.organizationId, correlationId: ctx.correlationId, context: { reasonCode: 'OWNER_REVOKED' } });
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType: 'growth_referral_code', aggregateId: codeId, eventType: 'growth.referral_code.revoked',
    payload: { referralCodeId: codeId, reasonCode: 'OWNER_REVOKED' }, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
}

// ---------------------------------------------------------------------------
// Growth: an employer lead's milestones and access requests
// ---------------------------------------------------------------------------

type MilestoneState = 'REACHED' | 'NOT_REACHED' | 'NA';
interface Milestone {
  readonly code: GrowthEmployerMilestone; readonly state: MilestoneState; readonly at: string | null;
  readonly note?: string; readonly counts?: Readonly<Record<string, number>>;
}

/** The derived milestones of an employer lead (design §7.1), read from their source tables now. */
export async function employerMilestones(runner: Runner, lead: { readonly id: string; readonly organization_id: string | null }): Promise<readonly Milestone[]> {
  const one = async <T>(query: ReturnType<typeof sql>): Promise<T | undefined> => ((await runner.execute(query)) as QueryResult<T>).rows[0];
  const requested = await one<{ at: Date | null }>(sql`
    SELECT min(r.created_at) AS at FROM employer_access_request_leads el JOIN employer_access_requests r ON r.id = el.access_request_id
    WHERE el.lead_id = ${lead.id}::uuid`);
  const accessRequested: Milestone = { code: 'ACCESS_REQUESTED', state: requested?.at ? 'REACHED' : 'NOT_REACHED', at: iso(requested?.at ?? null) };
  const org = lead.organization_id;
  if (!org) {
    return [accessRequested, ...(['ONBOARDED', 'VERIFIED', 'TERMS_ACCEPTED', 'FIRST_JOB_PUBLISHED', 'CAMPUS_DRIVE', 'SUSPENDED'] as const)
      .map((code): Milestone => ({ code, state: 'NOT_REACHED', at: null }))];
  }
  const onboarded = await one<{ at: Date | null }>(sql`
    SELECT min(recorded_at) AS at FROM growth_employer_onboardings WHERE lead_id = ${lead.id}::uuid AND organization_id = ${org}::uuid`);
  const verification = await one<{ state: string; first_at: Date | null }>(sql`
    SELECT o.verification_state::text AS state,
           (SELECT min(e.occurred_at) FROM organization_verification_events e WHERE e.organization_id = o.id AND e.to_state::text = 'VERIFIED') AS first_at
    FROM organizations o WHERE o.id = ${org}::uuid`);
  const terms = await readEmployerTermsStatus(runner, org);
  const jobs = await one<{ first_at: Date | null; published_now: number }>(sql`
    SELECT min(published_at) AS first_at, count(*) FILTER (WHERE lifecycle_state = 'PUBLISHED')::int AS published_now
    FROM opportunities WHERE employer_id = ${org}::uuid`);
  const drives = await runner.execute(sql`
    SELECT state, count(*)::int AS n, min(created_at) AS first_at FROM campus_drives WHERE employer_id = ${org}::uuid GROUP BY state ORDER BY state
  `) as QueryResult<{ state: string; n: number; first_at: Date }>;
  const driveCounts = Object.fromEntries(drives.rows.map((row) => [row.state, Number(row.n)]));
  const firstDrive = drives.rows.map((row) => new Date(row.first_at).getTime()).sort((a, b) => a - b)[0];
  return [
    accessRequested,
    { code: 'ONBOARDED', state: onboarded?.at ? 'REACHED' : 'NOT_REACHED', at: iso(onboarded?.at ?? null) },
    { code: 'VERIFIED', state: verification?.first_at ? 'REACHED' : 'NOT_REACHED', at: iso(verification?.first_at ?? null) },
    terms.status === 'NO_TERMS_PUBLISHED'
      ? { code: 'TERMS_ACCEPTED', state: 'NA', at: null, note: 'No employer terms are published yet.' }
      : { code: 'TERMS_ACCEPTED', state: terms.status === 'ACCEPTED' ? 'REACHED' : 'NOT_REACHED', at: terms.status === 'ACCEPTED' ? terms.latestAcceptance?.acceptedAt ?? null : null },
    { code: 'FIRST_JOB_PUBLISHED', state: jobs?.first_at ? 'REACHED' : 'NOT_REACHED', at: iso(jobs?.first_at ?? null), counts: { PUBLISHED_NOW: Number(jobs?.published_now ?? 0) } },
    { code: 'CAMPUS_DRIVE', state: drives.rows.length ? 'REACHED' : 'NOT_REACHED', at: firstDrive === undefined ? null : new Date(firstDrive).toISOString(), counts: driveCounts },
    { code: 'SUSPENDED', state: verification?.state === 'SUSPENDED' ? 'REACHED' : 'NOT_REACHED', at: null },
  ];
}

/** The access requests linked to an employer lead, as a growth person may see them: time, state and whose referral — nothing the requester typed. */
export async function accessRequestsForLead(runner: Runner, leadId: string, viewerUserId: string): Promise<readonly Record<string, unknown>[]> {
  const found = await runner.execute(sql`
    SELECT r.created_at, r.state, rc.user_id AS referrer_user_id
    FROM employer_access_request_leads el
    JOIN employer_access_requests r ON r.id = el.access_request_id
    LEFT JOIN employer_access_request_referrals rr ON rr.access_request_id = r.id
    LEFT JOIN growth_referral_codes rc ON rc.id = rr.referral_code_id
    WHERE el.lead_id = ${leadId}::uuid ORDER BY r.created_at DESC, r.id DESC LIMIT 20
  `) as QueryResult<{ created_at: Date; state: string; referrer_user_id: string | null }>;
  return found.rows.map((row) => ({ receivedAt: iso(row.created_at), state: row.state, referral: growthReferralSeenBy(viewerUserId, row.referrer_user_id) }));
}
