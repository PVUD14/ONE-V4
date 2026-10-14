# ADR-037 — External Faculty Review of ONE Content Is Assignment-Scoped and Advisory

**Status:** Accepted by default under AGENTS.md ("ask once, recommend, carry on"); Divakar may override
**Date:** 2026-09-29
**Goal:** OPS-10 (Appendix 1), item 1: "a scoped CONTENT_REVIEW_EXTERNAL capability grantable to
FACULTY_LECTURER and DEPARTMENT_HEAD memberships; content access only; no student data; no publishing"
**Relates to:** ADR-032 (internal operator capabilities; reserves `CONTENT_REVIEW_EXTERNAL` for institution
faculty), ADR-018 (capabilities rather than roles), ADR-035 (migrations apply once)
**Design:** `docs/architecture/external-review-assignments-table-design.md`

## Context

ONE's global learning content — skills (OPS-09a), readiness-check questions (OPS-09b), lessons and their
variants (OPS-09c), much of it imported as drafts (OPS-09d) and some of it agent-drafted — is written and
reviewed inside AI8HT. Content volume outpaces reviewers (Appendix 1 risk register), and the master plan
expects college faculty, who know the subjects, to review it. Faculty belong to colleges, not to the ONE
platform organisation, and faculty memberships also carry student data access through the institution
portal. Giving them any content power must not widen that, and must not let an outside party publish.

The four editors share one rule: whoever wrote, edited or submitted a revision never reviews or publishes it
(for lessons, the approver also never publishes). The approval step of the 0004 lifecycle is also the
**rights review**: it writes the release-eligible source record that AI8HT's release manifest requires.

## Decision

1. **The capability is eligibility, not access.** `CONTENT_REVIEW_EXTERNAL` stays what 0039 made it: a
   `membership_capabilities` grant, valid only on an ACTIVE institution `FACULTY_LECTURER` or
   `DEPARTMENT_HEAD` membership. On its own it shows nothing.
2. **Access is an assignment.** A person holding internal `CONTENT_REVIEW` assigns one IN_REVIEW content
   revision (or a set of them, one row each) to one granted faculty membership, for a fixed period of at
   most 30 days, with a reason code. The assignment is bound to the revision's content hash. The faculty
   member sees that revision's content, and nothing else, while the assignment is open.
3. **The faculty decision is advisory and recorded.** The reviewer approves or requests changes, with a
   reason code and a comment. The decision is stored on the assignment, audited and announced on the
   outbox. It does **not** move the revision along the lifecycle: an internal `CONTENT_REVIEW` holder still
   approves (and records the rights review), and an internal `CONTENT_PUBLISH` holder still publishes, with
   every approval rule the editors already enforce.
4. **Granting is capability administration.** Granting and revoking `CONTENT_REVIEW_EXTERNAL` needs
   `CAPABILITY_ADMIN` (ADR-032 §6) and a reason code, from Content Management, never from the Settings staff
   screen. It is not a high-risk capability (Appendix 1 §5.4), so it needs no second approval. Revoking it
   closes the membership's open assignments in the same transaction. A college ending the membership ends
   the access on the next request, because only ACTIVE memberships count.
5. **Conflict rules.** A contributor to a revision (author, editor, submitter) can neither assign it nor be
   assigned it; the assigner is never the reviewer.
6. **No answer keys, no student data, no staff data.** The faculty view is a whitelist projection per
   content type. For a question it is the prompt, the option texts, the difficulty band and the skill: the
   correct option, the explanation, the misconception tags and the hint ladder are withheld, because
   Appendix 1 OPS-09b makes keys visible only to `CONTENT_EDIT` and `CONTENT_REVIEW` and OPS-10 does not
   extend that. No response names an author, an operator or a student.

## Rejected

- **Faculty approval moves the revision to APPROVED.** Approval is the rights review, an attestation that
  AI8HT owns or may use the content, which a college lecturer cannot make on AI8HT's behalf. It would also
  put an external party into three editors' state machines and into the lessons' "approver never publishes"
  rule. The subject-matter check is what faculty add; it is recorded beside the internal approval instead.
- **A standing grant that shows every draft.** "Sees only assigned drafts" (OPS-10 acceptance) and least
  access both rule it out.
- **Scope by track (a set of topics).** Tracks are not one entity across skills, questions and lessons today.
  Per-revision assignment is the narrowest scope; assigning several revisions in one action covers an item
  set.
- **Granting from the college side.** The content is AI8HT's and so is the choice of who reviews it; the
  college's control is the membership itself, which it can end.
- **An expiry column on `membership_capabilities`.** Every capability loader would have to learn it; the
  time limit belongs on the assignment, which is where access actually lives. Standing grants are covered by
  the quarterly access review (OPS-15).
- **Staff-pool gating for faculty now.** OPS-07 enforces the staff pool for the three platform roles only;
  faculty sign in as institution staff. The grant opens content drafts only, never student or operator data,
  so it is not gated until institution roles join the staff pool (ADR-025).

## Consequences

- Faculty review works for skills, questions, lessons and lesson variants without touching the editors'
  lifecycle, and publishing still needs internal people.
- Question review by faculty cannot check the answer key. If Divakar wants that, it is a new decision: keys
  inside the review surface only, never in a learner DTO.
- The faculty queue is reachable under the existing faculty navigation (Learning Resources) and the
  department head's Assessments page; no navigation item is added, removed, renamed or reordered.
