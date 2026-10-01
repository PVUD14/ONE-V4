# Runbook — Client demo: before and after

**The demo now lives at `https://demo.oneby8.com` (ADR-045).** It needs no account and
no password, it resets when the page is reloaded, and production (`oneby8.com`) no
longer contains the pilot at all. Setup and checks: `docs/ops/runbook-demo-site.md`.
The marketing walkthrough: `docs/marketing/demo-script.md`.

## Before the demo (day before, 10 minutes)

1. Open `https://demo.oneby8.com` on the laptop you will present from. You should see
   the ONE logo, "LEARN | PREPARE | BUILD | GROW", "Demo — sample data" and seven roles.
2. Click through the flow you plan to show (`docs/marketing/demo-script.md`). The demo
   resets on reload by design - rehearse with that in mind.
3. Check no release is scheduled during the demo window (a release rebuilds the demo
   container too). If one is in flight, finish or postpone it.

## During the demo

- Say once, at the start, that everything on screen is sample data.
- When an audience asks "can we use this today?", answer from the "Live in the real
  app?" notes in the demo script - never from the demo screen alone.

## After the demo

Nothing to rotate or clean up: there are no demo accounts and nothing is saved.

## Retired: demo accounts on production

Until ADR-045 the pilot ran inside production for Cognito users named `demo.*`, with a
shared password rotated after every demo. That arrangement is retired. Divakar
disables the `demo.*` users once the demo site is live
(`runbook-demo-site.md`, step 4). If any `demo.*` password was ever shared outside the
vault, disabling the users closes it.

## Credential hygiene rules (standing)

- The UAT credential sheet is a vault item, shared per-person. The legacy local
  text file copy is retired once the vault holds it; no new copies are made.
- Real user accounts are never used in demos; the demo site's fictional people only.
- If a password is ever typed into the wrong place (a chat, a commit, a recording),
  rotate it that day.
