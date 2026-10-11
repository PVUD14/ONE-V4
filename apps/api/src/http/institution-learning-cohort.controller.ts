/**
 * The faculty cohort view over the learning engine (INST-15).
 *
 * A lecturer sees, for the students in their active teaching assignments only: the skills several
 * of them are stuck on (the planner's STUCK rule, imported from the engine), the most common
 * misconceptions in the class (counts of 5 or more only — `suppressSmallCount`), and who has
 * reviews due (skill names, never a date). Design: docs/architecture/faculty-cohort-view-design.md.
 *
 * Rules, each enforced here or in `@planthepath/persistence/src/learning-cohort.ts`:
 *   - FACULTY_LECTURER only; everyone else 403.
 *   - Scope is the INST-02 helper's write scope — teaching assignments with no fallback, so a
 *     lecturer without an active assignment (or at a college that records none) sees nobody.
 *   - Current relationship only; engine rows attributed to this institution only.
 *   - Adaptive-learning consent is checked in the same statement and fails closed: until the
 *     definition is published (HG-6) every block is empty and `consent.offered` is false.
 *   - No model number leaves the server (no BKT, no FSRS value, no readiness): names, labels, counts.
 *   - Every read returning per-student data writes an audit_events row in the same transaction.
 */
import { BadRequestException, Controller, ForbiddenException, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { suppressSmallCount, type InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { consentPurposeOffered } from '@planthepath/persistence/src/consent-purposes.js';
import { withTeachingAssignments, resolveInstitutionStudentWriteScope } from '@planthepath/persistence/src/institution-scope.js';
import {
  cohortDueReviewStudents,
  cohortHeadcount,
  cohortMisconceptionCounts,
  cohortStuckSkills,
  type CohortStudent,
} from '@planthepath/persistence/src/learning-cohort.js';
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
import { institutionStaffScopeMemberships } from './institution-student-scope.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CohortReader {
  readonly institutionId: string;
  readonly correlationId: string;
  readonly actorUserId: string;
  /** ASSIGNMENTS once the college records teaching assignments; MEMBERSHIP before (the view is then empty). */
  readonly mode: 'ASSIGNMENTS' | 'MEMBERSHIP';
  readonly scope: InstitutionStudentScope;
}

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionLearningCohortController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/institutions/:institutionId/learning-cohort')
  async summary(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    const offered = await consentPurposeOffered(this.db, 'adaptive-learning');
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      // Sequential: one transaction is one connection, and pg does not pipeline queries on it.
      const headcount = await cohortHeadcount(db, reader.institutionId, reader.scope);
      const stuck = await cohortStuckSkills(db, reader.institutionId, reader.scope);
      const misconceptions = await cohortMisconceptionCounts(db, reader.institutionId, reader.scope);
      const shown = misconceptions
        .map((entry) => ({ entry, count: suppressSmallCount(entry.students) }))
        .filter((item) => !item.count.suppressed);
      const studentIds = [...new Set(stuck.flatMap((skill) => skill.students.map((student) => student.studentUserId)))].sort();
      await this.audit(db, reader, 'institution.learning_cohort.read', { block: 'SUMMARY', returned: studentIds.length, studentUserIds: studentIds });
      const consenting = suppressSmallCount(headcount.consenting);
      return {
        mode: reader.mode,
        consent: { offered },
        students: headcount.students,
        studentsSharing: { suppressed: consenting.suppressed, count: consenting.value },
        stuckSkills: stuck.map((skill) => ({
          skillId: skill.skillId,
          skillName: skill.skillName,
          studentCount: skill.students.length,
          students: skill.students.map(publicStudent),
        })),
        misconceptions: shown.map(({ entry, count }) => ({ code: entry.code, title: entry.title, skillName: entry.skillName, students: count.value })),
        // Whether any code was withheld is itself not a count of people; it lets the screen say so.
        misconceptionsWithheld: shown.length < misconceptions.length,
      };
    });
  }

  @Get('/institutions/:institutionId/learning-cohort/due-reviews')
  async dueReviews(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const reader = await this.reader(request, institutionId);
    const limit = readLimit(limitParam, reader.correlationId);
    const cursor = readNameCursor(cursorParam, reader.correlationId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as PersistenceDb;
      const page = await cohortDueReviewStudents(db, reader.institutionId, reader.scope, { limit, cursor });
      await this.audit(db, reader, 'institution.learning_cohort.due_reviews_listed', {
        block: 'DUE_REVIEWS', returned: page.students.length, studentUserIds: page.students.map((student) => student.studentUserId), page: cursor ? 'NEXT' : 'FIRST',
      });
      const last = page.students[page.students.length - 1];
      return {
        mode: reader.mode,
        students: page.students.map((student) => ({ ...publicStudent(student), dueSkills: student.skillNames })),
        nextCursor: page.hasMore && last ? encodeCursor([last.sortKey, last.profileId]) : null,
      };
    });
  }

  private async reader(request: ProtectedHttpRequest, institutionId: string): Promise<CohortReader> {
    const context = requireTrustedAuthorization(request);
    if (!uuidPattern.test(institutionId)) throw forbidden(context.correlationId);
    const id = institutionId.toLowerCase();
    const memberships = institutionStaffScopeMemberships(request, id, ['FACULTY_LECTURER']);
    if (memberships.length === 0) throw forbidden(context.correlationId);
    const resolved = await withTeachingAssignments(this.db, id, memberships);
    const mode = resolved.some((membership) => Array.isArray(membership.teachingUnitIds)) ? 'ASSIGNMENTS' : 'MEMBERSHIP';
    // The write scope: teaching assignments only, no department/batch or whole-college fallback.
    const scope = await resolveInstitutionStudentWriteScope(this.db, id, memberships);
    return { institutionId: id, correlationId: context.correlationId, actorUserId: context.authorization.principal.userId, mode, scope };
  }

  private async audit(db: PersistenceDb, reader: CohortReader, action: string, context: Record<string, unknown>): Promise<void> {
    await db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${this.ids.uuid()}::uuid, ${reader.actorUserId}::uuid, ${action}, 'institution',
        ${reader.institutionId}, ${reader.institutionId}::uuid, 'SUCCESS', ${reader.correlationId}, ${JSON.stringify({ ...context, mode: reader.mode })}::jsonb)
    `);
  }
}

/** What a lecturer may see of a student here: the roster identity they already see on My Students. */
function publicStudent(student: CohortStudent): { profileId: string; fullName: string; rollNumber: string } {
  return { profileId: student.profileId, fullName: student.fullName, rollNumber: student.rollNumber };
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid(correlationId, 'limit');
  return limit;
}

/** A keyset cursor over (lower(full name), profile id). */
function readNameCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && parsed[0].length <= 300
      && typeof parsed[1] === 'string' && uuidPattern.test(parsed[1])) return [parsed[0], parsed[1].toLowerCase()];
  } catch { /* fall through */ }
  throw invalid(correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function invalid(correlationId: string, field: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_QUERY', message: 'Request could not be completed', correlationId, field } });
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
