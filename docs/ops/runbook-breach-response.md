# Runbook — Data breach response

What to do when personal data may have been accessed, altered, or lost by someone
who should not have it — a compromised account, a stolen credential, an exposed
backup, a vulnerability that was exploited, or a laptop with vault access gone
missing. Under India's DPDP Act, notifying the Data Protection Board **and every
affected user** is mandatory for a personal data breach — improvising this under
pressure is itself a compliance failure, which is why this page exists.

**Lead operator owns the incident.** Everyone else reports in and touches nothing
without instruction. Do not delete anything: evidence preservation beats tidiness.

## 1. Detect and declare (minutes)

Treat it as an incident the moment there is *reasonable suspicion* — do not wait
for proof. Start an incident log immediately (a timestamped note in the vault):
who noticed what, when, and every action taken from here on. This log is what the
Board notification, the user notification, and the post-mortem are written from.

## 2. Contain (first hour)

Pick the narrowest action that stops the bleeding — note each in the log:

- Compromised user account → disable it in Cognito (console → user pool → user →
  Disable). Do not delete it.
- Compromised operator/server credential → rotate it (SSH keys, Plesk password,
  vault master, `app.env` secrets) and check `journalctl` + `last` for its use.
- Active exploitation of the app → stop exposure while preserving data:
  `systemctl stop planthepath-api.service` (site down is better than data out),
  or block the offending source at the firewall if that suffices.
- Exposed backup or offsite storage → revoke the storage credential; note that
  offsite copies are GPG-encrypted, which may mean no personal data was actually
  exposed — record the reasoning either way.
- Take a fresh database dump and copy the relevant journal output somewhere safe
  **before** changing more state — you will need both for scope assessment.

## 3. Assess scope (same day)

Answer four questions in writing, using evidence, not guesses:

1. **What data?** Which tables/files could the access path reach — profile data,
   assessment results, documents? Tenant isolation limits blast radius to one
   institution unless the database itself was reached.
2. **Whose data?** Which users, which institutions. `audit_events` with its
   correlation IDs is the primary source: trace what the compromised principal
   actually did and when.
3. **What window?** First to last suspicious activity.
4. **Still open?** Confirm the access path is closed before writing "contained".

## 4. Notify (as required — do not skip)

- **Data Protection Board of India**: personal data breaches must be reported in
  the form and timeline prescribed under the DPDP Rules — involve the lawyer the
  same day; do not draft this alone.
- **Affected users**: plain-language notice — what happened, what data, what we
  did, what they should do (e.g., change password), and the grievance contact.
- **Affected institutions**: their placement leadership hears it from us before
  they hear it from students.
- If law enforcement is involved (theft, extortion), file and reference the FIR.

Never minimise in a notification. State what is known, what is not yet known, and
when the next update comes.

## 5. Recover and close

- Restore data integrity if anything was altered — [runbook-restore.md](runbook-restore.md)
  with a pre-incident dump; the incident log records exactly which one and why.
- Rotate every credential the attacker could have seen, not just the one used.
- Re-enable service, watch the monitor and journals closely for 48 hours.
- Post-mortem within a week: timeline, root cause, what detection missed, and the
  concrete fixes with owners and dates. The fixes go into the backlog as
  first-priority items — a breach root cause is never "accepted risk".

## Standing preparation (so this page works when needed)

- The weekly ops checklist proves backups and monitoring are alive.
- The vault holds: this runbook's location, the lawyer's contact, the grievance
  officer's mailbox credentials, and the backup private key.
- Every operator has read this page before getting server access.
