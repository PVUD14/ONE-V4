# Student Résumés (Generated From the ONE Record) — Table Design

**Status:** Adopted for build (RESUME-GEN), recommended options taken per CLAUDE.md ("ask once, recommend,
carry on"). Divakar may override any decision listed at the end.
**Date:** 2026-10-01
**Migration:** `0101_student_resumes.sql`
**Rule:** Written before the migration, per the migrations rule in `CLAUDE.md`.
**Builds on:** `academic-records-table-design.md` (0070: who stands behind a record, and "no issuer, no
verification"), `application-evidence-shares-table-design.md` and ADR-043 (EMP-13's qualifying-evidence rule
and the "never readiness, never a stage, never a count" contract), `application-snapshots-table-design.md`
(EMP-07: how a résumé reaches an employer today), ADR-020 (readiness is a band, never a number),
`privacy-export-coverage.md` (every personal table is in the export and in deletion).

## Why this exists

The student Résumé Builder page lists uploaded résumé documents and nothing else. Its Templates, Examples and
Resume Score tabs are NA shells. Uploads themselves are off on AWS: the API refuses to store a file without a
virus scanner (`config.ts`, FILE_STORAGE_ROOT requires CLAMAV), and none is deployed. So on the live service a
student cannot get a résumé out of ONE at all, although ONE already holds most of what a fresher's résumé
contains: the name on the college roster, the qualifications and term results the college verified, the skills
the student has shown in graded work, the career roles they chose, their headline, summary and portfolio link.

Divakar asked for ONE to **generate** the résumé. No model is involved (the AI hold, ADR-030): generation is
deterministic layout of the student's own records and their own words.

## What the student controls

1. **Which items.** Every section and every item is chosen by the student: each qualification, each term
   result, each evidenced skill, each certificate document, each career role, each shown with a tick box and
   its label. A new draft starts with education, evidenced skills and certificates ticked and term results and
   career objective unticked; nothing is saved that the student has not seen in the preview.
2. **Their own words.** The header (name, headline, phone, location, up to five https links, whether to show
   the sign-in email), the summary, projects (title, description, optional https link), self-declared skills
   and languages. These are typed by the student and are labelled *self-declared* wherever a label applies.
3. **The template.** One of three: `CLASSIC` (single column, centred header, rules between sections), `MODERN`
   (coloured header strip, accent headings), `COMPACT` (smaller type, denser lists, fits more on one page).
4. **The title** of the saved résumé ("Campus drives", "Data roles").

## What ONE fills in, and how it is labelled

The server resolves every chosen record from the student's own rows at the moment of preview or save. The
client sends **identifiers of the student's own records and free text**, never a label: a client cannot mark
anything verified.

| Section | Source | Label on the résumé |
|---|---|---|
| Name | `institution_student_profiles.full_name` (ACTIVE first, then GRADUATED), editable | none |
| Email | `users.email`, shown only if ticked | none |
| Headline, summary, portfolio | `student_profiles`, editable in the résumé only | none (the student's words) |
| Education | `student_qualifications` (never `REJECTED`) | `VERIFIED` **and** an issuing ONE organisation → "Verified by *<institution legal name>*". `PENDING_VERIFICATION` → "Self-declared · verification pending". `SELF_REPORTED` → "Self-declared". |
| Term results | `student_academic_terms` of a chosen qualification (never `REJECTED`), shown on the scale issued ("8.20 CGPA (of 10)", "76.5%", "Grade A", "Pass") — never converted, never a cumulative figure we computed | Same rule as education, per term. |
| Evidenced skills | `evidence_records` passing EMP-13's `qualifyingEvidence` rule, grouped by taxonomy topic | "Shown in ONE skill checks" / "Shown in an institution exam", with the month of the latest item. Never "verified by" — the evidence is graded work, not an institution's attestation. |
| Self-declared skills | typed | "Self-declared" heading |
| Projects | typed | "Self-declared" heading |
| Certificates | `student_document_metadata` of type `CERTIFICATE`, not archived | **Always "Self-declared"** — see the finding below. |
| Career objective | live `student_career_targets` role titles | none; off unless ticked |
| Languages | typed | "Self-declared" heading |

**Finding (documents are not verified evidence).** `student_document_metadata.verification_state` is written
by the student's own `POST/PATCH /students/me/documents` (`readDocumentInput` accepts `VERIFIED`), and nothing
records who verified a document. A document's `VERIFIED` therefore means nothing a reader could rely on, and
the résumé ignores it: certificates are always labelled self-declared. This is reported to Divakar; fixing the
document route is outside this goal.

**Never on a résumé, in any form:** a readiness band or snapshot, a mastery value, an evidence stage, a gap
status, a score, a percentage of anything ONE computed, counts of evidence, a rank, a profile photo, roll
number or any internal identifier. The content builder is a pure function with a contract test over every
string it emits, the API response and the PDF metadata.

## Decision 1: two tables, versions are immutable

### `student_resumes` — one row per résumé the student keeps

| Column | Notes |
|---|---|
| `id uuid PK` | |
| `student_user_id uuid NOT NULL → users` | owner; every query is scoped by it |
| `title text NOT NULL` | 1–120 characters, no leading `= + @ -` |
| `created_at`, `updated_at timestamptz` | |

`UNIQUE (id, student_user_id)` so versions can carry the owner through a composite foreign key.

### `student_resume_versions` — one row per save; never updated

| Column | Notes |
|---|---|
| `id uuid PK` | |
| `resume_id uuid NOT NULL` | composite FK `(resume_id, student_user_id) → student_resumes(id, student_user_id) ON DELETE CASCADE` — a version cannot belong to someone else's résumé |
| `student_user_id uuid NOT NULL → users` | |
| `version_number integer NOT NULL ≥ 1` | `UNIQUE (resume_id, version_number)` |
| `template_key text NOT NULL` | `CLASSIC`, `MODERN`, `COMPACT` |
| `selections jsonb NOT NULL` | what the student ticked and typed (record ids of their own rows + text), so "edit" starts from the last choices. Object, at most 32 KB. |
| `content jsonb NOT NULL` | the resolved résumé as the student saw it in the preview: every string and label that is drawn. Object, at most 64 KB, and no top-level `readiness`, `band`, `score`, `mastery` or `stage` key. |
| `content_hash text NOT NULL` | SHA-256 of the canonical JSON (the EMP-07 `canonicalJson`) |
| `created_at timestamptz NOT NULL DEFAULT now()` | |

A trigger refuses every `UPDATE` of a version: a saved version is what the student saw, and an edit is a new
version. `DELETE` is allowed (the cascade from the owner deleting a résumé, and privacy deletion).

**Why freeze the content rather than re-resolve on download.** A résumé is a document at a point in time: the
student reviewed exactly this text. Re-resolving would change a downloaded PDF under the student without them
seeing it. Freezing can only ever *under*-claim: academic verification is permanent (0070's trigger), so a
frozen "Verified by" stays true; an item that was pending when saved stays labelled pending in that version
until the student saves a new one.

**Rejected alternatives.** (a) Store rendered PDF bytes in `stored_files` — AWS has no file store or scanner,
and a stored PDF would need either a fake `CLEAN` verdict (weakening the scan invariant of 0008) or a scanner
that does not exist. (b) A column on `student_profiles` — one résumé, no versions, and it would mix the
student's public profile text with résumé-only edits.

## Decision 2: generation is synchronous rendering, not a model call

`pdfkit` (MIT, maintained, 0.20.x, dependencies `fontkit`, `linebreak`, `png-js`, `fflate`, `@noble/*`) lays
out the frozen content into an A4 PDF in the request. It is pure computation over at most 64 KB of text and
takes tens of milliseconds; there is no network call, no model, no outbox job. `pnpm audit --prod
--audit-level=high` stays clean with it (the only findings are the pre-existing moderate `qs` ones under
Express). Rejected: `pdf-lib` (unmaintained since 2021, no text layout); headless Chromium (hundreds of MB,
a browser in the API container); the browser's print dialog (no Android parity, output varies by browser).

**Fonts.** Inter (Regular, SemiBold, Bold) for Latin text and Noto Sans Telugu (Regular, Bold) for Telugu,
both SIL OFL 1.1, bundled under `apps/api/assets/fonts/` with their licences and embedded as subsets. Text is
split into runs by script and each run is drawn in the font that has its glyphs, so a Telugu name or project
title renders shaped (fontkit's Indic shaper) instead of as empty boxes.

**DOCX.** Not built. A DOCX writer needs a second dependency (or a hand-written ZIP container) for a format a
student can produce from the PDF; recorded as not done.

## Decision 3: routes, limits and authorization

All routes are the caller's own (`/students/me/...`, `ProtectedApiAuthenticationGuard`), as career targets and
goals are: no student identifier in any path, every query scoped by the principal. A résumé id that is not the
caller's answers **403** (the documents convention), so ids cannot be probed. No institution, employer or
operator route reads these tables.

| Route | Purpose |
|---|---|
| `GET /students/me/resume-sources` | everything the student may choose from, with its label, and the three templates |
| `POST /students/me/resumes/preview` | resolve a draft into content and the completeness checks; writes nothing |
| `GET /students/me/resumes` | the student's résumés with their latest version |
| `POST /students/me/resumes` | create a résumé with version 1 |
| `GET /students/me/resumes/:id` | a résumé, its versions and the latest version's selections and content |
| `POST /students/me/resumes/:id/versions` | save a new version |
| `GET /students/me/resumes/:id/versions/:n/pdf` | the PDF of one saved version |
| `DELETE /students/me/resumes/:id` | delete a résumé and every version |

Limits: 20 résumés per student; 50 versions per résumé; 30 saves per student per hour (counted from
`student_resume_versions.created_at`); 60 PDF renders per student per hour (counted from the audit rows each
render writes) → **429**. Draft text limits: summary 1,200; project description 800 (10 projects); 30
self-declared skills and 10 languages of up to 60 characters; 5 links. Content over 64 KB is refused (400).

Audit: `resume.created`, `resume.version_saved`, `resume.pdf_rendered`, `resume.deleted` with the résumé id as
the resource — the student's own actions, no content.

## Decision 4: completeness checks, never a score

The Resume Score tab becomes **Resume checks**: a list of objective, explainable checks on the draft — no
email or phone shown, no summary, no education, no education verified by an institution, no skills, no
projects, a missing name. Each is passed or not, with what to do. There is no number, no percentage, no
"n of m" and no ring: ONE does not score résumés, and a score would invite the readiness confusion ADR-020
exists to prevent.

## Decision 5: applying with a generated résumé — not in this goal

The EMP-07 application path pins a résumé as three pointers to a `RESUME` document version and its
**scanned-clean stored file** (`application_profile_snapshots.resume_*`, `application_resume_download_links.
stored_file_id NOT NULL`), and the immutable snapshot trigger and recruiter link table are built around that
file. Attaching a generated version would mean a second résumé kind in an employer-facing, immutable table, a
change to the snapshot guard and to the recruiter download — a consequential employer change that deserves
its own design and goal. Until then: the student downloads the PDF and, where uploads are on, can add it under
Documents as a résumé (it is then scanned like any upload) and attach it through the existing path. The
application snapshot already carries the student's qualifications with their verification state.

## Retention, export and deletion

- **Export.** `resumes` in the student's data export: each résumé's title and dates, and each version's
  number, template, date and full content (the words and labels). Not the selections (they are internal record
  ids) and not the hash.
- **Deletion.** Account deletion erases every résumé and version (counted under `STUDENT_PROFILE`).
- **Retention.** Kept until the student deletes the résumé or the account.
- **Who else reads it.** Nobody. No staff, institution or employer route reads these tables.

## Branding

The résumé carries no ONE logo or wordmark. Its footer carries one line of legend, because a "Verified by"
label needs its provenance: *"Verified by" marks a record the named institution confirmed in ONE; every other
item is self-declared. Generated <date>.* A logo would make the student's résumé an advert and is a slot the
brand rule says must be the real wordmark or nothing.

## Android

The phone gets the same function inside **Documents** (an entry card "Résumé builder"), not as a new menu item
(HG-3: navigation is not added to). It lists saved résumés, builds a new version with the same choices and
templates, previews the resolved sections, and saves the PDF through the system file picker, from which it can
be opened or shared.

## Readiness

None. No column, route, label or PDF line carries readiness, a band, a score, a stage, mastery or a count of
evidence; the contract test fails the build if one appears.

## Decisions for Divakar (recommended answers taken)

1. **Generated résumés are not attachable to applications yet** (Decision 5). Recommended: a follow-up goal
   that adds a generated-résumé pointer to the snapshot, rendered from the frozen version for the recruiter.
2. **Certificates are always self-declared**, because the student can set a document's verification state
   themselves. Recommended: a follow-up that takes `VERIFIED` away from the student's document route and adds a
   verifier.
3. **Academic term results and career objective are off unless ticked.** EMP-07 keeps both away from
   employers by default; on a résumé they are the student's choice, so they are available but never preset.
4. **No ONE branding on the résumé**, only the verification legend.
5. **No DOCX.**
