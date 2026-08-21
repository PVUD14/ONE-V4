# PlanThePath Next VPS UAT deployment

This directory contains the focused deployment pack for the temporary public UAT deployment at `https://one.ai8ht.pro`.

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
docker compose exec api pnpm db:migrate
```

If restoring the synthetic UAT dump:

```bash
docker compose cp /path/to/planthepath_uat.dump postgres:/tmp/planthepath_uat.dump
docker compose exec postgres pg_restore --clean --if-exists --no-owner --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" /tmp/planthepath_uat.dump
docker compose exec postgres rm -f /tmp/planthepath_uat.dump
docker compose exec api pnpm db:migrate
```

## Status

```bash
cd /srv/planthepath-next/deploy/vps
docker compose ps
curl -fsS http://api:3000/health
curl -fsS https://one.ai8ht.pro/health
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
docker compose exec api pnpm db:migrate
```

Write the deployed Git SHA to `/srv/planthepath-next/DEPLOYED_SHA`.

## Backup

Create backups outside any publicly served directory, for example:

```bash
mkdir -p /srv/planthepath-next/backups
chmod 700 /srv/planthepath-next/backups
docker compose exec postgres pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB" > /srv/planthepath-next/backups/planthepath_uat_$(date -u +%Y%m%dT%H%M%SZ).dump
chmod 600 /srv/planthepath-next/backups/*.dump
```

## Rollback

Rollback means redeploying the previous exact source SHA recorded in `DEPLOYED_SHA` while preserving the existing PostgreSQL volume. Do not destroy volumes during rollback. If a future migration is incompatible, stop and restore from a known-good backup rather than manually editing schema.
