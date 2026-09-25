# Scheduled jobs

Units for work that runs on a schedule rather than in response to a request.

## Health monitor

Every five minutes: public `/health`, the API directly (so a proxy fault and an API
fault read differently), service state, any failed `planthepath-*` unit, disk usage,
backup freshness, certificate expiry, and the clamd socket when uploads are on. All
failures are collected into one line rather than stopping at the first.

```bash
sudo cp /srv/planthepath-next/current/deploy/systemd/planthepath-monitor.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planthepath-monitor.timer
sudo systemctl start planthepath-monitor.service && journalctl -u planthepath-monitor.service -n 3 --no-pager
```

**Alerting needs one thing only you can do**: create two free checks at
healthchecks.io (or any dead-man's-switch service) — one expecting a ping every
5 minutes, one expecting a daily ping — and add to `app.env`:

```bash
MONITOR_PING_URL=https://hc-ping.com/<uuid-monitor>
BACKUP_PING_URL=https://hc-ping.com/<uuid-backup>
```

The service then emails you when pings stop arriving (host dead) or when the fail
endpoint is hit (host alive but broken). Without these URLs the monitor still runs
and logs, but nobody is told.

## Background jobs alert check

Every five minutes, one pass of `jobs:alert-check` (OPS-04). It looks at the outbox and
consumer receipts and raises **one alert per breach**: failed events at or above
`JOBS_ALERT_FAILED_THRESHOLD` (default 10), a due event waiting at least
`JOBS_ALERT_PENDING_STALL_MINUTES` (default 30), or a consumer listed in
`JOBS_ALERT_CONSUMER_SILENCE_MINUTES` with no receipt in its interval. It clears the alert
when the condition recovers. Operators see open and recent alerts in Operations →
System Health. It runs apart from the automation worker, so a stopped worker still shows
up as a stalled queue.

An alert is emailed to platform staff only when the `ops-failure` workflow is registered
active, outside its kill switch, and an approved `ops-failure` notification template
exists. Otherwise the alert is recorded as not emailed, and the screen says so.

```bash
sudo cp /srv/planthepath-next/current/deploy/systemd/planthepath-jobs-alerts.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planthepath-jobs-alerts.timer
sudo systemctl start planthepath-jobs-alerts.service && journalctl -u planthepath-jobs-alerts.service -n 3 --no-pager
```

A run logs one line:

```json
{"event":"jobs.alert.check","raised":[{"condition":"PENDING_EVENTS_STALLED","subject":null,"notice":"NOT_DELIVERED"}],"cleared":[],"open":1,"ignoredConfig":[]}
```

Until the pre-dispatcher backlog is superseded (System Health → Supersede the backlog),
expect a `PENDING_EVENTS_STALLED` alert on the first run. That alert is correct: those
events are waiting and nothing is delivering them.

## Off-host backup copy

The backup script copies each verified dump off the machine when either is set in
`app.env`:

```bash
BACKUP_RCLONE_REMOTE=remote:bucket/one-db     # any rclone remote (B2, S3, Drive…)
BACKUP_SCP_TARGET=user@othermachine:/backups/ # or plain scp with key auth
```

Unconfigured, every run logs a warning that a lost machine is still total loss; a
failed copy exits non-zero even though the local dump is good.

## Switching the API to production mode

`deploy/scripts/preflight-production.sh` names exactly what `app.env` is missing.
Production startup requires `NODE_ENV=production`, server-side
`COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` (the `VITE_` variants are the
browser's, not the API's), and `AUTOMATION_SIGNING_SECRET` (≥32 bytes;
`openssl rand -base64 48`). Release deploy scripts run the preflight before
building, and pass `ALLOW_PRODUCTION_MIGRATIONS=true` to the migrate step per-run —
that guard exists so production migrations are a conscious act, never ambient.

## Database backup with restore verification

A dump that has never been restored is not a backup; it is a file that might be one.
Every run therefore restores what it just produced into a scratch database and
compares table and row counts against the source. **A dump that fails to verify is
deleted rather than kept**, because a broken file sitting in the backup directory is
worse than an empty directory: it looks like protection.

```bash
sudo cp /srv/planthepath-next/current/deploy/systemd/planthepath-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planthepath-backup.timer
sudo systemctl start planthepath-backup.service    # run once, now
journalctl -u planthepath-backup.service -n 20 --no-pager
```

A good run logs:

```json
{"event":"backup.verified","bytes":355475,"tables":62,"rows":"12:4:0:118","retained":1}
```

A bad one logs the mismatch, deletes the dump and exits non-zero:

```json
{"event":"backup.verify.failed","reason":"table count 62 vs 0","deletedUnverifiedDump":true}
```

Runs at 01:30 IST, an hour before the deletion sweep, so each day's backup predates
that day's irreversible erasures. Keeps 14 days by default (`BACKUP_RETENTION_DAYS`).

Two limits worth stating plainly. The backups live **on the same host as the
database**, so this protects against corruption, a bad migration and mistaken
deletion — not against losing the machine. Copying them off-host is a separate,
still-outstanding job. And restore verification proves the dump is loadable, not that
the application works against it; a full recovery drill is still worth doing by hand
before real data arrives.

## Privacy deletion sweep

`executeDueDeletions` carries out deletion requests whose 30-day grace period has
elapsed. Without a scheduler the request is recorded and then waits indefinitely, so
this timer is what makes the deletion right real rather than merely offered.

Install on the host:

```bash
sudo cp /srv/planthepath-next/current/deploy/systemd/planthepath-privacy-deletion.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planthepath-privacy-deletion.timer
```

Verify:

```bash
systemctl list-timers planthepath-privacy-deletion.timer
sudo systemctl start planthepath-privacy-deletion.service   # run once, now
journalctl -u planthepath-privacy-deletion.service -n 50 --no-pager
```

A run logs one JSON line:

```json
{"event":"privacy.deletion.sweep","considered":2,"completed":1,"held":1,"failed":0}
```

`held` means a retention hold is active on that subject; the request stays open and is
picked up again once the hold is released. The service exits non-zero if any request
failed, so a failure surfaces in `systemctl status` rather than being reported as a
successful run in which nobody's data was actually deleted.

If `FILE_STORAGE_ROOT` is unset the sweep still erases the database rows but cannot
remove stored document bytes, and says so in the log line rather than reporting a
clean sweep.

The unit runs as `aight` from `/srv/planthepath-next/current`, so it always uses the
release currently serving traffic and needs no update when a new release is switched
in. `ReadWritePaths` grants it the storage root and nothing else.
