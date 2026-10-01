/**
 * The lead register's reads and writes, shared by the growth person's routes and the Operations
 * growth-admin routes (GROWTH-03; design §5, §13).
 *
 * Why one module: both sides must apply the same scope (`growthScopePredicate`), the same masking
 * rule (only the owner sees contacts in full), the same duplicate disclosure rule and the same
 * history writes. The controllers decide who the caller is and which pure rule admits them; this
 * file does the SQL, in one transaction per write with its audit row and outbox event.
 *
 * Nothing here returns a student, an amount, or a contact's full email or phone to anyone but the
 * lead's owner (or through an audited reveal).
 *
 * Design: docs/architecture/growth-leads-table-design.md
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  GROWTH_CONTACT_NOTICE_VERSION,
  GROWTH_LEAD_CONTACT_LIMIT,
  growthDuplicateDisclosure,
  growthOwningMembership,
  growthTeamForLeadKind,
  isGrowthLeadStale,
  maskEmail,
  maskPhone,
  seesGrowthContactsInFull,
  type GrowthLeadCaller,
  type GrowthLeadFacts,
  type GrowthLeadKind,
  type GrowthScope,
} from '@planthepath/authorization/src/index.js';
import { growthScopePredicate, loadGrowthScope } from '@planthepath/persistence/src/growth-territories.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { badRequest, conflict, forbidden, iso, notFound, writeGrowthAudit, writeGrowthOutbox, type QueryResult } from './growth-http.js';

type Runner = Pick<PersistenceDb, 'execute'>;

export const GROWTH_LEAD_PAGE = 50;

export interface LeadRow {
  readonly id: string; readonly kind: GrowthLeadKind; readonly name: string; readonly state_code: string | null; readonly state_name: string | null;
  readonly district_code: number | null; readonly district_name: string | null; readonly city: string | null; readonly aishe_code: string | null;
  readonly website_domain: string | null; readonly owner_membership_id: string | null; readonly owner_email: string | null; readonly stage: string;
  readonly lost_reason_code: string | null; readonly source: string; readonly possible_duplicate: boolean; readonly do_not_contact_at: Date | null;
  readonly do_not_contact_reason: string | null; readonly organization_id: string | null; readonly created_at: Date; readonly last_activity_at: Date;
  readonly version: number; readonly live_contacts: number; readonly owner_left: boolean;
}

const leadColumns = sql`
  l.id, l.kind, l.name, l.state_code, s.name AS state_name, l.district_code, d.name AS district_name, l.city, l.aishe_code, l.website_domain,
  l.owner_membership_id, ou.email AS owner_email, l.stage, l.lost_reason_code, l.source, l.possible_duplicate, l.do_not_contact_at,
  l.do_not_contact_reason, l.organization_id, l.created_at, l.last_activity_at, l.version,
  (SELECT count(*)::int FROM growth_lead_contacts c WHERE c.lead_id = l.id AND c.removed_at IS NULL) AS live_contacts,
  (l.owner_membership_id IS NULL AND (SELECT h.reason_code FROM growth_lead_owner_history h WHERE h.lead_id = l.id
     ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1) = 'OWNER_LEFT') AS owner_left`;

const leadJoins = sql`
  LEFT JOIN growth_states s ON s.code = l.state_code
  LEFT JOIN growth_districts d ON d.lgd_code = l.district_code
  LEFT JOIN organization_memberships om ON om.id = l.owner_membership_id
  LEFT JOIN users ou ON ou.id = om.user_id`;

/** The caller as the pure rules see them: their scope, and their ACTIVE growth memberships with today's teams. */
export async function loadGrowthLeadCaller(runner: Runner, input: { readonly userId: string; readonly growthAdmin: boolean }): Promise<GrowthLeadCaller> {
  const scope = await loadGrowthScope(runner, input);
  const memberships = await runner.execute(sql`
    SELECT m.id, m.role, coalesce(array_agg(t.team) FILTER (WHERE t.team IS NOT NULL), '{}') AS teams
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    LEFT JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL
    WHERE m.user_id = ${input.userId}::uuid AND m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
    GROUP BY m.id, m.role
  `) as QueryResult<{ id: string; role: string; teams: string[] }>;
  return { scope, memberships: memberships.rows.map((row) => ({ membershipId: row.id, role: row.role, teams: row.teams })) };
}

/** The live regions covering an area today (the SQL twin of `regionsCoveringArea`). */
export async function regionsForArea(runner: Runner, stateCode: string | null, districtCode: number | null): Promise<readonly string[]> {
  if (!stateCode) return [];
  const found = await runner.execute(sql`
    SELECT DISTINCT region_id FROM growth_region_areas
    WHERE removed_at IS NULL AND state_code = ${stateCode} AND (district_code IS NULL OR district_code = ${districtCode})
    ORDER BY region_id
  `) as QueryResult<{ region_id: string }>;
  return found.rows.map((row) => row.region_id);
}

export function leadFacts(row: LeadRow, regionIds: readonly string[]): GrowthLeadFacts {
  return {
    kind: row.kind, ownerMembershipId: row.owner_membership_id, regionIds,
    doNotContact: row.do_not_contact_at !== null, open: row.stage !== 'LOST' && row.organization_id === null,
  };
}

/** One lead with its facts, optionally locked; null when it does not exist. */
export async function loadLead(runner: Runner, leadId: string, lock = false): Promise<{ readonly row: LeadRow; readonly facts: GrowthLeadFacts } | null> {
  if (lock) await runner.execute(sql`SELECT 1 FROM growth_leads WHERE id = ${leadId}::uuid FOR UPDATE`);
  const found = await runner.execute(sql`SELECT ${leadColumns} FROM growth_leads l ${leadJoins} WHERE l.id = ${leadId}::uuid`) as unknown as QueryResult<LeadRow>;
  const row = found.rows[0];
  if (!row) return null;
  const normalised = { ...row, district_code: row.district_code === null ? null : Number(row.district_code) };
  return { row: normalised, facts: leadFacts(normalised, await regionsForArea(runner, row.state_code, normalised.district_code)) };
}

export function leadSummaryDto(row: LeadRow, caller: GrowthLeadCaller | null, now: Date): Record<string, unknown> {
  const mine = caller !== null && row.owner_membership_id !== null && caller.memberships.some((membership) => membership.membershipId === row.owner_membership_id);
  return {
    id: row.id, kind: row.kind, name: row.name,
    area: { stateCode: row.state_code, stateName: row.state_name, districtCode: row.district_code === null ? null : Number(row.district_code), districtName: row.district_name, city: row.city },
    aisheCode: row.aishe_code, websiteDomain: row.website_domain,
    owner: row.owner_membership_id ? { email: row.owner_email, isMe: mine } : null,
    needsNewOwner: Boolean(row.owner_left),
    stage: row.stage, lostReasonCode: row.lost_reason_code, source: row.source, possibleDuplicate: row.possible_duplicate,
    doNotContact: row.do_not_contact_at ? { at: iso(row.do_not_contact_at), reasonCode: row.do_not_contact_reason } : null,
    handedOff: row.organization_id !== null,
    liveContacts: Number(row.live_contacts),
    createdAt: iso(row.created_at), lastActivityAt: iso(row.last_activity_at),
    stale: isGrowthLeadStale(new Date(row.last_activity_at), now),
    version: Number(row.version),
  };
}

export async function leadDetailDto(runner: Runner, loaded: { readonly row: LeadRow; readonly facts: GrowthLeadFacts }, caller: GrowthLeadCaller | null, now: Date): Promise<Record<string, unknown>> {
  const full = caller !== null && seesGrowthContactsInFull(caller, loaded.facts);
  const contacts = await runner.execute(sql`
    SELECT id, contact_role, full_name, email, phone, permission_basis, source, notice_given_at, notice_version, created_at
    FROM growth_lead_contacts WHERE lead_id = ${loaded.row.id}::uuid AND removed_at IS NULL ORDER BY created_at, id
  `) as QueryResult<{ id: string; contact_role: string; full_name: string; email: string | null; phone: string | null; permission_basis: string; source: string; notice_given_at: Date | null; notice_version: string | null; created_at: Date }>;
  const removedCount = await runner.execute(sql`
    SELECT count(*)::int AS n FROM growth_lead_contacts WHERE lead_id = ${loaded.row.id}::uuid AND removed_at IS NOT NULL
  `) as QueryResult<{ n: number }>;
  const owners = await runner.execute(sql`
    SELECT h.reason_code, h.occurred_at, fu.email AS from_email, tu.email AS to_email
    FROM growth_lead_owner_history h
    LEFT JOIN organization_memberships fm ON fm.id = h.from_membership_id LEFT JOIN users fu ON fu.id = fm.user_id
    LEFT JOIN organization_memberships tm ON tm.id = h.to_membership_id LEFT JOIN users tu ON tu.id = tm.user_id
    WHERE h.lead_id = ${loaded.row.id}::uuid ORDER BY h.occurred_at, h.id LIMIT 100
  `) as QueryResult<{ reason_code: string; occurred_at: Date; from_email: string | null; to_email: string | null }>;
  const stages = await runner.execute(sql`
    SELECT from_stage, to_stage, reason_code, occurred_at FROM growth_lead_stage_history WHERE lead_id = ${loaded.row.id}::uuid ORDER BY occurred_at, id LIMIT 100
  `) as QueryResult<{ from_stage: string | null; to_stage: string; reason_code: string | null; occurred_at: Date }>;
  return {
    ...leadSummaryDto(loaded.row, caller, now),
    contactsShownInFull: full,
    contacts: contacts.rows.map((contact) => ({
      id: contact.id, role: contact.contact_role, fullName: contact.full_name,
      email: full ? contact.email : maskEmail(contact.email), phone: full ? contact.phone : maskPhone(contact.phone),
      masked: !full, permissionBasis: contact.permission_basis, source: contact.source,
      notice: contact.notice_given_at ? { givenAt: iso(contact.notice_given_at), version: contact.notice_version } : null,
      addedAt: iso(contact.created_at),
    })),
    removedContacts: removedCount.rows[0]?.n ?? 0,
    ownerHistory: owners.rows.map((row) => ({ reasonCode: row.reason_code, at: iso(row.occurred_at), from: row.from_email, to: row.to_email })),
    stageHistory: stages.rows.map((row) => ({ from: row.from_stage, to: row.to_stage, reasonCode: row.reason_code, at: iso(row.occurred_at) })),
  };
}

export type LeadView = 'ALL' | 'MINE' | 'UNOWNED' | 'NEEDS_OWNER';

export function encodeLeadCursor(row: { readonly created_at: Date; readonly id: string }): string {
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeLeadCursor(value: unknown): { readonly createdAt: string; readonly id: string } | null {
  if (typeof value !== 'string' || !value || value.length > 200) return null;
  const [createdAt, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

/** A keyset page of leads in scope, newest first. */
export async function listLeads(runner: Runner, input: {
  readonly scope: GrowthScope; readonly caller: GrowthLeadCaller | null; readonly kind: GrowthLeadKind | null; readonly view: LeadView;
  readonly search: string | null; readonly cursor: { readonly createdAt: string; readonly id: string } | null; readonly now: Date;
}): Promise<{ readonly leads: readonly Record<string, unknown>[]; readonly nextCursor: string | null }> {
  const filters: SQL[] = [growthScopePredicate(input.scope, 'l')];
  if (input.kind) filters.push(sql`l.kind = ${input.kind}`);
  const mine = (input.caller?.memberships ?? []).map((membership) => sql`${membership.membershipId}::uuid`);
  if (input.view === 'MINE') filters.push(mine.length ? sql`l.owner_membership_id IN (${sql.join(mine, sql`, `)})` : sql`FALSE`);
  if (input.view === 'UNOWNED') filters.push(sql`l.owner_membership_id IS NULL AND l.organization_id IS NULL AND l.stage <> 'LOST'`);
  if (input.view === 'NEEDS_OWNER') {
    filters.push(sql`l.owner_membership_id IS NULL AND l.organization_id IS NULL AND l.stage <> 'LOST' AND (SELECT h.reason_code FROM growth_lead_owner_history h
      WHERE h.lead_id = l.id ORDER BY h.occurred_at DESC, h.id DESC LIMIT 1) = 'OWNER_LEFT'`);
  }
  if (input.search) filters.push(sql`l.name_normalized LIKE ${`%${input.search.toLowerCase().replace(/[^a-z0-9]/g, '')}%`}`);
  if (input.cursor) filters.push(sql`(l.created_at, l.id) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`);
  const found = await runner.execute(sql`
    SELECT ${leadColumns} FROM growth_leads l ${leadJoins}
    WHERE ${sql.join(filters, sql` AND `)}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${GROWTH_LEAD_PAGE + 1}
  `) as unknown as QueryResult<LeadRow>;
  const page = found.rows.slice(0, GROWTH_LEAD_PAGE);
  return {
    leads: page.map((row) => leadSummaryDto(row, input.caller, input.now)),
    nextCursor: found.rows.length > GROWTH_LEAD_PAGE ? encodeLeadCursor(page[page.length - 1]!) : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface WriteContext {
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly uuid: () => string;
}

async function audit(tx: Runner, ctx: WriteContext, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action, resourceType, resourceId, organizationId: ctx.organizationId, correlationId: ctx.correlationId, context });
}

async function outbox(tx: Runner, ctx: WriteContext, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType, aggregateId, eventType, payload, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
}

export interface NewLeadInput {
  readonly kind: GrowthLeadKind; readonly name: string; readonly stateCode: string | null; readonly districtCode: number | null; readonly city: string | null;
  readonly aisheCode: string | null; readonly websiteDomain: string | null; readonly source: string;
}

/**
 * Create (design §5.3, §5.4): refused as a duplicate, a do-not-contact organisation or an employer
 * already on ONE; the creator owns it through their matching team; history and audit written.
 * The duplicate answer names the existing owner only to someone who could see that lead.
 */
export async function createLead(tx: Runner, ctx: WriteContext, caller: GrowthLeadCaller, input: NewLeadInput): Promise<string> {
  const owner = growthOwningMembership(caller, input.kind);
  if (!owner) throw forbidden('GROWTH_TEAM_MISMATCH', ctx.correlationId);
  if (input.districtCode !== null) {
    const district = await tx.execute(sql`SELECT state_code FROM growth_districts WHERE lgd_code = ${input.districtCode}`) as QueryResult<{ state_code: string }>;
    if (!district.rows[0]) throw notFound('GROWTH_DISTRICT_NOT_FOUND', ctx.correlationId);
    if (district.rows[0].state_code !== input.stateCode) throw badRequest('GROWTH_DISTRICT_STATE_MISMATCH', ctx.correlationId);
  }
  // Serialise creates for the same identifier, so the duplicate answer below is the one the index gives.
  const identifier = input.kind === 'COLLEGE' ? input.aisheCode : input.websiteDomain;
  if (identifier) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`growth_lead:${input.kind}:${identifier}`}))`);
  if (identifier) {
    const existing = await tx.execute(sql`
      SELECT l.id, l.owner_membership_id, l.state_code, l.district_code, l.do_not_contact_at, ou.email AS owner_email
      FROM growth_leads l LEFT JOIN organization_memberships om ON om.id = l.owner_membership_id LEFT JOIN users ou ON ou.id = om.user_id
      WHERE l.kind = ${input.kind} AND (stage <> 'LOST' OR do_not_contact_at IS NOT NULL)
        AND ${input.kind === 'COLLEGE' ? sql`l.aishe_code = ${identifier}` : sql`l.website_domain = ${identifier}`}
      LIMIT 1
    `) as QueryResult<{ id: string; owner_membership_id: string | null; state_code: string | null; district_code: number | null; do_not_contact_at: Date | null; owner_email: string | null }>;
    const found = existing.rows[0];
    if (found) {
      if (found.do_not_contact_at) throw conflict('GROWTH_LEAD_DO_NOT_CONTACT', ctx.correlationId);
      const regionIds = await regionsForArea(tx, found.state_code, found.district_code === null ? null : Number(found.district_code));
      const named = growthDuplicateDisclosure(caller.scope, { ownerMembershipId: found.owner_membership_id, regionIds }) === 'NAMED';
      throw conflict('GROWTH_LEAD_DUPLICATE', ctx.correlationId, named
        ? { existing: { leadId: found.id, owner: found.owner_email ? { email: found.owner_email } : null } }
        : { existing: null, detail: 'Already registered by another team member — ask your manager.' });
    }
  }
  if (input.kind === 'EMPLOYER' && input.websiteDomain) {
    const onOne = await tx.execute(sql`
      SELECT 1 FROM organization_profiles p JOIN organizations o ON o.id = p.organization_id AND o.kind = 'EMPLOYER'
      WHERE p.website_url IS NOT NULL
        AND regexp_replace(regexp_replace(lower(split_part(regexp_replace(p.website_url, '^[a-zA-Z]+://', ''), '/', 1)), ':[0-9]+$', ''), '^www\\.', '') = ${input.websiteDomain}
      LIMIT 1
    `) as QueryResult<unknown>;
    if (onOne.rows.length) throw conflict('GROWTH_ORGANIZATION_ALREADY_ON_ONE', ctx.correlationId);
  }
  const possible = input.districtCode !== null ? await tx.execute(sql`
    SELECT 1 FROM growth_leads WHERE kind = ${input.kind} AND district_code = ${input.districtCode}
      AND name_normalized = ${input.name.toLowerCase().replace(/[^a-z0-9]/g, '')} AND (stage <> 'LOST' OR do_not_contact_at IS NOT NULL) LIMIT 1
  `) as QueryResult<unknown> : { rows: [] };
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_leads (id, kind, name, state_code, district_code, city, aishe_code, website_domain, owner_membership_id, source, possible_duplicate, created_by_user_id)
    VALUES (${id}::uuid, ${input.kind}, ${input.name}, ${input.stateCode}, ${input.districtCode}, ${input.city}, ${input.aisheCode}, ${input.websiteDomain},
            ${owner}::uuid, ${input.source}, ${possible.rows.length > 0}, ${ctx.actorUserId}::uuid)
  `);
  await tx.execute(sql`
    INSERT INTO growth_lead_owner_history (id, lead_id, from_membership_id, to_membership_id, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${id}::uuid, NULL, ${owner}::uuid, 'CREATED', ${ctx.actorUserId}::uuid)
  `);
  await tx.execute(sql`
    INSERT INTO growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${id}::uuid, NULL, 'IDENTIFIED', NULL, ${ctx.actorUserId}::uuid)
  `);
  await audit(tx, ctx, 'growth.lead.created', 'growth_lead', id, { kind: input.kind, source: input.source, ownerMembershipId: owner, possibleDuplicate: possible.rows.length > 0 });
  await outbox(tx, ctx, 'growth.lead.created', 'growth_lead', id, { leadId: id, kind: input.kind });
  return id;
}

export async function changeOwner(tx: Runner, ctx: WriteContext, input: {
  readonly leadId: string; readonly from: string | null; readonly to: string | null; readonly reasonCode: string; readonly eventType: 'growth.lead.claimed' | 'growth.lead.reassigned';
}): Promise<void> {
  await tx.execute(sql`UPDATE growth_leads SET owner_membership_id = ${input.to}::uuid, last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  await tx.execute(sql`
    INSERT INTO growth_lead_owner_history (id, lead_id, from_membership_id, to_membership_id, reason_code, actor_user_id)
    VALUES (${ctx.uuid()}::uuid, ${input.leadId}::uuid, ${input.from}::uuid, ${input.to}::uuid, ${input.reasonCode}, ${ctx.actorUserId}::uuid)
  `);
  await audit(tx, ctx, input.eventType, 'growth_lead', input.leadId, { fromMembershipId: input.from, toMembershipId: input.to, reasonCode: input.reasonCode });
  await outbox(tx, ctx, input.eventType, 'growth_lead', input.leadId, { leadId: input.leadId, reasonCode: input.reasonCode });
}

/** The target of a reassignment: an ACTIVE growth membership on the matching team (the trigger repeats it). */
export async function assertReassignTarget(tx: Runner, kind: GrowthLeadKind, membershipId: string, correlationId: string): Promise<void> {
  const found = await tx.execute(sql`
    SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = ${growthTeamForLeadKind(kind)}
    WHERE m.id = ${membershipId}::uuid AND m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
  `) as QueryResult<unknown>;
  if (!found.rows.length) throw badRequest('GROWTH_REASSIGN_TARGET_INVALID', correlationId);
}

export interface NewContactInput {
  readonly role: string; readonly fullName: string; readonly email: string | null; readonly phone: string | null;
  readonly permissionBasis: string; readonly source: string; readonly noticeGiven: boolean;
}

export async function addContact(tx: Runner, ctx: WriteContext, leadId: string, input: NewContactInput): Promise<string> {
  const count = await tx.execute(sql`SELECT count(*)::int AS n FROM growth_lead_contacts WHERE lead_id = ${leadId}::uuid AND removed_at IS NULL`) as QueryResult<{ n: number }>;
  if ((count.rows[0]?.n ?? 0) >= GROWTH_LEAD_CONTACT_LIMIT) throw conflict('GROWTH_CONTACT_LIMIT_REACHED', ctx.correlationId);
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_lead_contacts (id, lead_id, contact_role, full_name, email, phone, permission_basis, source,
                                      notice_given_at, notice_version, notice_recorded_by_user_id, added_by_user_id)
    VALUES (${id}::uuid, ${leadId}::uuid, ${input.role}, ${input.fullName}, ${input.email}, ${input.phone}, ${input.permissionBasis}, ${input.source},
            ${input.noticeGiven ? sql`now()` : sql`NULL`}, ${input.noticeGiven ? GROWTH_CONTACT_NOTICE_VERSION : null},
            ${input.noticeGiven ? sql`${ctx.actorUserId}::uuid` : sql`NULL`}, ${ctx.actorUserId}::uuid)
  `);
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${leadId}::uuid`);
  // The audit row records the act, never the person's details.
  await audit(tx, ctx, 'growth.lead_contact.added', 'growth_lead_contact', id, { leadId, role: input.role, permissionBasis: input.permissionBasis, source: input.source, noticeGiven: input.noticeGiven });
  await outbox(tx, ctx, 'growth.lead_contact.added', 'growth_lead_contact', id, { leadId, contactId: id });
  return id;
}

export async function recordNotice(tx: Runner, ctx: WriteContext, leadId: string, contactId: string): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE growth_lead_contacts SET notice_given_at = now(), notice_version = ${GROWTH_CONTACT_NOTICE_VERSION}, notice_recorded_by_user_id = ${ctx.actorUserId}::uuid
    WHERE id = ${contactId}::uuid AND lead_id = ${leadId}::uuid AND removed_at IS NULL AND notice_given_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  if (!updated.rows.length) {
    const exists = await tx.execute(sql`SELECT notice_given_at FROM growth_lead_contacts WHERE id = ${contactId}::uuid AND lead_id = ${leadId}::uuid AND removed_at IS NULL`) as QueryResult<{ notice_given_at: Date | null }>;
    if (!exists.rows[0]) throw notFound('GROWTH_CONTACT_NOT_FOUND', ctx.correlationId);
    throw conflict('GROWTH_NOTICE_ALREADY_RECORDED', ctx.correlationId);
  }
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${leadId}::uuid`);
  await audit(tx, ctx, 'growth.lead_contact.notice_recorded', 'growth_lead_contact', contactId, { leadId, noticeVersion: GROWTH_CONTACT_NOTICE_VERSION });
}

export async function removeContact(tx: Runner, ctx: WriteContext, leadId: string, contactId: string, reasonCode: string): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE growth_lead_contacts
    SET removed_at = now(), removed_by_user_id = ${ctx.actorUserId}::uuid, removed_reason_code = ${reasonCode}, full_name = NULL, email = NULL, phone = NULL
    WHERE id = ${contactId}::uuid AND lead_id = ${leadId}::uuid AND removed_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  if (!updated.rows.length) throw notFound('GROWTH_CONTACT_NOT_FOUND', ctx.correlationId);
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${leadId}::uuid`);
  await audit(tx, ctx, 'growth.lead_contact.removed', 'growth_lead_contact', contactId, { leadId, reasonCode });
  await outbox(tx, ctx, 'growth.lead_contact.removed', 'growth_lead_contact', contactId, { leadId, contactId, reasonCode });
}

/** The full values of one live contact, for an audited reveal. */
export async function revealContact(tx: Runner, ctx: WriteContext, leadId: string, contactId: string, reasonCode: string): Promise<Record<string, unknown>> {
  const found = await tx.execute(sql`
    SELECT full_name, email, phone FROM growth_lead_contacts WHERE id = ${contactId}::uuid AND lead_id = ${leadId}::uuid AND removed_at IS NULL
  `) as QueryResult<{ full_name: string; email: string | null; phone: string | null }>;
  const row = found.rows[0];
  if (!row) throw notFound('GROWTH_CONTACT_NOT_FOUND', ctx.correlationId);
  await audit(tx, ctx, 'growth.lead_contact.revealed', 'growth_lead_contact', contactId, { leadId, reasonCode, fields: [row.email ? 'email' : null, row.phone ? 'phone' : null].filter(Boolean) });
  return { contactId, fullName: row.full_name, email: row.email, phone: row.phone };
}

export async function setDoNotContact(tx: Runner, ctx: WriteContext, leadId: string, reasonCode: string): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE growth_leads SET do_not_contact_at = now(), do_not_contact_reason = ${reasonCode}, do_not_contact_by_user_id = ${ctx.actorUserId}::uuid, last_activity_at = now()
    WHERE id = ${leadId}::uuid AND do_not_contact_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  if (!updated.rows.length) throw conflict('GROWTH_LEAD_ALREADY_DO_NOT_CONTACT', ctx.correlationId);
  await audit(tx, ctx, 'growth.lead.do_not_contact_set', 'growth_lead', leadId, { reasonCode });
  await outbox(tx, ctx, 'growth.lead.do_not_contact_set', 'growth_lead', leadId, { leadId, reasonCode });
}

/** Counts for the Home and Territory pages: open leads the caller owns, and open unowned leads per region. */
export async function leadCounts(runner: Runner, caller: GrowthLeadCaller): Promise<{ readonly ownedOpen: number; readonly unownedByRegion: Readonly<Record<string, number>> }> {
  const mine = caller.memberships.map((membership) => sql`${membership.membershipId}::uuid`);
  const owned = mine.length ? await runner.execute(sql`
    SELECT count(*)::int AS n FROM growth_leads WHERE owner_membership_id IN (${sql.join(mine, sql`, `)}) AND organization_id IS NULL AND stage <> 'LOST'
  `) as QueryResult<{ n: number }> : { rows: [{ n: 0 }] };
  const regions = caller.scope.kind === 'PERSON' ? caller.scope.unownedLeadRegionIds : [];
  const unowned: Record<string, number> = {};
  if (regions.length) {
    const found = await runner.execute(sql`
      SELECT a.region_id, count(DISTINCT l.id)::int AS n
      FROM growth_leads l JOIN growth_region_areas a ON a.removed_at IS NULL AND a.state_code = l.state_code
        AND (a.district_code IS NULL OR a.district_code = l.district_code)
      WHERE l.owner_membership_id IS NULL AND l.organization_id IS NULL AND l.stage <> 'LOST' AND l.do_not_contact_at IS NULL
        AND a.region_id IN (${sql.join(regions.map((id) => sql`${id}::uuid`), sql`, `)})
      GROUP BY a.region_id
    `) as QueryResult<{ region_id: string; n: number }>;
    for (const region of regions) unowned[region] = 0;
    for (const row of found.rows) unowned[row.region_id] = row.n;
  }
  return { ownedOpen: owned.rows[0]?.n ?? 0, unownedByRegion: unowned };
}
