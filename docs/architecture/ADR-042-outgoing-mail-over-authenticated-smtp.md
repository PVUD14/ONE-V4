# ADR-042 — Outgoing Mail Leaves Over Authenticated, TLS-Only SMTP

> What this is: the decision record for how ONE's email actually leaves the server. Why it exists:
> ADR-041 moved production to AWS and recorded as a "Known gap" that outgoing mail still went only
> to a loopback Mailpit. This ADR records how that gap is closed, what was rejected, and one schema
> change (migration 0094) that keeps the delivery ledger truthful once real mail is sent.

**Status:** Accepted (Divakar chose the provider, 2026-09-30)
**Decision date:** 2026-09-30
**Scope:** The transport between ONE and the mail provider, its configuration, and how a send is
recorded
**Builds on:** ADR-021 (email delivery), ADR-028 (the outbox is the transport), ADR-041 (production
on AWS; mail stays on `info@ai8ht.pro`)
**Supersedes in part:** ADR-021's "No second sending path is introduced into the API" — see
"Relationship to ADR-021". ADR-041 is not edited; this ADR closes its "Known gap".

## Context

Every ONE email is sent through one interface, `InvitationMailSink`
(`packages/persistence/src/invitation-mail.ts`), chosen once per process by
`createConfiguredInvitationMailSink()`:

- **The API** builds it in `Phase1ApiSecurityModule` and sends staff invitations during the request
  (operations → institution administrator, employer team, Growth team).
- **The automation worker** (`worker:automation`, `local-dispatcher` mode) builds it and sends
  student invitations, announcements, hiring notifications (with `.ics` invites) and incident status
  notices from the outbox.
- `mail:send-test` builds it to prove a configuration with one message.

No other code path in the repository opens a mail connection. The n8n workflows under
`automation/n8n` carry their own SMTP credential inside n8n and are not part of any deployment
today; they are unaffected by this decision.

Until 2026-09-30 the only sink was `LoopbackSmtpInvitationMailSink`, which refuses any host but
`127.0.0.1`/`localhost`. On a server there was no sink, so every email was recorded NOT_CONFIGURED.
Divakar's mailbox is `info@ai8ht.pro` at GoDaddy: `smtpout.secureserver.net`, port 465 with implicit
TLS (or 587 with STARTTLS), authenticated as the mailbox.

## Decision

1. **A second sink, `TlsSmtpMailSink`, speaks authenticated SMTP over TLS only**, written on Node's
   own `node:tls`/`node:net` — no new dependency.
   - `PTP_SMTP_SECURITY=TLS` (default, port 465): TLS from the first byte. `STARTTLS` (port 587):
     plain greeting, then a mandatory upgrade; if the server does not offer STARTTLS nothing is sent.
     There is no plain-text mode.
   - Certificate and host-name verification are always on (`rejectUnauthorized: true`, TLS 1.2
     minimum). There is no setting that turns them off. Tests trust their in-memory, self-signed
     fake server by adding its certificate as an extra CA through a test-only constructor option
     the configuration path never passes.
   - `AUTH PLAIN`, or `AUTH LOGIN` if that is all the server offers — and only once the connection
     is encrypted.
   - Every step has an idle timeout (default 20 s) and the whole send is bounded by three times it.
2. **One message format for both sinks.** `buildMailMessage()` builds the headers (From `AI8HT ONE
   <mailSender()>`, To, Subject, Date, Message-ID, correlation id), the multipart attachments and
   the header sanitising, so a Mailpit capture and a real delivery are the same bytes.
3. **Configuration comes only from the server environment**: `PTP_SMTP_HOST`, `PTP_SMTP_PORT`,
   `PTP_SMTP_USER`, `PTP_SMTP_PASSWORD`, optional `PTP_SMTP_SECURITY`. An empty host means no real
   sender (today's behaviour, or Mailpit when `PTP_LOCAL_INVITATION_MAILPIT_ENABLED=true` on a
   developer machine). A host with a missing or invalid user, password, port or security mode
   **stops the process at start-up** with an error that names the variable and never its value;
   setting both the host and the Mailpit flag is refused as ambiguous. The password lives in a
   private class field, never in an error, a log line or a serialised sink.
4. **Reply codes are classified by stage.** A 5xx on the recipient or the message is
   `PermanentMailRejection` (the address bounced). A 5xx on AUTH or MAIL FROM is our configuration
   being refused, so it is a non-retryable `MailDeliveryFailure` — a wrong password must never mark
   every recipient's address as bad. 4xx, timeouts and dropped connections are retryable.
5. **The delivery ledger says which transport sent the mail (migration 0094).**
   `notification_delivery_attempts.provider_kind` allowed only `MAILPIT`, `SES` and `N8N`, so the
   API would have recorded a GoDaddy delivery as `MAILPIT`. Each sink now carries a `providerKind`
   (`MAILPIT` or `SMTP`) and the API records it. Migration 0094 replaces the column's CHECK with one
   that allows the same values plus `SMTP`. It removes nothing that was allowed before; it is the
   minimum change that keeps the ledger truthful, and it is idempotent under the replaying migrator.

## Rejected

- **A third-party email API (SendGrid, SES, Postmark, Mailgun).** It would mean a second vendor
  account, a second set of DNS records and a second secret for a volume one mailbox can carry, and
  Divakar already pays for the GoDaddy mailbox that owns the sending address. SES in particular needs
  AWS access this work does not have (ADR-030). Nothing here prevents moving later: a new sink
  behind the same interface is the whole change, and `SES` is already an allowed `provider_kind`.
- **nodemailer.** It would do the job, but it adds a dependency (and its transitive surface) to both
  the API and the worker for what is about 300 lines of protocol ONE can test end to end against a
  fake server. It also makes it easy to pass `tls: { rejectUnauthorized: false }` — the one option
  this sender must never have. Writing the client keeps `pnpm audit --prod` unchanged and keeps the
  absence of a verification switch a property of the code rather than of reviewers' vigilance.
- **Falling back to plain text** when STARTTLS is missing, or **skipping certificate checks** for
  "difficult" servers. Either would send the mailbox password in a form an intermediary can read.
- **Starting without mail when the configuration is half set.** A process that silently sends
  nothing while an operator believes mail is on is worse than one that refuses to start and says
  which variable is wrong.
- **Letting SMTP silently win over the Mailpit flag.** On a developer machine that would send real
  mail when a local capture was intended; refusing both is clearer.

## Relationship to ADR-021

ADR-021 decided that email is delivered by deploying the automation worker and the workflow service,
and that no second sending path is introduced into the API. The API had in fact sent staff
invitations in-request through the Mailpit sink since before ADR-021; this ADR accepts that path and
gives it a real transport rather than removing it, because an invited administrator has to receive
their link before any other email in their institution matters. The worker path ADR-021 describes
is unchanged and uses the same sink. What ADR-021 said about not placing an outbound call next to
request handling still applies as a cost: a staff invitation now waits on GoDaddy, bounded by the
timeouts above, and a failed send is recorded and can be resent without undoing the invitation.

## Consequences

- Real email flows as soon as Divakar sets the four variables on the server (the password only on
  the server, never in the repository) and restarts the API. `docs/ops/runbook-mail-sender.md`
  says how, and how to prove it with one test message.
- Student invitations, announcements and hiring notifications still need the automation worker to
  run on the server with the same variables; the VPS/AWS compose does not run it today.
- GoDaddy's per-mailbox daily sending limit bounds a bulk student import. Failed sends are recorded
  FAILED and can be resent, not lost.
- SPF, DKIM and DMARC for `ai8ht.pro` must be in place before mail to real users, or it lands in spam.
