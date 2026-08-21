# ONE Product Convergence V1 security review

Review date: 2026-08-21

Scope: focused diff review of the ONE convergence frontend delta on `agent/one-product-convergence-v1` from base `4ec27b529ad3dd38d46c212759f7e27fa759555c`.

Changed runtime surfaces reviewed:

- `apps/web/src/App.tsx`
- `apps/web/src/rolePortalConfig.ts`
- `apps/web/src/rolePortalPages.tsx`
- `apps/web/src/staffPages.tsx`
- `apps/web/src/staffComponents.tsx`
- `apps/web/src/studentPages.tsx`
- `apps/web/src/careerReadinessApiPanel.tsx`
- `apps/web/src/demoData.ts`
- `apps/web/src/studentData.ts`
- `apps/web/src/styles.css`
- `apps/web/index.html`

Security conclusion: no reportable security regression found.

Evidence:

- `/` and `/login` now render the ONE sign-in entry. They do not mount the student fixture workspace when Cognito is absent.
- `/student`, `/institution`, `/employer`, and `/operations` fail closed for unauthenticated sessions and show a sign-in-required state instead of role selection or fixture data.
- Demo content is reachable only under `/demo`, `/demo/student`, `/demo/institution`, `/demo/employer`, and `/demo/operations`, with visible `DEMO PREVIEW` and fictional-data notices.
- The workspace chooser is presentation-only. It does not grant roles; existing API calls still use `getAccessToken()` and protected backend authorization.
- Invitation acceptance remains protected: the raw invitation token is read from the link for the acceptance request only and is not persisted in browser storage by this delta.
- Existing API/security integration tests still pass, including protected route authentication, verified-recipient invitation acceptance, no raw invitation token in audit/outbox, and staff onboarding by invitation rather than direct arbitrary `userId` attachment.

Residual risks / non-findings:

- Demo routes intentionally expose fictional fixture data. This is not a security finding because the routes are explicitly labeled and do not authenticate or authorize a user.
- The frontend chooser cannot by itself verify a user's final portal family before navigation. Backend APIs remain authoritative and deny unauthorized protected operations; improving the chooser to list only server-returned family memberships is a product hardening follow-up once Cognito/UAT identities are fully provisioned.
- Employer portal remains intentionally partial where backend hiring persistence is incomplete; it does not fabricate protected applicant directories on unauthenticated production routes.

Validation evidence:

- `corepack pnpm typecheck` passed.
- `corepack pnpm test` passed with `DATABASE_URL` pointing at the existing loopback disposable Postgres database.
- `corepack pnpm build` passed.
- `corepack pnpm db:migrate` passed through `0005_organization_onboarding.sql`.
- `PTP_N8N_JWT_CREDENTIAL_ID=ci_jwt_credential PTP_SMTP_CREDENTIAL_ID=ci_smtp_credential corepack pnpm automation:validate` passed.
- `corepack pnpm audit --prod` reported no known vulnerabilities.
