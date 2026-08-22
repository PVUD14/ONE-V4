# ONE Role UAT Runbook V1

Credentials are not in Git. Retrieve them from the operator-local file: `E:\8-PTPN-UAT-TEMP\identity\ONE_UAT_CREDENTIALS.local.txt`.

## Common login

Phase 1.1 was not accepted: manual UAT found the visible ONE form was not real credential authentication, refresh lost the authenticated session, and failed authentication could leave a demo Student screen visible. Phase 1.2 changes the normal login path to the visible ONE email/password form backed by Cognito SRP, persists only session-scoped Cognito token data, restores/refreshes the session on startup, and keeps demo routes isolated under `/demo/*`.

1. Open `https://one.ai8ht.pro`.
2. Enter the persona email and password directly in the ONE form.
3. Submit Sign in. Hosted UI may exist only as fallback/reference; the visible form is the normal UAT login path.
4. Confirm route and workspace are server-authorized.
5. Test forbidden deep links by manually entering a different portal family URL.
6. Refresh the browser and confirm the same authorized workspace remains visible.
7. Sign out and confirm return to `/login`.
8. Authenticate as the next persona in the same browser session and confirm no prior persona, demo, or preview content remains.

## Student A / Student B

- Precondition: Cognito user maps to internal user with active institution relationship.
- Expected landing: `/student`.
- Expected identity: real Student profile from `/api/v1/students/me`; Student A must render as Aanya, not Rahul.
- Allowed actions to test: Career Readiness view, lesson completion/start assessment where seeded catalog allows.
- Forbidden actions: `/institution/admin`, `/employer/recruiter`, `/operations/admin`.
- Expected result: Student portal only; other portals controlled denial or no authorized workspace.
- Evidence: dashboard, navigation, real name, refresh persistence, visible Sign out, Career Readiness panel/action, denied portal route, no `DEMO PREVIEW`, no `Session-local preview`, no Rahul.

## Institution Administrator

- Expected landing: `/institution/admin`.
- Allowed actions: create academic unit, add student, edit student, graduate/transfer/end relationship, validate/commit roster CSV, invite staff.
- Forbidden actions: Operations organization verification, employer applicant access.
- Evidence: dashboard, authenticated email/role, institution navigation, academic unit creation, student mutation, denied `/operations/admin`, refresh persistence, no Student sidebar, no Rahul, no demo/preview labels.

## Placement Admin

- Expected portal: Institution.
- Allowed actions: institution staff context, student list, aggregate report authorization where available.
- Forbidden actions: create platform organizations, grant platform roles, employer-only routes.
- Evidence: dashboard/navigation, roster/report access, denied operations route.

## Faculty Lecturer

- Expected portal: Institution.
- Allowed actions: institution staff context and authorized student list where exposed.
- Preview actions: faculty tasks, notes, assessments, resources.
- Forbidden actions: platform/employer routes and student identity override.
- Evidence: dashboard/navigation and preview-control classification.

## Department Head

- Expected portal: Institution.
- Allowed actions: institution staff context, aggregate reports, student list where exposed.
- Preview actions: workload, meetings, department interventions.
- Forbidden actions: employer offer terms, platform roles.
- Evidence: dashboard/navigation, report or student list, denied route.

## Recruiter

- Expected landing: `/employer/recruiter`.
- Allowed actions: employer context and applicant grant authorization where seeded grants exist.
- Partial actions: opportunity/application/interview/offer workflows.
- Forbidden actions: institution student directory and operations routes.
- Evidence: employer partial implementation page, authenticated email/role, refresh persistence, denied institution/operations route, no Student shell/sidebar, no Rahul.

## Operations Admin

- Expected landing: `/operations/admin`.
- Allowed actions: create/edit organization, transition verification, create initial admin invitation, inspect onboarding status, inspect Career Readiness operations.
- Forbidden actions: bypass raw invitation token handling, direct staff userId attachment, unrelated tenant mutation.
- Evidence: org mutation, verification event, invitation record without raw token, denied tenant test.

## Platform Super Admin

- Expected portal: Operations.
- Allowed actions: same currently implemented operations family actions.
- Partial: no distinct super-admin UI yet.
- Forbidden actions: credentials/secrets exposure; production infrastructure mutation from app UI.
- Evidence: operations dashboard and capability gap note.

## Multi-workspace Institution + Employer

- Expected: Choose workspace page with Institution and Employer only.
- Allowed actions: enter Institution and Employer; no Student/Operations choices.
- Evidence: chooser screenshot and denied operations route.
