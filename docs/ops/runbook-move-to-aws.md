# Runbook — move ONE to oneby8.com on AWS

The one-time cut-over from the VPS (`one.ai8ht.pro`) to the AWS server at
`oneby8.com` (ADR-041). Divakar runs every step that touches a server; nothing here
is automated, and nothing reaches the AWS server from the repository.

Uses the Compose pack in `deploy/vps/` (Postgres, API, web and Caddy in containers,
with automatic HTTPS).

## 0. Before you start (AWS console and DNS)

- [ ] **Elastic IP.** EC2 → Elastic IPs → Allocate → Associate with the ONE server.
      The auto-assigned public address changes if the instance is ever stopped.
      If the Elastic IP differs from `35.154.212.202`, update the `oneby8.com` DNS
      record to it.
- [ ] **Security group.** Inbound: `80/tcp` and `443/tcp` from `0.0.0.0/0` (the web),
      `22/tcp` from your own IP only (SSH). Nothing else — Postgres is never exposed.
- [ ] **DNS at the oneby8.com registrar:** `A  @  → <server IP>` and
      `A  www → <server IP>` (or `CNAME www → oneby8.com`). Check from any machine:
      `nslookup oneby8.com 8.8.8.8` and `nslookup www.oneby8.com 8.8.8.8` both show
      the server's address.
- [ ] **Instance size.** At least 2 vCPU / 4 GB RAM and 30 GB disk: the images are
      built on the server.

## 1. Prepare the server (once)

```bash
ssh -i <your key> ubuntu@<server IP>        # user depends on the AMI: ubuntu, ec2-user…
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && exit       # log in again for the group to apply
```

Get the code (a clone of the release commit Divakar chooses):

```bash
sudo mkdir -p /srv/one && sudo chown $USER /srv/one
git clone <repo URL> /srv/one && cd /srv/one && git checkout <release commit>
```

## 2. Settings

```bash
cd /srv/one/deploy/vps
cp .env.example .env && chmod 600 .env
nano .env                     # set POSTGRES_PASSWORD (openssl rand -base64 32)
```

Already set in `docker-compose.yml`: `API_CORS_ORIGIN` and `PTP_INVITATION_BASE_URL`
are `https://oneby8.com`, `PTP_MAIL_FROM` is `info@ai8ht.pro`. The Caddyfile serves
`oneby8.com`, forwards `www.oneby8.com` and `one.ai8ht.pro`, and sends certificate
notices to `info@ai8ht.pro`.

## 3. Start

```bash
docker compose up -d --build
docker compose exec -w /app api pnpm db:migrate
docker compose exec -w /app api pnpm db:migrate     # second run: "0 applied"
```

Caddy fetches the `oneby8.com` certificate on first request; allow a minute.

## 4. Data

Choose one:

- **Fresh start** — nothing further; accounts are created through the app.
- **Carry the VPS data across** — on the VPS, `pg_dump -Fc` the database; copy the
  dump to the AWS server; then:

  ```bash
  docker compose cp one.dump postgres:/tmp/one.dump
  docker compose exec postgres sh -lc 'pg_restore --clean --if-exists --no-owner --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" /tmp/one.dump'
  docker compose exec postgres rm -f /tmp/one.dump
  docker compose exec -w /app api pnpm db:migrate
  ```

  Delete the dump from both machines and from your laptop afterwards.

## 5. Check

- [ ] `curl -fsS https://oneby8.com/health` → `{"status":"ok"}`
- [ ] `https://oneby8.com` shows the sign-in page with a padlock.
- [ ] `https://www.oneby8.com/login` lands on `https://oneby8.com/login`.
- [ ] Sign in with a `@uat.example.test` account for each role.
- [ ] Android: install the build with `API_BASE_URL = https://oneby8.com`
      (versionCode 2) and sign in.

## 6. Retire one.ai8ht.pro

- [ ] At the ai8ht.pro DNS provider, point `one.ai8ht.pro` (`A` record) at the AWS
      server IP. Caddy then issues its certificate and forwards every request to
      `oneby8.com`, keeping the path.
- [ ] Check `https://one.ai8ht.pro/login` lands on `https://oneby8.com/login`.
- [ ] Take a final backup of the VPS database, keep it offline, then shut the VPS down.

## Rollback

Until step 6, the VPS is untouched: point `oneby8.com` nowhere (or at the VPS) and
users keep using `one.ai8ht.pro`. After step 6, point `one.ai8ht.pro` back at the VPS
address (`97.74.95.205`) and start its service again.

## Not covered yet

- **Outgoing email** still goes nowhere outside the server: only a loopback Mailpit
  sender exists (ADR-041, "Known gap"). Invitations and notices are not delivered
  until authenticated SMTP delivery is built.
- **Cognito.** The API stays in development-mode sign-in until a production user pool
  is provisioned. When it is, register `https://oneby8.com` callback and sign-out URLs
  in the web app client.
- **Backups and monitoring timers** (`deploy/systemd`) were written for the VPS layout
  under `/srv/planthepath-next`; adapt the paths before enabling them on AWS.
