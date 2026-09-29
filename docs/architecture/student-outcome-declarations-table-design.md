# Student Outcome Declarations — Table Design

**Status:** Adopted (INST-13), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0083_student_outcome_declarations.sql` (number assigned by the coordinator; references only
tables created in 0000–0080)
**Relates to:** ADR-019 (a college sees a student's records only with a distinct, revocable consent),
ADR-020 (readiness is a band), ADR-024 (no compensation to institutions), INST-12
(`placement-register-design.md`), `accreditation-outcome-exports-design.md` (the only reader)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Colleges report what their graduates did next — a job, higher studies or their own venture — for NAAC,
NBA and NIRF submissions (INST-13). ONE already knows one of the three: **placed**, from applications a
student chose to share with the college (ADR-019, INST-09, INST-12). It knows nothing about the other
two. No table, column or document type in 0000–0080 records that a person went on to a master's
programme or started a company; external applications (0019) are job applications only.

INST-13's goal says where those figures must come from: "self-reported by students, with consent". The
choice is between building that source or printing NA in two of the three outcome columns forever. NA
is the honest answer until a source exists, but the goal names the source, and it is small: one fact
per student per college, given by the student, withdrawable, and read only as a suppressed count.

## The rule this table serves

A student (usually a graduate) may tell **one college they studied at** one of:

| Outcome | Meaning shown to the student |
|---|---|
| `HIGHER_STUDIES` | "I went on to further study (for example a master's, a doctorate or another degree)" |
| `ENTREPRENEURSHIP` | "I started or run my own business or venture" |

- **The declaration is the consent.** Nothing is shared by default and nothing is inferred. A row
  exists only because the student chose that college and that outcome on their own screen.
- **The college never sees who.** No route returns a declaration to a college. It is read only by the
  accreditation export, as a count inside a department × programme × year table that goes through the
  one suppression helper (every group under 5 reads `<5`, margins that would recover one withheld).
- **Withdrawable at any time**, and the next export no longer counts it. Changing the outcome is a
  withdrawal plus a new declaration, in one transaction.
- **Self-reported and unverified**, and labelled so wherever it is counted. Neither ONE nor the
  college checks it; the export says so in the file.
- **No detail is collected** — no institution admitted to, course, venture name, dates or pay.
  Accreditation templates sometimes ask for those per student; ONE does not hold them and does not
  start collecting them here (data minimisation; the export marks them NA). A per-student list is a
  different consent and a different design.

### Which colleges a student may declare to

A college with which the student holds a relationship that is **current** (`ACTIVE` or `VERIFIED`,
inside its window) or **`GRADUATED`**. Not `TRANSFERRED`, `ENDED` or `PENDING`: a student who left
mid-course is not that college's graduate, and a pending relationship is not yet a college of theirs.

This deliberately reaches past the relationship policy's historical cut-off. For graduates, the
college's access to activity ends at `effective_to` (canonicalInstitutionRelationshipPolicy), and a
master's admission usually comes after it. The policy protects a student from being followed by their
old college; here the student initiates the disclosure, to a college they choose, it is revocable, and
it leaves only as a suppressed count. The relationship policy is unchanged for everything else: the
**placed** column still counts only activity before graduation (INST-12's rule, reused unchanged).
Recorded for Divakar below.

## Decision: one table, `student_outcome_declarations`

| Question | Decision | Rejected |
|---|---|---|
| Where does the fact live? | Its own table, one live row per student and college | A column on `institution_student_profiles` (the college's row: the college writes it, the student cannot, and it would read as the college's record); a new `external_applications.source_kind` (a job-application table, with per-record visibility that would expose each row to the college — ADR-019's model is per-record visibility, this is count-only) |
| Consent artefact | The row itself: it exists only while shared | A separate consent-registry purpose (0028) plus a private declaration: two things to keep in step, and a private declaration has no use — ONE does not use it for anything else |
| Change of outcome | Withdraw the live row and insert a new one, in one transaction | Updating `outcome` in place (the audit trail and the "declared before the period end" rule would silently move) |
| Detail fields | None | Institution/course/venture names, dates: collected for nothing ONE shows, and identifying in small colleges |
| Deletion | Erased with the person (privacy deletion, `STUDENT_PROFILE`) | Keeping anonymised rows (a count of an erased person would outlive their withdrawal right) |

## `student_outcome_declarations`

| Column | Type | Why |
|---|---|---|
| `id` | uuid PK | The student withdraws by id; never shown to a college |
| `student_user_id` | uuid NOT NULL → `users(id)` | The declaring student |
| `institution_id` | uuid NOT NULL → `organizations(id)` | The one college it is shared with |
| `outcome` | text NOT NULL, CHECK in (`HIGHER_STUDIES`, `ENTREPRENEURSHIP`) | The fact |
| `declared_at` | timestamptz NOT NULL DEFAULT now() | Counted only when before the export's period end (month-end stock, as INST-12) |
| `withdrawn_at` | timestamptz NULL, ≥ `declared_at` | Set once; the row then no longer counts |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

- **One live declaration per student and college:** partial unique index on
  `(student_user_id, institution_id) WHERE withdrawn_at IS NULL`.
- **Index for the export:** `(institution_id, student_user_id) WHERE withdrawn_at IS NULL`.
- **Guard trigger** (`student_outcome_declaration_guard`):
  - INSERT must have `withdrawn_at IS NULL` (a declaration starts shared);
  - UPDATE may only set `withdrawn_at` from NULL to a value; every other column is fixed, and a
    withdrawn row never changes again;
  - DELETE is refused except inside the privacy erase of that student (transaction-local
    `one.privacy_erase_subject`, as 0060, 0068 and 0080 do).
- Every statement guarded (`IF NOT EXISTS`, `CREATE OR REPLACE`, trigger created only if absent), so a
  replay is a no-op (ADR-035 applies files once; they are still written to survive a replay).

The relationship rule is enforced in the API, not the table: it depends on the relationship's state
and window at the time of the request, and the export counts only graduates anyway.

## Who may do what

| Route | Who | Effect |
|---|---|---|
| `GET /students/me/outcome-declarations` | The signed-in person | The colleges they may declare to (name, current or graduated, graduation date), each with their live declaration or none |
| `POST /students/me/outcome-declarations` `{institutionId, outcome}` | The signed-in person, for a college they may declare to | Shares; replaces a live declaration with a different outcome (withdraw + insert); the same outcome again writes nothing |
| `POST /students/me/outcome-declarations/:id/withdraw` `{}` | The declaring person only | Withdraws; repeating it is safe and keeps the first withdrawal |

Every write writes an `audit_events` row in the same transaction
(`student.outcome_declaration.shared` / `.withdrawn`, organisation = the college, context = the outcome).
Audit rows are read only by platform roles. Unknown fields are refused (400); another person's
declaration, or a college the person may not declare to, is 403. No college route reads the table
except the accreditation export.

## What the student is told

On Profile (web) and Profile (Android): "Tell your college what you did after graduating. Your college
never sees your name next to this: it appears only as a count in its accreditation reports, and a group
of fewer than 5 people is hidden. It is marked as self-reported. You can withdraw it at any time." A
current student sees the same choice, with the note that they are counted only once they graduate.

## Privacy deletion and export

- **Deletion:** every row of the person is erased inside the `STUDENT_PROFILE` step's transaction,
  with the erase setting the guard checks.
- **The student's own data export** is not extended in this goal (the bundle does not yet carry
  nominations, goals or external applications either); the rows are visible to the student on Profile.

## Open points (decisions for Divakar)

1. **Build the source (recommended, taken) or print NA.** The goal names "self-reported by students,
   with consent" as the source for higher studies and entrepreneurship. Taken: build it, minimal.
2. **Counting declarations made after graduation** reaches past the relationship policy's historical
   cut-off, on the student's own revocable initiative, as a suppressed count only. Recommended: keep.
   If rejected, the fix is one predicate (`declared_at < effective_to`) in the export.
3. **No detail fields.** Recommended: keep until a college shows it needs per-student lists, and then
   design that consent separately.
4. **No reminder or prompt** to graduates to declare. A nudge (in-app notice at graduation) would raise
   coverage; not built, as it is a notification-kind change and a product decision.
