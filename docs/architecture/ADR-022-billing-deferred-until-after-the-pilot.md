# ADR-022 — Billing Is Deferred Until After the Pilot

**Status:** Accepted
**Decision date:** 2026-09-06
**Scope:** When the commercial domain — plans, subscriptions, entitlements, payment — gets built
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

The specification requires configurable subscription plans and entitlements supporting direct
student subscriptions, institution-funded bulk-seat licensing, trials and promotions, with no
hard-coded price assumptions. It is Phase 5 work and a named module with its own acceptance
criteria.

Nothing of it exists. There is no plan, subscription, entitlement, payment or invoice table; no
payment provider in any dependency list; no billing controller; no entitlement check anywhere in
the authorization path. This is the only V1 module with a complete absence of implementation, and
because it has no screens it does not appear in any screen-level build-state count — which has made
it easy to overlook.

The platform therefore cannot take money from anyone today.

Against that: the remaining work across the rest of the product is dominated by finishing journeys
that are already partly built, and several of those are days rather than weeks from being useful.
The team is five streams.

## Decision

**Billing is not started until the pilot completes. Pilot institutions are invoiced out of band.**

This is a decision about **timing only**. Scope is unchanged: self-serve billing and entitlements
remain required before ONE can sell to students directly, and remain part of V1.

## Why

The pilot is institution-funded, so nothing in the billing domain is load-bearing for it. A
manually-issued invoice to a small number of known institutions is a solved commercial problem that
does not need product support.

Opening the largest greenfield domain in the plan concurrently with the wave of finishing work
would, with five streams, stall the finishing work. The finishing work is what makes the pilot
demonstrable; billing is what makes the pilot billable, and those are not needed in the same month.

## Consequences

- **ONE cannot charge anybody until this is built.** This must be stated plainly in commercial
  conversations rather than described as a configuration matter.
- The revisit trigger is explicit: a paying customer with a date, or a decision to sell directly to
  students. Either reopens this ADR immediately.
- Entitlements do not exist, so any capability gating built in the meantime must not assume a
  billing source of truth. Gate on role and membership, as the product does today, and do not
  introduce a placeholder entitlement concept that billing would later have to displace.
- Manual invoicing leaves no record inside the product. Nobody should later read the absence of
  payment rows as evidence that an institution has not paid.
- Deferring does not reduce the eventual cost. This ADR buys sequencing, not savings, and the
  estimate should not quietly shrink while it sits unstarted.
