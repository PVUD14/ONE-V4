# Managed Identity Authentication Integration

Status: Draft PR 10 implementation note
Scope: Phase 1 managed identity authentication boundary only

## Request authentication flow

1. The browser presents a Cognito-issued bearer access token to the Core API.
2. The server extracts the bearer token from the authorization header and verifies it with the configured trusted verifier.
3. Token verification must prove signature, issuer, client/audience binding, expiration, not-before where present, token use, subject claim, supported algorithm, and trusted key ID.
4. The verified Cognito `sub` is mapped to an internal PlanThePath user through server-side persistence.
5. The current internal account state is loaded. Non-`ACTIVE` accounts are denied even when the Cognito token remains cryptographically valid.
6. Current active organization memberships are loaded from persistence for the request.
7. A client-supplied organization ID may only be used as a candidate context. The server selects it only if the authenticated user currently has an active scoped membership in that organization.
8. Application services continue to perform role, scope, temporal, relationship, grant, and privileged-operation authorization. Middleware/controller code does not duplicate or replace the application role model.

## Trust boundary

- Cognito authenticates the external human identity.
- The authentication boundary converts a verified token into an internal principal.
- Persistence maps external subject to immutable internal user identity and current memberships.
- Application services own PlanThePath authorization decisions.
- Controllers/routes remain transport adapters and must not trust client-supplied user, organization, role, scope, institution, employer, or student identifiers.

## Implemented controls

- Cognito adapter remains based on `aws-jwt-verify` per ADR-017.
- A standards-compliant local JWT verifier is included for deterministic security tests of signature, issuer, audience/client, expiry, not-before, token-use, key ID, and algorithm rejection behavior.
- Authorization context construction rejects unknown and suspended internal accounts with generic external failure behavior.
- Current active memberships are reloaded for each request context and inactive memberships are filtered out.
- Organization context selection is server-side and requires a current active membership.
- Invitation tokens are generated with cryptographic randomness, persisted only as SHA-256 digests, and compared with constant-time digest comparison.
- Invitation acceptance through persistence requires both the stored token digest and the normalized verified recipient email from the authenticated identity.
- Audit/outbox payloads for invitation acceptance contain invitation/user identifiers only, not raw invitation tokens or token hashes.

## Deferred integration

- NestJS controllers/guards and OpenAPI contracts remain a later API-route slice.
- Full Cognito hosted UI/session/BFF cookie handling remains a later edge/API integration slice.
- End-to-end role-assignment concurrency remains partially integrated: PR 9 provides membership locking and uniqueness, while each security-sensitive application operation must call the lock primitive in its transaction.
- End-to-end employer grant revocation concurrency remains partially integrated until concrete employer opportunity/application operations are implemented.
- Employer opportunity/application/consent tables remain out of scope for this slice; current grant checks use the Phase 1 grant table.
- MFA, step-up authentication, privileged-session freshness, and global sign-out workflows remain governed by ADR-017 and future privileged-access slices.
