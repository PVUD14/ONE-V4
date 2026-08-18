# PlanThePath Application Architecture & Implementation Specification V1

**Status:** Approved — Authoritative V1 Baseline  
**Repository target:** `PVUD14/planthepath` (private)  
**Initial market:** India  
**Initial scale target:** 10,000 students; 100+ employers  
**Commercial model:** Pricing TBD. Configurable subscription plans and entitlements supporting direct student subscriptions, institution-funded/bulk-seat licensing, trials/promotions, and future commercial models without hard-coded price assumptions  
**V1 delivery:** Responsive English-language web application  
**Document role:** Authoritative implementation reference after approval  
**Application code status:** Not started

---

## 1. Executive Architecture Decision

PlanThePath will be implemented as a **multi-tenant, four-sided career-success SaaS platform** with four primary application surfaces:

1. Student Portal
2. Institution Portal
3. Employer Portal
4. PlanThePath Operations Portal

The V1 backend will use a **modular core architecture**, not a distributed microservice fleet. Transactional business domains will live in a strongly modularized core API with explicit domain ownership, interfaces, schemas, authorization boundaries, and events. AI orchestration and asynchronous/background processing will be separately deployable components because their scaling, failure, cost, and security characteristics differ materially from ordinary transactional workloads. The privileged Operations Portal will also be separately deployable from public-facing portals.

This is a deliberate compromise: a single unstructured monolith is rejected, but premature microservices are also rejected for the initial 10K-student target. Any domain can later be extracted behind its existing interface/event contract when throughput, team ownership, availability, or independent deployment requirements justify extraction.

---

# PART I — PRODUCT SPECIFICATION

## 2. Product Objective

PlanThePath shall help students progress from education to employment through measurable career planning, assessment, preparation, opportunity discovery, application tracking, interview preparation, and AI-assisted guidance.

It shall simultaneously provide institutions with authorized visibility into student career readiness and placement activity, employers with a trusted route to publish opportunities and recruit participating students, and the PlanThePath team with a secure operational control plane.

### 2.1 Core value proposition

**Student:** “What should I do next to become employable in my target career?”  
**Institution:** “Which students need intervention, what do they need, and what placement activity is happening?”  
**Employer:** “Which consenting applicants meet my actual requirements, and can I run a reliable hiring pipeline?”  
**PlanThePath:** “Can we measurably improve and govern the education-to-employment journey?”

### 2.2 Product moat

The defensible product asset is not the LLM. It is the **student career graph** and the verified events that accumulate around it:

Education → verified learning → skills → assessments → career goals → gaps → roadmap → interventions → opportunities → applications → interviews → offers → employment.

AI is an intelligence and interaction layer over that graph.

---

## 3. Target Users

### 3.1 Students

V1 targets adult (18+) undergraduate/college students in India. Postgraduate, diploma/polytechnic, recent graduates, and international expansion are supported by the domain model but are not required for first launch unless explicitly enabled.

### 3.2 Institutions

Colleges, universities, training institutes, and other approved educational organizations. A local institute may verify student records only after it becomes a verified PlanThePath organization.

### 3.3 Employers

Verified companies and recruiter organizations that create job/internship opportunities and manage applicants.

### 3.4 PlanThePath staff

Platform operations, technical administration, security, support, billing, moderation, content, and authorized super-administration staff.

---

## 4. User Roles

### 4.1 Student domain

- Student
- Graduate

### 4.2 Institution domain

- Institution Owner
- Institution Admin
- Placement Admin
- Placement Officer
- Department Head
- Faculty/Lecturer
- Career Counselor
- Institution Analyst (read-only)

### 4.3 Employer domain

- Employer Owner
- Employer Admin
- Recruiter
- Hiring Manager
- Interviewer

### 4.4 Platform domain

- Platform Super Admin
- Operations Admin
- Security Admin
- Support Agent
- Billing Admin
- Content/Moderation Admin

Roles define coarse-grained permissions. Resource scope, tenant association, institution relationship dates, department/batch assignment, opportunity ownership, application consent, and other contextual attributes shall be enforced using policy/attribute checks in addition to RBAC.

---

## 5. Institutional Relationship Model

A student shall not be modeled with a single permanent `college_id`.

A student can have multiple institution relationships over time and may concurrently have different relationship types (e.g., graduation college and participating training institute).

### 5.1 Relationship states

`PENDING → VERIFIED → ACTIVE → ENDED | TRANSFERRED | GRADUATED | REVOKED`

### 5.2 Authorization rule

Institution visibility shall depend on a valid relationship and the relationship's effective time range.

When a student transfers away from College A to College B:

- College A loses access to activity generated after its relationship end time.
- College B receives access only after its relationship is verified and according to its authorized role/scope.
- The student retains a continuous personal career timeline.
- Historical data access by a former institution shall be limited to data it lawfully originated or was entitled to during the active relationship, subject to retention policy.

This is a mandatory **temporal authorization** property.

---

## 6. MVP vs Future Scope

### 6.1 MVP / V1

- Student onboarding and invited self-registration
- Institution onboarding and hierarchy
- Employer onboarding and verification
- Role and scoped authorization
- Student career profile
- Academic pass/fail records with optional marks/GPA
- Record provenance and institution verification
- Skills and competency profile
- Career-interest assessment
- Aptitude assessment
- Technical assessments
- Communication assessment (initial structured format)
- Career readiness scoring
- Resume upload, structured resume profile, resume builder/optimizer
- Career recommendations
- Career roadmap and tasks
- Internship/job opportunity publishing
- PlanThePath/institution/employer/external opportunity sources
- Eligibility and matching
- Native applications for PlanThePath opportunities
- External application tracking
- Recruitment pipeline
- Interview tracking and preparation
- Institution interventions/tasks
- Student/institution/employer notifications via in-app and email
- AI career copilot
- AI subject/learning assistance
- Institution knowledge documents for AI retrieval
- Employer trust/accountability workflow
- Trust & Safety reporting/cases
- Subscriptions, entitlements, individual payment integration
- Institution dashboards and cohort reporting
- Employer hiring analytics
- Admin operations portal
- Audit/security logging
- Data export and deletion workflow
- Responsive mobile browser experience

### 6.2 Post-MVP

- Native Android/iOS applications
- Voice mock interviews
- Video interview analysis only after separate privacy/fairness review
- College SSO/SAML/OIDC
- Institution ERP/SIS integrations
- Employer ATS integrations
- Institutional bulk billing/invoicing UI
- Regional-language UI and AI
- Advanced talent search with explicit student opt-in
- Public employer trust badges based on mature evidence model
- Institution branding themes/custom domains
- Advanced placement forecasting
- Advanced proctoring if independently justified

### 6.3 Explicitly not V1

- Full LMS replacement
- Full enterprise ATS replacement
- Automated mass job application on behalf of students
- Unrestricted employer browsing of student profiles
- Employer access to private student AI chat history
- AI-generated student morality/personality/reputation scores
- Invasive webcam proctoring
- True multi-brand white-label deployment

---
