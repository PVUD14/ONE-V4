# Code Sandbox — Deployment, Tables, Job and Threat Model (ENG-12)

**Status:** Adopted (ENG-12). Recommended options taken per CLAUDE.md ("ask once, recommend, carry on");
every decision records what was rejected. One decision beyond ADR-034 is recorded as ADR-049.
**Date:** 2026-10-07
**Migration:** `0113_code_sandbox.sql`
**Rule:** Written before the migration, per the migrations rule. The tables hold a person's submitted
work and the result that becomes part of their learning record, so they are tables with consequences.
**Builds on:** ADR-034 §6 (Piston on an isolated VM, reached only through the outbox), ADR-028 (the
outbox is the transport), ENG-03 (`learning_attempt_events`, 0047), ENG-04 (evidence stages, 0050),
ENG-05 (skill-state projection), ENG-22 (`tutor-hints-table-design.md`: the request → job → row pattern
this copies).

## Why this exists

Some skills can only be shown by writing a program. ADR-034 settled where such a program runs: never in
the API, never on the application server, but on a separate machine running Piston, reached only by the
outbox worker, with no outbound network and hard CPU, memory, process and time limits. Master-plan
scenario **C8**: *a Python submission runs in the sandbox, its result becomes evidence, and a network call
from the code is blocked.*

ENG-12 builds every piece of that which does not need an AWS account: the deployment files, the job
pipeline, the tables, the evidence path and an attack suite that proves the isolation. Creating the VM is
HG-1 (AWS access) / HG-7 (provisioning), and stops at the README runbook.

## What already existed

| Piece | Where | Used as |
|---|---|---|
| Outbox, claim with lease, consumer receipts | `outbox-dispatcher.ts`, `automation-workers.ts` | The job transport; `handleEventIdempotently` makes the result write happen once |
| `local-outbox` worker mode | `run-automation-worker.ts` (ENG-22) | Runs the job on a deployment with no n8n |
| Request → PENDING row → outbox job → worker → final row | `tutor-hints.ts`, `tutor-hint-worker.ts` (ENG-22) | Copied: one row per request, claim before the external call, external call outside any transaction |
| Attempt log and sessions | 0047, `learning-attempts.ts` (`recordGradedAttemptSession`) | Where a graded run becomes evidence |
| Stages from the attempt log | `packages/learning-model` (`learning-model-v1`) | Unchanged: a code run is one more graded attempt |
| Skill-state projection request | ENG-05, written by `recordGradedAttemptSession` | Unchanged |
| Feature flags with a cap | 0029 (`feature_flags.cap_*`), `resolveFeatureFlag` | The switch and the daily ceiling |
| Engine health panel 4 | `engine-health.ts` (`NOT_BUILT`) | Not changed here — the seam is `code_submissions` (see "Open points") |

## The deployment — `deploy/sandbox/`

One dedicated VM runs Docker with two containers (`docker-compose.yml`):

- **piston** — `ghcr.io/engineer-man/piston`, pinned by digest. Every run is executed by `isolate`:
  a fresh box per run (new PID, mount, IPC, UTS and **network** namespaces, its own `/tmp` and
  `/box`), a cgroup v2 group with CPU-time, wall-time and memory limits, a process limit, an open-file
  limit and a file-size limit, and an unprivileged uid from a reserved range. The box is destroyed after
  the run.
  The container itself: `privileged` (isolate creates cgroups and namespaces), **read-only root**, writable
  only on tmpfs scratch (`/tmp`, `/var/local/lib/isolate` where boxes live, `/run/isolate`, `/piston`) and
  the runtime-packages volume; container memory 3 GiB, 2 CPUs, 1,024 pids.
- **proxy** — nginx, read-only root. The only port published, bound to the VM's private address
  (`SANDBOX_BIND`). It forwards exactly `POST /api/v2/execute` and `GET /api/v2/runtimes`, only with
  `Authorization: Bearer $SANDBOX_TOKEN`; everything else is 404 (package install/removal, the
  interactive websocket) or 403 (wrong method). Body limit 128 KiB.

Networks: `sandbox` is `internal: true` — no gateway, so the Piston container has **no route out**;
`ingress` carries only the proxy's published port. Runtimes are installed by the install overlay
(`docker-compose.install.yml`), which attaches Piston to an egress network **only while installing**,
through `docker compose exec` (not over the network); the plain file is then brought up again and the
route is gone. On the VM, the cloud firewall adds a third layer (README): inbound only from the
application server's private address to the proxy port; **no outbound** rule at all once runtimes are in.

### Limits — `code-sandbox-limits-v1`

| Limit | Value | Enforced by |
|---|---|---|
| Wall clock per run | 5 s | isolate `--wall-time` (Piston `run_timeout`) |
| CPU time per run | 3 s | isolate `--time` (`run_cpu_time`) |
| Memory per run | 128 MiB | cgroup `memory.max` (`run_memory_limit`) |
| Processes per run | 16 | isolate `--processes` |
| Open files | 64 | isolate `--open-files` |
| Largest file written | 1 MB | isolate `--fsize` |
| stdout / stderr kept | 64 KiB each, then killed | Piston `output_max_size` |
| Concurrent runs | 4 | Piston `max_concurrent_jobs` |
| Source size | 20,000 characters | API and a CHECK |
| Test cases per task | 1–8 | CHECK on `code_tasks` |
| A case that hits the time limit | the remaining cases are not run | worker (bounds one job to ≈ 5 s of hostile time) |

The worker asks Piston for exactly these values on every run; Piston refuses a request above its own
configured ceiling (the attack suite checks that a 600-second request is refused). The compose file sets
the ceilings to the same numbers. One job is at most 8 runs × 5 s plus overhead, inside the 60-second
outbox lease.

### How network is blocked (three independent layers)

1. **Per run:** isolate gives each run its own network namespace containing only `lo`
   (`PISTON_DISABLE_NETWORKING=true`; never `--share-net`). DNS, TCP and UDP to anywhere fail with
   "network unreachable" before a packet leaves the box.
2. **Per container:** the Piston container's only network is `internal`, which has no default route,
   so even Piston itself cannot reach the internet (run.sh checks this from inside the container).
3. **Per VM:** the cloud security group has no outbound rule (README, HG-1/HG-7).

Layer 1 alone satisfies C8; layers 2 and 3 are there for the day a Piston or isolate bug lets a program
out of its box.

## Tables — `0113_code_sandbox.sql`

### `code_tasks` — what a student is asked to program

| Column | Notes |
|---|---|
| `id`, `stable_key`, `version` | A new version is a new row (`stable_key`, `version` unique). |
| `skill_id` | `taxonomy_nodes(id)`, NOT NULL: a task bears on exactly one skill, so its attempt has a skill. |
| `language`, `language_version` | `python` / `3.12.0` only today (CHECK). |
| `title`, `statement` | Bounded text. |
| `test_cases` | jsonb array of 1–8 `{stdin, expectedStdout}`, each string ≤ 10,000 characters (insert trigger). Never sent to a student. |
| `state` | `DRAFT` → `PUBLISHED` → `RETIRED`. Content is frozen from insert; only the state moves, forward. |

No authoring screen or route exists in ENG-12 and the migration seeds no task: a task is content, and an
invented one must not reach a student. Tasks arrive with the content pipeline that needs them (and the
test suites create their own synthetic ones).

### `code_submissions` — one row per program a student sends

| Column | Notes |
|---|---|
| `subject_user_id`, `institution_id` | `institution_id` from the student's current relationship (the INST-02 scope rule). |
| `task_id` | The task version answered. |
| `purpose` | `PRACTICE` only (CHECK). **The employer seam (EMP-12):** an employer coding item adds `EMPLOYER_ASSESSMENT` in a later migration, with its own evidence writer into ADR-039's employer tables instead of the attempt log. Nothing is wired now. |
| `source_code`, `source_sha256` | 1–20,000 characters; the hash is computed by the database (`sha256`) so it cannot disagree with the text. |
| `status` | `QUEUED` → `RUNNING` → `COMPLETED` \| `FAILED`, or `QUEUED` → `FAILED`. Forward only. |
| `failure_code` | Stable codes, set only with `FAILED`: `SANDBOX_UNAVAILABLE` (no URL configured, or the sandbox could not be reached), `SANDBOX_ERROR` (the sandbox answered but could not run it), `SANDBOX_REJECTED` (the sandbox refused the request — a config mismatch), `SWITCHED_OFF` (the flag went off before the job ran), `TASK_UNAVAILABLE` (the task was retired), `EXPIRED` (not run within 10 minutes). |
| `verdict`, `tests_passed`, `tests_total` | Set only with `COMPLETED`: `PASSED` when every case passed, else `FAILED`; 0 ≤ passed ≤ total ≤ 8. |
| `runner`, `runner_version`, `limits_version`, `grader_version` | Provenance of the run: `piston`, the runtime Piston reported (`python 3.12.0`), `code-sandbox-limits-v1`, `code-grader-v1`. Set with `COMPLETED`. |
| `requested_at`, `started_at`, `completed_at`, `correlation_id` | Database clock. |

Triggers: born `QUEUED` with nothing filled in, for a `PUBLISHED` task in the same language; the request
(subject, task, purpose, source, hash, correlation) never changes; status forward only; an outcome is
written once; rows removed only by privacy deletion for the same subject (the 0072 pattern).

### `code_submission_cases` — one row per test case run

`submission_id`, `subject_user_id`, `case_index` (1–8, unique per submission), `outcome`
(`PASSED`, `WRONG_OUTPUT`, `RUNTIME_ERROR`, `TIME_LIMIT`, `MEMORY_LIMIT`, `OUTPUT_LIMIT`, `NOT_RUN`),
`exit_code`, `signal` (`SIG…`), `wall_time_ms`, `cpu_time_ms`, `memory_bytes`. Append-only; erased only by
privacy deletion. Written in the same transaction as the submission's `COMPLETED`.

**Not stored: the program's stdout and stderr.** The grade needs only the comparison, which the worker
makes in memory. Output is the student's own, but it can carry anything the program printed, and a
traceback carries sandbox paths; keeping it would be keeping data with no use. *Rejected:* storing
bounded excerpts "for debugging" — the attack suite and the case outcome codes cover what operators need.

### Widened vocabularies (every earlier value kept)

- `learning_attempt_events.item_source` += `CODE_TASK`
- `learning_attempt_events.source_attempt_type` += `code_submission`
- `learning_sessions.source_type` += `code_submission`

### The switch and the caps

`feature_flags` row `learning.code-sandbox`, **off**, `cap_kind = INVOCATIONS`, `cap_value = 2000`,
`cap_window = DAY`, `high_risk_direction = ENABLE` (switching on running untrusted code needs the
second-person approval, 0038). Per student: at most **one open submission** and **50 per day**
(constants in `code-submissions.ts`). The flag is resolved per student and organisation
(`resolveFeatureFlag`), on the request and again in the worker.

## The request and the job

`POST /api/v1/learning/code-submissions {taskId, source}` — authenticated; the subject is always the
principal. Under a per-student advisory lock, in one transaction: flag → task published → no open
submission → per-student and global daily caps → insert `QUEUED` → outbox `code.submission.requested`
(payload: the submission id only) → audit row. Answers **202** with `{ submission: { id, status } }`. It
never calls the sandbox. `GET /api/v1/learning/code-submissions/:id` returns the student's own
submission (status, verdict, counts, per-case outcome codes, a plain failure message) and 404 for
anyone else's. Errors carry a code, a plain sentence and the correlation id — never the sandbox's text.

The consumer (`code-submission-worker.ts`, run by the outbox worker):

1. Not `QUEUED` → close a `RUNNING` row older than the window as `EXPIRED` (a crashed worker), else nothing.
2. Older than 10 minutes → `FAILED/EXPIRED`. Flag off → `SWITCHED_OFF`. Task not published →
   `TASK_UNAVAILABLE`. `ONE_CODE_SANDBOX_URL` blank → `SANDBOX_UNAVAILABLE`. None of these call anything.
3. Claim `QUEUED → RUNNING` (a redelivered event never runs the code twice).
4. Outside any transaction: one Piston run per case, in order, each with the v1 limits and a 15-second
   HTTP deadline, inside a 45-second budget for the whole submission (so a slow sandbox can never outlast
   the 60-second outbox lease and let a second worker pick the event up). A `TIME_LIMIT` case stops the
   rest (`NOT_RUN`); an exhausted budget is `SANDBOX_UNAVAILABLE`. Unreachable / 5xx / timeout →
   `SANDBOX_UNAVAILABLE`; 4xx → `SANDBOX_REJECTED`; Piston status `XX` → `SANDBOX_ERROR`.
5. Under the consumer receipt, one transaction: the cases, `COMPLETED` with verdict and provenance, the
   attempt (below), the audit row.

Classification of a run (`code-grader-v1`, pure, unit-tested): `TO` → `TIME_LIMIT`; `OL`/`EL` →
`OUTPUT_LIMIT`; killed (`SIGKILL` or exit 137) with memory at ≥ 95 % of the limit → `MEMORY_LIMIT`; any
other non-zero exit, signal or `RE`/`SG` → `RUNTIME_ERROR`; exit 0 → `PASSED` if stdout equals the expected
output after normalising line endings, trailing spaces on each line and trailing blank lines, else
`WRONG_OUTPUT`.

## How a result becomes evidence

A `COMPLETED` submission is a graded response. The worker writes it with ENG-03's own writer,
`recordGradedAttemptSession`, in the transaction that records the result:

| Attempt column | Value |
|---|---|
| session | a `PRACTICE` session, `source_type = code_submission`, `source_id` = the submission |
| `item_source` / `item_id` / `item_version` | `CODE_TASK` / the task id / the task version |
| `skill_id` | the task's skill |
| `context` | `PRACTICE` |
| `answered`, `correct`, `score` | true; every case passed; passed ÷ total |
| `highest_hint_level`, `assisted` | 0, false (no hints exist for code tasks; when they do, the 0047 rule applies unchanged) |
| `content_version` | `code-task-v<version>` |
| `source_attempt_type` / `source_attempt_id` | `code_submission` / the submission id (unique: a replay writes nothing) |

The same writer requests the ENG-05 skill-state projection, so the run moves the skill's stage by
`learning-model-v1`'s rules exactly as a practice question does: an unaided pass is `RETAINED`, a pass on
a second calendar day is `DEMONSTRATED`. A `FAILED` submission (the sandbox did not grade it) writes no
attempt: nothing was shown either way.

**The evidence stage/source it carries:** source `code_submission` / item source `CODE_TASK`, context
`PRACTICE`, unaided. Its stage is whatever the projection computes (`learner_skill_state.evidence_stage`)
from the attempt log; there is no new stage rule for code.

**What it does not do: write `evidence_records` or move readiness.** The readiness band reads every
`evidence_records` row; adding code evidence there changes what readiness considers, which (as with the
exam bridge, 0030) is a new readiness model version and Divakar's decision. That decision, and the
reasons, are ADR-049. The calibration export is limited to the two question sources it was built for, so
code tasks do not enter 2PL calibration.

## Threat model

| Threat | Mitigation | Checked by |
|---|---|---|
| Code reaches the internet (exfiltration, attacks from our address) | Box netns with only `lo`; container on an internal network; VM with no egress rule | attack suite: DNS, TCP 1.1.1.1:443, TCP/UDP 8.8.8.8, HTTP, HTTPS, interfaces = `lo`; run.sh: container egress; C8 test |
| Code reaches the proxy, Docker or other internal services | No route out of the box; the proxy is not reachable from the box | attack suite: proxy, piston, docker host, host.docker.internal, loopback port |
| Fork bomb | 16 processes per box, cgroup pids, wall time | attack suite (both a counting and a recursive bomb; next run sees no leftovers) |
| CPU burn / infinite loop / sleeping forever | 3 s CPU, 5 s wall, then SIGKILL; worker stops further cases | attack suite |
| Memory exhaustion | cgroup memory 128 MiB per box; container 3 GiB; 4 concurrent | attack suite |
| Disk fill | 1 MB file-size limit; tmpfs sizes; read-only root | attack suite |
| Writing outside scratch / persisting between runs | read-only root, box per run destroyed afterwards | attack suite (8 paths; marker not visible to the next run) |
| Reading secrets | no secret is in the sandbox: the token lives only in the proxy and the worker; box env is minimal; `/etc/shadow`, docker socket unreadable | attack suite |
| Privilege escalation | unprivileged uid; setuid/chroot/mount refused | attack suite |
| Container escape via kernel / isolate bug | The container is privileged, so a kernel exploit from a box is the residual risk. It is contained by putting the sandbox on its own VM with nothing else on it, no credentials, no egress and inbound only from the app server. | design + README firewall steps |
| Someone on the network installs runtimes or uses the websocket | proxy forwards two routes only, with the token | attack suite |
| Output flood fills memory or the database | 64 KiB per stream then killed; no output stored | attack suite; schema |
| Abuse of compute (many submissions) | flag off by default; 1 open + 50/day per student; 2,000/day global (flag cap); 4 concurrent on the VM | integration tests |
| Sandbox text reaching a student (paths, Piston errors) | only outcome codes are stored or returned; failure codes map to fixed sentences | integration tests |
| Request handler waits on the sandbox | the API only queues; the worker calls Piston outside any transaction | integration tests; no import of the client from `apps/` |

## Rejected

- **Run code in the API or worker process (vm2, `child_process`, WebAssembly Python).** Untrusted code on
  the application server, next to the database credentials. ADR-034 rejected it; nothing has changed.
- **Run Piston on the application server, in a container.** Piston needs `--privileged`; a privileged
  container shares the kernel with the API and the database. A separate VM is the boundary.
- **A synchronous "run my code" endpoint.** CLAUDE.md and ADR-034 §6: jobs only. A student waits a few
  seconds and the screen polls, as the tutor does.
- **gVisor / Firecracker / Judge0.** Stronger isolation in principle, but each is a new operations
  burden for a two-person project; Piston + isolate + a dedicated VM is what ADR-034 chose, and the attack
  suite shows it holds. Revisit if the VM ever has to share a host.
- **Expose Piston's API directly on the private network.** It installs packages and opens an interactive
  websocket without authentication. The proxy closes both.
- **Retry a submission when the sandbox is down.** The claim makes the run at-most-once; a retry would need
  a second state machine. The student sees "the code runner is not available" and can send it again.
- **One Piston run with a harness that loops over all cases.** Cases would share a process and scratch;
  a crash in one would hide the others' results. One run per case is simpler to grade honestly.

## Open points (decisions for Divakar)

1. **HG-1 / HG-7 — provision the VM** (README runbook). Until then `ONE_CODE_SANDBOX_URL` is blank and every
   submission ends `FAILED/SANDBOX_UNAVAILABLE`; the flag is off anyway.
2. **Code evidence in readiness** (ADR-049). Recommended: no, until a readiness model version is designed
   that admits it, after the shadow report shows its effect.
3. **Engine health panel 4** can now read `code_submissions` (runs today, failures by code). Not wired in
   ENG-12 because it changes an operations screen's contract; a small follow-up.
4. **Student UI** for code tasks (web + Android parity) arrives with the first code content.
