# Governed V4 integration

Status: implemented pilot on `agent/v4-n8n-complete`. V4 remains evidence/reference input, never a runtime database.

## Frozen evidence and assessed slice

- Repository: `https://github.com/PVUD14/V4--Database`
- Commit: `0c067ce24f92662daa933edf0fc8b75636d99469`
- Assessed registry: `data/question-registry-approved.json`
- Registry SHA-256: `ad9b2ac75613fafbf132e6538db589461e562fe959c78fe49eb71760d264fdad`
- Career Readiness candidates assessed/staged: 11
- V4 candidates released: 0
- V4 candidates quarantined: 11

Every candidate has unresolved rights, SME, and quality review state. The staging manifest at `data/career-readiness/v4-staging-manifest.json` therefore marks all 11 records ineligible. No ownership or license clearance was inferred.

No V4 user, credential, session, MFA, payment, local path, learner history, readiness score, or synthetic interview score is read or imported.

## Deterministic package and provenance model

`@planthepath/career-readiness` validates the manifest, canonicalizes it, hashes it, and derives a stable package identity. `stageImportManifest` commits a package and all source rows in one transaction. Replaying the identical package returns the existing identity; changing content under that identity fails.

Migration `0004_v4_career_readiness.sql` adds migration runs, source packages, immutable source records, validation results, canonical mappings, record-level source evidence/review state, and fail-closed release manifests.

Source evidence is append-only. Canonical mappings may reject or quarantine a candidate; staging never publishes content automatically.

## Rights and clearance policy

A source record is eligible only when all required conditions are explicit: rights cleared, SME approved, quality approved, canonical mapping accepted/merged, not a duplicate, release approved, and no rejection codes. A release manifest containing an ineligible source row is rejected by a database trigger.

Operations APIs expose run summaries and record-level provenance/review state without exposing a source database:

- `GET /api/v1/operations/career-readiness/imports`
- `GET /api/v1/operations/career-readiness/imports/:migrationRunId/records`
- `GET /api/v1/operations/career-readiness/status`

All routes require a current active Platform Super Admin or Operations Admin role.

## Authored pilot release

Because V4 clearance is unresolved, the released `Career Readiness Fundamentals` pilot is newly authored PlanThePath content at `data/career-readiness/pilot-v1.json`. It contains two topics, three prerequisite-aware lessons, six reviewed questions, and a deterministic four-question assessment blueprint. The release uses separate existing author, reviewer, and publisher users. It does not convert a quarantined V4 record into released content.

## Governance and rollback

The content lifecycle is Draft -> In Review -> Changes Requested -> Approved -> Published -> Archived. Database guards reject author self-approval and mutation of published revisions. Rollback publishes or selects an earlier immutable release manifest; released rows are never destructively rewritten.

Deployment gate: stage V4 first, inspect all rejection and review state, publish only a hash-validated manifest whose records are eligible, and retain the previous manifest for rollback.
