# ADR-036 — Counselling Notes Are a Restricted Staff-Action Type

**Status:** Accepted by default under AGENTS.md ("ask once, recommend, carry on"); Divakar may override
**Date:** 2026-09-28
**Decision:** Institution plan decision 10.2 #5 — recommended answer adopted
**Relates to:** ADR-018 (role consolidation: counsellors are served by staff-action types, not a role),
ADR-019 and ADR-027 (consent-gated institution reads, whose audit and relationship habits this reuses)
**Design:** `docs/architecture/counselling-notes-table-design.md`

## Context

ADR-018 removed "career counsellor" as a role and said counselling would be served by staff-action
types. The only type that fits today, `FACULTY_NOTE`, is readable by every staff member whose unit
scope covers the student. Counselling content is sensitive personal data; the institution plan
(Section 5.2) says it must be readable only by the author, institution owners and admins, and staff
explicitly added to that student's counselling case.

## Decision

1. Counselling is a staff-action type, `COUNSELLING_NOTE`, stored in `staff_actions`, with a CHECK
   that forbids the workflow columns (due date, meeting window, exam, evidence) that would surface it in
   calendars and dashboards.
2. Access is **not** the unit scope. A note is readable by: owners and admins; its author while the
   student remains in the author's INST-02 read scope; and members of that student's counselling case
   (`counselling_case_participants`), added and removed by owners and admins with reason codes.
3. Notes are written within the INST-SR-02 write scope (or by a case participant); `SCOPE_REQUIRED`
   when the writer has no scope at all.
4. Default visibility to the student is `STAFF_ONLY`; the author, an owner or an admin may share a note
   with the student explicitly.
5. Every read and write is audited in the same transaction, and no audit row carries note text.
6. Notes are excluded from every aggregate, export, calendar and employer surface, are erased by the
   privacy-deletion flow, and are summarised (shared text, staff-only count) in the student's export.

## Rejected

- **A counsellor role or an institution-wide capability** — would grant every holder every student's
  notes; the need is per student.
- **A separate notes table** — duplicates the relationship, scope and audit machinery; isolation is
  obtained instead by type filters and a static test over every `staff_actions` query.
- **Unit-scope reads (as `FACULTY_NOTE`)** — the exposure this ADR exists to remove.

## Consequences

- Any new query over `staff_actions` must filter on `action_type`; a static test enforces it.
- Department heads and faculty lose nothing they have today: no counselling notes existed.
- Retention beyond deletion and offboarding is an open decision (design doc, Open points).
