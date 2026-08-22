# ONE Functional Reality Matrix V2

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
