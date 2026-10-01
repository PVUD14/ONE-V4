/**
 * The consented talent pool (EMP-14, ADR-044): who an employer may find, and what it sees.
 *
 * The one place that says which students appear in discovery (the flag, a live listing, the
 * employer-discovery consent at its current version, profile visibility EMPLOYER_DISCOVERY, an active
 * account with no deletion pending, and no block of this employer), what a card shows (only what the
 * student ticked: verified evidence per catalogue skill under EMP-13's qualifying rule, branch,
 * graduation year, preferred cities), and how a card is addressed (a per-employer pseudonym). The
 * student routes, the employer routes, the consent registry and the apply path all call these
 * functions, so the rules cannot drift apart.
 *
 * Never: a name, contact detail, college, identifier, readiness band or score, gap status, mastery
 * value, stage, marks, count, rank or sort by evidence. Design: docs/architecture/talent-pool-table-design.md.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { evidenceSource, qualifyingEvidence, type EvidenceSource } from './skill-evidence.js';

type Db = Pick<PersistenceDb, 'execute'>;
type QueryResult<T> = { rows: T[] };

/** Ships off (HG-4 approved 2026-10-01; the consent wording awaits HG-6): default off, a second person to switch on (0098). */
export const TALENT_POOL_FLAG = 'employer.talent-pool';
/** The consent the plan requires, seeded by 0098 at a draft version. */
export const DISCOVERY_CONSENT_KEY = 'employer-discovery';
/** Invitations one employer may send in any rolling 24 hours. */
export const DAILY_INVITATION_LIMIT = 20;
/** How long an invitation stays open, unless the job's deadline comes first. */
export const INVITATION_DAYS = 14;
/** Live evidence items one listing may show. */
export const MAX_LISTING_EVIDENCE = 40;
/** Own items offered per skill to choose from (every shown one is always listed). */
export const LISTING_CHOICES_PER_SKILL = 10;
export const MAX_SEARCH_SKILLS = 5;
export const SEARCH_PAGE_SIZE = 25;
export const MAX_SEARCH_PAGES = 8;
export const MAX_PREFERRED_CITIES = 5;

const cityPattern = /^[\p{L}][\p{L} .'-]{1,59}$/u;
const cardRefPattern = /^[0-9a-f]{32}$/;

export async function talentPoolEnabled(db: Db): Promise<boolean> {
  const rows = await db.execute(sql`SELECT enabled FROM feature_flags WHERE key = ${TALENT_POOL_FLAG}`) as QueryResult<{ enabled: boolean }>;
  return rows.rows[0]?.enabled === true;
}

/**
 * The consent registry asks this before listing or granting a key: a consent that gates a dark
 * feature is not offered while the feature is off. Withdrawal is never gated.
 */
export async function consentKeyOffered(db: Db, consentKey: string): Promise<boolean> {
  if (consentKey !== DISCOVERY_CONSENT_KEY) return true;
  return talentPoolEnabled(db);
}

export interface DiscoveryConsent { readonly version: string; readonly title: string; readonly documentRef: string | null }

export async function currentDiscoveryConsent(db: Db): Promise<DiscoveryConsent | null> {
  const rows = await db.execute(sql`
    SELECT version, title, document_ref FROM consent_definitions WHERE consent_key = ${DISCOVERY_CONSENT_KEY} AND retired_at IS NULL
  `) as QueryResult<{ version: string; title: string; document_ref: string | null }>;
  const [row] = rows.rows;
  return row ? { version: row.version, title: row.title, documentRef: row.document_ref ?? null } : null;
}

/** The student's latest action on the discovery consent: granted at which version, or not. */
export async function discoveryConsentState(db: Db, studentUserId: string): Promise<{ action: string; version: string } | null> {
  const rows = await db.execute(sql`
    SELECT action, version FROM user_consents WHERE user_id = ${studentUserId}::uuid AND consent_key = ${DISCOVERY_CONSENT_KEY}
    ORDER BY recorded_at DESC, id DESC LIMIT 1
  `) as QueryResult<{ action: string; version: string }>;
  return rows.rows[0] ?? null;
}

/** A catalogue skill (EMP-06): an active topic that an active career role's requirement names. */
export function catalogueTopic(topicIdColumn: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM taxonomy_nodes catalogue_node
    JOIN career_role_requirements catalogue_requirement ON catalogue_requirement.topic_id = catalogue_node.id
    JOIN career_roles catalogue_role ON catalogue_role.id = catalogue_requirement.career_role_id AND catalogue_role.active
    WHERE catalogue_node.id = ${topicIdColumn} AND catalogue_node.active)`;
}

/** The student's own consent, visibility and account conditions, on a listing alias. */
function studentStillConsents(l: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM student_profiles discovery_profile
      WHERE discovery_profile.user_id = ${l}.student_user_id AND discovery_profile.visibility_state = 'EMPLOYER_DISCOVERY')
    AND (SELECT discovery_consent.action = 'GRANTED' AND discovery_consent.version = (SELECT discovery_definition.version
        FROM consent_definitions discovery_definition
        WHERE discovery_definition.consent_key = ${DISCOVERY_CONSENT_KEY} AND discovery_definition.retired_at IS NULL)
      FROM user_consents discovery_consent
      WHERE discovery_consent.user_id = ${l}.student_user_id AND discovery_consent.consent_key = ${DISCOVERY_CONSENT_KEY}
      ORDER BY discovery_consent.recorded_at DESC, discovery_consent.id DESC LIMIT 1) IS TRUE
    AND EXISTS (SELECT 1 FROM users discovery_user
      WHERE discovery_user.id = ${l}.student_user_id AND discovery_user.state = 'ACTIVE' AND discovery_user.anonymised_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM privacy_requests discovery_deletion
      WHERE discovery_deletion.subject_user_id = ${l}.student_user_id AND discovery_deletion.request_type = 'DELETION'
        AND discovery_deletion.state IN ('RECEIVED', 'IN_PROGRESS')))`;
}

/**
 * Every condition for the listing under `listingAlias` to be found by `employerId`, at the moment of
 * the request. Nothing is cached, so leaving, withdrawing consent, changing visibility, blocking or
 * asking for deletion takes effect on the next request.
 */
export function discoverableBy(listingAlias: string, employerId: string): SQL {
  const l = sql.raw(safeAlias(listingAlias));
  return sql`(${l}.ended_at IS NULL
    AND EXISTS (SELECT 1 FROM feature_flags discovery_flag WHERE discovery_flag.key = ${TALENT_POOL_FLAG} AND discovery_flag.enabled)
    AND ${studentStillConsents(l)}
    AND NOT EXISTS (SELECT 1 FROM talent_pool_blocks discovery_block
      WHERE discovery_block.student_user_id = ${l}.student_user_id AND discovery_block.employer_id = ${employerId}::uuid
        AND discovery_block.unblocked_at IS NULL))`;
}

/** True when the student's own listing would be found by an employer they have not blocked. */
export async function studentIsDiscoverable(db: Db, studentUserId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM talent_pool_listings l
    WHERE l.student_user_id = ${studentUserId}::uuid AND l.ended_at IS NULL
      AND EXISTS (SELECT 1 FROM feature_flags discovery_flag WHERE discovery_flag.key = ${TALENT_POOL_FLAG} AND discovery_flag.enabled)
      AND ${studentStillConsents(sql.raw('l'))}
  `) as QueryResult<Record<string, unknown>>;
  return rows.rows.length > 0;
}

/** A card's address for one employer. Differs per employer and changes with every new opt-in. */
export function cardRef(listingAlias: string, employerId: string): SQL {
  const l = sql.raw(safeAlias(listingAlias));
  return sql`md5(${l}.id::text || ':' || ${employerId}::text)`;
}

export function isCardRef(value: unknown): value is string {
  return typeof value === 'string' && cardRefPattern.test(value);
}

/** The roster record a card's branch and graduation year come from: the college's own record. */
export function rosterLateral(listingAlias: string): SQL {
  const l = sql.raw(safeAlias(listingAlias));
  return sql`LEFT JOIN LATERAL (
    SELECT roster_unit.name AS branch, extract(year FROM roster_profile.expected_graduation_date)::int AS graduation_year
    FROM institution_student_profiles roster_profile
    LEFT JOIN institution_units roster_unit ON roster_unit.id = roster_profile.department_unit_id
    WHERE roster_profile.student_user_id = ${l}.student_user_id AND roster_profile.status IN ('ACTIVE', 'GRADUATED')
    ORDER BY (roster_profile.status = 'ACTIVE') DESC, roster_profile.updated_at DESC, roster_profile.id
    LIMIT 1) roster ON true`;
}

/**
 * Evidence a listing shows now: live rows, the student's own, still qualifying, on a catalogue skill.
 * `shownEvidenceJoin` is the FROM part (the evidence row under `evidenceAlias`), `shownEvidenceWhere`
 * the condition tying it to the listing under `listingAlias`.
 */
export function shownEvidenceJoin(evidenceAlias: string): SQL {
  const e = sql.raw(safeAlias(evidenceAlias));
  const shown = sql.raw(safeAlias(`${evidenceAlias}_shown`));
  return sql`talent_pool_listing_evidence ${shown}
    JOIN evidence_records ${e} ON ${e}.id = ${shown}.evidence_record_id AND ${e}.subject_user_id = ${shown}.student_user_id`;
}

export function shownEvidenceWhere(listingAlias: string, evidenceAlias: string): SQL {
  const l = sql.raw(safeAlias(listingAlias));
  const e = sql.raw(safeAlias(evidenceAlias));
  const shown = sql.raw(safeAlias(`${evidenceAlias}_shown`));
  return sql`(${shown}.listing_id = ${l}.id AND ${shown}.removed_at IS NULL AND ${shown}.student_user_id = ${l}.student_user_id
    AND ${qualifyingEvidence(evidenceAlias)} AND ${catalogueTopic(sql`${e}.topic_id`)})`;
}

/** The students' side: the invited job is visible to them while their invitation is live (or answered by applying). */
export function invitedToOpportunity(studentUserId: string, opportunityIdColumn: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM feature_flags invite_flag WHERE invite_flag.key = ${TALENT_POOL_FLAG} AND invite_flag.enabled)
    AND EXISTS (SELECT 1 FROM talent_pool_invitations invite
      WHERE invite.opportunity_id = ${opportunityIdColumn} AND invite.student_user_id = ${studentUserId}::uuid
        AND ((invite.state = 'SENT' AND invite.expires_at > now()) OR invite.state = 'APPLIED')))`;
}

export interface CardEvidenceItem {
  readonly type: string;
  readonly source: EvidenceSource;
  readonly occurredAt: unknown;
  readonly unaided: boolean;
}

/** The fields a card carries, as both the employer and (in preview) the student see them. */
export interface CardSummary {
  readonly cardRef: string;
  readonly skills: readonly string[];
  readonly branch: string | null;
  readonly graduationYear: number | null;
  readonly preferredCities: readonly string[];
}

export function mapCardSummary(row: Record<string, unknown>): CardSummary {
  return {
    cardRef: String(row.card_ref),
    skills: Array.isArray(row.skills) ? (row.skills as unknown[]).map(String) : [],
    branch: typeof row.branch === 'string' && row.branch !== '' ? row.branch : null,
    graduationYear: row.graduation_year == null ? null : Number(row.graduation_year),
    preferredCities: Array.isArray(row.preferred_cities) ? (row.preferred_cities as unknown[]).map(String) : [],
  };
}

/** One shown evidence item in the shared vocabulary. */
export function mapEvidenceItem(row: Record<string, unknown>): CardEvidenceItem {
  return { type: String(row.evidence_type), source: evidenceSource(row.source_aggregate_type), occurredAt: row.occurred_at, unaided: row.assisted !== true };
}

export interface SearchCriteria {
  readonly skills: readonly string[];
  readonly branch: string | null;
  readonly graduationYear: number | null;
  readonly city: string | null;
  readonly page: number;
}

export type CriteriaError = 'UNKNOWN_FILTER' | 'INVALID_FILTER' | 'FILTER_REQUIRED';

const searchKeys = new Set(['skill', 'branch', 'graduationYear', 'city', 'page']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The search filters, and only these. Any other parameter is refused, so a protected attribute can
 * never become a filter by accident.
 */
export function readSearchCriteria(query: Record<string, unknown>): SearchCriteria | CriteriaError {
  if (Object.keys(query).some((key) => !searchKeys.has(key))) return 'UNKNOWN_FILTER';
  const rawSkills = query.skill === undefined ? [] : Array.isArray(query.skill) ? query.skill : [query.skill];
  if (rawSkills.length > MAX_SEARCH_SKILLS || !rawSkills.every((value) => typeof value === 'string' && uuidPattern.test(value))) return 'INVALID_FILTER';
  const skills = [...new Set((rawSkills as string[]).map((value) => value.toLowerCase()))];
  const text = (value: unknown): string | null | false => {
    if (value === undefined) return null;
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length <= 60 ? trimmed : false;
  };
  const branch = text(query.branch);
  const city = text(query.city);
  if (branch === false || city === false) return 'INVALID_FILTER';
  let graduationYear: number | null = null;
  if (query.graduationYear !== undefined && query.graduationYear !== '') {
    if (typeof query.graduationYear !== 'string' || !/^\d{4}$/.test(query.graduationYear)) return 'INVALID_FILTER';
    graduationYear = Number(query.graduationYear);
    if (graduationYear < 1950 || graduationYear > 2100) return 'INVALID_FILTER';
  }
  let page = 0;
  if (query.page !== undefined) {
    if (typeof query.page !== 'string' || !/^\d{1,2}$/.test(query.page) || Number(query.page) >= MAX_SEARCH_PAGES) return 'INVALID_FILTER';
    page = Number(query.page);
  }
  if (!skills.length && branch === null && city === null && graduationYear === null) return 'FILTER_REQUIRED';
  return { skills, branch, graduationYear, city, page };
}

/** Escapes LIKE wildcards in a user-typed fragment. */
export function likeFragment(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Preferred cities from a request body: up to five, letters with spaces, dots, apostrophes and
 * hyphens, 2–60 characters each, de-duplicated without regard to case. Null for an invalid value.
 */
export function readPreferredCities(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PREFERRED_CITIES) return null;
  const cities: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const city = item.trim().replace(/\s+/g, ' ');
    if (!cityPattern.test(city)) return null;
    if (!cities.some((existing) => existing.toLowerCase() === city.toLowerCase())) cities.push(city);
  }
  return cities;
}

/** The student's own qualifying evidence per catalogue skill, with what `listingId` shows now. */
export async function readListingChoices(db: Db, studentUserId: string, listingId: string | null): Promise<{ name: string; items: (CardEvidenceItem & { evidenceId: string; shown: boolean })[] }[]> {
  const listing = listingId ?? '00000000-0000-0000-0000-000000000000';
  const rows = await db.execute(sql`
    SELECT t.id AS topic_id, t.name, q.id AS evidence_id, q.evidence_type, q.source_aggregate_type, q.occurred_at, q.assisted, q.shown_at
    FROM (
      SELECT e.id, e.topic_id, e.evidence_type, e.source_aggregate_type, e.occurred_at, e.assisted, shown.shown_at,
             row_number() OVER (PARTITION BY e.topic_id ORDER BY e.occurred_at DESC, e.id) AS position
      FROM evidence_records e
      LEFT JOIN talent_pool_listing_evidence shown ON shown.listing_id = ${listing}::uuid
        AND shown.evidence_record_id = e.id AND shown.removed_at IS NULL
      WHERE e.subject_user_id = ${studentUserId}::uuid AND ${qualifyingEvidence('e')} AND ${catalogueTopic(sql`e.topic_id`)}
    ) q
    JOIN taxonomy_nodes t ON t.id = q.topic_id
    WHERE q.position <= ${LISTING_CHOICES_PER_SKILL} OR q.shown_at IS NOT NULL
    ORDER BY lower(t.name), t.id, q.occurred_at DESC, q.id
  `) as QueryResult<Record<string, unknown>>;
  const skills: { topic: string; name: string; items: (CardEvidenceItem & { evidenceId: string; shown: boolean })[] }[] = [];
  for (const row of rows.rows) {
    let skill = skills[skills.length - 1];
    if (!skill || skill.topic !== String(row.topic_id)) {
      skill = { topic: String(row.topic_id), name: String(row.name), items: [] };
      skills.push(skill);
    }
    skill.items.push({ evidenceId: String(row.evidence_id), ...mapEvidenceItem(row), shown: row.shown_at != null });
  }
  return skills.map(({ name, items }) => ({ name, items }));
}

export class ListingEvidenceError extends Error {
  constructor(readonly code: 'EVIDENCE_NOT_SHOWABLE' | 'TOO_MANY_EVIDENCE_ITEMS') {
    super(code);
  }
}

/**
 * Replaces what a live listing shows with `evidenceIds`: items left out are removed, new ones are
 * checked against the qualifying rule and the catalogue and inserted. Runs in the caller's
 * transaction, which holds the student's talent-pool lock.
 */
export async function replaceListingEvidence(tx: Db, ids: { uuid(): string }, input: { listingId: string; studentUserId: string; evidenceIds: readonly string[] }): Promise<{ added: number; removed: number }> {
  const wanted = [...new Set(input.evidenceIds.map((id) => id.toLowerCase()))];
  if (wanted.length > MAX_LISTING_EVIDENCE) throw new ListingEvidenceError('TOO_MANY_EVIDENCE_ITEMS');
  const current = await tx.execute(sql`
    SELECT evidence_record_id FROM talent_pool_listing_evidence WHERE listing_id = ${input.listingId}::uuid AND removed_at IS NULL
  `) as QueryResult<{ evidence_record_id: string }>;
  const live = new Set(current.rows.map((row) => String(row.evidence_record_id).toLowerCase()));
  const adding = wanted.filter((id) => !live.has(id));
  const removing = [...live].filter((id) => !wanted.includes(id));
  if (adding.length) {
    const showable = await tx.execute(sql`
      SELECT e.id FROM evidence_records e
      WHERE e.id IN (${sql.join(adding.map((id) => sql`${id}::uuid`), sql`, `)})
        AND e.subject_user_id = ${input.studentUserId}::uuid AND ${qualifyingEvidence('e')} AND ${catalogueTopic(sql`e.topic_id`)}
    `) as QueryResult<{ id: string }>;
    if (showable.rows.length !== adding.length) throw new ListingEvidenceError('EVIDENCE_NOT_SHOWABLE');
  }
  if (removing.length) {
    await tx.execute(sql`
      UPDATE talent_pool_listing_evidence SET removed_at = now(), removed_reason = 'STUDENT_REMOVED'
      WHERE listing_id = ${input.listingId}::uuid AND removed_at IS NULL
        AND evidence_record_id IN (${sql.join(removing.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
  }
  if (adding.length) {
    await tx.execute(sql`
      INSERT INTO talent_pool_listing_evidence (id, listing_id, student_user_id, evidence_record_id)
      VALUES ${sql.join(adding.map((id) => sql`(${ids.uuid()}::uuid, ${input.listingId}::uuid, ${input.studentUserId}::uuid, ${id}::uuid)`), sql`, `)}
    `);
  }
  return { added: adding.length, removed: removing.length };
}

/**
 * Ends the student's live listing (opt-out or deletion): its evidence rows are removed, the listing is
 * ended. Returns whether a listing was live. The caller records the consent withdrawal.
 */
export async function endLiveListing(tx: Db, studentUserId: string, reason: 'STUDENT_OPTED_OUT' | 'ACCOUNT_DELETION'): Promise<boolean> {
  await tx.execute(sql`
    UPDATE talent_pool_listing_evidence SET removed_at = now(), removed_reason = 'LISTING_ENDED'
    WHERE student_user_id = ${studentUserId}::uuid AND removed_at IS NULL
      AND listing_id IN (SELECT id FROM talent_pool_listings WHERE student_user_id = ${studentUserId}::uuid AND ended_at IS NULL)
  `);
  const ended = await tx.execute(sql`
    UPDATE talent_pool_listings SET ended_at = greatest(now(), opted_in_at), end_reason = ${reason}, updated_at = greatest(now(), opted_in_at)
    WHERE student_user_id = ${studentUserId}::uuid AND ended_at IS NULL
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return ended.rows.length > 0;
}

function safeAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('invalid SQL alias');
  return alias;
}
