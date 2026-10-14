# Recalibration Runs — Table Design

**Status:** Adopted (ENG-26), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-08
**Migration:** `0115_recalibration_runs.sql` (`recalibration_runs`, `recalibration_decisions`)
**Rule:** Written before the migration, per the migrations rule in `CLAUDE.md` and D.2 of the program
**Builds on:** `item-calibrations-table-design.md` (ENG-13, 0062), `mastery-bkt-shadow-design.md` (ENG-06),
ADR-034 (TypeScript online, Python offline), ADR-020 (readiness is a band)
**Supersedes in part:** ENG-13's weekly, automatically imported calibration run (see "Adoption")

## Why this exists

ENG-26 adds two monthly offline jobs: a **recalibration** of the 2PL item parameters the placement test
reads, and a **refit** of per-skill BKT parameters, which until now are one cited, provisional set for every
skill. Both are fitted from consenting learners' attempts. Neither may change what a student meets just by
being computed: a refit is compared with the parameters it would replace, the comparison is stored, and
nothing is adopted until Divakar reads it and accepts it. These two tables are that record.

Running the jobs on pilot data is Divakar's step on the production side; the agent builds and tests them on
synthetic data only (`docs/ops/runbook-monthly-recalibration.md`).

## The pipeline

```
attempt log ──export (TS)──▶ export.json + baseline.json ──fit + compare (Python)──▶ proposal.json
                                                                                         │
                                         record (TS): recalibration_runs, PENDING ◀──────┘
                                                                │
                                 Divakar: report → accept | reject (TS): recalibration_decisions
                                                                │ accept, items only
                                                                ▼
                                       item_calibrations (ENG-13's importer, unchanged guards)
```

- **Export** — items: ENG-13's `exportCalibrationAttempts`, unchanged (model-improvement consent, per-run
  salted pseudonyms, first unaided response per item version, question banks only). BKT: for the same
  consenting learners, each learner's ordered BKT observations per skill, computed by the one rule the
  projector uses (`masteryObservationsBySkill`, ENG-06: answered, unaided attempts). A BKT export row is
  `[skill id, "0110…"]` and **carries no learner key at all** — the fit treats sequences independently, so
  nothing links two sequences to one person; rows are sorted, so order carries nothing either.
- **Baseline** — the parameters the refit would replace, with a digest (below). Items: every item's live
  calibration, exactly as `latestItemCalibrations` chooses it (latest `CALIBRATED`, else latest
  `PROVISIONAL`). BKT: the FITTED skills of the last accepted, unreverted BKT run; none means every skill
  is on the provisional defaults.
- **Fit + compare** — `python -m calibration recalibrate` (ENG-13's `item-calibration-2pl-v1` fit, reused
  as is) or `python -m calibration bkt-refit` (`bkt-fit-mle-v1`, below), then the comparison. Output: one
  proposal file — results + comparison report.
- **Record** — the TypeScript side validates the proposal strictly (unknown fields are refused, so nothing
  per-learner can ride along) and stores it as a PENDING run.

## BKT fit: `bkt-fit-mle-v1`

Maximum likelihood of mastery-bkt's model (four parameters, no forgetting) over every sequence of the
skill, by the forward algorithm, from four fixed starting points; standard errors from the observed
information (numerical Hessian, delta method back to probabilities). Deterministic. Per skill, in order:

1. fewer than `min_learners` sequences (default **100**) → `DEFAULT` / `TOO_FEW_LEARNERS`;
2. every observation correct, or every one wrong → `DEFAULT` / `NO_VARIANCE`;
3. the fit, rounded to four decimals, fails any of mastery-bkt's five admissibility conditions →
   `DEFAULT` / `NOT_ADMISSIBLE` (the same rule `validateParameters` enforces, so an accepted set can always
   be loaded);
4. the information is not positive definite, or any standard error exceeds **0.1** →
   `DEFAULT` / `IMPRECISE` (a 95% interval wider than ±0.2 cannot be compared month to month);
5. otherwise `FITTED`.

`DEFAULT` means the skill keeps the provisional defaults. *Rejected:* expectation–maximisation
(Baum–Welch) — the same optimum, but no standard errors without a second pass; *rejected:* pyBKT — a
dependency for a 40-line likelihood, with stochastic restarts by default.

## Stability bounds and drift

For every parameter compared:

    drifted  ⇔  |proposed − previous| > max(practical floor, z · √(SE_previous² + SE_proposed²))

A change is called drift only when it is **both** larger than sampling noise could make it **and** large
enough to matter in use. Small samples therefore tolerate large wobbles (they cannot tell), and large samples
flag only material changes (anything they can tell but that does not matter is not drift).

| Kind | Parameter | Floor | z | Why the floor |
| --- | --- | --- | --- | --- |
| Item 2PL | difficulty `b` | 0.30 logits | 3.5 | moves an average learner's P(correct) by ≤ 7.5 points at `a = 1` |
| Item 2PL | discrimination `a` | ln 1.25 on the log ratio | 3.5 | a 25% change in slope (≈ 56% in peak information) |
| BKT | each of P(L0), P(T), P(G), P(S) | 0.05 | 3.0 | five points on a probability BKT multiplies through every update |

**Standard errors.** Item: from the 2PL's expected Fisher information at the fitted `(a, b)` for the
item's `responses_used`, under the standard-normal ability the MML fit assumes (61-node Gauss–Hermite). It
treats ability as known, so it runs small; measured over 400 independent synthetic refits the standardised
change had sd 1.14 for `b` and 1.27 for `log a` — hence `z = 3.5` (≈ 3 on the true scale). BKT: from the
fit's own observed information; measured over 99 independent refit pairs the standardised change had sd
0.94–1.04, so `z = 3`. On those null studies (same truth, independent learners — harsher than real months,
which share most of the cumulative attempt log), **0 of 400** item comparisons and **0 of 99** skill
comparisons were flagged; at `z = 3` the items would have flagged 10 of 400, which is why the item `z` was
raised.

**What a report says per item / skill** (`change`): `STABLE`, `DRIFTED` (with which parameters, by how
much, against which tolerance), `NEW` (calibrated / fitted, nothing before), `NEWLY_CALIBRATED` (item was
provisional, now calibrated), `LOST_CALIBRATION` (was calibrated / fitted, this fit is not — live keeps the
old one, because the reader prefers `CALIBRATED`), `NOT_REFITTED` (live, but absent from this month's data),
`NOT_CALIBRATED` (provisional / default before and after). Run **verdict**: `DRIFTED` if anything drifted,
else `STABLE` if anything was compared, else `NO_COMPARISON` (first run, or nothing comparable).

*Rejected:* a fixed tolerance alone — at pilot volumes it would flag noise every month, at scale it would
miss nothing but flag everything; *rejected:* a significance test alone — at scale every trivial change is
"significant"; *rejected:* bootstrap standard errors — 50+ refits of the whole bank monthly on the shared
host, for errors the information already gives (BKT) or that one constant corrects (items).

## Adoption — the recorded, reviewable step

- **Items.** ENG-13 imported every weekly fit straight into `item_calibrations`, so a refit changed the
  placement test without anyone looking. From ENG-26 that path is **retired**: the weekly
  `planthepath-calibration` units and `run-calibration.sh` are removed (never installed anywhere), and
  `planthepath-recalibration.timer` runs monthly and only *proposes*. **Accept** imports the proposal's
  results through ENG-13's `importCalibrationResults` — the same validation, `min_responses` trigger,
  bounds CHECKs, append-only rows and PROVISIONAL/CALIBRATED rule — inside the decision's transaction, with
  the item run id equal to the recalibration run id. **Reject** records the decision and imports nothing.
- **BKT.** Accept only *records* the fit as the accepted BKT parameters (`acceptedBktParameters`, for
  ENG-27). The projector still passes no fitted parameters; switching BKT on for students is ENG-27 / HG-5.
  Nothing a BKT accept does reaches mastery, readiness or any screen.
- **Stale proposals are refused.** The baseline digest is sha256 over the live state the comparison was made
  against (items: every item's live `item key | run id | status`; BKT: the accepted run id or `none`). Accept
  recomputes it; if anything was imported or accepted since, the proposal compares against the wrong thing
  and must be re-run.
- **One decision per run**; decisions are serialised by an advisory lock.
- **Revert** (rollback) of an accepted item run writes a new item run whose rows copy each affected item's
  parameters as they were live before the reverted run (a new run, because both tables are append-only),
  only while the reverted run is still the latest imported. An item the reverted run calibrated for the first
  time cannot be un-calibrated (a newer provisional row never overrides a calibration — ENG-13's rule); the
  report lists those as `NEW` / `NEWLY_CALIBRATED`, and if one is wrong the remedy is the 0062 runbook's:
  archive the question. Reverting a BKT run only records it; the previous accepted run becomes current again.

*Rejected:* auto-accept when the verdict is `STABLE` — a stable verdict still changes live parameters
(within noise), and "recorded and reviewable" was the requirement; one command a month is cheap.
*Rejected:* keeping ENG-13's weekly auto-import beside the gate — the gate would mean nothing.

## The tables

### `recalibration_runs` (append-only)

| Column | Notes |
| --- | --- |
| `id` | uuid PK — the run id from the export, carried through fit and record (items: also the `item_calibration_runs.id` on accept). |
| `kind` | `ITEM_2PL` \| `BKT`. |
| `source` | CHECK `= 'jobs/calibration'`. |
| `algorithm_id` | `item-calibration-2pl-v1` with `ITEM_2PL`, `bkt-fit-mle-v1` with `BKT` (CHECK pairs them). |
| `library` | 1–200 chars, the pinned stack. |
| `threshold` | ≥ 1 — `min_responses` (items) or `min_learners` (BKT). |
| `units_read`, `observations_read` | ≥ 0 — items or skills; responses or observations. |
| `units_compared`, `units_drifted` | ≥ 0, drifted ≤ compared. |
| `verdict` | `STABLE` \| `DRIFTED` \| `NO_COMPARISON`, CHECKed against the two counts. |
| `baseline_digest` | 64 hex. |
| `previous_run_id` | uuid NULL — informational: the latest imported item run, or the accepted BKT run compared against. No FK (it names a row in either table). |
| `results`, `report` | jsonb objects — the validated fit results and comparison report. Parameters and counts only. |
| `exported_at`, `generated_at`, `recorded_at` | timestamptz. |

### `recalibration_decisions` (append-only)

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `run_id` | uuid → `recalibration_runs(id)`. |
| `decision` | `ACCEPTED` \| `REJECTED` \| `REVERTED`. UNIQUE (`run_id`, `decision`); a trigger allows `REVERTED` only after `ACCEPTED`, and `ACCEPTED`/`REJECTED` only when the run has neither. |
| `reason` | text 1–500, required — why. |
| `item_run_id` | uuid NULL → `item_calibration_runs(id)`: the item run an `ACCEPTED` item decision imported or a `REVERTED` one wrote; NULL for BKT and rejections. |
| `decided_at` | timestamptz DEFAULT now(). |

No user id: the decision is taken on the host by the operator running the command (Divakar), and the
command is on no route. Neither table holds personal data — no learner, pseudonym, user, institution,
response or timestamp of a person — so there is no privacy-deletion exception and nothing to export.

## Readiness and students

Nothing here reads or writes readiness, evidence or mastery projections. No route, screen or client (web or
Android) reads either table. Parameters are model state about items and skills, never a score. No model or
LLM is called; the fits are statistics. The engine-health calibration panel's cadence moves from weekly to
monthly (expected 31 days, overdue after 38: a month plus a week for review), because an import now
happens only on an accept.

## Open points (decisions for Divakar)

1. **Gate on item recalibration** (this note's main decision). Recommended and adopted: monthly, propose →
   accept. The alternative is to keep ENG-13's weekly auto-import and use ENG-26 only as an audit.
2. **Bounds.** Recommended and adopted as above; revisit after three real months of reports.
3. **`min_learners = 100`** for a BKT fit. Recommended; raise it when volumes allow.
