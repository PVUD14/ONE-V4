# Repository Governance

## Branching

- `main` is the protected integration branch.
- All non-emergency changes use short-lived branches prefixed `agent/`, `feat/`, `fix/`, `docs/`, or `chore/`.
- Direct feature commits to `main` are prohibited after repository bootstrap.
- Pull requests are required for material changes.

## Required review

Architecture, authorization, privacy, readiness scoring, employer accountability, AI safety, Trust & Safety, production IAM, and data-retention changes require architecture/security review in addition to ordinary code review.

## Pull-request gates

Before merge, applicable checks must pass:

- formatting/lint/type checks
- unit and integration tests once code exists
- authorization/tenant-isolation tests for protected resources
- secret-pattern check
- dependency/SCA scan
- SAST
- IaC scan when infrastructure exists
- migration validation for schema changes
- API compatibility check after contract generation exists

No failed critical security gate may be bypassed without a documented risk acceptance.

## Change control

Material deviation from the approved architecture requires an ADR. High-risk production changes require reason capture and auditable approval.

## Security rules

- No production secrets, tokens, private keys, credentials, PII exports, or real student/employer datasets in Git.
- No production data in local development or lower environments unless explicitly approved and irreversibly de-identified.
- No direct database editing from admin portals.
- No AI provider may receive data outside its approved minimum context.

## Commit/PR expectations

Commits should be scoped and descriptive. PR bodies must state what changed, why, security/privacy impact, validation performed, migrations/config changes, and rollback considerations.

## Ownership

Until team CODEOWNERS identities are finalized, the repository owner acts as final Product/Architecture approver. Named team ownership must replace this temporary arrangement before production GA.