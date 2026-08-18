# Decisions Required

These are product, legal, privacy, security, and business decisions that must be made before implementation. They are intentionally separate from engineering constraints already settled by the current architecture.

## Decision Summary

| ID | Decision | Owner | Needed by | Recommendation | Default if deferred |
| --- | --- | --- | --- | --- | --- |
| D1 | V4 content ownership and license obligations | Legal/Product | Phase A | Treat V4 as reference until each record has approved rights and attribution handling | Block content staging |
| D2 | First content taxonomy and release slice | Product/SME | Phase C | Start with one narrow academic or career pathway slice | Stage no production-facing content |
| D3 | Readiness outcomes, weights, and calibration | Product/Data/SME | Phase E | Rebuild as advisory, versioned, and evidence-backed; reject uncalibrated V4 weights | Hide readiness scores |
| D4 | Personal learner history migration | Product/Privacy | Phase C | Do not migrate personal history initially | Migrate only non-personal reference content |
| D5 | Outbound communication channels | Product/Privacy | Phase F | Email first; defer SMS, WhatsApp, and social messaging | Native email-only notifications |
| D6 | CRM, calendar, and meeting vendors | Business/Security | Phase G/H | Choose specific vendors and fields before any n8n pilot | No CRM/calendar automation |
| D7 | External opportunity/feed sources | Product/Legal | Phase H | Approve sources one by one with terms, freshness, and provenance rules | No external feed ingestion |
| D8 | AI resume and communication scope | Product/Security/Privacy | Phase I | Allow extraction and drafting assistance only with human review | No AI document features |
| D9 | Retention, deletion, and analytics policy | Privacy/Legal/Data | Phase C/F/I | Define per data class before collection or automation | Minimize collection and disable tracking beyond audit |
| D10 | Institution reporting and escalation policy | Product/Privacy | Phase E/J | Define recipient, scope, aggregation, and learner visibility rules | No institution-level readiness reporting |

## D1: V4 Content Ownership And License Obligations

Question: Which V4 materials may PlanThePath reuse, transform, attribute, publish, or commercialize?

Context:

- V4 records include mixed license labels such as MIT, CC BY, CC BY 4.0, and CC BY-SA.
- The `ONE Original` rights posture is unresolved.
- All registry records are marked `READY_FOR_SME_REVIEW`, not production approved.

Options:

- Approve only records with verified permissive rights and clear attribution requirements.
- Re-author all V4-derived content internally and keep V4 as research input only.
- Accept broader reuse with attribution and share-alike obligations where compatible with the product model.

Recommendation:

- Use V4 as reference until legal approves record-level reuse. Require source path, source hash, license label, attribution requirement, and reviewer status for every staged record.

Consequence if delayed:

- Content migration cannot begin beyond local analysis and dry-run package design.

## D2: First Content Taxonomy And Release Slice

Question: Which academic/career area should be staged and reviewed first?

Context:

- V4 covers broad occupational, academic, assessment, and roadmap concepts.
- PlanThePath's current runtime is still identity, organization, access, audit, and event focused.
- A broad import would create review, licensing, QA, and product debt all at once.

Options:

- One academic program pathway.
- One career readiness pathway.
- One assessment blueprint plus a small question bank.

Recommendation:

- Start with a narrow pathway that includes taxonomy, lessons, assessment blueprint, questions, and roadmap outputs so the full lifecycle can be tested without bulk migration.

Consequence if delayed:

- Engineering can build staging infrastructure, but SME review and production content release should wait.

## D3: Readiness Outcomes, Weights, And Calibration

Question: What should readiness mean, who is allowed to see it, and how should weights be calibrated?

Context:

- V4 readiness and scoring concepts are useful but uncalibrated.
- PlanThePath already has deterministic versioned readiness patterns, but the final domain semantics require product ownership.
- Readiness can affect learner trust and institutional decisions.

Options:

- Advisory readiness bands visible to learners and authorized institution staff.
- Detailed numeric scores visible only to internal reviewers.
- No score, only next recommended actions.

Recommendation:

- Begin with advisory bands and transparent explanation. Version every calculation and avoid hidden eligibility, ranking, or selection decisions.

Consequence if delayed:

- Roadmap and learning can proceed, but readiness publication should remain disabled.

## D4: Personal Learner History Migration

Question: Should any personal learner history from V4-like structures be migrated?

Context:

- The reviewed V4 source is a local SQLite-style application model and not trusted production learner data.
- Personal history raises consent, quality, and provenance risks.

Options:

- Do not migrate personal history.
- Migrate only explicitly consented learner records after reconciliation.
- Migrate aggregated or anonymized learning signals only.

Recommendation:

- Do not migrate personal learner history initially. Limit early migration to reference content and newly generated PlanThePath user activity.

Consequence if delayed:

- No blocker for reference content work; personal timeline features will use new native data only.

## D5: Outbound Communication Channels

Question: Which communication channels may PlanThePath use, and under what consent rules?

Context:

- The n8n catalog includes many communication patterns, including email, Slack, SMS, WhatsApp, and social channels.
- Current PlanThePath should minimize sensitive learner data leaving the system.

Options:

- Email only.
- Email plus SMS for high-priority reminders.
- Email, SMS, WhatsApp, and institution chat tools.

Recommendation:

- Start with native email notifications. Defer SMS, WhatsApp, and chat integrations until consent, preference, retention, and vendor terms are approved.

Consequence if delayed:

- Build notification preferences and email templates only.

## D6: CRM, Calendar, And Meeting Vendors

Question: Which external systems are approved for CRM synchronization, interview scheduling, reminders, and meeting links?

Context:

- n8n has many reusable CRM/calendar workflow patterns, but reuse depends on the actual vendors.
- Data fields, credentials, retention, and error handling differ by vendor.

Options:

- Google Calendar and Gmail.
- Outlook Calendar and Outlook Email.
- A named CRM such as HubSpot, Salesforce, Airtable, or another approved system.
- No external systems in the first release.

Recommendation:

- Choose one calendar/email path and one CRM target only after security review. Pilot with the minimum field set and native state retained as source of truth.

Consequence if delayed:

- n8n CRM/calendar workflows remain design references, not deployable pilots.

## D7: External Opportunity And Feed Sources

Question: Which scholarship, internship, job, admissions, or program feeds may be ingested?

Context:

- Opportunity data can be stale, licensed, sponsored, biased, or unsuitable for learner audiences.
- PlanThePath needs provenance and moderation before publication.

Options:

- Curated internal opportunities only.
- Approved institutional partner feeds.
- Public web/API sources with legal review.
- n8n-assisted intake into a moderation queue.

Recommendation:

- Approve sources one by one. Require terms review, source attribution, retrieval timestamp, freshness policy, moderation state, and takedown path.

Consequence if delayed:

- Build native opportunity model and moderation flow, but do not publish external feed data.

## D8: AI Resume And Communication Scope

Question: What AI assistance is acceptable for resumes, interview preparation, and learner communications?

Context:

- V4 includes resume/ATS and interview concepts.
- n8n contains many AI workflow examples.
- AI output can create privacy, fairness, explainability, and reliance risks.

Options:

- Extraction and summarization only.
- Drafting assistance with explicit human review.
- Interview practice feedback.
- Ranking, eligibility, or matching.

Recommendation:

- Allow extraction, summarization, and drafting assistance only after human review. Do not allow AI ranking, eligibility, hidden scoring, or autonomous submissions.

Consequence if delayed:

- Resume and communications features should stay manual or rules-based.

## D9: Retention, Deletion, And Analytics Policy

Question: How long should each data class be retained, and what analytics are permitted?

Context:

- Integration will introduce new event, content, notification, document, and external workflow data.
- Open tracking, engagement analytics, resume parsing, and interview artifacts can become sensitive quickly.

Options:

- Strict minimization with short retention for workflow payloads.
- Longer retention for learner-visible history and audit.
- Aggregated analytics only for institution reporting.

Recommendation:

- Define retention by data classification before implementation. Keep audit records where required, minimize workflow payloads, avoid unnecessary open/click tracking, and make learner-visible data deletion rules explicit.

Consequence if delayed:

- Disable non-essential analytics and collect only operational audit data needed for security and reliability.

## D10: Institution Reporting And Escalation Policy

Question: What can institutions see, and when should the system escalate learner progress or risk signals?

Context:

- PlanThePath has scoped institutional access patterns.
- Readiness, assessment, engagement, and roadmap data can affect learners if shared too broadly.

Options:

- Learner-only visibility by default.
- Institution-level aggregate reporting.
- Authorized staff access to named learner progress.
- Escalation workflows for missed milestones or expiring access grants.

Recommendation:

- Start with least-privilege reporting: learner-visible detail, institution aggregates where safe, and named learner views only under explicit scope and policy. Escalations should be transparent and auditable.

Consequence if delayed:

- Do not launch institution-facing readiness reports or automated escalations.

## Not Open Decisions

The following constraints should not be reopened during implementation without a separate architecture review:

- PlanThePath remains the source of truth for identity, organizations, access, audit, learner state, readiness, content release, and authoritative decisions.
- The target runtime remains the current PlanThePath stack: NestJS, Postgres, Drizzle, Cognito, RBAC/scoped access, audit events, and transactional outbox patterns.
- V4 is not imported as a runtime or schema.
- V4 data is not bulk imported directly into production.
- n8n does not receive direct production database access.
- n8n does not own authorization, readiness, recommendations, ranking, eligibility, or learner-facing truth.
- AI does not make hidden ranking, admissions, employment, eligibility, or final submission decisions.
- Secrets are not committed to the repository and workflow credentials are not inspected from example `.env` files.

## Decision Log Template

Use this template when a decision is made:

| Field | Value |
| --- | --- |
| Decision ID | D# |
| Decision |  |
| Owner |  |
| Date |  |
| Approved option |  |
| Scope |  |
| Data classes affected |  |
| Security/privacy conditions |  |
| Implementation phases unblocked |  |
| Review date |  |
