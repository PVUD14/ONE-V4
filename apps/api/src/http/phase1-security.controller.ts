import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  Phase1ProtectedApiRoutes,
  ProtectedApiAuthenticationGuard,
  VerifiedIdentityAuthenticationGuard,
  type ProtectedHttpRequest,
} from './api-security.js';

@Controller('/api/v1')
export class Phase1SecurityController {
  constructor(@Inject(Phase1ProtectedApiRoutes) private readonly routes: Phase1ProtectedApiRoutes) {}

  @Get('/security/context')
  @UseGuards(ProtectedApiAuthenticationGuard)
  currentContext(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    return this.routes.currentContext(request);
  }

  @Get('/institutions/:institutionId/student-activity-access/:studentUserId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  institutionStudentActivityAccess(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('studentUserId') studentUserId: string,
    @Query('activityAt') activityAt: string,
  ): Promise<Record<string, unknown>> {
    return this.routes.institutionStudentActivityAccess(request, { institutionId, studentUserId, activityAt });
  }

  @Post('/invitations/accept')
  @UseGuards(VerifiedIdentityAuthenticationGuard)
  acceptInvitation(
    @Req() request: ProtectedHttpRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.routes.acceptInvitation(request, body);
  }

  @Get('/employers/:employerId/applicant-access/:opportunityId/:studentUserId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  employerApplicantAccess(
    @Req() request: ProtectedHttpRequest,
    @Param('employerId') employerId: string,
    @Param('opportunityId') opportunityId: string,
    @Param('studentUserId') studentUserId: string,
  ): Promise<Record<string, unknown>> {
    return this.routes.employerApplicantAccess(request, { employerId, opportunityId, studentUserId });
  }
}
