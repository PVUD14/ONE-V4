# SOP — Counselling notes

> What this is: the procedure college staff follow to write, read, share and erase counselling notes
> about a student, and how an owner or administrator decides who else may read them. Why it exists:
> Appendix 3 INST-19; journey J7. Built by INST-11 (ADR-036: counselling notes are a restricted
> staff-action type). Written 2026-10-01 against base `719eb34`. Design:
> `docs/architecture/counselling-notes-table-design.md`.

## Who can read a note

1. Its **author** — while the student is still within the author's scope.
2. The college's **owners and administrators**.
3. Staff an owner or administrator has **added to that student's counselling case**.

Nobody else. A department head of the student's own department, the student's lecturers and the
placement office do **not** read notes unless added to the case. Every read — including a refused
one — is recorded, without the note's text.

## Where

**Interventions → Counselling notes** (*Restricted*), on the administrator, department head and
faculty portals. The placement officer's portal has no Interventions item: a placement officer added to
a case has no screen yet (see Gaps).

## A. Write a note (staff with a writing scope)

1. **Write a counselling note** → **Student** (only students in your writing scope are offered) →
   **Title** (up to 200 characters) → **Note** (up to 4,000).
2. Leave **Share this note with the student** unticked unless the student should read it. Notes are
   staff only by default.
3. Save. A note cannot be edited: write a new note to correct one.
4. *Writing a counselling note needs a department or teaching assignment…* means your membership has
   no scope; ask an administrator.

## B. Share or stop sharing (author, owner or administrator)

On the student's case, **Share with the student** or **Stop sharing with the student**. The student
sees shared notes under *Counselling notes shared with you*, with the writer shown as a role, on the
web and on Android. Case participants cannot change sharing.

## C. Add or remove case participants (owner or administrator)

1. Open the student's case → **Case participants** → **Add a case participant**: choose the staff
   member and a reason (`CASE_REFERRAL` referred to this case, `CASE_SUPPORT` supporting the student).
2. To remove: choose a reason (`CASE_CLOSED`, `ROLE_CHANGED`). Removal takes effect on their next
   request; the record of their participation is kept.
3. When the support ends, remove the participants who no longer need access (`CASE_CLOSED`).

## D. Erase a note (owner or administrator)

Use **Erase note** with a reason — `STUDENT_REQUEST` (the student asked the college to erase it) or
`RECORDED_IN_ERROR`. Erasure is permanent.

## What notes never reach

Exports (the staff-action summary counts other types only), calendars, the other staff-action
screens, employers and reports. When a college leaves ONE, its exit export leaves notes out unless the owner explicitly
asks for them with a listed reason ([college exit SOP](sop-college-exit.md)). A student's own data
export includes the notes shared with them and, per college, how many staff-only notes exist.

## Never do

- Never record health, family or religious detail unless it is needed to support the student.
- Never copy a note into an intervention, a task, a meeting title or an announcement.
- Never add someone to a case "so they are aware" — add only people who act on it.

## Gaps

- **Placement officers** added to a case can read through the API but have no screen (no
  Interventions item — a navigation decision, HG-3).
- No time-based deletion is built; the design recommends erasing notes one year after the
  relationship ends (an open decision).
- Writing notes is web only (a desk task).
- The design's DPDP statements are an engineering reading awaiting legal review.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J7.
