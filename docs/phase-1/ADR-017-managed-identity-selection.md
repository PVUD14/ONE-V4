# ADR-017 — Managed Identity Selection and Authorization Boundary

**Status:** Accepted for V1
**Decision date:** 2026-08-16
**Scope:** Human-user authentication for Student, Institution, Employer, and Platform Operations portals

## Decision

Use **Amazon Cognito user pools** as the V1 managed identity provider. Server-side Node.js services validate Cognito access tokens with `aws-jwt-verify` (or an equivalent standards-compliant verifier if this ADR is later amended).

Cognito authenticates users. **PlanThePath authorizes users.**

IdP groups, custom claims, federated-provider claims, or OAuth scopes must never be sufficient by themselves to grant institution, employer, student-record, or platform-administration access.

## Authentication boundary

```text
Browser / mobile web
  -> Cognito local or federated sign-in
  -> access/ID/refresh token set
Core API
  -> verify JWT signature, issuer, client, token use, expiry
  -> map Cognito `sub` to immutable internal user ID
  -> load current PlanThePath account state
  -> load current memberships, relationships, grants and scopes
  -> evaluate RBAC + scoped/temporal ABAC
```

The spike includes a tested adapter boundary where a valid external token is rejected if the corresponding internal account is suspended or unknown.

## Why Cognito

Cognito user pools support the required V1 and expansion paths:

- local user-pool authentication;
- email verification;
- MFA capabilities;
- Google/social federation;
- OIDC and SAML federation for future institutional SSO;
- standard access, ID and refresh tokens;
- hosted/managed authentication endpoints where appropriate;
- token revocation, global sign-out and administrative global sign-out.

AWS documents `aws-jwt-verify` as the recommended Node.js library for Cognito JWT validation, including signature, expiry, user-pool/client and token-use validation with JWKS caching/rotation support.

## Critical revocation limitation

Cognito token revocation does not remove the cryptographic validity of a previously issued self-contained JWT when a generic JWT verifier checks only signature and expiration. Therefore PlanThePath must not rely on token revocation alone for immediate business-access shutdown.

For protected requests the API loads current internal account state and current authorization context. A suspended/deleted account, ended institution relationship, suspended membership, revoked employer applicant grant, or revoked privileged session must fail even when the presented JWT remains otherwise valid.

## Session policy

- Access tokens must be short-lived within practical UX constraints.
- Refresh tokens are never exposed to application JavaScript when a secure server-managed/BFF session architecture can avoid it.
- Tokens must not be stored in browser localStorage.
- Logout revokes the applicable refresh/session token and clears the application session.
- Security/operations actions may additionally use `AdminUserGlobalSignOut` or equivalent administrative revocation.
- Privileged platform roles require stronger MFA and may use shorter session/reauthentication windows.
- High-risk administrative operations can require step-up/recent authentication independent of ordinary session validity.

## Federation policy

V1 may support Google sign-in where product scope requires it. Microsoft/enterprise federation remains compatible through OIDC or SAML without changing the internal authorization model.

External identity-provider attributes are identity/profile inputs, not PlanThePath authorization grants.

## Environment separation

Development, test/staging, and production use separate user pools/app clients/configuration. Production users and credentials are never copied into non-production environments. Automated test identities are explicitly marked and isolated.

## Internal identity mapping

`Cognito sub -> PlanThePath users.id`

The internal user ID is the stable foreign key used by business domains. Email addresses and federation usernames are mutable attributes and must not be used as durable authorization identifiers.

## Consequences

Positive:

- managed password/MFA/federation lifecycle rather than custom authentication infrastructure;
- standard OIDC/OAuth integration path;
- future institutional SSO without redesigning business authorization;
- application-owned authorization remains testable and independent of IdP configuration.

Costs:

- Cognito configuration becomes security-critical infrastructure as code;
- logout/revocation semantics require API-side compensating controls;
- federation account-linking and duplicate-email cases require explicit workflows;
- privileged-access policies require additional application/session enforcement beyond basic Cognito token verification.
