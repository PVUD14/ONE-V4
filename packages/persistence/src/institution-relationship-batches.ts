/**
 * Year-end batch actions (INST-10): graduate, transfer or end the relationships of a batch or a
 * list of roll numbers, previewed first and committed all or nothing.
 *
 * The preview stores nothing but an audit row; it returns every evaluated student and a digest
 * over them. Commit re-evaluates inside one transaction under a per-institution lock and writes
 * only when nothing is invalid and the digest still matches what the admin was shown — the same
 * guarantee the roster import gets from a stored preview, with nothing stored (the academic
 * results import does the same). Each changed student gets the per-student endpoint's writes:
 * relationship, roster status, pending invitations revoked, an `institution.relationship.ended`
 * audit row and outbox event. Accounts, consents, documents and records are never touched.
 * Design: docs/architecture/institution-batch-lifecycle-design.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  institutionUnitDescendants,
  narrowInstitutionStudentScope,
  relationshipBatchMaxStudents,
  type InstitutionStudentScope,
  type RelationshipBatchState,
} from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql, loadInstitutionUnitTree } from './institution-scope.js';
import { revokePendingStudentInvitations } from './student-invitations.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export type RelationshipBatchTarget =
  | { readonly unitId: string }
  | { readonly institutionStudentIds: readonly string[] };

export type RelationshipBatchOutcome = 'CHANGE' | 'UNCHANGED' | 'INVALID';

export interface RelationshipBatchRow {
  readonly institutionStudentId: string;
  readonly fullName: string | null;
  readonly studentProfileId: string | null;
  readonly currentState: string | null;
  readonly outcome: RelationshipBatchOutcome;
  readonly issues: readonly string[];
}

export interface RelationshipBatchEvaluation {
  readonly state: RelationshipBatchState;
  readonly effectiveTo: string | null;
  readonly rows: readonly RelationshipBatchRow[];
  readonly counts: { readonly change: number; readonly unchanged: number; readonly invalid: number };
  readonly digest: string;
}

interface EvaluatedStudent extends RelationshipBatchRow {
  readonly studentUserId: string | null;
  readonly relationshipId: string | null;
  readonly effectiveFrom: string | null;
}

export class RelationshipBatchRejected extends Error {
  constructor(readonly code: 'EFFECTIVE_DATE_IN_FUTURE' | 'UNIT_ID_INVALID' | 'BATCH_TOO_LARGE' | 'BATCH_HAS_INVALID_ROWS'
    | 'BATCH_PREVIEW_STALE' | 'NOTHING_TO_CHANGE', readonly evaluation?: RelationshipBatchEvaluation) {
    super(code);
    this.name = 'RelationshipBatchRejected';
  }
}

export interface RelationshipBatchInput {
  readonly institutionId: string;
  readonly scope: InstitutionStudentScope;
  readonly state: RelationshipBatchState;
  readonly target: RelationshipBatchTarget;
  /** ISO date-time, or null for "now" by the database clock. */
  readonly effectiveTo: string | null;
}

type ProfileRow = {
  profile_id: string; student_user_id: string; institution_student_id: string; full_name: string;
  relationship_id: string | null; relationship_state: string | null; effective_from: Date | null; effective_to: Date | null;
  starts_after_end: boolean | null;
};

/**
 * Evaluate a batch: one row per targeted student, in roll-number order, with the digest the
 * commit must match. Also returns the resolved end time (the database's, when none was given).
 */
export async function evaluateRelationshipBatch(
  tx: PersistenceDb,
  input: RelationshipBatchInput,
): Promise<{ readonly evaluation: RelationshipBatchEvaluation; readonly students: readonly EvaluatedStudent[]; readonly endsAt: Date }> {
  const clock = await tx.execute(sql`
    SELECT COALESCE(${input.effectiveTo}::timestamptz, now()) AS ends_at,
           COALESCE(${input.effectiveTo}::timestamptz > now(), false) AS future
  `) as QueryResult<{ ends_at: Date; future: boolean }>;
  const { ends_at: endsAt, future } = clock.rows[0]!;
  if (future) throw new RelationshipBatchRejected('EFFECTIVE_DATE_IN_FUTURE');
  const endsAtIso = new Date(endsAt).toISOString();

  // The latest relationship per profile; `current` only when it is open and active.
  const select = (where: SQL) => sql`
    SELECT sp.id AS profile_id, sp.student_user_id, sp.institution_student_id, sp.full_name,
           ir.id AS relationship_id, ir.state::text AS relationship_state, ir.effective_from, ir.effective_to,
           (ir.effective_from >= ${endsAtIso}::timestamptz) AS starts_after_end
    FROM institution_student_profiles sp
    LEFT JOIN LATERAL (
      SELECT id, state, effective_from, effective_to FROM institution_relationships
      WHERE institution_id = sp.institution_id AND student_user_id = sp.student_user_id
      ORDER BY (state IN ('ACTIVE', 'VERIFIED') AND effective_to IS NULL) DESC, effective_from DESC
      LIMIT 1
    ) ir ON true
    WHERE sp.institution_id = ${input.institutionId}::uuid AND ${where}
    ORDER BY lower(sp.institution_student_id), sp.id
  `;

  let profiles: ProfileRow[];
  const missing: string[] = [];
  if ('unitId' in input.target) {
    const unit = await tx.execute(sql`SELECT id FROM institution_units WHERE id = ${input.target.unitId}::uuid AND institution_id = ${input.institutionId}::uuid`) as QueryResult<{ id: string }>;
    if (!unit.rows[0]) throw new RelationshipBatchRejected('UNIT_ID_INVALID');
    const tree = await loadInstitutionUnitTree(tx, input.institutionId);
    const narrowed = narrowInstitutionStudentScope(input.scope, institutionUnitDescendants(input.target.unitId, tree));
    const found = await tx.execute(select(sql`${institutionStudentScopeSql(narrowed, 'sp')}`)) as QueryResult<ProfileRow>;
    profiles = found.rows;
  } else {
    const wanted = new Map<string, string>();
    for (const raw of input.target.institutionStudentIds) {
      const id = raw.trim();
      if (id && !wanted.has(id.toLowerCase())) wanted.set(id.toLowerCase(), id);
    }
    const keys = [...wanted.keys()];
    profiles = keys.length === 0 ? [] : (await tx.execute(select(sql`lower(sp.institution_student_id) IN (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})
      AND ${institutionStudentScopeSql(input.scope, 'sp')}`)) as QueryResult<ProfileRow>).rows;
    const seen = new Set(profiles.map((row) => row.institution_student_id.toLowerCase()));
    for (const [key, id] of wanted) if (!seen.has(key)) missing.push(id);
  }
  if (profiles.length + missing.length > relationshipBatchMaxStudents) throw new RelationshipBatchRejected('BATCH_TOO_LARGE');

  const students: EvaluatedStudent[] = profiles.map((row) => {
    const current = row.relationship_id !== null && ['ACTIVE', 'VERIFIED'].includes(row.relationship_state ?? '') && row.effective_to === null;
    const issues = current && row.starts_after_end ? ['EFFECTIVE_BEFORE_START'] : [];
    const outcome: RelationshipBatchOutcome = !current ? 'UNCHANGED' : issues.length ? 'INVALID' : 'CHANGE';
    return {
      institutionStudentId: row.institution_student_id, fullName: row.full_name, studentProfileId: row.profile_id,
      currentState: row.relationship_state, outcome, issues,
      studentUserId: row.student_user_id, relationshipId: current ? row.relationship_id : null,
      effectiveFrom: row.effective_from ? new Date(row.effective_from).toISOString() : null,
    };
  });
  // Not found and out of scope read the same, so the preview cannot be used to probe scope.
  for (const id of missing.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    students.push({ institutionStudentId: id, fullName: null, studentProfileId: null, currentState: null, outcome: 'INVALID',
      issues: ['STUDENT_NOT_FOUND'], studentUserId: null, relationshipId: null, effectiveFrom: null });
  }

  const digest = createHash('sha256').update(JSON.stringify({
    institutionId: input.institutionId, state: input.state, effectiveTo: input.effectiveTo,
    rows: students.map((row) => [row.institutionStudentId, row.studentProfileId, row.relationshipId, row.currentState, row.effectiveFrom, row.outcome, row.issues]),
  })).digest('hex');
  const rows: RelationshipBatchRow[] = students.map(({ institutionStudentId, fullName, studentProfileId, currentState, outcome, issues }) =>
    ({ institutionStudentId, fullName, studentProfileId, currentState, outcome, issues }));
  const evaluation: RelationshipBatchEvaluation = {
    state: input.state, effectiveTo: input.effectiveTo, rows, digest,
    counts: {
      change: rows.filter((row) => row.outcome === 'CHANGE').length,
      unchanged: rows.filter((row) => row.outcome === 'UNCHANGED').length,
      invalid: rows.filter((row) => row.outcome === 'INVALID').length,
    },
  };
  return { evaluation, students, endsAt: new Date(endsAt) };
}

/** Preview: evaluate and record that the admin looked, nothing else. */
export async function previewRelationshipBatch(
  db: PersistenceDb,
  input: RelationshipBatchInput & { readonly actorUserId: string; readonly correlationId: string },
): Promise<RelationshipBatchEvaluation> {
  return db.transaction(async (tx) => {
    const { evaluation } = await evaluateRelationshipBatch(tx, input);
    await audit(tx, input, 'institution.relationship_batch.previewed', 'institution_relationship_batch', randomUUID(), {
      state: input.state, target: targetKind(input.target), effectiveTo: input.effectiveTo, digest: evaluation.digest, counts: evaluation.counts,
    });
    return evaluation;
  });
}

/**
 * Commit exactly what was previewed, all or nothing. Refuses when any row is invalid, the digest
 * no longer matches, or nothing would change; a relationship that stopped being current between
 * evaluation and update rolls the whole batch back as stale.
 */
export async function commitRelationshipBatch(
  db: PersistenceDb,
  input: RelationshipBatchInput & { readonly previewDigest: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string },
): Promise<{ readonly reference: string; readonly evaluation: RelationshipBatchEvaluation; readonly changed: number; readonly effectiveTo: string }> {
  return db.transaction(async (tx) => {
    // One batch at a time per institution, so two commits cannot interleave on the same students.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`relationship-batch:${input.institutionId}`}))`);
    const { evaluation, students, endsAt } = await evaluateRelationshipBatch(tx, input);
    if (evaluation.counts.invalid > 0) throw new RelationshipBatchRejected('BATCH_HAS_INVALID_ROWS', evaluation);
    if (evaluation.digest !== input.previewDigest) throw new RelationshipBatchRejected('BATCH_PREVIEW_STALE', evaluation);
    if (evaluation.counts.change === 0) throw new RelationshipBatchRejected('NOTHING_TO_CHANGE', evaluation);

    const reference = randomUUID();
    const effectiveTo = endsAt.toISOString();
    let changed = 0;
    for (const student of students) {
      if (student.outcome !== 'CHANGE' || !student.relationshipId || !student.studentUserId || !student.studentProfileId) continue;
      const updated = await tx.execute(sql`
        UPDATE institution_relationships
        SET state = ${input.state}::relationship_state, effective_to = ${effectiveTo}::timestamptz, updated_at = now()
        WHERE id = ${student.relationshipId}::uuid AND institution_id = ${input.institutionId}::uuid
          AND state IN ('ACTIVE', 'VERIFIED') AND effective_to IS NULL
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (updated.rows.length !== 1) throw new RelationshipBatchRejected('BATCH_PREVIEW_STALE', evaluation);
      await tx.execute(sql`
        UPDATE institution_student_profiles SET status = ${input.state}::roster_student_status, updated_at = now()
        WHERE id = ${student.studentProfileId}::uuid AND institution_id = ${input.institutionId}::uuid
      `);
      // Someone who has left must not be able to activate into the relationship afterwards.
      await revokePendingStudentInvitations(tx, { institutionId: input.institutionId, studentUserId: student.studentUserId, reasonCode: `RELATIONSHIP_${input.state}` });
      // The per-student endpoint's action and event, so a person's trail reads the same either way.
      await audit(tx, input, 'institution.relationship.ended', 'institution_relationship', student.relationshipId, {
        state: input.state, reasonCode: input.reasonCode, batchReference: reference, effectiveTo, bulk: true,
      });
      const outbox = {
        id: randomUUID(), aggregateType: 'institution_relationship', aggregateId: student.relationshipId,
        eventType: 'institution.relationship.ended', eventVersion: 1, payload: { relationshipId: student.relationshipId, state: input.state },
        actorUserId: input.actorUserId, organizationId: input.institutionId, correlationId: input.correlationId,
      };
      validateOutboxWriteInput(outbox);
      await tx.execute(sql`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
        VALUES (${outbox.id}::uuid, ${outbox.aggregateType}, ${outbox.aggregateId}, ${outbox.eventType}, 1, ${JSON.stringify(outbox.payload)}::jsonb,
                ${outbox.actorUserId}::uuid, ${outbox.organizationId}::uuid, ${outbox.correlationId})
      `);
      changed += 1;
    }
    await audit(tx, input, 'institution.relationship_batch.committed', 'institution_relationship_batch', reference, {
      state: input.state, target: targetKind(input.target), effectiveTo, reasonCode: input.reasonCode, digest: evaluation.digest,
      counts: evaluation.counts, changed,
    });
    return { reference, evaluation, changed, effectiveTo };
  });
}

function targetKind(target: RelationshipBatchTarget): Record<string, unknown> {
  return 'unitId' in target ? { unitId: target.unitId } : { institutionStudentIds: target.institutionStudentIds.length };
}

async function audit(tx: PersistenceDb, input: { readonly institutionId: string; readonly actorUserId: string; readonly correlationId: string },
  action: string, resourceType: string, resourceId: string, context: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${input.actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId},
            ${input.institutionId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}
