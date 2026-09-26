# SOP — Verifying marks, CGPA and backlogs

> What this is: the procedure college staff follow to confirm or reject the academic results
> students ask the college to verify, and to upload a term's results in bulk. Why it exists:
> Appendix 3 INST-19 (IM1 slice); journey J4. Built by INST-04. Written 2026-09-26 against base
> `6864332`.

## Who and where

| Task | Role | Where |
|---|---|---|
| Decide one request at a time | Owner, administrator, department head, faculty (placement officers via the API only — Gap) | Admin and department head: **Students** (the *Academic verification* section). Faculty: **Academic Verification** |
| Upload a term's results | Owner, administrator, department head (own department) | The same section → **Upload results** |

You see only requests from students in your scope.

## A. Decide a request

1. Open the queue. Each entry shows the student, relationship (*Current student*, *Former
   student*, *Not on your roster*), the term, the reported result and — where the college already
   has a verified value that differs — the conflict.
2. Check the result against the college's own record (examination office register).
3. **Confirm** (recorded as `MATCHES_INSTITUTION_RECORD`) or **Reject** with a reason:
   `DOES_NOT_MATCH_RECORD`, `RECORD_NOT_FOUND`, `NOT_OUR_STUDENT`, `EVIDENCE_INSUFFICIENT` →
   **Confirm rejection**.
4. The decision and reason are audited. **Load more requests** pages through the queue.

Evidence documents show title, type and version only; they cannot be opened until the
per-version document consent (ADR-027) is built. Decide from the college's own record.

Former students may ask for verification after they have left — serve them as current ones.

## B. Upload a term's results

1. **Upload results** → use the template header
   `institution_student_id,term_sequence,term_label,scale,result,backlogs,qualification_type,programme`
   (up to 1 000 rows).
2. Choose why: `RESULTS_DECLARED`, `PAST_TERMS_BACKFILL`, `CORRECTED_SHEET` → **Validate
   results**.
3. Read the preview. Each row is CREATE (new verified term), CONFIRM (matches what the student
   reported), UNCHANGED, CONFLICT (the student reported something different — both are kept and
   flagged) or INVALID.
4. Any INVALID row means nothing is written; fix and validate again.
5. Commit. If records changed since the preview you are asked to validate again.

Imported terms are *Verified by the institution*; nothing a student reported is overwritten.

## Never do

- Never confirm from a screenshot or a phone call; use the college's own record.
- Never upload another college's or a test file into a live college.

## Gaps

- **Evidence cannot be opened** (ADR-027 per-version consent not built).
- The rejection reason is not shown to the student; students are not notified of decisions.
- An already-verified term cannot be corrected; conflicts are reported only.
- Placement officers have no web screen for the queue.
- Android: faculty, administrators and department heads can confirm or reject; upload is web-only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J4.
