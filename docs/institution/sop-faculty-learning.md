# SOP — Learning across your students, and assigning learning

> What this is: the procedure a lecturer follows to see where the students they teach are stuck, and
> to act on it — assigning a practice set or lesson, planning a group session, or setting one
> student's next step. Why it exists: Appendix 3 INST-19; journey J10. Covers two shipped modules:
> INST-15 (faculty cohort view, on **My Students**) and INST-16 (learning actions, on **Learning
> Resources**). Written 2026-10-01 against base `719eb34`. Design:
> `docs/architecture/faculty-cohort-view-design.md`,
> `docs/architecture/faculty-learning-actions-table-design.md`.

## Before you start

- **Lecturers only.** Department heads and administrators do not have these tools.
- You need an **active teaching assignment** ([staff SOP](sop-staff-scope-and-teaching.md)). Without
  one you see *You need an active teaching assignment to do this…*.
- **The cohort view is empty today.** It shows only students who hold the adaptive-learning consent,
  and that consent cannot be given until its wording is legally reviewed and published (HG-6). Until
  then *Learning across your students* reads NA everywhere. Assigning work (section B) does not need
  that consent and works now.

## A. Learning across your students (My Students)

| Block | Shows |
|---|---|
| Stuck on the same skill | Students who have practised a skill on at least two days without yet getting it right on their own — by name, your own students only |
| Most common misconceptions | Mistakes held by **five or more** of your students, as counts. Smaller groups are not shown |
| Reviews due | Students with a skill due for review (no dates) |

Each row links to an action: **Assign practice**, **Plan a group session**, **Set next step**.
Every load is recorded.

## B. Learning Resources → Assign and plan learning

1. Search **Learning resources** (practice sets and lessons). Only published ONE content is listed.
2. On a resource choose one of:
   - **Assign** — *Who it is for*: *A class you teach* or *Selected students* (up to 500). The work
     comes up as the students' next step and stays until they finish it or you withdraw it.
   - **Plan a group session** — title, start, end, the class or students. It appears on your
     **Calendar** as a meeting; attendees see the title, time and content, not your staff note.
   - **Set as a student's next step** — one student, an action (learn, practise, review) and a
     reason: matches the class topic, a prerequisite first, revisit fundamentals, an upcoming
     assessment, the student asked, or your judgement. One pending next step per student; it is used
     once, when the student next plans.
3. Your recent assignments show **Done / Not yet** counts (a count under five reads `<5`). Open one to
   see who has done it.
4. To stop: **withdraw** the assignment or the next step with a reason (no longer needed, set in error,
   replaced).
5. Students see it on **Learning → From your lecturer** (web and Android) and are told in the app.

## What never changes

Nothing a lecturer does changes a student's results, evidence, mastery or readiness. Assigning only
changes what the student is offered next.

## Never do

- Never use *Set next step* to punish or single out a student; give the reason honestly.
- Never ask students to hand over their adaptive-learning consent so the cohort view fills up.

## Gaps

- **HG-6:** the cohort view and a student's plan stay empty until the adaptive-learning consent is
  published.
- The web form links one resource to a session (the system accepts up to five); no reminders.
- Department heads have no version of these tools.
- Writing is web only; Android shows lecturers *Assigned learning* read-only and students *From your
  lecturer*.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J10.
