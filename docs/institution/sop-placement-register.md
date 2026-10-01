# SOP — Placement statistics and the placement register

> What this is: the procedure the placement office, administrators and department heads follow to
> read the season's placement statistics and the register of employers and drives. Why it exists:
> Appendix 3 INST-19; journey J8. Built by INST-12 (statistics, register, drive categories), on
> INST-09's shared-application rule. Written 2026-10-01 against base `719eb34`. Design:
> `docs/architecture/placement-register-design.md`.

## Where

| Role | Where |
|---|---|
| Placement officer | **Dashboard** — *Placement statistics* and *Placement register* sections (there is no Drives or Placement item — HG-3) |
| Administrator, owner | **Placement** — statistics, register, each student's status and campus drive decisions |
| Department head | **Placement Pipeline** — the department's statistics by batch |
| Faculty | Not shown |

Drive categories are set under **Settings → Drive categories** ([campus drives SOP](sop-campus-drives.md)).

## How to read the statistics

| Column | Meaning |
|---|---|
| Eligible | Current students of the batch in your scope (graduates stay in their batch's season) |
| Not shared | Students who shared no application — **never counted as unplaced** |
| Applied, Shortlisted, With an offer | From shared applications |
| Placed | An offer accepted, or a hire |
| Placed, of students sharing | Placed ÷ students who shared — not placed ÷ eligible |
| Offers per placed student | Offers made ÷ placed |

- Figures stand at the **end of the last full month**: a placement made this month appears next month.
- Any group under five reads `<5`, and a row or column total that would reveal it is withheld. Early
  in a season most totals read `<5` — this is expected.
- Offer pay is never shown.

## The register

- **Employers engaged**: drives approved, scheduled and completed, jobs addressed to the college, last
  engaged.
- **Drive calendar**: date, employer, category, state, and after the drive completes the students
  sharing, with an offer and placed — counted only from shared applications.

## Steps

1. Once a month, after the first of the month, open the statistics and the register.
2. Reconcile with your own records by batch; differences usually mean a student has not shared an
   application. Ask them, never record it for them.
3. For a report to management, quote the figures as "of students who shared their applications".

## Never do

- Never fill a `<5` cell from your own knowledge in a report that names the department and batch.
- Never present the placement percentage as a share of all eligible students.
- Never add pay figures from another source to this register.

## Gaps

- No placement export (on screen only); the register lists at most 200 drives.
- Students without a department or batch are grouped as "No department" / "No batch".
- Android shows a read-only Placement statistics card; the register's employer and calendar tables
  are web only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J8.
