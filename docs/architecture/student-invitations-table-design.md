# Student Invitations — Table Design

**Status:** Adopted (INST-01), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0037_student_invitations.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

A college can add a student one at a time or import a roster, and both paths create a `users` row
with `state = 'INVITED'`, `external_subject = NULL`, an `INVITED` roster profile and an `ACTIVE`
relationship. Nothing ever invites that person. Sign-in resolves users only by `external_subject`
and requires `ACTIVE`, so **a rostered student cannot sign in at all** (INST-00, defect I-1,
reproduced). The profile also never becomes `ACTIVE`, so even an activated student would stay
invisible to staff actions, assessment assignment and hiring joins.

The machinery to fix this already exists for staff. `invitations` holds a hashed, single-use,
expiring token; `/invitations/accept` requires a verified email that matches the invitation, binds an
existing `users` row found by that email to the caller's identity, sets it `ACTIVE` and consumes the
token in one transaction. What is missing is a student kind of invitation, a way to send it that does
not block an import, delivery state a college can see, and resend.

## Decision: extend `invitations`, do not add `student_invitations`

**Chosen.** Add a `kind` to `invitations` (`STAFF` default, `STUDENT`) plus delivery columns. A
student invitation is `kind = 'STUDENT'`, `role IS NULL`, `organization_id` = the institution,
`student_user_id` = the pre-created roster user.

**Rejected: a dedicated `student_invitations` table.** It would duplicate the token hashing, expiry,
single-use consumption, the "one pending invitation per email per organisation" index and — most
importantly — the accept transaction, which is the security-critical part. Two accept paths drift;
one path with a `kind` branch does not. The existing scope trigger (`enforce_invitation_scope`, 0001)
requires a role on every organisation-scoped invitation, so 0037 redefines it with a **stricter**
student branch in front — institution only, no role or unit scope, and the invited user must be
rostered at that institution — and leaves the staff logic byte-for-byte as it was. No existing rule
for staff invitations is relaxed.

**Rejected: linking at first sign-in by email, with no invitation.** Decision 10.2 #1 requires
activation by emailed invitation. Linking any sign-in whose email matches a roster row would let
whoever controls an address the college typed claim that student's record, with no act of acceptance
and no single-use proof. The accept step keeps the link deliberate and auditable.

## Columns added to `invitations`

| Column | Notes |
| --- | --- |
| `kind` | text NOT NULL DEFAULT `'STAFF'`, CHECK in (`STAFF`, `STUDENT`). Every existing row is staff. |
| `student_user_id` | uuid NULL → `users(id)`. Required for `STUDENT`, forbidden for `STAFF`. Accept binds exactly this row. |
| `delivery_state` | text NOT NULL DEFAULT `'NOT_SENT'`, CHECK in (`NOT_SENT`, `SENT`, `FAILED`, `BOUNCED`, `NOT_CONFIGURED`). |
| `send_count` | integer NOT NULL DEFAULT 0, ≥ 0. |
| `last_sent_at` | timestamptz NULL. |
| `bounced_at` | timestamptz NULL. Set when the mail sink reports a permanent rejection; later by a provider bounce webhook once a production sender exists (HG-7). |
| `reason_code` | text NULL, `^[A-Z0-9_:-]{3,64}$` — why a resend or revocation happened. |

Constraints: `kind = 'STUDENT'` ⇒ `role IS NULL AND organization_id IS NOT NULL AND student_user_id IS NOT NULL`;
`kind = 'STAFF'` ⇒ `student_user_id IS NULL`. An index on `(organization_id, student_user_id)` for the
roster's activation lookup. The migration is idempotent (`ADD COLUMN IF NOT EXISTS`, constraints
dropped and re-added) because the migrator replays every file on every run.

## Tokens: minted at send time

Only a SHA-256 hash of an invitation token is ever stored, so whoever sends the email must hold the
raw token. The request that creates a student cannot send (it must not block an import of hundreds),
and the worker that sends cannot recover a token from its hash. So **the sender mints the token**:
the invitation is created with a random, never-disclosed hash; the delivery consumer generates a
fresh token, stores its hash, and puts the raw token only into the email. Resending mints again, which
also invalidates the previous link. The token never touches a log, an outbox payload or a response.

## Sending

Creating a student, and committing an import, writes one invitation and one outbox event
`institution.student.invitation.requested` (payload: `invitationId`) per new student, in the same
transaction as the roster rows. The ADR-028 local dispatcher routes that event to
`deliverStudentInvitation`, which runs under `event_consumer_receipts` — a replayed event sends
nothing twice. Inside one transaction it checks the invitation is still a pending, unexpired,
unrevoked student invitation; stores the new token hash, `delivery_state = 'SENT'`, `send_count + 1`,
`last_sent_at`; and sends last. If sending fails the transaction rolls back, so no stored hash points
at an email that was never sent, and the retry mints a new token. A permanent SMTP rejection is
recorded as `BOUNCED` and not retried.

**No production sender exists yet** (email sender set-up is hard gate HG-7). With no mail sink
configured the consumer records `NOT_CONFIGURED` and acknowledges; the invitation stays pending and
is resent from the Students screen once a sender is configured. The email body is a versioned
template (`notification_templates`, stable key `institution-student-invitation`, version 1).

## Accepting

The accept transaction gains a student branch: the verified email must match the invitation (as
today), the `users` row it binds must be the invitation's `student_user_id`, and it additionally sets
that student's `INVITED` roster profile in this institution to `ACTIVE`. The relationship is already
`ACTIVE`. Any mismatch fails with the existing generic `FORBIDDEN` — no message distinguishes "no such
invitation" from "wrong email", so nothing can be learnt about which addresses are rostered.

Acceptance depends on the student's access token carrying `email` and `email_verified`, exactly as
staff acceptance already does. Whether the student pool's tokens carry them is Cognito configuration
(AWS, HG-1) and was not changed.

## Activation state shown to the college

Derived, never stored twice: **Activated** (the student's `users` row is `ACTIVE`), **Bounced**
(latest invitation `BOUNCED`), **Expired** (latest pending invitation past `expires_at`, or `EXPIRED`),
**Invited** (latest invitation pending and unexpired, whatever its delivery state — the delivery
state is shown alongside), **Not invited** (no invitation, e.g. rows created before this change).
The roster response carries these per student and a server-computed summary, which the Dashboard
reads, so the two cannot disagree.

## Resend and revoke

Resend (one student, or many) requires a reason code. If the latest invitation is pending and
unexpired it is re-queued (a new token is minted on send); otherwise it is marked `EXPIRED` and a new
invitation is created. Ending a student's relationship revokes their pending invitation, so an ended
student cannot activate into a relationship that no longer exists. Every create, resend, revoke and
accept is audited.

## Open points (decisions for Divakar)

1. **Sender and domain** (HG-7, Appendix 3 open question): which domain delivers student invitations.
   Until decided, invitations are created and visible but not delivered in production.
2. **Students already on ONE.** A student whose email already has a ONE account (for example a past
   graduate who joined independently) is refused at creation today (`STUDENT_EMAIL_ALREADY_EXISTS`).
   Linking such an account to a new roster row needs its own consent step; not in this change.
