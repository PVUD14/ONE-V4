# Trust & Safety Cases — Table Design for Circulation

**Status:** Circulated for comment — not yet implemented
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Migration:** Core block, `0032`
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

There is no Trust & Safety domain: no table, no endpoint, no service, no UI. The Operations nav item
renders a not-yet-available state. Meanwhile the product already tells students they may report an
employer for misrepresenting a job, and the specification describes the workflow in detail.

Two pieces are built and going nowhere:

- **`opportunity_review_signals`** records four detector codes — `APPLICANT_PAYMENT_DEMAND`,
  `CROSS_EMPLOYER_DUPLICATE`, `MISSING_COMPENSATION`, `IMPLAUSIBLE_COMPENSATION` — on every
  opportunity publish, with a partial index over pending rows that is quite plainly a queue index.
  **Nothing reads it.** Its header says *"Advisory evidence only. Operations owns review decisions and
  their UI."* That UI is this.
- **`data_retention_holds`** already carries the reason codes `SAFETY_INVESTIGATION`,
  `EMPLOYER_ACCOUNTABILITY_CASE` and `DISPUTE`, and the deployed privacy-deletion sweep already
  honours them. A case can suspend an erasure today; only the API to place the hold is missing.

So a student reports a fraudulent listing and there is nowhere to put it, while the detector that
spotted the same listing writes to a table with no reader.

## Two rules that shape everything below

**A report is not a penalty.** Spec §38: *"A report creates a case; it does not automatically
penalize the employer."* The case record and the enforcement record are therefore separate tables, so
that deciding and punishing are distinct acts and an appeal can reverse the second without rewriting
the first.

**Safety never touches readiness.** Spec §7.16 and §30: integrity and misuse signals feed safety
workflows and must not be blended into the readiness band or exposed to employers as an unexplained
"genuineness score". No column here references readiness, and a test should assert that opening,
deciding or actioning a case leaves a student's band untouched.

## Why not reuse `staff_actions`

`staff_actions` is the closest structural precedent in the repository and the temptation is real: a
10-state machine, a type discriminator, actor/assignee/subject, optimistic `version`, a reviewer-pair
constraint, five purpose-built indexes.

It is rejected because it is institution-scoped by construction — `institution_id` is `NOT NULL`, and
composite foreign keys pin its department and batch columns to that same institution. A platform case
about an employer has no institution, and making `institution_id` nullable would weaken constraints
that currently make cross-institution leakage structurally impossible.

**The shape is borrowed; the table is not.** The transition ledger follows `content_review_actions`
and `learner_content_reviews`, which are the cleanest review patterns present.

## Proposed tables

### `trust_cases`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `case_type` | `EMPLOYER_ACCOUNTABILITY` / `OPPORTUNITY_MODERATION` / `USER_SAFETY` / `CONTENT` |
| `subject_kind` | `ORGANIZATION` / `USER` / `OPPORTUNITY_VERSION` / `CONTENT_REVISION` |
| `subject_id` | uuid — resolved per `subject_kind`; no polymorphic FK, so an index plus a check in the service |
| `organization_id` | uuid, **nullable**, references `organizations(id)` — the tenant the case concerns, absent for platform-wide cases |
| `reported_by_user_id` | uuid, nullable — null means detector-originated, not anonymous |
| `state` | see the machine below |
| `severity` | `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` |
| `assigned_to_user_id` | nullable, references `users(id)` |
| `opened_at`, `closed_at` | timestamptz, `closed_at` set only in a terminal state |
| `version` | integer, optimistic concurrency, as `staff_actions` does |

**States:** `REPORTED → TRIAGED → AWAITING_RESPONSE → UNDER_INVESTIGATION → DECIDED → ACTIONED →
CLOSED`, with `DISMISSED` reachable from `TRIAGED` or `UNDER_INVESTIGATION`, and `APPEALED → REOPENED`
from `ACTIONED` or `CLOSED` where policy permits. `AWAITING_RESPONSE` is the employer's right of reply
and is what stops this being a star chamber.

### `trust_case_events`

Append-only transition ledger, modelled on `content_review_actions`.

| Column | Notes |
| --- | --- |
| `id`, `case_id` | |
| `from_state`, `to_state` | text, CHECK `from_state <> to_state` — as `learner_content_reviews` does |
| `actor_user_id` | references `users(id)` |
| `reason_code` | text, `^[A-Z0-9_:-]{3,64}$` |
| `note` | text, bounded to 2000 chars |
| `correlation_id`, `occurred_at` | |

### `trust_case_evidence`

References, never copies. Evidence points at records that already exist.

| Column | Notes |
| --- | --- |
| `id`, `case_id` | |
| `evidence_kind` | `REVIEW_SIGNAL` / `OPPORTUNITY_VERSION` / `DOCUMENT_VERSION` / `AUDIT_CORRELATION` / `REPORTER_STATEMENT` |
| `reference_id` | uuid or text depending on kind |
| `added_by_user_id`, `added_at` | |

A `REVIEW_SIGNAL` row is how `opportunity_review_signals` finally acquires a reader. Attaching a
signal to a case is also what transitions it to `REVIEWED` — the state it can currently never leave.

**No raw personal data is stored here.** A reporter's statement is the one free-text exception and is
bounded.

### `trust_case_actions`

The enforcement record, separate from the decision.

| Column | Notes |
| --- | --- |
| `id`, `case_id` | |
| `action` | `WARNING` / `ENHANCED_MODERATION` / `POSTING_RESTRICTION` / `TRUST_DOWNGRADE` / `TEMPORARY_SUSPENSION` / `PERMANENT_REMOVAL` — spec §38 |
| `effective_from`, `effective_to` | timestamptz, `effective_to` nullable for indefinite actions |
| `applied_by_user_id`, `applied_at` | |
| `reversed_by_user_id`, `reversed_at`, `reversal_reason_code` | nullable, set together — an appeal reverses an action without deleting it |

## How this connects to what already exists

- **Suspension is not a new mechanism.** `organization_verification_events` already supports
  `VERIFIED → SUSPENDED` and back, and `account_state` and `membership_state` both carry `SUSPENDED`.
  A `TEMPORARY_SUSPENSION` action drives those existing transitions; it does not add a parallel field
  that could disagree with them.
- **Retention holds are placed by the case**, using the reason codes `data_retention_holds` already
  defines, and released when the case closes.
- **`audit_events` is the investigation substrate.** A case writing `trust.*` actions inherits the
  existing keyset-paginated audit search for free — which is also the strongest argument for finally
  wiring that orphaned endpoint to its nav item.
- **No case automatically opens.** A detector writes a signal; a human opens a case citing it. That
  ordering is what `opportunity_review_signals` means by "advisory".

## Open questions for the owners

1. **Who may read a case?** Proposal: `PLATFORM_SUPER_ADMIN`, `OPERATIONS_ADMIN` and `SECURITY_ADMIN`
   only, plus a narrow employer-facing view during `AWAITING_RESPONSE` showing the allegation and
   nothing about the reporter.
2. **Does the reporting student see progress?** Spec permits appeal "where policy permits" but says
   nothing about visibility. Proposal: the reporter sees opened / under review / closed and no detail,
   because detail is the reporter's route to identifying the employer's response.
3. **Can the decider be the reporter or the triager?** Proposal: no on both. The repository already
   rejects self-approval on content reviews; the same constraint belongs here.
4. **Retention of closed cases.** They contain allegations about named people. Proposal: a defined
   retention period rather than indefinite, set with the legal owner, and never shorter than any
   active retention hold the case itself placed.
5. **Is `USER_SAFETY` in scope for v1**, or is v1 employer-and-content only? Proposal: model the
   column now, build the employer path first — the assessment-integrity signals that would feed
   `USER_SAFETY` are thin today.
6. **Does `subject_kind` / `subject_id` warrant real foreign keys** via four nullable typed columns
   instead of one polymorphic pair? Proposal: yes, four nullable columns with a CHECK that exactly one
   is set. It is uglier and the database enforces it.

## Not in scope here

Employer trust *state* as a public-facing badge — spec defers public trust badges to post-MVP behind a
mature evidence model. This design records enforcement; it does not publish it.
