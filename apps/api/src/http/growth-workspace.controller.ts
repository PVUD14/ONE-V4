/**
 * The Growth workspace's own read (GROWTH-01, ADR-040).
 *
 * `GET /api/v1/growth/me` tells a signed-in growth person which growth role they work in,
 * the teams they are on (with their manager) and their own staff type — the only facts the
 * Growth portal has in GROWTH-01. Everything else on the portal is not built yet and says so.
 *
 * Only an ACTIVE growth membership admits the caller. An operator, even a super admin, is
 * refused: growth administration lives in Operations → Settings, not here. Nothing here
 * returns a student, an amount or another person's data beyond their manager's email.
 *
 * GROWTH-02: `GET /api/v1/growth/territory` — the regions the person works today, from the one
 * scope function (`growthScopeFor`), each with its areas and its people: a manager sees everyone
 * assigned to their regions; an executive sees the region's managers, so they know whom to ask.
 *
 * GROWTH-03: `/me` carries the count of open leads the person owns and `/territory` the count of
 * open, unowned, contactable leads in each region (from the lead register, in scope).
 *
 * GROWTH-06: `/me` carries the person's visits this IST month and their follow-ups due today or
 * earlier (from the field log).
 */
import { Controller, ForbiddenException, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { growthWorkspaceRole, isGrowthRole } from '@planthepath/authorization/src/index.js';
import { leadCounts, loadGrowthLeadCaller } from './growth-leads-service.js';
import { myFieldCounts } from './growth-field-service.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';

type QueryResult<T> = { rows: T[] };

@Controller('/api/v1/growth')
export class GrowthWorkspaceController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/me')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async me(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const memberships = context.authorization.memberships;
    const role = growthWorkspaceRole(memberships);
    if (!role) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const growthIds = memberships.filter((membership) => membership.state === 'ACTIVE' && isGrowthRole(membership.role)).map((membership) => membership.id);
    const workingId = memberships.find((membership) => membership.state === 'ACTIVE' && membership.role === role)!.id;
    const idList = sql.join(growthIds.map((id) => sql`${id}::uuid`), sql`, `);
    const teams = await this.db.execute(sql`
      SELECT t.team, min(t.joined_at) AS joined_at, (array_agg(mu.email ORDER BY t.joined_at DESC))[1] AS manager_email
      FROM growth_team_members t
      JOIN organization_memberships m ON m.id = t.membership_id AND m.state = 'ACTIVE'
      LEFT JOIN organization_memberships mm ON mm.id = t.manager_membership_id
      LEFT JOIN users mu ON mu.id = mm.user_id
      WHERE t.left_at IS NULL AND t.membership_id IN (${idList})
      GROUP BY t.team
      ORDER BY t.team
    `) as QueryResult<{ team: string; joined_at: Date | string; manager_email: string | null }>;
    const staffType = await this.db.execute(sql`
      SELECT staff_type FROM growth_staff_types WHERE membership_id = ${workingId}::uuid AND ended_at IS NULL
    `) as QueryResult<{ staff_type: string }>;
    const counts = await leadCounts(this.db, await loadGrowthLeadCaller(this.db, { userId: context.authorization.principal.userId, growthAdmin: false }));
    const field = await myFieldCounts(this.db, growthIds);
    return {
      role,
      staffType: staffType.rows[0]?.staff_type ?? null,
      openLeads: counts.ownedOpen,
      // GROWTH-06: the person's own visits this IST month, and open follow-ups due today or earlier.
      visitsThisMonth: field.visitsThisMonth,
      followUpsDue: field.followUpsDue,
      teams: teams.rows.map((row) => ({
        team: row.team,
        joinedAt: new Date(row.joined_at).toISOString(),
        manager: row.manager_email ? { email: row.manager_email } : null,
      })),
      correlationId: context.correlationId,
    };
  }

  @Get('/territory')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async territory(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const role = growthWorkspaceRole(context.authorization.memberships);
    if (!role) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const caller = await loadGrowthLeadCaller(this.db, { userId: context.authorization.principal.userId, growthAdmin: false });
    const scope = caller.scope;
    const regionIds = scope.kind === 'PERSON' ? scope.workingRegionIds : [];
    const counts = await leadCounts(this.db, caller);
    if (!regionIds.length) return { role, regions: [], correlationId: context.correlationId };
    const idList = sql.join(regionIds.map((id) => sql`${id}::uuid`), sql`, `);
    const regions = await this.db.execute(sql`SELECT id, name FROM growth_regions WHERE id IN (${idList}) ORDER BY lower(name), id`) as QueryResult<{ id: string; name: string }>;
    const areas = await this.db.execute(sql`
      SELECT a.region_id, a.state_code, s.name AS state_name, a.district_code, d.name AS district_name
      FROM growth_region_areas a JOIN growth_states s ON s.code = a.state_code LEFT JOIN growth_districts d ON d.lgd_code = a.district_code
      WHERE a.removed_at IS NULL AND a.region_id IN (${idList})
      ORDER BY s.name, d.name NULLS FIRST
    `) as QueryResult<{ region_id: string; state_code: string; state_name: string; district_code: number | null; district_name: string | null }>;
    const people = await this.db.execute(sql`
      SELECT a.region_id, a.membership_id, a.assignment_role, a.starts_at, u.email, (m.user_id = ${context.authorization.principal.userId}::uuid) AS is_self
      FROM growth_territory_assignments a
      JOIN organization_memberships m ON m.id = a.membership_id AND m.state = 'ACTIVE'
      JOIN users u ON u.id = m.user_id
      WHERE a.ended_at IS NULL AND a.region_id IN (${idList})
      ORDER BY a.assignment_role DESC, u.email
    `) as QueryResult<{ region_id: string; membership_id: string; assignment_role: string; starts_at: Date | string; email: string; is_self: boolean }>;
    return {
      role,
      regions: regions.rows.map((region) => {
        const mine = people.rows.filter((row) => row.region_id === region.id && row.is_self);
        const myRole = mine.some((row) => row.assignment_role === 'MANAGER') ? 'MANAGER' : 'EXECUTIVE';
        const visiblePeople = people.rows.filter((row) => row.region_id === region.id && !row.is_self
          && (myRole === 'MANAGER' || row.assignment_role === 'MANAGER'));
        return {
          id: region.id,
          name: region.name,
          myRole,
          since: mine.length ? new Date(mine.map((row) => new Date(row.starts_at).getTime()).sort((a, b) => a - b)[0]!).toISOString() : null,
          areas: areas.rows.filter((area) => area.region_id === region.id).map((area) => ({
            stateCode: area.state_code, stateName: area.state_name,
            districtCode: area.district_code === null ? null : Number(area.district_code), districtName: area.district_name,
          })),
          people: visiblePeople.map((row) => ({ email: row.email, role: row.assignment_role, since: new Date(row.starts_at).toISOString() })),
          unownedLeads: counts.unownedByRegion[region.id] ?? 0,
        };
      }),
      correlationId: context.correlationId,
    };
  }
}
