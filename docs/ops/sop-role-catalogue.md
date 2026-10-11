# SOP — Job-role catalogue (Content Management → Job-role catalogue)

> What this is: the operator procedure for keeping the 108-role career catalogue and each role's
> requirement set: synonyms, a draft requirement set, review by someone else, and publishing with
> a second person's approval. Why it exists: Appendix 1 OPS-17 (full) needs an SOP for every
> shipped module; journey J8 runs through it. Built by OPS-08. Written 2026-10-01 against base
> `719eb34`. Design: `docs/architecture/career-catalogue-table-design.md`.

## Purpose

Students pick a career target from this catalogue, and each role's requirement set feeds their
gap and readiness results. A requirement set therefore never goes live on one person's say-so: it
is drafted, reviewed by someone else, approved by a second person, and only then published.

## Who and what capability

| Task | Capability | Who holds it |
|---|---|---|
| Read the catalogue | `CATALOGUE_MANAGE`, `CONTENT_REVIEW` or `CONTENT_PUBLISH` | by grant |
| Synonyms, drafts, items, submit, withdraw | `CATALOGUE_MANAGE` | by grant |
| Pass a review / send back | `CONTENT_REVIEW` (and not the set's author) | by grant |
| Publish | `CONTENT_PUBLISH` **plus an approval** (`CAREER_REQUIREMENT_SET_PUBLISH`) | by grant (high-risk to grant) |

**No platform role holds any of these by baseline.** Each must be granted on Settings
([sop-staff-capabilities.md](sop-staff-capabilities.md)). The super admin can act through them
only as break-glass, and every such write is audited `break_glass: true`. `CONTENT_PUBLISH` is a
high-risk capability: granting it needs an approval.

## Where

**Operations → Content Management → Job-role catalogue** (the first panel on the page).

## A. Find a role

1. Search by code (for example `C01`), name, branch or synonym. Filter by family, branch or
   release label. **Open <code>** shows the role.
2. The role shows its planning data, the live requirements and **Students targeting it**, which
   shows **<5** for any count under 5. Students are never listed.

## B. Synonyms

1. Add: type the synonym (2–120 characters) and **Add synonym** with a reason:
   `STUDENT_WORDING`, `INDUSTRY_TITLE`, `REGIONAL_TITLE`, `CORRECTION`. Text that starts like a
   spreadsheet formula is refused.
2. Remove: **Remove <synonym>…** with `MISLEADING`, `DUPLICATE` or `CORRECTION`.

## C. Change a role's requirements (J8)

1. **Start a new draft…** with `NEW_REQUIREMENT_SET`, `REVISION` or `EVIDENCE_UPDATE`. A role has at
   most one open set at a time.
2. **Find topics**, add items (level, target mastery between 0 and 1, required evidence types),
   then **Save draft** (`DRAFT_EDIT`). At most 50 items per set.
3. **Submit for review…** (`READY_FOR_REVIEW`). The items are now frozen.
4. **A different person** holding `CONTENT_REVIEW` either chooses **Pass review…**
   (`REVIEW_PASSED`) or **Send back…** (`CHANGES_REQUESTED`). If you drafted the set, the screen
   says "You drafted this set, so someone else reviews it." The server refuses a self-review with
   `CAREER_SET_SELF_REVIEW_REFUSED`, and so does the database.
5. On the REVIEWED set, choose the **Label after publishing** and **Request publish…** with
   `NEW_REQUIREMENT_SET`, `REQUIREMENT_CORRECTION`, `ROLE_VERIFIED` or `EVIDENCE_UPDATE`. This
   files an approval request. It does not publish.
6. An approver (`APPROVE_HIGH_RISK`) approves it in **Settings → Approvals**. You then press
   **Execute** within 24 hours ([sop-approvals.md](sop-approvals.md)). The set goes live, and the
   previous version stays on record.
7. If the publish is refused with `CAREER_TOPIC_NOT_LIVE`, a topic in the set is not yet published
   in the skill map ([sop-content-authoring.md](sop-content-authoring.md)). Publish the topic, then
   execute again: the approval is still usable within its 24 hours.

To abandon a set, choose **Withdraw…** with `ABANDONED`, `SUPERSEDED_BY_NEW_DRAFT` or
`ENTERED_IN_ERROR`. An author can pull a set back from review with `AUTHOR_RECALL`.

## Reason codes

All of them are listed above. They are defined in `packages/authorization/src/career-catalogue.ts:64-78`.

## Escalation

- `APPROVAL_PAYLOAD_MISMATCH`: the set or label changed after the request. File a new request.
- `CAREER_SET_OPEN_EXISTS`: finish or withdraw the open set first.
- A student-facing change you did not expect: the student catalogue is behind the flag
  `career-catalogue.selectable-roles`, which is **off** by default ([sop-feature-flags.md](sop-feature-flags.md)).

## Never do

- Never ask the reviewer to "just pass it". Review is the control.
- Never mark a role VERIFIED except through a reviewed and approved publish (the database refuses
  any other route).
- Never edit `data/careers/*.json` or run the starter seed against production to change a role.
  That is an engineering deployment step.

## Gaps

- **A one-person pilot cannot publish a requirement set.** Review needs a second person, and there
  is no solo path for review. The approval itself can use the solo safeguard.
- Nothing recomputes students' gaps after a publish. The `career_requirement_set.published` event
  is emitted, and gaps refresh through the existing paths.
- The author of a set is not refused at the publish step. Only author ≠ reviewer is enforced
  (security review OPS-SR-35).
- There is no student-facing synonym matching, and there is no web student career picker (Android only).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J8.
