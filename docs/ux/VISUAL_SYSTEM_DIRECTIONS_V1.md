# PlanThePath V1 Visual System Directions

**Status:** Proposed visual exploration baseline  
**Applies to:** Student Portal, Institution Portal, Employer Portal, Platform Operations Portal  
**Source authority:** `docs/architecture/APPLICATION_ARCHITECTURE_SPEC.md`, `docs/phase-0/design-system-baseline.md`, `docs/phase-0/authorization-matrix.md`, `docs/phase-0/data-classification-retention.md`, `docs/ux/UX_INFORMATION_ARCHITECTURE.md`, `docs/ux/SCREEN_CATALOG.md`, `docs/ux/ROLE_NAVIGATION_MATRIX.md`  
**Implementation status:** Documentation only. Do not implement production frontend code from this file until one direction is selected and converted into tokens/components.

## Purpose

This document defines exactly three distinct visual directions for PlanThePath V1. Each direction keeps the product professional, career-focused, and credible for adult students, institutions, employers, and platform staff. The product must not feel like a children's LMS, a test-prep toy, or a gamified school portal.

The representative screens for visual evaluation are:

- `STU-001` Student Home / Dashboard
- `INS-001` Institution Executive Dashboard
- `EMP-001` Employer Dashboard
- `OPS-001` Operations Overview

## Non-Negotiable Design Constraints

1. Four portals share design primitives, but navigation, density, and hierarchy vary by portal.
2. Frontend visibility remains permission-aware, but server-side authorization remains authoritative.
3. UI labels use business language, not RBAC/ABAC jargon.
4. Student screens prioritize next action and career progress.
5. Institution screens prioritize cohort visibility, readiness distribution, skill gaps, interventions, and placement activity.
6. Employer screens prioritize opportunity performance, applicant pipeline, interviews, deadlines, and accountable hiring workflow.
7. Operations screens prioritize controlled administration, queues, health, auditability, and security posture.
8. Private AI conversations are visible only to the student by default.
9. Employers never receive generic student-directory access in V1.
10. Former institutions never see post-relationship student activity.
11. Employer candidate data is opportunity-scoped and consent-gated.
12. Sensitive provenance must be visually distinguishable: `SELF_DECLARED`, `INSTITUTION_VERIFIED`, `PLATFORM_ASSESSED`, `EMPLOYER_REPORTED`, and `EXTERNALLY_EVIDENCED`.
13. No status may rely on color alone. Use labels, icons, tooltips, copy, and tabular alternatives for charts.
14. High-risk actions require consequence text, reason capture where required, confirmation, and audit-ready success/failure states.
15. AI unavailable states are degraded capability states, not broken core portal states.
16. Use responsive web patterns. Student must work well on mobile browser; Institution, Employer, and Ops can be desktop-dense with responsive fallbacks.

## Shared Foundation Across All Directions

### Product Tone

PlanThePath should feel like a professional employment operating system:

- serious enough for colleges and employers;
- clear enough for students under pressure;
- trustworthy enough for private records, applications, AI, billing, and privileged operations;
- visually modern without looking experimental or juvenile.

Avoid:

- cartoon mascots;
- childish achievement badges;
- loud rainbow palettes;
- classroom-style LMS decoration;
- social-feed aesthetics;
- vanity dashboards full of decorative metrics;
- fake AI magic surfaces that hide provenance or authorization.

### Shared Shell

Desktop shell:

- top bar with active portal context, search where authorized, notifications, help, account, and organization switcher;
- collapsible left navigation rendered from effective capabilities;
- main workspace with page heading, state summary, primary action, and permission-safe secondary actions;
- optional right rail for context, next action, audit/context notes, or AI assistance where allowed.

Mobile shell:

- compact top bar;
- bottom navigation for 4-5 highest-frequency destinations;
- More menu for lower-frequency modules;
- dashboards reduce to prioritized stacked sections, not miniaturized desktop tables.

### Shared Primitive Categories

- typography scale and heading rhythm;
- spacing scale;
- buttons and icon buttons;
- form fields, selects, search, filters;
- cards, section groups, tables, list rows;
- tabs, breadcrumbs, steppers, timelines;
- score components and score explanations;
- provenance badges and data-source chips;
- status badges with icon + label + accessible text;
- charts with table alternatives;
- skeleton, empty, no-results, degraded, permission-denied, stale/conflict, validation, recoverable-error, and terminal-error states;
- confirmation dialogs with reason capture for privileged/high-risk actions;
- permission-aware action wrapper that never substitutes for API authorization.

## Direction 1: Career Command

### Design Thesis

Career Command is a crisp, modern employment cockpit. It gives students a clear next step, gives institutions readable placement intelligence, gives employers a hiring operations dashboard, and gives operations staff a controlled command surface.

This is the safest default for V1 because it balances aspiration, credibility, and dashboard clarity.

### Visual Personality

- Professional SaaS, clean and decisive.
- Strong page hierarchy with restrained surfaces.
- Progress feels measurable, not gamified.
- Employment and readiness concepts feel like operating data, not school homework.

### Palette

| Token role | Suggested value | Usage |
|---|---:|---|
| Base | `#F7F9FC` | app background |
| Surface | `#FFFFFF` | primary panels and tables |
| Text strong | `#101828` | headings and key metrics |
| Text muted | `#667085` | secondary copy |
| Border | `#D0D5DD` | dividers and table lines |
| Brand | `#164C8F` | primary actions, active nav |
| Career accent | `#0E9384` | student progress and positive movement |
| Warning | `#DC6803` | deadlines, pending verification |
| Danger | `#D92D20` | destructive/error states |
| Info | `#1570EF` | neutral system notices |

Portal accents:

| Portal | Accent | Meaning |
|---|---:|---|
| Student | `#0E9384` | progress and readiness |
| Institution | `#164C8F` | cohort analytics and intervention control |
| Employer | `#6941C6` | hiring pipeline and opportunity management |
| Operations | `#344054` | privileged control and platform health |

### Typography

- Primary font: Inter or Geist Sans.
- Optional numeric font: Geist Mono for operational IDs, timestamps, and audit references.
- Body baseline: 14-16px.
- Dashboard metrics use 28-36px only for primary KPIs; avoid oversized hero typography inside app screens.

### Shape, Density, and Motion

- Radius: 6-8px for cards, inputs, and buttons.
- Shadows: rare, low elevation only for overlays/popovers.
- Tables use dividers first, not heavy card stacking.
- Motion is functional: expanding filters, row focus, toast transitions. Respect reduced motion.

### Representative Screen Direction

#### Student Dashboard

Primary question: "What should I do next to become employable in my target career?"

Layout:

- top summary row: target career, readiness score, next deadline;
- dominant next-action panel with one primary action such as Continue assessment or Prepare for interview;
- readiness component strip with score model/version link;
- application/interview timeline;
- recommended opportunities with match reasons and verified employer/source state;
- right rail with roadmap progress and private AI Coach entry point.

Privacy handling:

- AI Coach is clearly marked private to student by default.
- Data provenance appears next to readiness, academic records, skills, and recommendations.
- Resume/application submission uses consent and snapshot language.

#### Institution Dashboard

Primary question: "Which students need intervention, and what placement activity is moving?"

Layout:

- scoped institution header with org, active relationship policy cue, and role/scope text in business language;
- KPI row: active students, placement eligible, intervention-needed, interviews, offers, placed;
- readiness band chart with accessible table toggle;
- top skill gaps list with cohort filters;
- students requiring attention queue;
- upcoming drives/interviews;
- scoped drill-down actions only when capability exists.

Privacy handling:

- no private AI-chat entry points.
- student detail links use active relationship and staff scope.
- former relationship or insufficient scope returns safe permission messaging without leaking protected records.

#### Employer Dashboard

Primary question: "Which hiring actions need attention today?"

Layout:

- company verification/trust status line;
- KPI row: active opportunities, new applicants, shortlisted, interviews, offers, hires;
- aging pipeline chart;
- action queue for review applicants, schedule interviews, respond to trust/evidence request;
- active opportunities table with posting version, deadline, material-term warnings;
- quick action to create opportunity if authorized.

Privacy handling:

- no student directory.
- candidate links require opportunity scope and valid applicant grant.
- material-term changes are versioned and visible.

#### Operations Dashboard

Primary question: "What platform risks, queues, and health signals need controlled action?"

Layout:

- privileged context header with role, session strength/MFA indicator, and environment;
- queue summary: institutions, employers, moderation, trust/safety, support, billing exceptions;
- platform health strip: API, queues, notifications, AI usage/cost/latency, security alerts;
- assigned cases table with severity, SLA, owner, and next action;
- audit/security highlights with safe metadata only;
- restricted AI Ops entry shown only to authorized roles.

Privacy handling:

- no raw private AI conversation browser.
- no SQL console, unrestricted file browser, raw secret viewer, or generic impersonation control.
- high-risk actions require reason capture and confirmation.

### Best Fit

Choose Career Command if V1 needs the most balanced, boardroom-safe, implementation-friendly visual identity.

## Direction 2: Verified Pathway

### Design Thesis

Verified Pathway makes trust, provenance, and career progression the visual spine. It treats every student signal as evidence with a source, every application as a controlled snapshot, and every employer/institution action as a governed workflow.

This direction is strongest when PlanThePath wants to differentiate on verified employability, not just dashboards.

### Visual Personality

- Evidence-led, structured, premium.
- More editorial and certificate-like than generic SaaS.
- Strong emphasis on timelines, source tags, version history, and trust states.
- Student motivation comes from verified movement, not playful rewards.

### Palette

| Token role | Suggested value | Usage |
|---|---:|---|
| Base | `#F8FAFB` | app background |
| Surface | `#FFFFFF` | panels and data surfaces |
| Text strong | `#111827` | headings and dense copy |
| Text muted | `#5B6472` | secondary copy |
| Border | `#CBD5E1` | dividers and evidence rows |
| Brand | `#0F3B57` | primary actions and nav |
| Verified | `#067647` | verified/proven data |
| Assessed | `#175CD3` | platform-assessed data |
| Reported | `#B54708` | employer-reported or pending action |
| Restricted | `#B42318` | denied, destructive, restricted states |

Portal accents:

| Portal | Accent | Meaning |
|---|---:|---|
| Student | `#067647` | verified progress |
| Institution | `#175CD3` | institutional verification and cohort insight |
| Employer | `#7F56D9` | controlled hiring and candidate review |
| Operations | `#0F172A` | governance and audit control |

### Typography

- Primary font: IBM Plex Sans, Source Sans 3, or Inter.
- Mono font: IBM Plex Mono for audit IDs, version IDs, and evidence references.
- Use slightly tighter dashboard density than Career Command, but keep body text readable.

### Shape, Density, and Motion

- Radius: 4-6px.
- Dividers, timelines, badges, and source chips carry most structure.
- Tables and lists feel like professional review queues.
- Motion emphasizes state change: verified, submitted, acknowledged, revoked, expired.

### Representative Screen Direction

#### Student Dashboard

Primary question: "Which verified steps move me toward my target role?"

Layout:

- career target header with readiness score and model version;
- evidence-backed progress timeline: declared -> assessed -> verified -> applied -> interviewed;
- next action panel tied to a missing evidence or readiness gap;
- readiness components with source chips;
- application snapshot reminders and upcoming interview preparation;
- private AI Coach shown as a confidential advisor with explicit action confirmation.

Privacy handling:

- private AI content is separated from verified career graph data.
- self-declared, institution-verified, platform-assessed, employer-reported, and externally evidenced signals are visually distinct.
- application cards show which resume/profile snapshot was shared.

#### Institution Dashboard

Primary question: "Which claims, gaps, and placement steps need verification or intervention?"

Layout:

- verification queue and readiness bands share the top-level hierarchy;
- cohort filters are explicit: department, program, batch, assigned scope;
- student-attention queue shows reason: low readiness, missing verification, assessment due, intervention overdue;
- placement funnel shows source and effective-date constraints;
- reports/export controls appear only when separately granted.

Privacy handling:

- no unshared personal documents.
- no private AI-chat menu.
- institution-originated history is separated from post-relationship activity.

#### Employer Dashboard

Primary question: "Which consented applicants have the verified evidence needed for this role?"

Layout:

- opportunity-centric dashboard instead of generic talent discovery;
- active opportunities list with versioned material terms;
- applicant pipeline with consent and snapshot states;
- candidate action queue: review verified skills, schedule interview, submit scorecard, respond to case;
- trust status and moderation notices are visible but not alarmist.

Privacy handling:

- candidate cards show only permitted applicant snapshots.
- no private counseling, AI chats, unrelated applications, or generic student browsing.
- material-term change warnings are prominent.

#### Operations Dashboard

Primary question: "Which governed workflows need review, approval, or enforcement?"

Layout:

- review queues organized by evidence state: under review, missing evidence, escalated, decision due;
- platform health and AI usage are present but secondary to controlled workflow;
- audit search and security overview are permission-gated tiles;
- case list emphasizes reason, evidence state, decision deadline, and assigned owner.

Privacy handling:

- support-safe metadata is visually separate from restricted evidence.
- exceptional access patterns require visible reason and audit state.
- no raw secrets or unrestricted production tools.

### Best Fit

Choose Verified Pathway if the brand should lean into trust, proof, and accountable employability as the core differentiator.

## Direction 3: Workforce Grid

### Design Thesis

Workforce Grid is the densest, most operational direction. It treats PlanThePath as a high-confidence workforce readiness and recruitment command platform. It is best for heavy institutional, employer, and operations usage while keeping the student view focused and readable.

This direction is strongest if the buyer-facing product must feel enterprise-grade from day one.

### Visual Personality

- Enterprise control-room clarity.
- Data-dense, table-forward, low decoration.
- More serious and operational than aspirational.
- Student screen remains supportive, but the system overall feels built for scale and accountability.

### Palette

| Token role | Suggested value | Usage |
|---|---:|---|
| Base | `#F5F7FA` | app background |
| Surface | `#FFFFFF` | workspace surfaces |
| Surface alt | `#EEF2F6` | dense bands and grouped rows |
| Text strong | `#0B1220` | headings and primary data |
| Text muted | `#52606D` | secondary text |
| Border | `#C9D3DF` | tables, panels, separators |
| Brand | `#123C69` | primary navigation and actions |
| Success | `#147D64` | completed/healthy |
| Attention | `#C78500` | due/pending/warning |
| Critical | `#C2410C` | critical operational states |
| Security | `#5B21B6` | restricted/security context |

Portal accents:

| Portal | Accent | Meaning |
|---|---:|---|
| Student | `#147D64` | career progress |
| Institution | `#123C69` | cohort command |
| Employer | `#9333EA` | hiring workflow |
| Operations | `#0B1220` | administrative authority |

### Typography

- Primary font: Roboto, Inter, or Geist Sans.
- Mono font: Roboto Mono or Geist Mono for dense timestamps, IDs, queue metrics, and audit rows.
- Tables use 13-14px with comfortable line height; student content stays 15-16px.

### Shape, Density, and Motion

- Radius: 4px.
- Minimal shadows; rely on row grouping, dividers, sticky headers, and compact controls.
- Dashboards use split panes and persistent filters.
- Motion is nearly invisible and utility-driven.

### Representative Screen Direction

#### Student Dashboard

Primary question: "What is my next required move?"

Layout:

- compact career readiness header with score, target role, and model/version link;
- task queue ranked by deadline and readiness impact;
- roadmap progress as a structured checklist/timeline;
- upcoming assessments, interviews, and application updates;
- opportunities shown as a shortlist with match evidence;
- AI Coach entry appears as a controlled helper, not a full-screen marketing feature.

Privacy handling:

- private and shared data boundaries are explicit.
- score explanations and source labels are always available.
- application submission displays consent and snapshot state.

#### Institution Dashboard

Primary question: "Where should placement and faculty teams act now?"

Layout:

- dense KPI band with active filters and scope label;
- readiness distribution, intervention queue, and placement pipeline visible above the fold;
- cohort grid with sortable readiness band, target career, assessment due, intervention state, placement state;
- faculty verification queue as a compact worklist;
- bulk actions gated behind explicit permission and scope preview.

Privacy handling:

- row-level actions are permission-filtered.
- data from expired relationships is excluded from current views.
- exports are absent unless separately granted.

#### Employer Dashboard

Primary question: "Which pipelines are blocked, aging, or ready for decision?"

Layout:

- pipeline-first dashboard with compact stage counts;
- opportunity table with applicants, stage aging, deadline, term version, and risk/moderation state;
- assigned interviews and scorecards in a right rail;
- top action button: Create opportunity or Review applicants depending on capability;
- analytics is available as drill-down, not decorative dashboard filler.

Privacy handling:

- candidate rows are scoped to assigned/authorized opportunities.
- interviewer view removes unrelated candidate and organization controls.
- employer-visible readiness is policy-permitted and clearly labeled.

#### Operations Dashboard

Primary question: "Which operational controls need action before risk grows?"

Layout:

- high-density queue matrix: verification, moderation, support, billing, security, AI operations, jobs;
- health strip with SLO-relevant signals and DLQ/backlog indicators;
- case table with severity, owner, age, next SLA, action affordance;
- privileged controls grouped by domain and protected by confirmation flows;
- security events and audit denials use compact investigation tables.

Privacy handling:

- support, security, billing, moderation, and AI Ops widgets render only from effective capabilities.
- high-risk actions show reason capture and audit result.
- restricted content is summarized unless a policy-defined exceptional access flow exists.

### Best Fit

Choose Workforce Grid if the first commercial pressure is enterprise credibility, high-density operations, and institution/employer productivity.

## Cross-Direction Dashboard Content Priorities

| Portal | Must lead with | Must not lead with |
|---|---|---|
| Student | next action, readiness, target career, applications/interviews | generic school announcements, decorative badges, private-data confusion |
| Institution | cohort readiness, intervention queue, placement movement, skill gaps | unrestricted student directory, unrelated employer details, private AI chat |
| Employer | active opportunities, applicant pipeline, interviews, deadlines | generic talent search, unconsented student browsing, unexplained scores |
| Operations | queues, platform health, risk, audit-safe actions | raw secrets, SQL/file browsers, private AI chat browsing, unrestricted impersonation |

## Provenance and Privacy Visual Language

Every direction must include a consistent source/provenance system:

| Provenance | Visual treatment | Notes |
|---|---|---|
| Self-declared | neutral outlined chip | student-entered, not verified |
| Institution verified | solid verified chip with verifier/date access pattern | only visible where authorized |
| Platform assessed | assessed chip with model/version link | deterministic/versioned where score-related |
| Employer reported | employer/source chip | tied to application/opportunity scope |
| Externally evidenced | evidence chip with source/date | subject to document access rules |
| Private | lock + explicit privacy text | private AI/chat/doc state, not org-readable by default |
| Restricted | restricted label + safe explanation | do not leak inaccessible resource existence |

## Shared State Requirements

Each representative dashboard must include designs for:

- loading/skeleton;
- first-use empty state;
- no-results state;
- permission denied/access expired;
- stale/conflict state;
- degraded dependency state, especially AI or provider failure;
- validation errors;
- destructive/high-risk confirmation;
- success acknowledgement;
- mobile responsive layout;
- keyboard focus and screen-reader semantics.

## Recommendation

Recommended default direction for V1: **Career Command**.

Reason: it gives the best balance across all four portals. It is professional enough for institutions and employers, approachable enough for students, and disciplined enough for Operations without over-indexing on enterprise density before the first pilot.

Use **Verified Pathway** if the brand strategy centers on provenance and verified employability. Use **Workforce Grid** if institutional and employer dashboards must feel enterprise-grade before student-side warmth matters.

## Next Step Before Frontend Implementation

Before production frontend work starts, select one visual direction and convert it into:

1. design tokens;
2. portal shell rules;
3. dashboard wireframes for `STU-001`, `INS-001`, `EMP-001`, and `OPS-001`;
4. component inventory;
5. responsive behavior specs;
6. accessibility acceptance checks;
7. privacy/RBAC visual-state checklist;
8. implementation tickets tied back to the screen catalog.
