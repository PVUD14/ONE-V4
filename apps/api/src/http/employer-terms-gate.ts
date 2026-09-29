/**
 * The employer-terms publish gate (EMP-16), shared by every route that puts a job in front of
 * students anew: publish, reopen, and requesting or resubmitting a campus drive.
 *
 * Callers run it inside their write transaction, after they hold the organisation row, so an
 * owner's acceptance and a publish cannot interleave. The rule itself is one SQL predicate in
 * packages/persistence/src/employer-terms.ts. It is never retroactive: nothing already live is
 * touched when the terms change; only the next publish waits for an owner to accept.
 */
import { ForbiddenException } from '@nestjs/common';
import { employerHasAcceptedCurrentTerms } from '@planthepath/persistence/src/employer-terms.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

export const EMPLOYER_TERMS_NOT_ACCEPTED = 'EMPLOYER_TERMS_NOT_ACCEPTED';

export function employerTermsRefusal(correlationId: string): ForbiddenException {
  return new ForbiddenException({ error: { code: EMPLOYER_TERMS_NOT_ACCEPTED, message: 'Access denied', correlationId } });
}

export async function assertEmployerTermsAccepted(db: Pick<PersistenceDb, 'execute'>, employerId: string, correlationId: string): Promise<void> {
  if (!await employerHasAcceptedCurrentTerms(db, employerId)) throw employerTermsRefusal(correlationId);
}
