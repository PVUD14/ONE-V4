# PlanThePath UX Information Architecture V1

**Status:** Proposed implementation baseline  
**Applies to:** Student, Institution, Employer, Platform Operations portals  
**Authority:** Must remain consistent with `docs/architecture/APPLICATION_ARCHITECTURE_SPEC.md` and `docs/security/AUTHORIZATION_MATRIX.md`.

## 1. UX principles

1. Four distinct product experiences share one design system; they do not share one indiscriminate navigation tree.
2. Frontend visibility is permission-aware, but server-side authorization remains authoritative.
3. Users see business-language capabilities, never RBAC/ABAC implementation jargon.
4. Student screens optimize for next action and progress; Institution screens for cohort intervention; Employer screens for hiring workflow; Operations screens for controlled administration.
5. Private AI conversations are visible only to the student by default.
6. Former institutions cannot see student activity after the relationship effective end time.
7. Employer candidate views require opportunity scope plus valid applicant consent/access grant.
8. Every privileged mutation has confirmation, audit context, and a clear success/failure state.
9. Responsive mobile web is first-class for Student; dense desktop workflows are primary for Institution/Employer/Ops but remain responsive.
10. English V1 strings use localization keys from the start.

## 2. Shared application shell

Desktop: top bar + collapsible left navigation + workspace + optional contextual right rail. Mobile: compact top bar + bottom navigation for the 4–5 highest-frequency destinations + More menu.

Shared top-bar capabilities where authorized: global/contextual search, notifications, help, profile/account, organization switcher for users with multiple memberships.

No UI element grants authority. Hidden/disabled actions are UX affordances only; API policy is re-evaluated on every protected request.

## 3. Permission-driven navigation contract

The authenticated session exposes a normalized capability context:

- user/account state
- active organization and membership
- coarse roles
- effective permissions
- resource scopes (department/program/batch/opportunity/etc.)
- relationship effective dates
- feature entitlements
- feature flags

Navigation items declare required capabilities. If none are satisfied, the item is absent. Direct navigation to an unauthorized route returns a safe 403/404 experience without leaking protected resource existence.

## 4. Student Portal

### Primary navigation

Home; My Career; Readiness; Assessments; Skills; Opportunities; Applications; Interviews; Resume; Learning; AI Career Coach; Tasks; Documents; Notifications; Profile & Privacy.

### Home

Purpose: answer “What should I do next?”

Components: readiness summary, primary career target, next-best actions, upcoming interviews/assessments/deadlines, application status changes, roadmap progress, institution-assigned actions, relevant opportunity recommendations.

Primary actions: Continue assessment, update resume, view recommendation, apply, prepare for interview, complete task.

### My Career

Screens: career targets, career explorer, target detail, gap analysis, roadmap, milestones/tasks, history.

Students can select/change primary and secondary targets. AI may propose roadmap mutations but cannot apply them without confirmation.

### Readiness

Screens: overall score, component breakdown, evidence, history, model explanation, improvement actions.

Must show score/model version and explain contributing components. No opaque morality/genuineness score. Integrity/safety enforcement is separate.

### Assessments

Tabs: Recommended, Institution Assigned, Employer Assessments, Completed.

Each card shows source, type, duration, due date, attempts, readiness eligibility, and integrity requirements. Employer-specific tests are clearly distinguished from PlanThePath readiness-eligible tests.

### Skills

Views: verified skills, assessment-backed skills, declared skills, gaps for target career, evidence/verification status.

### Opportunities

Views: recommended, internships, jobs, saved, institution opportunities.

Filters: career, skill, location, work mode, opportunity type, compensation, eligibility, verified employer. Cards show explainable match factors and verification/source state.

### Opportunity detail

Role/company, verification, material terms, eligibility, responsibilities, required/preferred skills, selection stages, deadline, source, material-term version, match explanation, Save/Apply/Track externally.

### Applications

Views: list + pipeline/timeline. Native and externally tracked applications are distinguished. Application detail shows submitted profile/resume snapshot, employer-term version, stages, interview events, offer/outcome and withdrawal where allowed.

### Interviews

Upcoming calendar/list, interview detail, preparation checklist, role/company context, AI preparation, post-interview reflection and outcome.

### Resume

Resume versions, upload, structured profile, builder/editor, optimization suggestions, preview/export. Students control which version is submitted to each application.

### Learning

Subject/career-skill question workspace, institution knowledge sources, saved explanations, recommended learning tasks. Retrieved institutional sources are visibly attributed.

### AI Career Coach

Conversation list + career context header + chat workspace + proposed actions. Context header can show target career/readiness/active roadmap without exposing hidden system data. Consequential actions use explicit Confirm/Cancel.

### Tasks

Tabs: My roadmap, Institution assigned, Completed. Shows source, due date, priority, evidence/completion requirements.

### Documents

Private files, resumes, certificates/evidence, verification state, sharing state. Upload lifecycle visibly distinguishes Processing/Quarantined/Available/Rejected.

### Profile & Privacy

Personal profile, academic relationships, career preferences, notification preferences, connected identity methods, active sessions, data export, deletion request, consent/sharing controls.

## 5. Institution Portal

### Role families

Institution Owner/Admin; Placement Admin/Officer; Department Head; Faculty/Lecturer; Career Counselor; Analyst.

### Institution Owner/Admin navigation

Executive Dashboard; Students; Readiness; Departments & Programs; Staff & Access; Assessments; Opportunities; Placement Pipeline; Interventions; Reports; Knowledge; Notifications; Institution Settings; Licensing/Entitlements where authorized.

### Placement Admin/Officer navigation

Dashboard; Students; Readiness; Assessments; Skills Gaps; Opportunities; Applications; Interviews; Interventions; Reports; Messages/Notifications.

### Department Head navigation

Department Dashboard; Students; Readiness; Skills Gaps; Assessments; Interventions; Reports. Scope defaults to assigned department/program/batches.

### Faculty/Lecturer navigation

Home; My Students; Academic Verification; Assessments; Assigned Tasks/Recommendations. No institution billing, global placement administration, employer disputes or unrelated departments.

### Career Counselor navigation

My Students/Caseload; Career Plans; Readiness; Interventions; Appointments/Tasks; Notes governed by separate visibility policy. No raw private AI chat access.

### Analyst navigation

Read-only dashboards/reports for authorized organizational scope; no mutations or bulk sensitive exports unless separately granted.

### Institution Dashboard

KPIs: active students, placement eligible, readiness bands, intervention-needed, applications, interviews, offers, placed, readiness trend, top skill gaps, upcoming drives, students requiring attention. Drill-down always respects active relationship and staff scope.

### Student Directory

Search/filter by hierarchy, cohort, readiness band, target career, placement state and intervention state. Bulk actions require explicit bulk permission and confirmation.

### Institution Student Detail

Header: identity, program/batch, active relationship state. Tabs: Career Overview; Readiness; Skills; Academic Verification; Applications/Interviews visible under policy; Tasks/Interventions; Institution-originated history.

Explicitly excluded: private AI conversations, unshared personal documents, unrelated employer data, post-relationship activity for former institutions.

### Academic Verification

Queue of student-declared academic records/evidence. Actions: Verify, Reject with reason, Request clarification. Verifier identity/time/provenance is retained.

### Institution Assessments

Create/version question banks and assessments, assign cohorts/students, schedule windows, view results/integrity signals, publish results. Only certified assessment types can influence readiness according to scoring policy.

### Institution Opportunities

Create institution-originated opportunities/placement drives, eligibility, target cohorts, deadlines and communications. Employer-originated material terms cannot be silently overwritten.

### Interventions

Create task/counseling intervention, assign student/cohort, due date/priority, track acknowledgement/completion/outcome. Former institution access terminates according to temporal policy.

### Staff & Access

Invite staff, assign role(s), assign department/program/batch/caseload scopes, revoke memberships, view access history. UI warns when a permission broadens scope materially.

## 6. Employer Portal

### Role families

Employer Owner/Admin; Recruiter; Hiring Manager; Interviewer.

### Employer Owner/Admin navigation

Dashboard; Opportunities; Applicants; Assessments; Interviews; Offers; Team & Access; Company Profile; Verification & Trust; Analytics; Notifications; Settings.

### Recruiter navigation

Dashboard; Opportunities assigned/managed; Applicants; Assessments; Interviews; Offers; Notifications. No organization ownership/security controls unless granted.

### Hiring Manager navigation

Assigned Opportunities; Candidate Pipeline; Interviews; Scorecards/Decisions; Offers where granted.

### Interviewer navigation

My Interviews; Candidate briefing for assigned interviews; Interview Scorecard. No candidate export, company admin or unrelated applicant access.

### Employer Dashboard

Active opportunities, applications, eligible/shortlisted, interviews, offers, hires, aging pipeline, deadlines and action queue.

### Opportunity creation wizard

Steps: Role → Requirements → Eligibility → Compensation & Terms → Selection Process → Targeting/Visibility → Preview → Submit.

Material terms include compensation, duration, work mode/location, employment/internship type and key joining conditions. Published material changes create a new version and notify affected applicants.

### Applicants

Pipeline stages: Applied → Screening → Shortlisted → Assessment → Interview → Offer → Hired/Rejected/Withdrawn. Stages may be skipped where allowed. Candidate data is opportunity-scoped and consent-gated.

### Candidate detail

Permitted profile snapshot, submitted resume, verified skills, relevant readiness components/overall score only where product policy permits, institution endorsement after application, assessment results relevant to the opportunity, recruitment history for this employer/opportunity.

Never expose private AI chat, unrelated applications, institution counseling, trust/safety reports or unshared records.

### Verification & Trust

Company verification status/evidence requests, policy notices, material-term adherence feedback/cases where employer response is allowed, enforcement status and appeal workflow.

## 7. Platform Operations Portal

This is a separate privileged surface with stronger authentication/session controls.

### Role-specific navigation

Platform Super Admin: all approved control-plane modules, excluding raw secrets.

Operations Admin: Overview; Institutions; Employers; Users; Verification; Opportunity Moderation; Support; Feature operations; operational reports.

Security Admin: Security Overview; Authentication/Sessions; Authorization Denials; Privileged Audit; Security Alerts; Integrations Security; Trust/Safety security cases.

Support Agent: User/organization search; support cases; account state/support-safe actions; limited audit timeline. No global policy, prompt, billing or bulk export authority.

Billing Admin: Plans/Pricing; Subscriptions; Payments; Refund/Reconciliation; Entitlements; institutional licensing.

Content/Moderation Admin: Careers/Skills taxonomy; platform assessments/content; opportunity moderation; Trust & Safety case workflows where assigned.

### Operations Overview

Platform health/business operational counts, verification queues, moderation queues, safety cases, failed jobs, notification health, AI usage/cost/latency, security alerts. Widgets themselves are permission filtered.

### Organization administration

Institution/employer review, verification, suspension/reactivation, membership support and scoped audit history. High-risk actions require reason capture and confirmation.

### AI Operations

Restricted roles only: model routing, prompt/policy versions, evaluation results, knowledge-source status, usage/cost, latency/failures and safety events. No general UI for reading student private conversations.

### Security

Security events, authentication anomalies, session revocation, authorization-denial trends, privileged changes and alert investigations. Raw secrets are never displayed.

### Prohibited Ops features

No unrestricted SQL console; no unrestricted production file browser; no raw secret viewer; no generic “impersonate any user” function without a separately approved secure support design.

## 8. Core route/capability map

Examples:

- `/student/readiness` → student.readiness.read:self
- `/institution/students` → student.read:institution_scope
- `/institution/academic-verification` → academic.verify:assigned_scope
- `/employer/opportunities` → opportunity.manage:employer_scope
- `/employer/applicants/:id` → application.read:opportunity_scope + valid applicant grant
- `/ops/employers/verification` → employer.verify:platform
- `/ops/security/audit` → audit.read:security_scope

Route visibility is evaluated from effective capabilities. API authorization independently evaluates resource, organization, relationship time and consent.

## 9. Cross-role behavior

A person may hold multiple roles. Navigation is the union of allowed capabilities within the active organization context, not a hardcoded role menu. Organization switching recalculates capabilities. Privilege revocation invalidates/recomputes the session capability context and protected APIs reject stale authority.

## 10. UX states required for every major screen

Each implementation must define: loading/skeleton; first-use empty state; no-results state; validation errors; permission denied; stale/conflict state; dependency unavailable; destructive confirmation; success acknowledgement; mobile layout; accessibility keyboard/focus behavior.

## 11. Accessibility and responsive baseline

Target WCAG 2.2 AA. Keyboard-operable navigation and dialogs; visible focus; semantic headings/landmarks; accessible tables; non-color-only score/status communication; minimum usable touch targets; charts require textual/tabular alternatives; reduced-motion preference honored.

## 12. Design-system direction

Professional career SaaS aesthetic: restrained, credible, data-readable. Student experience can be more motivational; Institution analytical; Employer workflow-oriented; Operations dense/control-oriented. Shared primitives: typography, spacing, buttons, form fields, dialogs, tables, cards, badges, tabs, breadcrumbs, timeline, stepper, score/risk components, charts, empty/error states, permission-aware action wrapper.

Institution branding in V1 is co-branding (institution identity inside PlanThePath), not full white-label.

## 13. Implementation rule

Codex/developers must not invent new navigation, expose a privileged action, or broaden a role’s visibility merely to simplify UI implementation. Changes to screen/capability mappings must be reconciled with the authorization matrix and architecture specification.
