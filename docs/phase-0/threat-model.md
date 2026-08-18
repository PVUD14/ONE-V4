# Threat Model

Method: STRIDE-informed abuse-case model focused on PlanThePath trust boundaries. This is a living Phase 0 artifact.

## Trust boundaries

1. Student browser ↔ public edge/API.
2. Institution browser ↔ public edge/API.
3. Employer browser ↔ public edge/API.
4. Operations portal ↔ privileged API surface.
5. API ↔ PostgreSQL/cache/object storage/queue.
6. API/AI service ↔ external identity, email, payment, and AI providers.
7. Uploaded documents ↔ quarantine/scanning ↔ approved storage.
8. Organization A ↔ Organization B tenant boundary.
9. Active institution relationship ↔ expired/transferred relationship boundary.
10. AI-generated text ↔ authorized application actions/tools.

## Priority threats and mandatory mitigations

| Threat | Example | Required controls |
|---|---|---|
| Broken tenant isolation | College A reads College B/student data | centralized policy checks, scoped queries, negative tests, audit |
| Temporal authorization failure | old college reads new student activity | effective-date policy on every institution-scoped resource/read model |
| IDOR/BOLA | attacker changes resource ID | resource-level authorization; non-enumerating failures |
| Privilege escalation | lecturer becomes admin | server-side role assignment policy, MFA, audit, approval |
| Account takeover | stolen privileged credential | managed IdP, MFA for privileged roles, session revocation, anomaly alerts |
| Employer fraud | fake job/payment demand | employer verification, posting moderation, material-term versioning, safety cases |
| Student/application fraud | forged evidence/impersonation | provenance, document validation, integrity events, evidence-based enforcement |
| Malicious upload | malware in resume/evidence | private upload, quarantine, scan, allowlist, content-disposition controls |
| Prompt injection | uploaded document tells AI to leak data | retrieval isolation, instruction hierarchy, tool allowlists, output/context policy |
| Cross-tenant RAG leak | institution docs returned to other tenant | collection/tenant filters enforced outside prompt, retrieval authorization tests |
| AI overreach | copilot mutates state without consent | tool authorization, confirmation for consequential action, no direct DB access |
| Sensitive prompt leakage | provider retains private data | minimum context, provider contract review, logging redaction, configurable routing |
| Webhook replay | duplicate payment event | signature validation, timestamp checks, idempotency keys/event ledger |
| Queue replay/duplication | duplicate notification/state change | idempotent consumers, dedupe keys, DLQ, retry limits |
| Audit tampering | admin hides action | append-only/immutable-enough audit path, restricted writers, external retention |
| Secret exposure | credentials committed/logged | secrets manager, CI pattern checks, redaction, rotation and incident runbook |
| Mass scraping | harvesting opportunities/users | rate limiting, pagination caps, authorization, abuse detection |
| Denial of wallet | AI usage drains budget | per-user/org quotas, rate limits, model routing, cost alarms, circuit breakers |

## Security invariants

- Private AI chats never become institution/employer-readable by default.
- Career Readiness never changes because of unrelated/private chat content.
- AI-generated claims are advisory unless verified by deterministic/domain mechanisms.
- No organization boundary is trusted from client-provided claims alone.
- No production administrative action bypasses audit.

## Review triggers

Re-run threat modeling for new payment flows, new AI tools/models, native mobile apps, SSO/ERP/ATS integrations, recorded audio/video, new data exports, public talent search, major tenancy changes, and infrastructure-region changes.