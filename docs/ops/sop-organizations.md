# SOP — Organizations, verification, first administrators and employer access requests

> What this is: the operator procedure for onboarding a college or employer, moving it through
> verification, suspending or reinstating it, inviting its first administrator, chasing stuck
> invitations and working the employer access request queue. Why it exists: Appendix 1
> OPS-17 (M1 slice) and Appendix 2 EMP-18 ("the matching operator steps") need one procedure
> a single operator can follow. Covers what EMP-01, EMP-03, EMP-04, OPS-01 and OPS-02 built.
> Written 2026-09-26 against base `6864332`; updated 2026-10-01 against base `719eb34` (OPS-17
> full: employer terms, college data terms and exits, the college account panel).

## Purpose

Bring an organisation onto ONE and keep its verification state true. Verification state
decides what an employer may do (Appendix 2 §5.1):

| State | Employer may |
|---|---|
| PENDING, UNDER_REVIEW | Company profile, team, draft jobs. No publishing, no candidate data |
| VERIFIED | Everything its roles allow |
| REJECTED, SUSPENDED | Read its own status only |

## Who and what capability

| Task | Capability | Baseline role |
|---|---|---|
| Create or edit an organisation, invite its first administrator, decide an access request, see invitation tracking | `OPS_ORG_MANAGE` | OPERATIONS_ADMIN |
| Begin review, verify, reject, reinstate | `OPS_VERIFY` | OPERATIONS_ADMIN |
| Suspend | `OPS_VERIFY` **plus an approval** from someone with `APPROVE_HIGH_RISK` | — |

## Where

**Operations → Organizations** (the **Verification** and **Organization Detail** items open
the same screen). Invitation tracking is on **Operations → Users**, below the account lookup.

## A. Onboard a new organisation

1. Confirm the organisation is real before creating anything: its website, a named contact
   at a role address on the organisation's own domain, and (for a college) its affiliation.
   Record what you checked in a support case (category `ONBOARDING`) if a question arises.
2. In **Add Organization** choose **Type** (Institution or Employer), enter **Legal Name**,
   **Country** and the other profile fields, and submit.
3. The new row appears as **PENDING**. Choose **Begin review** → it moves to UNDER_REVIEW.
4. When your checks are complete choose **Verify** (or **Reject** if they fail).
5. Choose **Invite admin** and enter the first administrator's work email.
   - For an **employer** the first invitation creates an **EMPLOYER_OWNER** (EMP-01).
   - For a **college** it creates the institution administrator.
6. Check **Operations → Users → Invitation tracking** for the invitation. Its delivery state
   tells you whether it was emailed (see Gap G1).
7. When the person accepts, the invitation shows as accepted and the organisation's
   **Initial Admin** column fills.

Allowed transitions: PENDING → UNDER_REVIEW; UNDER_REVIEW → VERIFIED or REJECTED;
VERIFIED → SUSPENDED (approval required); SUSPENDED → UNDER_REVIEW or VERIFIED. Anything
else is refused with "Verification transition was rejected by policy."

## B. Suspend an organisation (dual control)

1. On the organisation's row choose **Suspend…**. The dialog shows the effect: the
   organisation is deactivated and **its published jobs are paused**.
2. Pick a reason code and file the request. Reason codes: `POLICY_VIOLATION`,
   `FRAUD_SUSPECTED`, `CONTRACT_ENDED`, `ORGANISATION_REQUEST`.
3. The request goes to **Settings → Approvals**. A second person with `APPROVE_HIGH_RISK`
   approves it (or you, alone, after the 15-minute cooling-off when you are the only
   approver — see [sop-approvals.md](sop-approvals.md)).
4. **You** (the requester) then choose **Execute** on the approved request within 24 hours of
   filing it. The suspension happens then, not before.
5. Confirm: the row shows SUSPENDED; the employer's staff see a status page; students no
   longer see its jobs.

**Reinstating** (SUSPENDED → VERIFIED or UNDER_REVIEW) needs no approval. Jobs paused by the
suspension **stay paused**; the employer republishes each one.

## C. Employer access requests (from the public "Request employer access" form)

A company can ask for access at `/employer-access` (linked from sign-in). The request creates
**nothing** — no user, organisation or invitation. It only appears in the queue.

1. On **Organizations**, open the **Employer access requests** section. Every request is
   PENDING until you decide it; its email is **unconfirmed** (nobody has proved they own it).
2. Check the review signals shown (possible matching organisations, free-mail flag).
3. Decide with one of:
   - **Mark onboarded** — only after you have created (section A) or found the organisation.
     Reasons `ORGANISATION_CREATED`, `EXISTING_ORGANISATION`. It links the request to that
     organisation and changes nothing about its verification.
   - **Decline** — `NOT_AN_EMPLOYER`, `COULD_NOT_CONFIRM`, `DUPLICATE_REQUEST`, `OUT_OF_SCOPE`.
   - **Spam** — `BULK_SUBMISSION`, `FAKE_DETAILS`, `ABUSIVE_CONTENT`.
4. There is no reply email to the requester (Gap G1). If you need to contact them, use the
   organisation's published contact route, never only the address typed into the form.

## D. Chase a stuck invitation

1. **Operations → Users → Invitation tracking**; search by email or organisation.
2. For an organisation's first administrator that expired or was never delivered, issue a
   new one with **Invite admin** on the Organizations row.
3. A **student** invitation is the college's to resend (Students → Resend invitation), not
   Operations'. Tell the caller so, and log the call as a support case
   ([sop-support.md](sop-support.md)).

## Reason codes

- Suspension: listed in B.
- Access request decisions: listed in C.
- **Begin review, Verify, Reject and reinstatement carry no reason you choose** — see Gap G2.

## Escalation

- Suspected fraud or misuse by a verified organisation: open or find the Trust and Safety case
  ([sop-trust-safety.md](sop-trust-safety.md)), then suspend (B) quoting the case, and open a
  support case. Trust and Safety enforcement actions do not suspend anything by themselves.
- A request refused with `APPROVAL_REQUIRED`, `APPROVAL_EXPIRED` or
  `APPROVAL_PAYLOAD_MISMATCH`: file a fresh request; do not try to work around it.

## Never do

- Never verify on the strength of the access-request form alone.
- Never suspend without an approval, and never ask someone to approve a request they have not
  read.
- Never add, import or move students from Operations — that is the college's job.
- **Never use "Edit details" to change one field.** The prompt sends the whole profile and
  can blank address fields that you leave empty (pre-existing defect; see the operations
  security review). Re-enter every field, or leave the record alone and log a case.

## Gaps (need engineering or not built)

- **G1 — Outgoing email is not switched on in production.** The SMTP sender is built (ADR-042,
  migration 0094) but not switched on, and the sender mailbox is still to be set up
  ([runbook-mail-sender.md](runbook-mail-sender.md)). Until it is, invitations are recorded and the
  delivery state says "not sent"; first-administrator onboarding in production needs the link to
  reach the person another way.
- **G2 — No operator-chosen reason on verification transitions.** The screen records a fixed
  code for Begin review / Verify / Reject / reinstate. Write your reasoning in a support case
  until this is fixed (finding in the operations security review).
- **G3 — Feature enablement for one college** (journey J6) has no organisation-override API; not
  built ([sop-feature-flags.md](sop-feature-flags.md)).
- **G4 — Changing an organisation's role for a person** has no screen: end and re-invite.

## E. Terms, college exits and the account panel (sections below the table)

- **Employer terms** → **Manage employer terms** → **Publish employer terms** (`OPS_ORG_MANAGE`):
  version, title, body, legal-review state, whether it needs re-acceptance, change summary →
  **Publish version**. The legal text is a **draft for legal review** (HG-6): publish as
  `DRAFT_FOR_LEGAL_REVIEW` (shown everywhere as "Draft — pending legal review"), and as
  `LEGAL_APPROVED` only with the legal reviewer's reference. A material version blocks every
  employer's next publish until an owner accepts it, and one operator can publish it — read it
  twice (security review OPS-SR-38). Versions can never be edited.
- **Institution data-processing terms** and **College exits** — follow
  [../institution/sop-college-exit.md](../institution/sop-college-exit.md). The purge after the
  90-day retention needs an `INSTITUTION_DATA_PURGE` approval ([sop-approvals.md](sop-approvals.md)).
- **College account** fields and contacts (Organization Detail) — [sop-college-accounts.md](sop-college-accounts.md).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J1 (onboard a college),
O-2 (employer access request), O-18 (employer terms); [ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J1, J2.
