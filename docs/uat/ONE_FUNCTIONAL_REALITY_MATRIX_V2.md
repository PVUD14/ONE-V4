# ONE Functional Reality Matrix V2

> **Status: retired — 2026-09-14. Do not use this file to judge what exists.**
>
> It was already stale on 2026-09-05, and the banner added then pointed readers at a
> "Role Capability and Build-State report" that exists only as a generated PDF nobody
> regenerates — so the redirection was itself a dead end, which is worse than no
> redirection at all.
>
> What this matrix gets wrong has only grown. It records student file upload, employer
> hiring mutations and student application workflows as unavailable; all three are built
> and enforced. It implies a missing readiness scoring engine; the engine exists and
> deliberately produces a band rather than a number
> ([ADR-020](../architecture/ADR-020-readiness-is-a-band-not-a-score.md)). Since it was
> written, candidate feedback, a merged calendar, alumni verification, employer screening
> assessments, learner-content authoring and the public profile have all shipped, and none
> of them appear below.
>
> **For the current state, read the source.** `docs/architecture/ADR-*.md` records the
> decisions and what each rejected; the `*-table-design.md` files record why the
> consequential tables are shaped as they are. A status document that drifts is worse than
> none, because it is believed. The table below is kept only as a record of what was true
> in Phase 2A.

Phase 2A starts from human-accepted Phase 1 routing/session UAT:

- Student login: PASS
- Institution login: PASS
- Refresh/session persistence: PASS
- Sign out: PASS
- Role routing: PASS

No credentials are stored in this repository.

| Module | Action | API | DB | Auth | Audit | UI | Status |
|---|---|---|---|---|---|---|---|
| Student profile | View own profile | `GET /api/v1/students/me/profile` | `student_profiles`, `users`, relationships | Verified Student principal | Read only | Profile page | REAL |
| Student profile | Edit target career/profile/visibility | `PATCH /api/v1/students/me/profile` | `student_profiles` | Verified Student principal only | `student.profile.updated` | Form validation + save/error | REAL |
| Student documents | List metadata | `GET /api/v1/students/me/documents` | `student_document_metadata` | Verified Student principal only | Read only | Documents table | REAL |
| Student documents | Create/update/archive metadata | `POST/PATCH/DELETE /api/v1/students/me/documents` | `student_document_metadata` | Verified Student principal only | document metadata audit events | Metadata forms/table | REAL |
| Student documents | Binary file upload | none | none | n/a | n/a | Explicit unavailable copy | NOT_YET_AVAILABLE |
| Student opportunities | Save/remove reference | `POST/DELETE /api/v1/students/me/saved-opportunities` | `student_saved_opportunities` | Verified Student principal only | saved opportunity audit events | Saved references table | REAL |
| Student applications/interviews/offers | Mutate hiring workflow | none | none | n/a | n/a | Disabled/unavailable | NOT_YET_AVAILABLE |
| Institution units | List/create/edit units | `/api/v1/institutions/:id/units` | `institution_units` | Institution Admin only, institution scoped | unit audit/outbox | Authenticated Academic Structure UI | REAL |
| Institution students | List/create/edit/end relationship | `/api/v1/institutions/:id/students...` | student profiles/relationships | Institution Admin only, institution scoped | student relationship audit/outbox | Authenticated Students UI | REAL |
| Institution roster import | Preview/commit CSV with institution unit resolution | `/api/v1/institutions/:id/student-imports` | roster import tables + student profiles | Institution Admin only, institution scoped | import audit/outbox | Authenticated Students import panel | REAL |
| Institution staff | Invite staff and inspect invitation/membership inventory | `/api/v1/institutions/:id/staff-role-assignments` | invitations/outbox/memberships | Institution Admin only | invitation audit/outbox | Authenticated Staff UI; revoke/resend/end membership unavailable | REAL_LIMITED |
| Operations organizations | Create/edit/verify/filter organizations and invite initial admin | `/api/v1/operations/organizations...` | organizations/profiles/invitations/audit | Operations roles | audit/outbox | Authenticated Operations Organizations UI | REAL |
| Operations Users & Access | Inspect identities/memberships/student relationship counts | `GET /api/v1/operations/users-access` | users/memberships/student relationships | Operations roles | read only | Authenticated read-only Users & Access UI | READ_ONLY |
| Invitation tracking | Read operational invitation inventory and delivery state | `GET /api/v1/operations/invitations` | invitations/outbox/notification delivery attempts | Operations roles | read only | Authenticated read-only Invitation inventory in Users & Access UI | READ_ONLY |
| Content operations | Read career readiness status | `/api/v1/operations/career-readiness/status` | V4 career-readiness tables | Operations roles | read only | Authenticated read-only Content Operations UI | READ_ONLY |
| Technical operations | Read system/audit/security/AI operations status | `/api/v1/operations/career-readiness/status` | outbox/automation/career readiness tables | Operations roles | read only | Authenticated read-only Technical Operations UI | READ_ONLY |
| Placement Admin | Placement workflow mutations | none for full workflow | none | Verified Placement Admin membership required to mount route | n/a | Authenticated limited page; demo preview remains under `/demo` only | NOT_YET_AVAILABLE |
| Faculty/Department | Academic workflow mutations | partial report/list surfaces only | existing report data | Scoped staff roles | read only | Authenticated read-only limited states; no preview success | READ_ONLY |
| Employer hiring | Opportunity/application/interview mutations | none in Phase 2A | none | Verified Recruiter membership required to mount route | n/a | Authenticated limited page; demo preview remains under `/demo` only | NOT_YET_AVAILABLE |
