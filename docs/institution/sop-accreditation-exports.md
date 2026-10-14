# SOP — Accreditation outcomes export and graduates' self-reports

> What this is: the procedure a college administrator or department head follows to download the
> accreditation outcomes file, and what a graduate does to report what they did after college. Why it
> exists: Appendix 3 INST-19; supplementary UAT script I-A. Built by INST-13 on INST-08's export gate.
> Written 2026-10-01 against base `719eb34`. Design:
> `docs/architecture/accreditation-outcome-exports-design.md`,
> `docs/architecture/student-outcome-declarations-table-design.md`.

## Before you start

- You need **analytics and exports access** ([exports SOP](sop-analytics-and-exports.md)). Placement
  officers and owners cannot hold it.
- Graduates count only once the college has recorded their graduation (**Students → Year-end
  actions**, [year-end SOP](sop-year-end-actions.md)).

## A. Download the file (administrator or department head with access)

1. **Reports → Exports** (department heads: **Reports and Analytics → Exports**) → **What to export:
   Accreditation outcomes**.
2. Choose a reason (usually `Accreditation preparation`) and download. There is no month or unit
   choice: the file stands at the end of last month and covers the students you are responsible for.
3. The file has one row per department × programme × year of graduation, plus a total. Each graduate
   is counted once:
   - **Placed** — an accepted offer or a hire, from applications the graduate shared with the college
     (the same rule as the placement statistics, so the numbers match);
   - **Higher studies** and **Entrepreneurship** — **self-reported** by graduates who chose to share
     them, and labelled so;
   - **No outcome shared** — everyone else.
4. Any figure under 5 reads `<5`; a total that would reveal it is withheld. Salary, package and
   anything ONE does not hold read `NA`.

## B. Before you submit anything

**ONE does not claim the file matches any NAAC, NBA or NIRF template.** The file says so in its first
rows. Check every figure against the current official template and your own records before
submission. A large "No outcome shared" count is expected at first.

## C. What graduates do (student, web or Android)

1. **Profile → After college**: choose *What did you go on to do?* (higher studies or
   entrepreneurship) and share it with the college.
2. They can change or **Withdraw** it at any time; the next export no longer counts it.
3. The college never sees the graduate's name next to it — only a count.

## Never do

- Never present `Placed` as all placements: students who shared nothing are not counted as placed or
  unplaced.
- Never fill the `NA` salary column from another source and present it as ONE's figure.
- Never ask graduates to self-report on the college's behalf or under pressure.

## Gaps

- No per-student accreditation list (names, employers, institutions admitted to) — by design.
- The self-report carries no detail (which institution, which venture).
- ONE does not remind graduates to self-report.
- The file is not on Android.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-A.
