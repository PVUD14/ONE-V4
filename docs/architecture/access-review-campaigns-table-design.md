# Access Review Campaigns — Table Design

**Status:** Adopted (OPS-15). Where a choice was needed, the recommended option was taken, per AGENTS.md ("ask once, recommend, carry on").
**Date:** 2026-09-29
**Migration:** `0079_access_review_campaigns.sql`
**Builds on:** ADR-032 and `internal-capabilities-table-design.md` (OPS-01, `0039`); `high-risk-approvals-table-design.md` (OPS-02, `0038`), whose solo-operator pattern this reuses; ADR-037 and `external-review-assignments-table-design.md` (OPS-10, `0066`), which left standing faculty grants to this review.
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`.

## Why this exists

ISO/IEC 27001 (A.5.18) and the security go-live gate both expect privileged access to be reviewed on a schedule, with evidence. ONE records who holds internal access in three places:

- the platform role on `organization_memberships`;
- internal capability grants on `membership_capabilities` (0039);
- faculty `CONTENT_REVIEW_EXTERNAL` grants on the same table (OPS-10).

Nothing asks anyone to look at those records periodically, and nothing proves that anyone did. OPS-10 said so directly: standing faculty grants are left to "the quarterly access review (OPS-15)".

An access review needs three things:

- a fixed list of what existed when the review started;
- a named person's decision on each entry, with a reason;
- a record that any removal actually took effect.

A reviewer cannot mark their own homework. With one operator, that rule has to fail visibly rather than silently.

## Decision 1: a campaign plus a frozen snapshot of items

**Chosen.** Two tables:

- `access_review_campaigns`: one row per review, with its period, opener, state and closure.
- `access_review_items`: one row per standing access, copied when the campaign opens.

The item copies everything a reviewer is judging: role, membership state, capability, the capability set, who granted it, when, and why. If the grant is revoked or the role changes during the campaign, the item still shows what was reviewed. The CSV then reproduces the campaign exactly, not the live state.

Rejected alternatives:

- **Reviewing the live tables directly, storing only decisions.** The list would change under the reviewer, so a grant added mid-review would never be reviewed. "What was reviewed on 2 October" could then only be rebuilt from audit, and the export could not reproduce the campaign.
- **Only audit rows** (one `access_review.attested` event per grant). Audit rows cannot be read back to decide whether a campaign may close, cannot enforce one decision per item, and cannot hold a snapshot the database protects.
- **One item per membership only**, with a capability array, as the goal text sketches. A reviewer then cannot keep someone's role but remove one of their grants, and a REVOKE would be ambiguous. The plan's own rule ("lists every standing internal grant with who granted it and when; the reviewer confirms or revokes each") needs one row per grant. The role remains its own item, carrying the capability snapshot the goal asks for.

### What becomes an item

| `item_kind` | Source | One row per |
| --- | --- | --- |
| `PLATFORM_ROLE` | `organization_memberships` in the `PLATFORM` organisation, state `ACTIVE` | membership. The snapshot is the membership's effective capability set: baseline, plus valid grants, plus the super admin's break-glass set. |
| `CAPABILITY_GRANT` | live `membership_capabilities` rows other than `INSTITUTION_ANALYTICS`, on platform memberships (0039's internal vocabulary) **and** `CONTENT_REVIEW_EXTERNAL` on faculty memberships (OPS-10) | grant |

What is not an item, and why:

- **`INSTITUTION_ANALYTICS`**. A college's own admin grants this to their own staff (ADR-018, INST-08). The college reviews it: its analytics screen already offers the reason `ACCESS_REVIEW`. If AI8HT revoked a college's delegation from an internal review, it would override the college's own governance.
- **`operation_approvals`**. An approval is not standing access: it lasts 24 hours at most and is used once. Its history is already in audit, and in the Approvals queue with SOLO markers.
- **PENDING, SUSPENDED and ENDED platform memberships**. They hold no capability (§5.1). A pending invitation becomes an item in the next review after it is accepted.

"Who granted it and when":

- For a grant, this is `granted_by_user_id` and `granted_at` from the grant row.
- For a platform role, it is the inviter of the accepted invitation that created the membership, and `created_at`. When no invitation exists (a membership seeded at bootstrap), the grantor is NULL and the screen and CSV show `NA`. Nothing is inferred.

## Decision 2: decisions, and what REVOKE does

Each item gets exactly one decision:

- `KEEP`, with a reason from `STILL_REQUIRED`, `ROLE_REQUIRES_IT` or `TEMPORARY_COVER_CONTINUES`.
- `REVOKE`, with a reason from `NO_LONGER_REQUIRED`, `LEAVER`, `EXCESSIVE_PRIVILEGE`, `UNRECOGNISED_GRANT` or `SECURITY_INCIDENT`.

Either may carry an optional note of 500 characters or fewer.

**A REVOKE takes effect in the same transaction as the decision.** It uses the same statements, audit action and outbox event as the capability APIs:

| Item | Effect |
| --- | --- |
| Internal capability grant | The grant is revoked with `revoked_reason_code = ACCESS_REVIEW_OUTCOME` (already in OPS-01's revoke list). Audit `operations.staff_capability.revoked` and outbox `organization_membership.capability_revoked`, as `revokeInternalCapability` writes them. |
| `CONTENT_REVIEW_EXTERNAL` grant | As `revokeExternalReviewer`: the grant is revoked, and the faculty member's open assignments are closed with `GRANT_REVOKED`. Audit `operations.external_reviewer.revoked` / `operations.external_review.revoked`, and the same outbox events. |
| Platform role | The membership moves to `SUSPENDED`, and its live internal grants are revoked with `ACCESS_REVIEW_OUTCOME`. Audit `operations.staff_membership.suspended`, outbox `organization_membership.suspended` (already registered) and `organization_membership.capability_revoked` for each grant. |

Every one of these audit rows carries `accessReview: { campaignId, itemId, periodLabel, decisionReasonCode }`. That is the goal's "revocations appear in audit with the campaign reference". Every decision, KEEP included, also writes `operations.access_review.item_decided`.

The shared statements are factored out of `platform-controls.ts` and `external-reviews.ts`, so the capability screens and the review cannot drift apart. The capability APIs themselves are unchanged.

If the access has already ended by the time of the decision (revoked from Settings, or the membership left in the meantime), the decision is still recorded, with `revocation_outcome = ALREADY_ENDED`. Otherwise it is `APPLIED`. Nothing claims a removal that did not happen.

**Suspension, not ending, for a platform role.** Suspension is the existing, registered membership event, and it is reversible. A mistaken review decision on the only other operator should be recoverable. Either state removes every capability at once, because only ACTIVE memberships count.

**Guards on REVOKE:**

- nobody revokes their own access (see Decision 3);
- the last ACTIVE `PLATFORM_SUPER_ADMIN` cannot be suspended (`ACCESS_REVIEW_LAST_SUPER_ADMIN`), so a review can never lock AI8HT out of its own console.

**Who applies it.** The reviewer holds `SECURITY_ACCESS_REVIEW` (baseline for `SECURITY_ADMIN` and the super admin, grantable to `OPERATIONS_ADMIN`), not `CAPABILITY_ADMIN`. This is deliberate:

- removal is the safe direction, and OPS-01 already lets revocation skip the super-admin rule;
- a review whose "revoke" waits for someone else is not evidence that access was removed;
- the privilege matrix gives `SECURITY_ADMIN` "access reviews … security suspension".

The power is narrow. It works only on an item in an OPEN campaign, only to remove access, never to grant it, and never on oneself.

## Decision 3: a reviewer cannot attest their own access — and the solo operator

The API (`refuseAccessReviewDecision`) and the trigger both refuse a decision by the item's subject: `ACCESS_REVIEW_OWN_ACCESS`.

With one operator, this rule would leave that operator's own items undecided forever, so the campaign could never close. Two answers were rejected:

- **Self-certification with no mark** would be a lie in the evidence.
- **Leaving it unclosable** makes the pilot's review impossible.

Instead, OPS-02's solo safeguard is reused exactly:

- **When:** while exactly one person holds `SECURITY_ACCESS_REVIEW`, that person may decide their **own** items.
- **Which decision:** `KEEP` only. Revoking your own access is refused by the capability rules, and a solo operator removing themselves would lock the console.
- **Cooling-off:** no sooner than **15 minutes after the campaign opened**.
- **Marking:** the item is marked `solo = true`, the audit row says `mode: SOLO`, and the screen, the campaign summary (the "self-attested (solo)" count) and the CSV (`mode` column) all show it.

The safeguard switches itself off. `access_review_reviewer_count()` is evaluated when the decision is made, so the moment a second reviewer exists, self-attestation is refused and the other person has to decide.

No email notice is raised. OPS-02's notice exists because a solo approval precedes an action. Here the SOLO mark is on the evidence itself, which is the thing an auditor reads.

A person may decide an item for a grant they themselves gave. Independence from the **subject** is the control ISO asks for. Also excluding the grantor would, in a two-person team, often leave no eligible reviewer at all.

## Decision 4: schedule and overdue

- **The period** is the calendar quarter (UTC) in which the campaign opens, e.g. `2026-Q4`, stamped by the database. More than one campaign may exist for a period (a post-incident re-review), but **only one campaign is OPEN at a time**, enforced by a partial unique index. Two open snapshots would split decisions.
- **Campaign due date:** `opened_at + 30 days`, stamped. After that, an open campaign is overdue.
- **Program cadence:** the next review is due 3 calendar months after the last campaign **closed**.
- **The review is overdue when:**
  - no campaign has ever closed (`NEVER_REVIEWED`);
  - the next due date has passed (`REVIEW_OVERDUE`);
  - or the open campaign has passed its own due date (`CAMPAIGN_OVERDUE`).

  The summary endpoint computes this with bounded SQL, and the screen shows it as a status tile. The rule is a pure function in `packages/authorization`.
- **Closing** needs every item decided. The trigger refuses a close with undecided items. A closed campaign is final: no item changes after it.

## Columns

### `access_review_campaigns`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `period_label` | text NOT NULL, `^[0-9]{4}-Q[1-4]$`, stamped from the database clock. |
| `state` | `OPEN` / `CLOSED`. |
| `opened_by_user_id` | → `users`. Must be a reviewer (trigger). |
| `opened_at`, `due_at` | Stamped: `now()`, `now() + 30 days`. |
| `open_reason_code` | `QUARTERLY_REVIEW`, `AD_HOC_REVIEW`, `POST_INCIDENT_REVIEW` or `AUDIT_REQUEST`. |
| `open_note` | ≤ 500, optional. |
| `open_correlation_id` | text NOT NULL. |
| `item_count` | int ≥ 0, the snapshot size, written at open. |
| `closed_by_user_id`, `closed_at`, `close_reason_code`, `close_correlation_id` | Set together, only on CLOSED. `closed_at` is stamped. |

### `access_review_items`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `campaign_id` | → campaigns. |
| `position` | int ≥ 1, unique per campaign. The snapshot order, used for keyset paging and CSV order. |
| `item_kind` | `PLATFORM_ROLE` / `CAPABILITY_GRANT`. |
| `membership_id` | → `organization_memberships`. |
| `subject_user_id` | → `users`. |
| `organization_id` | → `organizations`. |
| `role`, `membership_state` | As they were at the snapshot. |
| `capability`, `capability_grant_id` | Both required for a grant and forbidden for a role. The grant id is FK → `membership_capabilities`, unique per campaign. |
| `capabilities_snapshot` | text[] NOT NULL. |
| `high_risk` | Whether the item confers any §5.4 high-risk capability. |
| `granted_by_user_id` | NULL allowed for a role with no invitation. |
| `granted_at` | Grant time, or membership creation. |
| `grant_reason_code` | The grant's reason; NULL for a role. |
| `decision`, `decision_reason_code`, `decision_note`, `decided_by_user_id`, `decided_at`, `decision_correlation_id` | All set together, once. `decided_at` is stamped. |
| `solo` | boolean. True only on a KEEP by the subject. |
| `revocation_outcome` | `APPLIED` / `ALREADY_ENDED`, required exactly when the decision is REVOKE. |

## Rules, and where each is enforced

Every rule is decided by pure functions in `packages/authorization/src/access-reviews.ts`, which give the API's answer and error code. The rules are repeated by triggers, so a second writer cannot skip them. This is the pattern 0038 and 0039 use.

1. **Reviewer.** Opening, deciding and closing need `SECURITY_ACCESS_REVIEW`. The trigger checks the same through `access_review_is_reviewer(user)`: an ACTIVE user with an ACTIVE platform membership that is `PLATFORM_SUPER_ADMIN` or `SECURITY_ADMIN`, or that carries a live `SECURITY_ACCESS_REVIEW` grant. An integration test pins this to the TypeScript baselines.
2. **Snapshot integrity.**
   - Items can be inserted only while their campaign is OPEN, and only in the transaction that opened it (`campaign.opened_at = now()`, since `now()` is the transaction's start time). A later writer cannot add or remove what is under review.
   - Snapshot columns never change.
3. **One decision, once, while OPEN.** Decision columns go from NULL to set, only once, and never after the campaign closes.
4. **Not your own access.** `decided_by_user_id <> subject_user_id`, unless the decision is `solo`. A solo decision needs all of the following:
   - the decision is by the subject;
   - the decision is KEEP;
   - `access_review_reviewer_count() = 1`;
   - `now() >= opened_at + 15 minutes`.
5. **Close.** A campaign moves only from OPEN to CLOSED, and only when no item is undecided. Closing is stamped by the database.
6. **Immutability.** Neither table allows DELETE. Campaign identity columns never change.

API refusals:

| Status | Code |
| --- | --- |
| 403 | `FORBIDDEN`, `ACCESS_REVIEW_OWN_ACCESS`, `ACCESS_REVIEW_SOLO_COOLING_OFF`, `ACCESS_REVIEW_LAST_SUPER_ADMIN` |
| 409 | `ACCESS_REVIEW_ALREADY_OPEN`, `ACCESS_REVIEW_NOT_OPEN`, `ACCESS_REVIEW_ALREADY_DECIDED`, `ACCESS_REVIEW_UNDECIDED_ITEMS` |
| 404 | `ACCESS_REVIEW_NOT_FOUND` |
| 400 | input errors |

## Export

`POST /operations/access-reviews/:id/export` takes a reason code (`AUDIT_EVIDENCE`, `CERTIFICATION_EVIDENCE` or `INTERNAL_RECORD`) and returns `text/csv`. It uses the house CSV writer (`institution-export-csv.ts`): every cell is quoted, and formula-leading text is prefixed with `'`.

The file has one row per item, in snapshot order. Every row carries the campaign columns, followed by the item columns.

**Personal data.** The file contains staff and faculty email addresses, roles and capability names, and no student data. That is the minimum an auditor needs to identify who held what. It is not a §5.4 "bulk export containing personal data" of users, so it needs no dual control. It is recorded as a decision below.

**Audit.** Each export writes `operations.access_review.exported` with the reason, the row count and the SHA-256 of the file, so the evidence handed out can be matched to what the system produced.

**Test.** The integration test parses the CSV and compares it, field by field, with the campaign and items the API returns.

## Audit and events

Audit actions:

- `operations.access_review.opened`, with the item count and counts by kind;
- `operations.access_review.item_decided`, with the decision, reason, mode, item kind, capability and subject;
- `operations.access_review.closed`, with the kept, revoked and solo counts;
- `operations.access_review.exported`;
- the revocation actions from Decision 2, each carrying `accessReview`.

Outbox events, registered in `packages/events`, carrying identifiers and enums only:

- `access_review.opened`;
- `access_review.item_decided`;
- `access_review.closed`.

## Screen

The screen sits under the existing **Security** label, below the privacy and consent console (Appendix 1 §4.2). No navigation item changes.

It shows:

- status tiles: the last completed review, the next review due, the open campaign's progress, and an overdue flag. A missing source shows `NA`.
- an Open button, which opens a confirm dialog with the reason code;
- the items table: subject, organisation, role or capability, high-risk mark, granted by and when, decision, mode and outcome;
- KEEP and REVOKE dialogs, each needing a reason code. The REVOKE dialog says the removal is immediate;
- Close, which is disabled until every item is decided;
- Export CSV, which asks for a reason code;
- a campaign history list.

Your own items show why you cannot decide them, or when the solo window opens.

## Open points (decisions for Divakar)

1. **Solo self-attestation.** Adopted: OPS-02's pattern, as KEEP only, after 15 minutes, marked SOLO, and switching itself off.
2. **Role revocation suspends** rather than ends the membership. The last super admin is protected.
3. **The reviewer applies revocations** with `SECURITY_ACCESS_REVIEW` alone. `CAPABILITY_ADMIN` is not required, because removal is the safe direction.
4. **Cadence.** Quarterly, meaning 3 months from the last close, with 30 days to finish a campaign. A campaign may open at any time.
5. **`INSTITUTION_ANALYTICS` is out of scope.** It is the college's delegation, and the college reviews it.
6. **The export carries staff and faculty emails** and is audited with a hash. It has no dual control.
