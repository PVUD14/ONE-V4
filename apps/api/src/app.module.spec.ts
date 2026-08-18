import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from './app.module.js';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('runtime app module', () => {
  it('serves a minimal health endpoint', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('fails protected routes closed when runtime auth is not configured', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/security/context')
      .set('Authorization', 'Bearer signed-but-untrusted')
      .expect(401);
  });
});
