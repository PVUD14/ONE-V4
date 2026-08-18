# V4 and n8n integration assessment

**Assessment date:** 2026-08-18
**PlanThePath baseline:** `c39786b7e57207a7c08fb066848646d0d2741516`
**V4 evidence:** `PVUD14/V4--Database@0c067ce24f92662daa933edf0fc8b75636d99469`
**n8n catalog evidence:** `Zie619/n8n-workflows@94007c1445d9258a7da116646b79473e7c7c3282`

## Executive recommendation

Proceed, but treat both repositories as evidence sources rather than deployable subsystems.

- Keep PlanThePath's PostgreSQL, Drizzle, Cognito, scoped and temporal authorization, transactional outbox, audit, privacy, and deterministic-versioned readiness architecture authoritative.
- Migrate only V4 records that pass provenance, license, schema, quality, and product-ownership gates. Adapt useful taxonomies, question-bank governance, assessment evidence, roadmap concepts, and test cases. Do not reuse the SQLite runtime, authentication, payment, local-file, or fixed scoring implementations.
- Use n8n only behind a PlanThePath-owned integration boundary for approved external side effects. It must consume least-data events or authenticated adapter endpoints; it must never receive production database credentials or make product decisions.
- Implement the native outbox dispatcher, event contracts, notification service, webhook verification, idempotency, and observability before enabling any n8n workflow.
- Do not bulk-import the workflow catalog. Review, reconstruct, pin, test, and approve each selected workflow independently.

The result is an incremental path to the target architecture without changing the approved architecture or weakening the security model.

## Scope and evidence quality

This is a documentation-only assessment. No application code, database schema, source data, secrets, n8n instance, or cloud resources were changed. The external repositories were cloned from credential-free HTTPS URLs into an isolated temporary directory and inspected read-only.

Evidence limitations matter:

- V4 has no root `LICENSE`. Its third-party notices cover several named datasets, but the ownership or license for the `ONE Original` corpus is not established. The registry inspected contains 132 records, all marked `READY_FOR_SME_REVIEW`, with mixed MIT and Creative Commons labels.
- V4's tracked handoff describes a 20,320-question state, while an independent clean rebuild did not finish within two ten-minute attempts. The partial rebuild reached 16,985 questions. Counts and derivations therefore require a reproducible export plus manifests and checksums before migration.
- The n8n README advertises 4,343 workflows. The checked-out `workflows/` tree contains 2,061 JSON files; 2,052 parsed and 9 did not. This assessment uses the checked-out commit, not the advertised count.
- The n8n repository also contains a workflow-catalog web application and example deployment files. Those files are not a production n8n runtime design and are not proposed for deployment.

## Decision summary

| Area | Decision |
| --- | --- |
| System of record | PlanThePath PostgreSQL and domain services |
| Authentication | Amazon Cognito plus PlanThePath internal account and membership resolution |
| Authorization | PlanThePath RBAC plus scoped and temporal ABAC; re-check at every command and callback |
| Migration | Staged, repeatable, provenance-preserving ETL through canonical staging; no direct database copy |
| V4 code | Reference or adapt only; no SQLite runtime deployment |
| V4 content | Migrate only after ownership/license, SME, quality, and release gates |
| Readiness | Rebuild as deterministic, calibrated, versioned projections from immutable evidence |
| Automation | Native for authoritative state changes; n8n for approved external orchestration and delivery |
| AI | Advisory extraction/classification through the PlanThePath AI gateway; never authoritative eligibility, ranking, or readiness |
| n8n catalog | Curated pattern library only; no bulk import or automatic activation |

## Classification legend

- **REUSE AS-IS** — usable without semantic change, while still passing normal review.
- **ADAPT** — retain the domain idea but implement it in PlanThePath conventions.
- **MIGRATE DATA** — transform approved records into canonical schemas with provenance.
- **REUSE AS REFERENCE** — use as design or test evidence, not production code/data.
- **REJECT** — conflicts with architecture, security, privacy, quality, or ownership requirements.

Automation uses **IMPLEMENT NOW**, **PHASE 2**, **FUTURE**, and **REJECT**. These prioritize a newly built controlled workflow, not deployment of source JSON unchanged.

## Consolidated master matrix

| Source | Source component/workflow | Purpose | Target PlanThePath module | Current equivalent | Classification | Priority | Data classification | Security risk | Transformation required | Migration/implementation method | Native vs n8n | Dependencies | Tests | Blockers | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V4 | Subjects, topics, lessons, prerequisites | Learning taxonomy and graph | Learning | Spec only | ADAPT | P1 | Public/internal content | Cycles; unstable identifiers | Canonical IDs, graph constraints, ownership | Stage, validate DAG, publish version | Native | Content ownership; schema | Graph, version, authorization | Product taxonomy owner | Adapt the model; do not copy SQLite schema |
| V4 | Question corpus, options, tags, mappings | Assessment content | Content + Assessment | Spec only | MIGRATE DATA | P1 | Licensed content | Copyright; answer leakage | Normalize; license and provenance per record | Quarantine, dedupe, SME review, signed release | Native | License decision; content release model | License, duplication, correctness, leakage | Missing root/ONE Original license; rebuild mismatch | Migrate only cleared release artifacts |
| V4 | Assessment blueprints | Assemble assessments | Assessment | Architecture specified | ADAPT | P1 | Internal configuration | Predictable exams; tampering | Version blueprint and selection rules | Reimplement with deterministic seeded selection | Native | Taxonomy and content releases | Repeatability, coverage, concurrency | Calibration | Use as reference inputs, then re-author |
| V4 | Attempts, answers, timing | Preserve assessment evidence | Assessment | Spec only | ADAPT | P1 | Restricted education data | IDOR; answer leakage | Immutable evidence, actor/scope, timestamps | PlanThePath command service and repositories | Native | Authorization; audit; idempotency | Scope, submit-once, timing, audit | None architectural | Reimplement before importing any learner history |
| V4 | Topic scores | Aggregate skill evidence | Readiness projections | Spec only | REUSE AS REFERENCE | P2 | Restricted derived data | Stale or manipulable scores | Recompute from canonical evidence | Projection worker | Native | Evidence model | Rebuild, correction, version | Model definition | Never migrate as truth |
| V4 | Fixed readiness weights and snapshots | Readiness score | Readiness | Versioned model specified | REJECT | P1 | Highly sensitive derived data | Unfair or uncalibrated decisions | New calibrated model/version/evidence links | Native deterministic model registry and projections | Native | Product and fairness approval | Golden vectors, drift, explainability | Model weights and calibration | Do not promote V4 scores |
| V4 | Roadmap generator | Personalized next actions | Roadmap | Spec only | ADAPT | P1 | Restricted student data | Overreach; stale recommendations | Convert rules to versioned policy and explainable tasks | Native policy engine consuming readiness events | Native | Readiness v1; catalog | Determinism, auth, replanning | Product prioritization rules | Adapt concepts and test cases |
| V4 | Career goals and roles | Target outcomes | Profile + Career discovery | Spec only | MIGRATE DATA | P1 | Public/internal taxonomy | Taxonomy bias or drift | Canonical taxonomy, aliases, status/version | Curated reference-data import | Native | Taxonomy owner | Mapping, referential integrity | Ownership of source labels | Migrate curated non-personal records |
| V4 | Company packs, interview stages/questions | Interview preparation | Interview preparation | Spec/UI preview | MIGRATE DATA | P2 | Licensed/internal content | Employer IP; answer leakage | Separate generic from employer-owned content | Contract/license and SME-gated import | Native | Employer/content ownership | Access, license, publishing | Rights and confidentiality | Migrate only cleared generic content |
| V4 | Resume analysis and ATS rubric | Resume guidance | Document + AI gateway | Spec only | ADAPT | P2 | Highly sensitive document/AI data | Bias, prompt injection, disclosure | Safe extraction; advisory rubric; evidence links | Quarantine, malware scan, native AI gateway | Native | File security; AI policy | Adversarial docs, PII, human review | Approved rubric/provider | Adapt advisory feedback only |
| V4 | Content revision, review, release records | Four-eyes publishing | Content governance | Governance specified | ADAPT | P1 | Internal/audit data | Self-approval; provenance loss | Scoped roles, immutable actions, release manifests | Native review state machine | Native | Authorization and audit | Separation of duties, rollback | Content owner assignments | Preserve governance intent |
| V4 | Source metadata and third-party notices | Provenance evidence | Content provenance | Required by architecture | REUSE AS-IS | P0 | Public/internal legal metadata | False or incomplete attribution | Preserve raw evidence; verify before trust | Immutable evidence attachment plus normalized fields | Native | Legal review | Checksums, completeness | Missing root and corpus licenses | Retain as evidence, not clearance |
| V4 | Subscriptions and entitlement ledger | Commercial access | Billing + Entitlements | Spec only | ADAPT | P3 | Restricted financial metadata | Fraud; inconsistent entitlement | External payment references; append-only ledger | Native webhook-verified billing integration | Native | Provider and product decisions | Signature, replay, reconciliation | Commercial scope/provider | Adapt ledger invariants; reject local payment flow |
| V4 | College registration and dual approval | Institution onboarding | Identity + Organization | Temporal membership implemented | REUSE AS REFERENCE | P2 | Restricted identity data | Cross-tenant approval | Map to invitations/memberships/relationships | Extend native command workflows | Native | Role and scope policy | Dual control, expiry, revocation | Product workflow decision | Use scenarios, not legacy tables |
| V4 | Local users, passwords, sessions, MFA | Authentication | Identity | Cognito integration implemented | REJECT | P0 | Secret/restricted identity data | Credential compromise | None; do not import hashes or sessions | Cognito migration process only if separately approved | Native | Identity migration plan | Account linking, revocation | Lawful basis and account ownership | Never reuse local auth implementation |
| V4 | File paths and local assets | Store uploaded documents | Document | Secure S3 design specified | REJECT | P0 | Highly sensitive files | Traversal, malware, data leakage | Object metadata, quarantine state, checksum | Presigned upload to quarantine and scan workflow | Native | S3/KMS/scanner | Malware, content type, access, deletion | Storage implementation | Do not migrate file paths as production storage |
| n8n | Daily reminder pattern `1239` | Due-date notifications | Notification | Spec only | IMPLEMENT NOW | P1 | Minimal pseudonymous | Recipient/data leakage | Replace source connectors with event contract and message ID | Rebuild from approved nodes; call delivery adapter | n8n | Outbox dispatcher; templates | Idempotency, opt-out, retry, scope | Delivery provider | Pilot assessment and roadmap reminders |
| n8n | Weekly review pattern `1724` | Institution summary | Analytics + Notification | Spec/UI preview | IMPLEMENT NOW | P1 | Restricted aggregate | Tenant leakage; code-node execution | Native aggregate query; no Code/HTTP nodes | Native report artifact, n8n delivery only | Hybrid | Authorized report service | Tenant isolation, totals, replay | Report definitions | Keep aggregation native |
| n8n | Calendar/iCal/Zoom patterns `0038`, `0342`, `1159` | Interview scheduling | Interview + Integration | Spec/UI preview | PHASE 2 | P2 | Restricted identity/schedule | Calendar token and invite leakage | Opaque IDs, least fields, provider adapter | Native command; n8n provider side effect and callback | Hybrid | Interview domain; provider choice | Duplicate create, cancellation, callback auth | Calendar/meeting vendor | Add after interview domain exists |
| n8n | Error/SNS patterns `1849`, `0984` | Operational and security alerts | Platform operations | Partial audit/outbox | IMPLEMENT NOW | P0 | Internal/security metadata | Alert poisoning; sensitive logs | Structured allowlisted payload | Native alarms with n8n routing to approved channel | Hybrid | Metrics, DLQ, runbooks | Redaction, dedupe, escalation | On-call destination | Implement with event foundation |
| n8n | Asana overdue pattern `1629` | Content review SLA escalation | Content governance | Not implemented | PHASE 2 | P2 | Internal workflow metadata | External task disclosure | Native SLA state; opaque task reference | n8n approved task-system adapter | Hybrid | Governance workflow | Replay, closure, tenant boundary | Work-management vendor | Optional adapter; native state remains truth |
| n8n | Postmark trigger `0968` | Delivery telemetry | Notification | Not implemented | PHASE 2 | P2 | Restricted contact metadata | Forged callbacks | Signature verification; provider event mapping | Native callback ingress and event projection | Native | Email provider | Signature, replay, ordering | Provider selection | Do not expose generic n8n webhook |
| n8n | HubSpot triggers/actions `1081`, `1136` | Employer CRM synchronization | Employer + Integration | Spec only | PHASE 2 | P3 | Restricted employer/contact data | Over-broad OAuth; divergence | Field allowlist and consent/purpose mapping | n8n adapter through scoped integration API | n8n | Employer domain; data-processing agreement | Conflict, revocation, replay | CRM/product decision | Pilot one-way sync first |
| n8n | RSS patterns `1122`, `1180` | Opportunity feed intake | Opportunity ingestion | Spec only | PHASE 2 | P2 | Public plus internal review data | SSRF, poisoned content, licensing | Allowlisted feeds; canonical candidates; provenance | Sandboxed fetcher and human publishing gate | Native | Provider/license approval | SSRF, dedupe, attribution, rollback | Approved sources | Prefer native ingestion worker |
| n8n | Textract pattern `0112` | Document text extraction | Document ingestion | Spec only | PHASE 2 | P2 | Highly sensitive documents | Malware, exfiltration, OCR leakage | Quarantined object reference only | Native callback orchestrator; managed extractor | Hybrid | Secure file pipeline | Malware, signature, retention, retry | Provider/privacy review | Never pass raw files through generic workflow state |
| n8n | Resume review pattern `1501` | Extract and summarize resume | AI gateway | Spec only | FUTURE | P3 | Highly sensitive AI data | Prompt injection, bias, third-party sinks | Remove form, Drive, Sheets, rating; structured schema | Native AI gateway with human confirmation | Native | AI controls; document ingestion | Adversarial, schema, no-decision tests | Model/provider/rubric | Reuse extraction idea only |
| n8n | CV screening/rating pattern `1287` | Rank and route applicants | Employer decisions | None approved | REJECT | P0 | Highly sensitive employment data | Discrimination; automated adverse action | Not applicable | Do not implement | Native | Legal/product policy | Prohibition test | No approved use | Reject authoritative AI screening |
| n8n | Entire catalog / unsafe node families | Broad automation import | Integration platform | None | REJECT | P0 | Variable | Command execution, SSRF, exfiltration, secrets | Per-workflow reconstruction only | Allowlisted nodes, review, signed promotion | n8n | Platform hardening | Static scan, egress, secrets, promotion | Catalog quality mismatches | Never bulk import or auto-activate |

## Deliverables

- [Current capability inventory](CURRENT_PLANTHEPATH_CAPABILITY_INVENTORY.md)
- [V4 reuse and migration matrix](V4_REUSE_MIGRATION_MATRIX.md)
- [V4 data migration strategy](V4_DATA_MIGRATION_STRATEGY.md)
- [n8n top-20 automation matrix](N8N_TOP_20_AUTOMATION_MATRIX.md)
- [Automation event architecture](AUTOMATION_EVENT_ARCHITECTURE.md)
- [Integration security threat assessment](INTEGRATION_SECURITY_THREAT_ASSESSMENT.md)
- [Target architecture after integration](TARGET_ARCHITECTURE_AFTER_INTEGRATION.md)
- [Implementation roadmap](IMPLEMENTATION_ROADMAP.md)
- [Decisions required](DECISIONS_REQUIRED.md)

## Hard guardrails

1. No direct writes from n8n, migration scripts, or external systems into PlanThePath domain tables.
2. No V4 password hashes, sessions, MFA secrets, recovery codes, demo users, or unapproved personal data are migrated.
3. No content is published without per-record provenance, license clearance, SME approval, and a release manifest.
4. No readiness score is migrated as authoritative; it is recomputed under a versioned PlanThePath model.
5. No AI output changes eligibility, access, readiness, application status, ranking, or interview outcome without an explicit authorized human action.
6. No n8n production database credentials, unrestricted network egress, community nodes, `Execute Command`, local-file nodes, or arbitrary code nodes are enabled by default.
7. Every external side effect carries an idempotency key, is observable, has bounded retries and a dead-letter path, and can be reconciled.
8. Authorization is evaluated in PlanThePath at command time and again when an asynchronous callback attempts a state change.
