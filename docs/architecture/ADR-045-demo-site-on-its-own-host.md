# ADR-045 — The demo lives on demo.oneby8.com, and production carries no demo

Records where ONE's sales demo is served from, and what that changes for the
production site.

- **Status:** Proposed (branch `feat/demo-site`; Divakar asked for "the demo site" on
  2026-10-01 and accepts it by merging and installing it)
- **Supersedes:** the arrangement in `docs/ops/runbook-demo-prep.md` where the pilot ran
  inside production for Cognito accounts named `demo.*` and the shared demo password was
  rotated after every demo. ADR-041 (production on `oneby8.com`) is unaffected.

## Context

Before colleges and employers are onboarded, the real application shows only real
data, so it looks empty - correctly. The marketing team still has to show colleges what
ONE does. The pilot (`apps/web/src/pilot/`) already told that story with fictional
people, but it was reachable in two ways that sat badly with `CLAUDE.md`:

- it was compiled into the production bundle and shown to any signed-in account whose
  address began with `demo.` - fiction on the production host, guarded only by an
  email prefix, with a shared password that had to be rotated by hand after each demo;
- `/demo/*` previews of the real portals, switched off in production by
  `VITE_ENABLE_DEMO_PORTAL`, but still a second, older and thinner demo.

It also showed readiness as a number (`72 / 100`), named a real university as the
fictional college, and covered only the student, placement officer and employer.

## Decision

1. **A separate demo site at `https://demo.oneby8.com`**, on the same AWS server, served
   by its own container (`web-demo` in `deploy/vps/docker-compose.yml`) built from the
   same web app with `VITE_DEMO_SITE=true`. `src/main.tsx` renders `DemoSite` instead of
   the application in that build.
2. **The demo site is in-browser only.** No sign-in, no API address, no database, no
   backend. Caddy answers `/api/*` and `/health` on the demo host with 404, so the demo
   host has no path to the production API or its data. State lives in React memory and
   resets on reload; nothing is written to browser storage.
3. **Production carries no demo.** The pilot branch in `App.tsx` is guarded by a
   build-time literal (`import.meta.env.DEV || VITE_ENABLE_DEMO_PORTAL === 'true'`), so
   the bundler drops the pilot and its dataset from the `oneby8.com` build. A `demo.*`
   account signing in to `oneby8.com` now gets the real application like anyone else.
4. **The boundary is proved, not assumed.** `apps/web/scripts/check-demo-boundary.mjs`
   inspects the built files: the production build must contain none of the demo's
   fictional names and must be the real app; the demo build must contain the demo and
   none of the real app's sign-in. It runs in `Dockerfile.web` on every image build (a
   failure stops the build) and in CI.
5. **The demo obeys the product's rules even though it is fiction.** Readiness is shown
   only as the real application's four advisory bands, never a number, and never on an
   employer screen; employers see only the evidence a student chose to share; every
   screen carries a "Demo — sample data" marker; the fictional college is "Lakeview
   Institute of Technology", not a real institution; the brand is the ONE logo with the
   tagline LEARN | PREPARE | BUILD | GROW. Tests (`src/demoSite/DemoSite.test.tsx`) walk
   every page of every role and enforce these.
6. **Roles covered:** student (with a join walkthrough), graduate who has already left
   college, placement officer, lecturer, employer, operations and growth. The lecturer,
   operations, growth and graduate portals are new, built on the existing `PilotShell`
   and pilot classes; `pilot.css` and `pilotComponents.tsx` are untouched.

## Rejected

- **Turning on `VITE_ENABLE_DEMO_PORTAL` in production.** Puts fiction on the host real
  users reach - exactly what `CLAUDE.md` forbids.
- **A demo backend with a seeded database** (an isolated API + Postgres for the demo
  host). Would show the real screens with sample rows, but doubles what runs on the
  server, needs its own sign-in pool or demo passwords, and the real screens are still
  thin where engines are unbuilt - the very problem the demo exists to get past. The
  pilot's in-browser story needs none of that. Revisit if a "try it with real screens"
  sandbox is ever wanted.
- **Keeping `demo.*` accounts on production alongside the demo site.** Two demos to
  keep consistent, and a shared password to rotate, for no gain once the demo host
  exists.
- **Reusing the `/demo/*` previews as the demo site.** They predate the pilot design,
  show readiness as a number, and are labelled as authorization previews rather than a
  product story.

## Consequences

- The marketing team needs no accounts or passwords; a link is enough.
- `docs/ops/runbook-demo-prep.md`'s password rotation is retired. The `demo.*` Cognito
  users can be disabled by Divakar (`docs/ops/runbook-demo-site.md`).
- Anything shown on the demo site that the real application does not do yet is called
  out in `docs/marketing/demo-script.md`, so a presenter never sells an unbuilt feature
  as live.
