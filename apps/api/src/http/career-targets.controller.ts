/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Career targets, the gap against them, and the roadmap actions that answer it.
 *
 * Everything below reads and writes tables and domain logic that already existed and
 * had no caller: migration 0011 for the targets and gaps, the roadmap state machine
 * already declared in the `roadmap_actions` CHECK constraint, and `computeCareerGap`
 * in the career-readiness package.
 *
 * The learner is the only actor here. Every route resolves the subject from the
 * authenticated principal rather than a path parameter, so there is no identifier to
 * tamper with and no cross-learner read to authorize.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  CareerTargetError,
  clearStudentCareerTarget,
  getStudentCareerTargetState,
  isCareerCatalogueOpenForLearner,
  listCareerRoles,
  recomputeAllCareerGaps,
  setStudentCareerTarget,
} from '@planthepath/persistence/src/career-targets.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The states a learner may drive an action into, and from where.
 *
 * This mirrors the CHECK constraint on `roadmap_actions` rather than widening it. A
 * recommendation the learner has not touched can be accepted or dismissed; work in
 * progress can be finished or abandoned. SUPERSEDED is absent on purpose: only a
 * recomputation supersedes an action, never a person.
 */
const roadmapTransitions: Readonly<Record<string, readonly string[]>> = {
  RECOMMENDED: ['ACCEPTED', 'DISMISSED'],
  ACCEPTED: ['IN_PROGRESS', 'DISMISSED'],
  IN_PROGRESS: ['COMPLETED', 'DISMISSED'],
};

@Controller('/api/v1')
export class CareerTargetsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * The career catalogue. Public reference content, so no membership is required. The
   * full job-role catalogue is offered only where `career-catalogue.selectable-roles` is on
   * for the caller (OPS-08); otherwise the starter roles, exactly as before.
   */
  @Get('/career-targets/catalog')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async catalog(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const userId = request.planThePath?.authorization?.principal.userId;
    const catalogueOpen = userId ? await isCareerCatalogueOpenForLearner(this.pool, userId) : false;
    return { careerRoles: await listCareerRoles(this.pool, { catalogueOpen }) };
  }

  @Get('/students/me/career-targets')
  @UseGuards(ProtectedApiAuthenticationGuard)
  state(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    return getStudentCareerTargetState(this.pool, requireLearnerId(request));
  }

  @Post('/students/me/career-targets')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async select(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const learnerId = requireLearnerId(request);
    const { careerRoleId, priority } = readTargetBody(body);
    try {
      const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, learnerId);
      const created = await setStudentCareerTarget(this.pool, { subjectUserId: learnerId, careerRoleId, priority, catalogueOpen });
      return { ...created, ...(await getStudentCareerTargetState(this.pool, learnerId)) };
    } catch (error) {
      throw mapTargetError(error);
    }
  }

  @Delete('/students/me/career-targets/:targetId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async clear(@Req() request: ProtectedHttpRequest, @Param('targetId') targetId: string): Promise<Record<string, unknown>> {
    const learnerId = requireLearnerId(request);
    try {
      await clearStudentCareerTarget(this.pool, { subjectUserId: learnerId, targetId: requireUuid(targetId) });
    } catch (error) {
      throw mapTargetError(error);
    }
    return getStudentCareerTargetState(this.pool, learnerId);
  }

  /**
   * Recompute every live target against current evidence.
   *
   * Offered explicitly rather than folded into the read, so a GET stays a GET and a
   * learner refreshing a page does not silently write a snapshot.
   */
  @Post('/students/me/career-targets/recompute')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async recompute(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const learnerId = requireLearnerId(request);
    const recomputed = await recomputeAllCareerGaps(this.pool, learnerId);
    return { recomputed, ...(await getStudentCareerTargetState(this.pool, learnerId)) };
  }

  /**
   * Move a roadmap action along.
   *
   * The action must already belong to the caller: the update is scoped by
   * `subject_user_id`, so a mismatched identifier reads as not found rather than
   * disclosing that someone else's action exists.
   */
  @Post('/students/me/roadmap-actions/:actionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transitionRoadmapAction(
    @Req() request: ProtectedHttpRequest,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const learnerId = requireLearnerId(request);
    const toState = readToState(body);
    const id = requireUuid(actionId);

    const current = await this.pool.query<{ state: string }>(
      'SELECT state FROM roadmap_actions WHERE id=$1 AND subject_user_id=$2', [id, learnerId],
    );
    const from = current.rows[0]?.state;
    if (!from) throw new NotFoundException({ error: { code: 'ROADMAP_ACTION_NOT_FOUND' } });
    if (!(roadmapTransitions[from] ?? []).includes(toState)) {
      throw new BadRequestException({ error: { code: 'ROADMAP_TRANSITION_NOT_ALLOWED', from, to: toState } });
    }

    const updated = await this.pool.query<{ id: string; state: string; topicId: string; actionCode: string }>(
      `UPDATE roadmap_actions SET state=$3
       WHERE id=$1 AND subject_user_id=$2 AND state=$4
       RETURNING id, state, topic_id AS "topicId", action_code AS "actionCode"`,
      [id, learnerId, toState, from],
    );
    // A lost race means someone else moved it first; re-reading is cheaper and more
    // honest than guessing which state won.
    if (!updated.rows[0]) throw new BadRequestException({ error: { code: 'ROADMAP_TRANSITION_CONFLICT' } });
    return { action: updated.rows[0] };
  }
}

function requireLearnerId(request: ProtectedHttpRequest): string {
  const id = request.planThePath?.authorization?.principal.userId;
  if (!id) throw safeForbidden();
  return id;
}

function readTargetBody(body: unknown): { readonly careerRoleId: string; readonly priority: 'PRIMARY' | 'SECONDARY' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw safeBadRequest();
  const raw = body as Record<string, unknown>;
  if (typeof raw.careerRoleId !== 'string' || !uuidPattern.test(raw.careerRoleId)) throw safeBadRequest();
  const priority = raw.priority ?? 'PRIMARY';
  if (priority !== 'PRIMARY' && priority !== 'SECONDARY') throw safeBadRequest();
  return { careerRoleId: raw.careerRoleId, priority };
}

function readToState(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw safeBadRequest();
  const toState = (body as Record<string, unknown>).toState;
  if (typeof toState !== 'string' || !['ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED'].includes(toState)) throw safeBadRequest();
  return toState;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw safeBadRequest();
  return value;
}

function mapTargetError(error: unknown): BadRequestException | NotFoundException {
  if (error instanceof CareerTargetError) {
    if (error.code === 'CAREER_TARGET_NOT_FOUND') return new NotFoundException({ error: { code: error.code } });
    return new BadRequestException({ error: { code: error.code } });
  }
  return safeBadRequest();
}

function safeBadRequest(): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
}

function safeForbidden(): ForbiddenException {
  return new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
}
