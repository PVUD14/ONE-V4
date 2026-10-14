/**
 * requireActiveEmployer: the one authorisation helper every employer route calls (EMP-03).
 *
 * Before EMP-03, employer routes authorised on membership state alone, so operations
 * suspending or rejecting an employer changed nothing the employer could do, and an
 * unverified employer could publish. Appendix 2 §5.1 fixes the order of checks:
 *
 *   1. an ACTIVE membership in that employer with matching organisation and employer
 *      scope, in one of the roles the route allows;
 *   2. the organisation is active;
 *   3. its verification state allows the action:
 *        PENDING, UNDER_REVIEW  company profile, team, draft jobs; no publishing, no candidates
 *        VERIFIED               everything the role allows
 *        REJECTED, SUSPENDED    read their own organisation status and answer trust cases only
 *
 * The check keys on verification_state as well as `active`, because a REJECTED
 * organisation keeps active = true. The same rule, expressed as SQL, guards the student
 * side and the applicant-access check (employerInGoodStandingSql), so the two can never
 * disagree about which employers are allowed to reach students.
 */
import { ForbiddenException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * What the caller is about to do, grouped the way §5.1 groups the verification matrix.
 *
 *  - `organisation.status`  read the organisation's own state (allowed in every state);
 *  - `organisation.manage`  company profile, team, employer terms;
 *  - `jobs.draft`           create drafts, set audiences, build assessments that are not published;
 *  - `jobs.publish`         anything that makes a job or assessment reach students;
 *  - `candidates`           any read or write of candidate data: applicants, interviews,
 *                           offers, feedback, reports, assessment invitations and results;
 *  - `trust.cases`          read and answer trust cases about the organisation (EMP-16). Allowed in
 *                           every state: §5.1 lets a REJECTED or SUSPENDED employer "respond to trust
 *                           cases", and a suspended employer is the one most likely to need to appeal.
 */
export type EmployerAction = 'organisation.status' | 'organisation.manage' | 'jobs.draft' | 'jobs.publish' | 'candidates' | 'trust.cases';

export type EmployerVerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export interface EmployerOrganisationState {
  readonly verificationState: EmployerVerificationState;
  readonly active: boolean;
}

/** Why an action was refused, for clients that show the plain status page. */
export type EmployerStateRefusal = 'EMPLOYER_ORGANISATION_INACTIVE' | 'EMPLOYER_ORGANISATION_UNVERIFIED';

/** Pure decision for §5.1 step 2 and 3; null means allowed. */
export function employerStateRefusal(state: EmployerOrganisationState, action: EmployerAction): EmployerStateRefusal | null {
  if (action === 'organisation.status' || action === 'trust.cases') return null;
  if (!state.active || state.verificationState === 'SUSPENDED' || state.verificationState === 'REJECTED') return 'EMPLOYER_ORGANISATION_INACTIVE';
  if (state.verificationState === 'VERIFIED') return null;
  // PENDING and UNDER_REVIEW: set up the organisation and draft, nothing that reaches students.
  return action === 'organisation.manage' || action === 'jobs.draft' ? null : 'EMPLOYER_ORGANISATION_UNVERIFIED';
}

/** The roles that act for an employer organisation. Interview participants are these too (ADR-026). */
export const employerMemberRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;

/**
 * §5.1 in full. Throws 403 when the membership, the organisation's active flag or its
 * verification state does not allow the action; returns the request context otherwise.
 */
export async function requireActiveEmployer(
  db: Pick<PersistenceDb, 'execute'>,
  request: ProtectedHttpRequest,
  employerId: string,
  action: EmployerAction,
  roles: readonly string[] = employerMemberRoles,
): Promise<ReturnType<typeof requireTrustedAuthorization>> {
  const context = requireEmployerMembership(request, employerId, roles);
  await assertEmployerState(db, employerId, action, context.correlationId);
  return context;
}

/**
 * §5.1 step 1 alone, without touching the database. Exported for the few routes that
 * validate their input between the membership check and the state check, so malformed
 * input is refused before any query; they must still call assertEmployerState.
 */
export function requireEmployerMembership(request: ProtectedHttpRequest, employerId: string, roles: readonly string[]): ReturnType<typeof requireTrustedAuthorization> {
  const context = requireTrustedAuthorization(request);
  if (!uuidPattern.test(employerId)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  const permitted = context.authorization.memberships.some((membership) => (
    membership.organizationId === employerId
    && membership.scope.organizationId === employerId
    && membership.scope.employerId === employerId
    && membership.state === 'ACTIVE'
    && roles.includes(membership.role)
  ));
  if (!permitted) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  return context;
}

/** §5.1 steps 2 and 3: the organisation exists as an employer and its state allows the action. */
export async function assertEmployerState(db: Pick<PersistenceDb, 'execute'>, employerId: string, action: EmployerAction, correlationId: string): Promise<void> {
  const state = await readEmployerOrganisationState(db, employerId);
  if (!state) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  const refusal = employerStateRefusal(state, action);
  if (refusal) throw new ForbiddenException({ error: { code: refusal, message: 'Access denied', correlationId } });
}

export async function readEmployerOrganisationState(db: Pick<PersistenceDb, 'execute'>, employerId: string): Promise<EmployerOrganisationState | null> {
  const rows = await db.execute(sql`
    SELECT verification_state, active FROM organizations
    WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER'
  `) as QueryResult<{ verification_state: EmployerVerificationState; active: boolean }>;
  const [row] = rows.rows;
  return row ? { verificationState: row.verification_state, active: row.active } : null;
}

/**
 * SQL for "this employer may reach students": verified and active. `employerIdColumn`
 * is the column holding the employer id in the calling query (for example o.employer_id).
 */
export function employerInGoodStandingSql(employerIdColumn: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM organizations employer_org
    WHERE employer_org.id = ${employerIdColumn} AND employer_org.kind = 'EMPLOYER'
      AND employer_org.verification_state = 'VERIFIED' AND employer_org.active)`;
}
