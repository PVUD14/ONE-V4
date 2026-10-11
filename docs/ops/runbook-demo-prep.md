# Runbook — Client demo: before and after

**The demo lives at `https://demo.oneby8.com` (ADR-046):** the real application over its
own database of sample data, behind a per-person front-door login and a demo account per
role. It resets every night, not on reload. Production (`oneby8.com`) contains no demo.
Setup and checks: `docs/ops/runbook-demo-site.md`. The marketing walkthrough:
`docs/marketing/demo-script.md`.

## Before the demo (day before, 10 minutes)

1. Open `https://demo.oneby8.com` on the laptop you will present from, pass the front
   door with your own login, and sign in as each demo account you will use. Every screen
   shows "Demo — sample data".
2. Walk the story you plan to show (`docs/marketing/demo-script.md`). What you change
   stays changed until the nightly reset; if the story is out of shape, ask Divakar to
   reset the sandbox (runbook section 5).
3. Check no release is scheduled during the demo window (a release rebuilds the sandbox
   too). If one is in flight, finish or postpone it.

## During the demo

- Say once, at the start, that everything on screen is sample data.
- When an audience asks "can we use this today?", answer from the "Live in the real
  app?" notes in the demo script - never from the demo screen alone.

## After the demo

Nothing to clean up: the nightly reset restores the sample data. If a demo-account or
front-door password was seen by someone it was not given to, change it that day (Cognito
console for a demo account; `users.caddy` for the front door).

## Retired: demo accounts on production

Until ADR-045 the pilot ran inside production for Cognito users named `demo.*`, with a
shared password rotated after every demo. That arrangement is retired. Divakar
disables the `demo.*` users once the demo site is live
(`runbook-demo-site.md`, step 4). If any `demo.*` password was ever shared outside the
vault, disabling the users closes it.

## Credential hygiene rules (standing)

- The UAT credential sheet is a vault item, shared per-person. The legacy local
  text file copy is retired once the vault holds it; no new copies are made.
- Real user accounts are never used in demos; the sandbox's fictional people only. The
  sandbox's demo accounts live in their own Cognito pool and cannot sign in to oneby8.com.
- If a password is ever typed into the wrong place (a chat, a commit, a recording),
  rotate it that day.
