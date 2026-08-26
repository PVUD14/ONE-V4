# Runbook — Roll back to the previous release

Puts the previous release back live. Root required — lead operator performs or
supervises. Target time: under two minutes once the decision is made.

## When to roll back

- The switch script's health poll failed, or
- The new release is live but visibly broken (errors on login, blank portal,
  failing health endpoint) and no faster fix is in hand.

Do not debug in production first. Roll back, then debug on the build machine.

## 1. Identify the rollback target

The switch script printed it at deploy time and the deploy log recorded it:

```
ROLLBACK_TARGET=/srv/planthepath-next/releases/<previous-sha>
```

If the log is missing, list the releases and pick the one that was live before:

```
ls -lt /srv/planthepath-next/releases | head -5
readlink -f /srv/planthepath-next/current      # what is live right now
```

## 2. Flip the symlink and restart (as root)

```
ln -sfn /srv/planthepath-next/releases/<previous-sha> /srv/planthepath-next/current.next
mv -Tf /srv/planthepath-next/current.next /srv/planthepath-next/current
systemctl restart planthepath-api.service
```

## 3. Verify

```
curl -fsS http://127.0.0.1:7310/health     # {"status":"ok"}
curl -fsS https://one.ai8ht.pro/health     # {"status":"ok"}
systemctl is-active planthepath-api.service
```

Then hard-refresh the site in a browser and sign in with one demo account.

## The migration caveat — read before rolling back

Rolling back the **code** does not roll back the **database**. Our migrations are
additive (new tables/columns), so the previous release normally runs fine against
the migrated schema — a plain symlink rollback is safe.

But if the bad release's migration is itself the problem (data corrupted or
deleted), a code rollback is not enough: escalate to the lead operator and use
[runbook-restore.md](runbook-restore.md) with the pre-switch dump the deploy script
took (`shared/backups/planthepath_uat_before_<short>_<timestamp>.dump`). That
restore discards everything users did after the deploy — it is a lead-operator
decision, never a reflex.

## 4. Log it

Record: date, what was rolled back, to what, why, and the follow-up owner. The bad
release directory stays on disk for diagnosis — do not delete it.
