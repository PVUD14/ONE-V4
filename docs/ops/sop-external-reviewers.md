# SOP — Faculty reviewers (Content Management → Faculty review)

> What this is: the operator procedure for letting a college's faculty member review assigned
> content drafts, and the faculty member's own steps. Why it exists: Appendix 1 OPS-17 (full) needs
> an SOP for every shipped module; journey J9 runs through it. Built by OPS-10 (ADR-037). Written
> 2026-10-01 against base `719eb34`.

## Purpose

College faculty can check ONE's content drafts. They see only the drafts assigned to them, never a
student, and never an answer key. Their decision is advice. Publishing stays with an internal
`CONTENT_PUBLISH` holder.

## Who and what capability

| Task | Capability |
|---|---|
| See the Faculty review panel | `CONTENT_EDIT`, `CONTENT_REVIEW`, `CONTENT_PUBLISH` or `CAPABILITY_ADMIN` |
| Grant or revoke a faculty member's review access | `CAPABILITY_ADMIN` (super admin by baseline) |
| Assign drafts / withdraw an assignment | `CONTENT_REVIEW`, and not a contributor to the draft |
| Review an assigned draft (faculty) | An ACTIVE `FACULTY_LECTURER` or `DEPARTMENT_HEAD` membership holding `CONTENT_REVIEW_EXTERNAL` |

`CONTENT_REVIEW_EXTERNAL` is not high-risk, and granting it needs no approval. It cannot be granted
from the Settings staff screen, and it never opens an Operations screen.

## Where

- Operator: **Operations → Content Management → Faculty review** (below Bulk import).
- Faculty:
  - a lecturer uses **Learning Resources → Drafts assigned to you**;
  - a department head uses **Assessments**, in the section below the exam engine.

## A. Give a faculty member review access

1. Agree it with the college first, outside ONE. The college is not asked in the product.
2. Type the person's exact work email in **Faculty email** and press **Find**. Only an exact match is
   shown.
3. **Grant faculty review…** with `FACULTY_REVIEWER_AGREED` (or `CORRECTION`), then **Grant**.

## B. Assign drafts

1. In **Assign drafts in review**, tick the drafts (skills, questions or lessons that are IN_REVIEW).
2. Choose the **Reviewer** and the **Days** the assignment stays open (1–30, default 14).
3. **Assign N…** with `SUBJECT_EXPERT_REVIEW`, `CURRICULUM_ALIGNMENT` or `AGENT_DRAFT_CHECK`. At most
   50 drafts at a time.
4. You cannot assign a draft you wrote, edited or submitted
   (`EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED`), or assign one to yourself.

## C. The faculty member reviews (J9)

1. Open **Review…** on an open assignment. A question shows its prompt, options, difficulty and
   skill. It never shows the key or the hints.
2. Choose **Decision**:
   - **Approve** (`REVIEW_PASSED`);
   - **Request changes** with a reason (`CONTENT_INACCURATE`, `OUT_OF_SYLLABUS`, `UNCLEAR_WORDING`,
     `LEVEL_MISMATCH`, `ANSWER_OPTIONS_WEAK`, `OTHER_CONCERN`) and a **Comment** (required; no
     personal details).
3. **Record decision.** There is one decision per assignment.
4. Back in Operations, read the decision in **Assignments and faculty decisions**. The internal
   reviewer and publisher then continue as usual ([sop-content-authoring.md](sop-content-authoring.md)).

## D. Withdraw or revoke

- **Withdraw…** one open assignment: `NO_LONGER_NEEDED`, `REASSIGNED` or `CORRECTION`.
- **Revoke…** a faculty member's access: `REVIEW_PROGRAMME_ENDED`, `COLLEGE_REQUEST`, `LEAVER`,
  `SECURITY_INCIDENT` or `CORRECTION`. Every open assignment closes with it.
- The quarterly access review also lists every faculty grant ([sop-access-reviews.md](sop-access-reviews.md)).

## Escalation and standing rules

- **When a college tells you a lecturer has left, revoke the grant at once (`LEAVER`).** Ending the
  membership makes the grant ineffective, but it stays on record and comes back if the membership is
  reactivated.
- **When a college is deactivated or leaves ONE**, revoke its faculty grants (`COLLEGE_REQUEST` or
  `REVIEW_PROGRAMME_ENDED`). Review access does not check the college's state (security review
  OPS-SR-37).

## Never do

- Never send a faculty member a draft any other way (email, files). The assignment is the only
  channel that keeps them away from student data and answer keys.
- Never grant review access to a student, an institution admin or an employer. The server refuses
  it anyway.

## Gaps

- Faculty are not notified of a new assignment; they must check their queue.
- A faculty member opening a draft is not audited; only the decision is.
- Faculty sign in through the ordinary user pool, not the staff pool (a recorded decision).
- The operator lists show faculty emails to content staff, and those reads are not audited.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J9.
