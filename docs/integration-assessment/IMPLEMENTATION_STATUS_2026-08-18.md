# V4 and n8n implementation status - 2026-08-18

The assessment documents remain design and evidence inputs. Their former "documentation only / not authorized" language describes the earlier assessment state. The approved implementation now exists on `agent/v4-n8n-complete` and is summarized in:

- `docs/v4-integration/IMPLEMENTATION.md`
- `docs/career-readiness/ARCHITECTURE.md`
- `docs/automation/n8n/SECURITY_BASELINE.md`
- `docs/automation/n8n/ARCHITECTURE_RUNBOOK.md`

Implemented: governed V4 staging/quarantine, authored pilot release, native learning/assessment/evidence/readiness/roadmap/notification domains, EventBridge/SQS boundary, native workers/adapter/callbacks, hardened n8n artifacts, six reconstructed inactive workflows, learner/operations APIs, and API-backed UI surfaces.

Deferred to deployment owners: production SMTP, AWS deployment, SSO/MFA/TLS/DNS configuration, legal retention approval, and any V4 record rights clearance. CRM, calendars, arbitrary feeds, AI ranking, non-email channels, and personal V4 history remain explicitly out of scope.
