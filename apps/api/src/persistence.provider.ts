import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  findIdentityByExternalSubject,
  loadActiveMembershipsForUser,
} from '@planthepath/persistence/src/identity-authentication.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { survivePoolErrors } from '@planthepath/persistence/src/pool-errors.js';
import type { InternalIdentityStore } from '@planthepath/identity/src/principal.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const PG_POOL = Symbol('PG_POOL');

export type RuntimePersistenceDb = PersistenceDb;

export interface DatabaseRuntime {
  readonly pool: Pool;
  readonly db: RuntimePersistenceDb;
  readonly identityStore: InternalIdentityStore;
}

@Injectable()
export class PostgresRuntimeLifecycle implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabaseRuntime(databaseUrl: string): DatabaseRuntime {
  const pool = survivePoolErrors(new Pool({ connectionString: databaseUrl }), 'api');
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    identityStore: {
      findByExternalSubject: (externalSubject) => findIdentityByExternalSubject(db, externalSubject),
      loadActiveMembershipsForUser: (userId) => loadActiveMembershipsForUser(db, userId),
    },
  };
}
