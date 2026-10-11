# SOP — Exporting a job's applicants (CSV) and calendar invites

> What this is: employer-facing help for downloading one job's applicants as a spreadsheet file,
> and a note on calendar invites, with the matching operator steps. Why it exists: Appendix 2
> EMP-18 asks for an SOP per shipped module; this covers EMP-17. Written 2026-10-01 against base
> `719eb34`.

## For employers

### Who

**Owners and admins** of a verified, active employer. Recruiters do not see the export.

### Where

**Employer Portal → Applicants → Export applicants** (web only; a CSV is a desk task).

### Steps

1. Choose the job, then **Reason for this export**: `SHORTLIST_REVIEW`, `INTERVIEW_PLANNING`,
   `HIRING_COMMITTEE`, `OFFER_PREPARATION` or `RECORD_KEEPING`.
2. Choose **all open applicants** or **Shortlisted onward**.
3. Download. The file is named after the job and today's date.

### What is in the file

- Only candidates whose grant is live **at the moment you export**: no one who withdrew, was
  rejected or hired, whose grant expired, or who asked to be deleted.
- Only what each student shared in their application snapshot, plus stage and dates.
  Applications from before snapshots are marked *Not captured*.
- **Contact details only from Shortlisted onward.**
- Never: readiness, internal identifiers, roll numbers, compensation or protected attributes.
- Any cell that starts with `=`, `+`, `-` or `@` begins with an apostrophe, so a spreadsheet
  treats it as text, not a formula. A phone number appears as `'+91…`.

### Limits

At most 5,000 rows per file (`EXPORT_TOO_LARGE` — export Shortlisted onward instead) and 20
exports per person per employer in 24 hours (`EXPORT_RATE_LIMITED`). Every export is recorded
with your name, the reason, which applications left and a fingerprint (SHA-256) of the file.

### Calendar invites

Interview invites are the calendar files described in
[sop-employer-interviews.md](sop-employer-interviews.md). ONE does not connect to Google or
Microsoft calendars and has no two-way sync.

### Never do

- Never keep an export after the hiring decision it was made for.
- Never forward an export outside your hiring team.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| "Whose data left in which file?" | Search the audit log for `employer.applicants.exported`: actor, job, reason, scope, row count, the exported application ids and the file's SHA-256 |
| A student asks whether an employer exported them | The audit row lists application ids; answer through a support case ([../ops/sop-support.md](../ops/sop-support.md)) |
| Suspected misuse of exported data | Open a trust case about the employer; consider suspension ([../ops/sop-organizations.md](../ops/sop-organizations.md) §B) |

## Gaps

- One job per export; no export across jobs. Assessment results and scorecards are not exported.
- There is no operator screen for exports beyond the audit views.
- No Android export (deliberate).

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J9.
