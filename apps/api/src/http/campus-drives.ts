/**
 * Campus drive reads shared by the student hiring routes and the employer publish checks (EMP-11).
 *
 * A published job reaches a student through a matching audience row or, since EMP-11, through a
 * drive the student's college has approved (ADR-038). These are the SQL fragments and reads that
 * rule needs in more than one controller, so the listing, the detail, the preview and apply can
 * never disagree about which drives count, and which placement policy governs an application.
 * Design: docs/architecture/campus-drives-table-design.md.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { liveCampusDriveStates, oneOfferPolicyBlocks, openCampusDriveStates, type PlacementPolicyType } from '@planthepath/hiring/src/campus-drives.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };

const liveStates = sql.raw(liveCampusDriveStates.map((state) => `'${state}'`).join(', '));
const openStates = sql.raw(openCampusDriveStates.map((state) => `'${state}'`).join(', '));

/** The colleges a student currently belongs to: the relationship rule every student audience uses. */
export function studentCurrentInstitutionsSql(studentUserId: string): SQL {
  return sql`(SELECT ir.institution_id FROM institution_relationships ir
    WHERE ir.student_user_id = ${studentUserId}::uuid
      AND ir.state IN ('ACTIVE', 'VERIFIED')
      AND ir.effective_from <= now()
      AND (ir.effective_to IS NULL OR ir.effective_to > now()))`;
}

/** True when the job (alias `o`) has a drive the student's college has approved. */
export function visibleThroughCampusDriveSql(studentUserId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM campus_drives cd
    WHERE cd.opportunity_id = o.id AND cd.state IN (${liveStates})
      AND cd.institution_id IN ${studentCurrentInstitutionsSql(studentUserId)})`;
}

/**
 * What publish and reopen accept as "this job has somewhere to go": an audience row, or a drive
 * that is pending or live. A pending drive reaches nobody until the college approves it.
 */
export function opportunityHasAudienceSql(opportunityId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM opportunity_audiences WHERE opportunity_id = ${opportunityId}::uuid)
    OR EXISTS (SELECT 1 FROM campus_drives WHERE opportunity_id = ${opportunityId}::uuid AND state IN (${openStates})))`;
}

/**
 * An accepted offer the student still holds, from any employer in ONE: an ACCEPTED offer on an
 * application not later withdrawn or rejected, or a hire (mirrors `holdsAcceptedOffer`).
 */
function holdsAcceptedOfferSql(studentUserId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM applications held WHERE held.student_user_id = ${studentUserId}::uuid
    AND (held.state = 'HIRED' OR (held.state NOT IN ('WITHDRAWN', 'REJECTED')
      AND EXISTS (SELECT 1 FROM offers f WHERE f.application_id = held.id AND f.state = 'ACCEPTED'))))`;
}

export interface StudentCampusDrive {
  readonly id: string;
  readonly institutionName: string;
  readonly state: string;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly venueMode: string | null;
  readonly offerHoldersEligible: boolean;
  readonly placementPolicy: { readonly id: string; readonly policyType: PlacementPolicyType; readonly allowDriveExceptions: boolean; readonly note: string | null } | null;
  readonly blocksYou: boolean;
}

/**
 * The live drives for one job at the student's colleges, each with the placement policy in force
 * at that college and whether it stops this student. With `lock`, the drive rows are held FOR
 * SHARE: a cancellation takes them FOR UPDATE, so apply either sees it or is seen by it.
 */
export async function readStudentCampusDrives(db: Executor, studentUserId: string, opportunityId: string, lock = false): Promise<StudentCampusDrive[]> {
  const rows = await db.execute(sql`
    SELECT cd.id, org.legal_name AS institution_name, cd.state, cd.scheduled_start_at, cd.scheduled_end_at, cd.venue_mode,
           cd.offer_holders_eligible, p.id AS policy_id, p.policy_type, p.allow_drive_exceptions, p.note AS policy_note,
           ${holdsAcceptedOfferSql(studentUserId)} AS holds_accepted_offer
    FROM campus_drives cd
    JOIN organizations org ON org.id = cd.institution_id
    LEFT JOIN LATERAL (
      SELECT pp.id, pp.policy_type, pp.allow_drive_exceptions, pp.note FROM institution_placement_policies pp
      WHERE pp.institution_id = cd.institution_id AND pp.state = 'ACTIVE' AND pp.policy_type = 'ONE_OFFER_PER_STUDENT'
        AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
      ORDER BY pp.effective_from DESC LIMIT 1
    ) p ON true
    WHERE cd.opportunity_id = ${opportunityId}::uuid AND cd.state IN (${liveStates})
      AND cd.institution_id IN ${studentCurrentInstitutionsSql(studentUserId)}
    ORDER BY org.legal_name, cd.id
    ${lock ? sql`FOR SHARE OF cd` : sql``}
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.map((row) => {
    const policy = row.policy_id ? {
      id: String(row.policy_id), policyType: row.policy_type as PlacementPolicyType,
      allowDriveExceptions: row.allow_drive_exceptions === true, note: typeof row.policy_note === 'string' ? row.policy_note : null,
    } : null;
    return {
      id: String(row.id),
      institutionName: String(row.institution_name),
      state: String(row.state),
      scheduledStartAt: isoOrNull(row.scheduled_start_at),
      scheduledEndAt: isoOrNull(row.scheduled_end_at),
      venueMode: typeof row.venue_mode === 'string' ? row.venue_mode : null,
      offerHoldersEligible: row.offer_holders_eligible === true,
      placementPolicy: policy,
      blocksYou: oneOfferPolicyBlocks(policy, { holdsAcceptedOffer: row.holds_accepted_offer === true, driveOfferHoldersEligible: row.offer_holders_eligible === true }),
    };
  });
}

/** For a listing: the live drives at the student's colleges, per job, without policy detail. */
export async function readListedCampusDrives(db: Executor, studentUserId: string, opportunityIds: readonly string[]): Promise<Map<string, { institutionName: string; state: string; scheduledStartAt: string | null }[]>> {
  const grouped = new Map<string, { institutionName: string; state: string; scheduledStartAt: string | null }[]>();
  if (opportunityIds.length === 0) return grouped;
  const rows = await db.execute(sql`
    SELECT cd.opportunity_id, org.legal_name AS institution_name, cd.state, cd.scheduled_start_at
    FROM campus_drives cd JOIN organizations org ON org.id = cd.institution_id
    WHERE cd.opportunity_id = ANY(${`{${opportunityIds.join(',')}}`}::uuid[]) AND cd.state IN (${liveStates})
      AND cd.institution_id IN ${studentCurrentInstitutionsSql(studentUserId)}
    ORDER BY org.legal_name, cd.id
  `) as QueryResult<Record<string, unknown>>;
  for (const row of rows.rows) {
    const key = String(row.opportunity_id);
    const list = grouped.get(key) ?? [];
    list.push({ institutionName: String(row.institution_name), state: String(row.state), scheduledStartAt: isoOrNull(row.scheduled_start_at) });
    grouped.set(key, list);
  }
  return grouped;
}

/** Links a new application to every live drive it came through, with the policy checked for each. */
export async function linkApplicationToCampusDrives(tx: Executor, applicationId: string, opportunityId: string, drives: readonly StudentCampusDrive[]): Promise<void> {
  for (const drive of drives) {
    await tx.execute(sql`
      INSERT INTO campus_drive_applications (campus_drive_id, application_id, opportunity_id, placement_policy_id)
      VALUES (${drive.id}::uuid, ${applicationId}::uuid, ${opportunityId}::uuid, ${drive.placementPolicy?.id ?? null}::uuid)
    `);
  }
}

export function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
