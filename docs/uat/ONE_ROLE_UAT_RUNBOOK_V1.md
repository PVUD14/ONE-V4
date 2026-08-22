# ONE Role UAT Runbook V1

Credentials are not in Git. Retrieve them from the operator-local file: `E:\8-PTPN-UAT-TEMP\identity\ONE_UAT_CREDENTIALS.local.txt`.

## Common login

Phase 1.1 correction note: manual UAT previously observed an Institution Administrator session appearing to show the Student portal. Diagnostics found the Cognito and internal mappings were distinct and correct; the defect was frontend authenticated routing/deep-link fallback that could mount a protected portal shell before proving the requested family/role from `/api/v1/security/context`. After Phase 1.1, repeat this runbook in a clean browser before marking role login PASS.

1. Open `https://one.ai8ht.pro`.
2. Click Sign in.
3. Authenticate through Cognito managed login.
4. Confirm route and workspace are server-authorized.
5. Test forbidden deep links by manually entering a different portal family URL.
6. Sign out and confirm return to login.

## Student A / Student B

- Precondition: Cognito user maps to internal user with active institution relationship.
- Expected landing: `/student`.
- Allowed actions to test: Career Readiness view, lesson completion/start assessment where seeded catalog allows.
- Forbidden actions: `/institution/admin`, `/employer/recruiter`, `/operations/admin`.
- Expected result: Student portal only; other portals controlled denial or no authorized workspace.
- Evidence: dashboard, navigation, Career Readiness panel/action, denied portal route.

## Institution Administrator

- Expected landing: `/institution/admin`.
- Allowed actions: create academic unit, add student, edit student, graduate/transfer/end relationship, validate/commit roster CSV, invite staff.
- Forbidden actions: Operations organization verification, employer applicant access.
- Evidence: dashboard, academic unit creation, student mutation, denied `/operations/admin`.

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
- Evidence: employer partial implementation page, denied institution/operations route.

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
