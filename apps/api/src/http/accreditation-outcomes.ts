/**
 * The data behind the accreditation outcomes export (INST-13).
 *
 * Graduates in the export scope, grouped by department, programme and year of graduation, each
 * counted once: placed (INST-12's rule, through the same `loadPlacementFacts`, so the figures
 * reconcile with the placement statistics), else their own shared self-report (0083), else "no
 * outcome shared". As of the end of the last ended month; only the suppressed table leaves this
 * module. No pay (ADR-024) and no readiness (ADR-020) is read.
 * Design: docs/architecture/accreditation-outcome-exports-design.md.
 */
import { sql } from 'drizzle-orm';
import {
  accreditationOutcomes,
  isSelfReportedOutcome,
  placementFunnelStage,
  type AccreditationGraduate,
  type AccreditationOutcomeRow,
  type InstitutionStudentScope,
} from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { loadPlacementFacts, placementPeriod } from './placement-facts.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type Rows<T> = { rows: T[] };

export interface AccreditationOutcomeGroup {
  readonly department: string;
  readonly programme: string;
  readonly yearOfGraduation: number;
  readonly row: AccreditationOutcomeRow;
}

export interface AccreditationOutcomeTable {
  readonly asOf: { readonly month: string; readonly lastDay: string };
  readonly groups: readonly AccreditationOutcomeGroup[];
  readonly overall: AccreditationOutcomeRow;
}

export async function loadAccreditationOutcomes(db: Executor, institutionId: string, scope: InstitutionStudentScope): Promise<AccreditationOutcomeTable> {
  const period = await placementPeriod(db);
  const periodEnd = sql`${period.periodEnd}::timestamptz`;
  const placement = await loadPlacementFacts(db, institutionId, scope, period.periodEnd);
  const graduates = await db.execute(sql`
    SELECT sp.student_user_id, sp.department_unit_id, sp.program_unit_id,
      extract(year FROM (max(r.effective_to) AT TIME ZONE 'UTC'))::int AS graduation_year,
      (SELECT d.outcome FROM student_outcome_declarations d
        WHERE d.institution_id = sp.institution_id AND d.student_user_id = sp.student_user_id
          AND d.withdrawn_at IS NULL AND d.declared_at < ${periodEnd}
        ORDER BY d.declared_at DESC LIMIT 1) AS declared
    FROM institution_student_profiles sp
    JOIN users u ON u.id = sp.student_user_id
    JOIN institution_relationships r ON r.institution_id = sp.institution_id AND r.student_user_id = sp.student_user_id
      AND r.state = 'GRADUATED' AND r.effective_to IS NOT NULL AND r.effective_from < ${periodEnd} AND r.effective_to < ${periodEnd}
    WHERE sp.institution_id = ${institutionId}::uuid AND u.state = 'ACTIVE'
      AND ${institutionStudentScopeSql(scope, 'sp')}
    GROUP BY sp.institution_id, sp.student_user_id, sp.department_unit_id, sp.program_unit_id
  `) as Rows<{ student_user_id: string; department_unit_id: string | null; program_unit_id: string | null; graduation_year: number; declared: string | null }>;

  const groupKey = (row: { department_unit_id: string | null; program_unit_id: string | null; graduation_year: number }) =>
    `${row.department_unit_id ?? ''}|${row.program_unit_id ?? ''}|${Number(row.graduation_year)}`;
  const people: AccreditationGraduate<string>[] = graduates.rows.map((row) => {
    const facts = placement.get(row.student_user_id);
    return {
      group: groupKey(row),
      placed: facts ? placementFunnelStage(facts.applications) === 'PLACED' : false,
      declared: isSelfReportedOutcome(row.declared) ? row.declared : null,
    };
  });
  const keys = [...new Set(people.map((person) => person.group))];
  const unitIds = [...new Set(keys.flatMap((key) => key.split('|').slice(0, 2)).filter(Boolean))];
  const units = unitIds.length ? await db.execute(sql`
    SELECT id, name FROM institution_units WHERE institution_id = ${institutionId}::uuid AND id = ANY(${`{${unitIds.join(',')}}`}::uuid[])
  `) as Rows<{ id: string; name: string }> : { rows: [] };
  const unitName = new Map(units.rows.map((unit) => [unit.id, unit.name]));
  const described = keys.map((key) => {
    const [department, programme, year] = key.split('|');
    return {
      key,
      department: department ? unitName.get(department) ?? 'NA' : 'No department',
      programme: programme ? unitName.get(programme) ?? 'NA' : 'No programme',
      yearOfGraduation: Number(year),
    };
  }).sort((a, b) => b.yearOfGraduation - a.yearOfGraduation || a.department.localeCompare(b.department)
    || a.programme.localeCompare(b.programme) || a.key.localeCompare(b.key));
  const result = accreditationOutcomes(described.map((group) => group.key), people);
  const rowFor = new Map(result.groups.map((group) => [group.key, group.row]));
  return {
    asOf: { month: period.month, lastDay: period.lastDay },
    groups: described.map((group) => ({ department: group.department, programme: group.programme, yearOfGraduation: group.yearOfGraduation, row: rowFor.get(group.key)! })),
    overall: result.overall,
  };
}
