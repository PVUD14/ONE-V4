# SOP — System Health (background jobs console)

> What this is: the operator procedure for finding, inspecting and replaying failed background
> events, reading worker and consumer health, and asking for a backlog supersede. Why it
> exists: Appendix 1 OPS-17 (M1 slice); journey J3 ("a background event fails overnight").
> Built by OPS-04. Written 2026-09-26 against base `6864332`; updated 2026-10-01 against base
> `719eb34` (OPS-13 engine panels, the skill-state projector consumer, the mail sender).

## Purpose

Keep ONE's outbox (invitation emails, announcements, generated drafts and other background
work) flowing, without a database client or the API.

## Who and what capability

`OPS_JOBS_REPLAY` — baseline OPERATIONS_ADMIN and SECURITY_ADMIN. A backlog supersede also
needs an approval from someone with `APPROVE_HIGH_RISK`.

## Where

**Operations → System Health**. Its sections are:

- Worker;
- Alerts;
- Failed events;
- Consumers (since 2026-09-30 including `learner-skill-state-projector`);
- Automation workflows and commands;
- **Item calibration job** and **Code sandbox** (OPS-13);
- the Career Readiness governance panel, kept below.

## A2. Engine job panels (OPS-13)

- **Item calibration job** shows the last run and its status: current, **OVERDUE** after 8 days
  (the weekly timer plus a day's grace), or no run.
  - A failed job imports nothing, so it shows as an overdue run.
  - If fewer than 5 learners were read, the learner and response figures show <5.
- **Code sandbox** always shows NA, because ENG-12 is not built.
- These panels only read. An overdue calibration is an engineering task for Divakar on the server
  ([runbook-pilot-incident.md](runbook-pilot-incident.md) §3.1). Log it as a support case.

## A. Read the state (every day, and on any alert)

1. **Worker**: *Draining* (work is moving), *Stalled* (due work is not being picked up), or
   *No work waiting* — which means liveness cannot be judged, not that the worker is fine. Also
   shown: live claims, claims left by a stopped worker, last event delivered (NA when none).
2. **Alerts**: one row per breach, not one per event. Defaults: 10 failed events, or a due
   event waiting 30 minutes. An alert clears itself when the condition recovers.
3. **Consumers**: last activity, last success and failed receipts for each known consumer.
   NA means no activity recorded.

## B. A failed event (J3)

1. **Failed events** → filter by **Event type** or **Age** if the list is long; page with
   **Next page** / **Previous page**.
2. **Inspect** the event. You see its type, attempts, a plain explanation of the failure class,
   its reference, consumer receipts and any automation command. You never see its payload,
   the stored error text or recipients — by design.
3. Decide whether the cause is gone. Replaying repeats a real-world effect (for example an
   email), so replay only when the cause is fixed:

| Cause | Reason to replay with |
|---|---|
| A temporary outage that has passed | `TRANSIENT_FAILURE_RESOLVED` |
| Configuration corrected | `CONFIGURATION_FIXED` |
| The receiving system is back | `RECEIVER_RESTORED` |
| Recovering after an incident | `INCIDENT_RECOVERY` |
| The affected person asked for it | `CUSTOMER_REQUEST` |

4. **Replay…** → pick the reason → confirm. The replay is audited as `outbox.event.replayed`.
5. Refresh. Pass condition: the failed count returns to 0 and the alert clears on the next
   check (the checker runs every five minutes once installed — see Gaps).

If the same event fails again after replay, **stop replaying**: the cause is not fixed. Log a
support case (`TECHNICAL_FAULT`, `MONITORING_ALERT`) with the event reference.

## C. Supersede a backlog (dual control)

Use only for a stale backlog that must never be delivered (for example the pre-dispatcher
backlog) or incident clean-up.

1. **Request supersede…** → choose the **Cutoff** → **Count waiting events** to see exactly how
   many would be retired.
2. File the request with `PRE_DISPATCHER_BACKLOG` or `INCIDENT_CLEANUP`.
3. It is approved in **Settings → Approvals**, then **you** press **Execute** there within 24
   hours of filing ([sop-approvals.md](sop-approvals.md)). A changed cutoff needs a new request.

## Escalation

- Worker **Stalled** or claims left by a stopped worker: the worker process is down. Restarting
  it needs server access — **Divakar only**.
- An alert that will not clear and no failed events are listed: check Consumers for silence and
  log a case.

## Never do

- Never replay in bulk "to see what happens"; each replay can email someone again.
- Never supersede to hide failures you have not understood.
- Never ask for payloads or error text to be pasted out of the database.

## Gaps (need engineering or server access)

- **Alert delivery.** Alerts are recorded, but they are emailed only when the `ops-failure`
  workflow is active and an approved `ops-failure` template exists. The SMTP sender is built
  (ADR-042) but not switched on in production, the workflow is not active, and the automation
  worker is not yet deployed on AWS. Alerts therefore show "not emailed". **Check this screen
  daily; nothing will page you.**
- **The five-minute alert checker** (systemd timer `planthepath-jobs-alerts`) reaches a server
  only when Divakar installs it at a release.
- **Thresholds** (`JOBS_ALERT_*`) are changed in the server's environment file, not on screen —
  server access, Divakar only.
- **Workflow activation and kill switches** are not on this screen.
- **Restarting the worker** needs server access.
- A new consumer appears here only after it is added to the code's known-consumer list.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J3.
