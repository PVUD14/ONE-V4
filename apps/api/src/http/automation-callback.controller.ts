import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { validateAutomationToken, type AutomationTokenClaims } from '@planthepath/automation/src/index.js';
import { recordVerifiedAutomationCallback } from '@planthepath/persistence/src/automation-runtime.js';
import { PG_POOL, RUNTIME_CONFIG } from '../persistence.provider.js';
import type { RuntimeConfig } from '../config.js';

const callbackIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const providerReferencePattern = /^[A-Za-z0-9._:@<>-]{1,256}$/;
const statuses = new Set(['ACCEPTED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'EXPIRED']);

@Controller('/api/v1/internal/automation')
export class AutomationCallbackController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  @Post('/callbacks')
  async callback(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<{ readonly accepted: true; readonly idempotentReplay: boolean }> {
    const signingSecret = this.config.automation.signingSecret;
    if (!signingSecret) throw new ServiceUnavailableException({ error: { code: 'AUTOMATION_DISABLED', message: 'Automation callback is unavailable' } });
    const token = readBearerToken(authorization);
    const callback = readCallback(body);
    let claims: AutomationTokenClaims;
    try {
      claims = validateAutomationToken(token, { secret: Buffer.from(signingSecret, 'utf8'),
        audience: 'planthepath-automation-callback', purpose: 'WORKFLOW_CALLBACK', nowEpochSeconds: Math.floor(Date.now() / 1_000) });
      if (claims.sub !== 'automation-command') throw new Error('callback subject is invalid');
    } catch {
      throw new UnauthorizedException({ error: { code: 'INVALID_AUTOMATION_CALLBACK', message: 'Automation callback was rejected' } });
    }
    const result = await recordVerifiedAutomationCallback(this.pool, { claims, callbackId: callback.callbackId,
      status: callback.status, ...(callback.providerReference ? { providerReference: callback.providerReference } : {}) });
    return { accepted: true, idempotentReplay: result.idempotentReplay };
  }
}

function readBearerToken(value: string | undefined): string {
  if (!value || !/^Bearer [A-Za-z0-9._-]{32,4096}$/.test(value)) {
    throw new UnauthorizedException({ error: { code: 'INVALID_AUTOMATION_CALLBACK', message: 'Automation callback was rejected' } });
  }
  return value.slice('Bearer '.length);
}

function readCallback(body: unknown): {
  readonly callbackId: string;
  readonly status: 'ACCEPTED' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'EXPIRED';
  readonly providerReference?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidBody();
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.callbackId !== 'string' || !callbackIdPattern.test(candidate.callbackId)
    || typeof candidate.status !== 'string' || !statuses.has(candidate.status)
    || (candidate.providerReference !== undefined && (typeof candidate.providerReference !== 'string'
      || !providerReferencePattern.test(candidate.providerReference)))) throw invalidBody();
  return { callbackId: candidate.callbackId,
    status: candidate.status as 'ACCEPTED' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL' | 'EXPIRED',
    ...(typeof candidate.providerReference === 'string' ? { providerReference: candidate.providerReference } : {}) };
}

function invalidBody(): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
}
