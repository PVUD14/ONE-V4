# Automation architecture and operations runbook

## Boundary

PostgreSQL outbox -> native publisher -> explicit EventBridge bus -> encrypted SQS queue/DLQ -> native idempotent consumer -> native automation command -> allowlisted adapter -> private n8n -> SMTP.

`infra/event-boundary.yaml` creates the bus, exact notification-delivery rule, encrypted queue and retained DLQ, retry/redrive policy, least-privilege ECS workload role, and queue-age/DLQ alarms. AWS SDK clients use the default workload identity chain; static AWS keys are neither accepted nor documented.

Run workers with `pnpm --filter @planthepath/persistence worker:automation` and one `AUTOMATION_WORKER_MODE` per process:

- `outbox-publisher`: leases, validates, and publishes events to the explicit bus.
- `notification-consumer`: long-polls SQS, accepts only `notification.delivery.requested` v1, creates one native command per event, and acknowledges only after success.
- `automation-dispatcher`: leases an enabled allowlisted command, resolves the recipient/template late, validates bounded content, verifies a single-use short-lived invocation token, calls private n8n, verifies the bound callback token, and atomically records callback/delivery outcome.

Token claims bind issuer, audience, subject, purpose, workflow/version context, command, correlation ID, payload reference, `jti`, issued time, and expiry. PostgreSQL replay rows make invocation/callback use single-shot across worker restarts. Callback statuses are `ACCEPTED`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, or `EXPIRED`. The signed native endpoint is `POST /api/v1/internal/automation/callbacks`; production API startup requires `AUTOMATION_SIGNING_SECRET`.

The current workflows use a safer synchronous callback response over the authenticated private invocation connection. They do not enable an HTTP Request node. See `docs/architecture/ADR-002-N8N-SYNCHRONOUS-CALLBACK.md`.

## Workflow promotion

1. Run `pnpm automation:validate`.
2. Seed registry rows with `pnpm --filter @planthepath/persistence db:register:n8n`; all six are inactive with kill switches enabled.
3. Create n8n Header Auth and SMTP credentials in the target secret-controlled instance.
4. Materialize private imports with `node automation/n8n/scripts/materialize-workflows.mjs --output <temporary-private-directory>` and deployment-managed credential IDs.
5. Import all workflows inactive. Delete the temporary directory.
6. Confirm source artifact hashes equal manifest/registry hashes and the deployed differences are credential binding only.
7. Test one workflow with a non-external sink, verify callback/replay behavior, and run `n8n audit`.
8. Explicitly activate the target n8n workflow, then set the matching native registry row active and clear its kill switch.

The six allowlist IDs are assessment-due, roadmap-overdue, institution-report, content-review, ops-failure, and security-notification. Each directory contains a source reference, source hash, excluded capabilities, owner, data classification, retention, rollback, runbook, and test evidence.

## Failure, replay, and reconciliation

- EventBridge/SQS retries are bounded; poison messages reach the 14-day DLQ.
- Outbox and command claims expire and can be safely reclaimed. Database idempotency prevents a duplicate event from creating a second command.
- Retry delays are bounded exponential backoff; five attempts or expiry is terminal.
- A successful callback makes the command and notification delivered; callback ID and token replay are idempotent/rejected without a second effect.
- An ambiguous provider outcome requires reconciliation before operator replay. Never reset a command merely because the email outcome is unknown.
- Independent native queue/DLQ/age monitoring remains authoritative if n8n is down.

Manual outbox replay must use the native audited replay function with operator user, reason code, ticket reference, and audit ID. Do not edit delivery state directly.

## Kill switch and rollback

First set `kill_switch=true` in the native registry. This prevents new claims even if the n8n workflow remains published. Then unpublish the n8n workflow and revoke/rotate Header Auth and SMTP credentials if compromise is suspected. Retain pending/failed native commands for reconciliation; never delete the audit trail. Roll forward by registering a new version/hash, testing inactive, activating it, then retiring the old version.

## Retention matrix

| Data | Location | Pilot retention/control |
|---|---|---|
| Broad integration event | PlanThePath outbox | Metadata/payload minimized; native audit policy |
| SQS event | encrypted queue | 4 days; DLQ 14 days |
| Notification command | PlanThePath database | Immutable business fields; policy-controlled |
| Token replay ID | PlanThePath database | Deleted after token expiry |
| Callback/delivery attempt | PlanThePath database | Operational/audit policy |
| n8n successful/error payload | n8n database | Not saved |
| n8n execution metadata | n8n database | Pruned at 24 hours, maximum 1,000 |
| Institution artifact | PlanThePath storage/reference | 30-day expiry |

Raw assessment answers, answer keys, scores, evidence, resumes, documents, credentials, and private conversations are prohibited in n8n data.

## Production checklist

- Private TLS ingress and protected/restricted editor; SSO/MFA readiness reviewed.
- n8n database/network/security groups isolated from PlanThePath PostgreSQL.
- Secret-manager injection and rotation tested; no populated `.env` file.
- Egress policy permits only the approved SMTP relay; DNS and proxy rules fail closed.
- Workload identity attached to the worker task; no AWS key environment variables.
- Alarms routed through native monitoring; DLQ redrive requires approval/audit.
- Current advisory, image/dependency scan, workflow validation, Mailpit/canary, callback replay, kill switch, audit, backup, restore, and rollback all evidenced.

External production SMTP, DNS/TLS, SSO/MFA, legal retention approval, and final V4 rights clearance are deployment-owner dependencies. They do not block the deterministic local pilot and all integrations remain inactive by default.
