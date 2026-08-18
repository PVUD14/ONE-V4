# Environments and Secrets

## Environment separation

Minimum logical environments: local, development, staging, production. Production must use separate cloud accounts/projects or an equivalently strong administrative boundary from non-production before GA.

## Data

- local/dev: synthetic fixtures only by default.
- staging: synthetic or approved de-identified datasets.
- production: real user data.
- production database snapshots must not be restored into non-production without an approved de-identification process.

## Secrets

Secrets are never committed to Git or stored in frontend bundles. Runtime secrets are retrieved from an approved secrets-management service using workload identity/IAM. Secret values must not appear in ordinary application logs, traces, CI output, tickets, or AI prompts.

Secrets include database credentials, provider API keys, webhook secrets, signing keys, encryption keys, SMTP/payment/AI credentials, and privileged automation tokens.

## IAM

Use least privilege, workload identities instead of static credentials where available, separate deployment/runtime roles, MFA for human privileged access, short-lived sessions, and explicit break-glass procedures.

## Production changes

Production configuration is changed through IaC/config pipelines where possible. Emergency/manual changes require reason, actor, timestamp, audit trail, and subsequent reconciliation into source-controlled configuration.

## Key rotation

Rotation capability must exist for high-value credentials before production. Compromise response must support immediate revoke/rotate without application redesign.

## AI/provider configuration

Model/provider credentials remain server-side. Per-environment provider endpoints, model IDs, quotas, and data-use settings are configuration, not source-code assumptions.