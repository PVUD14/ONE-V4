# Runbook — Staff identity pool with MFA required (ADR-025)

What this is: the manual steps Divakar performs in AWS and on the server to give staff
their own Cognito user pool with MFA required, verify it, turn enforcement on, and undo
it. Why it exists: the security go-live gate requires privileged MFA (spec 104/135).
ADR-025 decided how it is done. The application code is already in place (OPS-07). What
is left needs AWS access, and only Divakar has that.

**Who:** Divakar only. Every step in Parts A, B and F changes AWS or production.
**Order:** UAT pools first, then production. Never do a production step before the same
step has worked in UAT.
**Values:** pool ids, client ids, domains, subs, tokens and phone numbers go in the
password manager. They never go into the repository, a commit, a ticket or a chat.

---

## What the code already does (no action needed)

| Piece | Where | Behaviour |
|---|---|---|
| Two-pool token verification | `packages/identity/src/cognito.ts` | With `COGNITO_STAFF_*` set, the API accepts tokens from either pool. Each pool is checked against its own issuer, keys and client id, so a student token cannot borrow the staff client id. |
| Staff-only roles | `packages/identity/src/staff-pool.ts`, `apps/api/src/runtime-auth.ts` | With the staff pool configured, `PLATFORM_SUPER_ADMIN`, `OPERATIONS_ADMIN` and `SECURITY_ADMIN` count only for a staff-pool token. A student-pool token keeps the person's other memberships and student access, and loses the internal roles. |
| Configuration contract | `apps/api/src/config.ts` | `COGNITO_STAFF_USER_POOL_ID` and `COGNITO_STAFF_CLIENT_ID` are optional and unset by default. When unset, nothing changes. Setting one without the other, reusing the student pool or client, or giving a malformed pool id stops the API at startup. |
| Preflight | `deploy/scripts/preflight-production.sh` | A half-configured staff pool always fails. A missing one is a warning by default and a failure with `--require-staff-pool`. The script prints setting names only, never values. |

**Not built yet: the staff sign-in entry (ADR-025 step 3).** The web app and the Android
app still sign in only against the student pool. A staff member therefore has no way
to get a staff-pool token from the product. Parts A to C below can all be done now.
**Parts E and F must wait until that entry ships** (see Part D). This is a stop point,
not an open question.

---

## Part A — Create the staff pool (UAT first)

Region `ap-south-1`, the same region as the student pool.

A1. **Create the user pool.** Cognito console → User pools → Create user pool.
- Application type: single-page application. Name the pool `one-staff-uat`, and later
  `one-staff-prod`.
- Sign-in identifier: **email**.
- Self-registration: **off**. Staff are created or invited by an administrator, never
  self-registered.
- Required attributes: **email** and **phone_number**. These cannot be changed after the
  pool exists, so check them before you create it. Both are required because Cognito will
  not carry the MFA code and the password-reset code on the same channel (ADR-025).
- Feature plan: the same as the student pool. If you want to brand managed login (A5),
  the plan must include the managed login branding editor.

A2. **MFA and recovery.** Sign-in → Multi-factor authentication.
- MFA enforcement: **Require MFA**.
- MFA methods: **Authenticator apps** now. Add **SMS message** once Part B has cleared,
  because TOTP needs none of the SMS registration and should not wait for it.
- User account recovery: **Email only**. SMS may be a person's MFA factor, so it must not
  also be their recovery channel.
- Password policy: at least as strict as the student pool's.
- Deletion protection: **on**.

A3. **Email delivery.** Messaging → Email: use the same sender configuration as the
student pool (SES identity or the Cognito default). This keeps invitation and reset
emails from the same address.

A4. **Web app client.** App integration → App clients → Create.
- Public client. **No client secret**, because it ships to browsers.
- Authentication flows: the same as the student SPA client. Check the student client
  and copy its flows exactly. Today the web uses `ALLOW_USER_SRP_AUTH` and
  `ALLOW_REFRESH_TOKEN_AUTH`.
- Managed login: create a domain prefix, for example `one-staff-uat`.
- OAuth grant: **Authorization code**. Scopes: `openid`, `email`, `profile`.
- Callback URLs and sign-out URLs: identical to the student SPA client's. The web app's
  callback is `https://<web host>/auth/callback`, plus `http://127.0.0.1:5173/auth/callback`
  for UAT and local use only, never on the production client.
- Token lifetimes: the same as the student client.

A5. **Brand.** Managed login is where staff will see the sign-in page. Its logo is the
AI8HT wordmark (`E:\8-1\samples\AI8HT_logo.jpg`), never text or a placeholder.

A6. **Android app client** (optional now, needed before staff sign in on phones). This is
a second public client with no secret. Callback `one.ai8ht.pro://signin` and sign-out
`one.ai8ht.pro://signout`. Authorization code grant with PKCE, same scopes.

A7. **Record, privately:** the pool id, the web client id, the Android client id if
created, and the managed login domain. Record them for UAT and later for production.

A8. **Reset permission for Operations Admin** (ADR-025: recovery must not bottleneck on the
account owner). In IAM, create a policy scoped to the staff pool's ARN only, and attach it
to the Operations Admin's IAM identity:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminSetUserMFAPreference",
      "cognito-idp:AdminResetUserPassword"
    ],
    "Resource": "arn:aws:cognito-idp:ap-south-1:<account-id>:userpool/<staff-pool-id>"
  }]
}
```

The student pool is deliberately not in `Resource`. Account root remains break-glass for
the platform, operations and security tier.

---

## Part B — SMS as a second factor (may follow TOTP)

SMS is the weakest factor. It is offered as an accessibility floor and TOTP is presented
first (ADR-025). Do this part only when you are ready to accept its per-message cost.

B1. **Indian DLT registration** (TRAI rules; this happens outside AWS, on an operator DLT
portal such as Jio, Airtel, Vi or BSNL):
- Register AI8HT as a Principal Entity. This gives you the **Entity ID**.
- Register a **header**, the sender ID.
- Register a **content template** for the code, in the service-implicit / OTP category.
  The text must match Cognito's SMS MFA message character for character, with the code
  as the variable. For example: `Your AI8HT verification code is {#var#}.` Cognito's own
  message is then `Your AI8HT verification code is {####}.`
- Keep the Entity ID, header and template ID.

B2. **Register the same details with AWS.** In AWS End User Messaging SMS (the SNS console
links there), follow AWS's current procedure for India sender IDs. Enter the sender ID,
Entity ID and template ID so that messages carry them.

B3. **Leave the SNS SMS sandbox.** SNS → Text messaging (SMS) → exit the sandbox. The
support case asks for your use case ("one-time passcodes for staff sign-in") and a
monthly spend limit. While in the sandbox, SMS goes only to verified numbers.
- Default message type: **Transactional**.
- Account spend limit: the figure you approved in the support case.

B4. **Connect Cognito to SNS.** Staff pool → Messaging → SMS. Let Cognito create the IAM
role with its external id, or choose an existing one. Set the SMS MFA message to the
exact DLT-registered template text.

B5. **Turn SMS on.** Staff pool → MFA methods → add **SMS message**. Test it on a UAT user
with a real Indian number before you touch production.

---

## Part C — Verify the UAT pool without the application

C1. **Create a test staff user.** Staff pool → Users → Create user, with an email and phone
number you control. Choose "send an email invitation".

C2. **Enrol.** Open managed login directly in a browser:

```
https://<staff-domain>.auth.ap-south-1.amazoncognito.com/login?client_id=<staff-web-client-id>&response_type=code&scope=openid+email+profile&redirect_uri=<registered callback, url-encoded>
```

Sign in with the temporary password and set a new one. Managed login then **forces MFA
setup**. Choose the authenticator app, scan the code and confirm. When you are
redirected to the callback, the web app will report a sign-in failure. That is expected:
the web app still exchanges codes with the student client.

C3. **Challenge.** Sign out, then sign in again the same way. You must be asked for the
TOTP code. If you are not asked, stop: the pool is not set to Require MFA.

C4. **Capture and inspect one access token** (ADR-025 asks for this). Repeat C2 and copy
the `code` from the callback URL. Exchange it within five minutes, using the same
redirect URI:

```bash
curl -s -X POST "https://<staff-domain>.auth.ap-south-1.amazoncognito.com/oauth2/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code -d client_id=<staff-web-client-id> \
  -d code=<code> -d redirect_uri=<registered callback>
```

Decode the payload of `access_token` locally, and never paste the token anywhere:

```bash
cut -d. -f2 <<<"$ACCESS_TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null; echo
```

Note three things:
- `iss` ends in the staff pool id.
- `client_id` is the staff web client.
- Whether an `amr` claim is present. If it is, record that in the OPS progress log; a
  later change may assert it as defence in depth. If it is absent, do nothing: Cognito
  issues no token unless the challenge was met, so the pool setting is the control.

C5. **Deliberate lockout and recovery.** As the Operations Admin identity from A8, remove
the test user's TOTP factor:

```bash
aws cognito-idp admin-set-user-mfa-preference --region ap-south-1 \
  --user-pool-id <staff-pool-id> --username <email> \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

Sign in again. Managed login must prompt for MFA enrolment again (ADR-025). Record the
time this took from report to working sign-in.

C6. **API enforcement, locally, against the UAT pools.** Run the API on your machine
against a local database. It never points at production data.

```bash
export DATABASE_URL=...local database...
export COGNITO_USER_POOL_ID=<UAT student pool id> COGNITO_CLIENT_ID=<UAT student web client id>
export COGNITO_STAFF_USER_POOL_ID=<UAT staff pool id> COGNITO_STAFF_CLIENT_ID=<UAT staff web client id>
corepack pnpm api:dev
```

In the local database, give a seeded internal user (for example an `OPERATIONS_ADMIN`)
the staff test user's `sub` as `external_subject`. The sub is shown on the user's page
in the Cognito console. Then:
- `GET /api/v1/security/context` with the staff token lists the internal membership.
- `GET /api/v1/operations/audit-events` with the staff token returns 200.
- The same calls with a UAT **student-pool** token for a user holding an internal role:
  the context omits the internal membership, and the operations call returns 403.
- Remove the two `COGNITO_STAFF_*` exports and restart. The student-pool token reaches
  the operations call again. This is the rollback behaviour.

---

## Part D — Prerequisite: the staff sign-in entry (not yet built)

Before Part E or F in production, both of these must exist:
- **Web:** a staff sign-in route that starts managed login against the staff pool (ADR-025
  step 3). It needs build settings for the staff domain and client, beside
  `VITE_COGNITO_DOMAIN` and `VITE_COGNITO_CLIENT_ID`.
- **Android:** the hosted sign-in in `apps/android/.../OAuth.kt` is already written for
  this. It needs the staff pool's domain and Android client as a second choice in the app.

Until both ship, stop here in production. Enforcing without them would lock every
internal user out of the operations portal.

---

## Part E — Re-bind internal staff to the staff pool (production)

A user row holds exactly one provider subject (`users.external_subject`, unique). Moving a
person to the staff pool changes their `sub` (ADR-025).

E1. In the production staff pool, create a user for each internal-role holder, with the
same email as their existing ONE account. They complete enrolment through managed login
(C2).

E2. For each person, record privately their **current** `external_subject`. Rollback
needs it.

E3. On the server, in one transaction per person, move the binding and leave an audit
row. Replace the placeholders:

```sql
BEGIN;
UPDATE users SET external_subject = '<staff-pool sub>', updated_at = now()
 WHERE id = '<user id>' AND external_subject = '<recorded old sub>';
-- Expect UPDATE 1. Anything else: ROLLBACK and check the recorded values.
INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id, context)
VALUES (gen_random_uuid(), '<your own user id>', 'identity.staff_pool.rebound', 'user', '<user id>',
        'SUCCESS', 'staff-pool-rebind-<yyyymmdd>', '{"reasonCode":"ADR_025_STAFF_POOL"}'::jsonb);
COMMIT;
```

From this moment that person can sign in only through the staff pool. Do E3 for
yourself last, after one other internal user has proved the staff sign-in works.

---

## Part F — Turn enforcement on (production)

F1. Add the two lines to `/srv/planthepath-next/shared/app.env`:

```
COGNITO_STAFF_USER_POOL_ID=<production staff pool id>
COGNITO_STAFF_CLIENT_ID=<production staff web client id>
```

F2. Run the preflight in required mode. It must pass:

```bash
deploy/scripts/preflight-production.sh /srv/planthepath-next/shared/app.env --require-staff-pool
```

F3. `sudo systemctl restart planthepath-api.service`, then
`systemctl is-active planthepath-api.service`. If the service will not start, the journal
names the setting at fault. Settings are named, never their values.

F4. Verify:
- Sign in through the staff entry. The operations portal loads.
- Sign in with a student-pool account that holds an internal role, if any remain. The
  operations portal is refused, and that person's other workspaces still load.
- The audit log shows your E3 rows.

From the security go-live release onward, run every release's preflight with
`--require-staff-pool`.

---

## Rollback

Enforcement is configuration only. Rolling back needs no AWS change and no code change.

1. Delete the two `COGNITO_STAFF_*` lines from `app.env`.
2. `sudo systemctl restart planthepath-api.service`. Internal roles count again for
   student-pool tokens, exactly as before OPS-07.
3. If people were re-bound in Part E, put back each recorded old `external_subject`,
   using the E3 statement with the two subs swapped and an audit row with action
   `identity.staff_pool.unbound`. Otherwise they cannot sign in through the student
   pool.
4. Leave the staff pool in place. It costs nothing unused, and re-enabling is Part F again.

---

## Later: institution and employer staff

ADR-025 defines staff as every role that is not Student or Graduate. OPS-07 enforces the
three internal platform roles first, because they reach every organisation. Institution
and employer roles follow in the same way once their users have staff-pool accounts:
extend the role list in `createRuntimeStaffPoolPolicy` in `apps/api/src/runtime-auth.ts`,
and re-bind as in Part E. Widening the list before those users are re-bound would lock
them out.

## Sign-off checklist

- [ ] A1–A8 done in UAT; values recorded privately
- [ ] C2–C5 passed: forced enrolment, challenge, `amr` noted, lockout and recovery timed
- [ ] C6 passed locally, including the rollback check
- [ ] B1–B5 done if SMS is offered, and tested on a real number
- [ ] Part D shipped (web and Android staff entry)
- [ ] A1–A8 repeated for production
- [ ] E1–E3 done for every internal-role holder; old subs recorded
- [ ] F1–F4 done; preflight passes with `--require-staff-pool`
