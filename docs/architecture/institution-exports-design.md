# Institution Analytics Capability and CSV Exports — Design

**Status:** Adopted (INST-08), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** none — grants are `membership_capabilities` (0031, 0039); every export is an `audit_events` row
**Relates to:** ADR-018 (analytics is a capability, not a role), ADR-019, ADR-020 (bands only), ADR-024
(no compensation), `membership-capabilities-table-design.md`, INST-SR-01 (one suppression rule, one ended
month), INST-SR-02 (permanent writes fail closed), INST-SR-13 (formula injection on output)

## Why this exists

`INSTITUTION_ANALYTICS` has been grantable by API since 0031 and enforced nowhere (I-9; security review
§6). A college has no way to take its own roster, readiness picture, assessment marks or staff-action
workload out of ONE for its management, accreditation or placement planning, so it copies screens by
hand. An export is the riskiest read a college can make: the data leaves the platform, cannot be
recalled, and can be compared with the next export. This document is the rule set for doing it once,
correctly.

## Who may export

- **The grant is necessary and never sufficient.** `canReadInstitutionAnalytics` (ADR-018) decides per
  membership: ACTIVE, in this institution, role `INSTITUTION_ADMIN` or `DEPARTMENT_HEAD`, holding a live
  `INSTITUTION_ANALYTICS` row. Every other caller gets **403 on every export endpoint**, whatever else they
  hold. Owners are not in ADR-018's list and 0031's trigger refuses a grant to them, so an owner cannot
  export — see Decisions.
- **Scope comes from the membership that holds the grant, never from the caller's other memberships**
  (0031 table comment). A lecturer who is also a department head exports what the head membership covers,
  not the union.
- **The export scope is the write scope** (`institutionStudentWriteScope`, INST-SR-02), not the read
  scope. The read scope keeps a fallback — a department head with no department reads the whole college —
  because failing closed would empty today's screens; that product decision is still open. An export is
  not a screen: it leaves the platform. A capability-holding head with no department on their membership
  gets **403 `SCOPE_REQUIRED`** ("ask an admin to set your department"), exactly as for verification.
- Grant and revoke: owners and admins of the institution (unchanged, `platform-controls.controller.ts`),
  with a reason code both ways, no self-grant (unchanged), and now **an audit row in the same transaction**
  (`institution.analytics_capability.granted` / `.revoked`) and `revoked_reason_code` recorded (0039's
  column, until now written only by the operations path). The institution revoke path refuses any
  capability other than `INSTITUTION_ANALYTICS`: operations grants such as `CONTENT_REVIEW_EXTERNAL` are not
  the college's to remove.

## The four exports

All are `POST` (an export writes an audit row, so it is not a safe method) with a JSON body carrying
`reasonCode` (`^[A-Z0-9_:-]{3,64}$`). Unknown fields are refused. The response is `text/csv; charset=utf-8`
with a UTF-8 byte-order mark (so spreadsheet software reads non-ASCII names), CRLF line ends,
`Content-Disposition: attachment`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Export | Level | Period | Columns |
| --- | --- | --- | --- |
| Roster with activation state | per student, current relationships only | now | Student ID (the college's roll number), name, email, department, programme, batch, section, relationship state, activation state, invited on, last invitation sent |
| Readiness band distribution | aggregate, one table | one ended calendar month | Month, readiness band, students (`<5` below the threshold; the total row `Withheld` when it would recover a hidden band) |
| Assessment results (one assessment) | per student | the assessment | Student ID, name, attempt, status, auto-submitted, score, maximum, percentage, correct, wrong, not attempted, time taken, completed at — plus one row per assigned student with no completed attempt (`NOT_ATTEMPTED` / `IN_PROGRESS`, marks empty) |
| Staff-action summary | aggregate | one ended calendar month | Month, action type, students with at least one such action opened that month, actions opened that month — each cell `<5` below the threshold, no totals |

### What is never in any export

- **No internal identifier.** No user, profile, membership, relationship, unit, definition or action id;
  units appear by name; students by the college's own roll number. The assessment is chosen by id in the
  request but the file names it by title.
- **No numeric readiness** (ADR-020): readiness appears only as band names and suppressed band counts.
  Assessment marks are the college's own test marks, not readiness, and no column is named or derived
  from readiness.
- **No compensation** (ADR-024): no export reads `offers`; every header is checked against
  `institutionForbiddenDisclosureFields` in the writer and the export fails closed if one ever appears.
- **No application data** (ADR-019): applications are INST-09 / INST-12's, with their own consent rule.
- **No free text written by staff** (notes, titles, outcome notes): the staff-action export is counts only,
  so nothing typed about a student leaves in a file.

### Suppression and the differencing hole

INST-SR-01 closed two holes in the readiness report: small cells, and two overlapping windows compared to
isolate one student. The exports must not reopen either.

- **Aggregates go through `suppressAggregateTable` / `suppressSmallCount` only.** The readiness export
  *is* the report: it calls `generateInstitutionAggregateReport` with the export scope, so the file and
  the screen can never disagree, and the stored report id is recorded in the export's audit row.
- **Aggregates cover exactly one calendar month that has ended** (`institutionReportingMonth`,
  `REPORT_PERIOD_INVALID` otherwise), for the staff-action summary as well: a month's counts of actions
  *opened* in it are fixed once the month ends, so re-exporting gives the same file. Current state
  ("open now") was rejected: it changes daily, and two exports a day apart isolate one student's case.
- **One table per scope, never broken down by unit.** A department breakdown beside the college total is
  a set of linked tables: college 7, department A 5, department B withheld — and B is 2 by subtraction.
  The caller's scope is the only table; a head exports their department, an admin the college.
- **No unit filter on aggregates.** A filter would turn one export into many overlapping ones. Per-student
  exports (roster, results) take an optional unit filter, because they suppress nothing a filter could
  recover.
- The staff-action summary has no total row and its cells do not partition anything, so there is no
  complementary cell to protect; each cell is suppressed on its own.

Residual (as INST-SR-01 recorded for the report): a relationship or unit change after a month ends can
change that month's counts. Noted, not fixed.

### Formula injection (INST-SR-13)

Encoded **on output**, in one writer: every text cell whose first character is `=`, `+`, `-`, `@`, tab or
carriage return is prefixed with `'`; every cell is quoted and embedded quotes doubled. Numbers the
server produced are written as numbers. Stored values are never altered for this.

### Size, rate and audit

- **Size:** at most 10 000 data rows per export. Above that the export is refused (422 `EXPORT_TOO_LARGE`)
  and nothing is audited as exported; the roster and results screens tell the user to narrow by unit.
- **Rate:** at most 30 exports per person per institution in any 24 hours (429 `EXPORT_RATE_LIMITED`),
  counted from the audit rows under a per-person advisory lock so two concurrent requests cannot both
  pass the last slot.
- **Audit:** one `audit_events` row per export, `SUCCESS`, action `institution.<kind>.exported`
  (§5.3 "audited as *.exported"), written and committed **before** the file is sent: who (actor), when,
  what (kind, scope kind and anchor units, month or assessment, unit filter, row count, report id) and
  why (`reasonCode`), plus the membership and grant that authorised it. A refused export by institution
  staff without the capability writes `institution.export.denied` (`DENIED`).

## Surfaces

- **Web:** the admin **Staff** page gains an "Analytics and exports access" panel (grant/revoke with
  reason codes). The admin **Reports** page and the department head's **Reports and Analytics** page gain
  an Exports panel below the readiness report. Navigation is unchanged (HG-3). The panel makes no request
  until the user acts: a caller without the capability learns so from the 403 of their first export,
  with who can grant it.
- **Android:** none. Exports are files for a desk (a spreadsheet for management or an accreditation
  pack), and granting access is an admin desk task like the other Settings/Staff controls the Android
  institution workspace does not carry. The Android app has no readiness report either.

## Rejected options

- **A new `institution_exports` table** (an export ledger with stored files). Rejected: nothing reads it
  back, `audit_events` already answers "who exported what, when and why", and a stored file is a second
  copy of student data to protect and delete.
- **A separate `INSTITUTION_EXPORT` capability** (open question 4 of the capability design). Rejected for
  now: one capability until there is a real read-only analytics surface to separate from exporting; the
  split stays cheap while the set has one member.
- **GET with query parameters.** Rejected: an export has a side effect (audit, rate count) and needs a
  reason code, which does not belong in a URL or a proxy log.
- **Per-department readiness tables in one file.** Rejected: linked tables (above).
- **Exporting under the read scope.** Rejected: an unscoped head would export the whole college.

## Decisions for Divakar

1. **Owners cannot export** (ADR-018 names admin and department head only; 0031's trigger enforces it).
   Recommended: keep it. An owner who wants exports holds an admin membership as well, and grants
   themselves nothing — another owner or admin grants it.
2. **The export scope is the write scope**: a head without a department cannot export. Recommended: keep,
   whatever is decided later for reads.
3. **Roster export covers current relationships only** (VERIFIED, ACTIVE). Alumni belong to INST-10's
   lifecycle work and INST-13's outcome exports.
4. **Limits:** 10 000 rows, 30 exports per person per day. Adjust with evidence.
