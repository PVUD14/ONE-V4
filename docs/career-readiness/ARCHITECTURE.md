# Career Readiness Fundamentals pilot architecture

Status: implemented vertical pilot. The model is advisory and is not visible to employers.

## Native domains

The pilot remains inside the existing PlanThePath application architecture:

- versioned career-readiness taxonomy, modules, lessons, questions, assessment definitions, and blueprints;
- immutable published content revisions and release manifests;
- versioned lesson prerequisites with database and deterministic in-memory cycle checks;
- learner progress and immutable lesson-completion evidence;
- frozen, server-seeded assessment attempts, ordered items, responses, submit-once scoring, and immutable outcome evidence;
- recomputable topic mastery projections with algorithm and evidence-set versions;
- versioned advisory readiness snapshots, factors, and explanations;
- versioned, explainable roadmap actions and completion evidence;
- native email preferences, templates, immutable commands, delivery attempts, and provider mappings.

Question selection uses a deterministic cryptographic hash ordering. The server freezes exact question revisions and timestamps. Learner DTOs omit answer keys and explanations used for scoring. Submission is transactionally idempotent and a submitted attempt cannot be rewritten.

## Readiness model v1

`career-readiness-advisory-v1` derives only named bands from canonical active evidence: `NOT_ENOUGH_EVIDENCE`, `DEVELOPING`, `PROGRESSING`, and `READY_FOR_NEXT_STEP`.

Every snapshot references model version, factors, evidence IDs, and generation time. It can be rebuilt. Numeric percentages are not exposed as calibrated readiness truth. `advisory=true` and `employerVisible=false` are persisted and returned; no employer API exposes this model and no adverse action is automated.

## Roadmap policy v1

`career-readiness-roadmap-v1` emits bounded action codes (`COMPLETE_LESSON`, `RETRY_PRACTICE`, `REVIEW_EVIDENCE`) with reason codes, topic and evidence references, state, and due rules. Actions are advice, not eligibility decisions. Replanning supersedes rather than erases history.

## Notification policy

Email is the only V1 channel. PlanThePath checks email preference, transactional legal purpose, India-local quiet hours, and daily cap before creating a deduplicated command. Recipient resolution happens in the native dispatcher immediately before delivery. Broad integration events contain only command/template IDs and channel, never an address, answer, score, document, resume, or conversation.

Starting the assessment creates the approved assessment-due command; submitting does not email a score. The native command/outbox commit is atomic. n8n receives only a bounded rendered email.

## APIs and UI

Public catalog data is answer-key-free. Protected learner routes derive the learner ID only from the verified Cognito-backed principal. Institution reports require a current selected institution membership and return aggregate-only data with a minimum cohort of five.

The existing Student UI now shows API-backed content on Learning, Assessments, Skills, Readiness, My Career, and Settings/Notifications. It labels the adjacent legacy demo content as preview-only. The Operations Content Management, System Health, Audit Logs, and Security routes render a role-restricted API-backed governance/automation panel. No access token is persisted outside session storage.

## Aggregate institution reporting

PlanThePath computes reports from temporally authorized relationships. Cohorts below five are suppressed. n8n may deliver an expiring opaque artifact reference but cannot query or aggregate learners.

## Retention and corrections

Evidence, projections, snapshots, commands, and audit data are native records. Corrections append superseding evidence; projections are regenerated. Institution artifacts expire after 30 days. Production retention for native evidence and audit records remains subject to the approved privacy schedule; deployments must not extend learner data merely for automation convenience.
