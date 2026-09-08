# PART XXVI — ERROR HANDLING AND RESILIENCE

## 99. User-facing Errors

Errors are actionable and non-sensitive. Form validation identifies fields. Authorization failures do not disclose existence of inaccessible resources where that creates enumeration risk.

## 100. External Dependencies

Use timeouts, bounded retries, circuit breakers where appropriate, idempotency, and degraded-mode UX.

Example: if AI provider is unavailable, core opportunities/applications/readiness history remain usable; AI assistance shows temporary unavailability rather than breaking the portal.

---

# PART XXVII — THIRD-PARTY INTEGRATIONS

## 101. V1 Integration Categories

- identity federation (Google/Microsoft optional after invitation control)
- payment gateway suitable for India
- transactional email
- AI inference provider(s)
- malware scanning capability
- approved external opportunity feeds if licensed/permitted

Every integration requires owner, data shared, authentication method, retry/idempotency behavior, rate limits, privacy/security review, failure mode, and exit/replacement strategy.

Do not scrape job sites in violation of provider terms.

---

# PART XXVIII — ADMIN CAPABILITIES

## 102. Platform Admin Controls

- institution/employer approval and suspension
- user status management with strict authorization
- invitation/support workflows
- subscription/entitlement administration
- opportunity moderation
- safety cases
- scoring-model publication (restricted)
- career/skill taxonomy management
- AI model/prompt/policy configuration
- feature flags
- notification templates
- external integration configuration references
- audit/security event search
- system health links

No general-purpose SQL console or unrestricted file browser shall be exposed through the Ops Portal.

## 103. High-Risk Actions

Actions such as changing global authorization policy, publishing readiness-model changes, disabling security controls, exporting bulk sensitive data, or modifying production AI safety policy require enhanced permission, reason capture, audit, and preferably dual control for highest-risk operations.

---

# PART XXIX — MODULE ACCEPTANCE CRITERIA

## 104. Identity & Access

Accepted when invited users can register; organization memberships are verified; privileged MFA is enforced; sessions can be revoked; suspended accounts cannot access protected APIs; and automated authorization tests prove cross-role/tenant denials.

## 105. Institution Management

Accepted when hierarchy supports Institution → Campus(optional) → Department → Program → Batch → Section(optional) → Student; scoped staff assignments work; relationship effective dates are enforced; and transferred students stop exposing new activity to the former institution.

## 106. Employer Management

Accepted when employers can register, submit verification, be approved/rejected, manage scoped recruiter users, and suspended employers cannot publish or access recruitment data beyond approved policy.

## 107. Student Profile

Accepted when students can maintain career profile/goals/preferences; institutions cannot directly overwrite student-owned career preferences; provenance is visible for verified vs declared data; and profile history is auditable where material.

## 108. Academic Records

Accepted when pass/fail works without marks; marks/GPA are optional; students can declare records; authorized institution staff can verify/reject; source/verifier/timestamps are preserved; and unauthorized staff cannot verify outside scope.

## 109. Skills

Accepted when standardized skills can be attached to students with source/evidence/verification; skill gaps can be calculated against target careers; and employer/institution visibility obeys policy.

## 110. Assessments

Accepted when authorized sources can create/version assessments, students receive immutable randomized attempts, results are reproducible, integrity events are captured, and assessment types correctly control readiness eligibility.

## 111. Readiness

Accepted when the advisory band is reproducible from a published versioned model, component explanations are visible, historical snapshots retain their model version, private AI chat content does not affect the band, and band recalculation is auditable.

Amended 2026-09-08 per [ADR-020 — Readiness Is a Band, Not a Score](../ADR-020-readiness-is-a-band-not-a-score.md). This criterion previously required a reproducible numeric *score*. The domain deliberately emits a four-value advisory band and never a number, enforced by CHECK constraints so that no numeric judgement can reach an employer, so the criterion as written could never be signed. Reproducibility, explainability, versioned snapshots and auditability are unchanged — only the artefact they apply to.

## 112. Career Intelligence/Roadmap

Accepted when students receive explainable recommendations, select target careers, get a structured gap/roadmap, update progress, and AI-proposed changes require confirmation before state mutation.

## 113. Resume/Documents

Accepted when files upload privately through quarantine/scanning, malicious files remain inaccessible, resume versions can be created, applicant snapshots are preserved, and document authorization prevents cross-user/tenant access.

## 114. Opportunities

Accepted when authorized employers/institutions/platform staff can publish after validation/moderation, opportunity source and material-term versions are preserved, expired postings stop accepting applications, and payment-demand/scam signals can trigger review.

## 115. Applications

Accepted when students can apply natively or track external applications, native applications store consented submission snapshot, state transitions are validated/audited, employer access is opportunity-scoped, and students can withdraw where policy permits.

## 116. Interviews

Accepted when authorized parties can schedule/update interviews, students receive reminders/preparation context, stages/outcomes are tracked, and unrelated employers/institutions cannot see interview data.

## 117. Institution Intervention

Accepted when scoped staff can assign tasks/counseling interventions, students can view/complete/respond, status is auditable, and former institution access ends with relationship scope.

## 118. Employer Trust & Safety

Accepted when reports create cases rather than automatic penalties, evidence can be attached, employers can respond where appropriate, authorized moderators can decide/enforce, appeals can be tracked, and all case actions are audited.

## 119. AI Copilot

Accepted when AI uses authorized context, private chat is not exposed to institution/employer, provider failures degrade safely, model usage/cost is metered, unsafe tool requests are blocked, and consequential actions require confirmation.

## 120. Learning Assistance

Accepted when students can ask subject/career-skill questions, institution-scoped knowledge retrieval cannot leak across organizations, retrieved sources are traceable, and uploaded instructions cannot override AI system/tool policy.

## 121. Notifications

Accepted when in-app/email notifications are event-driven, preferences are respected where non-mandatory, retries/DLQs work, duplicate sends are controlled, and delivery status is observable.

## 122. Billing/Entitlements

Accepted when a configured commercial plan can activate/expire the correct entitlements without hard-coded price assumptions, plan/price versions preserve historical transaction meaning, duplicate webhooks cannot double-process payment, raw card data is not stored, and student/institution/employer entitlements are decoupled from hard-coded UI roles.

## 123. Reporting

Accepted when student/institution/employer/ops reports match authoritative source data, tenant/relationship scope is enforced, expensive reports do not degrade core transactions beyond SLO, and report definitions are documented.

## 124. Audit/Security

Accepted when required privileged/security events are immutable enough for operational use, searchable by authorized roles, correlation IDs connect request/service events, secrets are excluded, and alerts exist for critical security conditions.

## 125. Data Export/Deletion

Accepted when verified users can request export/deletion, workflow status is visible, grace/retention policy is applied consistently, deletion removes/anonymizes designated data, and a deleted user cannot simply regain old deleted personal records by re-registering.

---

# PART XXX — DEVELOPMENT PHASES

## 126. Phase 0 — Architecture Foundation

Deliverables:

- approved specification
- ADR template and first ADR set
- threat model
- data classification/retention draft
- RBAC/ABAC matrix
- repository bootstrap
- CI/security gates
- IaC baseline
- environment/account structure
- design system baseline
- API conventions
- observability conventions

**Exit criterion:** no product feature development begins until identity/authorization, tenant boundaries, CI, secrets, and data model conventions are established.

## 127. Phase 1 — Identity, Organizations, Student Foundation

Identity, invitations, institutions, hierarchy, employers, memberships, student profile, institutional relationships, provenance, Ops approval workflows.

## 128. Phase 2 — Assessments, Skills, Readiness

Assessment engine, skills taxonomy, academic verification, readiness model, dashboards for baseline readiness.

## 129. Phase 3 — Career Intelligence, Roadmap, Resume, AI

Career taxonomy/recommendations, roadmap/tasks, resume/document pipeline, AI Gateway/Copilot, institution knowledge retrieval.

## 130. Phase 4 — Opportunities and Recruitment

Employer postings, moderation, matching, applications, recruitment pipeline, interviews, institution opportunities/interventions.

## 131. Phase 5 — Billing, Trust & Safety, Reporting

Annual subscriptions/payments, entitlements, employer accountability cases, cross-portal reporting, data export/deletion.

## 132. Phase 6 — Production Hardening and Pilot

Performance tests, security testing, penetration test/remediation, backup/restore test, DR exercise, privacy/legal review, AI evaluation, accessibility test, operational runbooks, pilot institution/employer onboarding.

## 133. Phase 7 — General Availability

Controlled production release with feature flags, monitoring, support procedures, incident response, cost dashboards, and post-launch metric review.

---
