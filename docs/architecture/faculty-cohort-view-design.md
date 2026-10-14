# Faculty Cohort View (learning engine) — Design

**Status:** Adopted (INST-15), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** none. `learner_skill_state` (0052) already carries everything read here, with the
`(institution_id, skill_id)` index its design reserved for INST-15/17.
**Rule:** Written before the code. No new table, but the view discloses a student's adaptive-learning
profile to a member of college staff — a consent and disclosure decision, so it is written down first.
**Builds on:** `learner-skill-state-table-design.md` (ENG-05), `review-scheduler-design.md` (ENG-09),
`learning-decisions-table-design.md` (ENG-08, the STUCK rule), `engine-consent-purposes-design.md` (ENG-01),
`faculty-teaching-assignments-table-design.md` (INST-03), Appendix 3 §5.1–5.4, ADR-020, ADR-034

## Why this exists

A lecturer who teaches a section needs to know, without opening every student: which skills several of
their students are stuck on, which misconceptions are common in the class, and who has let a review
lapse. The engine already knows all three per student; this view reads them for the lecturer's own
students and nobody else's.

## What is shown

On the faculty **My Students** page, below the roster, as one section (no navigation change — HG-3):

| Block | Source | What leaves the server |
| --- | --- | --- |
| **Stuck on the same skill** | `learner_skill_state` rows where the engine's STUCK rule holds | Per skill: the skill name and the students stuck on it (name, roll number). A count of students. |
| **Most common misconceptions** | `learner_skill_state.active_misconception_codes`, one student counted once per code | Per published code: title, skill name, and the number of students holding it — **only when that number is 5 or more** (`suppressSmallCount`). Codes under 5 are not listed at all; the screen says so. |
| **Reviews due** | `learner_skill_state.review_due_at ≤ now()` (the database's clock), the scheduler's "due" rule | Per student (keyset-paginated): name, roll number, and the names of the skills due. **No date, no interval, no count of days overdue.** |

Nothing else from the row leaves the server: no `mastery_likelihood` / `mastery_uncertainty` (BKT is
shadow, HG-5), no `review_stability` / `review_difficulty` / `review_due_at` (FSRS numbers are model
state), no attempt counts, no readiness. The evidence band and stage are labels and may appear later;
this view does not need them.

### "Stuck" is the engine's rule, not one invented here

`learning-orchestrator-v1` defines STUCK as *attempts on two or more calendar days and no unaided
success*. That rule was private to the planner. It is now exported from `packages/learning-orchestrator`
(`STUCK_MIN_ATTEMPT_DAYS`, `isStuckSkillState`) and the cohort read uses those exports, so if the engine
changes its rule (a new policy version), this view changes with it. *Rejected:* a faculty-specific
threshold ("3 wrong answers") — the goal says thresholds come from the engine, and two definitions of
"stuck" would let a student be stuck on the lecturer's screen and not in their own plan.

### Misconceptions: suppressed, not named per student

A misconception is a finer-grained signal than "stuck"; listing the individual students holding each code
would turn the view into a per-student error log. The goal asks for the *most common* ones, suppressed
under 5, so the block is aggregate only: a code held by 4 students of a class of 30 is not shown, and
there is no published total from which it could be recovered (no "all misconceptions" row). Only codes
whose `misconception_codes` version is `PUBLISHED` are named; an unpublished code is not counted.

## Who may read it

- **Faculty only** (`FACULTY_LECTURER`), for their own institution. Owners, admins, heads and placement
  admins get 403: the goal is the lecturer's view of the sections they teach (INST-17 covers the cohort
  readiness view for other roles).
- **Students in the lecturer's active teaching assignments only.** The read uses the INST-02 helper's
  *write* scope (`resolveInstitutionStudentWriteScope`), which has no fallbacks: a lecturer at a college
  that has not recorded teaching assignments, or with none active, sees nobody. *Rejected:* the read
  scope — its fallback (the membership's department or batch, or the whole college for an unscoped
  lecturer) would show adaptive data about students the lecturer does not teach, and the goal's
  acceptance is "only students in assignments appear".
- **Current students only**: an `ACTIVE`/`VERIFIED` relationship in force now. A graduated or
  transferred student's live skill state is not "before effective_to" data, so it is not shown at all.
- **Rows attributed to this institution only**: `learner_skill_state.institution_id` must equal the
  college. A student who transferred in keeps their previous college's history off this screen until they
  practise here.

## Consent: fails closed

The view shows a student's data **only while they hold `adaptive-learning`**, checked in the same SQL
statement that reads the rows, with the same rule as `hasConsentPurpose` (the latest recorded action for
the live definition's version is `GRANTED`). The rule now lives in one place:
`consentPurposeHeldSql` in `packages/persistence/src/consent-purposes.ts`, which `hasConsentPurpose`
itself uses.

- **Until HG-6 publishes the definition, nobody holds it**, so every block is empty and the screen
  says why ("Students have not yet been asked for adaptive learning consent, so there is no learning data
  to show — NA"). The response carries `consent: { offered: false }` so the screen can say it plainly.
- A withdrawal takes effect on the next request (no cache), and the projector deletes the rows anyway.
- The count of students in scope who hold the consent is shown **suppressed under 5**, because it is a
  count of people making a private choice.

**Disclosure.** The draft consent notice (`docs/legal/engine-consent-notice-DRAFT-for-legal-review.md`)
did not say that a lecturer sees this. A sentence is added to the draft for legal review; the view
remains unreachable in practice until HG-6 publishes the wording with it.

## Audit

Every read that returns per-student learning data writes one `audit_events` row in the same request:
`institution.learning_cohort.read` (the summary) or `institution.learning_cohort.due_reviews_listed`
(a page of the due list), resource the institution, context: which block, how many students were
returned, their user ids (at most 200 per page by construction), and the page. A 403 writes nothing
(no data read), matching the other institution reads.

## Actions (INST-16)

Each stuck skill and each due student links to an action. INST-16 (practice sets, group sessions, plan
overrides) is not built, so the links go to the lecturer's existing actions: **Assigned Tasks** (assign
a task to the student) and, for a student, **Student Detail**. INST-16 replaces them with its own.

## Android

The institution home already shows "My students" to a lecturer. It gains the same three blocks,
read-only, from the same endpoints: suppressed misconceptions, stuck skills, and the first page of due
students. Nothing new is written from the phone.

## Readiness

Nothing here reads or writes readiness, and no number about a student's learning leaves the server —
counts of students only, with small counts suppressed where the goal asks.

## Open points (decisions for Divakar)

1. **Faculty see names on "stuck" and "due", aggregates only on misconceptions.** Recommended as above.
2. **Faculty only.** Department heads get the cohort readiness view in INST-17; a head-level learning
   view could reuse this read with the head's department scope. Not built.
3. **The consent notice must tell students their lecturers see this** — proposed sentence added to the
   draft for legal review (HG-6).
