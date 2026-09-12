# Academic Records — Table Design for Circulation

**Status:** Frozen — open questions resolved 2026-09-12; migration not yet written
**Date:** 2026-09-08 · **Frozen:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

Module acceptance 108 (Academic Records) has no implementation. There is no table anywhere holding
marks, grades, GPA or pass/fail results, and no verification workflow for them.

This is not merely a missing module. It silently disables a feature that appears to work: employers
can already attach a `MIN_CGPA` or `MAX_BACKLOGS` eligibility rule to an opportunity, and the
eligibility engine reads a CGPA fact that nothing stores. The engine fails closed, which is correct,
so every student comes back blocked or unknown against such a rule with no way to fix it.

It also weakens the product's central claim. ONE's value over a job board is that a student's record
is **verified by their institution** rather than self-declared. Academic results are the most
important thing a college can verify, and today none of it exists.

## Two constraints that shape the design

**No institution will type results for every student.** Data entry has to be cheap for the college
or it will not happen. The design therefore supports three intake paths, in order of preference:

1. **Bulk import by the institution.** The roster CSV importer already exists with preview-and-commit
   and unit resolution. Results follow that pattern: one sheet per term, not one form per student.
2. **Student declares, institution verifies.** The student does the typing; staff only confirm or
   reject. This is the same lifecycle `student_document_metadata` already uses —
   `SELF_REPORTED → PENDING_VERIFICATION → VERIFIED → REJECTED`. Reuse it rather than inventing a
   second vocabulary for the same idea.
3. **Marksheet upload backing a declaration.** The document pipeline with scanning already works; a
   verified marksheet is evidence for a declared record.

**One shape does not fit every qualification.** A BTech runs eight semesters on a 10-point CGPA. Many
state universities issue percentages. An MBBS runs in professional years, not semesters. A diploma
may be pass/fail. Postgraduate programmes differ again.

The design must not hardcode "semester" or "CGPA".

## The rule that keeps this honest

**Store the value as issued, together with the scale it was issued on. Never store a converted
number.**

A marksheet saying 8.2/10 is stored as `8.2` on scale `CGPA_10`, and displayed that way. When an
employer filters on "minimum CGPA 7", normalisation happens **at comparison time only**. Nothing
converted is ever written back.

The reason is provenance. Once a converted figure is stored, nobody can later tell whether a number
was issued by the institution or computed by us — and the whole point of the module is that the
institution stands behind it. A conversion is our inference, not their record.

Where a scale cannot be normalised, the answer is **unknown**, never a guess. The eligibility engine
already distinguishes unknown from failing and fails closed, so this needs no new behaviour.

## Proposed tables

Three tables. Names and columns are the proposal, not a decision.

### `student_qualifications`

One row per programme of study a student has undertaken, including prior education at institutions
that are not ONE customers.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `student_user_id` | references `users(id)` |
| `institution_id` | references `organizations(id)`, **nullable** — prior education elsewhere has no ONE organisation |
| `institution_name_declared` | text, used only when `institution_id` is null |
| `qualification_type` | `BTECH`, `BE`, `BSC`, `BA`, `BCOM`, `MBBS`, `BDS`, `DIPLOMA`, `MTECH`, `MBA`, `MSC`, `PHD`, `OTHER` — extend by migration, never free text |
| `programme_name` | text, e.g. "Computer Science and Engineering" |
| `started_on`, `completed_on` | date, nullable |
| `awarded` | boolean, default false |
| `verification_state` | `SELF_REPORTED` / `PENDING_VERIFICATION` / `VERIFIED` / `REJECTED` |
| `verified_by_user_id`, `verified_at` | nullable, set together |

### `student_academic_terms`

A period of study within a qualification. Deliberately not called "semester".

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `qualification_id` | references `student_qualifications(id)` |
| `sequence` | integer, 1-based ordering |
| `label` | text as the institution names it — "Semester 4", "Professional Year 2", "Part I" |
| `result_value` | numeric, nullable — the aggregate the institution issued for this period |
| `result_scale` | `CGPA_10`, `GPA_4`, `PERCENTAGE`, `LETTER`, `PASS_FAIL`, nullable with the value |
| `result_letter` | text, nullable — used when the scale is `LETTER` or `PASS_FAIL` |
| `backlog_count` | integer, nullable — supports the existing `MAX_BACKLOGS` eligibility rule |
| `source` | `STUDENT_DECLARED` / `INSTITUTION_IMPORTED` / `DOCUMENT_BACKED` |
| `evidence_document_version_id` | nullable, references `student_document_versions(id)` |
| `verification_state`, `verified_by_user_id`, `verified_at` | as above |

Constraints worth writing: a numeric value requires a scale; a `LETTER` or `PASS_FAIL` scale requires
`result_letter` and forbids `result_value`; a reviewer identity requires a review time; `sequence` is
unique within a qualification.

### `student_academic_subjects`

Optional per-subject detail. Employers do not filter on it, but students and staff want to see it and
it is what a marksheet actually contains.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `term_id` | references `student_academic_terms(id)` |
| `subject_code`, `subject_name` | text |
| `credits` | numeric, nullable |
| `grade_value` / `grade_letter` / `grade_scale` | same pairing rule as the term |

## How eligibility consumes this

`MIN_CGPA` and `MAX_BACKLOGS` resolve against the **most recent `VERIFIED` term** of the student's
active qualification. A self-reported figure never satisfies an employer's rule — that would defeat
the purpose. It may be shown to the student as their own record, clearly marked unverified.

If no verified term exists, the fact is unknown and the engine fails closed, exactly as it does now.
This means the employer-facing behaviour improves the moment institutions start verifying, with no
change to the hiring code.

## Resolutions — the five open questions, answered

Frozen 2026-09-12. The proposals above are adopted as written except where noted.

### 1. Who owns the write paths

- **Schema and the canonical read API: Core.** The migration is written by Core from the
  **cross-stream block (`0070`)**, not from a feature stream's block, because three streams write to
  these tables and none of them owns the shape.
- **Institution bulk import and verify/reject: Stream C**, in its own controllers, reusing the roster
  CSV preview-and-commit pattern rather than inventing a second import shape.
- **Student declaration: the endpoint is Core, the screens are Stream D.** Stream D owns no API
  controller, so shipping the endpoint from Core avoids a scoped ownership exception for what is
  otherwise routine work.
- **Eligibility resolution: Stream B**, inside `packages/hiring`.

### 2. A verified record survives the relationship ending

**Yes. Verification is permanent; visibility is not.**

Once an institution has verified a term it issued, that verification stands after the student
graduates, transfers or the relationship is otherwise ended. A degree does not become unverified
because the graduate stopped being a current student — that is the whole point of an institution
standing behind the record.

This is deliberately *not* the same rule as DP-010. DP-010 governs what an institution may **read**
about a student's ongoing activity, and it remains strictly relationship- and time-scoped: a former
institution still sees nothing generated after its relationship ended, including new terms at a new
institution. What survives is the **fact of the earlier verification**, carried with the student.

Concretely: `verification_state`, `verified_by_user_id` and `verified_at` are never cleared by a
relationship transition, and no relationship transition may downgrade a `VERIFIED` term. A former
institution cannot verify, re-verify or reject anything after its relationship ends.

*This one interacts with DP-010 and should be confirmed explicitly at review rather than nodded
through.*

### 3. Only the issuing institution may verify

**Adopted as proposed.** Verification is available to the institution named in `institution_id`, and
to nobody where `institution_id` is null. A second institution cannot verify a record it did not
issue, however convenient that would be for a transfer student.

### 4. `backlog_count` is per term

**Adopted as proposed.** Stored per term; the cumulative figure is derived at read time and never
persisted. This follows the same provenance rule as the result value: what is stored is what the
institution issued for that period, and anything computed across periods is our arithmetic, not
their record.

`MAX_BACKLOGS` therefore evaluates against the derived cumulative figure over verified terms — and
returns unknown, not zero, where no verified term exists.

### 5. Prior education elsewhere is accepted and marked self-reported forever

**Adopted as proposed.** A qualification with a null `institution_id` is stored with
`institution_name_declared`, stays `SELF_REPORTED` permanently, and is displayed to the student as
their own record. It never satisfies an employer's eligibility rule and is never presented as
verified. Refusing to store it would lose the student's history to protect a distinction the
`verification_state` column already makes.

### Invariant that must ship with the migration

Store the value as issued together with the scale it was issued on; **never persist a converted
number**; normalise only at comparison time; and where a scale cannot be normalised, the answer is
unknown rather than a guess. This is to be enforced by a test in the same pull request as the
migration, because it is the rule most likely to be traded away the first time an employer filter
wants a comparable figure.

## Not in scope here

Normalisation weights between scales, and how academic performance influences the readiness band, are
model decisions. Readiness is a published, versioned, explainable model; any contribution from
academic records belongs in a new model version, not in this schema.
