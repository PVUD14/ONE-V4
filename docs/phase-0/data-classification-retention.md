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