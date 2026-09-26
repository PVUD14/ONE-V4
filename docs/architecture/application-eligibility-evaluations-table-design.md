# Job Requirements and Application Eligibility Evaluations — Table Design

**Status:** Adopted (EMP-06), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0054_opportunity_requirements_and_eligibility.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Campus hiring runs on eligibility: minimum CGPA, backlogs, branch, graduation year. The three
version-scoped tables for it (`opportunity_eligibility_rules`, `opportunity_skill_requirements`,
`opportunity_selection_stages`, 0007) have existed since the hiring domain was built and have never
been written (EMPLOYER_BASELINE D-5). Apply checks lifecycle, deadline and consent only, so a
student far below a job's stated bar can apply and the employer has no way to know which of the
facts behind an application the institution stands behind.

EMP-06 adds the editor, an evaluator, enforcement at apply, and flags for the employer. Most of it
needs no schema. Two things do:

1. **What the employer is told about each applicant's eligibility has to be fixed at the moment
   the student applied.** A student's academic record keeps changing — terms get verified, new
   terms get declared. If the employer's view were computed live, "met the CGPA rule on a
   self-reported figure" could quietly become "met it on a verified figure" (or the reverse) and
   nobody could say what was true when the decision to apply was made. It is a person's record:
   it belongs in a row, written once.
2. **A job's skills must be able to point at the ONE skill catalogue** (EMP-06 step 6), so
   EMP-13 can later show consented evidence per required skill. Today a skill is a name; a name
   cannot be joined to evidence without inventing a mapping, which the plan forbids.

## Decision 1: a new table `application_eligibility_evaluations`

**Chosen.** One immutable row per application per evaluated job version:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `application_id` | uuid → `applications(id)` | |
| `opportunity_version_id` | uuid → `opportunity_versions(id)` | the version whose rules were evaluated |
| `trigger` | text | `APPLY` or `TERMS_ACKNOWLEDGED` |
| `evaluator_version` | text, 1–64 | the evaluator in `packages/hiring` that produced it |
| `eligible` | boolean | every blocking rule was met |
| `outcomes` | jsonb array | one entry per rule: type, comparator, value, blocking, outcome, basis |
| `flag_count` | int ≥ 0 | outcomes the employer should look at |
| `self_reported_count` | int ≥ 0 | outcomes that rest on a self-reported figure |
| `evaluated_at` | timestamptz default now() | |

Unique on `(application_id, opportunity_version_id)`. An `UPDATE` is refused by a trigger; the
row is a statement of what was true then.

**What an outcome contains, and what it does not.** Each entry says which rule, whether it was
met (`MET`, `NOT_MET`, `UNKNOWN`, or `NOT_EVALUATED` for a `CUSTOM` rule), and the *basis*:
`VERIFIED` (an institution-verified academic term), `INSTITUTION_RECORD` (the college's roster —
department, programme, expected graduation), or `SELF_REPORTED`. It deliberately does **not**
contain the student's CGPA, backlog count or any other value. The employer learns "met the
minimum CGPA of 7.0, on a self-reported figure", which is what the flag is for; the figure itself
is the student's to share through the consented snapshot (EMP-07). Minimum necessary disclosure.

**When a row is written.** At apply, when the version has any rule, in the apply transaction.
Again when an applicant accepts a new version whose eligibility changed (the rules they are now
bound to were never evaluated). A blocking failure at acknowledgement does not refuse the
acknowledgement or reject anyone — ONE never rejects automatically (§5.4); it becomes a flag and a
person decides.

**Who can read it.** The employer, only through the applicant list, only while the student's
applicant-access grant is live (EMP-SR-01) — withheld with the rest of the person otherwise. The
student reads their own eligibility live on the job page, where their own values are shown.

**Rejected: compute the employer's flags live at read time.** Simpler, no table — but the answer
would drift as the student's record changes, it would read the student's academic record on every
employer page view, and nobody could reconstruct what the student applied on.

**Rejected: a jsonb column on `applications`.** `applications` is the hot row of the pipeline and
is updated on every transition; an evaluation must never be updated. It also cannot hold the
re-evaluation at acknowledgement without overwriting the first one.

**Rejected: store the student's values in the outcome.** It would put academic figures in front
of an employer outside the consented snapshot, for a purpose the flag already serves.

## Decision 2: two nullable catalogue references

- `opportunity_skill_requirements.taxonomy_topic_id uuid → taxonomy_nodes(id)`, nullable, unique
  per version where set. A recruiter picks a skill from the catalogue: the topics the published
  career-role requirement sets name (`career_role_requirements`, OPS-08). The skill's name is
  then the topic's name, set by the server. A free-text skill stays possible and is shown as
  "not in the ONE skill catalogue"; it is never matched to a topic by name.
- `opportunity_versions.career_role_id uuid → career_roles(id)`, nullable: the catalogue role the
  job maps to (used by EMP-13). Carried forward with the version like the other requirements.

Both are additive and nullable; every 0007 constraint is kept. Nothing is backfilled — no existing
skill row is guessed onto a topic.

**Rejected: free text only, match by name later.** "Python" the job skill and "Python" the
taxonomy topic may be the same thing or not; matching them is exactly the invented mapping the
plan forbids.

**Rejected: a separate mapping table.** The reference is a property of one requirement row on
one immutable version; a side table adds a join and a way for the two to disagree.

## What is not stored

- **No eligibility rule types are added.** The eight in the 0007 CHECK are the whole vocabulary;
  `CUSTOM` is shown to students and flagged to employers, never blocking.
- **`WORK_AUTHORIZATION` cannot be blocking.** ONE records no work-authorisation fact, so a
  blocking rule would refuse every student on missing data they cannot supply. It is shown and
  flagged, like `CUSTOM`.
- **No protected attribute.** Rule types are fixed, and text values (custom rules, department and
  programme names) are refused when they name a protected attribute or an obvious proxy (gender,
  religion, caste, age, disability, marital status, region of origin, photo).
- **No normalised figure.** The CGPA fact is normalised to a 10-point equivalent at comparison
  time only (the same linear rule as `asCgpa10` in `academic-records.ts`); letter and pass/fail
  scales are unknown, never guessed; nothing converted is written back.

## Self-reported values

The frozen academic-records design (2026-09-12) said a self-reported figure never satisfies an
employer rule. The employer plan (Appendix 2 §5.4 and EMP-06 step 2), written later, says blocking
rules prefer institution-verified records and **use self-reported values where no verified value
exists, flagged to the employer**. EMP-06 follows the later plan: failing closed on every student
whose college has not yet verified anything would lock most students out of most jobs, and the
flag keeps the distinction the earlier design protected — the employer always sees which facts
the institution stands behind. Recorded as a decision for Divakar in the EMP-06 report.
