CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  package_identity text NOT NULL UNIQUE,
  source_repository text NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-fA-F]{40}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-fA-F]{64}$'),
  transform_version text NOT NULL CHECK (transform_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  status text NOT NULL CHECK (status IN ('STARTED','VALIDATED','STAGED','FAILED','ROLLED_BACK')),
  started_by_user_id uuid NOT NULL REFERENCES users(id),
  record_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT migration_run_completion_ck CHECK ((status IN ('VALIDATED','STAGED','FAILED','ROLLED_BACK')) = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS source_packages (
  id uuid PRIMARY KEY,
  migration_run_id uuid NOT NULL REFERENCES migration_runs(id),
  deterministic_key text NOT NULL UNIQUE,
  source_repository text NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[0-9a-fA-F]{40}$'),
  package_hash text NOT NULL CHECK (package_hash ~ '^[0-9a-fA-F]{64}$'),
  transform_version text NOT NULL,
  source_paths jsonb NOT NULL,
  checksums jsonb NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_records (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES source_packages(id),
  source_entity_type text NOT NULL,
  source_record_id text NOT NULL,
  source_path text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-fA-F]{64}$'),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  license_label text NOT NULL,
  attribution_required boolean NOT NULL DEFAULT false,
  rights_state text NOT NULL CHECK (rights_state IN ('PENDING','APPROVED','REJECTED')),
  sme_state text NOT NULL CHECK (sme_state IN ('PENDING','APPROVED','CHANGES_REQUESTED','REJECTED')),
  quality_state text NOT NULL CHECK (quality_state IN ('PENDING','APPROVED','CHANGES_REQUESTED','REJECTED')),
  mapping_state text NOT NULL CHECK (mapping_state IN ('UNMAPPED','MAPPED','REJECTED')),
  duplicate_state text NOT NULL CHECK (duplicate_state IN ('UNCHECKED','UNIQUE','DUPLICATE','MERGED')),
  release_state text NOT NULL CHECK (release_state IN ('QUARANTINED','ELIGIBLE','RELEASED','EXCLUDED')),
  rejection_reason_codes text[] NOT NULL DEFAULT '{}',
  release_eligible boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_record_identity_uq UNIQUE (package_id, source_entity_type, source_record_id),
  CONSTRAINT source_record_release_eligibility_ck CHECK (
    release_eligible = (
      rights_state = 'APPROVED'
      AND sme_state = 'APPROVED'
      AND quality_state = 'APPROVED'
      AND mapping_state = 'MAPPED'
      AND duplicate_state IN ('UNIQUE','MERGED')
      AND cardinality(rejection_reason_codes) = 0
      AND release_state IN ('ELIGIBLE','RELEASED')
    )
  )
);
CREATE INDEX IF NOT EXISTS source_records_review_queue_idx ON source_records(rights_state, sme_state, quality_state, release_state);

CREATE TABLE IF NOT EXISTS content_provenance (
  id uuid PRIMARY KEY,
  source_record_id uuid NOT NULL REFERENCES source_records(id),
  canonical_entity_type text NOT NULL,
  canonical_entity_id uuid NOT NULL,
  canonical_version integer NOT NULL CHECK (canonical_version > 0),
  provenance_hash text NOT NULL CHECK (provenance_hash ~ '^[0-9a-fA-F]{64}$'),
  transform_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_provenance_mapping_uq UNIQUE (source_record_id, canonical_entity_type, canonical_entity_id, canonical_version)
);

CREATE TABLE IF NOT EXISTS rights_reviews (
  id uuid PRIMARY KEY,
  source_record_id uuid NOT NULL REFERENCES source_records(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('APPROVED','REJECTED','NEEDS_EVIDENCE')),
  license_label text NOT NULL,
  attribution_requirement text,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quality_reviews (
  id uuid PRIMARY KEY,
  source_record_id uuid NOT NULL REFERENCES source_records(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  review_kind text NOT NULL CHECK (review_kind IN ('SME','QUALITY','ACCESSIBILITY','DUPLICATE')),
  state text NOT NULL CHECK (state IN ('APPROVED','REJECTED','CHANGES_REQUESTED')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_validation_results (
  id uuid PRIMARY KEY,
  migration_run_id uuid NOT NULL REFERENCES migration_runs(id),
  source_record_id uuid REFERENCES source_records(id),
  rule_code text NOT NULL CHECK (rule_code ~ '^[A-Z0-9_:-]{3,64}$'),
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','BLOCKING')),
  passed boolean NOT NULL,
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canonical_id_mappings (
  id uuid PRIMARY KEY,
  source_record_id uuid NOT NULL REFERENCES source_records(id),
  canonical_entity_type text NOT NULL,
  canonical_entity_id uuid,
  disposition text NOT NULL CHECK (disposition IN ('ACCEPTED','MERGED','REJECTED','QUARANTINED','SUPERSEDED')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_id_mapping_uq UNIQUE (source_record_id, canonical_entity_type)
);

CREATE TABLE IF NOT EXISTS release_manifests (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  manifest_hash text NOT NULL UNIQUE CHECK (manifest_hash ~ '^[0-9a-fA-F]{64}$'),
  status text NOT NULL CHECK (status IN ('DRAFT','APPROVED','PUBLISHED','ROLLED_BACK','ARCHIVED')),
  approved_by_user_id uuid REFERENCES users(id),
  published_by_user_id uuid REFERENCES users(id),
  rollback_manifest_id uuid REFERENCES release_manifests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  published_at timestamptz,
  CONSTRAINT release_manifest_name_version_uq UNIQUE (name, version),
  CONSTRAINT release_manifest_approval_ck CHECK (status = 'DRAFT' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT release_manifest_publication_ck CHECK (status NOT IN ('PUBLISHED','ROLLED_BACK','ARCHIVED') OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS content_revisions (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('CAREER_ROLE','SUBJECT','TOPIC','SKILL','MODULE','LESSON','QUESTION','ASSESSMENT_BLUEPRINT')),
  entity_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  author_user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','PUBLISHED','ARCHIVED')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-fA-F]{64}$'),
  body jsonb NOT NULL,
  release_manifest_id uuid REFERENCES release_manifests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT content_revision_entity_uq UNIQUE (entity_type, entity_id, revision),
  CONSTRAINT content_revision_publication_ck CHECK ((state = 'PUBLISHED') = (published_at IS NOT NULL AND release_manifest_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS release_manifest_items (
  manifest_id uuid NOT NULL REFERENCES release_manifests(id),
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  source_record_id uuid NOT NULL REFERENCES source_records(id),
  item_hash text NOT NULL CHECK (item_hash ~ '^[0-9a-fA-F]{64}$'),
  PRIMARY KEY (manifest_id, content_revision_id)
);

CREATE TABLE IF NOT EXISTS content_review_actions (
  id uuid PRIMARY KEY,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('SUBMIT','REQUEST_CHANGES','APPROVE','PUBLISH','ARCHIVE','ROLLBACK')),
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('CAREER_ROLE','SUBJECT','TOPIC','SKILL')),
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT taxonomy_node_version_uq UNIQUE (kind, stable_key, version)
);

CREATE TABLE IF NOT EXISTS taxonomy_aliases (
  id uuid PRIMARY KEY,
  taxonomy_node_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  alias text NOT NULL,
  source_mapping_id uuid REFERENCES canonical_id_mappings(id),
  CONSTRAINT taxonomy_alias_uq UNIQUE (taxonomy_node_id, alias)
);

CREATE TABLE IF NOT EXISTS learning_modules (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  description text NOT NULL,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  release_manifest_id uuid NOT NULL REFERENCES release_manifests(id),
  published_at timestamptz NOT NULL,
  CONSTRAINT learning_module_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS lesson_versions (
  id uuid PRIMARY KEY,
  module_id uuid NOT NULL REFERENCES learning_modules(id),
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body jsonb NOT NULL,
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  published_at timestamptz NOT NULL,
  CONSTRAINT lesson_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS lesson_prerequisites (
  lesson_version_id uuid NOT NULL REFERENCES lesson_versions(id),
  prerequisite_lesson_version_id uuid NOT NULL REFERENCES lesson_versions(id),
  required boolean NOT NULL DEFAULT true,
  PRIMARY KEY (lesson_version_id, prerequisite_lesson_version_id),
  CONSTRAINT lesson_prerequisite_self_ck CHECK (lesson_version_id <> prerequisite_lesson_version_id)
);

CREATE TABLE IF NOT EXISTS learner_progress (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  lesson_version_id uuid NOT NULL REFERENCES lesson_versions(id),
  state text NOT NULL CHECK (state IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  started_at timestamptz,
  completed_at timestamptz,
  last_correlation_id text NOT NULL CHECK (last_correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_progress_uq UNIQUE (subject_user_id, lesson_version_id),
  CONSTRAINT learner_progress_completion_ck CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS assessment_definitions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  release_manifest_id uuid NOT NULL REFERENCES release_manifests(id),
  attempt_limit integer NOT NULL DEFAULT 1 CHECK (attempt_limit > 0),
  time_limit_seconds integer NOT NULL CHECK (time_limit_seconds BETWEEN 60 AND 14400),
  published_at timestamptz NOT NULL,
  CONSTRAINT assessment_definition_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS assessment_blueprints (
  id uuid PRIMARY KEY,
  assessment_definition_id uuid NOT NULL REFERENCES assessment_definitions(id),
  version integer NOT NULL CHECK (version > 0),
  selection_count integer NOT NULL CHECK (selection_count > 0),
  algorithm_version text NOT NULL,
  constraints jsonb NOT NULL,
  CONSTRAINT assessment_blueprint_version_uq UNIQUE (assessment_definition_id, version)
);

CREATE TABLE IF NOT EXISTS assessment_sections (
  id uuid PRIMARY KEY,
  blueprint_id uuid NOT NULL REFERENCES assessment_blueprints(id),
  position integer NOT NULL CHECK (position > 0),
  title text NOT NULL,
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  question_count integer NOT NULL CHECK (question_count > 0),
  CONSTRAINT assessment_section_position_uq UNIQUE (blueprint_id, position)
);

CREATE TABLE IF NOT EXISTS question_versions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  prompt text NOT NULL,
  options jsonb NOT NULL,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  release_manifest_id uuid NOT NULL REFERENCES release_manifests(id),
  published_at timestamptz NOT NULL,
  CONSTRAINT question_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS question_answer_keys (
  question_version_id uuid PRIMARY KEY REFERENCES question_versions(id),
  correct_option_id text NOT NULL,
  explanation text NOT NULL,
  answer_hash text NOT NULL CHECK (answer_hash ~ '^[0-9a-fA-F]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assessment_assignments (
  id uuid PRIMARY KEY,
  assessment_definition_id uuid NOT NULL REFERENCES assessment_definitions(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  available_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('ASSIGNED','AVAILABLE','COMPLETED','EXPIRED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_assignment_window_ck CHECK (due_at > available_at)
);

CREATE TABLE IF NOT EXISTS assessment_attempts (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES assessment_assignments(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  blueprint_id uuid NOT NULL REFERENCES assessment_blueprints(id),
  selection_seed text NOT NULL CHECK (length(selection_seed) BETWEEN 16 AND 256),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','SUBMITTED','EXPIRED','VOIDED')),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  submission_idempotency_key text,
  score_correct integer,
  score_possible integer,
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT assessment_attempt_window_ck CHECK (expires_at > started_at),
  CONSTRAINT assessment_attempt_submission_ck CHECK ((state = 'SUBMITTED') = (submitted_at IS NOT NULL AND submission_idempotency_key IS NOT NULL AND score_correct IS NOT NULL AND score_possible IS NOT NULL)),
  CONSTRAINT assessment_attempt_submit_key_uq UNIQUE (subject_user_id, submission_idempotency_key)
);

CREATE TABLE IF NOT EXISTS assessment_attempt_items (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES assessment_attempts(id),
  question_version_id uuid NOT NULL REFERENCES question_versions(id),
  position integer NOT NULL CHECK (position > 0),
  CONSTRAINT assessment_attempt_item_position_uq UNIQUE (attempt_id, position),
  CONSTRAINT assessment_attempt_item_question_uq UNIQUE (attempt_id, question_version_id)
);

CREATE TABLE IF NOT EXISTS assessment_responses (
  id uuid PRIMARY KEY,
  attempt_item_id uuid NOT NULL UNIQUE REFERENCES assessment_attempt_items(id),
  selected_option_id text NOT NULL,
  responded_at timestamptz NOT NULL,
  is_correct boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_records (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  evidence_type text NOT NULL CHECK (evidence_type IN ('LESSON_COMPLETION','ASSESSMENT_OUTCOME','TOPIC_DEMONSTRATION')),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  demonstrated integer NOT NULL CHECK (demonstrated >= 0),
  possible integer NOT NULL CHECK (possible > 0),
  source_aggregate_type text NOT NULL,
  source_aggregate_id uuid NOT NULL,
  content_version text NOT NULL,
  model_version text,
  provenance jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  supersedes_evidence_id uuid REFERENCES evidence_records(id),
  correction_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_value_ck CHECK (demonstrated <= possible),
  CONSTRAINT evidence_source_uq UNIQUE (subject_user_id, evidence_type, source_aggregate_type, source_aggregate_id, topic_id)
);

CREATE TABLE IF NOT EXISTS mastery_projections (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  algorithm_version text NOT NULL,
  evidence_ids uuid[] NOT NULL,
  evidence_set_hash text NOT NULL CHECK (evidence_set_hash ~ '^[0-9a-fA-F]{64}$'),
  band text NOT NULL CHECK (band IN ('NOT_ENOUGH_EVIDENCE','DEVELOPING','PROGRESSING','DEMONSTRATED')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  supersedes_projection_id uuid REFERENCES mastery_projections(id)
);

CREATE TABLE IF NOT EXISTS readiness_model_versions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  published_by_user_id uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CONSTRAINT readiness_model_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS readiness_snapshots (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  model_version_id uuid NOT NULL REFERENCES readiness_model_versions(id),
  evidence_ids uuid[] NOT NULL,
  evidence_set_hash text NOT NULL CHECK (evidence_set_hash ~ '^[0-9a-fA-F]{64}$'),
  band text NOT NULL CHECK (band IN ('NOT_ENOUGH_EVIDENCE','DEVELOPING','PROGRESSING','READY_FOR_NEXT_STEP')),
  advisory boolean NOT NULL DEFAULT true CHECK (advisory),
  employer_visible boolean NOT NULL DEFAULT false CHECK (NOT employer_visible),
  explanation jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  supersedes_snapshot_id uuid REFERENCES readiness_snapshots(id)
);

CREATE TABLE IF NOT EXISTS readiness_factors (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES readiness_snapshots(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  mastery_projection_id uuid NOT NULL REFERENCES mastery_projections(id),
  reason_code text NOT NULL,
  explanation text NOT NULL,
  CONSTRAINT readiness_factor_uq UNIQUE (snapshot_id, topic_id)
);

CREATE TABLE IF NOT EXISTS roadmap_policy_versions (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  published_by_user_id uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CONSTRAINT roadmap_policy_version_uq UNIQUE (stable_key, version)
);

CREATE TABLE IF NOT EXISTS roadmap_actions (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  policy_version_id uuid NOT NULL REFERENCES roadmap_policy_versions(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  action_code text NOT NULL CHECK (action_code IN ('COMPLETE_LESSON','RETRY_PRACTICE','REVIEW_EVIDENCE')),
  reason_code text NOT NULL,
  evidence_ids uuid[] NOT NULL,
  state text NOT NULL CHECK (state IN ('RECOMMENDED','ACCEPTED','IN_PROGRESS','COMPLETED','DISMISSED','SUPERSEDED')),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  supersedes_action_id uuid REFERENCES roadmap_actions(id)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  email_enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  quiet_hours_start_minute integer NOT NULL DEFAULT 1320 CHECK (quiet_hours_start_minute BETWEEN 0 AND 1439),
  quiet_hours_end_minute integer NOT NULL DEFAULT 420 CHECK (quiet_hours_end_minute BETWEEN 0 AND 1439),
  daily_cap integer NOT NULL DEFAULT 3 CHECK (daily_cap BETWEEN 0 AND 20),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_templates (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  locale text NOT NULL DEFAULT 'en-IN',
  subject_template text NOT NULL,
  body_template text NOT NULL,
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL,
  CONSTRAINT notification_template_version_uq UNIQUE (stable_key, version, locale)
);

CREATE TABLE IF NOT EXISTS notification_commands (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  template_id uuid NOT NULL REFERENCES notification_templates(id),
  channel text NOT NULL CHECK (channel = 'EMAIL'),
  legal_purpose text NOT NULL,
  destination_ref text NOT NULL CHECK (destination_ref ~ '^[A-Za-z0-9._:-]{8,128}$'),
  render_parameters jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('PENDING','DISPATCHED','DELIVERED','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED','SUPERSEDED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  supersedes_command_id uuid REFERENCES notification_commands(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES notification_commands(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  provider_kind text NOT NULL CHECK (provider_kind IN ('MAILPIT','SES','N8N')),
  provider_reference text,
  outcome text NOT NULL CHECK (outcome IN ('ACCEPTED','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','EXPIRED')),
  failure_class text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_attempt_uq UNIQUE (command_id, attempt)
);

CREATE TABLE IF NOT EXISTS automation_workflow_registry (
  id uuid PRIMARY KEY,
  allowlist_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[0-9a-fA-F]{64}$'),
  operation text NOT NULL,
  destination_class text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT true,
  CONSTRAINT automation_workflow_version_uq UNIQUE (allowlist_id, version)
);

CREATE TABLE IF NOT EXISTS automation_commands (
  id uuid PRIMARY KEY,
  workflow_registry_id uuid NOT NULL REFERENCES automation_workflow_registry(id),
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  idempotency_id text NOT NULL UNIQUE,
  operation text NOT NULL,
  destination_class text NOT NULL,
  payload_ref text NOT NULL CHECK (payload_ref ~ '^[A-Za-z0-9._:-]{8,128}$'),
  state text NOT NULL CHECK (state IN ('PENDING','ACCEPTED','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','EXPIRED','CANCELLED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_callbacks (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES automation_commands(id),
  callback_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ACCEPTED','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','EXPIRED')),
  provider_reference text,
  audience text NOT NULL,
  issued_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institution_aggregate_reports (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  release_manifest_id uuid NOT NULL REFERENCES release_manifests(id),
  report_period_start date NOT NULL,
  report_period_end date NOT NULL,
  aggregate jsonb NOT NULL,
  artifact_ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_report_period_ck CHECK (report_period_end >= report_period_start)
);

CREATE OR REPLACE FUNCTION reject_immutable_row_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable record cannot be changed';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['source_packages','source_records','content_provenance','rights_reviews','quality_reviews','import_validation_results','canonical_id_mappings','content_review_actions','assessment_attempt_items','assessment_responses','evidence_records','mastery_projections','readiness_snapshots','readiness_factors','notification_commands','notification_delivery_attempts','automation_callbacks']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_immutable_guard ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change()', table_name, table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION protect_published_content_revision()
RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('PUBLISHED','ARCHIVED') THEN
    RAISE EXCEPTION 'published content revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_revisions_published_guard ON content_revisions;
CREATE TRIGGER content_revisions_published_guard BEFORE UPDATE OR DELETE ON content_revisions
FOR EACH ROW EXECUTE FUNCTION protect_published_content_revision();

CREATE OR REPLACE FUNCTION enforce_content_review_separation()
RETURNS trigger AS $$
DECLARE author_id uuid;
BEGIN
  SELECT author_user_id INTO author_id FROM content_revisions WHERE id = NEW.content_revision_id;
  IF NEW.action = 'APPROVE' AND NEW.actor_user_id = author_id THEN
    RAISE EXCEPTION 'author cannot approve own content revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_review_separation_guard ON content_review_actions;
CREATE TRIGGER content_review_separation_guard BEFORE INSERT ON content_review_actions
FOR EACH ROW EXECUTE FUNCTION enforce_content_review_separation();

CREATE OR REPLACE FUNCTION enforce_release_manifest_eligibility()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('APPROVED','PUBLISHED') THEN
    IF NOT EXISTS (SELECT 1 FROM release_manifest_items WHERE manifest_id = NEW.id) THEN
      RAISE EXCEPTION 'release manifest must contain items';
    END IF;
    IF EXISTS (
      SELECT 1 FROM release_manifest_items item
      JOIN source_records source ON source.id = item.source_record_id
      WHERE item.manifest_id = NEW.id AND NOT source.release_eligible
    ) THEN
      RAISE EXCEPTION 'release manifest contains ineligible source records';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS release_manifest_eligibility_guard ON release_manifests;
CREATE TRIGGER release_manifest_eligibility_guard BEFORE UPDATE ON release_manifests
FOR EACH ROW EXECUTE FUNCTION enforce_release_manifest_eligibility();

CREATE OR REPLACE FUNCTION enforce_lesson_prerequisite_dag()
RETURNS trigger AS $$
BEGIN
  IF NEW.lesson_version_id = NEW.prerequisite_lesson_version_id THEN
    RAISE EXCEPTION 'lesson cannot require itself';
  END IF;
  IF EXISTS (
    WITH RECURSIVE dependencies(id) AS (
      SELECT prerequisite_lesson_version_id FROM lesson_prerequisites WHERE lesson_version_id = NEW.prerequisite_lesson_version_id
      UNION
      SELECT edge.prerequisite_lesson_version_id
      FROM lesson_prerequisites edge JOIN dependencies current ON edge.lesson_version_id = current.id
    )
    SELECT 1 FROM dependencies WHERE id = NEW.lesson_version_id
  ) THEN
    RAISE EXCEPTION 'lesson prerequisite cycle detected';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lesson_prerequisite_dag_guard ON lesson_prerequisites;
CREATE TRIGGER lesson_prerequisite_dag_guard BEFORE INSERT OR UPDATE ON lesson_prerequisites
FOR EACH ROW EXECUTE FUNCTION enforce_lesson_prerequisite_dag();

CREATE OR REPLACE FUNCTION protect_submitted_attempt()
RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'SUBMITTED' THEN RAISE EXCEPTION 'submitted assessment attempts are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS assessment_attempt_submitted_guard ON assessment_attempts;
CREATE TRIGGER assessment_attempt_submitted_guard BEFORE UPDATE OR DELETE ON assessment_attempts
FOR EACH ROW EXECUTE FUNCTION protect_submitted_attempt();
