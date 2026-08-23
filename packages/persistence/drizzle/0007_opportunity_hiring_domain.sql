-- Opportunity / Application / Interview / Offer domain.
--
-- Structural rules enforced here rather than only in application code:
--   * material opportunity terms are immutable once published; changes create a new
--     version, and applicants are bound to the version they applied to;
--   * an application, interview and offer can never drift to a different employer
--     than the opportunity they belong to (composite foreign keys);
--   * employer visibility of a student is consent-scoped and revocable;
--   * state changes are append-only history, never in-place edits.
--
-- No rows are seeded. These tables are created empty.

-- ---------------------------------------------------------------------------
-- Opportunity (stable identity; material terms live in versions)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  reference_code text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'DRAFT',
  current_version_id uuid,
  published_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_reference_code_ck CHECK (length(reference_code) BETWEEN 1 AND 64 AND reference_code !~ '^[=+@-]'),
  CONSTRAINT opportunities_lifecycle_ck CHECK (lifecycle_state IN ('DRAFT','PENDING_REVIEW','PUBLISHED','PAUSED','CLOSED','WITHDRAWN','ARCHIVED')),
  CONSTRAINT opportunities_published_state_ck CHECK ((lifecycle_state IN ('DRAFT','PENDING_REVIEW') AND published_at IS NULL) OR (lifecycle_state NOT IN ('DRAFT','PENDING_REVIEW'))),
  CONSTRAINT opportunities_published_requires_version_ck CHECK (lifecycle_state IN ('DRAFT','PENDING_REVIEW') OR current_version_id IS NOT NULL),
  CONSTRAINT opportunities_closed_after_published_ck CHECK (closed_at IS NULL OR published_at IS NULL OR closed_at >= published_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_employer_reference_uq ON opportunities(employer_id, lower(reference_code));
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_id_employer_uq ON opportunities(id, employer_id);
CREATE INDEX IF NOT EXISTS opportunities_employer_state_idx ON opportunities(employer_id, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_published_idx ON opportunities(lifecycle_state, published_at DESC) WHERE lifecycle_state = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Opportunity versions: the immutable record of material terms
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunity_versions (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  version_number integer NOT NULL,
  title text NOT NULL,
  summary text,
  responsibilities text,
  employment_type text NOT NULL,
  work_mode text NOT NULL,
  location_city text,
  location_region text,
  location_country text,
  positions_available integer,
  duration_months integer,
  compensation_disclosed boolean NOT NULL DEFAULT false,
  compensation_currency text,
  compensation_min numeric(12,2),
  compensation_max numeric(12,2),
  compensation_period text,
  joining_conditions text,
  application_deadline timestamptz,
  material_terms_hash text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_versions_number_ck CHECK (version_number >= 1),
  CONSTRAINT opportunity_versions_title_ck CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '^[=+@-]'),
  CONSTRAINT opportunity_versions_summary_ck CHECK (summary IS NULL OR length(summary) <= 2000),
  CONSTRAINT opportunity_versions_responsibilities_ck CHECK (responsibilities IS NULL OR length(responsibilities) <= 8000),
  CONSTRAINT opportunity_versions_employment_type_ck CHECK (employment_type IN ('INTERNSHIP','FULL_TIME','PART_TIME','APPRENTICESHIP','CONTRACT')),
  CONSTRAINT opportunity_versions_work_mode_ck CHECK (work_mode IN ('ONSITE','HYBRID','REMOTE')),
  CONSTRAINT opportunity_versions_location_ck CHECK (work_mode = 'REMOTE' OR location_city IS NOT NULL),
  CONSTRAINT opportunity_versions_positions_ck CHECK (positions_available IS NULL OR positions_available >= 1),
  CONSTRAINT opportunity_versions_duration_ck CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 120),
  CONSTRAINT opportunity_versions_currency_ck CHECK (compensation_currency IS NULL OR compensation_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT opportunity_versions_period_ck CHECK (compensation_period IS NULL OR compensation_period IN ('HOUR','MONTH','YEAR','TOTAL_STIPEND')),
  CONSTRAINT opportunity_versions_amount_ck CHECK ((compensation_min IS NULL OR compensation_min >= 0) AND (compensation_max IS NULL OR compensation_max >= 0) AND (compensation_min IS NULL OR compensation_max IS NULL OR compensation_max >= compensation_min)),
  -- Disclosed compensation must actually state an amount, a currency and a period.
  CONSTRAINT opportunity_versions_disclosure_ck CHECK (compensation_disclosed = false OR (compensation_currency IS NOT NULL AND compensation_period IS NOT NULL AND compensation_min IS NOT NULL)),
  CONSTRAINT opportunity_versions_joining_ck CHECK (joining_conditions IS NULL OR length(joining_conditions) <= 2000),
  CONSTRAINT opportunity_versions_hash_ck CHECK (length(material_terms_hash) = 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_versions_number_uq ON opportunity_versions(opportunity_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_versions_id_opportunity_uq ON opportunity_versions(id, opportunity_id);
CREATE INDEX IF NOT EXISTS opportunity_versions_opportunity_idx ON opportunity_versions(opportunity_id, version_number DESC);

-- The pointer to the live version is added after the versions table exists.
ALTER TABLE opportunities
  DROP CONSTRAINT IF EXISTS opportunities_current_version_fk;
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_current_version_fk
  FOREIGN KEY (current_version_id, id) REFERENCES opportunity_versions(id, opportunity_id);

-- ---------------------------------------------------------------------------
-- Version-scoped detail: skills, selection stages, eligibility
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunity_skill_requirements (
  id uuid PRIMARY KEY,
  opportunity_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  skill_name text NOT NULL,
  requirement_level text NOT NULL,
  CONSTRAINT opportunity_skill_name_ck CHECK (length(skill_name) BETWEEN 1 AND 120 AND skill_name !~ '^[=+@-]'),
  CONSTRAINT opportunity_skill_level_ck CHECK (requirement_level IN ('REQUIRED','PREFERRED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_skill_version_name_uq ON opportunity_skill_requirements(opportunity_version_id, lower(skill_name));

CREATE TABLE IF NOT EXISTS opportunity_selection_stages (
  id uuid PRIMARY KEY,
  opportunity_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  stage_order integer NOT NULL,
  stage_kind text NOT NULL,
  label text NOT NULL,
  detail text,
  CONSTRAINT opportunity_stage_order_ck CHECK (stage_order >= 1),
  CONSTRAINT opportunity_stage_kind_ck CHECK (stage_kind IN ('SCREENING','ASSESSMENT','INTERVIEW','GROUP_DISCUSSION','OFFER')),
  CONSTRAINT opportunity_stage_label_ck CHECK (length(label) BETWEEN 1 AND 120 AND label !~ '^[=+@-]'),
  CONSTRAINT opportunity_stage_detail_ck CHECK (detail IS NULL OR length(detail) <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_stage_order_uq ON opportunity_selection_stages(opportunity_version_id, stage_order);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_stage_id_version_uq ON opportunity_selection_stages(id, opportunity_version_id);

CREATE TABLE IF NOT EXISTS opportunity_eligibility_rules (
  id uuid PRIMARY KEY,
  opportunity_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  rule_type text NOT NULL,
  comparator text NOT NULL,
  value_numeric numeric(10,2),
  value_text text,
  is_blocking boolean NOT NULL DEFAULT true,
  CONSTRAINT opportunity_eligibility_type_ck CHECK (rule_type IN ('MIN_CGPA','MAX_BACKLOGS','GRADUATION_YEAR','DEPARTMENT','PROGRAM','INSTITUTION','WORK_AUTHORIZATION','CUSTOM')),
  CONSTRAINT opportunity_eligibility_comparator_ck CHECK (comparator IN ('GTE','LTE','EQ','IN','NOT_IN')),
  CONSTRAINT opportunity_eligibility_value_ck CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL),
  CONSTRAINT opportunity_eligibility_text_ck CHECK (value_text IS NULL OR length(value_text) <= 500)
);
CREATE INDEX IF NOT EXISTS opportunity_eligibility_version_idx ON opportunity_eligibility_rules(opportunity_version_id);

-- ---------------------------------------------------------------------------
-- Audience / visibility targeting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunity_audiences (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  audience_kind text NOT NULL,
  institution_id uuid REFERENCES organizations(id),
  institution_unit_id uuid REFERENCES institution_units(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_audience_kind_ck CHECK (audience_kind IN ('PUBLIC','INSTITUTION','INSTITUTION_UNIT','INVITE_ONLY')),
  CONSTRAINT opportunity_audience_scope_ck CHECK (
    (audience_kind IN ('PUBLIC','INVITE_ONLY') AND institution_id IS NULL AND institution_unit_id IS NULL)
    OR (audience_kind = 'INSTITUTION' AND institution_id IS NOT NULL AND institution_unit_id IS NULL)
    OR (audience_kind = 'INSTITUTION_UNIT' AND institution_id IS NOT NULL AND institution_unit_id IS NOT NULL)
  ),
  CONSTRAINT opportunity_audience_unit_same_institution_fk FOREIGN KEY (institution_unit_id, institution_id) REFERENCES institution_units(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_audience_scope_uq
  ON opportunity_audiences(opportunity_id, audience_kind, coalesce(institution_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(institution_unit_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS opportunity_audience_institution_idx ON opportunity_audiences(institution_id, opportunity_id);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS applications (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  applied_version_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'DRAFT',
  consent_granted_at timestamptz,
  consent_revoked_at timestamptz,
  submitted_at timestamptz,
  closed_at timestamptz,
  withdrawn_reason text,
  rejection_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_state_ck CHECK (state IN ('DRAFT','APPLIED','SCREENING','SHORTLISTED','ASSESSMENT','INTERVIEW','OFFER','HIRED','REJECTED','WITHDRAWN')),
  -- A submitted application must carry explicit consent; a draft must not.
  CONSTRAINT applications_submitted_consent_ck CHECK ((state = 'DRAFT' AND submitted_at IS NULL) OR (state <> 'DRAFT' AND submitted_at IS NOT NULL AND consent_granted_at IS NOT NULL)),
  CONSTRAINT applications_consent_order_ck CHECK (consent_revoked_at IS NULL OR (consent_granted_at IS NOT NULL AND consent_revoked_at >= consent_granted_at)),
  CONSTRAINT applications_terminal_closed_ck CHECK ((state IN ('HIRED','REJECTED','WITHDRAWN') AND closed_at IS NOT NULL) OR (state NOT IN ('HIRED','REJECTED','WITHDRAWN') AND closed_at IS NULL)),
  CONSTRAINT applications_withdrawn_reason_ck CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 1000),
  CONSTRAINT applications_rejection_code_ck CHECK (rejection_reason_code IS NULL OR length(rejection_reason_code) <= 64),
  -- An application can never point at an opportunity belonging to another employer.
  CONSTRAINT applications_opportunity_employer_fk FOREIGN KEY (opportunity_id, employer_id) REFERENCES opportunities(id, employer_id),
  -- The version applied to must belong to the same opportunity.
  CONSTRAINT applications_version_opportunity_fk FOREIGN KEY (applied_version_id, opportunity_id) REFERENCES opportunity_versions(id, opportunity_id)
);
-- One live application per student per opportunity; withdrawn/closed ones may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS applications_open_student_opportunity_uq
  ON applications(opportunity_id, student_user_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS applications_id_employer_uq ON applications(id, employer_id);
CREATE UNIQUE INDEX IF NOT EXISTS applications_id_opportunity_uq ON applications(id, opportunity_id);
CREATE UNIQUE INDEX IF NOT EXISTS applications_id_student_uq ON applications(id, student_user_id);
CREATE INDEX IF NOT EXISTS applications_employer_state_idx ON applications(employer_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS applications_student_idx ON applications(student_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS applications_opportunity_state_idx ON applications(opportunity_id, state);

-- Frozen view of the applicant at submission time. Immutable by policy.
CREATE TABLE IF NOT EXISTS application_profile_snapshots (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  resume_document_id uuid REFERENCES student_document_metadata(id),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_snapshot_hash_ck CHECK (length(snapshot_hash) = 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS application_profile_snapshot_application_uq ON application_profile_snapshots(application_id);

-- Append-only state transitions.
CREATE TABLE IF NOT EXISTS application_state_history (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  from_state text,
  to_state text NOT NULL,
  changed_by_user_id uuid REFERENCES users(id),
  actor_role text,
  reason_code text,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_history_states_ck CHECK (to_state IN ('DRAFT','APPLIED','SCREENING','SHORTLISTED','ASSESSMENT','INTERVIEW','OFFER','HIRED','REJECTED','WITHDRAWN')),
  CONSTRAINT application_history_from_ck CHECK (from_state IS NULL OR from_state IN ('DRAFT','APPLIED','SCREENING','SHORTLISTED','ASSESSMENT','INTERVIEW','OFFER','HIRED','REJECTED','WITHDRAWN')),
  CONSTRAINT application_history_note_ck CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT application_history_reason_ck CHECK (reason_code IS NULL OR length(reason_code) <= 64)
);
CREATE INDEX IF NOT EXISTS application_state_history_application_idx ON application_state_history(application_id, occurred_at DESC);

-- When an employer changes material terms after people have applied.
CREATE TABLE IF NOT EXISTS opportunity_term_change_acknowledgements (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  from_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  to_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  acknowledgement_required boolean NOT NULL DEFAULT true,
  notified_at timestamptz,
  acknowledged_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_term_change_versions_ck CHECK (from_version_id <> to_version_id),
  CONSTRAINT opportunity_term_change_outcome_ck CHECK (acknowledged_at IS NULL OR declined_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_term_change_application_versions_uq
  ON opportunity_term_change_acknowledgements(application_id, from_version_id, to_version_id);
CREATE INDEX IF NOT EXISTS opportunity_term_change_pending_idx
  ON opportunity_term_change_acknowledgements(application_id) WHERE acknowledged_at IS NULL AND declined_at IS NULL;

-- ---------------------------------------------------------------------------
-- Interviews
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interviews (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  selection_stage_id uuid REFERENCES opportunity_selection_stages(id),
  round_number integer NOT NULL DEFAULT 1,
  mode text NOT NULL,
  state text NOT NULL DEFAULT 'SCHEDULED',
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  location_detail text,
  joining_link text,
  cancellation_reason text,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interviews_round_ck CHECK (round_number >= 1),
  CONSTRAINT interviews_mode_ck CHECK (mode IN ('ONSITE','VIDEO','PHONE')),
  CONSTRAINT interviews_state_ck CHECK (state IN ('SCHEDULED','RESCHEDULED','COMPLETED','CANCELLED','NO_SHOW')),
  CONSTRAINT interviews_window_ck CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start),
  CONSTRAINT interviews_scheduled_requires_start_ck CHECK (state = 'CANCELLED' OR scheduled_start IS NOT NULL),
  CONSTRAINT interviews_onsite_location_ck CHECK (mode <> 'ONSITE' OR location_detail IS NOT NULL),
  CONSTRAINT interviews_link_ck CHECK (joining_link IS NULL OR (length(joining_link) <= 512 AND joining_link ~* '^https://[^[:space:]]+$')),
  CONSTRAINT interviews_location_ck CHECK (location_detail IS NULL OR length(location_detail) <= 500),
  CONSTRAINT interviews_cancellation_ck CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 1000),
  -- An interview can never be attached to an application owned by another employer.
  CONSTRAINT interviews_application_employer_fk FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS interviews_application_round_uq ON interviews(application_id, round_number);
CREATE UNIQUE INDEX IF NOT EXISTS interviews_id_employer_uq ON interviews(id, employer_id);
CREATE INDEX IF NOT EXISTS interviews_employer_schedule_idx ON interviews(employer_id, scheduled_start);
CREATE INDEX IF NOT EXISTS interviews_application_idx ON interviews(application_id, round_number DESC);

CREATE TABLE IF NOT EXISTS interview_participants (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews(id),
  participant_user_id uuid NOT NULL REFERENCES users(id),
  participant_role text NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT interview_participant_role_ck CHECK (participant_role IN ('INTERVIEWER','HIRING_MANAGER','OBSERVER','COORDINATOR'))
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_participant_active_uq
  ON interview_participants(interview_id, participant_user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS interview_participant_user_idx ON interview_participants(participant_user_id, interview_id);

CREATE TABLE IF NOT EXISTS interview_outcomes (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews(id),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  recommendation text NOT NULL,
  overall_rating integer,
  strengths text,
  concerns text,
  notes text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_outcome_recommendation_ck CHECK (recommendation IN ('STRONG_YES','YES','NEUTRAL','NO','STRONG_NO')),
  CONSTRAINT interview_outcome_rating_ck CHECK (overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
  CONSTRAINT interview_outcome_strengths_ck CHECK (strengths IS NULL OR length(strengths) <= 2000),
  CONSTRAINT interview_outcome_concerns_ck CHECK (concerns IS NULL OR length(concerns) <= 2000),
  CONSTRAINT interview_outcome_notes_ck CHECK (notes IS NULL OR length(notes) <= 4000)
);
-- One scorecard per interviewer per interview.
CREATE UNIQUE INDEX IF NOT EXISTS interview_outcome_interviewer_uq ON interview_outcomes(interview_id, submitted_by_user_id);

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  compensation_currency text,
  compensation_amount numeric(12,2),
  compensation_period text,
  joining_date date,
  offer_expires_at timestamptz,
  conditions text,
  decline_reason text,
  extended_at timestamptz,
  responded_at timestamptz,
  withdrawn_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_state_ck CHECK (state IN ('DRAFT','EXTENDED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED')),
  CONSTRAINT offers_currency_ck CHECK (compensation_currency IS NULL OR compensation_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT offers_period_ck CHECK (compensation_period IS NULL OR compensation_period IN ('HOUR','MONTH','YEAR','TOTAL_STIPEND')),
  CONSTRAINT offers_amount_ck CHECK (compensation_amount IS NULL OR compensation_amount >= 0),
  -- An extended offer must state what is being offered and when it lapses.
  CONSTRAINT offers_extended_terms_ck CHECK (state = 'DRAFT' OR (extended_at IS NOT NULL AND compensation_amount IS NOT NULL AND compensation_currency IS NOT NULL AND offer_expires_at IS NOT NULL)),
  CONSTRAINT offers_response_ck CHECK ((state IN ('ACCEPTED','DECLINED') AND responded_at IS NOT NULL) OR (state NOT IN ('ACCEPTED','DECLINED') AND responded_at IS NULL)),
  CONSTRAINT offers_withdrawn_ck CHECK ((state = 'WITHDRAWN' AND withdrawn_at IS NOT NULL) OR (state <> 'WITHDRAWN' AND withdrawn_at IS NULL)),
  CONSTRAINT offers_decline_reason_ck CHECK (decline_reason IS NULL OR length(decline_reason) <= 1000),
  CONSTRAINT offers_conditions_ck CHECK (conditions IS NULL OR length(conditions) <= 4000),
  CONSTRAINT offers_application_employer_fk FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id)
);
-- Only one live offer per application at a time.
CREATE UNIQUE INDEX IF NOT EXISTS offers_active_application_uq
  ON offers(application_id) WHERE state IN ('DRAFT','EXTENDED','ACCEPTED');
CREATE INDEX IF NOT EXISTS offers_employer_state_idx ON offers(employer_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS offers_expiry_idx ON offers(state, offer_expires_at) WHERE state = 'EXTENDED';
