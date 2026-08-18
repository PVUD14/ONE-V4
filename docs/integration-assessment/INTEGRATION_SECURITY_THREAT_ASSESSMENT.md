# Integration security threat assessment

## Executive risk statement

The proposed integration is acceptable only as a controlled migration and event-adapter program. Deploying V4 or importing the n8n catalog would create unacceptable identity, data-integrity, privacy, supply-chain and code-execution risk.

The highest risks are:

1. unlicensed or poisoned content entering production;
2. personal, assessment, readiness or employment data crossing an ungoverned automation boundary;
3. n8n credentials, arbitrary nodes or network egress enabling data exfiltration or infrastructure access;
4. forged/replayed callbacks or duplicate automation causing authoritative state corruption;
5. uncalibrated or AI-derived scores/rankings creating unfair decisions; and
6. multi-tenant authorization being evaluated at event creation but not at delayed execution.

The target controls reduce these risks by keeping all authoritative state and decisions native, minimizing event payloads, staging V4 content, and treating each workflow as reviewed code.

## Scope and assumptions

Assets in scope include student/applicant identity and education data, employer and institution data, assessment items and answer keys, documents/resumes, readiness and roadmap inferences, audit/event records, OAuth/API credentials, content/IP, and the availability/integrity of external side effects.

Trust boundaries:

- V4 repository/export → offline evidence and quarantine;
- quarantine → canonical PlanThePath import command;
- PlanThePath database → outbox/broker;
- broker → native consumers/integration adapter;
- adapter → n8n;
- n8n → external providers; and
- providers → native verified callback ingress.

This assessment does not authorize a production n8n deployment. The n8n source repository's deployment examples describe its catalog web application, use floating images in places, leave network policy disabled by default, and are not a hardened n8n architecture. A repository-local `ai-stack/.env` path was observed but deliberately not read; any repository-local environment file must be treated as potentially sensitive and handled by its owner.

## Risk rating

Ratings combine likelihood and impact before the proposed control set. **Critical** and **High** findings are release blockers. Residual acceptance requires the named verification; documentation alone does not close a risk.

| ID | Threat and affected asset | Source / evidence | Inherent risk | Mandatory controls | Verification / owner | Expected residual |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | Unlicensed code/content is copied or distributed | V4 has no root license; `ONE Original` grant unresolved; mixed CC labels | Critical | Immutable source evidence; per-record license; legal approval; quarantine default; attribution/share-alike policy | Manifest has 100% cleared records; Legal + Content | Medium |
| SEC-02 | Poisoned, incorrect or malicious assessment content enters a release | Large mixed-source corpus; build/count mismatch; external text | High | Schema/markup sanitization; exact/near dedupe; SME review; answer/explanation checks; signed release manifest; rollback | Representative adversarial/sampling suite; Content + Security | Low/Medium |
| SEC-03 | Protected answers leak to learners or automation logs | V4 question/options and n8n execution persistence | Critical | Separate answer-key storage/view; response DTO tests; no content in events/workflows; redact logs; least privilege | Pre-release leakage tests and role probes; Assessment + Security | Low |
| SEC-04 | V4 credentials or authentication state compromise accounts | Local hashes, sessions, MFA and recovery tables | Critical | Explicit denylist; never export/import; Cognito only; secret scanning of packages/manifests | Zero matching entity/column output; Identity + Security | Low |
| SEC-05 | Ambiguous identity mapping attaches history to the wrong person | Legacy local user IDs and incomplete controller context | Critical | Personal track disabled by default; verified account matching; subject confirmation for ambiguity; rollback and correction | 100% deterministic matches in pilot, zero unresolved; Privacy + Identity | Low |
| SEC-06 | Legacy access/roles create cross-tenant privilege | V4 global/local roles and college flows differ from scoped/temporal model | Critical | Never import grants; map personas only; create access through native authorized commands; recheck time/scope/purpose | Tenant and temporal negative tests; Authorization owner | Low |
| SEC-07 | Uncalibrated score or synthetic evidence drives opportunity/employer decision | Fixed V4 weights and synthetic interview completion score | Critical | Reject values; recompute under versioned model; prohibit employer exposure/default automated decisions; fairness governance | Golden vectors, model approval, policy tests; Readiness + Product | Medium |
| SEC-08 | Raw resumes/documents carry malware or exfiltrate through processing | V4 local paths; catalog S3/Textract/AI examples | Critical | Presigned quarantine; KMS; checksum/type/size; malware/CDR; clean-state gate; object-prefix roles; retention | Malicious-file suite and access probes; Documents + Security | Low/Medium |
| SEC-09 | Prompt injection in content/resumes/email controls tools or leaks data | Catalog AI workflows mix untrusted text, models and external tools | Critical | Native AI gateway; untrusted-data isolation; no tool authority; structured schema; provider no-training/retention; human confirmation | Adversarial prompt suite; AI + Security/Privacy | Medium |
| SEC-10 | AI screening/rating creates discriminatory adverse action | Catalog workflow `1287` moves/ranks CVs | Critical | Reject workflow; policy-as-code blocks AI-driven application status/ranking; human accountable decisions; audit | Prohibition tests and product/legal policy; Employer + Legal | Low |
| SEC-11 | Bulk workflow import introduces hidden executable behavior | 2,061 files, 9 malformed; many HTTP/Code/Function/Webhook nodes | Critical | No bulk import; reconstruct empty; static node/credential/egress diff; signed promotion; default inactive | CI rejects unallowlisted nodes/egress; Platform security | Low |
| SEC-12 | Execute Command, local file, SSH/FTP or community nodes compromise host | These node families exist in catalog | Critical | Node allowlist; disable community packages; container sandbox; read-only root; non-root; no host mounts; seccomp/capability drop | Runtime policy and escape test; Platform security | Low/Medium |
| SEC-13 | Generic HTTP nodes enable SSRF or data exfiltration | 889 parsed workflows contain HTTP Request | Critical | Prefer typed adapters; domain/method allowlist; egress proxy; DNS/IP validation; block metadata/private ranges; size/time limits | SSRF suite and egress-denial logs; Network + Security | Low |
| SEC-14 | Direct database node bypasses authorization/audit | Catalog contains Postgres/MySQL/MongoDB nodes | Critical | n8n never receives PlanThePath DB credentials/routes; network isolation; database firewall and IAM | Connection attempts denied; secret inventory; Data + Platform | Low |
| SEC-15 | OAuth/API secret theft affects broad SaaS data | Catalog connectors require many credential types | High | Secret manager references; per-workflow/environment credentials; least scopes; short lifetime where possible; rotation/revocation; no export | Credential inventory and rotation drill; Integrations + Security | Medium |
| SEC-16 | Workflow execution data/logs retain PII, tokens, answers or documents | n8n commonly stores node inputs/outputs; source examples move files/text | Critical | Minimum payloads; disable/save-minimum execution data; short retention; redact; encrypted volumes/backups; access logs | Retention/deletion and log-scan tests; Platform + Privacy | Low/Medium |
| SEC-17 | Forged provider webhook changes delivery/interview/application state | Catalog contains many generic Webhook nodes | Critical | Native ingress; signature, timestamp, audience/account and replay validation; WAF/rate limit; typed command | Invalid/stale/replay test corpus; Integration security | Low |
| SEC-18 | Duplicate/reordered events create duplicate emails, meetings or stale state | At-least-once delivery and delayed workflows | High | Event/aggregate versions; consumer ledger; provider idempotency keys; external-ID locks; cancellation/supersession; reconciliation | Replay/order/concurrency tests; Domain + Platform | Low |
| SEC-19 | Authorization becomes stale between event and side effect | Relationships, consent and preferences may revoke while queued | Critical | Minimum-data command; expiry; native recipient/action resolution and reauthorization just before effect; cancellation events | Revocation-before-delivery tests; Authorization + Notification | Low |
| SEC-20 | Tenant data leaks through scheduled aggregate/report | Weekly summary and CRM automation candidates | Critical | Native tenant-scoped report service; immutable artifact ACL; short-lived link; no aggregation in n8n | Cross-tenant fuzz/negative tests; Analytics + Security | Low |
| SEC-21 | Alert/event payload poisoning causes phishing, log injection or pager flood | Error/SNS patterns include attacker-controlled failure context | High | Structured reason codes; escape/render; length limit; fingerprint/rate limit; no raw trace/body; independent alert path | Injection/flood test; SRE + Security | Low |
| SEC-22 | Unsafe feed ingestion reaches internal network or publishes false jobs | RSS/HTML patterns fetch untrusted sources | High | Approved-source allowlist; sandboxed fetcher; SSRF controls; license/provenance; candidate quarantine; human publish | Source/redirect/HTML/adversarial suite; Opportunity + Security | Low/Medium |
| SEC-23 | Supply-chain drift changes workflow/runtime without review | Example images use `latest`; catalog is mutable and count differs | High | Digest-pinned images and dependencies; SBOM/signatures; vulnerability scans; immutable workflow hash/version | Promotion verifies digest/SBOM/hash; Platform security | Low/Medium |
| SEC-24 | n8n admin/API exposure enables workflow or credential takeover | Catalog examples use basic-auth placeholders and broad ingress concepts | Critical | Private ingress/VPN/SSO+MFA; admin RBAC; no shared/basic default; CSRF/session controls; audit; separate runtime/editor | External scan, role tests, break-glass drill; Platform security | Low/Medium |
| SEC-25 | Workflow failure is silent because n8n alerts itself | Error routing candidate depends on workflow engine | High | Independent native health/metrics alarm; queue age and heartbeat alarms; provider reconciliation | Stop-instance game day; SRE | Low |
| SEC-26 | Migration job has excessive production privileges or can be rerun destructively | Large ETL and mapping work | Critical | Separate accounts/zones; staging-only loader; manifest-scoped native import API; least privilege; dry run; idempotency; four-eyes production execution | IAM review and rerun/rollback drill; Data + SRE | Low |
| SEC-27 | Audit data itself leaks PII or can be tampered with | Cross-system correlation and provider payloads | High | Append-only controls; payload minimization; integrity monitoring; auditor roles; retention; no secrets/raw content | Tamper/access/redaction tests; Security + Privacy | Low |
| SEC-28 | Privacy rights fail across copies, workflow data, providers and backups | Documents, email, CRM and AI create downstream copies | Critical | Data inventory/ROPA; processor terms; retention/delete hooks; subject export/delete/restriction; backup policy; workflow data minimization | End-to-end data-subject request drill; Privacy | Medium |
| SEC-29 | Financial or entitlement callbacks grant access fraudulently | V4 local payments; future external provider | Critical | No V4 payment migration; native signed provider callbacks; append-only ledger; reconciliation; dual control | Signature/replay/reconciliation tests; Billing + Security | Low |
| SEC-30 | Semantic mismatch in current relationship status grants unintended access | Persistence includes `TRANSFERRED` while helper/service exclude it | High | Resolve one policy; align query/helper/service; regression tests before integration consumers | Temporal matrix passes in all adapters; Authorization owner | Low |

## Mandatory security architecture

### Workload isolation

- Dedicated n8n account/project, private subnets and a separate n8n database.
- No network path to PlanThePath PostgreSQL, Cognito administrative APIs, internal metadata endpoints, or general internal networks.
- Egress only through a policy proxy to approved provider endpoints; deny by default.
- Non-root container, all capabilities dropped, read-only root filesystem, ephemeral scratch, resource/time/concurrency limits, hardened seccomp/AppArmor equivalent, and no Docker socket or host mounts.
- Editor/admin plane separated from execution workers; production editing disabled or tightly controlled.

### Workflow software supply chain

- Workflow definitions live in PlanThePath-controlled source control as redacted exports plus a human-readable manifest.
- CI validates JSON schema, node allowlist, version pins, credential references, webhook absence, egress destinations, payload policy and test evidence.
- Promotion uses immutable hashes and signed artifacts. Environment-specific credentials/configuration are never embedded in the export.
- Node/runtime/container vulnerabilities are scanned before promotion and continuously; critical findings block activation.

### Secrets

- Use one secret reference per integration/workflow/environment with least provider scopes.
- Never put a secret, credential ID that reveals a value, refresh token, webhook signing secret, database string, private key or access token into git, events, logs or error messages.
- Define rotation, last-used, owner, expiry and emergency revocation. Test revocation without redeploying domain services.
- If an external source repository has ever held real secrets, the source owner—not this assessment—must rotate and scrub them.

### Data and privacy

| Class | Examples | n8n policy |
| --- | --- | --- |
| Public | Approved published opportunity/content metadata | Allowed only for approved destination and integrity purpose |
| Internal | Release ID, workflow metrics, runbook reference | Allowed in minimum fields; short operational retention |
| Restricted | Opaque student/task/report/notification IDs, contact metadata | Exception-based; native resolution preferred; encryption and short retention |
| Highly sensitive | Resumes, answers, readiness, application/interview feedback, private messages | No raw payload; native adapter/AI gateway only; opaque reference exception |
| Secret | Credentials, tokens, answer keys before allowed disclosure, signing material | Never in event/workflow data; secret-manager injection only |

## AI-specific controls

1. All model calls go through the native AI gateway with provider, region, retention/training, model and prompt policy.
2. Treat documents, content, email, URLs and tool outputs as untrusted data, not instructions.
3. No model/tool receives broad database, email, drive, calendar or CRM authority.
4. Enforce structured output schemas and bounded inputs/outputs; reject unknown fields and embedded instructions.
5. Store model, prompt/rubric and input-evidence versions with advisory outputs.
6. Require an authorized human confirmation for profile updates, communications and any consequential workflow.
7. Prohibit model-derived eligibility, ranking, readiness, application status or adverse decision in the current scope.
8. Measure correction, override, false-positive and subgroup outcomes before broader use.

## Security release gates

No n8n workflow becomes active until:

- its use case exists in the approved matrix and event catalog;
- the source reference/hash and reconstruction diff are recorded;
- every node, credential and egress destination is allowlisted;
- a threat review and data-flow/retention record are approved;
- native authorization, idempotency, callback, audit and reconciliation tests pass;
- the workflow has bounded retry, timeout, cancellation, DLQ and kill switch;
- a failure game day proves independent detection and recovery; and
- the domain owner, Platform/SRE and Security approve promotion.

No V4 release becomes active until:

- source counts and hashes are reproducible;
- every included record has cleared provenance/license;
- schema, quality, duplicate, accessibility, answer-leakage and SME gates pass;
- the signed manifest and rollback are tested; and
- no authentication secret, unapproved PII, legacy access grant or authoritative derived score is present.

## Residual risks requiring business acceptance

Even with controls, external SaaS and AI providers create processor, regional, retention, outage and vendor-lock-in risk. Creative Commons or employer-owned content can impose ongoing attribution/distribution obligations. Readiness models can create unfair outcomes despite determinism. These require documented Product, Legal/Privacy and model-governance ownership rather than a purely technical sign-off.
