# ADR-002: Use a synchronous bound n8n completion callback

Status: accepted for the email-only pilot.

## Decision

Each workflow is an authenticated Webhook -> Send Email -> Respond to Webhook chain. The response echoes the native callback ID and short-lived callback token plus the SMTP provider reference. The native adapter verifies signature, audience, purpose, time window, workflow, command, correlation, payload reference, and single-use token before committing the callback.

The native signed callback HTTP endpoint also exists for a future reviewed asynchronous provider, but the pilot does not grant n8n an arbitrary HTTP Request node merely to call it.

## Rationale

This provides a verified native completion boundary while keeping n8n unable to select a destination or call arbitrary PlanThePath/domain endpoints. The static private Header Auth credential authenticates adapter transport; the short-lived token binds the individual command and callback. Execution data is not retained by n8n.

## Consequences

The adapter request remains open through SMTP acceptance and has a bounded timeout. A missing/invalid response is retried only under native policy and ambiguous delivery outcomes require reconciliation. A later asynchronous callback design must add a destination-specific egress proxy/custom reviewed node, threat model, and new workflow hash/version.
