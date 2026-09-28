# ADR-038 — A Campus Drive Is an Opportunity Published to One Institution Through That Institution's Approval

**Status:** Accepted by default under AGENTS.md ("ask once, recommend, carry on"); Divakar may override
**Date:** 2026-09-29
**Goal:** EMP-11 (Appendix 2), item 1
**Relates to:** ADR-019 (institution visibility of applications is the student's choice), ADR-020 and
ADR-024 (no readiness numbers, no compensation to colleges), ADR-023 (navigation), ADR-035 (migrations
apply once)
**Design:** `docs/architecture/campus-drives-table-design.md`

## Context

Campus hiring in India runs through the college placement office. ONE lets an employer target a college
with an `INSTITUTION` audience row, but that row takes effect the moment the employer writes it: the
college is not asked, cannot say no, cannot attach its placement rules, and cannot see how the drive
went. EMP-11 has to give the placement office the decision, without forking the hiring pipeline that
EMP-05 to EMP-09 built on the opportunity (versions, eligibility, snapshots, access grants, stages,
interviews, offers, notifications).

## Decision

A campus drive is **the employer's existing job, offered to one college, which reaches that college's
students only while the college has approved it**.

- The drive is a row (`campus_drives`) naming the job and the college, with a state the college
  controls. Only the college can move it to `APPROVED` or `SCHEDULED`.
- Student visibility is derived: a published job is visible to a student when an audience row matches
  them or when a drive for it is `APPROVED`/`SCHEDULED` at a college they currently belong to. Nothing
  is copied into `opportunity_audiences`, so cancelling or completing a drive removes that route on the
  next request.
- An application to a job with a live drive at the student's college is linked to the drive, and the
  college's placement policies are enforced for it at apply — whichever listing the student used.
- Candidate data still reaches the employer only through the applicant-access grant written at apply.
  The drive grants nothing.
- The college sees drive results as suppressed counts after completion, and named results only for
  students who shared that application with it.

## Rejected

- **A drive as a separate job object** (its own title, terms, applicant list). It would duplicate
  versioning, eligibility, snapshots, grants, stages and notifications, and a student would see the same
  role twice. Every later goal (EMP-12 assessments, EMP-15 reports, INST-12 register) would have to
  handle two kinds of job.
- **Drives without approval** — the employer selects colleges and the job goes live. This is what the
  `INSTITUTION` audience already does; it is the gap EMP-11 exists to close.
- **Approval writes an `INSTITUTION` audience row.** Two copies of one fact: the audience table does not
  record who wrote a row, so cancellation could remove an audience the employer set directly, or leave
  the drive's behind.

## Consequences

- Publish and reopen accept a pending or live drive as the job's audience, so a drive-only job can be
  published before the college decides; it reaches nobody until approval.
- The direct `INSTITUTION` audience remains for existing jobs. Retiring it for new jobs, so that every
  college-targeted job goes through approval, is left to Divakar (design doc, open point 1).
- Drive categories and ranked tier exceptions arrive with INST-12; EMP-11 ships one per-drive exception
  flag set by the college.
- No navigation item is added (hard gate HG-3): the placement officer decides drives from a Dashboard
  section, the admin from Placement, policies sit in the admin's Settings and on the officer's
  Dashboard, and the employer requests drives from Opportunity Detail.
