# SOP — Campus drives (employer side) and the placement office's approval

> What this is: employer-facing help for asking a college to run a campus drive for a job, with
> the matching placement-office and operator steps. Why it exists: Appendix 2 EMP-18 asks for an
> SOP per shipped module; this covers EMP-11 (ADR-038). Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters of a **verified** employer whose owner has accepted the current
employer terms (once Operations has published terms).

### Where

**Employer Portal → Opportunity Detail → Campus drives**. Android shows each job's drives and the
college's decision read-only.

### Steps

1. Create the job with **Who can see it: Only colleges that approve a campus drive** (or use an
   existing job). You can publish such a job before any college decides; it reaches nobody until
   one approves, and the screen says so.
2. **Request a campus drive → Find a college** (verified, active colleges), add a proposed start
   and end, where, and an optional **Note to the placement office** → **Send request**.
3. Wait for the college. You cannot approve a drive yourself; only the college's placement office
   can.
4. If the college **asks for changes**, edit and **Send changes** (resubmit).
5. **Cancel drive** with a reason (`HIRING_ON_HOLD`, `ROLE_CANCELLED`, `POSITIONS_FILLED`,
   `SCHEDULE_UNWORKABLE`, `REQUESTED_IN_ERROR`), or **Mark complete** when it is over.
6. **History** lists every decision with its reason.

### What a drive changes, and what it does not

- Students at that college see and apply to the job **only while the drive is approved or
  scheduled**. Withdrawing approval hides it on the next request; existing applications stand.
- The college's placement policy applies to everyone who applies while a live drive exists at
  their college, whichever listing they used. With **one offer per student**, a student who has
  accepted an offer (or been hired) anywhere on ONE cannot apply, and is told why
  (`PLACEMENT_POLICY_ONE_OFFER`) before they try.
- A drive gives you **nothing extra about candidates**. You see an applicant only through the
  grant created when they apply ([sop-employer-candidates-and-offers.md](sop-employer-candidates-and-offers.md)).
- The college sees counts only after the drive is **completed**, and names only of students who
  shared their application with the college.

## Matching placement-office steps (college side)

The placement officer decides drives on their **Dashboard** (*Campus drive approvals*); a college
admin decides on **Placement** and sets policies in **Settings → Placement policies**. Deciding
needs an institution-wide write scope; department heads read, faculty cannot see drives.
Actions: **Approve**, **Ask for changes**, **Decline**, **Set date**, **Withdraw approval**,
**Mark complete**, each with a listed reason where one applies. **Put this policy in force**
sets one offer per student (optionally allowing per-drive exceptions). The college's full
procedure is in [../institution/sop-campus-drives.md](../institution/sop-campus-drives.md).

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A college says a drive appeared without its approval | Check the job's audiences: a job given a direct **college** audience (not a drive) reaches that college without approval today (EMP-SR-21). Log a case; if deliberate, open a trust case about the employer |
| A college cannot find an employer to approve | The employer must be verified and active; check **Organizations** |
| A drive cannot be approved (409) | The employer is not in good standing (suspended or unverified); see [../ops/sop-organizations.md](../ops/sop-organizations.md) |

## Gaps

- A direct college audience still bypasses approval and the college's policy (EMP-SR-21, open).
- The one-offer check at apply is not serialised with a concurrent offer acceptance.
- Drives cannot target one department. Approving a drive does not message the students.
- The `campus_drive.state_changed` event has no consumer; notices are in-app only.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J6.
