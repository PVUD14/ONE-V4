# Data Classification and Retention

## Classification

- **Public:** approved public opportunity/company/marketing data.
- **Internal:** non-sensitive configuration, taxonomy, operational metadata.
- **Confidential:** user profiles, academic/career records, applications, interview data, institution/employer operational data.
- **Restricted:** authentication/security data, private AI conversations, identity documents if later collected, sensitive support/safety evidence, bulk exports, secrets/keys.

## Handling rules

Restricted and Confidential data must be encrypted in transit and at rest, access-controlled server-side, audited where privileged, excluded from source control, and minimized in logs. Production PII must not be copied to lower environments; use synthetic or irreversibly de-identified fixtures.

## Provenance

Material student records carry subject, source, creator, verification state, verifier where applicable, timestamps, evidence reference where applicable, and effective dates. `SELF_DECLARED`, `INSTITUTION_VERIFIED`, `PLATFORM_ASSESSED`, `EMPLOYER_REPORTED`, and `EXTERNALLY_EVIDENCED` must remain distinguishable.

## Retention principles

Exact legal retention periods remain a deferred decision pending qualified India privacy/legal review. Until approved, schemas/services must support configurable policy by record class rather than hard-coded durations.

Initial operational defaults for design/testing only:

- closed employer applicant access: 90 days, then revoke normal employer access unless an approved basis exists;
- deleted account: grace/recovery period configurable; after completion, designated personal data is deleted/anonymized and is not silently resurrected on re-registration;
- audit/security records: retained longer than ordinary user content where legally justified and access-restricted;
- analytics: prefer aggregated/de-identified retention once identifiable detail is no longer required.

## Deletion/export

Deletion is a workflow: verify requester → disable/restrict account → evaluate retention holds → delete/anonymize designated data → record completion. Export must be authenticated, rate-limited, scoped to the subject, securely delivered, and audited.

## Relationship expiry

Ending/transferring an institution relationship immediately changes authorization to subsequent activity. Retention of historically lawful institution-originated records does not grant visibility to future student events.

## Provider inventory

Every processor/integration must document data categories shared, purpose, region, retention, subprocessors where relevant, security terms, deletion behavior, and exit strategy before production use.
## What account deletion does, by category

The declared policy is `DELETION_POLICY` in `packages/privacy/src/index.ts`; every executed deletion writes
one `privacy_deletion_records` row per category with its disposition, record count and, for anything kept,
the basis the person is shown. Details and the table-by-table audit: `docs/architecture/privacy-export-coverage.md`.

| Category | Disposition | What it covers |
|---|---|---|
| IDENTITY | Anonymised | The account row, kept without identity so references stay valid |
| STUDENT_PROFILE | Erased | Profile, career targets and gaps, goals, outcome declarations, external applications, academic records, public profile links and photo |
| DOCUMENTS | Erased | Document metadata, versions and stored bytes |
| NOTIFICATIONS | Erased | Notification commands, preferences, in-app notifications, push devices |
| INSTITUTION_ROSTER | Anonymised | The college's enrolment history, with the name replaced |
| APPLICATIONS, OFFERS | Anonymised | The employer's hiring record; shared snapshots erased in place |
| EMPLOYER_SCREENING | Anonymised | Screening attempts and scores kept for the employer; the person's answers erased |
| APPLICATION_MESSAGES | Erased | Message text, both sides |
| ASSESSMENT_EVIDENCE | Anonymised | Evidence records, detached |
| LEARNING_ACTIVITY | Erased | Engine behavioural data and learning history: attempts, sessions, activity, decisions, step items, placement sittings, skill state, lecturer actions for the person, lesson progress, topic bands, readiness snapshots and factors, roadmap actions, readiness-check assignments, attempts, items and responses |
| COUNSELLING_NOTES | Erased | Counselling notes and case participants |
| STAFF_ACTIONS | Erased | The text of every other staff-only college action about the person; the row's skeleton stays for the college's counts and the rows that reference it |
| SUPPORT_CASES | Anonymised | The service record, without the person, summary or notes |
| CONSENT_RECORDS | Retained | Consent grants and withdrawals, as proof of consent (legal obligation), linked only to the anonymised account |
| AUDIT | Retained | Security and access audit, under the retention schedule |

A deleted person is not silently resurrected by a college: a results import skips their roll number
(`SKIPPED`, `student_deleted`), and a roster import refuses a roll number already on the roster.
