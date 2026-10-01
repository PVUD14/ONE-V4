# SOP — Content authoring: skill map, question bank, lessons and variants, archiving

> What this is: the operator procedure for writing, reviewing, publishing and withdrawing learning
> content in the three editors under Content Management. Why it exists: Appendix 1 OPS-17 (full)
> needs an SOP for every shipped module. Built by OPS-09a (skill map), OPS-09b (question bank),
> OPS-09c (lessons and variants, with ENG-16's native-speaker review) and the OPS-GAPS archive
> action. Written 2026-10-01 against base `719eb34`. Design notes: `skill-map-editor-design.md`,
> `question-bank-editor-design.md`, `lesson-language-serving-design.md` and
> `content-archive-design.md` in `docs/architecture/`.

## Purpose

All three editors follow the same rule. **Someone writes, someone else reviews (and records the
rights review), and someone who did not write it publishes.** A publish that changes what
students are measured against also needs a second person's approval. Every step is audited with
its reason code.

## Who and what capability

| Task | Capability |
|---|---|
| Read the editors | `CONTENT_EDIT`, `CONTENT_REVIEW` or `CONTENT_PUBLISH`. `CATALOGUE_MANAGE` can also read the skill map and lessons, but not the question bank |
| Create, revise, save, submit | `CONTENT_EDIT` |
| Request changes / approve with rights review | `CONTENT_REVIEW` |
| Publish, archive | `CONTENT_PUBLISH` (high-risk to grant) |
| See a question's answer key | `CONTENT_EDIT` or `CONTENT_REVIEW` only. A publisher who holds neither sees the question without its key |

**No platform role holds these by baseline.** Grant them on Settings
([sop-staff-capabilities.md](sop-staff-capabilities.md)). The super admin acts through them only as
break-glass, and each such write is audited `break_glass: true`.

**Contributors never review or publish what they contributed to.**

| Editor | Who counts as a contributor |
|---|---|
| Skill map | The author, and anyone who saved an edit |
| Question bank and lessons | The author, anyone who saved an edit, and whoever submitted it |
| Lessons, in addition | Whoever approved a lesson may not publish it either |

## Where

**Operations → Content Management**, panels **Skill map**, **Question bank** and **Lessons and
variants** (below the Job-role catalogue).

## A. Write

1. **New skill… / New question… / New lesson…** (or **New variant…** on a live base lesson). Choose
   a reason:

   | Editor | Reason codes |
   |---|---|
   | Skill | `NEW_SKILL`, `TRACK_BUILD` |
   | Question | `NEW_QUESTION`, `TRACK_BUILD` |
   | Lesson | `NEW_LESSON`, `TRACK_BUILD` |
   | Variant | `NEW_LANGUAGE`, `NEW_LEVEL`, `NEW_STYLE`, `ACCESSIBILITY` |

2. Fill the editor.
   - A skill needs all four levels (aware, guided, independent, troubleshoot) and a licence
     (`AI8HT-Owned`, `CC-BY-4.0`, `CC-BY-SA-4.0`). Its prerequisites must not form a cycle.
   - A question needs:
     - a skill tag;
     - options a–f and the answer key;
     - a difficulty band;
     - a misconception for each wrong option;
     - a four-step hint ladder (hints are editable only in DRAFT or CHANGES_REQUESTED).
3. **Save draft** (`DRAFT_EDIT`), then **Submit for review…** (`READY_FOR_REVIEW`, or `CHANGES_MADE`
   after a send-back).
4. To change live content, use **Start a new revision…**:

   | Editor | Reason codes |
   |---|---|
   | Skill | `LEVEL_DESCRIPTORS`, `PREREQUISITE_CHANGE`, `CORRECTION`, `EXPERT_FEEDBACK` |
   | Question | `CORRECTION`, `DISTRACTOR_CHANGE`, `HINT_CHANGE`, `EXPERT_FEEDBACK` |
   | Lesson | `CORRECTION`, `CONTENT_UPDATE`, `PREREQUISITE_CHANGE`, `EXPERT_FEEDBACK`, `TRANSLATION_UPDATE` |

## B. Review (a different person)

1. **Request changes…** with a reason:

   | Editor | Reason codes |
   |---|---|
   | Skill | `CONTENT_INACCURATE`, `LEVELS_UNCLEAR`, `PREREQUISITES_WRONG`, `RIGHTS_NOT_CLEARED`, `EXPERT_CHECK_OPEN` |
   | Question | `CONTENT_INACCURATE`, `ANSWER_KEY_WRONG`, `DISTRACTORS_WEAK`, `HINTS_REVEAL_ANSWER`, `RIGHTS_NOT_CLEARED`, `EXPERT_CHECK_OPEN` |
   | Lesson | `CONTENT_INACCURATE`, `TRANSLATION_INACCURATE`, `LEVEL_MISMATCH`, `PREREQUISITES_WRONG`, `RIGHTS_NOT_CLEARED`, `EXPERT_CHECK_OPEN` |

2. Or **Approve, with rights review…**: `REVIEW_PASSED` plus a rights reason (`OWNERSHIP_VERIFIED`
   or `LICENCE_VERIFIED`).
   - A lesson or variant in a language other than English also needs a native-speaker review code
     (`NATIVE_SPEAKER_REVIEWED` or `NATIVE_SPEAKER_CONSULTED`); without one it is refused with
     `LESSON_LANGUAGE_REVIEW_MISSING`.
   - These drafts carry a **Needs native-speaker review** badge.
3. A contributor is refused with `SKILL_SELF_REVIEW_REFUSED`, `QUESTION_SELF_REVIEW_REFUSED` or
   `LESSON_SELF_REVIEW_REFUSED`.
4. A faculty reviewer may also be assigned the draft ([sop-external-reviewers.md](sop-external-reviewers.md)).
   Their decision is advice: it does not approve the revision.

## C. Publish

| Editor | Approval needed when | Approval key |
|---|---|---|
| Skill | It is the skill's first publish, or a live requirement names the skill | `CONTENT_SKILL_PUBLISH` |
| Question | **Always** | `CONTENT_QUESTION_PUBLISH` |
| Lesson | It is a base lesson's first publish, or it changes the topic or prerequisites (wording-only revisions and every variant need `CONTENT_PUBLISH` alone) | `CONTENT_LESSON_PUBLISH` |

1. Where an approval is needed, press **Request publish…** and choose a reason:
   - skill: `NEW_SKILL`, `SKILL_REVISION`, `CORRECTION`, `TRACK_RELEASE`;
   - question: `NEW_QUESTION`, `QUESTION_REVISION`, `CORRECTION`, `TRACK_RELEASE`;
   - lesson: `NEW_LESSON`, `LESSON_REVISION`, `NEW_VARIANT`, `CORRECTION`, `TRACK_RELEASE`.

   The approval is bound to the revision and its content hash. An approver approves it in
   **Settings → Approvals**, and you **Execute** within 24 hours ([sop-approvals.md](sop-approvals.md)).
2. Otherwise press **Publish…** directly.
3. A skill whose prerequisites are not live yet is refused with `SKILL_PREREQUISITE_NOT_LIVE`.
   Publish skills in prerequisite order.
   - A question whose misconception code is not published is refused with
     `QUESTION_MISCONCEPTION_NOT_PUBLISHED`.
   - In both cases the approval stays usable.
4. A publish of a question writes the learner version and the grading-only answer key. The key
   never reaches a learner screen.

## D. Archive (withdraw live content at once)

1. **Archive…** appears on a LIVE skill, question or lesson with no working revision, for a
   `CONTENT_PUBLISH` holder. Choose a reason: `CONTENT_INACCURATE`, `RIGHTS_WITHDRAWN`, `OUT_OF_DATE`,
   `DUPLICATE` or `INCIDENT_RESPONSE`.
2. Archiving takes effect at once and needs no second person, by design: it is a removal and must
   be quick in an incident. It is recorded instead: an ARCHIVE review action, an audit row and an
   event.
3. It is refused (`*_ARCHIVE_BLOCKED`, with the reason listed) while something live depends on the
   item:
   - an open revision;
   - a role requirement;
   - a live skill, question or lesson that depends on it;
   - a live variant of a base lesson.

   Archive dependents first.
4. **Archived is final.** A replacement is new content with a new key.
5. Archiving the last few questions of a skill can stop the readiness check from starting. The
   dialog warns you.

## Escalation

- A send-back loop you cannot resolve: record it in a support case and ask the content lead.
- Content that is harmful or wrong and live now: archive it (D, `INCIDENT_RESPONSE`) and declare
  an incident if students were affected ([sop-incidents-and-status-notices.md](sop-incidents-and-status-notices.md)).

## Never do

- Never review, approve or publish your own work. The server refuses it, so do not look for another way.
- Never paste an answer key, hint or question text into a support case, chat or ticket.
- Never mark AI-drafted content as human-written. While the AI hold stands (ADR-030), nothing here
  is generated by a model.

## Gaps

- A one-person pilot cannot publish content: review needs a second person and has no solo path.
- There is no batch publish. 13 skills means 13 approvals, each with the solo cooling-off when there
  is one approver.
- An APPROVED revision that is never published blocks new revisions of that item.
- Engine content (misconception codes, teaching strategies) has no archive route.
- For skills, a submitter is not counted as a contributor (security review OPS-SR-34).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-8 (skill map), O-9 (question bank
and answer keys), O-10 (lesson variant with native-speaker review), O-12 (archive); also J9.
