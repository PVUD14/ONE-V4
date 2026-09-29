/**
 * College account fields (OPS-14, migration 0078): renewal date, contract reference, AI8HT
 * account owner and the college's contacts, as Operations → Organization Detail reads and
 * changes them.
 *
 * Every write takes the account row lock, writes its change and its audit row in one
 * transaction, and names a reason code. Contacts leave this module masked, except through
 * `revealCollegeContact`, which writes its audit row before it returns the values. Audit
 * rows never carry a contact's name, email or phone.
 *
 * Design: docs/architecture/institution-accounts-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { collegeContactLimit, maskEmail, maskPhone, type CollegeContactRole } from '@planthepath/authorization/src/index.js';
import { validateAuditWriteInput } from './repositories.js';

export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export type CollegeAccountErrorCode =
  | 'COLLEGE_NOT_FOUND'
  | 'COLLEGE_ACCOUNT_VERSION_CONFLICT'
  | 'COLLEGE_ACCOUNT_OWNER_INVALID'
  | 'COLLEGE_ACCOUNT_UNCHANGED'
  | 'COLLEGE_CONTACT_NOT_FOUND'
  | 'COLLEGE_CONTACT_LIMIT_REACHED'
  | 'COLLEGE_ACCOUNT_REJECTED';

export class CollegeAccountError extends Error {
  constructor(readonly code: CollegeAccountErrorCode) {
    super(code);
    this.name = 'CollegeAccountError';
  }
}

export interface CollegeContactView {
  readonly id: string;
  readonly role: CollegeContactRole;
  readonly name: string;
  /** Masked (§5.5): `a***@college.edu`; the full value only through the audited reveal. */
  readonly email: string | null;
  /** Masked: `***1234`. */
  readonly phone: string | null;
  readonly addedAt: string;
}

export interface CollegeAccountView {
  readonly institution: { readonly id: string; readonly name: string; readonly verificationState: string; readonly active: boolean };
  /** Null until an operator first saves something for this college. */
  readonly account: {
    readonly renewalDate: string | null;
    readonly contractReference: string | null;
    readonly accountOwner: { readonly membershipId: string; readonly email: string; readonly role: string; readonly active: boolean } | null;
    readonly version: number;
    readonly updatedAt: string;
  } | null;
  readonly contacts: readonly CollegeContactView[];
  readonly contactLimit: number;
}

export interface CollegeAccountOwnerOption {
  readonly membershipId: string;
  readonly email: string;
  readonly role: string;
}

async function audit(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
            ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

/** The college's account fields with masked contacts, or null when the id is not an institution. */
export async function loadCollegeAccount(runner: SqlRunner, institutionId: string): Promise<CollegeAccountView | null> {
  const [college] = await rows<{ id: string; name: string; verification_state: string; active: boolean }>(runner, sql`
    SELECT o.id, COALESCE(NULLIF(p.display_name, ''), o.legal_name) AS name, o.verification_state::text AS verification_state, o.active
    FROM organizations o LEFT JOIN organization_profiles p ON p.organization_id = o.id
    WHERE o.id = ${institutionId}::uuid AND o.kind = 'INSTITUTION'
  `);
  if (!college) return null;
  const [account] = await rows<{
    renewal_date: string | null; contract_reference: string | null; version: number; updated_at: Date | string;
    owner_membership_id: string | null; owner_email: string | null; owner_role: string | null; owner_active: boolean | null;
  }>(runner, sql`
    SELECT to_char(a.renewal_date, 'YYYY-MM-DD') AS renewal_date, a.contract_reference, a.version, a.updated_at,
           m.id AS owner_membership_id, u.email AS owner_email, m.role AS owner_role,
           (m.state = 'ACTIVE' AND u.state = 'ACTIVE') AS owner_active
    FROM institution_accounts a
    LEFT JOIN organization_memberships m ON m.id = a.account_owner_membership_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE a.institution_id = ${institutionId}::uuid
  `);
  const contacts = await rows<{ id: string; contact_role: CollegeContactRole; full_name: string; email: string | null; phone: string | null; created_at: Date | string }>(runner, sql`
    SELECT id, contact_role, full_name, email, phone, created_at FROM institution_account_contacts
    WHERE institution_id = ${institutionId}::uuid AND removed_at IS NULL
    ORDER BY created_at, id
  `);
  return {
    institution: { id: college.id, name: college.name, verificationState: college.verification_state, active: college.active },
    account: account ? {
      renewalDate: account.renewal_date,
      contractReference: account.contract_reference,
      accountOwner: account.owner_membership_id && account.owner_email && account.owner_role
        ? { membershipId: account.owner_membership_id, email: account.owner_email, role: account.owner_role, active: account.owner_active === true }
        : null,
      version: account.version,
      updatedAt: new Date(account.updated_at).toISOString(),
    } : null,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      role: contact.contact_role,
      name: contact.full_name,
      email: maskEmail(contact.email),
      phone: maskPhone(contact.phone),
      addedAt: new Date(contact.created_at).toISOString(),
    })),
    contactLimit: collegeContactLimit,
  };
}

/** Who may be named account owner: ACTIVE internal memberships of the ONE platform organisation. */
export async function listCollegeAccountOwnerOptions(runner: SqlRunner): Promise<readonly CollegeAccountOwnerOption[]> {
  const found = await rows<{ membership_id: string; email: string; role: string }>(runner, sql`
    SELECT m.id AS membership_id, u.email, m.role
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.state = 'ACTIVE' AND m.role IN ('PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN')
    ORDER BY u.email, m.role
    LIMIT 200
  `);
  return found.map((row) => ({ membershipId: row.membership_id, email: row.email, role: row.role }));
}

interface WriteContext {
  readonly institutionId: string;
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly correlationId: string;
}

/** Lock the college's account row, creating it (empty) first when it does not exist yet. */
async function lockAccount(tx: SqlRunner, institutionId: string, actorUserId: string): Promise<{ version: number; created: boolean }> {
  const [college] = await rows<{ id: string }>(tx, sql`SELECT id FROM organizations WHERE id = ${institutionId}::uuid AND kind = 'INSTITUTION' FOR SHARE`);
  if (!college) throw new CollegeAccountError('COLLEGE_NOT_FOUND');
  const inserted = await rows<{ version: number }>(tx, sql`
    INSERT INTO institution_accounts (institution_id, updated_by_user_id) VALUES (${institutionId}::uuid, ${actorUserId}::uuid)
    ON CONFLICT (institution_id) DO NOTHING
    RETURNING version
  `);
  const [locked] = await rows<{ version: number }>(tx, sql`SELECT version FROM institution_accounts WHERE institution_id = ${institutionId}::uuid FOR UPDATE`);
  return { version: locked!.version, created: inserted.length > 0 };
}

export interface CollegeAccountPatch {
  readonly renewalDate?: string | null;
  readonly contractReference?: string | null;
  readonly accountOwnerMembershipId?: string | null;
}

/**
 * Change the account fields present in `patch`. `expectedVersion` is the version the
 * operator saw, or null when they saw no account yet. The audit row records each changed
 * field with its before and after value; none of them is personal data.
 */
export async function updateCollegeAccount(db: TransactionalRunner, input: WriteContext & {
  readonly patch: CollegeAccountPatch; readonly expectedVersion: number | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const { version, created } = await lockAccount(tx, input.institutionId, input.actorUserId);
    const expected = input.expectedVersion ?? 1;
    if (version !== expected || (input.expectedVersion !== null && created)) throw new CollegeAccountError('COLLEGE_ACCOUNT_VERSION_CONFLICT');
    const [before] = await rows<{ renewal_date: string | null; contract_reference: string | null; account_owner_membership_id: string | null }>(tx, sql`
      SELECT to_char(renewal_date, 'YYYY-MM-DD') AS renewal_date, contract_reference, account_owner_membership_id
      FROM institution_accounts WHERE institution_id = ${input.institutionId}::uuid
    `);
    const current = { renewalDate: before!.renewal_date, contractReference: before!.contract_reference, accountOwnerMembershipId: before!.account_owner_membership_id };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const key of ['renewalDate', 'contractReference', 'accountOwnerMembershipId'] as const) {
      if (input.patch[key] === undefined) continue;
      const next = input.patch[key] ?? null;
      if (next !== current[key]) changes[key] = { from: current[key], to: next };
    }
    if (!Object.keys(changes).length) throw new CollegeAccountError('COLLEGE_ACCOUNT_UNCHANGED');
    const next = {
      renewalDate: changes.renewalDate ? changes.renewalDate.to : current.renewalDate,
      contractReference: changes.contractReference ? changes.contractReference.to : current.contractReference,
      accountOwnerMembershipId: changes.accountOwnerMembershipId ? changes.accountOwnerMembershipId.to : current.accountOwnerMembershipId,
    };
    await tx.execute(sql`SAVEPOINT college_account_update`);
    try {
      await tx.execute(sql`
        UPDATE institution_accounts
        SET renewal_date = ${next.renewalDate}::date, contract_reference = ${next.contractReference},
            account_owner_membership_id = ${next.accountOwnerMembershipId}::uuid,
            version = version + 1, updated_by_user_id = ${input.actorUserId}::uuid
        WHERE institution_id = ${input.institutionId}::uuid
      `);
    } catch (error) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT college_account_update`);
      const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : '';
      if (/account owner must be/.test(message)) throw new CollegeAccountError('COLLEGE_ACCOUNT_OWNER_INVALID');
      throw new CollegeAccountError('COLLEGE_ACCOUNT_REJECTED');
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_account.updated', resourceType: 'institution_account',
      resourceId: input.institutionId, organizationId: input.institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, changes, ...(input.note ? { note: input.note } : {}) },
    });
  });
}

/** Add a contact (at most `collegeContactLimit` live per college). Returns its id. */
export async function addCollegeContact(db: TransactionalRunner, input: WriteContext & {
  readonly role: CollegeContactRole; readonly name: string; readonly email: string | null; readonly phone: string | null;
}): Promise<string> {
  return db.transaction(async (tx) => {
    await lockAccount(tx, input.institutionId, input.actorUserId);
    const [live] = await rows<{ n: number }>(tx, sql`
      SELECT count(*)::int AS n FROM institution_account_contacts WHERE institution_id = ${input.institutionId}::uuid AND removed_at IS NULL
    `);
    if ((live?.n ?? 0) >= collegeContactLimit) throw new CollegeAccountError('COLLEGE_CONTACT_LIMIT_REACHED');
    const id = randomUUID();
    await tx.execute(sql`
      INSERT INTO institution_account_contacts (id, institution_id, contact_role, full_name, email, phone, added_by_user_id, added_reason_code)
      VALUES (${id}::uuid, ${input.institutionId}::uuid, ${input.role}, ${input.name}, ${input.email}, ${input.phone},
              ${input.actorUserId}::uuid, ${input.reasonCode})
    `);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_account.contact_added', resourceType: 'institution_account_contact',
      resourceId: id, organizationId: input.institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, role: input.role, fields: presentFields(input), ...(input.note ? { note: input.note } : {}) },
    });
    return id;
  });
}

/** Remove a live contact, erasing its name, email and phone in the same statement. */
export async function removeCollegeContact(db: TransactionalRunner, input: WriteContext & { readonly contactId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockAccount(tx, input.institutionId, input.actorUserId);
    const removed = await rows<{ contact_role: string }>(tx, sql`
      UPDATE institution_account_contacts
      SET removed_at = now(), removed_by_user_id = ${input.actorUserId}::uuid, removed_reason_code = ${input.reasonCode},
          full_name = NULL, email = NULL, phone = NULL
      WHERE id = ${input.contactId}::uuid AND institution_id = ${input.institutionId}::uuid AND removed_at IS NULL
      RETURNING contact_role
    `);
    if (!removed.length) throw new CollegeAccountError('COLLEGE_CONTACT_NOT_FOUND');
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_account.contact_removed', resourceType: 'institution_account_contact',
      resourceId: input.contactId, organizationId: input.institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, role: removed[0]!.contact_role, ...(input.note ? { note: input.note } : {}) },
    });
  });
}

/** A live contact's full email and phone, audited in the same transaction before it returns. */
export async function revealCollegeContact(db: TransactionalRunner, input: WriteContext & { readonly contactId: string }): Promise<{ readonly email: string | null; readonly phone: string | null }> {
  return db.transaction(async (tx) => {
    const [contact] = await rows<{ contact_role: string; email: string | null; phone: string | null }>(tx, sql`
      SELECT contact_role, email, phone FROM institution_account_contacts
      WHERE id = ${input.contactId}::uuid AND institution_id = ${input.institutionId}::uuid AND removed_at IS NULL
    `);
    if (!contact) throw new CollegeAccountError('COLLEGE_CONTACT_NOT_FOUND');
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_account.contact_revealed', resourceType: 'institution_account_contact',
      resourceId: input.contactId, organizationId: input.institutionId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, role: contact.contact_role, fields: presentFields(contact), ...(input.note ? { note: input.note } : {}) },
    });
    return { email: contact.email, phone: contact.phone };
  });
}

function presentFields(contact: { readonly email: string | null; readonly phone: string | null }): string[] {
  return [...(contact.email ? ['email'] : []), ...(contact.phone ? ['phone'] : [])];
}
