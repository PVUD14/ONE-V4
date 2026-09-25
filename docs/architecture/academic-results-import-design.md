# Academic Results Import and the Verification Screen — Design

**Status:** Adopted (INST-04), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** none — the tables are `0070_academic_records.sql`; nothing new is stored
**Relates to:** `academic-records-table-design.md` (frozen 2026-09-12), ADR-027, decision 10.2 #9 of the
institution plan

## Why this exists

`0070` gave ONE somewhere to keep a student's results and a way for the issuing institution to
confirm them, one term at a time, from a queue that no screen could reach (INST-00, I-4). The frozen
table design names three intake paths and prefers the first: **bulk import by the institution**, "one
sheet per term, not one form per student". Nothing built it. Without it a college confirms eight
semesters for two thousand students by clicking sixteen thousand buttons, which it will not do — and
every employer `MIN_CGPA` / `MAX_BACKLOGS` rule keeps failing closed.

Decision 10.2 #9 settles the policy: **bulk results upload creates institution-sourced verified
records attributed to the uploader, with conflicts shown rather than overwritten.** This document is
how.

## The upload

Same shape as the roster import: upload → validated preview with row-level issues → commit.

CSV header (case-insensitive, any order, unknown columns refused so a typo is not silently ignored):

| Column | Required | Meaning |
| --- | --- | --- |
| `institution_student_id` | yes | The roll number on this institution's roster |
| `term_sequence` | yes | 1–30, the position of the term in the programme |
| `term_label` | yes | What the institution calls it — "Semester 4", "Part II" |
| `scale` | yes | `CGPA_10`, `GPA_4`, `PERCENTAGE`, `LETTER`, `PASS_FAIL` |
| `result` | yes | The value **as issued**, on that scale; a letter for `LETTER`, `PASS`/`FAIL` for `PASS_FAIL` |
| `backlogs` | yes | Backlogs in that term (0–100). Required because "unknown" and "none" are different facts |
| `qualification_type` | when the student has no institution record yet | `BTECH`, `MBA`, … (the 0070 list) |
| `programme` | when the student has no institution record yet | Falls back to the roster's programme unit name |

Nothing is converted. A value arrives on its scale and is stored on its scale — the provenance rule of
the frozen design applies to imports exactly as it does to declarations.

**Formula injection.** Text cells (`institution_student_id`, `term_label`, `programme`) starting with
`= + - @` are refused as a row issue rather than rewritten, because 0070's CHECKs refuse them anyway
and a silently rewritten roll number would never match the roster. Results and backlogs are parsed as
numbers, so they cannot carry a formula. The preview is returned as JSON and rendered as text.

**Size.** At most 1 000 data rows and 512 KB — one term for one large department. Larger colleges
upload per department or per term.

## What each row does

For the student named on the row (resolved on **this institution's roster and inside the uploader's
scope** — anyone else is `student_not_found`, the same answer whether they exist or not) and the term
sequence, ONE looks at every term that student already has **at this institution**:

| Existing record at that sequence | Outcome | Written |
| --- | --- | --- |
| none | `CREATE` — a new term, `source = INSTITUTION_IMPORTED`, `VERIFIED`, verifier = uploader | yes |
| a verified term with the same result and backlogs | `UNCHANGED` | nothing |
| a verified term that differs | `CONFLICT` — shown with the verified value | nothing; a verified record is permanent (0070 trigger) and correcting one is a separate, unbuilt flow |
| an unverified student declaration with the same result and backlogs | `CONFIRM` — that term becomes `VERIFIED`, verifier = uploader, source unchanged | state only |
| an unverified student declaration that differs, in the student's own programme record | `CREATE` in the institution's record, **with the student's value shown beside it** | the institution record only; the student's declaration is untouched and stays in the queue, where it is flagged against the verified value |
| an unverified student declaration that differs, inside the institution's own programme record | `CONFLICT` | nothing (the two cannot share a sequence) |

This is decision #9 literally: the institution's record is created and attributed to the uploader;
where the student reported something else, that is **shown** — in the preview, in the commit result
and against the student's pending item in the queue — and **never overwritten**. A student's value is
the student's; ONE does not rewrite it because a college disagreed.

### Where created terms live

Created terms go into the student's **institution-issued programme record**: a `student_qualifications`
row with `institution_id` = this institution and `verification_state = 'VERIFIED'`. No product path
can set a student's own declaration to `VERIFIED` (only terms are decided), so a verified qualification
at an institution is one that institution created. If the student has none, the first created row
makes it, from `qualification_type` and `programme` (roster programme as the fallback) and the roster's
academic start date.

**Rejected: writing into the student's own declared programme record.** A differing declaration there
occupies the sequence (unique per qualification), so the college's verified value could never land
while the student's wrong one stood — and students cannot edit a term. The pilot would stall on the
first typo.

**Rejected: overwriting a differing declaration.** Explicitly ruled out by decision #9 and by the
frozen design's provenance rule.

**Rejected: auto-rejecting a differing declaration.** Rejection is a decision about a student's
submission with a reason; it belongs to a person looking at it, not to a side effect of an upload.

## Preview and commit

The preview persists nothing but an audit row. It returns every row with its outcome and issues, the
counts, and a **digest** (SHA-256 over the institution and every evaluated row, internal ids
included). Commit sends the same file, the digest and a reason code. The server re-evaluates inside
the transaction:

- any `INVALID` row → **400, nothing written**, row errors listed;
- a digest that no longer matches (a student submitted, another upload landed) → **409, nothing
  written**, preview again;
- otherwise every `CREATE` and `CONFIRM` is written, with one audit row per term and one for the
  upload, in one transaction. `CONFLICT` and `UNCHANGED` rows are reported, not written.

**Rejected: an import table (`0042`) holding the preview, as the roster importer does.** The roster
import stores rows because committing creates people from them. Here the facts are re-derived at
commit anyway (a queue item can change between preview and commit), so a stored preview would be a
second copy to keep consistent, and it could not reference `student_academic_terms`: the migrator
replays files in lexical order and `0042` runs before `0070` on a fresh database. The digest gives
the same guarantee — you commit exactly what you were shown — with nothing to store.

## Who may do what

| Action | Roles | Scope |
| --- | --- | --- |
| Read the queue and its summary | owner, admin, placement admin, department head, faculty | INST-02 scope helper |
| Decide one term (verify / reject) | same | the term must be in the reader's queue; reason code required |
| Upload results | owner, admin, department head | rows outside the uploader's scope are `student_not_found` |

Faculty and placement admins confirm individually; bulk upload is a registrar's act, which in a
college is the office or the head of department.

## Evidence (ADR-027)

The queue shows evidence **metadata only** — document title, type and version number — never the
filename and never a link. ADR-027 lets staff open a document version only with the student's
per-version consent, and that consent (the Core half of ADR-027) does not exist yet. ADR-027 also says
the staff read path must not ship before the consent it depends on, so no read path ships: the screen
says plainly that the student has not shared the document. Building the consent is its own table
design.

## Audit and reason codes

- `academic_term.verification_decided` — per decision, with `decision` and `reasonCode`.
- `academic_term.verified_by_import` — per created or confirmed term, with the outcome and the digest.
- `institution.academic_results.previewed` / `institution.academic_results.imported` — per upload,
  with counts, filename, digest and reason code.

Reason codes follow `^[A-Z0-9_:-]{3,64}$`.
