/**
 * Operations → Settings → Growth set-up (GROWTH-02, design §4 and §16.2).
 *
 * A GROWTH_ADMIN holder imports the official LGD district list (dry run, then exactly what was
 * previewed), creates and retires sales regions, adds and removes the states or districts a
 * region covers, and assigns growth people to regions as executive or manager. It is a section
 * of the existing Settings page, not a navigation item (O-24).
 *
 * Decisions this file carries:
 *  - Every write is one transaction with its audit row and outbox event, and carries a reason
 *    code from a fixed list; the reason is also on the row, so history survives without audit.
 *  - The area rules are checked here first (clean domain codes) and enforced again by the
 *    database (unique indexes and a trigger), which decides a race.
 *  - Nobody assigns their own territory; only an ACTIVE growth membership of the platform
 *    organisation can be assigned, as EXECUTIVE or MANAGER to match its role.
 *  - Nothing here returns a student, an amount, or a growth person beyond their work email.
 *
 * Design: docs/architecture/growth-territories-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  canAdministerGrowthTerritory,
  growthAssignmentRoles,
  growthTerritoryReasons,
  isGrowthAssignmentRole,
  isGrowthRegionName,
  isIndianStateCode,
  refuseGrowthArea,
  refuseGrowthTeamChange,
  type GrowthRegionArea,
} from '@planthepath/authorization/src/index.js';
import {
  commitGrowthDistrictImport,
  GROWTH_DISTRICT_IMPORT_FILENAME_MAX,
  GROWTH_DISTRICT_IMPORT_MAX_CHARACTERS,
  GROWTH_DISTRICT_IMPORT_MAX_ROWS,
  GrowthDistrictImportRejected,
  previewGrowthDistrictImport,
} from '@planthepath/persistence/src/growth-territories.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import {
  badRequest,
  conflict,
  forbidden,
  iso,
  mapGrowthWriteError,
  notFound,
  platformOrganizationId,
  readObject,
  readReason,
  readUuid,
  writeGrowthAudit,
  writeGrowthOutbox,
  type QueryResult,
} from './growth-http.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = Awaited<ReturnType<typeof loadCallerCapabilityContext>>;

const listCap = 200;
const districtCap = 1_000;

/** Trigger refusals → domain codes. The database decides a race; these name what it decided. */
const areaMessages = {
  'growth area conflict': 'GROWTH_AREA_CONFLICT',
  'growth area redundant': 'GROWTH_AREA_REDUNDANT',
  'needs a live region': 'GROWTH_REGION_RETIRED',
  'does not belong to the area': 'GROWTH_DISTRICT_STATE_MISMATCH',
} as const;

@Controller('/api/v1/operations/growth-territories')
export class OperationsGrowthTerritoriesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** States with district counts, regions with their live areas and people, and the vocabulary. */
  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async overview(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const states = await this.db.execute(sql`
      SELECT s.code, s.name, s.kind, count(d.lgd_code)::int AS district_count
      FROM growth_states s LEFT JOIN growth_districts d ON d.state_code = s.code
      GROUP BY s.code, s.name, s.kind ORDER BY s.name
    `) as QueryResult<{ code: string; name: string; kind: string; district_count: number }>;
    const regions = await this.db.execute(sql`
      SELECT id, name, created_at, reason_code, retired_at, retired_reason_code
      FROM growth_regions ORDER BY (retired_at IS NULL) DESC, lower(name), id LIMIT ${listCap + 1}
    `) as QueryResult<{ id: string; name: string; created_at: Date; reason_code: string; retired_at: Date | null; retired_reason_code: string | null }>;
    const page = regions.rows.slice(0, listCap);
    const regionIds = page.map((row) => row.id);
    const areas = regionIds.length ? await this.db.execute(sql`
      SELECT a.id, a.region_id, a.state_code, s.name AS state_name, a.district_code, d.name AS district_name, a.added_at, a.reason_code
      FROM growth_region_areas a JOIN growth_states s ON s.code = a.state_code LEFT JOIN growth_districts d ON d.lgd_code = a.district_code
      WHERE a.removed_at IS NULL AND a.region_id IN (${sql.join(regionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY s.name, d.name NULLS FIRST
    `) as QueryResult<{ id: string; region_id: string; state_code: string; state_name: string; district_code: number | null; district_name: string | null; added_at: Date; reason_code: string }> : { rows: [] };
    const assignments = regionIds.length ? await this.db.execute(sql`
      SELECT a.id, a.region_id, a.membership_id, u.email, a.assignment_role, a.starts_at, a.reason_code, m.state::text AS membership_state
      FROM growth_territory_assignments a JOIN organization_memberships m ON m.id = a.membership_id JOIN users u ON u.id = m.user_id
      WHERE a.ended_at IS NULL AND a.region_id IN (${sql.join(regionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY a.assignment_role DESC, u.email
    `) as QueryResult<{ id: string; region_id: string; membership_id: string; email: string; assignment_role: string; starts_at: Date; reason_code: string; membership_state: string }> : { rows: [] };
    const people = await this.db.execute(sql`
      SELECT m.id, u.email, m.role FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM' JOIN users u ON u.id = m.user_id
      WHERE m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER') AND m.state = 'ACTIVE'
      ORDER BY u.email, m.role LIMIT ${listCap}
    `) as QueryResult<{ id: string; email: string; role: string }>;
    const lastImport = await this.db.execute(sql`
      SELECT i.id, i.filename, i.row_count, i.created_count, i.renamed_count, i.unchanged_count, i.reason_code, i.created_at, u.email
      FROM growth_district_imports i JOIN users u ON u.id = i.imported_by_user_id ORDER BY i.created_at DESC, i.id LIMIT 1
    `) as QueryResult<{ id: string; filename: string; row_count: number; created_count: number; renamed_count: number; unchanged_count: number; reason_code: string; created_at: Date; email: string }>;
    const imported = lastImport.rows[0];
    return {
      states: states.rows.map((row) => ({ code: row.code, name: row.name, kind: row.kind, districtCount: row.district_count })),
      regions: page.map((row) => ({
        id: row.id, name: row.name, createdAt: iso(row.created_at), reasonCode: row.reason_code,
        retiredAt: iso(row.retired_at), retiredReasonCode: row.retired_reason_code,
        areas: areas.rows.filter((area) => area.region_id === row.id).map((area) => ({
          id: area.id, stateCode: area.state_code, stateName: area.state_name, districtCode: area.district_code, districtName: area.district_name,
          addedAt: iso(area.added_at), reasonCode: area.reason_code,
        })),
        assignments: assignments.rows.filter((assignment) => assignment.region_id === row.id).map((assignment) => ({
          id: assignment.id, membershipId: assignment.membership_id, email: assignment.email, role: assignment.assignment_role,
          startsAt: iso(assignment.starts_at), reasonCode: assignment.reason_code, membershipState: assignment.membership_state,
        })),
      })),
      truncated: regions.rows.length > listCap,
      people: people.rows.map((row) => ({ membershipId: row.id, email: row.email, role: row.role })),
      lastImport: imported ? {
        id: imported.id, filename: imported.filename, rowCount: imported.row_count, created: imported.created_count,
        renamed: imported.renamed_count, unchanged: imported.unchanged_count, reasonCode: imported.reason_code,
        importedAt: iso(imported.created_at), importedBy: imported.email,
      } : null,
      vocabulary: { assignmentRoles: growthAssignmentRoles, reasons: growthTerritoryReasons },
      limits: { importRows: GROWTH_DISTRICT_IMPORT_MAX_ROWS, importCharacters: GROWTH_DISTRICT_IMPORT_MAX_CHARACTERS },
      correlationId,
    };
  }

  /** The imported districts of one state. */
  @Get('/districts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async districts(@Req() request: ProtectedHttpRequest, @Query('state') state: unknown): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    if (!isIndianStateCode(state)) throw badRequest('GROWTH_STATE_INVALID', correlationId);
    const found = await this.db.execute(sql`
      SELECT d.lgd_code, d.name, a.region_id, r.name AS region_name
      FROM growth_districts d
      LEFT JOIN growth_region_areas a ON a.district_code = d.lgd_code AND a.removed_at IS NULL
      LEFT JOIN growth_regions r ON r.id = a.region_id
      WHERE d.state_code = ${state} ORDER BY d.name, d.lgd_code LIMIT ${districtCap}
    `) as QueryResult<{ lgd_code: number; name: string; region_id: string | null; region_name: string | null }>;
    return {
      stateCode: state,
      districts: found.rows.map((row) => ({ code: Number(row.lgd_code), name: row.name, region: row.region_id ? { id: row.region_id, name: row.region_name } : null })),
      correlationId,
    };
  }

  /** Dry run: the row-level report and its digest. Nothing is written. */
  @Post('/district-imports/preview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async previewImport(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const upload = readUpload(body, false, correlationId);
    const preview = await previewGrowthDistrictImport(this.db, upload);
    return { preview, correlationId };
  }

  /** Commit exactly the previewed file: all rows or none. */
  @Post('/district-imports/commit')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async commitImport(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const upload = readUpload(body, true, correlationId);
    const organizationId = await this.platform(correlationId);
    try {
      const committed = await commitGrowthDistrictImport(this.db, {
        filename: upload.filename, content: upload.content, previewDigest: upload.previewDigest!, reasonCode: upload.reasonCode!,
        actorUserId: actor.userId, organizationId, correlationId, ids: this.ids,
      });
      return { import: { id: committed.importId, counts: committed.report.counts, rowCount: committed.report.rowCount }, correlationId };
    } catch (error) {
      if (error instanceof GrowthDistrictImportRejected) {
        throw error.code === 'IMPORT_STALE' ? conflict(error.code, correlationId, { preview: error.report }) : badRequest(error.code, correlationId, { preview: error.report });
      }
      throw mapGrowthWriteError(error, correlationId);
    }
  }

  @Post('/regions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createRegion(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const raw = readObject(body, ['name', 'reasonCode'], correlationId);
    const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
    if (!isGrowthRegionName(name)) throw badRequest('GROWTH_REGION_NAME_INVALID', correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.createRegion, correlationId);
    const organizationId = await this.platform(correlationId);
    const id = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO growth_regions (id, name, created_by_user_id, reason_code) VALUES (${id}::uuid, ${name}, ${actor.userId}::uuid, ${reasonCode})`);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.region.created', resourceType: 'growth_region', resourceId: id,
        organizationId, correlationId, context: { name, reasonCode } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_region', aggregateId: id, eventType: 'growth.region.created',
        payload: { regionId: id, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { unique: 'GROWTH_REGION_NAME_TAKEN' }); });
    return { region: { id, name, reasonCode }, correlationId };
  }

  @Post('/regions/:regionId/retire')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async retireRegion(@Req() request: ProtectedHttpRequest, @Param('regionId') regionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = readUuid(regionId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.retireRegion, correlationId);
    const organizationId = await this.platform(correlationId);
    await this.db.transaction(async (tx) => {
      await this.lockLiveRegion(tx, id, correlationId);
      const inUse = await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM growth_region_areas WHERE region_id = ${id}::uuid AND removed_at IS NULL) AS areas,
               (SELECT count(*)::int FROM growth_territory_assignments WHERE region_id = ${id}::uuid AND ended_at IS NULL) AS assignments
      `) as QueryResult<{ areas: number; assignments: number }>;
      if ((inUse.rows[0]?.areas ?? 0) > 0 || (inUse.rows[0]?.assignments ?? 0) > 0) throw conflict('GROWTH_REGION_IN_USE', correlationId);
      await tx.execute(sql`
        UPDATE growth_regions SET retired_at = now(), retired_by_user_id = ${actor.userId}::uuid, retired_reason_code = ${reasonCode}
        WHERE id = ${id}::uuid AND retired_at IS NULL
      `);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.region.retired', resourceType: 'growth_region', resourceId: id,
        organizationId, correlationId, context: { reasonCode } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_region', aggregateId: id, eventType: 'growth.region.retired',
        payload: { regionId: id, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: { 'growth region in use': 'GROWTH_REGION_IN_USE' } }); });
    return { region: { id, retired: true, reasonCode }, correlationId };
  }

  @Post('/regions/:regionId/areas')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addArea(@Req() request: ProtectedHttpRequest, @Param('regionId') regionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = readUuid(regionId, correlationId);
    const raw = readObject(body, ['stateCode', 'districtCode', 'reasonCode'], correlationId);
    if (!isIndianStateCode(raw.stateCode)) throw badRequest('GROWTH_STATE_INVALID', correlationId);
    const stateCode = raw.stateCode;
    const districtCode = raw.districtCode === undefined || raw.districtCode === null ? null
      : typeof raw.districtCode === 'number' && Number.isInteger(raw.districtCode) && raw.districtCode > 0 ? raw.districtCode : -1;
    if (districtCode === -1) throw badRequest('GROWTH_DISTRICT_INVALID', correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.addArea, correlationId);
    const organizationId = await this.platform(correlationId);
    const areaId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await this.lockLiveRegion(tx, id, correlationId);
      if (districtCode !== null) {
        const district = await tx.execute(sql`SELECT state_code FROM growth_districts WHERE lgd_code = ${districtCode}`) as QueryResult<{ state_code: string }>;
        if (!district.rows[0]) throw notFound('GROWTH_DISTRICT_NOT_FOUND', correlationId);
        if (district.rows[0].state_code !== stateCode) throw badRequest('GROWTH_DISTRICT_STATE_MISMATCH', correlationId);
      }
      // The same lock the database trigger takes, so this check and the insert see one state.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`growth_region_area:${stateCode}`}))`);
      const live = await tx.execute(sql`
        SELECT region_id, state_code, district_code FROM growth_region_areas WHERE state_code = ${stateCode} AND removed_at IS NULL
      `) as QueryResult<{ region_id: string; state_code: string; district_code: number | null }>;
      const refusal = refuseGrowthArea({ regionId: id, stateCode, districtCode },
        live.rows.map((row): GrowthRegionArea => ({ regionId: row.region_id, stateCode: row.state_code, districtCode: row.district_code === null ? null : Number(row.district_code) })));
      if (refusal) throw conflict(refusal, correlationId);
      await tx.execute(sql`
        INSERT INTO growth_region_areas (id, region_id, state_code, district_code, added_by_user_id, reason_code)
        VALUES (${areaId}::uuid, ${id}::uuid, ${stateCode}, ${districtCode}, ${actor.userId}::uuid, ${reasonCode})
      `);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.region_area.added', resourceType: 'growth_region_area', resourceId: areaId,
        organizationId, correlationId, context: { regionId: id, stateCode, districtCode, reasonCode } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_region_area', aggregateId: areaId, eventType: 'growth.region_area.added',
        payload: { regionId: id, stateCode, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { unique: 'GROWTH_AREA_TAKEN', messages: areaMessages }); });
    return { area: { id: areaId, regionId: id, stateCode, districtCode, reasonCode }, correlationId };
  }

  @Post('/regions/:regionId/areas/:areaId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeArea(@Req() request: ProtectedHttpRequest, @Param('regionId') regionId: string, @Param('areaId') areaParam: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = readUuid(regionId, correlationId);
    const areaId = readUuid(areaParam, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.removeArea, correlationId);
    const organizationId = await this.platform(correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT state_code, district_code, removed_at FROM growth_region_areas WHERE id = ${areaId}::uuid AND region_id = ${id}::uuid FOR UPDATE
      `) as QueryResult<{ state_code: string; district_code: number | null; removed_at: Date | null }>;
      const area = found.rows[0];
      if (!area) throw notFound('GROWTH_AREA_NOT_FOUND', correlationId);
      if (area.removed_at) throw conflict('GROWTH_AREA_ALREADY_REMOVED', correlationId);
      await tx.execute(sql`
        UPDATE growth_region_areas SET removed_at = now(), removed_by_user_id = ${actor.userId}::uuid, removed_reason_code = ${reasonCode}
        WHERE id = ${areaId}::uuid AND removed_at IS NULL
      `);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.region_area.removed', resourceType: 'growth_region_area', resourceId: areaId,
        organizationId, correlationId, context: { regionId: id, stateCode: area.state_code, districtCode: area.district_code, reasonCode } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_region_area', aggregateId: areaId, eventType: 'growth.region_area.removed',
        payload: { regionId: id, stateCode: area.state_code, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { area: { id: areaId, removed: true, reasonCode }, correlationId };
  }

  @Post('/regions/:regionId/assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assign(@Req() request: ProtectedHttpRequest, @Param('regionId') regionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = readUuid(regionId, correlationId);
    const raw = readObject(body, ['membershipId', 'role', 'reasonCode'], correlationId);
    const membershipId = readUuid(raw.membershipId, correlationId);
    if (!isGrowthAssignmentRole(raw.role)) throw badRequest('GROWTH_ASSIGNMENT_ROLE_INVALID', correlationId);
    const role = raw.role;
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.startAssignment, correlationId);
    const organizationId = await this.platform(correlationId);
    const assignmentId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      await this.lockLiveRegion(tx, id, correlationId);
      const target = await this.lockTarget(tx, membershipId, actor, correlationId);
      if ((role === 'EXECUTIVE') !== (target.role === 'GROWTH_EXECUTIVE')) throw badRequest('GROWTH_ASSIGNMENT_ROLE_MISMATCH', correlationId);
      const existing = await tx.execute(sql`
        SELECT 1 FROM growth_territory_assignments WHERE region_id = ${id}::uuid AND membership_id = ${membershipId}::uuid AND ended_at IS NULL
      `) as QueryResult<unknown>;
      if (existing.rows.length) throw conflict('GROWTH_ASSIGNMENT_EXISTS', correlationId);
      await tx.execute(sql`
        INSERT INTO growth_territory_assignments (id, region_id, membership_id, assignment_role, assigned_by_user_id, reason_code)
        VALUES (${assignmentId}::uuid, ${id}::uuid, ${membershipId}::uuid, ${role}, ${actor.userId}::uuid, ${reasonCode})
      `);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.territory_assignment.started', resourceType: 'growth_territory_assignment',
        resourceId: assignmentId, organizationId, correlationId, context: { regionId: id, membershipId, role, reasonCode, targetUserId: target.user_id } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_territory_assignment', aggregateId: assignmentId, eventType: 'growth.territory_assignment.started',
        payload: { regionId: id, membershipId, role, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { unique: 'GROWTH_ASSIGNMENT_EXISTS', messages: { 'needs a live region': 'GROWTH_REGION_RETIRED' } }); });
    return { assignment: { id: assignmentId, regionId: id, membershipId, role, reasonCode }, correlationId };
  }

  @Post('/regions/:regionId/assignments/:assignmentId/end')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async endAssignment(@Req() request: ProtectedHttpRequest, @Param('regionId') regionId: string, @Param('assignmentId') assignmentParam: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = readUuid(regionId, correlationId);
    const assignmentId = readUuid(assignmentParam, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.endAssignment, correlationId);
    const organizationId = await this.platform(correlationId);
    await this.db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT a.membership_id, a.assignment_role, a.ended_at, m.user_id
        FROM growth_territory_assignments a JOIN organization_memberships m ON m.id = a.membership_id
        WHERE a.id = ${assignmentId}::uuid AND a.region_id = ${id}::uuid FOR UPDATE OF a
      `) as QueryResult<{ membership_id: string; assignment_role: string; ended_at: Date | null; user_id: string }>;
      const assignment = found.rows[0];
      if (!assignment) throw notFound('GROWTH_ASSIGNMENT_NOT_FOUND', correlationId);
      if (assignment.ended_at) throw conflict('GROWTH_ASSIGNMENT_ALREADY_ENDED', correlationId);
      if (assignment.user_id === actor.userId) throw forbidden('GROWTH_SELF_CHANGE_REFUSED', correlationId);
      await tx.execute(sql`
        UPDATE growth_territory_assignments SET ended_at = now(), ended_by_user_id = ${actor.userId}::uuid, ended_reason_code = ${reasonCode}
        WHERE id = ${assignmentId}::uuid AND ended_at IS NULL
      `);
      await writeGrowthAudit(tx, { id: this.ids.uuid(), actorUserId: actor.userId, action: 'growth.territory_assignment.ended', resourceType: 'growth_territory_assignment',
        resourceId: assignmentId, organizationId, correlationId,
        context: { regionId: id, membershipId: assignment.membership_id, role: assignment.assignment_role, reasonCode, targetUserId: assignment.user_id } });
      await writeGrowthOutbox(tx, { id: this.ids.uuid(), aggregateType: 'growth_territory_assignment', aggregateId: assignmentId, eventType: 'growth.territory_assignment.ended',
        payload: { regionId: id, membershipId: assignment.membership_id, role: assignment.assignment_role, reasonCode }, actorUserId: actor.userId, organizationId, correlationId });
    }).catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { assignment: { id: assignmentId, ended: true, reasonCode }, correlationId };
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canAdministerGrowthTerritory(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  private async platform(correlationId: string): Promise<string> {
    const id = await platformOrganizationId(this.db);
    if (!id) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return id;
  }

  private async lockLiveRegion(tx: PersistenceDb, regionId: string, correlationId: string): Promise<void> {
    const found = await tx.execute(sql`SELECT retired_at FROM growth_regions WHERE id = ${regionId}::uuid FOR UPDATE`) as QueryResult<{ retired_at: Date | null }>;
    if (!found.rows[0]) throw notFound('GROWTH_REGION_NOT_FOUND', correlationId);
    if (found.rows[0].retired_at) throw conflict('GROWTH_REGION_RETIRED', correlationId);
  }

  private async lockTarget(tx: PersistenceDb, membershipId: string, actor: Actor, correlationId: string): Promise<{ readonly user_id: string; readonly role: string }> {
    const found = await tx.execute(sql`
      SELECT m.user_id, m.role, m.state::text AS state, o.kind::text AS organization_kind
      FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.id = ${membershipId}::uuid FOR SHARE OF m
    `) as QueryResult<{ user_id: string; role: string; state: string; organization_kind: string }>;
    const row = found.rows[0];
    if (!row) throw notFound('GROWTH_MEMBER_NOT_FOUND', correlationId);
    const refusal = refuseGrowthTeamChange({ actor, target: { userId: row.user_id, role: row.role, state: row.state, organizationKind: row.organization_kind } });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal === 'GROWTH_SELF_CHANGE_REFUSED') throw forbidden(refusal, correlationId);
    if (refusal === 'MEMBERSHIP_NOT_ACTIVE') throw conflict(refusal, correlationId);
    if (refusal) throw badRequest(refusal, correlationId);
    return row;
  }
}

function readUpload(body: unknown, commit: boolean, correlationId: string): {
  readonly filename: string; readonly content: string; readonly previewDigest?: string; readonly reasonCode?: string;
} {
  const raw = readObject(body, commit ? ['filename', 'content', 'previewDigest', 'reasonCode'] : ['filename', 'content'], correlationId);
  if (typeof raw.content !== 'string' || raw.content.length === 0) throw badRequest('IMPORT_FILE_EMPTY', correlationId);
  if (raw.content.length > GROWTH_DISTRICT_IMPORT_MAX_CHARACTERS) throw badRequest('IMPORT_FILE_TOO_LARGE', correlationId);
  const filename = raw.filename === undefined || raw.filename === null || raw.filename === '' ? 'districts.csv'
    : typeof raw.filename === 'string' && raw.filename.trim().length <= GROWTH_DISTRICT_IMPORT_FILENAME_MAX ? raw.filename.trim() : null;
  if (!filename) throw badRequest('IMPORT_FILENAME_INVALID', correlationId);
  if (!commit) return { filename, content: raw.content };
  if (typeof raw.previewDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.previewDigest)) throw badRequest('PREVIEW_DIGEST_REQUIRED', correlationId);
  const reasonCode = readReason(raw.reasonCode, growthTerritoryReasons.importDistricts, correlationId);
  return { filename, content: raw.content, previewDigest: raw.previewDigest, reasonCode };
}
