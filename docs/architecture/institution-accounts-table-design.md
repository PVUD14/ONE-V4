# Institution Accounts and College Health — Table and Metric Design

**Status:** Adopted (OPS-14), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0078_institution_accounts.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Customer success has to show each college the value it is getting and spot renewal risk early.
Today an operator cannot see either from the console. There is nowhere to record when a college's
agreement renews, which AI8HT person looks after it, or whom to call at the college. Every health
figure also needs someone to run SQL.

OPS-14 adds two things:

1. **Account fields** on a college: renewal date, contract reference, AI8HT account owner, and the
   college's own contacts. These appear on Operations → Organization Detail. They are editable
   only with `ACCOUNT_MANAGE`, audited with a reason code, and unknown fields are rejected.
2. **College health**: aggregate figures per college on Operations → Analytics, needing
   `ANALYTICS_VIEW`. They are built only from tables that exist and pass through the shared
   suppression helper (`packages/authorization/src/aggregate-suppression.ts`).

Billing stays deferred (ADR-022). **No amount, price, seat count or payment term is stored
anywhere.** The contract reference is an identifier that points at the paper agreement held
outside ONE.

## Decision: a one-row-per-college `institution_accounts` table plus a contacts table

**Chosen.** `institution_accounts` is keyed by `institution_id`, with one row per college, created
the first time an operator saves anything for that college. `institution_account_contacts` holds
the college's contacts, one row per person. A contact is either live or removed. Removing a
contact erases its personal fields.

**Rejected: columns on `organization_profiles`.** That table is the college's public-facing
profile, and the college's own settings screens and the onboarding controller write to it. Account
fields are AI8HT's internal commercial record. They need a different capability, their own audit
actions and a no-delete rule, and they must never be served to a college or an employer. Keeping
them in a separate table means no existing profile query can leak them by accident.

**Rejected: contacts as a `jsonb` array on the account row.** Removal has to erase one person's
details. That erasure must be checkable by a CHECK constraint and a trigger, not by application
code rewriting an array. Each contact also needs its own id for an audited reveal.

**Rejected: linking contacts to ONE `users`.** Many college contacts (a principal, an accounts
officer) will never hold a ONE account. Tying them to `users` would force invitations nobody asked
for, and would mix a commercial address book into identity.

## `institution_accounts`

| Column | Type | Rule |
|---|---|---|
| `institution_id` | uuid PK → `organizations(id)` | The trigger requires `kind = 'INSTITUTION'` |
| `renewal_date` | date NULL | Between 2000-01-01 and 2100-12-31 |
| `contract_reference` | text NULL | 1–64 characters of `[A-Za-z0-9/_.:-]` with no spaces, starting with a letter or digit. It is an identifier, not a note: no currency symbols, commas or spaces, so an amount such as "Rs 5,00,000" cannot be typed into it |
| `account_owner_membership_id` | uuid NULL → `organization_memberships(id)` | Checked by the trigger when set or changed: an ACTIVE membership of the PLATFORM organisation in one of the three internal roles |
| `version` | integer ≥ 1 | Optimistic concurrency. The API sends `expectedVersion`, and a stale write returns 409 |
| `created_at`, `updated_at` | timestamptz | Stamped by the database (`now()`), never by Node |
| `updated_by_user_id` | uuid → `users(id)` | The last writer. Full history is in `audit_events` |

The trigger also refuses `DELETE`, and refuses any change to `institution_id` or `created_at`.

## `institution_account_contacts`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `institution_id` | uuid → `institution_accounts(institution_id)` | The account row is created first, in the same transaction |
| `contact_role` | text | `PRINCIPAL`, `PLACEMENT_OFFICER`, `ACADEMIC_COORDINATOR`, `IT_CONTACT`, `ACCOUNTS`, `OTHER` |
| `full_name` | text NULL | 1–120 characters. NULL only once removed |
| `email` | text NULL | Lower-case address of at most 254 characters |
| `phone` | text NULL | `+`, digits, spaces, `()` and `-`, 6–24 characters |
| `added_by_user_id`, `added_reason_code`, `created_at` | | Set once |
| `removed_at`, `removed_by_user_id`, `removed_reason_code` | NULL until removed | Set together, once |

CHECKs:

- A live contact has a name and at least one of email or phone.
- A removed contact has **no** name, email or phone. Removal erases the personal fields in the
  same statement.
- Reason codes match `^[A-Z0-9_:-]{3,64}$`.

The trigger allows exactly one update: live → removed, with the three personal fields cleared.
Nothing else may change, a removed contact cannot be changed again, and `DELETE` is refused. To
correct a contact, remove it and add it again, so the audit trail records both steps.

The API allows at most **10 live contacts per college**. It counts them under a row lock on the
account row. This is a sanity bound, not a business rule, so it lives in code and not in a CHECK.

## Privacy and data minimisation (§5.5)

- Contacts are personal data of college staff, supplied by the college. The account view returns
  **role, name, masked email (`a***@college.edu`) and masked phone (`***1234`)**, using the
  support desk's `maskEmail` and `maskPhone`.
- The full email and phone come back only from `POST …/contacts/:id/reveal`, which takes a reason
  code and writes `operations.institution_account.contact_revealed` in the same transaction,
  before the values are returned.
- Audit rows never carry contact values. They carry the contact id, its role, which fields were
  present, and the reason code.
- A person who asks to be forgotten is removed with reason `PRIVACY_REQUEST`, which erases the
  personal fields. Only the role and timestamps remain, and those identify nobody.
- Account fields and contacts are never served by any institution, employer or student endpoint.

## Authorisation, reason codes and audit

| Endpoint | Capability | Audit action | Reason codes |
|---|---|---|---|
| `GET /operations/college-accounts/:institutionId` | ACCOUNT_MANAGE | none (masked view) | — |
| `GET /operations/college-accounts/owners` | ACCOUNT_MANAGE | none (internal staff list) | — |
| `PATCH /operations/college-accounts/:institutionId` | ACCOUNT_MANAGE | `operations.institution_account.updated` | NEW_CONTRACT, RENEWAL_AGREED, OWNER_HANDOVER, CORRECTION |
| `POST …/contacts` | ACCOUNT_MANAGE | `operations.institution_account.contact_added` | NEW_CONTACT, CONTACT_REPLACED, CORRECTION |
| `POST …/contacts/:contactId/remove` | ACCOUNT_MANAGE | `operations.institution_account.contact_removed` | CONTACT_LEFT, CONTACT_REPLACED, PRIVACY_REQUEST, CORRECTION |
| `POST …/contacts/:contactId/reveal` | ACCOUNT_MANAGE | `operations.institution_account.contact_revealed` | RENEWAL_OUTREACH, SUPPORT_FOLLOW_UP, ONBOARDING, ESCALATION |
| `GET /operations/analytics/colleges` and `/:institutionId` | ANALYTICS_VIEW | none (suppressed aggregates, as the Overview and OPS-11) | — |

- By baseline (ADR-032), OPERATIONS_ADMIN and the super admin hold both capabilities. Anyone else
  needs a grant.
- Reads share the write capability, as OPS-01's D4 decided for every module.
- Every write takes an optional note of at most 500 characters. It is kept only in the audit
  context, and the UI tells the operator not to put personal data in it.
- The update audit row records the changed field names with their before and after values. None of
  those values is personal: a date, a reference, and a membership id.
- **Dual control: none.** §5.4 does not list account fields, and nothing here suspends,
  un-verifies, exports personal data or changes readiness. No outbox event is written, because no
  consumer needs one: renewal reminders would be a later automation goal.

## College health: what each figure counts, and from what

Every figure below has a real source. Where no source exists, the screen shows **NA** in the same
slot and says why.

**Counts of people** go through `suppressSmallCount` or `suppressAggregateTable`. Any count below
5, zero included, leaves the server only as `<5`. **Counts of work items** (support cases) are not
suppressed, following OPS-03's rule for the Overview.

**Windows are fixed calendar periods, never "the last 7 days".** A rolling window can be read on
two consecutive days and differenced to isolate one person's activity. A complete ISO week
(Monday to Sunday, UTC), or an ended calendar month, gives the same answer every time it is read
until the next period closes. This is the period rule INST-SR-01 set for the college's own
reports. Week and month boundaries are computed in SQL from the database's `now()`.

| Figure | Source | Definition |
|---|---|---|
| Students rostered | `institution_relationships`, `users` | Students with a current relationship (VERIFIED or ACTIVE, in window), whose account is not deleted, pending deletion or anonymised |
| Signed in / not yet | `users.state` | Of those, the account is ACTIVE (INST-01's "Activated") or it is not. Two cells go through `suppressAggregateTable`, so the rostered total is withheld when the smaller cell is 1–4 |
| Weekly active learners | `learner_activity_events` (0015) | Distinct students with at least one learning event in the last complete ISO week, whose relationship with this college covered the event's time (the same predicate as the INST-08 exports). The list shows one week and the college view the last four, each suppressed on its own |
| Assessments taken | `exam_attempts` (0012) | Attempts at this college's assessments submitted or auto-submitted in the last ended month, with the distinct students who took them. Each is suppressed |
| Readiness band distribution | `readiness_snapshots`, through `institutionReadinessDistribution` | The college's own report function, called for the last ended month: each student's latest snapshot in that month. Bands only, never a number (ADR-020). Suppressed cell by cell, with the total withheld when it would reveal a hidden band |
| Staff members / active last week | `organization_memberships`, `audit_events` | ACTIVE staff memberships at the college, split into people who wrote at least one audit event for this college in the last complete ISO week and those who did not. The two cells go through `suppressAggregateTable` |
| Staff actions opened last week | `staff_actions` (0020) | Interventions, tasks, notes, verifications and meetings opened in the last complete week. Counselling notes are never counted (INST-11). Suppressed like INST-08's staff-action export |
| Open support cases | `support_cases` (0043) | Cases for this organisation in OPEN, IN_PROGRESS or WAITING_ON_CUSTOMER, with how many are past their SLA. Work items, not suppressed |
| Verification state, active | `organizations` | As stored |
| Renewal date | `institution_accounts` | NA when not recorded |

**Not shown, because there is no honest source.** The plan's customer-success row mentions
readiness-band *movement*. A per-student movement count would need two snapshots per student, and
a cross-month difference of two suppressed tables. The college view instead shows one ended month's
distribution, and the movement slot says NA with that reason. There is no health score, no
predicted churn and no invented composite.

### No totals across colleges

The list never shows a total of people summed over colleges. A "learners across all colleges" total
beside per-college cells would let a suppressed college be recovered by subtraction. The only
totals on the Analytics header count colleges or work items: colleges, colleges renewing within 90
days, colleges with no renewal date, and open cases.

### Ordering

The list is sorted server-side by renewal date (soonest first, unset last), then by weekly active
learners, then by name. Activity ordering uses **published values only**. A college whose count is
suppressed sorts after every shown count and then by name, never by its true size, because order is
itself a disclosure (OPS-11). The web table offers the same two orders over the same rule.

### Bounds

The list is one bounded summary of at most 500 colleges, with `collegesCapped`. It is computed as
one grouped statement per figure over all colleges, not one query per college. Like OPS-11, it
takes no query parameters, and any parameter returns 400. The college view is one college. Neither
endpoint writes an audit row, because both are suppressed aggregates with no personal data (the
Overview and OPS-11 precedent).

## Rejected options

- **A composite "health score".** It would be an invented number with no agreed definition, and it
  would invite comparison with the readiness score this product refuses to compute.
- **Rolling 7- and 30-day windows.** These can be differenced day to day (see above).
- **Owner email in the analytics list.** It is not needed to rank renewal risk, so it is kept to the
  account view (`ACCOUNT_MANAGE`), which is data minimisation.
- **Storing the contract value "for later".** Billing is deferred (ADR-022), and a column nobody may
  fill is an invitation to fill it.
- **Dual control for owner or renewal changes.** Not in §5.4. These changes are reversible and fully
  audited.

## Open points (decisions for Divakar)

1. **Weekly active uses complete ISO weeks in UTC.** Recommended and adopted. An IST week would move
   the boundary 5½ hours, which does not matter at pilot scale.
2. **"Signed in" means an activated account** (INST-01). ONE records no per-sign-in history for
   students, and none is added here.
3. **Staff "active" means wrote an audit event for the college in the week.** Reads are mostly not
   audited, so a staff member who only looked at dashboards counts as inactive. The screen says so.
