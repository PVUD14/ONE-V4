# ONE — Operations Handbook

How the operational team runs one.ai8ht.pro. Model: **designated operator with an
automation safety net** — releases stay human-driven from runbooks; backups and
monitoring run unattended and alert a person when they stop working.

## Roles

| Domain | Owner | Backup |
| --- | --- | --- |
| Releases, rollback, migrations | Lead operator | Trained junior operator |
| Backup verification, quarterly restore drill | Trained junior operator | Lead operator |
| UAT, issue triage, post-deploy re-test | Junior team | — |
| Accounts, demo credential rotation, access reviews | Lead operator | — |
| Monitoring alerts (first responder) | Whoever is alerted | Escalate to lead |

A junior becomes a "trained junior operator" by shadowing two deploys, then
performing one supervised deploy end-to-end (the `aight` half only).

## Access model — standing rules

1. **Root stays with the lead operator alone.** Junior operators work only as the
   `aight` user; the switch step (root) is performed or supervised by the lead.
2. **No migration without the flag and a fresh backup.** `ALLOW_PRODUCTION_MIGRATIONS=true`
   is passed per-run by the deploy script, never set in `app.env`. The deploy script
   takes a pre-migration dump automatically; never bypass it.
3. **Credentials live in the team vault, never in the repository, never in chat.**
   The UAT credential sheet and server secrets are vault entries shared per-person.
   Juniors receive only the accounts they need, through the vault or a private channel.
4. **The shared demo password is rotated after every client demo.** See
   [runbook-demo-prep.md](runbook-demo-prep.md).
5. **Release tarballs are built only by the standard artifact process** (LF-normalized
   `git archive`, SHA-256 recorded in the deploy script). If the checksum check in a
   deploy script fails, stop — do not re-copy and retry blind; the artifact is wrong.

## Runbooks

- [runbook-deploy.md](runbook-deploy.md) — put a release live.
- [runbook-rollback.md](runbook-rollback.md) — put the previous release back.
- [runbook-restore.md](runbook-restore.md) — restore the database; quarterly drill.
- [runbook-backups-monitoring.md](runbook-backups-monitoring.md) — one-time install,
  alert meanings, day-2 checks.
- [runbook-demo-prep.md](runbook-demo-prep.md) — before and after a client demo.

## Weekly checklist (5 minutes, junior operator)

```
systemctl list-timers 'planthepath-*'          # both timers scheduled, none stale
journalctl -u planthepath-backup.service -n 5  # last run ends in backup.verified
ls -lh /srv/planthepath-next/shared/backups | tail -3
curl -fsS https://one.ai8ht.pro/health         # {"status":"ok"}
df -h /srv                                     # below 80%
```

Anything unexpected: screenshot it and escalate to the lead operator. Do not "fix"
server state ad hoc — every corrective action comes from a runbook.
