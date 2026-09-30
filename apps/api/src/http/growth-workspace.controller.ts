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
 */
import { Controller, ForbiddenException, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { growthWorkspaceRole, isGrowthRole } from '@planthepath/authorization/src/index.js';
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
    return {
      role,
      staffType: staffType.rows[0]?.staff_type ?? null,
      teams: teams.rows.map((row) => ({
        team: row.team,
        joinedAt: new Date(row.joined_at).toISOString(),
        manager: row.manager_email ? { email: row.manager_email } : null,
      })),
      correlationId: context.correlationId,
    };
  }
}
