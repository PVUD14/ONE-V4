# V4 + n8n security review

Date: 2026-08-20  
Reviewed range: `988d1ce03a233581209c99ff5a4d0b74d06c9b4d..856e682edfb3bd0bddd41d4a9c93996f35e30b93`

## Outcome

The original terminal security scan reviewed 51 executable and configuration files and reported three findings. Commit `856e682` remediates all three, and a terminal follow-up diff scan of the 24 security-relevant remediation files found no unresolved reportable security finding.

| Original finding | Severity | Resolution |
| --- | --- | --- |
| Institution aggregate included snapshots outside an allowed relationship state/time | Medium / P2 | Each snapshot is now joined to an allowed relationship state at `generated_at`, using an exclusive `effective_to` boundary. Tests cover transferred, ended, and exact-boundary records. |
| n8n receivers ignored the signed invocation token | Low / P3 | All six workflows use JWT Auth with a dedicated 15-second HS256 secret. Claims bind issuer, audience, purpose, workflow key, registry ID, version, command, and SHA-256 of the exact body. Sink expressions enforce those bindings. |
| Production web builds could fall back to authenticated cleartext loopback requests | Low / P3 | Missing production configuration is same-origin; explicit production origins must be trusted HTTPS and cannot contain credentials, paths, queries, or fragments. |

## Additional controls verified

- Ambiguous SMTP outcomes are terminal and the dispatcher leases one command at a time; only an explicit `429` is retried.
- Workflow source hashes are recomputed from the committed exports, the registry is re-read immediately before dispatch, and workflow validation checks authentication, graph shape, allowed fields, guarded sink expressions, and callback shape.
- Direct insertion of finalized content, ineligible publication, and mutation of finalized release items are blocked by database triggers.
- EventBridge delivery uses a customer-managed KMS key with an EventBridge key-policy grant, and the target queue and DLQ policies grant only the exact rule permission to send.
- Generated workflow output is constrained to a real-path-resolved private output directory.

## Residual hardening notes

Two candidates were retained as non-reportable defense-in-depth work:

1. A valid n8n invocation can be replayed with the identical body during its 15-second lifetime. Reaching this condition requires live bearer capture inside the private TLS-protected worker-to-n8n channel, or compromise of the n8n/runtime host that already possesses the SMTP capability. The previous indefinite static-header replay path is removed; expiry, workflow binding, and full-body binding are enforced. Receiver-side atomic one-time consumption remains desirable if the deployment later adds an appropriate durable store.
2. A principal with arbitrary SQL write access can still manufacture some content lifecycle states without corresponding review actions. No HTTP, CLI, or application repository path exposes arbitrary SQL, and such a database principal already has equivalent catalog-integrity authority. Legal state-transition triggers and distinct-actor review invariants remain useful database defense in depth.

## Verification evidence

- `corepack pnpm test`: 244 tests passed across all eight projects.
- `corepack pnpm typecheck`: all eight projects passed.
- `corepack pnpm build`: all eight projects passed.
- Frozen offline install, clean/upgrade database migrations, and 54-table schema checks passed.
- Six inactive, email-only, hash-pinned n8n workflows validated and materialized successfully.
- Pinned n8n `2.35.3` live canary: missing auth `401`, expired token `403`, valid request delivered exactly one Mailpit message, tampered body delivered none, reuse after expiry `403`, and final workflow state `6 inactive / 0 active`.
- n8n built-in security audit and AWS CloudFormation template validation passed.

## Limitations

No production ingress, browser fleet, SMTP relay, AWS account deployment, or production database was used for exploit validation. Local Docker Scout scanning timed out, and local package-audit submission was unavailable; the pinned CI dependency-audit gate remains the authoritative networked check.
