# Jobs Health Alerts — Table Design

**Status:** Adopted (OPS-04), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0045_jobs_health_alerts.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

OPS-04 gives System Health a background-jobs console, and asks for one more thing that a screen
cannot do: **tell someone** when failed events pile up or a consumer goes quiet, through the existing
`ops-failure` workflow, with **one alert per breach, not one per event**.

"One per breach" needs memory. An evaluator that only looks at the current count would email every
time it runs while the breach lasts (every five minutes, all night). It has to know that it has
already raised this condition and not yet seen it clear. That memory must survive restarts and be
shared by every evaluator run, so it lives in the database.

The obvious home, `audit_events`, does not fit: `actor_user_id` is `NOT NULL REFERENCES users(id)`
(0001), and an alert raised by a timer has no actor. Writing one would mean inventing a system user,
and an invented person in the audit record is exactly what the record exists to prevent.

## Decision: a small `jobs_health_alerts` table, one row per breach

**Chosen.** One row per breach of one condition. A row is `OPEN` while the breach lasts and becomes
`CLEARED` when the evaluator next finds the condition healthy. A partial unique index allows at most
one `OPEN` row per condition and subject, so two evaluators racing cannot raise the same breach twice;
the evaluator also takes a transaction-scoped advisory lock so the race is not even attempted.

**Rejected: dedupe on `notification_commands.dedupe_key` with a time bucket** (for example one alert
per condition per day). That is "one per day", not "one per breach": a breach that clears at 10:00 and
returns at 11:00 would be silent, and a breach that lasts three days would email three times. It also
leaves nothing to show on the screen when no email sender is configured, which is the state today.

**Rejected: keep state in the worker's memory.** The local dispatcher is not deployed yet (ADR-028),
it would lose the state on restart, and "the worker has stopped" is one of the things being alerted
on. The evaluator is deliberately separate from the worker.

**Rejected: audit rows under an invented system user.** See above.

## Columns

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `condition_key` | text NOT NULL, CHECK in (`FAILED_EVENTS_THRESHOLD`, `PENDING_EVENTS_STALLED`, `CONSUMER_SILENT`). |
| `subject` | text NULL. The consumer name for `CONSUMER_SILENT` (required there, forbidden otherwise), `^[a-z0-9._-]{1,100}$`. A consumer name is a code constant, not personal data. |
| `state` | text NOT NULL, CHECK in (`OPEN`, `CLEARED`). |
| `observed_value` | integer NOT NULL ≥ 0 — the count, or minutes, seen when raised. |
| `threshold` | integer NOT NULL ≥ 1 — the configured limit it breached. |
| `notice` | text NOT NULL, CHECK in (`QUEUED`, `NOT_DELIVERED`). Whether an email was queued. |
| `correlation_id` | text NOT NULL, `^[A-Za-z0-9._:-]{8,128}$`. Carried onto the notification commands. |
| `raised_at` | timestamptz NOT NULL DEFAULT now(). Stamped by the database. |
| `cleared_at` | timestamptz NULL. Required exactly when `state = 'CLEARED'`. |

Indexes: the partial unique index `(condition_key, coalesce(subject, ''))` WHERE `state = 'OPEN'`,
and `(raised_at DESC, id DESC)` for the screen's short "recent alerts" list.

A guard trigger makes every business column immutable, allows only `OPEN → CLEARED` (with
`cleared_at` stamped by the database clock), and refuses deletes. Nothing in this goal edits or
removes an alert after the fact; the history is the evidence that the alerting worked.

## What counts as a breach

Configuration comes from the environment (`app.env`, shared by the API and the evaluator), parsed by
one function in `packages/persistence/src/jobs-health.ts`, so the screen shows the same thresholds the
evaluator uses.

| Condition | Breach when | Default |
| --- | --- | --- |
| `FAILED_EVENTS_THRESHOLD` | `FAILED` outbox events ≥ `JOBS_ALERT_FAILED_THRESHOLD` | 10 |
| `PENDING_EVENTS_STALLED` | a due `PENDING` event has waited ≥ `JOBS_ALERT_PENDING_STALL_MINUTES` | 30 |
| `CONSUMER_SILENT` | a consumer listed in `JOBS_ALERT_CONSUMER_SILENCE_MINUTES` (`name=minutes,…`) has no receipt within its interval | none configured |

`CONSUMER_SILENT` is off unless configured. A consumer that has nothing to consume is not broken, and
guessing an interval for it would invent a fact about the pilot's traffic. Divakar sets intervals once
real traffic shows what "normal" looks like.

## Delivery

When a breach is raised, and only when the `ops-failure` workflow is registered active and outside
its kill switch, the evaluator writes one `notification_commands` row per active platform staff
member plus a `notification.delivery.requested` outbox event for each. That is the same pipeline
(ADR-021) and the same recipient rule as OPS-02's solo-approval notice. The template is a fixed
`ops-failure` template whose text names the condition class only: no event payloads, no personal data
and no identifiers. Otherwise nothing is queued and the alert records `NOT_DELIVERED`. The screen says
so plainly, and no email is claimed.

There is no "operations mailbox" entity in ONE today. Platform staff are the people who can act on
the alert, so they are the recipients (decision for Divakar below).

## Who runs the evaluator

A one-shot command, `corepack pnpm --filter @planthepath/persistence jobs:alert-check`, run every five
minutes by a new systemd timer (`deploy/systemd/planthepath-jobs-alerts.*`), the same pattern as the
privacy sweep. It is not an always-on service. It is independent of the worker, so it still reports a
stalled worker. Nothing reaches production until Divakar installs the units by hand.

## Indexes on existing tables (bounded reads)

The console's summary endpoint must compute its numbers in bounded SQL. 0045 adds partial indexes so
each summary query is an index probe rather than a scan:

- `outbox_events (occurred_at DESC, id DESC) WHERE delivery_state = 'FAILED'`: failed-event keyset list.
- `outbox_events (event_type, occurred_at DESC, id DESC) WHERE delivery_state = 'FAILED'`: event-type filter.
- `outbox_events (occurred_at) WHERE delivery_state = 'PENDING'`: oldest waiting event.
- `outbox_events (published_at DESC) WHERE delivery_state = 'PUBLISHED'`: last delivery (worker liveness).
- `event_consumer_receipts (consumer_name, updated_at DESC)`: last activity per consumer.

Counts by state are capped (`LIMIT 10001` inside the count), so a large backlog reads as "10,000+"
instead of a full scan.

## Open points (decisions for Divakar)

1. **Recipients.** All active platform staff, the same rule as the OPS-02 solo notice. The
   alternative, a configured mailbox address, needs a destination that is not a `users` row, and
   `notification_commands` cannot carry one today (`subject_user_id` is required).
2. **Defaults.** 10 failed events, and 30 minutes for a waiting event. Both can be changed in
   `app.env` without a release.
3. **Consumer intervals** are off until configured.
