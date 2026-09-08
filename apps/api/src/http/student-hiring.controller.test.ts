/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { StudentHiringController } from './student-hiring.controller.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const studentId = randomUUID();
const applicationId = randomUUID();
const opportunityId = randomUUID();
const request = { headers: {}, planThePath: { correlationId: 'consent-test', verifiedIdentity: {}, authorization: { principal: { userId: studentId }, memberships: [] } } } as unknown as ProtectedHttpRequest;

function fixture(resultRows: Record<string, unknown>[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); return { rows: resultRows.shift() ?? [] }; });
  const db = { execute, transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ execute })) };
  return { controller: new StudentHiringController(db as unknown as PersistenceDb, { uuid: randomUUID }), queries, db };
}

describe('institution visibility consent controller', () => {
  it('retains authentication on the revocation endpoint and rejects untrusted requests', async () => {
    expect(Reflect.getMetadata('__guards__', StudentHiringController.prototype.revokeInstitutionVisibility)).toContain(ProtectedApiAuthenticationGuard);
    const { controller, db } = fixture([]);
    await expect(controller.revokeInstitutionVisibility({ headers: {} }, applicationId)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])('captures only explicit institution consent (%s)', async (choice) => {
    const { controller, queries } = fixture([
      [{ id: opportunityId, employer_id: randomUUID(), current_version_id: randomUUID(), lifecycle_state: 'PUBLISHED', application_deadline: null }],
      [{ id: applicationId }],
    ]);
    await controller.apply(request, { opportunityId, consentGranted: true, ...(choice === undefined ? {} : { institutionVisibilityGranted: choice }) });
    const insert = queries.find((query) => query.sql.includes('INSERT INTO applications'))!;
    expect(insert.sql).toContain('institution_visibility_granted_at');
    expect(insert.params.at(-1)).toBe(choice === true);
    const grantAudits = queries.filter((query) => query.params.includes('application.institution_visibility_granted'));
    expect(grantAudits).toHaveLength(choice ? 1 : 0);
  });
  it('rejects a truthy non-boolean consent without writing anything', async () => {
    const { controller, db } = fixture([]);
    await expect(controller.apply(request, { opportunityId, consentGranted: true, institutionVisibilityGranted: 'true' })).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it('revokes with an owner predicate, preserves the first timestamp and audits atomically', async () => {
    const { controller, queries, db } = fixture([[{ id: applicationId }]]);
    await expect(controller.revokeInstitutionVisibility(request, applicationId)).resolves.toMatchObject({ ok: true });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(queries[0]!.sql).toMatch(/WHERE id = .* AND student_user_id = /s);
    expect(queries[0]!.params).toEqual([applicationId, studentId]);
    expect(queries[0]!.sql).toContain('coalesce(institution_visibility_revoked_at');
    expect(queries[0]!.sql).not.toMatch(/SET state|consent_revoked_at|closed_at/);
    expect(queries[1]!.sql).toContain('application.institution_visibility_revoked');
  });
  it('refuses missing or foreign applications without an audit success', async () => {
    const { controller, queries } = fixture([[]]);
    await expect(controller.revokeInstitutionVisibility(request, applicationId)).rejects.toThrow();
    expect(queries).toHaveLength(1);
  });
});
