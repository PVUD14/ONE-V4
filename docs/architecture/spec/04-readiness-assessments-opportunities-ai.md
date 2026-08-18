# PART VIII — CAREER READINESS AND INTEGRITY

## 29. Career Readiness Score

The readiness score is 0–100 and composed of independently visible components.

Initial component families:

- aptitude
- technical competence
- communication
- interview readiness
- resume readiness
- projects/practical exposure
- career-roadmap progress
- internship/work exposure
- institution assessment/endorsement

Weights shall be configurable only through versioned scoring-model definitions. Exact weights require product validation and pilot calibration and are not frozen in this document.

### 29.1 Required properties

- deterministic calculation given same inputs/model version
- model version recorded with every score snapshot
- component-level explanation
- no hidden LLM-only score
- no private-chat morality factor
- no employer-specific arbitrary assessment directly modifying platform score unless assessment is certified for that component
- historical scores never recalculated silently when model changes

## 30. Platform Integrity and Safety Signals

Career Readiness must be separate from misuse/integrity state.

Objective integrity events may include assessment cheating indicators, impersonation, document fraud, account sharing, application fraud, or spam. Signals feed security/trust workflows and may restrict platform features after policy review. They shall not be exposed to employers as an unexplained “genuineness score.”

---

# PART IX — ASSESSMENT ARCHITECTURE

## 31. Assessment Sources

- PlanThePath standardized assessments
- institution assessments
- employer assessments
- hybrid employer workflow using PlanThePath plus employer questions

## 32. Question Model

Questions are versioned. An attempt references immutable question versions. Supported initial types may include single choice, multiple choice, numeric/text response, code/technical text response where safely supported, and structured communication prompts.

## 33. Integrity Controls

- randomized questions/options where valid
- server-side timing
- attempt limits
- tokenized attempt sessions
- tab-focus/copy-paste telemetry only where disclosed and proportionate
- answer-pattern anomaly signals
- replay prevention
- question exposure monitoring
- assessment event audit
- no invasive webcam requirement in MVP

---

# PART X — OPPORTUNITIES, EMPLOYERS, AND ACCOUNTABILITY

## 34. Opportunity Sources

Each opportunity records source:

- VERIFIED_EMPLOYER
- INSTITUTION
- PLANTHEPATH
- APPROVED_EXTERNAL_SOURCE

External opportunities must record source URL/provider, retrieval date, freshness/expiry, and terms that clarify PlanThePath is not the original publisher when applicable.

## 35. Employer Verification

Lifecycle:

`UNVERIFIED → UNDER_REVIEW → VERIFIED → TRUSTED` with possible `RESTRICTED`, `SUSPENDED`, `REVOKED` states.

V1 verification combines business-email/domain checks, company profile/evidence, automated risk signals, and manual PlanThePath review.

## 36. Opportunity Moderation

Validate required fields, compensation/stipend, deadline, location/work mode, suspicious URLs, payment requests, discriminatory/prohibited criteria, duplicates, and known scam indicators.

A student must not be required to pay a fee/deposit to apply through a legitimate job/internship listing on PlanThePath. Payment-demand indicators trigger moderation/safety workflows.

## 37. Material-Term Versioning

Material opportunity terms are versioned. At application time, PlanThePath stores the applicable terms version. Material changes after application trigger notification and may require renewed acknowledgement where appropriate.

Examples: compensation, unpaid period, work location/mode, duration, role, joining conditions, or significant eligibility changes.

## 38. Employer Accountability Cases

Students may report misrepresentation or non-adherence. A report creates a case; it does not automatically penalize the employer.

Case flow:

Report → evidence → triage → employer response → investigation → decision → action → appeal when policy permits.

Possible actions: warning, enhanced moderation, posting restriction, trust downgrade, temporary suspension, permanent removal.

## 39. Applicant Data Retention

Proposed product default: normal employer in-platform applicant access while recruitment is active and for 90 days after closure, after which access is restricted/minimized unless a legitimate retention basis applies. Final legal retention periods must be confirmed against current India privacy/employment obligations before production launch.

---

# PART XI — AI / LLM ARCHITECTURE

## 40. AI Principle

No portal may call an LLM provider directly. All AI requests go through PlanThePath AI Orchestration.

## 41. AI Gateway

The AI Gateway abstracts model providers and supports routing by workload, cost, quality, latency, context sensitivity, and availability.

Possible targets:

- AWS-managed foundation-model inference
- self-hosted open-weight model
- external commercial model API
- future provider

The application code consumes PlanThePath model capabilities, not provider-specific APIs.

## 42. Initial AI Infrastructure Recommendation

**Do not launch with an always-on GPU EC2 instance merely because model weights are free.** V1 should start with managed/pay-per-use inference for variable interactive demand unless benchmark data proves self-hosting cheaper at required quality and latency.

Self-hosted inference becomes an optimization option after observing:

- tokens/requests per active student
- peak concurrency
- average/95th latency
- GPU utilization
- model memory/quantization requirements
- per-student gross margin
- privacy/data-routing constraints
- operational staffing cost

The gateway must make a later migration possible without frontend/domain changes.

## 43. AI Workload Classes

- classification/extraction: small/low-cost model
- resume parsing/normalization: specialized extraction pipeline + validation
- subject explanation: general reasoning model with safety policy
- career planning: higher-quality model + structured student context
- opportunity skill extraction: low-cost structured-output model
- moderation assistance: model plus deterministic rules; human review for consequential enforcement
- embeddings/retrieval: independent embedding model/provider

## 44. AI Context Boundaries

AI context may include only data required for the authorized task. A career-planning request may receive student career graph data; an employer request must not receive unrelated student private data; institution AI features must obey active relationship scope.

## 45. AI Memory

Use controlled structured memory:

- career goals
- preferences
- agreed roadmap
- important user-approved facts

Do not rely on unlimited historical chat replay. Memory updates shall be explicit or policy-controlled and deletable.

## 46. AI Actions

AI may propose actions such as creating a roadmap task, updating a career target, saving an opportunity, or scheduling preparation. Consequential state changes require explicit user confirmation and are executed through authorized domain APIs, never directly against the database.

## 47. RAG / Institution Knowledge

Institution documents may populate organization-scoped knowledge collections. Retrieval must enforce organization membership/scope at query time and/or use physically/logically separate indexes. Retrieved passages should carry source metadata and document version.

Prompt injection from uploaded/retrieved content must be treated as untrusted data; retrieved instructions cannot override system/tool policy.

## 48. AI Safety and Security

Required controls include:

- system/prompt versioning
- provider timeout/retry/circuit breaker
- structured-output schemas
- input/output validation
- tool allowlists
- tool argument authorization
- prompt-injection defenses
- data minimization before provider call
- provider data-use configuration review
- sensitive-data redaction where appropriate
- abuse rate limits and quotas
- AI audit metadata
- cost budgets/alerts
- no automatic consequential moderation/employment decisions solely from an LLM

---

# PART XII — NOTIFICATIONS AND BACKGROUND JOBS

## 49. Notification Channels

V1: in-app + email.

Future: SMS/WhatsApp only after cost, consent, vendor, template, and regional policy evaluation.

## 50. Notification Events

Examples: invitation, account/verification, assessment due/result, readiness change, intervention, matched opportunity, application status, interview reminder, opportunity material-term change, offer, subscription expiry, employer case request, security alert.

## 51. Background Jobs

Use durable queues for:

- notification delivery
- resume/document parsing
- malware scan completion
- opportunity matching
- score recalculation
- analytics projection
- report generation
- external-source ingestion
- deletion/anonymization workflows
- AI batch jobs
- stale opportunity expiration

Jobs require idempotency, retry with exponential backoff, bounded attempts, dead-letter handling, correlation IDs, and operational dashboards.

---
