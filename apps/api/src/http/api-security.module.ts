import { DynamicModule, Module, Provider } from '@nestjs/common';
import {
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
      ProtectedApiAuthenticationGuard,
      VerifiedIdentityAuthenticationGuard,
      Phase1ProtectedApiRoutes,
    ];

    return {
      module: Phase1ApiSecurityModule,
      controllers: [Phase1SecurityController, OperationsInstitutionOnboardingController, StudentOperationalCoreController],
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
