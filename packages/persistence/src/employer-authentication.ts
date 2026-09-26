import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

/**
 * The one definition of a live applicant-access grant (Appendix 2 §5.2, "no grant, no
 * data"). A grant is live when it has not been revoked, has not expired, and the student
 * it belongs to is not leaving ONE: an account in deletion (an open DELETION request,
 * DELETION_PENDING, DELETED or anonymised) gives no employer access. The open-request
 * test is a condition rather than a revocation because the student may still cancel
 * within the grace period; the deletion itself revokes the grant for good.
 *
 * Every employer route that reads or changes one candidate's data reaches the grant
 * through this predicate — directly, through `applicationHasLiveApplicantGrant`, or
 * through one of the assertions below — so there is exactly one place it can be wrong.
 */
export function liveApplicantGrantCondition(grantAlias: string, now?: Date): SQL {
  const grant = sql.raw(safeAlias(grantAlias));
  const at = now ? sql`${now}` : sql`now()`;
  return sql`(${grant}.revoked_at IS NULL
    AND (${grant}.expires_at IS NULL OR ${grant}.expires_at > ${at})
    AND NOT EXISTS (SELECT 1 FROM users grant_subject
      WHERE grant_subject.id = ${grant}.student_user_id
        AND (grant_subject.state IN ('DELETION_PENDING', 'DELETED') OR grant_subject.anonymised_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM privacy_requests grant_deletion
      WHERE grant_deletion.subject_user_id = ${grant}.student_user_id
        AND grant_deletion.request_type = 'DELETION'
        AND grant_deletion.state IN ('RECEIVED', 'IN_PROGRESS')))`;
}

/**
 * True when the application row under `applicationAlias` carries a live grant for its own
 * employer, opportunity and student. List routes select it as a column and withhold the
 * person when it is false; they keep the application's id and state so the employer's
 * pipeline still adds up.
 */
export function applicationHasLiveApplicantGrant(applicationAlias: string): SQL {
  const application = sql.raw(safeAlias(applicationAlias));
  return sql`EXISTS (SELECT 1 FROM employer_applicant_access_grants live_grant
    WHERE live_grant.employer_id = ${application}.employer_id
      AND live_grant.opportunity_id = ${application}.opportunity_id
      AND live_grant.student_user_id = ${application}.student_user_id
      AND ${liveApplicantGrantCondition('live_grant')})`;
}

export interface EmployerApplicantAccessInput {
  readonly actorUserId: string;
  readonly employerId: string;
  readonly opportunityId: string;
  readonly studentUserId: string;
  readonly now?: Date;
  readonly lockForMutation?: boolean;
}

export async function assertEmployerApplicantAccessForAuthenticatedPrincipal(
  db: PersistenceDb,
  input: EmployerApplicantAccessInput,
): Promise<void> {
  const lockClause = input.lockForMutation ? sql`FOR UPDATE OF grant_record, membership` : sql``;

  const result = await db.execute(sql`
    SELECT grant_record.id
    FROM employer_applicant_access_grants grant_record
    JOIN organization_memberships membership
      ON membership.organization_id = grant_record.employer_id
     AND membership.user_id = ${input.actorUserId}::uuid
     AND membership.state = 'ACTIVE'
     AND membership.scope_organization_id = grant_record.employer_id
     AND membership.scope_employer_id = grant_record.employer_id
     AND membership.role IN ('EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER')
    -- EMP-03: a grant is only usable while the employer is verified and active. A
    -- REJECTED organisation keeps active = true, so the state is checked as well.
    JOIN organizations employer_org
      ON employer_org.id = grant_record.employer_id
     AND employer_org.kind = 'EMPLOYER'
     AND employer_org.verification_state = 'VERIFIED'
     AND employer_org.active
    WHERE grant_record.employer_id = ${input.employerId}::uuid
      AND grant_record.opportunity_id = ${input.opportunityId}::uuid
      AND grant_record.student_user_id = ${input.studentUserId}::uuid
      AND ${liveApplicantGrantCondition('grant_record', input.now ?? new Date())}
    ${lockClause}
  `) as QueryResult<{ id: string }>;

  if (result.rows.length < 1) throw new Error('employer applicant access not found');
}

export interface EmployerApplicationAccessInput {
  readonly employerId: string;
  /** One or more applications; every one must be this employer's and carry a live grant. */
  readonly applicationIds: readonly string[];
  /**
   * Inside a write transaction, share-lock the grant rows so a withdrawal, close or
   * deletion that revokes them waits for the write rather than racing it.
   */
  readonly lockForMutation?: boolean;
}

/**
 * The request-time check for employer routes that act on named applications (EMP-SR-01).
 * The caller has already passed the organisation guard (membership, active, verified), so
 * this adds only what that guard cannot know: that the student's grant for each
 * application is live now. Throws when any application is missing, belongs to another
 * employer, or has no live grant; callers turn that into the shared safe 403.
 */
export async function assertEmployerApplicationAccess(
  db: Pick<PersistenceDb, 'execute'>,
  input: EmployerApplicationAccessInput,
): Promise<void> {
  const ids = [...new Set(input.applicationIds)];
  if (ids.length < 1) throw new Error('employer applicant access not found');
  const lockClause = input.lockForMutation ? sql`FOR SHARE OF live_grant` : sql``;
  const result = await db.execute(sql`
    SELECT application.id
    FROM applications application
    JOIN employer_applicant_access_grants live_grant
      ON live_grant.employer_id = application.employer_id
     AND live_grant.opportunity_id = application.opportunity_id
     AND live_grant.student_user_id = application.student_user_id
    WHERE application.employer_id = ${input.employerId}::uuid
      AND application.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      AND ${liveApplicantGrantCondition('live_grant')}
    ${lockClause}
  `) as QueryResult<{ id: string }>;

  // At most one unrevoked grant exists per employer, student and opportunity (the partial
  // unique index in 0001), so one row per application means every one is covered.
  if (new Set(result.rows.map((row) => row.id)).size !== ids.length) throw new Error('employer applicant access not found');
}

function safeAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('invalid SQL alias');
  return alias;
}
