# Student Document Verification — Design

**Status:** Adopted (security fix `fix/document-verification`)
**Date:** 2026-10-02
**Migration:** `0107_student_document_verifier.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

`student_document_metadata.verification_state` (0006) takes `SELF_REPORTED`,
`PENDING_VERIFICATION`, `VERIFIED` or `REJECTED`. The only writers are the student's own routes,
`POST /api/v1/students/me/documents` and `PATCH /api/v1/students/me/documents/:documentId`, and both
accepted every one of the four values from the request body. Nothing recorded who verified, and no
staff route anywhere writes the column. So a document marked "Verified" was always the student
saying so, and the "Verified" chip on the web Documents page (and the "Verified" count above it), on
the student dashboard's document list and on the Android Documents screen presented that as a check.

The PATCH also defaulted an omitted `verificationState` to `SELF_REPORTED`, so any metadata edit
silently reset whatever state the row held — harmless today, but it would have let a student wipe a
real staff decision the day one exists.

## Who reads the column (audit, 2026-10-02)

| Reader | What it shows | Exposure |
| --- | --- | --- |
| `GET /students/me/documents[/:id]` (student-operational-core.controller.ts) | `verificationState` to the student | Student's own screens: web `AuthenticatedStudentDocuments` (App.tsx table + "Verified" stat), web pilot-parity student dashboard (`pilotParity/student.tsx`, document list and evidence list), Android `DocumentsPage` (JobsAndMore.kt) chip |
| Privacy export (`privacy-export.ts`) | `verification_state` in the student's own data copy | Student only |
| Résumé sources (`resume/resume-sources.ts`) | Does **not** read it; certificates are always "Self-declared" | — |
| Public profile (`public-profile.ts` `loadCertificates`) | Titles only | — |
| Application snapshot / employer candidate view (`application-snapshots.ts`) | Résumé title, filename, version; no state | — |
| Institution academic queue (`academic-records.ts`, ADR-027) | Evidence title, type, version; no state | — |

No employer or institution surface reads a document's verification state today. The false claim
reached the student's own screens and their privacy export. The fix still guards the column at the
database, because the first staff or employer reader to be added would otherwise inherit rows that
say `VERIFIED` and mean nothing.

## Decision

### 1. A student can say "self-reported" or "please verify", never "verified"

The student routes accept `SELF_REPORTED` and `PENDING_VERIFICATION` only. `VERIFIED` or `REJECTED`
from a student answers **400 `DOCUMENT_VERIFICATION_STATE_NOT_ALLOWED`**. An unknown value keeps the
existing generic refusal.

On PATCH, an omitted `verificationState` now **keeps** the current state instead of resetting it.

### 2. A decision records its verifier, at the database

New nullable columns on `student_document_metadata`:

| Column | Notes |
| --- | --- |
| `verified_by_user_id` | uuid → `users(id)`. The staff member who decided. |
| `verified_at` | timestamptz. When they decided. |
| `verification_institution_id` | uuid → `organizations(id)`. The institution on whose behalf they decided. |

Constraints (CHECK unless noted):

- `student_document_decided_ck` — `VERIFIED`/`REJECTED` **if and only if** a verifier is recorded.
  A row cannot become `VERIFIED` or `REJECTED` without one, even if the API is bypassed, and an
  undecided row cannot carry one.
- `student_document_verifier_ck` — the three columns are all set or all NULL.
- `student_document_not_self_verified_ck` — the verifier is never the document's owner.
- Trigger `student_document_verification_guard` (BEFORE INSERT OR UPDATE):
  - a decision names an organisation of kind `INSTITUTION`, and the verifier holds an `ACTIVE`
    membership in it;
  - `VERIFIED` is permanent, as for academic records (0070): it never moves back, and its verifier
    is never rewritten;
  - while a row stays decided (`VERIFIED` or `REJECTED`), its title, type, description, verifier and
    current file version cannot change. Clearing `current_version_id` to NULL stays allowed — privacy
    deletion does that immediately before deleting the row. Archiving stays allowed.

### 3. What a student can do to a decided document

| Current state | Student PATCH | Student file upload | Archive |
| --- | --- | --- | --- |
| `SELF_REPORTED`, `PENDING_VERIFICATION` | Edit freely; set either student state | Allowed | Allowed |
| `REJECTED` | Allowed only when the body sets `verificationState` (a new request or back to self-reported); that clears the decision, and the audit row records `REJECTED → …`. Without it: **409 `DOCUMENT_VERIFICATION_DECIDED`** | **409** — set a new state first | Allowed |
| `VERIFIED` | **409 `DOCUMENT_VERIFICATION_DECIDED`** | **409** — add a new document for a new file | Allowed |

So a staff decision is never downgraded silently: a verification cannot be touched at all, and a
rejection is cleared only by the student explicitly asking again, recorded in `audit_events`.

### 4. No staff verification route exists, and this change does not add one

The columns are NULL on every row until one is built. That route must: check the reviewer role and
active relationship rules of ADR-027 (or their successor) before reading the evidence, write the three
columns in the same statement that sets the state, and write its own audit event. The trigger above
already refuses a verifier who is not an active member of the institution named.

### 5. Existing rows: reset, never deleted

Every row that is `VERIFIED` or `REJECTED` today has no verifier, because no route could have
recorded one; each is a student's self-assertion. 0107 sets them to `SELF_REPORTED` before adding
the constraints. Nothing else on the row changes, and no document or file is deleted.

**Audit record.** `audit_events.actor_user_id` is NOT NULL, and the codebase has no system actor and
no pattern for recording a data correction made by a migration. Writing the student as the actor
would misattribute the change, so the migration does not write audit rows. The decision is recorded
here; the migration raises a NOTICE with the number of rows it reset. The prior value carried no
information worth keeping: it was the student's own claim.

**Count on a seeded database:** the repository's seed and fixture data insert no
`student_document_metadata` rows with `VERIFIED` or `REJECTED`, so a freshly migrated database resets
**0** rows. (A local database holding UAT activity may hold some; the NOTICE reports them.)

### 6. Screens

- The student's own document forms never offer `VERIFIED` or `REJECTED` (web and Android already did
  not; the API now refuses them regardless).
- A document's chip reads **"Verified"** only when the API returns `VERIFIED` *and* a verification
  time; **"Verification requested"** for `PENDING_VERIFICATION`; **"Not verified"** for `REJECTED`
  with a decision time; otherwise **"Self-reported"**. The API returns `verifiedAt`, never the
  verifier's identity.
- The web "Verified" stat counts only documents that pass the same test, which is 0 until a staff
  route exists.

## Rejected alternatives

- **Drop `VERIFIED`/`REJECTED` from the CHECK.** It would make the column honest today and force a
  migration to put them back later, with the verifier rule still missing. The decided ⇔ verifier
  constraint keeps the states available for a real reviewer and impossible for anyone else.
- **Silently ignore a student's `VERIFIED` (store `SELF_REPORTED`).** A client sending it would
  believe it succeeded. A 400 with a specific code tells it.
- **A side table of verification decisions.** Worth it once decisions have history (re-review,
  appeal). Today there is no decision at all; three columns and a guard are the smallest thing that
  makes the state mean something, and a later table can be added beside them.
- **Write the reset into `audit_events` with the student as actor.** Misattributes the action; see 5.
