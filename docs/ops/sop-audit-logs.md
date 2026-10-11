# SOP — Audit Logs (search)

> What this is: the operator procedure for searching ONE's audit log, for instance to check what
> happened after a support call or during an incident. Why it exists: Appendix 1 OPS-17 (full)
> needs an SOP for every shipped module, and every other SOP's checks end here. Written 2026-10-01
> against base `719eb34`.

## Who and what capability

`SECURITY_AUDIT_SEARCH`. All three platform roles hold it by baseline.

## Where

**Operations → Audit Logs.**

## Steps

1. Filter by any of these:
   - **Action prefix**, for example `operations.support` or `organization`;
   - **Outcome**: Any, SUCCESS or DENIED;
   - **Correlation ID**: exact match, taken from the reference an error screen showed;
   - **From** and **To** dates.
2. **Search.** Page with **Previous** and **Next**. Each page holds up to 200 rows, newest first.
3. Each row shows when it occurred, the action, the outcome, the resource, the actor (an internal id)
   and the correlation ID.

## Read the dates carefully

**From** and **To** are midnight UTC. **To** therefore *excludes* the day you pick, and anything
before 05:30 IST on the next day. To include a day, set **To** to the following day (security review
OPS-SR-36).

## Never do

- Never copy audit rows out of ONE. A row's context can carry notes, ids and approval details.
- Never use a `%` or `_` in the action prefix to "search everything". They are wildcards today.
- Never treat a missing row as proof that something did not happen. Some actions are not audited
  yet: ordinary feature-flag changes (OPS-SR-33), trust-case transitions and actions (OPS-SR-28/29),
  and read-only analytics.

## Gaps

- Searches are not themselves audited, though results can include personal data in their context
  (OPS-SR-36).
- There is no export.
- The audit table has no database guard against change (OPS-SR-03).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-16.
