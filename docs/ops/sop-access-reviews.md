# SOP — Quarterly access reviews (Security → Access reviews)

> What this is: the operator procedure for the quarterly review of internal access. Why it
> exists: ISO/IEC 27001 and the security go-live gate expect privileged access to be reviewed
> periodically, with evidence (Appendix 1 D6, journey J11). Built by OPS-15. Written 2026-09-29.
> Design: `docs/architecture/access-review-campaigns-table-design.md`.

## Who

Anyone holding `SECURITY_ACCESS_REVIEW`:

- by baseline: `SECURITY_ADMIN` and `PLATFORM_SUPER_ADMIN`;
- by grant: an `OPERATIONS_ADMIN`, from Settings.

Other staff see "Not permitted" on this panel. The privacy console above it is unaffected.

## When

- Once a quarter. The next review is due three calendar months after the last one closed.
- Finish a review within 30 days of opening it.
- Open an extra review after a security incident (`POST_INCIDENT_REVIEW`) or when an auditor asks for one (`AUDIT_REQUEST`).

The status tile says **Never reviewed**, **Overdue** or **Open review overdue** whenever a review is late, and a red line under the tiles says why.

## Steps

1. **Security → Access reviews → Open access review…** Choose a reason (`QUARTERLY_REVIEW` for the routine one).

   Every ACTIVE platform staff role, every live internal capability grant and every faculty content-review grant is frozen into the review. Anything granted afterwards is reviewed next time.

2. **Decide each item.** For each one, check who holds it, who granted it and when, and whether it is still needed.

   - **Keep…**: choose `STILL_REQUIRED`, `ROLE_REQUIRES_IT` or `TEMPORARY_COVER_CONTINUES`.
   - **Revoke…**: choose `NO_LONGER_REQUIRED`, `LEAVER`, `EXCESSIVE_PRIVILEGE`, `UNRECOGNISED_GRANT` or `SECURITY_INCIDENT`.

   A revocation takes effect at once:

   - a grant is revoked (reason `ACCESS_REVIEW_OUTCOME`);
   - a faculty grant also closes that person's open review assignments;
   - a staff role is **suspended**, and its grants are revoked.

   The audit log records each revocation with the review's reference. "Access had already ended" means it was removed some other way before your decision; the decision is still recorded.

3. **Your own access.** You cannot decide your own items; another reviewer must. If you are the **only** reviewer, you may **keep** your own access 15 minutes after the review opened. The decision is marked **SOLO** on the screen, in the audit log and in the export, and this switches off as soon as a second reviewer exists. You can never revoke your own access here.

4. **Close review…** is available once every item is decided. A closed review cannot change.

5. **Export CSV…** (reason `AUDIT_EVIDENCE`, `CERTIFICATION_EVIDENCE` or `INTERNAL_RECORD`). The file has one row per item and contains staff and faculty emails but no student data. The audit log records the export with the file's SHA-256. Keep the file with the quarter's security evidence.

## Limits

- The last active super admin cannot be suspended by a review.
- A suspended staff membership has no screen to reactivate it. Reactivation is a data change by engineering (see sop-staff-capabilities G1).
- College-granted `INSTITUTION_ANALYTICS` is reviewed by each college, not here.
