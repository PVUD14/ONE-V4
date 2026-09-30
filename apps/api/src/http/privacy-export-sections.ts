/**
 * The sections of the student's data export added by the coverage audit
 * (docs/architecture/privacy-export-coverage.md): account, records, hiring, college and learning
 * data that goals after OPS-06 stored without reaching the export.
 *
 * Kept apart from privacy-export.ts so each section's rules sit next to its query. The rules are
 * the export's own: the subject's rows only; organisations and roles, never another person; no
 * answer keys or reused question papers; bands, counts and dates the student sees, never the
 * engine's estimates; no internal identifiers — rows are joined on ids here and grouped in
 * memory, and the ids are not emitted.
 */
import { sql } from 'drizzle-orm';
import { evidenceSource } from './skill-evidence.js';

type Row = Record<string, unknown>;
type Query = (query: ReturnType<typeof sql>) => Promise<Row[]>;

const num = (value: unknown): number | null => (value == null ? null : Number(value));

export async function assembleCoverageSections(one: Query, subjectUserId: string): Promise<Record<string, unknown>> {
  const subject = sql`${subjectUserId}::uuid`;
  const [account, records, hiring, college, learning] = await Promise.all([
    accountSections(one, subject),
    recordSections(one, subject),
    hiringSections(one, subject),
    collegeSections(one, subject),
    learningSections(one, subject),
  ]);
  return { ...account, ...records, ...hiring, ...college, learning };
}

type Subject = ReturnType<typeof sql>;

async function accountSections(one: Query, subject: Subject): Promise<Record<string, unknown>> {
  const [consents, preferences, notifications, devices, invitations, supportCases] = await Promise.all([
    one(sql`SELECT c.consent_key, d.title, c.version, c.action, c.recorded_at
            FROM user_consents c
            LEFT JOIN consent_definitions d ON d.consent_key = c.consent_key AND d.version = c.version
            WHERE c.user_id = ${subject} ORDER BY c.recorded_at, c.id`),
    one(sql`SELECT email_enabled, timezone, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap, updated_at
            FROM notification_preferences WHERE user_id = ${subject}`),
    // The payload column holds internal references for deep links; the words the person saw are title and body.
    one(sql`SELECT kind, title, body, created_at, read_at FROM user_notifications WHERE user_id = ${subject} ORDER BY created_at, id`),
    // Never the token: it is a credential for the device.
    one(sql`SELECT platform, created_at, last_seen_at, revoked_at FROM device_push_tokens WHERE user_id = ${subject} ORDER BY created_at, id`),
    one(sql`SELECT org.legal_name AS organization_name, i.kind, i.state::text AS state, i.email, i.created_at, i.accepted_at, i.revoked_at
            FROM invitations i LEFT JOIN organizations org ON org.id = i.organization_id
            WHERE i.student_user_id = ${subject} OR i.accepted_by_user_id = ${subject}
            ORDER BY i.created_at, i.id`),
    // The service record; the summary an operator typed and the case notes are operations' working notes.
    one(sql`SELECT channel, category, state, opened_at, resolved_at, closed_at FROM support_cases
            WHERE subject_user_id = ${subject} ORDER BY opened_at, id`),
  ]);
  const preference = preferences[0];
  return {
    consents: consents.map((row) => ({ consentKey: row.consent_key, title: row.title ?? null, version: row.version, action: row.action, recordedAt: row.recorded_at })),
    notificationPreferences: preference ? {
      emailEnabled: preference.email_enabled, timezone: preference.timezone,
      quietHoursStartMinute: num(preference.quiet_hours_start_minute), quietHoursEndMinute: num(preference.quiet_hours_end_minute),
      dailyCap: num(preference.daily_cap), updatedAt: preference.updated_at,
    } : null,
    notifications: notifications.map((row) => ({ kind: row.kind, title: row.title, body: row.body, createdAt: row.created_at, readAt: row.read_at ?? null })),
    devices: devices.map((row) => ({ platform: row.platform, registeredAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at ?? null })),
    invitations: invitations.map((row) => ({
      organizationName: row.organization_name ?? null, kind: row.kind, state: row.state, sentTo: row.email,
      createdAt: row.created_at, acceptedAt: row.accepted_at ?? null, revokedAt: row.revoked_at ?? null,
    })),
    supportCases: supportCases.map((row) => ({
      channel: row.channel, category: row.category, state: row.state,
      openedAt: row.opened_at, resolvedAt: row.resolved_at ?? null, closedAt: row.closed_at ?? null,
    })),
  };
}

async function recordSections(one: Query, subject: Subject): Promise<Record<string, unknown>> {
  const [targets, gaps, gapItems, goals, outcomes, external, qualifications, terms, subjects, links, photos] = await Promise.all([
    one(sql`SELECT r.title, t.priority, t.selected_at, t.cleared_at
            FROM student_career_targets t JOIN career_roles r ON r.id = t.career_role_id
            WHERE t.student_user_id = ${subject} ORDER BY t.selected_at, t.id`),
    // Counts of the role's requirements met, unknown and in total: what the gap view shows, not a score.
    one(sql`SELECT g.id, r.title, g.requirements_total, g.requirements_met, g.requirements_unknown, g.computed_at, g.superseded_at
            FROM career_gap_snapshots g JOIN career_roles r ON r.id = g.career_role_id
            WHERE g.student_user_id = ${subject} ORDER BY g.computed_at, g.id`),
    // Each requirement's level and status as the gap view shows it; not the mastery values it compared.
    one(sql`SELECT i.snapshot_id, tn.name AS topic_name, i.requirement_level, i.status, i.priority_rank
            FROM career_gap_items i
            JOIN career_gap_snapshots g ON g.id = i.snapshot_id
            JOIN taxonomy_nodes tn ON tn.id = i.topic_id
            WHERE g.student_user_id = ${subject} ORDER BY i.priority_rank, i.id`),
    one(sql`SELECT g.goal_type, r.title AS role_title, tn.name AS topic_name, cg.title AS catalogue_goal, g.priority, g.status, g.origin,
                   g.discovery_interests, g.discovery_strengths, g.discovery_branch, org.legal_name AS institution_name, g.created_at, g.ended_at
            FROM learner_goals g
            LEFT JOIN student_career_targets t ON t.id = g.career_target_id
            LEFT JOIN career_roles r ON r.id = t.career_role_id
            LEFT JOIN taxonomy_nodes tn ON tn.id = g.topic_id
            LEFT JOIN career_catalogue_goals cg ON cg.code = g.catalogue_goal_code
            LEFT JOIN organizations org ON org.id = g.institution_id
            WHERE g.student_user_id = ${subject} ORDER BY g.created_at, g.id`),
    one(sql`SELECT org.legal_name AS institution_name, d.outcome, d.declared_at, d.withdrawn_at
            FROM student_outcome_declarations d JOIN organizations org ON org.id = d.institution_id
            WHERE d.student_user_id = ${subject} ORDER BY d.declared_at, d.id`),
    one(sql`SELECT company_name, role_title, source_kind, applied_on::text AS applied_on, application_url, stage, source, verification_state,
                   institution_visibility_granted_at, institution_visibility_revoked_at, created_at, updated_at
            FROM external_applications WHERE student_user_id = ${subject} ORDER BY created_at, id`),
    // Who verified a record is a staff member: the state and the time are the student's, the person is not.
    one(sql`SELECT q.id, coalesce(org.legal_name, q.institution_name_declared) AS institution_name, q.qualification_type, q.programme_name,
                   q.started_on::text AS started_on, q.completed_on::text AS completed_on, q.awarded, q.verification_state, q.verified_at
            FROM student_qualifications q LEFT JOIN organizations org ON org.id = q.institution_id
            WHERE q.student_user_id = ${subject} ORDER BY q.started_on NULLS LAST, q.created_at, q.id`),
    one(sql`SELECT t.id, t.qualification_id, t.sequence, t.label, t.result_value, t.result_scale, t.result_letter, t.backlog_count, t.source,
                   t.verification_state, t.verified_at
            FROM student_academic_terms t JOIN student_qualifications q ON q.id = t.qualification_id
            WHERE q.student_user_id = ${subject} ORDER BY t.sequence, t.id`),
    one(sql`SELECT s.term_id, s.subject_code, s.subject_name, s.credits, s.grade_value, s.grade_scale, s.grade_letter, s.passed
            FROM student_academic_subjects s
            JOIN student_academic_terms t ON t.id = s.term_id
            JOIN student_qualifications q ON q.id = t.qualification_id
            WHERE q.student_user_id = ${subject} ORDER BY s.subject_code NULLS LAST, s.subject_name, s.id`),
    // Never the token digest: with it, anyone could find the link.
    one(sql`SELECT cover_key, show_photo, show_headline, show_city, show_institution, show_education, show_self_reported, show_assessments,
                   show_learning, show_certificates, show_skills, show_portfolio, created_at, expires_at, revoked_at, last_viewed_at
            FROM public_profile_links WHERE student_user_id = ${subject} ORDER BY created_at, id`),
    one(sql`SELECT content_type, byte_size, uploaded_at FROM student_profile_photos WHERE student_user_id = ${subject}`),
  ]);
  const photo = photos[0];
  return {
    careerTargets: targets.map((row) => ({ roleTitle: row.title, priority: row.priority, selectedAt: row.selected_at, clearedAt: row.cleared_at ?? null })),
    careerGaps: gaps.map((row) => ({
      roleTitle: row.title, requirementsTotal: num(row.requirements_total), requirementsMet: num(row.requirements_met),
      requirementsUnknown: num(row.requirements_unknown), computedAt: row.computed_at, supersededAt: row.superseded_at ?? null,
      requirements: gapItems.filter((item) => item.snapshot_id === row.id).map((item) => ({
        topicName: item.topic_name, level: item.requirement_level, status: item.status, priorityRank: num(item.priority_rank),
      })),
    })),
    goals: goals.map((row) => ({
      goalType: row.goal_type, roleTitle: row.role_title ?? null, topicName: row.topic_name ?? null, catalogueGoal: row.catalogue_goal ?? null,
      priority: row.priority, status: row.status, origin: row.origin,
      discoveryInterests: row.discovery_interests ?? null, discoveryStrengths: row.discovery_strengths ?? null, discoveryBranch: row.discovery_branch ?? null,
      institutionName: row.institution_name ?? null, createdAt: row.created_at, endedAt: row.ended_at ?? null,
    })),
    outcomeDeclarations: outcomes.map((row) => ({ institutionName: row.institution_name, outcome: row.outcome, declaredAt: row.declared_at, withdrawnAt: row.withdrawn_at ?? null })),
    externalApplications: external.map((row) => ({
      companyName: row.company_name, roleTitle: row.role_title, sourceKind: row.source_kind, appliedOn: row.applied_on,
      applicationUrl: row.application_url ?? null, stage: row.stage, source: row.source, verificationState: row.verification_state,
      sharedWithCollegeAt: row.institution_visibility_granted_at ?? null, sharingStoppedAt: row.institution_visibility_revoked_at ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    academicRecords: qualifications.map((row) => ({
      institutionName: row.institution_name ?? null, qualificationType: row.qualification_type, programmeName: row.programme_name,
      startedOn: row.started_on ?? null, completedOn: row.completed_on ?? null, awarded: row.awarded,
      verificationState: row.verification_state, verifiedAt: row.verified_at ?? null,
      terms: terms.filter((term) => term.qualification_id === row.id).map((term) => ({
        sequence: num(term.sequence), label: term.label, resultValue: num(term.result_value), resultScale: term.result_scale ?? null,
        resultLetter: term.result_letter ?? null, backlogCount: num(term.backlog_count), source: term.source,
        verificationState: term.verification_state, verifiedAt: term.verified_at ?? null,
        subjects: subjects.filter((entry) => entry.term_id === term.id).map((entry) => ({
          subjectCode: entry.subject_code ?? null, subjectName: entry.subject_name, credits: num(entry.credits),
          gradeValue: num(entry.grade_value), gradeScale: entry.grade_scale ?? null, gradeLetter: entry.grade_letter ?? null, passed: entry.passed ?? null,
        })),
      })),
    })),
    publicProfile: {
      photo: photo ? { contentType: photo.content_type, byteSize: num(photo.byte_size), uploadedAt: photo.uploaded_at } : null,
      links: links.map((row) => ({
        cover: row.cover_key,
        shows: {
          photo: row.show_photo, headline: row.show_headline, city: row.show_city, institution: row.show_institution, education: row.show_education,
          selfReported: row.show_self_reported, assessments: row.show_assessments, learning: row.show_learning,
          certificates: row.show_certificates, skills: row.show_skills, portfolio: row.show_portfolio,
        },
        createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at ?? null, lastViewedAt: row.last_viewed_at ?? null,
      })),
    },
  };
}

async function hiringSections(one: Query, subject: Subject): Promise<Record<string, unknown>> {
  const [snapshots, history, termChanges, interviews, releases, reasons, grants, nominations, evidenceShares] = await Promise.all([
    // The snapshot is what they shared with the employer; it holds no internal identifier (EMP-07).
    one(sql`SELECT org.legal_name AS employer_name, v.title, s.created_at, s.snapshot, s.erased_at
            FROM application_profile_snapshots s
            JOIN applications a ON a.id = s.application_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            WHERE a.student_user_id = ${subject} ORDER BY s.created_at, s.id`),
    // The moves only: the note and reason code are what the employer wrote for its own team.
    one(sql`SELECT org.legal_name AS employer_name, v.title, h.from_state, h.to_state, h.occurred_at
            FROM application_state_history h
            JOIN applications a ON a.id = h.application_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            WHERE a.student_user_id = ${subject} ORDER BY h.occurred_at, h.id`),
    one(sql`SELECT org.legal_name AS employer_name, v.title, nv.title AS new_title, c.acknowledgement_required,
                   c.notified_at, c.acknowledged_at, c.declined_at, c.created_at
            FROM opportunity_term_change_acknowledgements c
            JOIN applications a ON a.id = c.application_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = c.from_version_id
            JOIN opportunity_versions nv ON nv.id = c.to_version_id
            WHERE a.student_user_id = ${subject} ORDER BY c.created_at, c.id`),
    // As the candidate sees each interview (EMP-08): the place and link only while it is ahead.
    one(sql`SELECT org.legal_name AS employer_name, v.title, i.round_number, st.label AS stage_label, i.mode, i.state,
                   i.scheduled_start, i.scheduled_end, i.location_detail, i.joining_link, i.preparation_note,
                   (i.state IN ('SCHEDULED', 'RESCHEDULED') AND a.closed_at IS NULL AND a.consent_revoked_at IS NULL
                     AND coalesce(i.scheduled_end, i.scheduled_start + interval '1 hour') > now()) AS upcoming
            FROM interviews i
            JOIN applications a ON a.id = i.application_id AND a.employer_id = i.employer_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            LEFT JOIN opportunity_selection_stages st ON st.id = i.selection_stage_id
            WHERE a.student_user_id = ${subject} AND a.state <> 'DRAFT'
            ORDER BY i.scheduled_start NULLS LAST, i.created_at, i.id`),
    one(sql`SELECT f.id, org.legal_name AS employer_name, v.title, f.note, f.released_at, f.superseded_at
            FROM application_feedback_releases f
            JOIN applications a ON a.id = f.application_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            WHERE a.student_user_id = ${subject} ORDER BY f.released_at, f.id`),
    one(sql`SELECT r.release_id, cr.student_label
            FROM application_feedback_release_reasons r
            JOIN candidate_feedback_reasons cr ON cr.code = r.reason_code
            JOIN application_feedback_releases f ON f.id = r.release_id
            JOIN applications a ON a.id = f.application_id
            WHERE a.student_user_id = ${subject} ORDER BY cr.sort_order, cr.code`),
    one(sql`SELECT org.legal_name AS employer_name, g.granted_at, g.expires_at, g.revoked_at
            FROM employer_applicant_access_grants g JOIN organizations org ON org.id = g.employer_id
            WHERE g.student_user_id = ${subject} ORDER BY g.granted_at, g.id`),
    // Who nominated them is a role at a college, as on their nominations screen; never the staff member.
    one(sql`SELECT inst.legal_name AS institution_name, emp.legal_name AS employer_name, v.title, n.nominated_by_role, n.reason_code, n.note,
                   n.state, n.created_at, n.responded_at, n.cancelled_at, n.cancel_reason_code
            FROM campus_drive_nominations n
            JOIN campus_drives cd ON cd.id = n.campus_drive_id
            JOIN organizations inst ON inst.id = n.institution_id
            JOIN organizations emp ON emp.id = cd.employer_id
            JOIN opportunities o ON o.id = n.opportunity_id
            LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
            WHERE n.student_user_id = ${subject} ORDER BY n.created_at, n.id`),
    // EMP-13: the evidence they chose to share with each employer, and when they took it back. The
    // topic's name stands in for the skill; no evidence identifier and no marks.
    one(sql`SELECT org.legal_name AS employer_name, v.title, t.name AS skill_name, e.evidence_type, e.source_aggregate_type, e.occurred_at, e.assisted,
                   sh.shared_via, sh.shared_at, sh.revoked_at, sh.revoked_reason
            FROM application_evidence_shares sh
            JOIN applications a ON a.id = sh.application_id
            JOIN organizations org ON org.id = a.employer_id
            JOIN opportunity_versions v ON v.id = a.applied_version_id
            JOIN evidence_records e ON e.id = sh.evidence_record_id
            JOIN taxonomy_nodes t ON t.id = e.topic_id
            WHERE sh.student_user_id = ${subject} ORDER BY sh.shared_at, sh.id`),
  ]);
  return {
    applicationSnapshots: snapshots.map((row) => ({ employerName: row.employer_name, title: row.title, sharedAt: row.created_at, snapshot: row.snapshot, erasedAt: row.erased_at ?? null })),
    applicationHistory: history.map((row) => ({ employerName: row.employer_name, title: row.title, fromState: row.from_state ?? null, toState: row.to_state, occurredAt: row.occurred_at })),
    jobTermChanges: termChanges.map((row) => ({
      employerName: row.employer_name, title: row.title, newTitle: row.new_title, acknowledgementRequired: row.acknowledgement_required,
      notifiedAt: row.notified_at ?? null, acknowledgedAt: row.acknowledged_at ?? null, declinedAt: row.declined_at ?? null, createdAt: row.created_at,
    })),
    interviews: interviews.map((row) => {
      const upcoming = row.upcoming === true;
      return {
        employerName: row.employer_name, title: row.title, roundNumber: num(row.round_number), stageLabel: row.stage_label ?? null,
        mode: row.mode, state: row.state, scheduledStart: row.scheduled_start ?? null, scheduledEnd: row.scheduled_end ?? null,
        locationDetail: upcoming ? row.location_detail ?? null : null, joiningLink: upcoming ? row.joining_link ?? null : null,
        preparationNote: row.state === 'CANCELLED' ? null : row.preparation_note ?? null,
      };
    }),
    feedbackReleased: releases.map((row) => ({
      employerName: row.employer_name, title: row.title, note: row.note ?? null, releasedAt: row.released_at, supersededAt: row.superseded_at ?? null,
      reasons: reasons.filter((reason) => reason.release_id === row.id).map((reason) => reason.student_label),
    })),
    evidenceShares: evidenceShares.map((row) => ({
      employerName: row.employer_name, title: row.title, skill: row.skill_name, type: row.evidence_type, source: evidenceSource(row.source_aggregate_type),
      recordedAt: row.occurred_at, unaided: row.assisted !== true, sharedVia: row.shared_via, sharedAt: row.shared_at,
      revokedAt: row.revoked_at ?? null, revokedReason: row.revoked_reason ?? null,
    })),
    employerAccess: grants.map((row) => ({ employerName: row.employer_name, grantedAt: row.granted_at, expiresAt: row.expires_at ?? null, revokedAt: row.revoked_at ?? null })),
    campusDriveNominations: nominations.map((row) => ({
      institutionName: row.institution_name, employerName: row.employer_name, title: row.title ?? null,
      nominatedByRole: row.nominated_by_role, reasonCode: row.reason_code, note: row.note ?? null, state: row.state,
      nominatedAt: row.created_at, respondedAt: row.responded_at ?? null, cancelledAt: row.cancelled_at ?? null, cancelReasonCode: row.cancel_reason_code ?? null,
    })),
  };
}

async function collegeSections(one: Query, subject: Subject): Promise<Record<string, unknown>> {
  const [shared, held, assignments, nextSteps, sessions, exams, attempts] = await Promise.all([
    // Counselling notes have their own section (INST-11); this is every other kind of college action.
    one(sql`SELECT org.legal_name AS institution_name, a.action_type, a.title, a.note, a.state, a.due_at, a.scheduled_start_at,
                   a.scheduled_end_at, a.created_at, a.resolved_at
            FROM staff_actions a JOIN organizations org ON org.id = a.institution_id
            WHERE a.subject_student_user_id = ${subject} AND a.visibility = 'SUBJECT_VISIBLE' AND a.action_type <> 'COUNSELLING_NOTE'
            ORDER BY a.created_at, a.id`),
    // What the college keeps to itself about them: how many, of which kind, never the text (as ADR-036).
    one(sql`SELECT org.legal_name AS institution_name, a.action_type, count(*)::int AS staff_only_actions
            FROM staff_actions a JOIN organizations org ON org.id = a.institution_id
            WHERE a.subject_student_user_id = ${subject} AND a.visibility = 'STAFF_ONLY' AND a.action_type <> 'COUNSELLING_NOTE'
            GROUP BY org.legal_name, a.action_type ORDER BY org.legal_name, a.action_type`),
    one(sql`SELECT org.legal_name AS institution_name, a.content_kind, lv.title AS lesson_title, tn.name AS skill_name, a.note, a.assigned_at, a.withdrawn_at
            FROM learning_assignment_students s
            JOIN learning_assignments a ON a.id = s.assignment_id
            JOIN organizations org ON org.id = a.institution_id
            JOIN taxonomy_nodes tn ON tn.id = a.skill_id
            LEFT JOIN lesson_versions lv ON lv.id = a.lesson_version_id
            WHERE s.student_user_id = ${subject} ORDER BY a.assigned_at, a.id`),
    one(sql`SELECT org.legal_name AS institution_name, o.action, o.content_kind, lv.title AS lesson_title, tn.name AS skill_name, o.reason_code, o.note,
                   o.state, o.created_at, o.applied_at, o.withdrawn_at, o.withdraw_reason_code
            FROM learning_plan_overrides o
            JOIN organizations org ON org.id = o.institution_id
            JOIN taxonomy_nodes tn ON tn.id = o.skill_id
            LEFT JOIN lesson_versions lv ON lv.id = o.lesson_version_id
            WHERE o.student_user_id = ${subject} ORDER BY o.created_at, o.id`),
    one(sql`SELECT org.legal_name AS institution_name, a.title, a.state, a.scheduled_start_at, a.scheduled_end_at, t.added_at
            FROM staff_action_attendees t
            JOIN staff_actions a ON a.id = t.staff_action_id
            JOIN organizations org ON org.id = a.institution_id
            WHERE t.student_user_id = ${subject} ORDER BY a.scheduled_start_at NULLS LAST, a.id`),
    one(sql`SELECT d.id AS definition_id, org.legal_name AS institution_name, d.title, s.name AS subject_name, d.exam_kind, d.starts_at, d.ends_at,
                   min(x.created_at) AS assigned_at
            FROM exam_definitions d
            JOIN exam_subjects s ON s.id = d.subject_id
            JOIN organizations org ON org.id = d.institution_id
            LEFT JOIN exam_assignments x ON x.definition_id = d.id AND x.student_user_id = ${subject}
            WHERE x.id IS NOT NULL OR EXISTS (SELECT 1 FROM exam_attempts t WHERE t.definition_id = d.id AND t.student_user_id = ${subject})
            GROUP BY d.id, org.legal_name, s.name ORDER BY min(x.created_at) NULLS LAST, d.starts_at, d.id`),
    // The result only once the college has published it; the paper and the answers are its secured material.
    one(sql`SELECT t.definition_id, t.attempt_number, t.status, t.started_at, t.submitted_at, t.auto_submitted, t.screen_shift_count,
                   r.score, r.max_score, r.percentage, r.correct_count, r.wrong_count, r.not_attempted_count, r.time_taken_seconds
            FROM exam_attempts t LEFT JOIN exam_results r ON r.attempt_id = t.id AND r.published
            WHERE t.student_user_id = ${subject} ORDER BY t.attempt_number, t.id`),
  ]);
  return {
    collegeActions: {
      shared: shared.map((row) => ({
        institutionName: row.institution_name, actionType: row.action_type, title: row.title, note: row.note ?? null, state: row.state,
        dueAt: row.due_at ?? null, scheduledStartAt: row.scheduled_start_at ?? null, scheduledEndAt: row.scheduled_end_at ?? null,
        createdAt: row.created_at, resolvedAt: row.resolved_at ?? null,
      })),
      heldByCollege: held.map((row) => ({ institutionName: row.institution_name, actionType: row.action_type, staffOnlyActions: num(row.staff_only_actions) })),
    },
    fromYourLecturers: {
      assignments: assignments.map((row) => ({
        institutionName: row.institution_name, kind: row.content_kind, title: row.lesson_title ?? row.skill_name, skillName: row.skill_name,
        note: row.note ?? null, assignedAt: row.assigned_at, withdrawnAt: row.withdrawn_at ?? null,
      })),
      nextSteps: nextSteps.map((row) => ({
        institutionName: row.institution_name, action: row.action, kind: row.content_kind, title: row.lesson_title ?? row.skill_name, skillName: row.skill_name,
        reasonCode: row.reason_code, note: row.note ?? null, state: row.state, createdAt: row.created_at,
        appliedAt: row.applied_at ?? null, withdrawnAt: row.withdrawn_at ?? null, withdrawReasonCode: row.withdraw_reason_code ?? null,
      })),
      sessions: sessions.map((row) => ({
        institutionName: row.institution_name, title: row.title, state: row.state,
        scheduledStartAt: row.scheduled_start_at ?? null, scheduledEndAt: row.scheduled_end_at ?? null, invitedAt: row.added_at,
      })),
    },
    collegeExams: exams.map((exam) => ({
      institutionName: exam.institution_name, examTitle: exam.title, subjectName: exam.subject_name, examKind: exam.exam_kind,
      opensAt: exam.starts_at, closesAt: exam.ends_at, assignedAt: exam.assigned_at ?? null,
      attempts: attempts.filter((attempt) => attempt.definition_id === exam.definition_id).map((attempt) => ({
        attemptNumber: num(attempt.attempt_number), status: attempt.status, startedAt: attempt.started_at, submittedAt: attempt.submitted_at ?? null,
        autoSubmitted: attempt.auto_submitted, focusLossCount: num(attempt.screen_shift_count),
        result: attempt.score == null ? null : {
          score: num(attempt.score), maxScore: num(attempt.max_score), percentage: num(attempt.percentage),
          correct: num(attempt.correct_count), wrong: num(attempt.wrong_count), notAttempted: num(attempt.not_attempted_count),
          timeTakenSeconds: num(attempt.time_taken_seconds),
        },
      })),
    })),
  };
}

async function learningSections(one: Query, subject: Subject): Promise<Record<string, unknown>> {
  const [sessions, attempts, activity, lessons, steps, stepItems, placements, skills, evidence, bands, readiness, roadmap, checks] = await Promise.all([
    // Model, prompt, token and cost columns are internal metering, not about the person.
    one(sql`SELECT mode, language, started_at, ended_at FROM learning_sessions WHERE subject_user_id = ${subject} ORDER BY started_at, id`),
    // Not the item or the option chosen: with correctness, those would be the answer key.
    one(sql`SELECT e.occurred_at, e.context, tn.name AS skill_name, e.answered, e.correct, e.assisted, e.highest_hint_level, e.response_time_ms
            FROM learning_attempt_events e LEFT JOIN taxonomy_nodes tn ON tn.id = e.skill_id
            WHERE e.subject_user_id = ${subject} ORDER BY e.occurred_at, e.id`),
    one(sql`SELECT event_type, occurred_at FROM learner_activity_events WHERE user_id = ${subject} ORDER BY occurred_at, id`),
    one(sql`SELECT lv.title, p.state, p.started_at, p.completed_at
            FROM learner_progress p JOIN lesson_versions lv ON lv.id = p.lesson_version_id
            WHERE p.subject_user_id = ${subject} ORDER BY coalesce(p.started_at, p.updated_at), p.id`),
    // What the planner chose and why, not the inputs it weighed (its working estimates).
    one(sql`SELECT d.id, d.decided_at, d.action, tn.name AS skill_name, d.reason_codes, d.adaptive
            FROM learning_decisions d LEFT JOIN taxonomy_nodes tn ON tn.id = d.skill_id
            WHERE d.subject_user_id = ${subject} ORDER BY d.decided_at, d.id`),
    one(sql`SELECT i.decision_id, i.position, tn.name AS skill_name, i.hint_level, i.served_at
            FROM learning_step_items i JOIN taxonomy_nodes tn ON tn.id = i.skill_id
            WHERE i.subject_user_id = ${subject} ORDER BY i.position, i.id`),
    // The level the sitting ended on, as shown to them; the calibrated items served are model parameters.
    one(sql`SELECT scope, state, started_at, deadline_at, completed_at, placement_level, items_answered, stop_reason
            FROM placement_tests WHERE subject_user_id = ${subject} ORDER BY started_at, id`),
    // Counts, stage, band and the next review date; never mastery likelihood, uncertainty or scheduler parameters.
    one(sql`SELECT tn.name AS skill_name, s.attempt_count, s.attempt_day_count, s.unaided_success_count, s.unaided_success_day_count,
                   s.assisted_success_count, s.last_attempt_at, s.evidence_stage, s.evidence_band, s.review_due_at
            FROM learner_skill_state s JOIN taxonomy_nodes tn ON tn.id = s.skill_id
            WHERE s.subject_user_id = ${subject} ORDER BY tn.name, s.skill_id`),
    one(sql`SELECT e.evidence_type, tn.name AS topic_name, e.demonstrated, e.possible, e.assisted, e.stage_at_capture, e.occurred_at, e.correction_reason_code
            FROM evidence_records e JOIN taxonomy_nodes tn ON tn.id = e.topic_id
            WHERE e.subject_user_id = ${subject} ORDER BY e.occurred_at, e.id`),
    one(sql`SELECT tn.name AS topic_name, m.band, m.generated_at
            FROM mastery_projections m JOIN taxonomy_nodes tn ON tn.id = m.topic_id
            WHERE m.subject_user_id = ${subject} ORDER BY m.generated_at, m.id`),
    // Readiness is an advisory band (ADR-020): the band and when, nothing numeric.
    one(sql`SELECT band, generated_at FROM readiness_snapshots WHERE subject_user_id = ${subject} ORDER BY generated_at, id`),
    one(sql`SELECT r.action_code, tn.name AS topic_name, r.reason_code, r.state, r.due_at, r.created_at, r.completed_at
            FROM roadmap_actions r JOIN taxonomy_nodes tn ON tn.id = r.topic_id
            WHERE r.subject_user_id = ${subject} ORDER BY r.created_at, r.id`),
    // The score the student is shown on submitting; the items and responses stay with the reused check.
    one(sql`SELECT d.title, t.state, t.started_at, t.expires_at, t.submitted_at, t.score_correct, t.score_possible
            FROM assessment_attempts t
            JOIN assessment_assignments x ON x.id = t.assignment_id
            JOIN assessment_definitions d ON d.id = x.assessment_definition_id
            WHERE t.subject_user_id = ${subject} ORDER BY t.started_at, t.id`),
  ]);
  return {
    sessions: sessions.map((row) => ({ mode: row.mode, language: row.language ?? null, startedAt: row.started_at, endedAt: row.ended_at ?? null })),
    attempts: attempts.map((row) => ({
      occurredAt: row.occurred_at, context: row.context, skillName: row.skill_name ?? null, answered: row.answered, correct: row.correct,
      assisted: row.assisted, highestHintLevel: num(row.highest_hint_level), responseTimeMs: num(row.response_time_ms),
    })),
    activity: activity.map((row) => ({ eventType: row.event_type, occurredAt: row.occurred_at })),
    lessons: lessons.map((row) => ({ lessonTitle: row.title, state: row.state, startedAt: row.started_at ?? null, completedAt: row.completed_at ?? null })),
    steps: steps.map((row) => ({
      decidedAt: row.decided_at, action: row.action, skillName: row.skill_name ?? null, reasonCodes: row.reason_codes, adaptive: row.adaptive,
      items: stepItems.filter((item) => item.decision_id === row.id).map((item) => ({
        position: num(item.position), skillName: item.skill_name, highestHintShown: num(item.hint_level), servedAt: item.served_at,
      })),
    })),
    placementTests: placements.map((row) => ({
      scope: row.scope, state: row.state, startedAt: row.started_at, deadlineAt: row.deadline_at, completedAt: row.completed_at ?? null,
      placementLevel: row.placement_level ?? null, itemsAnswered: num(row.items_answered), stopReason: row.stop_reason ?? null,
    })),
    skills: skills.map((row) => ({
      skillName: row.skill_name, attemptCount: num(row.attempt_count), attemptDayCount: num(row.attempt_day_count),
      unaidedSuccessCount: num(row.unaided_success_count), unaidedSuccessDayCount: num(row.unaided_success_day_count),
      assistedSuccessCount: num(row.assisted_success_count), lastAttemptAt: row.last_attempt_at ?? null,
      evidenceStage: row.evidence_stage, evidenceBand: row.evidence_band, reviewDueAt: row.review_due_at ?? null,
    })),
    evidence: evidence.map((row) => ({
      evidenceType: row.evidence_type, topicName: row.topic_name, demonstrated: num(row.demonstrated), possible: num(row.possible),
      assisted: row.assisted, stageAtCapture: row.stage_at_capture, occurredAt: row.occurred_at, correctionReasonCode: row.correction_reason_code ?? null,
    })),
    topicBands: bands.map((row) => ({ topicName: row.topic_name, band: row.band, generatedAt: row.generated_at })),
    readiness: readiness.map((row) => ({ band: row.band, generatedAt: row.generated_at })),
    roadmap: roadmap.map((row) => ({
      actionCode: row.action_code, topicName: row.topic_name, reasonCode: row.reason_code, state: row.state,
      dueAt: row.due_at ?? null, createdAt: row.created_at, completedAt: row.completed_at ?? null,
    })),
    readinessChecks: checks.map((row) => ({
      title: row.title, state: row.state, startedAt: row.started_at, expiresAt: row.expires_at, submittedAt: row.submitted_at ?? null,
      scoreCorrect: num(row.score_correct), scorePossible: num(row.score_possible),
    })),
  };
}
