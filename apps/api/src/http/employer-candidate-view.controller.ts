/**
 * The employer's candidate view and résumé download (EMP-07, defects D-4 and D-7).
 *
 * Employers used to see a name, an email and a roll number. This controller shows them what the
 * student consented to share when they applied — the frozen snapshot, never the live profile —
 * with the EMP-06 eligibility outcomes (basis, never figures), the stage timeline, interviews and
 * the offer; and hands out the chosen résumé through a single-use link that lives for 60 seconds.
 *
 * Every route runs the same three checks, in order: an ACTIVE membership in a verified, active
 * employer (EMP-03, action `candidates`); the application is this employer's; and the student's
 * applicant-access grant is live at this moment (EMP-SR-01's one predicate — revoked, expired or
 * an account in deletion gives 403). Every view, link and download is audited with the
 * organisation. No readiness field exists anywhere in what is returned. Design:
 * docs/architecture/application-snapshots-table-design.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Controller, ForbiddenException, Get, Inject, NotFoundException, Optional, Param, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { assertEmployerApplicationAccess } from '@planthepath/persistence/src/employer-authentication.js';
import { employerSnapshotView } from '@planthepath/hiring/src/application-snapshot.js';
import type { FileStorage } from '../storage/file-storage.js';
import {
  API_FILE_STORAGE,
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';

type QueryResult<T> = { rows: T[] };
type Db = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** How long a résumé link lives. The 0058 CHECK caps it at five minutes. */
export const RESUME_LINK_SECONDS = 60;

@Controller('/api/v1')
export class EmployerCandidateViewController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_FILE_STORAGE) private readonly storage?: FileStorage,
  ) {}

  @Get('/employers/:employerId/applications/:applicationId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async candidate(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    await requireLiveGrant(this.db, employerId, id, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT a.id, a.state, a.opportunity_id, a.submitted_at, a.closed_at, a.updated_at,
             v.title, v.version_number AS applied_version_number, cv.version_number AS current_version_number,
             s.snapshot, s.snapshot_hash, s.created_at AS shared_at, s.erased_at,
             (s.resume_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM readable_stored_files f WHERE f.id = s.resume_file_id)) AS resume_available,
             EXISTS (SELECT 1 FROM opportunity_term_change_acknowledgements t WHERE t.application_id = a.id AND t.acknowledgement_required
               AND t.acknowledged_at IS NULL AND t.declined_at IS NULL) AS terms_pending
      FROM applications a
      JOIN opportunity_versions v ON v.id = a.applied_version_id
      JOIN opportunities o ON o.id = a.opportunity_id
      LEFT JOIN opportunity_versions cv ON cv.id = o.current_version_id
      LEFT JOIN application_profile_snapshots s ON s.application_id = a.id
      WHERE a.id = ${id}::uuid AND a.employer_id = ${employerId}::uuid AND a.state <> 'DRAFT'
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);

    const [eligibility, timeline, interviews, offer] = await Promise.all([
      this.db.execute(sql`
        SELECT e.eligible, e.outcomes, e.flag_count, e.self_reported_count, e.evaluated_at, e.trigger, ev.version_number
        FROM application_eligibility_evaluations e JOIN opportunity_versions ev ON ev.id = e.opportunity_version_id
        WHERE e.application_id = ${id}::uuid ORDER BY ev.version_number DESC LIMIT 1
      `) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`
        SELECT from_state, to_state, actor_role, reason_code, occurred_at FROM application_state_history
        WHERE application_id = ${id}::uuid ORDER BY occurred_at, id LIMIT 200
      `) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`
        SELECT i.round_number, i.mode, i.state, i.scheduled_start, i.scheduled_end,
               (SELECT count(*) FROM interview_outcomes io WHERE io.interview_id = i.id)::int AS scorecard_count
        FROM interviews i WHERE i.application_id = ${id}::uuid AND i.employer_id = ${employerId}::uuid
        ORDER BY i.round_number LIMIT 50
      `) as Promise<QueryResult<Record<string, unknown>>>,
      this.db.execute(sql`
        SELECT state, compensation_currency, compensation_amount, compensation_period, joining_date, offer_expires_at, extended_at, responded_at
        FROM offers WHERE application_id = ${id}::uuid AND employer_id = ${employerId}::uuid
        ORDER BY created_at DESC LIMIT 1
      `) as Promise<QueryResult<Record<string, unknown>>>,
    ]);

    await writeAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'application.candidate_viewed', id, employerId, context.correlationId,
      { snapshotHash: row.snapshot_hash ?? null });

    const snapshot = row.erased_at ? null : employerSnapshotView(row.snapshot, String(row.state));
    const [evaluation] = eligibility.rows;
    const [latestOffer] = offer.rows;
    return {
      candidate: {
        application: {
          id: row.id, opportunityId: row.opportunity_id, state: row.state, title: row.title,
          appliedVersionNumber: Number(row.applied_version_number),
          currentVersionNumber: row.current_version_number == null ? null : Number(row.current_version_number),
          submittedAt: row.submitted_at ?? null, closedAt: row.closed_at ?? null, updatedAt: row.updated_at,
          termsAcknowledgementPending: row.terms_pending === true,
        },
        // What the student shared, as they shared it. Applications made before snapshots existed
        // have none, and say so rather than falling back to the live profile.
        snapshot,
        snapshotStatus: snapshot ? 'SHARED' : row.erased_at ? 'ERASED' : row.snapshot_hash ? 'UNREADABLE' : 'NOT_CAPTURED',
        sharedAt: row.shared_at ?? null,
        resumeAvailable: snapshot !== null && row.resume_available === true,
        eligibility: evaluation ? {
          eligible: evaluation.eligible === true,
          evaluatedAt: evaluation.evaluated_at,
          trigger: evaluation.trigger,
          versionNumber: evaluation.version_number == null ? null : Number(evaluation.version_number),
          flagCount: Number(evaluation.flag_count ?? 0),
          selfReportedCount: Number(evaluation.self_reported_count ?? 0),
          outcomes: Array.isArray(evaluation.outcomes) ? evaluation.outcomes : [],
        } : null,
        timeline: timeline.rows.map((entry) => ({
          fromState: entry.from_state ?? null, toState: entry.to_state, actor: entry.actor_role ?? null,
          reasonCode: entry.reason_code ?? null, occurredAt: entry.occurred_at,
        })),
        interviews: interviews.rows.map((entry) => ({
          roundNumber: Number(entry.round_number), mode: entry.mode, state: entry.state,
          scheduledStart: entry.scheduled_start ?? null, scheduledEnd: entry.scheduled_end ?? null,
          scorecardCount: Number(entry.scorecard_count ?? 0),
        })),
        offer: latestOffer ? {
          state: latestOffer.state,
          compensation: latestOffer.compensation_currency ? { currency: latestOffer.compensation_currency, amount: latestOffer.compensation_amount, period: latestOffer.compensation_period } : null,
          joiningDate: latestOffer.joining_date ?? null, expiresAt: latestOffer.offer_expires_at ?? null,
          extendedAt: latestOffer.extended_at ?? null, respondedAt: latestOffer.responded_at ?? null,
        } : null,
      },
      correlationId: context.correlationId,
    };
  }

  /** Issues a single-use, 60-second link to the résumé the student attached to this application. */
  @Get('/employers/:employerId/applications/:applicationId/resume')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async resumeLink(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    const actorId = context.authorization.principal.userId;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = await this.db.transaction(async (tx) => {
      await requireLiveGrant(tx, employerId, id, context.correlationId, true);
      const files = await tx.execute(sql`
        SELECT f.id FROM application_profile_snapshots s
        JOIN applications a ON a.id = s.application_id
        JOIN readable_stored_files f ON f.id = s.resume_file_id
        WHERE s.application_id = ${id}::uuid AND a.employer_id = ${employerId}::uuid AND s.erased_at IS NULL
      `) as QueryResult<{ id: string }>;
      const [file] = files.rows;
      if (!file) throw new NotFoundException({ error: { code: 'RESUME_NOT_AVAILABLE', message: 'Request could not be completed', correlationId: context.correlationId } });
      const issued = await tx.execute(sql`
        INSERT INTO application_resume_download_links (id, application_id, employer_id, issued_to_user_id, stored_file_id, token_digest, issued_at, expires_at)
        VALUES (${this.ids.uuid()}::uuid, ${id}::uuid, ${employerId}::uuid, ${actorId}::uuid, ${file.id}::uuid, ${digest(token)},
          now(), now() + make_interval(secs => ${RESUME_LINK_SECONDS}::double precision))
        RETURNING expires_at
      `) as QueryResult<{ expires_at: Date | string }>;
      await writeAudit(tx, this.ids.uuid(), actorId, 'application.resume_link_issued', id, employerId, context.correlationId, {});
      return issued.rows[0]!.expires_at;
    });
    return {
      download: {
        path: `/api/v1/employers/${employerId}/applications/${id}/resume/file?token=${token}`,
        expiresAt,
      },
      correlationId: context.correlationId,
    };
  }

  /** Redeems a résumé link once: same employer checks, same live grant, then the bytes as an attachment. */
  @Get('/employers/:employerId/applications/:applicationId/resume/file')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async resumeFile(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('applicationId') applicationId: string,
    @Query('token') token: string | undefined, @Res() response: DownloadResponse): Promise<void> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const id = requireUuid(applicationId, context.correlationId);
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw forbidden(context.correlationId);
    const storage = this.storage;
    if (!storage) throw new ServiceUnavailableException({ error: { code: 'FILE_STORAGE_NOT_CONFIGURED', message: 'Request could not be completed', correlationId: context.correlationId } });
    const actorId = context.authorization.principal.userId;

    const file = await this.db.transaction(async (tx) => {
      // Consumed in one statement: a second redemption, another person's link, a link for another
      // application or an expired one all change nothing and are refused alike.
      const consumed = await tx.execute(sql`
        UPDATE application_resume_download_links SET consumed_at = now()
        WHERE token_digest = ${digest(token)} AND application_id = ${id}::uuid AND employer_id = ${employerId}::uuid
          AND issued_to_user_id = ${actorId}::uuid AND consumed_at IS NULL AND expires_at > now()
        RETURNING stored_file_id
      `) as QueryResult<{ stored_file_id: string }>;
      const [link] = consumed.rows;
      if (!link) throw forbidden(context.correlationId);
      // The grant is checked again now: a withdrawal inside the link's minute still ends access.
      await requireLiveGrant(tx, employerId, id, context.correlationId, true);
      const files = await tx.execute(sql`
        SELECT f.storage_key, f.original_filename, f.content_type FROM readable_stored_files f
        JOIN application_profile_snapshots s ON s.resume_file_id = f.id AND s.application_id = ${id}::uuid AND s.erased_at IS NULL
        WHERE f.id = ${link.stored_file_id}::uuid
      `) as QueryResult<{ storage_key: string; original_filename: string; content_type: string }>;
      const [stored] = files.rows;
      if (!stored) throw forbidden(context.correlationId);
      const bytes = await storage.get(stored.storage_key);
      await writeAudit(tx, this.ids.uuid(), actorId, 'application.resume_downloaded', id, employerId, context.correlationId, {});
      return { ...stored, bytes };
    });

    response.setHeader('Content-Type', file.content_type);
    response.setHeader('Content-Length', String(file.bytes.length));
    // attachment, not inline: never render an uploaded document in the site's origin.
    response.setHeader('Content-Disposition', `attachment; filename="${asciiFilename(file.original_filename)}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.send(file.bytes);
  }
}

interface DownloadResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

async function requireLiveGrant(db: Db, employerId: string, applicationId: string, correlationId: string, lock = false): Promise<void> {
  try {
    await assertEmployerApplicationAccess(db, { employerId, applicationIds: [applicationId], lockForMutation: lock });
  } catch {
    throw forbidden(correlationId);
  }
}

async function writeAudit(db: Db, id: string, actorUserId: string, action: string, applicationId: string, employerId: string, correlationId: string, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actorUserId}::uuid, ${action}, 'application', ${applicationId}::uuid, ${employerId}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(detail)}::jsonb)
  `);
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Content-Disposition must not carry quotes or non-ASCII into the header. */
function asciiFilename(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
