# Institution Settings, Grading Scales and Academic Calendar — Table Design

**Status:** Adopted (INST-05), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0044_institution_settings.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Defect I-6 (INST-00, confirmed): `organization_profiles` (0005) is written only by Operations and
there is no institution-side settings or profile API. The admin's **Settings** item says "Not built
yet"; faculty and department heads see "View-only for your role"; the placement officer has no
Settings item at all (and gets none — navigation does not change).

Three things are missing, and two of them carry consequences:

1. **The college's own description** — what the college says about itself and who students and
   employers contact about placements. Low consequence, but it touches the same profile row
   Operations verifies against.
2. **Grading scales per programme.** Employer eligibility (EMP-06) compares a student's marks with
   a threshold. A BTech on a 10-point CGPA and a BCom issued in percentages cannot be compared
   without knowing which scale each programme uses. If ONE guesses, an eligible student is
   silently filtered out of a job, or an ineligible one is let through. This is the record a
   person's opportunities depend on.
3. **The academic calendar** — terms, examination periods and breaks, per college, programme or
   batch. Staff need it to plan; teaching assignments (INST-03) already record a term, as free
   text, "until INST-05 adds academic terms".

## Part 1 — the college profile

### Decision: Operations-verified fields stay on `organization_profiles`; the college's own fields go in a new `institution_settings` row

Operations verifies an institution against its **legal name**, **display name**, **website**,
**address**, **primary contact email** and **institution type**. The rule EMP-04 adopted for
employers holds here for the same reason: if the college could change those after verification, a
verified record would quietly stop describing the college that was verified. So the settings API
**reads** those fields from `organization_profiles` and never writes them; a request that names any
of them is refused with `403 INSTITUTION_PROFILE_FIELD_OPERATIONS_CONTROLLED` and changes nothing.
The screen shows them read-only, "Managed by AI8HT operations".

What the college writes itself:

| Column | Notes |
| --- | --- |
| `institution_id` | uuid PK → `organizations(id)`; a trigger requires `kind = 'INSTITUTION'`. |
| `about_text` | text NULL, 1–2000 characters, must not start with `= + - @` (it will reach exports). |
| `placement_contact_email` | text NULL, lower-case, ≤ 254, email-shaped. The placement office's address — distinct from the verified primary contact. |
| `updated_by_user_id` | uuid NOT NULL → `users(id)`. |
| `created_at`, `updated_at` | timestamptz. |

**Rejected: reuse the `about_text` column 0041 added to `organization_profiles`.** 0041 guards those
columns with a trigger that refuses them on anything but an employer. Using them for colleges means
redefining that trigger — relaxing a constraint to make a feature easier, which AGENTS.md forbids —
and it would mix a college-written field into the row Operations owns.

**Rejected: let the college edit the verified fields and send it back to review.** Same reasoning
as EMP-04: it turns a typo fix into a verification event. The college asks Operations, who already
has the edit route.

**Rejected: a logo now.** Storing an uploaded image needs the file store and scanner configured
(they report themselves unavailable until then). A column nobody can fill is not added; the logo
comes with the upload, in its own migration. The college is shown by name, never by a placeholder.

**Rejected: display settings (colours, short names).** The pilot design system is the UI for every
client; a college-chosen colour or short name is either unused or a second brand. Nothing to store.

## Part 2 — `institution_grading_scales`

### The rule this table exists to keep

**A programme without a grading scale is NA wherever a scale is needed — never a guessed scale.**
So there is deliberately **no institution-wide default** and no fallback: a default would be a guess
for every programme that differs from it. EMP-06 reads the programme's row, and if there is none it
must treat the comparison as not possible (NA), not assume CGPA.

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `institution_id` | uuid NOT NULL → `organizations(id)`. |
| `program_unit_id` | uuid NOT NULL; composite FK `(program_unit_id, institution_id)` → `institution_units(id, institution_id)`, so a scale can never point at another college's unit. A trigger requires the unit's kind to be `PROGRAM`. |
| `result_scale` | text NOT NULL, one of `CGPA_10`, `GPA_4`, `PERCENTAGE`, `LETTER`, `PASS_FAIL` — **exactly the 0070 academic-records scale list**, so a programme's scale and a student's term result use one vocabulary. |
| `pass_threshold` | numeric(6,3) NULL. Only on the numeric scales, and within that scale's range (0–10, 0–4, 0–100) — the same per-scale ranges 0070 enforces on results. NULL on `LETTER` and `PASS_FAIL`. NULL on a numeric scale means "the college has not said", shown as NA. |
| `created_by_user_id`, `updated_by_user_id` | uuid NOT NULL → `users(id)`. |
| `created_at`, `updated_at` | timestamptz. |

`UNIQUE (institution_id, program_unit_id)`: one scale per programme.

**Why per programme, not per batch.** A programme's scale is set by its regulations; it changes
rarely and, when it does, a new regulation normally means a new programme unit. Per-batch scales
would multiply rows for no case we have. Revisit if a pilot college shows one.

**Why letter-grade pass rules are not modelled.** Which letters pass (and their order) varies by
university and is not needed until EMP-06 filters on letters. It is a new column in a new migration
when it is; until then a `LETTER` programme has no threshold, which reads as NA.

**Changing and removing.** Setting a programme's scale replaces the row; removing it deletes the row
with a reason code. Both are audited with the values before and after. This is configuration, not a
person's record: every student's term result keeps the scale it was **issued on** (0070 stores
`result_scale` per term, and never converts), so changing a programme's scale rewrites no student
data. What an eligibility check concluded at the time is EMP-06's to snapshot.

**Rejected: store the scale on `institution_units`.** It is a property of programme units only, and
adding a nullable column to every unit (departments, sections…) with a trigger that forbids it on
most of them is a worse shape than a small table.

## Part 3 — `institution_academic_terms`

Named `institution_academic_terms` because `student_academic_terms` (0070) already exists and means
something else: a period **of one student's record** (their semester 3 result). This table is the
**college's calendar**. The two are not linked by this migration.

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `institution_id` | uuid NOT NULL → `organizations(id)`. |
| `name` | text NOT NULL, 1–60, must not start with `= + - @`. E.g. "2026-27 Odd semester". |
| `kind` | text NOT NULL: `TERM`, `EXAMINATIONS`, `BREAK`. Dates only — not a timetable (Section 0.5: ONE is not an ERP). |
| `starts_on`, `ends_on` | date NOT NULL, `ends_on >= starts_on`, span ≤ 400 days. |
| `unit_id` | uuid NULL; composite FK to `institution_units(id, institution_id)`; a trigger requires `PROGRAM` or `BATCH`. NULL means the whole college. |
| `created_by_user_id`, `updated_by_user_id` | uuid NOT NULL → `users(id)`. |
| `created_at`, `updated_at` | timestamptz. |
| `archived_at`, `archived_by_user_id`, `archive_reason_code` | Set together (reason `^[A-Z0-9_:-]{3,64}$`) or not at all. |

A partial unique index keeps one live term of a given name per college-or-unit
(`institution_id, coalesce(unit_id, nil), lower(name)` where not archived).

**Archived, never deleted.** A teaching assignment will point at a term (below); deleting the term
would break that link. Archiving removes it from the calendar and keeps the row.

### How INST-03's free-text term relates — proposal, not built here

`faculty_teaching_assignments.academic_term` is `text NOT NULL` (1–40) and is part of the partial
unique index that stops the same assignment being active twice. INST-03's design already said a
later migration "adds a nullable `academic_term_id` beside it rather than rewriting this column".
The migration-safe plan, for the goal that needs it (INST-07, or when a college asks):

1. A new migration adds `faculty_teaching_assignments.academic_term_id uuid NULL` with a composite
   FK to `institution_academic_terms(id, institution_id)`. No existing row changes.
2. The assignment form offers the college's calendar terms; choosing one stores its id **and** copies
   its name into `academic_term`, so the NOT NULL column, the unique index and every existing reader
   keep working unchanged. Free text stays allowed for colleges without a calendar.
3. Existing rows are left as they are. An optional, admin-triggered, audited "link to calendar" step
   may set `academic_term_id` where the free text equals a live term's name (case-insensitive) in the
   same college; nothing is matched automatically and nothing is rewritten.
4. Faculty scope does **not** start depending on term dates: an assignment's own
   `starts_on` / `ends_on` stay the rule INST-03 tested.

It is not built in INST-05 because nothing reads the link yet and INST-03's data must not move.
`name` is capped at 60 characters, but only names of 40 or fewer fit `academic_term`; step 2 will
refuse (or truncate with a visible warning) a longer name — to be decided with the form.

## Part 4 — staff notification preferences: reuse `notification_preferences`

`notification_preferences` (0004) is already per **user** — email on/off, quiet hours, daily cap —
and staff are users. No new table. The staff Settings screen reads and writes the caller's own row.
Honesty point for the screen: ONE sends staff no reminder emails yet (the only sender that reads
this row today is the student assessment reminder). The screen says so; the preferences apply once
staff notifications exist (INST-06 announcements).

## Who may do what

| | Owner / admin | Department head | Faculty | Placement officer |
| --- | --- | --- | --- | --- |
| College profile, grading scales, calendar | read and write | read | read | read (API only — no Settings item) |
| Own notification preferences and staff profile | read and write | read and write | read and write | read and write (API only) |
| Operations-verified fields | read | read | read | read |

Every write is one transaction with an `audit_events` row (`institution.settings.updated`,
`institution.grading_scale.set` / `.removed`, `institution.academic_term.created` / `.updated` /
`.archived`, `user.notification_preferences.updated`) carrying the changed fields and, for scales
and terms, the values before and after. No outbox events: nothing consumes them yet (INST-03 made
the same call); EMP-06 reads the table directly.

Placement policies and data-processing terms are shown on the admin Settings screen as honest
"Not built yet" sections: there is no placement policy engine (EMP-06 / INST-12), and the terms are
INST-18's.

## Open points (decisions for Divakar)

1. **Grading scale granularity:** per programme, no institution-wide default. *Recommended; the
   no-default rule is what keeps "never a guessed scale" true.*
2. **Letter-grade pass rules:** not modelled until EMP-06 needs them. *Recommended.*
3. **College-editable profile fields:** about and placement contact email only; everything Operations
   verifies stays with Operations. *Recommended, consistent with EMP-04.*
4. **Teaching-assignment terms:** keep INST-03's free text; link to the calendar later by the
   additive plan above. *Recommended.*
5. **Which grading scales do the pilot colleges use?** (Appendix 3 §10.3, still open.) The table
   takes any of the five; the answer only decides what the colleges enter.
