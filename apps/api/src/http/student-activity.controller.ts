import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };

/**
 * Learner activity feed for streaks and weekly progress. Aggregated counts
 * only, derived from real learning actions (lesson completions and assessment
 * attempts) - never logins or page views, so a streak always means actual
 * learning activity. Advisory and learner-facing; never employer-visible.
 */
@Controller('/api/v1/student')
export class StudentActivityController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/activity')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async activity(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const userId = context.authorization.principal.userId;

    const todayRow = await this.db.execute(sql`SELECT CURRENT_DATE::text AS today`) as QueryResult<{ today: string }>;
    const today = todayRow.rows[0]?.today ?? new Date().toISOString().slice(0, 10);

    const counts = await this.db.execute(sql`
      SELECT occurred_on::text AS day, count(*)::int AS n
      FROM learner_activity_events
      WHERE user_id = ${userId}::uuid AND occurred_on >= CURRENT_DATE - 27
      GROUP BY occurred_on
      ORDER BY occurred_on
    `) as QueryResult<{ day: string; n: number }>;

    const activeDays = await this.db.execute(sql`
      SELECT DISTINCT occurred_on::text AS day
      FROM learner_activity_events
      WHERE user_id = ${userId}::uuid AND occurred_on >= CURRENT_DATE - 365
      ORDER BY day DESC
    `) as QueryResult<{ day: string }>;

    // Streak: consecutive active days ending today, or ending yesterday when
    // today has no activity yet (today's inactivity does not break it early).
    const active = new Set(activeDays.rows.map((row) => row.day));
    const dayMs = 24 * 60 * 60 * 1000;
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    let cursor = todayMs;
    if (!active.has(today)) cursor -= dayMs;
    let currentStreakDays = 0;
    while (active.has(new Date(cursor).toISOString().slice(0, 10))) {
      currentStreakDays += 1;
      cursor -= dayMs;
    }

    const last7: { readonly date: string; readonly count: number }[] = [];
    const byDay = new Map(counts.rows.map((row) => [row.day, row.n]));
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(todayMs - offset * dayMs).toISOString().slice(0, 10);
      last7.push({ date, count: byDay.get(date) ?? 0 });
    }

    return {
      today,
      currentStreakDays,
      activeDaysLast7: last7.filter((entry) => entry.count > 0).length,
      last7,
      days: counts.rows.map((row) => ({ date: row.day, count: row.n })),
      correlationId: context.correlationId,
    };
  }
}
