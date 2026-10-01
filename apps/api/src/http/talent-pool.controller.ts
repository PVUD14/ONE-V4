/**
 * The consented talent pool (EMP-14, ADR-044): the student's opt-in and the employer's discovery.
 *
 * Student (`/students/me/talent-pool…`): see what a card would show and choose it; join (an explicit
 * act that grants the employer-discovery consent and sets profile visibility EMPLOYER_DISCOVERY);
 * change it; leave at any time; answer invitations; block and unblock employers. Leaving, blocking and
 * declining are always allowed; joining and changing need the flag.
 *
 * Employer (`/employers/:employerId/talent-pool…`): filter (never rank) the pool, open one card, invite a
 * card to apply to an invite-only job, and see its own invitations. Every route runs EMP-03's
 * `requireActiveEmployer(…, 'candidates')` first; with the flag off each answers `available: false`
 * without reading any student data. Searches, card views and invitations are audited in the same
 * transaction. No name, contact, college, identifier, score, stage, count or rank: see talent-pool.ts.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { employerMemberRoles, requireActiveEmployer } from './employer-organisation-state.js';
import { readEvidenceRecordIds } from './skill-evidence.js';
import { recordNotification } from './notify.js';
import {
  DAILY_INVITATION_LIMIT,
  DISCOVERY_CONSENT_KEY,
  INVITATION_DAYS,
  ListingEvidenceError,
  MAX_LISTING_EVIDENCE,
  SEARCH_PAGE_SIZE,
  cardRef,
  currentDiscoveryConsent,
  discoverableBy,
  discoveryConsentState,
  endLiveListing,
  isCardRef,
  likeFragment,
  mapCardSummary,
  mapEvidenceItem,
  readListingChoices,
  readPreferredCities,
  readSearchCriteria,
  replaceListingEvidence,
  rosterLateral,
  shownEvidenceJoin,
  shownEvidenceWhere,
  studentIsDiscoverable,
  talentPoolEnabled,
} from './talent-pool.js';

type QueryResult<T> = { rows: T[] };
type Db = Pick<PersistenceDb, 'execute'>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const listingKeys = new Set(['consentVersion', 'showBranch', 'showGraduationYear', 'preferredCities', 'evidenceRecordIds']);

@Controller('/api/v1')
export class TalentPoolController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Student
  // ---------------------------------------------------------------------------------------------

  /** The student's own talent-pool page: what a card would show, what it shows now, invitations, blocks. */
  @Get('/students/me/talent-pool')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async studentView(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    return { talentPool: await this.ownView(this.db, context.authorization.principal.userId), correlationId: context.correlationId };
  }

  /**
   * Join, or change what the card shows. Joining is explicit: `consentVersion` must be the current
   * version of the employer-discovery consent, and sending it (re)grants the consent and sets profile
   * visibility to EMPLOYER_DISCOVERY. Without it, only the card's contents change.
   */
  @Put('/students/me/talent-pool')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async saveListing(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const correlationId = context.correlationId;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !listingKeys.has(key))) throw badRequest('UNKNOWN_FIELD', correlationId);
    if (record.consentVersion !== undefined && (typeof record.consentVersion !== 'string' || record.consentVersion.length > 64)) throw badRequest('INVALID_CONSENT_VERSION', correlationId);
    for (const key of ['showBranch', 'showGraduationYear'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'boolean') throw badRequest('INVALID_BODY', correlationId);
    }
    const cities = readPreferredCities(record.preferredCities);
    if (cities === null) throw badRequest('INVALID_PREFERRED_CITIES', correlationId);
    const evidenceIds = Array.isArray(record.evidenceRecordIds) && record.evidenceRecordIds.length > MAX_LISTING_EVIDENCE ? null : readEvidenceRecordIds(record.evidenceRecordIds);
    if (evidenceIds === null) throw badRequest('INVALID_EVIDENCE_SELECTION', correlationId);
    const consentVersion = typeof record.consentVersion === 'string' ? record.consentVersion : null;

    const view = await this.db.transaction(async (tx) => {
      await lockStudent(tx, studentUserId);
      if (!(await talentPoolEnabled(tx))) throw badRequest('TALENT_POOL_UNAVAILABLE', correlationId);
      const consent = await currentDiscoveryConsent(tx);
      if (!consent) throw badRequest('TALENT_POOL_UNAVAILABLE', correlationId);
      const live = await readLiveListing(tx, studentUserId);
      if (!live && consentVersion === null) throw badRequest('CONSENT_REQUIRED', correlationId);
      if (consentVersion !== null && consentVersion !== consent.version) throw badRequest('CONSENT_VERSION_MISMATCH', correlationId);

      let listingId: string;
      if (live) {
        listingId = live.id;
        await tx.execute(sql`
          UPDATE talent_pool_listings SET
            show_branch = coalesce(${typeof record.showBranch === 'boolean' ? record.showBranch : null}::boolean, show_branch),
            show_graduation_year = coalesce(${typeof record.showGraduationYear === 'boolean' ? record.showGraduationYear : null}::boolean, show_graduation_year),
            preferred_cities = ${record.preferredCities === undefined ? sql`preferred_cities` : sql`${textArray(cities)}`},
            updated_at = greatest(now(), opted_in_at)
          WHERE id = ${listingId}::uuid
        `);
      } else {
        listingId = this.ids.uuid();
        await tx.execute(sql`
          INSERT INTO talent_pool_listings (id, student_user_id, show_branch, show_graduation_year, preferred_cities, consent_version)
          VALUES (${listingId}::uuid, ${studentUserId}::uuid, ${record.showBranch === true}, ${record.showGraduationYear === true}, ${textArray(cities)}, ${consent.version})
        `);
      }
      if (consentVersion !== null) {
        // The explicit act of joining: the consent at the version shown, and the profile visibility the
        // plan requires alongside it. Both are the student's own records.
        const held = await discoveryConsentState(tx, studentUserId);
        if (!(held?.action === 'GRANTED' && held.version === consent.version)) {
          await tx.execute(sql`
            INSERT INTO user_consents (id, user_id, consent_key, version, action, correlation_id)
            VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, ${DISCOVERY_CONSENT_KEY}, ${consent.version}, 'GRANTED', ${correlationId})
          `);
        }
        await tx.execute(sql`
          INSERT INTO student_profiles (user_id, visibility_state, employer_discovery_enabled, updated_at)
          VALUES (${studentUserId}::uuid, 'EMPLOYER_DISCOVERY', true, now())
          ON CONFLICT (user_id) DO UPDATE SET visibility_state = 'EMPLOYER_DISCOVERY', employer_discovery_enabled = true, updated_at = now()
        `);
      }
      let changed = { added: 0, removed: 0 };
      if (record.evidenceRecordIds !== undefined) {
        try {
          changed = await replaceListingEvidence(tx, this.ids, { listingId, studentUserId, evidenceIds });
        } catch (error) {
          if (error instanceof ListingEvidenceError) throw badRequest(error.code, correlationId);
          throw error;
        }
      }
      await writeAudit(tx, this.ids.uuid(), studentUserId, live ? 'talent_pool.listing_updated' : 'talent_pool.opted_in', 'talent_pool_listing', listingId, null, correlationId,
        { evidenceAdded: changed.added, evidenceRemoved: changed.removed, consentGranted: consentVersion !== null });
      return this.ownView(tx, studentUserId);
    });
    return { talentPool: view, correlationId };
  }

  /** Leave the pool. Always allowed; effective on the next employer request. */
  @Delete('/students/me/talent-pool')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async leave(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    const view = await this.db.transaction(async (tx) => {
      await lockStudent(tx, studentUserId);
      const ended = await endLiveListing(tx, studentUserId, 'STUDENT_OPTED_OUT');
      const held = await discoveryConsentState(tx, studentUserId);
      if (held?.action === 'GRANTED') {
        await tx.execute(sql`
          INSERT INTO user_consents (id, user_id, consent_key, version, action, correlation_id)
          VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, ${DISCOVERY_CONSENT_KEY}, ${held.version}, 'WITHDRAWN', ${context.correlationId})
        `);
      }
      // Narrowed, never widened: discovery goes, the college view the student already had stays.
      await tx.execute(sql`
        UPDATE student_profiles SET visibility_state = CASE WHEN visibility_state = 'EMPLOYER_DISCOVERY' THEN 'INSTITUTION_VISIBLE' ELSE visibility_state END,
          employer_discovery_enabled = false, updated_at = now()
        WHERE user_id = ${studentUserId}::uuid AND (visibility_state = 'EMPLOYER_DISCOVERY' OR employer_discovery_enabled)
      `);
      if (ended || held?.action === 'GRANTED') {
        await writeAudit(tx, this.ids.uuid(), studentUserId, 'talent_pool.opted_out', 'user', studentUserId, null, context.correlationId, { listingEnded: ended });
      }
      return this.ownView(tx, studentUserId);
    });
    return { talentPool: view, correlationId: context.correlationId };
  }

  /** Decline an invitation. The employer is not told; it looks like no answer until it expires. */
  @Post('/students/me/talent-pool/invitations/:invitationId/decline')
  @UseGuards(ProtectedApiAuthenticationGuard)
  @HttpCode(200)
  async decline(@Req() request: ProtectedHttpRequest, @Param('invitationId') invitationId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    if (!uuidPattern.test(invitationId)) throw forbidden(context.correlationId);
    const view = await this.db.transaction(async (tx) => {
      const declined = await tx.execute(sql`
        UPDATE talent_pool_invitations SET state = 'DECLINED', responded_at = greatest(now(), created_at)
        WHERE id = ${invitationId}::uuid AND student_user_id = ${studentUserId}::uuid AND state = 'SENT' AND expires_at > now()
        RETURNING employer_id
      `) as QueryResult<{ employer_id: string }>;
      const [row] = declined.rows;
      if (!row) throw badRequest('INVITATION_NOT_OPEN', context.correlationId);
      await writeAudit(tx, this.ids.uuid(), studentUserId, 'talent_pool.invitation_declined', 'talent_pool_invitation', invitationId, row.employer_id, context.correlationId, {});
      return this.ownView(tx, studentUserId);
    });
    return { talentPool: view, correlationId: context.correlationId };
  }

  /** Verified employers by name, for the student to choose one to block. Names only; never candidates. */
  @Get('/students/me/talent-pool/employers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async findEmployers(@Req() request: ProtectedHttpRequest, @Query('q') q?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 80) throw badRequest('INVALID_QUERY', context.correlationId);
    const pattern = likeFragment(q.trim());
    const rows = await this.db.execute(sql`
      SELECT org.id, coalesce(nullif(profile.display_name, ''), org.legal_name) AS name
      FROM organizations org LEFT JOIN organization_profiles profile ON profile.organization_id = org.id
      WHERE org.kind = 'EMPLOYER' AND org.verification_state = 'VERIFIED' AND org.active
        AND (org.legal_name ILIKE ${pattern} OR profile.display_name ILIKE ${pattern})
      ORDER BY lower(coalesce(nullif(profile.display_name, ''), org.legal_name)), org.id
      LIMIT 10
    `) as QueryResult<{ id: string; name: string }>;
    return { employers: rows.rows.map((row) => ({ employerId: row.id, name: row.name })), correlationId: context.correlationId };
  }

  /**
   * Block an employer: it never finds this student and cannot invite them, and its unanswered
   * invitations are cancelled (they look like no answer to the employer). Always allowed.
   */
  @Post('/students/me/talent-pool/blocks')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async block(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', context.correlationId);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'employerId')) throw badRequest('UNKNOWN_FIELD', context.correlationId);
    const employerId = record.employerId;
    if (typeof employerId !== 'string' || !uuidPattern.test(employerId)) throw badRequest('INVALID_EMPLOYER', context.correlationId);
    const view = await this.db.transaction(async (tx) => {
      await lockStudent(tx, studentUserId);
      const employer = await tx.execute(sql`SELECT 1 FROM organizations WHERE id = ${employerId}::uuid AND kind = 'EMPLOYER'`) as QueryResult<Record<string, unknown>>;
      if (!employer.rows.length) throw badRequest('INVALID_EMPLOYER', context.correlationId);
      const inserted = await tx.execute(sql`
        INSERT INTO talent_pool_blocks (id, student_user_id, employer_id) VALUES (${this.ids.uuid()}::uuid, ${studentUserId}::uuid, ${employerId}::uuid)
        ON CONFLICT (student_user_id, employer_id) WHERE unblocked_at IS NULL DO NOTHING RETURNING id
      `) as QueryResult<{ id: string }>;
      await tx.execute(sql`
        UPDATE talent_pool_invitations SET state = 'CANCELLED', cancel_reason = 'STUDENT_BLOCKED', responded_at = greatest(now(), created_at)
        WHERE student_user_id = ${studentUserId}::uuid AND employer_id = ${employerId}::uuid AND state = 'SENT'
      `);
      if (inserted.rows.length) await writeAudit(tx, this.ids.uuid(), studentUserId, 'talent_pool.employer_blocked', 'organization', employerId, employerId, context.correlationId, {});
      return this.ownView(tx, studentUserId);
    });
    return { talentPool: view, correlationId: context.correlationId };
  }

  // The parameter is not called employerId: that name makes the authentication guard scope the request to
  // the caller's membership of that organisation, which a student never has.
  @Delete('/students/me/talent-pool/blocks/:blockedEmployerId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async unblock(@Req() request: ProtectedHttpRequest, @Param('blockedEmployerId') employerId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const studentUserId = context.authorization.principal.userId;
    if (!uuidPattern.test(employerId)) throw badRequest('INVALID_EMPLOYER', context.correlationId);
    const view = await this.db.transaction(async (tx) => {
      const lifted = await tx.execute(sql`
        UPDATE talent_pool_blocks SET unblocked_at = greatest(now(), blocked_at)
        WHERE student_user_id = ${studentUserId}::uuid AND employer_id = ${employerId}::uuid AND unblocked_at IS NULL RETURNING id
      `) as QueryResult<{ id: string }>;
      if (lifted.rows.length) await writeAudit(tx, this.ids.uuid(), studentUserId, 'talent_pool.employer_unblocked', 'organization', employerId, employerId, context.correlationId, {});
      return this.ownView(tx, studentUserId);
    });
    return { talentPool: view, correlationId: context.correlationId };
  }

  private async ownView(db: Db, studentUserId: string): Promise<Record<string, unknown>> {
    const enabled = await talentPoolEnabled(db);
    const live = await readLiveListing(db, studentUserId);
    const blocks = await db.execute(sql`
      SELECT b.employer_id, coalesce(nullif(profile.display_name, ''), org.legal_name) AS name, b.blocked_at
      FROM talent_pool_blocks b JOIN organizations org ON org.id = b.employer_id
      LEFT JOIN organization_profiles profile ON profile.organization_id = org.id
      WHERE b.student_user_id = ${studentUserId}::uuid AND b.unblocked_at IS NULL
      ORDER BY b.blocked_at DESC, b.id
    `) as QueryResult<Record<string, unknown>>;
    const base = {
      available: enabled,
      optedIn: live !== null,
      blocks: blocks.rows.map((row) => ({ employerId: row.employer_id, employerName: row.name, blockedAt: row.blocked_at })),
    };
    // Dark: nothing is offered. A listing made while it was on is reported so it can still be ended.
    if (!enabled) return { ...base, discoverable: false, consent: null, listing: null, roster: null, skills: [], invitations: [] };

    const consent = await currentDiscoveryConsent(db);
    const held = await discoveryConsentState(db, studentUserId);
    const profile = await db.execute(sql`SELECT visibility_state FROM student_profiles WHERE user_id = ${studentUserId}::uuid`) as QueryResult<{ visibility_state: string }>;
    const roster = await db.execute(sql`
      SELECT roster.branch, roster.graduation_year FROM (SELECT ${studentUserId}::uuid AS student_user_id) l ${rosterLateral('l')}
    `) as QueryResult<{ branch: string | null; graduation_year: number | null }>;
    const invitations = await db.execute(sql`
      SELECT i.id, i.opportunity_id, i.state, i.created_at, i.expires_at, i.responded_at, (i.state = 'SENT' AND i.expires_at <= now()) AS expired,
             coalesce(nullif(profile.display_name, ''), org.legal_name) AS employer_name, v.title
      FROM talent_pool_invitations i
      JOIN organizations org ON org.id = i.employer_id
      LEFT JOIN organization_profiles profile ON profile.organization_id = org.id
      JOIN opportunities o ON o.id = i.opportunity_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE i.student_user_id = ${studentUserId}::uuid
      ORDER BY i.created_at DESC, i.id
      LIMIT 50
    `) as QueryResult<Record<string, unknown>>;
    return {
      ...base,
      discoverable: await studentIsDiscoverable(db, studentUserId),
      consent: consent ? { version: consent.version, title: consent.title, granted: held?.action === 'GRANTED' && held.version === consent.version } : null,
      visibility: profile.rows[0]?.visibility_state ?? 'PRIVATE',
      listing: live ? { showBranch: live.showBranch, showGraduationYear: live.showGraduationYear, preferredCities: live.preferredCities, optedInAt: live.optedInAt } : null,
      // The student's own roster values, so they can see exactly what ticking would show.
      roster: { branch: roster.rows[0]?.branch ?? null, graduationYear: roster.rows[0]?.graduation_year == null ? null : Number(roster.rows[0].graduation_year) },
      skills: await readListingChoices(db, studentUserId, live?.id ?? null),
      invitations: invitations.rows.map((row) => ({
        id: row.id, opportunityId: row.opportunity_id, employerName: row.employer_name, title: row.title ?? null,
        state: row.expired === true ? 'EXPIRED' : row.state, sentAt: row.created_at, expiresAt: row.expires_at, respondedAt: row.responded_at ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Employer
  // ---------------------------------------------------------------------------------------------

  /** The employer's own side: jobs it can invite to, invitations left today, and its invitations. No student data. */
  @Get('/employers/:employerId/talent-pool')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async employerOverview(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    if (!(await talentPoolEnabled(this.db))) return { talentPool: { available: false }, correlationId: context.correlationId };
    const jobs = await this.db.execute(sql`
      SELECT o.id, o.reference_code, v.title, v.application_deadline FROM opportunities o
      JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE o.employer_id = ${employerId}::uuid AND o.lifecycle_state = 'PUBLISHED'
        AND (v.application_deadline IS NULL OR v.application_deadline > now())
        AND EXISTS (SELECT 1 FROM opportunity_audiences oa WHERE oa.opportunity_id = o.id AND oa.audience_kind = 'INVITE_ONLY')
      ORDER BY o.published_at DESC NULLS LAST, o.id
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    const used = await invitationsInLastDay(this.db, employerId);
    // A decline or a block looks like no answer until the invitation expires (as INST-14).
    const invitations = await this.db.execute(sql`
      SELECT i.created_at, i.expires_at, v.title,
        CASE WHEN i.state = 'APPLIED' THEN 'APPLIED' WHEN i.expires_at > now() THEN 'PENDING' ELSE 'CLOSED' END AS status
      FROM talent_pool_invitations i JOIN opportunities o ON o.id = i.opportunity_id
      LEFT JOIN opportunity_versions v ON v.id = o.current_version_id
      WHERE i.employer_id = ${employerId}::uuid
      ORDER BY i.created_at DESC, i.id
      LIMIT 50
    `) as QueryResult<Record<string, unknown>>;
    return {
      talentPool: {
        available: true,
        invitableJobs: jobs.rows.map((row) => ({ opportunityId: row.id, title: row.title, referenceCode: row.reference_code ?? null, applicationDeadline: row.application_deadline ?? null })),
        dailyInvitationLimit: DAILY_INVITATION_LIMIT,
        invitationsLeftToday: Math.max(0, DAILY_INVITATION_LIMIT - used),
        invitations: invitations.rows.map((row) => ({ title: row.title ?? null, sentAt: row.created_at, expiresAt: row.expires_at, status: row.status })),
      },
      correlationId: context.correlationId,
    };
  }

  /** Filter the pool. Never a score or a rank: the order is a per-employer hash of the card. Audited. */
  @Get('/employers/:employerId/talent-pool/search')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async search(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const criteria = readSearchCriteria(query ?? {});
    if (typeof criteria === 'string') throw badRequest(criteria, context.correlationId);
    if (!(await talentPoolEnabled(this.db))) return { talentPool: { available: false, cards: [], hasMore: false }, correlationId: context.correlationId };

    const skillConditions = criteria.skills.map((topicId, index) => {
      const alias = `match_evidence_${index}`;
      return sql`EXISTS (SELECT 1 FROM ${shownEvidenceJoin(alias)} WHERE ${shownEvidenceWhere('pool', alias)} AND ${sql.raw(alias)}.topic_id = ${topicId}::uuid)`;
    });
    const rows = await this.db.execute(sql`
      WITH pool AS (
        SELECT l.id, l.student_user_id, l.preferred_cities, ${cardRef('l', employerId)} AS card_ref,
               CASE WHEN l.show_branch THEN roster.branch END AS branch,
               CASE WHEN l.show_graduation_year THEN roster.graduation_year END AS graduation_year
        FROM talent_pool_listings l ${rosterLateral('l')}
        WHERE ${discoverableBy('l', employerId)}
      )
      SELECT pool.card_ref, pool.branch, pool.graduation_year, pool.preferred_cities,
        ARRAY(SELECT DISTINCT skill_node.name FROM ${shownEvidenceJoin('card_evidence')}
          JOIN taxonomy_nodes skill_node ON skill_node.id = card_evidence.topic_id
          WHERE ${shownEvidenceWhere('pool', 'card_evidence')} ORDER BY skill_node.name) AS skills
      FROM pool
      WHERE ${criteria.branch === null ? sql`true` : sql`pool.branch ILIKE ${likeFragment(criteria.branch)}`}
        AND ${criteria.graduationYear === null ? sql`true` : sql`pool.graduation_year = ${criteria.graduationYear}`}
        AND ${criteria.city === null ? sql`true` : sql`EXISTS (SELECT 1 FROM unnest(pool.preferred_cities) city WHERE lower(city) = lower(${criteria.city}))`}
        ${skillConditions.length ? sql`AND ${sql.join(skillConditions, sql` AND `)}` : sql``}
      ORDER BY md5(pool.card_ref), pool.card_ref
      LIMIT ${SEARCH_PAGE_SIZE + 1} OFFSET ${criteria.page * SEARCH_PAGE_SIZE}
    `) as QueryResult<Record<string, unknown>>;
    const page = rows.rows.slice(0, SEARCH_PAGE_SIZE);
    await writeAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'talent_pool.searched', 'organization', employerId, employerId, context.correlationId, {
      skills: criteria.skills.length, branch: criteria.branch, graduationYear: criteria.graduationYear, city: criteria.city, page: criteria.page, cardsReturned: page.length,
    });
    return {
      talentPool: { available: true, cards: page.map(mapCardSummary), hasMore: rows.rows.length > SEARCH_PAGE_SIZE },
      correlationId: context.correlationId,
    };
  }

  /** One card, with its evidence items per skill. Audited against the listing (operators see whose; the employer never does). */
  @Get('/employers/:employerId/talent-pool/cards/:cardRef')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async card(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Param('cardRef') ref: string): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    if (!isCardRef(ref)) throw cardNotAvailable(context.correlationId);
    if (!(await talentPoolEnabled(this.db))) return { talentPool: { available: false }, correlationId: context.correlationId };
    const found = await findCard(this.db, employerId, ref);
    if (!found) throw cardNotAvailable(context.correlationId);
    const items = await this.db.execute(sql`
      SELECT skill_node.name AS skill, card_evidence.evidence_type, card_evidence.source_aggregate_type, card_evidence.occurred_at, card_evidence.assisted
      FROM talent_pool_listings pool, ${shownEvidenceJoin('card_evidence')}
      JOIN taxonomy_nodes skill_node ON skill_node.id = card_evidence.topic_id
      WHERE pool.id = ${found.listingId}::uuid AND ${shownEvidenceWhere('pool', 'card_evidence')}
      ORDER BY lower(skill_node.name), card_evidence.occurred_at DESC, card_evidence.id
    `) as QueryResult<Record<string, unknown>>;
    const skills: { name: string; items: ReturnType<typeof mapEvidenceItem>[] }[] = [];
    for (const row of items.rows) {
      let skill = skills[skills.length - 1];
      if (!skill || skill.name !== String(row.skill)) { skill = { name: String(row.skill), items: [] }; skills.push(skill); }
      skill.items.push(mapEvidenceItem(row));
    }
    await writeAudit(this.db, this.ids.uuid(), context.authorization.principal.userId, 'talent_pool.card_viewed', 'talent_pool_listing', found.listingId, employerId, context.correlationId, {});
    const summary = mapCardSummary(found.row);
    return {
      talentPool: { available: true, card: { cardRef: summary.cardRef, branch: summary.branch, graduationYear: summary.graduationYear, preferredCities: summary.preferredCities, skills } },
      correlationId: context.correlationId,
    };
  }

  /**
   * Invite a card to apply to one of this employer's published invite-only jobs. The student gets an
   * in-app notice; nothing about them reaches the employer unless they apply. At most
   * DAILY_INVITATION_LIMIT in any 24 hours per employer, one per card per job. Audited.
   */
  @Post('/employers/:employerId/talent-pool/invitations')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async invite(@Req() request: ProtectedHttpRequest, @Param('employerId') employerId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requireActiveEmployer(this.db, request, employerId, 'candidates', employerMemberRoles);
    const correlationId = context.correlationId;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', correlationId);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'cardRef' && key !== 'opportunityId')) throw badRequest('UNKNOWN_FIELD', correlationId);
    if (!isCardRef(record.cardRef)) throw badRequest('INVALID_CARD', correlationId);
    if (typeof record.opportunityId !== 'string' || !uuidPattern.test(record.opportunityId)) throw badRequest('INVALID_OPPORTUNITY', correlationId);
    const ref = record.cardRef;
    const opportunityId = record.opportunityId;

    const sent = await this.db.transaction(async (tx) => {
      // Two recruiters of one employer cannot race past the daily limit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'talent-pool-invite:' + employerId}))`);
      if (!(await talentPoolEnabled(tx))) throw badRequest('TALENT_POOL_UNAVAILABLE', correlationId);
      const job = await tx.execute(sql`
        SELECT o.id, v.title, org.legal_name AS employer_name, coalesce(nullif(profile.display_name, ''), org.legal_name) AS display_name,
               least(now() + make_interval(days => ${INVITATION_DAYS}), coalesce(v.application_deadline, 'infinity'::timestamptz)) AS expires_at
        FROM opportunities o JOIN opportunity_versions v ON v.id = o.current_version_id
        JOIN organizations org ON org.id = o.employer_id
        LEFT JOIN organization_profiles profile ON profile.organization_id = org.id
        WHERE o.id = ${opportunityId}::uuid AND o.employer_id = ${employerId}::uuid AND o.lifecycle_state = 'PUBLISHED'
          AND (v.application_deadline IS NULL OR v.application_deadline > now())
          AND EXISTS (SELECT 1 FROM opportunity_audiences oa WHERE oa.opportunity_id = o.id AND oa.audience_kind = 'INVITE_ONLY')
        FOR SHARE OF o
      `) as QueryResult<Record<string, unknown>>;
      const [opportunity] = job.rows;
      if (!opportunity) throw badRequest('JOB_NOT_INVITABLE', correlationId);
      // Locks the listing, so a student leaving at this moment either lands first (and is not found) or waits.
      const listing = await tx.execute(sql`
        SELECT l.id, l.student_user_id FROM talent_pool_listings l
        WHERE ${cardRef('l', employerId)} = ${ref} AND ${discoverableBy('l', employerId)}
        FOR SHARE OF l
      `) as QueryResult<{ id: string; student_user_id: string }>;
      const [card] = listing.rows;
      if (!card) throw cardNotAvailable(correlationId);
      if ((await invitationsInLastDay(tx, employerId)) >= DAILY_INVITATION_LIMIT) {
        throw new HttpException({ error: { code: 'INVITATION_LIMIT_REACHED', message: 'Request could not be completed', correlationId } }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const invitationId = this.ids.uuid();
      const inserted = await tx.execute(sql`
        INSERT INTO talent_pool_invitations (id, employer_id, opportunity_id, listing_id, student_user_id, invited_by_user_id, expires_at)
        VALUES (${invitationId}::uuid, ${employerId}::uuid, ${opportunityId}::uuid, ${card.id}::uuid, ${card.student_user_id}::uuid,
                ${context.authorization.principal.userId}::uuid, ${opportunity.expires_at as string}::timestamptz)
        ON CONFLICT (opportunity_id, listing_id) DO NOTHING
        RETURNING expires_at
      `) as QueryResult<{ expires_at: string }>;
      if (!inserted.rows.length) throw badRequest('ALREADY_INVITED', correlationId);
      await writeAudit(tx, this.ids.uuid(), context.authorization.principal.userId, 'talent_pool.invitation_sent', 'talent_pool_invitation', invitationId, employerId, correlationId, {});
      return { studentUserId: card.student_user_id, expiresAt: inserted.rows[0]?.expires_at, title: String(opportunity.title ?? 'a role'), employerName: String(opportunity.display_name ?? opportunity.employer_name ?? 'An employer') };
    });
    // After the commit, like INST-14's nomination notices: a failed notice never undoes the invitation.
    await recordNotification(this.db, this.ids, {
      userId: sent.studentUserId, kind: 'SYSTEM', title: 'An employer invited you to apply',
      body: `${sent.employerName} found your talent pool card and invited you to apply for ${sent.title}. Nothing about you is shared with them unless you apply. See it under Profile → Talent pool.`,
      data: { screen: 'talent-pool' },
    });
    return { invitation: { status: 'PENDING', expiresAt: sent.expiresAt }, correlationId };
  }
}

interface LiveListing {
  readonly id: string;
  readonly showBranch: boolean;
  readonly showGraduationYear: boolean;
  readonly preferredCities: readonly string[];
  readonly optedInAt: unknown;
}

async function readLiveListing(db: Db, studentUserId: string): Promise<LiveListing | null> {
  const rows = await db.execute(sql`
    SELECT id, show_branch, show_graduation_year, preferred_cities, opted_in_at FROM talent_pool_listings
    WHERE student_user_id = ${studentUserId}::uuid AND ended_at IS NULL
  `) as QueryResult<Record<string, unknown>>;
  const [row] = rows.rows;
  if (!row) return null;
  return {
    id: String(row.id), showBranch: row.show_branch === true, showGraduationYear: row.show_graduation_year === true,
    preferredCities: Array.isArray(row.preferred_cities) ? (row.preferred_cities as unknown[]).map(String) : [], optedInAt: row.opted_in_at,
  };
}

async function findCard(db: Db, employerId: string, ref: string): Promise<{ listingId: string; studentUserId: string; row: Record<string, unknown> } | null> {
  const rows = await db.execute(sql`
    SELECT l.id, l.student_user_id, l.preferred_cities, ${cardRef('l', employerId)} AS card_ref,
           CASE WHEN l.show_branch THEN roster.branch END AS branch,
           CASE WHEN l.show_graduation_year THEN roster.graduation_year END AS graduation_year
    FROM talent_pool_listings l ${rosterLateral('l')}
    WHERE ${cardRef('l', employerId)} = ${ref} AND ${discoverableBy('l', employerId)}
  `) as QueryResult<Record<string, unknown>>;
  const [row] = rows.rows;
  return row ? { listingId: String(row.id), studentUserId: String(row.student_user_id), row } : null;
}

async function invitationsInLastDay(db: Db, employerId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS n FROM talent_pool_invitations WHERE employer_id = ${employerId}::uuid AND created_at > now() - interval '24 hours'
  `) as QueryResult<{ n: number }>;
  return Number(rows.rows[0]?.n ?? 0);
}

/** One talent-pool change per student at a time (two tabs, or a join racing a leave). */
async function lockStudent(tx: Db, studentUserId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'talent-pool-student:' + studentUserId}))`);
}

function textArray(values: readonly string[]): ReturnType<typeof sql> {
  return values.length ? sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;
}

async function writeAudit(db: Db, id: string, actorUserId: string, action: string, resourceType: string, resourceId: string, organizationId: string | null, correlationId: string, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, ${organizationId}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(detail)}::jsonb)
  `);
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId } });
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

/** The same answer whether the card never existed, left, blocked this employer or is being deleted. */
function cardNotAvailable(correlationId: string): NotFoundException {
  return new NotFoundException({ error: { code: 'CARD_NOT_AVAILABLE', message: 'That card is no longer in the talent pool', correlationId } });
}
