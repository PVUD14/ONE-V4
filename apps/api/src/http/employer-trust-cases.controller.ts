/**
 * An employer's part in trust cases about it (EMP-16, spec §38 and §118): see what operations
 * shared, respond when asked, and appeal a decision once. Operations decide.
 *
 * Design: docs/architecture/employer-terms-and-trust-participation-design.md, Decision 4.
 *
 * Decisions this file carries:
 *  - Owners and admins act for the organisation; recruiters do not (the accountable people answer
 *    for it). The `trust.cases` action group is allowed in every organisation state: a SUSPENDED or
 *    REJECTED employer may still "respond to trust cases" (§5.1), and is the one most likely to
 *    need to appeal.
 *  - A case the employer may not see — not about it, or not yet disclosed by operations — answers
 *    404 exactly like a case that does not exist, so the route cannot be used to learn that a
 *    report was made.
 *  - Responses never name the reporter or carry the reporter's statement, severity, assignee,
 *    notes, operator identities, the opening time or any student data (persistence/trust-safety.ts).
 *  - A response or appeal is written with its state move and audit row in one transaction, so it is
 *    on the operator's case timeline the moment it exists.
 */
import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  TrustSafetyError,
  getEmployerTrustCase,
  listEmployerTrustCases,
  recordEmployerTrustStatement,
} from '@planthepath/persistence/src/trust-safety.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { assertEmployerState, requireEmployerMembership } from './employer-organisation-state.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const employerTrustRoles = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'] as const;
const statementMaxLength = 4000;

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class EmployerTrustCasesController {
  private readonly db: ReturnType<typeof drizzle>;
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.db = drizzle(pool);
  }

  @Get('/employers/:employerId/trust-cases')
  async list(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await this.authorise(request, employerId);
    return { cases: await listEmployerTrustCases(this.pool, employerId), correlationId: context.correlationId };
  }

  @Get('/employers/:employerId/trust-cases/:caseId')
  async detail(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('caseId') caseId: string): Promise<Record<string, unknown>> {
    const context = await this.authorise(request, employerId);
    const id = requireUuid(caseId, context.correlationId);
    const found = await getEmployerTrustCase(this.pool, employerId, id);
    if (!found) throw notFound(context.correlationId);
    return { case: found, correlationId: context.correlationId };
  }

  @Post('/employers/:employerId/trust-cases/:caseId/response')
  async respond(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('caseId') caseId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.record(request, employerId, caseId, body, 'EMPLOYER_RESPONSE');
  }

  @Post('/employers/:employerId/trust-cases/:caseId/appeal')
  async appeal(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('caseId') caseId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.record(request, employerId, caseId, body, 'EMPLOYER_APPEAL');
  }

  private async record(request: ProtectedHttpRequest, employerId: string, caseId: string, body: unknown, kind: 'EMPLOYER_RESPONSE' | 'EMPLOYER_APPEAL'): Promise<Record<string, unknown>> {
    const context = requireEmployerMembership(request, employerId, employerTrustRoles);
    const { correlationId } = context;
    const id = requireUuid(caseId, correlationId);
    const text = readStatement(body, correlationId);
    await assertEmployerState(this.db, employerId, 'trust.cases', correlationId);
    try {
      await recordEmployerTrustStatement(this.pool, {
        employerId, caseId: id, kind, body: text, actorUserId: context.authorization.principal.userId, correlationId,
      });
    } catch (error) {
      if (error instanceof TrustSafetyError) {
        if (error.code === 'TRUST_CASE_NOT_FOUND') throw notFound(correlationId);
        if (['TRUST_CASE_RESPONSE_NOT_REQUESTED', 'TRUST_CASE_NOT_APPEALABLE', 'TRUST_CASE_ALREADY_APPEALED', 'TRUST_CASE_TRANSITION_NOT_ALLOWED'].includes(error.code)) {
          throw new ConflictException(domainError(error.code, correlationId));
        }
      }
      throw new BadRequestException(domainError('TRUST_CASE_STATEMENT_REJECTED', correlationId));
    }
    return { case: await getEmployerTrustCase(this.pool, employerId, id), correlationId };
  }

  private async authorise(request: ProtectedHttpRequest, employerId: string): Promise<ReturnType<typeof requireEmployerMembership>> {
    const context = requireEmployerMembership(request, employerId, employerTrustRoles);
    await assertEmployerState(this.db, employerId, 'trust.cases', context.correlationId);
    return context;
  }
}

function readStatement(body: unknown, correlationId: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'statement')) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
  const text = typeof raw.statement === 'string' ? raw.statement.trim() : '';
  if (!text || text.length > statementMaxLength) throw new BadRequestException(domainError('TRUST_CASE_STATEMENT_INVALID', correlationId));
  return text;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
  return value;
}

function notFound(correlationId: string): NotFoundException {
  return new NotFoundException(domainError('TRUST_CASE_NOT_FOUND', correlationId));
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}
