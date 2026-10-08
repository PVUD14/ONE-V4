# Runbook — Monthly recalibration and BKT refit

> What this is: the step-by-step procedure for the monthly refit of the placement test's 2PL item
> parameters and of per-skill BKT parameters, for Divakar. Why it exists: ENG-26 builds the
> commands and tests them on synthetic data only; running them on pilot data is Divakar's step on
> the production side, because the agent never reads or derives from production data. A refit only
> ever *proposes*: nothing changes for a student until a run is accepted here. Every command below was
> run on a local seeded database (see [Verified locally](#verified-locally)). Written 2026-10-08.
> Design and reasoning: [recalibration-runs-table-design.md](../architecture/recalibration-runs-table-design.md).

## What a run does, in one paragraph

Per kind — **items** (2PL difficulty and discrimination, read by the placement test) and **BKT** (four
probabilities per skill, read by nothing live until ENG-27 / HG-5) — the job exports the attempts of
students who hold the live `model-improvement` consent (de-identified: per-run pseudonyms for items, no
learner key at all for BKT), fits them offline in Python, compares the fit with the parameters it would
replace, and records the result as a **PENDING** run with a markdown report. You then **accept** or
**reject** each run. Accepting an item run imports it into `item_calibrations` (the placement test uses it
from its next sitting); accepting a BKT run only records it. A run never shows, uses or changes a
readiness value.

Throughout: `F="corepack pnpm --silent --filter @planthepath/persistence"`, run from the release
directory (`/srv/planthepath-next/current` on the server) with `DATABASE_URL` set as the service has it
(`set -a; . /srv/planthepath-next/shared/app.env; set +a`). Never paste the URL into a ticket or chat.

## 1. Preconditions

| # | Check | How | If not |
|---|---|---|---|
| 1 | The release contains migration 0115 | `$F db:migrate` reports `0 applied`; `SELECT count(*) FROM recalibration_runs;` works | Deploy the release first (runbook-deploy.md) |
| 2 | The engine consent purposes are published (HG-6) | `SELECT version FROM consent_definitions WHERE consent_key = 'model-improvement' AND retired_at IS NULL AND effective_from <= now();` returns a row | Stop here: every export is empty by design (fails closed) |
| 3 | The calibration venv exists | `/srv/planthepath-next/shared/calibration-venv/bin/python -c "import girth, numpy, scipy"` | Install it: deploy/systemd/README.md, "Monthly recalibration" |
| 4 | The report directory exists, owned by `aight` | `ls -ld /srv/planthepath-next/shared/recalibration-reports` | `sudo install -d -o aight -g aight -m 0750 …/recalibration-reports` |
| 5 | Enough pilot attempts | §2 below | Run anyway (it only proposes) or wait a month |
| 6 | A backup from today exists | runbook-backups-monitoring.md | Take one first |

**Enough** means, for anything to come out calibrated: items — at least **200** first, unaided responses
per item from consenting students, and at least **3** such items; BKT — at least **100** consenting
learners with observations on a skill. Below that the run records the item or skill as `PROVISIONAL` /
`DEFAULT` (`TOO_FEW_RESPONSES`, `TOO_FEW_LEARNERS`) and nothing would change on accept.

## 2. Check the volumes (optional, counts only)

```bash
umask 077; tmp=$(mktemp -d)
$F engine:recalibration export --kind items --out "$tmp/e.json" --baseline "$tmp/b.json"
$F engine:recalibration export --kind bkt   --out "$tmp/e2.json" --baseline "$tmp/b2.json"
rm -rf "$tmp"      # the exports are pseudonymous per-learner data: never keep or copy them
```

Each prints one line of counts, e.g. `{"event":"engine.recalibration.exported","kind":"ITEM_2PL",…,
"learners":300,"items":16,"responses":4800,"baselineItems":0}` and `{…"kind":"BKT",…,"sequences":600,
"skills":2,"observations":4800,"baselineSkills":0}`. `responses / items` near or above 200, and
`sequences / skills` near or above 100, mean the fit will calibrate something. These two exports are not
recorded anywhere; the real run makes its own.

## 3. Run

On the server, either let the timer run it (the 1st of the month, 22:00 UTC) or start it now:

```bash
sudo systemctl start planthepath-recalibration.service
journalctl -u planthepath-recalibration.service --since today -o cat
```

By hand, from the release directory, the same thing: `bash deploy/scripts/run-recalibration.sh`.
`RECALIBRATION_KINDS=items` (or `bkt`) limits it to one kind.

The log is counts only. Per kind you will see `exported`, `fitted` (items only), `compared`, `recorded`
and `report-written`, e.g.

```json
{"event":"engine.recalibration.recorded","runId":"88e60f76-…","kind":"ITEM_2PL","recorded":true,"verdict":"NO_COMPARISON","counts":{"STABLE":0,"DRIFTED":0,"NEW":14,…,"NOT_CALIBRATED":2}}
{"event":"engine.recalibration.report-written","runId":"88e60f76-…","file":"/srv/planthepath-next/shared/recalibration-reports/2026-10-08-ITEM_2PL-88e60f76-….md"}
```

A failed step stops the run and records nothing; fix the cause and run it again. A fit refused for a
malformed file exits 2 with `{"event":"engine.calibration.failed","reason":…}`.

## 4. Read the report

```bash
$F engine:recalibration list                     # newest first: id, kind, verdict, compared, drifted, state
$F engine:recalibration report --run <id>        # the markdown report (also in the report directory)
$F engine:recalibration report --run <id> --json # the machine-readable report, every item / skill
```

What to read, top to bottom:

1. **Compared against.** Items: the most recently imported item run. BKT: the last accepted BKT run, or
   "the provisional defaults" on the first refit.
2. **Verdict.** `STABLE` — every compared parameter stayed inside the bounds. `DRIFTED` — at least one
   moved more than sampling noise explains *and* more than the practical floor. `NO_COMPARISON` —
   nothing was fitted on both sides (a first run, or too little data).
3. **Stability bounds.** Drift means |proposed − previous| > max(floor, z × SE of the difference).
   Items: floor 0.30 logits on difficulty, a 25% ratio on discrimination, z = 3.5. BKT: floor 0.05 on
   each probability, z = 3. The `Tolerance` column is that max for the row.
4. **Counts** by change: `STABLE`, `DRIFTED`, `NEW` (fitted now, nothing before), `NEWLY_CALIBRATED`
   (item was provisional, now calibrated), `LOST_CALIBRATION` (calibrated before, not now — live keeps
   the old one), `NOT_REFITTED` (no data this month — live keeps it), `NOT_CALIBRATED`.
5. **Drifted** — one row per drifted parameter: previous, proposed, change, tolerance, scale
   (`log-ratio` for discrimination).
6. **Status changes** — `NEW`, `NEWLY_CALIBRATED` and `LOST_CALIBRATION` with the proposed values
   (items: `b`, `a`; BKT: each probability ± its standard error).

### Deciding

| What you see | Recommended | Why |
|---|---|---|
| `STABLE`, only `STABLE` / `NOT_CALIBRATED` rows | Accept | Live parameters change only within noise; the record stays current |
| `NO_COMPARISON` with `NEW` rows, first run | Accept if the `NEW` values are plausible (items: `b` within about ±3, `a` not pinned at 0.2 or 4.0 for many items; BKT: no guess near 0.5) | First calibration; nothing to drift from |
| `DRIFTED` and you know why (an item was reworded, a cohort with a different curriculum joined) | Accept, and say why in the reason | The new parameters describe the items as they are now |
| `DRIFTED` and you do not know why | Reject; look at the drifted items' content and recent changes; run again next month | Drift without a cause may be a data problem |
| Many `LOST_CALIBRATION` | Reject | Usually a consent or volume drop; live keeps the old calibrations either way |
| BKT anything | Accept or reject freely | Nothing live reads BKT fits until ENG-27 / HG-5 |

## 5. Accept or reject

```bash
$F engine:recalibration accept --run <id> --reason "Reviewed: 14 NEW items, values plausible."
$F engine:recalibration reject --run <id> --reason "Drift on 3 items with no known cause; investigating."
```

A reason (1–500 characters) is required and is stored with the decision. Each run is decided once.

- Accepting an **item** run prints `{"event":"engine.recalibration.decided",…,"decision":"ACCEPTED",
  "itemRunId":"<same id>","imported":{"calibrated":14,"provisional":2}}`. The placement test uses the
  imported parameters from its next sitting.
- Accepting a **BKT** run prints `"imported":null`; it becomes the accepted fit (and the baseline next
  month) and changes nothing live.
- **Accept is refused as `STALE`** (exit 2, `{"event":"engine.recalibration.refused","code":"STALE",…}`)
  if anything was imported or accepted after the run was compared — typically when two months are pending
  and you accepted the newer one. The proposal compares against the wrong thing: reject it ("superseded")
  and, if needed, run again.
- Two pending runs of the same kind: decide the newest; reject the older as superseded.

## 6. Check after accepting

```sql
SELECT r.kind, r.verdict, d.decision, d.decided_at
FROM recalibration_runs r JOIN recalibration_decisions d ON d.run_id = r.id
ORDER BY d.decided_at DESC LIMIT 5;
SELECT run_id, status, count(*) FROM item_calibrations
WHERE run_id = '<accepted item run id>' GROUP BY 1, 2;
```

**Operations → AI → Engine health → Last calibration run** shows the accepted item run with status
`CURRENT`. It turns `OVERDUE` 38 days after the last *import*, i.e. when a month's run was rejected or
left pending — that is the panel telling you the live calibrations are getting old, not a failure.

## 7. Roll back

```bash
$F engine:recalibration revert --run <accepted id> --reason "Placement looked wrong after the import."
```

- **Items:** writes a new item run that copies, for every item the reverted run touched, the
  calibration that was live before it, and records `REVERTED`. Output:
  `{…"decision":"REVERTED","itemRunId":"<new run>","restored":14,"notRestorable":2}`. Allowed only while
  the reverted run is still the latest imported item run (`NOT_LATEST` otherwise — revert the newer one
  first).
- **`notRestorable`** counts items the reverted run calibrated for the first time (no row, or only a
  provisional one, before). They stay calibrated, because the placement reader always prefers a
  calibration over a provisional row and rows are never deleted. If one of them is wrong, archive the
  question (**Content Management → Question bank → Archive…**): it leaves every pool.
- **BKT:** records `REVERTED`; the previously accepted fit is current again. Nothing live changes.
- **Stop the job** (it only proposes, so this is rarely needed):
  `sudo systemctl disable --now planthepath-recalibration.timer`.
- **Code rollback** to a release without ENG-26: safe; pending runs simply wait (runbook-engine-migration-rollback.md, 0115).

## 8. Refusals

| Code (exit 2) | Meaning | Do |
|---|---|---|
| `INVALID` | Malformed proposal or reason, or a bad run id | Re-run the job; give a reason |
| `NOT_FOUND` | No run with that id | `list` and copy the id |
| `ALREADY_DECIDED` | The run was already accepted / rejected (or reverted) | Nothing |
| `STALE` | Live parameters changed since the comparison | Reject as superseded; run again |
| `NOT_ACCEPTED` | Revert of a run that was not accepted | Nothing to revert |
| `NOT_LATEST` | A newer item run was imported after this one | Revert the newer one first |
| `ALREADY_IMPORTED` | An item run with this id already exists | Should not happen; investigate before anything else |

## 9. Rehearse on a local seeded database

Synthetic data only, on your machine. The seed refuses any host other than this machine.

```bash
# a fresh local database (adjust the name)
export DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/ptp_rehearsal
corepack pnpm db:migrate
$F db:seed:local-users                       # prints three CAREER_READINESS_* ids; export them
$F db:seed:career-readiness                  # two active topics
python -m venv jobs/calibration/.venv && jobs/calibration/.venv/bin/pip install -r jobs/calibration/requirements.txt
export APP_ROOT=$PWD CALIBRATION_PYTHON=$PWD/jobs/calibration/.venv/bin/python RECALIBRATION_REPORT_DIR=$PWD/.recalibration-reports

# month 1: 300 synthetic consenting learners, first run, accept both
$F engine:recalibration-synthetic-seed --local --learners 300 --seed 1
bash deploy/scripts/run-recalibration.sh
$F engine:recalibration list
$F engine:recalibration report --run <items id>
$F engine:recalibration accept --run <items id> --reason "rehearsal month 1"
$F engine:recalibration accept --run <bkt id> --reason "rehearsal month 1"

# month 2: same population again -> STABLE; month 3: a perturbed population -> BKT DRIFTED
$F engine:recalibration-synthetic-seed --local --learners 300 --seed 2
bash deploy/scripts/run-recalibration.sh
$F engine:recalibration-synthetic-seed --local --learners 300 --seed 3 --perturb
bash deploy/scripts/run-recalibration.sh
$F engine:recalibration report --run <month-3 bkt id>
$F engine:recalibration accept --run <month-3 items id> --reason "rehearsal month 3"
$F engine:recalibration accept --run <month-2 items id> --reason "x"     # refused: STALE
$F engine:recalibration reject --run <month-2 items id> --reason "superseded"
$F engine:recalibration reject --run <month-2 bkt id> --reason "superseded"
$F engine:recalibration accept --run <month-3 bkt id> --reason "rehearse a revert"
$F engine:recalibration revert --run <month-3 bkt id> --reason "rehearsal"
$F engine:recalibration revert --run <month-3 items id> --reason "rehearsal"
$F engine:recalibration revert --run <month-1 items id> --reason "x"     # refused: NOT_LATEST
```

On Windows the venv's interpreter is `jobs/calibration/.venv/Scripts/python`.

## Verified locally

Run on 2026-10-08 against a fresh local PostgreSQL 16 database (`ptp_eng26r2`; a first pass on
`ptp_eng26r` found and fixed the revert's `notRestorable` count), branch `feat/eng-26-recalibration`,
with §1's database and venv checks, §2, §9 exactly as written, §6's two queries and §7 (Windows, Git
Bash, Python 3.14 venv with the pinned `girth 0.8.0`, `numpy 2.4.6`, `scipy 1.17.1`). No production
host, database or data was touched.

| Step | Result |
|---|---|
| `db:migrate` | `99 applied` (0115 included), then `0 applied`; `SELECT count(*) FROM recalibration_runs` → 0; venv imports girth, numpy, scipy |
| §2 volume check | items `learners 300, items 16, responses 4800, baselineItems 0`; BKT `sequences 600, skills 2, observations 4800`; files removed |
| Seeds | `db:seed:local-users`, `db:seed:career-readiness` (2 active topics), then 300 synthetic learners, 4,800 attempts |
| Month 1 run | items: 300 learners, 16 items, 4,800 responses → 14 `CALIBRATED`, 2 `PROVISIONAL:ESTIMATE_OUT_OF_RANGE`, verdict `NO_COMPARISON` (14 `NEW`); BKT: 600 sequences, 2 skills → both `FITTED`, `NEW` |
| BKT report | fitted values within about 0.03 of the generating parameters (e.g. `pGuess 0.2189 ± 0.0165` for a true 0.20) |
| Accept both | item run imported (`calibrated 14, provisional 2`); BKT recorded (`imported: null`); `learner_skill_state` has no fitted version; a second accept → `ALREADY_DECIDED`, exit 2 |
| Month 2 (same population) | items `STABLE` (14 compared, 0 drifted); BKT `STABLE` (2 compared) |
| Month 3 (perturbed) | items `STABLE` (+2 `NEWLY_CALIBRATED`); BKT `DRIFTED`: one skill, `pGuess 0.2691 → 0.1817`, change −0.0874 > tolerance 0.0585 |
| Decisions | month-3 items accepted (16 calibrated); month-2 items accept → `STALE`, exit 2, then rejected; month-2 BKT rejected; month-3 BKT accepted then reverted |
| §6 queries | the last five decisions by kind / verdict; 16 `CALIBRATED` rows in the accepted month-3 item run |
| Item revert | new item run, `restored 14, notRestorable 2`: 14 items back on the month-1 values (checked in SQL), the 2 newly calibrated items stay; reverting month 1 → `NOT_LATEST`, exit 2 |
| Privacy | no `@`, account id or `L<n>` pseudonym in any report file or stored report; no `learner_skill_state` row carries a fitted BKT version |
| `list` | every run with its state: `ACCEPTED`, `REJECTED`, `REVERTED` |

Not exercised: the `systemctl` steps (no server), and the Engine health panel after an accept (the panel's
own tests cover the new 31 / 38-day cadence).
