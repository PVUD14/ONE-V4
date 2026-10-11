# External Review Assignments — Table Design

**Status:** Adopted (OPS-10), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0066_external_review_assignments.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Decision:** ADR-037
**Builds on:** `internal-capabilities-table-design.md` (0039: `CONTENT_REVIEW_EXTERNAL` only on institution
faculty and department heads), the 0004 content lifecycle, the editors' designs (`skill-map-editor-design.md`,
`question-bank-editor-design.md`, `lesson-variant-editor-design.md`)

## Why this exists

A college faculty member may review ONE's global content, but only what they are asked to review, only for
a while, and only while they still hold the grant and their college membership. The table answers, for every
faculty reviewer and at any time, "which draft could this person see, who decided that, until when, and
what did they say about it". That is who-may-see-what data with consequences, so it is written down first.

## Decision 1: one row per (revision, reviewer) assignment

**Chosen.** `external_review_assignments`, one row each time a content revision is assigned to one faculty
membership. The row carries the grant of access (who assigned, when, until when, why), the faculty decision
(approve or request changes, reason, comment, when) and the end of access (revoked by whom, when, why).

| Column | Type | Rule |
| --- | --- | --- |
| `id` | uuid PK | |
| `content_revision_id` | uuid → `content_revisions` | a `TOPIC`, `QUESTION` or `LESSON` revision in `IN_REVIEW` at assignment |
| `content_hash` | text | the revision's hash at assignment, 64 hex; the decision is refused if it changed |
| `reviewer_membership_id` | uuid → `organization_memberships` | ACTIVE institution `FACULTY_LECTURER` / `DEPARTMENT_HEAD` holding a live `CONTENT_REVIEW_EXTERNAL` grant |
| `reviewer_user_id` | uuid → `users` | the membership's user (checked), kept for the conflict rules and the caller filter |
| `institution_id` | uuid → `organizations` | the membership's organisation (checked); lets the faculty route be tenant-scoped |
| `assigned_by_user_id` | uuid → `users` | never the reviewer |
| `assigned_at` | timestamptz | stamped by the database |
| `expires_at` | timestamptz | later than `assigned_at` by 1 to 30 days |
| `reason_code` | text | `^[A-Z0-9_:-]{3,64}$`, from the list in code |
| `state` | text | `ASSIGNED`, `DECIDED`, `REVOKED` |
| `decision` | text | `APPROVE` or `REQUEST_CHANGES`, only when `DECIDED` |
| `decision_reason_code` | text | as `reason_code`, only when `DECIDED` |
| `decision_comment` | text | ≤ 2000 characters; required for `REQUEST_CHANGES` |
| `decided_at` | timestamptz | stamped by the database, only when `DECIDED`, before `expires_at` |
| `revoked_by_user_id`, `revoked_at`, `revoked_reason_code` | | all three together, only when `REVOKED` |

"Expired" and "closed" are not states: an `ASSIGNED` row past `expires_at` is expired, and an `ASSIGNED` row
whose revision has left `IN_REVIEW` (or whose hash changed) is closed. Both are derived at read time from the
clock and the revision, so there is no sweeper job and no row that says something the facts no longer say.

**One open assignment per (revision, reviewer):** a partial unique index on
`(content_revision_id, reviewer_user_id) WHERE state = 'ASSIGNED'`. Several faculty may review one revision.
A re-review after changes is a new assignment of the new revision (or of the same revision after a revoke).

**Rejected: a `comments` table with threads.** OPS-10 asks for a decision "with comments". One decision per
assignment with its comment is the record the internal reviewer needs; a conversation is a follow-up if
faculty ask for it.
**Rejected: an expiry on the capability grant.** See ADR-037: the time limit is where access lives.
**Rejected: storing the content snapshot on the row.** The revision is immutable while `IN_REVIEW` and the
hash binds the decision to it; a copy would be a second place answer keys could leak from.

## Decision 2: the database enforces the grant of access, not only the API

A trigger, `external_review_assignment_guard`, BEFORE INSERT OR UPDATE, and a refusal of DELETE:

On **insert**:
- `state = 'ASSIGNED'`, no decision or revocation columns, `assigned_at` set to `now()`.
- The revision exists, is a `TOPIC`, `QUESTION` or `LESSON` revision, is `IN_REVIEW`, and its hash equals
  `content_hash`.
- The membership is ACTIVE, in an `INSTITUTION` organisation equal to `institution_id`, has role
  `FACULTY_LECTURER` or `DEPARTMENT_HEAD`, belongs to `reviewer_user_id`, and holds a live (unrevoked)
  `CONTENT_REVIEW_EXTERNAL` grant.
- The reviewer is not the revision's author, and not the assigner.
- `expires_at` is between 1 and 30 days after `now()`.

On **update**: the identity columns never change. The only moves are `ASSIGNED → DECIDED` (decision columns
written together; `decided_at` set to `now()`; refused at or after `expires_at`; refused unless the revision
is still `IN_REVIEW` with the same hash and the grant is still live and the membership still ACTIVE) and
`ASSIGNED → REVOKED` (revocation columns together; `revoked_at` set to `now()`). `DECIDED` and `REVOKED` rows
never change again. Rows are never deleted.

Contributors beyond the author (editors and submitters, taken from the audit log as the editors do) are
refused by the API at assignment and again at decision.

## Decision 3: who does what

| Action | Who | Where |
| --- | --- | --- |
| Grant / revoke `CONTENT_REVIEW_EXTERNAL` | `CAPABILITY_ADMIN`, not on themselves | Operations → Content Management |
| Assign / revoke an assignment | `CONTENT_REVIEW`, not a contributor to the revision | Operations → Content Management |
| Read assignments and decisions | `CONTENT_EDIT`, `CONTENT_REVIEW` or `CONTENT_PUBLISH` | Operations → Content Management |
| See an assigned draft; decide | the assigned faculty member, through their ACTIVE membership in that college, while the grant is live, the assignment is open and unexpired, and the revision is still the one assigned | Institution portal (faculty: Learning Resources; department head: Assessments) |
| Approve (rights review) and publish | unchanged: internal `CONTENT_REVIEW` and `CONTENT_PUBLISH` in the editors | Operations → Content Management |

Revoking the grant revokes the membership's `ASSIGNED` rows (reason `GRANT_REVOKED`) in the same transaction.
Grant and revoke use the existing outbox events `organization_membership.capability_granted` / `_revoked`.

## Decision 4: what a faculty reviewer is shown

A whitelist projection per content type, in `packages/career-readiness` (`externalReviewContent`), unit
tested against a body that carries every secret field:

- **Skill:** stable key, name, description, the four level descriptors, prerequisite keys, basis.
- **Question:** stable key, skill name, prompt, option ids and texts, difficulty band. Never the correct
  option, explanation, misconception tags or rationale, or the hint ladder.
- **Lesson / variant:** stable key, title, summary, practice, variant (language, level, style), prerequisite
  keys, basis.

Never: author or operator names or emails, provenance generator details, licence and rights, any student,
any institution data. The list shows only open and past assignments' titles, dates and the reviewer's own
decision; content is returned only while the assignment is open.

## Audit and events

Every write puts its audit row (and outbox event) in its own transaction:

| Audit action | Resource | Organisation |
| --- | --- | --- |
| `operations.external_reviewer.granted` / `.revoked` | `organization_membership` | the college |
| `operations.external_review.assigned` / `.revoked` | `external_review_assignment` | the college |
| `institution.content_review.decided` | `external_review_assignment` | the college |

Contexts carry reason codes, the revision id and entity type, the decision, and `break_glass` when the super
admin acts through break-glass. The comment itself stays on the row (audit carries its length only).
Outbox: `external_review.assigned`, `external_review.decided`, `external_review.revoked` — identifiers and
enums only, registered in `packages/events`.

## Migration 0066

`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and `DROP TRIGGER IF
EXISTS` before each `CREATE TRIGGER`: it applies once under ADR-035 and survives a bootstrap replay. No
existing table, constraint or migration changes.

## Open points (decisions for Divakar)

1. **Answer keys for faculty.** Withheld (OPS-09b's rule stands). Recommended: keep until a college asks to
   review keys; then show them inside the review surface only, never in a learner DTO, by its own decision.
2. **Advisory decisions.** A faculty approval does not approve the revision. Recommended: keep; the internal
   approval carries the rights review.
3. **30-day maximum, 14-day default.** Recommended as above.
4. **The college is not asked in-product** before its faculty member is granted review. Recommended: agree
   it with the college out of band and record the grant's reason code; the college's control is the
   membership.
