# ADR-034 — TypeScript Online, Python Offline: How the Learning Engine Is Built

**Status:** Proposed
**Decision date:** 2026-09-25
**Scope:** Where the adaptive learning engine's decision logic lives and runs, what may run outside the
API, and the data rules every engine goal (ENG-03 to ENG-27) inherits
**Builds on:** ADR-028 (the outbox is the transport), ADR-020 (readiness is a band), ADR-012
(versioned deterministic readiness), ADR-033 (models), `engine-consent-purposes-design.md` (ENG-01)
**Amends:** the program plan's Part D, section D.1 — two data rules, see "Conflicts resolved". No
earlier ADR is superseded.
**Program goal:** ENG-02 (D.1 calls this "ADR-032"; that number was already taken by the internal
operator capabilities ADR, so this is ADR-034)
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

The engine adds a planner, a mastery model (BKT), a review scheduler (FSRS), an adaptive placement
test, item calibration (IRT) and a code sandbox to a product that today has one pattern for this kind
of logic: `packages/career-readiness`, a set of pure TypeScript functions with algorithm ID strings
(`career-readiness-mastery-v1`, `career-gap-v1`, …), called from `packages/persistence` inside the same
transaction that writes the evidence they read.

Production is one VPS running the API, the database and the outbox worker under systemd (ADR-028),
operated by one person. Every always-on process is something Divakar has to keep alive.

The algorithms split cleanly by *when* they run:

- **Per request or per event, small arithmetic:** BKT's four-parameter update, FSRS's scheduling step
  (a maintained TypeScript implementation, `ts-fsrs`, exists), next-item selection and ability update
  for placement given calibrated items, the planner's rules. None needs a numerical library.
- **Periodic, statistical fitting over many learners:** 2PL item calibration and BKT refits. These
  need an IRT fitting library, and the mature ones (`py-irt`, `girth`) are Python.

The ENG-00 baseline also found conflicts between D.1's data rules and what the schema and privacy
policy already guarantee. This ADR resolves those it can and names an owner for the rest.

## Decision

**All online engine logic is TypeScript in this monorepo, written as pure, deterministic, versioned,
unit- and property-tested packages following the `packages/career-readiness` pattern. Python runs only
offline, as batch jobs started by a timer. The engine adds no always-on service to the request path;
the one new always-on component is the isolated code sandbox, reached only through the outbox.**

1. **Packages.** `packages/learning-model`, `packages/mastery-bkt`, `packages/placement`,
   `packages/learning-orchestrator`, `packages/review-scheduler` and (gated, HG-2)
   `packages/tutoring`. Each exports pure functions: no database, clock, randomness or network inside
   them; time, seeds and inputs are arguments. Identical inputs give identical outputs.
2. **Versioned by algorithm ID.** Every package exposes an ID string (`mastery-bkt-v1`,
   `learning-orchestrator-v1`, …). Every row the engine derives records the ID that produced it.
   Changing behaviour means a new ID, never an edited one. The code's ID and the database's active
   model version must agree — ENG-00 found `career-readiness-fundamentals-v1` in code while model v2 is
   active in the database (0030); ENG-04 reconciles that before new IDs are added beside it.
3. **Tested as algorithms.** Unit tests plus property tests (mastery rises on a correct answer and
   stays in bounds; FSRS due dates are monotonic on success; stages never regress incorrectly;
   assisted successes never count). The planner has golden decision tests and a replay command
   (C4, X1).
4. **Where it runs.** Inside the API process, in the same transaction as the write it derives from,
   when the result must be consistent with that write (attempt rows with their evidence, ENG-03);
   otherwise as an outbox consumer in the existing worker (the skill-state projector, ENG-05). No
   engine logic makes a network call.
5. **Python offline only.** `jobs/calibration` (and, gated by HG-2, `jobs/embeddings`) run as batch
   commands under a systemd timer following the privacy-sweep pattern (ENG-13). They read a
   de-identified export of attempts restricted to students holding `model-improvement` consent, and
   write back only their own output tables (`item_calibrations`, with a run identifier and a
   `PROVISIONAL` / `CALIBRATED` status). The API never calls Python and never waits for it; online
   code reads the latest calibrated parameters from the table and falls back to provisional ones. The
   unit file is written in the repository; installing it on any server is Divakar's manual step.
6. **The sandbox is the single exception.** Untrusted student code must run somewhere isolated, and
   that has to be a separate machine: Piston on an isolated VM with no outbound network and hard
   CPU, memory, process and time limits (ENG-12). Submissions go through the outbox as jobs, never
   as a synchronous call from a handler; results come back as rows that become evidence through the
   normal path. Provisioning the VM is HG-1 / HG-7.
7. **No model in the decision loop.** Planner v1 is rules. BKT, FSRS and IRT are statistics. Nothing
   in the engine's online path calls a model (ADR-033); with every AI flag off every journey still
   completes (X2).

## Data rules every engine goal inherits

These restate D.1's data rules as the schema actually allows them, and are the review checklist for
every engine migration and table design.

- **Facts are append-only; projections are rebuildable and never hand-edited.** Attempts
  (`learning_attempt_events`) and decisions (`learning_decisions`) are append-only. `learner_skill_state`
  is a projection with a full-rebuild command, and rebuilding reproduces it exactly (ENG-05).
- **`institution_id` on every new row** where the student belongs to an institution, so the INST-02
  scope rule can be applied to engine data without a join through membership history.
- **Consent is checked server-side on every request** with `hasConsentPurpose`; it fails closed, and
  the fallback is the non-adaptive path, never an error (ENG-01). Until HG-6 publishes the purpose
  definitions, every student is on the non-adaptive path.
- **Readiness is only written through the existing readiness path** (`recomputeReadiness` in
  `packages/persistence/src/career-readiness.ts`). Engine code never inserts into
  `readiness_snapshots` or `readiness_factors`. BKT runs in shadow (ENG-06) and replaces
  `career-readiness-mastery-v1` only through HG-5 (ENG-27). Numeric internals — mastery likelihood,
  ability estimates, FSRS stability and difficulty — are model state; no screen presents them as a
  score or as readiness, and none reaches an employer.
- **Migrations are idempotent** (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`), because the migrator replays every file in lexical
  order on every run with no tracking table (`packages/persistence/src/migrate.ts`). A migration that
  references a table created in `0070` or `0071` must be numbered `0072` or later, or it fails on a
  fresh database. Every engine table gets its table-design document first.

## Conflicts resolved

**1. Immutable evidence versus evidence stages.** D.1 says `evidence_records` "gains assisted and
stage", which reads as a column that moves from *estimated* to *retained* to *demonstrated*. It cannot:
`evidence_records`, `mastery_projections` and `readiness_snapshots` reject every `UPDATE` and `DELETE`
by trigger (`0004`, `reject_immutable_row_change`), and relaxing that trigger is not on the table.

**Decision:** a skill's stage is a **projection**, held in `learner_skill_state` and recomputed by
`packages/learning-model` from the facts; it is never stored as a mutable value on an evidence row.
Anything added to `evidence_records` is a fact **fixed at insert** — `assisted`, and if ENG-04 keeps
it, the stage the evidence *supports when captured* — and is never updated. A stage change that must be
recorded as a fact is a new appended row, not an edit. Adding the columns with constant defaults does
not fire the row trigger; existing rows default to `assisted = false` (true: no hints existed before
ENG-15) and the most conservative stage. Owner: ENG-04 (columns), ENG-05 (projection).

*Rejected:* dropping or narrowing the immutability trigger so `stage` can move in place — it is the
guarantee that evidence is a record of what happened, and `CLAUDE.md` forbids relaxing a constraint
to make a feature easier. *Rejected:* a separate stage-history table as the source of truth — it
duplicates what the projection already derives, and two sources would disagree.

**2. Privacy deletion versus the anonymisation policy.** D.1 says "privacy deletion removes attempts
and rebuilds projections". The declared `DELETION_POLICY` (`packages/privacy/src/index.ts:171`) keeps
`ASSESSMENT_EVIDENCE` **anonymised** — the rows stay, detached from the person, because aggregate
assessment integrity depends on them — and the trigger forbids deleting them anyway.

**Decision:** the two apply to different data.
- **Engine behavioural data is erased.** `learning_attempt_events`, `learning_sessions`,
  `learner_skill_state`, `learner_goals` and a subject's engine decisions are only about the person, so
  they get a new `DELETION_POLICY` category with disposition `ERASED`. Append-only is enforced by a
  trigger that rejects `UPDATE` and rejects `DELETE` except inside the privacy-deletion worker's
  transaction (a transaction-local setting the worker sets), so the table is append-only for everyone
  else and erasable for deletion. The subject's projections are then deleted, not rebuilt — with no
  facts left, the rebuild of that subject is the empty set. Owner: ENG-03 (attempts and the policy
  category), ENG-05 (projection).
- **Existing assessment evidence stays anonymised**, exactly as the policy already declares and the
  deletion worker already does. This ADR does not change it.
- **Aggregates are not rewritten retroactively.** A past calibration run that used a deleted
  student's de-identified attempts is not recomputed; the next run simply no longer sees them. Only
  students with `model-improvement` consent are in those exports, and withdrawal removes them from the
  next export (ENG-01).

*Rejected:* erasing assessment evidence too, to satisfy D.1 literally — it changes a declared policy
with a stated basis and removes institution-facing records, which is Divakar's decision (open question
below), not an engine goal's. *Rejected:* anonymising attempts like evidence — attempts are behavioural
profiling data with no third-party interest in them, and keeping them contradicts the purpose of the
`adaptive-learning` consent.

**3. Readiness as a band; no model output influences it.** Resolved by the data rule above and by
ADR-033: engine code writes readiness only through the existing path, BKT is shadow-only until HG-5,
and no model output becomes evidence or influences a stage or band.

**4. The AI hold and the assistant exception.** Resolved in ADR-033: the engine needs no model; the
assistant is a recorded, bounded exception whose retirement path is owned by ENG-20.

**Deferred with an owner:**
- C9 ("an institution exam result on a mapped subject moves the student's band") fails today because
  the `0030` bridge writes evidence without calling `recomputeReadiness`, and unpublished exam results
  never write evidence. Owner: ENG-03 (it writes attempts from the same bridge, so it routes the bridge
  through the readiness path in the same transaction).
- Numeric progress reaches clients today that is not readiness (`careerTargetProgress.percentOfEvaluated`,
  shown on Android). It is not covered by ADR-020 and this ADR does not remove it. Owner: ENG-18, which
  reworks the student path view and decides whether it stays.

## Rejected options

- **A Python service in the request path** (for example a FastAPI service running BKT, placement and
  the planner with Python libraries). Rejected: a second runtime, deployment, health check and
  dependency chain on a single-VPS product run by one person; a network hop and a new failure mode in
  every learning request; a cross-language contract that drifts from the TypeScript types the API,
  web and Android already share; and it breaks the same-transaction write of attempts with evidence
  (ENG-03). The online algorithms are small arithmetic that do not need Python's libraries — only
  offline fitting does, and that is where Python is allowed.
- **A separate learning microservice**, in any language, with its own database or API. Rejected for
  the same operational reasons as ADR-028 gave for not deploying a broker between two processes on
  one machine, plus one of its own: attempts, evidence and readiness must commit together, and a
  service boundary turns that into a distributed-consistency problem the product does not need. The
  outbox already gives asynchronous processing with at-least-once delivery and idempotent consumers.
- **Calibration in TypeScript.** Rejected for now: no maintained TypeScript IRT fitting library of the
  maturity of `py-irt` / `girth`, and writing one is avoidable risk. Fitting is offline, so Python there
  costs nothing at request time.
- **Python called from the API as a child process.** Rejected: it is a Python service in the request
  path with worse isolation and no supervision.
- **A model as the planner.** Rejected for v1: decisions must replay identically from recorded inputs
  (C4), which a sampled model output cannot guarantee, and the AI hold applies (ADR-030).
- **Running student code in the API or worker process, or in a container on the production host.**
  Rejected: untrusted code needs a machine with no route to the database or the network; hence the
  sandbox exception.

## Consequences

- Engine packages share the monorepo's types, tooling, typecheck and test run; there is one language
  in production code and one deployment.
- Python appears in the repository for the first time, confined to `jobs/`, with its own dependency
  pinning and licence check (ENG-13), and never imported by or bundled with the API.
- Offline jobs make calibration stale between runs by design; online code must behave correctly with
  provisional parameters (ENG-14).
- The sandbox VM is a new piece of infrastructure Divakar must provision and operate (HG-1 / HG-7);
  until it exists, code practice produces no evidence and says so.
- `DELETION_POLICY` gains a category for engine behavioural data, and the privacy-deletion worker gains
  the erase step, both in ENG-03.
- Every engine table design is reviewed against the data rules above before its migration is written.

## Open questions for Divakar

1. Should `ASSESSMENT_EVIDENCE` stay **anonymised** on deletion (current policy, recommended: yes, and
   revisit with the DPDP legal review before 14 May 2027), or be erased like engine attempts?
2. Confirm the tutor rule in ADR-033: any AI tutor reply on an item makes that attempt **assisted**
   (recommended: yes — a model can then only make evidence count less).
