# PlanThePath V1 Selected Visual System — Career Command

**Status:** Selected V1 implementation baseline  
**Selected direction:** Career Command  
**Source:** `docs/ux/VISUAL_SYSTEM_DIRECTIONS_V1.md`  
**Applies to:** Student Portal, Institution Portal, Employer Portal, Platform Operations Portal

## 1. Decision

Career Command is selected as the V1 visual direction.

Rationale:

- balances student motivation with institutional and employer credibility;
- supports high-density operational screens without making the student experience feel administrative;
- maps cleanly to the approved four-portal architecture;
- supports strong provenance, permission, consent, and trust/safety presentation without making governance the dominant visual theme;
- is implementation-friendly for a shared component system and responsive web delivery;
- avoids childish LMS/gamified styling while remaining approachable.

`Verified Pathway` remains a useful reference for provenance/evidence patterns. `Workforce Grid` remains a useful reference for dense Ops/Institution table patterns. They are not alternate production themes for V1.

## 2. Core visual tokens

### 2.1 Foundation

| Token | Value | Use |
|---|---|---|
| `surface.app` | `#F7F9FC` | application background |
| `surface.primary` | `#FFFFFF` | cards, tables, primary panels |
| `text.strong` | `#101828` | headings, high-priority metrics |
| `text.muted` | `#667085` | secondary copy |
| `border.default` | `#D0D5DD` | separators, inputs, tables |
| `brand.primary` | `#164C8F` | primary actions and shared brand |
| `status.info` | `#1570EF` | informational states |
| `status.warning` | `#DC6803` | deadlines, pending verification |
| `status.danger` | `#D92D20` | destructive/error states |

### 2.2 Portal accents

| Portal | Accent |
|---|---|
| Student | `#0E9384` |
| Institution | `#164C8F` |
| Employer | `#6941C6` |
| Operations | `#344054` |

Portal accents support orientation. They must not independently communicate authorization, verification, risk, or status.

### 2.3 Typography

- Primary: Inter or Geist Sans; final package selection may be made during frontend bootstrap.
- Mono: Geist Mono or equivalent only for IDs, timestamps, technical/audit references.
- Body: 14–16px depending on portal density.
- Primary dashboard KPI: 28–36px maximum.
- No oversized marketing typography inside authenticated workspaces.

### 2.4 Shape and elevation

- Primary radius: 6–8px.
- Inputs/buttons/cards share consistent radius family.
- Shadows are reserved for overlays, menus, drawers, dialogs and temporary elevated surfaces.
- Main data grouping uses borders, spacing, background contrast, and headings before shadows.

## 3. Shared application shell

Desktop:

1. top bar — portal context, authorized search, notifications, help, account, organization switcher where applicable;
2. collapsible left navigation generated from effective capabilities;
3. workspace header — title, context/scope, primary action, safe secondary actions;
4. main content;
5. optional right rail only when it adds next-action, context, audit, or permitted AI value.

Mobile:

1. compact top bar;
2. bottom navigation for 4–5 high-frequency destinations;
3. `More` for secondary modules;
4. stacked content priority instead of compressed desktop tables;
5. drawers/sheets for filters and secondary actions.

## 4. Density by portal

### Student

- medium/comfortable density;
- mobile-first interaction priorities;
- cards and short lists preferred over large tables;
- strongest visual emphasis on next action, readiness explanation, roadmap, applications and interviews.

### Institution

- medium-high density;
- desktop-first dashboards with responsive fallback;
- filter bars, cohort tables, queues, charts + accessible table alternatives;
- student drill-down preserves active relationship and staff scope cues.

### Employer

- medium-high density;
- opportunity-centric workflow;
- pipelines, candidate review tables, interviews and deadlines;
- no generic student-directory visual patterns.

### Operations

- high controlled density;
- queue and exception-oriented;
- audit/security metadata prioritized over decorative metrics;
- privileged context and environment must always be obvious.

## 5. Shared component primitives

The V1 design system shall define reusable implementations for:

- application shell / portal shell;
- top bar and capability-driven side navigation;
- mobile bottom navigation;
- page header and context/scope banner;
- buttons: primary, secondary, tertiary, destructive, icon;
- text input, textarea, select, multi-select, combobox, date/time, search;
- filter bar and saved-filter pattern where authorized;
- card, metric card, section panel;
- table, sortable table, selectable table, pagination;
- list row, queue row;
- tabs, breadcrumb, stepper, timeline;
- drawer, modal/dialog, popover, tooltip;
- toast/notification;
- score summary and score-breakdown components;
- provenance badge/chip;
- verification status;
- employer trust/verification state;
- relationship/scope notice;
- permission-denied state;
- consent/snapshot disclosure;
- material-term change warning;
- chart container with accessible tabular alternative;
- skeleton, empty, no-results, degraded, recoverable-error, terminal-error, stale/conflict states;
- privileged confirmation with consequence text and optional required reason;
- private-AI indicator for Student Portal only.

## 6. Provenance visual contract

The following source states must be visually and textually distinguishable:

- `SELF_DECLARED` — label: Self-declared
- `INSTITUTION_VERIFIED` — label: Institution verified
- `PLATFORM_ASSESSED` — label: PlanThePath assessed
- `EMPLOYER_REPORTED` — label: Employer reported
- `EXTERNALLY_EVIDENCED` — label: Evidence provided

Color may support these distinctions but must never be the only differentiator.

## 7. Portal dashboard composition

### 7.1 Student Dashboard (`STU-001`)

Required priority:

1. target career + readiness + next deadline;
2. dominant `Next best action` panel;
3. readiness component breakdown with scoring-model/version access;
4. applications/interviews timeline;
5. recommended opportunities with match reasons and source/verification;
6. roadmap progress;
7. private AI Career Coach entry point.

The screen must answer: **What should I do next to become more employable?**

### 7.2 Institution Executive Dashboard (`INS-001`)

Required priority:

1. institution/scope header;
2. active students / placement eligible / intervention needed / interviews / offers / placed;
3. readiness distribution + accessible table;
4. skill gaps;
5. students requiring attention;
6. upcoming drives/interviews;
7. permitted drill-down/actions.

The screen must answer: **Which students need intervention, and what placement activity is moving?**

### 7.3 Employer Dashboard (`EMP-001`)

Required priority:

1. employer verification/trust context;
2. active opportunities / new applicants / shortlisted / interviews / offers / hires;
3. pipeline aging;
4. action queue;
5. active opportunities with posting version/deadline/material-term state;
6. create-opportunity action when authorized.

The screen must answer: **Which hiring actions need attention today?**

### 7.4 Operations Dashboard (`OPS-001`)

Required priority:

1. role + MFA/session strength + environment context;
2. operational queues;
3. API / queues / notifications / AI cost-latency / security health;
4. assigned cases and SLA state;
5. audit/security highlights;
6. capability-gated AI Ops and security actions.

The screen must answer: **What platform risks, queues, and health signals need controlled action?**

## 8. Permission-aware UI contract

Frontend visibility is derived from effective capabilities and context, but backend authorization remains authoritative.

Rules:

1. Do not render actions the user lacks capability to execute.
2. Do not assume hidden navigation is a security control.
3. Handle `403` safely when capability changes after page load.
4. Institution student access must consider active relationship time and assigned scope.
5. Employer applicant access must be opportunity-scoped and consent-gated.
6. Private student AI conversations have no Institution or Employer UI entry point.
7. Ops/support roles do not receive raw private-chat browsing as a generic support feature.
8. High-risk privileged actions require consequence copy, confirmation and reason capture where policy requires it.

## 9. Accessibility baseline

- Target WCAG 2.2 AA.
- Keyboard operation for all core tasks.
- Visible focus states.
- Status cannot rely on color alone.
- Charts require table/text equivalents.
- Minimum usable touch targets on mobile.
- Reduced-motion preference respected.
- Form errors associate with fields and provide actionable text.
- Dense tables require semantic headings and keyboard-safe controls.

## 10. Responsive rules

- Student experience must be first-class on mobile browser.
- Institution/Employer/Ops are desktop-optimized but cannot become unusable on small screens.
- Large tables become card/list summaries, horizontal controlled data regions, or priority-column views rather than shrinking unreadably.
- Critical primary actions remain reachable without horizontal scrolling.

## 11. Explicit exclusions

Do not implement:

- children's LMS/gamified visuals;
- cartoon mascots;
- decorative achievement badges unrelated to verified progress;
- generic social feed;
- generic student directory for employers;
- private AI-chat access for institutions/employers;
- unversioned employer material-term edits;
- UI-only permission controls;
- raw SQL/secret/file-browser tooling in Ops;
- status semantics conveyed by color alone.

## 12. Implementation gate

Frontend implementation may begin only against this selected visual baseline plus:

- `UX_INFORMATION_ARCHITECTURE.md`
- `SCREEN_CATALOG.md`
- `ROLE_NAVIGATION_MATRIX.md`
- architecture and Phase 0 authorization/security contracts.

When a visual mockup conflicts with authorization/privacy requirements, the authorization/privacy requirement wins and the mockup must be corrected.
