# PlanThePath Next VPS UAT deployment

> **Moving to AWS.** Production moves to `https://oneby8.com` on AWS using this Compose
> pack (ADR-041). Follow `docs/ops/runbook-move-to-aws.md` for the cut-over; the Caddyfile
> already serves `oneby8.com` and forwards `www.oneby8.com` and `one.ai8ht.pro` to it.

> **This Compose pack is not what currently runs `https://one.ai8ht.pro`.**
>
> The live UAT host uses a release-directory deployment, not Docker Compose:
>
> - releases unpack to `/srv/planthepath-next/releases/<sha>/`, with `/srv/planthepath-next/current` symlinked to the active one;
> - environment comes from `/srv/planthepath-next/shared/app.env`;
> - the API runs under `systemctl` as `planthepath-api.service` on `127.0.0.1:7310`;
> - the web app is served as static files from `current/apps/web/dist`;
> - a release tarball is staged at `/home/aight/planthepath-deploy/planthepath-next-<sha>.tar` and verified by SHA-256 before extraction.
>
> Deploy and switch scripts for each release live in `.deploy/` in the repository
> working tree (untracked). `git pull` on the host does nothing, because the host
> holds unpacked release directories rather than a clone.
>
> The Compose pack below remains valid for standing up an independent environment
> from scratch; keep the two in step if the live host is ever migrated onto it.

> **Demo site.** The pack also serves `https://demo.oneby8.com` from a separate
> `web-demo` container: the sales demo, sample data only, no API route, no database
> (ADR-045, `docs/ops/runbook-demo-site.md`). Both web images refuse to build if the
> production image contains demo data or the demo image contains the real app.

## Security posture

- Reverse proxy publishes only `80/tcp` and `443/tcp`.
- PostgreSQL is private to the Docker network and has no host port mapping.
- API and web containers expose ports only inside the Docker network.
- n8n, automation workers and Mailpit are not part of this deployment.
- The API intentionally runs with `NODE_ENV=development` for this temporary UAT environment because approved non-production Cognito does not exist yet and production startup requires Cognito. Do not add fake Cognito values. Protected endpoints must remain `401/403`.
- Upgrade this deployment to production-mode runtime config once UAT Cognito identities and automation secrets are provisioned.

## First deploy

On the VPS:

```bash
cd /srv/planthepath-next/deploy/vps
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set a strong server-specific `POSTGRES_PASSWORD`.

Then:

```bash
docker compose up -d --build
docker compose exec -e ALLOW_PRODUCTION_MIGRATIONS=true -w /app api pnpm db:migrate
```

If restoring the synthetic UAT dump:

```bash
docker compose cp /path/to/planthepath_uat.dump postgres:/tmp/planthepath_uat.dump
docker compose exec postgres sh -lc 'pg_restore --clean --if-exists --no-owner --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" /tmp/planthepath_uat.dump'
docker compose exec postgres rm -f /tmp/planthepath_uat.dump
docker compose exec -e ALLOW_PRODUCTION_MIGRATIONS=true -w /app api pnpm db:migrate
```

## Status

```bash
cd /srv/planthepath-next/deploy/vps
docker compose ps
curl -fsS http://api:3000/health
curl -fsS https://oneby8.com/health
```

## Start

```bash
cd /srv/planthepath-next/deploy/vps
docker compose up -d
```

## Stop

```bash
cd /srv/planthepath-next/deploy/vps
docker compose down
```

Do not use `docker compose down -v` for normal operations.

## Restart

```bash
cd /srv/planthepath-next/deploy/vps
docker compose restart api web reverse-proxy
```

## Logs

```bash
cd /srv/planthepath-next/deploy/vps
docker compose logs --tail=200
```

## Update deployment

Before updating, record the current deployed SHA:

```bash
cat /srv/planthepath-next/DEPLOYED_SHA
```

Transfer the new exact clean source tree, then:

```bash
cd /srv/planthepath-next/deploy/vps
docker compose up -d --build
docker compose exec -e ALLOW_PRODUCTION_MIGRATIONS=true -w /app api pnpm db:migrate
```

Write the deployed Git SHA to `/srv/planthepath-next/DEPLOYED_SHA`.

## Backup

Create backups outside any publicly served directory, for example:

```bash
mkdir -p /srv/planthepath-next/backups
chmod 700 /srv/planthepath-next/backups
docker compose exec postgres sh -lc 'pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB"' > /srv/planthepath-next/backups/planthepath_uat_$(date -u +%Y%m%dT%H%M%SZ).dump
chmod 600 /srv/planthepath-next/backups/*.dump
```

## Rollback

Rollback means redeploying the previous exact source SHA recorded in `DEPLOYED_SHA` while preserving the existing PostgreSQL volume. Do not destroy volumes during rollback. If a future migration is incompatible, stop and restore from a known-good backup rather than manually editing schema.
