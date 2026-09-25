/**
 * The Operations Overview's server-side summary (OPS-03, Appendix 1 §5.5–5.7).
 *
 * The Overview used to fetch three full lists (organisations, invitations, users — each
 * capped at 200 rows) and count them in the browser, so every number was silently wrong
 * above 200 and the new operator queues were missing. This module computes each count in
 * SQL instead, and computes only the sections the caller may see (the caller passes the
 * list from `operationsOverviewSectionsFor`), so a section the caller cannot open is never
 * even queried.
 *
 * Every count is bounded: it stops at OVERVIEW_COUNT_CAP and reports `capped`, so a large
 * table reads as "10,000+" instead of a scan. Each section is one statement of such
 * subqueries. The short "recent" lists are LIMITed and carry no personal data: an
 * invitation is described by its role and organisation, never its recipient.
 *
 * Counts of people (accounts) are suppressed below 5 (§5.5). Counts of work items are not
 * (see packages/authorization/src/operations-overview.ts for why).
 */
import { sql, type SQL } from 'drizzle-orm';
import { suppressPeopleCount, type OperationsOverviewSection, type SuppressedPeopleCount } from '@planthepath/authorization/src/index.js';

export interface OverviewSqlRunner {
  execute(query: SQL): Promise<unknown>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: OverviewSqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/** Counts stop here, so a large queue reads as "10,000+" rather than a table scan. */
export const OVERVIEW_COUNT_CAP = 10_000;

export interface OverviewCount {
  readonly value: number;
  /** True when there are more than `value` rows; `value` is then the cap. */
  readonly capped: boolean;
}

const verificationStates = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] as const;
export type OverviewVerificationState = (typeof verificationStates)[number];
const deliveryStates = ['NOT_SENT', 'SENT', 'FAILED', 'BOUNCED', 'NOT_CONFIGURED'] as const;
export type OverviewDeliveryState = (typeof deliveryStates)[number];
const trustSeverities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export interface OverviewOrganizationKindCounts {
  readonly total: OverviewCount;
  readonly byVerification: Readonly<Record<OverviewVerificationState, OverviewCount>>;
}

export interface OperationsOverview {
  readonly generatedAt: string;
  readonly organizations: {
    readonly total: OverviewCount;
    readonly active: OverviewCount;
    readonly institutions: OverviewOrganizationKindCounts;
    readonly employers: OverviewOrganizationKindCounts;
    readonly recent: readonly {
      readonly id: string; readonly kind: 'INSTITUTION' | 'EMPLOYER'; readonly name: string;
      readonly verificationState: OverviewVerificationState; readonly active: boolean;
    }[];
  } | null;
  readonly verification: { readonly awaitingDecision: OverviewCount; readonly underReview: OverviewCount } | null;
  readonly employerAccessRequests: { readonly pending: OverviewCount; readonly oldestPendingAt: string | null } | null;
  readonly invitations: {
    readonly staff: {
      readonly total: OverviewCount;
      readonly accepted: OverviewCount;
      readonly pending: OverviewCount;
      readonly pendingOver72Hours: OverviewCount;
      readonly expiredUnaccepted: OverviewCount;
    };
    readonly expiringSoon: readonly { readonly id: string; readonly role: string | null; readonly organizationName: string | null; readonly expiresAt: string }[];
    readonly recent: readonly { readonly id: string; readonly role: string | null; readonly organizationName: string | null; readonly state: string; readonly createdAt: string }[];
    readonly student: {
      readonly pending: OverviewCount;
      readonly pendingOver72Hours: OverviewCount;
      readonly notDelivered: OverviewCount;
      readonly byDelivery: Readonly<Record<OverviewDeliveryState, OverviewCount>>;
    };
  } | null;
  readonly accounts: {
    readonly total: SuppressedPeopleCount;
    readonly students: SuppressedPeopleCount;
    readonly withOrganizationRoles: SuppressedPeopleCount;
  } | null;
  readonly trustSafety: {
    readonly open: OverviewCount;
    readonly unassigned: OverviewCount;
    readonly bySeverity: Readonly<Record<(typeof trustSeverities)[number], OverviewCount>>;
  } | null;
  readonly jobs: { readonly failedEvents: OverviewCount; readonly openAlerts: OverviewCount } | null;
  readonly privacyRequests: {
    readonly open: OverviewCount;
    readonly openExports: OverviewCount;
    readonly openDeletions: OverviewCount;
    readonly deletionsDueWithin7Days: OverviewCount;
    readonly failed: OverviewCount;
  } | null;
  readonly privacyHolds: { readonly active: OverviewCount } | null;
  readonly approvals: { readonly pending: OverviewCount; readonly awaitingExecution: OverviewCount } | null;
  readonly support: { readonly open: OverviewCount; readonly overdue: OverviewCount; readonly unassigned: OverviewCount } | null;
}

/**
 * Several bounded counts in one statement. Each fragment is `<table> WHERE <predicate>`;
 * each count reads at most cap + 1 rows.
 */
async function boundedCounts<K extends string>(runner: OverviewSqlRunner, parts: Readonly<Record<K, SQL>>, cap: number): Promise<Record<K, OverviewCount>> {
  const keys = Object.keys(parts) as K[];
  const selects = keys.map((key, index) =>
    sql`(SELECT count(*) FROM (SELECT 1 FROM ${parts[key]} LIMIT ${cap + 1}) bounded)::int AS ${sql.raw(`c${index}`)}`);
  const [row] = await rows<Record<string, number>>(runner, sql`SELECT ${sql.join(selects, sql`, `)}`);
  const result = {} as Record<K, OverviewCount>;
  keys.forEach((key, index) => {
    const value = Number(row?.[`c${index}`] ?? 0);
    result[key] = value > cap ? { value: cap, capped: true } : { value, capped: false };
  });
  return result;
}

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

const managedOrganizations = sql`organizations WHERE kind IN ('INSTITUTION','EMPLOYER')`;
const liveStaffPending = sql`invitations WHERE kind = 'STAFF' AND state = 'PENDING' AND expires_at > now()`;
const liveStudentPending = sql`invitations WHERE kind = 'STUDENT' AND state = 'PENDING' AND expires_at > now()`;

async function organizationsSection(runner: OverviewSqlRunner, cap: number): Promise<NonNullable<OperationsOverview['organizations']>> {
  const parts: Record<string, SQL> = {
    total: managedOrganizations,
    active: sql`organizations WHERE kind IN ('INSTITUTION','EMPLOYER') AND active`,
  };
  for (const kind of ['INSTITUTION', 'EMPLOYER'] as const) {
    parts[`${kind}:total`] = sql`organizations WHERE kind = ${kind}::organization_kind`;
    for (const state of verificationStates) {
      parts[`${kind}:${state}`] = sql`organizations WHERE kind = ${kind}::organization_kind AND verification_state = ${state}::verification_state`;
    }
  }
  const counts = await boundedCounts(runner, parts, cap);
  const kindCounts = (kind: 'INSTITUTION' | 'EMPLOYER'): OverviewOrganizationKindCounts => ({
    total: counts[`${kind}:total`]!,
    byVerification: Object.fromEntries(verificationStates.map((state) => [state, counts[`${kind}:${state}`]!])) as Record<OverviewVerificationState, OverviewCount>,
  });
  const recent = await rows<{ id: string; kind: 'INSTITUTION' | 'EMPLOYER'; name: string; verification_state: OverviewVerificationState; active: boolean }>(runner, sql`
    SELECT o.id, o.kind, coalesce(p.display_name, o.legal_name) AS name, o.verification_state, o.active
    FROM organizations o
    LEFT JOIN organization_profiles p ON p.organization_id = o.id
    WHERE o.kind IN ('INSTITUTION','EMPLOYER')
    ORDER BY o.updated_at DESC, o.id DESC
    LIMIT 5
  `);
  return {
    total: counts.total!,
    active: counts.active!,
    institutions: kindCounts('INSTITUTION'),
    employers: kindCounts('EMPLOYER'),
    recent: recent.map((row) => ({ id: row.id, kind: row.kind, name: row.name, verificationState: row.verification_state, active: row.active })),
  };
}

async function invitationsSection(runner: OverviewSqlRunner, cap: number): Promise<NonNullable<OperationsOverview['invitations']>> {
  const parts: Record<string, SQL> = {
    staffTotal: sql`invitations WHERE kind = 'STAFF'`,
    staffAccepted: sql`invitations WHERE kind = 'STAFF' AND state = 'ACCEPTED'`,
    staffPending: liveStaffPending,
    staffStale: sql`invitations WHERE kind = 'STAFF' AND state = 'PENDING' AND expires_at > now() AND created_at <= now() - interval '72 hours'`,
    staffExpired: sql`invitations WHERE kind = 'STAFF' AND state = 'PENDING' AND expires_at <= now()`,
    studentPending: liveStudentPending,
    studentStale: sql`invitations WHERE kind = 'STUDENT' AND state = 'PENDING' AND expires_at > now() AND created_at <= now() - interval '72 hours'`,
    studentNotDelivered: sql`invitations WHERE kind = 'STUDENT' AND state = 'PENDING' AND expires_at > now() AND delivery_state <> 'SENT'`,
  };
  for (const state of deliveryStates) {
    parts[`delivery:${state}`] = sql`invitations WHERE kind = 'STUDENT' AND state = 'PENDING' AND expires_at > now() AND delivery_state = ${state}`;
  }
  const counts = await boundedCounts(runner, parts, cap);
  const expiring = await rows<{ id: string; role: string | null; organization_name: string | null; expires_at: Date | string }>(runner, sql`
    SELECT i.id, i.role, o.legal_name AS organization_name, i.expires_at
    FROM invitations i LEFT JOIN organizations o ON o.id = i.organization_id
    WHERE i.kind = 'STAFF' AND i.state = 'PENDING' AND i.expires_at > now()
    ORDER BY i.expires_at ASC, i.id ASC
    LIMIT 3
  `);
  const recent = await rows<{ id: string; role: string | null; organization_name: string | null; state: string; created_at: Date | string }>(runner, sql`
    SELECT i.id, i.role, o.legal_name AS organization_name, i.state::text AS state, i.created_at
    FROM invitations i LEFT JOIN organizations o ON o.id = i.organization_id
    WHERE i.kind = 'STAFF'
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 4
  `);
  return {
    staff: {
      total: counts.staffTotal!, accepted: counts.staffAccepted!, pending: counts.staffPending!,
      pendingOver72Hours: counts.staffStale!, expiredUnaccepted: counts.staffExpired!,
    },
    expiringSoon: expiring.map((row) => ({ id: row.id, role: row.role, organizationName: row.organization_name, expiresAt: iso(row.expires_at)! })),
    recent: recent.map((row) => ({ id: row.id, role: row.role, organizationName: row.organization_name, state: row.state, createdAt: iso(row.created_at)! })),
    student: {
      pending: counts.studentPending!,
      pendingOver72Hours: counts.studentStale!,
      notDelivered: counts.studentNotDelivered!,
      byDelivery: Object.fromEntries(deliveryStates.map((state) => [state, counts[`delivery:${state}`]!])) as Record<OverviewDeliveryState, OverviewCount>,
    },
  };
}

async function accountsSection(runner: OverviewSqlRunner, cap: number): Promise<NonNullable<OperationsOverview['accounts']>> {
  const counts = await boundedCounts(runner, {
    total: sql`users`,
    students: sql`users u WHERE EXISTS (SELECT 1 FROM institution_relationships r WHERE r.student_user_id = u.id)`,
    withOrganizationRoles: sql`users u WHERE EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id AND m.state = 'ACTIVE')`,
  }, cap);
  return {
    total: suppressPeopleCount(counts.total.value, counts.total.capped),
    students: suppressPeopleCount(counts.students.value, counts.students.capped),
    withOrganizationRoles: suppressPeopleCount(counts.withOrganizationRoles.value, counts.withOrganizationRoles.capped),
  };
}

async function trustSection(runner: OverviewSqlRunner, cap: number): Promise<NonNullable<OperationsOverview['trustSafety']>> {
  const open = sql`trust_cases WHERE state NOT IN ('CLOSED','DISMISSED')`;
  const parts: Record<string, SQL> = {
    open,
    unassigned: sql`trust_cases WHERE state NOT IN ('CLOSED','DISMISSED') AND assigned_to_user_id IS NULL`,
  };
  for (const severity of trustSeverities) parts[severity] = sql`trust_cases WHERE state NOT IN ('CLOSED','DISMISSED') AND severity = ${severity}`;
  const counts = await boundedCounts(runner, parts, cap);
  return {
    open: counts.open!,
    unassigned: counts.unassigned!,
    bySeverity: Object.fromEntries(trustSeverities.map((severity) => [severity, counts[severity]!])) as Record<(typeof trustSeverities)[number], OverviewCount>,
  };
}

/**
 * The summary for the given sections. Sections not listed are returned as null and are
 * not queried. `cap` is for tests; callers use the default.
 */
export async function readOperationsOverview(
  runner: OverviewSqlRunner,
  sections: readonly OperationsOverviewSection[],
  cap: number = OVERVIEW_COUNT_CAP,
): Promise<OperationsOverview> {
  const wants = new Set(sections);
  const [clock] = await rows<{ now: Date | string }>(runner, sql`SELECT now() AS now`);

  const organizations = wants.has('organizations') ? await organizationsSection(runner, cap) : null;

  const verification = wants.has('verification')
    ? await boundedCounts(runner, {
      awaitingDecision: sql`organizations WHERE kind IN ('INSTITUTION','EMPLOYER') AND verification_state IN ('PENDING','UNDER_REVIEW')`,
      underReview: sql`organizations WHERE kind IN ('INSTITUTION','EMPLOYER') AND verification_state = 'UNDER_REVIEW'`,
    }, cap)
    : null;

  let employerAccessRequests: OperationsOverview['employerAccessRequests'] = null;
  if (wants.has('employerAccessRequests')) {
    const counts = await boundedCounts(runner, { pending: sql`employer_access_requests WHERE state = 'PENDING'` }, cap);
    const [oldest] = await rows<{ at: Date | string }>(runner, sql`
      SELECT created_at AS at FROM employer_access_requests WHERE state = 'PENDING' ORDER BY created_at ASC LIMIT 1
    `);
    employerAccessRequests = { pending: counts.pending, oldestPendingAt: iso(oldest?.at) };
  }

  const invitations = wants.has('invitations') ? await invitationsSection(runner, cap) : null;
  const accounts = wants.has('accounts') ? await accountsSection(runner, cap) : null;
  const trustSafety = wants.has('trustSafety') ? await trustSection(runner, cap) : null;

  const jobs = wants.has('jobs')
    ? await boundedCounts(runner, {
      failedEvents: sql`outbox_events WHERE delivery_state = 'FAILED'`,
      openAlerts: sql`jobs_health_alerts WHERE state = 'OPEN'`,
    }, cap)
    : null;

  const privacyRequests = wants.has('privacyRequests')
    ? await boundedCounts(runner, {
      open: sql`privacy_requests WHERE state IN ('RECEIVED','IN_PROGRESS','READY')`,
      openExports: sql`privacy_requests WHERE request_type = 'EXPORT' AND state IN ('RECEIVED','IN_PROGRESS','READY')`,
      openDeletions: sql`privacy_requests WHERE request_type = 'DELETION' AND state IN ('RECEIVED','IN_PROGRESS','READY')`,
      // The only deadline ONE records is when a deletion is scheduled to run; no statutory
      // response period is defined in code, so none is invented here.
      deletionsDueWithin7Days: sql`privacy_requests WHERE request_type = 'DELETION' AND state IN ('RECEIVED','IN_PROGRESS')
        AND deletion_scheduled_for >= now() AND deletion_scheduled_for < now() + interval '7 days'`,
      failed: sql`privacy_requests WHERE state = 'FAILED'`,
    }, cap)
    : null;

  const privacyHolds = wants.has('privacyHolds')
    ? await boundedCounts(runner, { active: sql`data_retention_holds WHERE released_at IS NULL` }, cap)
    : null;

  const approvals = wants.has('approvals')
    ? await boundedCounts(runner, {
      pending: sql`operation_approvals WHERE state = 'PENDING' AND expires_at > now()`,
      awaitingExecution: sql`operation_approvals WHERE state = 'APPROVED' AND executed_at IS NULL AND expires_at > now()`,
    }, cap)
    : null;

  const support = wants.has('support')
    ? await boundedCounts(runner, {
      open: sql`support_cases WHERE state IN ('OPEN','IN_PROGRESS','WAITING_ON_CUSTOMER')`,
      overdue: sql`support_cases WHERE state IN ('OPEN','IN_PROGRESS','WAITING_ON_CUSTOMER') AND now() > sla_due_at`,
      unassigned: sql`support_cases WHERE state IN ('OPEN','IN_PROGRESS','WAITING_ON_CUSTOMER') AND assigned_to_user_id IS NULL`,
    }, cap)
    : null;

  return {
    generatedAt: new Date(clock!.now).toISOString(),
    organizations,
    verification,
    employerAccessRequests,
    invitations,
    accounts,
    trustSafety,
    jobs,
    privacyRequests,
    privacyHolds,
    approvals,
    support,
  };
}
