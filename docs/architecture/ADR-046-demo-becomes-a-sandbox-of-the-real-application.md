# ADR-046 — demo.oneby8.com becomes a sandbox of the real application

Records why the demo host stops serving a browser-only mock and serves the real application
over its own database of sample data, and what that changes on the server.

- **Status:** Accepted — Divakar, 2026-10-01: the mock "shows placeholders" (he tried to
  build a resume and got one); he wants the demo "to run on the real engine", with a login
  where each marketing person sees only what their demo needs, never public. Takes effect
  when he installs the release that carries it and follows `docs/ops/runbook-demo-site.md`.
- **Supersedes:** ADR-045 decisions 1, 2 and 6 (the in-browser `DemoSite` served by
  `web-demo`). ADR-045's other decisions stand: the demo lives on its own host, production
  carries no demo, the boundary is proved on the built files, and the demo obeys the
  product's rules. ADR-045 is not edited; this record replaces the parts named here.

## Context

ADR-045 rejected "a demo backend with a seeded database" because it doubled what runs on
the server, needed its own sign-in, and the real screens were thin. Since then the real
screens have caught up (pilot parity on every role, placement register, campus drives,
growth workspace), and the mock became the weak point: it can only show what someone
scripted, so anything a presenter tries off-script is a placeholder. A college watching a
demo wants to see the product, not a picture of it.

## Decision

1. **Same code, separate stack.** The Compose pack gains `postgres-demo` (its own volume,
   database `one_sandbox`), `api-demo` (the same API image as production) and
   `web-sandbox` (a normal build of the real web app with `VITE_SANDBOX=true`, API origin
   `https://demo.oneby8.com`). They sit on their own Docker networks: `demo-db` (no route
   out) for the API and its database, `demo-edge` for the API, the sandbox web and Caddy.
   Production's `api` and `postgres` are only on `internal`; the sandbox's containers are
   never on it. Caddy is the one container on both, because it serves both hosts. The
   sandbox services carry the Compose profile `sandbox`, so nothing starts until Divakar
   sets `COMPOSE_PROFILES=sandbox`, and production's `docker compose up` is unchanged.
2. **Its own sign-in pool.** `api-demo` and `web-sandbox` use a separate Cognito user pool
   (`DEMO_COGNITO_*` in the server `.env`, blank by default). A demo account cannot sign in
   to oneby8.com and no real account can sign in to the sandbox, because each API verifies
   tokens against its own pool only. No SMTP, automation secret or staff pool is passed to
   `api-demo`: the sandbox never emails anyone.
3. **One account per persona, mapped the way the API already maps people.** The API finds a
   user by `users.external_subject = <Cognito sub>` and nothing else. The seed creates one
   sample user per persona (student, graduate, placement officer, institution admin,
   lecturer, department head, recruiter, employer owner, operations, growth executive) with
   the membership or student relationship that role has in the real product, and binds each
   to its sandbox-pool sub from `DEMO_ACCOUNT_SUBJECTS`. Each persona therefore sees exactly
   its own workspace, enforced by the same authorization code as production — there is no
   demo-specific permission logic.
4. **Two locks.** Caddy's per-person basic-auth gate (ADR-045, commit db3ad06) stays in front
   of every request to the demo host, pages and API alike. Behind it, the persona sign-in
   decides the workspace. Because the browser keeps sending the gate's credentials in
   `Authorization`, the sandbox build sends its access token as `X-One-Authorization` and
   Caddy turns it back into `Authorization` for `api-demo`; the gate's credentials never
   reach the API. Production's build sends `Authorization` exactly as before.
5. **A sandbox seed and a nightly reset.** `db:seed:sandbox` loads the fictional Lakeview
   Institute of Technology, ~30 students with verified academic records and evidence, two
   graduates, Corvane Labs with three published jobs, applications at every stage, an
   interview, offers, an approved campus drive, a growth team with a Karnataka territory and
a pipeline of fictional prospective colleges (GROWTH-02/03 tables). Content goes through the
   real publishing code (the career-readiness pilot, the career catalogue, the aptitude bank
   as drafts, learner cards through review) and readiness bands are computed by the
   readiness engine from evidence, never typed in. `db:reset:sandbox` drops the database,
   migrates and seeds; a systemd timer runs it nightly.
6. **The seed cannot reach production.** Both scripts refuse unless `ONE_SANDBOX=true`, the
   database name ends in `_sandbox`, the host is `postgres-demo` or loopback, and
   `NODE_ENV` is not production; the seed also refuses a database holding any account whose
   address is not a sample address (`@demo.oneby8.com` or `*.example`). No override exists.
7. **The mock is retired.** `apps/web/src/demoSite/` and the `web-demo` service are removed.
   `check-demo-boundary.mjs` now proves: production carries no pilot fiction and no sandbox
   marker; the sandbox build is the real app, carries the marker, and ships no pilot fiction
   either (its sample people live in its database, not its bundle). Every sandbox screen
   shows "Demo — sample data".

## Rejected

- **Keeping the mock and filling its placeholders.** Every new feature would be built twice,
  and the mock would still drift from the product it sells.
- **Demo accounts in the production pool or database.** One misconfigured role and a demo
  account sees real students; and production would carry fiction. ADR-045 already removed
  this.
- **Sharing the production Postgres server with a second database.** Cheaper by one
  container, but a mistaken connection string or a runaway demo query would land on
  production's server. A separate container and volume make the isolation physical.
- **Binding demo logins by email on first sign-in.** Cognito access tokens carry no email,
  and adding an email-binding path to the API would be new authentication code that exists
  only for the demo. Mapping by sub uses the identity path production already uses.
- **Driving the seed through the HTTP API with a stub verifier.** Would exercise more code,
  but ships a token-trusting verifier inside the production image. The seed writes rows the
  way the API does and calls the persistence functions where they exist; an integration
  test then proves every persona through the real HTTP routes.
- **Opening the sandbox API without the gate (relying on Cognito alone).** Unauthenticated
  routes (health, public profile links) would be reachable by anyone; Divakar asked that the
  demo never be public.
- **A cron loop inside a container for the reset.** A long-running container that sleeps is
  harder to see and stop than a systemd timer Divakar can list with `systemctl list-timers`.

## Consequences

- The server runs three more containers when the sandbox is on: about 0.9 GB of RAM at the
  caps set in Compose (Postgres 384 MB, API 512 MB, web 64 MB), and one more image build of
  the API and the web app per release. Divakar sizes the instance for it (runbook).
- Divakar creates a second Cognito pool and ten users once, and shares persona passwords
  per person; the runbook has the console steps.
- Anything a visitor changes in the sandbox is real for the rest of that day and gone after
  the nightly reset. Two presenters using the same persona at once see each other's changes.
- Features that need infrastructure the sandbox does not have stay off there exactly as on
  production: no email, no file uploads (no storage or scanner), no AI. The demo script says
  so where it matters.
- Android is unaffected: it talks to production only.
