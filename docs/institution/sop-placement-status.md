# SOP — Students' placement status and shared applications

> What this is: the procedure placement officers, administrators and department heads follow to see
> where each student stands in placements, and what a student does to share or stop sharing an
> application with the college. Why it exists: Appendix 3 INST-19; supplementary UAT script I-P and
> journey J8. Built by INST-09 under ADR-019 (the college sees an application only with the student's
> consent) and ADR-024 (never offer pay). Written 2026-10-01 against base `719eb34`.

## The rule in one line

**The college sees only applications a student has chosen to share, only while the student is
enrolled, and never the offer's pay or terms.**

## Who sees it, and where

| Role | Where |
|---|---|
| Administrator, owner | **Placement** (status by student, with *View shared applications*) and **Student Detail** |
| Placement officer | **Students** and **Student Search** (Placement status column, *View applications*) |
| Department head | **Students**, **Placement Pipeline**, **Opportunities and Offers** — their department only |
| Faculty | Not shown |

## What each status means

| Status | Meaning |
|---|---|
| Nothing shared | The student has not shared any application. **It does not mean "not applied"** |
| Applied | A shared application that is not further along (including rejected, withdrawn or declined) |
| In process | A shared application between screening and interview |
| Offer | A shared application with an offer sent and not yet answered |
| Accepted | A shared offer accepted, or a hire |

An employer's unsent draft offer is not an offer. Applications the student declared from outside ONE
are listed per student, marked unverified, and never change the status.

## Steps (staff)

1. Open the list for your role (table above). Use **Load more students** to page.
2. Open **View shared applications** only when you need the detail for one student. Every list load and
   every per-student read is recorded.
3. When a student says they have an offer that is not shown, ask them to share it themselves — never
   record it on their behalf.

## Steps (student, web or Android)

1. **Applications**: when applying, tick *Also share this application's employer, role, stage, key
   dates and offer response with my institution…* (optional).
2. Later, each application shows **Share with institution** or **Stop institution sharing**. Stopping
   removes it from the college's view on its next load.
3. For an application made outside ONE, the external-application form offers the same optional share.

## Never do

- Never count "Nothing shared" as unplaced, in a report or in a conversation with management.
- Never pressure a student to share; sharing is their choice and they can stop at any time.
- Never ask an employer for a student's pay.

## Gaps

- The per-student status list is web only (an audited read); Android shows the suppressed status
  distribution on the institution home.
- The apply-time and share-later wording is a privacy-review item (ADR-019 notice text).

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-P, and step 4 of J8.
