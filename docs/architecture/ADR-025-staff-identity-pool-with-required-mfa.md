# ADR-025 — Staff Identity Moves to a Separate Pool with MFA Required

**Status:** Accepted
**Decision date:** 2026-09-07
**Scope:** Where staff authenticate, and how the privileged-MFA requirement is enforced
**Amends:** ADR-017 — Managed Identity Selection (single user pool for all principals)
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

Module acceptance 104 requires that "privileged MFA is enforced", and the Security go-live gate
(135) will not sign without it. Nothing in the codebase implements MFA today.

The application is closer to ready than that suggests. `authenticateUser` in `apps/web/src/auth.ts`
already wires all five Cognito challenge callbacks — `mfaRequired`, `totpRequired`, `mfaSetup`,
`selectMFAType` and `customChallenge` — and maps them to a `mfa_required` result that the shell
reports honestly rather than crashing on. Turning MFA on would not break sign-in; it would produce a
dead end with a truthful message.

The obstacle is not the application. It is that **Amazon Cognito cannot require MFA for a subset of
users within one user pool.** A pool is `OFF`, `OPTIONAL` or `REQUIRED`, and the documentation is
explicit about what optional means:

> When you set MFA to optional in a user pool, managed login doesn't prompt users to set up MFA, but
> it does prompt users for an MFA code when they have a preferred MFA method.

> To work with optional MFA, you must build an interface in your app that prompts your users to
> select that they want to set up MFA, then guides them through the API inputs to verify their
> additional sign-in factor.

So `OPTIONAL` challenges only users who have already enrolled, and offers no enrolment path of its
own — nothing compels a member of staff to set MFA up. `REQUIRED` compels everyone, students
included. Neither expresses "staff must, students need not" in a single pool. Group membership,
pre-authentication triggers and adaptive authentication do not change this.

## Decision

**Staff authenticate against a separate Cognito user pool with MFA set to `REQUIRED`. Students and
graduates remain in the existing pool with MFA off.**

Managed login handles both enrolment and the sign-in challenge for the staff pool, so no MFA
handshake is implemented or maintained in application code. The ONE sign-in form hands off to
managed login when it meets a challenge.

"Staff" means every role that is not Student or Graduate: the platform roles, all institution staff
roles, and all employer roles.

**Both an authenticator app (TOTP) and SMS are offered, and the user chooses.** Managed login
presents the `SELECT_MFA_TYPE` prompt and the setup flow for whichever they pick, so supporting two
factors costs nothing in application code.

TOTP alone was the first choice, on the grounds that it is free, works without signal and avoids SMS
entirely. It was widened during review for a practical reason: staff at partner institutions cannot
be relied upon to install an authenticator app, and the support cost of that friction is expected to
exceed the cost of SMS. Offering both removes an adoption barrier at the point where these are
external users we do not employ.

The costs of admitting SMS are accepted knowingly:

- Indian DLT sender registration and an Amazon SNS configuration are required before SMS MFA works,
  and the account must be out of the SNS sandbox.
- SMS carries a per-message cost for the life of the product.
- SMS is the weakest of the available factors; SIM-swap is its standard bypass. It is offered as an
  accessibility floor, not as the recommended option, and TOTP should be presented first.

**A user needs both an email address and a phone number on file.** Cognito will not let the same
channel carry both the MFA code and the password-reset code. With SMS as a user's factor, recovery
must go by email; with email recovery unavailable, that user cannot reset a password. Both
attributes are therefore required on the staff pool rather than optional.

## Why not the alternatives

**MFA required for every user in the existing pool.** One setting, no build, strongest enforcement —
and an authenticator app between every student and their account. Wrong for a product whose first
scale target is ten thousand students, and broader than the requirement, which is about privileged
access.

**One pool on `OPTIONAL`, enforcement in the application.** Keeps a single pool, but AWS states
plainly that optional mode obliges the application to build the enrolment interface. That is
security-sensitive front-end code we would own permanently, plus a server-side check on every
staff-scoped endpoint, to reach an outcome the platform gives us natively.

**Narrowing scope to the three cross-tenant admin roles.** Would satisfy the gate as literally
written and could ship in days, with enrolment verified procedurally when granting membership. It
was rejected because institution and employer staff hold real student personal data, and procedural
enforcement is not enforcement.

## Consequences

- **A staff sign-in entry point is required.** Which pool a person belongs to cannot be known before
  they authenticate, so staff need their own sign-in route rather than a shared form that guesses.
- **Token verification accepts two issuers.** `packages/identity/src/jwt.ts` verifies a single
  issuer and client id today. It gains a second, configured pair. Both remain strictly verified; this
  widens the accepted set, it does not relax the check.
- **Existing staff identities must be re-bound.** `users.external_subject` is a single nullable
  column under a unique index, so a user row maps to exactly one provider subject. Moving a staff
  member changes their `sub`. Prefer clearing `external_subject` for staff users and letting the
  existing verified-email binding path re-establish it at first sign-in, over a bespoke remap: that
  path is already implemented and tested.
- **A person who is both staff and a student needs two accounts.** One user row cannot hold two
  provider subjects. This is rare — a faculty member studying at their own institution — and is
  accepted rather than designed around.
- **Recovery is lighter than it appears.** Under `REQUIRED`, removing a user's TOTP factor causes
  managed login to prompt them to enrol again at next sign-in. Recovery is therefore one
  administrative action followed by self-service, not a supervised reset.
- **The reset action must not bottleneck on one person.** AWS account root remains break-glass for
  the platform, operations and security tier; Operations Admin receives a narrowly scoped IAM
  permission for the reset action on the staff pool, so a lost phone at a pilot college does not
  escalate to the account owner.
- **Two pools to configure, monitor and keep in step.** Accepted as the cost of not writing our own
  MFA handling.

## Implementation notes

Sequence, staff pool in UAT before production:

1. Create the staff pool with MFA `REQUIRED`, both TOTP and SMS enabled, `email` and `phone_number`
   as required attributes, and an app client matching the existing public SPA client's flows. SMS
   additionally needs an SNS configuration, DLT sender registration and the account out of the SNS
   sandbox; TOTP works without any of that, so ship TOTP first and add SMS when the registration
   clears rather than blocking the pool on it.
2. Widen token verification to accept both issuers. Additive and independently shippable.
3. Add the staff sign-in route, and make the existing form hand off to managed login on a challenge
   rather than reporting a dead end.
4. Re-bind UAT staff identities and verify end to end, including a deliberate lockout and recovery.
5. Repeat for production, then record the reset procedure in the operations runbooks.

Before step 2, capture a real access token from the staff pool and inspect its claims. If Cognito
includes `amr`, the API may additionally assert that a staff session completed MFA as
defence-in-depth. If it does not, do not design around it: Cognito does not issue a token at all
unless the challenge was met, so the pool setting is the control.
