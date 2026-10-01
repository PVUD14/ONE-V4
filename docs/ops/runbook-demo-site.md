# Runbook — the demo site at demo.oneby8.com

The demo site is ONE's sales demo: every role (student, graduate, placement officer,
lecturer, employer, operations, growth) over fictional sample data, with no sign-in.
It runs on the same AWS server as `oneby8.com`, in its own container (`web-demo`), and
has no route to the API or the database (ADR-045). The marketing team's walkthrough is
`docs/marketing/demo-script.md`.

Divakar runs every step that touches the server or DNS. Nothing here is automated.

## 1. DNS (once)

At the oneby8.com DNS provider, add:

```
A   demo   →   <the AWS server's Elastic IP>      (the same address as oneby8.com)
```

Check from any machine: `nslookup demo.oneby8.com 8.8.8.8` shows that address.
Caddy cannot get the certificate until this resolves, so do it first.

## 2. Install (with the release that contains branch `feat/demo-site`)

On the AWS server, in the Compose pack:

```bash
cd /srv/one && git fetch && git checkout <release commit>
cd deploy/vps
sudo docker compose up -d --build
```

That one command now builds and starts three web-facing pieces: `web` (oneby8.com),
`web-demo` (demo.oneby8.com) and `reverse-proxy` (Caddy, which picks up the new
`demo.oneby8.com` block from the Caddyfile). No `.env` change is needed - the demo
needs no settings, no secrets and no database. No migration is involved.

Both web images check themselves while building: the oneby8.com image fails to build
if it contains any demo sample data, and the demo image fails if it contains the real
application. If `docker compose up --build` stops with `check-demo-boundary ... FAILED`,
do not work around it - the release is wrong; tell the developer.

If Caddy was already running and does not pick up the new site, restart it:
`sudo docker compose restart reverse-proxy`.

## 2a. Who may open the demo (a login per person)

demo.oneby8.com asks for a username and password before showing anything. The list of
people lives only on the server, in `/srv/one/deploy/vps/demo-access/users.caddy`, one
person per line. It is never committed, and nobody's password is stored in plain text.
With no list the demo is locked to everyone; oneby8.com is never affected.

Add a person (on the server):

```bash
cd /srv/one/deploy/vps
sudo docker compose exec reverse-proxy caddy hash-password      # type their password twice
sudo nano demo-access/users.caddy                               # add:  priya <the hash it printed>
sudo docker compose exec reverse-proxy caddy reload --config /etc/caddy/Caddyfile
```

Remove a person: delete their line, then run the same `caddy reload`. Give each person
their own username so one can be removed without changing everyone's password, and
share passwords one to one, never in a group chat.

The first time this release is installed, recreate the front door so it picks up the new
settings and the access folder: `sudo docker compose up -d --force-recreate reverse-proxy`.

## 3. Check

- [ ] `https://demo.oneby8.com` shows the ONE logo, "LEARN | PREPARE | BUILD | GROW",
      the "Demo — sample data" marker and seven role cards, with a padlock.
- [ ] Open each role once; every page shows "Demo — sample data" at the top.
- [ ] `https://demo.oneby8.com/api/me` answers **404 "Not available on the demo site"**
      (the demo host never reaches the API).
- [ ] `https://oneby8.com` is unchanged: the sign-in page, and `curl -fsS
      https://oneby8.com/health` → `{"status":"ok"}`.
- [ ] `curl -sI https://demo.oneby8.com | grep -i x-robots-tag` shows
      `noindex, nofollow` (kept out of search engines).

Send the marketing team the link `https://demo.oneby8.com` and the script. They need
no account and no password.

## 4. Retire the old demo accounts (once, after the check)

Production no longer contains the pilot (ADR-045): a `demo.*` account that signs in to
`oneby8.com` now gets the ordinary application, with no workspace. To stop anyone
using them, in the AWS console → Amazon Cognito → the user pool → Users, **disable**
each `demo.*` user (disable, not delete, until you are sure nothing else uses them).
The demo-password rotation in `runbook-demo-prep.md` is then no longer needed.

## Day to day

- **Reset:** every visitor's demo resets when they reload the page. There is nothing to
  clean up between demos and nothing is stored.
- **Before a demo:** open `https://demo.oneby8.com` on the presenting laptop and click
  into the roles you will show. There is no password to check.
- **Updating the demo:** it ships with each release, like the main site. The next
  `docker compose up -d --build` rebuilds both.
- **Stopping only the demo:** `sudo docker compose stop web-demo` (Caddy then shows an
  error page on demo.oneby8.com; oneby8.com is unaffected). Start again with
  `sudo docker compose start web-demo`.

## Rollback

Remove the `A demo` DNS record, or `sudo docker compose stop web-demo`. Neither touches
`oneby8.com`, its API or its database.

## Developers: running the demo site locally

```bash
VITE_DEMO_SITE=true corepack pnpm --filter @planthepath/web dev     # 127.0.0.1:5173
```

Prove the boundary on local builds:

```bash
corepack pnpm --filter @planthepath/web build
node apps/web/scripts/check-demo-boundary.mjs apps/web/dist production
VITE_DEMO_SITE=true corepack pnpm --filter @planthepath/web exec vite build --outDir /tmp/one-demo-dist --emptyOutDir
node apps/web/scripts/check-demo-boundary.mjs /tmp/one-demo-dist demo
```
