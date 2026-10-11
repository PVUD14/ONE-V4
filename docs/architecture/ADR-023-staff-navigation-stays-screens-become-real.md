# ADR-023 — Staff Navigation Stays; The Screens Become Real

**Status:** Accepted
**Decision date:** 2026-09-06
**Scope:** The Faculty and Department Head sidebars, and the priority of the staff-action screens
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

Faculty presents fifteen navigation items, of which eleven render an identical "view-only for your
role" message. Department Head presents fourteen, of which ten do the same. Eleven identical dead
ends read as a broken product where six honest items would read as a focused one.

Trimming the navigation would fix that impression within a day. It was offered as an option in the
Role Capability and Build-State report, which correctly flagged it as a product-owner call rather
than an engineering one, and noted that the standing rule — *sidebars keep exactly their items and
grouping and are never reorganized* — was written about visual reskins rather than scope changes,
so the two do not strictly collide.

The relevant fact is that the underlying record already exists. `staff_actions` (migration 0020) is
live in production with a type discriminator covering `INTERVENTION`, `ASSIGNED_TASK`,
`FACULTY_NOTE`, `ACADEMIC_VERIFICATION` and `MEETING`, and a controller offering list, create and
transition. Only one screen consumes it.

The five features those eleven dead ends represent are not five features. They are one record that
is already built, surfaced five ways.

## Decision

**The navigation is not trimmed. The dead ends are removed by making the screens real on the
existing staff-action record. The staff-action screen work is therefore ranked first among all
build items.**

## Why not trim

Trimming improves the impression immediately and then has to be undone, because these are screens
the product intends to ship — they are not aspirational entries, they are entries whose backend
already exists and whose front end is a few weeks out.

More importantly, it would set a precedent against the sidebar rule for exactly the reason the rule
exists to resist: appearance. A rule that yields to "it looks bad" is not a rule. If navigation is
ever genuinely wrong, that is a scope change, argued on scope, in its own pull request.

## Consequences

- The poor first impression persists until the screens land. This is accepted deliberately, and the
  mitigation is priority rather than copy.
- Ranking this first displaces other institution work. That is the intended trade: it converts
  twenty-one view-only screens across two roles into screens where the role can act, from a table
  that is already deployed.
- Career Counselor depends on the same record (ADR-018), so this work also determines when that
  role can be folded in. Three roles are served by finishing one thing.
- Fallback, if the screens slip materially: an explicit "not yet available" treatment on the eleven,
  which is honest and still removes nothing from the sidebar. That is a copy change and does not
  need a new ADR — but it is a fallback, not the plan.
