# PlanThePath Internal Role & Privilege Matrix V1

**Status:** Proposed
**Authority:** Internal Business Operating Model V1 + Phase 0 authorization controls

## Principle

Department membership is descriptive. Effective access is determined by explicit permissions, scopes, current role assignments, account state, and applicable segregation-of-duties rules.

## Capability groups

### Executive
- executive.dashboard.read
- company.kpi.read
- commercial.forecast.read
- risk.summary.read

### Sales
- lead.read
- lead.create
- lead.update
- sales.pipeline.read
- sales.pipeline.update
- proposal.metadata.manage
- onboarding.handoff.create

### Customer Success
- institution.health.read
- institution.adoption.read
- institution.engagement.read
- renewal.risk.read
- success.task.manage
- account.note.manage

### Marketing
- campaign.read
- campaign.manage
- attribution.read
- marketing.funnel.read
- marketing.cac.read
- approved.lead.read

### Finance / Billing
- pricing.plan.read
- pricing.plan.publish
- subscription.read
- subscription.manage
- payment.read
- refund.manage
- reconciliation.read
- licensing.manage
- commercial.economics.read
- commercial.scenario.manage

### Operations
- institution.verification.read
- institution.verification.decide
- employer.verification.read
- employer.verification.decide
- opportunity.moderation.read
- opportunity.moderation.decide
- operations.queue.read
- operations.queue.manage

### Support
- support.case.read
- support.case.manage
- account.support_lookup
- support.audit_timeline.read_limited
- support.escalate

### Trust & Safety
- safety.case.read
- safety.case.manage
- safety.evidence.read
- safety.enforcement.execute
- safety.appeal.manage

### Content
- career.taxonomy.manage
- skills.taxonomy.manage
- assessment.content.manage
- question_bank.manage
- knowledge_source.manage

### AI Operations
- ai.model_config.read
- ai.model_config.manage
- ai.prompt_version.read
- ai.prompt_version.manage
- ai.evaluation.read
- ai.evaluation.manage
- ai.usage.read
- ai.cost.read
- ai.safety_event.read

### Security
- security.dashboard.read
- security.alert.read
- auth.event.read
- authorization.denial.read
- audit.security.read
- privileged_action.read
- security.incident.manage
- access_review.manage
- account.security_suspend

### Privacy / Compliance
- privacy.request.read
- privacy.request.manage
- consent.record.read
- retention.policy.read
- retention.policy.manage
- legal_hold.manage
- compliance.evidence.read

### Technology
- deployment.read
- deployment.manage
- feature_flag.read
- feature_flag.manage
- integration.config.read
- integration.config.manage
- system_health.read
- technical_config.manage

### Role Administration
- internal_role.read
- internal_role.assign
- internal_role.revoke
- external_partner_access.assign
- external_partner_access.revoke

## Role bundles

| Role | Primary capabilities | Explicit restrictions |
|---|---|---|
| PLATFORM_SUPER_ADMIN | emergency/full administrative control under audit | no routine private-AI-chat browsing; production secrets remain outside app UI |
| EXECUTIVE | executive/KPI/forecast/risk | no implicit student private data or security-admin actions |
| OPERATIONS_ADMIN | verification, moderation, operational queues | no pricing publication, security policy, private AI chat |
| SECURITY_ADMIN | security events, access reviews, incidents, security suspension | no general commercial or student-content browsing |
| SUPPORT_AGENT | support cases, limited account lookup/timeline | no private AI chats, security logs, bulk exports, pricing changes |
| SALES_ADMIN | sales pipeline, proposals, onboarding handoff | no student academic/readiness/application data |
| SALES_REP | assigned/scoped sales leads and pipeline | no finance admin or operational verification decisions |
| CUSTOMER_SUCCESS_ADMIN | institution health/adoption/renewal | no private student AI data; student-level access only when explicitly approved for a support/use case |
| CUSTOMER_SUCCESS_MANAGER | assigned institution health and success tasks | no cross-account commercial/security administration |
| FINANCE_ADMIN | commercial economics, reconciliation, pricing governance | no private student data/security administration |
| BILLING_ADMIN | subscriptions, payments, refunds, licensing | no security/content/student private data |
| MARKETING_ADMIN | campaign/attribution/funnel/CAC | no student/recruitment/security datasets |
| MARKETING_ANALYST | aggregate campaign analytics | no privileged writes or unrestricted leads |
| EXTERNAL_MARKETING_PARTNER | contract-scoped campaign metrics and approved lead scope | no student, academic, readiness, AI, applicant, security or raw billing datasets |
| TRUST_SAFETY_ADMIN | investigations, evidence, enforcement, appeals | no pricing/technology administration |
| TRUST_SAFETY_ANALYST | scoped case investigation | enforcement only if separately granted |
| CONTENT_ADMIN | taxonomy/assessment/knowledge management | no general student records |
| ASSESSMENT_CONTENT_EDITOR | assigned assessment/question-bank content | no readiness override or student private data by default |
| AI_OPERATIONS_ADMIN | model/prompt/evaluation/usage configuration | no unrestricted student chat browsing or auth bypass |
| AI_OPERATIONS_ANALYST | AI metrics/evaluations/cost | no model publishing unless granted |
| PRIVACY_ADMIN | privacy requests, retention/legal hold | no unrelated commercial/security authority |
| COMPLIANCE_ANALYST | compliance evidence/read-focused privacy controls | no destructive data actions without approval |
| TECHNOLOGY_ADMIN | integrations/system config/deployment operations | no implicit production data entitlement |
| RELEASE_MANAGER | deployments/release controls | no student/commercial administration |

## External marketing partner scope

An `EXTERNAL_MARKETING_PARTNER` assignment must include:
- partner organization identifier
- contract/campaign scope
- effective start
- effective end or review date
- assigning internal authority
- approved lead-data purpose where applicable

Access must default to aggregate metrics. Personally identifiable lead data requires an explicitly authorized marketing/business purpose and must not include student-product records unless the person independently becomes a PlanThePath user under the appropriate product relationship.

## Commercial Intelligence authorization

Recommended access:

| Capability | Executive | Finance Admin | Billing Admin | Operations Admin | Marketing Admin | External Marketing |
|---|---:|---:|---:|---:|---:|---:|
| Live unit economics | Yes | Yes | Scoped | Cost/usage limited | Aggregate acquisition only | No |
| Scenario planner | Yes | Yes | Optional | No | Marketing assumptions only | No |
| Break-even analysis | Yes | Yes | Read | Read optional | CAC contribution only | No |
| Publish live price | No by default | Yes | If specifically granted | No | No | No |
| AI/cloud cost detail | Yes | Yes | Read | Yes | No | No |
| Marketing CAC | Yes | Yes | Read | Optional | Yes | Campaign scope only |

Publishing a live pricing plan requires `pricing.plan.publish`; scenario permissions never imply this permission.

## Sensitive-data exclusions

The following are not granted merely because a role is internal:
- raw passwords or authentication secrets
- cloud/database credentials
- unrestricted production database access
- private student AI conversations
- unrelated student documents
- unrestricted employer applicant records
- payment-card data
- broad security telemetry unrelated to job function

Exceptional access must be separately authorized, justified, minimized, and audited.

## UI requirement

Internal navigation must be generated from effective capabilities. Hidden navigation is a usability control only; API/service authorization remains authoritative.

## Audit requirement

Log at minimum:
- role assignments/revocations
- external-partner access changes
- live price publication
- refunds/financial adjustments
- verification decisions
- trust/safety enforcement
- account suspension
- privileged export
- AI model/prompt configuration changes
- security policy/config changes
