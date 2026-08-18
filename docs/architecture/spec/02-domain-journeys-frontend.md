# PART II — DOMAIN ARCHITECTURE

## 7. Bounded Contexts and Ownership

### 7.1 Identity & Access

Owns user identity mapping, account state, login linkage, MFA policy metadata, sessions/revocation metadata, role assignments, organization memberships, and authorization claims. Does not own career/student profile data.

### 7.2 Organization & Tenant Management

Owns institutions, employers, hierarchy, organization verification state, departments/programs/batches/sections, institutional/employer memberships, and organization lifecycle.

### 7.3 Student Career Profile

Owns personal career goals, preferences, declared skills, portfolio/project metadata, experience, profile completion, and graduate transition state.

### 7.4 Academic Records & Verification

Owns subject status, pass/fail/pending, optional grades/marks/GPA, source, evidence reference, verification status, verifier, and effective dates.

### 7.5 Skills & Competencies

Owns normalized skill taxonomy, competency evidence, skill levels, assessment-backed competence, institution endorsements, and skill gap calculations.

### 7.6 Assessments

Owns assessment definitions, question banks, randomized attempts, responses, scoring, integrity events, assessment ownership/source, and result publication.

Assessment types: aptitude, technical, communication, career interest, and work-preference guidance. Employer-created assessments shall not directly manipulate the platform-wide readiness score unless certified as eligible for the scoring model.

### 7.7 Career Intelligence

Owns career taxonomy, career-role requirements, recommendation calculation, explanation, skill-gap mapping, and recommendation provenance.

### 7.8 Career Roadmap

Owns target careers, milestones, tasks, task completion, deadlines, recommended actions, institution-assigned actions, and roadmap history.

### 7.9 Career Readiness

Owns scoring-model definitions, weights, model versions, score components, score calculation events, historical snapshots, and explanations.

The score must be transparent and reproducible. LLM output shall not be the authoritative numerical scoring engine.

### 7.10 Documents & Resume

Owns document metadata, resume versions, upload lifecycle, malware-scan state, parsed resume structure, generated resume artifacts, file access policy, and evidence attachments.

### 7.11 Opportunities

Owns jobs/internships, employer/institution/platform/external source, posting versions, eligibility criteria, compensation terms, location/work mode, deadlines, moderation state, and immutable/versioned material terms.

### 7.12 Applications & Recruitment

Owns native applications, external application tracking, consented profile snapshot, state transitions, employer pipeline, withdrawal, offers, outcomes, and status history.

### 7.13 Interviews

Owns interview stages, schedules, preparation plans, interview outcome metadata, reminders, and post-interview reflections.

### 7.14 Institution Intervention

Owns institution-assigned tasks, counseling/intervention records, assigned students/cohorts, due dates, resolution, and intervention outcome.

### 7.15 Employer Trust & Accountability

Owns employer verification, material-term adherence reports, evidence links, trust status, enforcement history, and moderation outcomes.

### 7.16 Trust & Safety

Owns reports, cases, evidence metadata, case classification, reviewer assignment, decisions, sanctions, appeal state, and safety/security signals.

Reports do not automatically modify Career Readiness.

### 7.17 AI Orchestration

Owns AI policies, model routing, provider abstraction, prompt templates/versioning, context assembly, retrieval, tool/action authorization, usage metering, cost data, safety filters, and AI execution audit metadata.

### 7.18 Learning Assistance

Owns subject-help context, institution learning collections, student learning queries, learning recommendations, and references returned to students. It consumes AI Orchestration rather than calling providers directly.

### 7.19 Notifications

Owns notification templates, preferences, notification queue, email/in-app delivery state, retry/dead-letter behavior, and user notification history.

### 7.20 Subscription, Billing & Entitlements

Owns plans, annual subscription periods, payment transaction references, entitlement activation/suspension/expiry, coupons if later enabled, and institutional bulk entitlement model.

### 7.21 Reporting & Analytics

Owns derived metrics/read models. It must not become a backdoor around operational authorization. Analytical access shall retain tenant, role, and privacy constraints.

### 7.22 Audit & Security

Owns immutable security/audit event records, administrative actions, authorization denials, high-risk changes, authentication events, and integrations with monitoring/SIEM.

### 7.23 Platform Administration

Provides privileged workflows over domain APIs. It shall not directly edit production database tables.

---

## 8. Cross-Domain Interface Rules

1. A module may write only its owned data.
2. Cross-domain reads shall occur through approved service interfaces, repositories exposed by the owning module, or replicated read models.
3. Cross-domain state changes shall use service commands and domain events, never direct table mutation.
4. User-facing API DTOs are not database entities.
5. Domain events are versioned.
6. Every event must include event ID, event type/version, occurred-at timestamp, actor/subject context where applicable, correlation ID, and tenant/organization scope where applicable.
7. External side effects shall use the transactional outbox pattern where reliability is required.
8. Any future microservice extraction must preserve the same contracts.

---

# PART III — USER JOURNEYS

## 9. Student Journey

1. Student receives institution invitation.
2. Student self-registers and verifies email.
3. Institution relationship is established/verified.
4. Student completes profile and career-interest assessment.
5. Student completes baseline aptitude/technical/communication assessments.
6. Readiness score and gaps are generated.
7. Career recommendations are shown with reasons and confidence/provenance.
8. Student chooses target career(s).
9. Career roadmap is generated and accepted.
10. Student uploads/builds resume.
11. Matching opportunities are surfaced.
12. Student applies natively or records an external application.
13. Interview events trigger preparation tasks/reminders.
14. Outcomes update timeline/readiness components where appropriate.
15. AI Copilot assists continuously but must seek confirmation before consequential changes.
16. After graduation, account transitions to graduate state without losing personal career history.

## 10. Institution Journey

1. PlanThePath approves institution.
2. Institution owner/admin configures hierarchy.
3. Students are invited via controlled invitation/bulk invite flow.
4. Faculty/placement roles are assigned with department/program/batch scope.
5. Staff verify eligible student academic/skill claims.
6. Placement team reviews cohort dashboards and readiness distributions.
7. Staff drill into authorized student profiles and assign interventions.
8. Institution creates assessments/opportunities.
9. Placement progress and outcomes are reported.
10. When student relationship ends/transfers, ongoing activity access stops automatically.

## 11. Employer Journey

1. Employer signs up with business email.
2. Organization profile and evidence are submitted.
3. PlanThePath verification/review is completed.
4. Employer owner adds recruiters/hiring managers/interviewers.
5. Employer creates opportunity and material terms.
6. Validation/moderation passes; posting is published.
7. Matching eligible students see opportunity.
8. Students apply and consented applicant profile is shared.
9. Recruiters move applicants through pipeline.
10. Employer assessments/interviews are scheduled.
11. Offer/hire/rejection is recorded.
12. Post-process accountability feedback may open a Trust & Safety case.

## 12. Operations Journey

The operations portal handles organization approval, user support, billing/entitlements, opportunity moderation, trust/safety cases, AI configuration, feature flags, content, audit review, and system-health links. Privileged actions require reason capture and strong audit logging; selected high-risk actions require step-up authentication and/or dual approval.

---

# PART IV — EXPERIENCE AND FRONTEND ARCHITECTURE

## 13. Frontend Applications

Recommended logical applications:

- `student-web`
- `institution-web`
- `employer-web`
- `ops-web`
- shared design system/package
- shared API client/types package
- shared authentication/session package where security boundaries permit

Student, institution, and employer apps may share the same hosting platform/CDN but shall remain separately deployable. The Ops app shall have a separate deployment and stricter network/session/security policy.

## 14. UX Principles

- Mobile-first responsive layouts for student workflows.
- Desktop-optimized analytical tables/dashboards for institution/employer/ops workflows while retaining responsive fallbacks.
- WCAG 2.2 AA target for core flows.
- English V1, but all UI text externalized through i18n resources.
- Do not rely on color alone for readiness/status meaning.
- Every calculated score/recommendation must have an explanation route.
- AI-generated content must be visually distinguishable where material.
- Destructive/irreversible operations require explicit confirmation.
- Private AI conversation status must be clear to students.
- Employer material-term changes must be prominent to applicants.

## 15. Primary Student Navigation

Dashboard, Career, Readiness, Assessments, Skills, Resume, Opportunities, Applications, Interviews, Learning, AI Copilot, Timeline, Notifications, Account & Privacy.

## 16. Primary Institution Navigation

Dashboard, Students, Cohorts, Readiness, Assessments, Interventions, Opportunities, Placement Pipeline, Faculty/Users, Organization, Reports, Notifications.

## 17. Primary Employer Navigation

Dashboard, Company, Opportunities, Applicants, Assessments, Interviews, Offers/Outcomes, Recruiter Users, Analytics, Trust/Compliance, Settings.

## 18. Primary Ops Navigation

Organizations, Users, Verification Queue, Opportunity Moderation, Trust & Safety Cases, Subscriptions, Billing, Content, AI Configuration, Feature Flags, Audit/Security, Support, System Status.

---
