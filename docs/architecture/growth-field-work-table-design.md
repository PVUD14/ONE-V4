# Growth Field Work: Activities, Follow-ups, Visit Location and the Offline Queue — Table Design

**Status:** Adopted (GROWTH-06), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** `0103_growth_field_work.sql` (new; no existing migration is edited and no function an earlier migration
defined is redefined — no capability CHECK, grant trigger or scope trigger is touched)
**Parent design:** `growth-portal-design.md` §13.4–13.5 (retention, staff's own data), §14 (field work on the phone,
offline, location), §16; `growth-leads-table-design.md` (GROWTH-03: leads, scope, the retention sweep); ADR-040
(D5 field work on phones; D14 / O-23 location: 180 days, visit proof only, never attendance or pay)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Field staff log what they did — a visit, a call, a meeting, a note — and what they must do next, mostly on a phone,
often where the network is poor. Two things make this more than a log table:

1. **Location is personal data about the staff member.** It is optional, captured only on a tap, kept coarse
   (about 100 m), kept 180 days, seen only by the person and their manager, and never used for attendance, pay or
   discipline (O-23). Each of those is enforced where it can be: the database rounds and erases, the API filters who
   sees it, and the phone asks for foreground coarse location only.
2. **A write sent from a phone may arrive twice.** A retried send over a dropped connection, or an offline queue
   replayed when the network returns, must land once. Every field write carries an `Idempotency-Key` and is recorded
   in the existing `idempotency_records` table (0001) in the same transaction as the write.

## 1. Tables

| Table | What a row is |
|---|---|
| `growth_activities` | one thing a growth person did about a lead: a `VISIT`, `CALL`, `MEETING` or `NOTE` |
| `growth_follow_ups` | one thing a growth person must do next about a lead, with a due date: open, done or cancelled |

No new table for idempotency: `idempotency_records` (0001) already has `(scope, key)` unique, a request hash and the
resource the first request produced.

## 2. `growth_activities`

| Column | Rule |
|---|---|
| `id` | uuid (server-generated) |
| `lead_id` | → `growth_leads(id)` |
| `kind` | `VISIT`, `CALL`, `MEETING`, `NOTE` |
| `outcome` | `MET`, `NOT_AVAILABLE`, `RESCHEDULED`, `DECLINED`, `INTERESTED`; **required** for `VISIT`, `CALL`, `MEETING`, **NULL** for `NOTE` (CHECK) |
| `contact_id` | NULL or → `growth_lead_contacts(id)`, a contact **of the same lead** (trigger). Who was met is a reference, never free text (design §14.1). A contact later erased leaves the reference pointing at an erased row, which names nobody |
| `notes` | NULL or 1–2000 characters, no `<` or `>`. Organisation-level: the form says not to write personal details about individuals |
| `notes_erased_at` | set once, with `notes` NULL, by the 24-month retention sweep (§6.2) |
| `author_membership_id` | the growth membership the author logged it through (→ `organization_memberships`) |
| `author_user_id` | → `users` |
| `occurred_at` | **as reported by the device**, stored as given |
| `received_at` | `now()` at insert (trigger). Ordering and every period boundary use `received_at`, never `occurred_at` |
| `location_latitude` | NULL or `numeric(6,3)` in −90…90 — **3 decimal places** (about 110 m), the column type itself rounds |
| `location_longitude` | NULL or `numeric(7,3)` in −180…180 |
| `location_accuracy_m` | NULL or integer 0–50 000, the accuracy the phone reported |
| `location_erased_at`, `location_erased_reason` | set together, once: `RETENTION_EXPIRED`, `AUTHOR_REMOVED`, `ACCOUNT_ERASED` |

**CHECKs.**
- Location is all three of latitude, longitude and accuracy, or none. It is allowed only on `VISIT` and `MEETING` —
  the in-person kinds — never on a `CALL` or `NOTE`.
- Once erased: the three location columns are NULL and `location_erased_at` and its reason are set.
- `notes_erased_at` set ⇒ `notes` NULL.

**Guard trigger (BEFORE INSERT OR UPDATE OR DELETE).**
- DELETE refused: an activity is history.
- INSERT: `received_at := now()`. Refused when the lead is do-not-contact (design §13.4: "no visits logged"), when
  `contact_id` is not a contact of the same lead, and when **`occurred_at` is more than 7 days before `now()` or
  more than 5 minutes after it** (design §14.2; acceptance). The 5 minutes are phone-clock skew, not a future
  report: a phone a few seconds ahead must not lose a visit, and nothing more than that is accepted. A location
  cannot be inserted already erased.
- UPDATE: only two changes exist — erasing the location (the three columns to NULL with `location_erased_at = now()`
  and a reason; once), and erasing the notes (to NULL with `notes_erased_at = now()`; once). Every other column is
  fixed. **A location can never be added or changed after the visit is logged** (no "attach later" that could be
  used to place someone after the fact).

**Indexes.** `(lead_id, received_at DESC, id DESC)`; `(author_membership_id, received_at DESC, id DESC)`; a partial
index on `received_at` where a location is held (the 180-day sweep); a partial index on `received_at` where notes
are held.

## 3. `growth_follow_ups`

| Column | Rule |
|---|---|
| `id` | uuid |
| `lead_id` | → `growth_leads(id)` |
| `assignee_membership_id` | the growth membership that must do it — the creator's (follow-ups are personal; a manager reassigns the lead, not the follow-up) |
| `created_by_user_id`, `created_at` | `created_at = now()` |
| `activity_id` | NULL or → `growth_activities(id)` of the same lead: the visit that produced it |
| `due_on` | a date (the phone schedules its reminder for 09:00 local on that date) |
| `title` | 1–280, no `<` or `>`; NULL only once erased (§6.2) |
| `title_erased_at` | set once, with `title` NULL, by the 24-month retention sweep |
| `state` | `OPEN` → `DONE` or `CANCELLED`, once (trigger) |
| `closed_at`, `closed_by_user_id`, `cancel_reason_code` | set together on leaving `OPEN`; `cancel_reason_code` only for `CANCELLED`: `NO_LONGER_NEEDED`, `LEAD_LOST`, `DUPLICATE`, `REASSIGNED`, `OTHER` |

**Guard trigger.** DELETE refused. INSERT: `created_at := now()`, state `OPEN`; refused on a do-not-contact lead;
`activity_id` must be of the same lead; `due_on` must be within 7 days before today and 366 days after (IST date of
`now()`), so an offline follow-up a few days old still lands but no one schedules a reminder years out. UPDATE: only
`OPEN → DONE | CANCELLED` (with the closing columns, `closed_at := now()`), and erasing the title once.
**When the lead's owner leaves** nothing moves here: a leaver's open follow-ups stay open and visible to their manager
as theirs, because the lead itself has gone to "Needs a new owner" and the next owner sets their own.

## 4. Who may write and who may see

The scope is GROWTH-02's `growthScopeFor`; nothing here adds a predicate of its own.

| Act | Who |
|---|---|
| Log an activity, add a follow-up | The lead's **owner**; or a **manager** who could reassign the lead (their region, or their report's lead) — managers go on visits too. An executive must claim an unowned lead before logging work on it (claiming is one tap), so every activity has an owner's context. Only on an open lead (not `LOST`, not handed off) that is not do-not-contact |
| Mark a follow-up done or cancel it | Its assignee, or a manager of the assignee (`scope.ownerMembershipIds` of a `GROWTH_MANAGER`) |
| Remove the location from an activity | Its author only (it is their data) |
| See a lead's activities and follow-ups | Anyone whose scope includes the lead — they are organisation-level history like the stage history |
| **See an activity's location** | **Its author, and their manager** (a `GROWTH_MANAGER` membership whose `scope.ownerMembershipIds` contains the author's membership). Nobody else: not another executive who can see the lead, not a growth admin, not Operations. Everyone else gets `location: null` and `hasLocation: false` is not even disclosed — they see no location field at all |
| The Field page | "Mine" for everyone; "Team" for a manager: their reports' follow-ups and activities (locations by the rule above) |

Operations (`GROWTH_ADMIN`) gets no activity or location read in this goal: the design gives growth admins the leads,
not the field log, and location is "visible to the person and their manager only" (§14.3).

## 5. Idempotency and the offline queue

**On the server.** The field writes — `POST …/leads/:id/activities`, `POST …/leads/:id/follow-ups`,
`POST …/follow-ups/:id/complete`, `POST …/follow-ups/:id/cancel` — **require** an `Idempotency-Key` header
(`^[A-Za-z0-9._:-]{8,128}$`). `POST /api/v1/growth/leads` (a new lead, which may also be made offline) accepts one
optionally, so GROWTH-03's web form keeps working unchanged. In the write's own transaction:

```
INSERT INTO idempotency_records (id, scope, key, request_hash, status)
VALUES (…, 'growth:<user id>:<route>', <key>, sha256(<route> | <canonical body>), 'STARTED')
ON CONFLICT (scope, key) DO UPDATE SET updated_at = idempotency_records.updated_at
RETURNING request_hash, status, response_resource_type, response_resource_id
```

- First arrival: the write runs, the record becomes `SUCCEEDED` with the resource it produced, and both commit
  together. A refusal rolls both back, so a retry gets the same refusal, never a half-written record.
- A retry after commit finds `SUCCEEDED` and returns the **same resource** (`idempotentReplay: true`) without writing
  anything — no second row, no second audit, no second outbox event.
- Two copies in flight at once: the second blocks on the unique index until the first commits, then replays.
- The same key with a different body: `422 IDEMPOTENCY_KEY_REUSED`.
- The scope includes the user id, so two people's keys can never collide, and the route, so a key cannot replay a
  different kind of write.

**On the phone (design §14.2).** Every field write — visit, call, meeting, note, follow-up, follow-up done or
cancelled, new lead — goes through **one queue**, online or not: the item is written to the queue first (with a
fresh uuid that is its `Idempotency-Key` forever), then the queue is sent in order. So there is one code path, and
a write made with a signal is just a queue that empties at once.
- Sent in capture order. A network failure or a 5xx stops the run and leaves the item at the head, to try again
  when the network returns (Android connectivity callback), when the Growth workspace opens, or on "Send now".
- A refusal (4xx: the lead was reassigned meanwhile, it became do-not-contact, the report is now more than 7 days
  old) marks the item **refused with the server's reason** and keeps it, shown to the person until they dismiss it;
  the run continues with the next item. Nothing is dropped silently.
- **Encrypted at rest:** the queue file lives in the app's no-backup private storage, encrypted with AES-256-GCM
  under a key held in the **Android Keystore** (never exported). The cache of API responses (`Store.kt`) keeps
  contacts only for the person's own leads (the API masks everyone else's).
- **Bound to the person:** the queue records the signed-in email; a different person signing in on the phone finds
  it discarded unread.
- **Sign-out clears the cache, the queue and the scheduled reminders**, after a warning that names how many items
  have not been sent.
- A visit to a lead created offline is logged once that lead has synced (the lead id comes from the server).

## 6. Personal data

### 6.1 Location (O-23, design §14.3)
- **Only on a tap**: the phone asks for `ACCESS_COARSE_LOCATION` ("while using the app") the first time the person
  taps "Attach my location", after showing the field-staff location notice
  (`docs/legal/growth-field-location-notice-DRAFT-for-legal-review.md`, DRAFT; publishing is HG-6). It never asks for
  background or fine location and reads location at no other moment. Declining changes nothing else: the visit
  logs without one.
- **Precision**: rounded to 3 decimal places on the phone, again by the API, and finally by the column type.
- **Retention: 180 days** after `received_at`. A daily sweep in the privacy worker (`run-privacy-worker.ts`,
  beside the lead-contact sweep) erases the three columns with `RETENTION_EXPIRED`, in bounded, idempotent batches,
  logging a summary line. No `audit_events` row (no human actor), as the GROWTH-03 sweep.
- **Purpose**: proof that a visit was logged at or near the lead's area. No endpoint aggregates location over time,
  per person or per day; nothing computes distance travelled, time on site or attendance.
- **Erasure on request**: the author removes the location from any of their activities (`AUTHOR_REMOVED`, audited
  without coordinates). When a growth person's account is erased (privacy deletion), every location they logged is
  erased in the deletion run (`ACCOUNT_ERASED`).
- **Export**: the person's privacy export (`growthWork`) gains `fieldActivities` — their own activities with kind,
  outcome, lead name, times, notes, and the location **if still held** — and `followUps`.
- Audit rows and outbox events record `hasLocation: true|false`, never coordinates.

### 6.2 Notes and follow-up titles (design §13.4)
Visit notes are organisation-level, but free text can hold more than it should. The **24-month retention sweep**
that GROWTH-03 built for lead contacts now also erases the `notes` of every activity and the `title` of every
follow-up of the same leads (no activity for 24 months, not handed off), with `notes_erased_at` / `title_erased_at`.
The rows stay, so counts (visits this month, meetings for targets) remain answerable.

## 7. Reads and writes

- Growth (`/api/v1/growth/…`): `GET field` (follow-ups due today, overdue and upcoming; recent activities; counts;
  `?view=TEAM` for managers; the vocabulary and the DRAFT location notice), `GET leads/:id/field` (that lead's
  activities and follow-ups), `POST leads/:id/activities`, `POST leads/:id/follow-ups`,
  `POST follow-ups/:id/complete`, `POST follow-ups/:id/cancel`, `POST activities/:id/remove-location`.
  `GET me` gains `visitsThisMonth` (the person's `VISIT` activities with `received_at` in the current IST calendar
  month) and `followUpsDue` (open, due today or earlier). Every list is bounded (100).
- Every write: one transaction, its `audit_events` row, an outbox event (`growth.activity.logged`,
  `growth.follow_up.created`, `growth.follow_up.closed`, `growth.activity.location_removed`), the idempotency record,
  and the lead's `last_activity_at` moved (so logged work keeps the 24-month clock and "stale" honest).

## Rejected

- **Client-generated row ids as the duplicate guard** (the phone's uuid as the activity's primary key). It would
  work for inserts but not for "mark done", and it lets a client choose server keys. The existing idempotency
  records cover every write the same way.
- **Accepting any `occurred_at`** and sorting by it. A phone with a wrong clock would reorder history and move work
  across month boundaries for targets; the design orders by `received_at` and refuses reports more than 7 days old.
- **Fine location** (`ACCESS_FINE_LOCATION`, GPS). The purpose — near the lead's area — needs about 100 m; anything
  finer is more personal data than the purpose needs.
- **Attaching a location after the visit was logged.** Refused by the trigger: proof of a visit is captured with it.
- **A server push for reminders.** The phone schedules its own local notification (design §14.1); no push service,
  no notification text leaves the device.
- **A separate queue per kind of write.** One ordered queue keeps "create follow-up, then mark it done" in order.

## Decisions taken for Divakar (recommended, built)

- An executive logs work only on a lead they own (claim first); a manager may log on any lead they could reassign.
- Activities and follow-ups are visible to anyone who can see the lead; the **location** only to its author and
  their manager.
- `occurred_at` up to 5 minutes ahead of the server is clock skew and accepted; more is refused as "in the future".
- Location is allowed on visits and meetings only, never on calls or notes, and never after the fact.
- A follow-up's due date is 7 days back to 366 days ahead; reminders fire at 09:00 local on the due date.
- The 24-month sweep also erases activity notes and follow-up titles of the same leads (design §13.4 says notes go
  with the contacts).
- Location removal on account erasure has no deletion category of its own; it is a step of the deletion run,
  recorded in `privacy-export-coverage.md`.
