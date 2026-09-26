import { Module } from '@nestjs/common';
import { Phase1ApiSecurityModule } from './http/api-security.module.js';
import { loadRuntimeConfig } from './config.js';
import { createDatabaseRuntime, PG_POOL, PostgresRuntimeLifecycle, RUNTIME_CONFIG } from './persistence.provider.js';
import { createRuntimeIdentityVerifier, createRuntimeStaffPoolPolicy } from './runtime-auth.js';
import { HealthController } from './health.controller.js';
import { createClamAvScanner } from './storage/clamav.js';
import { createLocalDiskStorage, type FileStorage } from './storage/file-storage.js';
import { createEncryptedStorage, parseFileEncryptionKey } from './storage/encrypted-storage.js';
import { CareerReadinessController } from './http/career-readiness.controller.js';
import { CareerTargetsController } from './http/career-targets.controller.js';
import { AcademicRecordsController } from './http/academic-records.controller.js';
import { PlatformControlsController } from './http/platform-controls.controller.js';
import { InstitutionExportsController } from './http/institution-exports.controller.js';
import { TrustSafetyController } from './http/trust-safety.controller.js';
import { OperationsStaffController } from './http/operations-staff.controller.js';
import { AutomationCallbackController } from './http/automation-callback.controller.js';
import { LearnerContentController } from './http/learner-content.controller.js';
import { PublicProfileController } from './http/public-profile.controller.js';
import { API_FILE_SCANNER, API_FILE_STORAGE } from './http/api-security.js';

const runtimeConfig = loadRuntimeConfig();
const databaseRuntime = createDatabaseRuntime(runtimeConfig.databaseUrl);
const staffPoolPolicy = createRuntimeStaffPoolPolicy(runtimeConfig);

/** Disk storage, wrapped in at-rest encryption whenever FILE_ENCRYPTION_KEY is set. */
function configuredFileStorage(documents: typeof runtimeConfig.documents): FileStorage {
  const disk = createLocalDiskStorage(documents.storageRoot!);
  return documents.fileEncryptionKey
    ? createEncryptedStorage(disk, parseFileEncryptionKey(documents.fileEncryptionKey))
    : disk;
}
const configuredScanner = runtimeConfig.documents.clamavSocketPath
  ? createClamAvScanner({ socketPath: runtimeConfig.documents.clamavSocketPath })
  : runtimeConfig.documents.clamavHost && runtimeConfig.documents.clamavPort
    ? createClamAvScanner({ host: runtimeConfig.documents.clamavHost, port: runtimeConfig.documents.clamavPort })
    : undefined;

@Module({
  imports: [
    Phase1ApiSecurityModule.register({
      verifier: createRuntimeIdentityVerifier(runtimeConfig),
      identityStore: databaseRuntime.identityStore,
      db: databaseRuntime.db,
      // ADR-025: only when COGNITO_STAFF_* are set; absent, memberships are unchanged.
      ...(staffPoolPolicy ? { staffPoolPolicy } : {}),
      // Both or neither: config already refuses a storage root without a scanner, so
      // documents are either fully configured or reported unavailable.
      ...(runtimeConfig.documents.storageRoot ? { fileStorage: configuredFileStorage(runtimeConfig.documents) } : {}),
      ...(configuredScanner ? { fileScanner: configuredScanner } : {}),
    }),
  ],
  controllers: [HealthController, CareerReadinessController, CareerTargetsController, AcademicRecordsController, PlatformControlsController, InstitutionExportsController, TrustSafetyController, OperationsStaffController, AutomationCallbackController, LearnerContentController, PublicProfileController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    // The public-profile controller lives here because it needs the pool, and it needs the
    // same document store and scanner the api-security module is given.
    ...(runtimeConfig.documents.storageRoot
      ? [{ provide: API_FILE_STORAGE, useValue: configuredFileStorage(runtimeConfig.documents) }] : []),
    ...(configuredScanner ? [{ provide: API_FILE_SCANNER, useValue: configuredScanner }] : []),
    { provide: PG_POOL, useValue: databaseRuntime.pool },
    PostgresRuntimeLifecycle,
  ],
})
export class AppModule {}
