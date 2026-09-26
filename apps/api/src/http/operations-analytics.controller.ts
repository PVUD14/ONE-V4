/**
 * Operations → Analytics: the role demand dashboard (OPS-11, Appendix 1 §4.2, §5.5–5.7).
 *
 * One bounded summary (every career role with its suppressed student count, colleges,
 * release label and promotion-rule status; demand by release label; a 12-month trend) and
 * a drill-down for one role by college and department. Both need ANALYTICS_VIEW.
 *
 * Read-only aggregates: no student name, email or identifier is returned, every count of
 * people below 5 is suppressed in the persistence layer before it reaches this file, and
 * so, like the Overview, the read is not audited as a personal-data view.
 *
 * Design: docs/architecture/role-demand-dashboard-design.md
 */
import { BadRequestException, Controller, ForbiddenException, Get, Inject, InternalServerErrorException, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { canViewRoleDemand, rolePromotionMinimumColleges, rolePromotionMinimumStudents } from '@planthepath/authorization/src/index.js';
import { readRoleDemandDetail, readRoleDemandSummary } from '@planthepath/persistence/src/role-demand.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

/** The rule the indicator applies, so the screen states it from the same constants. */
const promotionRule = { minimumStudents: rolePromotionMinimumStudents, minimumColleges: rolePromotionMinimumColleges, employerArm: 'NOT_RECORDED' } as const;

@Controller('/api/v1/operations/analytics')
export class OperationsAnalyticsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/role-demand')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async roleDemand(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const correlationId = await this.requireViewer(request);
    // The summary takes no parameters; anything sent is a mistake, not a filter to ignore.
    if (Object.keys(query ?? {}).length) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    try {
      return { demand: await readRoleDemandSummary(this.db), promotionRule, correlationId };
    } catch {
      // Never forward database or driver text to the browser.
      throw new InternalServerErrorException(domainError('ROLE_DEMAND_UNAVAILABLE', correlationId));
    }
  }

  @Get('/role-demand/roles/:roleId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async roleDemandDetail(@Req() request: ProtectedHttpRequest, @Param('roleId') roleId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const correlationId = await this.requireViewer(request);
    if (Object.keys(query ?? {}).length) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    if (!uuidPattern.test(roleId)) throw new BadRequestException(domainError('CAREER_ROLE_ID_INVALID', correlationId));
    let detail;
    try {
      detail = await readRoleDemandDetail(this.db, roleId);
    } catch {
      throw new InternalServerErrorException(domainError('ROLE_DEMAND_UNAVAILABLE', correlationId));
    }
    if (!detail) throw new NotFoundException(domainError('CAREER_ROLE_NOT_FOUND', correlationId));
    return { detail, promotionRule, correlationId };
  }

  private async requireViewer(request: ProtectedHttpRequest): Promise<string> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canViewRoleDemand(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return context.correlationId;
  }
}
