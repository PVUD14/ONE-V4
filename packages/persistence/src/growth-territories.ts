/**
 * Growth territories (GROWTH-02): the LGD district import and the loader for the growth scope.
 *
 * Why this exists: territory decides whose pipeline a growth person sees, so the two things that
 * feed it — the district list and the live assignments — are read and written in one place.
 *
 *  - District import (design §3.1): a CSV downloaded from the Local Government Directory is
 *    previewed (nothing written; a row-level report and a digest) and then committed exactly as
 *    previewed, all rows or none, with one `growth_district_imports` row, one audit row and one
 *    outbox event. Districts are never deleted and never change state; a rename is recorded.
 *  - `loadGrowthScope`: the inputs of the pure `growthScopeFor` (packages/authorization), read
 *    from the rows as they stand now, so visibility follows today's assignment.
 *
 * Design: docs/architecture/growth-territories-table-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { parseCsvRecords } from '@planthepath/career-readiness';
import {
  growthScopeFor,
  type GrowthAssignmentRole,
  type GrowthScope,
} from '@planthepath/authorization/src/index.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
type Runner = Pick<PersistenceDb, 'execute'>;
async function rows<T>(runner: Runner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The caller's growth scope, from the database as it is now. `growthAdmin` is resolved by the
 * caller through the capability model (GROWTH_ADMIN); every other input is read here.
 */
export async function loadGrowthScope(runner: Runner, input: { readonly userId: string; readonly growthAdmin: boolean }): Promise<GrowthScope> {
  if (input.growthAdmin) return { kind: 'ALL' };
  const memberships = await rows<{ id: string; role: string; state: string; organization_kind: string }>(runner, sql`
    SELECT m.id, m.role, m.state::text AS state, o.kind::text AS organization_kind
    FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ${input.userId}::uuid AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
  `);
  if (!memberships.length) return { kind: 'NONE' };
  const ids = sql.join(memberships.map((row) => sql`${row.id}::uuid`), sql`, `);
  const assignments = await rows<{ membership_id: string; region_id: string; assignment_role: GrowthAssignmentRole }>(runner, sql`
    SELECT a.membership_id, a.region_id, a.assignment_role
    FROM growth_territory_assignments a JOIN growth_regions r ON r.id = a.region_id AND r.retired_at IS NULL
    WHERE a.ended_at IS NULL AND a.membership_id IN (${ids})
  `);
  const teamRows = await rows<{ membership_id: string; manager_membership_id: string }>(runner, sql`
    SELECT membership_id, manager_membership_id FROM growth_team_members
    WHERE left_at IS NULL AND manager_membership_id IN (${ids})
  `);
  return growthScopeFor({
    growthAdmin: false,
    memberships: memberships.map((row) => ({ membershipId: row.id, role: row.role, state: row.state, organizationKind: row.organization_kind })),
    assignments: assignments.map((row) => ({ membershipId: row.membership_id, regionId: row.region_id, role: row.assignment_role, ended: false })),
    teamRows: teamRows.map((row) => ({ memberMembershipId: row.membership_id, managerMembershipId: row.manager_membership_id, left: false })),
  });
}

/**
 * The SQL form of `isVisibleInGrowthScope` for a table with `owner_membership_id`, `state_code`
 * and `district_code` columns under `alias`. A region covers a record when it has a live area for
 * the record's district or a live whole-state area for its state (the pure `regionsCoveringArea`).
 */
export function growthScopePredicate(scope: GrowthScope, alias: string): SQL {
  if (scope.kind === 'ALL') return sql`TRUE`;
  if (scope.kind === 'NONE') return sql`FALSE`;
  const column = (name: string): SQL => sql.raw(`${alias}.${name}`);
  const covered = (regionIds: readonly string[]): SQL => regionIds.length === 0 ? sql`FALSE` : sql`EXISTS (
    SELECT 1 FROM growth_region_areas ga
    WHERE ga.removed_at IS NULL AND ga.region_id IN (${sql.join(regionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND ga.state_code = ${column('state_code')}
      AND (ga.district_code IS NULL OR ga.district_code = ${column('district_code')}))`;
  const owners = scope.ownerMembershipIds.length === 0 ? sql`FALSE`
    : sql`${column('owner_membership_id')} IN (${sql.join(scope.ownerMembershipIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  return sql`(${owners} OR ${covered(scope.allLeadRegionIds)} OR (${column('owner_membership_id')} IS NULL AND ${covered(scope.unownedLeadRegionIds)}))`;
}

// ---------------------------------------------------------------------------
// District import
// ---------------------------------------------------------------------------

export const GROWTH_DISTRICT_IMPORT_MAX_ROWS = 2_000;
export const GROWTH_DISTRICT_IMPORT_MAX_CHARACTERS = 1_000_000;
export const GROWTH_DISTRICT_IMPORT_FILENAME_MAX = 200;

export type GrowthDistrictRowStatus = 'NEW' | 'UNCHANGED' | 'RENAMED' | 'ERROR';

export interface GrowthDistrictImportRow {
  readonly line: number;
  readonly districtCode: number | null;
  readonly districtName: string | null;
  readonly stateCode: string | null;
  readonly status: GrowthDistrictRowStatus;
  readonly issues: readonly string[];
  readonly previousName?: string;
}

export interface GrowthDistrictImportReport {
  readonly filename: string;
  readonly fileProblems: readonly string[];
  readonly rowCount: number;
  readonly counts: { readonly new: number; readonly unchanged: number; readonly renamed: number; readonly errors: number };
  readonly rows: readonly GrowthDistrictImportRow[];
  readonly committable: boolean;
  readonly digest: string;
}

export class GrowthDistrictImportRejected extends Error {
  constructor(readonly code: 'IMPORT_INVALID' | 'IMPORT_STALE', readonly report: GrowthDistrictImportReport) {
    super(code);
  }
}

const headerAliases: Readonly<Record<'districtCode' | 'districtName' | 'stateCode' | 'stateName', readonly string[]>> = {
  districtCode: ['districtcode', 'districtlgdcode', 'lgddistrictcode'],
  districtName: ['districtnameinenglish', 'districtname', 'district'],
  stateCode: ['statecode', 'isostatecode', 'statecodeiso'],
  stateName: ['statenameinenglish', 'statename', 'state'],
};

/** Historic names LGD and older lists still use for the same subdivision. Never a guess. */
const stateNameAliases: Readonly<Record<string, string>> = {
  nctofdelhi: 'IN-DL', nationalcapitalterritoryofdelhi: 'IN-DL', orissa: 'IN-OD', pondicherry: 'IN-PY', uttaranchal: 'IN-UK',
};

const normaliseHeader = (value: string): string => value.trim().toLowerCase().replace(/[^a-z]/g, '');

/** Lower case, `&` → `and`, a leading "the" dropped, everything but letters removed. */
export function normaliseGrowthStateName(value: string): string {
  return value.trim().toLowerCase().replaceAll('&', ' and ').replace(/^the\s+/, '').replace(/[^a-z]/g, '');
}

interface ParsedDistrictRow {
  readonly line: number;
  readonly districtCode: number | null;
  readonly districtName: string | null;
  readonly stateCode: string | null;
  readonly issues: string[];
}

/**
 * Parses the CSV against the seeded states. Pure: no database. Each row carries its own issues;
 * file-level problems (no header, a missing column, too many rows) stop the whole file.
 */
export function parseGrowthDistrictCsv(
  content: string,
  states: readonly { readonly code: string; readonly name: string }[],
): { readonly fileProblems: readonly string[]; readonly rows: readonly ParsedDistrictRow[] } {
  if (content.length > GROWTH_DISTRICT_IMPORT_MAX_CHARACTERS) return { fileProblems: ['IMPORT_FILE_TOO_LARGE'], rows: [] };
  const records = parseCsvRecords(content.replace(/^﻿/, ''));
  if (!records) return { fileProblems: ['IMPORT_CSV_UNTERMINATED_QUOTE'], rows: [] };
  const filled = records.map((record, index) => ({ record, line: index + 1 })).filter(({ record }) => record.some((cell) => cell.trim()));
  if (!filled.length) return { fileProblems: ['IMPORT_FILE_EMPTY'], rows: [] };
  const header = filled[0]!.record.map(normaliseHeader);
  const find = (key: keyof typeof headerAliases): number => {
    for (const alias of headerAliases[key]) {
      const index = header.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };
  const columns = { districtCode: find('districtCode'), districtName: find('districtName'), stateCode: find('stateCode'), stateName: find('stateName') };
  const problems: string[] = [];
  if (columns.districtCode < 0) problems.push('IMPORT_COLUMN_MISSING:district_code');
  if (columns.districtName < 0) problems.push('IMPORT_COLUMN_MISSING:district_name');
  if (columns.stateCode < 0 && columns.stateName < 0) problems.push('IMPORT_COLUMN_MISSING:state');
  const data = filled.slice(1);
  if (data.length > GROWTH_DISTRICT_IMPORT_MAX_ROWS) problems.push('IMPORT_TOO_MANY_ROWS');
  if (problems.length) return { fileProblems: problems, rows: [] };

  const byCode = new Map(states.map((state) => [state.code, state.code]));
  const byName = new Map(states.map((state) => [normaliseGrowthStateName(state.name), state.code]));
  const seen = new Set<number>();
  const parsed: ParsedDistrictRow[] = [];
  for (const { record, line } of data) {
    const issues: string[] = [];
    const cell = (index: number): string => (index >= 0 ? record[index] ?? '' : '').trim();
    const rawCode = cell(columns.districtCode);
    const districtCode = /^[0-9]{1,7}$/.test(rawCode) && Number(rawCode) > 0 ? Number(rawCode) : null;
    if (districtCode === null) issues.push('DISTRICT_CODE_INVALID');
    else if (seen.has(districtCode)) issues.push('DISTRICT_CODE_DUPLICATE');
    else seen.add(districtCode);
    const name = cell(columns.districtName).replace(/\s+/g, ' ');
    const districtName = name.length >= 1 && name.length <= 120 && !/[<>]/.test(name) ? name : null;
    if (districtName === null) issues.push('DISTRICT_NAME_INVALID');
    const rawStateCode = cell(columns.stateCode).toUpperCase();
    const rawStateName = cell(columns.stateName);
    let stateCode: string | null = null;
    if (rawStateCode && /^IN-[A-Z]{2}$/.test(rawStateCode)) stateCode = byCode.get(rawStateCode) ?? null;
    if (!stateCode && rawStateName) {
      const key = normaliseGrowthStateName(rawStateName);
      stateCode = byName.get(key) ?? stateNameAliases[key] ?? null;
    }
    if (!stateCode) issues.push('STATE_UNKNOWN');
    parsed.push({ line, districtCode, districtName, stateCode, issues });
  }
  return { fileProblems: [], rows: parsed };
}

function evaluate(
  filename: string,
  content: string,
  parsed: ReturnType<typeof parseGrowthDistrictCsv>,
  existing: ReadonlyMap<number, { readonly stateCode: string; readonly name: string }>,
): GrowthDistrictImportReport {
  const reportRows: GrowthDistrictImportRow[] = parsed.rows.map((row) => {
    const issues = [...row.issues];
    const current = row.districtCode === null ? undefined : existing.get(row.districtCode);
    if (current && row.stateCode && current.stateCode !== row.stateCode) issues.push('DISTRICT_STATE_MISMATCH');
    const base = { line: row.line, districtCode: row.districtCode, districtName: row.districtName, stateCode: row.stateCode };
    if (issues.length) return { ...base, status: 'ERROR' as const, issues };
    if (!current) return { ...base, status: 'NEW' as const, issues };
    if (current.name === row.districtName) return { ...base, status: 'UNCHANGED' as const, issues };
    return { ...base, status: 'RENAMED' as const, issues, previousName: current.name };
  });
  const count = (status: GrowthDistrictRowStatus): number => reportRows.filter((row) => row.status === status).length;
  const counts = { new: count('NEW'), unchanged: count('UNCHANGED'), renamed: count('RENAMED'), errors: count('ERROR') };
  const committable = parsed.fileProblems.length === 0 && reportRows.length > 0 && counts.errors === 0;
  const digest = createHash('sha256')
    .update(JSON.stringify({ content, rows: reportRows.map((row) => [row.line, row.districtCode, row.stateCode, row.status, row.previousName ?? null]) }))
    .digest('hex');
  return { filename, fileProblems: parsed.fileProblems, rowCount: reportRows.length, counts, rows: reportRows, committable, digest };
}

async function evaluateAgainstDatabase(runner: Runner, filename: string, content: string): Promise<GrowthDistrictImportReport> {
  const states = await rows<{ code: string; name: string }>(runner, sql`SELECT code, name FROM growth_states`);
  const parsed = parseGrowthDistrictCsv(content, states);
  const codes = parsed.rows.map((row) => row.districtCode).filter((code): code is number => code !== null);
  const existing = new Map<number, { stateCode: string; name: string }>();
  if (codes.length) {
    const found = await rows<{ lgd_code: number; state_code: string; name: string }>(runner, sql`
      SELECT lgd_code, state_code, name FROM growth_districts WHERE lgd_code = ANY(${`{${codes.join(',')}}`}::int[])
    `);
    for (const row of found) existing.set(Number(row.lgd_code), { stateCode: row.state_code, name: row.name });
  }
  return evaluate(filename, content, parsed, existing);
}

/** Step one: the report and its digest. Nothing is written. */
export async function previewGrowthDistrictImport(runner: Runner, input: { readonly filename: string; readonly content: string }): Promise<GrowthDistrictImportReport> {
  return evaluateAgainstDatabase(runner, input.filename, input.content);
}

export interface GrowthDistrictImportCommit {
  readonly importId: string;
  readonly report: GrowthDistrictImportReport;
}

/**
 * Step two: exactly the previewed file, all rows or none. Imports are serialised by a table lock,
 * so the evaluation the commit checks is the one it writes.
 */
export async function commitGrowthDistrictImport(db: PersistenceDb, input: {
  readonly filename: string;
  readonly content: string;
  readonly previewDigest: string;
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly ids?: { uuid(): string };
}): Promise<GrowthDistrictImportCommit> {
  const uuid = (): string => input.ids?.uuid() ?? randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE growth_districts IN SHARE ROW EXCLUSIVE MODE`);
    const report = await evaluateAgainstDatabase(tx, input.filename, input.content);
    if (!report.committable) throw new GrowthDistrictImportRejected('IMPORT_INVALID', report);
    if (report.digest !== input.previewDigest) throw new GrowthDistrictImportRejected('IMPORT_STALE', report);
    const importId = uuid();
    await tx.execute(sql`
      INSERT INTO growth_district_imports (id, filename, file_digest, row_count, created_count, renamed_count, unchanged_count, reason_code, imported_by_user_id)
      VALUES (${importId}::uuid, ${input.filename}, ${createHash('sha256').update(input.content).digest('hex')}, ${report.rowCount},
              ${report.counts.new}, ${report.counts.renamed}, ${report.counts.unchanged}, ${input.reasonCode}, ${input.actorUserId}::uuid)
    `);
    for (const row of report.rows) {
      if (row.status === 'NEW') {
        await tx.execute(sql`
          INSERT INTO growth_districts (lgd_code, state_code, name, created_import_id)
          VALUES (${row.districtCode}, ${row.stateCode}, ${row.districtName}, ${importId}::uuid)
        `);
      } else if (row.status === 'RENAMED') {
        await tx.execute(sql`
          UPDATE growth_districts SET name = ${row.districtName}, renamed_at = now(), renamed_import_id = ${importId}::uuid
          WHERE lgd_code = ${row.districtCode}
        `);
      }
    }
    const renamed = report.rows.filter((row) => row.status === 'RENAMED')
      .map((row) => ({ code: row.districtCode, from: row.previousName, to: row.districtName }));
    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${uuid()}::uuid, ${input.actorUserId}::uuid, 'operations.growth_districts.imported', 'growth_district_import', ${importId},
              ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId},
              ${JSON.stringify({ filename: input.filename, reasonCode: input.reasonCode, digest: report.digest, counts: report.counts, renamed })}::jsonb)
    `);
    const outbox = { id: uuid(), aggregateType: 'growth_district_import', aggregateId: importId, eventType: 'growth.districts.imported', eventVersion: 1,
      payload: { importId, reasonCode: input.reasonCode }, actorUserId: input.actorUserId, organizationId: input.organizationId, correlationId: input.correlationId };
    validateOutboxWriteInput(outbox);
    await tx.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
      VALUES (${outbox.id}::uuid, ${outbox.aggregateType}, ${outbox.aggregateId}, ${outbox.eventType}, 1, ${JSON.stringify(outbox.payload)}::jsonb,
              ${outbox.actorUserId}::uuid, ${outbox.organizationId}::uuid, ${outbox.correlationId})
    `);
    return { importId, report };
  });
}
