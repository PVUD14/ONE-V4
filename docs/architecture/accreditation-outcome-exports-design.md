# Accreditation-Ready Outcome Exports — Design

**Status:** Adopted (INST-13), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0083_student_outcome_declarations.sql` — the self-report source; see
`student-outcome-declarations-table-design.md`. The export itself adds no table.
**Relates to:** ADR-018 (analytics is a capability), ADR-019 (consented applications), ADR-020 (bands only),
ADR-024 (no compensation to institutions; decision 10.2 #6), `institution-exports-design.md` (INST-08: the
capability gate, write scope, reason codes, CSV writer, row cap, daily limit, audit before sending),
`placement-register-design.md` (INST-12: the period, the population and "placed")

## Why this exists

Colleges assemble outcome figures for NAAC, NBA and NIRF submissions every cycle, by hand, from
spreadsheets the placement office keeps. ONE already holds part of that picture — who graduated from
which department and programme, and who was placed through applications they shared with the college —
and a ready file is a strong renewal reason (INST-13). The risk is the opposite of the benefit: a file
that looks like an official template invites a college to submit it unchecked, and any figure ONE does
not actually hold would be invented. This document fixes what the file contains, where each figure
comes from, and what is left NA.

## What the file is — and is not

- **One CSV, `accreditation-outcomes`, on the existing exports framework (INST-08).** Same gate
  (`INSTITUTION_ANALYTICS`, ADR-018: institution admins and department heads holding a live grant; 403
  for everyone else, audited `institution.export.denied`), same **write scope** (a head exports their
  department; a head with no department gets `SCOPE_REQUIRED`), same reason code, CSV-injection-safe
  writer, 10 000-row cap, 30-per-day limit, and the audit row
  (`institution.accreditation_outcomes.exported`) committed **before** the file is sent.
- **Aggregates only.** Every figure is a count of people, suppressed through `aggregate-suppression.ts`.
  No name, roll number, employer or internal identifier is in the file.
- **Not a template.** The first rows of the file say, in plain words, that the college must check every
  figure against the current official template before submission and that ONE does not claim the file
  complies with any format. ONE does not reproduce any body's form, numbering or wording.

## Period and population

- **Period: a stock as of the end of the last ended calendar month** — INST-12's period, from the
  database clock (`T` = first instant of the current UTC month). No caller-chosen period and no unit
  filter: a chosen window, or a filtered table beside an unfiltered one, can be differenced to isolate
  one graduate (INST-SR-01, INST-12). Two exports in the same month are identical.
- **Graduates:** students on the roster inside the export scope, account active, with a `GRADUATED`
  relationship with the college that began and ended (`effective_to`) before `T`. This is a subset of
  INST-12's eligible population, which is why the placed figures reconcile.
- **Year of graduation:** the UTC calendar year of the recorded graduation date (`effective_to`; the
  latest, if a student graduated twice). Academic years were rejected: each college (and each body)
  defines them differently, and INST-05's calendar is institution-edited. The college regroups years to
  its template's academic year if it must; the file says which convention it uses.
- **Groups:** department × programme × year of graduation, from the student's roster profile. A
  student with no department or programme is grouped under "No department" / "No programme".
  Transferred, ended and revoked students are not graduates of the college and are not counted.

## One partition per graduate

Each graduate is counted **once**, in the first stage that applies:

| Stage | Source | Label in the file |
|---|---|---|
| `PLACED` | INST-12's rule, **the same code path**: an offer accepted, or the application hired, on an application the student shared with the college, dated before `T` and inside the relationship (so before graduation) | Placed (applications shared with the college) |
| `HIGHER_STUDIES` | A live self-report shared with this college, declared before `T` (0083) | Higher studies (self-reported) |
| `ENTREPRENEURSHIP` | A live self-report shared with this college, declared before `T` (0083) | Entrepreneurship (self-reported) |
| `NONE_SHARED` | None of the above | No outcome shared |

- **Placed first**, so the Placed column is exactly INST-12's placed count for those graduates — the
  acceptance ("counts reconcile with INST-12") holds by construction, and the integration test checks
  it against the placement statistics endpoint. A graduate who was placed and also declared higher
  studies counts once, as placed; the file says so.
- **"No outcome shared" never means unplaced** (INST-12's rule): it is everyone the college has no
  shared record for.
- **Suppression:** the groups-by-stage table with its margins goes through
  `suppressGroupedPartition` (cells and row totals per group; column totals and the grand total
  withheld under 5 or when they would recover a withheld group). Withheld cells read `<5`; a withheld
  total reads `Withheld`.

## Mapping to commonly requested fields

Names and numbering change between cycles and programmes, so this maps to the **kind of figure**
commonly requested, not to a metric number. Anything ONE does not hold is **NA** in every row.

| Commonly requested (NAAC, NBA, NIRF) | Column | Source in ONE |
|---|---|---|
| Outgoing / graduating students, by programme and year (all three) | Graduated | `GRADUATED` relationships + roster profile |
| Students placed (NAAC placement of outgoing students; NBA placement; NIRF placement) | Placed (applications shared with the college) | Shared applications (ADR-019), INST-12's rule |
| Students progressing to higher education (NAAC; NBA higher studies; NIRF higher studies) | Higher studies (self-reported) | 0083, self-reported, consented |
| Entrepreneurs (NBA entrepreneurship) | Entrepreneurship (self-reported) | 0083, self-reported, consented |
| Median salary / package (NIRF; NBA and NAAC per-student lists) | Median salary or package | **NA** — ONE never gives institutions offer pay, individually or in aggregate (ADR-024, decision 10.2 #6) |
| Students graduating within the programme's normal duration (NIRF; NBA success rate) | Graduated within normal duration | **NA** — ONE records a graduation date, not the programme's stipulated duration or each student's admission cohort reliably |
| Students qualifying in national or state examinations (NAAC) | Qualified in national or state examinations | **NA** — ONE holds no examination results of that kind |
| Per-student lists (names, employer, institution admitted to, venture) | — | **Not produced.** Aggregates only; per-student placement status stays on INST-09's audited screen, and self-reports carry no detail |

The goal says salary fields are "left empty with an explanatory note"; the file writes `NA` in them
(the house rule for a missing source: NA, never blank or invented) and a note row says why.

## The file

`one-accreditation-outcomes-<YYYY-MM>.csv`, the writer's usual BOM, CRLF and quoting. Columns:

`Row, Department, Programme, Year of graduation, Graduated, Placed (applications shared with the college),
Higher studies (self-reported), Entrepreneurship (self-reported), No outcome shared, Graduated within
normal duration, Qualified in national or state examinations, Median salary or package, Note`

Rows, in order:

1. `Note` rows (every other cell empty), stating: prepared on <date> from records as of <last day of the
   month>; **check every figure against the current official template before submission — ONE does not
   claim this file complies with any format**; how Placed is defined; that higher studies and
   entrepreneurship are self-reported by graduates who chose to share them and are not verified; that
   each graduate is counted once, placed first; that "No outcome shared" does not mean unplaced; the
   year convention; `<5` and `Withheld`; and why each NA column is NA.
2. `Group` rows: one per department × programme × year, newest year first.
3. One `All graduates in scope` row (the column totals and grand total), year `All years`.

No readiness, band or score of any kind appears (ADR-020); no query reads `offers.compensation_*`
(ADR-024) and the writer's header check refuses any compensation column.

## Surfaces

- **Web:** a fifth entry, "Accreditation outcomes", in the existing Exports panel on the admin
  **Reports** page and the department head's **Reports and Analytics** page. No month or unit picker
  (fixed period, whole scope). Navigation is unchanged (HG-3).
- **Student (web and Android):** the self-report on **Profile** (see the table design).
- **Android: no export.** Exports are desk files (a spreadsheet assembled for a submission), exactly as
  INST-08 recorded; the Android institution workspace carries no Reports exports. The student
  self-report *is* on Android, because it is the student's own choice and must match the web.

## Rejected options

- **NA for higher studies and entrepreneurship, no source.** Honest, but the goal names the source;
  building a small consented self-report is not inventing data.
- **Separate NAAC / NBA / NIRF files in each body's layout.** Rejected: implies format compliance ONE
  cannot promise, and every layout change becomes a bug. One neutral file plus this mapping.
- **Counting placement from external applications (0019).** A declared external offer is not an
  accepted offer ONE saw; INST-12 excluded it and reconciliation requires the same rule.
- **A per-year request parameter.** Rejected: a chosen year beside the whole file is a linked table; the
  file already carries every year.
- **Academic-year grouping.** Rejected above (institution- and body-specific).
- **Opening the export to the placement officer.** ADR-018 limits `INSTITUTION_ANALYTICS` to admins and
  department heads (0031's trigger). Not changed here; recorded below.

## Decisions for Divakar

1. **Self-report source built (0083)** rather than NA — see the table design.
2. **Declarations after graduation count** (student-initiated, revocable, suppressed count only), which
   reaches past the relationship policy's historical cut-off for this one fact. Recommended: keep.
3. **Each graduate counted once, placed first**, so Placed reconciles with INST-12.
4. **Year of graduation = calendar year of the recorded graduation date.**
5. **Graduates only**: final-year students expected to graduate are not counted until a graduation is
   recorded (INST-10's batch action records it).
6. **Placement officers cannot run it** (ADR-018). Recommended: keep; an admin who prepares accreditation
   holds the grant (`ACCREDITATION_LEAD` is already a grant reason).
7. **Residual differencing** (as INST-08 and INST-12 recorded): a head's department file and an admin's
   college file are linked tables; consecutive months give each month's movement; a relationship,
   consent or declaration change after a month ends changes that month's figures. All counts stay under
   the one threshold.
