# SOP — Privacy and consent console (Security)

> What this is: the operator procedure for watching DPDP privacy requests, placing and
> releasing legal holds, and reading consent coverage. Why it exists: Appendix 1 OPS-17 (M1
> slice); journey J4 ("a student submits a data-deletion request"). Built by OPS-06, with the
> support-case detachment from OPS-05 and the engine purposes from ENG-01. Written 2026-09-26
> against base `6864332`.

## Purpose

Make every access and erasure request visible with its state, history and schedule; stop
erasure where the law requires records to be kept (a legal hold); and show consent coverage
without exposing individuals.

## Who and what capability

| Task | Capability | Baseline role |
|---|---|---|
| Request queue and detail | `PRIVACY_REQUESTS` | OPERATIONS_ADMIN, SECURITY_ADMIN |
| Place a hold | `PRIVACY_HOLDS` | SECURITY_ADMIN, OPERATIONS_ADMIN |
| Release a hold | `PRIVACY_HOLDS` **plus an approval** (`APPROVE_HIGH_RISK`) | — |

## Where

**Operations → Security**: Privacy requests, Legal holds, Consent coverage, Breach response
and incidents. The governance status shown before OPS-06 is kept beneath.

## A. Watch the request queue (daily)

1. Choose the view (**Open**, **Closed**, **All**, or one state) and optionally a **Request
   type** (export or deletion). Page with **Next page** / **Previous page**.
2. Stats: open data exports, open deletions, **erasures due in 7 days**, legal holds in force.
3. **View** a request to see its full state history, who acted (the person, ONE or operations —
   never an internal id), what a deletion did per data category, and holds on the person.
   Opening a request is audited (`operations.privacy_request.viewed`).

Requests are made by the person from their own account. The request runs itself: exports are
built and deletions run after the 30-day grace period (the date shown is the real
`deletion_scheduled_for`).

## B. A deletion request (J4)

1. Find it under **Open** → **View**. Confirm its state and scheduled date.
2. Check for a reason to keep data (an open dispute, a safety investigation, a regulator's
   request, an employer accountability case, a legal obligation). If there is one, place a
   hold (C) **before** the scheduled date.
3. Otherwise do nothing: the deletion completes on schedule. Afterwards the request detail
   shows what was done per category, and the person's support cases have lost their link to
   them (subject detached, summary replaced, notes redacted).
4. A request in a **failed** state: see Escalation.

## C. Place a legal hold

1. From the request's detail choose **Place a legal hold…**.
2. Choose the lawful basis: `LEGAL_OBLIGATION`, `SAFETY_INVESTIGATION`,
   `EMPLOYER_ACCOUNTABILITY_CASE`, `DISPUTE`, `REGULATORY_REQUEST`.
3. Save. The hold appears under **Legal holds** with the subject masked.

## D. Release a legal hold (dual control)

1. **Legal holds → Request release…** with `OBLIGATION_ENDED`, `CASE_CLOSED` or
   `ENTERED_IN_ERROR`.
2. A second approver approves in **Settings → Approvals**; **you** then **Execute** within 24
   hours ([sop-approvals.md](sop-approvals.md)). While a release is in flight the hold shows
   "awaiting approval" or "approved" with the next step instead of the button.

## E. Consent coverage

For each consent key: people on the live version, withdrawn, and on an older version. Any
count under 5, including 0, shows **<5**, and no total is shown (so a hidden cell cannot be
worked out). The engine purposes `adaptive-learning`, `ai-tutoring` and `model-improvement`
show **Not published** until their wording is approved (HG-6). Do not read that as zero
consent.

## Escalation

- **Failed** export or deletion: there is no retry button (Gap). Log a support case
  (`PRIVACY_REQUEST`, `MONITORING_ALERT`), check **System Health** for the related failed
  event and replay it there only if the cause is fixed. If not, this needs engineering.
- A personal-data breach: follow [runbook-breach-response.md](runbook-breach-response.md). The
  incident register is not built (OPS-16).

## Never do

- Never edit or browse a person's consent; there is deliberately no control for it.
- Never place a hold "just in case"; a hold stops a lawful erasure.
- Never copy request details out of ONE.

## Gaps (need engineering or a decision)

- **Statutory deadlines show NA.** No DPDP response period is set in code
  (`STATUTORY_RESPONSE_PERIOD_DAYS`), and the privacy notice draft still says "[TODO days]".
  Needs a legal answer (HG-6) and then a code change.
- **No operator actions on requests** (reject, retry a failed export).
- **A hold can be placed only from a request's detail.** Holding someone who has made no
  request needs engineering today.
- **Incident register** (J12) is not built — not in this slice.
- **Engine consent definitions** are unpublished until HG-6 approval.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J4, O-4 (legal hold).
