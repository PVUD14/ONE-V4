# BKT Mastery in Shadow — Design

**Status:** Adopted (ENG-06), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** none. `learner_skill_state` (0052, ENG-05) already carries `mastery_likelihood`,
`mastery_uncertainty` and `mastery_algorithm_version`, guarded by a CHECK that a number never appears
without the algorithm that produced it. This goal fills those columns through the existing projector.
**Rule:** Written before the code, per D.2 of the program ("table design first for any table change"). No
column, constraint or trigger changes; the projection's *rule* changes, so its algorithm ID changes.
**Builds on:** ADR-034 (pure, versioned algorithm packages; projections rebuildable; BKT is shadow until
HG-5), ADR-033 (no model in the loop), ADR-020 (readiness is a band), `learner-skill-state-table-design.md`
(ENG-05), `evidence-stages-table-design.md` (ENG-04, whose open point 1 waits for this report)

## Why this exists

Readiness today is banded from `career-readiness-mastery-v1`: a topic's band is the ratio of successful
evidence items, with two items (of any kind, on any day) enough to band. ENG-04 showed that rule claims
bands from one attempt or same-day attempts (C3), and the master plan's replacement is Bayesian Knowledge
Tracing. Replacing it for real students is hard gate HG-5 (ENG-27). Before anyone can decide that, we
need to know *what would change*: how many students' topic bands would move, in which direction, and
whether BKT's predictions are any good on our data. That is what "shadow" means here: BKT runs beside
v1 on the same facts, its output is stored only as model state, and a report compares the two.

**Shadow means, concretely:**
- BKT writes only `learner_skill_state.mastery_*`. It never writes `readiness_snapshots`,
  `readiness_factors`, `mastery_projections` or evidence, and the readiness path never reads it.
- No route, screen (web or Android), export or event carries a BKT value or a BKT band. The only
  reader is the offline report command below, which prints counts.
- Nothing is shown as a number. `mastery_likelihood` is model state (ADR-034's data rule).

## The package: `packages/mastery-bkt`, algorithm `mastery-bkt-v1`

Pure, deterministic, no dependencies, no clock, no randomness. It knows nothing about attempts,
hints or days — it takes an ordered list of binary observations and parameters. Deciding which
attempts are observations is the learning model's job (below), so the C5 rule lives in one place.

### The model

Standard four-parameter BKT (Corbett & Anderson, 1995): a skill is either known or not; `P(L0)` is
the probability it is known before any opportunity, `P(T)` the probability of learning it at each
opportunity, `P(G)` of answering correctly without knowing it, `P(S)` of answering wrongly despite
knowing it. No forgetting. For each observation, in order (the recursion as written by Baker, Corbett
& Aleven, 2008, and Van de Sande, 2013, eqs. 8–10):

    predicted P(correct) = P(L)(1 − S) + (1 − P(L))G                        (recorded for the report)
    evidence:  P(L | correct) = P(L)(1 − S) / [P(L)(1 − S) + (1 − P(L))G]
               P(L | wrong)   = P(L)S / [P(L)S + (1 − P(L))(1 − G)]
    learning:  P(L') = P(L | obs) + (1 − P(L | obs))T

The stored `mastery_likelihood` is `P(L)` after the last observation's learning step — the standard
knowledge-tracing `P(Ln)`, which is also the state the next prediction is made from. A skill row with no
observations (an attempt count of zero, or only assisted attempts) stores NULL, not `P(L0)`: nothing about
the student has been observed, and a prior is not a measurement of them.

### Default parameters (provisional)

| Parameter | Value | Source |
| --- | --- | --- |
| `P(L0)` | 0.36 | Van de Sande (2013), Fig. 3 |
| `P(T)` | 0.10 | Van de Sande (2013), Fig. 3 |
| `P(G)` | 0.30 | Van de Sande (2013), Fig. 3; equal to the guess ceiling of Corbett & Anderson (1995) |
| `P(S)` | 0.05 | Van de Sande (2013), Fig. 3; under the slip ceiling of 0.10 of Corbett & Anderson (1995) |

**They are provisional and marked so in code** (`source: 'DEFAULT_PROVISIONAL'`). They are a published,
worked BKT parameter set that satisfies every admissibility condition below; they are not fitted to ONE's
students or items. Fitting per skill is ENG-26's job (offline, ADR-034 §5), and until a fit exists every
skill uses these.

**Admissibility, enforced on every parameter set (defaults and future fits alike):**
1. Each parameter strictly between 0 and 1.
2. `G + S < 1` — otherwise a correct answer *lowers* mastery ("empirically degenerate", Baker et al.
   2008; Van de Sande 2013, eq. 15).
3. `G < 0.5` and `S < 0.5` — Baker et al. (2008)'s bound, as cited by Van de Sande (2013).
4. `T < 1 − S / (1 − G)` — keeps every estimate inside [0, 1] for any history (Van de Sande 2013, eq. 16).
5. `L0 > (1 − G)T / (1 − G − S)` — the prior lies above the stable fixed point of a run of wrong answers
   (Van de Sande 2013, eq. 14). Consequence: from the prior, the wrong-answer map can never take `P(L)`
   below that fixed point, so **every wrong answer lowers mastery and every correct answer raises it, on
   every history the model can reach**. With the defaults the fixed point is 0.108 and `P(L0)` is 0.36.

*Rejected: the hmm-scalable defaults* (Yudelson, Koedinger & Gordon, 2013's tool: `P(L0)=0.5`, `P(T)=0.4`,
`P(G)=0.2`, `P(S)=0.2`). They are EM starting points rather than an operating model, and with them the
wrong-answer fixed point is 0.533 — above the prior — so a student's *first wrong answer would raise*
their mastery (0.50 → 0.52). The goal's acceptance ("falls on wrong") and plain sense both forbid that.
*Rejected: inventing "reasonable" round numbers* — the brief requires documented, cited parameters.

### Uncertainty

`mastery_uncertainty` is the binary entropy of `P(L)` in bits: 1 at 0.5, 0 at 0 or 1. It says how
undecided the model is between "known" and "not known". It is **not** parameter uncertainty — BKT with
fixed parameters has none to report; a refit (ENG-26) may add a different measure under a new ID.
*Rejected:* `sqrt(p(1 − p))` — the same information on a 0–0.5 scale, easier to misread as a standard
error of something.

### Per-skill parameters

`resolveParameters(skillId, fitted)` returns a fitted set for the skill if one is supplied, else the
defaults. A fitted set must carry `source: 'FITTED'` and the fit run's id; it is validated like the
defaults. **No fitted sets exist and nothing supplies them in this goal** — the projector passes none.
When ENG-26 adds them, the stamped version records which fit produced a value: `mastery-bkt-v1` for the
defaults, `mastery-bkt-v1+fit:<run id>` for a fitted set (≤ 64 characters, the column's CHECK), so a stored
number always names exactly what produced it.

### Precision

`numeric(5,4)` holds four decimals. The package rounds the stored likelihood and uncertainty to four
decimals (half away from zero) itself, so the value a rebuild computes is byte-identical to the stored
one. Strict rises and falls are properties of the unrounded trace; after rounding, a change smaller than
0.00005 (near 1, or near the fixed point) reads as equal.

## Which attempts are observations (learning model, `learner-skill-state-v2`)

`packages/learning-model` decides, and the projector and the report share the one function:

- **Answered, unaided attempts on the skill**, in the projection's total order (`occurred_at`, then id).
  Exam items count on every topic mapped at the time (ENG-05's rule), because that is the attempt set the
  row's stage is computed from.
- **Blanks are not observations** — a blank is not an attempt at the skill (ENG-05).
- **Assisted attempts are not observations, correct or wrong** — neither the evidence step nor the
  learning step runs. C5 says an assisted success never counts; skipping only assisted *successes* would
  let help bias the estimate downward (failures with help count, successes with help do not), so both are
  skipped. *Rejected:* applying the learning step for an assisted attempt ("they were taught") — mastery
  would then rise on help alone, which is C5 in another form. No attempt is assisted today (no hints exist
  until ENG-15), so this changes no current value.

Adding the mastery columns is a change to the projection's rule, so the projector's ID moves from
`learner-skill-state-v1` to **`learner-skill-state-v2`** (ADR-034 §2: a new ID, never an edited one).
v2 = v1's stage, count, band and misconception rules unchanged + `mastery-bkt-v1` over the observations
above. Rows written under v1 carry NULL mastery and are replaced on the student's next projection or by
the rebuild command (`engine:rebuild-skill-state`); until HG-6 publishes the consent definitions no real
student has rows at all.

## The shadow report (ENG-04's "shadow report")

**Where it lives: an offline command**, `corepack pnpm --filter @planthepath/persistence
engine:bkt-shadow-report`, printing one JSON document. *Rejected: an Operations read under an existing
label* — it would put BKT-derived figures behind an HTTP route, which the "no model state on a route"
reading of ADR-034 and the goal's "offline command" both argue against, and it would need a new screen
section for no decision that cannot be made from the command's output. No navigation changes either way.

**Whose data:** only students who hold `adaptive-learning` when the report runs (checked with
`hasConsentPurpose`, fail-closed) and have `learner_skill_state` rows. Nobody else's attempts are read.
Live bands come from each consenting student's latest `mastery_projections` row per topic.

**What it compares**, per (student, topic) pair that has both a live band and an engine row:

1. **C3 adoption** — `learning-model-v1`'s `evidence_band` (already on the row) against the live v1 band.
   This is exactly the number ENG-04's open point 1 asked for.
2. **BKT** — the band BKT *would* give against the live v1 band. The BKT band is computed in the report,
   never stored: `NOT_ENOUGH_EVIDENCE` while the row has fewer than two attempt days (C3 applies to BKT
   too), otherwise `DEMONSTRATED` at `P(L) ≥ 0.95` (the Cognitive Tutor mastery criterion, Corbett &
   Anderson 1995), `PROGRESSING` at `P(L) ≥ 0.5` (more likely known than not), else `DEVELOPING`. These
   two cut-offs are provisional, like the parameters; they exist only so a band-to-band comparison is
   possible, and HG-5 decides any real mapping.

For each comparison: pairs compared, unchanged, changed, moved up, moved down, distinct students with at
least one change, and the from→to matrix. **Predicted vs actual next attempt:** every observation after a
skill's first produces a prediction made before it was seen; the report gives the count, Brier score,
accuracy at 0.5, and calibration in five equal-width bins (predictions, observed correct). Coverage:
live pairs with no engine row (not consented, or no attempts), engine rows with no live band, and engine
rows still on `learner-skill-state-v1` (rebuild needed).

**Disclosure control.** Counts only; no user id, topic id, institution id, name or timestamp appears.
Every count from 1 to 4 prints as `"<5"`. Brier score, accuracy and bin rates are printed only when the
predictions come from at least five distinct students and at least five predictions (per bin for the bin
rate); otherwise `"suppressed"`. If fewer than five consenting students are in scope, the whole report is
suppressed except its algorithm and parameter header.

## Readiness

Unchanged. Nothing here reads or writes readiness; `career-readiness-mastery-v1` stays the live rule. The
report is an input to Divakar's HG-5 / ENG-04 decision, not a decision.

## Sources

- Corbett, A. T., & Anderson, J. R. (1995). Knowledge tracing: Modeling the acquisition of procedural
  knowledge. *User Modeling and User-Adapted Interaction*, 4(4), 253–278.
- Baker, R. S. J. d., Corbett, A. T., & Aleven, V. (2008). More accurate student modeling through
  contextual estimation of slip and guess probabilities in Bayesian Knowledge Tracing. *ITS 2008*, LNCS
  5091, 406–415.
- Van de Sande, B. (2013). Properties of the Bayesian Knowledge Tracing model. *Journal of Educational
  Data Mining*, 5(2), 1–10. (Eqs. 8–16 and Fig. 3.)
- Yudelson, M. V., Koedinger, K. R., & Gordon, G. J. (2013). Individualized Bayesian Knowledge Tracing
  models. *AIED 2013*; tool defaults from github.com/myudelson/hmm-scalable (rejected above).

## Open points (decisions for Divakar)

1. **Parameters.** Recommended: keep the cited defaults, provisional, until ENG-26 fits per-skill
   parameters from consenting students' de-identified attempts.
2. **BKT band cut-offs (0.95 / 0.5).** Recommended: use them for the shadow report only; HG-5 decides any
   mapping students would see.
3. **Adopting C3 or BKT in the live band.** Not taken here. Recommended: run the report once real
   consenting students exist, and decide ENG-04 open point 1 and HG-5 from its counts.
