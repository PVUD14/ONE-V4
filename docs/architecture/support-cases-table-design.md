# Support Cases — Table Design

**Status:** Adopted (OPS-05), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0043_support_cases.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

College and student issues arrive by email, phone and WhatsApp and leave no record. Nobody can
later say who called, what was wrong, who handled it, or whether the same fault keeps coming back.
That fails audits and disputes, and it wastes the only signal a founder-run pilot has about what is
breaking. Appendix 1 §3 gives Support two jobs: log every call or email as a case, and look up a
user's account state without an engineer. §6.3 names the tables: `support_cases` and
`support_case_events`.

A support case is a record *about a person* — it can name them, and its summary and notes are free
text an operator typed while talking to them. That is why it gets a design document: the privacy
deletion flow has to be able to strip it, and nothing in it may become a back door to data the
operations console is otherwise forbidden to show (§5.5: no academic content, no AI conversations,
no document contents).

## Decision: two new tables, not a reuse of `trust_cases`

**Chosen.** `support_cases` (the current state of one case) and `support_case_events` (append-only
history: opening, state changes, notes, assignments).

**Rejected: reuse `trust_cases` with a new `case_type`.** Trust cases are enforcement records —
their state machine has a right of reply, decisions and appeals, their subject shape allows
organisations, opportunity versions and content revisions, and the no-self-review trigger assumes a
reporter who must not decide. A support case is none of those things: it is a service record with
an optional person attached. Folding support into trust would mean either widening
`trust_case_state_ck` (relaxing a constraint that currently makes an invalid trust transition
impossible) or bending support into states that mean something else. Separate tables keep both
strict.

**Rejected: one table with a JSON history column.** History in a JSON array cannot be made
append-only by the database, cannot be indexed by time, and cannot be redacted row by row on a
privacy deletion. A child table can be all three.

## `support_cases`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `organization_id` | uuid NULL → `organizations(id)`. The college or employer the case concerns. Nullable: a student with no college on ONE can still call. |
| `subject_user_id` | uuid NULL → `users(id)`. The person the case is about. Optional (an institution-level issue has no single subject). Set to NULL by a privacy deletion. |
| `subject_detached_at` | timestamptz NULL. When a privacy deletion removed the subject. `subject_detached_at IS NOT NULL ⇒ subject_user_id IS NULL`. |
| `channel` | text NOT NULL, CHECK in (`EMAIL`, `PHONE`, `WHATSAPP`, `IN_APP`). How the issue arrived. |
| `category` | text NOT NULL, CHECK in (`ACCOUNT_ACCESS`, `INVITATION`, `ONBOARDING`, `DATA_CORRECTION`, `PRIVACY_REQUEST`, `TECHNICAL_FAULT`, `HOW_TO`, `COMPLAINT`, `OTHER`). |
| `severity` | text NOT NULL, CHECK in (`LOW`, `MEDIUM`, `HIGH`, `URGENT`). Fixed at creation (see Open points). |
| `state` | text NOT NULL DEFAULT `'OPEN'`, CHECK in (`OPEN`, `IN_PROGRESS`, `WAITING_ON_CUSTOMER`, `RESOLVED`, `CLOSED`). |
| `summary` | text NOT NULL, 3–500 characters. One line an operator can type during a call. Replaced by a fixed placeholder on privacy deletion. |
| `summary_redacted_at` | timestamptz NULL. When a deletion replaced the summary. |
| `assigned_to_user_id` | uuid NULL → `users(id)`. The operator who owns the case. Must hold SUPPORT_CASES (checked by the API; see below). |
| `opened_by_user_id` | uuid NOT NULL → `users(id)`. The operator who logged it. |
| `opening_reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$`. Why the case was opened (§5.3). |
| `opened_at` | timestamptz NOT NULL, stamped by the trigger from the database clock. |
| `sla_due_at` | timestamptz NOT NULL, stamped by the trigger: `opened_at` + the severity's target. |
| `resolved_at` | timestamptz NULL. Set on entering `RESOLVED`; cleared if the case is reopened. |
| `closed_at` | timestamptz NULL. Set on entering `CLOSED`. |
| `updated_at` | timestamptz NOT NULL. |
| `version` | integer NOT NULL DEFAULT 1, ≥ 1, incremented on every change. |

Constraints: `state = 'CLOSED' ⇔ closed_at IS NOT NULL`; `state = 'RESOLVED' ⇒ resolved_at IS NOT NULL`;
`state IN ('OPEN','IN_PROGRESS','WAITING_ON_CUSTOMER') ⇒ resolved_at IS NULL`; `sla_due_at > opened_at`;
the detachment rule above. Indexes: the queue `(state, opened_at DESC, id DESC)`; the keyset list
`(opened_at DESC, id DESC)`; `subject_user_id` (for the account view and for deletion);
`assigned_to_user_id`; `organization_id`.

**No contact columns.** The case does not copy the caller's email, phone number or name. When the
caller has an account, `subject_user_id` points at it and the account view shows the masked contact;
when they do not, the operator describes them in the summary without contact details (the UI says
so). Copying contact data into a second table would create a second place a deletion has to find.

## `support_case_events`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `case_id` | uuid NOT NULL → `support_cases(id)`. |
| `event_kind` | text NOT NULL, CHECK in (`OPENED`, `STATE_CHANGED`, `NOTE`, `ASSIGNED`). |
| `from_state`, `to_state` | text NULL. Required and different for `STATE_CHANGED`; `to_state = 'OPEN'`, `from_state` NULL for `OPENED`; both NULL otherwise. |
| `assignee_user_id` | uuid NULL → `users(id)`. The new assignee for `ASSIGNED` (NULL = unassigned). |
| `note` | text NULL, ≤ 2000 characters. Required for `NOTE`. Set to NULL on privacy deletion. |
| `linked_correlation_id` | text NULL, `^[A-Za-z0-9._:-]{8,128}$`. The reference a user read out from an error screen, linking the case to the audit trail for that request. |
| `reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$`. |
| `actor_user_id` | uuid NOT NULL → `users(id)`. |
| `correlation_id` | text NOT NULL. The request that wrote this row; the same value is on its audit row. |
| `occurred_at` | timestamptz NOT NULL DEFAULT now(). |
| `redacted_at` | timestamptz NULL. When a deletion removed the note. `redacted_at IS NOT NULL ⇒ note IS NULL`. |

Append-only, enforced by a trigger: no row is ever deleted, and the only permitted update is the
redaction (setting `note` to NULL and stamping `redacted_at`, with every other column unchanged).
Index `(case_id, occurred_at, id)`.

## State machine

| From | To |
| --- | --- |
| `OPEN` | `IN_PROGRESS`, `WAITING_ON_CUSTOMER`, `RESOLVED`, `CLOSED` |
| `IN_PROGRESS` | `WAITING_ON_CUSTOMER`, `RESOLVED` |
| `WAITING_ON_CUSTOMER` | `IN_PROGRESS`, `RESOLVED`, `CLOSED` |
| `RESOLVED` | `IN_PROGRESS` (reopen), `CLOSED` |
| `CLOSED` | — (terminal) |

`OPEN → CLOSED` exists for a duplicate or a misdirected contact; `WAITING_ON_CUSTOMER → CLOSED` for
a customer who never replied. Everything else goes through `RESOLVED`, so a closed case with a
resolution time says it was fixed and one without says it was not. The machine is declared once, as
data, in `packages/authorization/src/support-desk.ts`; the API refuses an invalid transition with
400 `SUPPORT_CASE_TRANSITION_NOT_ALLOWED`, and the `support_case_guard` trigger repeats the same table
so another writer cannot skip it. Each target state has its own reason codes.

## SLA defaults by severity

| Severity | First-resolution target |
| --- | --- |
| `URGENT` | 4 hours |
| `HIGH` | 24 hours |
| `MEDIUM` | 72 hours |
| `LOW` | 120 hours (5 days) |

Calendar hours, not business hours: the pilot has no support rota to base business hours on. The
trigger stamps `sla_due_at` from the database clock so it cannot be backdated by the caller. A case
is *overdue* while it is not `RESOLVED`/`CLOSED` and `now() > sla_due_at`; that is derived at read
time, never stored.

## Who may do what

- `SUPPORT_CASES` — create, list, read, transition, note, assign. Baseline for `OPERATIONS_ADMIN`
  (and the super admin), grantable to any platform membership (ADR-032).
- `SUPPORT_ACCOUNT_LOOKUP` — account search, account view, contact reveal. Baseline for
  `OPERATIONS_ADMIN` and `SECURITY_ADMIN`.
- An assignee must hold `SUPPORT_CASES` through an ACTIVE platform membership; the API computes this
  with the same pure functions (`effectiveInternalCapabilities`) and refuses anyone else with 400
  `SUPPORT_ASSIGNEE_NOT_ELIGIBLE`.

## Privacy and data minimisation (§5.5)

- **Masked by default.** Account search, the account view and a case's subject line show the email
  masked (`a***@college.edu`) and the phone as its last four digits. ONE stores no phone number
  today, so that slot shows `NA`. The full value comes only from a separate
  `POST …/contact-reveal` call that requires a reason code and writes
  `operations.support_account.contact_revealed`.
- **Reads are audited.** The account view writes `operations.support_account.viewed`; a search writes
  `operations.support_account.searched` (result count and query kind only — the search text itself
  is not copied into audit); opening a case's detail writes `operations.support_case.viewed`.
- **What the account view shows.** State, identity-link status, memberships (organisation, role,
  state), student relationships (institution, state, dates), invitations (organisation, role, state,
  delivery state), open support cases, and the last 20 audit events for the person (action, outcome,
  time, reference). No academic records, readiness, assessment answers, documents, assistant
  conversations or audit `context` payloads.

## Deletion and retention

A support case is a record the *operator* holds about a service interaction, so like an employer's
application record it survives a privacy deletion with the person removed from it. The privacy
worker (`executeDueDeletions`, `apps/api/src/http/privacy-deletion.ts`) gains a step, before identity
is anonymised, that for every case whose `subject_user_id` is the deleted person:

1. sets `subject_user_id = NULL` and `subject_detached_at = now()`;
2. replaces `summary` with the fixed text `Summary removed on privacy deletion.` and stamps
   `summary_redacted_at` — the summary is free text typed while talking to the person and must be
   presumed identifying;
3. redacts every note on those cases (`note = NULL`, `redacted_at = now()`).

What remains — organisation, channel, category, severity, state, timestamps, SLA, assignee, reason
codes, correlation IDs — says that a case of this kind happened and how it was handled, and nothing
about who it was. A new deletion category `SUPPORT_CASES` with disposition `ANONYMISED` records the
count in `privacy_deletion_records`, so the deletion evidence says what happened to them; this needs
the 0009 category CHECK widened by one value in 0043 (the existing values are unchanged). A
retention hold on the person blocks the whole deletion exactly as before.

Retention of the cases themselves (how long a closed, detached case is kept) follows the approved
retention schedule for operational records; no automatic purge is built here.

## Audit and outbox

Every write — open, transition, note, assign — writes its `support_case_events` row, an
`audit_events` row (`operations.support_case.{opened,transitioned,note_added,assigned}`, reason code
in `context`) and, for open, transition and assign, an outbox event
(`support_case.{opened,state_changed,assigned}`, identifiers and enums only) in one transaction.
Lists are keyset paginated on `(opened_at, id)`, default 50, maximum 200.

## Rejected alternatives

- **Store the caller's contact details on the case** — rejected above: a second copy of personal data
  for deletion to chase, and the account already holds it.
- **Hard-delete a deleted person's cases** — destroys the operational history other people (the
  college, the operator) have a legitimate interest in, and the evidence that the service handled a
  complaint; detachment keeps the record and removes the person, as `applications` already does.
- **Allow `CLOSED` from every state** — a close without resolution would then be indistinguishable
  from a fix; the limited edges keep that meaning in the data.
- **Store an `overdue` flag** — it would go stale the moment it was written; derived instead.

## Open points (decisions for Divakar)

1. **Severity changes after opening.** Not supported in this goal: severity is fixed at creation so
   the SLA stamp is honest. If a re-grade is needed, the recommendation is a `SEVERITY_CHANGED`
   event kind that re-stamps the SLA from the change time, added by a later migration.
2. **Business-hours SLAs.** Calendar hours until a support rota exists.
