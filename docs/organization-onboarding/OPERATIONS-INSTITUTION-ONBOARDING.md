# Operations and Institution Onboarding V1

This slice separates platform Operations ownership from Institution Administration ownership.

## Ownership boundaries

Operations owns platform organization onboarding:

- create Institution and Employer organizations;
- maintain platform-owned organization master/profile metadata;
- transition organization verification state through the supported lifecycle;
- suspend organizations;
- persist initial administrator invitations;
- inspect onboarding, audit and outbox evidence.

Operations does not own student lifecycle. Operations routes intentionally do not expose add-student, roster import, relationship transfer, graduation, end relationship, assessment answer, readiness edit or academic-record controls.

Institution Admin owns institution administration:

- manage institution-scoped academic units;
- list and add institution students;
- validate and commit CSV roster imports;
- maintain institution-owned academic placement metadata;
- transfer, graduate, end or revoke a student relationship without deleting global identity/history;
- assign only allowed institution staff roles.

## Organization lifecycle

Organizations remain authoritative in `organizations`; subordinate onboarding metadata lives in `organization_profiles`.

Verification states are:

- `PENDING`
- `UNDER_REVIEW`
- `VERIFIED`
- `REJECTED`
- `SUSPENDED`

Allowed API transitions are:

- `PENDING -> UNDER_REVIEW`
- `UNDER_REVIEW -> VERIFIED`
- `UNDER_REVIEW -> REJECTED`
- `VERIFIED -> SUSPENDED`
- `SUSPENDED -> UNDER_REVIEW`
- `SUSPENDED -> VERIFIED`

Each transition appends `organization_verification_events`, writes `audit_events`, and emits a minimized outbox event containing only opaque identifiers/status.

## Invitation boundary

Initial organization administrators are invited through `invitations`; the API does not fabricate an active authenticated identity. Invitation acceptance remains bound to the existing verified identity flow.

## Student lifecycle

Institution-owned roster metadata lives in `institution_student_profiles`; temporal access remains in `institution_relationships`.

There is no normal delete-student operation. Relationship-ending actions update relationship state/effective end time while preserving the global user row, roster evidence, audit records and outbox evidence.

## CSV import safety

V1 accepts CSV only. The import API:

- bounds payload size and rows;
- requires known columns;
- treats formula-prefixed cells as text;
- validates emails and required student IDs;
- detects duplicate student IDs/emails in-file;
- rejects rows whose email already belongs to an existing global user, avoiding cross-institution account attachment during bulk import;
- validates referenced department, program, batch and section names against the institution's academic units;
- persists preview rows before commit;
- commits only validated rows;
- records aggregate import metadata, not full roster PII, in audit/outbox events.

## Known UAT identity blocker

Protected APIs require the existing verified request principal and active memberships. If no approved non-production Cognito identities are available, interactive authenticated UAT remains blocked. This implementation intentionally does not add role-selection auth, fake JWTs, query-parameter impersonation, or browser-supplied user IDs.
