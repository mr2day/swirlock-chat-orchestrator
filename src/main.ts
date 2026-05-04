import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module';
import { SERVICE_CONFIG, ServiceConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  const cfg = app.get<ServiceConfig>(SERVICE_CONFIG);
  await app.listen(cfg.port, cfg.host);
  Logger.log(
    `Chat Orchestrator listening on http://${cfg.host}:${cfg.port}`,
    'Bootstrap',
  );
}

void bootstrap();
