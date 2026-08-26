# Mobile Foundation — decisions and contracts for the Android app

Decisions from the pre-app review (pending ledger, section H), recorded so the
app is built against commitments rather than assumptions.

## 1. Android v1 scope — the exam decision

**v1 ships without in-app exam taking.** Timed, focus-proctored exams on mobile
change the integrity model (app switching, notification interruptions, process
death mid-attempt) and deserve their own design pass. v1 is:

- Sign in · profile view/edit · assigned assessments and windows · **results**
- The persistent notification inbox, with push
- Public-profile QR display
- The ONE Assistant

Exam attempts open in the browser (the app deep-links to the web runner).
Revisit after v1 adoption data.

## 2. Authentication — Cognito OAuth 2.0 + PKCE

The web app's token flow is not transplanted. The app uses Cognito's OAuth
authorization-code flow with PKCE via a custom-tab browser, yielding the same
JWTs the API already verifies — **no server-side auth changes needed**.

Operator setup when app development starts (AWS console, ~5 minutes): add a
second app client (no secret) to pool `ap-south-1_nPl3qFkvB` with the app's
redirect URI (`one.ai8ht.pro` scheme or App Links), and enable the hosted UI
domain. Refresh-token lifetime: 30 days (mobile norm), access token 1 hour.

## 3. Push notifications — status: server half built

Built now (release carrying migration 0013):

- `user_notifications` — persistent per-user feed written by domain events:
  **EXAM_ASSIGNED** (on assignment), **EXAM_REOPENED** (on reopen/extend),
  **RESULT_PUBLISHED** (on publish of a scored attempt). Notification writes
  never fail the domain operation.
- `device_push_tokens` — FCM token registry; register is idempotent per token
  and reassigns a device to whoever is signed in on it.
- API: `GET /api/v1/me/notifications` (latest 50 + unreadCount),
  `POST /me/notifications/:id/read`, `POST /me/notifications/read-all`,
  `POST /me/devices` {platform, token}, `POST /me/devices/revoke` {token}.
- The web student bell consumes this same feed (one contract, two clients).

Remaining (needs the operator, then engineering):

1. Operator: create a Firebase project, register the Android app, download the
   **service-account JSON**, place it on the server, and set `FCM_PROJECT_ID`
   + `FCM_SERVICE_ACCOUNT_PATH` in app.env (vault both).
2. Engineering: the FCM HTTP v1 sender (OAuth2 service-account signing) wired
   where `notify.ts` currently logs `notify.push.pending`.

## 4. API contract policy — /api/v1 freezes at first app release

The day an app binary ships, server deploys stop being atomic for all clients.
From that release onward:

- `/api/v1` responses are **additive-only**: new fields may appear; existing
  fields never change type, meaning, or disappear.
- Breaking changes go to `/api/v2` endpoints; v1 stays serving until the app's
  minimum supported version has moved.
- The app sends `X-Client: one-android/<version>` so the server can measure
  version spread before retiring anything.

Until the first app release, v1 remains freely changeable as today.

## 5. Deep links

Target scheme: `https://one.ai8ht.pro/p/<profile-share-id>` (public profile QR)
and `https://one.ai8ht.pro/app/assessments` (assignment notifications). Android
App Links verification needs `/.well-known/assetlinks.json` served with the
app's signing-certificate fingerprint — added once the app's keystore exists.

## 6. What only the operator can do (tracked in the pending ledger)

Firebase project + service account · Cognito mobile app client · Play Console
account and data-safety form (must mirror the privacy notice) · app signing
keystore (vault it — losing it means losing the Play listing identity).
