# Where the invitation token lives between creation and delivery

**Status:** Circulated for comment — blocks build-plan item 1.7 (real notification templates)
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Relates to:** ADR-021 (email delivery), ADR-028 (the outbox is the transport)

## Why this exists

Build-plan item 1.7 reads "real subject/body templates per workflow, replacing the
placeholder body." It looks like a content task. It is not, and it should not be picked
up as one.

`ensureInvitationNotificationTemplate` currently writes the body
`'Invitation link is rendered only in the ephemeral local/test delivery sink.'` The real
body already exists a few lines above it as `textBody`, complete with the invitation URL
— but it is handed straight to the local Mailpit sink and never reaches the template.

That is not an oversight anyone forgot to finish. It is the only arrangement that
currently keeps a promise the schema makes.

## The constraint

`invitations` stores `token_hash`, never the token. The plaintext single-use token exists
only in memory, between `generateInvitationToken()` and the synchronous local sink. Once
the request ends, nobody — including us — can reconstruct the link.

A real body template needs the link. The workflow service renders from
`notification_commands.render_parameters`, which today holds `{ invitationId, role }`.
So making the template real means putting the invitation URL, and therefore the
plaintext token, into `render_parameters`.

**That would undo the hashing.** A single-use credential would sit at rest in a jsonb
column, in a table with a retention policy written for delivery bookkeeping rather than
for secrets, readable by anything that can read the notification ledger. Hashing the
token in `invitations` while storing it in plaintext one table over is not a security
posture, it is a rounding error.

## The options, none of which is a content edit

1. **Token in `render_parameters`, with compensating controls.** Shortest path. Needs at
   minimum: encryption at rest for that column, a retention rule that deletes the
   parameters at delivery rather than at command expiry, and an explicit decision that a
   14-day invitation token may sit in the database for its lifetime.
2. **Deliver synchronously at creation**, as the Mailpit sink does today, and let the
   notification ledger record an attempt rather than carry the payload. Keeps the token
   out of the database entirely. Contradicts ADR-021, which deliberately moved delivery
   off the request path — though ADR-021's reasoning was about third-party network calls
   in a request handler, which this still is.
3. **Mint the link at dispatch.** The worker, not the controller, generates the token,
   writes the new hash to `invitations`, and renders the body. The token is never
   persisted in plaintext and never crosses a table boundary. Costs: the dispatcher gains
   write access to `invitations`, and a replay must not mint a second valid token — which
   the existing idempotency machinery can carry, but deliberately, not by accident.
4. **A short-lived exchange reference.** `render_parameters` holds an opaque one-time
   reference; the link resolves it to the real token at click time. Most moving parts,
   best separation.

**Proposal: option 3.** It is the only one that both keeps ADR-021's boundary and keeps
the token unpersisted, and the outbox already gives the dispatcher the idempotency it
needs. It is also the one that most changes who may write to `invitations`, so it is a
decision rather than an implementation detail.

## Until this is settled

The placeholder body stays. Shipping a template with the token in `render_parameters`
because the task was filed as "write the copy" is the failure mode this note exists to
prevent — it would be a quiet, permanent downgrade of how invitations are stored,
introduced by a change nobody would think to review for it.

The rest of the delivery chain is unaffected and already works: invitations emit
`notification.delivery.requested`, the consumer selects its workflow from the registry,
and the worker will dispatch. What lands in the reader's inbox is the last open question,
not the plumbing.
