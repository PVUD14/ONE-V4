import { Module } from '@nestjs/common';
import { Phase1ApiSecurityModule } from './http/api-security.module.js';
import { loadRuntimeConfig } from './config.js';
import { createDatabaseRuntime, PG_POOL, PostgresRuntimeLifecycle, RUNTIME_CONFIG } from './persistence.provider.js';
import { createRuntimeIdentityVerifier } from './runtime-auth.js';
import { HealthController } from './health.controller.js';
import { createClamAvScanner } from './storage/clamav.js';
import { createLocalDiskStorage } from './storage/file-storage.js';
import { CareerReadinessController } from './http/career-readiness.controller.js';
import { AutomationCallbackController } from './http/automation-callback.controller.js';

const runtimeConfig = loadRuntimeConfig();
const databaseRuntime = createDatabaseRuntime(runtimeConfig.databaseUrl);
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
      ...(runtimeConfig.documents.storageRoot ? { fileStorage: createLocalDiskStorage(runtimeConfig.documents.storageRoot) } : {}),
      ...(configuredScanner ? { fileScanner: configuredScanner } : {}),
    }),
  ],
  controllers: [HealthController, CareerReadinessController, AutomationCallbackController],
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    { provide: PG_POOL, useValue: databaseRuntime.pool },
    PostgresRuntimeLifecycle,
  ],
})
export class AppModule {}
