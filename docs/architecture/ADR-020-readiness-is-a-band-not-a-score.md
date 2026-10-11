# ADR-020 — Readiness Is a Band, Not a Score

**Status:** Accepted
**Decision date:** 2026-09-05
**Scope:** How career readiness is presented in every client — web, mobile and any future surface

## Context

Every readiness widget in the product showed **NA/100**, and this was recorded as a missing scoring
engine. It is not. The engine is built, has run in production, and its result already reaches the
browser.

At the time of this decision the production database held one active readiness model version, seven
readiness snapshots, fourteen readiness factors and fourteen mastery projections over seventy-one
evidence records. `GET /api/v1/career-readiness/me` already returns `readiness.band`, the per-topic
`mastery` projections, the factor explanations and the roadmap actions, and the student dashboard
already rendered the band chip beside the empty `/100`.

What is absent is a **number**, and the domain refuses to produce one deliberately. Readiness is
modelled as a four-value advisory band —

```
NOT_ENOUGH_EVIDENCE → DEVELOPING → PROGRESSING → READY_FOR_NEXT_STEP
```

— and `readiness_snapshots` pins that choice in the schema: `advisory boolean NOT NULL DEFAULT true
CHECK (advisory)` and `employer_visible boolean NOT NULL DEFAULT false CHECK (NOT employer_visible)`.
Those are not defaults someone forgot to make configurable. They are CHECK constraints that make the
opposite state unrepresentable.

The `/100` ring came from the pilot design, which was drawn before the domain was modelled. The
mismatch is between a picture and a decision, and the decision is the one with reasons behind it.

## Decision

**Readiness is presented as an advisory band. No client computes, projects, infers or displays a
numeric readiness score.**

- The overall widget shows the current band, with the existing `readiness_factors` as its legend.
- Per-category widgets are driven by the per-topic `mastery` projections, which are themselves
  banded, not scored.
- Where no snapshot exists yet, the widget says so plainly — the pilot composition is kept and the
  absence is stated, per the standing pilot-parity rule.
- Readiness remains advisory and never employer-visible. This ADR does not weaken invariant 6, DP-011
  or the CHECK constraints, and must not be cited to justify doing so.

## Why not a numeric score

A number would have to be defended. A student who sees 63/100 will reasonably ask what the missing
37 is, and any answer we give is a precision the evidence does not support — the underlying model
counts demonstrated-over-possible across a small number of active evidence records and deliberately
reports a band because that is the resolution the evidence justifies.

A number also travels. It invites league tables, cohort ranking and employer requests, and the
product has already decided in the schema that readiness must never reach an employer. A band with
explanations is harder to misuse than a number with none.

If a numeric score is ever genuinely required, it needs a new ADR superseding this one, a model that
can defend the precision, and a migration removing two CHECK constraints. That is the correct cost.

## Consequences

- The `NA/100` disappears from the student dashboard, the readiness page and all four institution
  staff dashboards at once — six surfaces, from one presentation change and no new engine.
- The mobile client must follow the same rule. A band on web and a score on mobile would be worse
  than either.
- Anyone reading the old reality matrix will believe a scoring engine is outstanding. It is not, and
  that document is being corrected.
- Category widgets are limited to topics with mastery projections. Topics with no evidence show as
  not-enough-evidence rather than zero, which is the honest distinction and the one the band
  vocabulary already makes.

## Status of implementation

Implemented in Stream D on `stream/d-santhosh/readiness-band-ring`, which replaces the numeric ring
with the band, adds published topic names so factors can be labelled from real data, and tightens
the existing test to assert that `/100` no longer appears anywhere in the authenticated shell.
