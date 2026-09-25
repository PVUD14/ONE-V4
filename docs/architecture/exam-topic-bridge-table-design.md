# Institution Exam → Readiness Topic Bridge — Table Design for Circulation

**Status:** Circulated for comment — not yet implemented
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Migration:** Core block, `0030`
**Blocks:** build-plan items 1.18 and 1.19 (the evidence bridge)
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

There are two assessment engines and one readiness loop, and no connection between them.

- **Career readiness** (migration `0004`) scores an attempt, writes one `ASSESSMENT_OUTCOME`
  row into `evidence_records` **per topic**, reprojects mastery, and recomputes the advisory band.
- **Institution assessments** (migration `0012`) run a full authoring, review, blueprint, attempt
  and result pipeline, ending in `exam_results`. **Nothing it produces reaches `evidence_records`.**

So an institution can run a whole examination programme and every student's readiness band sits
exactly where it was. Institutions will reasonably report this as broken, and until the bridge
exists they are right to.

The missing piece is not the write. It is the **mapping**: `evidence_records.topic_id` references
`taxonomy_nodes`, and an `exam_subjects` row is institution-local free text with no relationship to
that taxonomy. `exam_syllabus_nodes` exists in `0012` and is never read or written by any
controller, so it cannot be leaned on either.

## The rule that keeps this honest

**An unmapped subject contributes nothing, and says so.** The alternative — guessing a topic from a
subject name, or falling back to a default topic — would put invented evidence under a student's
readiness band, which is the one thing the readiness model may never contain. A subject with no
mapping produces no evidence and is reported as unmapped to the institution, so the gap is visible
and fixable rather than silently filled.

## Proposed table

### `exam_subject_topic_links`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `exam_subject_id` | references `exam_subjects(id)` |
| `institution_id` | denormalised, with a composite FK to `exam_subjects(id, institution_id)` — the unique index for that already exists, and it keeps a link inside one institution structurally |
| `topic_id` | references `taxonomy_nodes(id)` |
| `weight` | numeric(4,3), default 1.000 — a subject that covers two topics unevenly |
| `created_by_user_id`, `created_at` | |
| `retired_at` | nullable; a mapping is retired, never deleted, so past evidence stays explicable |

- `UNIQUE (exam_subject_id, topic_id) WHERE retired_at IS NULL`.
- A CHECK that `topic_id` refers to a node of kind `TOPIC` cannot be expressed directly; propose a
  trigger, matching how `0031` enforces its role restriction.

## How the bridge then works

On result publication, for each live link on the definition's subject:

```
demonstrated = correct_count × weight
possible     = (correct_count + wrong_count + not_attempted_count) × weight
```

written as one `ASSESSMENT_OUTCOME` evidence row per linked topic, with
`source_aggregate_type = 'exam_attempt'` and the attempt id, so the provenance of every contribution
is traceable to the paper that produced it.

Negative marking is deliberately **not** carried into evidence. `exam_results.score` can be negative
by design; `evidence_records` requires `0 ≤ demonstrated ≤ possible`, and a penalty is an assessment
policy rather than a statement about what a student has demonstrated.

Evidence is written **only for a published result**. An unpublished result is not yet the
institution's word.

## The consequence that needs a decision, not an implementation

**Existing students' bands will move.** ADR-020 requires readiness to be a published, versioned,
explainable model, so this cannot be slipped in:

- The bridge ships with a **new `readiness_model_versions` row** — `career-readiness-fundamentals`
  version 2 — and the old version is deactivated rather than edited.
- Historical snapshots are **not** recalculated. `readiness_snapshots` already carries its model
  version, and ADR-020's requirement that history is never silently recalculated applies here.
- A test must assert the model version changed, so the bridge cannot merge while still claiming to
  be version 1.
- Institutions and students need telling before it lands, not after.

## Open questions for the owners

1. **Who creates the mappings?** Proposal: institution staff with the assessment approval roles, in
   the existing exam manager, since they are the people who know what a subject covers. Operations
   cannot do it on a customer's behalf without knowing their curriculum.
2. **Is one mapping per subject enough for v1?** Proposal: allow many with weights, because a
   subject like "Aptitude" plainly covers more than one readiness topic, and retrofitting weights
   later means rewriting evidence provenance.
3. **Does an unmapped subject block publishing results?** Proposal: no. Publishing results is the
   institution's business and must not be held hostage to a readiness mapping; report the gap
   instead.
4. **Should `exam_syllabus_nodes` be the mapping point rather than `exam_subjects`?** It is finer
   grained and would give better evidence, and it is also entirely unused, so adopting it means
   building syllabus authoring first. Proposal: subject now, syllabus later if the evidence proves
   too coarse.
5. **Does a retired mapping supersede the evidence it produced?** Proposal: no. Evidence records
   what was true when it was written, and `supersedes_evidence_id` exists for genuine corrections.

## Not in scope here

Any change to how the band itself is calculated. This design adds an input; the weighting of that
input is a model decision belonging to the version bump above.
