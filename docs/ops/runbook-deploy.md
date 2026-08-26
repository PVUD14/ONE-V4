# Runbook — Deploy a release

Puts release `<short>` (e.g. `bfe6566`) live on one.ai8ht.pro. Junior-executable up
to the switch step; the switch (root) is performed or supervised by the lead operator.

## Preconditions

- The release was cut by the standard process: three files exist in `.deploy/` on the
  build machine — `planthepath-next-<sha>.tar`, `deploy-<short>.sh`, `switch-<short>.sh`.
- The deploy script's header says whether this release runs a migration. If it does,
  the lead operator runs or supervises the whole deploy, not just the switch.
- Juniors have been told a deploy is coming (their demo sessions will restart).

## 1. Copy the artifacts (build machine → server)

```
scp .deploy/planthepath-next-<sha>.tar .deploy/deploy-<short>.sh .deploy/switch-<short>.sh aight@one.ai8ht.pro:/home/aight/planthepath-deploy/
```

## 2. Stage and build (Plesk SSH terminal, as `aight`)

If the terminal logs you in as root, become `aight` first:

```
su aight
bash /home/aight/planthepath-deploy/deploy-<short>.sh
```

Wait for it to finish. It verifies the tarball checksum, extracts to
`/srv/planthepath-next/releases/<sha>`, runs the production preflight against
`shared/app.env`, takes a pre-switch `pg_dump`, installs dependencies and builds.
**Any failure stops before traffic is touched — production is still on the old
release.** Read the error, fix the named cause (usually an `app.env` requirement or
a checksum mismatch), and re-run. Never improvise past a failed step.

## 3. Switch traffic (as root)

```
exit          # back to root
bash /home/aight/planthepath-deploy/switch-<short>.sh
```

The script prints `ROLLBACK_TARGET=<previous release path>` — **copy that line into
the deploy log before anything else.** It then flips the `current` symlink, restarts
`planthepath-api.service`, and polls health for 30 seconds.

Success looks like:

```
API_HEALTH={"status":"ok"}
CURRENT_SYMLINK=/srv/planthepath-next/releases/<sha>
SERVICE_STATE=active
PUBLIC_HEALTH={"status":"ok"}
```

If it fails, it prints the exact rollback command using `ROLLBACK_TARGET` — run it,
verify health, then investigate. See [runbook-rollback.md](runbook-rollback.md).

## 4. Verify like a user

- Hard-refresh https://one.ai8ht.pro (Ctrl+Shift+R) — the login page renders with
  the AI8HT wordmark.
- Sign in with one demo account and click through one changed area from the release
  notes.
- Ask the junior team to run the re-test list attached to the release.

## 5. Log it

Record in the deploy log (vault note or the team channel): date, `<short>`, who
deployed, the `ROLLBACK_TARGET` line, and the verification result.
