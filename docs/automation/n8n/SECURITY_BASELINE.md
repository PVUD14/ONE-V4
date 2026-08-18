# n8n security baseline

Review date: 2026-08-18.

## Selected release and images

The official n8n release page identified `2.35.3` as the latest stable release on 2026-08-18 (released 2026-08-14): https://github.com/n8n-io/n8n/releases/tag/n8n%402.35.3

Pinned runtime images:

- `n8nio/n8n:2.35.3@sha256:31375a4f730081a139bba2d379bf2efaa8e662cc9e131d12bb5e15859d4f0282`
- `postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`
- `axllent/mailpit:v1.30.6@sha256:7f33095f80e901f6ad08028f06ca284aa58fe84942be5496008d041d3b9f4d4d`

PostgreSQL 17 is dedicated to n8n and shares neither network nor credentials with PlanThePath PostgreSQL 16.

## Advisory review

The current official advisory list was reviewed: https://github.com/n8n-io/n8n/security/advisories

The July 22 high-severity advisories affecting versions before `2.32.1`/`2.31.5`, including Send Email file-read/SSRF, Edit Image arbitrary write, expression escape, shared-workflow credential exfiltration, Git-node execution, and prototype-pollution issues, are below the pinned `2.35.3` version. The Send Email advisory is especially relevant and its patched thresholds are recorded here: https://github.com/n8n-io/n8n/security/advisories/GHSA-2x35-3fw4-9jr4

Defense remains independent of patch level: authenticated private webhooks, strict string/bounds validation in the native adapter, a read-only container, no host mounts, no filesystem/Code/HTTP/database nodes, and a three-node source-controlled workflow allowlist.

## Runtime controls

- Base compose publishes no port; local override binds editor and Mailpit to `127.0.0.1` only.
- Docker networks are `internal`; n8n has no route to PlanThePath PostgreSQL or public egress.
- Separate n8n database and volume; no PlanThePath database credential, Docker socket, or host mount.
- UID/GID 1000, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, bounded tmpfs, 1 CPU/1 GiB, execution/concurrency deadlines.
- Encryption and user-management secrets are required environment references.
- diagnostics, version notification, templates, personalization, public API, community packages, verified/unverified packages, AI, MCP, MCP registry, workflow builder, and quick-connect modules are disabled.
- Success, failure, progress, and manual execution payload saving are disabled; pruning is capped at 24 hours/1,000 metadata rows.
- Only `webhook`, `emailSend`, and `respondToWebhook` nodes are included. Command, Code, filesystem, Git, SSH, FTP, arbitrary HTTP, databases, cloud messaging, contacts, chat, task-management, and AI nodes are explicitly excluded.
- Credential IDs are injected only into private mode-0600 deployment copies; source exports contain credential types/names only.

The JavaScript task-runner process exists in n8n v2, but Code nodes are excluded. The missing-Python warning is therefore non-operative for these workflows.

## Audit disposition

The supported CLI audit procedure is documented by n8n at https://docs.n8n.io/hosting/securing/security-audit/ and was run on the final local configuration. It confirmed community packages, version notifications, templates, public API, and diagnostics disabled and reported the exact three-node include list. Its only credential findings were the two deliberately disposable test credentials after all workflows were unpublished. Those credentials and both test volumes were destroyed.

Full redacted evidence is in `automation/n8n/VERIFICATION.md`. There is no unresolved critical/high unsafe configuration.

## Upgrade gate

Before every promotion: recheck the official stable release and advisories, verify image signatures/digests under organizational policy, run dependency/image scanning, validate all workflow hashes, import inactive, bind rotated credentials, execute a Mailpit canary, run `n8n audit`, and activate only the registry version explicitly approved by change control.
