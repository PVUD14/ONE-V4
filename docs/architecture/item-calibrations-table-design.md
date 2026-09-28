# Item Calibrations — Table Design

**Status:** Adopted (ENG-13), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0062_item_calibrations.sql` (`item_calibration_runs` and `item_calibrations`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (TypeScript online, Python offline — Proposed, followed here), ADR-035 (migrations
apply once), ADR-020 (readiness is a band), `learning-attempt-events-table-design.md` (ENG-03),
`engine-consent-purposes-design.md` (ENG-01)

## Why this exists

The placement test (ENG-14) chooses the next question by how hard it is and how sharply it separates
students who know a skill from those who do not. Those two numbers are the item's **difficulty** and
**discrimination** under a two-parameter logistic item-response model (2PL):

    P(correct | ability θ) = 1 / (1 + exp(−a · (θ − b)))      a = discrimination, b = difficulty

They are not authored; they are *fitted* from many students' answers. Fitting is periodic statistics over
the whole attempt log, which ADR-034 places offline in Python (`jobs/calibration`), started by a timer,
never called by the API. This document designs the two tables the job's output lands in, the
de-identified export it reads, and how online code reads the result.

**Calibrations are model state.** They describe items, not people. They are never shown to a student
as a number, never shown to an employer, never an input to readiness, and never a readiness value. No
screen reads them in this goal; ENG-14 reads them only to choose which item to ask next.

## The pipeline

```
learning_attempt_events ──(1) export, TypeScript──▶ export.json  (de-identified, consented only)
                                                        │
                                          (2) fit, Python (girth 2PL MML)
                                                        ▼
item_calibrations ◀──(3) import, TypeScript── results.json  (item parameters only)
```

1. **Export** — `corepack pnpm --filter @planthepath/persistence engine:calibration-export --out <file>`.
   Reads `learning_attempt_events` for students who hold the live `model-improvement` purpose (ENG-01;
   same rule as `hasConsentPurpose`, applied set-wise in SQL). Writes a new run id and, per response, only
   `[pseudonym, item key, correct]` — see "De-identification".
2. **Fit** — `python -m calibration fit --in <export> --out <results>`. Pure computation over the
   file: no database driver, no credentials, no network. Writes one row per item.
3. **Import** — `engine:calibration-import --in <results>`. Validates the file strictly and writes the
   run and its rows in **one transaction**.

`deploy/scripts/run-calibration.sh` chains the three in a private temporary directory that is removed on
exit, and `deploy/systemd/planthepath-calibration.{service,timer}` runs it weekly. The unit files are
written in the repository only; installing them on a server is Divakar's manual step.

*Rejected:* **Python connects to PostgreSQL** (psycopg) and reads/writes the tables itself. It would put
database credentials and identified rows inside the Python process, and the consent filter,
de-identification and write validation would live in an untested-by-CI second language. With a file
hand-off, everything that touches the database is TypeScript under the existing integration suites, and
the Python process can only ever see pseudonyms.
*Rejected:* **the API or worker spawns Python.** ADR-034 rejects it: a Python service in the request path.
*Rejected:* **an outbox job per calibration run.** Calibration is a whole-table batch, not a reaction to
an event; the timer is the established pattern (privacy sweep, jobs alert check).

## De-identification

The export carries, per response, exactly three values:

| Value | What it is |
| --- | --- |
| pseudonym | `L1`, `L2`, … — a per-run number. Learners are ranked by `sha256(salt ‖ user id)` where `salt` is 32 random bytes generated for the run in Node, passed as a query parameter and **never stored or printed**. Numbers therefore carry no order of user id, and the same person gets unrelated numbers in different runs, so runs cannot be joined to each other or back to a person. |
| item key | `item_source:item_id:item_version` — identifies content, not people. |
| correct | `1` or `0`. |

Nothing else leaves the database: no user id, email, name, institution, session, skill, time, hint level
or score. The file header holds only the run id, the format tag and the database's export time.

**Which responses:**

- only students whose latest consent action on the **live** `model-improvement` definition is `GRANTED`.
  Until HG-6 publishes the engine purposes there is no live definition, so the export is empty — the
  pipeline fails closed and every run fits nothing;
- `assisted = false` only. A response given after substantial help says little about the item's own
  difficulty and would make it look easier;
- the **first** response of each learner to each item version (by `occurred_at`, then `id`). IRT assumes
  one independent response per learner and item; repeats of a reviewed item are practice, not new
  information about the item;
- unanswered items on a submitted paper count as incorrect (`correct = false` already); the student saw
  the item and did not answer it.

*Rejected:* **a stable pseudonym** (for example a hash of the user id without a per-run salt). It would let
anyone holding two exports link a learner's history across runs, which the calibration does not need.
*Rejected:* **pseudonymising in Node after reading user ids.** Ranking in SQL means identified rows never
leave the database process.

The export file is still per-learner response patterns, so it is handled as personal data: written with
mode `0600` into the unit's private temporary directory and deleted when the run ends. It never leaves
the host.

## The tables

### `item_calibration_runs`

One row per imported run — the provenance every calibration row points to.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key. The **run id**, created by the export and carried through the fit to the import, so the three steps are one run. |
| `source` | text NOT NULL, CHECK `= 'jobs/calibration'`. What produced the rows. |
| `algorithm_id` | text NOT NULL, CHECK `= 'item-calibration-2pl-v1'`. The generator version; a change in method is a new ID and a widened CHECK, never an edited one. |
| `library` | text NOT NULL, 1–200 chars. The pinned fitting stack as the job reports it, e.g. `girth==0.8.0 numpy==2.4.6 scipy==1.17.1`. |
| `min_responses` | integer NOT NULL, CHECK ≥ 1. The CALIBRATED threshold this run used. |
| `learners_read`, `responses_read`, `items_read` | integer NOT NULL, CHECK ≥ 0. Counts only. |
| `exported_at` | timestamptz NOT NULL. The database's `now()` at export. |
| `generated_at` | timestamptz NOT NULL. When the fit finished (the job's clock; informational). |
| `recorded_at` | timestamptz NOT NULL DEFAULT `now()`. |

### `item_calibrations`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key. |
| `run_id` | uuid NOT NULL → `item_calibration_runs(id)`. |
| `item_source`, `item_id`, `item_version` | The same item identity as `learning_attempt_events` (same CHECK on `item_source`; `item_version > 0`). No foreign key on `item_id`, for the reason the attempt log gives (two banks). The import rejects an item that does not appear in the attempt log. |
| `model` | text NOT NULL, CHECK `= '2PL'`. |
| `difficulty` | numeric(6,4) NOT NULL, CHECK −4 ≤ b ≤ 4. |
| `discrimination` | numeric(6,4) NOT NULL, CHECK 0.2 ≤ a ≤ 4. |
| `responses_used` | integer NOT NULL, CHECK ≥ 0. Responses to this item in the run. |
| `status` | text NOT NULL, CHECK in (`PROVISIONAL`, `CALIBRATED`). |
| `status_reason` | text NULL. NULL exactly when `CALIBRATED`; otherwise one of `TOO_FEW_RESPONSES`, `NO_VARIANCE`, `TOO_FEW_ITEMS`, `ESTIMATE_OUT_OF_RANGE`. |
| `recorded_at` | timestamptz NOT NULL DEFAULT `now()`. |

Constraints and indexes:

- `UNIQUE (run_id, item_source, item_id, item_version)` — one row per item per run.
- `(item_source, item_id, item_version, recorded_at DESC)` for "latest calibration of these items".
- A `BEFORE INSERT` trigger rejects a `CALIBRATED` row whose `responses_used` is below its run's
  `min_responses`. **Items with too few responses stay PROVISIONAL at the data layer**, not only in the
  job.
- Both tables are **append-only**: a trigger rejects every `UPDATE` and `DELETE`. A new run adds rows; it
  never rewrites an old one. There is no privacy-deletion exception because there is nothing personal in
  either table (ADR-034: aggregates are not rewritten retroactively; the next run simply no longer sees a
  deleted or withdrawn student).

**Why the bounds.** An item everyone answers correctly has a fitted difficulty heading to −∞; a flawed item
can fit a negative discrimination. Neither is usable for item selection. Every stored row is inside the
range online code can use; a fit outside it is stored as `PROVISIONAL` / `ESTIMATE_OUT_OF_RANGE` with the
provisional values below, and is visible to an operator as such.

### What a PROVISIONAL row holds

A usable, conservative starting point, so ENG-14 can still select an item nobody has calibrated yet:
discrimination `1.0`, and difficulty `−logit((k + 1) / (n + 2))` clamped to [−4, 4], where `n` is the
item's responses in the run and `k` the correct ones — the difficulty at which an average student
(θ = 0) would have the smoothed observed success rate. With no responses it is `0`. It is labelled
PROVISIONAL precisely because it is a prior, not a fit.

### Status rule (`item-calibration-2pl-v1`)

In order, for each item in the export:

1. fewer than `min_responses` responses (default **200**) → `PROVISIONAL` / `TOO_FEW_RESPONSES`;
2. all responses correct, or all incorrect → `PROVISIONAL` / `NO_VARIANCE`;
3. fewer than **3** items pass 1–2 in the run → those items `PROVISIONAL` / `TOO_FEW_ITEMS` (a 2PL fit
   of one or two items is not identified);
4. otherwise the item enters one joint 2PL fit (girth `twopl_mml`, marginal maximum likelihood with a
   standard-normal ability distribution, missing responses tagged as missing); a non-finite or
   out-of-range estimate → `PROVISIONAL` / `ESTIMATE_OUT_OF_RANGE`; else `CALIBRATED`.

200 is the commonly cited lower bound for stable 2PL item estimates; below it the standard errors of `a`
are too wide to trust. It is a run parameter, recorded on the run, so it can be raised without a new
algorithm ID.

## Reading calibrations online

`latestItemCalibrations(db, items)` (TypeScript, `packages/persistence/src/item-calibrations.ts`) returns,
per item version: the most recent `CALIBRATED` row if one exists, otherwise the most recent
`PROVISIONAL` row, otherwise nothing (the caller uses its own default) — ADR-034's "reads the latest
calibrated parameters and falls back to provisional ones". A newer provisional row does not override an
older calibration: provisional values are a prior, and a calibrated fit that has since lost responses
(withdrawals, deletions) is still the better estimate until a new fit replaces it.

## Choice of library

| Library | Licence | Method | Dependencies | Verdict |
| --- | --- | --- | --- | --- |
| **girth 0.8.0** | MIT | Marginal maximum likelihood (deterministic) | numpy, scipy (BSD-3-Clause) | **Chosen** |
| py-irt 0.7.1 | MIT | Variational inference in Pyro | torch, pyro-ppl, pandas, scikit-learn, … | Rejected |

Both licences are MIT (checked from the packages' own metadata, 2026-09-28). py-irt is rejected because
its variational fit is stochastic (same data, different numbers unless every seed and thread is pinned)
and it pulls PyTorch — hundreds of megabytes onto a single small VPS for a weekly job. girth's MML is
deterministic for identical input, handles missing responses, and needs only numpy and scipy. girth has
had no release since 2021; that is acceptable for a batch job with pinned versions and a parameter-recovery
test that fails if an upgrade changes its answers. Versions are pinned in `jobs/calibration/requirements.txt`.

## Readiness and students

Nothing here writes readiness or evidence. No route, screen or client (web or Android) reads
`item_calibrations`; they are not student-facing and never presented as a score. They are not model
output in the AI sense (no model or LLM is called — they are a statistical fit), so the AI provenance
columns `prompt_version` and `review_state` do not apply; provenance is the run row (`source`,
`algorithm_id`, `library`, counts and times). *Rejected:* a DRAFT → reviewed workflow for calibrations —
nobody can meaningfully review hundreds of fitted numbers by hand; the guards are the threshold, the
bounds and the status, all enforced in the database.

## Open points (Decisions for Divakar)

1. **Schedule.** Weekly (Sunday 22:00 UTC, Monday 03:30 IST) is recommended: calibrations move slowly and
   the export reads the whole log. Adopted.
2. **Threshold.** `min_responses = 200` recommended and adopted; raise it once volumes allow.
