# Learning Sessions — Table Design

**Status:** Adopted (ENG-03), recommended options taken per AGENTS.md
**Date:** 2026-09-26
**Migration:** `0047_learning_attempt_log.sql`
**Rule:** Written before the migration, per D.2 of the program
**Companion:** `learning-attempt-events-table-design.md` — consent, deletion and readiness rules there
apply here unchanged

## Why this exists

Attempts need a frame: which sitting they happened in, in what mode, and — once AI features exist —
which model and prompt produced any help given and what it cost. The planner (ENG-08) groups work by
session, the review scheduler (ENG-09) puts due skills "first in the next session" (C7), and AI cost
caps (OPS-12, ENG-25) are accounted per session. Without a session row every one of those reconstructs
a sitting from timestamps.

## The table

### `learning_sessions`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `subject_user_id` | uuid NOT NULL → `users(id)` |
| `institution_id` | uuid NULL → `organizations(id)`; same rule as attempts, fixed at insert |
| `mode` | text NOT NULL, CHECK in (`LEARN`, `PRACTICE`, `REVIEW`, `ASSESSMENT`, `EXPLORE`) |
| `language` | text NULL, CHECK `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` (a BCP 47 tag). NULL = not recorded; neither engine stores a content language today, and guessing `en` would be invented data. |
| `model_version`, `prompt_version` | text NULL, 1–128 chars; **both or neither**. NULL for every session today (AI hold, ADR-030). |
| `tokens` | integer NULL, ≥ 0 |
| `cost_amount` | numeric(12,6) NULL, ≥ 0; `cost_currency` text NULL, `^[A-Z]{3}$`; both or neither |
| — | CHECK: `tokens` and cost only when `model_version` is present — usage without a model is a contradiction |
| `source_type`, `source_id` | text / uuid, both or neither. For today's sessions: `assessment_attempt` or `exam_attempt` and its id. `UNIQUE (source_type, source_id)` — one session per sitting, so a replayed write creates nothing. |
| `started_at` | timestamptz NOT NULL — the attempt's own start |
| `ended_at` | timestamptz NULL, CHECK `ended_at >= started_at` |
| `recorded_at` | timestamptz NOT NULL DEFAULT now() |

Indexes: `(subject_user_id, started_at)`, `(institution_id, started_at)`.

## Which sessions exist today

One `ASSESSMENT` session per submitted readiness check and per finalised institution exam, written in
the same transaction as its attempts, with `started_at` from the attempt and `ended_at = now()`.
`LEARN`, `PRACTICE`, `REVIEW` and `EXPLORE` sessions arrive with the student learning experience
(ENG-18); the modes exist now so that goal needs no migration.

## Append-only, with one exception: closing

Like attempts, a trigger rejects `UPDATE` and allows `DELETE` only inside the privacy-deletion
transaction for the same subject. The one permitted update is **closing an open session once**:
`ended_at` from NULL to a value, optionally with `tokens` and cost filled at the same moment, and every
other column unchanged. After that the row is frozen.

*Why the exception:* a live learning session starts before its attempts (they reference it) and ends
later; forbidding the close would force either an open session forever or a second "session ended"
table carrying one timestamp. *Rejected:* allowing token and cost increments while open — usage is
metered per call in `ai_generations` (0033); the session total is written once, at close, from that
ledger.

## Deletion

Part of the `LEARNING_ACTIVITY` category, `ERASED`, removed after the subject's attempts (which
reference it).
