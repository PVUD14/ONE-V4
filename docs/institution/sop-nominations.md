# SOP — Nominating students for a campus drive

> What this is: the procedure the placement office follows to put eligible students forward for an
> approved campus drive, and what a nominated student does. Why it exists: Appendix 3 INST-19;
> journey J9. Built by INST-14 (decision 10.2 #7: only students who opt in reach the employer).
> Written 2026-10-01 against base `719eb34`. Design:
> `docs/architecture/campus-drive-nominations-table-design.md`.

## The rule in one line

**Nothing about a student reaches the employer unless the student opts in. A student who declines is
not singled out: the college sees only "Opted in" or "Not opted in".**

## Who and where

| Who | Can |
|---|---|
| Placement officer with a whole-college scope, owner, administrator | Nominate and withdraw nominations |
| Department head | Read the nominations of their department's students |
| Faculty | Nothing |

Nominations live in an approved drive's details: **Campus drive approvals** (placement officer's
Dashboard; administrator's Placement page) → open the drive → **Nominations**. There is no separate
navigation item (HG-3).

## A. Nominate (placement office)

1. Open an **approved or scheduled** drive. A drive that is not open for applications cannot take
   nominations.
2. **Nominate students → Eligible list**: each current student in your scope with their result against
   the job's eligibility rules — *Eligible*, *Does not meet a rule*, *Cannot confirm yet* — from their
   academic records. The list never says whether a student applied or holds an offer.
3. Tick students (or **Choose every eligible student shown**; **Show more students** to page). Only
   *Eligible* students can be nominated; at most 200 at a time.
4. Choose a **Reason** — meets eligibility, placement office shortlist, or student expressed interest —
   and an optional **Note to the students**. Confirm.
5. Students already nominated, not eligible, or outside your scope are skipped and listed as such.

## B. Follow up

1. **Nominated students** shows each student's response: *Opted in*, *Not opted in*, *Nomination
   withdrawn*, *Drive closed*. The summary counts read `<5` for any group under five.
2. To withdraw a nomination that has not been accepted: **Withdraw nomination** → reason
   (`NOMINATED_IN_ERROR`, `DRIVE_CHANGED`, `STUDENT_REQUESTED`) → **Confirm: withdraw**.
3. A nomination closes by itself when its drive ends. There are no reminders.

## C. What the student does (web or Android)

1. **Applications → Nominations from your college** shows who nominated them (as a role and the
   college), the drive, the reason, and the one-offer policy if it stops them.
2. **Review and decide** shows exactly what the employer would see. **Opt in and share my profile**
   makes an ordinary application, marked "Nominated by placement office" to the employer. Sharing that
   application's progress with the college is a separate, unticked choice.
3. **Decline** has no effect on the student's standing and can be changed while the drive is live.

## Never do

- Never tell an employer who was nominated or who declined.
- Never contact a student to ask why they did not opt in.
- Never nominate on a student's behalf "to save time" — the opt-in is the student's consent.

## Gaps

- Nominating is web only; Android shows students their nominations (with opt-in and decline) and staff
  each scheduled drive's suppressed summary.
- Nomination notices are in-app only (no email).
- A withdrawal after opting in is visible to the college as different from a decline.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J9.
