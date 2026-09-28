/**
 * Job requirements and eligibility, the database half (EMP-06).
 *
 * packages/hiring decides (eligibility.ts, opportunity-requirements.ts); this module reads and
 * writes what those rules need: a version's eligibility rules, skills and stages (written only
 * into a new version — EMP-05's versioning path — and carried forward when an edit leaves them
 * alone), the student's academic records the evaluator resolves against, the catalogue checks
 * for skills and roles (OPS-08), and the frozen evaluation row an employer sees
 * (docs/architecture/application-eligibility-evaluations-table-design.md).
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import type { EligibilityRule } from '@planthepath/hiring';
import {
  ELIGIBILITY_EVALUATOR_VERSION,
  employerOutcome,
  type AcademicQualificationRecord,
  type EligibilityEvaluation,
  type EligibilityRecords,
} from '@planthepath/hiring/src/eligibility.js';
import {
  RequirementInputError,
  STAGE_APPLICATION_STATE,
  opportunityVersionReasonCodes,
  parseEligibilityRules,
  parseSelectionStages,
  parseSkillRequirements,
  type SelectionStageInput,
  type SelectionStageKind,
  type SkillRequirementInput,
} from '@planthepath/hiring/src/opportunity-requirements.js';
import type { ApiIdGenerator } from './api-security.js';

type QueryResult<T> = { rows: T[] };
type Executor = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The requirement fields a version body may carry, beside the version's terms. */
export const opportunityRequirementFields = ['eligibilityRules', 'skills', 'stages', 'careerRoleId', 'reasonCode'] as const;

export interface OpportunityRequirementsInput {
  /** Undefined: carry the previous version's forward unchanged. */
  readonly eligibilityRules: readonly EligibilityRule[] | undefined;
  readonly skills: readonly SkillRequirementInput[] | undefined;
  readonly stages: readonly SelectionStageInput[] | undefined;
  /** Undefined: carry forward; null: no catalogue role. */
  readonly careerRoleId: string | null | undefined;
  readonly reasonCode: string | null;
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}

/** Parse the optional requirement fields of a version body. Unknown fields are refused by the caller. */
export function readOpportunityRequirementsInput(body: unknown, correlationId: string): OpportunityRequirementsInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const parse = <T>(key: string, parser: (value: unknown) => T): T | undefined => {
    if (record[key] === undefined) return undefined;
    try {
      return parser(record[key]);
    } catch (error) {
      if (error instanceof RequirementInputError) throw badRequest(error.code, correlationId);
      throw error;
    }
  };
  const careerRoleId = record.careerRoleId;
  if (careerRoleId !== undefined && careerRoleId !== null && (typeof careerRoleId !== 'string' || !uuidPattern.test(careerRoleId))) {
    throw badRequest('INVALID_CAREERROLEID', correlationId);
  }
  const reasonCode = record.reasonCode;
  if (reasonCode !== undefined && reasonCode !== null && (typeof reasonCode !== 'string' || !(opportunityVersionReasonCodes as readonly string[]).includes(reasonCode))) {
    throw badRequest('INVALID_REASONCODE', correlationId);
  }
  return {
    eligibilityRules: parse('eligibilityRules', parseEligibilityRules),
    skills: parse('skills', parseSkillRequirements),
    stages: parse('stages', parseSelectionStages),
    careerRoleId: careerRoleId === undefined ? undefined : (careerRoleId as string | null)?.toLowerCase() ?? null,
    reasonCode: typeof reasonCode === 'string' ? reasonCode : null,
  };
}

/**
 * Write a new version's skills, stages, eligibility rules and catalogue role: the ones the body
 * gave, or the previous version's carried forward. Runs inside the version transaction; the new
 * version row is not yet visible to anyone else, so setting its role here is not an edit of a
 * published version.
 */
export async function writeVersionRequirements(tx: Executor, input: {
  readonly versionId: string; readonly previousVersionId: string; readonly requirements: OpportunityRequirementsInput; readonly correlationId: string;
}): Promise<void> {
  const { versionId, previousVersionId, requirements, correlationId } = input;

  if (requirements.skills === undefined) {
    await tx.execute(sql`
      INSERT INTO opportunity_skill_requirements (id, opportunity_version_id, skill_name, requirement_level, taxonomy_topic_id)
      SELECT gen_random_uuid(), ${versionId}::uuid, skill_name, requirement_level, taxonomy_topic_id FROM opportunity_skill_requirements WHERE opportunity_version_id = ${previousVersionId}::uuid
    `);
  } else if (requirements.skills.length) {
    const topicIds = requirements.skills.map((skill) => skill.taxonomyTopicId).filter((id): id is string => id !== null);
    const topicNames = new Map<string, string>();
    if (topicIds.length) {
      // A catalogue skill is a topic a published career-role requirement names (OPS-08).
      const topics = await tx.execute(sql`
        SELECT n.id, n.name FROM taxonomy_nodes n
        WHERE n.id IN (${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND n.active
          AND EXISTS (SELECT 1 FROM career_role_requirements r JOIN career_roles cr ON cr.id = r.career_role_id AND cr.active WHERE r.topic_id = n.id)
      `) as QueryResult<{ id: string; name: string }>;
      for (const row of topics.rows) topicNames.set(row.id, row.name.trim().slice(0, 120));
      if (topicNames.size !== topicIds.length) throw badRequest('UNKNOWN_CATALOGUE_SKILL', correlationId);
    }
    const rows = requirements.skills.map((skill) => ({ ...skill, resolvedName: skill.taxonomyTopicId ? topicNames.get(skill.taxonomyTopicId)! : skill.name! }));
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.resolvedName.toLowerCase())) throw badRequest('DUPLICATE_SKILL', correlationId);
      seen.add(row.resolvedName.toLowerCase());
    }
    await tx.execute(sql`
      INSERT INTO opportunity_skill_requirements (id, opportunity_version_id, skill_name, requirement_level, taxonomy_topic_id)
      VALUES ${sql.join(rows.map((row) => sql`(gen_random_uuid(), ${versionId}::uuid, ${row.resolvedName}, ${row.level}, ${row.taxonomyTopicId}::uuid)`), sql`, `)}
    `);
  }

  if (requirements.stages === undefined) {
    // EMP-09: a stage keeps its scorecard template when it is carried forward, even a retired
    // one — retiring only stops a template being chosen again.
    await tx.execute(sql`
      INSERT INTO opportunity_selection_stages (id, opportunity_version_id, stage_order, stage_kind, label, detail, scorecard_template_id)
      SELECT gen_random_uuid(), ${versionId}::uuid, stage_order, stage_kind, label, detail, scorecard_template_id FROM opportunity_selection_stages WHERE opportunity_version_id = ${previousVersionId}::uuid
    `);
  } else if (requirements.stages.length) {
    const templateIds = [...new Set(requirements.stages.map((stage) => stage.scorecardTemplateId).filter((id): id is string => id !== null))];
    if (templateIds.length) {
      // A newly chosen template must be one of this job's employer's, and not retired.
      const found = await tx.execute(sql`
        SELECT count(*)::int AS count FROM interview_scorecard_templates t
        JOIN opportunity_versions v ON v.id = ${versionId}::uuid
        JOIN opportunities o ON o.id = v.opportunity_id AND o.employer_id = t.employer_id
        WHERE t.id IN (${sql.join(templateIds.map((id) => sql`${id}::uuid`), sql`, `)})
          AND (t.retired_at IS NULL OR EXISTS (SELECT 1 FROM opportunity_selection_stages prior
            WHERE prior.opportunity_version_id = ${previousVersionId}::uuid AND prior.scorecard_template_id = t.id))
      `) as QueryResult<{ count: number }>;
      if (found.rows[0]?.count !== templateIds.length) throw badRequest('UNKNOWN_SCORECARD_TEMPLATE', correlationId);
    }
    await tx.execute(sql`
      INSERT INTO opportunity_selection_stages (id, opportunity_version_id, stage_order, stage_kind, label, detail, scorecard_template_id)
      VALUES ${sql.join(requirements.stages.map((stage, index) => sql`(gen_random_uuid(), ${versionId}::uuid, ${index + 1}, ${stage.kind}, ${stage.label}, ${stage.detail}, ${stage.scorecardTemplateId}::uuid)`), sql`, `)}
    `);
  }

  if (requirements.eligibilityRules === undefined) {
    await tx.execute(sql`
      INSERT INTO opportunity_eligibility_rules (id, opportunity_version_id, rule_type, comparator, value_numeric, value_text, is_blocking)
      SELECT gen_random_uuid(), ${versionId}::uuid, rule_type, comparator, value_numeric, value_text, is_blocking FROM opportunity_eligibility_rules WHERE opportunity_version_id = ${previousVersionId}::uuid
    `);
  } else if (requirements.eligibilityRules.length) {
    const institutionIds = [...new Set(requirements.eligibilityRules
      .filter((rule) => rule.ruleType === 'INSTITUTION')
      .flatMap((rule) => (rule.valueText ?? '').split(', ')))];
    if (institutionIds.length) {
      const found = await tx.execute(sql`
        SELECT count(*)::int AS count FROM organizations
        WHERE id IN (${sql.join(institutionIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND kind = 'INSTITUTION'
      `) as QueryResult<{ count: number }>;
      if (found.rows[0]?.count !== institutionIds.length) throw badRequest('UNKNOWN_INSTITUTION', correlationId);
    }
    await tx.execute(sql`
      INSERT INTO opportunity_eligibility_rules (id, opportunity_version_id, rule_type, comparator, value_numeric, value_text, is_blocking)
      VALUES ${sql.join(requirements.eligibilityRules.map((rule) => sql`(gen_random_uuid(), ${versionId}::uuid, ${rule.ruleType}, ${rule.comparator}, ${rule.valueNumeric ?? null}, ${rule.valueText ?? null}, ${rule.isBlocking})`), sql`, `)}
    `);
  }

  if (requirements.careerRoleId === undefined) {
    await tx.execute(sql`
      UPDATE opportunity_versions SET career_role_id = (SELECT career_role_id FROM opportunity_versions WHERE id = ${previousVersionId}::uuid)
      WHERE id = ${versionId}::uuid
    `);
  } else if (requirements.careerRoleId !== null) {
    const role = await tx.execute(sql`SELECT id FROM career_roles WHERE id = ${requirements.careerRoleId}::uuid AND active`) as QueryResult<{ id: string }>;
    if (!role.rows[0]) throw badRequest('UNKNOWN_CAREER_ROLE', correlationId);
    await tx.execute(sql`UPDATE opportunity_versions SET career_role_id = ${requirements.careerRoleId}::uuid WHERE id = ${versionId}::uuid`);
  }
}

/** The eligibility rules of one version, in a stable order, as the evaluator takes them. */
export async function readVersionEligibilityRules(db: Executor, versionId: string): Promise<EligibilityRule[]> {
  const rows = await db.execute(sql`
    SELECT rule_type, comparator, value_numeric, value_text, is_blocking FROM opportunity_eligibility_rules
    WHERE opportunity_version_id = ${versionId}::uuid ORDER BY rule_type, comparator, value_numeric NULLS FIRST, value_text NULLS FIRST, id
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.map(mapEligibilityRuleRow);
}

export function mapEligibilityRuleRow(row: Record<string, unknown>): EligibilityRule {
  return {
    ruleType: row.rule_type as EligibilityRule['ruleType'],
    comparator: row.comparator as EligibilityRule['comparator'],
    valueNumeric: row.value_numeric == null ? null : Number(row.value_numeric),
    valueText: row.value_text == null ? null : String(row.value_text),
    isBlocking: row.is_blocking === true,
  };
}

/**
 * Everything a screen shows about a version's requirements. Institution rules are shown by the
 * colleges' names; each stage says which application state it moves an applicant to, so the
 * applicant pipeline can offer the job's stages in order.
 */
export async function readVersionRequirements(db: Executor, versionId: string): Promise<Record<string, unknown>> {
  const [rules, skills, stages, role] = await Promise.all([
    readVersionEligibilityRules(db, versionId),
    db.execute(sql`
      SELECT skill_name, requirement_level, taxonomy_topic_id FROM opportunity_skill_requirements
      WHERE opportunity_version_id = ${versionId}::uuid ORDER BY requirement_level DESC, lower(skill_name)
    `) as Promise<QueryResult<Record<string, unknown>>>,
    db.execute(sql`
      SELECT st.stage_order, st.stage_kind, st.label, st.detail, st.scorecard_template_id, t.name AS scorecard_template_name
      FROM opportunity_selection_stages st LEFT JOIN interview_scorecard_templates t ON t.id = st.scorecard_template_id
      WHERE st.opportunity_version_id = ${versionId}::uuid ORDER BY st.stage_order
    `) as Promise<QueryResult<Record<string, unknown>>>,
    db.execute(sql`
      SELECT cr.id, cr.code, coalesce(cr.catalogue_title, cr.title) AS title, cr.catalogue_code FROM opportunity_versions v
      JOIN career_roles cr ON cr.id = v.career_role_id WHERE v.id = ${versionId}::uuid
    `) as Promise<QueryResult<Record<string, unknown>>>,
  ]);
  const names = await institutionNames(db, rules);
  const roleRow = role.rows[0];
  return {
    eligibilityRules: rules.map((rule) => ({ ...rule, displayValue: displayValue(rule, names) })),
    skills: skills.rows.map((row) => ({
      name: row.skill_name, level: row.requirement_level,
      taxonomyTopicId: row.taxonomy_topic_id ?? null, catalogue: row.taxonomy_topic_id != null,
    })),
    stages: selectionStagesOf(stages.rows),
    careerRole: roleRow ? { id: roleRow.id, code: roleRow.catalogue_code ?? roleRow.code, title: roleRow.title } : null,
  };
}

export function selectionStagesOf(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    // A stage row is per version, so its id is given only where a screen acts on it now (the
    // applicant pipeline schedules against it); a version's requirements compare across versions.
    ...(row.id ? { id: row.id } : {}),
    order: Number(row.stage_order), kind: row.stage_kind, label: row.label, detail: row.detail ?? null,
    applicationState: STAGE_APPLICATION_STATE[row.stage_kind as SelectionStageKind] ?? null,
    // EMP-09: the stage's scorecard template, by name; its criteria are read where they are used.
    scorecardTemplate: row.scorecard_template_id ? { id: row.scorecard_template_id, name: row.scorecard_template_name ?? null } : null,
  }));
}

async function institutionNames(db: Executor, rules: readonly EligibilityRule[]): Promise<Map<string, string>> {
  const ids = [...new Set(rules.filter((rule) => rule.ruleType === 'INSTITUTION').flatMap((rule) => (rule.valueText ?? '').split(',').map((id) => id.trim())).filter((id) => uuidPattern.test(id)))];
  if (!ids.length) return new Map();
  const rows = await db.execute(sql`SELECT id, legal_name FROM organizations WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`) as QueryResult<{ id: string; legal_name: string }>;
  return new Map(rows.rows.map((row) => [row.id, row.legal_name]));
}

/** A rule's value as a person reads it: a college by its name, never its identifier. */
export function displayValue(rule: EligibilityRule, names: ReadonlyMap<string, string>): string {
  if (rule.ruleType === 'INSTITUTION') {
    return (rule.valueText ?? '').split(',').map((id) => names.get(id.trim()) ?? 'A college no longer on ONE').join(', ');
  }
  return rule.valueNumeric != null ? String(rule.valueNumeric) : (rule.valueText ?? '');
}

export async function eligibilityDisplayNames(db: Executor, rules: readonly EligibilityRule[]): Promise<Map<string, string>> {
  return institutionNames(db, rules);
}

/**
 * The records the evaluator resolves against: the student's live college record (department,
 * programme, expected graduation) and their qualifications with every term, newest first. Only
 * the student's own records, read for the student's own request or their own apply.
 */
export async function readEligibilityRecords(db: Executor, studentUserId: string): Promise<EligibilityRecords> {
  const [institution, qualifications] = await Promise.all([
    db.execute(sql`
      SELECT isp.institution_id, dept.name AS department_name, prog.name AS program_name,
             extract(year FROM isp.expected_graduation_date)::int AS graduation_year
      FROM institution_student_profiles isp
      LEFT JOIN institution_units dept ON dept.id = isp.department_unit_id
      LEFT JOIN institution_units prog ON prog.id = isp.program_unit_id
      WHERE isp.student_user_id = ${studentUserId}::uuid AND isp.status = 'ACTIVE'
      ORDER BY isp.updated_at DESC
      LIMIT 1
    `) as Promise<QueryResult<Record<string, unknown>>>,
    db.execute(sql`
      SELECT q.id, q.institution_id, q.completed_on::text AS completed_on, q.verification_state,
        coalesce((SELECT json_agg(json_build_object('sequence', t.sequence, 'label', t.label, 'resultValue', t.result_value,
            'resultScale', t.result_scale, 'backlogCount', t.backlog_count, 'verificationState', t.verification_state) ORDER BY t.sequence)
          FROM student_academic_terms t WHERE t.qualification_id = q.id), '[]'::json) AS terms
      FROM student_qualifications q
      WHERE q.student_user_id = ${studentUserId}::uuid
      ORDER BY q.started_on DESC NULLS LAST, q.created_at DESC
      LIMIT 20
    `) as Promise<QueryResult<Record<string, unknown>>>,
  ]);
  const record = institution.rows[0];
  return {
    institution: record ? {
      institutionId: String(record.institution_id),
      departmentName: record.department_name ? String(record.department_name) : null,
      programName: record.program_name ? String(record.program_name) : null,
      graduationYear: record.graduation_year == null ? null : Number(record.graduation_year),
    } : null,
    qualifications: qualifications.rows.map((row): AcademicQualificationRecord => ({
      id: String(row.id),
      institutionId: row.institution_id ? String(row.institution_id) : null,
      completedOn: row.completed_on ? String(row.completed_on) : null,
      verificationState: String(row.verification_state),
      terms: (Array.isArray(row.terms) ? row.terms as Record<string, unknown>[] : []).map((term) => ({
        sequence: Number(term.sequence),
        label: String(term.label),
        resultValue: term.resultValue == null ? null : Number(term.resultValue),
        resultScale: term.resultScale == null ? null : String(term.resultScale),
        backlogCount: term.backlogCount == null ? null : Number(term.backlogCount),
        verificationState: String(term.verificationState),
      })),
    })),
  };
}

/** Write the frozen evaluation an employer sees: outcomes and basis, never the student's figures. */
export async function recordEligibilityEvaluation(tx: Executor, ids: ApiIdGenerator, input: {
  readonly applicationId: string; readonly versionId: string; readonly trigger: 'APPLY' | 'TERMS_ACKNOWLEDGED'; readonly evaluation: EligibilityEvaluation;
}): Promise<void> {
  const { evaluation } = input;
  await tx.execute(sql`
    INSERT INTO application_eligibility_evaluations (id, application_id, opportunity_version_id, trigger, evaluator_version, eligible, outcomes, flag_count, self_reported_count)
    VALUES (${ids.uuid()}::uuid, ${input.applicationId}::uuid, ${input.versionId}::uuid, ${input.trigger}, ${ELIGIBILITY_EVALUATOR_VERSION},
      ${evaluation.eligible}, ${JSON.stringify(evaluation.outcomes.map(employerOutcome))}::jsonb, ${evaluation.flagCount}, ${evaluation.selfReportedCount})
    ON CONFLICT (application_id, opportunity_version_id) DO NOTHING
  `);
}

/** How a student is told about each rule: their own value, and what would fix an unknown. */
export function studentRuleOutcomes(evaluation: EligibilityEvaluation, names: ReadonlyMap<string, string>): Record<string, unknown>[] {
  return evaluation.outcomes.map((outcome) => ({
    ruleType: outcome.ruleType,
    comparator: outcome.comparator,
    valueNumeric: outcome.valueNumeric,
    valueText: outcome.valueText,
    displayValue: displayValue(outcome, names),
    isBlocking: outcome.isBlocking,
    outcome: outcome.outcome,
    basis: outcome.basis,
    unknownReason: outcome.unknownReason,
    yourValue: outcome.studentValue,
  }));
}
