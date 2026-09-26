# Consented Application Snapshots and Résumé Download Links — Table Design

**Status:** Adopted (EMP-07), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0058_application_snapshots_and_resume_links.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Employers can see almost nothing about an applicant — name, email and college roll number from
the applicant list (EMPLOYER_BASELINE D-7) — and the consented submission snapshot the spec asks
for (§115) has never been written: `application_profile_snapshots` exists since 0007, with a
résumé file pointer added in 0008, and no code inserts into it (D-4). EMP-07 writes it at apply,
lets the student review it first, and gives the employer a candidate view and a résumé download
built on it.

A snapshot is a statement about a person, made by that person, at one moment, to one employer.
It carries consequences in both directions: the employer decides on it, and the student must be
able to say "this, and only this, is what I shared". So it is written once, never edited, tied
to the exact job terms the student applied under, and erased only by the student's own deletion.

## Decision 1: keep `application_profile_snapshots`, harden it

**Chosen.** The 0007 table is the right shape (one row per application, JSON content, a 64-char
hash, an optional résumé). 0058 adds:

| Column | Type | Notes |
|---|---|---|
| `schema_version` | smallint, default 1 | the snapshot format; readers branch on it |
| `opportunity_version_id` | uuid → `opportunity_versions(id)` | the terms applied under; a trigger requires it to equal `applications.applied_version_id` at insert |
| `resume_document_version_id` | uuid → `student_document_versions(id)` | the exact résumé version chosen (with the existing `resume_document_id` and `resume_file_id`) |
| `erased_at` | timestamptz | set once, by privacy deletion only |

A trigger refuses `DELETE` always, and `UPDATE` except one transition: privacy deletion for the
application's own student (the transaction-local `one.privacy_erase_subject`, the 0047 pattern)
setting `erased_at` from NULL, replacing the content with an erased marker and clearing the
résumé pointers. Nothing else about the row may change.

**Why the version column, when `applications.applied_version_id` exists.** The application's
column is fixed today, but EMP-05 lets an applicant accept later terms; the snapshot must name
the terms it was given under, as a fact of its own row, and the trigger proves the two agree at
the moment of writing.

**Rejected: a new table.** The 0007 table and its unique index on `application_id` already say
"exactly one per application"; a second table would leave the first as a trap.

**Rejected: live reads of the profile in the employer view.** The profile keeps changing; the
employer would see things the student never shared with them (§5.2 "employers see the snapshot,
not the live profile").

## What a snapshot contains (schema version 1)

Built by one pure function in `packages/hiring` from the student's own records at apply time:

- **Candidate:** full name (the college roster name — ONE has no other name field), sign-in
  email, and a phone number only if the student types one in for this application.
- **Current education:** institution name, programme, department, expected graduation year —
  from the student's ACTIVE roster profile, else the most recent GRADUATED one (alumni apply too).
- **Qualification summary:** each declared qualification — type, programme, institution, start
  and completion years, awarded, and its verification state. **No results, grades, CGPA or
  backlog figures**: EMP-06 decided the employer never sees figures, only eligibility outcomes
  and their basis; a figure-sharing option is a later, separate consent.
- **Profile:** the student's own headline and summary.
- **Links:** up to five `https://` links the student adds for this application (portfolio,
  code, publications), each with an optional label.
- **Résumé:** title, file name, version number, type and size of the chosen RESUME document's
  current scanned-clean version — or none.

**Excluded, always:** anything readiness-related (bands, scores, gap statuses, mastery, career
targets and interests — they feed readiness), assessment results, documents not chosen, the
profile photo (a protected-attribute proxy, §5.4), roll numbers and every internal identifier.
The content carries no timestamps, so the hash of what the student previewed equals the hash of
what is stored when nothing changed in between.

**Hash.** SHA-256 over a canonical JSON serialisation (keys sorted). The preview returns it; the
apply request sends it back as `reviewedSnapshotHash`; apply rebuilds the snapshot inside its
transaction and refuses with 409 `SNAPSHOT_CHANGED` if they differ, so the stored row is exactly
what the student reviewed. Clients built before EMP-07 may omit it; apply then stores what it
builds, and the student can still see it on their application.

## What the employer sees

`GET …/employers/:employerId/applications/:applicationId` — only through the live
applicant-access grant (EMP-SR-01 predicate; revoked, expired or deleting ⇒ 403), for a verified,
active employer (EMP-03), audited as `application.candidate_viewed` every time. It returns the
snapshot, not the profile; the email only from SHORTLISTED onward (decision 10.2 #9); the phone
only if the student added one; the EMP-06 eligibility outcomes and basis without figures; the
stage timeline; interviews; the offer. Applications from before EMP-07 have no snapshot and say
so (`NA`), rather than falling back to the live profile.

## Decision 2: short-lived, single-use résumé links — `application_resume_download_links`

**Chosen.** The résumé never leaves through the candidate view. `GET …/applications/:id/resume`
checks the grant, the scanned-clean file behind the snapshot, writes a link row and returns a
path with a random token valid for **60 seconds, once**, for the recruiter who asked:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `application_id`, `employer_id` | uuid, composite FK → `applications(id, employer_id)` | |
| `issued_to_user_id` | uuid → `users(id)` | only this person can redeem it |
| `stored_file_id` | uuid → `stored_files(id)` | the snapshot's pinned file |
| `token_digest` | text, 64 hex, unique | SHA-256 of the token; the token itself is never stored |
| `issued_at`, `expires_at` | timestamptz | CHECK `expires_at` ≤ `issued_at` + 5 minutes |
| `consumed_at` | timestamptz | set once, atomically, on download |

Redeeming (`GET …/resume/file?token=`) is authenticated too, re-checks the employer's state and
the grant at that moment, consumes the link in one UPDATE, reads only through
`readable_stored_files`, and is audited as `application.resume_downloaded`; issuing is audited as
`application.resume_link_issued`. The bytes go out as an attachment with `nosniff`, as student
downloads already do. The row holds no personal content, so deletion leaves it.

**Rejected: an HMAC-signed stateless URL.** It needs a signing secret the API does not have
today, cannot be single-use, and leaves no row to audit against. When storage moves to S3 this
route becomes the place that mints the presigned URL, with the same checks.

**Rejected: serving the bytes from the candidate view route.** It would put a file transfer on
every page view and make "view" and "download" indistinguishable in the audit.

## Grant expiry (decision 10.2 #7)

The recommendation — access ends at most 180 days after an application closes — is adopted as
the ceiling. No new column is needed: `employer_applicant_access_grants.expires_at` (0001) is the
column, and the one shared predicate (`liveApplicantGrantCondition`) honours it for the list,
the candidate view and both résumé routes. Today every close (hire, rejection, withdrawal,
declined terms, deletion) already revokes at once, which is stricter than 180 days and is pinned
by an existing test; EMP-07 does not relax it. Keeping a hired candidate visible for 180 days
would be a one-line change at the HIRED transition (set `expires_at` instead of `revoked_at`) and
is left to Divakar. The expiry job for grants that do carry an `expires_at` is EMP-16.

## Retention and deletion

A snapshot lives as long as its application (APPLICATIONS are anonymised, not erased, under the
deletion policy). Privacy deletion replaces its content with `{"schemaVersion":1,"erased":true}`
(and that content's hash), clears the résumé pointers — which must happen before the document
rows are deleted — and stamps `erased_at`, inside the same transaction-local erase setting. The
employer has already lost access by then: an open deletion request withholds the person, and
execution revokes every grant first (EMP-SR-02).
