import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
  API_FILE_SCANNER,
  API_FILE_STORAGE,
  API_ID_GENERATOR,
  API_IDENTITY_VERIFIER,
  API_INTERNAL_IDENTITY_STORE,
  API_PERSISTENCE_DB,
  Phase1ProtectedApiRoutes,
  ProtectedApiAuthenticationGuard,
  VerifiedIdentityAuthenticationGuard,
  type ApiSecurityDependencies,
  cryptoApiIdGenerator,
} from './api-security.js';
import { Phase1SecurityController } from './phase1-security.controller.js';
import { API_INVITATION_MAIL_SINK, OperationsInstitutionOnboardingController, createConfiguredInvitationMailSink } from './operations-institution-onboarding.controller.js';
import { StudentOperationalCoreController } from './student-operational-core.controller.js';
import { StudentHiringController } from './student-hiring.controller.js';
import { EmployerHiringController } from './employer-hiring.controller.js';
import { StudentDocumentsController } from './student-documents.controller.js';
import { StudentPrivacyController } from './student-privacy.controller.js';
import { InstitutionAssessmentsController } from './institution-assessments.controller.js';
import { StaffActionsController } from './staff-actions.controller.js';
import { StudentAssessmentAttemptsController } from './student-assessment-attempts.controller.js';
import { AssistantController } from './assistant.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { ConsentsController } from './consents.controller.js';
import { HelpController } from './help.controller.js';
import { StudentActivityController } from './student-activity.controller.js';
import { OperationsOutboxController } from './operations-outbox.controller.js';
import { OperationsPrivacyController } from './operations-privacy.controller.js';
import { OperationsApprovalsController } from './operations-approvals.controller.js';
import { OperationsSupportController } from './operations-support.controller.js';
import { ExamTopicMappingController } from './exam-topic-mapping.controller.js';
import { OperationsAuditController } from './operations-audit.controller.js';
import { CalendarController } from './calendar.controller.js';
import { EmployerAssessmentsController } from './employer-assessments.controller.js';
import { EmployerTeamController } from './employer-team.controller.js';
import { InstitutionTeachingAssignmentsController } from './institution-teaching-assignments.controller.js';
import { InstitutionAnnouncementsController } from './institution-announcements.controller.js';
import { EmployerCompanyProfileController } from './employer-company-profile.controller.js';
import { EmployerAccessRequestsController } from './employer-access-requests.controller.js';
import { OperationsJobsController } from './operations-jobs.controller.js';
import { InstitutionSettingsController } from './institution-settings.controller.js';

@Module({})
export class Phase1ApiSecurityModule {
  static register(dependencies: ApiSecurityDependencies): DynamicModule {
    const configuredInvitationMailSink = dependencies.invitationMailSink ?? createConfiguredInvitationMailSink();
    const providers: Provider[] = [
      { provide: API_IDENTITY_VERIFIER, useValue: dependencies.verifier },
      { provide: API_INTERNAL_IDENTITY_STORE, useValue: dependencies.identityStore },
      { provide: API_PERSISTENCE_DB, useValue: dependencies.db },
      { provide: API_ID_GENERATOR, useValue: dependencies.ids ?? cryptoApiIdGenerator },
      ...(configuredInvitationMailSink ? [{ provide: API_INVITATION_MAIL_SINK, useValue: configuredInvitationMailSink }] : []),
      ...(dependencies.fileStorage ? [{ provide: API_FILE_STORAGE, useValue: dependencies.fileStorage }] : []),
      ...(dependencies.fileScanner ? [{ provide: API_FILE_SCANNER, useValue: dependencies.fileScanner }] : []),
      ProtectedApiAuthenticationGuard,
      VerifiedIdentityAuthenticationGuard,
      Phase1ProtectedApiRoutes,
    ];

    return {
      module: Phase1ApiSecurityModule,
      controllers: [StaffActionsController, Phase1SecurityController, OperationsInstitutionOnboardingController, StudentOperationalCoreController, StudentHiringController, EmployerHiringController, StudentDocumentsController, StudentPrivacyController, InstitutionAssessmentsController, StudentAssessmentAttemptsController, AssistantController, NotificationsController, ConsentsController, HelpController, StudentActivityController, OperationsAuditController, OperationsOutboxController, OperationsPrivacyController, OperationsApprovalsController, ExamTopicMappingController, CalendarController, EmployerAssessmentsController, EmployerTeamController, InstitutionTeachingAssignmentsController, EmployerCompanyProfileController, EmployerAccessRequestsController, OperationsSupportController, OperationsJobsController, InstitutionSettingsController, InstitutionAnnouncementsController],
      providers,
      exports: [
        API_IDENTITY_VERIFIER,
        API_INTERNAL_IDENTITY_STORE,
        API_PERSISTENCE_DB,
        ProtectedApiAuthenticationGuard,
        VerifiedIdentityAuthenticationGuard,
        Phase1ProtectedApiRoutes,
      ],
    };
  }
}
