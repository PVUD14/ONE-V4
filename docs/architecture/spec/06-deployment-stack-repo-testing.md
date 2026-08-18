# PART XVIII — DEPLOYMENT ARCHITECTURE

## 73. Cloud Direction

AWS is the recommended initial cloud because the product owner has already identified AWS and its managed services reduce operational burden. Cloud abstractions should nevertheless be kept behind application interfaces where practical; do not create artificial multi-cloud complexity in V1.

## 74. Recommended AWS Topology

### Edge

Route 53 → CloudFront → AWS WAF → web origins/API load balancer.

### Web applications

Static/SSR web applications deployed through a managed frontend/container strategy; exact hosting can be selected during implementation based on framework build mode.

### APIs and workers

Amazon ECS with AWS Fargate is recommended for containerized Core API, AI orchestration, and worker services. Fargate avoids managing EC2 clusters and supports independent CPU/memory sizing of services.

### Database

Managed PostgreSQL-compatible RDS/Aurora deployment with production Multi-AZ/high-availability configuration, encrypted storage, automated backups, point-in-time restore, and private networking.

### Cache

Managed Redis-compatible cache only for justified use cases: rate limits, short-lived cache, distributed lock/session metadata if needed. Redis is not the system of record.

### Queue/eventing

SQS queues + DLQs for background work; EventBridge may be used for scheduled/event routing where useful.

Outbox dispatch must treat a successful external publish followed by a failed database acknowledgement as a reconciliation-required state. The dispatcher should surface that condition explicitly for operator review instead of silently retrying as if the publish definitely failed.

### Object storage

S3 private buckets for documents, exports, and controlled static assets.

### Email

SES or approved transactional email provider behind Notification interface.

### Identity

Amazon Cognito is a strong V1 candidate because it supports OIDC-compatible managed user pools, federated identity, OTP/MFA and WebAuthn/passkeys. Final choice must pass UX and cost validation during implementation spike.

### Secrets

AWS Secrets Manager/SSM Parameter Store according to secret sensitivity. Secrets Manager automatic rotation for supported credentials.

### AI

Start with managed model inference (Amazon Bedrock and/or external providers selected by benchmark) through AI Gateway. Self-hosted GPU inference is optional later and must be benchmark-driven.

## 75. Network Architecture

- public subnets only for internet-facing load-balancer components as required
- API/worker tasks in private subnets
- databases/cache in isolated/private subnets
- no public database endpoint
- security groups based on service-to-service need
- VPC endpoints where cost/security justification exists
- controlled egress for workloads that call external providers

---

# PART XIX — ENVIRONMENT SEPARATION AND SECRETS

## 76. Environments

Minimum:

- local/developer
- development
- staging/pre-production
- production

Production must be isolated at account and credential level; recommended AWS account separation at least for production vs non-production. Staging should mirror production topology at smaller capacity.

No production PII may be copied to development. Use synthetic/anonymized test data.

## 77. Configuration

Environment configuration is injected at deploy/runtime, not compiled as secrets. Feature flags shall be environment-aware and audited for privileged changes.

## 78. Secrets

- no secrets in Git
- no `.env` secrets committed
- workload IAM roles instead of static AWS keys
- CI uses OIDC/federated cloud access where supported
- database/service credentials rotated
- emergency secret rotation documented
- secret values redacted from logs/errors

---

# PART XX — BACKUP, RECOVERY, AND RESILIENCE

## 79. Database

- automated encrypted backups
- point-in-time recovery
- defined retention policy
- regular restore tests
- schema migration rollback/forward-recovery procedures

## 80. Object Storage

- appropriate versioning
- lifecycle policies
- recovery policy for accidental deletion
- retention policy aligned with privacy requirements

## 81. Disaster Recovery

V1 uses single-primary AWS region with Multi-AZ resilience. Cross-region active-active is not justified for initial scale. Critical backups/configuration should support region-level recovery according to agreed RTO/RPO; cross-region replication for selected backup assets may be introduced based on cost/risk analysis.

Run at least semiannual recovery exercises after launch, with more frequent database restore tests.

---

# PART XXI — SCALABILITY AND PERFORMANCE

## 82. Capacity Assumptions

Target registered population: 10K students + institution staff + 100+ employers.

Design load testing around peak events such as placement drives and simultaneous assessments rather than average daily traffic.

## 83. Scaling Strategy

- stateless API horizontal scaling
- worker scaling from queue depth
- AI service scaling independently
- DB connection pooling
- proper indexing and query budgets
- caching only measured hot paths
- object storage/CDN for static/file delivery
- async handling for expensive operations
- pagination everywhere for unbounded lists

## 84. Future Extraction Triggers

Extract a domain from Core API only when one or more applies:

- independent scaling is materially required
- different availability/SLO requirement
- separate team ownership and release cadence
- data/compliance isolation requirement
- operational contention affects other domains
- technology/runtime specialization provides material benefit

Likely first candidates after AI: opportunity matching/search, notifications, analytics, document processing.

---

# PART XXII — TECHNOLOGY STACK EVALUATION AND RECOMMENDATION

## 85. Frontend

**Recommendation:** TypeScript + React-based production framework (Next.js currently preferred) with a shared component/design-system package.

Rationale: strong ecosystem, responsive web support, SSR/CSR flexibility, mature testing, strong type sharing, and efficient staffing.

## 86. Core Backend

**Recommendation:** TypeScript + NestJS (or an equivalently structured TypeScript backend framework) for the modular core.

Rationale: dependency-injection/modules, explicit domain organization, validation, OpenAPI support, background integrations, strong end-to-end type/tooling alignment.

A plain Express-style unstructured backend is rejected.

## 87. AI Service

**Recommendation:** Python service (FastAPI or equivalent) because model/RAG/evaluation libraries are substantially stronger in Python. The API contract remains provider/framework neutral.

This is an intentional second runtime because AI workloads justify it.

## 88. Database

**Recommendation:** PostgreSQL.

## 89. ORM/data access

Choose a migration-capable typed data layer after implementation spike. The architecture must prevent ORM entities from leaking through domain/API layers. Raw SQL may be used for optimized reporting/query paths under review.

## 90. Queue

AWS SQS for durable V1 jobs; avoid introducing Kafka unless event volume/use cases justify it.

## 91. Search

PostgreSQL search/trigram/full-text capabilities are sufficient initially for bounded opportunity/profile search. Add OpenSearch only when search quality/scale/faceting evidence justifies operational cost.

## 92. Monorepo

Recommended single repository with workspace tooling because the product has shared API contracts, UI components, policy packages, and coordinated releases. Deployment units remain independent.

---

# PART XXIII — REPOSITORY STRUCTURE

## 93. Proposed Layout

```text
planthepath/
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── CODEOWNERS
├── docs/
│   ├── architecture/
│   │   ├── APPLICATION_ARCHITECTURE_SPEC.md
│   │   ├── threat-model.md
│   │   ├── data-classification.md
│   │   ├── authorization-model.md
│   │   └── adr/
│   ├── product/
│   ├── api/
│   ├── runbooks/
│   └── security/
├── apps/
│   ├── student-web/
│   ├── institution-web/
│   ├── employer-web/
│   ├── ops-web/
│   ├── core-api/
│   ├── ai-service/
│   └── worker/
├── packages/
│   ├── ui/
│   ├── api-contracts/
│   ├── authz/
│   ├── domain-events/
│   ├── observability/
│   ├── config/
│   └── test-utils/
├── infrastructure/
│   ├── modules/
│   ├── environments/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── prod/
│   └── policies/
├── scripts/
├── tests/
│   ├── e2e/
│   ├── performance/
│   └── security/
└── .github/
    ├── workflows/
    ├── ISSUE_TEMPLATE/
    └── pull_request_template.md
```

The exact workspace/build tooling is chosen in Phase 0 and recorded in ADRs.

---

# PART XXIV — DEVELOPMENT AND RELEASE PROCESS

## 94. Branching

Use trunk-oriented development with short-lived feature branches and protected `main`. All production changes require pull requests and CI. Direct pushes to `main` should be prohibited except controlled emergency procedure.

## 95. CI Gates

At minimum:

- formatting/lint
- type checking
- unit tests
- integration tests where affected
- build
- SAST
- dependency/SCA scan
- secret scan
- IaC scan
- container scan
- migration validation
- API contract compatibility checks

Production deployment requires approval and environment protection rules.

## 96. Database Migrations

Migrations are reviewed artifacts. Prefer backward-compatible expand/migrate/contract patterns for production. Do not deploy destructive schema changes coupled to a single instantaneous application release.

---

# PART XXV — TESTING STRATEGY

## 97. Test Pyramid

### Unit

Domain rules, readiness calculations, eligibility, authorization policy functions, state machines, normalization, AI structured-action validation.

### Integration

Database repositories, identity integration, queues, storage, payment webhooks, email adapter, AI provider adapters.

### Contract

OpenAPI/API clients, domain events, provider adapters.

### E2E

Critical journeys across each portal.

### Security

Authorization matrix tests, tenant isolation, IDOR/BOLA, privilege escalation, file upload, session/auth, rate-limit, injection, SSRF, prompt injection/tool abuse, webhook verification.

### Performance

Placement-drive spike, assessment start/submit, opportunity browse/search, dashboards, queue backlogs, AI concurrency.

### Resilience

Provider timeout, queue retry/DLQ, DB failover assumptions, AI-provider outage, email failure, payment webhook duplicates.

### Accessibility

Automated checks plus manual keyboard/screen-reader validation for critical flows.

## 98. AI Evaluation

Maintain evaluation datasets for career advice, subject explanations, resume assistance, extraction, moderation assistance, and tool-call correctness.

Measure:

- factuality/grounding where applicable
- safety
- structured-output validity
- tool authorization violations
- retrieval precision
- latency
- model cost
- user usefulness through controlled product feedback

Changing an AI model/prompt used in important workflows requires evaluation before production rollout.

---
