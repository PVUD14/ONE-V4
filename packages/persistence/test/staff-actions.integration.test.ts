/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Verify migration replay, staff-action storage and local database integrity.
 * Fixtures roll back per test; no pending application policy is implemented.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);
let client: PoolClient;
let institutionId: string;
let actorId: string;
let studentId: string;
let membershipId: string;
let relationshipId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  institutionId = randomUUID();
  actorId = randomUUID();
  studentId = randomUUID();
  membershipId = randomUUID();
  relationshipId = randomUUID();
  for (const id of [actorId, studentId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, id + '@example.test']);
  }
  await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'C3 local test institution')", [institutionId]);
  await client.query(
    `INSERT INTO organization_memberships
      (id, organization_id, user_id, role, state, scope_organization_id, scope_institution_id)
     VALUES ($1, $2, $3, 'FACULTY_LECTURER', 'ACTIVE', $2, $2)`,
    [membershipId, institutionId, actorId],
  );
  await client.query(
    `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from)
     VALUES ($1, $2, $3, 'ACTIVE', now())`,
    [relationshipId, institutionId, studentId],
  );
});

afterEach(async () => {
  try { await client.query('ROLLBACK'); } finally { client.release(); }
});
afterAll(async () => pool.end());

async function insertAction(overrides: Record<string, unknown> = {}) {
  const record: Record<string, unknown> = {
    id: randomUUID(), institution_id: institutionId,
    subject_student_user_id: studentId, institution_relationship_id: relationshipId,
    actor_user_id: actorId, actor_membership_id: membershipId,
    action_type: 'INTERVENTION', title: 'Local test follow-up', updated_by_user_id: actorId,
    ...overrides,
  };
  const keys = Object.keys(record);
  return client.query(
    `INSERT INTO staff_actions (${keys.join(', ')}) VALUES (${keys.map((_, index) => '$' + (index + 1)).join(', ')}) RETURNING *`,
    Object.values(record),
  );
}

describe('Stream C staff_actions migration', () => {
  it('stores defaults and preserves an existing record when migration 0020 is replayed', async () => {
    const original = (await insertAction()).rows[0];
    expect(original).toMatchObject({ state: 'DRAFT', visibility: 'STAFF_ONLY', version: 1 });
    expect(original.created_at).toBeInstanceOf(Date);
    expect(original.updated_at).toEqual(original.created_at);
    await client.query(await readFile(new URL('0020_staff_actions.sql', migrationDir), 'utf8'));
    expect((await client.query('SELECT * FROM staff_actions WHERE id = $1', [original.id])).rows[0]).toEqual(original);
  });

  it('stores all five action types in the same table with optional workflow references', async () => {
    for (const actionType of ['INTERVENTION', 'ASSIGNED_TASK', 'FACULTY_NOTE', 'ACADEMIC_VERIFICATION', 'MEETING']) {
      const row = (await insertAction({
        action_type: actionType, subject_student_user_id: null, institution_relationship_id: null,
      })).rows[0];
      expect(row.action_type).toBe(actionType);
      expect(row.assigned_to_membership_id).toBeNull();
      expect(row.evidence_document_version_id).toBeNull();
    }
  });

  it('stores a scheduled meeting with responsible staff and review provenance', async () => {
    const row = (await insertAction({
      action_type: 'MEETING', assigned_to_membership_id: membershipId,
      scheduled_start_at: '2026-09-07T09:00:00Z', scheduled_end_at: '2026-09-07T10:00:00Z',
      last_reviewed_by_user_id: actorId, last_reviewed_at: '2026-09-06T10:00:00Z',
      state: 'OPEN', visibility: 'SUBJECT_VISIBLE',
    })).rows[0];
    expect(row.scheduled_end_at.getTime() - row.scheduled_start_at.getTime()).toBe(3_600_000);
    expect(row.last_reviewed_by_user_id).toBe(actorId);
  });

  it.each([
    ['action_type', 'UNKNOWN', 'staff_actions_type_ck'],
    ['state', 'UNKNOWN', 'staff_actions_state_ck'],
    ['visibility', 'PUBLIC', 'staff_actions_visibility_ck'],
    ['version', 0, 'staff_actions_version_ck'],
    ['scheduled_start_at', '2026-09-07T09:00:00Z', 'staff_actions_meeting_pair_ck'],
    ['scheduled_end_at', '2026-09-07T10:00:00Z', 'staff_actions_meeting_pair_ck'],
    ['last_reviewed_at', '2026-09-06T10:00:00Z', 'staff_actions_reviewer_pair_ck'],
  ])('rejects invalid local integrity for %s', async (column, value, constraint) => {
    await expect(insertAction({ [column]: value })).rejects.toMatchObject({ code: '23514', constraint });
  });

  it('rejects reviewer identity without review time', async () => {
    await expect(insertAction({ last_reviewed_by_user_id: actorId })).rejects.toMatchObject({
      code: '23514', constraint: 'staff_actions_reviewer_pair_ck',
    });
  });

  it.each(['2026-09-07T09:00:00Z', '2026-09-07T08:00:00Z'])('rejects a meeting ending at %s before or at its start', async (end) => {
    await expect(insertAction({
      scheduled_start_at: '2026-09-07T09:00:00Z', scheduled_end_at: end,
    })).rejects.toMatchObject({ code: '23514', constraint: 'staff_actions_meeting_window_ck' });
  });

  it('rejects an update timestamp earlier than creation', async () => {
    await expect(insertAction({
      created_at: '2026-09-07T10:00:00Z', updated_at: '2026-09-07T09:00:00Z',
    })).rejects.toMatchObject({ code: '23514', constraint: 'staff_actions_updated_at_ck' });
  });

  it.each(['department_unit_id', 'batch_unit_id'])('rejects a %s from another institution using existing composite keys', async (column) => {
    const otherInstitutionId = randomUUID();
    const unitId = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'Other local test institution')", [otherInstitutionId]);
    await client.query("INSERT INTO institution_units (id, institution_id, kind, name) VALUES ($1, $2, 'DEPARTMENT', 'Local test unit')", [unitId, otherInstitutionId]);
    await expect(insertAction({ [column]: unitId })).rejects.toMatchObject({ code: '23503' });
  });

  it.each(['source_exam_assignment_id', 'evidence_document_version_id'])('rejects a nonexistent %s', async (column) => {
    await expect(insertAction({ [column]: randomUUID() })).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the action when its referenced staff membership cannot be deleted', async () => {
    await insertAction();
    await client.query('SAVEPOINT deletion_check');
    await expect(client.query('DELETE FROM organization_memberships WHERE id = $1', [membershipId])).rejects.toMatchObject({ code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT deletion_check');
    expect((await client.query('SELECT count(*)::integer AS count FROM staff_actions WHERE actor_membership_id = $1', [membershipId])).rows[0].count).toBe(1);
  });
});
