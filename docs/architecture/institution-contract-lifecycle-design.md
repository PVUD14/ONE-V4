# Institution Data-Processing Terms, Exit Export and Offboarding — Table Design

**Status:** Adopted (INST-18), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-30
**Migration:** `0088_institution_contract_lifecycle.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `employer-terms-and-trust-participation-design.md` (EMP-16, the same "versioned terms, an
owner accepts, never retroactive, the text is a draft for legal review" problem), `institution-exports-design.md`
(INST-08: writer, audit before send, limits), `counselling-notes-table-design.md` (INST-11),
`high-risk-approvals-table-design.md` (OPS-02 dual control), `institution-batch-lifecycle-design.md` (INST-10:
how a relationship ends and what the student is told), decision 10.2 #10 and #12.

## Why this exists

A college is the data controller for the records it keeps in ONE: its roster, its staff, its
assessments and marks, the notes its staff write and the decisions it makes about academic records.
Appendix 3 (INST-18, milestone IM5) asks for the three things that make that relationship contractual
rather than informal:

1. **Versioned data-processing terms**, accepted by an owner before the college goes live, and
   re-accepted when they change materially.
2. **An exit export** of institution-owned records — units, roster, staff and their assignments,
   assessments and results, staff actions, verification decisions — excluding restricted counselling
   notes unless the owner explicitly asks for them with a reason.
3. **An offboarding runbook and job:** end the relationships, revoke staff memberships, and delete the
   institution-owned data after the retention period (decision 10.2 #10: 90 days). Offboarding is
   reversible until the retention period ends. Students keep their accounts and their own data.

Every one of these writes a record somebody will later rely on — "the college accepted version X on
this date", "these relationships ended because the college left", "this data was deleted, with this
approval" — and one of them deletes data for good. So the tables are designed here first.

## What belongs to whom

This is the rule every later decision follows, so it is stated once:

| Owner | Records | At exit |
| --- | --- | --- |
| **The college** (institution-owned) | roster profiles and roster imports, staff actions (including counselling notes), counselling case participants, assessments (subjects, syllabus, questions, definitions, sections, assignments, attempts, answers, results), teaching assignments, lecturer learning assignments and plan overrides, announcements and their recipient lists, college settings, grading scales and calendar, stored readiness reports | exported (owner), then **deleted** after the retention period |
| **The college, kept as a skeleton** | units (department, programme, batch and section names) | exported, **kept**: they contain no personal data, and ended staff memberships, revoked invitations, employers' published job audiences and campus drives point at them |
| **The student** | account, relationship history, academic records and their verification state, documents, consents, applications, learning records, outcome self-reports, notifications | **never touched** except that a current relationship ends (state and date) — which is the fact of the college leaving, recorded on the student's own history |
| **Employers jointly with students** | campus drives, drive applications, nominations, drive categories and category assignments, placement policies the drives were run under | **kept**: an employer's process and a student's application do not disappear because the college left; the college simply no longer sees them |
| **AI8HT** | the organisation row and its profile, account fields and contacts (OPS-14), memberships and capability history, invitations, terms acceptances, the offboarding record, audit events, outbox, approvals | **kept**; account contacts are removed through the OPS-14 route (which erases the personal fields) as a runbook step |

Verification is the one subtle case. 0070 already decided it: "Verification is permanent; visibility is
not. Nothing here is cleared when an institution relationship ends — a graduate's degree does not become
unverified because they stopped being a current student." A verified term is a fact on the student's
record that employers rely on. The **decision** is exported to the college (it is the college's act),
but the verified state stays on the student's record after the purge. A term still waiting for the
college (`PENDING_VERIFICATION`) is left as the student left it; the college can no longer decide it.

## Part 1 — data-processing terms

### Decision: two dedicated tables, the EMP-16 shape

**Chosen.** `institution_data_terms_versions` (what the terms said, immutable) and
`institution_data_terms_acceptances` (which college accepted which version, which owner, when;
append-only). The same columns, rules and guards as EMP-16's employer terms.

**Rejected: reuse `employer_terms_versions` with an audience column.** The texts are different
contracts with different parties (an employer is a recipient of candidate data; a college is a
controller of its own records), they change on different schedules, and a material change to one must
never demand re-acceptance of the other. A shared table would need an audience predicate on every read
and a trigger that keeps the audiences apart — more rules for less clarity.

**Rejected: the consent registry (0028)** — a consent is a person's; terms are accepted by an
organisation (EMP-16's reasoning, unchanged). **Rejected: a column on `organizations`** — it keeps only
the latest answer and loses which version was in force when a student was rostered.

### `institution_data_terms_versions`

| Column | Type | Rule |
| --- | --- | --- |
| `version` | text PK | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, chosen by the operator |
| `id` | uuid UNIQUE | the events and audit layer address records by uuid |
| `title` | text | 1–200 |
| `body` | text | 1–60,000 — the exact text shown to the owner |
| `body_sha256` | text | 64 hex, computed in SQL from `body` at insert |
| `legal_review_state` | text | `DRAFT_FOR_LEGAL_REVIEW` or `LEGAL_APPROVED` |
| `legal_review_reference` | text | required when (and only when) `LEGAL_APPROVED`, 3–200 |
| `requires_reacceptance` | boolean | a material change |
| `change_summary` | text | optional, ≤ 2,000 |
| `published_at` | timestamptz | `now()` |
| `published_by_user_id` | uuid → users | the operator |
| `reason_code` | text | `^[A-Z0-9_:-]{3,64}$` |
| `correlation_id` | text | 1–128 |

- Immutable (trigger refuses UPDATE and DELETE); a correction is a new version.
- The first version must require acceptance (trigger), so "the version a college must have accepted"
  always has an answer once any terms exist.
- **Nothing is seeded.** Until an operator publishes a version, rostering behaves exactly as today.
- **Legal text is never presented as final unless it is.** The repository holds only
  `docs/legal/institution-data-processing-terms-DRAFT-for-legal-review.md`, marked DRAFT throughout, with
  every legal term left as a bracketed placeholder for review. A version published as
  `DRAFT_FOR_LEGAL_REVIEW` is labelled "Draft — pending legal review" wherever it is shown.

### `institution_data_terms_acceptances`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | uuid PK | |
| `institution_id` | uuid → organizations | must be an `INSTITUTION` (trigger) |
| `terms_version` | text → versions | |
| `accepted_by_user_id` | uuid → users | |
| `accepted_role` | text | `INSTITUTION_OWNER` only |
| `accepted_at` | timestamptz | `now()` |
| `correlation_id` | text | |

`UNIQUE (institution_id, terms_version)`; append-only. A college that no longer accepts the terms
leaves ONE through Part 3; an acceptance is never withdrawn by editing it.

### The rule and where it bites

- **Required version** = the most recent version with `requires_reacceptance`. A college has accepted
  current terms when it accepted that version or any later one. A non-material version asks nobody.
- **Only owners accept** (the goal: "accepted by an owner"). Owners and admins read the status and text.
  An owner accepts only the latest version, so nobody accepts text they were not shown as current. A
  repeat is a no-op.
- **What it gates — "before the college goes live":** the two acts that bring students into ONE under
  the college, **adding a student** and **committing a roster import**. Refusal: 403
  `INSTITUTION_DATA_TERMS_NOT_ACCEPTED`. Both checks run inside the write's own transaction after a
  row lock on the organisation, which the acceptance also takes, so an acceptance and a rostering cannot
  race.
- **Never retroactive.** A new material version pauses nothing: students already rostered keep their
  invitations and relationships, staff keep working, assessments run. Only the next rostering waits.

**Rejected: gate operations' verification of the college instead.** Verification is AI8HT checking the
college's identity; tying it to a contract the college has not yet been shown puts the steps in the
wrong order, and it would not bite on a college verified before terms existed. Rostering is the moment
students' data first enters ONE on the college's say-so.

**Rejected: gate every institution write.** Refusing marks entry or verification decisions mid-semester
because the terms moved would hurt students more than the college (EMP-16's reasoning).

## Part 2 — the exit export

### Who, when

- **The owner only** (the goal: the owner requests counselling notes; the export is the college's
  contractual copy of its records). Admins, placement officers, heads and faculty get 403. The INST-08
  analytics capability is not involved: ADR-018 and 0031 keep that capability from owners, and this is
  not analytics — it is the controller taking its records back.
- **Only while an exit notice is open** (offboarding state `NOTICE`, Part 3). Outside an exit, the
  owner has no bulk export of everything (INST-08's scoped exports remain the day-to-day tool). This
  keeps the largest read in the product to the moment it exists for. Refusal: 409 `EXIT_NOT_IN_NOTICE`.
- The runbook makes sure the owner has the window: operations record the notice, the owner exports,
  operations end the relationship. Nothing forces operations to wait (a college that never answers must
  still be able to leave), but the operator screen shows whether and when an exit export was taken.

### What

Every file is a CSV from INST-08's writer (`toCsv`: byte-order mark, every cell quoted, formula prefixes
neutralised, forbidden-field headers refused), sent with the same headers (`attachment`, `no-store`,
`nosniff`). Each section is its own `POST /institutions/:id/exit-export/:section` with a reason code and
a `part` (1-based); a part holds at most 10,000 rows (INST-08's per-file cap, so an exit never fails on
size — it becomes more parts). A `GET …/exit` summary lists the sections with row counts and parts.

| Section | Rows | Columns (names, never internal identifiers) |
| --- | --- | --- |
| `units` | every unit | Unit, Kind, Parent unit, Created on |
| `roster` | every student the college ever rostered | Student ID (roll number), Full name, Email, Department, Programme, Batch, Section, Roster status, Relationship, From, To, Academic start, Expected graduation |
| `staff` | every staff membership | Email, Role, Department, Batch, State, Since |
| `teaching-assignments` | every teaching assignment | Faculty email, Unit, Subject, Subject code, Academic term, Starts on, Ends on, State |
| `assessments` | every assessment definition | Assessment, Subject, Kind, State, Total marks, Duration (minutes), Opens, Closes, Attempts allowed, Published on |
| `assessment-results` | every completed attempt the relationship authorised | Assessment, Student ID, Full name, Attempt, Status, Auto-submitted, Score, Maximum score, Percentage, Correct, Wrong, Not attempted, Time taken, Completed at |
| `staff-actions` | every staff action **except counselling notes** | Type, Title, Note, Outcome note, State, Visibility, Student ID, Department, Batch, Created by, Created at, Due, Resolved at, Archived at |
| `verification-decisions` | every qualification and term the college verified or rejected | Student ID, Full name, Record, Programme, Term, Result, Scale, Letter, Backlogs, Decision, Decided at, Decided by |
| `counselling-notes` | restricted — see below | Student ID, Full name, Title, Note, State, Written by, Written at |

**Nothing a student owns is in any file:** no learning records, readiness, applications, offers or
compensation (ADR-024; the writer's header check still applies), messages, documents, consents, outcome
self-reports or anything employers hold. The summary lists these exclusions in plain words so the owner
knows what is not coming and why.

### Counselling notes (INST-11): only on an explicit, reasoned, audited request

The `staff-actions` section never contains a counselling note, whatever is asked. The
`counselling-notes` section is refused unless the body carries `includeRestrictedCounsellingNotes:
true` **and** a reason from a fixed list — `STUDENT_WELFARE_CONTINUITY`, `LEGAL_OBLIGATION`,
`REGULATOR_REQUEST`, `COLLEGE_RECORDS_POLICY`. Its audit action is distinct
(`institution.exit_export.counselling_notes.exported`) so a review can find every such release, and it
records how many notes left. Refusals: 400 `COUNSELLING_EXPORT_CONFIRMATION_REQUIRED`,
`COUNSELLING_EXPORT_REASON_INVALID`.

### Audit, rate and size

Reused from INST-08 unchanged: one `audit_events` row per file (`institution.exit_export.<section>.exported`,
matching INST-08's `institution.%.exported`), written and committed before the file is sent, with the
section, part, row count and reason; the same per-person daily allowance (30), counted over both kinds of
export under the same advisory lock. The export itself never writes to any other table.

## Part 3 — offboarding

### Decision: one `institution_offboardings` row per exit, plus a ledger of what it changed

**Chosen.** A state machine on its own row, and a second table listing each relationship and membership
the exit changed with the state it had before, so reversal restores exactly those and nothing else.

**Rejected: flip `organizations.active` and nothing else.** Staff would lose nothing (memberships are
what access checks read), students would keep "current" relationships with a college that has left, and
there would be nowhere to hold the retention clock or the approval that authorised the deletion.

**Rejected: suspend through ORGANIZATION_SUSPEND.** Suspension is an enforcement act with its own meaning
(employers' jobs pause; the college may come back after review). An exit is contractual; mixing them makes
the audit trail say "suspended" about a college that simply left.

**Rejected: reverse by recomputing from the audit trail.** Audit rows are never read back to authorise or
drive a change (OPS-02's rule). A ledger row is.

### `institution_offboardings`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | uuid PK | |
| `institution_id` | uuid → organizations | an `INSTITUTION` (trigger) |
| `state` | text | `NOTICE`, `ENDED`, `CANCELLED`, `PURGED` |
| `notice_at`, `notice_by_user_id`, `notice_reason_code` | | set on insert (`now()`, operator, `CONTRACT_ENDED` · `COLLEGE_REQUESTED_EXIT` · `NON_RENEWAL`) |
| `ended_at`, `ended_by_user_id`, `end_reason_code` | | set together on NOTICE → ENDED |
| `retention_ends_at` | timestamptz | CHECK `= ended_at + 90 days` (decision 10.2 #10) — the database clock, never Node |
| `was_active` | boolean | the organisation's `active` before the exit, restored on cancel |
| `cancelled_at`, `cancelled_by_user_id`, `cancel_reason_code` | | set together on → CANCELLED |
| `purged_at`, `purged_by_user_id`, `purge_approval_id` → operation_approvals | | set together on ENDED → PURGED |
| `purge_summary` | jsonb | counts per table deleted — the documented deletion |
| `correlation_id` | text | the request that opened it |

- **One open exit per college:** partial unique index on `institution_id` where state in (`NOTICE`, `ENDED`).
- **Transitions (trigger):** NOTICE → ENDED; NOTICE → CANCELLED; ENDED → CANCELLED **only while
  `now() < retention_ends_at`**; ENDED → PURGED **only when `now() >= retention_ends_at`** and
  `purge_approval_id` names an `EXECUTED` `INSTITUTION_DATA_PURGE` approval whose target is this row.
  CANCELLED and PURGED are terminal. Columns set by an earlier step never change. Never deleted.
- A new exit after a cancellation is a new row.

### `institution_offboarding_changes`

| Column | Type | Rule |
| --- | --- | --- |
| `offboarding_id` | uuid → institution_offboardings | |
| `target_kind` | text | `RELATIONSHIP` or `MEMBERSHIP` |
| `target_id` | uuid | the relationship or membership |
| `prior_state` | text | the state before the exit ended it |
| `prior_profile_status` | text | for a relationship, the roster status before |
| `restored_at` | timestamptz | set once, on cancellation |

PK `(offboarding_id, target_kind, target_id)`. Append-only except `restored_at`, set once (trigger).

### The steps

**1. Notice** (operations, `OPS_ORG_MANAGE`, reason-coded, audited, outbox). Nothing else changes. The
college's Settings shows the exit and the owner can take the exit export. Roster intake is refused while
an exit is open (`INSTITUTION_OFFBOARDING_IN_PROGRESS`): inviting a student into a relationship that is
about to end serves nobody.

**2. End** (operations, reason-coded, one transaction under the organisation lock):
- every relationship in `PENDING`, `VERIFIED` or `ACTIVE` becomes `ENDED` with `effective_to = now()`, and
  its roster profile `ENDED` — `GRADUATED` and `TRANSFERRED` history is untouched;
- every `ACTIVE` or `SUSPENDED` staff membership becomes `ENDED` — access checks read only `ACTIVE`, so
  every staff read and write stops on the next request;
- every pending invitation of the college (staff and student) is revoked (`INSTITUTION_OFFBOARDED`), so
  no one can join or activate into a college that has left;
- `organizations.active = false`, so the college leaves the institution directory and campus-drive
  pickers, and no new qualification can name it;
- each relationship and membership changed is written to the ledger with its prior state;
- each ended relationship gets the per-student audit row INST-10 writes (`institution.relationship.ended`,
  reason `INSTITUTION_OFFBOARDED`), and each activated student an in-app notice. The INST-10 outbox event
  is **not** written: its consumer tells the student "the college recorded you as no longer enrolled" and
  "you can still ask it to verify past results", which would be untrue here. The exit notice says what
  happened: the college stopped using ONE, the student's account, records and choices stay theirs, and
  the college no longer sees anything about them on ONE.

**3. Cancel** (operations, reason-coded) — from NOTICE (nothing to restore) or from ENDED while the
retention period runs: every ledger row is restored (relationship back to its prior state with
`effective_to` cleared and roster status restored; membership back to its prior state) **only if it is
still exactly as the exit left it**, `organizations.active` returns to `was_active`, and each activated
student whose relationship came back gets a notice saying so. Revoked invitations are not revived — the
college resends them (a revived token would have been unusable for weeks). After the retention period,
cancel is refused (`OFFBOARDING_RETENTION_ENDED`): the data may already be gone, and a college that
returns is a new onboarding.

**4. Purge** — the only destructive step, and it needs all of:
- `now() >= retention_ends_at` (409 `OFFBOARDING_RETENTION_RUNNING` otherwise);
- an OPS-02 approval, action `INSTITUTION_DATA_PURGE` (an extended key, 0051's mechanism, repeating
  every earlier key), requested and executed by an `OPS_ORG_MANAGE` holder and approved by a different
  person holding `APPROVE_HIGH_RISK` (or the solo safeguard), bound to `{offboardingId, reasonCode}`,
  consumed in the purge's own transaction;
- no active `data_retention_holds` on any student the college rostered (409 `OFFBOARDING_PURGE_HELD`): a
  legal hold outranks a contract clock, as it does for deletions and EMP-16's message erasure.

It deletes the institution-owned rows in the table of "What belongs to whom", in foreign-key order, in
one transaction, records the count per table in `purge_summary` and the audit row, and moves the exit to
PURGED. It is idempotent per exit (a PURGED exit cannot purge again) and touches no student-owned table.

A **preview** (`GET …/purge-preview`) runs the same counting queries without deleting — the runbook's
dry run. It works in any state, so operations can see the scale of a purge before the notice.

### Deleting through the 0082 guards

Five 0082 triggers refuse DELETE except inside a student's privacy erasure
(`learning_assignments`, `learning_assignment_students`, `learning_plan_overrides`,
`staff_action_attendees`, `staff_action_content_links`). 0088 **splits** each into its unchanged
INSERT/UPDATE trigger and a DELETE trigger that calls the **same, unchanged function** unless
`current_setting('one.institution_purge', true)` equals the row's institution (for content links, through
their staff action). The setting is transaction-local and set only inside the purge transaction, after
the approval has been consumed.

**Rejected: rewrite the five guard functions with a new branch.** Copying function bodies into a new
migration risks drifting from 0082's rules; the split leaves every rule byte-for-byte as 0082 wrote it
and adds only the one exception. **Rejected: reuse `one.privacy_erase_subject` per student.** It names a
different act (a person's erasure) and could not delete the lecturer's own assignment headers and
content links, which 0082 never lets privacy erasure remove. **Rejected: leave these rows behind.** A
"documented deletion" that silently keeps lecturers' actions about named students is not one.

This is the same standing as 0082's triggers — a guard against application mistakes, not against a
writer with SQL — and is noted as such.

## Who may do what

| Act | Who | Where |
| --- | --- | --- |
| Publish a terms version | operations, `OPS_ORG_MANAGE` | Operations → Organizations |
| Read terms and status | college owner and admin | admin Settings |
| Accept terms | college owner | admin Settings |
| Record notice, end, cancel an exit; request a purge; purge | operations, `OPS_ORG_MANAGE` | Operations → Organizations |
| Approve a purge | a different operator with `APPROVE_HIGH_RISK` (solo safeguard as OPS-02) | Operations → Settings → Approvals |
| See the exit and its status | college owner and admin | admin Settings |
| Take the exit export | college owner, during NOTICE | admin Settings |

Every write is one transaction with its audit row(s) and an outbox event:
`institution.data_terms.published`, `institution.data_terms.accepted`,
`institution.offboarding.notice_recorded`, `institution.offboarding.ended`,
`institution.offboarding.cancelled`, `institution.offboarding.purged` — identifiers and enums only,
registered in `packages/events`. No consumer: the student notices are written in the transaction that
makes the change (INST-14's pattern), so they cannot drift from it.

## Privacy

- The terms tables and the offboarding tables hold no student data. The ledger holds only identifiers
  and prior states.
- The exit export is the one route by which the college's own records leave in bulk; it is owner-only,
  window-bound, reason-coded, audited before send and rate-limited.
- A student's privacy erasure is unaffected: it continues to erase their counselling notes and 0082
  rows under its own setting. After a purge those rows are simply gone already.

## Surfaces

- **Web:** admin **Settings** replaces its "Data-processing terms — not built yet" state with the terms
  (status, text with its DRAFT label, Accept for owners) and a "Leaving ONE" section (no exit / notice
  with the export sections / ended with the retention date / cancelled). **Operations → Organizations**
  gains "Institution data-processing terms" (publish, list) and "College exits" (notice, end, cancel,
  purge preview, request purge approval, purge). The Approvals queue shows and executes the new action.
  No navigation item is added, removed, renamed or moved (HG-3).
- **Android:** none for staff — terms, exports and exits are desk tasks, like every other Settings and
  export control the Android institution workspace does not carry. For students the exit arrives as an
  ordinary in-app notification, which the Android app already lists, and their college line already reads
  "Left <college> on <date>" for an ended relationship (INST-10).

## Open points (decisions for Divakar)

1. **Legal text.** The DPA is a DRAFT with every legal term a placeholder. Recommendation: publish a
   version to colleges only after legal review, as `LEGAL_APPROVED` with the reviewer's reference.
   Whether a signed DPA is needed before the pilot is §10.3's open question.
2. **Gate at rostering**, not at verification or on every write. Recommended.
3. **Owners only accept**, admins read. Recommended (goal text).
4. **Exit export only during NOTICE**, owner only, not behind the analytics capability. Recommended.
5. **Units survive the purge** (no personal data; history and employers' job audiences point at them).
   Recommended; the alternative is nulling scope on ended memberships and invitations and deleting
   employers' audience rows, which rewrites other parties' history.
6. **Campus drives, nominations, drive categories and placement policies survive** (joint with
   employers and students' applications). Recommended.
7. **Verification decisions stay on students' records** (0070's "verification is permanent").
   Recommended.
8. **Retention: 90 days from the end**, as decision 10.2 #10 ("subject to legal review"). One constant,
   enforced by a CHECK.
9. **Starting and ending an exit is single-operator** (reason-coded, audited, reversible); only the
   purge is dual-controlled. Recommendation: keep — ending is fully reversible for 90 days.
10. **Pending verification requests** to a college that has left stay pending on the student's record;
    a follow-up can tell the student the college has left ONE.
