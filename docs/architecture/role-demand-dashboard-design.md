# Role demand dashboard — design note (OPS-11)

**What this is.** The design for the Operations → Analytics role demand dashboard: what "demand" means, where each
number comes from, how small groups are suppressed, and how the catalogue's promotion rule is evaluated. It exists
because the dashboard counts people, and the rules that keep an aggregate from pointing at a person need to be written
down before the code that applies them.

**Goal:** OPS-11, Appendix 1 (§4.2 Analytics, §5.5 privacy, §5.6 honesty, §5.7 one bounded summary).
**Depends on:** OPS-08 (career_roles catalogue columns, migration 0051; `career-catalogue-table-design.md`),
OPS-01 (`ANALYTICS_VIEW`).
**Migration:** none. Everything read here already exists.

## What the product records, and therefore what "demand" can mean

| Source | What it gives | Used |
| --- | --- | --- |
| `student_career_targets` (0011) | A student's live targets (`cleared_at IS NULL`), PRIMARY or SECONDARY, with `selected_at` | Yes: the demand count, and the monthly trend |
| `career_roles` (0011 + 0051) | Code, title, catalogue code and family, `release_label`, `planned_release`, `active` | Yes: the rows, grouping by release label |
| `institution_relationships` (0000) | Which college a student belongs to, with state and window | Yes: colleges per role |
| `institution_student_profiles` + `institution_units` (0001, 0005) | The student's department at that college | Yes: branch, as the college names it |
| Engine goal table | — | Does not exist on any branch (see the catalogue design's "Goals G01–G13 are not stored") |
| Opportunities → role mapping | — | Does not exist: `opportunities` / `opportunity_versions` carry a free-text title and skills, nothing references `career_roles` |
| Paying employer requests | — | Do not exist: billing is deferred (ADR-022), and no "drive target" record exists |

Definitions used by the code (`packages/persistence/src/role-demand.ts`):

- **A student demanding role R** is a distinct user with a live target on R, whose account is not
  `DELETION_PENDING` or `DELETED` and has not been anonymised. PRIMARY and SECONDARY targets both count; a student is
  counted once per role.
- **A student's college** is an INSTITUTION organisation with an `institution_relationships` row for them that is
  current (`VERIFIED` or `ACTIVE`, started, not ended) or `GRADUATED`. Graduates count at the college they left
  (ONE serves past graduates); a student with no such row is counted under "No college recorded".
- **Branch** is the department unit (`institution_units.name`) on the student's `institution_student_profiles` row at
  that college, or "Department not recorded". Branch names are the college's own; they are **not** normalised across
  colleges, because mapping "CSE" at one college to "Computer Science" at another would be an inference the data does
  not support.
- **Trend** is, for each of the last 12 calendar months (UTC), the number of distinct students who selected any target
  in that month (by `selected_at`), whether or not they have since cleared it. It is platform-wide only.
- **Employer demand** is NA with the reason stated. No mapping from opportunities to roles is inferred from titles or
  skills.

## Suppression (§5.5)

Every count of people passes through the shared helper before it leaves the persistence layer, so a raw small count
never reaches a controller, the network or a screen.

- **Helper.** `suppressSmallCount` in `packages/authorization/src/aggregate-suppression.ts`, the one shared rule since
  INST-SR-01 / OPS-SR-24. A count below 5 — zero included — returns `{ suppressed: true, value: null }`.
- **Why not `suppressAggregateTable`.** That helper protects a table whose cells partition a published total by
  withholding the total. Here the total is the role's own count, which the summary shows and ranks by, and a student
  related to two colleges is counted in both, so college cells do not partition it. The breakdown helper below withholds
  a cell instead, and every value it publishes still passes through `suppressSmallCount`.
- **Role totals.** Each role's student count is suppressed below 5.
- **Colleges per role.** A count of colleges is not a count of people, but a role with fewer than 5 students and, say,
  4 colleges tells the reader it has exactly 4 students. So whenever the role's student count is suppressed, its
  college count is withheld too.
- **Breakdowns (colleges within a role, departments within a college).** Cells below 5 show `<5`. A single suppressed
  cell next to a shown total is recoverable by subtraction (total 7, one college 5, the other must be 2). So the
  breakdown helper `suppressDemandBreakdown` (`packages/authorization/src/role-demand.ts`) applies **complementary
  suppression**: if the suppressed cells together hold between 1 and 4 people, the smallest shown cell is withheld as
  well, which puts at least 6 people behind the withheld cells. Such a cell is marked `complementary` and the screen
  says "Withheld", not "<5", because it is not below 5.
- **No breakdown behind a suppressed parent.** A role whose total is suppressed returns no college breakdown; a college
  whose cell is withheld returns no departments.
- **Ordering does not leak.** Shown rows are ranked by count; suppressed rows follow in code order, never in their true
  order.
- **Trend months** are suppressed below 5 individually. No platform total of selections is shown beside them, so
  months cannot be recovered by subtraction.
- **Known limit.** A student related to two colleges is counted at both, so college cells can sum to more than the role
  total; complementary suppression is computed on the true suppressed mass, which is conservative in that case.

## The promotion rule

Source: `docs/ops/inputs/job-role-catalogue.md` §H — "a selectable role moves to the next release's build list when at
least 200 students across at least 3 colleges select it, or when a paying employer asks for it as a drive target."

The thresholds live in code constants in `packages/authorization/src/role-demand.ts`:

| Constant | Value |
| --- | --- |
| `rolePromotionMinimumStudents` | 200 |
| `rolePromotionMinimumColleges` | 3 |

`evaluateRolePromotion` returns:

- `MEETS` — the role is SELECTABLE and has at least 200 demanding students across at least 3 distinct colleges;
- `NOT_MET` — the role is SELECTABLE and the student arm is not met on recorded data;
- `NOT_APPLICABLE` — the role is already VERIFIED, or is not in the catalogue (no release label).

The employer arm is always reported as `NOT_RECORDED`: no paying-employer request exists to read. The screen says so
next to the indicator, so "not met" is never read as "no employer asked". A college counts toward the 3 when at least
one demanding student belongs to it (the rule says "across", not "at least 5 in each"); the college count behind the
indicator is still subject to the withholding rule above.

## API

- `GET /api/v1/operations/analytics/role-demand` — the one summary: every role (bounded at 1 000 rows, reported as
  `capped`), its suppressed student count, colleges (or withheld), release label, planned release and promotion
  status; the release-label grouping; the 12-month trend; employer demand NA. No parameters; any query parameter is a
  400.
- `GET /api/v1/operations/analytics/role-demand/roles/:roleId` — the drill-down for one role: colleges (bounded at 200)
  and, under each shown college, departments (bounded at 50), all through the breakdown helper.

Both require `ANALYTICS_VIEW` (OPERATIONS_ADMIN and PLATFORM_SUPER_ADMIN by baseline; SECURITY_ADMIN only by grant).
Both are read-only aggregates without names, emails or identifiers of students, so they write no audit row, as the
Overview does not. Errors use `safeError` with a correlation ID; database text never reaches the browser.

## Rejected options

- **Counting per branch across colleges by department name.** Rejected: department names are free text chosen by each
  college; matching them would be inventing a mapping. Branch stays within a college.
- **Using the catalogue's `eligible_branches`.** Rejected as a demand source: it describes who a role suits, not who
  chose it.
- **Inferring employer demand from opportunity titles or skills.** Rejected: §5.6 and the goal forbid invented
  mappings. Employer demand is NA until opportunities carry a role reference.
- **Primary-only counts, or primary and secondary side by side.** Side by side lets one be recovered from the other
  when small; primary-only undercounts a student's stated interest. Counting distinct students with any live target is
  what the promotion rule describes ("students select it").
- **Per-role trend.** Rejected for now: 108 roles × 12 months is mostly `<5` cells and multiplies subtraction risks.
- **Putting the breakdown for every role in the summary.** Rejected: unbounded in colleges × roles; the drill-down
  keeps the summary one bounded request.
- **A migration (materialised demand table).** Not needed at pilot scale; the counts are bounded aggregate queries over
  indexed tables. Revisit only with measured latency.
