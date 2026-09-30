# Runbook — Pilot support (including the learning engine)

> What this is: the step-by-step procedure an operator follows when a pilot student, lecturer or
> placement officer contacts ONE, with the learning-engine questions the pilot will actually
> raise and what the code says the answer is. Why it exists: ENG-17 (engine appendix) asks for a
> pilot support runbook executable step by step on seeded data. It builds on the OPS-05 support
> desk ([sop-support.md](sop-support.md)) rather than repeating it. Every route, capability and
> reason code below was read from the code on base `4fab0c6` and executed on a local seeded
> database (see [Verified locally](#verified-locally)). Written 2026-09-30.

## Who and what capability

| Task | Capability | Baseline role |
|---|---|---|
| Log, assign, note, move and close a case | `SUPPORT_CASES` | OPERATIONS_ADMIN (and the super admin) |
| Look an account up, reveal a contact | `SUPPORT_ACCOUNT_LOOKUP` | OPERATIONS_ADMIN, SECURITY_ADMIN |
| Read System Health, replay a failed event | `OPS_JOBS_REPLAY` | OPERATIONS_ADMIN, SECURITY_ADMIN |
| Engine commands on the server (§4) | none in the app — a shell on the server | Divakar only |

## 1. Log the case (target: under a minute)

**Operations → Support → New case.** Pick channel, category, severity, open reason; one-line
summary with **no personal data**. Full field lists: [sop-support.md](sop-support.md) §A.

| Field | Values |
|---|---|
| Channel | `EMAIL`, `PHONE`, `WHATSAPP`, `IN_APP` |
| Category | `ACCOUNT_ACCESS`, `INVITATION`, `ONBOARDING`, `DATA_CORRECTION`, `PRIVACY_REQUEST`, `TECHNICAL_FAULT`, `HOW_TO`, `COMPLAINT`, `OTHER` |
| Severity (SLA) | `URGENT` 4 h, `HIGH` 24 h, `MEDIUM` 72 h, `LOW` 120 h |
| Open reason | `CUSTOMER_CONTACT`, `OPERATOR_FOLLOW_UP`, `INSTITUTION_ESCALATION`, `MONITORING_ALERT` |

API equivalent: `POST /api/v1/operations/support/cases` with `channel`, `category`, `severity`,
`summary`, `reasonCode` (optional `subjectUserId`, `organizationId`, `assignToMe`) → 201, state
`OPEN`. Learning-engine questions are normally `HOW_TO` (the product is doing what it should) or
`TECHNICAL_FAULT` (it is not).

## 2. Find the account

**Operations → Users**: at least 3 characters, a full email address or an account id
(`GET /api/v1/operations/support/accounts?q=…`, then `GET …/accounts/<userId>`). The email shows
masked (`a***@domain`); reveal it only with a reason (`ACCOUNT_RECOVERY`, `IDENTITY_VERIFICATION`,
`CUSTOMER_CALLBACK`, `PRIVACY_REQUEST`). Searches, views and reveals are audited.

Operations **cannot** see a student's learning path, attempts, skill state or planner decisions:
there is no operator screen for them (see [Gaps](#gaps)). Diagnose from what the caller reads out
and the table in §3; escalate to §4 when the table does not explain it.

## 3. Learning-engine questions and their answers

What the student sees is on the web **Learning** page and the Android **Learning** tab (the same
contract, `GET /api/v1/learning/path` and `POST /api/v1/learning/next-step`). Each next step shows
its reasons as sentences; the reason codes behind them are in `plannerReasonCodes`
(`packages/learning-orchestrator`).

| The caller says | What it means (from the code) | What to tell them | Close with |
|---|---|---|---|
| "My plan is the same order as everyone's / it doesn't adapt" (reason text *"Your plan follows your target role's order; it does not adapt to your answers."*) | Reason `NON_ADAPTIVE_NO_CONSENT`: the student does not hold the `adaptive-learning` consent purpose. On every pilot database today **no engine consent definition is published** (HG-6), so every student is on this path. After publication it also means the student has not granted it, or withdrew it. | The plan still works and follows the target role. Adaptive learning needs their permission, which ONE has not asked for yet (or they declined). | `RESOLVED` / `ANSWERED` |
| "It says I have not chosen a target role" | Reason `NO_CAREER_TARGET`: no live career target. | Choose a target role (student career targets / goals screen), then ask for the next step again. | `ANSWERED` |
| "A skill says *Not enough evidence* although I answered questions" | A band needs attempts on **two different days** (C3; enforced by `learner_skill_state_sufficiency_ck`). One sitting, however many questions, is never a band. | Practise that skill again on another day. This is deliberate: one good day is not evidence. | `ANSWERED` |
| "I got it right but it doesn't count / it says assisted" | An answer after hint level 3 or more is **assisted** and never counts toward DEMONSTRATED (C5). | Try a similar question without the last hints. | `ANSWERED` |
| "It says *You have a newer step. Reload to continue.*" | 409 `STEP_SUPERSEDED`: a newer next step exists (another device or tab). | Reload the Learning page. | `ANSWERED` |
| "*That is not the question you are on*" | 409 `NOT_CURRENT_QUESTION` (learning step or placement test). | Reload; the current question is shown. | `ANSWERED` |
| "The placement test won't start again" | 409 `ALREADY_COMPLETED`: the sitting finished. | Expected; results are on the Learning page. | `ANSWERED` |
| "I practised but my next step didn't change" | The skill state is recomputed **by the background worker** after each graded submission (outbox event `learning.skill_state.projection_requested`, consumer `learner-skill-state-projector`). If the worker is stalled, the step is planned from old state. | Check §3.1 before answering. If System Health is healthy, ask them to take the next step again. | `ANSWERED`, or keep open and escalate |
| "I withdrew adaptive learning — is my data deleted?" | Withdrawal (`POST /api/v1/me/consents/adaptive-learning/withdraw`) deletes their skill-state projection in the same transaction; their attempt history stays until a privacy deletion, which erases it (category `LEARNING_ACTIVITY`). | Their profile is gone; for full erasure they file a deletion request from their own account (see [sop-privacy.md](sop-privacy.md)). | category `PRIVACY_REQUEST` if they want erasure |
| "Show me my readiness score / percentage" | Readiness is an advisory band, never a number, and never shown to employers (ADR-020). | There is no score; the band and the requirement counts are what ONE shows. | `ANSWERED` |
| A lecturer: "My plan override did nothing" | A faculty override (INST-16) decides **one** step: it is applied by the student's next `next-step` and linked to that decision. | Ask the student to open their next step; the reason *faculty override* appears on it. | `ANSWERED` |

### 3.1 Is the background worker keeping up?

1. **Operations → System Health** (`GET /api/v1/operations/jobs/summary`). Read **Worker**:
   *Draining* is fine; *Stalled* means due work is not being picked up; *No work waiting* means
   liveness cannot be judged. Read **Alerts** (one row per breach: 10 failed events, or a due
   event waiting 30 minutes, by default).
2. **Failed events** (`GET /api/v1/operations/jobs/failed?eventType=learning.skill_state.projection_requested`):
   if the student's projection request failed, open it and **Replay** with reason
   `TRANSIENT_FAILURE_RESOLVED` (or `CONFIGURATION_FIXED`, `RECEIVER_RESTORED`,
   `INCIDENT_RECOVERY`, `CUSTOMER_REQUEST`) — `POST /api/v1/operations/outbox/<eventId>/replay`.
   Replaying is idempotent: the projector recomputes the student from facts.
3. Stalled worker or repeated failures: that is an incident — open
   [runbook-pilot-incident.md](runbook-pilot-incident.md), and note the incident on the case.

Note: the **Consumers** panel does not list `learner-skill-state-projector` (only the two
consumers in `knownJobConsumers`), so its last activity is not visible there; use the failed-event
list and the Worker state.

## 4. Escalating to engineering (Divakar, on the server)

These commands read or rebuild engine data; none calls a model, none prints learner data. They run
from the release directory with `DATABASE_URL` from `app.env` (never printed):

```
cd /srv/planthepath-next/current
corepack pnpm --silent --filter @planthepath/persistence engine:replay-decisions [<decision-id>]
corepack pnpm --silent --filter @planthepath/persistence engine:rebuild-skill-state
corepack pnpm --silent --filter @planthepath/persistence engine:bkt-shadow-report
```

| Command | What it does | Writes? | Read the result |
|---|---|---|---|
| `engine:replay-decisions` | Recomputes every stored planner decision (or one) from its stored inputs and compares (C4). | No | `{"event":"learning_decisions.replayed","checked":N,"matched":N,...}`. Exit code 1 if `matched ≠ checked`; the arrays name the decision ids that `mismatched`, have a `hashMismatch`, `invalidInputs` or `unsupportedPolicy`. Any non-empty array is a defect: open an incident (`DATA_INTEGRITY`). |
| `engine:rebuild-skill-state` | Recomputes `learner_skill_state` for every student with attempts or rows, from the attempt log, under the projector's per-student lock. Idempotent, safe beside the worker. | Only the projection | `{"event":"learner_skill_state.rebuilt","subjects":S,"written":W,"deleted":D}`. Students without `adaptive-learning` get no rows (`deleted` counts removals). |
| `engine:bkt-shadow-report` | The BKT shadow comparison for HG-5. | No | One JSON document of counts only; counts under the report's `suppressionThreshold` (5) are suppressed and `"suppressed": true` marks a report with too little consenting data — expected in the pilot. |

The decision id is not visible to operators; Divakar finds it from the student's id
(`SELECT id, decided_at, action, reason_codes FROM learning_decisions WHERE subject_user_id = '<id>' ORDER BY decided_at DESC LIMIT 5`).

## 5. Close the case

Note what you told the caller (`CASE_UPDATE`, `CUSTOMER_CONTACT` or `INTERNAL_FINDING`; no personal
data), then move it: `IN_PROGRESS` (`WORK_STARTED`) → `RESOLVED` (`FIXED`, `ANSWERED`,
`NO_FAULT_FOUND`, `REFERRED_ELSEWHERE`) → `CLOSED` (`CONFIRMED_WITH_CUSTOMER`, `NO_RESPONSE`).
API: `POST /api/v1/operations/support/cases/<id>/notes` and `…/transition` with `toState` and
`reasonCode`. `CLOSED` is final.

## Never do

- Never promise a student a band, a score or a date by which they will be "ready".
- Never ask for, or type into a case, marks, answers, attempt details or a student's email.
- Never run an engine command yourself or ask a college for a database extract; escalate (§4).
- Never tell a student to grant consent to "fix" their plan — consent is their choice, and the
  non-adaptive path is a working product.

## Gaps

Missing operator capabilities found while writing this runbook. None was built here.

1. **No operator view of a student's learning state** (path, latest decision and its reasons,
   skill-state freshness). Every engine question is answered from the caller's description; OPS-13
   (engine health panels) is the planned home.
2. **The skill-state projector is not listed in System Health → Consumers**
   (`knownJobConsumers` holds only student invitations and seeded content generation).
3. **Replay, rebuild and the shadow report are shell commands** with no route, screen or audit row;
   only Divakar can run them.
4. **Planner decision ids are not visible** to support, so a replay of "this student's step" needs a
   database query.

## Verified locally

Staging does not exist and production is out of bounds, so every step was executed on a local,
fresh PostgreSQL database `one_eng17`, migrated twice and seeded with the repository's seed
scripts (listed in [runbook-ai-kill-switch.md](runbook-ai-kill-switch.md#verified-locally)), through
the real controllers with a local test identity verifier. The student, staff and organisations were
synthetic; so was a **local-only** `adaptive-learning` consent definition used to exercise the
adaptive path (publishing the real one is HG-6).

RESULTS_SUPPORT

**Needs a real environment:** the §4 commands on the server (run here against the local database
instead), and the web/Android screens themselves (the same routes were exercised directly).
