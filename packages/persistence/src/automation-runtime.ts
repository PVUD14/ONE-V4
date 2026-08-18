import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import type { AutomationTokenClaims, ReplayStore } from '@planthepath/automation/src/index.js';

type DbClient = Pick<PoolClient, 'query'>;
type AutomationOutcome = 'ACCEPTED' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'EXPIRED';

export interface AutomationWorkflowDeployment {
  readonly id: string;
  readonly allowlistId: 'assessment-due' | 'roadmap-overdue' | 'institution-report' | 'content-review'
    | 'ops-failure' | 'security-notification';
  readonly version: number;
  readonly workflowHash: string;
  readonly operation: 'SEND_EMAIL' | 'DELIVER_REPORT';
  readonly destinationClass: 'EMAIL';
  readonly active: boolean;
  readonly killSwitch: boolean;
}

export interface ClaimedAutomationCommand {
  readonly id: string;
  readonly workflowKey: string;
  readonly workflowVersion: number;
  readonly workflowHash: string;
  readonly operation: string;
  readonly destinationClass: 'EMAIL';
  readonly payloadRef: string;
  readonly correlationId: string;
  readonly idempotencyId: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

export interface ResolvedEmailDelivery {
  readonly commandId: string;
  readonly notificationCommandId: string;
  readonly idempotencyId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly expiresAt: string;
}

export class PostgresAutomationReplayStore implements ReplayStore {
  constructor(readonly pool: Pool, readonly commandId: string, readonly purpose: AutomationTokenClaims['purpose']) {}

  async consume(tokenId: string, expiresAt: number): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO automation_token_replays (token_id,command_id,purpose,expires_at)
       VALUES ($1,$2,$3,to_timestamp($4)) ON CONFLICT (token_id) DO NOTHING RETURNING token_id`,
      [tokenId, this.commandId, this.purpose, expiresAt],
    );
    return result.rowCount === 1;
  }
}

export async function deleteExpiredAutomationTokenReplays(pool: Pool, now = new Date()): Promise<number> {
  const result = await pool.query('DELETE FROM automation_token_replays WHERE expires_at <= $1', [now]);
  return result.rowCount ?? 0;
}

export async function registerAutomationWorkflow(pool: Pool, deployment: AutomationWorkflowDeployment): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(deployment.workflowHash)) throw new Error('workflow hash must be SHA-256');
  await pool.query(
    `INSERT INTO automation_workflow_registry
     (id, allowlist_id, version, workflow_hash, operation, destination_class, active, kill_switch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (allowlist_id,version) DO UPDATE SET
       workflow_hash=EXCLUDED.workflow_hash, operation=EXCLUDED.operation, destination_class=EXCLUDED.destination_class,
       active=EXCLUDED.active, kill_switch=EXCLUDED.kill_switch
     WHERE automation_workflow_registry.id=EXCLUDED.id`,
    [deployment.id, deployment.allowlistId, deployment.version, deployment.workflowHash, deployment.operation,
      deployment.destinationClass, deployment.active, deployment.killSwitch],
  );
}

export async function setAutomationWorkflowKillSwitch(pool: Pool, allowlistId: AutomationWorkflowDeployment['allowlistId'], enabled: boolean): Promise<boolean> {
  const result = await pool.query(
    `UPDATE automation_workflow_registry SET kill_switch=$2 WHERE allowlist_id=$1 AND active RETURNING id`, [allowlistId, enabled],
  );
  return result.rowCount === 1;
}

export async function createAutomationCommandForNotificationEvent(pool: Pool, eventId: string): Promise<{
  readonly commandId: string; readonly idempotentReplay: boolean;
}> {
  return transaction(pool, async (client) => {
    const source = await client.query<{
      id: string; event_type: string; payload: { commandId?: unknown }; actor_user_id: string | null; correlation_id: string;
    }>('SELECT id,event_type,payload,actor_user_id,correlation_id FROM outbox_events WHERE id=$1 FOR UPDATE', [eventId]);
    const event = source.rows[0];
    if (!event || event.event_type !== 'notification.delivery.requested' || typeof event.payload.commandId !== 'string') {
      throw new Error('event is not an eligible notification delivery request');
    }
    const replay = await client.query<{ id: string }>('SELECT id FROM automation_commands WHERE event_id=$1', [eventId]);
    if (replay.rows[0]) return { commandId: replay.rows[0].id, idempotentReplay: true };
    const notification = await client.query<{ id: string; stable_key: string; expires_at: Date; state: string }>(
      `SELECT n.id,t.stable_key,n.expires_at,n.state FROM notification_commands n JOIN notification_templates t ON t.id=n.template_id
       WHERE n.id=$1`, [event.payload.commandId],
    );
    const item = notification.rows[0];
    if (!item || item.state !== 'PENDING' || item.stable_key !== 'assessment-due') throw new Error('notification is not eligible for the approved workflow');
    const workflow = await client.query<{
      id: string; allowlist_id: string; version: number; operation: string; destination_class: 'EMAIL';
    }>(
      `SELECT id,allowlist_id,version,operation,destination_class FROM automation_workflow_registry
       WHERE allowlist_id='assessment-due' AND active AND NOT kill_switch ORDER BY version DESC LIMIT 1`,
    );
    if (!workflow.rows[0]) throw new Error('approved assessment-due workflow is disabled');
    const idempotencyId = `event:${eventId}:workflow:${workflow.rows[0].id}`;
    const existing = await client.query<{ id: string }>('SELECT id FROM automation_commands WHERE idempotency_id=$1', [idempotencyId]);
    if (existing.rows[0]) return { commandId: existing.rows[0].id, idempotentReplay: true };
    const commandId = randomUUID();
    await client.query(
      `INSERT INTO automation_commands
       (id,workflow_registry_id,event_id,correlation_id,idempotency_id,operation,destination_class,payload_ref,state,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)`,
      [commandId, workflow.rows[0].id, eventId, event.correlation_id, idempotencyId, workflow.rows[0].operation,
        workflow.rows[0].destination_class, `notification:${item.id}`, item.expires_at],
    );
    await insertOutbox(client, { aggregateType: 'automation_command', aggregateId: commandId, eventType: 'automation.command.requested',
      ...(event.actor_user_id ? { actorUserId: event.actor_user_id } : {}), correlationId: event.correlation_id,
      payload: { commandId, workflowKey: workflow.rows[0].allowlist_id, commandType: workflow.rows[0].operation } });
    return { commandId, idempotentReplay: false };
  });
}

export async function claimAutomationCommands(pool: Pool, input: {
  readonly leaseOwner: string; readonly batchSize: number; readonly leaseDurationMs: number; readonly now: Date;
}): Promise<readonly ClaimedAutomationCommand[]> {
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(input.leaseOwner) || !Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 100
    || !Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 300_000) throw new Error('invalid automation claim parameters');
  const leaseToken = randomUUID();
  const result = await pool.query<{
    id: string; allowlist_id: string; version: number; workflow_hash: string; operation: string; destination_class: 'EMAIL';
    payload_ref: string; correlation_id: string; idempotency_id: string; expires_at: Date; attempts: number; lease_owner: string; lease_token: string;
  }>(
    `WITH candidates AS (
       SELECT c.id FROM automation_commands c JOIN automation_workflow_registry w ON w.id=c.workflow_registry_id
       WHERE c.state IN ('PENDING','FAILED_RETRYABLE') AND c.available_at <= $1 AND c.expires_at > $1
         AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= $1) AND w.active AND NOT w.kill_switch
       ORDER BY c.available_at,c.created_at,c.id LIMIT $2 FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE automation_commands c SET lease_owner=$3,lease_token=$4,lease_expires_at=$5,attempts=attempts+1,last_failure_class=NULL
     FROM candidates, automation_workflow_registry w WHERE c.id=candidates.id AND w.id=c.workflow_registry_id
     RETURNING c.id,w.allowlist_id,w.version,w.workflow_hash,c.operation,c.destination_class,c.payload_ref,c.correlation_id,
       c.idempotency_id,c.expires_at,c.attempts,c.lease_owner,c.lease_token`,
    [input.now, input.batchSize, input.leaseOwner, leaseToken, new Date(input.now.getTime() + input.leaseDurationMs)],
  );
  return result.rows.map((row) => ({ id: row.id, workflowKey: row.allowlist_id, workflowVersion: row.version,
    workflowHash: row.workflow_hash, operation: row.operation, destinationClass: row.destination_class, payloadRef: row.payload_ref,
    correlationId: row.correlation_id, idempotencyId: row.idempotency_id, expiresAt: new Date(row.expires_at), attempts: row.attempts,
    leaseOwner: row.lease_owner, leaseToken: row.lease_token }));
}

export async function resolveClaimedEmailDelivery(pool: Pool, claim: ClaimedAutomationCommand, now = new Date()): Promise<ResolvedEmailDelivery> {
  const result = await pool.query<{
    command_id: string; notification_id: string; idempotency_id: string; email: string; subject_template: string; body_template: string; expires_at: Date;
  }>(
    `SELECT c.id AS command_id,n.id AS notification_id,c.idempotency_id,u.email,t.subject_template,t.body_template,c.expires_at
     FROM automation_commands c JOIN notification_commands n ON c.payload_ref='notification:'||n.id::text
     JOIN users u ON u.id=n.subject_user_id AND u.state='ACTIVE'
     JOIN notification_templates t ON t.id=n.template_id
     WHERE c.id=$1 AND c.lease_owner=$2 AND c.lease_token=$3 AND c.lease_expires_at>$4
       AND c.state IN ('PENDING','FAILED_RETRYABLE') AND c.destination_class='EMAIL' AND n.channel='EMAIL'
       AND n.state IN ('PENDING','FAILED_RETRYABLE') AND c.expires_at>$4 AND n.expires_at>$4`,
    [claim.id, claim.leaseOwner, claim.leaseToken, now],
  );
  const row = result.rows[0];
  if (!row) throw new Error('automation command lease is not current or delivery is ineligible');
  return { commandId: row.command_id, notificationCommandId: row.notification_id, idempotencyId: row.idempotency_id,
    recipientEmail: row.email, subject: row.subject_template, textBody: row.body_template, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function markAutomationAccepted(pool: Pool, claim: ClaimedAutomationCommand): Promise<boolean> {
  return transaction(pool, async (client) => {
    const updated = await client.query<{ payload_ref: string }>(
      `UPDATE automation_commands SET state='ACCEPTED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND state IN ('PENDING','FAILED_RETRYABLE') RETURNING payload_ref`,
      [claim.id, claim.leaseOwner, claim.leaseToken],
    );
    const payloadRef = updated.rows[0]?.payload_ref;
    if (!payloadRef) return false;
    const notificationId = payloadRef.replace(/^notification:/, '');
    await client.query("UPDATE notification_commands SET state='DISPATCHED' WHERE id=$1 AND state IN ('PENDING','FAILED_RETRYABLE')", [notificationId]);
    return true;
  });
}

export async function releaseAutomationClaimForFailure(pool: Pool, claim: ClaimedAutomationCommand, input: {
  readonly retryable: boolean; readonly failureClass: 'N8N_TIMEOUT' | 'N8N_RATE_LIMITED' | 'N8N_UNAVAILABLE' | 'N8N_REJECTED'; readonly now: Date;
}): Promise<boolean> {
  const terminal = !input.retryable || claim.attempts >= 5 || claim.expiresAt <= input.now;
  const state = claim.expiresAt <= input.now ? 'EXPIRED' : terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE';
  const delaySeconds = Math.min(900, 2 ** Math.max(0, claim.attempts - 1) * 5);
  const result = await pool.query(
    `UPDATE automation_commands SET state=$4,available_at=$5,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_failure_class=$6
     WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND state IN ('PENDING','FAILED_RETRYABLE')`,
    [claim.id, claim.leaseOwner, claim.leaseToken, state, new Date(input.now.getTime() + delaySeconds * 1_000), input.failureClass],
  );
  return result.rowCount === 1;
}

export async function recordAutomationCallback(pool: Pool, input: {
  readonly commandId: string; readonly callbackId: string; readonly status: AutomationOutcome;
  readonly providerReference?: string; readonly audience: string; readonly issuedAt: Date;
}): Promise<{ readonly idempotentReplay: boolean }> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.callbackId) || input.audience !== 'planthepath-automation-callback') throw new Error('callback scope is invalid');
  if (input.providerReference && !/^[A-Za-z0-9._:-]{1,256}$/.test(input.providerReference)) throw new Error('provider reference is invalid');
  return transaction(pool, async (client) => {
    const existing = await client.query('SELECT id FROM automation_callbacks WHERE callback_id=$1', [input.callbackId]);
    if (existing.rows[0]) return { idempotentReplay: true };
    const command = await client.query<{ payload_ref: string; state: string; attempts: number }>(
      'SELECT payload_ref,state,attempts FROM automation_commands WHERE id=$1 FOR UPDATE', [input.commandId],
    );
    if (!command.rows[0] || command.rows[0].state !== 'ACCEPTED') throw new Error('automation command is not awaiting callback');
    await client.query(
      `INSERT INTO automation_callbacks (id,command_id,callback_id,status,provider_reference,audience,issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.commandId, input.callbackId, input.status, input.providerReference ?? null, input.audience, input.issuedAt],
    );
    await client.query('UPDATE automation_commands SET state=$2,last_failure_class=$3 WHERE id=$1',
      [input.commandId, input.status, input.status.startsWith('FAILED') ? 'N8N_CALLBACK_FAILURE' : null]);
    const notificationId = command.rows[0].payload_ref.replace(/^notification:/, '');
    const notificationState = input.status === 'SUCCEEDED' ? 'DELIVERED' : input.status === 'ACCEPTED' ? 'DISPATCHED' : input.status;
    await client.query('UPDATE notification_commands SET state=$2 WHERE id=$1', [notificationId, notificationState]);
    await client.query(
      `INSERT INTO notification_delivery_attempts (id,command_id,attempt,provider_kind,provider_reference,outcome,failure_class)
       VALUES ($1,$2,$3,'N8N',$4,$5,$6)`,
      [randomUUID(), notificationId, command.rows[0].attempts, input.providerReference ?? null, input.status,
        input.status.startsWith('FAILED') ? 'N8N_CALLBACK_FAILURE' : null],
    );
    return { idempotentReplay: false };
  });
}

export async function recordVerifiedAutomationCallback(pool: Pool, input: {
  readonly claims: AutomationTokenClaims; readonly callbackId: string; readonly status: AutomationOutcome;
  readonly providerReference?: string;
}): Promise<{ readonly idempotentReplay: boolean }> {
  if (input.claims.purpose !== 'WORKFLOW_CALLBACK' || input.claims.aud !== 'planthepath-automation-callback') {
    throw new Error('callback token scope is invalid');
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.callbackId)) throw new Error('callback scope is invalid');
  if (input.providerReference && !/^[A-Za-z0-9._:@<>-]{1,256}$/.test(input.providerReference)) throw new Error('provider reference is invalid');
  return transaction(pool, async (client) => {
    const replay = await client.query(
      `INSERT INTO automation_token_replays (token_id,command_id,purpose,expires_at)
       VALUES ($1,$2,'WORKFLOW_CALLBACK',to_timestamp($3)) ON CONFLICT (token_id) DO NOTHING RETURNING token_id`,
      [input.claims.jti, input.claims.commandId, input.claims.exp],
    );
    if (replay.rowCount !== 1) return { idempotentReplay: true };
    const command = await client.query<{ payload_ref: string; state: string; attempts: number; correlation_id: string }>(
      'SELECT payload_ref,state,attempts,correlation_id FROM automation_commands WHERE id=$1 FOR UPDATE', [input.claims.commandId],
    );
    const current = command.rows[0];
    if (!current || current.state !== 'ACCEPTED' || current.correlation_id !== input.claims.correlationId
      || current.payload_ref !== input.claims.payloadRef) throw new Error('automation command is not awaiting this callback');
    await insertCallbackAndOutcome(client, current, { commandId: input.claims.commandId, callbackId: input.callbackId,
      status: input.status, ...(input.providerReference ? { providerReference: input.providerReference } : {}), audience: input.claims.aud,
      issuedAt: new Date(input.claims.iat * 1_000) });
    return { idempotentReplay: false };
  });
}

export async function completeClaimedAutomationCommand(pool: Pool, claim: ClaimedAutomationCommand, input: {
  readonly claims: AutomationTokenClaims; readonly callbackId: string; readonly status: 'SUCCEEDED'; readonly providerReference?: string;
}): Promise<boolean> {
  if (input.claims.purpose !== 'WORKFLOW_CALLBACK' || input.claims.aud !== 'planthepath-automation-callback'
    || input.claims.commandId !== claim.id || input.claims.workflowKey !== claim.workflowKey
    || input.claims.correlationId !== claim.correlationId || input.claims.payloadRef !== claim.payloadRef) {
    throw new Error('callback token is not bound to the claimed command');
  }
  return transaction(pool, async (client) => {
    const accepted = await client.query<{ payload_ref: string; attempts: number; correlation_id: string }>(
      `UPDATE automation_commands SET state='ACCEPTED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
       WHERE id=$1 AND lease_owner=$2 AND lease_token=$3 AND state IN ('PENDING','FAILED_RETRYABLE')
       RETURNING payload_ref,attempts,correlation_id`,
      [claim.id, claim.leaseOwner, claim.leaseToken],
    );
    const current = accepted.rows[0];
    if (!current) return false;
    const replay = await client.query(
      `INSERT INTO automation_token_replays (token_id,command_id,purpose,expires_at)
       VALUES ($1,$2,'WORKFLOW_CALLBACK',to_timestamp($3)) ON CONFLICT (token_id) DO NOTHING RETURNING token_id`,
      [input.claims.jti, claim.id, input.claims.exp],
    );
    if (replay.rowCount !== 1) throw new Error('automation callback token replay was rejected');
    const notificationId = current.payload_ref.replace(/^notification:/, '');
    await client.query("UPDATE notification_commands SET state='DISPATCHED' WHERE id=$1 AND state IN ('PENDING','FAILED_RETRYABLE')", [notificationId]);
    await insertCallbackAndOutcome(client, current, { commandId: claim.id, callbackId: input.callbackId,
      status: input.status, ...(input.providerReference ? { providerReference: input.providerReference } : {}), audience: input.claims.aud,
      issuedAt: new Date(input.claims.iat * 1_000) });
    return true;
  });
}

async function insertCallbackAndOutcome(client: DbClient, command: { payload_ref: string; attempts: number }, input: {
  readonly commandId: string; readonly callbackId: string; readonly status: AutomationOutcome;
  readonly providerReference?: string; readonly audience: string; readonly issuedAt: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO automation_callbacks (id,command_id,callback_id,status,provider_reference,audience,issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), input.commandId, input.callbackId, input.status, input.providerReference ?? null, input.audience, input.issuedAt],
  );
  await client.query('UPDATE automation_commands SET state=$2,last_failure_class=$3 WHERE id=$1',
    [input.commandId, input.status, input.status.startsWith('FAILED') ? 'N8N_CALLBACK_FAILURE' : null]);
  const notificationId = command.payload_ref.replace(/^notification:/, '');
  const notificationState = input.status === 'SUCCEEDED' ? 'DELIVERED' : input.status === 'ACCEPTED' ? 'DISPATCHED' : input.status;
  await client.query('UPDATE notification_commands SET state=$2 WHERE id=$1', [notificationId, notificationState]);
  await client.query(
    `INSERT INTO notification_delivery_attempts (id,command_id,attempt,provider_kind,provider_reference,outcome,failure_class)
     VALUES ($1,$2,$3,'N8N',$4,$5,$6)`,
    [randomUUID(), notificationId, command.attempts, input.providerReference ?? null, input.status,
      input.status.startsWith('FAILED') ? 'N8N_CALLBACK_FAILURE' : null],
  );
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertOutbox(client: DbClient, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string;
  readonly actorUserId?: string; readonly correlationId: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  createIntegrationEventEnvelope({ eventId: id,eventType: input.eventType,eventVersion: 1,occurredAt: new Date().toISOString(),
    aggregateId: input.aggregateId,...(input.actorUserId ? { actorId: input.actorUserId } : {}),correlationId: input.correlationId,payload: input.payload });
  await client.query(
    `INSERT INTO outbox_events (id,aggregate_type,aggregate_id,event_type,event_version,payload,actor_user_id,correlation_id)
     VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7)`,
    [id,input.aggregateType,input.aggregateId,input.eventType,JSON.stringify(input.payload),input.actorUserId ?? null,input.correlationId],
  );
}
