# SOP — Incident register and status notices (Security → Incident register; Settings → Status communications)

> What this is: the operator procedure for recording an incident in ONE, keeping its timeline,
> watching a personal-data breach's Board reporting clock, and telling the affected colleges and
> employers through an approved template. Why it exists: Appendix 1 OPS-17 (full) needs an SOP for
> every shipped module; journey J12 runs through it. Built by OPS-16, with the second-person notice
> approval from OPS-GAPS (migration 0090). Written 2026-10-01 against base `719eb34`.
>
> The step-by-step incident procedure is in [runbook-pilot-incident.md](runbook-pilot-incident.md)
> (§2 Declare, §4 status notices, §5 Resolve and close). The breach procedure is in
> [runbook-breach-response.md](runbook-breach-response.md). This SOP gives the console facts and
> does not repeat them.

## Purpose

Leave an in-product record of every incident: when it was detected, contained and resolved, which
organisations it affected, and who notified whom and when. Never let a free-text message go out to
colleges.

## Who and what capability

| Task | Capability | Baseline |
|---|---|---|
| Incident register | `INCIDENT_MANAGE` | SECURITY_ADMIN, super admin. **Not** OPERATIONS_ADMIN |
| Templates and notices | `COMMS_TEMPLATES` | OPERATIONS_ADMIN, super admin |
| Approve publishing a template | `APPROVE_HIGH_RISK` | super admin |
| Approve a notice for sending | `COMMS_TEMPLATES`, and not the drafter | — |

## Where

- **Operations → Security → Incident register.** It is below the privacy console and Access reviews.
- **Operations → Settings → Status communications.** It is below Approvals and Staff capabilities.

## A. Declare and run an incident

1. **Declare incident** and fill these fields:
   - **Title** (up to 120 characters) and **Summary** (up to 1,000). Neither may contain an email
     address or a phone number (`INCIDENT_TEXT_PERSONAL_DATA`), and neither can be changed later.
   - **Category**: `PERSONAL_DATA_BREACH`, `SECURITY`, `SERVICE_OUTAGE`, `DEGRADED_SERVICE`,
     `DATA_INTEGRITY` or `OTHER`.
   - **Severity**.
   - **Detected at**: the time of first reasonable suspicion, within the last 365 days.
   - **Reason**: `MONITORING_ALERT`, `CUSTOMER_REPORT`, `INTERNAL_DISCOVERY`, `THIRD_PARTY_REPORT`
     or `SUSPECTED_BREACH`.
2. **Add an affected organisation…** for each college or employer (`SCOPE_ASSESSED` or
   `NEW_EVIDENCE`). Remove one with `SCOPE_ASSESSED` or `ENTERED_IN_ERROR`.
3. Record each step with **Add to the timeline** (`TIMELINE_UPDATE`, `EVIDENCE_RECORDED`,
   `DECISION_RECORDED`, up to 500 characters, no personal data).
4. Move the incident along with its reason:
   - **Move to Contained…**: `ACCESS_PATH_CLOSED`, `CREDENTIAL_ROTATED`, `SERVICE_ISOLATED`,
     `MITIGATION_APPLIED`.
   - **Move to Resolved…**: `ROOT_CAUSE_FIXED`, `SERVICE_RESTORED`, `DATA_RESTORED`,
     `NO_IMPACT_CONFIRMED`.
   - **Move to Closed…**: `POST_INCIDENT_REVIEW_DONE`. An OPEN incident can only close as
     `DUPLICATE` or `FALSE_ALARM`.
   - **Reopen…** from Contained or Resolved: `RECURRENCE`, `CONTAINMENT_FAILED`, `NEW_EVIDENCE`.
   - Closed is final.
5. **Change severity…** (`ASSESSMENT_UPDATED`, `SCOPE_GREW`, `SCOPE_REDUCED`) and **Reclassify…**
   (`ASSESSMENT_UPDATED`, `CONFIRMED_PERSONAL_DATA`, `NO_PERSONAL_DATA_INVOLVED`).

## B. A personal-data breach (J12)

1. The register shows the **Board reporting clock**: 72 hours from **Detected at**, on the database
   clock. Its status is *Clock running*, *Deadline passed — Board not yet notified*, *Board notified
   in time* or *Board notified after the deadline*.
   - The 72 hours is the plan's period, **pending legal confirmation**.
   - The clock counts from Detected at even if the incident is reclassified as a breach later.
2. ONE never contacts the Data Protection Board or the affected people. When a person has done it
   outside ONE, record it:
   - **Record Board report…** (`BOARD_REPORT_FILED`, the time, and an optional acknowledgement
     reference);
   - **Record affected people told…** (`USERS_NOTIFIED_BY_EMAIL`, `USERS_NOTIFIED_BY_COLLEGE` or
     `USERS_NOTIFIED_OTHER_CHANNEL`).

   Each can be recorded once.
3. A breach cannot close until both are recorded (`INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING`).
   - A notified breach cannot be reclassified.
   - A false alarm is reclassified first (`NO_PERSONAL_DATA_INVOLVED`) and then closed.

## C. Templates (prepare them before the pilot)

1. **Draft a template version**: a key (lower-case letters, digits and hyphens), a subject, a body,
   and a reason (`NEW_TEMPLATE`, `WORDING_UPDATE` or `CORRECTION`). Press **Draft version**.
2. The draft's author presses **Ask for approval…** (`INCIDENT_COMMUNICATION`,
   `PLANNED_COMMUNICATION` or `WORDING_CORRECTION`). This files `COMMS_TEMPLATE_PUBLISH`, bound to
   the template's content.
3. An approver approves in Settings → Approvals. The author then presses **Publish…** (or Execute in
   Approvals) within 24 hours. The solo safeguard applies ([sop-approvals.md](sop-approvals.md)).
4. **Withdraw…** a draft with `SUPERSEDED`, `ENTERED_IN_ERROR` or `NOT_NEEDED`.

## D. Send a notice

1. **Draft a notice**: the incident, a **published** template, and `INITIAL_NOTICE`,
   `INCIDENT_UPDATE` or `RESOLUTION_NOTICE`. A notice has no free-text field.
2. **Another `COMMS_TEMPLATES` holder** presses **Approve for sending…** (`APPROVED_FOR_SEND`).
   - Your own approval is refused (`STATUS_NOTICE_SELF_APPROVAL_REFUSED`), except when you are the
     only holder: then **Approve for sending (solo)…** works 15 minutes after drafting and is marked SOLO.
   - In a one-person pilot, draft the notice first and contain while the 15 minutes run.
3. The notice goes to the ACTIVE owners and admins of the incident's affected organisations, and
   never to students.
   - It is limited to one per incident per 15 minutes and six per 24 hours (429
     `STATUS_NOTICE_RATE_LIMITED`).
   - It needs at least one affected organisation (`STATUS_NOTICE_NO_AUDIENCE`).
4. The incident shows, for each notice, who approved it and when, when it was sent, how many admins
   it reached, and the email outcome counts.

## What actually reaches people today

- The in-app notice and its email are delivered by the **automation worker**, which is **not yet
  deployed on AWS** (runbook-move-to-aws.md).
- The SMTP sender is built (ADR-042) but **not switched on in production**, and the sender mailbox
  is still to be set up.

Until both happen, a notice is recorded and shows **not sent — no mail service configured**.
**Tell affected college admins by phone as well, and record that as a timeline note.**

## Never do

- Never put a student's name, email, marks or answers in an incident, a note or a template.
- Never send a notice from a template you have not read in full.
- Never record the Board report before it has actually been filed.

## Gaps

- The incident register cannot be exported.
- Template publishing covers status-notice templates only. The `ops-failure` and
  `security-notification` templates that OPS-04 and OPS-02 wait for are not published from here.
- A `COMMS_TEMPLATES` holder without `INCIDENT_MANAGE` still sees open incident titles in the notice
  form (security review OPS-SR-39).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J12.
