# ONE Android (v0.1)

Kotlin + Jetpack Compose client for one.ai8ht.pro, scoped per
`docs/architecture/MOBILE_FOUNDATION.md`: assessments & results, the
notification inbox, DPDP consent gate, and sign-in. Exam *taking* stays on the
web in v1 by design.

## Open in Android Studio

Open the `apps/android` folder (not the repo root). `local.properties` with
your `sdk.dir` is created automatically by Studio if missing.

## Build from the command line

```
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
gradle assembleDebug        # or Studio's bundled Gradle / a wrapper
```

Output: `app/build/outputs/apk/debug/app-debug.apk` — install on a device with
`adb install app-debug.apk` (enable USB debugging), or drag onto a running
emulator.

## Sign-in paths

- **Today (UAT):** paste an access token on the sign-in screen (testers get it
  from the web session), optionally overriding the API base URL for local dev.
- **Production:** Cognito Hosted UI with PKCE, dormant until the operator
  registers a mobile app client and fills `COGNITO_HOSTED_DOMAIN` +
  `COGNITO_CLIENT_ID` in `app/build.gradle.kts`. The redirect scheme
  `one.ai8ht.pro://signin` is already declared in the manifest.

## What activates later

- **Push:** `Api.registerDevice` posts the FCM token to the live registry; the
  Firebase dependency and messaging service land once the Firebase project
  exists (operator step).
- **Consent gate:** mirrors the web — appears only when the server sets
  `CONSENT_PRIVACY_NOTICE_VERSION` after legal sign-off.
- Keep `versionCode` monotonically increasing; the Play keystore, once created,
  must be vaulted.
