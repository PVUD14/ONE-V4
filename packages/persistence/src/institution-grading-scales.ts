/**
 * Programme grading scales (INST-05) — the one read every consumer uses.
 *
 * Employer eligibility (EMP-06) needs to know which scale a programme's results are issued
 * on before it can compare a student's marks with a threshold. The rule this file keeps is
 * the reason the table has no default: a programme without a row returns null, and the
 * caller must treat the comparison as not possible (NA). Nothing here guesses a scale or
 * converts a value. Design: docs/architecture/institution-settings-table-design.md.
 */
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

/** Exactly the 0070 academic-records result scales. */
export const institutionResultScales = ['CGPA_10', 'GPA_4', 'PERCENTAGE', 'LETTER', 'PASS_FAIL'] as const;
export type InstitutionResultScale = typeof institutionResultScales[number];

/** Scales that carry a numeric value, with the range 0070 enforces on results. */
export const numericScaleMaximum: Readonly<Partial<Record<InstitutionResultScale, number>>> = { CGPA_10: 10, GPA_4: 4, PERCENTAGE: 100 };

export interface ProgrammeGradingScale {
  readonly programUnitId: string;
  readonly scale: InstitutionResultScale;
  /** Null on LETTER and PASS_FAIL, and when the college has not given one: NA, never assumed. */
  readonly passThreshold: number | null;
  readonly updatedAt: string;
}

interface ScaleRow { program_unit_id: string; result_scale: InstitutionResultScale; pass_threshold: string | null; updated_at: Date | string }

function mapScale(row: ScaleRow): ProgrammeGradingScale {
  return {
    programUnitId: row.program_unit_id,
    scale: row.result_scale,
    passThreshold: row.pass_threshold === null ? null : Number(row.pass_threshold),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** The grading scale of one programme, or null when the college has not set one. */
export async function loadProgrammeGradingScale(db: PersistenceDb, institutionId: string, programUnitId: string): Promise<ProgrammeGradingScale | null> {
  const rows = await db.execute(sql`
    SELECT program_unit_id, result_scale, pass_threshold::text AS pass_threshold, updated_at
    FROM institution_grading_scales
    WHERE institution_id = ${institutionId}::uuid AND program_unit_id = ${programUnitId}::uuid
  `) as unknown as { rows: ScaleRow[] };
  return rows.rows[0] ? mapScale(rows.rows[0]) : null;
}

/** Every programme of the institution with its scale, or scale null (NA) where none is set. */
export async function loadInstitutionProgrammeScales(db: PersistenceDb, institutionId: string): Promise<readonly {
  readonly programUnitId: string; readonly programName: string; readonly parentName: string | null; readonly gradingScale: ProgrammeGradingScale | null;
}[]> {
  const rows = await db.execute(sql`
    SELECT program.id AS program_unit_id, program.name AS program_name, parent.name AS parent_name,
           scale.result_scale, scale.pass_threshold::text AS pass_threshold, scale.updated_at
    FROM institution_units program
    LEFT JOIN institution_units parent ON parent.id = program.parent_unit_id
    LEFT JOIN institution_grading_scales scale ON scale.institution_id = program.institution_id AND scale.program_unit_id = program.id
    WHERE program.institution_id = ${institutionId}::uuid AND program.kind = 'PROGRAM'
    ORDER BY lower(program.name), program.id
    LIMIT 500
  `) as unknown as { rows: (Omit<ScaleRow, 'result_scale' | 'updated_at'> & { program_name: string; parent_name: string | null; result_scale: InstitutionResultScale | null; updated_at: Date | string | null })[] };
  return rows.rows.map((row) => ({
    programUnitId: row.program_unit_id,
    programName: row.program_name,
    parentName: row.parent_name,
    gradingScale: row.result_scale && row.updated_at
      ? mapScale({ program_unit_id: row.program_unit_id, result_scale: row.result_scale, pass_threshold: row.pass_threshold, updated_at: row.updated_at })
      : null,
  }));
}
