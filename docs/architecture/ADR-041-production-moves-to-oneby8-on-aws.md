# ADR-041 — Production moves to oneby8.com on AWS

Records where ONE is served from once the move off the VPS happens, and which
names change with it.

- **Status:** Accepted (Divakar, 2026-09-30)
- **Supersedes:** the hosting assumption in `deploy/vps/README.md` and `docs/ops/*`
  that production is `one.ai8ht.pro` on the VPS. ADR-030 (inference waits for AWS)
  is unaffected: this ADR is about the application, not inference.

## Decision

1. ONE is served at **`https://oneby8.com`**, from the AWS server Divakar provisioned
   (ap-south-1). The domain was bought for the product; the DNS `A` record for
   `oneby8.com` already points at that server.
2. **`www.oneby8.com` and `one.ai8ht.pro` forward permanently** (HTTP 308) to
   `https://oneby8.com`, keeping the path. `one.ai8ht.pro` does not serve the app any
   more. The forward works once `one.ai8ht.pro`'s DNS record points at the AWS server;
   the VPS is retired after `oneby8.com` is confirmed working.
3. **Mail keeps `info@ai8ht.pro`** as the sender for now. Certificate-expiry notices
   also go to `info@ai8ht.pro`.
4. The AWS server **is production**. The production rules in `CLAUDE.md` apply to it
   exactly as they applied to the VPS: no one but Divakar releases to it, connects to
   it or touches its data.

## What deliberately does not change

- **Calendar invitation UIDs stay `…@one.ai8ht.pro`.** A UID is an identity, not a
  link. Calendars match updates and cancellations to invitations already sent by UID;
  changing the domain would turn every reschedule of an existing interview into a
  duplicate event.
- **The Android sign-in redirect scheme stays `one.ai8ht.pro://signin`.** It is a
  private app-link name registered with Cognito, not a web address; renaming it would
  break sign-in until Cognito is reconfigured, for no user-visible gain.
- **The Android application ID stays `pro.ai8ht.one`.** Changing it publishes a
  different app; existing installs would not update.

## Rejected

- **Pointing `oneby8.com` at the VPS first, AWS later.** Faster to see, but means two
  cut-overs and two certificate issuances; the VPS is being retired anyway.
- **Keeping `one.ai8ht.pro` serving the app alongside `oneby8.com`.** Two live
  addresses split bookmarks, shared profile links and CORS configuration; one address
  with a forward keeps old links working without that cost.
- **Moving the sender to `@oneby8.com` now.** Needs a mailbox plus SPF, DKIM and DMARC
  records on the new domain before mail stops landing in spam; deferred until wanted.

## Known gap this move does not close

Outgoing email is not wired to a real mail server. `packages/persistence/src/invitation-mail.ts`
sends only to a loopback Mailpit; the `info@ai8ht.pro` sender changed the From line,
not the delivery path. Authenticated TLS delivery through the provider's SMTP server
(`smtpout.secureserver.net`) is separate work, with the password held only in the
server's environment.
