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

## OPS-06 — Privacy and consent console (under Security) — 2026-09-26
**Result:** Complete. Security is now the privacy and consent console. It has the DPDP request queue with each request's state
history (the read is audited), legal holds (place a hold; ask to release one through the OPS-02 approval flow), and consent
coverage for each consent key, with small groups suppressed. The governance status Security showed before is kept beneath it.
**Branch / PR:** feat/ops-privacy-console → feat/plan-phases-0-to-2. Commits in order: acceptance tests (be880a6), implementation
(509beeb), then this report. Pushed to onev4. No PR was opened because `gh` is not installed.
**Files created:**
- packages/authorization/src/privacy-console.ts (+ .test.ts): the hold reasons and `suppressSmallCount` (threshold 5).
- packages/persistence/src/privacy-operations.ts: the queue, detail, holds and coverage reads, and the `*.viewed` audit.
- apps/api/src/http/operations-privacy.integration.spec.ts
- apps/web/src/api/privacyOperations.ts
- apps/web/src/rolePortal/privacyConsole.tsx (+ .test.tsx)

**Files modified:**
- apps/api/src/http/operations-privacy.controller.ts:
  - GET /requests is rebuilt: keyset paging, filters, a SQL summary, and policy.
  - New routes GET /requests/:id and GET /consents.
  - GET /holds now masks the subject, includes the release in flight, and lists the reasons.
  - POST /holds rejects unknown fields, returns 404 for an unknown subject, and refuses an erased subject.
- packages/privacy/src/index.ts (+ test): `STATUTORY_RESPONSE_PERIOD_DAYS` (all null) and `statutoryResponseDueAt`.
- packages/authorization/src/index.ts and apps/web/src/api.ts: exports only.
- apps/web/src/rolePortalPages.tsx: one line, for the operations `Security` label only. AI Operations keeps the read-only page.

**Migrations added:** none. Every table read already exists (0009, 0014, 0028, 0038), so 0048 was not used.
**Design docs / ADRs:** none needed. No new table, and the reasoning is in the module headers.
**Defect fixed on the way:** GET /operations/privacy/requests selected `r.due_at`, a column that exists on no migration, so the
endpoint could only return 500. The OPS-01 matrix did not catch it because it asserts only "not 401/403". The new spec also
asserts "not 500" for every console route.

**Validation (fresh `one_ops06`, only DATABASE_URL exported):**
- `corepack pnpm db:migrate` run twice: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: 1 676 passed, 1 failed.
  - The failure was web `src/auth.test.ts` › "signs out through Cognito logout…". The ConsentGate was still showing "Checking
    privacy consent" when the test looked for the Sign out button: the checking-state timing race the brief notes.
  - Neither that file nor anything it imports is touched by this branch.
  - That file was then run on its own 6 more times and passed every time. The whole web package was rerun and passed: 508/508.
- Per-package counts:
  - api: 637, including 30 new
  - web: 508, including 13 new
  - persistence: 199
  - authorization: 149, including 12 new
  - privacy: 22, including 2 new
  - others: 161
- `corepack pnpm build`: pass.
- Starting state: INST-05's recorded green run on 980d1a7.

**Acceptance criteria:**
- Every privacy request is visible with its state and history ✔.
  - The queue has views Open, Closed, All or any single state, plus a type filter. Paging is keyset: default 50, maximum 200, and
    no request repeats across pages.
  - Detail shows the full `privacy_request_events` history, who acted (the person, ONE or operations; never an id), what a
    deletion did per category, and the holds on the person.
  - Reading a request writes `operations.privacy_request.viewed` with the actor and correlation ID. An unknown id is a 404 and
    writes no audit row.
- Hold release requires an approval ✔.
  - "Request release…" opens `RequestApprovalDialog` for `PRIVACY_HOLD_RELEASE` with a reason code from the fixed list.
  - A release already in flight shows as awaiting approval or approved, with the next step, instead of offering the button again.
  - The endpoint still returns 403 `APPROVAL_REQUIRED` without an approval, and the requester cannot approve their own request.
    The full request → approve → execute flow is tested.
- Consent counts under 5 show <5 ✔.
  - They are suppressed on the server: the value is dropped, zero included.
  - The three cells (consented to the live version, withdrawn, on an older version) split the people who have any record for the
    key. No total is given, so no suppressed cell can be worked out by subtraction.
- Engine purposes (`adaptive-learning`, `ai-tutoring`, `model-improvement`, unpublished under HG-6) show "Not published", never
  0 or 0% ✔. A key whose only versions are retired or not yet effective shows "No version in force" with NA counts.
- Statutory deadline ✔: NA everywhere. No DPDP response period is defined in code, and the privacy notice draft still says
  "[TODO days]". It is computed from the real `requested_at` once a period is set in packages/privacy. The deletion schedule
  shown is the real `deletion_scheduled_for` (the 30-day grace period).
- Breach runbook and incident register ✔: the runbook path is given, and the incident register says plainly that it is not built
  yet (OPS-16).
- Do-nots respected: there is no per-user consent editing or browsing, and consent-gate behaviour is unchanged.
- §6.6 minimums ✔:
  - Authorization unit tests: granted, denied, inactive.
  - API: 401, 403 (institution admin, suspended membership), 200 for all three roles, input 400s including unknown fields,
    pagination bounds, and the audit row with its reason code.
  - No full email and no typed deletion reason appears in any response.
  - Web tests: real data, NA, empty, loading, error with reference, forbidden, sign-in, reason-required dialogs, and navigation
    labels unchanged.

**Decisions for Divakar (recommendations adopted):**
- **Suppression includes 0:** 0 is shown as <5, following the literal §5.5 and acceptance text ("under 5 show <5").
- **Coverage population:** people are placed by their latest record for the key. Erased (anonymised) people are excluded.
  Counts are given only for a LIVE definition (`retired_at IS NULL AND effective_from <= now()`).
- **No coverage percentage:** a percentage needs a denominator (who is expected to consent), and nothing in code defines one.
- **Placing a hold** is done from a request's detail (the person is known there). Holding someone who has no request needs the
  account lookup to link to it (see Limitations).
- **Open question, not decided:** the DPDP statutory response periods for access and erasure requests. They need a legal answer
  (HG-6 territory). Until then the console shows NA.

**Limitations / not done:**
- No operator actions on the requests themselves (reject, retry a failed export); the goal did not ask for them.
- A hold can be placed only from a request's detail. There is no hold action on Users / User Detail.
- The queue sorts on `requested_at` with no global index. That is fine at pilot size; add an index if the table grows.
- The coverage query scans `user_consents` for live keys once per page load.

**Android:** no change. §4.3 keeps operator screens web-only. The app's only operations calls are GET organizations and GET
invitations (Api.kt:200,205). It has no Security or privacy-operations screen, and nothing in this goal changes those calls.
**Risks / follow-ups:**
- The GET /requests and GET /holds response shapes changed; no other caller existed. The old holds list's full `subject_email` is
  replaced by a masked subject; `detail` is kept.
- The `auth.test.ts` timing flake should be hardened separately.

## OPS-03 — Real Overview with server-side queue counts — 2026-09-26
**Result:** Complete. The operations Overview now renders from one bounded server-side summary covering every operator queue. It fetches no full lists, and a section the caller cannot access shows NA in its slot. No widget is dropped.

**Branch / PR:** feat/ops-overview → feat/plan-phases-0-to-2. Commits in order: acceptance tests (9d8ae5c), implementation (4300e6e), this report. The branch is pushed to onev4. No PR was opened because `gh` is not installed.

**Files created:**
- packages/authorization/src/operations-overview.ts (+ .test.ts): the gate, the section → capability table and `suppressPeopleCount`.
- packages/persistence/src/operations-overview.ts: `readOperationsOverview`. Each section is one statement of capped counts, and only the sections the caller may see are queried.
- apps/api/src/http/operations-overview.controller.ts (+ operations-overview.integration.spec.ts): `GET /api/v1/operations/overview`.
- apps/web/src/api/operationsOverview.ts: the client.
- apps/web/src/operationsOverview.test.tsx

**Files modified:**
- apps/web/src/dashboardsV2.tsx: `OperationsDashboardV2` only. Nothing was needed in rolePortalPages.tsx because the Overview branch already renders this component.
- apps/web/src/api.ts: a re-export.
- apps/api/src/http/api-security.module.ts: registration only.
- packages/authorization/src/index.ts: an export.
- apps/android/…/Api.kt and StaffDashboards.kt (see Android).

**Migrations added:** none. Every table read already exists on the base.
**Design docs / ADRs:** none needed. No new table; this builds on ADR-032.

**Validation (fresh `one_ops03`, only DATABASE_URL exported):**
- `db:migrate` run twice: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: pass, **1 671 passed, 0 failed**.
  - api 618 (9 new)
  - web 503 (8 new)
  - persistence 221
  - authorization 147 (10 new)
  - others 182
- `corepack pnpm build`: pass (web chunk-size warning only).
- Android: `./gradlew --no-daemon -q :app:compileDebugKotlin` passes.

**What the summary counts, and who sees it.** Each section needs the capability its own screen checks. Without it the section is `null`, is not queried, and renders NA.

| Section | Capability | Counts | Tile links to |
|---|---|---|---|
| organizations | OPS_ORG_MANAGE | total, active, by kind × verification state, 5 most recent | Organizations |
| verification | OPS_VERIFY | awaiting a decision (PENDING + UNDER_REVIEW), under review | Verification |
| employerAccessRequests | OPS_ORG_MANAGE | pending, oldest pending date | Organizations |
| invitations | OPS_ORG_MANAGE | staff: total / accepted / pending / pending over 72 h / expired unaccepted; student: pending, over 72 h, not delivered, by delivery state; 3 expiring soonest, 4 most recent | Users |
| accounts | ANALYTICS_VIEW | all accounts, student accounts, accounts with organisation roles (suppressed under 5) | Users |
| trustSafety | TRUST_SAFETY_INVESTIGATE | open, unassigned, by severity | Trust and Safety |
| jobs | OPS_JOBS_REPLAY | failed outbox events, open health alerts | System Health |
| privacyRequests | PRIVACY_REQUESTS | open (exports, deletions), deletions scheduled within 7 days, failed | Security |
| privacyHolds | PRIVACY_HOLDS | active holds | Security |
| approvals | APPROVE_HIGH_RISK | pending (unexpired), approved awaiting execution | Settings |
| support | SUPPORT_CASES | open, past SLA, unassigned | Support |

What each role sees:
- The super admin sees every section.
- OPERATIONS_ADMIN sees every section except approvals, because an approver sees the whole approvals queue and anyone else sees only their own requests there.
- SECURITY_ADMIN sees trust, jobs and the two privacy sections.

**Acceptance criteria:**
- One request renders the Overview, and no full-list fetches remain ✔. The web test asserts exactly one fetch, to `/operations/overview`, and none to `/operations/organizations`, `/invitations` or `/users-access`. On Android the two list calls are gone too.
- A count for a module the caller cannot access shows NA ✔.
  - API: the security admin gets `null` for the seven sections outside its baseline. A granted SUPPORT_CASES adds `support`, and revoking it removes it again.
  - Web: every stat, the ring, the queue rows, and the Organizations, Invitations, Accounts and Needs-attention widgets show NA, and every heading stays on the page.
- Tile links open the matching screens ✔. The web test clicks each of the 10 queue tiles and checks the path against the Operations nav config.
- §5.7 bounded SQL ✔. Every count reads at most 10 001 rows (`LIMIT cap+1` subqueries) and reports `capped`, which the screens show as "10,000+". This is tested with cap = 1.
- §5.6 no dropped widget ✔. The previous Overview hid the ring and the Accounts card when data was missing. Both now always render, with NA or 0.
- §6.6 minimums ✔:
  - Authorization unit tests: granted, denied, inactive membership, institution role with stray grants.
  - API: 401; 403 for an institution admin and a suspended operator; 200 for all three roles; 400 on any query parameter, checked only after authorization; bounded counts; no personal data. The last is asserted by searching the response for seeded email and subject markers.
  - Web: real data, NA, loading, error with reference, forbidden, navigation labels unchanged.
  - Regression: every pre-existing test passes unchanged. No existing test was edited.
  - There is no write, so no reason code or audit row is needed.

**Decisions for Divakar (recommendations adopted):**
- **Gate.** The endpoint opens for anyone holding any internal capability except CONTENT_REVIEW_EXTERNAL, which is the faculty reviewer's, not an operator's. Today that means exactly the three ACTIVE platform roles.
- **Suppression per tile (§5.5).**
  - The Accounts counts are counts of people, so they are suppressed below 5, zero included. The value never leaves the server.
  - Every queue count is a count of work items: requests, cases, invitations, events, approvals. These are not suppressed, because the same operator can already open each item on the linked screen, and showing "<5 failed deliveries" would hide work without protecting anyone. OPS-06 made the same call for privacy queue counts.
- **Accounts use ANALYTICS_VIEW.** Platform-wide counts of people are aggregate analytics. This is the same role set as the OPS_ORG_MANAGE list they used to come from.
- **No personal data in the summary.** Recent and expiring invitations are described by role and organisation, not by recipient; recipients stay on the Users screen. The previous Overview printed recipient emails. Because the summary carries no personal data, the read is not audited as a `*.viewed` event.
- **Privacy "due within 7 days"** means deletions whose erasure is scheduled within 7 days, the only deadline ONE records. No statutory response period is defined in code, and OPS-06 also left it NA, so none is invented.
- **Invitation counts** cover live invitations (not past `expires_at`). Expired, never-accepted invitations are counted separately. The acceptance ring is staff invitations accepted out of all staff invitations.

**Limitations / not done:**
- OPS-06 (the privacy console) was not on the base when this finished. The privacy counts are real because they read 0009's tables, but the Security tile opens the existing read-only Security page until OPS-06 merges.
- OPS-06 adds its own `suppressSmallCount` helper, and this goal adds `suppressPeopleCount`. They have different names and do not conflict, but both implement the same rule. After both merge, one should be kept.
- Seeding an overdue support case in the API test is not possible, because the 0043 trigger stamps the SLA from the database clock. The overdue count is asserted as 0, and its SQL matches `summariseSupportCases`.
- With no token the Overview stays on its loading state, which is unchanged from before. The authenticated chooser never renders it without one.

**Android:** changed, for parity. The app's operations overview counted the same two lists, each capped at 200, and turned any failure into 0.
- It now makes one call to `/operations/overview` and computes the four stat cells from the summary: Institutions, Employers, Verified, Invites pending.
- It lists the same ten operator queues read-only. The app stays view-only per §4.3, so there is no action, and each row names the web screen where the queue is worked.
- Recent organisations come from the summary.
- A section the caller cannot access shows NA, and a failed load says so instead of showing zeros.
- `listOperationsOrganizations` and `listOperationsInvitations` and their DTOs are removed; nothing else used them.
- `compileDebugKotlin` passes.

**Risks / follow-ups:**
- `organizations` has no index on `verification_state`. The table is small, and every count is capped regardless.
- If a later module adds a queue, it needs a section, a capability entry in the authorization table, and a tile.

**Next goal:** OPS-07.

## OPS-07 — Staff access readiness (non-AWS parts) — 2026-09-26

**Result:** Complete (non-AWS scope). Once a staff pool is configured, the internal platform roles count only for tokens that pool issued. The configuration is absent by default and changes nothing while it is unset. Preflight and runbook are in place; the AWS steps are left to Divakar.
**Branch / PR:** feat/ops-staff-access → feat/plan-phases-0-to-2 (coordinator merges)
**Files created:** packages/identity/src/staff-pool.ts, packages/identity/test/staff-pool-policy.test.ts, apps/api/src/staff-pool-config.test.ts,
apps/api/src/http/staff-pool-access.integration.spec.ts, deploy/scripts/test-preflight-production.sh, docs/ops/runbook-staff-pool.md
**Files modified:** packages/identity/src/cognito.ts (two-pool aws-jwt-verify when a staff pool is given), packages/identity/src/principal.ts
(membership filter), apps/api/src/config.ts (`COGNITO_STAFF_USER_POOL_ID` / `COGNITO_STAFF_CLIENT_ID`, both or neither), apps/api/src/runtime-auth.ts,
apps/api/src/app.module.ts, apps/api/src/http/api-security.ts and api-security.module.ts (optional `API_STAFF_POOL_POLICY` injected into the
one protected guard), deploy/scripts/preflight-production.sh, deploy/systemd/README.md, .env.example, .github/workflows/phase1-ci.yml (runs the
preflight cases)
**Migrations added:** none
**Design docs / ADRs:** none new. The work implements ADR-025 steps 2 and 5 (the runbook). ADR-025 is unchanged.
**Validation (fresh database `one_ops07`):**
- `corepack pnpm db:migrate` run twice: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: pass, 123 files and 1804 tests. That includes api 37 files / 674 tests, web 41 / 517,
  identity 5 / 41 and persistence 20 / 236.
- `corepack pnpm build`: pass.
- `bash deploy/scripts/test-preflight-production.sh`: all 9 synthetic cases pass.

**Tests added:**
- identity `staff-pool-policy.test.ts`, 16 tests:
  - a student-pool token loses the internal roles and keeps the rest;
  - a staff token in either Cognito issuer format keeps them;
  - the staff issuer with another client is not staff;
  - with no policy nothing changes;
  - platform organisation selection is refused;
  - end to end with RS256 tokens signed by two pools;
  - a student token claiming the staff client is unauthenticated;
  - the runtime aws-jwt-verify multi-pool verifier builds, and refuses duplicate or half pools.
- api `staff-pool-config.test.ts`, 7 tests: absent by default in production; both or neither; no staff pool without a student pool; the student
  pool or client cannot pose as the staff pool; malformed pool id; the policy covers the three internal roles.
- api `staff-pool-access.integration.spec.ts`, 7 tests on real Postgres through the real guard:
  - a student-pool token gets 403 on `/operations/audit-events`, and the error body names no pool or role;
  - the same person with a staff token gets 200;
  - a controller outside the security module (`/operations/staff`) is covered too;
  - organisation selection is refused;
  - other memberships survive;
  - without a staff pool the behaviour is unchanged;
  - an unauthenticated request still gets 401.

**Acceptance criteria:**
- ✔ With the staff pool configured, a student-pool token cannot act as an internal role. This is proven in the identity unit tests and in the API
  integration tests.
- ✔ Preflight fails clearly when staff-pool configuration is missing:
  - it exits 2 under `--require-staff-pool`;
  - a half-configured pool, the student pool reused, the student client reused, or a malformed id always exits 2;
  - it prints names only, and a test fails if any value is echoed.
- ✔ The runbook covers:
  - the pool: MFA REQUIRED, TOTP first with SMS allowed, email and phone required, email-only recovery;
  - app clients and the scoped reset IAM policy;
  - DLT registration and leaving the SNS sandbox;
  - verification without the app, capturing a token for `amr`, and a timed lockout and recovery;
  - a local enforcement check, re-binding with audit rows, enforcement, and rollback.

  It has one explicit stop point (below). A stop point is not an open question.

**Decisions for Divakar (recommendations adopted):**
- **Enforced roles.** Only `PLATFORM_SUPER_ADMIN`, `OPERATIONS_ADMIN` and `SECURITY_ADMIN` are enforced, as the goal text says. ADR-025's wider
  "all non-student roles" follows once those users have staff-pool accounts; widening it earlier locks them out. It is one list, in
  `createRuntimeStaffPoolPolicy`.
- **Filter, not reject.** A student-pool token loses the internal memberships but keeps its other access, so a person who is also a student or
  college staff is not locked out.
- **Preflight default.** A missing staff pool is a named warning by default and a failure only with `--require-staff-pool`. A default failure
  would block every release until the AWS work is done. The runbook says to use the flag from the security go-live release onward.
- **Startup.** The API does not require a staff pool in production (current production has none). It refuses a partial or confused one.

**Limitations / not done:**
- **ADR-025 step 3 (staff sign-in entry) is not built.** Neither web nor Android can start a staff-pool sign-in. The runbook stops before
  re-binding (Part E) and enforcement (Part F) in production until it ships. I recommend it as its own goal, because it touches the sign-in
  screens in both clients.
- **Re-binding is a hand-run SQL step** by Divakar, written in the runbook with an audit row. There is no operator screen for it, and building one
  was not in this goal.
- **`CONTENT_REVIEW_EXTERNAL` (OPS-10)** sits on faculty memberships and is not staff-pool-gated until institution roles join the list.

**Android:** no code change, and nothing needed to compile.
- The app's workspaces come from `/api/v1/security/context` (`classifyWorkspaces`, StaffDashboards.kt), which the server now filters. With
  enforcement on, a student-pool token simply has no OPS workspace.
- By default nothing changes.
- The staff-pool sign-in for Android is part of ADR-025 step 3. The existing dormant hosted-UI flow (OAuth.kt) was written for it and needs the
  staff pool's domain and client as a second choice.
- Operator screens stay web-only (§4.3).

**Risks / follow-ups:**
- A phone that has an OPS workspace saved sees 403s once enforcement is on, until the user signs in again.
- Capture the `amr` claim (runbook C4) before deciding whether to assert it.

**Next goal:** OPS-08.

## OPS-08 — Job-role catalogue administration — 2026-09-26
**Result:** Complete. All 108 catalogue roles load from the transcribed Appendix 4 and are searchable by code, name,
branch and synonym under Content Management. A requirement set goes draft → review by someone other than its author →
publish, and the publish needs CONTENT_PUBLISH plus a second person's approval (new OPS-02 action
`CAREER_REQUIREMENT_SET_PUBLISH`). Students see the full catalogue only behind a flag that is off by default.

**Branch / PR:** feat/ops-role-catalogue → feat/plan-phases-0-to-2. Commits, in order: design and input transcription
(9808e3c), acceptance tests (65fac67), implementation (3acd3c3), and this report. Pushed to onev4. No PR was opened
because `gh` is not installed.

**Input:** docs/ops/inputs/job-role-catalogue.md did not exist, so per program rule B.3 Appendix 4 was transcribed into it
first. It has 108 role rows (S 25, D 9, C 9, E 13, L 7, M 14, P 6, V 11, B 14) and 13 goal rows (G01–G13), plus the usage
notes and the §H branch map. Planned releases: 1 V1, 13 V2, 38 V3, 56 selectable. Every row was reconstructed; none needed
guessing. The counts are checked by code on every test run, and the §H V2 list matches exactly.

**Files created:**
- docs/ops/inputs/job-role-catalogue.md
- docs/architecture/career-catalogue-table-design.md
- packages/persistence/drizzle/0051_career_catalogue.sql
- data/careers/catalogue-v1.json, generated from the input
- packages/authorization/src/career-catalogue.ts (+ .test.ts)
- packages/persistence/src/career-catalogue.ts, career-catalogue-input.ts, generate-career-catalogue.ts and
  seed-career-catalogue.ts
- packages/persistence/test/career-catalogue-input.test.ts and career-catalogue.integration.test.ts
- apps/api/src/http/operations-career-catalogue.controller.ts (+ .integration.spec.ts)
- apps/web/src/api/careerCatalogue.ts
- apps/web/src/rolePortal/careerCatalogue.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/high-risk-actions.ts: the new action key, `legacyHighRiskActionKeys`, and its reasons.
- packages/authorization/src/index.ts: export only.
- packages/events/src/index.ts: the approval key, plus the events `career_requirement_set.state_changed` and
  `career_requirement_set.published`.
- packages/persistence/src/operation-approvals.ts: writes a post-0038 key to the extension columns and reads it back with
  COALESCE.
- packages/persistence/src/career-targets.ts: the student list and selection now depend on the flag.
- packages/persistence/package.json: adds `db:seed:career-catalogue` and `catalogue:generate`.
- apps/api/src/http/operation-approval-gate.ts and operations-approvals.controller.ts: the payload, the target check and the
  queue summary for the new action.
- apps/api/src/http/career-targets.controller.ts: resolves the flag.
- apps/api/src/http/api-security.module.ts: registration only.
- apps/web/src/api.ts and api/operations.ts: types and barrel.
- apps/web/src/rolePortal/approvals.tsx: describes and executes the new action.
- apps/web/src/rolePortalPages.tsx: the operations `Content Management` branch only. It now renders the catalogue above
  LearnerContentStudio and OperationsContentReadOnlyPage, both of which are kept as they were.
- apps/android/…/ApiStudent.kt and StudentCareer.kt.

**Migrations added:** 0051_career_catalogue.sql:
- catalogue columns on `career_roles`; every 0011 constraint is kept;
- `required_evidence_types` on `career_role_requirements`, declared exactly as ENG-04's unmerged 0050 declares it, so the two
  converge;
- `career_role_synonyms`;
- `career_requirement_sets` and `career_requirement_set_items`, with lifecycle, freeze and self-review triggers, and a publish
  that needs an executed approval;
- a release-label guard on `career_roles`;
- extension columns on `operation_approvals`;
- the flag `career-catalogue.selectable-roles`, off by default.

It references only tables from 0001–0038. `db:migrate` ran twice on a freshly created `one_ops08` with no errors.

**Design docs / ADRs:** career-catalogue-table-design.md covers the chosen design and the rejected options. No ADR was
needed.

**Validation (fresh `one_ops08`, only DATABASE_URL exported):**
- `corepack pnpm db:migrate` ×2: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: pass, **1 824 passed, 0 failed**, including:
  - api 673, with 13 new;
  - web 530, with 13 new;
  - persistence 248, with 12 new;
  - authorization 168, with 12 new.
- `corepack pnpm build`: pass.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin`: pass.

The replay hazard was also reproduced by hand in psql. With a sixth key in `action_key`, re-running 0038's DROP/ADD fails
with "check constraint operation_approval_action_ck … is violated by some row".

**Acceptance criteria:**
- ✔ All 108 roles load and are searchable by code, name, branch and synonym. The seed test checks 108 roles, 5 mapped, 103
  created, nothing verified, and that a rerun is idempotent. The API spec checks search by code (C01), starter code, name,
  branch (`maths-strong`, `Geo-informatics`), synonym, and the family, branch and label filters.
- ✔ A requirement-set change cannot go live without review and approval.
  - Publishing without an approval returns 403 `APPROVAL_REQUIRED`.
  - A self-review is refused by the API and by the database.
  - Items are frozen once a set is submitted.
  - The requester cannot approve their own publish.
  - Execution by someone other than the requester, a changed payload (a different label) and an expired approval are each
    rejected.
  - The database refuses PUBLISHED without an executed approval for exactly that set.
  - The release label can change only through a publish.
- ✔ Existing career-target and gap tests pass unchanged, and `computeCareerGap` is untouched. A student's pre-catalogue target
  and gap read identically after the seed and after a publish, with the same target id.
- ✔ §6.6 minimums:
  - 401 without a token.
  - 403 without the capability, for OPERATIONS_ADMIN, SECURITY_ADMIN and an institution admin, and 200 with it.
  - Input 400s, and pagination defaulting to 50 with a maximum of 200 and a keyset cursor.
  - An audit row with the reason code on every write; break-glass is audited for the super admin.
  - Detail shows only a count of live targets, never a student.
  - Web tests cover real data, NA, loading, empty, an error with its reference, forbidden, reason-required dialogs, and
    unchanged navigation labels.

**Decisions for Divakar (recommendations adopted; see the design doc):**
- **Approval-key storage.** OPS-02's plan to "widen the CHECK in a new migration" breaks every later migrate, because 0038
  re-adds its five-key CHECK on each replay. A key added after 0038 now lives in `extended_action_key`/`extended_target_type`,
  with its vocabulary in the replaceable function `operation_approval_extended_target_type()`. Every future approval action
  should follow this pattern. The alternative is Divakar's call: an apply-once migration tracker, or a waiver to edit 0038.
- **Starter mappings:** SOC_ANALYST→C01, SOFTWARE_ENGINEER→S01, DATA_ANALYST→D01, BUSINESS_ANALYST→S21 and
  CUSTOMER_SUCCESS→B11. A mapped row keeps its starter code, title, family and summary; the catalogue name is kept in
  `catalogue_title`.
- **Labels.** Every role seeds as SELECTABLE, because nothing is verified today, C01 included. The V1/V2/V3 "Release" column
  is stored as `planned_release`, which is plan data and not a label.
- **Reviewer and author.** The reviewer is never the author, and there is no solo path for review. A lone operator therefore
  needs a second person to review.
- **Approval scope.** Every publish needs an approval, including one whose content is unchanged.
- **Synonyms.** They get a new table, because `taxonomy_aliases` points at taxonomy nodes. None are seeded, since the catalogue
  lists none.
- **Goals.** G01–G13 are not stored, because no goal model exists on any branch. They are recorded as pending in the input
  file and the JSON.
- **Flag scope.** The flag resolves by user, then by the student's ACTIVE institution, then globally.

**Limitations / not done:**
- No worker recomputes students' gaps after a publish. The `career_requirement_set.published` event is emitted, and gaps are
  recomputed through the existing paths.
- The starter seed (`db:seed:careers`) still writes live requirements directly. It is an engineer-run deployment step.
- There is no student-facing synonym matching ("I want to be a developer"). That is a later goal.
- There is no web student career picker. Only Android has one.

**Android:** changed, because students pick career targets there.
- `CareerRoleDto` gains `releaseLabel` and `catalogueCode`, which are null while the flag is off.
- When the flag is on, the picker shows a "Not yet verified" or "Verified" chip and a search once the list has more than 12
  roles.
- With the flag off, the screen is unchanged.
- `compileDebugKotlin` passes.
- There are no operator screens on Android (§4.3).

**Risks / follow-ups:**
- ENG-04's 0050 and this 0051 both declare `career_role_requirements.required_evidence_types`. They are identical, so either
  merge order converges.
- The approvals queue shows extended actions through the same DTO.
- `privacy-operations.ts` counts `action_key = 'PRIVACY_HOLD_RELEASE'`. That is unaffected, because legacy keys stay in
  `action_key`.

**Next goal:** OPS-09.

## OPS-11 — Role demand dashboard (Analytics) — 2026-09-26
**Result:** Complete. Operations → Analytics is now the role demand dashboard. It ranks every career role by how many
students target it, shows colleges per role and demand by release label, gives a 12-month selection trend, marks each
role against the catalogue's promotion rule, and opens any role to show its colleges and their departments. Every count of
people below 5 is suppressed on the server.

**Branch / PR:** feat/ops-role-demand → feat/plan-phases-0-to-2, rebased onto 7804fcd. Commits, in order:
- design note: 5f6e048;
- acceptance tests: d36a204;
- implementation: 987f4eb;
- the switch to the shared suppression helper: 576199f;
- this report.

Pushed to onev4. No PR was opened because `gh` is not installed.

**Files created:**
- docs/architecture/role-demand-dashboard-design.md
- packages/authorization/src/role-demand.ts (+ .test.ts)
- packages/persistence/src/role-demand.ts
- apps/api/src/http/operations-analytics.controller.ts (+ .integration.spec.ts)
- apps/web/src/api/roleDemand.ts
- apps/web/src/rolePortal/roleDemand.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/index.ts: export only.
- apps/api/src/http/api-security.module.ts: registration only.
- apps/web/src/api.ts: barrel only.
- apps/web/src/rolePortalPages.tsx: only the operations `Analytics` branch. Subscriptions and Billing keep the
  not-yet-available state (ADR-022).

**Migrations added:** none. Everything read already exists: 0000, 0001, 0005, 0011 and 0051.

**Design docs / ADRs:** role-demand-dashboard-design.md records the demand definitions, the suppression rules, the
promotion-rule constants and the rejected options. No ADR was needed.

**API:**
- `GET /api/v1/operations/analytics/role-demand` is one bounded summary. It takes no parameters, and any query parameter
  returns 400.
- `GET /api/v1/operations/analytics/role-demand/roles/:roleId` is the drill-down, bounded at 200 colleges and 50
  departments per college.
- Both need ANALYTICS_VIEW. Both are read-only aggregates with no student names, emails or ids, so, like the Overview,
  they write no audit row.

**What demand counts, from what is actually recorded:**
- A student is counted for a role when they have a live `student_career_targets` row for it and their account is not
  deleted, pending deletion or anonymised. PRIMARY and SECONDARY targets both count, and each student counts once per role.
- A student's college comes from a current `institution_relationships` row (VERIFIED or ACTIVE, in window) or a
  GRADUATED one. Past graduates count at the college they left; anyone else is "No college recorded".
- Branch is the student's department unit at that college, under the college's own name. Names are not matched across
  colleges.
- The trend counts distinct students who selected a target in each UTC month.
- Employer demand shows **NA** in its own slot. Nothing links an opportunity or a paying employer to a career role, and
  no mapping is inferred from job titles or skills.
- The engine goal table does not exist, so goals are not counted.

**Suppression (§5.5)**, through the shared `suppressSmallCount` in aggregate-suppression.ts (INST-SR-01):
- Role totals, trend months and totals are suppressed below 5, zero included.
- The colleges count is withheld whenever the role's student count is suppressed.
- Breakdowns (colleges, departments, release labels) go through `suppressDemandBreakdown`, which adds complementary
  suppression. When the suppressed cells hold 1–4 people between them, the smallest shown cell is also withheld and marked
  `complementary`; the screen says "Withheld", not "<5".
- A suppressed parent has no breakdown behind it.
- Suppressed rows are ordered by code, never by their true size, and have no rank.

`suppressAggregateTable` was not used. It withholds the table total, but here the total is the role count the dashboard
ranks by, and college cells do not partition it, because a student can belong to two colleges.

**Validation (fresh `one_ops11` on base 7804fcd, only DATABASE_URL exported):**
- `corepack pnpm db:migrate` ×2: pass (47 applied, then 0 applied / 47 already applied).
- `corepack pnpm typecheck`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: 2 130 passed and 1 failed.
  - The one failure was the web `App.test.tsx` test "resolves every visible navigation item for every new role", which
    timed out at 20 s under machine load. It exercises demo-mode preview portals, which this change does not touch.
  - Re-run alone, `App.test.tsx` passed 96/96.
  - On the pre-rebase base, the same full suite exited 0.
  - New tests: authorization 16, api 10 (integration, real Postgres), web 11.
- `corepack pnpm build`: pass.

**Acceptance criteria:**
- ✔ **No individual student is identifiable, and suppression is unit-tested.** Unit tests cover:
  - below 5, zero included;
  - complementary withholding, and that only one extra cell is withheld;
  - no complementary cell when the suppressed mass is already 5 or more;
  - label order for suppressed cells;
  - withholding the colleges count.

  Integration tests cover:
  - no raw count below 5 anywhere in the summary;
  - a college withheld so the no-college bucket and a 2-student college cannot be recovered by subtraction;
  - no breakdown for a role with 3 students;
  - no student email, roll number or id in any response;
  - deleted, pending-deletion and cleared targets not counted.
- ✔ **The indicator matches the documented rule** (docs/ops/inputs/job-role-catalogue.md §H):
  - The rule's numbers are code constants: `rolePromotionMinimumStudents` = 200 and `rolePromotionMinimumColleges` = 3.
  - MEETS exactly at 200 students across 3 colleges; NOT_MET at 199, and with 2 colleges.
  - NOT_APPLICABLE for verified or uncatalogued roles.
  - The employer arm is always NOT_RECORDED, and the screen says so.
  - Integration: 200 students across 3 colleges gives MEETS; 200 across 2 gives NOT_MET.
- ✔ **§6.6 minimums:**
  - 401 without a token.
  - 403 for SECURITY_ADMIN without a grant, for an institution admin and for a suspended operator.
  - 200 for OPERATIONS_ADMIN, the super admin, and SECURITY_ADMIN with an ANALYTICS_VIEW grant.
  - 400 for query parameters and for a malformed id; 404 for an unknown role.
  - Pagination is not applicable: this is one bounded summary with caps.
  - No audit row, because this is a read-only aggregate, the same as the Overview.
  - Web tests cover real data, <5 and Withheld, NA for employer demand, empty, error with its reference, forbidden,
    loading, sign-in, and unchanged navigation labels.

**Decisions for Divakar (recommendations adopted):**
- **College for promotion counting.** A college counts toward "3 colleges" when at least one demanding student belongs to
  it, including graduates of that college.
- **Demand counts PRIMARY and SECONDARY targets** as one distinct-student count. Showing them side by side would let one be
  recovered from the other.
- **Branch stays within a college.** Names are not normalised across colleges.
- **Complementary suppression** withholds a cell rather than the total, for the reason above.

**Limitations / not done:**
- There is no per-role trend. It would be 108 × 12 cells, mostly <5, and it would multiply subtraction risk.
- The employer arm of the promotion rule cannot be evaluated until opportunities reference a career role and a paying
  employer's request is recorded.

**Risks / follow-ups:**
- OPS-08's catalogue role detail (Content Management) returns `liveTargetCount` unsuppressed. It is a count of people
  below 5 on an operator screen, and should pass through `suppressSmallCount`. It is outside this goal and is left as found.

**Android:** no change. Operations stay web-only (Appendix 1 §4.3). The Android operations dashboard is the view-only
Overview and has no Analytics screen.

**Next goal:** OPS-12.

## OPS-09a — Skill map editor — 2026-09-26
**Result:** Complete. Skills are drafted, reviewed by someone who did not write them (which includes a real rights review), and published through a release manifest. A publish that changes readiness inputs also needs a second person's approval. ENG-11's pending SOC topics now have a path to go live.

**Branch / PR:** `feat/ops-skill-map-editor`, cut from `onev4/stack/emp-06` (ee4818a) to get ENG-11's 0056. Its target is `feat/plan-phases-0-to-2`, and the coordinator merges it.

**Files created:**
- `docs/architecture/skill-map-editor-design.md`
- `packages/persistence/drizzle/0057_skill_map_editor.sql`
- `packages/career-readiness/src/skill-map.ts` (pure content rules; the graph check uses `assertAcyclicPrerequisites`)
- `packages/authorization/src/skill-map.ts`
- `packages/persistence/src/skill-map.ts`
- `apps/api/src/http/operations-skill-map.controller.ts`
- `apps/web/src/api/skillMap.ts`
- `apps/web/src/rolePortal/skillMap.tsx`
- Tests: `packages/career-readiness/test/skill-map.test.ts`, `packages/authorization/src/skill-map.test.ts`, `apps/api/src/http/operations-skill-map.integration.spec.ts` and `apps/web/src/rolePortal/skillMap.test.tsx`

**Files modified:**
- `packages/authorization/src/high-risk-actions.ts` and `index.ts` (new extended key `CONTENT_SKILL_PUBLISH`)
- `packages/career-readiness/src/index.ts`
- `packages/events/src/index.ts` (`skill_map.revision_state_changed` and `skill_map.skill_published`)
- `packages/persistence/src/operation-approvals.ts` (the queue summary names the skill)
- `apps/api/src/http/operation-approval-gate.ts`, `operations-approvals.controller.ts` and `api-security.module.ts`
- `apps/web/src/api.ts` and `api/operations.ts`
- `apps/web/src/rolePortal/approvals.tsx` and `shared.tsx`
- `apps/web/src/rolePortalPages.tsx`: the Content Management branch only. The skill map sits under the catalogue.

**Migrations added:** `0057_skill_map_editor.sql`. There is no new table. It does three things:
- replaces `operation_approval_extended_target_type` to add `CONTENT_SKILL_PUBLISH → content_revision`, keeping 0051's key;
- adds `content_review_author_publish_guard`, so a revision's author never publishes it (TOPIC only);
- adds `taxonomy_node_published_content_guard`, so on update a topic moves only to a published revision of itself and goes live only on published content.

**Design docs / ADRs:** `docs/architecture/skill-map-editor-design.md`. No ADR was needed.

**Validation:** on a fresh database `one_ops09a`:
- `corepack pnpm db:migrate` ran twice: 51 applied, then 0 applied.
- `corepack pnpm typecheck` passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` passed 2186 of 2187 tests: web 630, api 832, persistence 321/322, authorization 254, career-readiness 51, and all other packages passed.
- The one failure was `migration-runner.integration.test.ts`. Its `afterEach` `DROP SCHEMA` hit "out of shared memory" on the shared dev Postgres while other agents were loading it. Rerun alone, it passed 7/7.
- `corepack pnpm build` passed.
- New tests: 12 career-readiness unit, 8 authorization unit, 17 API integration and 14 web.

**Acceptance criteria:**
- ✔ **Draft → review → publish works.** Create a pending skill; save, submit, request changes, resubmit; approve with the rights review; publish through a release manifest (approved by the reviewer, published by the publisher); the node goes live; a later revision republishes and the older revision stays PUBLISHED.
- ✔ **Self-review is rejected.**
  - The author holding CONTENT_REVIEW gets 403 `SKILL_SELF_REVIEW_REFUSED`.
  - Someone who only edited another person's draft is refused too (contributors come from audit rows).
  - The author holding CONTENT_PUBLISH is refused at the approval request and at publish.
  - A direct PUBLISH insert by the author is refused by 0057.
- ✔ **Prerequisite cycles are rejected.** `assertAcyclicPrerequisites` checks on every save and submit and again at publish against the live map. Prerequisites must be live first, so skills publish in prerequisite order. A refused publish leaves its approval usable.
- ✔ **Publishing needs CONTENT_PUBLISH, plus an approval when readiness inputs change** (a first publish, or a skill a live requirement names). The approval binds the revision id, content hash and reason. Tested: required, payload mismatch, requester-cannot-approve, APPROVAL_NOT_REQUIRED, consumption.
- ✔ **Every transition is audited:** `operations.content.skill_created`, `…skill_revision_started`, `…skill_draft_saved`, `…skill_transitioned`, `…skill_rights_reviewed` and `…skill_published`, each with its reason code and break_glass, plus outbox events.
- ✔ **Rights review is not bypassed.** Approving writes a release-eligible source record (with its rights review, SME review and provenance), and the 0004 manifest trigger demands it at publish.
- ✔ **ENG-11 pending topic.** Integration imports the real SOC pack; a person writes the levels and someone else reviews. Publishing `soc-networking-fundamentals` satisfies 0056: the node goes live, AGENT_DRAFTED provenance is kept, and expertCheck, packKey and provenance stay in the body. The C01 draft set now shows 3 live and 12 pending.
- ✔ **§6.6 minimums:** 401; 403 (no capability, institution member); 200 (catalogue manager read-only); input 400s; 404; keyset pagination.
- ✔ **Web states:** real data, NA, loading, empty, error with reference, forbidden, reason-code dialogs, the rights reason on approve, a contributor not offered review, an approval request instead of publish, the direct publish, the approvals-queue execute, and unchanged navigation labels.
- Not applicable to 09a: answer keys (09b) and bulk import (09d).

**Decisions for Divakar (recommendations adopted):**
- **Per-skill approvals.** The 13 C01 skills need 13 approvals, each with a 15-minute solo cooling-off; a batch publish is a follow-up.
- **All four levels are required to submit.**
- **Licences** are AI8HT-Owned, CC-BY-4.0 and CC-BY-SA-4.0.
- **Contributors** are the author plus anyone who saved an edit. None of them reviews or publishes that revision.
- **Prerequisites live in the revision body.** No table was added, because nothing reads them yet.
- **The node's `version` is not bumped.** The content revision number is the skill's version.
- **Console-authored source packages** record the SHA-1 of the reviewed body in `source_commit`.

**Limitations / not done:**
- There is no retire or withdraw.
- An APPROVED revision that is never published blocks new revisions of that skill.
- Levels and prerequisites are not shown to students.
- The web client shows one summarised message instead of the individual validation problem codes.

**Risks / follow-ups:**
- Any later goal adding an approval key must repeat both `CAREER_REQUIREMENT_SET_PUBLISH` and `CONTENT_SKILL_PUBLISH` in its replacement of `operation_approval_extended_target_type`.
- Merges with other approval-key goals will conflict in `operations-approvals.controller.ts`, `operation-approval-gate.ts` and `approvals.tsx`.
- A pilot seed configured with the same author and publisher would now be refused by 0057.

**Android:** no change. The skill map is an operator surface, and operator screens are web-only (Appendix 1 §4.3).

**Next goal:** OPS-09b.

## OPS-09b — Question bank editor — 2026-09-28
**Result:** Complete. Operators draft readiness-check questions with a skill tag, answer key, difficulty band, a misconception per wrong option and a four-step hint ladder. Someone who did not write, edit or submit the question reviews it, and that review records the rights review. Every publish goes through a second person's approval. It writes the learner-facing version and the grading-only answer key, and supersedes the previous version in the readiness-check pool.

**Branch / PR:** `feat/ops-question-bank-editor`, cut from `onev4/feat/plan-phases-0-to-2` (94fd0d8). The coordinator merges it.

**Files created:**
- `docs/architecture/question-bank-editor-design.md`, `docs/architecture/question-hint-ladders-table-design.md`
- `packages/persistence/drizzle/0061_question_bank_editor.sql`
- `packages/career-readiness/src/question-bank.ts` (pure body rules; `publishedQuestionColumns` decides what reaches `question_versions`)
- `packages/authorization/src/question-bank.ts`
- `packages/persistence/src/question-bank.ts`
- `apps/api/src/http/operations-question-bank.controller.ts`
- `apps/web/src/api/questionBank.ts`, `apps/web/src/rolePortal/questionBank.tsx`
- Tests: `packages/career-readiness/test/question-bank.test.ts`, `packages/authorization/src/question-bank.test.ts`, `apps/api/src/http/operations-question-bank.integration.spec.ts`, `apps/web/src/rolePortal/questionBank.test.tsx`

**Files modified:**
- `packages/authorization/src/high-risk-actions.ts` and `index.ts` (extended key `CONTENT_QUESTION_PUBLISH`); `packages/career-readiness/src/index.ts`
- `packages/events/src/index.ts` (`question_bank.revision_state_changed`, `question_bank.question_published`, the approval key)
- `packages/persistence/src/career-readiness.ts`: the readiness-check pool excludes superseded versions (one SQL line).
- `packages/persistence/src/operation-approvals.ts`: the queue names the question key and revision. The skill columns now fill only for TOPIC targets.
- `apps/api/src/http/operation-approval-gate.ts`, `operations-approvals.controller.ts`, `api-security.module.ts`
- `apps/web/src/api.ts`, `api/operations.ts`, `rolePortal/approvals.tsx`, `rolePortal/shared.tsx`
- `apps/web/src/rolePortalPages.tsx`: the Content Management branch only. The question bank sits under the skill map.
- CI parity: `hiringPages.tsx`, `rolePortal/institutionPlacement.tsx`, `privacyConsole.tsx`, `roleDemand.tsx`, `support.tsx`, `systemHealth.tsx` and `approvals.tsx` had ten pre-existing `?.x.method` chains that the foundation-policy grep rejects. Each is now guarded (`?.x?.method`) with no change in behaviour, and the grep prints nothing.

**Migrations added:** `0061_question_bank_editor.sql`. It adds:
- `question_hint_ladders`: one row per QUESTION revision, hints 1–4, provenance as in 0049, `review_state` mirrored from the question revision, a guard trigger, and no deletes.
- `question_versions.superseded_at`, with a guard: it is the only change a published version ever takes, and only once.
- A replacement of `operation_approval_extended_target_type` that repeats `CAREER_REQUIREMENT_SET_PUBLISH` and `CONTENT_SKILL_PUBLISH` and adds `CONTENT_QUESTION_PUBLISH`.
- `content_review_author_publish_guard`, extended from TOPIC to TOPIC and QUESTION.
- An expression index for question key lookups.

No misconception table was created: the editor writes to ENG-07's `question_option_misconceptions`.

**Design docs / ADRs:** the two design documents above. No ADR was needed.

**Validation:** on a fresh database `one_ops09b`:
- `corepack pnpm db:migrate` ran twice: 54 applied, then 0 applied. `0061` was also replayed twice by hand over the migrated database without error.
- `corepack pnpm typecheck` passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` passed 2662 of 2662 tests across all packages (api 892, web 664, persistence 335, authorization 272, and the rest). There were no teardown failures.
- `corepack pnpm build` passed.
- The foundation-policy optional-chain grep over `apps/web/src` (excluding tests) prints nothing.
- New tests: 13 career-readiness unit, 9 authorization unit, 14 API integration and 14 web.
- `corepack pnpm audit --prod --audit-level=high` exits 1 because of the pre-existing multer advisories (see Limitations).

**Acceptance criteria:**
- ✔ **Draft → review → publish works; self-review is rejected.** The author, anyone who saved an edit and anyone who submitted count as contributors, taken from the audit log. They get 403 `QUESTION_SELF_REVIEW_REFUSED` or `QUESTION_SELF_PUBLISH_REFUSED`, at the approval request as well as at publish. 0061 refuses a direct PUBLISH insert by the author.
- ✔ **Answer keys never appear in learner DTOs (toLearnerQuestionDto).**
  - Unit: passing `publishedQuestionColumns` through `toLearnerQuestionDto` leaves no key, explanation, tag, hint or difficulty.
  - Integration: the published `question_versions.options` hold only `{id, text}`. After a pilot question is republished, a student starting the readiness check gets only `id, topicId, prompt, options, publishedRevision`.
  - An operator with only CONTENT_PUBLISH sees the key, explanation and tags withheld. The approvals queue and the audit and outbox rows carry no answer.
- Not applicable to 09b: prerequisite cycles (09a) and bulk import (09d).
- ✔ **Publishing needs CONTENT_PUBLISH plus an approval when it changes readiness inputs.** Today that is every publish, because the check draws from every published question. Tested: APPROVAL_REQUIRED, payload mismatch, execution, and a refused publish that leaves the approval usable.
- ✔ **Every transition is audited:** `operations.content.question_created`, `…question_revision_started`, `…question_draft_saved`, `…question_transitioned`, `…question_rights_reviewed` and `…question_published`, each with its reason code and break_glass. The outbox events are registered.
- ✔ **Rights review is not bypassed:** approval writes a release-eligible source record with its rights review, and 0004 refuses the release manifest (question plus its tags) without it.
- ✔ **Imports and edits land as DRAFT:** every new question and revision starts as DRAFT, and nothing publishes automatically.
- ✔ **§6.6 minimums:** 401; 403 for plain operations, catalogue manager, institution admin and student (a reviewer cannot create); 200; input 400s; 404; keyset pagination; audit rows with reason codes.
- ✔ **Web states:** real data, NA, loading, empty, error with reference, forbidden, reason-code dialogs, the rights reason, a contributor not offered review, publish filing an approval, the withheld-key view, the approvals-queue execute, and unchanged navigation labels.

**Decisions for Divakar (recommendations adopted):**
- **Every question publish needs an approval** while the readiness check draws from every published question.
- **The readiness-check pool is not scoped by topic** (unchanged), so a question published here joins the Career Readiness Fundamentals check. Recommended follow-up: select only the blueprint's declared topics, then relax the approval rule for items outside every live blueprint.
- **Tagging a wrong option is optional.** ENG-10's pack validation enforces its own "at least one".
- **A complete four-hint ladder is required to submit.** The six pilot questions have none, so their next revision needs one.
- **The hint ladder is reviewed with its question** and has no revision of its own. Adding a ladder to a published question needs a new question revision.
- **Tags are written at submission** by the submitter and reused on resubmission. A dropped tag stays in CHANGES_REQUESTED and is never published, because 0049 forbids deleting it.
- **Difficulty bands** are FOUNDATION, INTERMEDIATE and ADVANCED. Licences are as in OPS-09a.
- **Answer keys** go only to CONTENT_EDIT and CONTENT_REVIEW. Readers are CONTENT_EDIT, CONTENT_REVIEW and CONTENT_PUBLISH, not CATALOGUE_MANAGE.

**Limitations / not done:**
- Misconception codes are chosen here, not authored. ENG-07 has no operator path to draft or publish a code, and a question tagged with an unpublished code cannot publish.
- No learner route shows hints yet (ENG-15/ENG-18).
- There is no retire or withdraw. An APPROVED revision that is never published blocks new revisions of that question.
- `corepack pnpm audit --prod --audit-level=high` exits 1 on the base and on this branch. The cause is three pre-existing high advisories in `multer` via `@nestjs/platform-express`; this goal adds no dependency. Fixing it needs a dependency override and a lockfile change shared by every branch, so it is left to the coordinator.

**Risks / follow-ups:**
- Any later approval key must repeat all three extended keys in its replacement of `operation_approval_extended_target_type`. Expect conflicts in `operations-approvals.controller.ts`, `operation-approval-gate.ts`, `approvals.tsx`, `operation-approvals.ts` and `packages/events`.
- The optional-chain fixes touch six files that other goals also edit. Any conflicts there are one line each.

**Android:** no change. The question bank is an operator surface, and operator screens are web-only (Appendix 1 §4.3). Nothing a student sees changes shape: the readiness check returns the same fields.

**Next goal:** OPS-09c.

## OPS-09c — Lesson and variant editor — 2026-09-28
**Result:** Complete. Operators draft lessons and their language, level and style variants. Someone who did not write, edit or submit a revision reviews it, and that review records the rights review. A third person, who neither wrote nor approved it, publishes it, which is the learner-content lifecycle's rule. A lesson's first publish, or a revision that changes its skill or prerequisites, also needs a second person's approval. Publishing writes the `lesson_versions` row students complete. A variant writes none, because it is another rendering of the same lesson.

**Branch / PR:** `feat/ops-lesson-variant-editor`, cut from `onev4/feat/plan-phases-0-to-2` (bc3350d). The coordinator merges it.

**Files created:**
- `docs/architecture/lesson-variant-editor-design.md`
- `packages/persistence/drizzle/0065_lesson_variant_editor.sql`
- `packages/career-readiness/src/lesson-editor.ts` (pure body rules, variant vocabularies, `lessonGraphProblems`, `publishedLessonBody`)
- `packages/authorization/src/lesson-editor.ts`
- `packages/persistence/src/lesson-editor.ts`
- `apps/api/src/http/operations-lessons.controller.ts`
- `apps/web/src/api/lessons.ts`, `apps/web/src/rolePortal/lessons.tsx`
- Tests: `packages/career-readiness/test/lesson-editor.test.ts`, `packages/authorization/src/lesson-editor.test.ts`, `apps/api/src/http/operations-lessons.integration.spec.ts`, `apps/web/src/rolePortal/lessons.test.tsx`

**Files modified:**
- `packages/authorization/src/high-risk-actions.ts` and `index.ts` (extended key `CONTENT_LESSON_PUBLISH`); `packages/career-readiness/src/index.ts`
- `packages/events/src/index.ts`: `lesson_editor.revision_state_changed`, `lesson_editor.lesson_published` and the approval key.
- `packages/persistence/src/career-readiness.ts`: learner reads resolve a lesson by its stable key.
  - The catalogue lists current versions only.
  - Completion is idempotent per lesson.
  - A prerequisite is met by completing any version of it.
  - Progress is reported against the current version.
  - Evidence provenance names the lesson's own manifest.
- `packages/persistence/src/operation-approvals.ts`: the queue names the lesson key, variant and revision.
- `apps/api/src/http/operation-approval-gate.ts`, `operations-approvals.controller.ts`, `api-security.module.ts`
- `apps/web/src/api.ts`, `api/operations.ts`, `rolePortal/approvals.tsx`, `rolePortal/shared.tsx`
- `apps/web/src/rolePortalPages.tsx`: the Content Management branch only. The lesson editor sits under the question bank.

**Migrations added:** `0065_lesson_variant_editor.sql`. It adds no table. It adds:
- `lesson_versions.superseded_at`, with a guard: it is the only change a lesson version ever takes, only once, and versions are never deleted.
- A replacement of `operation_approval_extended_target_type` that repeats `CAREER_REQUIREMENT_SET_PUBLISH`, `CONTENT_SKILL_PUBLISH` and `CONTENT_QUESTION_PUBLISH` and adds `CONTENT_LESSON_PUBLISH`.
- `content_review_author_publish_guard`, extended from TOPIC and QUESTION to LESSON.
- An expression index for lesson key lookups.

**Design docs / ADRs:** `lesson-variant-editor-design.md`. No ADR was needed.

**Validation:** on a fresh database `one_ops09c`:
- `corepack pnpm db:migrate` ran twice: 57 applied, then 0 applied. `0065` was also replayed twice by hand over the migrated database without error.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` passed 2794 of 2794 tests across all packages, with no teardown failures.
- `corepack pnpm build` passed.
- `corepack pnpm audit --prod --audit-level=high` exited 0 (two moderate advisories, none high).
- The foundation-policy greps (optional chains in `apps/web/src`, conflict markers, private keys) print nothing.
- `corepack pnpm typecheck` first failed on the new integration spec: an array destructure typed the pilot-lesson accessors as possibly undefined. The fix is in 1a0d615 and changes no assertion. The re-run then passed.
- New tests: 8 career-readiness unit, 6 authorization unit, 17 API integration and 16 web.

**Acceptance criteria:**
- ✔ **Draft → review → publish works; self-review is rejected.**
  - The author, anyone who saved an edit and anyone who submitted are contributors, taken from the audit log. They get 403 `LESSON_SELF_REVIEW_REFUSED` or `LESSON_SELF_PUBLISH_REFUSED`, at the approval request as well as at publish.
  - The approver gets 403 `LESSON_APPROVER_PUBLISH_REFUSED`.
  - 0065 refuses a direct PUBLISH insert by the author.
  - Every move is checked against both the 0004 lifecycle and the learner-content lifecycle.
- ✔ **Prerequisite cycles are rejected.** `assertAcyclicPrerequisites` runs on stable keys:
  - on every save and submit, over the drafts being built;
  - at publish, over the live lessons, and every prerequisite must be live.
  - Tested among drafts and through the pilot's live chain.
- ✔ **Publishing needs CONTENT_PUBLISH, plus an approval when readiness inputs change.** That means a base lesson's first publish, or a change of skill or prerequisites, because completion writes `LESSON_COMPLETION` evidence. A wording revision and every variant publish directly; requesting an approval for them returns `APPROVAL_NOT_REQUIRED`. Tested: APPROVAL_REQUIRED, payload mismatch, execution, and a refused publish that leaves the approval usable.
- ✔ **Every transition is audited:** `operations.content.lesson_created`, `…lesson_variant_created`, `…lesson_revision_started`, `…lesson_draft_saved`, `…lesson_transitioned`, `…lesson_rights_reviewed` and `…lesson_published`. Each carries its reason code, the variant and break_glass. The outbox events are registered.
- ✔ **Rights review is not bypassed:** approval writes a release-eligible source record with its rights review, and 0004 refuses the release manifest without it.
- ✔ **Imports and edits land as DRAFT:** every new lesson, variant and revision starts as DRAFT, and nothing publishes automatically. `createLessonVariant` takes agent-draft provenance for ENG-16, and the screen marks agent drafts and shows their expert note.
- ✔ **A revision does not disturb learners.** Integration tests cover a republished pilot lesson:
  - version 1 is superseded, and the old row is immutable;
  - the catalogue lists the lesson once, and the next lesson's prerequisite names the new version;
  - a learner who completed version 1 sees version 2 as done;
  - completing version 2 is an idempotent replay with no new evidence;
  - the dependent lesson unlocks.
- Not applicable to 09c: answer keys (09b) and bulk import (09d).
- ✔ **§6.6 minimums:** 401; 403 for plain operations, institution admin, student, a reviewer creating and a catalogue manager creating; 200 for a catalogue manager reading; input 400s; 404; keyset pagination; audit rows with reason codes.
- ✔ **Web states:** real data, NA, loading, empty, error with reference, forbidden, and reason-code dialogs, including the rights reason. A contributor is not offered review and the approver is not offered publish. A first publish files an approval; a variant publishes directly. The variant shows what it renders and whether it is stale. The approvals-queue execute and unchanged navigation labels are tested.

**Decisions for Divakar (recommendations adopted):**
- **Lessons are the 0004 lessons** (`content_revisions` LESSON → `lesson_versions`), not `learner_content_items` rows. The goal and the coordinator pointed at the learner-content lifecycle (0024/0026). But `learner_content_items` has no LESSON type, no versions, and nothing a student completes reads it. So review *follows* that lifecycle (its states, transitions and both separation rules) over the storage students actually use. Recorded in the design, Decision 1.
- **Three people per lesson.** The approver never publishes, following the learner-content lifecycle. Relaxing this is one rule in `refuseLessonPublish`.
- **Variants are their own reviewed entities.** Each carries language, level and style, with an English base. A variant writes no `lesson_versions` row and is completed as its lesson; ENG-16 serves it and falls back to English.
- **Variant vocabularies:** eleven languages (ISO 639-1), three levels (FOUNDATION, STANDARD, ADVANCED) and four styles (EXPLANATION, WORKED_EXAMPLE, STEP_BY_STEP, SUMMARY).
- **Stale variants may publish.** A variant based on an older base revision is shown as stale; ENG-16 decides whether to serve it.
- **Approvals only when completion evidence changes:** a first publish, a new skill or new prerequisites.

**Limitations / not done:**
- Modules are chosen, not authored. Only the pilot module exists, so a new track's lessons need a module first.
- No student language selection. That is ENG-16.
- There is no retire or withdraw. An APPROVED revision that is never published blocks new revisions of that lesson.
- **Recommendation, not built:** misconception codes (ENG-07) still have no console path to review and publish them, as ENG-10 noted, and a question tagged with an unpublished code cannot publish. A small review/publish screen reusing this lifecycle beside the editors would fit naturally.

**Risks / follow-ups:**
- Any later approval key must repeat all four extended keys in its replacement of `operation_approval_extended_target_type`.
- Merges with other approval-key goals will conflict in `operations-approvals.controller.ts`, `operation-approval-gate.ts`, `approvals.tsx`, `operation-approvals.ts` and `packages/events`.
- The learner reads in `career-readiness.ts` now join `lesson_versions` by stable key. Pilot data behaves exactly as before, because it has one version per key.

**Android:** no change.
- The editor is an operator surface, and operator screens are web-only (Appendix 1 §4.3).
- The learner contract keeps its shape: the catalogue and progress DTOs have the same fields, now resolved to current versions. The Android app shows revised lessons and completion correctly with no client change, so it was not rebuilt.

**Next goal:** OPS-09d.

## OPS-09d — Bulk import — 2026-09-28
**Result:** Complete. Operators with Content Edit import a CSV or JSON file of skills, questions, lessons or lesson variants. Preview runs every row through the editors and reports each row's problems, writing no content. Commit writes exactly the previewed file, all rows or none, and every row lands as a DRAFT authored by the importer, who can never review or publish it.

**Branch / PR:** `feat/ops-content-bulk-import`, cut from `onev4/stack/ops09c` (f8809e1: the base plus the assistant-off/mail-sender fix, ENG-14 and OPS-09c). The coordinator merges it.

**Files created:**
- `docs/architecture/content-bulk-import-design.md`
- `packages/career-readiness/src/content-import.ts` (pure file rules: CSV/JSON parsing, unknown-field refusal, caps, row → editor input, prerequisite order within a file, the report and its digest)
- `packages/authorization/src/content-import.ts` (CONTENT_EDIT; reason codes)
- `packages/persistence/src/content-import.ts` (preview and commit through the editors' functions)
- `apps/api/src/http/operations-content-import.controller.ts`
- `apps/web/src/api/contentImport.ts`, `apps/web/src/rolePortal/contentImport.tsx`
- Tests: `packages/career-readiness/test/content-import.test.ts`, `packages/authorization/src/content-import.test.ts`, `apps/api/src/http/operations-content-import.integration.spec.ts`, `apps/web/src/rolePortal/contentImport.test.tsx`

**Files modified:**
- `packages/career-readiness/src/index.ts`, `packages/authorization/src/index.ts` (exports)
- `apps/api/src/http/api-security.module.ts` (controller registered)
- `apps/web/src/api.ts` (client export)
- `apps/web/src/rolePortalPages.tsx`: the Content Management branch only. Bulk import sits under the lesson editor.

**Migrations added:** none. 0066 was reserved and is left unused: every row lands in existing tables and states, and the preview is a rolled-back transaction rather than a stored copy (design, Decisions 2–3).

**Design docs / ADRs:** `content-bulk-import-design.md`. No ADR was needed.

**How it works:**
- `POST /api/v1/operations/content-imports/preview` `{kind, format, filename, content}` parses the file, then runs every row through `createSkill`/`saveSkillDraft`, `createQuestion`/`saveQuestionDraft`, `createLesson`/`saveLessonDraft` or `createLessonVariant`/`saveLessonDraft` inside one transaction, each row in its own savepoint, and rolls the transaction back. It returns per row: number, key, outcome (`CREATE`/`INVALID`) and issue codes, plus file problems and a SHA-256 digest over the file's normalised rows and every row's outcome and issues. Its one write is an `operations.content.import_previewed` audit row.
- `POST …/commit` adds `previewDigest` and `reasonCode`, re-runs the same evaluation and keeps it only when no row is invalid (else 400 `IMPORT_HAS_INVALID_ROWS`) and the digest matches (else 409 `IMPORT_STALE`); a file problem is 400 `IMPORT_FILE_INVALID`. A refused commit writes nothing, not even an audit row. A kept commit writes `operations.content.import_committed` (kind, format, file name, digest, reason, count and keys) beside the editors' own `*_created` and `*_draft_saved` rows, which carry the chosen reason code.
- Skills and lessons are created first and saved in prerequisite order within the file, as the ENG-10/ENG-11 packs do, so a row may name a prerequisite a later row defines and the editor's acyclic check runs on each save.
- Caps: 200 rows and 90,000 characters per file (the API's unchanged 100 KB JSON body limit is the outer bound). Unknown, duplicated or missing CSV columns are file problems; unknown JSON fields are row issues.

**Validation:** on a fresh database `one_ops09d`:
- `corepack pnpm db:migrate` ran twice: 59 applied, then 0 applied (no migration added).
- `corepack pnpm typecheck` passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` passed 2938 of 2939 tests: web 706, api 965/966, persistence 392, authorization 283, career-readiness 92, and every other package in full.
  - The one failure was `employer-eligibility-stages.integration.spec.ts` › "uses a self-reported record where nothing is verified…". It asserts that the stringified application list does not contain `8.37`, and the response also carries timestamps such as `…:58.37…`, so it fails whenever a timestamp happens to contain those digits. It is pre-existing, EMP-06's, and unrelated to this change. Re-run alone, it passed 10/10. It was not edited.
- `corepack pnpm build` passed.
- `corepack pnpm audit --prod --audit-level=high` exited 0 (two moderate advisories, none high).
- The foundation-policy greps (optional chains in `apps/web/src`, conflict markers, private keys) print nothing.
- New tests: 17 career-readiness unit, 5 authorization unit, 14 API integration and 10 web. They all passed, the new API spec inside the full run as well.

**Acceptance criteria:**
- ✔ **An invalid file shows row-level errors and writes nothing.** The integration spec counts twelve tables (content revisions, taxonomy nodes, lesson and question versions, answer keys, hint ladders, misconception tags, review actions, source records, release manifests, audit, outbox) before and after:
  - a preview of a file with a missing field, a taken key, a prerequisite cycle, an unknown prerequisite and a bad key: every row's problem is reported, and only the preview's audit row is written;
  - the commit of that file: 400 `IMPORT_HAS_INVALID_ROWS` with the fresh report, and nothing is written;
  - an unknown CSV column, an unknown JSON field, a stale digest (409), and a second commit of an already-imported file: nothing is written.
- ✔ **Every imported row lands as DRAFT; never auto-publish.** Skills, questions, lessons and variants are created in DRAFT, with nodes inactive and no `lesson_versions` or `question_versions` row. Nothing in the import moves a revision.
- ✔ **The importer can never review or publish what they imported.** An importer holding Content Edit, Review and Publish submits an imported skill, is refused approval (403 `SKILL_SELF_REVIEW_REFUSED`), and after another reviewer approves is refused publish (403 `SKILL_SELF_PUBLISH_REFUSED`). This is the editors' contributor rule plus the 0057/0061/0065 author-publish guard; the import adds no path around it.
- ✔ **Through the editors' functions:** row issues are the editors' own codes (`SKILL_KEY_EXISTS`, `SKILL_PREREQUISITE_CYCLE`, `LESSON_PREREQUISITE_CYCLE`, `QUESTION_TOPIC_UNKNOWN`, `QUESTION_MISCONCEPTION_UNKNOWN`, `LESSON_BASE_NOT_LIVE` …). Provenance, rights fields and audit rows are the editors'.
- ✔ **Prerequisite cycles are rejected** for skills and for lessons within a file.
- ✔ **Answer keys never appear in learner DTOs, audit, outbox or approval payloads.** The report never echoes a row's text. The spec plants a marker in the correct option and explanation and finds it only in `content_revisions.body`: not in the preview or commit responses, any audit context or any outbox payload, and no `question_versions` row is written. An import files no approval.
- ✔ **Rules for all four** hold unchanged: the author never reviews or publishes, publishing still needs CONTENT_PUBLISH and the editors' approvals, and every write is audited with a reason code.
- ✔ **§6.6 minimums:** 401; 403 for Review-only, Publish-only, Catalogue Manage, plain operations and institution admin on every endpoint; 200 policy; input 400s (unknown body field, kind, format, empty and oversized content, file name, missing digest, bad reason code); audit rows with reason codes.
- ✔ **Web states:** fields and caps per kind, NA counts, loading, empty, error with reference, forbidden, row problems in plain words, file problems, no commit offered while anything is wrong, a confirm dialog that requires a reason code and says no approval is needed, the commit sending the previewed digest, a re-preview after a stale refusal, and unchanged navigation labels.
- Not applicable to 09d: the editors' own draft → review → publish flows (09a–c), unchanged.

**Decisions for Divakar (recommendations adopted):**
- **Create-only imports.** A key that exists is a row error. Revisions of existing content stay in the editors, where the reviewer sees the published revision beside the change.
- **200 rows and 90,000 characters per file.** Larger sets are split. Raising the caps means moving the evaluation to an outbox job.
- **No approval for an import.** Every row is a draft; dual control stays at publish, where the editors already require it.
- **Reason codes:** `TRACK_BUILD`, `CONTENT_MIGRATION`, `EXPERT_BATCH`.
- **Misconceptions are named by code** in the file and resolved to the latest non-archived version; the editor then checks it belongs to the question's skill.
- **One kind per file**, chosen on the screen.

**Limitations / not done:**
- No import of revisions, retirements or the misconception codes themselves.
- Agent-draft provenance cannot be set from an upload: an operator's file is the operator's authorship. Agent packs keep their engineer-run path.
- The screen puts the common problems into plain words; rarer editor codes are shown as the code.

**Risks / follow-ups:**
- Each row runs the editors' queries twice (preview and commit). Lesson saves scan every lesson revision for the draft graph, so very large lesson sets would need the outbox job above.
- The screen reads the file in the browser and refuses a file above the cap before upload.
- Flaky EMP-06 assertion (above): matching `'8.37'` against the whole JSON collides with timestamps. It should assert on the eligibility fields instead. This was left for its owner goal, because changing a test's assertion is outside this goal.

**Android:** no change. Bulk import is an operator surface, and operator screens are web-only (Appendix 1 §4.3). Nothing a student sees changes: imported rows are drafts.

**Next goal:** OPS-10.

## OPS-10 — External reviewer access for college faculty — 2026-09-29
**Result:** Complete. A college faculty member or department head holding `CONTENT_REVIEW_EXTERNAL` sees only the ONE drafts an internal reviewer assigned to them, for a fixed period, never an answer key and never a student, and records an audited, advisory decision. Approving (the rights review) and publishing stay with internal `CONTENT_REVIEW` and `CONTENT_PUBLISH` holders.

**Branch / PR:** `feat/ops-external-reviewers`, cut from `onev4/feat/plan-phases-0-to-2` (edd5de8). The coordinator merges it. Commits, in order: design (1118052), acceptance tests (b5d9a68), implementation (62bce8f), this report.

**Files created:**
- `docs/architecture/ADR-037-external-faculty-content-review.md`, `docs/architecture/external-review-assignments-table-design.md`
- `packages/persistence/drizzle/0066_external_review_assignments.sql`
- `packages/authorization/src/external-review.ts` (who grants, who assigns, which membership may act in which college, conflict rules, reasons, derived status)
- `packages/career-readiness/src/external-review.ts` (the whitelist view a faculty reviewer is shown, per content type)
- `packages/persistence/src/external-reviews.ts`
- `apps/api/src/http/operations-external-reviews.controller.ts`, `apps/api/src/http/institution-content-reviews.controller.ts`
- `apps/web/src/api/externalReviews.ts`, `apps/web/src/rolePortal/externalReviews.tsx`
- Tests: `packages/authorization/src/external-review.test.ts`, `packages/career-readiness/test/external-review.test.ts`, `apps/api/src/http/external-reviews.integration.spec.ts`, `apps/web/src/rolePortal/externalReviews.test.tsx`

**Files modified:**
- `packages/authorization/src/index.ts`, `packages/career-readiness/src/index.ts` (exports)
- `packages/events/src/index.ts`: `external_review.assigned`, `external_review.decided`, `external_review.revoked`. Grant and revoke reuse OPS-01's `organization_membership.capability_granted` / `_revoked`.
- `apps/api/src/http/api-security.module.ts` (two controllers registered)
- `apps/web/src/api.ts` (client export)
- `apps/web/src/rolePortalPages.tsx`, three branches only:
  - Operations **Content Management**: the faculty review panel sits below bulk import.
  - Faculty **Learning Resources**: the review queue sits above the read-only notice that label showed before.
  - Department head **Assessments**: the queue is a section below the exam engine, rendered only for a holder of the grant.

**Migrations added:** `0066_external_review_assignments.sql`. It adds:
- the `external_review_assignments` table: revision, content hash, reviewer membership/user/college, assigner, DB-stamped times, a 1–30 day window, reason, `ASSIGNED`/`DECIDED`/`REVOKED`, decision columns, revocation columns, and shape CHECKs;
- a partial unique index (one open assignment per revision and reviewer), plus list indexes;
- `external_review_membership_eligible()`, and a guard trigger. On insert it requires an IN_REVIEW skill, question or lesson revision whose hash matches; an ACTIVE institution faculty or department-head membership of the stated college holding a live grant; a reviewer who is not the author and not the assigner; and a window of 1–30 days. On update the identity columns never change, and a row moves only `ASSIGNED → DECIDED` (refused after expiry, if the revision moved on, or if the grant or membership lapsed) or `ASSIGNED → REVOKED`. Rows are never deleted.

It changes no existing table or migration.

**Design docs / ADRs:** ADR-037 (the next free number on every onev4 branch), and `external-review-assignments-table-design.md`.

**Validation:** on a freshly created database `one_ops10`, with only DATABASE_URL exported:
- `corepack pnpm db:migrate` ran twice: 60 applied, then 0 applied. `0066` was also replayed twice by hand over the migrated database without error.
- `corepack pnpm typecheck` passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` passed 2984 of 2984 tests, with no failures and no teardown errors. That includes api 984, web 717 and persistence 392.
- `corepack pnpm build` passed.
- `corepack pnpm audit --prod --audit-level=high` exited 0 (two moderate advisories, none high).
- The foundation-policy greps (optional chains in `apps/web/src`, conflict markers, private keys) print nothing.
- New tests: 12 authorization unit, 4 career-readiness unit, 18 API integration and 11 web.

**Acceptance criteria:**
- ✔ **A faculty reviewer sees only assigned drafts and cannot reach any student record through this path.**
  - The queue and detail are filtered by the caller's user, their ACTIVE granted memberships in the path's college, and the assignment.
  - Another reviewer's assignment gives 404, whether in the same college or another. Another college's path gives 403. A student's id used as an assignment id gives 404.
  - The spec plants a student and an answer-key marker and finds neither, nor any email, in the faculty responses.
  - The content is a whitelist, and is returned only while the assignment is OPEN. It is withheld once expired, withdrawn, revoked, or closed because the revision left review.
- ✔ **Their decision is recorded and audited; publishing still needs an internal CONTENT_PUBLISH holder.**
  - The decision writes `institution.content_review.decided` (actor, college, revision, decision, reason, comment length only) and outbox `external_review.decided`.
  - The revision stays IN_REVIEW. The faculty member gets 403 on the editor's approve and publish.
  - The spec then completes the journey (J9): an internal reviewer approves with the rights review, a publisher files an approval, a second person approves it, and the publisher publishes.
- ✔ **ADR: a scoped CONTENT_REVIEW_EXTERNAL grantable to FACULTY_LECTURER and DEPARTMENT_HEAD; content access only; no student data; no publishing.** ADR-037 covers this, enforced by 0039's trigger (unchanged) and 0066's.
- ✔ **Review queue in the institution portal under the existing faculty navigation, no new items.** Tested: assigned drafts only; approve, or request changes with a comment. The web test asserts the operations, faculty and department-head labels are unchanged.
- ✔ **Conflict rules.**
  - A contributor (author, editor or submitter, from the audit log as the editors compute it) cannot assign a draft (403 `EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED`) and cannot be assigned it (API 403, and the trigger for the author).
  - Assignments need `CONTENT_REVIEW`. The assigner is never the reviewer.
- ✔ **Integration specs including cross-tenant denial tests; web tests.** The §6.6 minimums are covered:
  - 401, and 403 for plain operations, institution admin, faculty on the operator side, non-grantees and other colleges;
  - 200, and input 400s (unknown fields, reasons, window, empty set, email lookup not exact);
  - 404, and keyset pagination with bounds (0/201/x);
  - audit rows with reason codes, and `break_glass` for a super-admin assignment;
  - the trigger refusals, and no delete.
  - Web: real data, NA, loading, empty, error with reference, forbidden, reason-code dialogs, powers per viewer, the comment required to request changes, and unchanged labels.

**Decisions for Divakar (recommendations adopted):**
- **The faculty decision is advisory.** It does not move the revision, because approval is AI8HT's rights review. Faculty add the subject-matter check, shown beside the draft in Content Management.
- **No answer keys for faculty.** The goal does not extend OPS-09b's rule that keys go only to CONTENT_EDIT and CONTENT_REVIEW, so question review shows the prompt, options, difficulty and skill. Hints are withheld too, since the ladder can walk to the answer. Showing keys inside the review surface only is a separate decision.
- **Scope is per revision**, with several revisions assigned in one all-or-nothing action (an item set). Scoping by track was rejected because tracks are not one entity across skills, questions and lessons.
- **Time limit on the assignment**, not on the grant: 1–30 days, 14 by default. Standing grants fall under the quarterly access review (OPS-15).
- **Granting needs CAPABILITY_ADMIN, from Content Management**, never from the Settings staff screen, and not on oneself. It is not high-risk under §5.4, so there is no dual control. The college is not asked in-product: agree it out of band and record the reason `FACULTY_REVIEWER_AGREED`. The college's control is the membership, and ending it cuts access on the next request.
- **Revoking the grant withdraws open assignments** in the same transaction, with reason `GRANT_REVOKED`.
- **Staff-pool gating:** faculty are not gated. OPS-07 gates the three platform roles only, and this grant opens drafts, never student or operator data.
- **Reason codes:**
  - grant: `FACULTY_REVIEWER_AGREED`, `CORRECTION`
  - revoke: `REVIEW_PROGRAMME_ENDED`, `COLLEGE_REQUEST`, `LEAVER`, `SECURITY_INCIDENT`, `CORRECTION`
  - assign: `SUBJECT_EXPERT_REVIEW`, `CURRICULUM_ALIGNMENT`, `AGENT_DRAFT_CHECK`
  - withdraw: `NO_LONGER_NEEDED`, `REASSIGNED`, `CORRECTION`
  - approve: `REVIEW_PASSED`
  - request changes (comment required): `CONTENT_INACCURATE`, `OUT_OF_SYLLABUS`, `UNCLEAR_WORDING`, `LEVEL_MISMATCH`, `ANSWER_OPTIONS_WEAK`, `OTHER_CONCERN`

**Limitations / not done:**
- The editors' own screens do not show faculty decisions inline. The internal reviewer reads them in the Faculty review panel just below, filtered by draft.
- There is no notification to the faculty member when something is assigned. The mail sender is HG-7, so they see it in their queue.
- One decision per assignment, with no discussion thread. A re-review is a new assignment.
- Faculty opening a draft is not audited as a read. Only the decision is, because the content is ONE's global content, not personal data.

**Risks / follow-ups:**
- Any goal that changes the editors' contributor actions must also update `draftSavedActions`/`transitionedActions` in `persistence/src/external-reviews.ts`.
- `docs/security/reviews/OPERATIONS-CONSOLE-SECURITY-REVIEW.md` §3.8 said "no API can grant it today". That is now superseded by this goal, and the review should record the new controls.

**Android:** no change, and nothing to compile. Faculty content review is a desk task (reading drafts, writing comments), like the operator screens §4.3 keeps web-only. The phone's institution workspace has home, verification and exams, and no Learning Resources screen; adding one would be a new navigation entry. The contract change is additive, as new endpoints only, so nothing the app calls changes.

**Next goal:** OPS-12 (OPS-11 is already complete).

## OPS-15 — Quarterly internal access reviews (Security) — 2026-09-29
**Result:** Complete. A holder of `SECURITY_ACCESS_REVIEW` opens a review that freezes every standing internal access, keeps or revokes each item with a reason code, and closes it once every item is decided. A revocation takes effect in the same transaction and is audited with the campaign reference. Nobody attests their own access, except a solo operator's KEEP, which is marked SOLO. Each review exports as CSV evidence, and an overdue review is shown on the screen.

**Branch / PR:** `feat/ops-access-reviews`, cut from `onev4/feat/plan-phases-0-to-2` (e472cef). The coordinator merges it. Commits, in order: design (41286e0), acceptance tests (10a4e9f), implementation (0535ae0), this report.

**Files created:**
- `docs/architecture/access-review-campaigns-table-design.md`, `docs/ops/sop-access-reviews.md`
- `packages/persistence/drizzle/0079_access_review_campaigns.sql`
- `packages/authorization/src/access-reviews.ts` (+ `.test.ts`): reviewer, decision and solo rules, the last-super-admin guard, the schedule and overdue rule, and reason codes.
- `packages/persistence/src/access-reviews.ts`: the snapshot, decisions with revocation, close, export audit, and reads.
- `apps/api/src/http/operations-access-reviews.controller.ts`, `apps/api/src/http/access-review-csv.ts`, `apps/api/src/http/access-reviews.integration.spec.ts`
- `apps/web/src/api/accessReviews.ts`, `apps/web/src/rolePortal/accessReviews.tsx` (+ `.test.tsx`)

**Files modified:**
- `packages/persistence/src/platform-controls.ts`: `revokeInternalCapabilityWithin` factored out of `revokeInternalCapability`. The audit context can now carry `accessReview`. Behaviour is unchanged.
- `packages/persistence/src/external-reviews.ts`: `revokeExternalReviewerWithin` factored out of `revokeExternalReviewer`, in the same way.
- `packages/events/src/index.ts`: `access_review.opened`, `access_review.item_decided`, `access_review.closed`.
- `packages/authorization/src/index.ts` (export) and `apps/api/src/app.module.ts` (controller registration; PG_POOL, like the staff controller).
- `apps/web/src/api.ts` (export), `apps/web/src/rolePortal/shared.tsx` (safe messages for the new error codes).
- `apps/web/src/rolePortalPages.tsx`: only the operations **Security** branch. It renders the privacy console and then Access reviews.
- `docs/ops/sop-staff-capabilities.md` (G2 now points to the SOP) and `docs/uat/ONE_OPERATIONS_UAT_V1.md` (J11 now built).

**Migrations added:** `0079_access_review_campaigns.sql`. It references only tables up to 0066.
- Two tables:
  - `access_review_campaigns`: DB-stamped UTC quarter, `opened_at`, and `due_at` = +30 days; one OPEN campaign at a time (partial unique index); closure columns set together.
  - `access_review_items`: a frozen snapshot of kind, membership, subject, organisation, role, state, capability and grant id, capability set, high-risk flag, grantor, grant time and grant reason; one decision block; `solo`; `revocation_outcome`.
- Functions `access_review_is_reviewer(uuid)` and `access_review_reviewer_count()`.
- Guard triggers:
  - items are inserted only in the transaction that opened the campaign;
  - snapshot columns never change;
  - an item is decided once, only while its campaign is OPEN, and only by a reviewer;
  - a decision on your own item must be a solo KEEP, made while exactly one reviewer exists and at least 15 minutes after opening;
  - a campaign closes only when no item is undecided;
  - nothing is ever deleted.
- The file is idempotent. See Validation.

**Design docs / ADRs:** `access-review-campaigns-table-design.md` records the chosen designs and the rejected alternatives (live-table review, audit-only, one item per membership). No ADR was needed: this builds on ADR-032 and reuses OPS-02's solo pattern.

**Validation:** run on a freshly created database, `one_ops15`, with only DATABASE_URL exported. Scripts and logs are in the scratchpad's `OPS-15/` folder.
- `corepack pnpm db:migrate`, run twice: the first run applied 67 migrations and the second applied 0 (ADR-035 ledger). `0079` was also replayed twice by hand with `psql -v ON_ERROR_STOP=1` over the migrated database, without error.
- `corepack pnpm typecheck` passed.
- `corepack pnpm build` passed.
- `corepack pnpm audit --prod --audit-level=high` exited 0 (2 moderate, none high).
- Foundation-policy greps (optional chains in `apps/web/src`, conflict markers, private keys): no matches. No frozen file or existing migration is touched.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: **3199 of 3200 passed.**
  - Every non-api package passed, including web 779 (13 new) and authorization (13 new).
  - api: 1063 passed and 1 failed, with 8 files reported failed. All 9 failures were the shared-local-Postgres `out of shared memory` error. In 7 files it hit teardown only (`DROP SCHEMA`). In 1 test (institution-student-scope) it hit mid-run; that test does not touch this change.
- Each of those 8 files was then re-run alone, per the brief, and all passed:
  - documents 11/11
  - employer-organisation-state 14/14
  - institution-announcements 21/21
  - institution-placement-visibility 15/15 (the first rerun hit the same teardown error again; the second passed cleanly)
  - learner-goals 5/5 (same as above)
  - operations-institution-onboarding 2/2
  - operations-overview 9/9
  - institution-student-scope 15/15
- The new `access-reviews.integration.spec.ts` passed 22/22 in the full run.
- external-reviews, operations-capabilities and operations-approvals (which cover the refactored revoke paths) passed, 74/74.

**Acceptance criteria:**
- ✔ **A reviewer cannot attest their own access.** The API refuses it with 403 `ACCESS_REVIEW_OWN_ACCESS`, for KEEP and REVOKE, whenever a second reviewer exists; the trigger refuses it too.
  - Solo case: the only reviewer may KEEP their own access 15 minutes after opening. Before that the API returns 403 `ACCESS_REVIEW_SOLO_COOLING_OFF`.
  - The decision is marked SOLO on the item, in the audit row (`mode: SOLO`), in the campaign counts and in the CSV `mode` column.
  - The exception switches off as soon as a second reviewer exists (tested). Revoking your own access is never allowed.
- ✔ **Revocations applied from a campaign appear in audit with the campaign reference.** Each revocation writes its own audit row, and every one carries `accessReview {campaignId, itemId, periodLabel, decisionReasonCode}`:
  - internal grant: `operations.staff_capability.revoked`;
  - faculty grant: `operations.external_reviewer.revoked`, plus `operations.external_review.revoked` for each closed assignment;
  - platform role: `operations.staff_membership.suspended`, which lists the grants it revoked.

  Every decision also writes `operations.access_review.item_decided`. The effect is immediate: a reviewer whose grant was revoked gets 403 on the next request.
- ✔ **The CSV reproduces the campaign exactly.** The spec parses the export and compares every cell of every row with the campaign and items the API returns. The export is audited as `operations.access_review.exported`, with its row count and SHA-256, and the spec checks that the hash matches the file.
- ✔ **A review lists every standing internal grant, with who granted it and when.**
  - A role item shows the inviter of the accepted invitation, or NA when there is none.
  - It excludes suspended memberships, revoked grants and college-granted `INSTITUTION_ANALYTICS`.
- ✔ **Overdue reviews are visible.** The status tile and alert line show `NEVER_REVIEWED`, `REVIEW_OVERDUE` (3 months after the last close) and `CAMPAIGN_OVERDUE` (more than 30 days open). Each is tested in the API and on the web.
- ✔ **§6.6 minimums.**
  - API: 401; 403 for an operations admin without the grant, a college admin and faculty; 200 for security, super and granted operations admins; input 400s; 404; keyset pagination bounds (0/201/bad cursor); audit rows with reason codes; outbox rows; no user ids in responses.
  - Web: real data, NA, loading, empty, error with reference, forbidden, reason-code dialogs (submit disabled until chosen), Close disabled while items are undecided, and navigation labels unchanged.

**Decisions for Divakar (recommendations adopted):**
- **Solo self-attestation.** OPS-02's pattern is reused: KEEP only, 15 minutes after the campaign opened, marked SOLO everywhere, and switching itself off. There is no email notice, because the SOLO mark is on the evidence itself.
- **Revoking a platform role suspends the membership** (the existing registered `organization_membership.suspended` event) rather than ending it, so it can be reversed. The membership's internal grants are revoked with it. The last active super admin is protected (`ACCESS_REVIEW_LAST_SUPER_ADMIN`).
- **The reviewer applies revocations with `SECURITY_ACCESS_REVIEW` alone**, without `CAPABILITY_ADMIN`. Removal is the safe direction, and the power is limited to an item in an open campaign, never oneself, and never a grant.
- **Cadence:** 3 calendar months from the last close, with 30 days to finish a campaign. The period is the UTC calendar quarter of opening. More than one campaign per quarter is allowed, but only one can be open at a time.
- **Scope:**
  - Included: ACTIVE platform roles, internal grants, and faculty `CONTENT_REVIEW_EXTERNAL` grants (as OPS-10 asked).
  - Excluded: `INSTITUTION_ANALYTICS`, which is the college's own delegation (the college's analytics screen already offers an `ACCESS_REVIEW` reason); and `operation_approvals`, which are not standing access (24 hours, single use, and already in audit with SOLO marks).
- **The export carries staff and faculty emails and no student data.** It is audited with a hash. It is not treated as a §5.4 bulk personal-data export, so it has no dual control.
- **Reason codes:**
  - open: `QUARTERLY_REVIEW`, `AD_HOC_REVIEW`, `POST_INCIDENT_REVIEW`, `AUDIT_REQUEST`
  - keep: `STILL_REQUIRED`, `ROLE_REQUIRES_IT`, `TEMPORARY_COVER_CONTINUES`
  - revoke: `NO_LONGER_REQUIRED`, `LEAVER`, `EXCESSIVE_PRIVILEGE`, `UNRECOGNISED_GRANT`, `SECURITY_INCIDENT`
  - close: `REVIEW_COMPLETE`
  - export: `AUDIT_EVIDENCE`, `CERTIFICATION_EVIDENCE`, `INTERNAL_RECORD`

  A revoked grant records `ACCESS_REVIEW_OUTCOME`, which is already in OPS-01's revoke list.

**Limitations / not done:**
- A suspended staff membership has no reactivation screen. Reactivating one is still a data change by engineering (sop-staff-capabilities G1).
- The Overview (OPS-03) does not yet count overdue reviews. Overdue status is shown on Security.
- No reminder is sent when a review falls due, because there is no email sender (HG-7).

**Android:** no change, and nothing to compile. Access reviews are an operator screen, and Appendix 1 §4.3 keeps operator screens web-only. The phone's only operations calls are the read-only GET organizations and GET invitations, which are unchanged. The contract change is additive: new endpoints only.

**Risks / follow-ups:**
- `access_review_is_reviewer` mirrors the TypeScript baseline for `SECURITY_ACCESS_REVIEW`. An integration test pins the two together, so a baseline change must update both.
- `docs/security/reviews/OPERATIONS-CONSOLE-SECURITY-REVIEW.md` should record this control when the console review is next updated.

**Next goal:** OPS-16.

## OPS-14 — College health and account fields (Analytics, Organizations) — 2026-09-29
**Result:** Complete. Operations → Analytics now shows college health beneath role demand. For every college it shows rostered and signed-in students, weekly active learners, staff activity, open support cases, verification state and renewal date, sorted by renewal date or by activity. Each college's own view adds a four-week trend, assessments taken and the readiness band distribution. Operations → Organization Detail now carries the college account fields: renewal date, contract reference, AI8HT account owner and masked college contacts. They are editable only with ACCOUNT_MANAGE, each change needs a reason code, and every change is audited.

**Branch / PR:** feat/ops-college-health, cut from onev4/feat/plan-phases-0-to-2 @ e472cef → feat/plan-phases-0-to-2. Commits, in order:
- design: eb5fcec
- acceptance tests: bbe0861
- migration, persistence and API: 82fa78c
- web: 6664e64
- this report

Pushed to onev4. No PR was opened because `gh` is not installed.

**Files created:**
- docs/architecture/institution-accounts-table-design.md
- packages/persistence/drizzle/0078_institution_accounts.sql
- packages/authorization/src/college-health.ts (+ .test.ts)
- packages/persistence/src/college-health.ts
- packages/persistence/src/institution-accounts.ts
- apps/api/src/http/operations-college-health.controller.ts (+ .integration.spec.ts)
- apps/web/src/api/collegeHealth.ts
- apps/web/src/rolePortal/collegeHealth.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/index.ts: export only.
- apps/api/src/http/api-security.module.ts: registration only.
- apps/web/src/api.ts: barrel only.
- apps/web/src/rolePortalPages.tsx: two operations branches only.
  - `Analytics` shows role demand, then college health.
  - `Organization Detail` shows the organisation list, then the account panel.

**Migrations added:** 0078_institution_accounts.sql (the number assigned). It adds two tables:
- `institution_accounts`: one row per college, never deleted. Its trigger:
  - requires the row to belong to an INSTITUTION;
  - requires the owner, when set or changed, to be an ACTIVE internal membership of the PLATFORM organisation;
  - stamps times from the database clock.

  The contract reference is an identifier (`[A-Za-z0-9/_.:-]`, no spaces), so an amount cannot be stored in it.
- `institution_account_contacts`: the only update allowed is live → removed. Removal erases the name, email and phone, and a CHECK enforces the erasure. Rows are never deleted.

Every statement is guarded. `db:migrate` ran twice, and the file was also replayed twice by hand with psql; both replays exited 0.

**Design docs / ADRs:** institution-accounts-table-design.md. It records the table, the privacy rules, each figure's source and definition, the fixed windows and the ordering rule. It also records the rejected options:
- columns on `organization_profiles`;
- contacts as a jsonb array;
- contacts as `users`;
- a composite health score;
- rolling windows;
- a stored contract value;
- dual control.

No ADR was needed.

**API:**
- `GET /api/v1/operations/analytics/colleges`: one bounded summary of at most 500 colleges. Any query parameter returns 400.
- `GET /api/v1/operations/analytics/colleges/:collegeId`: one college.
  - Both analytics routes need ANALYTICS_VIEW.
  - Both return suppressed aggregates, so, like the Overview and OPS-11, they write no audit row.
- `GET /api/v1/operations/college-accounts/policy` and `GET /api/v1/operations/college-accounts/:collegeId`: masked reads.
- `PATCH /api/v1/operations/college-accounts/:collegeId`: renewal date, contract reference and owner, with `expectedVersion`. A stale version returns 409.
- `POST …/contacts`, `POST …/contacts/:id/remove` and `POST …/contacts/:id/reveal`.
- Every account route needs ACCOUNT_MANAGE and returns 400 for unknown fields. Every write takes a reason code from `packages/authorization/src/college-health.ts` and an optional note of at most 500 characters.
- Audit actions are `operations.institution_account.{updated,contact_added,contact_removed,contact_revealed}`, each written in the same transaction as its change.
  - The update row records each field's before and after value.
  - No audit row ever carries a contact's name, email or phone.
- The route parameter is named `collegeId` because the authentication guard reads an `institutionId` parameter as the caller's own organisation, and would refuse every operator.

**What each figure counts:**
- **Rostered:** students with a current VERIFIED or ACTIVE relationship whose account is not deleted, pending deletion or anonymised.
- **Signed in:** the account is activated (INST-01). "Signed in" and "not yet" go through `suppressAggregateTable`, which withholds the total when it would reveal a hidden cell.
- **Weekly active learners:** distinct students with a `learner_activity_events` row in the last complete ISO week (UTC), whose relationship covered the event. The list shows one week; the college view shows four.
- **Assessments:** submitted and auto-submitted `exam_attempts` in the last ended month, as a count of attempts and of distinct students.
- **Readiness bands:** the college's own `institutionReadinessDistribution` over the last ended month. Bands only.
- **Staff:** active memberships, split into those that did and did not write an audit event for the college in the week. The split is suppressed.
- **Staff actions opened in the week:** counselling notes are never counted.
- **Open support cases:** cases still open, and how many are overdue against their SLA. These are work items, so they are not suppressed.
- **Verification state and renewal date:** as stored.
- **Readiness band movement:** NA, with the reason on screen.
- No count of people is summed across colleges. The header totals count only colleges and cases.

**Validation (fresh local DB `one_ops14`, only DATABASE_URL exported):** full run on 9e7a4e1.
- `db:migrate` ×2: pass (67 applied with the ledger created, then 0 applied / 67 already applied).
- `corepack pnpm typecheck`: pass.
- `corepack pnpm build`: pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: 3 189 passed, 2 failed, and 1 file errored.
  - All 17 other packages passed. The api suite passed 1 055 of 1 057 across 66 files.
  - The failures were `institution-roster-activation` (1 test) and `operations-audit` (1 test). `employer-organisation-state` errored in teardown.
  - Each one was Postgres `out of shared memory` on the shared local server, which was holding 3–9.6 thousand locks for other agents' concurrent runs against `max_locks_per_transaction` 64.
  - This branch touches none of those files.
- Re-runs, each file alone, as the brief directs:
  - `operations-audit`: 12/12 pass.
  - `employer-organisation-state`: first re-run 14/14 with a teardown shared-memory error; second 14/14, exit 0.
  - `institution-roster-activation`: 12/13 twice, both times on `out of shared memory` in `TRUNCATE`. The third run, once the server's lock count fell to about 1 150, passed 13/13 with exit 0.
- No test was skipped or changed.

Before this report:
- `db:migrate` ×2: pass (67 applied, then 0).
- 0078 replayed twice by hand: pass.
- `corepack pnpm typecheck`: pass.
- The new suites pass on their own:
  - authorization college-health: 9/9;
  - api operations-college-health integration: 15/15;
  - web collegeHealth: 15/15, with roleDemand still 11/11.
- CI parity:
  - optional-chain grep empty;
  - `pnpm audit --prod --audit-level=high` exit 0 (2 moderate);
  - no private-key blocks or conflict markers.

**Acceptance criteria:**
- ✔ **Every figure has a real source or NA.**
  - Each figure above is read from an existing table.
  - Readiness band movement shows NA in its slot, because no computation exists for it.
  - An unrecorded renewal date shows NA.
  - The integration tests seed each source (students, events, attempts, snapshots, audit events, staff actions, cases) and assert the exact published value.
  - The web tests assert NA in every stat slot when loading fails, and NA for a college with no account yet.
- ✔ **Band distributions under 5 students show <5.**
  - With 5 DEVELOPING and 1 PROGRESSING, the 1 and both zeros show <5 and the total is withheld.
  - A college with fewer than 5 readiness updates shows no bands at all.
  - Every other count of people follows the same rule:
    - Beta's 3 students and 2 learners show <5.
    - Alpha has 12 rostered students (10 signed in, 2 not), and its total is withheld.
  - A college's position in the list never reveals a suppressed count: a unit test shows two different true counts give the same order.
- ✔ **Account fields are editable only with ACCOUNT_MANAGE, audited with reason codes, and unknown fields are rejected.**
  - 401 without a token.
  - 403 for SECURITY_ADMIN without a grant, for an institution admin, and for a suspended operator.
  - ANALYTICS_VIEW opens health only; ACCOUNT_MANAGE opens accounts only.
  - 400 for each of:
    - unknown fields (`contractValue`, `salary`);
    - a missing or unlisted reason code;
    - an impossible date;
    - "Rs 5,00,000" as a contract reference;
    - a malformed owner id;
    - an overlong note;
    - a request that changes nothing.
  - 404 for an employer or an unknown id.
  - 409 for a stale version, and 409 for an eleventh contact.
  - The owner rule is checked in both the API and the trigger.
  - The database refuses deleting an account, editing a contact in place, and deleting a contact.
- ✔ **No student-level data.**
  - Every health response is checked for student emails, roll numbers and ids, and contains none.
  - No numeric readiness value appears anywhere.
- ✔ **Contacts are masked** (`m***@alpha.edu`, `***2345`).
  - The full value comes only from a reason-coded reveal, which is audited before the value is returned.
  - Removing a contact with PRIVACY_REQUEST leaves the name, email and phone NULL.
- ✔ **§6.6 web minimums:**
  - real data, <5 and Withheld, and NA;
  - empty and loading states;
  - error and forbidden states, each with its reference;
  - confirm dialogs that require a reason code (account fields and reveal);
  - navigation labels unchanged.
- **Dual control: not applicable.** §5.4 lists none of these actions.

**Decisions for Divakar (recommendations adopted):**
- **Fixed windows:** the last complete ISO week (UTC) and the last ended month. Rolling windows were rejected because they can be differenced from one day to the next (INST-SR-01).
- **"Signed in" means an activated account.** ONE keeps no per-sign-in history for students.
- **Staff count as "active"** when they wrote an audit event for the college that week. Viewing alone is not recorded, and the screen says so.
- **The owner's email appears only in the account view** (ACCOUNT_MANAGE), not in the analytics list.
- **At most 10 live contacts per college.** Correcting a contact means removing it and adding it again.
- **Layout without new navigation:**
  - Analytics stacks college health beneath role demand.
  - Organization Detail stacks the account panel, with a college picker, beneath the organisation list.
  - No navigation item was added, renamed or reordered (HG-3).

**Limitations / not done:**
- Not built:
  - per-student readiness movement;
  - a renewal reminder;
  - an outbox event for account changes (nothing consumes one yet).
- The rostered and signed-in counts are a live stock. Reading them daily can show that a student joined, but never which student.
- The list is capped at 500 colleges with no pagination, the same bounded-summary approach as OPS-11.
- The Organization Detail college picker lists institutions from the existing organisations endpoint, which is capped at 200.

**Risks / follow-ups:**
- OPS-15's access review should include holders of ACCOUNT_MANAGE, because contacts are personal data.
- A contact is not a ONE user, so the user-deletion flow does not reach them. A contact's privacy request is served by removing them with PRIVACY_REQUEST, and the SOPs should say so.

**Android:** no change, and nothing to compile. Operator screens are web-only (Appendix 1 §4.3). The app's only operations call is the read-only `GET /operations/overview` (Api.kt:212), which this goal does not change.

**Next goal:** OPS-15, or as scheduled by the coordinator.

## OPS-16 — Incident register, breach clocks and status communications — 2026-09-29
**Result:** Complete. Security has an incident register with a timeline and, for a personal data breach, a Board reporting clock
computed on the database clock from `detected_at`. Settings has status-notice templates, published only with a second person's
approval (OPS-02 dual control), and notices to the admins of affected organisations. A notice is a draft until a person approves
it; it is rate-limited and sent through the outbox worker.

**Branch / PR:** feat/ops-incidents-comms → feat/plan-phases-0-to-2, based on e472cef. The commits are, in order: design (d354de5),
acceptance tests (8da95a7), backend implementation (df7228b), web and Android (6cdc85b), this report (ecacfe7), a spec typing fix (5f0a901) and the validation amendment. The branch is pushed to
onev4. No PR was opened because `gh` is not installed, so the merge is left to review.

**Files created:**
- docs/architecture/incident-register-table-design.md
- packages/persistence/drizzle/0081_incident_register.sql
- packages/authorization/src/incidents.ts (+ .test.ts)
- packages/persistence/src/incidents.ts and packages/persistence/src/status-notices.ts
- apps/api/src/http/operations-incidents.controller.ts, apps/api/src/http/operations-communications.controller.ts
- apps/api/src/http/operations-incidents.integration.spec.ts
- apps/web/src/api/incidents.ts
- apps/web/src/rolePortal/incidents.tsx, apps/web/src/rolePortal/communications.tsx, apps/web/src/rolePortal/incidents.test.tsx

**Files modified:**
- packages/authorization/src/{high-risk-actions,index}.ts: a new extended approval key `COMMS_TEMPLATE_PUBLISH` (capability
  COMMS_TEMPLATES, target `status_notice_template`), and an export.
- packages/events/src/index.ts: 4 new events (`incident.declared`, `incident.state_changed`, `status_notice_template.published`,
  `incident.status_notice.dispatch.requested`) and the new key in the approval key list.
- packages/persistence/src/operation-approvals.ts: the approval summary names the template key and version.
- packages/persistence/src/automation-workers.ts: the dispatch consumer is registered with the ADR-028 local publisher.
- apps/api/src/http/{operation-approval-gate,operations-approvals.controller,api-security.module}.ts: the payload shape, request
  validation (only the draft's author may ask), and registration.
- apps/web/src/{api.ts,api/operations.ts,api/platform.ts,notificationsBell.tsx}: barrel export, the approval key and summary fields,
  the `STATUS_NOTICE` notification kind, and a "Service status notice from AI8HT" prefix in the bell.
- apps/web/src/rolePortal/approvals.tsx: describe and execute the new approval.
- apps/web/src/rolePortal/privacyConsole.tsx (+ .test.tsx): "Incident register: not built yet" became "Incident register: below".
  That statement was no longer true, so the test changed with it; it now also asserts the old text is gone.
- apps/web/src/rolePortalPages.tsx: only the operations `Security` and `Settings` branches (a component appended to each).
- apps/android/.../Api.kt, StaffDashboards.kt: the staff inbox labels a status notice as from AI8HT (see Android).
- docs/ops/runbook-breach-response.md: declare in the register, record the Board and user notifications there, and use status
  notices for colleges. The 72-hour clock is labelled as pending legal confirmation.

**Migrations added:** 0081_incident_register.sql. It references only tables up to 0074 and contains:
- the tables `incidents`, `incident_events` (append-only), `incident_affected_organizations`, `status_notice_templates`,
  `incident_status_notices` and `incident_status_notice_recipients`;
- a guard trigger on each table. The triggers:
  - stamp every lifecycle time from the database clock;
  - make declarations, template content and drafts immutable;
  - enforce the state machine;
  - refuse closing a breach before the Board and the users are recorded as notified;
  - refuse reclassifying a notified breach;
  - refuse a notice on a template that did not pass dual control;
  - apply the notice rate limit under a lock on the incident;
  - refuse every DELETE.
- `operation_approval_extended_target_type()` redefined with every earlier key plus `COMMS_TEMPLATE_PUBLISH`;
- `user_notifications.kind` gains `STATUS_NOTICE` (the read-and-union pattern of 0059/0067/0074).

The migration was applied twice through `db:migrate` on a fresh `one_ops16` (the second run applied 0 files, per ADR-035). The file
was also replayed by hand on top of itself with no error.

**Design docs / ADRs:** incident-register-table-design.md covers the chosen design, the clock's basis, the delivery path, and the
rejected options. No ADR was needed; this builds on ADR-032, OPS-02 dual control and ADR-028.

**Validation (only DATABASE_URL exported; fresh databases, all created in this session):**
- `db:migrate` twice on fresh `one_ops16x`: the first run applied 67 files including 0081, and the second applied 0. Both passed.
- `corepack pnpm typecheck`: pass. The first full run failed on one implicit-any in the new spec; this was fixed in 5f0a901.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: the combined run is not usable. A stopped earlier run was still writing
  to the same log, and on the shared server it hit "out of shared memory" in teardown. Each package was therefore re-run on its own,
  and every one passed:
  - web: 785, including 19 new in incidents.test and the updated privacy-console test
  - api: 1 069, including 27 new in operations-incidents.integration.spec
  - persistence: 404 in total. On `one_ops16x`, 403 passed and 1 failed: evidence-stages "0050 columns", because it read
    information_schema and saw two schemas left behind by the aborted run's teardown. Re-run alone on a fresh `one_ops16y`, that
    file passed 13/13.
  - authorization: 332, including 21 new
  - hiring 192, career-readiness 105, learning-model 72, learning-orchestrator 52, identity 41, placement 31, mastery-bkt 29,
    review-scheduler 23, privacy 22, ai-orchestration 19, assessments 15, events 14, learner-content 7, automation 7
  - Total: 3 219 passed, 0 failed.
- `corepack pnpm build`: pass.
- CI parity:
  - `corepack pnpm audit --prod --audit-level=high` exits 0 (2 moderate advisories, none high).
  - The optional-chain policy grep prints nothing.
  - No private-key blocks or merge-conflict markers.
- Android: `./gradlew --no-daemon -q :app:compileDebugKotlin` with the Android Studio JBR exits 0.

**Acceptance criteria:**
- ✔ A breach incident shows its 72-hour deadline and who was notified when.
  - The deadline is `detected_at` + 72 h, computed in SQL on the database clock.
  - The status is RUNNING, OVERDUE, MET or MET_LATE, and the time remaining comes from the database clock.
  - The register records who recorded the Board report and when (with an optional acknowledgement reference), and who recorded that
    the affected users were told, and when.
  - For each status notice, the incident detail shows who approved it and when, when it was sent, how many admins in how many
    organisations it reached, and the email outcome counts.
  - The timeline has every step with actor, time and reason code. Integration specs cover RUNNING, OVERDUE, MET and MET_LATE.
- ✔ A notice cannot be sent from an unapproved template version.
  - The API refuses a draft template with `STATUS_NOTICE_TEMPLATE_NOT_APPROVED`, and a notice body has no text field
    (`INVALID_REQUEST`).
  - At the database, a notice can reference only a `notification_templates` row. Every row there is approved (NOT NULL
    `approved_by_user_id`), and the 0081 trigger additionally requires a PUBLISHED `status_notice_templates` row pointing at it.
    Tested by a direct insert with a rogue template row.
  - A template version is published only with an executed `COMMS_TEMPLATE_PUBLISH` approval: `APPROVAL_REQUIRED` without one, and
    `COMMS_TEMPLATE_NOT_AUTHOR` when a non-author asks. The published row carries the approver as `approved_by_user_id`.
- ✔ The §6.6 minimums:
  - 401 without a token.
  - 403 for an institution admin on every route, 403 across the capability split (OPERATIONS_ADMIN on incidents, SECURITY_ADMIN
    on communications), 403 for a suspended membership, and 200 through an explicit grant.
  - 400 on invalid input, including an email address or phone number in incident text, and on unknown fields.
  - Keyset paging, bounded 1–200, with no repeats.
  - Audit rows carry the reason code, and outbox rows are written.
  - Recipient lists are never returned; the screens show counts only.
  - Web tests cover real data, NA, loading, empty, an error with its reference, forbidden, reason-required dialogs, and unchanged
    navigation labels.
- ✔ The rules given for this goal:
  - Every incident change is audited with a reason code.
  - Clocks use the database clock.
  - Notices are DRAFT until a person approves them and are sent only through the outbox and the existing mail sink, with sender
    `mailSender()` = info@ai8ht.pro. Email is recorded NOT_CONFIGURED with no sink.
  - Nothing contacts the Board or any external party.
  - Incident titles and summaries refuse contact details.
  - Operations labels are unchanged (HG-3).
  - There are no model calls.

**Decisions for Divakar (recommendations adopted):**
- **The 72-hour period** is the goal text's, labelled everywhere as the plan's period pending legal confirmation. It is not presented
  as settled law. It is stamped per breach, so a later change, made by a new migration after legal review, never moves a running
  deadline. No deadline is shown for telling affected users, because the goal states none; ONE records when they were told.
- **Delivery path.** Notices go through the outbox and the local worker, as an in-app notification plus email through the
  configured mail sink. They do not use `notification_commands` and n8n: that path selects the workflow by `stable_key`, and the
  only fitting allow-listed workflow (`security-notification`) is inactive (HG-7) and keyed to OPS-02's solo notice.
- **Template approval reuses OPS-02 dual control.** It is a new extended action, not a bespoke second-person rule, so the solo
  safeguard (15-minute cooling-off, marked SOLO) lets a one-person pilot publish. Only the draft's author may ask for approval, so
  the approver is never the author.
- **Audience.** Recipients are the ACTIVE owners and admins (institution and employer) of the incident's live affected
  organisations, resolved when the notice is sent. It never reaches students.
- **Email preference.** A notice honours an admin's "email off" preference, recorded SKIPPED, like announcements.
- **Rate limit.** One approved notice per incident per 15 minutes and at most 6 per 24 hours, answered with 429
  `STATUS_NOTICE_RATE_LIMITED`.
- **Breach rules.**
  - A breach cannot close until the Board and the users are recorded as notified.
  - A notified breach cannot be reclassified.
  - A false alarm is reclassified first, then closed.
  - OPEN → CLOSED is allowed only as DUPLICATE or FALSE_ALARM.
- **Personal data in incident text.** An email address, or a run of 10 or more digits (split at most by single spaces), is refused
  with `INCIDENT_TEXT_PERSONAL_DATA`. Dates written with dashes pass.
- **The affected-organisations count** is derived from the live link rows, not stored.
- **Reason codes:**
  - declare: `MONITORING_ALERT`, `CUSTOMER_REPORT`, `INTERNAL_DISCOVERY`, `THIRD_PARTY_REPORT`, `SUSPECTED_BREACH`
  - contain: `ACCESS_PATH_CLOSED`, `CREDENTIAL_ROTATED`, `SERVICE_ISOLATED`, `MITIGATION_APPLIED`
  - resolve: `ROOT_CAUSE_FIXED`, `SERVICE_RESTORED`, `DATA_RESTORED`, `NO_IMPACT_CONFIRMED`
  - close: `POST_INCIDENT_REVIEW_DONE`, `DUPLICATE`, `FALSE_ALARM`
  - reopen: `RECURRENCE`, `CONTAINMENT_FAILED`, `NEW_EVIDENCE`
  - severity: `ASSESSMENT_UPDATED`, `SCOPE_GREW`, `SCOPE_REDUCED`
  - category: `ASSESSMENT_UPDATED`, `CONFIRMED_PERSONAL_DATA`, `NO_PERSONAL_DATA_INVOLVED`
  - note: `TIMELINE_UPDATE`, `EVIDENCE_RECORDED`, `DECISION_RECORDED`
  - organisations: add `SCOPE_ASSESSED`, `NEW_EVIDENCE`; remove `SCOPE_ASSESSED`, `ENTERED_IN_ERROR`
  - Board: `BOARD_REPORT_FILED`
  - users: `USERS_NOTIFIED_BY_EMAIL`, `USERS_NOTIFIED_BY_COLLEGE`, `USERS_NOTIFIED_OTHER_CHANNEL`
  - templates: draft `NEW_TEMPLATE`, `WORDING_UPDATE`, `CORRECTION`; publish `INCIDENT_COMMUNICATION`, `PLANNED_COMMUNICATION`,
    `WORDING_CORRECTION`; withdraw `SUPERSEDED`, `ENTERED_IN_ERROR`, `NOT_NEEDED`
  - notices: draft `INITIAL_NOTICE`, `INCIDENT_UPDATE`, `RESOLUTION_NOTICE`; approve `APPROVED_FOR_SEND`; withdraw `NOT_NEEDED`,
    `WRONG_TEMPLATE`, `SUPERSEDED`

**Limitations / not done:**
- No email leaves any environment until a production mail sender exists (HG-7). Until then the screens say "not sent — no mail
  service configured".
- Status notices go to organisation admins only. Notices to students and data principals are out of scope, as the goal specifies.
- The comms screen publishes status-notice templates only. It does not publish the `ops-failure` or `security-notification`
  templates that OPS-04 and OPS-02 wait on; that is a small follow-up on the same mechanism.
- Incident titles and summaries are immutable after declaration; updates go in the timeline.
- The incident list header counts are server-side. The Settings stat tiles count the loaded page only, and are labelled "in this
  view".

**Risks / follow-ups:**
- `operation_approval_extended_target_type()` is redefined in full by each migration that adds a key. 0081 lists every key up to
  0065 plus its own. A parallel branch that adds a key in a migration numbered below 0081 must be re-listed in a later migration.
  None of 0077 (fix/privacy-employer-screening), 0078 (OPS-14) or 0079 (OPS-15) on onev4 touches it.
- The rolePortalPages `Security` line is also changed by OPS-15 (access reviews). The merge is a one-line union of both components.
- The API route parameter for removing an organisation is `affectedOrgId`, not `organizationId`. api-security treats a parameter
  named `organizationId` as selecting the caller's membership.

**Android:** changed, and compiled with the Android Studio JBR (`:app:compileDebugKotlin`, exit 0). The operator screens stay
web-only (§4.3). A status notice is a user-facing in-app notification to college and employer admins, and the phone's staff inbox
already lists every notification. It now labels a `STATUS_NOTICE` "Service status notice from AI8HT for <organisation>" (Api.kt
`statusNoticeSource`, StaffDashboards.kt `StaffInboxOverlay`), matching the web bell. Students never receive one, so the student
inbox is unchanged.

**Next goal:** OPS-17 (full).

## OPS-12 — AI Operations console — 2026-09-30
**Result:** Complete. The existing AI Operations item is now the AI console:
- usage, outcomes, failure classes, tokens, prompt versions and evaluation records, all read from ONE AI Orchestration's own
  tables (cost NA);
- per-feature switches and limits;
- a one-action global AI kill switch;
- a no-restart off switch for the in-app assistant;
- an evaluation gate on switching any feature on.

The AI hold is respected: no provider adapter, no model call, no price.

**Branch / PR:** feat/ops-ai-console → feat/plan-phases-0-to-2, based on 09a8d9a. The commits are, in order: design (9565b31),
acceptance tests (34d1ce8), backend (6182264), web (782c6b4), web tests and runbook (cf503ae), and this report. The branch is
pushed to onev4. No PR was opened because `gh` is not installed, so the merge is left to the coordinator.

**Files created:**
- docs/architecture/ai-evaluations-table-design.md
- packages/persistence/drizzle/0089_ai_operations.sql
- packages/authorization/src/ai-operations.ts (+ .test.ts)
- packages/ai-orchestration/src/registry.ts
- packages/persistence/src/ai-operations.ts and packages/persistence/test/ai-operations.integration.test.ts
- apps/api/src/http/operations-ai.controller.ts (+ operations-ai.integration.spec.ts)
- apps/web/src/api/aiOperations.ts
- apps/web/src/rolePortal/aiOperations.tsx (+ .test.tsx)

**Files modified:**
- packages/authorization/src/{high-risk-actions,index}.ts: two extended approval keys.
- packages/events/src/index.ts: 3 events and the 2 approval keys.
- packages/ai-orchestration/src/index.ts: exports the registry.
- packages/persistence/src/ai-orchestration.ts: `loadAiFeaturePolicy` reports a feature as disabled while the kill switch is
  engaged, and `upsertAiFeaturePolicy` takes the prompt.
- apps/api/src/http/{operation-approval-gate, operations-approvals.controller, api-security.module, assistant.controller}.ts
- apps/web/src/{api.ts, api/operations.ts, rolePortal/approvals.tsx, rolePortal/shared.tsx}
- apps/web/src/rolePortalPages.tsx: only the AI Operations branch.
- docs/ops/runbook-ai-kill-switch.md: a new "Since OPS-12" section.

**Migrations added:** 0089_ai_operations.sql. It references only tables up to 0085, plus the approval function. It contains:
- `ai_feature_policies.prompt_key` and `prompt_version`, set together or not at all.
- `ai_evaluations`:
  - append-only (a trigger refuses UPDATE and DELETE);
  - `decided_at` is stamped by the database;
  - metrics are a JSON list of 1–20 `{name, value, threshold, comparator}` entries;
  - a PASS must meet every threshold it records.
- `ai_evaluation_passes()`, the single definition of "passing for this model and prompt": the latest record wins, and a tie
  counts as FAIL.
- Two flags, inserted only if absent, and `ai_kill_switch_engaged()`:
  - `ai.global-kill-switch`: high-risk DISABLE, default not engaged;
  - `ai.assistant`: high-risk ENABLE, default off.
- A trigger on `ai_feature_policies`:
  - switching a feature on needs the kill switch released and a passing evaluation;
  - an enabled feature whose model or prompt changes without an evaluation is switched off;
  - inserting an enabled feature is refused while the kill switch is engaged.
- `operation_approval_extended_target_type()` redefined with:
  - every earlier key (0051, 0057, 0061, 0065, 0081);
  - `INSTITUTION_DATA_PURGE` from 0088 on feat/inst-contract-lifecycle, because 0089 sorts after it and must not drop it;
  - the new `AI_FEATURE_ENABLE` and `AI_FEATURE_LIMITS_RAISE`.

The migration was applied twice through `db:migrate` (the second run applied 0) and was replayed by hand with no error.

**Design docs / ADRs:** ai-evaluations-table-design.md covers the decisions, the assistant rationale, the rejected options and
the open points. No ADR was needed; this builds on ADR-030, ADR-032 and OPS-02.

**Validation:** see the amendment below.

**Acceptance criteria:**
- ✔ Every figure comes from `ai_generations` or `ai_feature_policies`, or shows NA.
  - The summary, usage-by-period and usage-by-organisation queries read only those tables, plus `ai_evaluations` and the two
    flags.
  - Cost is `null` with basis `NO_PRICE_TABLE` in the API, and NA on every screen.
  - The code prompt registry is an empty list under the hold, and the screen says so.
  - An organisation row standing for fewer than 5 people withholds every figure (`suppressSmallCount`) and shows <5.
- ✔ Switching a feature on without a passing evaluation is blocked:
  - at the approval request (409 `AI_EVALUATION_REQUIRED`), at execution, and at the database for any writer;
  - a pass for another model or another prompt version does not count;
  - a later FAIL overturns an earlier PASS;
  - the approval is bound to the model, prompt version and evaluation id, so a later model change gives
    `APPROVAL_PAYLOAD_MISMATCH` and a later FAIL gives `AI_EVALUATION_REQUIRED`.
- ✔ The kill switch disables all AI features in one action.
  - One transaction sets the flag and switches off every enabled policy and the assistant flag.
  - It writes an audit row for each change and for the kill switch itself, plus flag events and one outbox event.
  - The orchestrator refuses the very next call, with no restart (persistence test).
  - **Deliberate deviation:** the goal says "one approved action", but the brief says switching off, including the global kill
    switch, needs no approval and takes effect immediately. Engaging it therefore needs no approval, and releasing it is the
    dual-controlled direction (§5.4 "AI global kill switch off").
- ✔ Approvals and audit:
  - switching off (a feature, the assistant or the kill switch) needs no approval;
  - switching on and widening need OPS-02 dual control and a reason code;
  - the solo path (15-minute cooling-off, marked SOLO) is tested on a limits raise;
  - every change is audited.
- ✔ The §6.6 minimums:
  - 401 on every route;
  - 403 on every route for an institution admin and for a suspended membership, and 200 with the capability;
  - an OPERATIONS or SECURITY admin without `AI_OPS_CONFIGURE` cannot configure;
  - 400 on invalid input (unknown fields, reasons, bounds, metrics);
  - keyset paging, bounded 1–200, with no repeats;
  - audit rows carry the reason code, and a super admin's use is marked `break_glass: true`.
  - Web tests cover real data, NA, loading, empty, an error with its reference, forbidden, reason-required dialogs, and
    unchanged navigation labels.

**Decisions for Divakar (recommendations adopted):**
- **Assistant switch.**
  - The console can switch the assistant **off** without a restart. The flag `ai.assistant` is read on every request and
    fails closed.
  - Switching it **on** still needs `ASSISTANT_ENABLED=true` and a provider key on the server, and also an approved high-risk
    flag change.
  - The flag is **off by default**, so merging this changes nothing: the assistant stays off, as Divakar set it on 2026-09-28.
  - The console shows only whether the variable and the key are set (true or false), and never changes either.
- **Who may stop AI:** anyone holding `AI_OPS_CONFIGURE` or `OPS_FLAGS_MANAGE`. The brake must be reachable by whoever is on
  duty, and only the super admin holds `AI_OPS_CONFIGURE` by baseline. Configuring (switching on, limits, evaluations) needs
  `AI_OPS_CONFIGURE`.
- **Kill switch default:** not engaged. Every feature and the assistant are already off by default.
- **Every feature counts as reaching students.** The evaluation gate applies to all of them; there is no audience column that
  could be used to get round it.
- **Evaluation match:** feature + model + prompt key + prompt version, without the provider, because the policy has no provider
  column. Add the provider when the ADR-030 adapter lands.
- **A window change** (DAY ↔ MONTH) counts as widening, in either direction.
- **Flag overrides are ignored** for the two AI flags.
- **Reason codes:**
  - disable: `INCIDENT_MITIGATION`, `QUALITY_CONCERN`, `COST_CONTROL`, `ROLLBACK`, `NOT_NEEDED`
  - kill switch: `INCIDENT_MITIGATION`, `HARMFUL_OUTPUT`, `SUSPECTED_KEY_COMPROMISE`, `SPEND_RUNAWAY`, `PRECAUTION`
  - assistant off: `INCIDENT_MITIGATION`, `HARMFUL_OUTPUT`, `SUSPECTED_KEY_COMPROMISE`, `POLICY_REQUIREMENT`, `PRECAUTION`
  - enable: `EVALUATION_COMPLETE`, `PILOT_ROLLOUT`, `INCIDENT_RESOLVED`
  - lower limits: `COST_CONTROL`, `INCIDENT_MITIGATION`, `CORRECTION`
  - raise limits: `DEMAND_GROWTH`, `PILOT_EXPANSION`, `CORRECTION`
  - evaluation: `INITIAL_BENCHMARK`, `MODEL_CHANGE`, `PROMPT_CHANGE`, `PERIODIC_REVIEW`, `INCIDENT_REVIEW`

**Limitations / not done:**
- No AI feature exists yet because of the AI hold, so on a real database the features table is empty and the screen says so.
- The database does not refuse inserting an enabled feature while the kill switch is released, because an evaluation cannot
  exist before its policy row. Registration code never sets `enabled`, and the console never inserts. This gap is recorded in
  the design doc.
- The assistant has no prompt-registry version, so the evaluation gate does not apply to it. The recommendation is to bring it
  back only through ONE AI Orchestration (OPS-SR-02).
- Engine health panels belong to OPS-13.

**Android:** no change.
- §4.3 keeps operator screens web-only, and the app has no AI Operations screen.
- The only effect users can see is the assistant answering 503 while its console switch is off. The app already handles that:
  `JobsAndMore.kt` shows "The assistant is switched off for now" on a 503.
- The assistant is off today either way.

**Risks / follow-ups:**
- A later migration that adds an approval key must re-list all eight extended keys above.
- The assistant controller now receives the persistence database by injection. Only `Phase1ApiSecurityModule` registers it,
  and that module provides the database.

**Next goal:** OPS-13 (once the engine tables exist) or OPS-17.
