# SOP — Analytics: role demand and college health

> What this is: the operator procedure for reading Operations → Analytics: which roles students are
> aiming for, whether a role meets the catalogue's promotion rule, and how each college is doing.
> Why it exists: Appendix 1 OPS-17 (full) needs an SOP for every shipped module. Built by OPS-11
> (role demand) and OPS-14 (college health). Written 2026-10-01 against base `719eb34`. Designs:
> `docs/architecture/role-demand-dashboard-design.md` and `institution-accounts-table-design.md`.

## Purpose

Show measured demand and customer health without ever identifying a student.

## Who and what capability

`ANALYTICS_VIEW`. OPERATIONS_ADMIN and the super admin hold it by baseline. It can be granted to
SECURITY_ADMIN. Both screens only read. Nothing on them is audited, because they show only
suppressed totals, never a person.

## Where

**Operations → Analytics**. Role demand is at the top. **College health** is below it.

## A. Role demand

1. The tiles show:
   - **Students with a career target**;
   - **Roles in the catalogue**;
   - **Roles meeting the promotion rule**;
   - **Employer demand (not recorded)**, which is always NA because no record links an employer
     request to a role.
2. **Roles ranked by demand.** Filter by release label. A role with fewer than 5 students shows
   "Fewer than 5 students", has no rank, and sorts by code.
3. **Colleges…** opens one role's colleges and departments. A cell under 5 shows **<5**. A cell
   that would let a hidden count be worked out shows **Withheld**.
4. **The promotion rule** is 200 students across at least 3 colleges, or a paying employer request.
   The employer half is never evaluated (NOT_RECORDED), and the screen says so.
5. **New target selections by month** covers the last 12 months.

## B. College health

1. The **Colleges** table can be sorted by renewal date or by activity. Per college it shows:
   - rostered and signed-in students;
   - weekly active learners for the last complete week;
   - staff activity and open support cases;
   - verification state and renewal date.
2. **Details…** opens one college. It adds a four-week trend, assessments in the last month, staff
   actions and the **readiness band distribution** (bands only, never a number). Band movement shows
   NA, because nothing computes it yet.
3. Every count of people under 5 shows **<5**. A total that would reveal a hidden cell is withheld.
   Open support cases are work items and are shown as they are.

## What the numbers are not

- Not a list of students. If someone asks "which students?", the answer is: the college's own
  portal, under the college's own access rules.
- Not real-time. Weeks are complete ISO weeks (UTC) and months are ended months, on purpose: a
  rolling window could be compared day to day to single someone out.

## Never do

- Never try to recover a <5 or Withheld cell by subtracting other figures, and never publish
  figures from this screen in a way that lets others do it.
- Never copy college-level figures into a document for another college.
- Never read band counts as a readiness score. Readiness is an advisory band.

## Known issues

- **Release-label totals can reveal a hidden role count.** The "Demand by release label" total,
  minus the shown roles carrying that label, can give back a suppressed role's count. Until it is
  fixed (security review OPS-SR-27), do not share the release-label card outside Operations.
- The college list is capped at 500 colleges, and the role list at 1,000 roles.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-13 (role demand), O-14 (college health).
