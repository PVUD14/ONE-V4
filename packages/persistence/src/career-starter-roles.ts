/**
 * The starter career roles and their requirements (data/careers/starter-v1.json), as a
 * function. `db:seed:careers` runs it from the command line; the sandbox seed (ADR-046)
 * calls it directly so the sandbox's catalogue is the real one.
 *
 * Idempotent: rerunning updates titles and requirements in place rather than duplicating
 * them. A requirement whose topic is not in the published taxonomy is reported and
 * skipped rather than failing, so the catalogue can be written ahead of the content.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface CareerRequirementInput {
  readonly topic: string;
  readonly level: 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';
  readonly targetMastery: number;
  readonly rationale?: string;
}

export interface CareerRoleInput {
  readonly code: string;
  readonly title: string;
  readonly family: string;
  readonly summary?: string;
  readonly requirements: readonly CareerRequirementInput[];
}

/** Deterministic ids so a rerun addresses the same rows without storing a mapping. */
export function deterministicId(namespace: string, key: string): string {
  const hash = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

export async function seedStarterCareerRoles(pool: Pool, roles: readonly CareerRoleInput[]): Promise<{
  readonly roles: number; readonly requirements: number; readonly skippedMissingTopics: readonly string[];
}> {
  const topics = await pool.query<{ id: string; stable_key: string }>(
    `SELECT DISTINCT ON (stable_key) id, stable_key FROM taxonomy_nodes
     WHERE kind = 'TOPIC' AND active ORDER BY stable_key, version DESC`,
  );
  const topicByKey = new Map(topics.rows.map((row) => [row.stable_key, row.id]));

  let rolesSeeded = 0;
  let requirementsSeeded = 0;
  const skipped: string[] = [];

  for (const role of roles) {
    const roleId = deterministicId('career-role', role.code);
    await pool.query(
      `INSERT INTO career_roles (id, code, title, family, summary, active)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, family = EXCLUDED.family,
         summary = EXCLUDED.summary, active = true, updated_at = now()`,
      [roleId, role.code, role.title, role.family, role.summary ?? null],
    );
    rolesSeeded += 1;

    for (const requirement of role.requirements) {
      const topicId = topicByKey.get(requirement.topic);
      if (!topicId) {
        skipped.push(`${role.code}:${requirement.topic}`);
        continue;
      }
      await pool.query(
        `INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery, rationale)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (career_role_id, topic_id) DO UPDATE SET
           requirement_level = EXCLUDED.requirement_level,
           target_mastery = EXCLUDED.target_mastery,
           rationale = EXCLUDED.rationale`,
        [deterministicId('career-requirement', `${role.code}:${requirement.topic}`), roleId, topicId, requirement.level, requirement.targetMastery, requirement.rationale ?? null],
      );
      requirementsSeeded += 1;
    }
  }
  // Named rather than counted: a silently thin catalogue would make the gap analysis
  // look complete when it is not.
  return { roles: rolesSeeded, requirements: requirementsSeeded, skippedMissingTopics: skipped };
}
