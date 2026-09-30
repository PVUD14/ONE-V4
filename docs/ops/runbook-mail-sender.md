# Runbook — outgoing mail sender (info@ai8ht.pro via GoDaddy)

> What this is: how to switch on ONE's real outgoing email, prove it with one test message, and set up
> the DNS records that stop it landing in spam. Why it exists: until 2026-09-30 ONE could only send to
> a local Mailpit, so every invitation, announcement, hiring notification and status notice on a
> server was recorded NOT_CONFIGURED. Divakar chose GoDaddy's outgoing server for the info@ai8ht.pro
> mailbox; `TlsSmtpMailSink` (`packages/persistence/src/invitation-mail.ts`) is the sender. Nothing in
> this runbook has been run against GoDaddy or any real mailbox: there are no credentials in the
> repository, and sending to real people is Divakar's call.

## What the sender does

- Connects to `PTP_SMTP_HOST` with **TLS from the first byte** (`PTP_SMTP_SECURITY=TLS`, port 465) or
  with a **mandatory STARTTLS upgrade** (`STARTTLS`, port 587). If the server does not offer
  STARTTLS, nothing is sent — it never falls back to plain text.
- Verifies the server certificate and host name against the system trust store. There is no switch
  to turn verification off.
- Authenticates with `AUTH PLAIN`, or `AUTH LOGIN` if that is all the server offers, only once the
  connection is encrypted.
- Sends from `AI8HT ONE <info@ai8ht.pro>` (`PTP_MAIL_FROM`, default `info@ai8ht.pro`) — the same
  message format the local Mailpit sink uses, including calendar (`.ics`) attachments.
- Reports the outcome by reply code:

  | Server reply | Recorded as | Meaning |
  |---|---|---|
  | 2xx after the message | SENT | Accepted by GoDaddy for delivery (not proof of inbox delivery). |
  | 5xx on the recipient or the message | BOUNCED | The address or message was refused permanently. |
  | 5xx on login or sender (e.g. 535 bad credentials) | FAILED | A problem with *our* configuration — the recipient is **not** marked bounced. |
  | 4xx, timeout, dropped connection, certificate failure | FAILED | Temporary or configuration problem; retryable. |

- Error messages carry only the stage and reply code (e.g. `mail delivery failed at AUTH (535)`),
  never the server's text, the password, or its base64 form.

## Environment variables

Set these in the server environment file (on the live host `/srv/planthepath-next/shared/app.env`,
see `deploy/vps/README.md`). **Divakar sets `PTP_SMTP_PASSWORD` himself, directly on the server.** It
is never committed, pasted into a ticket, or shared with an agent.

| Variable | Value for info@ai8ht.pro | Notes |
|---|---|---|
| `PTP_SMTP_HOST` | `smtpout.secureserver.net` | Setting it switches the real sender on. Leave empty to send nothing. |
| `PTP_SMTP_SECURITY` | `TLS` | Optional. `TLS` or `STARTTLS` (any case); unset means `STARTTLS` for port 587 and `TLS` otherwise. Anything else refuses to start. |
| `PTP_SMTP_PORT` | `465` | Optional. Defaults to 465 for `TLS`, 587 for `STARTTLS`. |
| `PTP_SMTP_USER` | `info@ai8ht.pro` | The full mailbox address. |
| `PTP_SMTP_PASSWORD` | *(the mailbox password — Divakar only)* | Required when the host is set. |
| `PTP_MAIL_FROM` | `info@ai8ht.pro` | Must be the same mailbox, or GoDaddy will refuse or rewrite the sender. |
| `PTP_SMTP_HELO_NAME` | *(optional)* | Name sent in EHLO; default `one.ai8ht.pro`. |
| `PTP_SMTP_TIMEOUT_MS` | *(optional)* | Per-step timeout, 1000–120000; default 20000. The whole send is bounded by three times it. |

Rules the code enforces at start-up: an empty `PTP_SMTP_HOST` means no mail is sent. If it is set but
the user or password is missing, or the port or security mode is wrong, **the API and the automation worker refuse to start** with an error naming
the variable (never its value). `PTP_SMTP_HOST` and `PTP_LOCAL_INVITATION_MAILPIT_ENABLED=true`
together are also refused.

Which processes send mail:

- **The API** sends staff invitations (operations → institution onboarding, employer team) during
  the request, and uses the same setting to tell the announcements screen whether email is
  configured.
- **The automation worker** (`worker:automation` in `local-dispatcher` mode) sends student
  invitations, announcements, hiring notifications (with interview `.ics` invites) and incident
  status notices from the outbox. The worker is not part of the current live deployment
  (`deploy/vps/README.md`); until it runs there with the same variables, those emails stay queued or
  are recorded as not sent. Give both processes the same `PTP_SMTP_*` values.

After changing the environment file, restart the service (`sudo systemctl restart
planthepath-api.service`) so it reads the new values, then check it started (`systemctl status`,
`journalctl -u planthepath-api.service -n 50`). A configuration error shows there by variable name.

## Switching it on with docker compose (the AWS server, `deploy/vps`)

The compose file passes the five `PTP_SMTP_*` variables from the server's `.env` to the API
container, blank by default. On the server, in the directory holding `docker-compose.yml`:

1. `sudo nano .env` and fill in:

   ```
   PTP_SMTP_HOST=smtpout.secureserver.net
   PTP_SMTP_PORT=465
   PTP_SMTP_SECURITY=TLS
   PTP_SMTP_USER=info@ai8ht.pro
   PTP_SMTP_PASSWORD=<type the mailbox password here, on the server only>
   ```

   If the password contains a `$`, wrap it in single quotes (`PTP_SMTP_PASSWORD='...'`) so compose
   does not treat it as a variable. Save, and keep the file `chmod 600`.
2. `sudo docker compose up -d` — compose recreates the API container with the new values.
3. `sudo docker compose logs --tail 50 api` — a configuration error shows here by variable name, and
   the API does not start until it is fixed. Nothing prints the password.

To prove it, either send the fixed test message below from inside the container:

```bash
sudo docker compose exec api pnpm --filter @planthepath/persistence mail:send-test -- --to <your-address> --confirm-real-send
```

or send **one test invitation** through the product: sign in as an operator, open an organisation
you control in Operations → institution onboarding, and invite an administrator using an address you
own. The invitation is recorded as delivered and the email arrives from
`AI8HT ONE <info@ai8ht.pro>` with the invitation link. The delivery is recorded in
`notification_delivery_attempts` with `provider_kind = 'SMTP'` and a `provider_reference` starting
`smtp:`. Revoke the test invitation afterwards if you do not intend to accept it.

## First test send on the older systemd host — SENDS A REAL EMAIL (Divakar only)

> **This sends one real email through GoDaddy.** Run it only yourself, only to an address you
> choose and control, and only after the variables above are set. No agent or test runs it.

On the server, from the release directory, with the environment file loaded:

```bash
cd /srv/planthepath-next/current
set -a; . /srv/planthepath-next/shared/app.env; set +a
corepack pnpm --filter @planthepath/persistence mail:send-test -- --to <your-address> --confirm-real-send
```

It sends one fixed message ("ONE mail sender test") and prints either
`Accepted by the server. Reference: smtp:...` or the failing stage and code. It prints nothing
secret. Without `--confirm-real-send` it only prints its usage and sends nothing. Afterwards, close
the shell so the loaded variables do not linger.

What to check in the received message (in Gmail: ⋮ → *Show original*):

1. From reads `AI8HT ONE <info@ai8ht.pro>`.
2. `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. If any is missing or failing, fix DNS (below) before
   sending to real users.
3. It arrived in the inbox, not spam.

If it fails:

| Output | Likely cause |
|---|---|
| `failed at AUTH (535)` | Wrong password, or SMTP authentication is not enabled for the mailbox in GoDaddy's email settings. |
| `failed at TLS: ...` | The host name is wrong or not the one on GoDaddy's certificate; check `PTP_SMTP_HOST`. |
| `failed at CONNECT` / `TIMEOUT` | The server's outbound port 465 (or 587) is blocked by the hosting provider or firewall. Try the other port and mode. |
| `failed at MAIL (5xx)` | `PTP_MAIL_FROM` is not the authenticated mailbox. |
| `refused ... permanently (550)` | The test recipient address does not exist. |

## DNS records for ai8ht.pro

Add these in GoDaddy's DNS management for `ai8ht.pro`. The exact values come from GoDaddy for this
mailbox — **copy them from GoDaddy, not from this page.**

1. **SPF** (TXT on `@`). There must be exactly one SPF record for the domain. It must include
   GoDaddy's outgoing servers (`include:secureserver.net`, as GoDaddy's help article on SPF records
   for its email shows) alongside anything else that sends as ai8ht.pro, ending in `~all` or `-all`.
   If an SPF record already exists, add the include to it rather than creating a second record.
2. **DKIM**. In GoDaddy's email settings for the mailbox, turn on DKIM signing (GoDaddy's help
   centre: search "DKIM" for your email product). GoDaddy either adds the record itself when the
   domain's DNS is at GoDaddy, or gives you the selector and TXT/CNAME value to add.
3. **DMARC** (TXT on `_dmarc`). Start in monitoring mode, e.g. `v=DMARC1; p=none; rua=mailto:<a
   mailbox you read>`, as GoDaddy's help article on adding a DMARC record describes. After a couple
   of weeks of clean reports, move to `p=quarantine`.

DNS changes can take up to 48 hours to be visible everywhere. Re-run the test send afterwards and
confirm all three pass.

## Turning it off

Empty `PTP_SMTP_HOST` in the environment file and restart the API (and worker). ONE goes back to
recording every email as NOT_CONFIGURED; nothing is lost from the database.

## Known limits

- Staff-invitation delivery attempts record the sink that sent them: `SMTP` for the real sender,
  `MAILPIT` for the local capture (migration 0094 added `SMTP`; ADR-042).
- The compose deployment runs only the API, so only staff invitations (institution administrators,
  employer team, Growth team) leave the server. Student invitations, announcements and hiring
  notifications need the automation worker, which is not deployed yet.
- GoDaddy limits how many messages a mailbox may send per day. A large student import can exceed it;
  failed sends are recorded FAILED, not lost silently. Check the limit for this plan in GoDaddy's
  email settings before a bulk invitation.
- 2xx means GoDaddy accepted the message. Later bounces arrive as emails to info@ai8ht.pro; they are
  not read back into ONE.
