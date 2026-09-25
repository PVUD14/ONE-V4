# Operations console progress

> Goal reports for the operations plan (docs/ops/OPS_CONSOLE_PLAN.md), newest last, in the plan's Section 0.6 format.

Base branch: **feat/plan-phases-0-to-2** — the most advanced non-main branch; it contains all of
integration plus the plan-phase work. Chosen 2026-09-25 (OPS-00); head c802d3b after PRG-FIX.
Repository: PVUD14/ONE-V4 (private). Goal branches are cut from the base and merged back into it;
main and production are released by Divakar only.

## PRG-00 — Program bootstrap (baseline validation) — 2026-09-25
**Result:** Complete.
**What was done:** `.program/` and `SCOPE/` (where the controller PDF was saved) added to
`.git/info/exclude`; `git status --ignored` confirms both are untracked. PDF path noted in the state file;
a text extract kept at `.program/ONE_PROGRAM_GOAL.txt` so later runs need not re-extract it. Base branch
chosen after `git fetch --all` and a head comparison: feat/plan-phases-0-to-2 @ d6687f2. State file
created with all 88 steps and all gates.
**Working tree:** the main checkout has uncommitted work not made by this program (Android, assistant/help,
contact, public profile, `.deploy/`, android-ci workflow, marketing files). Per A.3 it was left untouched;
all validation ran in a detached worktree of d6687f2 in the session scratchpad (since removed).
**Baseline validation (d6687f2, clean worktree, only DATABASE_URL exported, local dev Postgres in Docker):**
- `corepack pnpm install --frozen-lockfile` — pass
- `corepack pnpm typecheck` — pass
- `corepack pnpm build` — pass (web chunk-size warning only)
- `corepack pnpm test` — **fail**: stops at the first failing package. Rerun on a freshly migrated
  database with `pnpm -r --no-bail --workspace-concurrency=1 test`: **1 110 passed, 1 failed** across
  13 test-bearing packages (web 366, api 353, persistence 161/162, others 230).
- Failing test: `packages/persistence/test/exam-evidence-bridge.integration.test.ts` ›
  "publishes version 2 as the active model and retires version 1" — `expected [] to have a length of 1`.

**Cause (verified on a fresh database, not a stale-data artefact):** readiness model version 1
(`career-readiness-fundamentals`) is not created by any migration; it is written at runtime by the
career-readiness import (`packages/persistence/src/career-readiness.ts:331`). Migration 0030 creates
version 2 with `INSERT … SELECT … FROM readiness_model_versions WHERE version = 1`, so on any database
migrated before its first import — a fresh environment, CI, a new server — 0030 inserts nothing. A later
import then creates v1 as the active model and v2 never appears, so exam outcomes never become a
readiness input there. Separately, integration suites run `TRUNCATE users CASCADE`, which cascades via
`published_by_user_id` and wipes model versions on a reused dev database. Production is likely unaffected
if its import ran before 0030 — not verified (no production access, by rule).
**Classification:** not small and obvious — the fix decides how readiness model versions are published
(ADR-020 territory: a new migration and/or a change to the import path). A.4 hard stop for building
goals; recorded as a decision for Divakar.

## PRG-FIX — Readiness model v2 on a first import — 2026-09-25
**Result:** Complete — base green again.
**Decision:** adopted the run-1 recommendation without a recorded approval, per AGENTS.md ("ask once,
recommend, carry on") and B.6; logged as a default decision Divakar can override. On inspection the
migrator replays every file on every run (no tracking table), so a migration 0072 was unnecessary — an
environment self-heals at its next migrate; the remaining gap was the window between first import and
next migrate. Fix: the import publishes v2 in its own transaction with 0030's idempotent statements.
**Branch:** fix/prg-readiness-model-v2 → feat/plan-phases-0-to-2, commit c802d3b, fast-forward merged,
both pushed to onev4. No PR (`gh` not installed).
**Files modified:** packages/persistence/src/career-readiness.ts;
packages/persistence/test/career-readiness.integration.test.ts (new test);
packages/persistence/test/exam-evidence-bridge.integration.test.ts (precondition set up explicitly;
assertion unchanged).
**Migrations added:** none.
**Validation (fresh local DB, only DATABASE_URL exported):** typecheck pass · test pass — 1 112 passed,
0 failed (web 366, api 353, persistence 163, others 230) · build pass. The new test fails with the
source change reverted (verified), passes with it.
**Merge review (B.4):** no frozen file, navigation, migration, secret; no assertion removed or weakened.

## OPS-00 — Baseline and base-branch record — 2026-09-25
**Result:** Complete — base branch recorded with reasons; every Section 2.4 row confirmed or corrected
with file and route evidence; free migration numbers verified across all refs.
**Branch / PR:** docs/program-baselines (baseline documents only; no application code).
**Files created:** docs/ops/OPS_BASELINE.md, docs/ops/OPS_PROGRESS.md.
**Migrations added:** none.
**Validation:** as PRG-00 above.
**Acceptance criteria:** OPS progress names the base branch and why ✔ (state file + OPS_BASELINE);
every 2.4 row covered with evidence ✔; free migration numbers listed and verified across all branches ✔
(open-PR state not queryable: `gh` not installed; PR head refs checked instead).
**Corrections to the plan's Section 2:** base head is d6687f2 (integration + 25, 3 unpushed); local
`integration` is 84f915e, and 6449be1 is `onev4/integration`; "(main)" means onev4/main; the audit API is
already on integration; Overview caps each list at 200 and drops two widgets when data is missing; feature
flag overrides and caps have no API; Trust and Safety has no evidence route or detail/enforcement UI;
privacy also has POST /holds; Content Management is no longer read-only (LearnerContentStudio, whose role
list names non-existent roles); SECURITY_ADMIN is excluded from organisations, users and content;
migration numbers in AGENTS.md are stale.
**Risks / follow-ups:** the 3 base commits carrying migrations 0035, 0036 and 0071 exist only locally —
not on the onev4 backup. PR #9's external-applications design doc is the only branch work missing from
the base.
**Next goal:** EMP-00 (step 4).

## OPS-01 — Internal capability model — 2026-09-25
**Result:** Complete — the retrofitted operations endpoints now check named capabilities through pure functions in `packages/authorization`. Behaviour for the three platform roles is unchanged, and Settings shows staff and lets an operator grant or revoke capabilities with a reason code.
**Branch / PR:** feat/ops-capabilities → feat/plan-phases-0-to-2 (pushed to onev4; no PR opened — `gh` not installed; merge left to review).
**Files created:** docs/architecture/ADR-032-internal-operator-capabilities.md;
docs/architecture/internal-capabilities-table-design.md; packages/authorization/src/internal-capabilities.ts
(+ .test.ts); packages/persistence/drizzle/0039_internal_capabilities.sql;
packages/persistence/test/internal-capabilities.integration.test.ts; apps/api/src/http/internal-capability-guard.ts;
apps/api/src/http/operations-staff.controller.ts; apps/api/src/http/operations-capabilities.integration.spec.ts;
apps/web/src/rolePortal/staffCapabilities.tsx (+ .test.tsx).
**Files modified:** packages/authorization/src/index.ts (export); packages/events/src/index.ts (2 events);
packages/persistence/src/platform-controls.ts (grant/revoke/list/role change; ROLE_CHANGED reason);
apps/api/src/http/{operations-institution-onboarding, operations-audit, operations-outbox, operations-privacy,
platform-controls, trust-safety}.controller.ts; apps/api/src/app.module.ts; apps/web/src/api/operations.ts;
apps/web/src/rolePortalPages.tsx (the operations `Settings` branch only).
**Migrations added:** 0039_internal_capabilities.sql. It redefines the capability CHECK under 0031's own name,
adds `revoked_reason_code`, and adds a grant trigger and a role-change trigger. It is idempotent: migrated
twice on a fresh database with no errors.
**Design docs / ADRs:** ADR-032; internal-capabilities-table-design.md (vocabulary of 25, baselines, divergences D1–D6).
**Validation (fresh local DB `one_ops01`, only DATABASE_URL exported):** `db:migrate` ×2 pass · typecheck
pass · `pnpm -r --no-bail --workspace-concurrency=1 test` pass — 1 255 passed / 0 failed (api 419 incl. 39 new,
web 383 incl. 11 new, persistence 178 incl. 15 new, authorization 93 incl. 33 new, others 182) · build pass
(web chunk-size warning only). Starting state = INST-01's recorded run on the same head (1 157 passed); the
non-api packages re-ran green before any change. A mutation check confirmed the matrix catches drift: adding
OPS_ORG_MANAGE to SECURITY_ADMIN's baseline failed 10 tests.
**Acceptance criteria:**
- Every pre-existing integration test for operations endpoints passes unchanged ✔ (operations-audit,
  operations-institution-onboarding and api-security specs are untouched and green).
- Each retrofitted endpoint admits a role with the baseline capability and denies an ACTIVE institution admin ✔.
  There are 24 routes, each checked against all three platform roles, an institution admin and no token. The
  expected roles are written out by hand from the old role lists.
- Granting SUPPORT_CASES to a platform membership succeeds and is audited (actor, reason code, correlation ID,
  outbox event) ✔. Granting it to an institution membership is refused by the API, and a direct insert fails at
  the database trigger ✔.
- Self-grant is rejected ✔, by both the API (403 CAPABILITY_SELF_CHANGE_REFUSED) and the trigger.
- Changing a membership's role revokes its internal capabilities ✔. `changeMembershipRole` revokes them with
  reason ROLE_CHANGED in the same transaction, and a raw role update is refused while an internal grant is live.
- §6.6 minimums ✔: 401, 403, 200, 400 on invalid input, pagination bounds, the audit row carries the reason
  code, and the staff response has exactly 8 fields. Web tests cover real data, loading, NA, empty, error with
  correlation ID, forbidden, the confirm dialog requiring a reason, and navigation labels.
**Decisions for Divakar:**
- Baselines follow what the code allows today where it differs from §6.2. Tighten later, each by its own ADR:
  - D1: SECURITY_ADMIN keeps OPS_FLAGS_MANAGE.
  - D2: the super admin holds CATALOGUE_MANAGE, CONTENT_EDIT/REVIEW/PUBLISH and AI_OPS_CONFIGURE as break-glass
    rather than as baseline.
  - D3: users and invitations lookup stays on OPS_ORG_MANAGE, not SUPPORT_ACCOUNT_LOOKUP.
  - D4: each module's reads share its write capability.
  - D5: TRUST_SAFETY_ENFORCE and PRIVACY_HOLDS are baseline for OPS and SEC.
  - D6: no dual control yet.
- Capabilities that have no endpoint yet take their baseline from §6.2.
- Until OPS-02, only an ACTIVE PLATFORM_SUPER_ADMIN may grant a high-risk capability. Revoking needs only
  CAPABILITY_ADMIN.
- Nobody may change capabilities on their own membership, in either direction.
- The staff screen never grants CONTENT_REVIEW_EXTERNAL; OPS-10 builds that path.
- Reason codes: grant NEW_RESPONSIBILITY / TEMPORARY_COVER / ACCESS_REVIEW_OUTCOME / CORRECTION; revoke
  RESPONSIBILITY_ENDED / ACCESS_REVIEW_OUTCOME / LEAVER / SECURITY_INCIDENT / CORRECTION.
**Limitations / not done:**
- learner-content and career-readiness operations controllers keep their role lists (outside the goal's list).
  learner-content still names non-existent roles.
- `apps/api/src/application/identity-organization/services.ts` (in-memory service, not an HTTP path) keeps its
  role lists.
- There is no HTTP endpoint for a role change, so `changeMembershipRole` is persistence-only.
- `break_glass: true` auditing is ready (`resolveInternalCapability` returns BREAK_GLASS), but no existing
  endpoint reaches break-glass, so nothing writes it yet.
- The role-change trigger covers internal capabilities only; INSTITUTION_ANALYTICS behaviour from 0031 is
  deliberately unchanged.
- Android: no change. The app's only operations calls are the read-only GET organizations and GET
  invitations. Both still admit exactly PLATFORM_SUPER_ADMIN and OPERATIONS_ADMIN, and §4.3 keeps operator
  screens web-only.
**Risks / follow-ups:**
- OPS-02 should route high-risk grants through approvals and tighten D1/D6.
- OPS-05 decides whether account lookup moves to SUPPORT_ACCOUNT_LOOKUP (D3).
- The audit-search cursor uses millisecond precision. Staff paging uses microseconds after the same bug showed
  up in its test, and the audit cursor may deserve the same fix.
**Next goal:** OPS-02.

## OPS-02 — Reason codes and dual control for high-risk actions — 2026-09-25
**Result:** Complete. Every high-risk action that exists today now needs a second person's approval. The approval is bound to the
exact payload, expires after 24 hours, is used once inside the action's own transaction, and only the requester can execute it.
The solo-operator safeguard is in place, and Settings has an Approvals queue.
**Branch / PR:** feat/ops-dual-control → feat/plan-phases-0-to-2. The branch was rebased onto the base after EMP-02. Commits, in
order: design, acceptance tests, implementation, this report. Pushed to onev4. No PR was opened because `gh` is not installed, so
the merge is left to review.
**Files created:**
- docs/architecture/high-risk-approvals-table-design.md
- packages/persistence/drizzle/0038_operation_approvals.sql
- packages/authorization/src/high-risk-actions.ts (+ .test.ts)
- packages/persistence/src/operation-approvals.ts
- apps/api/src/http/operation-approval-gate.ts
- apps/api/src/http/operations-approvals.controller.ts
- apps/api/src/http/operations-approvals.integration.spec.ts
- apps/web/src/rolePortal/approvals.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/{index,internal-capabilities}.ts: a high-risk grant now returns APPROVAL_REQUIRED instead of
  HIGH_RISK_GRANT_REQUIRES_SUPER_ADMIN.
- packages/events/src/index.ts: 3 new events.
- packages/persistence/src/platform-controls.ts: a flag guard hook, `highRiskDirection` in the flag list, and an approval hook on grants.
- apps/api/src/http/{operations-institution-onboarding (verification route only), operations-outbox, operations-privacy,
  operations-staff, platform-controls}.controller.ts.
- apps/api/src/http/api-security.module.ts: registration only.
- apps/web/src/api/operations.ts and apps/web/src/rolePortal/{operations,staffCapabilities,shared}.tsx.
- apps/web/src/rolePortalPages.tsx: the operations `Settings` branch only.
- Tests updated: operations-capabilities.integration.spec.ts, employer-organisation-state.integration.spec.ts,
  internal-capabilities.test.ts, staffCapabilities.test.tsx (see Risks).

**Migrations added:** 0038_operation_approvals.sql. It contains:
- the `operation_approvals` table and its shape CHECKs;
- a guard trigger: the request cannot change, state only moves forward, expiry uses the database clock, the approver and solo
  rules are enforced, rows cannot be deleted, and request timestamps are stamped by the database;
- the functions `operation_approval_is_approver` and `operation_approval_approver_count`;
- the column `feature_flags.high_risk_direction`.

The migration is idempotent: `db:migrate` ran twice on a freshly created `one_ops02` with no errors.
**Design docs / ADRs:** high-risk-approvals-table-design.md records the chosen design and the rejected alternatives for both the
table and the safeguard. No ADR was needed; this builds on ADR-032.
**Validation (only DATABASE_URL exported; after rebasing onto the EMP-02 base e238fd2; freshly recreated `one_ops02`):**
- `db:migrate` run twice: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: pass, **1 376 passed, 0 failed**.
  - web 422 (9 new in approvals.test)
  - api 478 (17 new in operations-approvals.integration.spec)
  - persistence 187
  - authorization 107 (14 new)
  - others 182
- `corepack pnpm build`: pass (web chunk-size warning only).

A run before the rebase had a single timeout on the App.test demo-mode nav walk (22.4 s against a 20 s limit, under load). That test
does not touch this change, and it passed in this run. Starting state: OPS-01's recorded green run on 300c6f2.
**Acceptance criteria:**
- Each high-risk action without a valid approval returns 403 with a clear code ✔. Suspension, a high-risk flag change, backlog
  supersede, hold release and a high-risk grant all return `APPROVAL_REQUIRED`, including for the super admin, and nothing changes.
  Other refusals are `APPROVAL_NOT_APPROVED`, `APPROVAL_EXPIRED`, `APPROVAL_PAYLOAD_MISMATCH` and `APPROVAL_NOT_REQUESTER`.
- The requester cannot approve their own request except through a valid SOLO approval ✔ (`APPROVAL_SELF_DECISION_REFUSED`). The
  trigger refuses it as well.
- Expired and payload-changed approvals are rejected ✔. This covers expiry at decision and at execution, a different reason, a
  different target, a wider limit, and reuse after execution.
- The solo path works only with exactly one approver and after 15 minutes ✔. Under 15 minutes returns `APPROVAL_SOLO_COOLING_OFF`;
  with one approver the approval succeeds and is marked SOLO; once a second approver is granted, self-approval is refused.
- Every request, decision and execution is audited ✔ as `operations.approval.{requested,approved,rejected,executed}`, with requester,
  approver, mode and reason. The action's own audit row carries the approval, and outbox events are written.
- §6.6 minimums ✔: 401/403/200, input 400s, pagination bounds, and no personal data beyond minimised fields (the hold subject never
  appears in the queue). Web tests cover real data, empty, loading, error with reference, forbidden, confirm dialogs that require a
  reason code, and unchanged navigation labels.
- OPS-01's temporary "super admin only" rule for high-risk grants now goes through dual control ✔.

**Decisions for Divakar (recommendations adopted):**
- **Solo safeguard:** a 15-minute cooling-off, a SOLO marker, and automatic switch-off. The approver count comes from live
  memberships, not from a setting.
- **SOLO email notice:** it uses the existing pipeline (notification_commands → the allow-listed `security-notification` workflow,
  ADR-021) only when that workflow is registered active and outside its kill switch. None is today (HG-7), so the notice is recorded
  as **NOT_DELIVERED** on the approval and in audit, and the screen says so. Nothing is queued to fail and nothing claims delivery.
  The QUEUED path is tested with a registered workflow.
- **No break-glass bypass:** the solo path is the only single-person route until the incident register (OPS-16) exists.
- **Approval rules:**
  - One 24-hour window from the request covers both decision and execution.
  - The executor must be the requester.
  - An approver may not approve a capability grant to themselves.
  - A request is refused `APPROVAL_NOT_REQUIRED` when the change is not actually high-risk.
- **High-risk flags** are marked by `high_risk_direction`: ENABLE for AI features, DISABLE for safety controls and kill switches. It is
  set by migration only, with no API. No flag exists yet.
- **Reason codes** are defined in code for each action, with fixed approve and reject decision lists.

**Limitations / not done:**
- These §5.4 rows have no endpoint yet: flag cap raise (no cap API), requirement-set publish (OPS-08) and bulk personal-data exports.
  Each gets a key by a new migration that widens the CHECK.
- Backlog supersede and hold release have no web control because System Health and Security are read-only today. Their requests go
  through the API and are executed from the Approvals queue.
- The Approvals stat "Requests in this view" counts only the loaded page (up to 50). It is labelled that way and is not a server-side
  queue count; that is OPS-03's job.

**Android:** no change. §4.3 keeps operator screens web-only. The app's only operations calls are GET organizations and GET
invitations (Api.kt:181,186), so no gated write is reachable from the phone.
**Risks / follow-ups:**
- Four pre-existing tests had to change because their contract changed on purpose. No assertion was weakened; each is at least as
  strict as before:
  - The OPS-01 matrix row for backlog supersede now expects `APPROVAL_REQUIRED` for admitted roles, instead of "any non-403".
  - The OPS-01 delegated-grant test now proves that nobody, the super admin included, can grant a high-risk capability without
    approval.
  - The EMP-03 suspension helper now runs request → approve → execute, with the listed reason `POLICY_VIOLATION` instead of
    `REPRO_D3`.
  - The unit test for high-risk grants changed in the same way.
- A shared or production database gains high-risk flags only when a migration marks them.

**Next goal:** OPS-03.

## OPS-05 — Support desk (minimal) and account lookup — 2026-09-25
**Result:** Complete. Support is now a case desk, and Users / User Detail is a masked, audited account lookup. A privacy
deletion detaches the person from their support cases and redacts each case's summary and notes.

**Branch / PR:** feat/ops-support-desk → feat/plan-phases-0-to-2. The commits are, in order: design (ed663f0), acceptance
tests (b4cc580), implementation (a7e7b32), and this report. The branch is pushed to onev4. No PR was opened because `gh` is
not installed, so the merge is left to review.

**Files created:**
- docs/architecture/support-cases-table-design.md
- packages/persistence/drizzle/0043_support_cases.sql
- packages/authorization/src/support-desk.ts (+ .test.ts)
- packages/persistence/src/support-cases.ts
- apps/api/src/http/operations-support.controller.ts (+ operations-support.integration.spec.ts)
- apps/web/src/api/support.ts
- apps/web/src/rolePortal/support.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/index.ts: export only.
- packages/events/src/index.ts: 3 events, `support_case.opened`, `.state_changed` and `.assigned`, carrying identifiers and
  enums only.
- packages/privacy/src/index.ts: a new deletion category `SUPPORT_CASES`, disposition ANONYMISED, with a stated basis.
- apps/api/src/http/privacy-deletion.ts: the erase step detaches support cases before the identity is anonymised. The brief
  named packages/persistence/src/privacy-deletion.ts, but the flow lives in the API package and `run-privacy-worker.ts` runs it.
- apps/api/src/http/api-security.module.ts: registration only.
- apps/web/src/api.ts: barrel export only.
- apps/web/src/rolePortal/operations.tsx: the unmasked users table is gone. Invitation tracking stays, as its own panel.
- apps/web/src/rolePortalPages.tsx: only the `Users`, `User Detail` and `Support` branches.
- Tests updated: the privacy unit test and privacy.integration.spec. Adding a category moves the category count from 9 to 10,
  and each test gains one expectation for the new category. No assertion was loosened.

**Migrations added:** 0043_support_cases.sql. It creates:
- the tables `support_cases` and `support_case_events`;
- a guard trigger on cases. It stamps the SLA target and timestamps from the database clock and makes the opening record
  immutable. It allows only the listed transitions, and the only changes it allows to the subject and summary are a
  detachment and a redaction. Nothing can be deleted.
- a guard trigger on history, which is append-only except for redacting a note;
- a widened `privacy_deletion_category_ck`, with the one new value `SUPPORT_CASES`;
- the index `audit_resource_time_idx`, for the account timeline.

The migration was run twice on a freshly created `one_ops05` with no errors.

**Design docs / ADRs:** support-cases-table-design.md covers the chosen design, state machine, SLA table, deletion and
retention, and the rejected options. No ADR was needed; this builds on ADR-032.

**Validation (fresh `one_ops05`, only DATABASE_URL exported):**
- `db:migrate` ×2: pass.
- typecheck: pass.
- `pnpm -r --no-bail --workspace-concurrency=1 test`: **1 424 passed, 0 failed**, broken down as:
  - web: 435, including 13 new
  - api: 496, including 18 new
  - authorization: 124, including 17 new
  - persistence: 187
  - others: 182
- build: pass, with the web chunk-size warning only.

Starting state: OPS-02's recorded green run on the same head, 8a780af, had 1 376 passing. In this session, migrate,
typecheck and the package tests up to persistence were re-run on that head and passed. The base api/web run was stopped after
40 minutes of disk contention from parallel agents, so no result is claimed for it.

**Acceptance criteria:**
- ✔ A case can be logged from a phone call in under a minute, with category, severity and summary. It takes one dialog and
  one request. The dialog defaults to PHONE, MEDIUM and CUSTOMER_CONTACT, so the operator picks a category and types one line.
- ✔ Transitions follow the state machine. An invalid transition returns 400 `SUPPORT_CASE_TRANSITION_NOT_ALLOWED`, and a
  reason that does not fit the transition returns `REASON_CODE_INVALID`. The trigger refuses the same transitions from any
  other writer.
- ✔ Account lookup masks contacts, and the reveal is audited.
  - The email shows as `a***@domain`.
  - The phone slot shows NA, because ONE stores no phone number.
  - A reveal needs a reason code, and `operations.support_account.contact_revealed` is written in the same transaction.
  - Searching and viewing are audited as `…searched` and `…viewed`. The search text is not stored in audit.
  - Reading a case writes `operations.support_case.viewed`.
- ✔ After a privacy deletion the case no longer links to the user.
  - The subject is set to NULL and `subject_detached_at` is set.
  - The summary is replaced, and the notes are redacted.
  - `privacy_deletion_records` gets a SUPPORT_CASES row.
  - Re-linking the case to the user is refused by the trigger.
- ✔ The §6.6 minimums:
  - 401 without a token.
  - 403 for an institution admin on every route, and for SECURITY_ADMIN on the case desk.
  - 400 on invalid input and on unknown fields.
  - Pagination defaults to 50 and allows at most 200. It is keyset paging, and no case repeats across pages.
  - Audit rows carry the reason code, and outbox rows are written.
  - The full email address and the audit context never appear in any response.
  - Web tests cover real data, NA, loading, empty, an error with its reference, forbidden, reason-required dialogs, and
    unchanged navigation labels.
- ✔ No operations screen shows academic content, documents or AI conversations.

**Decisions for Divakar (recommendations adopted):**
- D3 from OPS-01: the new lookup uses SUPPORT_ACCOUNT_LOOKUP. The old `GET /operations/users-access` endpoint is unchanged and
  still needs OPS_ORG_MANAGE, but no screen calls it any more. Retiring it is a later cleanup.
- On deletion, support cases are anonymised, not erased. This is recorded as a new deletion category.
- SLA targets are in calendar hours: URGENT 4, HIGH 24, MEDIUM 72, LOW 120. Severity is fixed when the case is opened.
- Reason codes are defined in code for opening a case, for each target state, and for notes, assignment and reveal.
- A case can only be assigned to someone who holds SUPPORT_CASES through an ACTIVE platform membership.
- Cases store no contact details.
- Account search needs at least 3 characters, a full address, or an id. It cannot list every account.

**Limitations / not done:**
- No attachments, email ingestion or impersonation, as the goal specifies.
- A case does not link to the account view; operators search for the account instead.
- The Overview support tile is left to OPS-03.

**Android:** no change. §4.3 keeps operator screens web-only. The app's only operations calls are GET organizations and GET
invitations (Api.kt:181,186), and both are unchanged.

**Risks / follow-ups:**
- `audit_resource_time_idx` is built without CONCURRENTLY. On a large `audit_events` table that briefly locks it.
- The privacy worker still does not run in a single transaction; that is unchanged. The detach step is idempotent, so a
  retry is safe.

**Next goal:** OPS-06.

## OPS-04 — Background jobs console (System Health) — 2026-09-25
**Result:** Complete. System Health is now the background jobs console. Operators can see outbox health, the worker's state,
consumer activity, automation workflows and commands, and breach alerts. They can inspect and replay a failed event, and ask for a
backlog supersede through the OPS-02 approval flow. They need neither the API nor a database client.
**Branch / PR:** feat/ops-jobs-console → feat/plan-phases-0-to-2. Commits in order: design, acceptance tests, implementation, this
report. Pushed to onev4. No PR was opened because `gh` is not installed.

**Files created:**
- docs/architecture/jobs-health-alerts-table-design.md
- packages/persistence/drizzle/0045_jobs_health_alerts.sql
- packages/persistence/src/jobs-health.ts and packages/persistence/src/run-jobs-alert-check.ts
- packages/authorization/src/jobs-console.ts (+ .test.ts)
- apps/api/src/http/operations-jobs.controller.ts (+ operations-jobs.integration.spec.ts)
- apps/web/src/api/systemHealth.ts
- apps/web/src/rolePortal/systemHealth.tsx (+ .test.tsx)
- packages/persistence/test/jobs-health.integration.test.ts
- deploy/systemd/planthepath-jobs-alerts.{service,timer}

**Files modified:**
- apps/web/src/rolePortalPages.tsx: one new line for the `System Health` label only. Security and AI Operations keep the read-only page.
- apps/web/src/api.ts: a re-export.
- apps/api/src/http/operations-outbox.controller.ts: `requireJobsOperator` is now exported, and replay reasons must come from the list.
- apps/api/src/http/api-security.module.ts: registration only.
- packages/authorization/src/index.ts: an export.
- packages/persistence/src/content-generation.ts: the consumer-name constant is now exported.
- packages/persistence/package.json: the `jobs:alert-check` script.
- .env.example: three optional `JOBS_ALERT_*` variables.
- deploy/systemd/README.md

**Migrations added:** 0045_jobs_health_alerts.sql. It adds the `jobs_health_alerts` table: one row per breach, a partial unique index
allowing at most one open alert per condition, and a guard trigger. The trigger makes the fields immutable, allows only OPEN → CLEARED
stamped by the database clock, and refuses deletes. The migration also adds five partial or covering indexes so the summary reads stay
bounded. It is idempotent: `db:migrate` ran twice on a fresh `one_ops04`, and the persistence test replays it in its own schema.
**Design docs / ADRs:** jobs-health-alerts-table-design.md, which also records the rejected options: an audit row under an invented
system user, a time-bucket dedupe, and state kept in the worker. No ADR was needed.

**Validation (fresh `one_ops04`, only DATABASE_URL exported):**
- `corepack pnpm db:migrate` run twice: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: pass, **1 504 passed, 0 failed**.
  - web 455 (10 new)
  - api 548 (15 new)
  - persistence 199 (12 new)
  - authorization 120 (5 new)
  - others 182
- `corepack pnpm build`: pass (web chunk-size warning only).
- `jobs:alert-check` was run against the local database. It logged one JSON line and exited 0.

**Acceptance criteria:**
- An operator can find, inspect and replay a failed event without the API or a database client ✔.
  - Finding: a keyset list (default 50, max 200) filtered by event type and by age.
  - Inspecting: the event's type, attempts, failure class with a fixed plain explanation, the reference, consumer receipts and the
    automation command.
  - Replaying: a confirm dialog that requires a listed reason code. The replay is audited as `outbox.event.replayed` with the reason.
  - Never shown: the payload, the stored failure message, recipients or lease owners. The API tests assert this.
- Supersede requires an approval ✔. The screen counts what a cutoff would retire, then files `OUTBOX_BACKLOG_SUPERSEDE` through
  `RequestApprovalDialog`. The action is carried out from Settings → Approvals. Without an approval the endpoint still returns 403
  `APPROVAL_REQUIRED`; the full flow is tested.
- A threshold breach produces one alert, not one per event ✔. More failures and repeated runs during one breach leave one row. The
  alert clears when the condition recovers, and a new breach raises a new alert.
- Consumer health ✔: last activity, last success and failed receipts for each known consumer. Content-generation worker activity is
  that consumer's receipts. Missing values show NA.
- Automation workflow registry state and command counts by state ✔.
- Worker liveness, derived from data only ✔: Draining, Stalled, or "No work waiting", which says plainly that liveness cannot be judged
  when nothing is due. Also shown: live claims, claims left by a stopped worker, and the last delivery (NA when none).
- §6.6 minimums ✔:
  - Authorization unit tests: granted, denied, and inactive membership.
  - API: 401, 403 (institution admin, suspended membership), 200 for all three roles, input 400s, pagination bounds, audit row with the
    reason code, and no data beyond the minimised fields.
  - Web: real data, NA, empty, loading, error with reference, forbidden, confirm dialogs that require a reason code, and navigation
    labels unchanged.
  - Regression: every pre-existing test passes unchanged.
- The Career Readiness governance panel that System Health showed before is kept under the console ✔.

**Decisions for Divakar (recommendations adopted):**
- **Alert recipients** are all active platform staff, the same rule as the OPS-02 solo notice. ONE has no "operations mailbox"
  entity, and `notification_commands` needs a `users` row.
- **Alert delivery** goes only through the existing `ops-failure` workflow (no new channel), and only when that workflow is active and
  outside its kill switch **and** an approved `ops-failure` notification template exists. Otherwise the alert is recorded as
  NOT_DELIVERED and the screen says it was not emailed. The evaluator does not create the template itself: `approved_by_user_id` must be
  a real person, and a timer has none. Publishing the template belongs with communication templates (OPS-16) or a seed run by Divakar.
  The QUEUED path is tested.
- **Defaults:** 10 failed events, or 30 minutes for a due event. Consumer silence is off until an interval is configured. All three
  are changed in `app.env` without a release. A value that cannot be used is ignored, and the screen says so.
- **The evaluator** is a five-minute one-shot systemd timer, not an always-on service and not part of the worker. A stopped worker still
  shows up as a stalled queue.
- **Replay reason codes** come from a fixed list: TRANSIENT_FAILURE_RESOLVED, CONFIGURATION_FIXED, RECEIVER_RESTORED,
  INCIDENT_RECOVERY, CUSTOMER_REQUEST. The existing replay endpoint now enforces it (`OUTBOX_REASON_INVALID`). This tightens it; no
  existing test changed.
- **Failed-list ordering:** keyset on (occurred_at, id) per §5.7, with a microsecond-precision cursor.

**Limitations / not done:**
- Nothing here reaches production until Divakar installs the timer units and releases.
- The first alert check on a host with an unsuperseded pre-dispatcher backlog will correctly raise PENDING_EVENTS_STALLED. The README
  says so.
- Consumers are the two known in code (student invitations, seeded content generation). A new consumer must be added to
  `knownJobConsumers` to appear.
- Workflow activation and the kill switch stay outside the screen, as before.
- The old `GET /operations/outbox/failed` endpoint is left unchanged and unused by the web.

**Android:** no change. §4.3 keeps operator screens web-only. The app's only operations calls are GET organizations and GET
invitations (Api.kt:191,196), and nothing in this goal changes them.
**Risks / follow-ups:**
- The 0045 indexes are built without CONCURRENTLY, because the migrator runs each file as one query. They are partial and the pilot
  outbox is small, but on a large production outbox the build would briefly block writes.
- The staff-actions API spec took about 16 minutes on the shared local Postgres under load from parallel agents. It passed, but it is
  slow.

**Next goal:** OPS-05.
