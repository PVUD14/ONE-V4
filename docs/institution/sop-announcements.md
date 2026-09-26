# SOP — Announcements to students

> What this is: the procedure college staff follow to announce something to the students in
> their scope, in the app and by email, and to cancel one. Why it exists: Appendix 3 INST-19
> (IM1 slice); journey J5. Built by INST-06. Written 2026-09-26 against base `6864332`.

## Who can address whom

| Sender | Audience |
|---|---|
| Owner, administrator | The whole college or any unit |
| Placement officer | The whole college, or their own campus/department/batch if scoped |
| Department head | Their department and its units (a head with no department addresses nobody) |
| Faculty | Only the sections and batches of their **active teaching assignments** |

Recipients are checked again when a scheduled announcement is sent; if the sender has lost the
scope by then, nothing is sent.

## Where

**Faculty → Messages**. The screen shows *New announcement*, *Sent and scheduled* and *Your
inbox*. **Other roles have no Messages item yet** (Gap, HG-3).

## Steps

1. **New announcement**: **Title** (up to 160 characters), **Message** (up to 500 — the whole
   message fits in the notification), **Send to** (only audiences you may address are offered).
2. Tick **Also send by email** if needed. Tick **Schedule for later** and choose **Send at**
   (up to 90 days ahead) if it should wait.
3. Send. You may send at most 20 announcements in 24 hours (cancelled ones count).
4. *Sent and scheduled* shows delivery: in-app delivered, emailed, skipped (not activated or
   email turned off), failed.
5. To stop a scheduled one: **Cancel** with `PLANS_CHANGED`, `SENT_IN_ERROR` or `DUPLICATE`. A
   sent announcement cannot be cancelled.

## Never do

- Never put marks, attendance or anything about one student in an announcement.
- Never announce payment requests on behalf of an employer.

## Gaps

- **HG-3 — navigation:** owners, administrators, placement officers and department heads can send
  through the API but have no screen, because they have no Messages item. Adding one is a
  navigation decision for Divakar.
- **HG-7 — no production sender:** email is recorded "not sent: no sender is set up yet"; in-app
  delivery works.
- Students cannot reply; no per-student read receipts.
- Android: students see announcements in their inbox; staff see sent and scheduled ones; composing
  is web-only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J5 (faculty variant).
