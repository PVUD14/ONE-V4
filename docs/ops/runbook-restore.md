# Runbook — Restore the database

Two modes. The **drill** is routine and safe, run quarterly by the trained junior
operator. The **emergency restore** overwrites production data and is a
lead-operator decision only.

Backups live in `/srv/planthepath-next/shared/backups/`:

- `<db>_<timestamp>.dump` — nightly, restore-verified by the backup job itself.
- `<db>_<timestamp>.dump.gpg` — the encrypted copy of the same dump; this is the
  form that ships offsite.
- `planthepath_uat_before_<short>_<timestamp>.dump` — taken by every deploy,
  immediately before that release's migration ran.

An **offsite** `.dump.gpg` must be decrypted first, on the operator machine,
with the private key from the vault (the server cannot decrypt it):

```
gpg --import one-backup-PRIVATE.key      # from the vault, once per machine
gpg --output restored.dump --decrypt <db>_<timestamp>.dump.gpg
```

Then treat `restored.dump` like any dump below. Local restores use the plaintext
`.dump` that is already on the host — no decryption step.

All commands as `aight` unless stated. Connection settings come from
`DATABASE_URL` in `/srv/planthepath-next/shared/app.env` — export them first:

```
set -a; . /srv/planthepath-next/shared/app.env; set +a
```

## A. Quarterly drill (no production impact)

Proves a dump restores and a human knows how. The nightly job already verifies
mechanically; the drill verifies the *team*.

```
DUMP=$(ls -t /srv/planthepath-next/shared/backups/*.dump | head -1)
psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE drill_restore;'
pg_restore --no-owner --no-acl -d "${DATABASE_URL%/*}/drill_restore" "$DUMP"
psql "${DATABASE_URL%/*}/drill_restore" -c 'SELECT count(*) FROM users;'
psql "${DATABASE_URL%/*}/drill_restore" -c 'SELECT count(*) FROM audit_events;'
psql "${DATABASE_URL%/*}/postgres" -c 'DROP DATABASE drill_restore;'
```

Counts should be plausible (non-zero, near production). Log the date, dump file
name, counts, and who ran it. If restore fails or counts are absurd, escalate the
same day — the backup chain is broken precisely when it looks healthy.

## B. Emergency restore (destructive — lead operator only)

Overwrites production with the chosen dump. **Everything users did after that dump
is permanently lost.** Confirm out loud, with a second person, which dump and why.

1. Stop the application so nothing writes mid-restore (as root):

```
systemctl stop planthepath-api.service
```

2. Take a safety dump of the current (bad) state first — recovery from a wrong
   decision runs through this file:

```
pg_dump "$DATABASE_URL" -Fc -f /srv/planthepath-next/shared/backups/pre_restore_safety_$(date -u +%Y%m%dT%H%M%SZ).dump
```

3. Restore into a fresh database, then swap names — the dump is proven good
   *before* the old data is touched:

```
DB=$(basename "${DATABASE_URL%%\?*}")
BASE="${DATABASE_URL%/*}"
psql "$BASE/postgres" -c 'CREATE DATABASE restore_incoming;'
pg_restore --no-owner --no-acl -d "$BASE/restore_incoming" /path/to/chosen.dump
psql "$BASE/restore_incoming" -c 'SELECT count(*) FROM users;'   # sanity before the swap
psql "$BASE/postgres" -c "ALTER DATABASE \"$DB\" RENAME TO \"${DB}_replaced\";"
psql "$BASE/postgres" -c "ALTER DATABASE restore_incoming RENAME TO \"$DB\";"
```

4. Start and verify (as root):

```
systemctl start planthepath-api.service
curl -fsS https://one.ai8ht.pro/health
```

Sign in with a demo account and check recent data matches the dump's point in time.

5. Only after days of confirmed-good operation: `DROP DATABASE "<db>_replaced";`

6. Log: date, dump used, why, data-loss window, who approved.
