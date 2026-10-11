# SOP — Campus drive approvals, placement policies and drive categories (college side)

> What this is: the procedure the placement office follows to decide employers' campus drive
> requests, set the college's placement policy and label drives with the college's own categories.
> Why it exists: Appendix 3 INST-19 — the placement office's drive work is a shipped module of the
> institution portal; supplementary UAT script I-D. Built by EMP-11 (drives and policies, ADR-038)
> and INST-12 (categories). The employer side of a drive is covered by the employer SOPs and UAT.
> Written 2026-10-01 against base `719eb34`.

## Who and where

| Who | Where | Can |
|---|---|---|
| Placement officer with a whole-college scope, owner, administrator | Placement officer: **Dashboard → Campus drive approvals**, **Placement policies**. Administrator: **Placement → Campus drive approvals**; **Settings → Placement policies** | Decide drives, set and retire the policy |
| Same | **Settings → Drive categories** (administrator); the Category column of **Campus drive approvals** | Define, retire and assign categories |
| Placement officer narrowed to a campus, department or batch | Same screens | Read only — deciding needs a placement role for the whole college |
| Department head, faculty | — | No drive decisions |

## A. Decide a drive request

1. **Campus drive approvals** lists each request: employer, state, category, proposed and confirmed
   dates, the employer's note. An employer *Not currently verified* is flagged.
2. Open the request (**Show**) and choose one action:

   | Action | Effect |
   |---|---|
   | **Approve** | Your students see the job and can apply while it is open; your placement policy applies to everyone applying through the drive |
   | **Ask for changes** | The employer revises; nothing reaches students meanwhile. Reason: schedule, eligibility, terms clarification or details missing |
   | **Decline** | The employer sees your reason: season closed, schedule conflict, role not suitable, terms not acceptable, employer concern, duplicate request |
   | **Set date** | Confirm or move the start and end, and where |
   | **Mark complete** | Students no longer see the job through the drive; its results become available |
   | **Withdraw approval** | Students no longer see the job through the drive; applications already made carry on. Reason required |

3. Tick *Open to students who already hold an offer* only for a drive that should be an exception to
   your one-offer policy (and only if the policy allows exceptions).
4. After completion, **Results** shows counts, and names only students who shared that application
   with the college. Groups under five read `<5`. Offer pay is never shown.

## B. Placement policy

1. **Placement policies → One offer per student**: a student who has accepted an offer cannot apply
   through your campus drives. Optionally allow exceptions for drives you mark as open to offer
   holders, and add a note shown to students. **Put this policy in force**.
2. To stop it: **Retire this policy** with a reason (`POLICY_CHANGED`, `SEASON_ENDED`, `SET_IN_ERROR`).
   It no longer applies to new drive applications.
3. The policy never applies to jobs a student finds outside your drives.

## C. Drive categories

1. **Settings → Drive categories**: add a **Name** (for example Dream, Core, Mass), an optional meaning
   and an order.
2. Label a drive from the Category column of **Campus drive approvals**.
3. Categories are internal labels: employers and students never see them, and they carry no rule.
4. A category cannot be edited or deleted, only retired (`NO_LONGER_USED`, `RENAMED`, `SET_IN_ERROR`).

## Never do

- Never approve a drive whose terms ask students to pay the employer.
- Never use a category name that judges students (categories describe drives, not people).

## Gaps

- **No Drives navigation item (HG-3):** the placement officer works from Dashboard sections.
- Android shows scheduled drives (with category and the suppressed nomination summary) read-only;
  deciding is web only.
- Outgoing email is not switched on in production, so employers and students learn of decisions in the
  app only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-D.
