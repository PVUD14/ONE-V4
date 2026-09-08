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
import { EmployerHiringController } from './employer-hiring.controller.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const employerId = randomUUID();
const actorId = randomUUID();
function request(role = 'RECRUITER', state = 'ACTIVE', scopeId = employerId): ProtectedHttpRequest {
  return { headers: {}, planThePath: { correlationId: 'employer-test', verifiedIdentity: {}, authorization: {
    principal: { userId: actorId }, memberships: [{ organizationId: employerId, state, role, scope: { organizationId: employerId, employerId: scopeId } }],
  } } } as unknown as ProtectedHttpRequest;
}
function fixture(resultRows: Record<string, unknown>[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); return { rows: resultRows.shift() ?? [] }; });
  const db = { execute, transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ execute })) };
  return { controller: new EmployerHiringController(db as unknown as PersistenceDb, { uuid: randomUUID }), queries, db };
}
describe('employer report authorization', () => {
  it('requires the existing authentication guard', () => {
    expect(Reflect.getMetadata('__guards__', EmployerHiringController.prototype.hiringAnalytics)).toContain(ProtectedApiAuthenticationGuard);
  });
  it.each([['RECRUITER', 'SUSPENDED', employerId], ['INSTITUTION_ADMIN', 'ACTIVE', employerId], ['RECRUITER', 'ACTIVE', randomUUID()]])('denies %s / %s / mismatched scope before querying', async (role, state, scope) => {
    const { controller, db } = fixture([]);
    await expect(controller.hiringAnalytics(request(role, state, scope), employerId)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it('scopes the applications, offers and opportunities to the caller employer and returns no identity columns', async () => {
    const { controller, queries } = fixture([[{ opportunity_id: 'internal-opportunity', title: 'Role', state: 'APPLIED', reached: ['APPLIED'], count: 3, offer_days: null, timed_offers: 0 }]]);
    const response = await controller.hiringAnalytics(request(), employerId);
    expect(queries[0]!.params).toEqual([employerId, employerId, employerId]);
    expect(queries[0]!.sql).not.toMatch(/student_user_id|candidate|email|compensation/);
    expect(JSON.stringify(response)).not.toContain('internal-opportunity');
    expect(response.analytics).toMatchObject({ applicationCount: 3, meanTimeToOfferDays: null });
  });
});
describe('interview rescheduling', () => {
  it('rejects invalid windows before database writes', async () => {
    const { controller, db } = fixture([]);
    await expect(controller.updateInterviewState(request(), employerId, randomUUID(), { toState: 'RESCHEDULED', scheduledStart: '2099-01-01T10:00Z', scheduledEnd: '2099-01-01T09:00Z' })).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
  it('saves both times under employer ownership and audits the state change', async () => {
    const id = randomUUID();
    const { controller, queries } = fixture([[{ id, state: 'SCHEDULED' }]]);
    await controller.updateInterviewState(request(), employerId, id, { toState: 'RESCHEDULED', scheduledStart: '2099-01-01T09:00Z', scheduledEnd: '2099-01-01T10:00Z' });
    expect(queries[1]!.params).toEqual(['RESCHEDULED', null, '2099-01-01T09:00:00.000Z', '2099-01-01T10:00:00.000Z', id, employerId]);
    expect(queries[2]!.params).toContain('interview.rescheduled');
  });
});
describe('opportunity review recording', () => {
  it('records signals on create, withholds rival identity and does not reject a flagged posting', async () => {
    const opportunityId = randomUUID();
    const versionId = randomUUID();
    const { controller, queries, db } = fixture([[{ id: opportunityId }], [], [], [{
      id: versionId, title: 'Role', summary: 'Candidates must pay a registration fee.', responsibilities: null,
      compensation_min: null, compensation_max: null, compensation_currency: null, compensation_period: null, cross_employer_duplicate: true,
    }]]);
    const result = await controller.createOpportunity(request(), employerId, { referenceCode: 'test-role', title: 'Role', employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false });
    expect(result.opportunity).toMatchObject({ lifecycleState: 'DRAFT' });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(queries.filter((query) => query.sql.includes('INSERT INTO opportunity_review_signals'))).toHaveLength(3);
    const event = queries.find((query) => query.sql.includes('opportunity.review_requested'))!;
    expect(event.sql).toContain('opportunity.review_requested');
    expect(event.sql).toContain('INSERT INTO audit_events');
    expect(queries.some((query) => /REJECTED|SUSPENDED/.test(query.sql))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('CROSS_EMPLOYER_DUPLICATE');
  });
  it('checks and records signals before publish without using them as an automatic rejection', async () => {
    const id = randomUUID();
    const { controller, queries } = fixture([[{ id, lifecycle_state: 'DRAFT' }], [{ count: 1 }], [{ id: randomUUID(), title: 'Role', compensation_min: null }]]);
    const result = await controller.publishOpportunity(request(), employerId, id);
    const signalIndex = queries.findIndex((query) => query.sql.includes('INSERT INTO opportunity_review_signals'));
    const publishIndex = queries.findIndex((query) => query.sql.includes("lifecycle_state = 'PUBLISHED'"));
    expect(signalIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(signalIndex);
    expect(result.opportunity).toMatchObject({ lifecycleState: 'PUBLISHED' });
  });
});
