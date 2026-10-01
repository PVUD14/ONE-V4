# SOP — Content bulk import (Content Management → Bulk import)

> What this is: the operator procedure for importing many skills, questions or lessons at once from
> a CSV or JSON file, as drafts. Why it exists: Appendix 1 OPS-17 (full) needs an SOP for every
> shipped module. Built by OPS-09d. Written 2026-10-01 against base `719eb34`.

## Purpose

Load content in volume without an engineer. Nothing imported is ever live: every row lands as a
DRAFT, authored by you, and goes through the normal review and publish path
([sop-content-authoring.md](sop-content-authoring.md)).

## Who and what capability

You need `CONTENT_EDIT`, for preview and commit alike. Reviewers, publishers, catalogue managers
and plain operators are refused. No role holds `CONTENT_EDIT` by baseline; it is granted on
Settings.

## Where

**Operations → Content Management → Bulk import.**

## Steps

1. Choose the **Import kind** (skills, questions or lessons; one kind per file) and the **Import
   format** (CSV or JSON). Choose the **Import file**.
2. **Preview.** The server validates every row and shows a **Validation report**.
   - Each bad row is listed with its problem code: the editors' own codes plus `IMPORT_*` codes,
     for example `IMPORT_KEY_DUPLICATE` or `IMPORT_TOO_MANY_ROWS`.
   - The report never shows row text, so it never shows an answer key.
3. Fix the file until the report is clean. **One bad row blocks the whole import. Nothing is
   written until every row is valid.**
4. **Import N as drafts…** and choose a reason: `TRACK_BUILD`, `CONTENT_MIGRATION` or `EXPERT_BATCH`.
   The dialog reminds you that you will not be able to review or publish these drafts.
5. **Import as drafts.** If the file changed since the preview, the commit is refused
   (`IMPORT_STALE`) and nothing is written. Preview again.
6. Ask a reviewer to take the drafts through review ([sop-content-authoring.md](sop-content-authoring.md) §B).

## Limits

- At most 200 rows and 90,000 characters per file. The file name can be at most 160 characters.
- Only one import runs at a time across ONE.
- Create only. An existing key is a row error; revisions are made in the editors.
- **Non-English text:** the request body is limited to about 100 KB. A file of Telugu (or other
  non-Latin) text can therefore be refused with a plain "too large" error well below 90,000
  characters (about 33,000 Telugu characters). Split the file.

## Never do

- Never import content you do not have the rights to; the rights review happens at review, and it
  must be true.
- Never import a file of student data. The importer accepts content only. A file of personal data
  in a content field would be published to every student.

## Gaps

- No import of revisions, retirements or misconception codes.
- Imported text is not formula-escaped. That is harmless today, because no content is exported as
  CSV. Any future content export must escape it.
- Agent provenance cannot be set from an upload.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-11.
