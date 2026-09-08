# ADR-027 — Institution Access to Student Document Evidence

**Status:** Accepted
**Decision date:** 2026-09-08
**Scope:** When institution staff may open a student's uploaded document, and what a staff action's evidence reference does and does not grant
**Relates to:** ADR-019 — Institution Visibility of Student Applications, whose mechanism this reuses

## Context

`staff_actions` carries `evidence_document_version_id`, so an academic verification can cite the
exact marksheet or certificate it was decided against. The column exists and the foreign key
resolves. Nothing reads it, because there is no rule saying when institution staff may open a
student's document.

Today documents are strictly student-only. `student-documents.controller.ts` scopes every read to
`context.authorization.principal.userId`, and bytes are served solely through the
`readable_stored_files` view, which admits a file only when it is STORED, CLEAN and not deleted.
There is no institution path at all, and adding one is the single largest widening of document
access the product has attempted.

Stream C raised the requirement precisely, and the hardest part of it is a negative: **retaining an
audit reference must not imply continued access to what it references.** A verification decided in
March is a permanent record; the marksheet behind it is not permanently readable because of that.

## Decision

**Institution staff may open a specific student document version only when all four hold, checked on
every request:**

1. The student has granted a **distinct, revocable consent for that document version**.
2. The institution's relationship with that student is **active at the time of reading**.
3. The reader holds a **reviewer role** in that institution — `INSTITUTION_OWNER`,
   `INSTITUTION_ADMIN`, `PLACEMENT_ADMIN`, `DEPARTMENT_HEAD` or `FACULTY_LECTURER`.
4. The file passes the existing `readable_stored_files` conditions.

No condition is sufficient alone, and none is inferred from a staff action.

### Consent is per version, never per document

`student_document_versions` is already immutable and uniquely bound to one `stored_files` row.
Consent attaches there.

Granting access to version 2 of a marksheet grants access to *that scan*. Uploading version 3 grants
nothing: the student consents again, or the newer file stays private. A consent that followed the
document rather than the version would silently widen every time a student replaced a file, which is
exactly the failure mode this ADR exists to prevent.

### An evidence reference is a citation, not a key

`staff_actions.evidence_document_version_id` records **which** version a decision was made against.
It confers no read access whatsoever. Access is evaluated independently on every request against the
four conditions above.

Consequently a staff action can outlive its evidence's readability, and that is correct. The action
keeps its reference, its audit trail and its outcome; the document behind it closes when consent is
withdrawn or the relationship ends. Staff surfaces must render an unreadable reference as a plain
statement that the evidence is no longer available, never as an error and never as a broken link.

### Relationship end closes access immediately

When the institution-student relationship ends, transfers, graduates or is revoked, access stops
from that moment. It is not scoped to the activity date the way DP-010 scopes reading past activity,
because a document is not an event: there is no moment it "happened" that a former institution could
still be entitled to.

A graduate's former college keeps its verification records. It does not keep their certificates.

### Metadata is narrower than the file

Where staff may see that evidence exists without meeting all four conditions — listing a
verification, for instance — they see the document title, its type and its version number. They do
not see the filename, which students routinely name in ways that disclose more than they intend, and
they do not receive a download link.

## Why not the alternatives

**Institution-granted access.** Letting an institution authorize itself to read documents it did not
create would invert the product's central claim, that a student's record is theirs and disclosure is
consented. It was rejected without much difficulty.

**Access implied by the staff action.** Convenient, and wrong. It would make every historical
verification a standing key to a private file, and there would be no moment at which access ended
short of deleting the action — which would destroy the audit trail to close a permission.

**A blanket institution-visibility flag on the document.** Simpler to build, but it cannot express
"this scan, for this verification". Consent that cannot be scoped is consent that gets granted once
and forgotten.

## Consequences

- A new consent surface is required on the student's own document screens: grant per version, see
  what is currently shared, and revoke. A consent that cannot be withdrawn is not consent.
- Revocation takes effect on the next request. There is no cached authorization and no signed URL
  outliving the check, which means download links must be short-lived and re-authorized rather than
  stable.
- Every document read by staff is audited with actor, document version, correlation id and outcome.
  Denials are audited too: an attempt to open a withdrawn document is exactly the event a security
  review would want.
- Institution staff surfaces gain a state they must handle: *referenced but not readable*. It is the
  normal end state of an old verification, not an error.
- Ownership: the consent column and the student-facing grant and revoke belong with the document
  owner in Core; the staff read path and its surfaces are Stream C. Neither should implement the
  other's half, and the read path must not ship before the consent it depends on.
- Migration numbers are not allocated here. Circulate the table design first, as the migrations rule
  requires.
