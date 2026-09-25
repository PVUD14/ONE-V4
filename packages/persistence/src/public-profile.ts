/**
 * Public profile share links: creating one, controlling it, and resolving one into the
 * page a stranger sees.
 *
 * Decision in docs/architecture/ADR-031-public-profile-share-links.md.
 *
 * `resolvePublicProfile` is the only function in the codebase that assembles data for an
 * unauthenticated caller, so the rules it enforces are worth stating where they live:
 *
 *   It reads nothing from readiness_snapshots, mastery_projections, applications,
 *   application_feedback_releases or student_document_versions. Not "filters them out" --
 *   does not join them at all.
 *
 *   Every section is gated on the student's own flag, and a flag that is false means the
 *   query for that section does not run.
 *
 *   A token that is unknown, expired or revoked all produce the same null, so the route
 *   above cannot be used to learn which tokens exist.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Anything that can run a statement. These functions never open their own connection: a
 * caller inside a transaction (a test, or a controller doing several things at once) must
 * be able to pass its own client, and a function that called `pool.connect()` internally
 * could not accept one.
 */
type Queryable = Pick<Pool | PoolClient, 'query'>;

export type CoverKey = 'MIDNIGHT' | 'TEAL' | 'VIOLET' | 'EMBER';
export const COVER_KEYS: readonly CoverKey[] = ['MIDNIGHT', 'TEAL', 'VIOLET', 'EMBER'];

/** Ninety days. A profile that lives forever is one the student forgets they left open. */
export const DEFAULT_LINK_DAYS = 90;
export const MAX_LINK_DAYS = 365;

export interface ShareSections {
  readonly showPhoto: boolean;
  readonly showHeadline: boolean;
  readonly showCity: boolean;
  readonly showInstitution: boolean;
  readonly showEducation: boolean;
  readonly showSelfReported: boolean;
  readonly showAssessments: boolean;
  readonly showLearning: boolean;
  readonly showCertificates: boolean;
  readonly showSkills: boolean;
  readonly showPortfolio: boolean;
}

export const DEFAULT_SECTIONS: ShareSections = {
  // Both defaults that matter are false, deliberately: a percentage attached to a person
  // and a face attached to a name are acts, not side effects of pressing publish.
  showPhoto: false,
  showAssessments: false,
  showHeadline: true,
  showCity: true,
  showInstitution: true,
  showEducation: true,
  showSelfReported: true,
  showLearning: true,
  showCertificates: true,
  showSkills: true,
  showPortfolio: true,
};

export interface ShareLinkRecord {
  readonly id: string;
  readonly coverKey: CoverKey;
  readonly sections: ShareSections;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastViewedAt: Date | null;
}

export class PublicProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PublicProfileError';
  }
}

/** The same hashing invitation tokens use. The raw token is never stored. */
export function digestShareToken(rawToken: string): string {
  if (!rawToken) throw new PublicProfileError('TOKEN_REQUIRED', 'a share token is required');
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function shareTokenMatches(rawToken: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digestShareToken(rawToken), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const sectionColumns = [
  'show_photo', 'show_headline', 'show_city', 'show_institution', 'show_education',
  'show_self_reported', 'show_assessments', 'show_learning', 'show_certificates',
  'show_skills', 'show_portfolio',
] as const;

function mapSections(row: Record<string, unknown>): ShareSections {
  return {
    showPhoto: row.show_photo === true,
    showHeadline: row.show_headline === true,
    showCity: row.show_city === true,
    showInstitution: row.show_institution === true,
    showEducation: row.show_education === true,
    showSelfReported: row.show_self_reported === true,
    showAssessments: row.show_assessments === true,
    showLearning: row.show_learning === true,
    showCertificates: row.show_certificates === true,
    showSkills: row.show_skills === true,
    showPortfolio: row.show_portfolio === true,
  };
}

function mapLink(row: Record<string, unknown>): ShareLinkRecord {
  return {
    id: String(row.id),
    coverKey: row.cover_key as CoverKey,
    sections: mapSections(row),
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    lastViewedAt: (row.last_viewed_at as Date | null) ?? null,
  };
}

const linkColumns = `id, cover_key, created_at, expires_at, revoked_at, last_viewed_at, ${sectionColumns.join(', ')}`;

/**
 * Publish. Any live link is revoked first, so a student never has two live addresses and
 * "revoke" means what they think it means.
 */
export async function createShareLink(
  pool: Queryable,
  input: {
    readonly studentUserId: string;
    readonly linkId: string;
    readonly tokenDigest: string;
    readonly days?: number;
    readonly coverKey?: CoverKey;
    readonly sections?: Partial<ShareSections>;
  },
): Promise<ShareLinkRecord> {
  const days = input.days ?? DEFAULT_LINK_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_LINK_DAYS) {
    throw new PublicProfileError('INVALID_DURATION', 'a share link lasts between 1 and 365 days');
  }
  const cover = input.coverKey ?? 'MIDNIGHT';
  if (!COVER_KEYS.includes(cover)) throw new PublicProfileError('INVALID_COVER', 'unknown cover');
  const sections = { ...DEFAULT_SECTIONS, ...(input.sections ?? {}) };

  // Revoke-then-insert. The caller owns the transaction; the controller wraps this so a
  // failure cannot leave a student with no live link after their old one was revoked.
  await pool.query(
    'UPDATE public_profile_links SET revoked_at = now() WHERE student_user_id = $1 AND revoked_at IS NULL',
    [input.studentUserId],
  );
  const result = await pool.query(
      `INSERT INTO public_profile_links
         (id, student_user_id, token_digest, cover_key, expires_at,
          show_photo, show_headline, show_city, show_institution, show_education,
          show_self_reported, show_assessments, show_learning, show_certificates,
          show_skills, show_portfolio)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval,
               $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING ${linkColumns}`,
      [
        input.linkId, input.studentUserId, input.tokenDigest, cover, String(days),
        sections.showPhoto, sections.showHeadline, sections.showCity, sections.showInstitution,
        sections.showEducation, sections.showSelfReported, sections.showAssessments,
        sections.showLearning, sections.showCertificates, sections.showSkills, sections.showPortfolio,
      ],
    );
  return mapLink(result.rows[0] as Record<string, unknown>);
}

export async function getLiveShareLink(pool: Queryable, studentUserId: string): Promise<ShareLinkRecord | null> {
  const result = await pool.query(
    `SELECT ${linkColumns} FROM public_profile_links
     WHERE student_user_id = $1 AND revoked_at IS NULL`,
    [studentUserId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapLink(row) : null;
}

export async function revokeShareLink(pool: Queryable, studentUserId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE public_profile_links SET revoked_at = now() WHERE student_user_id = $1 AND revoked_at IS NULL',
    [studentUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateShareLink(
  pool: Queryable,
  input: {
    readonly studentUserId: string;
    readonly coverKey?: CoverKey;
    readonly sections?: Partial<ShareSections>;
    readonly extendDays?: number;
  },
): Promise<ShareLinkRecord> {
  const live = await getLiveShareLink(pool, input.studentUserId);
  if (!live) throw new PublicProfileError('NO_LIVE_LINK', 'there is no live share link to change');
  if (input.coverKey && !COVER_KEYS.includes(input.coverKey)) {
    throw new PublicProfileError('INVALID_COVER', 'unknown cover');
  }
  if (input.extendDays !== undefined
    && (!Number.isInteger(input.extendDays) || input.extendDays < 1 || input.extendDays > MAX_LINK_DAYS)) {
    throw new PublicProfileError('INVALID_DURATION', 'an extension lasts between 1 and 365 days');
  }
  const sections = { ...live.sections, ...(input.sections ?? {}) };
  const result = await pool.query(
    `UPDATE public_profile_links SET
       cover_key = $2,
       show_photo = $3, show_headline = $4, show_city = $5, show_institution = $6,
       show_education = $7, show_self_reported = $8, show_assessments = $9,
       show_learning = $10, show_certificates = $11, show_skills = $12, show_portfolio = $13,
       -- Extending runs from now, not from the old expiry, so a lapsed link and a fresh
       -- one behave identically rather than one starting already part-spent.
       expires_at = CASE WHEN $14::int IS NULL THEN expires_at ELSE now() + ($14 || ' days')::interval END
     WHERE student_user_id = $1 AND revoked_at IS NULL
     RETURNING ${linkColumns}`,
    [
      input.studentUserId, input.coverKey ?? live.coverKey,
      sections.showPhoto, sections.showHeadline, sections.showCity, sections.showInstitution,
      sections.showEducation, sections.showSelfReported, sections.showAssessments,
      sections.showLearning, sections.showCertificates, sections.showSkills, sections.showPortfolio,
      input.extendDays ?? null,
    ],
  );
  return mapLink(result.rows[0] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Resolving a token into a page
// ---------------------------------------------------------------------------

export interface PublicProfilePage {
  readonly coverKey: CoverKey;
  readonly name: string | null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly targetCareer: string | null;
  readonly city: string | null;
  readonly institutionName: string | null;
  readonly expectedGraduation: string | null;
  readonly photoUrl: string | null;
  readonly portfolioUrl: string | null;
  readonly skills: readonly string[];
  readonly education: readonly {
    readonly programmeName: string;
    readonly qualificationType: string;
    readonly institutionName: string | null;
    readonly declaredInstitutionName: string | null;
    readonly startedOn: string | null;
    readonly completedOn: string | null;
    readonly verified: boolean;
    readonly terms: readonly {
      readonly label: string;
      readonly result: string | null;
      readonly verified: boolean;
      readonly verifiedAt: string | null;
    }[];
  }[];
  readonly assessments: readonly {
    readonly title: string;
    readonly percentage: number;
    readonly takenAt: string | null;
  }[];
  readonly learning: readonly { readonly title: string; readonly completedAt: string | null }[];
  readonly certificates: readonly { readonly title: string }[];
  readonly verifiedCount: number;
  readonly totalClaimCount: number;
  readonly expiresAt: string;
}

/**
 * A token into a page, or null.
 *
 * Unknown, expired and revoked all return null and are indistinguishable from one another
 * to the caller, so this cannot be used to discover which tokens exist.
 */
export async function resolvePublicProfile(
  pool: Queryable,
  tokenDigest: string,
  photoUrlFor: (studentUserId: string) => string,
): Promise<PublicProfilePage | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenDigest)) return null;
  const linkResult = await pool.query(
    `SELECT student_user_id, cover_key, expires_at, ${sectionColumns.join(', ')}
     FROM public_profile_links
     WHERE token_digest = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenDigest],
  );
  const link = linkResult.rows[0] as Record<string, unknown> | undefined;
  if (!link) return null;

  const studentUserId = String(link.student_user_id);
  const sections = mapSections(link);

  // Identity. The name comes from the institution's own roster, which is the only place
  // ONE holds one; an independent learner has none yet, and the page leads with the
  // headline rather than inventing a name.
  const identity = await pool.query(
    `SELECT isp.full_name, isp.expected_graduation_date,
            org.legal_name AS institution_name, prof.city,
            sp.profile_headline, sp.profile_summary, sp.target_career,
            sp.career_interests, sp.portfolio_url
     FROM users u
     LEFT JOIN student_profiles sp ON sp.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT full_name, expected_graduation_date, institution_id
       FROM institution_student_profiles p
       WHERE p.student_user_id = u.id
       ORDER BY p.updated_at DESC LIMIT 1
     ) isp ON true
     LEFT JOIN organizations org ON org.id = isp.institution_id
     LEFT JOIN organization_profiles prof ON prof.organization_id = isp.institution_id
     WHERE u.id = $1 AND u.state = 'ACTIVE'`,
    [studentUserId],
  );
  const person = identity.rows[0] as Record<string, unknown> | undefined;
  // A suspended or deleted account stops serving its page, immediately and without a
  // separate revocation step.
  if (!person) return null;

  const photo = sections.showPhoto
    ? await pool.query('SELECT student_user_id FROM student_profile_photos WHERE student_user_id = $1', [studentUserId])
    : { rows: [] as unknown[] };

  const education = sections.showEducation ? await loadEducation(pool, studentUserId, sections.showSelfReported) : [];
  const assessments = sections.showAssessments ? await loadAssessments(pool, studentUserId) : [];
  const learning = sections.showLearning ? await loadLearning(pool, studentUserId) : [];
  const certificates = sections.showCertificates ? await loadCertificates(pool, studentUserId) : [];

  // A count of facts, never a score. "Four of six confirmed" describes the evidence; a
  // percentage would describe the person, which this page refuses to do.
  const claims = education.flatMap((entry) => [entry, ...entry.terms]);
  const verifiedCount = claims.filter((claim) => claim.verified).length + assessments.length;
  const totalClaimCount = claims.length + assessments.length + certificates.length;

  await pool.query(
    'UPDATE public_profile_links SET last_viewed_at = now() WHERE token_digest = $1',
    [tokenDigest],
  );

  return {
    coverKey: link.cover_key as CoverKey,
    name: (person.full_name as string | null) ?? null,
    headline: sections.showHeadline ? ((person.profile_headline as string | null) ?? null) : null,
    summary: sections.showHeadline ? ((person.profile_summary as string | null) ?? null) : null,
    targetCareer: (person.target_career as string | null) ?? null,
    city: sections.showCity ? ((person.city as string | null) ?? null) : null,
    institutionName: sections.showInstitution ? ((person.institution_name as string | null) ?? null) : null,
    expectedGraduation: sections.showInstitution && person.expected_graduation_date
      ? new Date(String(person.expected_graduation_date)).toISOString() : null,
    photoUrl: photo.rows.length ? photoUrlFor(studentUserId) : null,
    portfolioUrl: sections.showPortfolio ? ((person.portfolio_url as string | null) ?? null) : null,
    skills: sections.showSkills ? ((person.career_interests as string[] | null) ?? []) : [],
    education,
    assessments,
    learning,
    certificates,
    verifiedCount,
    totalClaimCount,
    expiresAt: new Date(String(link.expires_at)).toISOString(),
  };
}

async function loadEducation(
  pool: Queryable,
  studentUserId: string,
  includeSelfReported: boolean,
): Promise<PublicProfilePage['education']> {
  const result = await pool.query(
    `SELECT q.id, q.programme_name, q.qualification_type, q.started_on, q.completed_on,
            q.verification_state AS qualification_state,
            org.legal_name AS institution_name, q.institution_name_declared,
            t.label, t.result_value, t.result_scale, t.result_letter,
            t.verification_state AS term_state, t.verified_at, t.sequence
     FROM student_qualifications q
     LEFT JOIN organizations org ON org.id = q.institution_id
     LEFT JOIN student_academic_terms t ON t.qualification_id = q.id
     WHERE q.student_user_id = $1
       AND ($2::boolean OR q.verification_state = 'VERIFIED')
     ORDER BY q.started_on DESC NULLS LAST, t.sequence`,
    [studentUserId, includeSelfReported],
  );

  const byQualification = new Map<string, PublicProfilePage['education'][number] & { terms: unknown[] }>();
  for (const raw of result.rows as Record<string, unknown>[]) {
    const id = String(raw.id);
    if (!byQualification.has(id)) {
      byQualification.set(id, {
        programmeName: String(raw.programme_name),
        qualificationType: String(raw.qualification_type),
        institutionName: (raw.institution_name as string | null) ?? null,
        declaredInstitutionName: (raw.institution_name_declared as string | null) ?? null,
        startedOn: raw.started_on ? new Date(String(raw.started_on)).toISOString() : null,
        completedOn: raw.completed_on ? new Date(String(raw.completed_on)).toISOString() : null,
        verified: raw.qualification_state === 'VERIFIED',
        terms: [],
      } as never);
    }
    if (raw.label) {
      const termVerified = raw.term_state === 'VERIFIED';
      if (includeSelfReported || termVerified) {
        (byQualification.get(id)!.terms as unknown[]).push({
          label: String(raw.label),
          result: formatResult(raw),
          verified: termVerified,
          verifiedAt: raw.verified_at ? new Date(String(raw.verified_at)).toISOString() : null,
        });
      }
    }
  }
  return [...byQualification.values()] as PublicProfilePage['education'];
}

/** The institution's own scale, never a conversion. */
function formatResult(raw: Record<string, unknown>): string | null {
  if (raw.result_letter) return String(raw.result_letter);
  if (raw.result_value === null || raw.result_value === undefined) return null;
  const value = String(raw.result_value);
  const scale = raw.result_scale;
  if (scale === 'PERCENTAGE') return `${value}%`;
  if (scale === 'CGPA_10') return `${value} / 10`;
  if (scale === 'GPA_4') return `${value} / 4`;
  return value;
}

/** Only published results of institution exams. An unpublished result is not a fact yet. */
async function loadAssessments(pool: Queryable, studentUserId: string): Promise<PublicProfilePage['assessments']> {
  const result = await pool.query(
    `SELECT d.title, r.percentage, a.submitted_at
     FROM exam_attempts a
     JOIN exam_results r ON r.attempt_id = a.id
     JOIN exam_definitions d ON d.id = a.definition_id
     WHERE a.student_user_id = $1 AND r.published AND r.percentage >= 0
     ORDER BY a.submitted_at DESC NULLS LAST
     LIMIT 20`,
    [studentUserId],
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    title: String(row.title),
    percentage: Number(row.percentage),
    takenAt: row.submitted_at ? new Date(String(row.submitted_at)).toISOString() : null,
  }));
}

async function loadLearning(pool: Queryable, studentUserId: string): Promise<PublicProfilePage['learning']> {
  const result = await pool.query(
    `SELECT lv.title, p.completed_at
     FROM learner_progress p
     JOIN lesson_versions lv ON lv.id = p.lesson_version_id
     WHERE p.subject_user_id = $1 AND p.state = 'COMPLETED'
     ORDER BY p.completed_at DESC NULLS LAST
     LIMIT 20`,
    [studentUserId],
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    title: String(row.title),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  }));
}

/** Titles only. The files themselves are never reachable from a public page. */
async function loadCertificates(pool: Queryable, studentUserId: string): Promise<PublicProfilePage['certificates']> {
  const result = await pool.query(
    `SELECT title FROM student_document_metadata
     WHERE student_user_id = $1 AND document_type = 'CERTIFICATE' AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 20`,
    [studentUserId],
  );
  return (result.rows as Record<string, unknown>[]).map((row) => ({ title: String(row.title) }));
}
