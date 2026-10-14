/**
 * Quarterly internal access reviews (OPS-15, migration 0079).
 *
 * Why this exists: privileged access has to be reviewed on a schedule, with evidence. A
 * campaign freezes every standing internal access — each ACTIVE platform membership and
 * each live internal or faculty-review capability grant — into items; a reviewer decides
 * KEEP or REVOKE on each with a reason code; a REVOKE takes effect in the same
 * transaction through the same statements the capability screens use, and its audit rows
 * carry the campaign reference. The pure rules live in packages/authorization
 * (access-reviews.ts); the 0079 triggers repeat them.
 *
 * Design: docs/architecture/access-review-campaigns-table-design.md
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  accessReviewHighRisk,
  accessReviewRevocationReason,
  effectiveInternalCapabilities,
  type AccessReviewDecision,
  type AccessReviewDecisionOutcome,
  type AccessReviewItemKind,
  type AccessReviewMode,
  type AccessReviewRefusal,
} from '@planthepath/authorization/src/index.js';
import { revokeInternalCapabilityWithin } from './platform-controls.js';
import { revokeExternalReviewerWithin } from './external-reviews.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

export type AccessReviewErrorCode =
  | AccessReviewRefusal
  | 'ACCESS_REVIEW_NOT_FOUND'
  | 'ACCESS_REVIEW_ALREADY_OPEN'
  | 'ACCESS_REVIEW_UNDECIDED_ITEMS'
  | 'ACCESS_REVIEW_REJECTED';

export class AccessReviewError extends Error {
  constructor(readonly code: AccessReviewErrorCode) {
    super(code);
    this.name = 'AccessReviewError';
  }
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AccessReviewPerson { readonly userId: string; readonly email: string }

export interface AccessReviewCampaignView {
  readonly id: string;
  readonly periodLabel: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly openedBy: AccessReviewPerson;
  readonly openedAt: string;
  readonly dueAt: string;
  readonly openReasonCode: string;
  readonly openNote: string | null;
  readonly itemCount: number;
  readonly closedBy: AccessReviewPerson | null;
  readonly closedAt: string | null;
  readonly closeReasonCode: string | null;
  readonly counts: { readonly decided: number; readonly kept: number; readonly revoked: number; readonly solo: number; readonly highRisk: number };
}

interface CampaignRow {
  id: string; period_label: string; state: 'OPEN' | 'CLOSED'; opened_by_user_id: string; opened_by_email: string;
  opened_at: Date; due_at: Date; open_reason_code: string; open_note: string | null; item_count: number;
  closed_by_user_id: string | null; closed_by_email: string | null; closed_at: Date | null; close_reason_code: string | null;
  decided: number; kept: number; revoked: number; solo: number; high_risk: number; opened_at_cursor: string;
}

const campaignSelect = `
  SELECT c.id, c.period_label, c.state, c.opened_by_user_id, ou.email AS opened_by_email, c.opened_at, c.due_at,
         c.open_reason_code, c.open_note, c.item_count, c.closed_by_user_id, cu.email AS closed_by_email, c.closed_at,
         c.close_reason_code,
         -- Microsecond precision for the keyset cursor: a millisecond one could repeat rows.
         to_char(c.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_at_cursor,
         (SELECT count(*)::int FROM access_review_items i WHERE i.campaign_id = c.id AND i.decision IS NOT NULL) AS decided,
         (SELECT count(*)::int FROM access_review_items i WHERE i.campaign_id = c.id AND i.decision = 'KEEP') AS kept,
         (SELECT count(*)::int FROM access_review_items i WHERE i.campaign_id = c.id AND i.decision = 'REVOKE') AS revoked,
         (SELECT count(*)::int FROM access_review_items i WHERE i.campaign_id = c.id AND i.solo) AS solo,
         (SELECT count(*)::int FROM access_review_items i WHERE i.campaign_id = c.id AND i.high_risk) AS high_risk
  FROM access_review_campaigns c
  JOIN users ou ON ou.id = c.opened_by_user_id
  LEFT JOIN users cu ON cu.id = c.closed_by_user_id`;

function mapCampaign(row: CampaignRow): AccessReviewCampaignView {
  return {
    id: row.id,
    periodLabel: row.period_label,
    state: row.state,
    openedBy: { userId: row.opened_by_user_id, email: row.opened_by_email },
    openedAt: iso(row.opened_at)!,
    dueAt: iso(row.due_at)!,
    openReasonCode: row.open_reason_code,
    openNote: row.open_note,
    itemCount: row.item_count,
    closedBy: row.closed_by_user_id && row.closed_by_email ? { userId: row.closed_by_user_id, email: row.closed_by_email } : null,
    closedAt: iso(row.closed_at),
    closeReasonCode: row.close_reason_code,
    counts: { decided: row.decided, kept: row.kept, revoked: row.revoked, solo: row.solo, highRisk: row.high_risk },
  };
}

type Queryable = Pool | PoolClient;

export async function loadAccessReviewCampaign(client: Queryable, campaignId: string): Promise<AccessReviewCampaignView | null> {
  const result = await client.query<CampaignRow>(`${campaignSelect} WHERE c.id = $1`, [campaignId]);
  return result.rows[0] ? mapCampaign(result.rows[0]) : null;
}

/** Where the programme stands: reviewers, the open campaign, the last closed one, and the database clock. */
export async function accessReviewOverview(pool: Pool): Promise<{
  readonly reviewerCount: number; readonly now: string;
  readonly open: AccessReviewCampaignView | null; readonly lastClosed: AccessReviewCampaignView | null;
}> {
  const meta = await pool.query<{ reviewers: number; now: Date }>('SELECT access_review_reviewer_count() AS reviewers, now() AS now');
  const open = await pool.query<CampaignRow>(`${campaignSelect} WHERE c.state = 'OPEN' LIMIT 1`);
  const closed = await pool.query<CampaignRow>(`${campaignSelect} WHERE c.state = 'CLOSED' ORDER BY c.closed_at DESC, c.id DESC LIMIT 1`);
  return {
    reviewerCount: meta.rows[0]!.reviewers,
    now: iso(meta.rows[0]!.now)!,
    open: open.rows[0] ? mapCampaign(open.rows[0]) : null,
    lastClosed: closed.rows[0] ? mapCampaign(closed.rows[0]) : null,
  };
}

/** Every campaign, newest first, keyset-paginated on (opened_at, id). */
export async function listAccessReviewCampaigns(pool: Pool, input: {
  readonly limit: number; readonly cursor?: { readonly openedAt: string; readonly id: string };
}): Promise<{ readonly campaigns: readonly AccessReviewCampaignView[]; readonly nextCursor: { readonly openedAt: string; readonly id: string } | null }> {
  const result = await pool.query<CampaignRow>(
    `SELECT * FROM (${campaignSelect}) x
     WHERE ($1::timestamptz IS NULL OR (x.opened_at, x.id) < ($1::timestamptz, $2::uuid))
     ORDER BY x.opened_at DESC, x.id DESC LIMIT $3`,
    [input.cursor?.openedAt ?? null, input.cursor?.id ?? null, input.limit + 1],
  );
  const page = result.rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const nextCursor = result.rows.length > input.limit && last ? { openedAt: last.opened_at_cursor, id: last.id } : null;
  return { campaigns: page.map(mapCampaign), nextCursor };
}

export interface AccessReviewItemView {
  readonly id: string;
  readonly campaignId: string;
  readonly position: number;
  readonly kind: AccessReviewItemKind;
  readonly membershipId: string;
  readonly subject: AccessReviewPerson;
  readonly organizationName: string;
  readonly organizationKind: string;
  readonly role: string;
  readonly membershipState: string;
  readonly capability: string | null;
  readonly capabilities: readonly string[];
  readonly highRisk: boolean;
  readonly grantedBy: AccessReviewPerson | null;
  readonly grantedAt: string;
  readonly grantReasonCode: string | null;
  readonly decision: AccessReviewDecision | null;
  readonly decisionReasonCode: string | null;
  readonly decisionNote: string | null;
  readonly decidedBy: AccessReviewPerson | null;
  readonly decidedAt: string | null;
  readonly mode: AccessReviewMode | null;
  readonly revocationOutcome: 'APPLIED' | 'ALREADY_ENDED' | null;
}

interface ItemRow {
  id: string; campaign_id: string; position: number; item_kind: AccessReviewItemKind; membership_id: string;
  subject_user_id: string; subject_email: string; organization_name: string; organization_kind: string; role: string;
  membership_state: string; capability: string | null; capabilities_snapshot: string[]; high_risk: boolean;
  granted_by_user_id: string | null; granted_by_email: string | null; granted_at: Date; grant_reason_code: string | null;
  decision: AccessReviewDecision | null; decision_reason_code: string | null; decision_note: string | null;
  decided_by_user_id: string | null; decided_by_email: string | null; decided_at: Date | null; solo: boolean;
  revocation_outcome: 'APPLIED' | 'ALREADY_ENDED' | null;
}

const itemSelect = `
  SELECT i.id, i.campaign_id, i.position, i.item_kind, i.membership_id, i.subject_user_id, su.email AS subject_email,
         o.legal_name AS organization_name, o.kind::text AS organization_kind, i.role, i.membership_state, i.capability,
         i.capabilities_snapshot, i.high_risk, i.granted_by_user_id, gu.email AS granted_by_email, i.granted_at,
         i.grant_reason_code, i.decision, i.decision_reason_code, i.decision_note, i.decided_by_user_id,
         du.email AS decided_by_email, i.decided_at, i.solo, i.revocation_outcome
  FROM access_review_items i
  JOIN users su ON su.id = i.subject_user_id
  JOIN organizations o ON o.id = i.organization_id
  LEFT JOIN users gu ON gu.id = i.granted_by_user_id
  LEFT JOIN users du ON du.id = i.decided_by_user_id`;

function mapItem(row: ItemRow): AccessReviewItemView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    position: row.position,
    kind: row.item_kind,
    membershipId: row.membership_id,
    subject: { userId: row.subject_user_id, email: row.subject_email },
    organizationName: row.organization_name,
    organizationKind: row.organization_kind,
    role: row.role,
    membershipState: row.membership_state,
    capability: row.capability,
    capabilities: row.capabilities_snapshot,
    highRisk: row.high_risk,
    grantedBy: row.granted_by_user_id && row.granted_by_email ? { userId: row.granted_by_user_id, email: row.granted_by_email } : null,
    grantedAt: iso(row.granted_at)!,
    grantReasonCode: row.grant_reason_code,
    decision: row.decision,
    decisionReasonCode: row.decision_reason_code,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by_user_id && row.decided_by_email ? { userId: row.decided_by_user_id, email: row.decided_by_email } : null,
    decidedAt: iso(row.decided_at),
    mode: row.decision ? (row.solo ? 'SOLO' : 'DUAL') : null,
    revocationOutcome: row.revocation_outcome,
  };
}

/** One page of a campaign's items in snapshot order, keyset-paginated on position. */
export async function listAccessReviewItems(pool: Pool, input: {
  readonly campaignId: string; readonly limit: number; readonly afterPosition?: number; readonly filter?: 'UNDECIDED' | 'DECIDED';
}): Promise<{ readonly items: readonly AccessReviewItemView[]; readonly nextPosition: number | null }> {
  const result = await pool.query<ItemRow>(
    `${itemSelect}
     WHERE i.campaign_id = $1 AND i.position > $2
       AND ($3::text IS NULL OR ($3 = 'UNDECIDED' AND i.decision IS NULL) OR ($3 = 'DECIDED' AND i.decision IS NOT NULL))
     ORDER BY i.position LIMIT $4`,
    [input.campaignId, input.afterPosition ?? 0, input.filter ?? null, input.limit + 1],
  );
  const page = result.rows.slice(0, input.limit).map(mapItem);
  return { items: page, nextPosition: result.rows.length > input.limit && page.length ? page[page.length - 1]!.position : null };
}

/** Every item of a campaign, in snapshot order: the export. */
export async function loadAllAccessReviewItems(client: Queryable, campaignId: string): Promise<readonly AccessReviewItemView[]> {
  const result = await client.query<ItemRow>(`${itemSelect} WHERE i.campaign_id = $1 ORDER BY i.position`, [campaignId]);
  return result.rows.map(mapItem);
}

// ---------------------------------------------------------------------------
// Audit and outbox
// ---------------------------------------------------------------------------

async function writeAudit(client: PoolClient, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string | null; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, correlationId: input.correlationId });
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',$7,$8::jsonb)`,
    [id, input.actorUserId, input.action, input.resourceType, input.resourceId, input.organizationId, input.correlationId, JSON.stringify(input.context)],
  );
}

async function writeOutbox(client: PoolClient, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly organizationId: string | null; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({
    id, aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, eventVersion: 1,
    payload: input.payload, actorUserId: input.actorUserId, ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    correlationId: input.correlationId,
  });
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
     VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8)`,
    [id, input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload), input.actorUserId, input.organizationId, input.correlationId],
  );
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof AccessReviewError) throw error;
    const code = (error as { code?: string } | null)?.code;
    if (code === '23505') throw new AccessReviewError('ACCESS_REVIEW_ALREADY_OPEN');
    // Never forward database text; a trigger refusal means "not allowed as asked".
    throw new AccessReviewError('ACCESS_REVIEW_REJECTED');
  } finally {
    client.release();
  }
}

async function platformOrganizationId(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ id: string }>("SELECT id FROM organizations WHERE kind = 'PLATFORM' ORDER BY created_at, id LIMIT 1");
  return result.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Open: freeze the snapshot
// ---------------------------------------------------------------------------

interface SnapshotItem {
  readonly kind: AccessReviewItemKind;
  readonly membershipId: string;
  readonly subjectUserId: string;
  readonly subjectEmail: string;
  readonly organizationId: string;
  readonly organizationKind: string;
  readonly role: string;
  readonly membershipState: string;
  readonly capability: string | null;
  readonly grantId: string | null;
  readonly capabilities: readonly string[];
  readonly grantedByUserId: string | null;
  readonly grantedAt: Date;
  readonly grantReasonCode: string | null;
}

/** Every standing internal access, as it is now, in a stable order. */
async function readSnapshot(client: PoolClient): Promise<readonly SnapshotItem[]> {
  const roles = await client.query<{
    membership_id: string; user_id: string; email: string; organization_id: string; role: string; state: string;
    created_at: Date; invited_by: string | null; grants: string[];
  }>(`
    SELECT m.id AS membership_id, m.user_id, u.email, m.organization_id, m.role, m.state::text AS state, m.created_at,
           (SELECT i.invited_by_user_id FROM invitations i
             WHERE i.organization_id = m.organization_id AND i.accepted_by_user_id = m.user_id AND i.role = m.role
               AND i.state = 'ACCEPTED'
             ORDER BY i.accepted_at DESC NULLS LAST, i.id LIMIT 1) AS invited_by,
           COALESCE(array_agg(c.capability ORDER BY c.capability) FILTER (WHERE c.id IS NOT NULL), '{}') AS grants
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id
    LEFT JOIN membership_capabilities c ON c.membership_id = m.id AND c.revoked_at IS NULL AND c.capability <> 'INSTITUTION_ANALYTICS'
    WHERE m.state = 'ACTIVE'
    GROUP BY m.id, u.email`);
  const grants = await client.query<{
    grant_id: string; membership_id: string; user_id: string; email: string; organization_id: string; organization_kind: string;
    role: string; state: string; capability: string; granted_by_user_id: string; granted_at: Date; reason_code: string;
  }>(`
    SELECT c.id AS grant_id, m.id AS membership_id, m.user_id, u.email, m.organization_id, o.kind::text AS organization_kind,
           m.role, m.state::text AS state, c.capability, c.granted_by_user_id, c.granted_at, c.reason_code
    FROM membership_capabilities c
    JOIN organization_memberships m ON m.id = c.membership_id
    JOIN organizations o ON o.id = m.organization_id
    JOIN users u ON u.id = m.user_id
    WHERE c.revoked_at IS NULL
      AND ((o.kind = 'PLATFORM' AND c.capability <> 'INSTITUTION_ANALYTICS') OR c.capability = 'CONTENT_REVIEW_EXTERNAL')`);
  const items: SnapshotItem[] = [
    ...roles.rows.map((row): SnapshotItem => ({
      kind: 'PLATFORM_ROLE', membershipId: row.membership_id, subjectUserId: row.user_id, subjectEmail: row.email,
      organizationId: row.organization_id, organizationKind: 'PLATFORM', role: row.role, membershipState: row.state,
      capability: null, grantId: null, capabilities: effectiveInternalCapabilities(row.role, row.grants),
      grantedByUserId: row.invited_by, grantedAt: row.created_at, grantReasonCode: null,
    })),
    ...grants.rows.map((row): SnapshotItem => ({
      kind: 'CAPABILITY_GRANT', membershipId: row.membership_id, subjectUserId: row.user_id, subjectEmail: row.email,
      organizationId: row.organization_id, organizationKind: row.organization_kind, role: row.role, membershipState: row.state,
      capability: row.capability, grantId: row.grant_id, capabilities: [row.capability],
      grantedByUserId: row.granted_by_user_id, grantedAt: row.granted_at, grantReasonCode: row.reason_code,
    })),
  ];
  // Platform staff first, then faculty; by person; the role before its grants.
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return items.sort((a, b) =>
    compare(a.organizationKind === 'PLATFORM' ? '0' : '1', b.organizationKind === 'PLATFORM' ? '0' : '1')
    || compare(a.subjectEmail.toLowerCase(), b.subjectEmail.toLowerCase())
    || compare(a.membershipId, b.membershipId)
    || compare(a.kind === 'PLATFORM_ROLE' ? '0' : '1', b.kind === 'PLATFORM_ROLE' ? '0' : '1')
    || compare(a.capability ?? '', b.capability ?? ''));
}

export async function openAccessReviewCampaign(pool: Pool, input: {
  readonly actorUserId: string; readonly reasonCode: string; readonly note: string | null; readonly correlationId: string;
}): Promise<AccessReviewCampaignView> {
  return inTransaction(pool, async (client) => {
    const open = await client.query("SELECT 1 FROM access_review_campaigns WHERE state = 'OPEN' LIMIT 1");
    if (open.rowCount) throw new AccessReviewError('ACCESS_REVIEW_ALREADY_OPEN');
    const snapshot = await readSnapshot(client);
    const campaignId = randomUUID();
    await client.query(
      `INSERT INTO access_review_campaigns (id, opened_by_user_id, open_reason_code, open_note, open_correlation_id, item_count)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [campaignId, input.actorUserId, input.reasonCode, input.note, input.correlationId, snapshot.length],
    );
    let position = 0;
    for (const item of snapshot) {
      position += 1;
      await client.query(
        `INSERT INTO access_review_items (id, campaign_id, position, item_kind, membership_id, subject_user_id, organization_id, role,
           membership_state, capability, capability_grant_id, capabilities_snapshot, high_risk, granted_by_user_id, granted_at, grant_reason_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,$14,$15,$16)`,
        [randomUUID(), campaignId, position, item.kind, item.membershipId, item.subjectUserId, item.organizationId, item.role,
          item.membershipState, item.capability, item.grantId, [...item.capabilities], accessReviewHighRisk(item.capabilities),
          item.grantedByUserId, item.grantedAt, item.grantReasonCode],
      );
    }
    const organizationId = await platformOrganizationId(client);
    const roleItems = snapshot.filter((item) => item.kind === 'PLATFORM_ROLE').length;
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'operations.access_review.opened', resourceType: 'access_review_campaign', resourceId: campaignId,
      organizationId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, itemCount: snapshot.length, roleItems, grantItems: snapshot.length - roleItems, ...(input.note ? { note: input.note } : {}) },
    });
    await writeOutbox(client, {
      aggregateType: 'access_review_campaign', aggregateId: campaignId, eventType: 'access_review.opened', payload: { campaignId },
      actorUserId: input.actorUserId, organizationId, correlationId: input.correlationId,
    });
    return (await loadAccessReviewCampaign(client, campaignId))!;
  });
}

// ---------------------------------------------------------------------------
// Decide: record, and apply a revocation in the same transaction
// ---------------------------------------------------------------------------

export interface AccessReviewDecisionContext {
  readonly campaign: { readonly state: string; readonly openedAt: string };
  readonly item: { readonly subjectUserId: string; readonly decided: boolean };
  readonly reviewerCount: number;
  /** The database clock. */
  readonly now: string;
}

export async function decideAccessReviewItemRecord(pool: Pool, input: {
  readonly campaignId: string; readonly itemId: string; readonly decision: AccessReviewDecision;
  readonly reasonCode: string; readonly note: string | null; readonly actorUserId: string; readonly correlationId: string;
  /** The pure rule, evaluated against the locked rows and the database clock. */
  readonly decide: (context: AccessReviewDecisionContext) => AccessReviewDecisionOutcome;
  /** The pure last-super-admin rule for a role revocation. */
  readonly refuseRoleRevocation: (target: { readonly targetRole: string; readonly targetState: string; readonly activeSuperAdmins: number }) => AccessReviewRefusal | null;
}): Promise<AccessReviewItemView> {
  return inTransaction(pool, async (client) => {
    const campaign = await client.query<{ state: string; opened_at: Date; period_label: string }>(
      'SELECT state, opened_at, period_label FROM access_review_campaigns WHERE id = $1 FOR SHARE', [input.campaignId],
    );
    const item = await client.query<{
      subject_user_id: string; decision: string | null; item_kind: AccessReviewItemKind; membership_id: string;
      organization_id: string; role: string; capability: string | null; capability_grant_id: string | null;
    }>(
      `SELECT subject_user_id, decision, item_kind, membership_id, organization_id, role, capability, capability_grant_id
       FROM access_review_items WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [input.itemId, input.campaignId],
    );
    const campaignRow = campaign.rows[0];
    const itemRow = item.rows[0];
    if (!campaignRow || !itemRow) throw new AccessReviewError('ACCESS_REVIEW_NOT_FOUND');
    const meta = await client.query<{ reviewers: number; now: Date }>('SELECT access_review_reviewer_count() AS reviewers, now() AS now');
    const outcome = input.decide({
      campaign: { state: campaignRow.state, openedAt: iso(campaignRow.opened_at)! },
      item: { subjectUserId: itemRow.subject_user_id, decided: itemRow.decision !== null },
      reviewerCount: meta.rows[0]!.reviewers,
      now: iso(meta.rows[0]!.now)!,
    });
    if (!outcome.allowed) throw new AccessReviewError(outcome.refusal);

    const accessReview = { campaignId: input.campaignId, itemId: input.itemId, periodLabel: campaignRow.period_label, decisionReasonCode: input.reasonCode };
    let revocationOutcome: 'APPLIED' | 'ALREADY_ENDED' | null = null;
    if (input.decision === 'REVOKE') {
      revocationOutcome = itemRow.item_kind === 'PLATFORM_ROLE'
        ? await suspendPlatformMembership(client, { ...input, membershipId: itemRow.membership_id, accessReview })
        : await revokeGrant(client, {
          ...input, membershipId: itemRow.membership_id, capability: itemRow.capability!, grantId: itemRow.capability_grant_id!, accessReview,
        });
    }

    await client.query(
      `UPDATE access_review_items
       SET decision = $3, decision_reason_code = $4, decision_note = $5, decided_by_user_id = $6, decision_correlation_id = $7,
           solo = $8, revocation_outcome = $9, decided_at = now()
       WHERE id = $1 AND campaign_id = $2`,
      [input.itemId, input.campaignId, input.decision, input.reasonCode, input.note, input.actorUserId, input.correlationId,
        outcome.mode === 'SOLO', revocationOutcome],
    );
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'operations.access_review.item_decided', resourceType: 'access_review_item', resourceId: input.itemId,
      organizationId: itemRow.organization_id, correlationId: input.correlationId,
      context: {
        campaignId: input.campaignId, periodLabel: campaignRow.period_label, decision: input.decision, reasonCode: input.reasonCode,
        mode: outcome.mode, itemKind: itemRow.item_kind, targetUserId: itemRow.subject_user_id, targetRole: itemRow.role,
        ...(itemRow.capability ? { capability: itemRow.capability } : {}),
        ...(revocationOutcome ? { revocationOutcome } : {}), ...(input.note ? { note: input.note } : {}),
      },
    });
    await writeOutbox(client, {
      aggregateType: 'access_review_campaign', aggregateId: input.campaignId, eventType: 'access_review.item_decided',
      payload: { campaignId: input.campaignId, itemId: input.itemId, decision: input.decision, mode: outcome.mode },
      actorUserId: input.actorUserId, organizationId: itemRow.organization_id, correlationId: input.correlationId,
    });
    const [view] = (await client.query<ItemRow>(`${itemSelect} WHERE i.id = $1`, [input.itemId])).rows.map(mapItem);
    return view!;
  });
}

/** A live grant the snapshot named: revoked through the shared capability statements. */
async function revokeGrant(client: PoolClient, input: {
  readonly membershipId: string; readonly capability: string; readonly grantId: string; readonly actorUserId: string;
  readonly correlationId: string; readonly note: string | null; readonly accessReview: Record<string, unknown>;
}): Promise<'APPLIED' | 'ALREADY_ENDED'> {
  const target = await client.query<{ user_id: string; role: string; organization_id: string; live: boolean }>(
    `SELECT m.user_id, m.role, m.organization_id,
            EXISTS (SELECT 1 FROM membership_capabilities c WHERE c.id = $2 AND c.revoked_at IS NULL) AS live
     FROM organization_memberships m WHERE m.id = $1 FOR UPDATE OF m`,
    [input.membershipId, input.grantId],
  );
  const row = target.rows[0];
  // The grant reviewed is the one that must go. If it already ended (and was perhaps
  // granted again since), the new grant was not reviewed and is not touched.
  if (!row || !row.live) return 'ALREADY_ENDED';
  const common = { membershipId: input.membershipId, correlationId: input.correlationId, accessReview: input.accessReview };
  if (input.capability === 'CONTENT_REVIEW_EXTERNAL') {
    const closed = await revokeExternalReviewerWithin(drizzle(client), {
      ...common, reasonCode: accessReviewRevocationReason, note: input.note,
      actor: { userId: input.actorUserId, breakGlass: false, correlationId: input.correlationId },
      target: { userId: row.user_id, role: row.role, organizationId: row.organization_id },
    });
    return closed === null ? 'ALREADY_ENDED' : 'APPLIED';
  }
  const revoked = await revokeInternalCapabilityWithin(client, {
    ...common, capability: input.capability, actorUserId: input.actorUserId, reasonCode: accessReviewRevocationReason,
    ...(input.note ? { note: input.note } : {}),
    target: { userId: row.user_id, role: row.role, organizationId: row.organization_id },
  });
  return revoked ? 'APPLIED' : 'ALREADY_ENDED';
}

/**
 * A platform role the review removes: the membership is suspended (reversible, and the
 * existing registered event), and its live internal grants are revoked with it.
 */
async function suspendPlatformMembership(client: PoolClient, input: {
  readonly membershipId: string; readonly actorUserId: string; readonly correlationId: string; readonly note: string | null;
  readonly accessReview: Record<string, unknown>;
  readonly refuseRoleRevocation: (target: { readonly targetRole: string; readonly targetState: string; readonly activeSuperAdmins: number }) => AccessReviewRefusal | null;
}): Promise<'APPLIED' | 'ALREADY_ENDED'> {
  const membership = await client.query<{ user_id: string; role: string; state: string; organization_id: string }>(
    'SELECT user_id, role, state::text AS state, organization_id FROM organization_memberships WHERE id = $1 FOR UPDATE', [input.membershipId],
  );
  const row = membership.rows[0];
  if (!row || row.state !== 'ACTIVE') return 'ALREADY_ENDED';
  const supers = await client.query<{ n: number }>(`
    SELECT count(DISTINCT m.user_id)::int AS n FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.role = 'PLATFORM_SUPER_ADMIN' AND m.state = 'ACTIVE'`);
  const refusal = input.refuseRoleRevocation({ targetRole: row.role, targetState: row.state, activeSuperAdmins: supers.rows[0]!.n });
  if (refusal) throw new AccessReviewError(refusal);
  const revoked = await client.query<{ capability: string }>(
    `UPDATE membership_capabilities SET revoked_by_user_id = $2, revoked_at = now(), revoked_reason_code = $3
     WHERE membership_id = $1 AND revoked_at IS NULL AND capability <> 'INSTITUTION_ANALYTICS'
     RETURNING capability`,
    [input.membershipId, input.actorUserId, accessReviewRevocationReason],
  );
  await client.query("UPDATE organization_memberships SET state = 'SUSPENDED', updated_at = now() WHERE id = $1", [input.membershipId]);
  const revokedCapabilities = revoked.rows.map((grant) => grant.capability).sort();
  await writeAudit(client, {
    actorUserId: input.actorUserId, action: 'operations.staff_membership.suspended', resourceType: 'organization_membership',
    resourceId: input.membershipId, organizationId: row.organization_id, correlationId: input.correlationId,
    context: {
      reasonCode: accessReviewRevocationReason, targetUserId: row.user_id, targetRole: row.role, revokedCapabilities,
      accessReview: input.accessReview, ...(input.note ? { note: input.note } : {}),
    },
  });
  await writeOutbox(client, {
    aggregateType: 'organization_membership', aggregateId: input.membershipId, eventType: 'organization_membership.suspended',
    payload: { membershipId: input.membershipId }, actorUserId: input.actorUserId, organizationId: row.organization_id, correlationId: input.correlationId,
  });
  for (const capability of revokedCapabilities) {
    await writeOutbox(client, {
      aggregateType: 'organization_membership', aggregateId: input.membershipId, eventType: 'organization_membership.capability_revoked',
      payload: { membershipId: input.membershipId, capability }, actorUserId: input.actorUserId, organizationId: row.organization_id, correlationId: input.correlationId,
    });
  }
  return 'APPLIED';
}

// ---------------------------------------------------------------------------
// Close and export
// ---------------------------------------------------------------------------

export async function closeAccessReviewCampaign(pool: Pool, input: {
  readonly campaignId: string; readonly actorUserId: string; readonly reasonCode: string; readonly correlationId: string;
}): Promise<AccessReviewCampaignView> {
  return inTransaction(pool, async (client) => {
    const campaign = await client.query<{ state: string }>('SELECT state FROM access_review_campaigns WHERE id = $1 FOR UPDATE', [input.campaignId]);
    if (!campaign.rows[0]) throw new AccessReviewError('ACCESS_REVIEW_NOT_FOUND');
    if (campaign.rows[0].state !== 'OPEN') throw new AccessReviewError('ACCESS_REVIEW_NOT_OPEN');
    const undecided = await client.query('SELECT 1 FROM access_review_items WHERE campaign_id = $1 AND decision IS NULL LIMIT 1', [input.campaignId]);
    if (undecided.rowCount) throw new AccessReviewError('ACCESS_REVIEW_UNDECIDED_ITEMS');
    await client.query(
      `UPDATE access_review_campaigns SET state = 'CLOSED', closed_by_user_id = $2, close_reason_code = $3, close_correlation_id = $4, closed_at = now()
       WHERE id = $1`,
      [input.campaignId, input.actorUserId, input.reasonCode, input.correlationId],
    );
    const view = (await loadAccessReviewCampaign(client, input.campaignId))!;
    const organizationId = await platformOrganizationId(client);
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'operations.access_review.closed', resourceType: 'access_review_campaign', resourceId: input.campaignId,
      organizationId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, periodLabel: view.periodLabel, itemCount: view.itemCount, kept: view.counts.kept, revoked: view.counts.revoked, solo: view.counts.solo },
    });
    await writeOutbox(client, {
      aggregateType: 'access_review_campaign', aggregateId: input.campaignId, eventType: 'access_review.closed', payload: { campaignId: input.campaignId },
      actorUserId: input.actorUserId, organizationId, correlationId: input.correlationId,
    });
    return view;
  });
}

/** The export is itself audited, with the file's hash, so the evidence handed out can be matched. */
export async function recordAccessReviewExport(pool: Pool, input: {
  readonly campaignId: string; readonly actorUserId: string; readonly reasonCode: string; readonly correlationId: string;
  readonly rows: number; readonly sha256: string; readonly periodLabel: string;
}): Promise<void> {
  await inTransaction(pool, async (client) => {
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'operations.access_review.exported', resourceType: 'access_review_campaign', resourceId: input.campaignId,
      organizationId: await platformOrganizationId(client), correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, periodLabel: input.periodLabel, rows: input.rows, sha256: input.sha256 },
    });
  });
}

/** The reviewer count and the database clock, for deciding what the viewer may do. */
export async function accessReviewClock(pool: Pool): Promise<{ readonly reviewerCount: number; readonly now: string }> {
  const meta = await pool.query<{ reviewers: number; now: Date }>('SELECT access_review_reviewer_count() AS reviewers, now() AS now');
  return { reviewerCount: meta.rows[0]!.reviewers, now: iso(meta.rows[0]!.now)! };
}
