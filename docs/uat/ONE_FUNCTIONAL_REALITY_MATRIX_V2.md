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
| Institution units | List/create/edit units | `/api/v1/institutions/:id/units` | `institution_units` | Institution Admin family | audit/outbox | Existing authenticated operations API | REAL |
| Institution students | List/create/edit/end relationship | `/api/v1/institutions/:id/students...` | student profiles/relationships | Institution Admin family | audit/outbox | Existing authenticated operations API | REAL |
| Institution roster import | Preview/commit CSV | `/api/v1/institutions/:id/student-imports` | roster import tables + student profiles | Institution Admin family | audit/outbox | Existing authenticated operations API | REAL |
| Institution staff | Invite staff | `/api/v1/institutions/:id/staff-role-assignments` | invitations/outbox | Institution Admin only | invitation audit/outbox | Existing authenticated API | REAL |
| Operations organizations | Create/edit/verify/invite initial admin | `/api/v1/operations/organizations...` | organizations/profiles/invitations/audit | Operations roles | audit/outbox | Existing authenticated API | REAL |
| Operations Users & Access | Inspect identities/memberships | not yet dedicated | users/memberships | Operations roles required when added | n/a | Not yet a dedicated UI | NOT_YET_AVAILABLE |
| Invitation tracking | Read operational invitation inventory | not yet dedicated | invitations/outbox | Operations roles required when added | n/a | Not yet a dedicated UI | NOT_YET_AVAILABLE |
| Content operations | Read career readiness status | `/api/v1/operations/career-readiness/status` | V4 career-readiness tables | Operations roles | read only | Existing panel/status | READ_ONLY |
| Technical operations | Outbox/workflow status | `/api/v1/operations/career-readiness/status` | outbox/automation tables | Operations roles | read only | Existing status panel | READ_ONLY |
| Placement Admin | Placement workflow mutations | none for full workflow | none | n/a | n/a | Must remain unavailable | NOT_YET_AVAILABLE |
| Faculty/Department | Academic workflow mutations | partial report/list surfaces only | existing report data | Scoped staff roles | read only | Must not simulate success | READ_ONLY |
| Employer hiring | Opportunity/application/interview mutations | none in Phase 2A | none | n/a | n/a | Explicit unavailable | NOT_YET_AVAILABLE |

