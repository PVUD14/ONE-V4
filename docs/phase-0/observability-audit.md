# Observability and Audit Conventions

## Telemetry

All deployable services emit structured logs, metrics, and traces with environment, service, version, correlation/request ID, and operation context. PII, secrets, tokens, raw private AI prompts, payment data, and sensitive safety evidence must not be logged by default.

## Minimum service metrics

- request rate, latency, error rate, saturation
- database/connection health
- queue depth, age, retry and DLQ counts
- background-job success/failure duration
- notification delivery status
- AI requests, tokens/units where available, latency, provider/model, cost estimate, policy blocks
- authentication/authorization failure rates

## Audit events

Audit records are separate from ordinary debug logs and capture actor, action, target/resource, organization scope, result, reason where required, timestamp, correlation ID, source channel, and relevant before/after metadata without storing forbidden secrets.

Mandatory audit categories include privileged role changes, institution/employer approval/suspension, relationship changes, verification decisions, readiness-model publication, opportunity material-term changes, safety-case decisions, bulk export, deletion workflow, billing/entitlement override, AI policy/model configuration, and high-risk production configuration actions.

## Alerts

Critical alerts include elevated auth failures, cross-tenant authorization anomalies, privileged-account anomalies, queue/DLQ growth, database/storage exhaustion, malware-scan failures, payment/webhook failures, AI cost/budget spikes, provider outage, and repeated critical application errors.

## SLO direction

Concrete production SLOs will be finalized before pilot load testing. Core transactional availability and latency are measured separately from AI provider availability; AI degradation must not make core career/application workflows unavailable.

## Access

Observability access follows least privilege. Security/audit search is limited to authorized platform roles and itself audited for sensitive investigations where appropriate.