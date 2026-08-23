# Scheduled jobs

Units for work that runs on a schedule rather than in response to a request.

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
