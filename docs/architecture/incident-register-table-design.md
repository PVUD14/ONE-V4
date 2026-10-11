# Incident Register, Breach Clocks and Status Notices — Table Design

**Status:** Adopted (OPS-16), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0081_incident_register.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

`docs/ops/runbook-breach-response.md` tells the lead operator to "start an incident log immediately (a
timestamped note in the vault)". That log is what the Data Protection Board notification, the notice
to affected people and the post-mortem are written from — and today it lives outside ONE, with no
clock, no record of who was told what and when, and no link to the organisations affected. Appendix 1
§3 (Security, Communications) and OPS-16 ask for three things:

1. an incident register with a timeline (`incidents`, `incident_events`);
2. for a personal data breach, a visible 72-hour clock from `detected_at`;
3. status notices to the administrators of affected organisations, sent only from a template version a
   second person approved, through the existing notification path, audited and rate-limited.

An incident record carries consequences: it is the evidence of when ONE knew about a breach and whom
it told. It gets a design document for that reason.

## The 72-hour clock — what is and is not settled

The goal text says "DPDP requires breach reporting within 72 hours" and asks for "a visible 72-hour
clock from detected_at". The plan also lists the DPDP statutory periods as an open question for
Divakar, and DPDP obligations apply from 14 May 2027. ONE therefore:

- uses **72 hours from `detected_at`** because the goal states it — not because this document has
  confirmed the law;
- labels the clock on every screen and in the API as **"period from the ONE plan, pending legal
  confirmation"** (`clockBasis: 'PLAN_PENDING_LEGAL_CONFIRMATION'`);
- stamps the period **on each breach incident** (`board_clock_hours`) when it becomes a breach, so a
  later change to the period (by a new migration, after legal review) never silently moves the
  deadline of an incident already running;
- shows **no deadline** for notifying affected people. The runbook says they must be told; no period
  for that is stated in the goal, so ONE records *when* they were told and shows no clock. A period
  can be added later by the same mechanism.

Nothing in ONE contacts the Board, a regulator, the police or any other external party. The register
records that a person did so (`board_notified_at`, `board_notified_by_user_id`, an optional
acknowledgement reference); it never sends anything outside the product.

## Decision: four incident tables plus a template-draft table; no new delivery channel

**Chosen.**

- `incidents` — current state of one incident.
- `incident_events` — append-only timeline.
- `incident_affected_organizations` — which organisations are affected (the audience for notices).
- `incident_status_notices` + `incident_status_notice_recipients` — a notice (DRAFT until a person
  approves it for sending) and, once sent, who received it and what happened to each email.
- `status_notice_templates` — draft versions of status-notice wording, waiting for a second person.
  An approved version is copied into the existing `notification_templates` (existing versioning:
  `stable_key`, `version`, `locale`, `approved_by_user_id`, `published_at`).

**Rejected: a free-text notice with no template.** The goal forbids it ("send free-text messages
without a template"). A notice here is only ever a published template version; its text cannot be
edited at send time.

**Rejected: drafts directly in `notification_templates`.** `approved_by_user_id` and `published_at`
are `NOT NULL` there (0004): every row is approved by definition. That is exactly the property the
acceptance test needs ("a notice cannot be sent from an unapproved template version") — a notice
references `notification_templates(id)`, so an unapproved version is unreachable by foreign key.
Relaxing those NOT NULLs to hold drafts would weaken a constraint every other sender relies on.

**Rejected: a bespoke second-person rule on the draft table.** OPS-02 already has dual control —
approver not the requester, 24-hour expiry, payload hash binding, single use, and the solo-operator
safeguard (15-minute cooling-off, marked SOLO) that lets a one-person pilot operate at all. Template
publication becomes one more extended approval action, `COMMS_TEMPLATE_PUBLISH` (0051's mechanism),
so the Approvals queue, its audit and its solo rule apply unchanged. Only the draft's author may
request its publication, so the approver can never be the author.

**Rejected: `notification_commands` and the n8n workflow as the delivery path.** That path chooses
the workflow by the template's `stable_key`, and only six allow-listed workflows exist, all inactive
behind their kill switches (HG-7). Using it would either mean re-keying status notices as
`security-notification` (colliding with OPS-02's solo notice, which reads that key's version 1) or
queueing commands that can only fail into the dead letter. The **existing outbox path** that INST-06
announcements and EMP-08 hiring notices use is chosen instead: an outbox event, the ADR-028 local
dispatcher, an in-app `user_notifications` row per recipient, and email through the configured mail
sink from `mailSender()` (info@ai8ht.pro). With no mail sink the email is recorded `NOT_CONFIGURED`,
never faked.

**Rejected: storing `affected_organizations_count` as a column.** It is the count of live rows in
`incident_affected_organizations`; a stored copy would drift the first time someone forgot to update
it. The API returns it as `affectedOrganizationsCount`, computed.

## `incidents`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. The operator-facing reference is derived: `INC-` + the first 8 hex characters. |
| `title` | text NOT NULL, 3–120 characters. What happened, in a line. No personal data: the API refuses an email address or a run of 10+ digits. |
| `summary` | text NOT NULL, 3–1000 characters. Same rule. |
| `category` | text NOT NULL, CHECK in (`PERSONAL_DATA_BREACH`, `SECURITY`, `SERVICE_OUTAGE`, `DEGRADED_SERVICE`, `DATA_INTEGRITY`, `OTHER`). May change as the assessment develops (a suspected breach is confirmed, or ruled out). |
| `severity` | text NOT NULL, CHECK in (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). May change. |
| `state` | text NOT NULL DEFAULT `'OPEN'`, CHECK in (`OPEN`, `CONTAINED`, `RESOLVED`, `CLOSED`). |
| `detected_at` | timestamptz NOT NULL. When ONE first had reasonable suspicion (the runbook's trigger). Entered by the operator; the trigger refuses a time after the database clock and never lets it change. |
| `declared_at` | timestamptz NOT NULL, stamped by the trigger (`now()`). |
| `declared_by_user_id` | uuid NOT NULL → `users(id)`. |
| `declare_reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$`. |
| `contained_at` | timestamptz NULL. Stamped on first entering `CONTAINED` (or `RESOLVED` straight from `OPEN`). Kept on reopen: it records when containment was first achieved; the timeline records the reopen. |
| `resolved_at` | timestamptz NULL. Stamped on entering `RESOLVED`; cleared on reopen. |
| `closed_at` | timestamptz NULL. Stamped on entering `CLOSED`. |
| `board_clock_hours` | integer NULL, CHECK 1–720. Stamped (72) by the trigger when the incident is, or becomes, a `PERSONAL_DATA_BREACH`; NULL otherwise. The deadline is `detected_at + board_clock_hours`, computed in SQL against the database clock. |
| `board_notified_at` | timestamptz NULL. When a person reported the breach to the Board. Operator-entered, between `detected_at` and the database clock. Set once. |
| `board_notified_by_user_id` | uuid NULL → `users(id)`. Who recorded it. |
| `board_reference` | text NULL, `^[A-Za-z0-9._:/-]{3,64}$`. Optional acknowledgement reference. |
| `users_notified_at` | timestamptz NULL. When affected people were told (by whatever channel the runbook directs). Operator-entered, same bounds. Set once. |
| `users_notified_by_user_id` | uuid NULL → `users(id)`. |
| `updated_at` | timestamptz NOT NULL, stamped by the trigger. |

Rules (the pure functions in `packages/authorization/src/incidents.ts`, repeated by the 0081 trigger):

- `board_*` columns only on a breach; a breach cannot be reclassified away once the Board was notified.
- A breach cannot be `CLOSED` until both `board_notified_at` and `users_notified_at` are recorded.
  A false alarm is reclassified first (reason `NO_PERSONAL_DATA_INVOLVED`), then closed.
- No row is ever deleted.

### State machine

| From | To |
| --- | --- |
| `OPEN` | `CONTAINED`, `RESOLVED`, `CLOSED` (reasons `DUPLICATE`, `FALSE_ALARM` only) |
| `CONTAINED` | `OPEN` (reopen), `RESOLVED` |
| `RESOLVED` | `OPEN` (reopen), `CLOSED` |
| `CLOSED` | — |

## `incident_events` (append-only)

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `incident_id` | uuid NOT NULL → `incidents(id)`. |
| `event_kind` | text NOT NULL, CHECK in (`DECLARED`, `STATE_CHANGED`, `SEVERITY_CHANGED`, `CATEGORY_CHANGED`, `NOTE`, `ORGANIZATION_ADDED`, `ORGANIZATION_REMOVED`, `BOARD_NOTIFIED`, `USERS_NOTIFIED`, `NOTICE_DRAFTED`, `NOTICE_QUEUED`, `NOTICE_SENT`, `NOTICE_WITHDRAWN`). |
| `from_value`, `to_value` | text NULL. Enum values only (states, severities, categories). |
| `organization_id` | uuid NULL → `organizations(id)`. For organisation events. |
| `notice_id` | uuid NULL. For notice events (no FK: the notice table is created after this one; the API writes only real ids). |
| `note` | text NULL, ≤ 500 characters. Same personal-data refusal as the title. |
| `reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$`. |
| `actor_user_id` | uuid NOT NULL → `users(id)`. For `NOTICE_SENT` written by the worker, the person who approved the send. |
| `occurred_at` | timestamptz NOT NULL, stamped by the trigger (`now()`) — never client time. |
| `correlation_id` | text NOT NULL. |

A trigger refuses every UPDATE and DELETE.

## `incident_affected_organizations`

`id` uuid PK; `incident_id`, `organization_id` (INSTITUTION or EMPLOYER only, checked by the trigger);
`added_by_user_id`, `added_at` (stamped); `removed_at`, `removed_by_user_id` (set once, together).
A partial unique index allows one live row per (incident, organisation); a removed organisation can be
added again as a new row. Nothing else may change.

## `status_notice_templates`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `template_key` | text NOT NULL, `^[a-z][a-z0-9-]{2,48}$`. The published row's `stable_key` is `status-notice.<template_key>`, so status notices can never collide with another sender's key. |
| `version` | integer NOT NULL > 0. Next version for the key, assigned under an advisory lock. UNIQUE (`template_key`, `version`). |
| `subject` | text NOT NULL, 3–160 characters (the in-app title limit). |
| `body` | text NOT NULL, 3–500 characters (the in-app body limit). |
| `content_hash` | text NOT NULL, SHA-256 hex of key, version, subject and body. Bound into the approval payload. |
| `state` | `DRAFT` → `PUBLISHED` or `WITHDRAWN`. |
| `drafted_by_user_id`, `drafted_at`, `draft_reason_code` | Who wrote it, when (stamped), why. |
| `published_template_id` | uuid NULL → `notification_templates(id)`. Set on publish. |
| `publish_approval_id` | uuid NULL → `operation_approvals(id)`. The executed `COMMS_TEMPLATE_PUBLISH` approval. |
| `published_at`, `withdrawn_at`, `withdrawn_by_user_id`, `withdraw_reason_code` | Stamped on the transition. |

The trigger makes the content immutable and, on `PUBLISHED`, checks that the approval is an
**executed** `COMMS_TEMPLATE_PUBLISH` for this row, requested by the author, and that the
`notification_templates` row it points to carries the approver as `approved_by_user_id`.

## `incident_status_notices`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `incident_id` | uuid NOT NULL → `incidents(id)`. |
| `template_id` | uuid NOT NULL → `notification_templates(id)`. The trigger also requires a `PUBLISHED` `status_notice_templates` row pointing at it. |
| `state` | `DRAFT` → `QUEUED` → `SENT`; `DRAFT` → `WITHDRAWN`. |
| `drafted_by_user_id`, `drafted_at`, `draft_reason_code` | |
| `approved_by_user_id`, `approved_at`, `approve_reason_code` | The person who approved it for sending (`DRAFT` → `QUEUED`). |
| `approve_solo` | boolean, default false (0090). True only when the drafter approved their own notice under the solo-operator safeguard (see "Who approves a notice"). |
| `sent_at`, `recipient_count`, `organization_count` | Stamped by the worker. |
| `withdrawn_at`, `withdrawn_by_user_id`, `withdraw_reason_code` | |

**Rate limit** (checked by the API under a lock on the incident and again by the trigger, both on the
database clock): a notice for an incident may be approved for sending only if no other notice for the
same incident was approved in the last **15 minutes**, and at most **6** in the last **24 hours**.
A notice cannot be approved for a `CLOSED` incident or one with no affected organisation.

## `incident_status_notice_recipients`

(`notice_id`, `recipient_user_id`) PK; `organization_id`; `notification_id` → `user_notifications(id)`
ON DELETE SET NULL; `email_state` in (`PENDING`, `SENDING`, `SENT`, `FAILED`, `BOUNCED`,
`NOT_CONFIGURED`, `SKIPPED`); `email_attempted_at`; `created_at`. Same shape as INST-06's announcement
recipients.

**Audience.** Resolved by the worker at send time, not when drafting: every `ACTIVE` account with an
`ACTIVE` `INSTITUTION_OWNER`, `INSTITUTION_ADMIN`, `EMPLOYER_OWNER` or `EMPLOYER_ADMIN` membership of a
live affected organisation. Never a student (the goal forbids sending to students in this goal).
Email is `SKIPPED` for an account that is not active or has turned email off (the INST-06 rule),
`NOT_CONFIGURED` with no mail sink, otherwise `PENDING`.

`user_notifications.kind` gains `STATUS_NOTICE` (the 0059/0067 pattern: keep every kind the current
constraint allows and add it).

## Who may do what

| Action | Capability |
| --- | --- |
| Register, timeline, affected organisations, Board / users notified records | `INCIDENT_MANAGE` (baseline SECURITY_ADMIN; super admin) |
| Draft a template version, request its publication, publish after approval, withdraw a draft | `COMMS_TEMPLATES` (baseline OPERATIONS_ADMIN; super admin) |
| Approve publication | `APPROVE_HIGH_RISK` (OPS-02; the solo safeguard applies) |
| Draft, withdraw a notice | `COMMS_TEMPLATES` |
| Approve a notice for sending | `COMMS_TEMPLATES`, and a different person from its drafter (0090; the solo safeguard applies) |

### Who approves a notice (amended 2026-09-30, migration 0090)

The first version of this design said "a notice is a draft until a person approves it", and any holder of
`COMMS_TEMPLATES` could approve, **including the person who drafted it**. The ENG-17 incident runbook confirmed it: the
drafter's own approval returned 201. A notice goes to the administrators of real colleges and employers, in ONE's name,
during an incident. Choosing the approved wording and the moment to send it is exactly the decision a second person
should check. So the approver must now be a different person from the drafter.

This reuses the OPS-02 rule rather than inventing a new one: **the approver is never the requester, except for the
solo-operator safeguard.** A one-person pilot must still be able to tell a college about an incident. So the drafter may
approve their own notice only when both of these hold:

- they are the **only** person who can approve notices: exactly one ACTIVE user holds `COMMS_TEMPLATES` on an ACTIVE
  platform membership (the super admin and operations admin baselines, or a live grant to a security admin). This is
  `status_notice_approver_count()`, the notice counterpart of 0038's `operation_approval_approver_count()`;
- at least **15 minutes** have passed since the notice was drafted, on the database clock (OPS-02's cooling-off,
  `soloCoolingOffMinutes`).

Such an approval is **marked SOLO**. `incident_status_notices.approve_solo` is true, and the audit row and the screens
both say "solo". The safeguard switches itself off as soon as a second person can
approve. A drafter's own approval with anyone else able to approve is refused with 403
`STATUS_NOTICE_SELF_APPROVAL_REFUSED`. A solo approval inside the cooling-off is refused with 403
`STATUS_NOTICE_SOLO_COOLING_OFF`.

The API applies the rule (`decideStatusNoticeApprover`, packages/authorization) under the incident's lock. The 0090
version of `incident_status_notice_guard` repeats it for any other writer, and a CHECK keeps `approve_solo` true only
when the approver is the drafter.

**Rejected: an OPS-02 approval request per notice** (a new extended key, request → approve → execute). It would move
notice approval to `APPROVE_HIGH_RISK` holders and add a third round-trip to every notice in an incident. The existing
one-step approval, with the requester-is-not-approver rule and the solo safeguard, gives the same guarantee.
**Rejected: no solo path.** A pilot with one operator could then never send a status notice.
**Not done: a separate solo email.** OPS-02 emails platform staff when a high-risk approval is self-approved. For a
notice, the notice itself is the email. The SOLO mark is on the notice, in the audit row and on the incident's notice list,
which the security lead reviews.

Every write carries a reason code from the lists in code and writes its timeline row (where it concerns
an incident), its audit row and — where another system may care — its outbox event in one transaction.

## Privacy and data minimisation

- Titles, summaries and notes refuse email addresses and 10+ digit runs; the screen says "no names,
  emails or phone numbers".
- Outbox payloads and audit context carry identifiers and enums only — never a title, summary, note
  or notice text.
- The operator screens show recipient counts and email-state counts per notice, not recipient lists.
- A privacy deletion anonymises the `users` row; recipient rows keep only the (now anonymous) user id
  and the organisation, and the in-app notification is removed by the existing deletion step
  (`notification_id` becomes NULL).

## Audit and outbox

Audit actions: `operations.incident.{declared,transitioned,severity_changed,category_changed,note_added,
organization_added,organization_removed,board_notified_recorded,users_notified_recorded,viewed}`,
`operations.comms_template.{drafted,published,withdrawn}`,
`operations.status_notice.{drafted,approved,withdrawn,sent}`.
Outbox events: `incident.declared`, `incident.state_changed`, `status_notice_template.published`,
`incident.status_notice.dispatch.requested` (the only one with a consumer).

## Rejected alternatives (summary)

- A deadline column — it would have to be recomputed whenever `detected_at` or the period changed;
  derived in SQL instead, from the stamped period.
- Client-supplied timestamps for declared/contained/resolved — every lifecycle time is the database
  clock; only `detected_at` and the two "notified at" times are operator facts, and they are bounded
  by the database clock.
- Sending the notice inside the request — ADR-028 makes the outbox the scheduler; a request never
  sends email.

## Open points (decisions for Divakar)

1. **The 72-hour period** is the plan's, pending legal confirmation. A different period is a new
   migration plus a code constant; running incidents keep theirs.
2. **Email preference.** Status notices honour an admin's "email off" preference, like announcements.
   If security notices should override it, that is a one-line change and a design note.
3. **Rate limit** 15 minutes / 6 per day per incident.
4. **Solo notice approval** (0090): the drafter may approve their own notice only while they are the sole `COMMS_TEMPLATES`
   holder, after 15 minutes, marked SOLO. Recommended and adopted, as for OPS-02. Once a second operator exists it no longer
   applies.
