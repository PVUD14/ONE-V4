# SOP — Support desk and account lookup

> What this is: the operator procedure for logging and working support cases and for looking
> up an account with masked contacts. Why it exists: Appendix 1 OPS-17 (M1 slice) requires an
> SOP for every shipped module; journey J2 ("a TPO phones about a student who cannot sign in")
> runs through it. Built by OPS-05. Written 2026-09-26 against base `6864332`; re-checked
> 2026-10-01 against base `719eb34` (the support code is unchanged; the known findings are noted
> under Gaps).

## Purpose

Record every contact from a user or college as a case with a severity-based target time, find
the account involved without exposing more personal data than the task needs, and close the
case with a recorded outcome.

## Who and what capability

| Task | Capability | Baseline role |
|---|---|---|
| Open, assign, note, move and resolve cases | `SUPPORT_CASES` | OPERATIONS_ADMIN |
| Account lookup, account timeline, contact reveal | `SUPPORT_ACCOUNT_LOOKUP` | OPERATIONS_ADMIN, SECURITY_ADMIN |

SECURITY_ADMIN can look accounts up but cannot work the case desk unless granted
`SUPPORT_CASES` ([sop-staff-capabilities.md](sop-staff-capabilities.md)).

## Where

- Cases: **Operations → Support**.
- Accounts: **Operations → Users** (and **User Detail**, the same screen).

## A. Log a case (target: under a minute)

1. **Support → New case** (or **Open case**).
2. The dialog defaults to channel **PHONE**, severity **MEDIUM** and reason
   **CUSTOMER_CONTACT**. Change what does not fit:
   - Channel: `EMAIL`, `PHONE`, `WHATSAPP`, `IN_APP`.
   - Category: `ACCOUNT_ACCESS`, `INVITATION`, `ONBOARDING`, `DATA_CORRECTION`,
     `PRIVACY_REQUEST`, `TECHNICAL_FAULT`, `HOW_TO`, `COMPLAINT`, `OTHER`.
   - Severity (fixed once opened) and its target: `URGENT` 4 h, `HIGH` 24 h, `MEDIUM` 72 h,
     `LOW` 120 h (calendar hours).
   - Open reason: `CUSTOMER_CONTACT`, `OPERATOR_FOLLOW_UP`, `INSTITUTION_ESCALATION`,
     `MONITORING_ALERT`.
3. Type a one-line **summary** with **no personal data** — no names, emails, phone numbers,
   marks or document contents. Write "Student cannot sign in after invitation", not who.
4. Save. The case is OPEN with its SLA target stamped by the server.

## B. Look up the account involved

1. **Users** → search with at least 3 characters, a full email address, or an account id.
   The lookup cannot list every account.
2. **View account**. You see the account state, memberships, student relationships,
   invitations and recent activity. The email shows masked (`a***@domain`); the phone slot
   shows **NA** because ONE stores no phone number.
3. Only if the task truly needs the full email (for example, to confirm it matches what the
   caller reads out), choose **Reveal contact…** and pick a reason: `ACCOUNT_RECOVERY`,
   `IDENTITY_VERIFICATION`, `CUSTOMER_CALLBACK`, `PRIVACY_REQUEST`. The reveal is audited
   against your name.
4. Searching and viewing are audited too; the search text itself is not stored.

## C. Work the case

1. **Assign** it (reasons `TAKE_OWNERSHIP`, `REBALANCE`, `ESCALATION`, `CORRECTION`). Only
   staff holding `SUPPORT_CASES` can be assignees.
2. **Add a note** for each step (reasons `CASE_UPDATE`, `CUSTOMER_CONTACT`,
   `INTERNAL_FINDING`) — again, no personal data.
3. **Move to** the next state with its reason:

| To | Allowed from | Reasons |
|---|---|---|
| IN_PROGRESS | OPEN, WAITING_ON_CUSTOMER, RESOLVED | `WORK_STARTED`, `CUSTOMER_REPLIED`, `REOPENED_NOT_FIXED` |
| WAITING_ON_CUSTOMER | OPEN, IN_PROGRESS | `INFORMATION_REQUESTED`, `CONFIRMATION_REQUESTED` |
| RESOLVED | OPEN, IN_PROGRESS, WAITING_ON_CUSTOMER | `FIXED`, `ANSWERED`, `NO_FAULT_FOUND`, `REFERRED_ELSEWHERE` |
| CLOSED | OPEN, WAITING_ON_CUSTOMER, RESOLVED | `CONFIRMED_WITH_CUSTOMER`, `NO_RESPONSE`, `DUPLICATE`, `MISDIRECTED` |

   CLOSED is final. Close from OPEN only for a duplicate or misdirected contact.

## Common case: "a student cannot sign in" (J2)

1. Log the case (A): category `ACCOUNT_ACCESS`, channel as it arrived.
2. Look the student up (B). Read the account state and the student invitation:
   - Invitation **pending / expired / not delivered** → the college resends it from
     **Students → Resend invitation** (reason `NOT_RECEIVED` or `LINK_EXPIRED`). Tell the TPO
     exactly that; Operations cannot resend a student invitation.
   - Invitation **accepted** and account active → the problem is the sign-in itself (password
     or Cognito). Password resets happen through the sign-in screen's own recovery flow.
3. Note what you told the caller, move to RESOLVED (`ANSWERED` or `FIXED`), and CLOSED once
   they confirm (`CONFIRMED_WITH_CUSTOMER`) or after no reply (`NO_RESPONSE`).

## Privacy deletion and cases

When a person's deletion completes, their cases lose the link to them automatically: the
subject is detached, the summary replaced and the notes redacted. Do not re-type their details
into a note to "keep context".

## Escalation

- A fault you cannot resolve from the console (a failed background event, a bug): note the
  on-screen reference, check **System Health** ([sop-system-health.md](sop-system-health.md)),
  and if it is a code defect it needs engineering — say so in the case and set it to
  WAITING_ON_CUSTOMER with `INFORMATION_REQUESTED` only if you are waiting on the user.
- A privacy request (access or erasure) made by phone or email: log it with category
  `PRIVACY_REQUEST`; the person must submit it from their own account (Settings → privacy) so
  it is authenticated. See [sop-privacy.md](sop-privacy.md).

## Never do

- Never put personal data in a summary or note.
- Never reveal a contact "just to see".
- Never impersonate a user or ask for their password; ONE has no impersonation, by design.
- Never attach files or paste screenshots of a user's data into a case (attachments are not
  supported, deliberately).

## Gaps (need engineering or not built)

- A case cannot be linked to the account view; search for the account each time.
- No email ingestion or attachments (out of scope for OPS-05).
- Resetting a user's password or unlocking a Cognito account from the console is not built;
  the user uses the sign-in recovery flow. A locked-out staff account needs Divakar in AWS
  (see [runbook-staff-pool.md](runbook-staff-pool.md) for staff).

- **Known findings still open (security review):**
  - The case queue returns summaries without an audit record (OPS-SR-05). This is one more reason
    to keep summaries free of personal data.
  - A 3-character search can page through every account (OPS-SR-08). Search for the person you
    need, not a common fragment.
  - A case can be opened about an erased person (OPS-SR-09). Check the account state first.
  - A reveal can quote a case about someone else (OPS-SR-10). Quote the case about this person.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J2.
