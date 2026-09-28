# Counselling Notes — Table Design

**Status:** Adopted (INST-11), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0060_counselling_notes.sql`
**ADR:** ADR-036 — Counselling notes are a restricted staff-action type (decision 10.2 #5)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`. Legal statements below
are the engineering reading of the Digital Personal Data Protection Act, 2023 and are **marked for legal
review**; nothing here is legal advice or agreed contract terms.

## Why this exists

A college counsels students about things that matter to them — stress, family circumstances, a
lapse, a career doubt. ONE has no place for that record. The nearest thing, a `FACULTY_NOTE` staff
action, is readable by every staff member whose unit scope covers the student: a department head,
any lecturer who teaches the section, the placement office. That is right for "missed two labs" and
wrong for "disclosed a family bereavement".

A counselling note is sensitive personal data about a person who did not write it and usually cannot
see it. Who can read it, how long it lives, what the student can do about it, and where it must never
appear are all consequences. That is why it gets a design before its migration.

## Decision: a restricted staff-action type plus a case-participant list

- `staff_actions.action_type` gains `COUNSELLING_NOTE` (ADR-018 folded "counsellor" into staff
  actions rather than a role; decision 10.2 #5 keeps that). The row reuses the existing tenancy
  (institution, relationship, unit) columns, author columns and audit habits.
- A new table, `counselling_case_participants`, lists the staff memberships an owner or admin has
  explicitly added to one student's counselling case.
- The generic staff-action endpoints do **not** accept `COUNSELLING_NOTE`. Notes are reached only
  through a dedicated controller whose read rule is narrower than the unit scope.

### Rejected

- **A separate `counselling_notes` table.** It would isolate the text from every existing
  `staff_actions` query by construction, which is attractive. It was rejected because the plan and
  ADR-018 make counselling a staff-action type, and a second table would duplicate the relationship,
  scope and audit machinery that staff actions already have and INST-02 already tested. The isolation
  it buys is obtained instead by (a) the generic endpoints refusing the type, (b) every existing
  `staff_actions` reader filtering on `action_type`, and (c) a static test that fails the build if a
  new `FROM staff_actions` query appears without an `action_type` filter.
- **A `readers` array column on the note.** Per-note reader lists drift: a counsellor added in
  November would not see September's notes. The case is per student, so the participant list is too.
- **Making "counsellor" a role or a membership capability.** A capability would still be
  institution-wide — every holder would read every student's notes. The need is per student.
- **Unit scope as the read rule (what `FACULTY_NOTE` does).** That is exactly the exposure this goal
  removes.

## Who can read a note

A note about student S is readable by the caller's active staff membership M only when the student
passes the relationship policy (below) **and** one of these holds:

| Basis | Rule |
| --- | --- |
| Owner or admin | M is `INSTITUTION_OWNER` or `INSTITUTION_ADMIN` of the institution (their INST-02 scope is the whole institution). |
| Author | M is the membership that wrote the note (`actor_membership_id`), **and** S is still inside M's read scope from the single INST-02 helper. A lecturer whose teaching assignment ends stops reading what they wrote about that section. |
| Case participant | M is an active (not removed) row in `counselling_case_participants` for (institution, S). Explicit participation is the grant: it does not depend on M's unit scope, because an owner or admin chose this person for this student, with a reason code, on the record. |

Nobody else. In particular a department head, a placement admin and a faculty member see no note
they did not write unless added to that student's case — faculty "do not see them by default".
A membership that is revoked or suspended fails the membership check before any of this runs.

**Relationship policy** (Section 6.3, same as applications): each note is shown only when both its
`created_at` and its `updated_at` fall inside an institution relationship that authorises activity at
that moment (`hasInstitutionRelationshipAuthorizationForActivity`). An ended or revoked relationship
therefore hides every note; a graduated or transferred student's notes remain readable only when they
were written before `effective_to`. Writing needs a current relationship.

## Who can write

- **A note:** any staff role, when S is inside the caller's **write scope**
  (`resolveInstitutionStudentWriteScope`, INST-SR-02) or the caller is a participant in S's case. A
  caller whose write scope is empty and who is not a participant gets 403 `SCOPE_REQUIRED` ("assign
  this person a scope first"); one with a scope that does not cover S gets 403 `FORBIDDEN`.
- **Participants:** owners and admins only, with a reason code (`^[A-Z0-9_:-]{3,64}$`). The member must
  be an active staff membership of the same institution. Removal also takes a reason code and keeps
  the row (removed_at), so "who could read this, when" stays answerable.
- **Sharing with the student:** the author, an owner or an admin may switch a note between
  `STAFF_ONLY` (the default) and `SUBJECT_VISIBLE`, with optimistic versioning. Participants may not:
  disclosure to the student is the author's or the college's call.
- **Erasure of one note:** owners and admins, with a reason code — the route by which a student's
  request to correct or erase a specific note (DPDP s.12) is honoured by the college.
- **No editing.** A note is a record of what was said; a correction is a new note. `title` and `note`
  never change after insert.

## Columns

### `staff_actions` (existing table)

A `COUNSELLING_NOTE` row is constrained by a new CHECK, `staff_actions_counselling_shape_ck`:
it must name a student and relationship, carry note text, have no due date, meeting window, exam or
evidence reference, and be assigned to its own author. Those columns belong to workflows (tasks,
meetings, verification) that surface in calendars and dashboards; a note that carried one would
leak into them. State is `OPEN` for the life of the note.

### `counselling_case_participants` (new)

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `institution_id` | the institution; FK organizations |
| `student_user_id` | the student whose case this is; FK users |
| `membership_id` | the staff membership added; FK organization_memberships (same-institution checked by the API) |
| `added_by_user_id`, `added_by_membership_id` | who added them |
| `added_reason_code` | CHECK `^[A-Z0-9_:-]{3,64}$` |
| `added_at` | default now() |
| `removed_at`, `removed_by_user_id`, `removed_reason_code` | all null or all set (CHECK) |

A partial unique index allows one active participation per (institution, student, membership).

## Audit (Section 5.4)

Every read and write writes an `audit_events` row in the same transaction. **No audit row carries a
note's title or text** — the operations audit console can read audit context, and the audit log is
retained after deletion (AUDIT is RETAINED). Rows carry ids, counts, lengths, visibility, the basis of
access and reason codes.

| Action | When |
| --- | --- |
| `counselling_note.created` | a note is written |
| `counselling_note.read` | a staff member opens a student's notes (SUCCESS with ids returned; DENIED when the caller has no basis) |
| `counselling_note.cases_listed` | a staff member lists the cases they can open |
| `counselling_note.visibility_changed` | shared with / withdrawn from the student |
| `counselling_note.erased` | an owner or admin erases one note |
| `counselling_case.participant_added` / `.participant_removed` | case membership changes |
| `counselling_note.student_read` | the student reads the notes shared with them |

A denied read is audited and then refused (403), so probing is visible.

## Never exported, never aggregated, never employer-facing

- **INST-08 exports and every aggregate:** excluded by an explicit `action_type <> 'COUNSELLING_NOTE'`
  filter in the staff-action summary; the department workspace, teaching-assignment and calendar
  queries already filter or now filter by type. Counts of counselling activity are not shown anywhere:
  even a count per department can identify a student in a small cohort.
- **Calendars:** staff and student calendars exclude the type.
- **Employer surfaces:** no employer controller reads `staff_actions`; a static test keeps it so.
- **Operations console:** no read path to the text; audit rows carry none.
- **INST-18 exit export (future):** excluded unless an owner explicitly requests them with a reason,
  as the plan already states.
- **Generic staff-action endpoints:** refuse the type with 400.

## Retention and the student's rights (DPDP Act 2023 — for legal review)

The college is the data fiduciary for its counselling notes; ONE processes them on its behalf.

- **Right to access (s.11).** The student's own data export includes the full text of every note the
  college has shared with them, and, for notes it has not shared, the number held per college — the
  existing export already told the student that such notes exist and are not included; it now says how
  many and that the college can share them. The student's workspace shows shared notes.
- **Right to correction and erasure (s.12).** A request about one note goes to the college, whose owner
  or admin can erase that note (audited with a reason code) or add a correcting note.
- **Account deletion.** The privacy-deletion flow erases every counselling note about the subject and
  every participant row of their case (new category `COUNSELLING_NOTES`, disposition `ERASED`), after
  the grace period and subject to retention holds, like every other category. Audit rows remain,
  without content.
- **Retention otherwise.** A note lives while the college keeps it, readable by staff only within the
  relationship policy above. Institution offboarding (INST-18, decision 10.2 #10) deletes it with the
  college's other records. No time-based purge is built here — see Open points.

## Open points (decisions for Divakar)

1. **Time-based retention.** Recommended: erase counselling notes automatically one year after the
   student's relationship with the college ends (graduated, transferred or ended), unless a retention
   hold applies. Not built in INST-11; the privacy-deletion and offboarding paths cover erasure today.
2. **Staff-only note counts in the subject export.** Recommended (and built): disclose the number of
   staff-only notes per college, not their text. Alternative: disclose nothing until shared — rejected,
   because s.11 entitles the student to a summary of what is processed about them.
3. **Should participants be able to share a note with the student?** Recommended (and built): no —
   the author, owners and admins only.
