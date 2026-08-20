import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  claimAutomationCommands,
  createAutomationCommandForNotificationEvent,
  loadCurrentAutomationWorkflowRegistration,
  markAutomationAccepted,
  recordVerifiedAutomationCallback,
  registerAutomationWorkflow,
  releaseAutomationClaimForFailure,
  resolveClaimedEmailDelivery,
  setAutomationWorkflowKillSwitch,
} from '../src/automation-runtime.js';
import { loadN8nWorkflowDeployments } from '../src/register-n8n-workflows.js';
import { assertWorkflowInvocationAllowed, mintAutomationToken, validateAutomationToken } from '@planthepath/automation/src/index.js';
import { N8nAutomationAdapter } from '@planthepath/automation/src/index.js';
import { dispatchAutomationOnce } from '../src/automation-workers.js';
import { publishCareerReadinessPilot, startAssessmentAttempt, type PilotFixture } from '../src/career-readiness.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const actors = {
  authorUserId: '51000000-0000-4000-8000-000000000001',
  reviewerUserId: '51000000-0000-4000-8000-000000000002',
  publisherUserId: '51000000-0000-4000-8000-000000000003',
};
const studentUserId = '51000000-0000-4000-8000-000000000004';
const workerStudentUserId = '51000000-0000-4000-8000-000000000005';
const killSwitchStudentUserId = '51000000-0000-4000-8000-000000000006';
const ambiguousStudentUserId = '51000000-0000-4000-8000-000000000007';
let fixture: PilotFixture;

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  await pool.query('TRUNCATE users CASCADE');
  for (const [index, userId] of [...Object.values(actors), studentUserId, workerStudentUserId,
    killSwitchStudentUserId, ambiguousStudentUserId].entries()) {
    await pool.query(`INSERT INTO users (id,external_subject,email,state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `automation-test:${index}`, `automation-${index}@example.test`]);
  }
  const fixtureBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(fixtureBytes.toString('utf8')) as PilotFixture;
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(fixtureBytes).digest('hex'), actors);
  await pool.query(`INSERT INTO notification_preferences (user_id,quiet_hours_start_minute,quiet_hours_end_minute) VALUES ($1,0,0)`, [studentUserId]);
  await pool.query(`INSERT INTO notification_preferences (user_id,quiet_hours_start_minute,quiet_hours_end_minute) VALUES ($1,0,0)`, [workerStudentUserId]);
  await pool.query(`INSERT INTO notification_preferences (user_id,quiet_hours_start_minute,quiet_hours_end_minute) VALUES ($1,0,0)`, [killSwitchStudentUserId]);
  await pool.query(`INSERT INTO notification_preferences (user_id,quiet_hours_start_minute,quiet_hours_end_minute) VALUES ($1,0,0)`, [ambiguousStudentUserId]);
  await registerAutomationWorkflow(pool, { id: '47000000-0000-4000-8000-000000000001', allowlistId: 'assessment-due', version: 1,
    workflowHash: 'cbfe75eb95092dcade4957972efa7629de0c094f1ede4b27e32c9f18508858b6', operation: 'SEND_EMAIL',
    destinationClass: 'EMAIL', active: true, killSwitch: false });
});

afterAll(async () => pool.end());

describe('native automation command lifecycle', () => {
  it('creates once, honors kill switch, retries safely, and records a replay-safe callback', async () => {
    await startAssessmentAttempt(pool, { subjectUserId: studentUserId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'automation-assessment-start', selectionSeed: 'automation-assessment-seed' });
    const event = await pool.query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='notification.delivery.requested' ORDER BY occurred_at DESC LIMIT 1",
    );
    const eventId = event.rows[0]!.id;
    const created = await createAutomationCommandForNotificationEvent(pool, eventId);
    expect(created.idempotentReplay).toBe(false);
    await expect(createAutomationCommandForNotificationEvent(pool, eventId)).resolves.toEqual({ commandId: created.commandId, idempotentReplay: true });

    const claimNow = new Date(Date.now() + 60_000);
    await setAutomationWorkflowKillSwitch(pool, 'assessment-due', true);
    await expect(claimAutomationCommands(pool, { leaseOwner: 'automation-worker-1', batchSize: 10, leaseDurationMs: 30_000,
      now: claimNow })).resolves.toEqual([]);
    await setAutomationWorkflowKillSwitch(pool, 'assessment-due', false);

    const firstClaim = (await claimAutomationCommands(pool, { leaseOwner: 'automation-worker-1', batchSize: 10,
      leaseDurationMs: 30_000, now: claimNow }))[0]!;
    await expect(releaseAutomationClaimForFailure(pool, firstClaim, { retryable: true, failureClass: 'N8N_UNAVAILABLE', now: claimNow })).resolves.toBe(true);
    const retryClaim = (await claimAutomationCommands(pool, { leaseOwner: 'automation-worker-1', batchSize: 10,
      leaseDurationMs: 30_000, now: new Date(claimNow.getTime() + 6_000) }))[0]!;
    expect(retryClaim).toMatchObject({ id: created.commandId, attempts: 2, workflowKey: 'assessment-due', destinationClass: 'EMAIL' });
    const delivery = await resolveClaimedEmailDelivery(pool, retryClaim, new Date());
    expect(delivery).toMatchObject({ commandId: created.commandId, recipientEmail: 'automation-3@example.test' });
    expect(Object.keys(delivery)).not.toEqual(expect.arrayContaining(['score', 'readinessBand', 'answers', 'evidence']));
    await expect(markAutomationAccepted(pool, retryClaim)).resolves.toBe(true);
    const signingSecret = randomBytes(32);
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    const callbackToken = mintAutomationToken({ secret: signingSecret, audience: 'planthepath-automation-callback',
      subject: 'automation-command', tokenId: randomUUID(), nowEpochSeconds, lifetimeSeconds: 60, purpose: 'WORKFLOW_CALLBACK',
      workflowKey: retryClaim.workflowKey, workflowRegistryId: retryClaim.workflowRegistryId,
      commandId: retryClaim.id, correlationId: retryClaim.correlationId, payloadRef: retryClaim.payloadRef });
    const claims = validateAutomationToken(callbackToken, { secret: signingSecret, audience: 'planthepath-automation-callback',
      purpose: 'WORKFLOW_CALLBACK', nowEpochSeconds });
    await expect(recordVerifiedAutomationCallback(pool, { claims, callbackId: 'n8n-callback-0001', status: 'SUCCEEDED',
      providerReference: 'mailpit-message-1' }))
      .resolves.toEqual({ idempotentReplay: false });
    await expect(recordVerifiedAutomationCallback(pool, { claims, callbackId: 'n8n-callback-0001', status: 'SUCCEEDED',
      providerReference: 'mailpit-message-1' }))
      .resolves.toEqual({ idempotentReplay: true });
    const states = await pool.query(
      `SELECT a.state AS automation_state,n.state AS notification_state FROM automation_commands a
       JOIN notification_commands n ON a.payload_ref='notification:'||n.id::text WHERE a.id=$1`, [created.commandId],
    );
    expect(states.rows[0]).toEqual({ automation_state: 'SUCCEEDED', notification_state: 'DELIVERED' });
  });

  it('loads exactly six source-controlled workflow registrations with fail-closed defaults', async () => {
    const deployments = await loadN8nWorkflowDeployments();
    expect(deployments).toHaveLength(6);
    expect(deployments.every((item) => !item.active && item.killSwitch && /^[0-9a-f]{64}$/.test(item.workflowHash))).toBe(true);
  });

  it('rechecks the current workflow registration after claim and observes a newly enabled kill switch', async () => {
    await startAssessmentAttempt(pool, { subjectUserId: killSwitchStudentUserId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'automation-kill-switch-recheck', selectionSeed: 'automation-kill-switch-seed' });
    const event = await pool.query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='notification.delivery.requested' AND actor_user_id=$1 ORDER BY occurred_at DESC LIMIT 1",
      [killSwitchStudentUserId],
    );
    await createAutomationCommandForNotificationEvent(pool, event.rows[0]!.id);
    const now = new Date(Date.now() + 60_000);
    const claim = (await claimAutomationCommands(pool, { leaseOwner: 'automation-kill-switch-recheck', batchSize: 1,
      leaseDurationMs: 60_000, now }))[0]!;
    await setAutomationWorkflowKillSwitch(pool, 'assessment-due', true);
    const current = await loadCurrentAutomationWorkflowRegistration(pool, claim);
    expect(() => assertWorkflowInvocationAllowed(current, { allowlistId: claim.workflowKey, version: claim.workflowVersion,
      workflowHash: claim.workflowHash, operation: claim.operation, destinationClass: claim.destinationClass })).toThrow('disabled');
    await setAutomationWorkflowKillSwitch(pool, 'assessment-due', false);
    await releaseAutomationClaimForFailure(pool, claim, { retryable: false, failureClass: 'N8N_REJECTED', now });
  });

  it('marks an ambiguous n8n response terminal and never dispatches it a second time', async () => {
    await startAssessmentAttempt(pool, { subjectUserId: ambiguousStudentUserId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'automation-ambiguous-response', selectionSeed: 'automation-ambiguous-seed' });
    const event = await pool.query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='notification.delivery.requested' AND actor_user_id=$1 ORDER BY occurred_at DESC LIMIT 1",
      [ambiguousStudentUserId],
    );
    const created = await createAutomationCommandForNotificationEvent(pool, event.rows[0]!.id);
    const fetcher = vi.fn().mockResolvedValue(new Response('upstream response lost', { status: 503 }));
    const adapter = new N8nAutomationAdapter('http://n8n:5678', fetcher);
    const invocationSigningSecret = randomBytes(32);
    const callbackSigningSecret = randomBytes(32);
    const now = new Date(Date.now() + 60_000);
    await expect(dispatchAutomationOnce({ pool, adapter, invocationSigningSecret, callbackSigningSecret,
      leaseOwner: 'automation-ambiguous-response', now }))
      .resolves.toEqual({ claimed: 1, succeeded: 0, retried: 0, terminal: 1 });
    const state = await pool.query('SELECT state,last_failure_class FROM automation_commands WHERE id=$1', [created.commandId]);
    expect(state.rows[0]).toEqual({ state: 'FAILED_TERMINAL', last_failure_class: 'N8N_TIMEOUT' });
    await expect(dispatchAutomationOnce({ pool, adapter, invocationSigningSecret, callbackSigningSecret,
      leaseOwner: 'automation-ambiguous-response', now: new Date(now.getTime() + 10_000) }))
      .resolves.toEqual({ claimed: 0, succeeded: 0, retried: 0, terminal: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('dispatches a bounded command through a signed synchronous n8n callback exactly once', async () => {
    await startAssessmentAttempt(pool, { subjectUserId: workerStudentUserId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'automation-worker-e2e', selectionSeed: 'automation-worker-seed' });
    const event = await pool.query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE event_type='notification.delivery.requested' AND actor_user_id=$1 ORDER BY occurred_at DESC LIMIT 1",
      [workerStudentUserId],
    );
    const created = await createAutomationCommandForNotificationEvent(pool, event.rows[0]!.id);
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { callbackId: string; callbackToken: string };
      return new Response(JSON.stringify({ status: 'SUCCEEDED', callbackId: body.callbackId,
        callbackToken: body.callbackToken, providerReference: 'mailpit-worker-message-1' }), { status: 200 });
    });
    const adapter = new N8nAutomationAdapter('http://n8n:5678', fetcher);
    const invocationSigningSecret = randomBytes(32);
    const callbackSigningSecret = randomBytes(32);
    const now = new Date(Date.now() + 60_000);
    await expect(dispatchAutomationOnce({ pool, adapter, invocationSigningSecret, callbackSigningSecret,
      leaseOwner: 'automation-worker-e2e', now }))
      .resolves.toEqual({ claimed: 1, succeeded: 1, retried: 0, terminal: 0 });
    await expect(createAutomationCommandForNotificationEvent(pool, event.rows[0]!.id))
      .resolves.toEqual({ commandId: created.commandId, idempotentReplay: true });
    await expect(dispatchAutomationOnce({ pool, adapter, invocationSigningSecret, callbackSigningSecret,
      leaseOwner: 'automation-worker-e2e', now: new Date(now.getTime() + 1_000) }))
      .resolves.toEqual({ claimed: 0, succeeded: 0, retried: 0, terminal: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
