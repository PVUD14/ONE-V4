# ADR-043 — Employers May See Consented, Per-Skill Verified Evidence; Never Readiness

**Status:** Accepted — Divakar approved hard gate **HG-4** on 2026-10-01 ("HG-4: YES"). The feature
still ships off: the flag `employer.skill-evidence` is off by default and is switched on through
Operations → Feature flags, with a second person (or the solo-operator cool-off) confirming it.
**Date:** 2026-09-30
**Goal:** EMP-13 (Appendix 2)
**Relates to:** ADR-020 (readiness is an advisory band, never shown to an employer), ADR-034 (evidence is
immutable; stages are fixed at capture), ADR-019 (per-application consents are separate and revocable)
**Design:** `docs/architecture/application-evidence-shares-table-design.md` (migration 0093)

## Context

The master plan's acceptance C12 once read "an employer sees readiness only for students who granted
employer-evidence-sharing". AGENTS.md forbids exposing readiness to an employer, and `readiness_snapshots`
enforces it (`employer_visible` CHECK false). The program replaced C12 with EMP-13: employers may see a
student's verified evidence per skill, never readiness (Part B.9). The evidence model exists (ENG-04) and
jobs can name catalogue skills (EMP-06); this ADR decides what an employer may see of it.

## Decision

An employer may see, **for one application, only through the live applicant-access grant, only when the
student chose it for that application**, and only for skills the job lists from the ONE catalogue:

- which job skill the item is shared against (as the employer wrote it, REQUIRED or PREFERRED);
- the kind of evidence (an assessment outcome, a topic demonstration);
- its source (a ONE skill check, an institution exam);
- the date it was recorded;
- whether it was unaided.

For a job skill with nothing shared the employer sees "no evidence shared". An item is shareable only if
ONE recorded it from graded work after the skill had reached the learning model's DEMONSTRATED stage
(unaided success on two different days), with something answered correctly, not superseded — see the
design for the exact rule.

An employer **never** sees: a readiness band or score; a gap status (MET, PARTIAL, MISSING, UNKNOWN); a
mastery value; the stage; the marks behind an item (`demonstrated`/`possible`) or any ratio; a count, total
or percentage of evidence; a ranking or a sort by evidence; any single "fit" number; any identifier of the
evidence, or of a skill on a candidate's panel (the job's catalogue-skill key appears only as the
applicant filter's value, and is never displayed); anything the student did not choose.

The employer may **filter** (not rank) a job's applicants by "has shared evidence for skill X" (decision
10.2 #5); the list keeps its own order.

The student chooses item by item — while applying, or later from the application — sees exactly the fields
the employer would see, and can take any item back at any time; the next employer request no longer
returns it.

## Why a per-skill list, not a score

- **A score is readiness by another name.** Any single number summarising a person's evidence is a model
  output presented as a fact about them — precisely what ADR-020 and AGENTS.md rule out for employers.
  It would also be the input to automated ranking, which the employer plan forbids (§0.5: evidence and
  eligibility inform; a person decides).
- **A list keeps the claim checkable.** Each item is one thing ONE observed, with a date and a source.
  The employer can weigh it, ask about it in an interview, or ignore it. Nothing is inferred on the
  student's behalf.
- **Consent can be granular only over items.** "Share my score" is all-or-nothing; a list lets a student
  share their SQL work with a data-analyst job and nothing else.
- **Counts were rejected too.** "7 evidence items" is a score with extra steps and rewards volume over
  substance; the panel lists items and never totals them.

## Alternatives rejected

- **Show the readiness band to consenting employers (old C12).** Forbidden by AGENTS.md and the
  `readiness_snapshots` constraint; not an option to reopen here.
- **Show the skill stage (DEMONSTRATED / TRANSFERRED).** It is a mastery-like judgement produced by a
  model, and it would invite employers to rank by it. It is used only as the qualifying rule.
- **Show marks per item (e.g. 8 of 10).** A score per item; aggregates trivially into a ranking.
- **A global consent key for all employers.** Replaced by the per-application choice (Part B.9); a global
  key over-shares with employers the student never chose for this.
- **Match free-text job skills by name.** A name guess would show evidence against skills that are not the
  same thing; only catalogue topics match.

## Consequences

- One new table (`application_evidence_shares`, 0093) with database guards against sharing another
  person's evidence, and a new audited employer route, a filter on the applicant list, and a student
  choice at apply and on each application (web and Android).
- Revocation is effective on the next request because every read checks the share and the grant in SQL.
- Privacy deletion revokes every share with the grants; the export lists them.
- Until HG-4 is approved the flag stays off: the preview offers nothing to share, apply refuses evidence
  choices, the employer route returns `available: false` without reading anything, and the filter is
  refused. Revoking remains possible for any share made while the flag was on.
