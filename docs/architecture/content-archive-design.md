# Archiving Published Content (Skills, Questions, Lessons) — Design

**Status:** Adopted. The recommended option was taken per AGENTS.md ("ask once, recommend, carry on").
**Date:** 2026-09-30
**Migration:** `0090_notice_approval_and_content_archive.sql`. It adds no table. It widens one CHECK for the `ARCHIVED` state
only, and replaces one guard.
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`.
**Builds on:** `skill-map-editor-design.md` (OPS-09a), `question-bank-editor-design.md` (OPS-09b),
`lesson-variant-editor-design.md` (OPS-09c), and the 0004 content lifecycle.

## Why this exists

The 0004 lifecycle is `DRAFT → IN_REVIEW → APPROVED → PUBLISHED → ARCHIVED`
(`assertContentTransition`, packages/career-readiness). The three content editors build every step up to
`PUBLISHED`. Nothing builds the last one. `docs/ops/runbook-engine-migration-rollback.md` (ENG-17, gap 1) found the
result: published content cannot be withdrawn. Suppose a question turns out to be wrong, or a lesson's licence is withdrawn,
or a skill was published by mistake. The only fix today is a new revision. That new revision keeps the item live, and it
needs a full review and publish.

Two things stop archiving today, even at the database level:

1. `protect_published_content_revision` (0004) refuses **every** update of a `PUBLISHED` row, including the lifecycle's own
   `PUBLISHED → ARCHIVED`.
2. `content_revision_publication_ck` (0004) says a row carries `published_at` and `release_manifest_id` **if and only if**
   it is `PUBLISHED`. An archived revision would then have to erase when it was published and which release published
   it. That is the provenance a person's record may later depend on: a readiness check that asked the question, or a
   lesson a student completed.

## Decision 1: archiving is a removal, recorded, with no dual control

The operator action is "archive this skill / question / lesson". It needs `CONTENT_PUBLISH`, because archiving is the
reverse of publishing, and the same people answer for what is live. It carries a reason code from code
(`contentArchiveReasons`, packages/authorization):

| Code | When |
| --- | --- |
| `CONTENT_INACCURATE` | The content is wrong. |
| `RIGHTS_WITHDRAWN` | The licence or ownership no longer holds. |
| `OUT_OF_DATE` | The content no longer reflects current practice. |
| `DUPLICATE` | Another item covers the same thing. |
| `INCIDENT_RESPONSE` | Withdrawn during an incident (runbook-pilot-incident.md). |

**No second person's approval.** Appendix 1 §5.4 asks for dual control on actions that *add* risk: publishing
content that changes readiness inputs, granting a capability, enabling an AI feature. Archiving takes something away from
students, and it must be quick in an incident, when one person may be all there is. What protects the product here is the
record, not a second pair of eyes. Every archive writes:

- a `content_review_actions` row per archived revision (`action = 'ARCHIVE'`, `PUBLISHED → ARCHIVED`, the reason
  code, the actor, the correlation id). The 0004 table already allows `ARCHIVE`;
- an audit row per item (`operations.content.{skill,question,lesson}_archived`) with the reason code, the item, the
  revisions archived and `break_glass` when it applies;
- the editor's existing `*.revision_state_changed` outbox event per revision (`toState = ARCHIVED`), which already has
  `ARCHIVED` in its enum. No new event type is needed.

**Rejected: an OPS-02 approval key for archiving.** It would put a 15-minute cooling-off in front of pulling a wrong
question during an incident while Divakar is the only approver. It would also make removal harder than the
publication it reverses.

**Rejected: contributor separation for archiving.** Separation exists so that nobody vouches for their own work. An
author withdrawing their own published item is not vouching for anything.

## Decision 2: the database allows exactly one change to a published revision

0090 replaces `protect_published_content_revision` with the same function plus one allowance. A `PUBLISHED` row of a
`TOPIC`, `QUESTION` or `LESSON` may move to `ARCHIVED` when **both** of these hold:

- every other column is unchanged (`to_jsonb(NEW) - 'state' = to_jsonb(OLD) - 'state'`). The body, hash, manifest and
  `published_at` stay exactly as published;
- an `ARCHIVE` review action (`PUBLISHED → ARCHIVED`) for that revision already exists. A second writer cannot archive
  without the record.

Everything else stays refused: any change to an `ARCHIVED` row, any other change to a `PUBLISHED` row, and deletion.
`ARCHIVED` is final (`ARCHIVED: []` in the lifecycle).

`content_revision_publication_ck` becomes
`state = 'ARCHIVED' OR ((state = 'PUBLISHED') = (published_at IS NOT NULL AND release_manifest_id IS NOT NULL))`.
For every state except `ARCHIVED` this is the 0004 rule unchanged. For `ARCHIVED` it allows the publication columns to
stay. The trigger above is what makes an archived row with a publication possible, and it makes that row possible only
from a real publication. This is a widening of a constraint, and it is deliberate. The alternative was to null
`published_at` and `release_manifest_id` on archive. That destroys the provenance the constraint exists to protect,
which is the worse outcome. No row in any environment can be `ARCHIVED` today with those columns set, so the new CHECK
validates against existing data unchanged.

**Engine content is not included.** Misconception codes, teaching strategies and option tags keep the 0004 behaviour.
Their lifecycle (`transitionEngineContent`) has its own mirror triggers onto the engine tables, and no operator screen
edits them yet. Archiving them is the same pattern on another table set, and is left for when an engine-content editor
exists. The runbook records that remainder.

## Decision 3: "stop serving immediately" goes through the column every pool already reads

Every learner-facing pool reads `question_versions.superseded_at IS NULL` and `lesson_versions.superseded_at IS NULL`:
the readiness check (`startAssessmentAttempt`), the learning-step items and lessons (`learning-experience.ts`), the
placement pool (`loadEligiblePlacementItems`), faculty learning actions (`learning_content_published`), and the
catalogue and progress reads (`career-readiness.ts`). The 0061 and 0065 guards already allow exactly one change to a
version row: `superseded_at` from NULL to a time.

Archiving a question or a base lesson therefore sets `superseded_at = now()` on its current version, in the archive
transaction. Every pool drops it from the next read, and no reader learns a new rule. The version row stays, so
attempts already holding the question still grade against it, and progress and evidence already pointing at the
lesson stay valid. That is the same promise supersession already makes.

Why not a new `archived_at` column: every pool query would have to learn it. A missed one would keep serving archived
content, and that is exactly the failure this goal must prevent. The editor tells archived from superseded by the
revisions' `ARCHIVED` state.

**A skill** is served through `taxonomy_nodes.active`. The published catalogue, the placement pool, the gap engine
and the requirement guards read it. Archiving sets `active = false`, and the node keeps pointing at its (now archived)
revision. The 0057 guard only restricts moving the pointer or switching a node on. The skill map already shows a
non-active node whose pointer is not an open revision as `RETIRED`.

**A variant** has no `lesson_versions` row. What ENG-16 will serve is "the latest `PUBLISHED` revision of the variant".
Archiving therefore archives **every** `PUBLISHED` revision of the item, not only the newest, so that no older revision
becomes "the latest published". The same rule is applied to all three kinds, for one consistent meaning: an archived
item has no published revision left.

## Decision 4: what may not be archived out from under something live

Archiving is refused, with 409 `<KIND>_ARCHIVE_BLOCKED` and stable problem codes, when it would leave something live
pointing at something that is no longer live. The operator archives or revises the dependent first.

| Item | Refused while | Problem code |
| --- | --- | --- |
| any | an open revision exists (publishing it later would bring the item back) | `ARCHIVE_OPEN_REVISION` |
| any | nothing of it is published (a pending item is simply not published) | `<KIND>_NOT_LIVE` (409, not a problem list) |
| skill | a live requirement (`career_role_requirements`) names it: readiness is measured against it | `SKILL_REQUIRED_BY_ROLE` |
| skill | a live skill lists it as a prerequisite (a live skill never depends on a non-live one) | `SKILL_PREREQUISITE_OF_LIVE_SKILL` |
| skill | a current question is tagged to it (the readiness pool does not read `active`) | `SKILL_HAS_LIVE_QUESTIONS` |
| skill | a current lesson teaches it | `SKILL_HAS_LIVE_LESSONS` |
| base lesson | a variant of it is live | `LESSON_HAS_LIVE_VARIANTS` |
| base lesson | a current lesson lists it as a prerequisite | `LESSON_PREREQUISITE_OF_LIVE_LESSON` |

Nothing blocks archiving a question except an open revision. Archiving the last few questions of a skill can shrink
the readiness check below its selection count. The check then refuses to start, and does not serve archived items. The
screen warns about this in the confirm dialog.

The rules are pure functions in `packages/authorization/src/content-archive.ts`. They are evaluated against rows read
under the editor's usual lock (the node row for a skill, the advisory lock on the item for a question or a lesson).

## Audit, events, and what people see

- **Operators** get an **Archive…** action on a live item in each Content Management editor (skill map, question bank,
  lessons). It opens the editor's existing reason dialog. It is never offered while a revision is open. The item then
  reads `Retired` (skill) or `Archived` (question, lesson), and its history lists the `ARCHIVE` actions. No navigation item
  is added, removed, renamed or reordered (HG-3).
- **Students** see the item disappear from the next read. Nothing they already did is changed or deleted.
- **Android**: operator screens are web-only (Appendix 1 §4.3). The phone reads the same learner endpoints, so an
  archived question or lesson stops appearing there with no client change.

## Rejected alternatives (summary)

- **Deleting content.** It is never deleted: attempts, evidence and progress point at it, and 0004 forbids it.
- **A new `archived_at` column on version rows.** Every pool would have to learn it (Decision 3).
- **Archiving only the newest published revision.** An older published revision would become current for anything
  that reads "latest published" (variants).
- **Cascading archive** (archiving a skill archives its questions and lessons). One click would remove far more
  than the operator is looking at. Refusal with a list is explicit, and can be undone by not doing it.
