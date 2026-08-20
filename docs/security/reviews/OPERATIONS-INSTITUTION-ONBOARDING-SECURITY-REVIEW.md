# Operations and Institution Onboarding Security Review

Review target: working-tree diff from `f376406f996490f0b74ac6a8f2c93f374d973f99`.

Preflight: `codex-security:security-diff-scan` parent-only path, ready with delegated-worker warning. TAC advisory: granted `tac1`.

## Conclusion

No unresolved reportable security blocker found in the final reviewed diff.

The change is security-sensitive because it adds protected organization, administrator invitation, institution roster, staff-role and CSV import mutation surfaces. The implemented controls preserve the requested ownership split: Operations can manage organization onboarding, while Institution Admin owns students and academic structure.

## Files reviewed

- `packages/persistence/drizzle/0005_organization_onboarding.sql`
- `packages/persistence/src/schema.ts`
- `packages/persistence/src/identity-authentication.ts`
- `packages/events/src/index.ts`
- `apps/api/src/http/operations-institution-onboarding.controller.ts`
- `apps/api/src/http/api-security.ts`
- `apps/api/src/http/api-security.module.ts`
- `apps/api/src/http/api-security.integration.spec.ts`
- `packages/persistence/test/identity-authentication.integration.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/rolePortalConfig.ts`
- `apps/web/src/rolePortalPages.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/styles.css`

## Security properties verified

- Protected API routes use `ProtectedApiAuthenticationGuard`; no role-selection, `?userId=`, `?role=`, fake JWT or Cognito bypass was added.
- Operations authorization requires active `PLATFORM_SUPER_ADMIN` or `OPERATIONS_ADMIN` membership.
- Institution student/unit/staff APIs require active institution-scoped membership.
- Operations routes with target organization IDs use `:targetOrganizationId`, avoiding accidental membership selection against the target institution/employer while still requiring platform Operations authority.
- Institution Admin cannot create platform organizations.
- Operations cannot add institution students.
- Institution Admin cannot assign platform roles or self-escalate.
- Initial administrator invitations keep the cryptographically random raw token ephemeral: only the hash is stored in `invitations`, and the normal API response, audit rows, outbox payloads, notification command rows and Operations list/detail records do not include the raw token.
- Local UAT invitation delivery is explicitly opt-in and loopback-only through Mailpit. The sink rejects non-loopback SMTP hosts and records only bounded delivery metadata.
- Invitation acceptance still requires a verified identity whose verified email matches the invitation recipient, preserves expiry/revocation/single-use/idempotency semantics, and now safely supports an existing matching verified user while rejecting ambiguous or conflicting identity bindings.
- Institution staff onboarding was tightened: the staff endpoint now creates a scoped invitation for allowed institution roles instead of directly attaching an arbitrary global `userId` to an institution membership.
- Student relationship lifecycle uses explicit transfer/graduate/end/revoke semantics and preserves user/history rows.
- CSV import bounds payload size/row count, validates required fields, rejects duplicate existing emails instead of silently attaching an institution relationship to an unrelated global user, validates referenced academic unit names, treats formula-prefixed cells as text, persists preview before commit, and avoids raw HTML rendering.
- Outbox event schemas reject unexpected or sensitive payload keys; new events carry opaque IDs/status only.
- Audit rows include actor, organization, resource and correlation ID.
- UI protected screens fail closed without an access token and do not mix preview rows into authenticated management tables. Operations organization create/edit/verify/suspend/invite actions call protected APIs rather than local preview mutation.

## Residual risks / hardening notes

- Interactive authenticated UAT remains blocked until approved non-production Cognito identities exist.
- The V1 CSV parser is intentionally small and CSV-only; keep row/file limits conservative before accepting larger institutional imports. It validates academic unit names for safety, but import commit currently stores the student profile without resolving those names into unit ID columns.
- Staff UI is intentionally minimal; the protected API now uses invitation/verified-recipient consent, and richer staff management UX should preserve the same allowed-role list, no-`userId` direct attachment policy, and self-escalation guard.
- Organization update API has basic validation and audit/outbox coverage; future optimistic concurrency/version headers would further reduce accidental lost updates.

## Evidence

- API integration tests cover Operations organization creation/verification, initial administrator invitation delivery, raw-token absence from durable records/API response, wrong-recipient denial, unverified-recipient denial, correct verified acceptance, idempotent same-key replay, rejected new-key replay, expired/revoked denial, Institution Admin denial on platform-controlled organization-admin invitation creation, Operations denial on student creation, Institution Admin student add/end relationship, duplicate existing student-email rejection, self-escalation denial, platform-role assignment denial, invitation-based staff onboarding, and roster CSV preview/commit with unknown-unit and existing-email rejection.
- Focused post-change security review: `codex-security:security-diff-scan` preflight was `ready` with parent-only delegated-worker warning; TAC advisory was granted `tac1`. No reportable security finding was identified in the final invitation/staff-onboarding delta.
- Local clean migration `0000 -> 0005` passed.
- Local upgrade migration `0000 -> 0004 -> 0005` passed.
- UAT loopback database reseeded with organization profiles and institution student profiles; Aanya/Rohan persona split verified.
- Local validation on the final reviewed working tree:
  - `corepack pnpm --filter @planthepath/api test`: passed, 46 tests.
  - `corepack pnpm --filter @planthepath/persistence test`: passed, 56 tests.
  - `corepack pnpm --filter @planthepath/web test`: passed, 87 tests.
  - `corepack pnpm test`: passed across web, authorization, career-readiness, events, identity, automation, persistence and API packages.
  - `corepack pnpm typecheck`: passed.
  - `corepack pnpm build`: passed.
  - `corepack pnpm db:migrate`: applied through `0005_organization_onboarding.sql` on the isolated loopback database.
  - Phase B upgrade validation: applied `0000` through `0003` to a fresh loopback database, then `corepack pnpm db:migrate` applied current migrations successfully.
  - `corepack pnpm audit --prod --audit-level=high`: no known vulnerabilities found.
  - `PTP_N8N_JWT_CREDENTIAL_ID=ci_jwt_credential PTP_SMTP_CREDENTIAL_ID=ci_smtp_credential corepack pnpm automation:validate`: passed, six inactive email-only hash-pinned workflows.
  - n8n materialization with synthetic CI credential IDs produced six workflow deployment copies; Docker Compose local Mailpit profile config validation passed.
