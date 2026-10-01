# SOP — Staff, their scope, and teaching assignments

> What this is: the procedure college administrators and department heads follow to invite
> staff, set which students each person may see, and assign faculty to sections and batches.
> Why it exists: Appendix 3 INST-19 (IM1 slice); journeys J2 and J3. Built by INST-02 (one scope
> rule on every student read) and INST-03 (teaching assignments, scoped invitations). Written
> 2026-09-26 against base `6864332`; brought up to date 2026-10-01 against base `719eb34`
> (SEC-INST's write scope, INST-08's analytics access).

## Who sees which students

| Role | Sees |
|---|---|
| Owner, administrator | The whole college |
| Placement officer | The whole college, or the campus / department / batch set on their membership |
| Department head | Their department (its programmes, batches and sections) |
| Faculty | The sections and batches of their **active teaching assignments** once the college has recorded its first assignment; before that, the department/batch on their membership |

Every screen — roster, student detail, verification queue, readiness report, assessment results,
staff actions, My Students — uses this one rule. A link to a student outside your scope is
refused.

**Reading and writing differ.** For **reading**, a placement officer or department head with **no**
scope set still sees the whole college (a transition rule awaiting Divakar's decision). For
**writing** — verifying results, uploading results, assigning assessments, exporting, sprints,
counselling notes, learning actions — a department head with no department, and a lecturer without
an active teaching assignment, are refused (`SCOPE_REQUIRED`). Set a scope for every such person.
(Staff actions — interventions, tasks, notes, meetings — still follow the read rule.)

## A. Invite staff with a scope (administrator)

1. **Institution Admin → Staff → Invite institution staff**: email, role (placement officer,
   department head, faculty), and **Department** / **Batch** where relevant →
   **Send staff invitation**.
2. The invitation appears under *Staff invitations*; revoke it there if sent in error.
3. On acceptance the person appears under *Active staff memberships* with their scope.

## B. Change someone's scope (administrator)

1. **Staff** → the person's row → scope editor → choose units → reason (`SCOPE_REVIEW`,
   `ROLE_CHANGE`, `DEPARTMENT_MOVE`, `CORRECTION`) → **Save scope**.
2. It applies on their next request. The audit record keeps before and after.
3. Once a term, review every row showing **Whole institution** and set a scope where it should
   be narrower.

## C. Assign faculty to teach (administrator or department head)

1. Administrators: **Staff → Teaching assignments**. Department heads: **Faculty and Staff**.
2. Choose **Faculty member**, **Section or batch**, **Subject** (or a **Subject code**),
   **Academic term**, **Starts on**, optional **Ends on**, and a reason (`NEW_TERM`, `COVER`,
   `REALLOCATION`, `CORRECTION`) → **Assign**.
3. Department heads can assign only to their own department's sections and batches.
4. **The first assignment switches the whole college to assignment-based faculty scope.** From
   then on a lecturer with no active assignment sees no students. Record everyone's assignments
   together at the start of term.
5. To stop an assignment: **End assignment** with `TERM_ENDED`, `REALLOCATED`,
   `LEFT_INSTITUTION` or `CORRECTION`. Access ends on the next request. Assignments cannot be
   edited — end and re-create.

## D. Faculty: My Students

**Faculty → My Students** lists exactly the students in your active assignments, with
activation, assessments submitted in the last 30 days and open tasks. If it says *You have no
active teaching assignment yet*, ask your administrator or department head.

## Never do

- Never leave a department head without a department.
- Never share a staff login; invite each person.
- Never use an assignment to give someone access "temporarily" without an end date.

## Gaps

- **Unscoped staff still read the whole college** (see above). The recommended change — department
  heads without a department see nobody — is not applied for reads (decision for Divakar; security
  review INST-SR-02).
- A pending invitation re-sent with a different scope keeps its original scope; revoke and
  re-invite instead.
- Revoking, resending or ending a staff membership is not available on the Staff page yet.
- Analytics and exports access is granted on the same page ([exports SOP](sop-analytics-and-exports.md)).
- Faculty *Student Detail* still shows the faculty-notes list, not a profile.
- The Android app shows *My students*; assigning is web-only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J2, J3.
