import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

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
  const now = input.now ?? new Date();
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
    WHERE grant_record.employer_id = ${input.employerId}::uuid
      AND grant_record.opportunity_id = ${input.opportunityId}::uuid
      AND grant_record.student_user_id = ${input.studentUserId}::uuid
      AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR grant_record.expires_at > ${now})
    ${lockClause}
  `) as QueryResult<{ id: string }>;

  if (result.rows.length < 1) throw new Error('employer applicant access not found');
}
