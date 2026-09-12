import { Module } from '@nestjs/common';
import { Phase1ApiSecurityModule } from './http/api-security.module.js';
import { loadRuntimeConfig } from './config.js';
import { createDatabaseRuntime, PG_POOL, PostgresRuntimeLifecycle, RUNTIME_CONFIG } from './persistence.provider.js';
import { createRuntimeIdentityVerifier } from './runtime-auth.js';
import { HealthController } from './health.controller.js';
import { createClamAvScanner } from './storage/clamav.js';
import { createLocalDiskStorage, type FileStorage } from './storage/file-storage.js';
import { createEncryptedStorage, parseFileEncryptionKey } from './storage/encrypted-storage.js';
import { CareerReadinessController } from './http/career-readiness.controller.js';
import { CareerTargetsController } from './http/career-targets.controller.js';
import { AcademicRecordsController } from './http/academic-records.controller.js';
import { AutomationCallbackController } from './http/automation-callback.controller.js';

const runtimeConfig = loadRuntimeConfig();
const databaseRuntime = createDatabaseRuntime(runtimeConfig.databaseUrl);

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
      // Both or neither: config already refuses a storage root without a scanner, so
      // documents are either fully configured or reported unavailable.
      ...(runtimeConfig.documents.storageRoot ? { fileStorage: configuredFileStorage(runtimeConfig.documents) } : {}),
      ...(configuredScanner ? { fileScanner: configuredScanner } : {}),
    }),
  ],
  controllers: [HealthController, CareerReadinessController, CareerTargetsController, AcademicRecordsController, AutomationCallbackController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    { provide: PG_POOL, useValue: databaseRuntime.pool },
    PostgresRuntimeLifecycle,
  ],
})
export class AppModule {}
