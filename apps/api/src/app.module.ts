import { Module } from '@nestjs/common';
import { Phase1ApiSecurityModule } from './http/api-security.module.js';
import { loadRuntimeConfig } from './config.js';
import { createDatabaseRuntime, PG_POOL, PostgresRuntimeLifecycle, RUNTIME_CONFIG } from './persistence.provider.js';
import { createRuntimeIdentityVerifier } from './runtime-auth.js';
import { HealthController } from './health.controller.js';
import { CareerReadinessController } from './http/career-readiness.controller.js';
import { AutomationCallbackController } from './http/automation-callback.controller.js';

const runtimeConfig = loadRuntimeConfig();
const databaseRuntime = createDatabaseRuntime(runtimeConfig.databaseUrl);

@Module({
  imports: [
    Phase1ApiSecurityModule.register({
      verifier: createRuntimeIdentityVerifier(runtimeConfig),
      identityStore: databaseRuntime.identityStore,
      db: databaseRuntime.db,
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
