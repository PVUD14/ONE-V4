# Runbook — the sandbox at demo.oneby8.com

demo.oneby8.com is ONE's sales demo: **the real application**, the same code as
`oneby8.com`, running over its **own database of fictional sample data** (ADR-046). It
replaced the browser-only mock of ADR-045. Two locks stand in front of it:

1. **The front door** — a username and password per person (Caddy basic auth). Nobody
   without a line in `demo-access/users.caddy` sees anything, not even the sign-in page or
   the API.
2. **A demo account** — each persona (student, placement officer, employer, …) is an
   account in the sandbox's own Cognito user pool. It decides which single workspace the
   person sees, through the same authorization code as production.

The marketing walkthrough is `docs/marketing/demo-script.md`. Divakar runs every step that
touches AWS, DNS or the server. Nothing here is automated except the nightly reset.

What runs where:

| Container | What it is | Networks |
|---|---|---|
| `postgres-demo` | The sandbox database `one_sandbox`, its own volume `postgres-demo-data` | `demo-db` (no route out) |
| `api-demo` | The same API image as production, pointed at `postgres-demo` and the sandbox Cognito pool | `demo-db`, `demo-edge` |
| `web-sandbox` | The real web app built with `VITE_SANDBOX=true` ("Demo — sample data" on every screen) | `demo-edge` |
| `sandbox-reset` | A one-off job: drop, migrate and seed the sandbox database | `demo-db` |
| `reverse-proxy` | Caddy, serving both hosts | `internal`, `demo-edge` |

Production's `api` and `postgres` are only on `internal`; nothing of the sandbox is. The
sandbox cannot resolve or reach production's API or database, and production cannot reach
the sandbox's. The sandbox sends no email (no SMTP settings are passed to it).

## 0. Server size

The sandbox adds three long-running containers, capped in `docker-compose.yml`:

| Container | Memory cap | Measured locally (seeded, idle) |
|---|---|---|
| `postgres-demo` | 384 MB | about 60 MB (75 MB while being reset) |
| `api-demo` | 512 MB | about 70–100 MB |
| `web-sandbox` | 64 MB | about 17 MB |

Plan for **about 1 GB more RAM** than production alone, plus about 2 GB of disk for the
extra images and the sandbox volume. Building the images (`docker compose up --build`)
needs the most memory: on a server with less than 4 GB, build one image at a time with
`sudo COMPOSE_PARALLEL_LIMIT=1 docker compose up -d --build`. The nightly reset runs a
short-lived container (about 200 MB at its peak, measured) for about a minute.

## 1. DNS (once — already done for ADR-045)

`A  demo → <the AWS server's Elastic IP>` at the oneby8.com DNS provider. Check:
`nslookup demo.oneby8.com 8.8.8.8`.

## 2. The sandbox's own Cognito user pool (once, in the AWS console)

The sandbox must never share a pool with production: a demo account must not be able to
sign in to oneby8.com, and no real account to the sandbox. Use region **ap-south-1
(Mumbai)**, like production.

1. **Amazon Cognito → User pools → Create user pool.**
   - Application type: **Single-page application (SPA)**. Name the application
     `one-sandbox-web`.
   - Options for sign-in identifiers: **Email** only.
   - **Self-registration: off** (untick "Enable self-registration"). Only you create
     demo accounts.
   - Required attributes for sign-up: **email**.
   - Return URL: `https://demo.oneby8.com/auth/callback`.
   - Create. Rename the pool to `one-sandbox` (User pool → Overview → Rename) so it is
     never confused with production's pool (`ap-south-1_nPl3qFkvB`).
2. **The app client** (User pool → App integration → App clients → `one-sandbox-web`):
   - It must have **no client secret** (the SPA type does this).
   - Login pages → Edit:
     - Allowed callback URLs: `https://demo.oneby8.com/auth/callback` (only this one)
     - Allowed sign-out URLs: `https://demo.oneby8.com/login` (only this one)
     - Identity providers: **Cognito user pool**
     - OAuth 2.0 grant types: **Authorization code grant**
     - OpenID Connect scopes: **openid, email, profile**
   - Save. Copy the **Client ID**.
3. **The sign-in domain** (User pool → Branding → Domain): the wizard creates a Cognito
   domain. If you create one yourself, use the prefix `one-sandbox-221388536238`. Copy the
   full `https://….auth.ap-south-1.amazoncognito.com` address.
4. **Copy the User pool ID** from the pool's Overview (`ap-south-1_…`).
5. **Create the ten demo accounts** (User pool → User management → Users → Create user),
   one per row below, each with:
   - Invitation message: **Don't send an invitation**
   - Email address: as in the table; tick **Mark email address as verified**
   - Temporary password: **Set a password** (a strong one per account; never write it in
     a ticket, the repository or a group chat)

   | Persona (for `DEMO_ACCOUNT_SUBJECTS`) | Email address | Lands in |
   |---|---|---|
   | `student` | `student@demo.oneby8.com` | Student — Arjun Reddy, final-year CSE |
   | `graduate` | `graduate@demo.oneby8.com` | Student workspace of a graduate — Kavitha Selvam |
   | `placement` | `placement@demo.oneby8.com` | Placement Admin — Prof. Meera Nair |
   | `institution-admin` | `institution-admin@demo.oneby8.com` | Institution — Dr. Lakshmi Menon |
   | `lecturer` | `lecturer@demo.oneby8.com` | Faculty — Prof. Suresh Raman |
   | `department-head` | `department-head@demo.oneby8.com` | Department Head — Dr. Farah Siddiqui |
   | `employer` | `employer@demo.oneby8.com` | Employer (recruiter) — Rohan Iyer |
   | `employer-owner` | `employer-owner@demo.oneby8.com` | Employer (owner) — Neha Kapoor |
   | `operations` | `operations@demo.oneby8.com` | Operations — Ananya Kulkarni |
   | `growth` | `growth@demo.oneby8.com` | Growth executive — Vikram Shetty |

   These addresses receive no mail; `demo.oneby8.com` has no mailbox. That is fine: you
   verify the accounts yourself, and the sandbox sends no email.
6. **Make each password permanent**, so nobody is asked to change it in front of an
   audience. Either sign in once as each account at https://demo.oneby8.com (after
   section 5) and set the permanent password when asked, or in **AWS CloudShell** (the
   `>_` icon in the console, region ap-south-1), once per account:

   ```bash
   aws cognito-idp admin-set-user-password --user-pool-id ap-south-1_XXXXXXXXX \
     --username student@demo.oneby8.com --password '<the password>' --permanent
   ```

   CloudShell keeps a shell history; clear it afterwards with `history -c`.
7. **Copy each account's sub**: open the user (Users → click the email) and copy
   **User ID (sub)**. These go into the server `.env` as `DEMO_ACCOUNT_SUBJECTS` — that is
   how the sandbox knows which account is which persona.

## 3. The server `.env` (once)

On the server, `sudo nano /srv/one/deploy/vps/.env`, and add (see `.env.example`):

```bash
COMPOSE_PROFILES=sandbox
DEMO_POSTGRES_PASSWORD=<run: openssl rand -hex 24>     # never production's password
DEMO_COGNITO_USER_POOL_ID=ap-south-1_XXXXXXXXX          # step 2.4
DEMO_COGNITO_CLIENT_ID=<the client id>                  # step 2.2
DEMO_COGNITO_DOMAIN=https://<prefix>.auth.ap-south-1.amazoncognito.com   # step 2.3
DEMO_ACCOUNT_SUBJECTS=student=<sub>,graduate=<sub>,placement=<sub>,institution-admin=<sub>,lecturer=<sub>,department-head=<sub>,employer=<sub>,employer-owner=<sub>,operations=<sub>,growth=<sub>
```

None of the `DEMO_COGNITO_*` values or subs is a password; `DEMO_POSTGRES_PASSWORD` is, and
lives only in this file. Leave `COMPOSE_PROFILES` blank to keep the sandbox off — then
oneby8.com runs exactly as before and demo.oneby8.com answers "bad gateway" behind the
front door.

## 4. Install (with the release that contains branch `feat/demo-sandbox`)

```bash
cd /srv/one && git fetch && git checkout <release commit>
cd deploy/vps
sudo docker compose up -d --build --remove-orphans
sudo docker compose up -d --force-recreate reverse-proxy     # first time only
```

- `--remove-orphans` removes the retired `web-demo` container (ADR-045's mock).
- The forced recreate puts Caddy on the sandbox network.
- Both web images check themselves while building: the oneby8.com image fails if it
  contains pilot sample data or the sandbox marker; the sandbox image fails if it is not
  the real application with the marker. If the build stops with `check-demo-boundary ...
  FAILED`, do not work around it — the release is wrong.
- The web-sandbox image bakes the `DEMO_COGNITO_*` values in at build time: after changing
  them, run `sudo docker compose up -d --build web-sandbox`.

## 5. Load the sample data (first time, and whenever you add or change a sub)

```bash
cd /srv/one/deploy/vps
sudo docker compose --profile sandbox stop api-demo worker-demo ai-content-demo
sudo docker compose --profile sandbox --profile sandbox-tools run --rm sandbox-reset
sudo docker compose --profile sandbox start api-demo worker-demo ai-content-demo
```

(The sandbox API and workers are stopped while the database is dropped and recreated; left
running, they crash on the closed connections and Docker restarts them, which is harmless but
noisy. Both profiles must be named: `sandbox-reset` is in `sandbox-tools` but depends on
`postgres-demo` in `sandbox`, and a `--profile` flag replaces `COMPOSE_PROFILES` rather than
adding to it, so naming only one fails with "depends on undefined service".)

It prints `sandbox reset: ... migrations applied` and `sandbox reset: seeded 30 students,
2 graduates, 10 demo accounts; sign-in bound for …`. Any persona listed under "not yet
bound" has no sub in `DEMO_ACCOUNT_SUBJECTS` and cannot sign in yet.

The job **refuses** to run unless the database is the sandbox's: `ONE_SANDBOX=true` (set
by the job), a database name ending in `_sandbox`, the host `postgres-demo`, and not
production mode. It never touches the production database: nothing in it knows
production's address or password, and it is not on production's network.

## 6. Nightly reset (once)

Every night at 02:30 India time the sandbox goes back to the sample data, so each day's
demos start from the same story. Install the timer:

```bash
cd /srv/one
sudo cp deploy/vps/demo-sandbox/one-sandbox-reset.service deploy/vps/demo-sandbox/one-sandbox-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now one-sandbox-reset.timer
systemctl list-timers one-sandbox-reset.timer        # shows the next run
```

The unit assumes the pack lives in `/srv/one/deploy/vps`; edit `WorkingDirectory` if not.
Last night's result: `journalctl -u one-sandbox-reset.service -n 30`. Reset by hand any
time with section 5 (about a minute; the sandbox shows errors while it runs).

## 7. Who may open the demo (the front door, per person)

Unchanged from ADR-045. The list lives only on the server, in
`/srv/one/deploy/vps/demo-access/users.caddy`, one person per line, never committed:

```bash
cd /srv/one/deploy/vps
sudo docker compose exec reverse-proxy caddy hash-password      # type their password twice
sudo nano demo-access/users.caddy                               # add:  priya <the hash it printed>
sudo docker compose exec reverse-proxy caddy reload --config /etc/caddy/Caddyfile
```

Remove a person: delete their line and run the same `caddy reload`. With no list the
demo is locked to everyone; oneby8.com is never affected.

**Each marketing person sees only what their demo needs:** give them their own front-door
login, and only the demo-account passwords for the stories they present — for example a
college-facing presenter gets `student`, `placement` and `lecturer`; an employer-facing
one gets `employer` and `student`. Share passwords one to one.

## 8. Check

- [ ] `https://demo.oneby8.com` asks for the front-door username and password.
- [ ] After it: the real ONE sign-in page with **"Demo — sample data"** at the top.
- [ ] Sign in as `student@demo.oneby8.com`: Arjun Reddy's student workspace opens
      directly, with the marker on every page; Opportunities lists *Graduate Software
      Engineer* and *Data Analyst Intern*.
- [ ] Sign out, sign in as `placement@demo.oneby8.com`: the Placement Admin workspace
      only (no student or employer workspace offered).
- [ ] Sign in to **https://oneby8.com** with `student@demo.oneby8.com`: it must fail
      (that account does not exist in the production pool).
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://demo.oneby8.com/health` → `401`
      (the front door covers the API too); with `-u <you>:<password>` → `200`.
- [ ] `curl -fsS https://oneby8.com/health` → `{"status":"ok"}`; oneby8.com unchanged.
- [ ] `curl -sI -u <you>:<password> https://demo.oneby8.com | grep -i x-robots-tag` →
      `noindex, nofollow`.
- [ ] `systemctl list-timers one-sandbox-reset.timer` shows the next reset.

## Day to day

- **Before a demo:** sign in once as each persona you will use. If yesterday's visitors
  left a mess, run section 5.
- **Two presenters, one persona:** they share the same data and see each other's changes
  until the nightly reset. Give concurrent demos different personas.
- **What does not work in the sandbox (as on production today):** email, file uploads
  (no storage or virus scanner is configured), AI features. The demo script says so.
- **Adding a persona's sign-in later:** create the Cognito user (steps 2.5–2.7), add
  `persona=sub` to `DEMO_ACCOUNT_SUBJECTS`, then section 5.
- **Updating:** the sandbox ships with each release; `docker compose up -d --build`
  rebuilds it with the main site.
- **Stopping only the sandbox:** set `COMPOSE_PROFILES=` in `.env`, then
  `sudo docker compose up -d --remove-orphans`. oneby8.com keeps running. The sample data
  stays in the `postgres-demo-data` volume until you remove it.

## Rollback

`COMPOSE_PROFILES=` and `sudo docker compose up -d --remove-orphans` stops the sandbox;
`sudo systemctl disable --now one-sandbox-reset.timer` stops the reset. Neither touches
oneby8.com, its API or its database. The sandbox Cognito pool can be deleted in the console
without affecting production's pool.

## Developers: running the sandbox locally

```bash
# a local database whose name ends in _sandbox, on 127.0.0.1
export DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:55432/dev_sandbox
corepack pnpm db:migrate
ONE_SANDBOX=true corepack pnpm db:seed:sandbox            # refuses without ONE_SANDBOX=true
ONE_SANDBOX=true corepack pnpm db:reset:sandbox           # drop, migrate, seed
VITE_SANDBOX=true corepack pnpm web:dev                   # the marker on every screen
```

Prove the boundary on local builds:

```bash
corepack pnpm --filter @planthepath/web build
node apps/web/scripts/check-demo-boundary.mjs apps/web/dist production
VITE_SANDBOX=true corepack pnpm --filter @planthepath/web exec vite build --outDir /tmp/one-sandbox-dist --emptyOutDir
node apps/web/scripts/check-demo-boundary.mjs /tmp/one-sandbox-dist sandbox
```

## AI in the demo (ENG-22 tutor hints, ENG-23 content drafts)

AI may only ever switch on in the sandbox. Its endpoint is the demo's own `DEMO_ONE_AI_*`
in `.env`; production's `ONE_AI_*` stay blank, so this cannot reach oneby8.com.

1. Start the RunPod pod and run `deploy/ai-pod/setup-pod.sh` on it (ADR-047).
2. In `.env` set `DEMO_ONE_AI_BASE_URL=https://<pod-id>-8888.proxy.runpod.net/v1`,
   `DEMO_ONE_AI_MODEL=<served model name>`, and `DEMO_ONE_AI_API_KEY=` the key from
   `/root/one-ai/api-key` on the pod (typed on the server only).
3. `sudo docker compose up -d` — this (re)starts `api-demo`, `worker-demo` (tutor hints)
   and `ai-content-demo` (content drafts) with the new values.
4. Inside the sandbox: `ai:register-features`, record the bake-off for the served model with
   `ai:bake-off-import` (the gate refuses to switch a feature on without a PASS), run
   `ai:tutor-sandbox-consent`, then switch `tutor.hint` and `content.lesson-draft` on in
   AI Operations with a second person. Detail: `runbook-tutor-hints-sandbox.md` and
   `sop-ai-operations.md` §F.
5. The nightly reset clears step 4; re-run it before a demo day, or after the reset.

Stop the pod when not demoing: the workers then report the endpoint unreachable and every
request falls back (tutor shows the written hint; drafts are refused, nothing lands).
