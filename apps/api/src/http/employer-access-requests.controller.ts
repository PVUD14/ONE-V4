/**
 * Employer access requests (EMP-04): the public "ask to join ONE as an employer" form, and
 * the Operations queue that reviews it.
 *
 * Design: docs/architecture/employer-access-requests-table-design.md, Part 2. Read it before
 * changing anything here.
 *
 * `submit` is the one unauthenticated write in ONE (ADR-031 made token-bound public reads the
 * first unauthenticated routes). It is deliberately narrow:
 *  - It creates a PENDING request and nothing else: no user, organisation, membership or
 *    invitation. An operator creates the organisation through the existing Organizations
 *    flow (which starts unverified) and links the request; verification stays a separate,
 *    audited operator action. Nothing here can express "verified".
 *  - It never reads organizations, and every well-formed submission gets the same
 *    `202 { received: true }` — new, repeated, or from a company already on ONE — so the
 *    form cannot be used to learn what exists. Possible matches are computed for Operations
 *    at read time, in the queue.
 *  - It is rate-limited per network address, per email domain and overall, counted in
 *    employer_access_request_attempts, which holds only a SHA-256 digest of the address and
 *    is pruned after two days.
 *  - Public webmail is refused unless Operations turns on `employer-access.allow-free-mail`.
 *
 * The queue (`/operations/employer-access-requests`) needs OPS_ORG_MANAGE, the capability that
 * creates organisations, and is shown on the existing Organizations screen.
 *
 * GROWTH-05 (growth-employer-pipeline-table-design.md): the form also accepts an optional `ref`, a
 * growth referral code. It is read only after the rate limits and the request upsert, inside a
 * savepoint, and an unknown, revoked or malformed code is ignored silently — the answer is the same
 * whatever it is. The queue shows the referral and the matching growth lead; marking a request
 * ONBOARDED also writes the onboarding record attribution is later built from.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { accessRequestGrowthColumns, presentAccessRequestGrowth, recordAccessRequestGrowthSignals, recordEmployerOnboarding } from './growth-employer-service.js';

type QueryResult<T> = { rows: T[] };

/** Limits from the design note. Checked before anything is written. */
export const accessRequestLimits = { perAddressPerHour: 5, perDomainPerDay: 10, overallPerHour: 200 } as const;
export const allowFreeMailFlag = 'employer-access.allow-free-mail';

/** Public webmail domains. A company asking to hire on ONE should write from its own domain. */
export const freeMailDomains: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.in', 'live.com', 'live.in', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'rediffmail.com', 'rediff.com', 'zohomail.com', 'zohomail.in', 'yandex.com', 'yandex.ru',
  'mail.com', 'gmx.com', 'gmx.net', 'tutanota.com', 'fastmail.com', 'hey.com', 'inbox.com',
]);

const requestStates = ['PENDING', 'ONBOARDED', 'DECLINED', 'SPAM'] as const;
type RequestState = typeof requestStates[number];
type Decision = Exclude<RequestState, 'PENDING'>;
/** Fixed reason codes per decision, so the queue's history is comparable. */
export const accessRequestReasonCodes: Readonly<Record<Decision, readonly string[]>> = {
  ONBOARDED: ['ORGANISATION_CREATED', 'EXISTING_ORGANISATION'],
  DECLINED: ['NOT_AN_EMPLOYER', 'COULD_NOT_CONFIRM', 'DUPLICATE_REQUEST', 'OUT_OF_SCOPE'],
  SPAM: ['BULK_SUBMISSION', 'FAKE_DETAILS', 'ABUSIVE_CONTENT'],
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const defaultLimit = 50;
const maxLimit = 200;

/** The minimum of an Express request the public route reads. */
interface PublicHttpRequest {
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined };
}

@Controller('/api/v1')
export class EmployerAccessRequestsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // ---------------------------------------------------------------------------
  // Unauthenticated.
  // ---------------------------------------------------------------------------

  @Post('/employer-access-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  async submit(@Req() request: PublicHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const correlationId = this.ids.uuid();
    const input = readSubmission(body, correlationId);
    const freeMail = freeMailDomains.has(input.emailDomain);
    if (freeMail && !await this.freeMailAllowed()) throw badRequest('EMPLOYER_ACCESS_REQUEST_WORK_EMAIL_REQUIRED', correlationId);
    const clientKey = createHash('sha256').update('employer-access-request:' + clientAddress(request)).digest('hex');

    await this.db.transaction(async (tx) => {
      // One submission at a time, so the limits below are exact rather than approximately right.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('employer_access_requests.submit'))`);
      await tx.execute(sql`DELETE FROM employer_access_request_attempts WHERE attempted_at < now() - interval '2 days'`);
      const counts = await tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE client_key = ${clientKey} AND attempted_at > now() - interval '1 hour')::int AS by_address,
          count(*) FILTER (WHERE email_domain = ${input.emailDomain} AND attempted_at > now() - interval '1 day')::int AS by_domain,
          count(*) FILTER (WHERE attempted_at > now() - interval '1 hour')::int AS overall
        FROM employer_access_request_attempts
      `) as QueryResult<{ by_address: number; by_domain: number; overall: number }>;
      const count = counts.rows[0] ?? { by_address: 0, by_domain: 0, overall: 0 };
      if (count.by_address >= accessRequestLimits.perAddressPerHour || count.by_domain >= accessRequestLimits.perDomainPerDay
        || count.overall >= accessRequestLimits.overallPerHour) {
        throw new HttpException(domainError('EMPLOYER_ACCESS_REQUEST_RATE_LIMITED', correlationId), HttpStatus.TOO_MANY_REQUESTS);
      }
      await tx.execute(sql`
        INSERT INTO employer_access_request_attempts (id, client_key, email_domain) VALUES (${this.ids.uuid()}::uuid, ${clientKey}, ${input.emailDomain})
      `);
      // A repeat of a pending request bumps its count instead of adding a queue row.
      const saved = await tx.execute(sql`
        INSERT INTO employer_access_requests (id, requester_name, company_name, work_email, email_domain, website_url, email_matches_website, free_mail)
        VALUES (${this.ids.uuid()}::uuid, ${input.requesterName}, ${input.companyName}, ${input.workEmail}, ${input.emailDomain}, ${input.websiteUrl},
                ${emailMatchesWebsite(input.emailDomain, input.websiteUrl)}, ${freeMail})
        ON CONFLICT (work_email) WHERE state = 'PENDING'
        DO UPDATE SET submission_count = employer_access_requests.submission_count + 1, last_submitted_at = now()
        RETURNING id, (xmax = 0) AS inserted
      `) as QueryResult<{ id: string; inserted: boolean }>;
      const row = saved.rows[0]!;
      // GROWTH-05: the referral and the lead match, in a savepoint; nothing here changes the answer.
      await recordAccessRequestGrowthSignals(tx, {
        requestId: row.id, ref: input.ref, emailDomain: input.emailDomain, websiteUrl: input.websiteUrl, uuid: () => this.ids.uuid(), correlationId,
      });
      if (row.inserted) {
        const event = { id: this.ids.uuid(), aggregateType: 'employer_access_request', aggregateId: row.id, eventType: 'employer_access_request.submitted',
          payload: { requestId: row.id }, correlationId };
        validateOutboxWriteInput({ ...event, eventVersion: 1 });
        await tx.execute(sql`
          INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
          VALUES (${event.id}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.eventType}, 1, ${JSON.stringify(event.payload)}::jsonb, ${correlationId})
        `);
      }
    }).catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      throw badRequest('EMPLOYER_ACCESS_REQUEST_INVALID', correlationId);
    });
    return { received: true, correlationId };
  }

  // ---------------------------------------------------------------------------
  // Operations queue.
  // ---------------------------------------------------------------------------

  @Get('/operations/employer-access-requests')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async queue(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await this.requireOperations(request);
    const { correlationId } = context;
    const source = query ?? {};
    if (Object.keys(source).some((key) => !['state', 'limit', 'cursor'].includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
    const state = readQueueState(source.state, correlationId);
    const limit = readLimit(source.limit, correlationId);
    const cursor = readCursor(source.cursor, correlationId);

    const rows = await this.db.execute(sql`
      SELECT r.id, r.requester_name, r.company_name, r.work_email, r.email_domain, r.website_url, r.email_matches_website, r.free_mail,
             r.state, r.organization_id, r.decision_reason_code, r.decided_at, r.submission_count, r.last_submitted_at, r.created_at,
             r.created_at::text AS created_at_key,
             coalesce((
               SELECT json_agg(json_build_object('organizationId', m.id, 'legalName', m.legal_name, 'verificationState', m.verification_state) ORDER BY m.legal_name)
               FROM (
                 SELECT o.id, o.legal_name, o.verification_state FROM organizations o
                 LEFT JOIN organization_profiles p ON p.organization_id = o.id
                 WHERE o.kind = 'EMPLOYER' AND (
                   lower(o.legal_name) = lower(r.company_name)
                   OR lower(coalesce(p.display_name, '')) = lower(r.company_name)
                   OR regexp_replace(lower(substring(coalesce(p.website_url, '') from '^https://([^/:?#]+)')), '^www\\.', '')
                      = regexp_replace(lower(substring(r.website_url from '^https://([^/:?#]+)')), '^www\\.', ''))
                 ORDER BY o.legal_name LIMIT 5
               ) m
             ), '[]'::json) AS possible_matches,
             ${accessRequestGrowthColumns}
      FROM employer_access_requests r
      WHERE (${state}::text IS NULL OR r.state = ${state})
        AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (r.created_at, r.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${limit + 1}
    `) as QueryResult<Record<string, unknown>>;
    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      requests: page.map(presentRequest),
      nextCursor: rows.rows.length > limit && last ? encodeCursor(String(last.created_at_key), String(last.id)) : null,
      reasonCodes: accessRequestReasonCodes,
      correlationId,
    };
  }

  @Post('/operations/employer-access-requests/:requestId/decision')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decide(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperations(request);
    const { correlationId } = context;
    if (!uuidPattern.test(requestId)) throw badRequest('INVALID_REQUEST', correlationId);
    const decision = readDecision(body, correlationId);
    const actorUserId = context.authorization.principal.userId;

    const decided = await this.db.transaction(async (tx) => {
      if (decision.organizationId) {
        const org = await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${decision.organizationId}::uuid AND kind = 'EMPLOYER'`) as QueryResult<Record<string, unknown>>;
        if (!org.rows.length) throw badRequest('EMPLOYER_ACCESS_REQUEST_ORGANIZATION_INVALID', correlationId);
      }
      const current = await tx.execute(sql`SELECT state FROM employer_access_requests WHERE id = ${requestId}::uuid FOR UPDATE`) as QueryResult<{ state: RequestState }>;
      const row = current.rows[0];
      if (!row) throw new NotFoundException(domainError('EMPLOYER_ACCESS_REQUEST_NOT_FOUND', correlationId));
      if (row.state !== 'PENDING') throw new ConflictException(domainError('EMPLOYER_ACCESS_REQUEST_NOT_PENDING', correlationId));
      await tx.execute(sql`
        UPDATE employer_access_requests
        SET state = ${decision.decision}, organization_id = ${decision.organizationId ?? null}::uuid, decided_by_user_id = ${actorUserId}::uuid,
            decided_at = now(), decision_reason_code = ${decision.reasonCode}
        WHERE id = ${requestId}::uuid
      `);
      const auditContext = { decision: decision.decision, reasonCode: decision.reasonCode, ...(decision.organizationId ? { organizationId: decision.organizationId } : {}) };
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, 'employer_access_request.decided', 'employer_access_request', ${requestId},
                ${decision.organizationId ?? null}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(auditContext)}::jsonb)
      `);
      // GROWTH-05: who could be credited, as it stands at this moment (design §8.3), and the lead linked.
      if (decision.decision === 'ONBOARDED' && decision.organizationId) {
        await recordEmployerOnboarding(tx, { requestId, organizationId: decision.organizationId, actorUserId, correlationId, uuid: () => this.ids.uuid() });
      }
      return { id: requestId, state: decision.decision, organizationId: decision.organizationId ?? null, reasonCode: decision.reasonCode };
    }).catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      throw badRequest('EMPLOYER_ACCESS_REQUEST_DECISION_REJECTED', correlationId);
    });
    return { request: decided, correlationId };
  }

  private async requireOperations(request: ProtectedHttpRequest): Promise<ReturnType<typeof requireTrustedAuthorization>> {
    const context = requireTrustedAuthorization(request);
    if (!await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(this.db), 'OPS_ORG_MANAGE')) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
    return context;
  }

  private async freeMailAllowed(): Promise<boolean> {
    const rows = await this.db.execute(sql`SELECT enabled FROM feature_flags WHERE key = ${allowFreeMailFlag}`) as QueryResult<{ enabled: boolean }>;
    return rows.rows[0]?.enabled === true;
  }
}

/**
 * The submitter's network address, for counting only. The socket peer, unless the peer is
 * our own reverse proxy (loopback or a private address), in which case the right-most
 * X-Forwarded-For entry — the one the proxy appended, which a client cannot forge.
 */
export function clientAddress(request: PublicHttpRequest): string {
  const peer = (request.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const forwarded = request.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : typeof forwarded === 'string' ? forwarded : '';
  const entries = header.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length && isProxyAddress(peer)) return entries[entries.length - 1]!.replace(/^::ffff:/, '').slice(0, 64);
  return peer || 'unknown';
}

function isProxyAddress(address: string): boolean {
  if (!address) return false;
  if (address === '::1' || address.startsWith('127.') || address.startsWith('10.') || address.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(address);
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/** The email's domain is the website's domain, a subdomain of it, or its parent. */
export function emailMatchesWebsite(emailDomain: string, websiteUrl: string): boolean {
  const host = hostOf(websiteUrl);
  if (!host) return false;
  const base = host.startsWith('www.') ? host.slice(4) : host;
  return emailDomain === base || emailDomain.endsWith('.' + base) || base.endsWith('.' + emailDomain);
}

interface Submission {
  readonly requesterName: string;
  readonly companyName: string;
  readonly workEmail: string;
  readonly emailDomain: string;
  readonly websiteUrl: string;
  /** GROWTH-05: the raw `ref`, never validated here — a malformed one is ignored like an unknown one. */
  readonly ref: unknown;
}

function readSubmission(body: unknown, correlationId: string): Submission {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  const allowed = ['requesterName', 'companyName', 'workEmail', 'websiteUrl', 'ref'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  const text = (value: unknown, max: number, code: string): string => {
    const trimmed = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!trimmed || trimmed.length > max) throw badRequest(code, correlationId);
    return trimmed;
  };
  const requesterName = text(raw.requesterName, 120, 'EMPLOYER_ACCESS_REQUEST_NAME_INVALID');
  const companyName = text(raw.companyName, 180, 'EMPLOYER_ACCESS_REQUEST_COMPANY_INVALID');
  const workEmail = typeof raw.workEmail === 'string' ? raw.workEmail.trim().toLowerCase() : '';
  if (!emailPattern.test(workEmail) || workEmail.length > 254) throw badRequest('EMPLOYER_ACCESS_REQUEST_EMAIL_INVALID', correlationId);
  const emailDomain = workEmail.slice(workEmail.lastIndexOf('@') + 1);
  if (emailDomain.length < 3 || emailDomain.length > 253) throw badRequest('EMPLOYER_ACCESS_REQUEST_EMAIL_INVALID', correlationId);
  const websiteUrl = typeof raw.websiteUrl === 'string' ? raw.websiteUrl.trim() : '';
  if (websiteUrl.length > 256 || !/^https:\/\/\S+$/i.test(websiteUrl) || !hostOf(websiteUrl)) throw badRequest('EMPLOYER_ACCESS_REQUEST_WEBSITE_INVALID', correlationId);
  return { requesterName, companyName, workEmail, emailDomain, websiteUrl, ref: raw.ref };
}

function readDecision(body: unknown, correlationId: string): { readonly decision: Decision; readonly reasonCode: string; readonly organizationId?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['decision', 'reasonCode', 'organizationId'].includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  const decision = raw.decision;
  if (decision !== 'ONBOARDED' && decision !== 'DECLINED' && decision !== 'SPAM') throw badRequest('EMPLOYER_ACCESS_REQUEST_DECISION_INVALID', correlationId);
  if (typeof raw.reasonCode !== 'string' || !accessRequestReasonCodes[decision].includes(raw.reasonCode)) throw badRequest('REASON_CODE_INVALID', correlationId);
  if (decision === 'ONBOARDED') {
    if (typeof raw.organizationId !== 'string' || !uuidPattern.test(raw.organizationId)) throw badRequest('EMPLOYER_ACCESS_REQUEST_ORGANIZATION_INVALID', correlationId);
    return { decision, reasonCode: raw.reasonCode, organizationId: raw.organizationId };
  }
  if (raw.organizationId !== undefined) throw badRequest('INVALID_REQUEST', correlationId);
  return { decision, reasonCode: raw.reasonCode };
}

function readQueueState(value: unknown, correlationId: string): RequestState | null {
  if (value === undefined || value === '') return 'PENDING';
  if (value === 'ALL') return null;
  if (typeof value !== 'string' || !(requestStates as readonly string[]).includes(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value as RequestState;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('INVALID_REQUEST', correlationId);
  return parsed;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

function readCursor(value: unknown, correlationId: string): { readonly createdAt: string; readonly id: string } | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200) throw badRequest('INVALID_REQUEST', correlationId);
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof parsed.c === 'string' && typeof parsed.i === 'string' && uuidPattern.test(parsed.i) && !Number.isNaN(Date.parse(parsed.c))) {
      return { createdAt: parsed.c, id: parsed.i };
    }
  } catch {
    // fall through to the refusal
  }
  throw badRequest('INVALID_REQUEST', correlationId);
}

function iso(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function presentRequest(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    requesterName: row.requester_name,
    companyName: row.company_name,
    workEmail: row.work_email,
    emailDomain: row.email_domain,
    websiteUrl: row.website_url,
    emailMatchesWebsite: row.email_matches_website,
    freeMail: row.free_mail,
    // No production sender exists (HG-7), so no request's email has been confirmed.
    emailConfirmed: false,
    state: row.state,
    organizationId: row.organization_id ?? null,
    decisionReasonCode: row.decision_reason_code ?? null,
    decidedAt: iso(row.decided_at),
    submissionCount: Number(row.submission_count),
    createdAt: iso(row.created_at),
    lastSubmittedAt: iso(row.last_submitted_at),
    possibleMatches: row.possible_matches ?? [],
    ...presentAccessRequestGrowth(row),
  };
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}
