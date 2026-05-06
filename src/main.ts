import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import 'reflect-metadata';
import { AppModule } from './app.module';
import { extractBearerToken } from './auth/bearer-auth.util';
import { ChatStreamHandler } from './chat/chat-stream.handler';
import { SERVICE_CONFIG } from './config/config';
import type { ServiceConfig } from './config/config';

const STREAM_PATH_RE =
  /^\/v2\/chat\/sessions\/([0-9a-fA-F-]{36})\/turns\/stream$/;

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
  const streamHandler = app.get(ChatStreamHandler);

  const corsOrigins = cfg.http?.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'x-correlation-id'],
      exposedHeaders: ['x-correlation-id'],
      credentials: false,
      maxAge: 600,
    });
    Logger.log(
      `CORS enabled for ${corsOrigins.length} origin(s): ${corsOrigins.join(', ')}`,
      'Bootstrap',
    );
  }

  await app.listen(cfg.port, cfg.host);

  attachStreamServer(app.getHttpServer() as HttpServer, cfg, streamHandler);

  Logger.log(
    `Chat Orchestrator listening on http://${cfg.host}:${cfg.port}`,
    'Bootstrap',
  );
  Logger.log(
    `Stream WS path: ws://${cfg.host}:${cfg.port}/v2/chat/sessions/:sessionId/turns/stream`,
    'Bootstrap',
  );
}

function attachStreamServer(
  httpServer: HttpServer,
  cfg: ServiceConfig,
  handler: ChatStreamHandler,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const log = new Logger('ChatStream');

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0];
    const match = STREAM_PATH_RE.exec(pathOnly);
    if (!match) {
      socket.destroy();
      return;
    }

    const token = extractBearerToken(req);
    if (!token || token !== cfg.devUser.bearerToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const incomingCorrelation = req.headers['x-correlation-id'];
    const correlationId =
      typeof incomingCorrelation === 'string' && incomingCorrelation.length > 0
        ? incomingCorrelation
        : Array.isArray(incomingCorrelation) && incomingCorrelation[0]
          ? incomingCorrelation[0]
          : randomUUID();

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handler
        .handle(ws, {
          sessionId,
          authUserId: cfg.devUser.userId,
          correlationId,
        })
        .catch((err: Error) => {
          log.error(`stream handler crashed: ${err.message}`, err.stack);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
    });
  });
}

void bootstrap();
