# ADR-002: Use a synchronous bound n8n completion callback

Status: accepted for the email-only pilot.

## Decision

Each workflow is an authenticated Webhook -> Send Email -> Respond to Webhook chain. The response echoes the native callback ID and short-lived callback token plus the SMTP provider reference. The native adapter verifies signature, audience, purpose, time window, workflow, command, correlation, payload reference, and single-use token before committing the callback.

The native signed callback HTTP endpoint also exists for a future reviewed asynchronous provider, but the pilot does not grant n8n an arbitrary HTTP Request node merely to call it.

## Rationale

This provides a verified native completion boundary while keeping n8n unable to select a destination or call arbitrary PlanThePath/domain endpoints. n8n JWT Auth verifies the dedicated HS256 invocation secret and token expiry before execution. The 15-second token also binds the deployed registry ID/version, command, and exact request-body digest. The callback uses a separate signing secret that n8n never receives. Execution data is not retained by n8n.

## Consequences

The adapter request remains open through SMTP acceptance and has a bounded timeout. Only a definite pre-execution `429` is automatically retried. A network failure, timeout, `5xx`, malformed callback, or callback-binding failure is terminal and requires reconciliation because SMTP acceptance may already have occurred. A later asynchronous callback design must add a destination-specific egress proxy/custom reviewed node, threat model, and new workflow hash/version.
