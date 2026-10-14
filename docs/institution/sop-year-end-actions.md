# SOP — Year-end actions: graduating, transferring and ending students

> What this is: the procedure college owners and administrators follow at the end of a year to
> graduate a batch, transfer students out or end their relationship, in one step. Why it exists:
> Appendix 3 INST-19; supplementary UAT script I-Y. Built by INST-10. Written 2026-10-01 against base
> `719eb34`. Design: `docs/architecture/institution-batch-lifecycle-design.md`.

## Who and where

Owners and administrators only: **Students → Year-end actions**. Department heads, placement officers
and faculty cannot change relationships.

## What changes, and what does not

- The student keeps their ONE account, their records and their choices. A graduate keeps the student
  workspace and can still ask the college to verify past results.
- From the effective date, the college sees only what happened **before** that date.
- A graduated student stays on the roster with the new state and end date, and stays in their batch's
  placement season.

## Steps

1. **Action**: *Graduate*, *Transfer out* or *End relationship*.
2. **Students**: *Everyone in a batch or unit* (choose it) or *A list of roll numbers* (one per line).
3. **Effective date**: leave empty for today. A future date is refused — prepare the batch and commit
   it on the day.
4. **Preview**. Each row reads *Will change*, *Already left — no change* or *Cannot change* (*Not on
   your roster*, *Date is before this student joined*). Nothing is saved while any row cannot change:
   fix or remove those rows and preview again.
5. Choose the **Reason**:

   | Action | Reasons |
   |---|---|
   | Graduate | Completed the programme · Completed early |
   | Transfer out | Moved to another institution · Moved to a programme outside ONE |
   | End relationship | Left the programme · Withdrawn by the institution |

6. **Commit N changes**. Exactly the previewed rows change. If anyone changed a student in between,
   the commit is refused — preview again.
7. At most 1,000 students in one batch; choose a smaller unit if you hit the limit.

## Never do

- Never graduate a batch before results are declared and verified.
- Never use *End relationship* to hide a student from a report.
- Never ask AI8HT to "undo" a year-end change by editing the database — record a correction instead.

## Gaps

- Department heads cannot run year-end actions for their department (an open decision for Divakar).
- Students are told by the in-app notice the app already sends; no email is sent until outgoing email
  is switched on.
- Year-end actions are web only (a desk task).

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-Y.
