/**
 * Student goals and onboarding routes (ENG-19): the goals read, goal options (roles by name and synonym,
 * published topics, and — while the catalogue is open — exam and company goals), setting and ending goals,
 * and "Not sure yet".
 *
 * Why it exists: onboarding asks "What job do you want?" on web and Android, and both clients need one
 * contract for it. The learner is the only actor: every route resolves the subject from the authenticated
 * principal, so there is no identifier to tamper with. Nothing here needs an enrolment (graduates onboard the
 * same way), nothing calls a model, and nothing produces a readiness number. Attempt history is read for
 * suggestions only under the adaptive-learning purpose (fail closed). Errors carry a code and a plain
 * sentence, never internal detail.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { CareerTargetError, isCareerCatalogueOpenForLearner } from '@planthepath/persistence/src/career-targets.js';
import { hasConsentPurpose } from '@planthepath/persistence/src/consent-purposes.js';
import {
  LearnerGoalError,
  addLearnerGoal,
  endLearnerGoal,
  listLearnerGoals,
  readCareerDiscovery,
  searchGoalOptions,
  setRoleGoal,
  submitCareerDiscovery,
  type LearnerGoalOrigin,
} from '@planthepath/persistence/src/learner-goals.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { PG_POOL } from '../persistence.provider.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const origins: readonly LearnerGoalOrigin[] = ['ONBOARDING', 'GOALS', 'DISCOVERY_SUGGESTION'];

type GoalBody =
  | { readonly goalType: 'ROLE'; readonly careerRoleId: string; readonly priority: 'PRIMARY' | 'SECONDARY'; readonly origin: LearnerGoalOrigin }
  | { readonly goalType: 'TOPIC'; readonly topicId: string; readonly origin: LearnerGoalOrigin }
  | { readonly goalType: 'EXAM' | 'COMPANY'; readonly catalogueGoalCode: string; readonly origin: LearnerGoalOrigin };

@Controller('/api/v1/students/me/goals')
export class LearnerGoalsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
  ) {}

  /** Live goals (primary first), whether the student is still onboarding, and the skills the goals need, each once. */
  @Get('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId } = requireContext(request);
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    return { ...(await listLearnerGoals(this.pool, userId, { catalogueOpen })), catalogueOpen };
  }

  /** What can be set as a goal, searched by name and synonym. */
  @Get('/options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async options(@Req() request: ProtectedHttpRequest, @Query('q') q: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    if (q !== undefined && (typeof q !== 'string' || q.length > 80)) throw badRequest(correlationId);
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    return { ...(await searchGoalOptions(this.pool, { query: typeof q === 'string' ? q : '', catalogueOpen })), catalogueOpen };
  }

  /** Sets a goal: a role (primary or secondary), a published topic, or an exam / company goal. */
  @Post('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async set(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const goal = readGoalBody(body, correlationId);
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    try {
      if (goal.goalType === 'ROLE') {
        await setRoleGoal(this.pool, { studentId: userId, careerRoleId: goal.careerRoleId, priority: goal.priority, origin: goal.origin, catalogueOpen });
      } else if (goal.goalType === 'TOPIC') {
        await addLearnerGoal(this.pool, { studentId: userId, goal: { goalType: 'TOPIC', topicId: goal.topicId }, origin: goal.origin, catalogueOpen });
      } else {
        await addLearnerGoal(this.pool, { studentId: userId, goal: { goalType: goal.goalType, catalogueGoalCode: goal.catalogueGoalCode }, origin: goal.origin, catalogueOpen });
      }
    } catch (error) {
      throw mapError(error, correlationId);
    }
    return { ...(await listLearnerGoals(this.pool, userId, { catalogueOpen })), catalogueOpen };
  }

  /** Ends a live goal: ACHIEVED or WITHDRAWN (a role goal is withdrawn, which clears its career target). */
  @Post('/:goalId/end')
  @HttpCode(200)
  @UseGuards(ProtectedApiAuthenticationGuard)
  async end(@Req() request: ProtectedHttpRequest, @Param('goalId') goalId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(goalId)) throw badRequest(correlationId);
    const status = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).status : undefined;
    if (status !== 'ACHIEVED' && status !== 'WITHDRAWN') throw badRequest(correlationId);
    try {
      await endLearnerGoal(this.pool, { studentId: userId, goalId, status });
    } catch (error) {
      throw mapError(error, correlationId);
    }
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    return { ...(await listLearnerGoals(this.pool, userId, { catalogueOpen })), catalogueOpen };
  }

  /** "Not sure yet": the survey, the student's answers and the roles they suggest now. */
  @Get('/discovery')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async discovery(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId } = requireContext(request);
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    const adaptive = await hasConsentPurpose(this.db, userId, 'adaptive-learning');
    return { discovery: await readCareerDiscovery(this.pool, { studentId: userId, catalogueOpen, adaptive }) };
  }

  /** Records the survey answers as the student's "Not sure yet" goal and returns 3–5 suggested roles. */
  @Post('/discovery')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async submitDiscovery(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(correlationId);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['interests', 'strengths', 'branch', 'origin'].includes(key))) throw badRequest(correlationId);
    const origin = readOrigin(record.origin, correlationId);
    const catalogueOpen = await isCareerCatalogueOpenForLearner(this.pool, userId);
    const adaptive = await hasConsentPurpose(this.db, userId, 'adaptive-learning');
    try {
      const answers = { interests: record.interests, strengths: record.strengths ?? [], branch: record.branch };
      return { discovery: await submitCareerDiscovery(this.pool, { studentId: userId, answers, origin, catalogueOpen, adaptive }) };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }
}

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId ?? 'unknown';
  if (!userId) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied', correlationId } });
  return { userId, correlationId };
}

function badRequest(correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code: 'INVALID_REQUEST', message: 'Request could not be processed', correlationId } });
}

function readOrigin(value: unknown, correlationId: string): LearnerGoalOrigin {
  if (value === undefined) return 'GOALS';
  if (typeof value !== 'string' || !(origins as readonly string[]).includes(value)) throw badRequest(correlationId);
  return value as LearnerGoalOrigin;
}

function readGoalBody(body: unknown, correlationId: string): GoalBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest(correlationId);
  const raw = body as Record<string, unknown>;
  const origin = readOrigin(raw.origin, correlationId);
  const allowed = (keys: readonly string[]): void => {
    if (Object.keys(raw).some((key) => !['goalType', 'origin', ...keys].includes(key))) throw badRequest(correlationId);
  };
  switch (raw.goalType) {
    case 'ROLE': {
      allowed(['careerRoleId', 'priority']);
      const priority = raw.priority ?? 'PRIMARY';
      if (typeof raw.careerRoleId !== 'string' || !uuidPattern.test(raw.careerRoleId)) throw badRequest(correlationId);
      if (priority !== 'PRIMARY' && priority !== 'SECONDARY') throw badRequest(correlationId);
      return { goalType: 'ROLE', careerRoleId: raw.careerRoleId, priority, origin };
    }
    case 'TOPIC':
      allowed(['topicId']);
      if (typeof raw.topicId !== 'string' || !uuidPattern.test(raw.topicId)) throw badRequest(correlationId);
      return { goalType: 'TOPIC', topicId: raw.topicId, origin };
    case 'EXAM':
    case 'COMPANY':
      allowed(['catalogueGoalCode']);
      if (typeof raw.catalogueGoalCode !== 'string' || !/^G[0-9]{2}$/.test(raw.catalogueGoalCode)) throw badRequest(correlationId);
      return { goalType: raw.goalType, catalogueGoalCode: raw.catalogueGoalCode, origin };
    default:
      // DISCOVERY is set through the survey, never directly.
      throw badRequest(correlationId);
  }
}

function mapError(error: unknown, correlationId: string): Error {
  if (error instanceof CareerTargetError) {
    if (error.code === 'CAREER_ROLE_NOT_FOUND') return new NotFoundException({ error: { code: error.code, message: 'That role is not available to choose.', correlationId } });
    return new NotFoundException({ error: { code: 'GOAL_NOT_FOUND', message: 'That goal was not found.', correlationId } });
  }
  if (!(error instanceof LearnerGoalError)) return error instanceof Error ? error : new Error('goal request failed');
  switch (error.code) {
    case 'GOAL_NOT_FOUND':
      return new NotFoundException({ error: { code: error.code, message: 'That goal was not found.', correlationId } });
    case 'TOPIC_NOT_FOUND':
      return new NotFoundException({ error: { code: error.code, message: 'That topic is not available as a goal.', correlationId } });
    case 'CATALOGUE_GOAL_NOT_FOUND':
      return new NotFoundException({ error: { code: error.code, message: 'That goal is not available to choose.', correlationId } });
    case 'GOAL_ALREADY_SET':
      return new ConflictException({ error: { code: error.code, message: 'That is already one of your goals.', correlationId } });
    case 'ROLE_GOAL_ENDS_BY_WITHDRAWAL':
      return new BadRequestException({ error: { code: error.code, message: 'A role goal can be withdrawn, not marked achieved.', correlationId } });
    case 'INVALID_INTERESTS':
      return new BadRequestException({ error: { code: error.code, message: 'Choose one to three kinds of work.', correlationId } });
    case 'INVALID_STRENGTHS':
      return new BadRequestException({ error: { code: error.code, message: 'Choose up to three strengths.', correlationId } });
    case 'INVALID_BRANCH':
      return new BadRequestException({ error: { code: error.code, message: 'Choose your branch from the list, or "Not listed".', correlationId } });
  }
}
