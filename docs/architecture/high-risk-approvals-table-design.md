# High-Risk Approvals — Table Design

**Status:** Adopted (OPS-02), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0038_operation_approvals.sql`
**Builds on:** ADR-032 and `internal-capabilities-table-design.md` (OPS-01, migration `0039`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Spec §103 asks for enhanced permission, reason capture, audit and dual control for the riskiest
operator actions. OPS-01 gave every operations endpoint a named capability and a reason code, but one
person holding the capability can still suspend a college, release a legal hold, switch on an AI
feature, bury a backlog of undelivered events or hand someone else the power to approve all of that.
OPS-01 recorded this as divergence D6 and, as a stopgap, let only a `PLATFORM_SUPER_ADMIN` grant a
high-risk capability. This design replaces the stopgap with the real control: a second person.

## Decision: one `operation_approvals` table, bound to the exact payload, consumed in the action's transaction

**Chosen.** An operator who wants to perform a high-risk action first files a request describing the
exact action. A different person holding `APPROVE_HIGH_RISK` approves or rejects it. The requester
then performs the action through the ordinary endpoint, passing `approvalId`; the endpoint recomputes
the payload hash from what it was actually asked to do and consumes the approval **in the same
transaction as the change**, so an approval is used at most once and never for anything else.

**Rejected: a "pending action" queue that executes on approval.** Having the approver's click perform
the action means the approval endpoint must know how to do every high-risk thing in the product, and
the action runs under the approver's authority rather than the requester's. Keeping execution in the
action's own endpoint keeps one code path per action, with its existing capability check, validation,
audit and outbox, and the approval is only a precondition.

**Rejected: an approval column on each target table** (for example `approved_by` on
`data_retention_holds`). Five tables would each grow their own expiry, self-approval and solo rules,
and the approvals queue would be a union over all of them. One table gives one queue, one set of
rules, one trigger.

**Rejected: re-using `audit_events` as the approval store.** Audit rows are immutable and are never
read back to authorise anything; an approval has a lifecycle (pending → decided → executed) and is
read under a row lock at execution time.

## The actions (Appendix 1 §5.4, as they exist today)

| `action_key` | Endpoint | High-risk when | Capability to request and execute |
| --- | --- | --- | --- |
| `ORGANIZATION_SUSPEND` | `POST /operations/organizations/:id/verification` | `toState = SUSPENDED` (the only transition out of `VERIFIED`, i.e. suspend or un-verify) | `OPS_VERIFY` |
| `FEATURE_FLAG_HIGH_RISK_CHANGE` | `POST /operations/feature-flags/:key/state` | the flag is marked high-risk and the change is in its risky direction | `OPS_FLAGS_MANAGE` |
| `OUTBOX_BACKLOG_SUPERSEDE` | `POST /operations/outbox/backlog/supersede` | always | `OPS_JOBS_REPLAY` |
| `PRIVACY_HOLD_RELEASE` | `POST /operations/privacy/holds/:id/release` | always | `PRIVACY_HOLDS` |
| `CAPABILITY_GRANT_HIGH_RISK` | `POST /operations/staff/:membershipId/capabilities` | the capability is one of the six high-risk ones | `CAPABILITY_ADMIN` |

The other §5.4 rows have no endpoint yet and gain their keys when they do, each by a new migration
that widens the CHECK: raising a flag cap (no cap API exists), publishing a career-role requirement set
(OPS-08) and bulk exports of personal data (no export endpoint exists). The action list lives in
`packages/authorization/src/high-risk-actions.ts` as data, next to the capability each needs.

### Marking a feature flag high-risk

`feature_flags` gains `high_risk_direction text NULL`, CHECK in (`ENABLE`, `DISABLE`). NULL is an
ordinary flag. `ENABLE` means switching it on needs approval (AI features); `DISABLE` means switching it
off needs approval (safety controls, and an AI global kill switch whose *on* state is the safe one — so
"kill switch off" is the risky direction). A single boolean was rejected because the risky direction
differs by flag: a boolean would either gate re-enabling a safety control (friction on the safe
direction) or leave its disabling ungated.

The marking is changed by migration only. There is no API for it, deliberately: an endpoint that can
un-mark a flag is an endpoint that removes the approval requirement, so it would itself need dual
control. No flag is seeded by any migration today, so no existing flag becomes high-risk.

## Columns

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `action_key` | text NOT NULL, CHECK in the five keys above. |
| `target_type`, `target_id` | text NOT NULL. `organization` / uuid, `feature_flag` / key, `outbox_backlog` / `backlog`, `data_retention_hold` / uuid, `organization_membership` / uuid. For the queue and the audit trail; the hash is what binds. |
| `payload` | jsonb NOT NULL. The canonical action, identifiers only — no names, emails or free text about a person beyond the operator's optional note. |
| `payload_hash` | text NOT NULL, `^[0-9a-f]{64}$`. SHA-256 of the canonical JSON (sorted keys) of `{actionKey, payload}`. |
| `requested_by_user_id` | uuid NOT NULL → `users`. |
| `reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$`. The action's own reason code; it is part of the payload, so the action is executed with the reason that was approved. |
| `note` | text NULL, ≤ 500. Optional operator note; the UI says not to include personal data. |
| `correlation_id` | text NOT NULL — the request's. |
| `requested_at` | timestamptz NOT NULL DEFAULT now(). |
| `expires_at` | timestamptz NOT NULL, CHECK `= requested_at + 24 hours`. |
| `state` | text NOT NULL DEFAULT `PENDING`, CHECK in (`PENDING`, `APPROVED`, `REJECTED`, `EXECUTED`). Expiry is derived from `expires_at` and the database clock, never stored, so no sweeper is needed and nothing can be "not yet marked expired". |
| `decided_by_user_id`, `decided_at` | set together on a decision. |
| `decision_reason_code`, `decision_note` | the approver's reason (fixed list) and optional note. |
| `solo` | boolean NOT NULL DEFAULT false. The approval was given by the requester under the solo-operator safeguard. |
| `solo_notice_state` | text NULL, CHECK in (`QUEUED`, `NOT_DELIVERED`); required when `solo`, forbidden otherwise. |
| `executed_at`, `executed_by_user_id`, `execution_correlation_id` | set together on execution. |

Shape constraints: a `PENDING` row has no decision and no execution; `APPROVED`/`REJECTED` have a
decision and no execution; `EXECUTED` has both and was approved; the executor is the requester; a
non-solo decision is by someone other than the requester; a solo decision is by the requester, is an
approval, and is at least 15 minutes after the request.

## Rules, and where each is enforced

Every rule is decided by pure functions in `packages/authorization` (the API's answer and error code)
and repeated by a trigger on the table, as 0039 does for grants, so a second writer cannot skip them.

1. **Request.** The requester must hold the action's capability. The target must exist and the change
   must actually be high-risk (a request for an ordinary flag change is refused as
   `APPROVAL_NOT_REQUIRED`, so the queue holds only real decisions). For a capability grant the ordinary
   grant rules run first (no self-grant, platform membership, active, not already held).
2. **Approver ≠ requester.** A decision by the requester is refused unless it is a valid solo approval.
3. **The approver holds `APPROVE_HIGH_RISK`**, checked by the API and again by the trigger through
   `operation_approval_is_approver(user)`: an ACTIVE user with an ACTIVE membership of the platform
   organisation that is either `PLATFORM_SUPER_ADMIN` (baseline) or carries a live `APPROVE_HIGH_RISK`
   grant — the same answer `effectiveInternalCapabilities` gives.
4. **No approving your own elevation.** For `CAPABILITY_GRANT_HIGH_RISK` the approver may not be the
   user who would receive the capability. Otherwise A could ask for B to be made an approver and B could
   approve it.
5. **Expiry.** A request can be decided, and an approval executed, only while the database clock is
   before `expires_at` (request + 24 h). One window, not a fresh 24 h after the decision: an approval is
   a statement about the situation when it was asked for, and a day is the longest that should be
   trusted.
6. **Payload binding.** Execution recomputes the hash from the request it received and refuses
   `APPROVAL_PAYLOAD_MISMATCH` if it differs, including a different reason code. The action key and the
   target must match too.
7. **Single use.** Execution moves the row `APPROVED → EXECUTED` under `FOR UPDATE` in the action's own
   transaction; if the action fails, the approval stays usable, and if it succeeds, the approval is
   spent.
8. **Executor = requester.** The person who asked is the person who acts; an approver cannot pick up a
   request and run it.
9. **Immutability.** Request columns never change; state moves only forward; rows are never deleted.

A high-risk action without `approvalId` returns **403 `APPROVAL_REQUIRED`**. The other refusals are 403
`APPROVAL_NOT_APPROVED`, `APPROVAL_EXPIRED`, `APPROVAL_PAYLOAD_MISMATCH`, `APPROVAL_NOT_REQUESTER`, and on
decisions `APPROVAL_SELF_DECISION_REFUSED`, `APPROVAL_SOLO_COOLING_OFF`, `APPROVAL_SUBJECT_CONFLICT`,
plus 409 `APPROVAL_NOT_PENDING`.

**No bypass.** `PLATFORM_SUPER_ADMIN` goes through approval like everyone else. The plan allows a
break-glass path that requires an incident reference; the incident register (OPS-16) does not exist, so
there is nothing to reference and no break-glass path is built. The solo safeguard below is the only
single-person route.

## Solo-operator safeguard (decision for Divakar — recommended default adopted)

While exactly one person holds `APPROVE_HIGH_RISK`, that person may approve their own request after a
**15-minute cooling-off** from the request. The approval is stored with `solo = true`, audited as
`operations.approval.approved` with `mode: SOLO`, and a notice is raised. The safeguard switches itself
off: the approver count is computed from live memberships and grants at decision time (and by the
trigger), so the moment a second approver exists, a self-approval is refused with no configuration
change. The requester still needs the action's own capability, and every rule above except rule 2
still applies.

**The notice.** It goes through the existing notification pipeline (ADR-021): a
`notification_commands` row per active platform staff member on the `security-notification` template
and a `notification.delivery.requested` outbox event, which the automation worker hands to the
allow-listed `security-notification` workflow. That only happens when the workflow is registered active
and not behind its kill switch. Today no sender is configured (email sender set-up is hard gate HG-7) and
the workflows register inactive with the kill switch on, so the notice is recorded as
**`NOT_DELIVERED`** — on the approval row and in the audit context — rather than queued to fail in the
dead letter or reported as sent. The Approvals screen shows "Notice not delivered — no email sender is
configured". Nothing claims an email went out.

## Rejected alternatives for the safeguard

- **No safeguard (strict two-person rule).** With one founder-operator the product could not suspend an
  abusive employer or release a lawful hold at all. Rejected for the pilot; it becomes the behaviour
  automatically once a second approver exists.
- **Solo with no cooling-off.** Reduces dual control to a second click. The 15 minutes is a deliberate
  pause, not a security boundary, and the audit marker is what makes it reviewable.
- **Solo decided by a setting.** A switch someone must remember to turn off will be left on. Deriving it
  from the approver count cannot drift.

## Queue and screen

`GET /operations/approvals?state=PENDING|APPROVED|REJECTED|EXECUTED|EXPIRED` (keyset on
`(requested_at, id)`, default 50, max 200) is readable by anyone who holds `APPROVE_HIGH_RISK` or who
filed requests (they see their own). The screen lives under **Settings** (Appendix 1 §4.2), above Staff
and capabilities; no navigation item changes. It shows the action, a payload summary with names
resolved server-side (organisation legal name, flag key, capability and staff email, hold reason — never
the hold subject), requester, reason, expiry, and decision buttons that collect a decision reason code.
A requester's own approved request has an "Execute" button that calls the original endpoint with the
stored payload and the `approvalId`.

Web: the Organizations "Suspend" button, the Feature Flags toggle on a high-risk flag and the high-risk
capability grant open a confirm dialog that collects the reason code, says approval is required, and
files the request. Backlog supersede and hold release have no web control yet (System Health and
Security are read-only today); their requests are made through the API and executed from the queue.

## Events

`operation_approval.requested`, `operation_approval.decided` and `operation_approval.executed` (payload:
identifiers and enums only), registered in `packages/events`. No consumer yet; like OPS-01's capability
events they are the durable announcement an access review (OPS-15) can follow.

## Open points (decisions for Divakar)

1. **Solo safeguard** — adopted as recommended (15 minutes, SOLO marker, automatic switch-off).
2. **Notice delivery** — recorded as `NOT_DELIVERED` until a sender exists (HG-7).
3. **Break-glass** — not built until the incident register (OPS-16) gives it something to reference.
4. **Which flags are high-risk** — none exist yet; each AI feature or safety flag should be created by
   its migration with `high_risk_direction` set.
