# ADR-019 — Institution Visibility of Student Applications

**Status:** Accepted
**Decision date:** 2026-09-05
**Scope:** What an institution may see about its own student's application to an employer
**Blocks:** Placement operations (pipeline, applications, interviews, offers, employer engagement)

## Context

The placement domain cannot be built until this is settled. No controller currently offers an
institution any path into employer-side application data: the hiring endpoints are all
`/employers/:employerId/...` and authorize on employer membership. Placement Phase 2 — pipeline,
applications, interviews, offers, employers — needs one, and building it before the rule is written
would produce a data path we would have to withdraw.

Two of the three relationships involved are already specified and enforced:

- **Institution to student.** Invariant 4 and DP-010: access is relationship- and time-scoped, and a
  former institution must not see post-relationship activity. Already implemented as
  `GET /institutions/:institutionId/student-activity-access/:studentUserId`.
- **Student to employer.** Invariant 5 and DP-011: employer candidate access is opportunity- and
  consent-scoped. Already enforced in the schema — `applications.consent_granted_at` /
  `consent_revoked_at`, with a CHECK that a submitted application must carry explicit consent and a
  revoked consent must not predate its grant.

The third — **institution to its student's application** — is specified nowhere. The consent the
student grants at application time is consent for *the employer* to see them. It is not a general
waiver, and reading it as one would be exactly the kind of scope creep the other two invariants
exist to prevent.

## Decision

**An institution may see a per-student application record only where the student has granted a
distinct, revocable institution-visibility consent for that application, and the institution's
relationship with that student is active at the time of reading.**

Both conditions, every time. Neither is sufficient alone.

This mirrors the mechanism already proven for employer visibility rather than inventing a second
one.

### What is disclosed when consent is present

- Employer identity and opportunity title
- Application stage and its key timestamps
- Whether an offer exists, and its response state

### What is never disclosed, consent or not

- **Offer compensation terms.** Visible to the student and the employer only. If placement reporting
  later needs compensation, that is a separate decision amending this ADR — not an implementation
  detail to be settled in a pull request.
- The student's documents, private AI conversations, or readiness snapshots. Invariant 6 and the
  `employer_visible` CHECK on `readiness_snapshots` are unaffected by this ADR and are not relaxed
  by it.

### Aggregate reporting

Counts and stage distributions across an institution's own cohort do **not** require per-application
consent, because they disclose no individual. They remain bounded by DP-010: a student who leaves
the institution leaves its aggregates from the relationship end date forward.

This is what makes most of the placement dashboards buildable before the consent field ships.

## Implementation

Mirror the employer consent columns rather than paralleling them with a different shape:

```sql
ALTER TABLE applications
  ADD COLUMN institution_visibility_granted_at timestamptz,
  ADD COLUMN institution_visibility_revoked_at timestamptz,
  ADD CONSTRAINT applications_institution_visibility_order_ck
    CHECK (institution_visibility_revoked_at IS NULL
           OR (institution_visibility_granted_at IS NOT NULL
               AND institution_visibility_revoked_at >= institution_visibility_granted_at));
```

Deliberately **not** mirrored: the employer CHECK requiring consent on every submitted application.
Institution visibility is optional. A student may apply without sharing it with their institution,
and an application with both columns null is valid.

Read path: an institution row is returned only when
`institution_visibility_granted_at IS NOT NULL AND institution_visibility_revoked_at IS NULL`
**and** the institution-student relationship is active for the application's date, reusing the
existing activity-access check rather than a second implementation of DP-010.

### Coordination

This crosses two streams and the split is deliberate:

- **Stream B (Hiring)** owns `applications`, so the migration and the student-side capture and
  revocation are Manisha's, in migration block 0017–0019.
- **Stream C (Institution)** owns the institution read path and the placement screens.

Navya should not add a column to a Stream B table, and Manisha should not build the institution
endpoint. Aggregate reporting has no dependency on either and can start immediately.

Consent must be capturable at application time and revocable afterwards from the student's own
screens; a consent that cannot be withdrawn is not consent.

## Consequences

- Placement Phase 2 is unblocked. Aggregate work starts now; per-student work starts when the
  consent field lands.
- Students who share nothing are invisible to their institution's per-student placement views by
  design. Placement officers will ask for this to be relaxed. The answer is no without a new ADR.
- A revoked consent must remove the student from institution views immediately, in the same way a
  revoked employer consent already stops the employer seeing candidate details.
- Notice text at the point of consent is required before this ships, and is a privacy-review item,
  not a UI copy decision.
