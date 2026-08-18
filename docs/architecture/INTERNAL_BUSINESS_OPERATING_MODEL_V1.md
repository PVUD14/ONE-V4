# PlanThePath Internal Business Operating Model V1

**Status:** Proposed architecture baseline
**Scope:** Internal PlanThePath control-plane functions, department boundaries, roles, and module ownership

## Objective

Define the internal operating model for PlanThePath so that commercial, operational, support, security, finance, content, and technology teams work through one controlled internal platform without receiving unnecessary access to student, institution, employer, or security-sensitive data.

## Architectural principle

PlanThePath will not create a separate portal for every department. Internal teams use one privileged **Platform Operations / Internal Business Portal**. Navigation and actions are capability-driven using RBAC plus scoped/attribute-based authorization.

Department membership is organizational metadata. Authorization is determined by explicit role assignments, permissions, scopes, account state, and where applicable segregation-of-duties controls.

## Initial internal functions

### 1. Executive / Founders

Responsibilities:
- company KPIs
- growth and revenue oversight
- unit economics
- risk and operational posture
- forecast review

Modules:
- Executive Dashboard
- Company KPIs
- Commercial Intelligence
- Forecasts
- Risk Overview

The executive role must not automatically grant unrestricted access to private student AI conversations, raw credentials, or production secrets.

### 2. Technology / Engineering

Responsibilities:
- product engineering
- infrastructure operation
- integrations
- release management
- technical configuration

Modules:
- Deployments
- Feature Flags
- Integrations
- System Health
- Technical Configuration

Engineering access to production data must be exceptional, least-privilege, time-bounded where practical, and auditable.

### 3. Security

Responsibilities:
- security monitoring
- incident response
- access reviews
- privileged-action oversight
- vulnerability/risk management

Modules:
- Security Overview
- Security Alerts
- Authentication Events
- Authorization Denials
- Audit Events
- Privileged Actions
- Security Incidents
- Access Reviews

Security access does not imply unrestricted content access to student AI conversations or business records.

### 4. Operations

Responsibilities:
- institution verification
- employer verification
- opportunity moderation
- operational queues
- escalations

Modules:
- Institution Verification
- Employer Verification
- Opportunity Moderation
- Operational Queues
- Escalations

### 5. Customer Support

Responsibilities:
- account/user support
- support case management
- operational troubleshooting

Modules:
- Support Cases
- User Lookup
- Institution Lookup
- Employer Lookup
- Limited Audit Timeline
- Escalation

Support must use masked/minimized views and must not receive general access to private AI chats, unrestricted documents, full security logs, or commercial administration.

### 6. Sales / Business Development

Responsibilities:
- institution acquisition
- employer commercial relationships where applicable
- demos/pilots/proposals/contracts
- sales pipeline

Lifecycle:

`Lead -> Qualified -> Demo -> Pilot -> Proposal -> Negotiation -> Contract -> Onboarding -> Active -> Renewal`

Modules:
- Leads
- Institution Sales Pipeline
- Employer Business Pipeline
- Demos
- Pilots
- Proposals
- Contracts/Commercial Metadata
- Onboarding Handoff

Sales access must not include student academic, readiness, AI-conversation, application, or applicant data.

### 7. Customer Success / Account Management

Responsibilities:
- institution activation
- adoption
- stakeholder engagement
- renewal readiness
- usage health

Modules:
- Institution Health
- Activation
- Adoption
- Engagement
- Renewal Risk
- Success Tasks
- Account Notes

Example health indicators:
- licensed students
- activated students
- monthly active students
- active placement staff
- assessment completion
- opportunity/application activity
- department adoption gaps
- unresolved support/escalation trends

Customer Success receives aggregate and contractually appropriate institution information, not private student AI conversations or unrestricted student-level data.

### 8. Marketing

Responsibilities:
- campaigns
- attribution
- acquisition funnels
- lead generation
- CAC analysis

Modules:
- Campaigns
- Attribution
- Lead Sources
- Funnels
- Acquisition Analytics
- CAC

Marketing must use aggregate/marketing-purpose data only unless a separate lawful and approved purpose exists.

### 9. External Marketing Partner

External marketing agencies/contractors receive a separate constrained role, e.g. `EXTERNAL_MARKETING_PARTNER`.

Permitted examples:
- campaign configuration metadata
- campaign spend
- landing-page metrics
- source attribution
- lead counts
- campaign conversion rates
- approved campaign-specific lead information

Explicit exclusions:
- student identity/profile
- academic records
- readiness scores
- resumes/documents
- application/interview records
- private AI conversations
- employer applicant data
- platform security events
- raw billing records
- unrestricted institution analytics

External access must be organization-scoped, time-bounded to the contract/engagement where practical, and revocable immediately.

### 10. Finance / Billing

Responsibilities:
- pricing plans
- subscriptions
- institution licensing
- payments/refunds
- reconciliation
- cost analysis
- unit economics

Modules:
- Plans & Pricing
- Subscriptions
- Payments
- Refunds
- Reconciliation
- Institution Licensing
- Commercial Intelligence

Finance does not require private student career/academic/AI data.

### 11. Commercial Intelligence & Unit Economics

This is a restricted internal module.

Primary views:
1. Live Economics
2. Scenario Planner
3. Break-even Analysis
4. Forecast

Input categories:
- paid students
- free/trial students
- student/institution pricing assumptions
- discounts/promotions
- institution-funded seats
- employer revenue assumptions
- infrastructure cost
- AI cost/model mix
- payment fees
- support cost
- sales/marketing spend
- CAC assumptions
- renewal/churn assumptions
- tax/GST assumptions where configured

Outputs:
- revenue
- ARR/MRR-equivalent metrics where relevant
- gross margin
- contribution margin
- infrastructure cost per active/paid student
- AI cost per active student
- CAC
- LTV (when sufficient data exists)
- break-even student count
- break-even price
- monthly burn
- annual run-rate

Mandatory distinction:
- **Actual:** measured production/billing/cloud/usage data
- **Assumption:** manually entered or forecast data

Simulation must never change live subscription pricing. Publishing or modifying a live commercial plan is a separate privileged, audited workflow.

### 12. Trust & Safety / Moderation

Responsibilities:
- abuse/fraud reports
- employer/student/institution complaints
- investigation
- evidence handling
- enforcement
- appeals

Modules:
- Reports
- Cases
- Evidence
- Investigations
- Enforcement
- Appeals

### 13. Content / Academic Operations

Responsibilities:
- career taxonomy
- skills taxonomy
- assessment content
- question banks
- learning/knowledge sources

Modules:
- Careers
- Skills
- Assessments
- Question Banks
- Knowledge Sources

Content roles do not receive general access to student records.

### 14. AI Operations

Responsibilities:
- model routing
- prompt/version governance
- evaluation
- usage/cost
- AI incidents/safety

Modules:
- Models
- Model Routing
- Prompt Versions
- Evaluation
- Usage
- Cost
- AI Safety Events

AI Operations does not receive general access to private AI conversation content. Exceptional investigation access requires a policy-defined case and audit trail.

### 15. Legal / Compliance / Privacy

Responsibilities:
- privacy rights workflows
- retention
- consent governance
- contracts/policies
- legal holds
- compliance evidence

Modules:
- Privacy Requests
- Consent Records
- Retention
- Deletion/Export Requests
- Legal Holds
- Compliance Evidence

## Role model

Users may hold multiple internal roles. The platform must not implement a single-role-per-user limitation.

Conceptually:

`User -> Role Assignments -> Permissions -> Scope -> Effective Access`

Each role assignment should support:
- role ID
- scope/context
- effective start/end where applicable
- assigning authority
- status
- audit metadata

## Initial internal role catalogue

Recommended roles include:
- PLATFORM_SUPER_ADMIN
- EXECUTIVE
- OPERATIONS_ADMIN
- SECURITY_ADMIN
- SUPPORT_AGENT
- SALES_ADMIN
- SALES_REP
- CUSTOMER_SUCCESS_ADMIN
- CUSTOMER_SUCCESS_MANAGER
- FINANCE_ADMIN
- BILLING_ADMIN
- MARKETING_ADMIN
- MARKETING_ANALYST
- EXTERNAL_MARKETING_PARTNER
- TRUST_SAFETY_ADMIN
- TRUST_SAFETY_ANALYST
- CONTENT_ADMIN
- ASSESSMENT_CONTENT_EDITOR
- AI_OPERATIONS_ADMIN
- AI_OPERATIONS_ANALYST
- PRIVACY_ADMIN
- COMPLIANCE_ANALYST
- TECHNOLOGY_ADMIN
- RELEASE_MANAGER

Role names are implementation identifiers; exact permission bundles must be defined independently.

## Segregation of duties

High-risk operations should be separated where practical as company size grows.

Examples:
- support cannot grant itself elevated privileges
- marketing cannot publish subscription pricing
- sales cannot approve employer trust/safety cases
- billing cannot modify security policy
- engineering cannot silently disable audit logging
- AI Operations cannot bypass normal student-data authorization
- external partners cannot administer internal roles

Small-company reality may require one person to hold multiple roles initially; the authorization system must support later separation without redesign.

## Internal portal navigation model

```text
Executive
  Executive Dashboard
  Company KPIs
  Forecasts
  Risk Overview

Commercial
  Sales Pipeline
  Institution Accounts
  Employer Accounts
  Pricing & Plans
  Commercial Intelligence
  Renewals

Customer Success
  Institution Health
  Activation
  Adoption
  Renewal Risk
  Success Tasks

Marketing
  Campaigns
  Attribution
  Leads
  Funnels
  CAC

Finance
  Revenue
  Payments
  Invoices
  Refunds
  Reconciliation
  Cost Analysis

Operations
  Institution Verification
  Employer Verification
  Opportunity Moderation
  Operational Queues

Support
  Cases
  Account Lookup
  Escalations

Trust & Safety
  Reports
  Investigations
  Enforcement
  Appeals

Content
  Skills
  Careers
  Assessments
  Knowledge

AI Operations
  Models
  Prompts
  Evaluation
  Usage
  Cost

Security
  Alerts
  Audit
  Access Reviews
  Incidents

Privacy & Compliance
  Consent
  Data Requests
  Retention
  Legal Holds

Technology
  Feature Flags
  Integrations
  Deployments
  System Health
```

Navigation visibility does not grant authority; server-side authorization remains mandatory.

## Build-vs-buy boundary

PlanThePath should build internal tooling where it is tightly coupled to unique platform workflows or provides proprietary business intelligence.

Build candidates:
- institution/employer onboarding pipeline integration
- customer-success health derived from PlanThePath usage
- Commercial Intelligence/unit economics using live product metrics
- trust/safety cases
- platform verification queues
- AI usage/cost controls

Do not build generic internal enterprise systems in V1 where mature SaaS products are better suited:
- payroll
- HRIS
- employee attendance
- generic accounting ledger
- procurement
- generic project management

Integrate with specialist systems later if necessary.

## MVP-lite internal business scope

Recommended early implementation order:
1. Operations/verification
2. Support
3. Sales pipeline (minimal)
4. Customer Success institution-health view
5. Finance/Billing basics
6. Commercial Intelligence scenario calculator + actual cloud/AI usage
7. Marketing attribution integration/aggregate dashboard

Trust & Safety, AI Operations, Privacy/Compliance and Security already exist as architectural responsibilities and expand as platform volume increases.

## Acceptance principles

- A user sees only modules supported by effective permissions.
- External marketing partners cannot access student/private/recruitment/security datasets.
- Commercial scenarios are separated from live pricing.
- Every privileged commercial, security, verification and role-management action is audited.
- Department labels do not substitute for explicit authorization.
- Multi-role users are supported.
- Revocation of a role/partner engagement removes access without requiring account recreation.
- Aggregate dashboards must not expose unnecessary personally identifiable information.
