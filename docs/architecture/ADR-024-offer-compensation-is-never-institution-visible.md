# ADR-024 — Offer Compensation Is Never Institution-Visible

**Status:** Accepted
**Decision date:** 2026-09-06
**Scope:** Whether an institution may ever see offer compensation, per student or in aggregate
**Relates to:** ADR-019 — confirms its exclusion; does not amend it
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

ADR-019 settled what an institution may see about its own student's application: employer identity,
opportunity title, application stage and its timestamps, and whether an offer exists with its
response state — all only where the student granted a distinct, revocable institution-visibility
consent and the relationship is active.

It excluded offer compensation terms, and deliberately left one door open:

> If placement reporting later needs compensation, that is a separate decision amending this ADR —
> not an implementation detail to be settled in a pull request.

Placement reporting is now scheduled work, so the question is live rather than hypothetical. It
needs an answer before the institution read path is written, because the cheapest moment to exclude
a column is before anyone selects it.

## Decision

**An institution never sees offer compensation — not for an individual student, and not in
aggregate. ADR-019 stands unamended.**

Placement reporting reports placements: counts, stages, offer existence, response states,
conversion. It does not report pay.

## Why not aggregate

Cohort-level pay statistics — a median or a range by batch — are the most defensible version of the
request, and they are still rejected:

- Small cohorts reverse-engineer to individuals. A batch of six with one outlier discloses that
  outlier to anyone who can see the median move.
- Defending against that means a minimum-cohort-size rule. Its threshold is arbitrary, it has to be
  enforced on every query rather than every screen, and it becomes a permanent policy surface that
  someone must maintain and audit. That is a large ongoing cost for a reporting nicety.
- Compensation is the most sensitive field in the hiring domain and the one a student is least
  likely to expect their college to hold. Consent granted so a placement officer can see that an
  offer exists is not consent for the college to learn what the student is paid.

The aggregate case is the one most likely to be re-argued. It is refused here explicitly so that it
has to be re-argued as an ADR rather than absorbed as a reporting requirement.

## Consequences

- `offers.compensation_currency`, `compensation_amount` and `compensation_period` remain
  employer-and-student-scoped. **No institution read path may select them**, including into an
  aggregate, a report generator or an export.
- Placement officers and institution marketing will ask for this, and the documented answer is no.
  As with ADR-019, the value of writing it down is that the answer does not have to be re-derived
  under pressure each time.
- Institution aggregate reporting can proceed immediately on everything else, since cohort counts
  and stage distributions disclose no individual and need no per-application consent.
- Reversing this needs a new ADR superseding it, plus privacy review, plus a minimum-cohort rule
  designed before rather than after. It is not a pull-request decision.
