# Runbook — Backups & monitoring: install and operate

The scripts and systemd units ship inside every release
(`deploy/scripts/backup-and-verify.sh`, `deploy/scripts/monitor.sh`,
`deploy/systemd/planthepath-{backup,monitor}.{service,timer}`). This runbook
installs them once and explains what their alerts mean.

## One-time install (lead operator, as root)

### 1. Create the alert checks (healthchecks.io, free tier)

Create two checks and copy each check's ping URL:

- **one-backup** — Period: 1 day, Grace: 6 hours.
- **one-monitor** — Period: 10 minutes, Grace: 10 minutes.

Add both integrations you actually read (email at minimum). These are dead-man's
switches: the alert fires when pings *stop arriving* (host dead) or when a script
pings `/fail` (host alive but broken) — both failure shapes reach a human.

### 2. Add the ping URLs to app.env

Append to `/srv/planthepath-next/shared/app.env` (values are the URLs from step 1):

```
BACKUP_PING_URL=https://hc-ping.com/<one-backup-uuid>
MONITOR_PING_URL=https://hc-ping.com/<one-monitor-uuid>
```

### 3. Configure backup encryption (before any offsite copy)

Everything that leaves the host ships encrypted to a public key; the private key
lives only in the operator vault. The server can encrypt backups it can never
decrypt — a lost offsite copy is ciphertext, not a breach.

On the **operator machine** (never on the server):

```
gpg --quick-gen-key "ONE Backups <ops@ai8ht.pro>" default default never
gpg --export --armor "ONE Backups" > one-backup-public.key
gpg --export-secret-keys --armor "ONE Backups" > one-backup-PRIVATE.key
```

Store `one-backup-PRIVATE.key` (and its passphrase, if set) in the vault, delete
the local file, and copy **only** the public half to the server:

```
scp one-backup-public.key aight@one.ai8ht.pro:/srv/planthepath-next/shared/backup-public.key
```

Then add to `app.env`:

```
BACKUP_GPG_PUBLIC_KEY=/srv/planthepath-next/shared/backup-public.key
```

The nightly job now writes `<dump>.gpg` beside each verified dump and ships only
the `.gpg` offsite; the `backup.verified` log line shows `"encrypted":"gpg:<key>"`.
If the key is configured but encryption fails, the run fails loudly rather than
shipping plaintext. The plaintext dump stays on the host for fast local restores
(an attacker who can read that directory can read the live database anyway).

### 3b. Configure the offsite copy

A backup that lives only on the server does not survive losing the server. Pick one:

- **rclone** (preferred — any S3/Drive/B2 remote): configure a remote as `aight`
  (`su aight` then `rclone config`), then add to app.env:
  `BACKUP_RCLONE_REMOTE=<remote>:<bucket-or-folder>/one-backups`
- **scp** to another machine you control, with a passwordless key for `aight`:
  `BACKUP_SCP_TARGET=user@host:/path/to/one-backups/`

Until one is set, every backup run logs `backup.offsite.unconfigured` — treat that
warning as a standing action item, not noise.

### 4. Install and enable the units

```
install -m 644 /srv/planthepath-next/current/deploy/systemd/planthepath-backup.service /etc/systemd/system/
install -m 644 /srv/planthepath-next/current/deploy/systemd/planthepath-backup.timer   /etc/systemd/system/
install -m 644 /srv/planthepath-next/current/deploy/systemd/planthepath-monitor.service /etc/systemd/system/
install -m 644 /srv/planthepath-next/current/deploy/systemd/planthepath-monitor.timer  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now planthepath-backup.timer planthepath-monitor.timer
```

### 5. Prove it end-to-end, today

```
systemctl start planthepath-backup.service
journalctl -u planthepath-backup.service -n 20 --no-pager   # ends in "backup.verified"
systemctl start planthepath-monitor.service
journalctl -u planthepath-monitor.service -n 5 --no-pager   # ends in "monitor.ok"
systemctl list-timers 'planthepath-*'
```

Then confirm both checks on healthchecks.io show green. Finally, prove the alarm
itself: pause the monitor timer for 15 minutes
(`systemctl stop planthepath-monitor.timer`), confirm the alert email arrives,
restart it (`systemctl start planthepath-monitor.timer`). An untested alert is a
decoration.

## What an alert means (first responder, junior-friendly)

**one-monitor fired.** Read the failure names:

```
journalctl -u planthepath-monitor.service -n 10 --no-pager
```

- `public-health` but not `local-api-health` → the proxy/Plesk layer, not the app.
- `local-api-health` or `api-service` → the API is down:
  `journalctl -u planthepath-api.service -n 50 --no-pager`, then escalate; a
  just-deployed release means [runbook-rollback.md](runbook-rollback.md).
- `disk-NNpct` → check `/srv/planthepath-next/releases` (old releases) and
  `shared/backups` before deleting anything; escalate first.
- `cert-expires-Nd` / `cert-unreadable` → renew via Plesk (Let's Encrypt).
- `backup-stale-Nh` / `no-backups` → the backup chain broke; treat as urgent even
  though the site is up.
- No journal output at all and the host is unreachable → the machine itself is
  down; escalate to the lead operator and the hosting provider.

**one-backup fired.** The nightly backup failed or its ping stopped:

```
journalctl -u planthepath-backup.service -n 30 --no-pager
```

The script's own log line names the reason (`backup.failed`,
`backup.verify.failed` — note it *deletes* unverifiable dumps by design,
`rclone:FAILED`/`scp:FAILED` — local dump good, offsite copy broken). Fix the named
cause, then `systemctl start planthepath-backup.service` to run it again and
confirm `backup.verified`.
