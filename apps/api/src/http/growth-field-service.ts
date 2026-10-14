/**
 * Growth field work: reads and writes for activities and follow-ups (GROWTH-06; design §14).
 *
 * Why one module: the growth person's routes and the Home counts must apply the same rule for who
 * sees a visit's location (its author and their manager, never anyone else), the same IST month
 * for "this month", and the same history writes. The controller decides who the caller is and
 * which pure rule admits them; this file does the SQL, one transaction per write with its audit
 * row, outbox event and idempotency record.
 *
 * Nothing here returns a student, an amount, or a location to anyone but its author and their
 * manager. Audit rows and events say whether a location was attached, never where.
 *
 * Design: docs/architecture/growth-field-work-table-design.md
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  GROWTH_FIELD_LIST_LIMIT,
  seesGrowthActivityLocation,
  type GrowthActivityKind,
  type GrowthLeadCaller,
  type GrowthLocationInput,
} from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { conflict, iso, notFound, writeGrowthAudit, writeGrowthOutbox, type QueryResult } from './growth-http.js';
import type { WriteContext } from './growth-leads-service.js';

type Runner = Pick<PersistenceDb, 'execute'>;

/** The start of the current IST calendar month, on the database clock. */
const istMonthStart = sql`(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const istToday = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

interface ActivityRow {
  readonly id: string; readonly lead_id: string; readonly lead_name: string; readonly lead_kind: string; readonly kind: string; readonly outcome: string | null;
  readonly contact_id: string | null; readonly contact_role: string | null; readonly contact_name: string | null;
  readonly notes: string | null; readonly notes_erased_at: Date | null; readonly author_membership_id: string; readonly author_email: string;
  readonly author_user_id: string; readonly occurred_at: Date; readonly received_at: Date;
  readonly location_latitude: string | null; readonly location_longitude: string | null; readonly location_accuracy_m: number | null;
  readonly location_erased_at: Date | null; readonly location_erased_reason: string | null;
}

const activityColumns = sql`
  a.id, a.lead_id, l.name AS lead_name, l.kind AS lead_kind, a.kind, a.outcome, a.contact_id, c.contact_role, c.full_name AS contact_name,
  a.notes, a.notes_erased_at, a.author_membership_id, au.email AS author_email, a.author_user_id, a.occurred_at, a.received_at,
  a.location_latitude, a.location_longitude, a.location_accuracy_m, a.location_erased_at, a.location_erased_reason`;
const activityJoins = sql`
  JOIN growth_leads l ON l.id = a.lead_id
  JOIN users au ON au.id = a.author_user_id
  LEFT JOIN growth_lead_contacts c ON c.id = a.contact_id`;

/** One activity as a caller may see it: the location only for its author and their manager. */
export function activityDto(row: ActivityRow, caller: GrowthLeadCaller): Record<string, unknown> {
  const mine = caller.memberships.some((membership) => membership.membershipId === row.author_membership_id);
  const dto: Record<string, unknown> = {
    id: row.id, leadId: row.lead_id, leadName: row.lead_name, leadKind: row.lead_kind, kind: row.kind, outcome: row.outcome,
    // An erased contact keeps its role and loses its name; the reference then names nobody.
    contact: row.contact_id ? { id: row.contact_id, role: row.contact_role, fullName: row.contact_name } : null,
    notes: row.notes, notesErased: row.notes_erased_at !== null,
    author: { email: row.author_email, isMe: mine },
    occurredAt: iso(row.occurred_at), receivedAt: iso(row.received_at),
  };
  if (seesGrowthActivityLocation(caller, row.author_membership_id)) {
    dto.location = row.location_latitude === null ? null : {
      latitude: Number(row.location_latitude), longitude: Number(row.location_longitude), accuracyM: Number(row.location_accuracy_m),
    };
    dto.locationRemoved = row.location_erased_reason ? { at: iso(row.location_erased_at), reasonCode: row.location_erased_reason } : null;
  }
  return dto;
}

interface FollowUpRow {
  readonly id: string; readonly lead_id: string; readonly lead_name: string; readonly lead_kind: string; readonly assignee_membership_id: string;
  readonly assignee_email: string; readonly activity_id: string | null; readonly due_on: string; readonly title: string | null;
  readonly title_erased_at: Date | null; readonly state: string; readonly created_at: Date; readonly closed_at: Date | null;
  readonly cancel_reason_code: string | null; readonly today: string;
}

const followUpColumns = sql`
  f.id, f.lead_id, l.name AS lead_name, l.kind AS lead_kind, f.assignee_membership_id, fu.email AS assignee_email, f.activity_id,
  to_char(f.due_on, 'YYYY-MM-DD') AS due_on, f.title, f.title_erased_at, f.state, f.created_at, f.closed_at, f.cancel_reason_code,
  to_char(${istToday}, 'YYYY-MM-DD') AS today`;
const followUpJoins = sql`
  JOIN growth_leads l ON l.id = f.lead_id
  JOIN organization_memberships fm ON fm.id = f.assignee_membership_id
  JOIN users fu ON fu.id = fm.user_id`;

export function followUpDto(row: FollowUpRow, caller: GrowthLeadCaller): Record<string, unknown> {
  const open = row.state === 'OPEN';
  return {
    id: row.id, leadId: row.lead_id, leadName: row.lead_name, leadKind: row.lead_kind,
    title: row.title, titleErased: row.title_erased_at !== null, dueOn: row.due_on, state: row.state,
    overdue: open && row.due_on < row.today, dueToday: open && row.due_on === row.today,
    assignee: { email: row.assignee_email, isMe: caller.memberships.some((membership) => membership.membershipId === row.assignee_membership_id) },
    activityId: row.activity_id, createdAt: iso(row.created_at), closedAt: iso(row.closed_at), cancelReasonCode: row.cancel_reason_code,
  };
}

export async function loadActivity(runner: Runner, activityId: string): Promise<ActivityRow | null> {
  const found = await runner.execute(sql`SELECT ${activityColumns} FROM growth_activities a ${activityJoins} WHERE a.id = ${activityId}::uuid`) as unknown as QueryResult<ActivityRow>;
  return found.rows[0] ?? null;
}

export async function loadFollowUp(runner: Runner, followUpId: string, lock = false): Promise<FollowUpRow | null> {
  if (lock) await runner.execute(sql`SELECT 1 FROM growth_follow_ups WHERE id = ${followUpId}::uuid FOR UPDATE`);
  const found = await runner.execute(sql`SELECT ${followUpColumns} FROM growth_follow_ups f ${followUpJoins} WHERE f.id = ${followUpId}::uuid`) as unknown as QueryResult<FollowUpRow>;
  return found.rows[0] ?? null;
}

/** A lead's activities and follow-ups, newest first, bounded. The caller has already been shown the lead. */
export async function leadFieldWork(runner: Runner, leadId: string, caller: GrowthLeadCaller): Promise<Record<string, unknown>> {
  const activities = await runner.execute(sql`
    SELECT ${activityColumns} FROM growth_activities a ${activityJoins}
    WHERE a.lead_id = ${leadId}::uuid ORDER BY a.received_at DESC, a.id DESC LIMIT ${GROWTH_FIELD_LIST_LIMIT}
  `) as unknown as QueryResult<ActivityRow>;
  const followUps = await runner.execute(sql`
    SELECT ${followUpColumns} FROM growth_follow_ups f ${followUpJoins}
    WHERE f.lead_id = ${leadId}::uuid ORDER BY (f.state = 'OPEN') DESC, f.due_on, f.created_at DESC, f.id LIMIT ${GROWTH_FIELD_LIST_LIMIT}
  `) as unknown as QueryResult<FollowUpRow>;
  return {
    activities: activities.rows.map((row) => activityDto(row, caller)),
    followUps: followUps.rows.map((row) => followUpDto(row, caller)),
  };
}

const membershipList = (ids: readonly string[]): SQL => ids.length ? sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`(NULL::uuid)`;

/** The memberships whose field work the caller sees on the Field page: their own, or (TEAM) their own and their reports'. */
export function fieldMemberships(caller: GrowthLeadCaller, view: 'MINE' | 'TEAM'): readonly string[] {
  const own = caller.memberships.map((membership) => membership.membershipId);
  if (view === 'MINE' || caller.scope.kind !== 'PERSON') return own;
  return [...new Set([...own, ...caller.scope.ownerMembershipIds])];
}

/** The Field page: open follow-ups, recent activities and this month's counts for the given memberships. */
export async function fieldPage(runner: Runner, caller: GrowthLeadCaller, memberships: readonly string[]): Promise<Record<string, unknown>> {
  const ids = membershipList(memberships);
  const followUps = await runner.execute(sql`
    SELECT ${followUpColumns} FROM growth_follow_ups f ${followUpJoins}
    WHERE f.state = 'OPEN' AND f.assignee_membership_id IN ${ids}
    ORDER BY f.due_on, f.created_at, f.id LIMIT ${GROWTH_FIELD_LIST_LIMIT}
  `) as unknown as QueryResult<FollowUpRow>;
  const activities = await runner.execute(sql`
    SELECT ${activityColumns} FROM growth_activities a ${activityJoins}
    WHERE a.author_membership_id IN ${ids} ORDER BY a.received_at DESC, a.id DESC LIMIT ${GROWTH_FIELD_LIST_LIMIT}
  `) as unknown as QueryResult<ActivityRow>;
  const counts = await runner.execute(sql`
    SELECT
      (SELECT count(*)::int FROM growth_activities WHERE author_membership_id IN ${ids} AND kind = 'VISIT' AND received_at >= ${istMonthStart}) AS visits,
      (SELECT count(*)::int FROM growth_activities WHERE author_membership_id IN ${ids} AND received_at >= ${istMonthStart}) AS activities,
      (SELECT count(*)::int FROM growth_activities WHERE author_membership_id IN ${ids} AND outcome = 'MET' AND received_at >= ${istMonthStart}) AS met,
      (SELECT count(*)::int FROM growth_follow_ups WHERE assignee_membership_id IN ${ids} AND state = 'OPEN' AND due_on < ${istToday}) AS overdue,
      (SELECT count(*)::int FROM growth_follow_ups WHERE assignee_membership_id IN ${ids} AND state = 'OPEN' AND due_on = ${istToday}) AS due_today,
      (SELECT count(*)::int FROM growth_follow_ups WHERE assignee_membership_id IN ${ids} AND state = 'OPEN') AS open,
      to_char(${istToday}, 'YYYY-MM-DD') AS today
  `) as QueryResult<{ visits: number; activities: number; met: number; overdue: number; due_today: number; open: number; today: string }>;
  const c = counts.rows[0]!;
  return {
    today: c.today,
    counts: {
      visitsThisMonth: c.visits, activitiesThisMonth: c.activities, metThisMonth: c.met,
      followUpsOverdue: c.overdue, followUpsDueToday: c.due_today, followUpsOpen: c.open,
    },
    followUps: followUps.rows.map((row) => followUpDto(row, caller)),
    activities: activities.rows.map((row) => activityDto(row, caller)),
  };
}

/** For `/me`: the caller's own visits this IST month and follow-ups due today or earlier. */
export async function myFieldCounts(runner: Runner, membershipIds: readonly string[]): Promise<{ readonly visitsThisMonth: number; readonly followUpsDue: number }> {
  const ids = membershipList(membershipIds);
  const found = await runner.execute(sql`
    SELECT
      (SELECT count(*)::int FROM growth_activities WHERE author_membership_id IN ${ids} AND kind = 'VISIT' AND received_at >= ${istMonthStart}) AS visits,
      (SELECT count(*)::int FROM growth_follow_ups WHERE assignee_membership_id IN ${ids} AND state = 'OPEN' AND due_on <= ${istToday}) AS due
  `) as QueryResult<{ visits: number; due: number }>;
  return { visitsThisMonth: found.rows[0]?.visits ?? 0, followUpsDue: found.rows[0]?.due ?? 0 };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function audit(tx: Runner, ctx: WriteContext, action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
  await writeGrowthAudit(tx, { id: ctx.uuid(), actorUserId: ctx.actorUserId, action, resourceType, resourceId, organizationId: ctx.organizationId, correlationId: ctx.correlationId, context });
}

async function outbox(tx: Runner, ctx: WriteContext, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
  await writeGrowthOutbox(tx, { id: ctx.uuid(), aggregateType, aggregateId, eventType, payload, actorUserId: ctx.actorUserId, organizationId: ctx.organizationId, correlationId: ctx.correlationId });
}

export interface NewActivityInput {
  readonly kind: GrowthActivityKind; readonly outcome: string | null; readonly contactId: string | null; readonly notes: string | null;
  readonly occurredAt: Date; readonly location: GrowthLocationInput | null;
}

export async function logActivity(tx: Runner, ctx: WriteContext, input: { readonly leadId: string; readonly authorMembershipId: string; readonly activity: NewActivityInput }): Promise<string> {
  const id = ctx.uuid();
  const a = input.activity;
  await tx.execute(sql`
    INSERT INTO growth_activities (id, lead_id, kind, outcome, contact_id, notes, author_membership_id, author_user_id, occurred_at,
                                   location_latitude, location_longitude, location_accuracy_m)
    VALUES (${id}::uuid, ${input.leadId}::uuid, ${a.kind}, ${a.outcome}, ${a.contactId}::uuid, ${a.notes}, ${input.authorMembershipId}::uuid,
            ${ctx.actorUserId}::uuid, ${a.occurredAt.toISOString()}::timestamptz,
            ${a.location?.latitude ?? null}, ${a.location?.longitude ?? null}, ${a.location?.accuracyM ?? null})
  `);
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  // Whether a location was attached, never where (design §14.3).
  await audit(tx, ctx, 'growth.activity.logged', 'growth_activity', id, { leadId: input.leadId, kind: a.kind, outcome: a.outcome, hasLocation: a.location !== null, hasContact: a.contactId !== null });
  await outbox(tx, ctx, 'growth.activity.logged', 'growth_activity', id, { activityId: id, leadId: input.leadId, kind: a.kind });
  return id;
}

export async function addFollowUp(tx: Runner, ctx: WriteContext, input: {
  readonly leadId: string; readonly assigneeMembershipId: string; readonly title: string; readonly dueOn: string; readonly activityId: string | null;
}): Promise<string> {
  const id = ctx.uuid();
  await tx.execute(sql`
    INSERT INTO growth_follow_ups (id, lead_id, assignee_membership_id, created_by_user_id, activity_id, due_on, title)
    VALUES (${id}::uuid, ${input.leadId}::uuid, ${input.assigneeMembershipId}::uuid, ${ctx.actorUserId}::uuid, ${input.activityId}::uuid, ${input.dueOn}::date, ${input.title})
  `);
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  await audit(tx, ctx, 'growth.follow_up.created', 'growth_follow_up', id, { leadId: input.leadId, dueOn: input.dueOn, assigneeMembershipId: input.assigneeMembershipId });
  await outbox(tx, ctx, 'growth.follow_up.created', 'growth_follow_up', id, { followUpId: id, leadId: input.leadId });
  return id;
}

export async function closeFollowUp(tx: Runner, ctx: WriteContext, input: {
  readonly followUpId: string; readonly leadId: string; readonly state: 'DONE' | 'CANCELLED'; readonly reasonCode: string | null;
}): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE growth_follow_ups SET state = ${input.state}, closed_at = now(), closed_by_user_id = ${ctx.actorUserId}::uuid, cancel_reason_code = ${input.reasonCode}
    WHERE id = ${input.followUpId}::uuid AND state = 'OPEN' RETURNING id
  `) as QueryResult<{ id: string }>;
  if (!updated.rows.length) throw conflict('GROWTH_FOLLOW_UP_ALREADY_CLOSED', ctx.correlationId);
  await tx.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id = ${input.leadId}::uuid`);
  await audit(tx, ctx, `growth.follow_up.${input.state === 'DONE' ? 'completed' : 'cancelled'}`, 'growth_follow_up', input.followUpId, { leadId: input.leadId, state: input.state, reasonCode: input.reasonCode });
  await outbox(tx, ctx, 'growth.follow_up.closed', 'growth_follow_up', input.followUpId, { followUpId: input.followUpId, leadId: input.leadId, state: input.state });
}

export async function removeActivityLocation(tx: Runner, ctx: WriteContext, activityId: string): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE growth_activities SET location_latitude = NULL, location_longitude = NULL, location_accuracy_m = NULL,
      location_erased_at = now(), location_erased_reason = 'AUTHOR_REMOVED'
    WHERE id = ${activityId}::uuid AND location_latitude IS NOT NULL RETURNING lead_id
  `) as QueryResult<{ lead_id: string }>;
  if (!updated.rows.length) throw notFound('GROWTH_ACTIVITY_LOCATION_NOT_HELD', ctx.correlationId);
  await audit(tx, ctx, 'growth.activity.location_removed', 'growth_activity', activityId, { leadId: updated.rows[0]!.lead_id, reasonCode: 'AUTHOR_REMOVED' });
  await outbox(tx, ctx, 'growth.activity.location_removed', 'growth_activity', activityId, { activityId, reasonCode: 'AUTHOR_REMOVED' });
}
