# Runbook — Pilot incident (including the learning engine)

> What this is: the step-by-step procedure for a pilot incident — something is broken, degraded,
> wrong or unsafe for pilot users — from detection to closure, with the learning-engine cases
> spelled out. Why it exists: ENG-17 (engine appendix) asks for a pilot incident runbook executable
> step by step on seeded data. It uses the OPS-16 incident register and status notices, the OPS-04
> jobs console and the OPS-02 approvals; for a personal data breach it hands over to
> [runbook-breach-response.md](runbook-breach-response.md). Every route, capability and reason code
> was read from the code on base `4fab0c6` and executed on a local seeded database (see
> [Verified locally](#verified-locally)). Written 2026-09-30.

## Who and what capability

| Task | Capability | Baseline role |
|---|---|---|
| Declare and run an incident | `INCIDENT_MANAGE` | SECURITY_ADMIN, super admin — **not** OPERATIONS_ADMIN (403) |
| Status-notice templates and notices | `COMMS_TEMPLATES` | OPERATIONS_ADMIN, super admin |
| Approve a template, a flag change, a backlog supersede | `APPROVE_HIGH_RISK` | super admin (a second person, or the solo safeguard) |
| System Health, failed-event replay | `OPS_JOBS_REPLAY` | OPERATIONS_ADMIN, SECURITY_ADMIN |
| Feature flags | `OPS_FLAGS_MANAGE` | OPERATIONS_ADMIN, SECURITY_ADMIN |
| Server, release rollback, database, engine commands | — | Divakar only |

In a one-person pilot the same person may hold every role; the approvals then use the solo
safeguard (15-minute cooling-off, recorded SOLO — [sop-approvals.md](sop-approvals.md)).

## 1. Detect

Any of these starts an incident:

- **Operations → System Health**: an **Alert** (default: 10 failed events, or a due event waiting
  30 minutes; raised by the `jobs:alert-check` timer), or Worker **Stalled**.
  API: `GET /api/v1/operations/jobs/summary`, `GET /api/v1/operations/jobs/failed`.
- The health monitor timer (`planthepath-monitor.timer`, deploy/systemd/README.md) — `/health`
  failing, a failed `planthepath-*` unit, disk, backups, certificates.
- Support cases: several callers with the same fault ([runbook-pilot-support.md](runbook-pilot-support.md)).
- An AI output or behaviour that should not have reached a user.
- A suspicion that personal data went where it should not → go to
  [runbook-breach-response.md](runbook-breach-response.md) now; this runbook's §2 is its step 1.

## 2. Declare (minutes)

**Operations → Security → Incident register → Declare incident.** API:
`POST /api/v1/operations/incidents` with:

| Field | Values |
|---|---|
| `category` | `PERSONAL_DATA_BREACH`, `SECURITY`, `SERVICE_OUTAGE`, `DEGRADED_SERVICE`, `DATA_INTEGRITY`, `OTHER` |
| `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `detectedAt` | when it was first noticed (ISO time) — for a breach this starts the 72-hour clock (pending legal confirmation) |
| `reasonCode` | `MONITORING_ALERT`, `CUSTOMER_REPORT`, `INTERNAL_DISCOVERY`, `THIRD_PARTY_REPORT`, `SUSPECTED_BREACH` |
| `title`, `summary` | plain words, **no email addresses or phone numbers** (refused with `INCIDENT_TEXT_PERSONAL_DATA`); title and summary never change after declaring — updates go in notes |

The incident opens `OPEN`. Engine incidents usually file as:

| Situation | Category |
|---|---|
| Next steps not updating, placement test or Learning page failing | `DEGRADED_SERVICE` (or `SERVICE_OUTAGE`) |
| `engine:replay-decisions` reports a mismatch; a projection or band looks wrong against the facts | `DATA_INTEGRITY` |
| An AI output reached a user; a model call found in a request path | `SECURITY` (or `PERSONAL_DATA_BREACH` if personal data went to a model provider without basis) |

Record every step below as a **note** (`POST /api/v1/operations/incidents/<id>/notes`, reasons
`TIMELINE_UPDATE`, `EVIDENCE_RECORDED`, `DECISION_RECORDED`; 500 characters; no personal data).
Add each affected college or employer (`POST …/<id>/organizations`, `organizationId`, reason
`SCOPE_ASSESSED` or `NEW_EVIDENCE`; remove with `…/organizations/<affectedOrgId>/remove`,
`SCOPE_ASSESSED` or `ENTERED_IN_ERROR`). Severity and category can change later with their reasons
(`ASSESSMENT_UPDATED`, `SCOPE_GREW`, `SCOPE_REDUCED`; `ASSESSMENT_UPDATED`,
`CONFIRMED_PERSONAL_DATA`, `NO_PERSONAL_DATA_INVOLVED`).

## 3. Contain — pick the narrowest lever

| If the cause is… | Lever | Where |
|---|---|---|
| AI behaviour of any kind | Pull every AI lever | [runbook-ai-kill-switch.md](runbook-ai-kill-switch.md) |
| A feature behind a flag | **Operations → Feature Flags → Disable**, reason e.g. `INCIDENT_MITIGATION` (`POST /api/v1/operations/feature-flags/<key>/state`). A flag marked high-risk to *disable* needs an approval first | [sop-feature-flags.md](sop-feature-flags.md) |
| One failed background event | **System Health → Failed events → Replay**, reason `TRANSIENT_FAILURE_RESOLVED`, `CONFIGURATION_FIXED`, `RECEIVER_RESTORED`, `INCIDENT_RECOVERY` or `CUSTOMER_REQUEST` (`POST /api/v1/operations/outbox/<eventId>/replay`) | [sop-system-health.md](sop-system-health.md) |
| A stale backlog that must never be delivered | **System Health → Request supersede…**, approval `OUTBOX_BACKLOG_SUPERSEDE` (`PRE_DISPATCHER_BACKLOG`, `INCIDENT_CLEANUP`), executed from **Settings → Approvals** | [sop-approvals.md](sop-approvals.md) |
| A bad release | Divakar rolls the code back | [runbook-rollback.md](runbook-rollback.md) |
| A bad engine migration | Forward fix, never a down-migration | [runbook-engine-migration-rollback.md](runbook-engine-migration-rollback.md) |
| Personal data exposure | Contain per the breach runbook | [runbook-breach-response.md](runbook-breach-response.md) §2 |

Then move the incident: `POST /api/v1/operations/incidents/<id>/transition` with
`toState: "CONTAINED"` and `ACCESS_PATH_CLOSED`, `CREDENTIAL_ROTATED`, `SERVICE_ISOLATED` or
`MITIGATION_APPLIED`.

### 3.1 Learning-engine incidents

The engine has no feature flag. Its levers are the worker, three shell commands and consent.
All of it is Divakar's on the server (`cd /srv/planthepath-next/current`, `DATABASE_URL` from
`app.env`, never printed; `F="corepack pnpm --silent --filter @planthepath/persistence"`):

1. **Next steps not updating.** Skill state is projected by the automation worker from the outbox
   event `learning.skill_state.projection_requested` (consumer `learner-skill-state-projector`).
   - System Health → Worker *Stalled*: the automation worker is not draining. It is
     `corepack pnpm --filter @planthepath/persistence worker:automation` with
     `AUTOMATION_WORKER_MODE=local-dispatcher` (ADR-028); restart it on the server. Due events drain
     by themselves once it runs. `deploy/` has no unit file for it (see [Gaps](#gaps)).
   - Failed events of that type: replay them (table above); replay is idempotent.
   - To re-derive everyone at once: `$F engine:rebuild-skill-state` →
     `{"event":"learner_skill_state.rebuilt","subjects":S,"written":W,"deleted":D}`. Idempotent,
     safe beside the worker, writes only the projection.
2. **A decision looks wrong** (a student or lecturer reports a step that does not follow the
   rules). `$F engine:replay-decisions` (or `… <decision-id>`) recomputes every stored decision from
   its stored inputs. Exit 0 and `matched = checked`: the planner did what its rules say — the
   question is about the rules or the inputs, not a defect in the audit. Exit 1: the ids listed in
   `mismatched`, `hashMismatch`, `invalidInputs`, `unsupportedPolicy` are the evidence; record them
   (`EVIDENCE_RECORDED`) and treat it as `DATA_INTEGRITY`. Decisions are append-only; nothing is
   corrected in place.
3. **Stop adaptive behaviour for everyone** (projection or planner defect under investigation).
   Every engine reader asks `hasConsentPurpose(…, 'adaptive-learning')` on each request and fails
   closed. Retiring the live `adaptive-learning` consent definition therefore moves every student to
   the non-adaptive path on their next request, and a rebuild then removes every projection row;
   the attempt log and the decisions stay. There is no operator route for consent definitions
   (they are published by migration after HG-6), so this is a new forward migration or a reviewed
   SQL statement by Divakar:
   ```sql
   UPDATE consent_definitions SET retired_at = now()
   WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL;
   ```
   then `$F engine:rebuild-skill-state`. Coming back means publishing a **new version** of the
   definition (students grant it again — a grant must match the live version,
   `CONSENT_VERSION_MISMATCH` otherwise). Today no definition is published, so this lever is
   already "pulled" in every pilot database.
4. **Calibration looks wrong.** Calibrations are append-only; the reader prefers the latest
   `CALIBRATED` run over newer `PROVISIONAL` ones. Stop the timer
   (`systemctl disable --now planthepath-calibration.timer`) and fix forward with a new run
   (`deploy/scripts/run-calibration.sh`). Not installed anywhere yet.

## 4. Tell the affected colleges and employers (status notices)

Status notices go to the ACTIVE owners and admins of the incident's affected organisations —
never to students — as an in-app notification plus email through the configured mail sink (no
sink: recorded "not sent — no mail service configured").

1. **A published template.** **Settings → Status communications → Templates** (`COMMS_TEMPLATES`):
   draft one (`POST /api/v1/operations/communications/templates`: `templateKey` lower-case
   `a-z0-9-`, `subject` 3–160, `body` 3–500 characters, reason `NEW_TEMPLATE`, `WORDING_UPDATE` or
   `CORRECTION`). Publishing needs an approval: the **draft's author** files
   `COMMS_TEMPLATE_PUBLISH` (reasons `INCIDENT_COMMUNICATION`, `PLANNED_COMMUNICATION`,
   `WORDING_CORRECTION`), a second person approves it in **Settings → Approvals**, and the author
   publishes with the approval (`POST …/templates/<id>/publish` with `reasonCode` and
   `approvalId`). Without it: 403 `APPROVAL_REQUIRED`. Prepare templates before the pilot so this
   is not done under pressure.
2. **Draft the notice** for the incident: `POST /api/v1/operations/communications/notices` with
   `incidentId`, `templateId` and `INITIAL_NOTICE`, `INCIDENT_UPDATE` or `RESOLUTION_NOTICE`. The
   notice has no free text — only the approved template's wording.
3. **Approve it for sending**: `POST …/notices/<id>/approve`, reason `APPROVED_FOR_SEND`. It becomes
   `QUEUED` and the outbox worker sends it. Refusals: `STATUS_NOTICE_NO_AUDIENCE` (add affected
   organisations first), `STATUS_NOTICE_INCIDENT_CLOSED`, `STATUS_NOTICE_NOT_DRAFT`, and 429
   `STATUS_NOTICE_RATE_LIMITED` (one per incident per 15 minutes, at most 6 per 24 hours).
   Withdraw a draft with `NOT_NEEDED`, `WRONG_TEMPLATE` or `SUPERSEDED`.

The incident detail shows, per notice, who approved it and when, when it was sent, how many admins
in how many organisations it reached, and the email outcome counts.

## 5. Resolve and close

1. When the cause is fixed: transition to `RESOLVED` (`ROOT_CAUSE_FIXED`, `SERVICE_RESTORED`,
   `DATA_RESTORED`, `NO_IMPACT_CONFIRMED`). Send a `RESOLUTION_NOTICE` if colleges were told.
2. Re-run whatever proved the fault: System Health clean, `engine:replay-decisions` exit 0,
   the assistant still 503 (AI incidents). Note the result.
3. After the review: `CLOSED` with `POST_INCIDENT_REVIEW_DONE`. `OPEN → CLOSED` is allowed only as
   `DUPLICATE` or `FALSE_ALARM`. A breach cannot close until the Board and the users are recorded as
   notified (`INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING`). An incident can be reopened to `OPEN`
   (`RECURRENCE`, `CONTAINMENT_FAILED`, `NEW_EVIDENCE`) from `CONTAINED` or `RESOLVED`; `CLOSED` is
   final — declare a new incident instead.
4. Close the support cases the incident caused ([runbook-pilot-support.md](runbook-pilot-support.md) §5)
   and update the runbook that did not work.

## Never do

- Never debug on production first; contain, then reproduce locally.
- Never put a student's name, email, marks or answers in an incident, a note or a notice.
- Never fix engine data by editing a projection, a decision or an attempt row; rebuild or fix
  forward.
- Never run a down-migration or edit an applied migration (ADR-035 refuses a changed file).

## Gaps

Missing operator capabilities found while writing this runbook. None was built here.

1. **No engine health on System Health** (OPS-13): the projector consumer is not in
   `knownJobConsumers`, so it has no Consumers row and cannot be given a silence alert
   (`JOBS_ALERT_CONSUMER_SILENCE_MINUTES` accepts only known consumers).
2. **No operator lever to pause adaptive behaviour**: §3.1 step 3 needs a database session or a
   migration.
3. **The automation worker has no unit file in `deploy/`**, so "restart the worker" depends on
   however it is supervised on the server today.
4. **Engine commands have no route, screen or audit**: replay, rebuild and calibration are shell
   steps for Divakar only, and leave only what the incident note records.
5. **Notice approval is not dual-controlled**: the template is (OPS-02), but any holder of
   `COMMS_TEMPLATES`, including the notice's drafter, can approve the notice itself (confirmed
   locally). This matches the OPS-16 design ("a notice is a draft until a person approves it");
   listed so nobody assumes a second pair of eyes on each send.

## Verified locally

Staging does not exist and production is out of bounds, so every step was executed on a local,
fresh PostgreSQL database `one_eng17`, migrated twice and seeded with the repository's seed scripts
(listed in [runbook-ai-kill-switch.md](runbook-ai-kill-switch.md#verified-locally)), through the real
controllers with a local test identity verifier. People, organisations and the template were
synthetic.

RESULTS_INCIDENT

**Needs a real environment:** the monitor and alert timers, restarting the worker, `systemctl`,
email delivery of notices (no mail sink locally: HG-7), and §3.1 on the server.
