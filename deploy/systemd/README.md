# Scheduled jobs

Units for work that runs on a schedule rather than in response to a request.

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
