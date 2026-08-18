# PR #1 Phase B Security Review

## Scope

Repository: `PVUD14/planthepath-next`

Reviewed range: `c39786b7e57207a7c08fb066848646d0d2741516..965a892322ed91659ff60dcc1ff3fc7424bb3338`

Review method: Codex Security diff-scan terminal workflow, full PR diff review plus targeted validation of hypotheses H1-H10.

Changed files reviewed:

- `.github/workflows/phase1-ci.yml`
- `apps/api/package.json`
- `apps/api/src/application/identity-organization/services.test.ts`
- `apps/api/src/application/identity-organization/services.ts`
- `apps/api/src/http/api-security.ts`
- `docs/architecture/spec/06-deployment-stack-repo-testing.md`
- `docs/integration-assessment/*`
- `docs/phase-b/*`
- `packages/authorization/src/index.test.ts`
- `packages/authorization/src/index.ts`
- `packages/events/package.json`
- `packages/events/src/index.test.ts`
- `packages/events/src/index.ts`
- `packages/events/tsconfig.json`
- `packages/persistence/drizzle/0002_phase_b_event_foundation.sql`
- `packages/persistence/drizzle/0003_phase_b_hardening.sql`
- `packages/persistence/package.json`
- `packages/persistence/src/identity-authentication.ts`
- `packages/persistence/src/outbox-dispatcher.ts`
- `packages/persistence/src/repositories.ts`
- `packages/persistence/src/schema.ts`
- `packages/persistence/test/*`
- `package.json`
- `pnpm-lock.yaml`

Threat model inputs reviewed:

- `docs/phase-0/threat-model.md`
- `docs/security/DATA_PROTECTION_SECURITY_ARCHITECTURE.md`
- `docs/security/DATA_PROTECTION_ENGINEERING_REQUIREMENTS.md`
- `docs/integration-assessment/INTEGRATION_SECURITY_THREAT_ASSESSMENT.md`
- `docs/phase-b/*`

## Threat model summary

The PR changes security-significant identity, authorization, event, audit, migration, replay and CI behavior. The principal risks are cross-tenant access, stale temporal institution access, poisoned outbox rows, duplicate or reordered delivery, stale-worker acknowledgement, replay abuse, event payload data leakage, schema confusion, migration drift, audit tampering and CI supply-chain drift.

The integration assessment correctly keeps V4 and n8n out of runtime scope. This review confirms no V4 runtime/data import and no n8n implementation were introduced.

## Confirmed findings and remediation

### High: outbox producers could commit unsupported or malformed events

Before remediation, persistence `writeOutboxEvent` implementations inserted arbitrary event type/version/aggregate/payload/correlation values and relied on dispatcher-time validation. A poisoned row could commit with the domain transaction and fail later.

Remediation:

- Added write-time `validateOutboxWriteInput` and `validateAuditWriteInput`.
- Enforced registered event schema, aggregate type, UUID aggregate/event IDs, canonical correlation IDs and payload contracts before transaction commit.
- Reused this validation in both persistence producer modules.
- Kept dispatcher validation as a second boundary.

Regression coverage:

- Unsupported event fails atomically with domain transaction.
- Invalid audit correlation and outbox schema fail before commit.

### Medium: event inventory test gave false confidence

The prior inventory test compared event-name literals and did not validate payload/aggregate/version compatibility. The in-memory service emits sequence IDs and is not a UUID-backed integration producer; treating it as one would be misleading. The `organization.role.assigned` contract also differed because the in-memory record included `role`.

Remediation:

- Scoped producer inventory test to persistence outbox producers.
- Added explicit note/test that the in-memory service records are representative internal records, not integration outbox contract producers.
- Extended `organization.role.assigned` schema to accept an optional validated role enum.
- Added producer-contract regression tests.

### Medium: broad prohibited-key matching rejected safe opaque IDs

Global substring matching rejected safe future opaque field names such as `documentId`, `documentVersionId`, and `answerSheetId`, despite per-event allowlists.

Remediation:

- Narrowed prohibited key checks to raw/sensitive field names.
- Added explicit schemas and UUID validation for opaque document and answer-sheet identifiers.
- Preserved rejection of raw document/answer content through event-specific allowlists.

### Medium: correlation-ID grammar was inconsistent

API ingress accepted `[A-Za-z0-9._:-]{8,128}`, while the event package allowed all printable ASCII, including quotes, spaces and backslashes.

Remediation:

- Canonicalized event validation to `[A-Za-z0-9._:-]{8,128}`.
- Applied the same validation to outbox writes and audit writes.
- Updated tests and docs.

### High: expired-event sweeper could clear an active processing lease

`markExpiredOutboxEvents` could mark an active `PROCESSING` row failed and clear its lease solely because `expires_at` had passed, creating a stale-worker publish/ack ambiguity.

Remediation:

- Sweeper now marks expired `PROCESSING` rows failed only after the processing lease has expired.
- Active workers still enforce event expiry before external publish.

Regression coverage:

- Active unexpired processing leases survive expiry sweeping.

### Medium: final-attempt crash could publish after max attempts

Attempts are claim attempts. Before remediation, a row reclaimed after the final allowed claim could exceed `maxAttempts` and still publish successfully.

Remediation:

- Dispatcher now fails rows whose claimed attempt count exceeds `maxAttempts` before envelope creation or external publish.

Regression coverage:

- Reclaimed final-attempt crash row reaches terminal failure with no publisher call.

### Medium: exported terminal failure helper accepted free-form messages

`markOutboxTerminalFailure` accepted caller-supplied text, risking raw exception, provider response, stack, credential or personal data persistence.

Remediation:

- Terminal failure helper now accepts only bounded failure classes and stores fixed safe messages.
- Retryable failure state stores class only.

Regression coverage:

- Terminal failure message is fixed and contains no raw sensitive text.

## Rejected or already-controlled hypotheses

- Cross-tenant authorization: repository/database constraints and service tests cover membership scope, institution hierarchy, employer grant scope and request-path tenant substitution.
- Temporal institution access: helper, in-memory service and persistence query align on `effective_from <= activity_at < effective_to`; malformed `TRANSFERRED` and `GRADUATED` open-ended rows are rejected.
- Lease ABA/stale worker completion: completion helpers require lease owner, lease token and unexpired lease; stale completion tests pass.
- Publish/ack ambiguity: a lost lease after successful publish raises `OutboxReconciliationRequiredError` for operator reconciliation rather than silently retrying.
- Replay abuse: ordinary replay accepts only non-expired `FAILED` rows, preserves original event ID/payload and writes an audit event.
- Consumer idempotency: PostgreSQL uniqueness on `(consumer_name, event_id)` plus transaction/savepoint behavior prevents duplicate successful effects and preserves retry after failure.
- SQL/migration destructive rewrite: migrations are additive; `0003` backfills only missing lease tokens for valid active `PROCESSING` rows and adds constraints.
- CI/supply chain: `phase1-ci` includes frozen lockfile install, typecheck, test, build and `db:migrate`; lockfile is committed.
- Secrets: no production credentials or hidden `.env` files were read; no runtime V4/n8n/AWS integration was added.

## Migration validation

- Clean PostgreSQL 16 migration with `corepack pnpm db:migrate` applied `0000`, `0001`, `0002`, and `0003`.
- Staged `0002 -> 0003` upgrade applied successfully after seeding a valid pre-0003 `PROCESSING` outbox row; `lease_token` was backfilled.
- Post-0003 probes rejected invalid outbox lease state, open-ended `TRANSFERRED`, and open-ended `GRADUATED` rows with named check constraints.

## Test evidence

Local validation completed against disposable PostgreSQL 16:

- `corepack pnpm install --frozen-lockfile`
- `corepack pnpm -r typecheck`
- `corepack pnpm -r test`
- `corepack pnpm -r build`
- `corepack pnpm db:migrate`
- staged `0002 -> 0003` migration validation

New/updated tests cover:

- write-time rejection of unsupported events;
- producer-to-registry contract compatibility;
- `organization.role.assigned` role payload contract;
- safe opaque future ID naming;
- canonical correlation-ID grammar;
- active lease versus expiry sweeper behavior;
- final-attempt crash and reclaim behavior;
- no raw terminal failure text persistence;
- concurrent consumer duplicate execution;
- replay state restrictions;
- clean and upgrade migration behavior.

## Residual risks

- EventBridge/SQS infrastructure remains deferred and must receive its own IAM, queue policy, replay, DLQ, encryption and monitoring review.
- n8n/V4 integration remains documentation-only in this PR; any future implementation requires separate Product, Legal/Privacy, Security and SRE approval.
- Historical access semantics for `ENDED` relationships remain intentionally narrow pending a future retention/product decision.

## Merge recommendation

APPROVE WITH FOLLOW-UP after remote CI passes and the PR remains draft until Product Owner authorization to merge.

Follow-up is limited to the deferred infrastructure/integration reviews above; no blocker remains in the Phase B reliable-event foundation after the applied remediation.
