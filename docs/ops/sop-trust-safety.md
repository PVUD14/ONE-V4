# SOP — Trust and Safety (cases about employers, jobs and conversations)

> What this is: the operator procedure for the Trust and Safety screen as it is built today:
> opening a case from a detector signal, triaging it, asking the employer to respond, reading the
> timeline and sharing a decision. Why it exists: Appendix 1 OPS-17 (full) needs an SOP for every
> shipped module; journey J5 runs through it. It is built from the Trust and Safety module (0032),
> EMP-10's reported conversations and EMP-16's employer response and appeal. Written 2026-10-01
> against base `719eb34`.

## Read this first: what is not usable yet

- **Enforcement is not usable from the console.** The screen has no button to decide a case, record
  an enforcement action or decide an appeal.
- An action recorded through the API changes nothing for the employer: nothing reads it. It also
  needs no approval and writes no audit row (security review OPS-SR-28).
- **To stop an employer, suspend the organisation** through Organizations (dual control,
  [sop-organizations.md](sop-organizations.md) §B). Reference the case in the suspension request's
  context and in a support case.

## Who and what capability

`TRUST_SAFETY_INVESTIGATE` covers everything on the screen. `TRUST_SAFETY_ENFORCE` covers the
API-only enforcement route. All three platform roles hold both by baseline.

## Where

**Operations → Trust and Safety.** The tiles are Open cases, High or critical, Signals awaiting
review, and Live enforcement actions.

## Steps

1. **Detector signals awaiting review** → **Open case**. This opens a moderation case on the job.
   A payment-demand signal opens as CRITICAL.
2. A student who reports a conversation opens a case automatically. **Reported conversation** shows
   the thread. Opening it is audited.
3. **Triage** the case. The reason is recorded as `OPERATIONS_REVIEW`.
4. For a case about an employer, open the **Timeline**, write a **Summary of the concern…** and
   choose **Share and ask for response**.
   - The employer reads the summary word for word, so **never identify the reporter**.
   - The case moves to AWAITING_RESPONSE.
   - The employer's response moves it to UNDER_INVESTIGATION and appears on the timeline.
5. When a decision has been made (outside the screen, see above), write a **Decision summary** and
   **Share decision**.
   - The employer can appeal once.
   - The appeal appears on the timeline.
   - There is no way to reverse an action on appeal yet.

## Never do

- Never put the reporter's identity, a student's name or message text into a summary the employer
  will read.
- Never treat a case as enforced because an action row exists. Check the organisation's state.
- Never decide or act on a case you reported yourself. The database refuses the state change, but
  the action route does not check (OPS-SR-28).

## Gaps (journey J5 is only partly met)

- The screen cannot open a case without a signal, add evidence after opening, decide, dismiss,
  close, record an action, or decide an appeal.
- Enforcement actions have no effect, no approval, no reason code and no audit row. There is no
  reversal.
- Transition reasons are free text, and transitions write no audit row (OPS-SR-29).
- The case list is capped at 100 rows, without paging. Cases have no assignee.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J5 (partly built, marked).
