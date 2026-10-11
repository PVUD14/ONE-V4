# DRAFT — FOR LEGAL REVIEW — NOT PUBLISHED

> Proposed first-run notice the ONE Android app shows a growth (partnerships) staff member before it asks,
> the first time, for permission to read the phone's approximate location when they tap "Attach my
> location" on a visit (GROWTH-06; `docs/architecture/growth-portal-design.md` §14.3,
> `docs/architecture/growth-field-work-table-design.md` §6.1; decision O-23). Nothing here is published
> until Divakar approves it (program hard gate HG-6). Every bracketed item must be settled by legal review.
>
> **DRAFT.** Version: `draft-2026-10` (`GROWTH_LOCATION_NOTICE_VERSION`,
> `packages/authorization/src/growth-field.ts`). The text below is the same text the API serves to the app
> and the web Field page with the label "Draft for legal review"; a change here must be made there too (a
> unit test compares the two).

## Who this notice is for

AI8HT's own growth staff — employees and contractors (D13) — who log field visits in ONE. They are data
principals too (design §13.5): their visit locations are their personal data. [Legal review: confirm the
basis for processing a staff member's location — consent at the tap, or the employment-related legitimate
use under section 7(i) of the Digital Personal Data Protection Act, 2023 — and whether contractors need a
different wording from employees.]

## Proposed notice text (DRAFT)

Attaching your location to a visit is optional. A visit without a location is a complete visit.

ONE reads your phone's approximate location only at the moment you tap "Attach my location", and never in the background.

It is stored rounded to about 100 metres, with the accuracy your phone reported, beside that one visit.

Only you and your manager can see it. It shows that the visit was logged at or near the organisation's area.

It is never used for attendance, pay, performance ratings or discipline.

It is erased automatically 180 days after the visit was logged. You can remove it from any of your visits sooner, and it is included when you ask for a copy of your data.

## Notes for legal review

- [Whether the notice must name the manager who can see the location, or whether "your manager" suffices.]
- [Whether a staff member's refusal must be recorded anywhere. The design records nothing: a refusal simply
  means no location is attached.]
- [Whether 180 days is the right period for contractors as well as employees.]
- The words "never used for attendance, pay, performance ratings or discipline" are a promise the product
  keeps by construction: no screen or export aggregates location by person or by day.
