# ADR-021 — Email Delivery Runs on the Automation Service

**Status:** Accepted
**Decision date:** 2026-09-06
**Scope:** How outbound email actually leaves the platform
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

The notification pipeline is built and has been for some time: `notification_templates`,
`notification_commands`, `notification_delivery_attempts`, `notification_preferences`, an
automation workflow registry with a per-workflow allowlist, a signing secret, a kill switch, and
six authored workflows — assessment-due, content-review, institution-report, ops-failure,
roadmap-overdue and security-notification.

None of it sends anything, because the component that performs delivery is not running.

Production runs four things: the API service, the privacy-deletion sweep, the backup job and the
health monitor. `worker:automation` — the dispatcher that claims `EMAIL`-class notification
commands and hands them to the workflow service — is not among them, and the workflow service
itself is not part of the production deployment at all.

The practical effect is that every invitation, reminder and alert the product believes it has sent
is sitting in `notification_commands` in a pending state. In-app notifications are unaffected:
`user_notifications` is served directly by the API and works.

This is not a gap in the design. It is a deployment that was never completed, and it has been
mistaken for missing functionality more than once.

## Decision

**Email is delivered by deploying the automation worker and the workflow service the pipeline was
designed against. No second sending path is introduced into the API.**

## Why not send directly from the API

Adding a transactional email provider to the API and writing a small sender is the obvious
alternative, and it is rejected for four reasons:

- It discards machinery that is already built and tested — the workflow allowlist, the signing
  secret, the kill switch and the delivery-attempt ledger — and would have to reimplement the parts
  of it that are load-bearing.
- It adds a provider SDK to the API's dependency set, which needs approval under the dependency
  rule and widens the blast radius of the request-serving process.
- It places an outbound third-party network call next to request handling. The architecture
  deliberately keeps that work on the outbox/event pipeline, for the same reasons it forbids
  synchronous model calls in a controller.
- It needs its own security review before it could ship, which is not obviously faster than
  deploying a service whose security baseline is already written.

The alternative becomes correct if operating a second service proves genuinely unaffordable. That
is an operational finding, not a design preference, and it would need a new ADR.

## Consequences

- One more service to run, patch and monitor. Stream A owns it; the deployment specifics belong
  there and are deliberately not specified here.
- Production preflight gains the worker's required configuration, so that a missing setting fails
  before a release switch rather than after it.
- The kill switch becomes operationally meaningful for the first time. It should be exercised once
  deliberately before it is ever needed.
- Until this ships, every invitation is delivered out of band by a human. That is the current
  reality and should be stated plainly to anyone onboarding a pilot institution, not assumed away.
- No code change is required to make email work. Anyone planning sending work should read this
  first.
