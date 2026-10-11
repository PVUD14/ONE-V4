# SOP — Adding students and getting them activated

> What this is: the procedure college staff follow to put students on the roster, invite them
> and see who has activated. Why it exists: Appendix 3 INST-19 (IM1 slice) requires an SOP per
> shipped module, written for college staff; journey J1 ("admin imports 200 students; students
> activate") runs through it. Built by INST-01. Written 2026-09-26 against base `6864332`; brought
> up to date 2026-10-01 against base `719eb34` (the INST-18 terms gate, year-end actions, email state).

## Who

| Task | Role |
|---|---|
| Add, import, edit, transfer, graduate or end a student's relationship; resend invitations | Institution owner or administrator |
| See the roster and activation state | Also placement officer, department head and faculty — each only for their own scope |

## Where

**Institution Admin → Students** (the Dashboard's *Student Activation* card shows the counts).

## Before you start

- An **owner** must have accepted the college's current **data-processing terms** (**Settings**).
  Until then adding a student and committing an import are refused ("An owner of your college must
  accept…"). While the college is leaving ONE, no students can be added at all
  ([college exit SOP](sop-college-exit.md)).
- Build the **Academic Structure** first (departments, programmes, batches, sections). The
  import matches unit names to it and refuses unknown names.
- Each student needs a unique college **institution student ID** and their **own** email.

## A. Add one student

1. **Students → Add Student**: institution student ID, full name, email, units, dates →
   **Add student**.
2. The student appears with invitation state *Invited*. An invitation email is queued.

## B. Import a class

1. Prepare a CSV with the header
   `institution_student_id,full_name,email,department,program,batch,section`
   (unit names exactly as in Academic Structure; file under 512 KB).
2. **Import Students**: paste it → **Validate CSV**. Read the preview: accepted, warnings,
   rejected, with each row's issue. A cell starting with `=`, `+`, `-` or `@` is stored with a leading apostrophe so it can never
   run as a spreadsheet formula — check any such name in the preview.
3. Fix every rejected row and validate again. **Commit N rows** stays disabled while any row is
   rejected.
4. **Commit**. Every committed student is invited once; replays never send a second email.

## C. Follow up activation

1. Watch *Student Activation* on the Dashboard and the **Invitation** column on Students
   (the Dashboard and the list are computed from the same rows and always agree).
2. For a student who has not activated, **Resend invitation** on their row, or **Resend to all
   students not yet activated**, with a reason: `NOT_RECEIVED`, `LINK_EXPIRED`,
   `EMAIL_CORRECTED`, `STUDENT_REQUESTED`. A resend issues a new link; the old link stops
   working.
3. When the student signs in with the invited, verified email they land in the student
   workspace linked to this record.

## D. When a student leaves

**Transfer**, **Graduate** or **End relationship** on their row, or for a whole batch at once
**Year-end actions** ([year-end SOP](sop-year-end-actions.md)). Any pending invitation is
revoked at once. Graduated and transferred students keep their account and their history up to that
date.

## Escalation

- "The link says it cannot be used": it was reused, expired, or opened with a different email.
  Resend (C). The message deliberately does not say which.
- A student whose email already has a ONE account is refused at roster creation (Gap).
- Anything else: contact ONE support with the reference shown on screen.

## Never do

- Never enter a parent's, a shared or a staff email for a student.
- Never import real student data into a test or demo college.
- Never commit an import you have not read.

## Gaps (need engineering or a decision)

- **Outgoing email is not switched on in production.** The SMTP sender is built (ADR-042) but the
  sender mailbox is still to be set up, and the automation worker that sends invitations is not yet
  deployed on AWS. Until both are done, invitations are created and shown as not sent; resend once
  email works. Students cannot be activated in production before then without engineering.
- Student sign-in needs the student pool's tokens to carry a verified email claim — a Cognito
  configuration step for Divakar.
- An existing ONE account cannot yet be linked to a roster record (needs its own consent step).
- The roster list returns at most 500 students per view and is not paged (security review
  INST-SR-09).
- Resending has no cooldown: do not press it repeatedly (security review INST-SR-07).
- Ending one student's relationship from their row takes no reason code (INST-SR-06); year-end
  actions do.
- The Android app shows the activation counts; resending is web-only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J1.
