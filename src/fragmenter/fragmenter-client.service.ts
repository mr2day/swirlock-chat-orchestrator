import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SessionObservedNotification {
  sessionId: string;
  lastTurnId: string;
  lastSeq: number;
  observedAt: string;
}

export interface SessionInvalidateNotification {
  sessionId: string;
  reason?: string;
}

export interface ConsolidationUpdatedEvent {
  sessionId: string;
  consolidationKind: string;
  occurredAt: string;
}

interface QueuedFrame {
  type: string;
  correlationId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const MAX_QUEUE_DEPTH = 256;
const MAX_FRAME_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 1000;

/**
 * Persistent WebSocket client to the Context Fragmenter at
 * `/v5/fragmenter`.
 *
 * Per v5 contract, all orchestrator → fragmenter messages are
 * fire-and-forget: the user-facing turn pipeline never blocks on these
 * calls and the orchestrator does not wait for any reply on the live
 * turn hot path.
 *
 * Failure-mode contract: if the fragmenter is unreachable, frames sit
 * in an in-memory queue for a short retry window and are then dropped
 * (per `apps/context-fragmenter.md` § "Failure Behaviour and
 * Degradation"). The chat turn already completed by the time the
 * notification was issued, so dropped notifications never affect the
 * user.
 *
 * When `cfg.fragmenter.enabled` is `false`, this service is a no-op:
 * `connect` is never called, `notifyObserved`/`notifyInvalidated` log
 * at debug level and return immediately. This is the dev/standalone
 * mode for running the orchestrator without a fragmenter peer.
 */
@Injectable()
export class FragmenterClientService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FragmenterClientService.name);
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;
  private readonly outbox: QueuedFrame[] = [];
  private listeners: Array<(event: ConsolidationUpdatedEvent) => void> = [];

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    if (!this.cfg.fragmenter.enabled) {
      this.log.log(
        'Fragmenter integration disabled (cfg.fragmenter.enabled=false); notifiers are no-ops.',
      );
      return;
    }
    void this.connect().catch((err: Error) => {
      this.log.warn(
        `Fragmenter persistent socket unavailable at startup: ${err.message}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.outbox.length = 0;
    this.listeners = [];
  }

  /**
   * Subscribe to inbound `consolidation.updated` events emitted by the
   * fragmenter. The orchestrator MVP does not act on these (it always
   * reads the latest consolidation row via plain SQL at prompt-assembly
   * time), but the subscription point exists so an in-process cache
   * could invalidate cheaply when added later.
   */
  onConsolidationUpdated(
    listener: (event: ConsolidationUpdatedEvent) => void,
  ): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  notifyObserved(notification: SessionObservedNotification): void {
    if (!this.cfg.fragmenter.enabled) return;
    this.enqueue({
      type: 'session.observed',
      correlationId: this.correlationId('observed', notification.sessionId),
      payload: { ...notification },
      attempts: 0,
    });
  }

  notifyInvalidated(notification: SessionInvalidateNotification): void {
    if (!this.cfg.fragmenter.enabled) return;
    this.enqueue({
      type: 'session.invalidate',
      correlationId: this.correlationId('invalidate', notification.sessionId),
      payload: { ...notification },
      attempts: 0,
    });
  }

  private enqueue(frame: QueuedFrame): void {
    if (this.outbox.length >= MAX_QUEUE_DEPTH) {
      const dropped = this.outbox.shift();
      const droppedSessionId =
        dropped && typeof dropped.payload.sessionId === 'string'
          ? dropped.payload.sessionId
          : 'unknown';
      this.log.warn(
        `Fragmenter outbox at capacity; dropped ${dropped?.type ?? 'unknown'} for ${droppedSessionId}`,
      );
    }
    this.outbox.push(frame);
    this.flush();
  }

  private flush(): void {
    if (this.closing) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      void this.connect().catch(() => {
        /* connect() already logs; flush will be retried on reconnect */
      });
      return;
    }
    while (this.outbox.length > 0) {
      const frame = this.outbox.shift();
      if (!frame) break;
      try {
        ws.send(
          JSON.stringify({
            type: frame.type,
            correlationId: frame.correlationId,
            payload: frame.payload,
          }),
        );
      } catch (err) {
        frame.attempts += 1;
        if (frame.attempts >= MAX_FRAME_ATTEMPTS) {
          this.log.warn(
            `Dropping fragmenter ${frame.type} after ${frame.attempts} attempts: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        this.outbox.unshift(frame);
        return;
      }
    }
  }

  private async connect(): Promise<void> {
    if (!this.cfg.fragmenter.enabled) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    if (this.closing) return;

    const wsUrl = this.streamUrl();

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.cfg.fragmenter.bearerToken}`,
        },
      });
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Fragmenter persistent socket connect timeout'));
        });
      }, this.cfg.fragmenter.timeoutMs);

      ws.on('open', () => {
        this.ws = ws;
        this.attachSocketHandlers(ws);
        settle(resolve);
        this.flush();
      });

      ws.on('error', (err: Error) => {
        settle(() => reject(err));
      });

      ws.on('close', () => {
        settle(() => reject(new Error('Fragmenter persistent socket closed')));
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (raw: WebSocket.RawData) => {
      this.handleMessage(raw);
    });

    ws.on('error', (err: Error) => {
      this.log.error(`Fragmenter persistent WS error: ${err.message}`);
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let envelope: { type?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(rawToString(raw)) as {
        type?: unknown;
        payload?: unknown;
      };
    } catch {
      return;
    }

    if (
      envelope.type === 'consolidation.updated' &&
      isRecord(envelope.payload)
    ) {
      const sessionId =
        typeof envelope.payload.sessionId === 'string'
          ? envelope.payload.sessionId
          : '';
      const consolidationKind =
        typeof envelope.payload.consolidationKind === 'string'
          ? envelope.payload.consolidationKind
          : '';
      const occurredAt =
        typeof envelope.payload.occurredAt === 'string'
          ? envelope.payload.occurredAt
          : new Date().toISOString();
      if (sessionId && consolidationKind) {
        const event: ConsolidationUpdatedEvent = {
          sessionId,
          consolidationKind,
          occurredAt,
        };
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (err) {
            this.log.warn(
              `consolidation.updated listener threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err: Error) => {
        this.log.warn(
          `Fragmenter persistent socket reconnect failed: ${err.message}`,
        );
        this.scheduleReconnect();
      });
    }, RECONNECT_BACKOFF_MS);
  }

  private streamUrl(): string {
    const base = this.cfg.fragmenter.baseUrl ?? '';
    return (
      base
        .replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:')
        .replace(/\/$/, '') + '/v5/fragmenter'
    );
  }

  private correlationId(kind: string, sessionId: string): string {
    return `co:${kind}:${sessionId}:${randomUUID()}`;
  }
}
