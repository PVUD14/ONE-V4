# Year-end batch actions and alumni — design

**Status:** Adopted (INST-10), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** none — 0060 was reserved and is not claimed
**Relates to:** decision 10.2 #12 of the institution plan ("graduated students keep their ONE accounts as
alumni; the college's access becomes historical"), `canonicalInstitutionRelationshipPolicy`
(packages/authorization), `academic-results-import-design.md` (the preview-digest pattern reused here),
`alumni-verification-request-design.md` (retroactive verification), ADR-019.

Written before the code because a relationship change is permanent for the person it touches: it decides
what their college may still see about them and — as it turned out — whether they can still open ONE.

## What already exists

The schema already models the end of a student's time at a college. Nothing new is stored.

- `institution_relationships.state` is `relationship_state` (`ACTIVE`, `VERIFIED`, `GRADUATED`,
  `TRANSFERRED`, `ENDED`, `REVOKED`, `PENDING`). CHECKs: `effective_to > effective_from` (0000);
  `GRADUATED` and `TRANSFERRED` require `effective_to` (0003).
- `institution_student_profiles.status` carries the same lifecycle for the roster (0005 CHECK).
- `POST …/students/:id/relationship` (owners and admins) ends one student's current relationship, revokes
  their pending invitation, and writes an audit row and an `institution.relationship.ended` outbox event.
- The relationship policy: a college reads current data only while the relationship is `ACTIVE` /
  `VERIFIED`; after `GRADUATED` / `TRANSFERRED` it may read only activity dated before `effective_to`
  (exclusive). Every institution read already applies it; current views (roster placement status,
  announcements, staff-action subjects, assessment assignment, exports) simply stop including the student.

What is missing is (1) doing it for a whole batch at once, (2) telling the student, and (3) — found while
reading the student side — **the student keeping ONE afterwards**.

## The defect this goal has to fix first: graduation locked the student out

Every student entry point asked for a *current* relationship:

| Path | Rule before | Effect on a graduate |
| --- | --- | --- |
| `GET /security/context` → `studentRelationships` | `ACTIVE`/`VERIFIED`, window open now | Web shows "No active ONE workspace"; the student workspace disappears |
| `GET /students/me` | same, as an inner join | 403 — web "Student identity unavailable", Android student header fails |
| `GET/PATCH /students/me/profile`, documents, saved opportunities (`student-operational-core`) | same | 403 on the student's own profile, documents and saved items |

So a graduated student's data was not deleted, but it was orphaned: nobody could reach it, including the
student. That contradicts decision 10.2 #12 and the standing product rule that ONE serves people who have
already left college. It is fixed in this goal, not deferred, because shipping a one-click "graduate the
batch" without it would lock out a whole year at once.

**The rule adopted: a *former student* keeps the student workspace.** A former student is someone with no
current relationship and at least one relationship in `GRADUATED`, `TRANSFERRED` or `ENDED`. For their own
data they are a student: profile, documents, saved opportunities, academic records, applications, consents
— all theirs, readable and editable as before. What changes is only what the *college* sees.

- `/security/context` gains `formerStudentRelationships` (institution, state, dates). `studentRelationships`
  keeps its meaning (current only), so nothing that scopes by it widens.
- `/students/me` falls back to the most recent former relationship and says so: `formerStudent: true`, the
  relationship's state and `effectiveTo`, and the institution's name.
- The `student-operational-core` gate accepts a current or former relationship for the student's own rows.
  It still refuses a caller who has never been a student anywhere, and it still refuses `REVOKED`.

**Why `REVOKED` is not a former student.** Revocation is the college saying the roster link was wrong
(a mistyped email, the wrong person). It is a per-student correction, not a year-end action, and granting
a student workspace on the strength of a link the college has withdrawn would be granting it on nothing.
That path is unchanged by this goal and is recorded as a question for Divakar.

**Why `ENDED` is.** A student who leaves without graduating — drops out, is withdrawn — has left college
exactly as a graduate has. Their account, records and consents are theirs; the product rule does not
distinguish.

## Batch actions

### API

`POST /api/v1/institutions/:id/relationship-batches/preview`
`POST /api/v1/institutions/:id/relationship-batches/commit`

Body (both): `state` (`GRADUATED` | `TRANSFERRED` | `ENDED`), exactly one target — `unitId` (every student
on the roster under that unit, including its descendant programmes, batches and sections) or
`institutionStudentIds` (1–1 000 of the college's own roll numbers, matched case-insensitively) — and an
optional `effectiveTo` (ISO date-time). Commit adds `previewDigest` and `reasonCode`
(`^[A-Z0-9_:-]{3,64}$`). Unknown fields are refused.

**Roles:** institution owner and admin — the same as the per-student endpoint, because roster and
relationship writes are theirs (SEC-INST enumerated them as owner/admin writes). The caller's
**write scope** (INST-SR-02) is still resolved through the one helper and applied to the target; a caller
with none gets 403 `SCOPE_REQUIRED`. For owners and admins that scope is the institution, so the rule is
there for the day a narrower role is admitted, rather than written a second time then.

### Rows

Each target student is evaluated to one row: the roll number, name, current relationship state, outcome
and issues.

| Outcome | When | Effect on commit |
| --- | --- | --- |
| `CHANGE` | a current (`ACTIVE`/`VERIFIED`, open-ended) relationship and a valid end time | written |
| `UNCHANGED` | no current relationship (already graduated, transferred or ended) | reported, not written |
| `INVALID` | roll number not found or outside scope (`STUDENT_NOT_FOUND` — one code, so scope is not probed); end time not after the relationship's start (`EFFECTIVE_BEFORE_START`) | blocks the whole commit |

A unit target larger than 1 000 students is 422 `BATCH_TOO_LARGE`; an empty one is a preview with no rows.

### Effective time

`effectiveTo` may be omitted (the commit's database time is used, one value for every student in the
batch) or given, **but not in the future** (400 `EFFECTIVE_DATE_IN_FUTURE`, checked against the database
clock). The web screen sends the start of the chosen day in the admin's local time.

*Why not future-dated.* Every current view already treats `GRADUATED` as not current regardless of
`effective_to`, so a graduation dated next month would hide the student from current views today while
claiming the college's access runs until next month. The two would disagree for a month. Preview is free
and persists nothing, so a college prepares the batch in advance and commits on the day.

### Preview then commit: a digest, not a table

The preview writes one audit row and returns the rows, the counts and a **digest** — SHA-256 over the
institution, the state, the given `effectiveTo` and every evaluated row (profile, relationship id and
state, start, outcome, issues). Commit re-evaluates inside one transaction, under a per-institution
advisory lock:

- any `INVALID` row → 400 `BATCH_HAS_INVALID_ROWS`, rows returned, **nothing written**;
- digest differs (a student was changed, added or ended since) → 409 `BATCH_PREVIEW_STALE`, nothing written;
- no `CHANGE` row → 400 `NOTHING_TO_CHANGE`;
- otherwise, for every `CHANGE` row: the relationship is updated only if it is still current (else the
  transaction is rolled back as stale), the roster status follows, pending invitations are revoked, and one
  `institution.relationship.ended` audit row (state, reason code, batch reference, effective time,
  `bulk: true`) and one `institution.relationship.ended` outbox event are written — the same action and
  event the per-student endpoint writes, so a person's trail reads the same however they were graduated.
  Then one `institution.relationship_batch.committed` audit row with counts, digest and reason code.

All or nothing: a constraint refusing any row rolls the whole batch back.

**Rejected: a batch table (0060) holding the preview, as the roster importer does.** The roster import
stores rows because committing *creates* people from them. Here every fact is re-read at commit anyway —
a relationship can end between preview and commit — so a stored preview would be a second copy to keep
consistent. The digest gives the same guarantee, "you commit exactly what you were shown", with nothing to
store. The audit rows are the history.

### What a batch action never touches

`users` (the account stays `ACTIVE`), `student_profiles` (visibility and discovery choices), every consent
(application and external-application visibility grants, the consent registry), documents, academic
records, applications, readiness. Graduating changes the college's access; it does not change the
student's data or choices. The integration spec asserts these rows are byte-identical before and after.

## Telling the student

The outbox event `institution.relationship.ended` (already registered, already written by both paths)
gets a consumer, `institution-relationship-notice`. Under a consumer receipt (at most once per event) it
writes one in-app notification (kind `SYSTEM`) to the student, if their account is `ACTIVE`: the college's
name, what changed and from when, that their account and records stay theirs, that the college now sees
only what happened before that date, and that they can still ask the college to verify past results.

It runs after the commit, so a failure to notify can never undo or block the change (plan §5.5). It covers
the per-student endpoint as well as the batch.

**Rejected: a new notification kind** (would need 0060 to widen `user_notifications_kind_ck`): `SYSTEM`
already means "about your account". **Not done: email.** In-app reaches the web bell and the Android inbox;
an email needs a versioned template and a delivery ledger like the announcement's, and is recorded as a
follow-up rather than half-built.

## What the college sees afterwards

- **Roster:** the student stays on the Students list with the new state and end date. It is the college's
  own record of who studied there; deleting it would erase the history the alumni verification queue
  relies on (`FORMER` in `alumni-verification-request-design.md`).
- **Current views:** the student leaves placement status, pipelines, announcements, staff-action subjects,
  assessment assignment and current exports on the next request.
- **Historical reads:** only activity dated before `effective_to` (the policy, unchanged).
- **Verification:** the graduate can still submit a result for verification; it lands in the college's
  queue marked `FORMER`, and the college can still verify it. Nothing here requires enrolment.

## Rejected alternatives

- **Department heads run batch actions for their department.** Plausible, but relationship writes are
  owner/admin today and widening who may end a relationship is a policy change; recorded for Divakar.
- **`REVOKED` in bulk.** A revocation is a correction about one person, not a cohort event.
- **Automatic graduation on `expected_graduation_date`.** A permanent change nobody decided; the date is
  an expectation, not a fact.
- **Archiving or deleting student data at graduation.** Contradicts decision 10.2 #12 and the product rule.
- **Putting former relationships into `studentRelationships`.** Every consumer that scopes by that list
  (the web workspace's organisation, Android's college-assigned items) would silently widen to a college
  the student has left.
