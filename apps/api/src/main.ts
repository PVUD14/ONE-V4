import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadRuntimeConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create(AppModule, {
    logger: config.nodeEnv === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug'],
  });

  app.enableShutdownHooks();
  if (config.apiCorsOrigin) {
    app.enableCors({
      origin: config.apiCorsOrigin,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    });
  }

  await app.listen(config.apiPort, config.apiHost);
  Logger.log(`PlanthePath API listening on http://${config.apiHost}:${config.apiPort}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup failure';
  Logger.error(`PlanthePath API failed to start: ${message}`, undefined, 'Bootstrap');
  process.exitCode = 1;
});
