/**
 * The Operations Overview summary (OPS-03, Appendix 1 §5.7): one request, every count
 * computed server-side in bounded SQL, so the Overview never fetches a full list and
 * counts it in the browser.
 *
 * Opens for any caller holding an operations capability (every ACTIVE platform role
 * does). Each section is computed only when the caller holds that module's capability
 * and is null otherwise, which the screen renders as NA — so a count never reaches
 * someone who could not open the queue behind it. The access table is in
 * packages/authorization/src/operations-overview.ts.
 *
 * Read-only and free of personal data: no names, emails or subjects are returned, and
 * counts of people below 5 are suppressed, so the read is not audited as a personal-data
 * view.
 */
import { BadRequestException, Controller, ForbiddenException, Get, Inject, InternalServerErrorException, Query, Req, UseGuards } from '@nestjs/common';
import { canViewOperationsOverview, operationsOverviewSectionsFor } from '@planthepath/authorization/src/index.js';
import { readOperationsOverview } from '@planthepath/persistence/src/operations-overview.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

@Controller('/api/v1/operations')
export class OperationsOverviewController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/overview')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async overview(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canViewOperationsOverview(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    // The summary takes no parameters; anything sent is a mistake, not a filter to ignore.
    if (Object.keys(query ?? {}).length) throw new BadRequestException(domainError('INVALID_REQUEST', context.correlationId));
    const sections = operationsOverviewSectionsFor(actor);
    try {
      const overview = await readOperationsOverview(this.db, sections);
      return { overview, viewer: { sections }, correlationId: context.correlationId };
    } catch {
      // Never forward database or driver text to the browser.
      throw new InternalServerErrorException(domainError('OVERVIEW_UNAVAILABLE', context.correlationId));
    }
  }
}
