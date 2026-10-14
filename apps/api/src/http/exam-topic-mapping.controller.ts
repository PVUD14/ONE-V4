/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Mapping an institution's exam subjects onto readiness topics (migration 0030).
 *
 * This is what turns an institution's examination programme into readiness evidence.
 * Without a mapping the bridge writes nothing and says so, which is the honest
 * behaviour — but it means these endpoints are the difference between an institution's
 * exams moving readiness bands and not.
 *
 * Restricted to the roles that already approve assessments, because the people who
 * know what a subject covers are the people who publish papers in it. Operations
 * cannot do it on a customer's behalf without knowing their curriculum.
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
import {
  linkExamSubjectToTopic,
  listExamSubjectTopicLinks,
  listMappableTopics,
  retireExamSubjectTopicLink,
} from '@planthepath/persistence/src/exam-evidence-bridge.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same set that may publish an assessment; Faculty excluded, as for approval. */
const mappingRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD'];

@Controller('/api/v1/institutions/:institutionId/exam-topic-links')
export class ExamTopicMappingController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const id = requireMappingRole(request, requireUuid(institutionId));
    void id;
    return {
      links: await listExamSubjectTopicLinks(this.db, institutionId),
      // Offered alongside so the screen never has to guess what a valid target is; the
      // trigger in 0030 refuses anything that is not a TOPIC node regardless.
      topics: await listMappableTopics(this.db),
    };
  }

  @Post('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireMappingRole(request, id);
    const raw = readObject(body);
    if (typeof raw.examSubjectId !== 'string' || !uuidPattern.test(raw.examSubjectId)) throw badRequest('EXAM_SUBJECT_INVALID');
    if (typeof raw.topicId !== 'string' || !uuidPattern.test(raw.topicId)) throw badRequest('TOPIC_INVALID');
    const weight = raw.weight === undefined ? 1 : Number(raw.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw badRequest('EXAM_TOPIC_WEIGHT_INVALID');

    try {
      await linkExamSubjectToTopic(this.db, {
        institutionId: id, examSubjectId: raw.examSubjectId, topicId: raw.topicId, weight, createdByUserId: actorUserId,
      });
    } catch (error) {
      // The composite foreign key refuses a subject from another institution and the
      // trigger refuses a node that is not a TOPIC; both read as a bad request here
      // rather than disclosing which one tripped.
      if (error instanceof Error && /only be mapped to a TOPIC/.test(error.message)) throw badRequest('TOPIC_INVALID');
      throw badRequest('EXAM_TOPIC_LINK_REJECTED');
    }
    return { links: await listExamSubjectTopicLinks(this.db, id) };
  }

  @Delete('/:linkId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async retire(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('linkId') linkId: string,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    requireMappingRole(request, id);
    const retired = await retireExamSubjectTopicLink(this.db, { institutionId: id, linkId: requireUuid(linkId) });
    if (!retired) throw new NotFoundException({ error: { code: 'EXAM_TOPIC_LINK_NOT_FOUND' } });
    return { links: await listExamSubjectTopicLinks(this.db, id) };
  }
}

function requireMappingRole(request: ProtectedHttpRequest, institutionId: string): string {
  const authorization = request.planThePath?.authorization;
  const userId = authorization?.principal.userId;
  const permitted = (authorization?.memberships ?? []).some((membership) => (
    membership.state === 'ACTIVE'
    && mappingRoles.includes(membership.role)
    && membership.organizationId === institutionId
    && membership.scope.organizationId === institutionId
  ));
  if (!userId || !permitted) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
  return userId;
}

function readObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST');
  return body as Record<string, unknown>;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST');
  return value;
}

function badRequest(code: string): BadRequestException {
  return new BadRequestException({ error: { code } });
}
