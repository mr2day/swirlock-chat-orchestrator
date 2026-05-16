import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import * as express from 'express';
import * as fs from 'fs';
import type { Server as HttpServer } from 'http';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import 'reflect-metadata';
import { AppModule } from './app.module';
import { extractBearerToken } from './auth/bearer-auth.util';
import { JwtVerifier } from './auth/jwt-verifier';
import { ChatStreamHandler } from './chat/chat-stream.handler';
import { SERVICE_CONFIG } from './config/config';
import type { ServiceConfig } from './config/config';

const STREAM_PATH = '/v5/chat';
const UPDATES_DIR = path.resolve(__dirname, '..', 'data', 'updates');
const IMAGES_DIR = path.resolve(__dirname, '..', 'data', 'images');

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
  const jwtVerifier = app.get(JwtVerifier);

  attachLiveUpdateEndpoint(app);
  attachImagesEndpoint(app);

  await app.listen(cfg.port, cfg.host);

  attachStreamServer(
    app.getHttpServer() as HttpServer,
    cfg,
    streamHandler,
    jwtVerifier,
  );

  Logger.log(
    `Chat Orchestrator listening on http://${cfg.host}:${cfg.port}`,
    'Bootstrap',
  );
  Logger.log(
    `Stream WS path: ws://${cfg.host}:${cfg.port}${STREAM_PATH}`,
    'Bootstrap',
  );
}

function attachStreamServer(
  httpServer: HttpServer,
  cfg: ServiceConfig,
  handler: ChatStreamHandler,
  jwtVerifier: JwtVerifier,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const log = new Logger('ChatStream');

  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0];
      if (pathOnly !== STREAM_PATH) {
        socket.destroy();
        return;
      }

      const token = extractBearerToken(req);
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let verified;
      try {
        verified = await jwtVerifier.verify(token);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'invalid_token';
        log.warn(`WS upgrade rejected: ${msg}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const incomingCorrelation = req.headers['x-correlation-id'];
      const correlationId =
        typeof incomingCorrelation === 'string' &&
        incomingCorrelation.length > 0
          ? incomingCorrelation
          : Array.isArray(incomingCorrelation) && incomingCorrelation[0]
            ? incomingCorrelation[0]
            : randomUUID();

      wss.handleUpgrade(req, socket, head, (ws) => {
        void handler
          .handle(ws, {
            authUserId: verified.sub,
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
    })();
  });
}

/**
 * Static-file endpoint that backs the Android APK's Capacitor Live
 * Update plugin (@capgo/capacitor-updater). The plugin POSTs to
 * /updates on each app launch with the device's current bundle
 * version; we reply with whatever `data/updates/manifest.json`
 * currently contains. The plugin compares the manifest version to
 * its own and downloads the listed ZIP bundle if it's newer. The
 * ZIPs themselves are served as plain static files at
 * /updates/<filename>.
 *
 * No auth on this endpoint: the manifest and bundle are public —
 * they contain the same compiled Angular code the SPA at
 * gigi-the-robot.com already serves to anyone with a browser.
 */
function attachLiveUpdateEndpoint(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
): void {
  const log = new Logger('LiveUpdate');
  const httpApp = app.getHttpAdapter().getInstance() as express.Express;

  // Make sure the directory exists so file-not-found isn't reported
  // as "manifest missing" on fresh deployments.
  fs.mkdirSync(UPDATES_DIR, { recursive: true });

  httpApp.post('/updates', express.json({ limit: '64kb' }), (_req, res) => {
    const manifestPath = path.join(UPDATES_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ message: 'no update available' });
      return;
    }
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      res.set('Cache-Control', 'no-store');
      res.status(200).json(manifest);
    } catch (err) {
      log.warn(
        `manifest read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ message: 'manifest unreadable' });
    }
  });

  httpApp.use(
    '/updates',
    express.static(UPDATES_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.zip')) {
          // Bundle ZIPs are immutable per version — every push produces
          // a fresh filename, so we can cache forever at every layer.
          res.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        } else {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    }),
  );

  log.log(`Live-update endpoint mounted at /updates (dir=${UPDATES_DIR})`);
}

/**
 * Serves user-attached pictures back to the SPA / APK so reopened
 * sessions can re-render the images the user pasted earlier. The
 * filename is `<userMessageId>-<index>.<ext>` (written by
 * ImagePersistenceService when the turn was originally submitted)
 * and the URL is exposed at `/images/<that filename>`.
 *
 * No auth gate today: the filename is a UUID-derived random string
 * the client only knows because the orchestrator gave it to them.
 * Tighten with a Bearer check if these ever need to be private from
 * other authenticated users on the same orchestrator.
 */
function attachImagesEndpoint(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
): void {
  const log = new Logger('Images');
  const httpApp = app.getHttpAdapter().getInstance() as express.Express;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  httpApp.use(
    '/images',
    express.static(IMAGES_DIR, {
      index: false,
      fallthrough: false,
      setHeaders: (res) => {
        // Images are immutable per messageId (we never overwrite an
        // existing file with new bytes) — long-cache them everywhere.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  log.log(`Image endpoint mounted at /images (dir=${IMAGES_DIR})`);
}

void bootstrap();
