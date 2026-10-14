# SOP — Employer Dashboard and Reports

> What this is: employer-facing help for reading the Dashboard and the hiring Reports, with the
> matching operator steps. Why it exists: Appendix 2 EMP-18 asks for an SOP per shipped module;
> this covers EMP-15. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters of a verified, active employer.

### Where

- **Employer Portal → Dashboard** (Android: Home).
- **Employer Portal → Reports** (Android: the **Reports** button on Home, read-only).

### The Dashboard

Counts of your own data, computed by ONE's server and matching your lists exactly: open jobs,
new applicants in the last 7 days, interviews this week (Monday to Sunday, India time), offers
awaiting an answer, drives awaiting a college, and where open applications are now. A tile whose
source cannot be read shows **NA**, never a guess.

### Reports

- **Funnel by job**, **Funnel by college**, **Funnel by campus drive**: each application sits in
  exactly one cell — its current stage, Hired, or the stage it left at.
- **Time to each stage**: median days to shortlist, interview, offer and hire.
- **Offer outcomes** and the acceptance rate.

Rules that protect candidates:

- Any figure about fewer than 5 people reads **<5**.
- A college is named only from 5 applications, using the college name students put in the
  application they shared; the rest form *Other colleges or not stated*.
- A median needs at least 5 applications; an acceptance rate needs at least 5 accepted and 5 not
  accepted.
- Reports carry no candidate, no readiness and no protected attribute, and cannot be filtered on
  anything else. Every report view is audited.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| An employer says a number is wrong | Ask which tile and which list it should match; Dashboard figures are exact counts of the same rows the lists show. Log a support case with the reference |
| An employer asks for a breakdown by gender, caste or similar | Refuse: ONE never reports protected attributes |

## Gaps

- The old unsuppressed `hiring-analytics` route and its web page still exist though no screen
  uses them (EMP-SR-20).
- Job and drive rows are capped at the 200 most recent.
- Suppression is per table, not across tables.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — E-R.
