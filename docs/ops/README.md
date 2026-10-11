# ONE — Operations Handbook

How the operational team runs ONE. Production is moving from the VPS (`one.ai8ht.pro`)
to `oneby8.com` on AWS � see `runbook-move-to-aws.md` and ADR-041; the release steps
below describe the VPS until that cut-over. Model: **designated operator with an
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
- [runbook-pilot-support.md](runbook-pilot-support.md) — pilot support calls, including the
  learning engine (ENG-17).
- [runbook-pilot-incident.md](runbook-pilot-incident.md) — a pilot incident from detection to
  closure (ENG-17).
- [runbook-ai-kill-switch.md](runbook-ai-kill-switch.md) — switch every AI path off and prove it
  (ENG-17).
- [runbook-engine-migration-rollback.md](runbook-engine-migration-rollback.md) — forward-only
  rollback notes for each learning-engine migration (ENG-17).
- [runbook-mail-sender.md](runbook-mail-sender.md) — switch on real email from info@ai8ht.pro
  (GoDaddy SMTP), the first test send, and the SPF/DKIM/DMARC records.

## Operator SOPs (Operations console)

Each console module has one SOP. Each SOP covers:
- the capability you need;
- the steps;
- the reason codes;
- when to escalate;
- what you must never do.

The UAT scripts are in [../uat/ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md). The
security review is in
[../security/reviews/OPERATIONS-CONSOLE-SECURITY-REVIEW.md](../security/reviews/OPERATIONS-CONSOLE-SECURITY-REVIEW.md).

- [sop-overview.md](sop-overview.md): Overview, the daily triage.
- [sop-organizations.md](sop-organizations.md): organisations, verification, suspension, employer
  access requests, and employer and college terms.
- [sop-college-accounts.md](sop-college-accounts.md): college account fields and contacts.
- [sop-support.md](sop-support.md): support desk and account lookup.
- [sop-trust-safety.md](sop-trust-safety.md): Trust and Safety cases (partly built).
- [sop-content-authoring.md](sop-content-authoring.md): skill map, question bank, lessons and
  variants, and archiving.
- [sop-role-catalogue.md](sop-role-catalogue.md): job-role catalogue and requirement sets.
- [sop-content-bulk-import.md](sop-content-bulk-import.md): content bulk import.
- [sop-external-reviewers.md](sop-external-reviewers.md): faculty reviewers.
- [sop-ai-operations.md](sop-ai-operations.md): AI Operations and the learning-engine panels.
- [sop-analytics.md](sop-analytics.md): role demand and college health.
- [sop-system-health.md](sop-system-health.md): background jobs and the engine job panels.
- [sop-audit-logs.md](sop-audit-logs.md): audit search.
- [sop-privacy.md](sop-privacy.md): privacy requests, legal holds and consent coverage.
- [sop-access-reviews.md](sop-access-reviews.md): quarterly access reviews.
- [sop-incidents-and-status-notices.md](sop-incidents-and-status-notices.md): incident register and
  status notices.
- [sop-feature-flags.md](sop-feature-flags.md): feature flags.
- [sop-approvals.md](sop-approvals.md): high-risk approvals and the solo safeguard.
- [sop-staff-capabilities.md](sop-staff-capabilities.md): platform staff and capabilities.
- [sop-growth-team.md](sop-growth-team.md): Growth team (the operations side of the Growth portal).
- [sop-staff-access.md](sop-staff-access.md): staff sign-in readiness.
- College exits: [../institution/sop-college-exit.md](../institution/sop-college-exit.md).

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
