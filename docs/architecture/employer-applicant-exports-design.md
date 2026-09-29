# Employer Applicant Exports and Calendar Integration — Design

**Status:** Adopted (EMP-17). The plan's recommended answers are taken (AGENTS.md: "ask once, recommend, carry on").
**Date:** 2026-09-30
**Migration:** none. Every export is an `audit_events` row. The file is never stored.
**Relates to:** Appendix 2 §5.1 (role matrix: owners and admins export), §5.2 (no grant, no data), §5.3 (no readiness),
§5.4 (no protected attribute), decisions 10.2 #9 and #10; EMP-SR-01 (`liveApplicantGrantCondition`), EMP-07
(`application_profile_snapshots`, `employerSnapshotView`), EMP-09 (`.ics` invites), EMP-16 (grant expiry sweep),
INST-08 (`institution-exports-design.md`: the CSV writer, caps, per-person limit, audit before sending).

## Why this exists

An employer's hiring team works in spreadsheets as well as in ONE: a shortlist goes to a hiring committee or into an
interview plan. Today the only way to get it is to copy the Applicants screen by hand. A copy made that way carries no
record of who took it or why, and it ignores the student's grant. An export is the riskiest read an employer can make:
the data leaves ONE and cannot be recalled. This document sets the rules for doing it once, correctly.

## Who may export

- `requireActiveEmployer(…, 'candidates', ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'])`. An ACTIVE owner or admin membership
  is required, in a VERIFIED and active employer. The §5.1 matrix gives recruiters no export (decision 10.2 #10), and
  they get 403 `FORBIDDEN`. An unverified employer gets `EMPLOYER_ORGANISATION_UNVERIFIED`, and a suspended or
  rejected one gets `EMPLOYER_ORGANISATION_INACTIVE`, exactly as for every other candidate read.
- The job must belong to the employer. Any other job gets 403 `FORBIDDEN`, and nothing reveals whether it exists.

## What is in the file

`POST /api/v1/employers/:employerId/opportunities/:opportunityId/applicant-export` with the body
`{ reasonCode, scope? }`:

- `reasonCode` comes from a fixed list: `SHORTLIST_REVIEW`, `INTERVIEW_PLANNING`, `HIRING_COMMITTEE`,
  `OFFER_PREPARATION` or `RECORD_KEEPING`.
- `scope` is `ALL_OPEN` (the default) or `SHORTLISTED_ONWARD`.
- Unknown fields are refused.

The response has the same headers as INST-08: `text/csv`, BOM, CRLF, `attachment`, `no-store`, `nosniff`.

**Rows.** An application is written only when all of these hold:

- It is this employer's application for this job, and not a draft.
- Its grant is live at the moment of export, checked by `applicationHasLiveApplicantGrant`, the one EMP-SR-01
  predicate on the database clock. That excludes a revoked grant (withdrawal, rejection, close, revoked sharing,
  deletion), an expired grant (EMP-16's sweep, and also an `expires_at` in the past that the sweep has not yet reached),
  a student with an open deletion request, and a deleted or anonymised account.
- The student has not revoked consent (`consent_revoked_at IS NULL`). The grant check already covers this; it is
  kept for defence in depth.
- It is in the chosen scope.

The query and the audit row run in one transaction, so the file and its record describe the same moment.

**Columns: only what the student shared.** Every value comes from the frozen EMP-07 snapshot, read through
`employerSnapshotView`. That function already applies decisions 10.2 #9 and #10: contact details appear only from
SHORTLISTED onward, and a phone number only if the student added one.

- Candidate, Email, Phone
- Contact details (`Shown` / `Shown from Shortlisted`)
- College, Programme, Department, Expected graduation year
- Qualifications (type, programme, college, years, `verified`/`self-reported`)
- Headline, Summary, Links, Résumé shared (Yes/No)
- Stage, Applied on
- Snapshot (`Shared` / `Not captured`)

An application made before snapshots existed (before EMP-07) has no snapshot. It is listed with `Not captured` and
every shared column blank. The file never falls back to the live profile or the roster, because the student never
shared those with this employer.

**Never in the file:**

- No internal identifier: no application, user or job id. The job appears by title in the filename.
- No readiness band, score, gap status, mastery or fit number.
- No eligibility figures.
- No offer compensation.
- No roll number.
- No protected attribute or proxy: gender, religion, caste, age or date of birth, disability, marital status, region
  of origin, photo.

The writer checks the header row against these words before anything is written, so a column added later cannot carry
them out. A contract test also checks the body.

**Formula injection.** INST-08's `csvCell` handles it. A text cell starting with `=`, `+`, `-`, `@`, a tab or a CR is
prefixed with `'`, and every cell is quoted with embedded quotes doubled. The writer is reused, not copied: the
document assembly moved into a shared `csvDocument`, and INST-08's `toCsv` keeps its own forbidden-header check on top
of it.

## Caps, limits, audit and hash

- **Cap.** 5,000 rows per file. A larger result is 422 `EXPORT_TOO_LARGE` and writes nothing.
- **Per-person limit.** 20 exports per person per employer in any 24 hours. The count uses successful audit rows,
  under an advisory lock on (person, employer), so two parallel requests cannot both take the last slot. The
  twenty-first is 429 `EXPORT_RATE_LIMITED`.
- **Audit before sending.** One `employer.applicants.exported` row is written in the export transaction, with:
  - the actor and organisation;
  - the reason code, scope, job, row count, and how many applications were left out for having no live grant;
  - the exported application ids (the audit trail, not the file);
  - the SHA-256 of the exact bytes sent.

  The file is sent only after that row commits. If the audit write fails, nothing is sent.
- **Hash.** The same SHA-256 goes back in `X-Export-Sha256`. A copy that turns up later can be matched to the export
  that produced it.

## Calendar integration

EMP-09 already delivers calendar invites: RFC 5545 `.ics`, one stable UID per interview, SEQUENCE bumps on reschedule,
and STATUS:CANCELLED on cancellation. The student and every panellist get one by email attachment and by download
inside ONE, and Android students and panellists get add-to-calendar. The goal text says "Calendar invites delivered
with EMP-09; no two-way calendar sync in this plan", and §4.3 puts deep sync out of scope. So EMP-17 adds no
calendar provider.

**Rejected:** a `CalendarProvider` interface with an unconfigured Google or Microsoft adapter. It would need OAuth
client credentials and per-user refresh tokens (secrets ONE must not hold or invent). It would have no consumer in
this plan. It would also add a store of third-party tokens, which is a consequential table of its own. If Divakar
wants sync later, the design starts there, with a table design and an ADR.

## Rejected options

- **An export ledger table with stored files.** Rejected for the reason INST-08 gave: a stored file is a second copy
  of candidate data with its own retention problem. The audit row with the hash is enough to trace a copy.
- **GET with query parameters.** An export writes an audit row and needs a reason, which does not belong in a URL or
  in a proxy log.
- **Exporting from the live profile when there is no snapshot.** The student shared nothing with this employer
  beyond the snapshot. The Applicants list shows a roster name for old applications, but the file is stricter,
  because it leaves ONE.
- **Recruiters exporting.** Decision 10.2 #10 says no.
- **Free-text reason codes.** A fixed list gives the screen a plain choice and keeps the audit queryable.

## Android

Exports are desk tasks: a CSV is opened in a spreadsheet on a computer, and INST-08 made the same call for every
institution export. The Android employer workspace gets no export. Calendar on Android is EMP-09's existing
add-to-calendar intent, and EMP-17 does not change it.
