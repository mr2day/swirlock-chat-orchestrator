import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import WebSocket from 'ws';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export type RetrievalMode =
  | 'none'
  | 'local_rag'
  | 'live_web'
  | 'local_and_live';

export type RagFreshness = 'low' | 'medium' | 'high' | 'realtime';
export type RagAllowedMode = 'local_rag' | 'live_web';

export interface RagHint {
  kind:
    | 'entity'
    | 'time_reference'
    | 'preference'
    | 'disambiguation'
    | 'constraint';
  text: string;
}

export type RagInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl?: string; imageId?: string; mimeType?: string };

export interface RagEvidence {
  evidenceId: string;
  sourceTitle: string;
  sourceUrl?: string;
  snippet?: string;
}

export interface RagContext {
  retrievalUsed: boolean;
  retrievalMode: RetrievalMode;
  evidence: RagEvidence[];
  diagnostics?: Record<string, unknown>;
}

export interface RetrievalStreamEvent {
  type: string;
  sequence: number;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface UserLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt?: string;
  /**
   * Server-side enrichment fields populated by the orchestrator's
   * GeocodingService after the UI delivers raw coords. Not part of the
   * v5 user-location contract; stripped before being forwarded to the
   * RAG Engine.
   */
  cityName?: string;
  regionName?: string;
  countryName?: string;
  countryCode?: string;
}

export interface RagInquiry {
  correlationId: string;
  sessionId: string;
  userText: string;
  parts: RagInputPart[];
  resolvedQueryText?: string;
  intent?: string;
  hints?: RagHint[];
  freshness?: RagFreshness;
  allowedModes?: RagAllowedMode[];
  userLocation?: UserLocation;
  onStreamEvent?: (event: RetrievalStreamEvent) => void;
  abortSignal?: AbortSignal;
}

interface RetrieveEvidenceData {
  normalizedQuery?: {
    retrievalMode?: RetrievalMode;
  };
  evidenceChunks?: Array<{
    evidenceId?: string;
    sourceTitle?: string;
    sourceUrl?: string;
    content?: string;
  }>;
  retrievalDiagnostics?: Record<string, unknown>;
}

class RagStreamFailedError extends Error {}

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Drop orchestrator-side enrichment fields (cityName, regionName,
 * countryName, countryCode) before sending UserLocation to the RAG
 * Engine. Per v5 contract, the RAG Engine accepts only the four base
 * fields.
 */
function stripUserLocationToContract(loc: UserLocation): {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt?: string;
} {
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    ...(loc.accuracyMeters !== undefined
      ? { accuracyMeters: loc.accuracyMeters }
      : {}),
    ...(loc.capturedAt !== undefined ? { capturedAt: loc.capturedAt } : {}),
  };
}

@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RagService.name);
  private client?: PersistentRagSocket;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    if (this.cfg.rag.enabled && this.cfg.rag.baseUrl) {
      void this.clientFor()
        .connect()
        .catch((err: Error) => {
          this.log.warn(
            `RAG Engine persistent socket unavailable at startup: ${err.message}`,
          );
        });
    }
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = undefined;
  }

  async retrieve(inquiry: RagInquiry): Promise<RagContext> {
    if (!this.cfg.rag.enabled) {
      return this.emptyContext();
    }

    if (!this.cfg.rag.baseUrl) {
      this.log.warn('rag.enabled=true but rag.baseUrl is not configured');
      return this.emptyContext();
    }

    try {
      return await this.clientFor().retrieve({
        correlationId: inquiry.correlationId,
        request: this.buildRetrieveRequest(inquiry),
        timeoutMs: this.cfg.rag.timeoutMs,
        onStreamEvent: inquiry.onStreamEvent,
        abortSignal: inquiry.abortSignal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(
        `[${inquiry.correlationId}] RAG Engine stream unavailable: ${message}`,
      );

      if (!(error instanceof RagStreamFailedError)) {
        inquiry.onStreamEvent?.({
          type: 'retrieval.failed',
          sequence: 1,
          occurredAt: new Date().toISOString(),
          data: { message },
        });
      }

      return this.emptyContext();
    }
  }

  private buildRetrieveRequest(inquiry: RagInquiry) {
    return {
      requestContext: {
        callerService: this.cfg.rag.callerService,
        priority: 'interactive',
        requestedAt: new Date().toISOString(),
        timeoutMs: this.cfg.rag.timeoutMs,
      },
      session: {
        sessionId: inquiry.sessionId,
      },
      query: {
        parts: inquiry.parts,
        resolvedQueryText: inquiry.resolvedQueryText ?? inquiry.userText,
        ...(inquiry.intent ? { intent: inquiry.intent } : {}),
        ...(inquiry.hints && inquiry.hints.length > 0
          ? { hints: inquiry.hints }
          : {}),
        freshness: inquiry.freshness ?? this.cfg.rag.freshness,
        allowedModes: inquiry.allowedModes ?? this.cfg.rag.allowedModes,
        maxEvidenceChunks: this.cfg.rag.maxEvidenceChunks,
        ...(inquiry.userLocation
          ? { userLocation: stripUserLocationToContract(inquiry.userLocation) }
          : {}),
      },
    };
  }

  private mapRetrievedContext(value: unknown): RagContext {
    const data = isRecord(value) ? (value as RetrieveEvidenceData) : {};
    const retrievalMode = this.normalizeRetrievalMode(
      data.normalizedQuery?.retrievalMode,
    );
    const evidence = Array.isArray(data.evidenceChunks)
      ? data.evidenceChunks
          .filter((chunk) => chunk.evidenceId && chunk.sourceTitle)
          .map((chunk) => ({
            evidenceId: String(chunk.evidenceId),
            sourceTitle: String(chunk.sourceTitle),
            ...(chunk.sourceUrl ? { sourceUrl: String(chunk.sourceUrl) } : {}),
            ...(chunk.content ? { snippet: String(chunk.content) } : {}),
          }))
      : [];

    return {
      retrievalUsed: retrievalMode !== 'none',
      retrievalMode,
      evidence,
      ...(data.retrievalDiagnostics
        ? { diagnostics: data.retrievalDiagnostics }
        : {}),
    };
  }

  private normalizeRetrievalMode(value: unknown): RetrievalMode {
    if (
      value === 'local_rag' ||
      value === 'live_web' ||
      value === 'local_and_live'
    ) {
      return value;
    }
    return 'none';
  }

  private emptyContext(): RagContext {
    return {
      retrievalUsed: false,
      retrievalMode: 'none',
      evidence: [],
    };
  }

  private clientFor(): PersistentRagSocket {
    if (this.client) return this.client;
    this.client = new PersistentRagSocket(
      this.cfg.rag.baseUrl!,
      this.cfg.rag.timeoutMs,
      this.log,
      (value) => this.mapRetrievedContext(value),
    );
    return this.client;
  }
}

interface PersistentRagRequest {
  correlationId: string;
  request: unknown;
  timeoutMs: number;
  onStreamEvent?: (event: RetrievalStreamEvent) => void;
  abortSignal?: AbortSignal;
}

interface PendingRagRequest {
  timer: NodeJS.Timeout;
  onStreamEvent?: (event: RetrievalStreamEvent) => void;
  resolve: (result: RagContext) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

interface RawRagEnvelope {
  type?: unknown;
  correlationId?: unknown;
  payload?: unknown;
  error?: { message?: string; retryable?: boolean };
}

class PersistentRagSocket {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;
  private readonly pending = new Map<string, PendingRagRequest>();

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs: number,
    private readonly log: Logger,
    private readonly mapRetrievedContext: (value: unknown) => RagContext,
  ) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.closing = false;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.streamUrl());
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
          reject(new Error('RAG Engine persistent socket connect timeout'));
        });
      }, this.defaultTimeoutMs);

      ws.on('open', () => {
        this.ws = ws;
        this.attachSocketHandlers(ws);
        settle(resolve);
      });

      ws.on('error', (err: Error) => {
        settle(() => reject(err));
      });

      ws.on('close', () => {
        settle(() => reject(new Error('RAG Engine persistent socket closed')));
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failAll(new Error('RAG Engine persistent socket closed'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  async retrieve(args: PersistentRagRequest): Promise<RagContext> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('RAG Engine persistent socket unavailable');
    }

    return new Promise<RagContext>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          args.correlationId,
          new Error('RAG Engine stream timeout'),
        );
      }, args.timeoutMs || this.defaultTimeoutMs);

      const onAbort = (): void => {
        this.sendCancel(args.correlationId);
        this.rejectPending(args.correlationId, new Error('aborted'));
      };
      args.abortSignal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(args.correlationId, {
        timer,
        onStreamEvent: args.onStreamEvent,
        resolve,
        reject,
        abortSignal: args.abortSignal,
        onAbort,
      });

      try {
        ws.send(
          JSON.stringify({
            type: 'retrieve_evidence',
            correlationId: args.correlationId,
            payload: { request: args.request },
          }),
        );
      } catch (error) {
        this.rejectPending(
          args.correlationId,
          error instanceof Error ? error : new Error('RAG Engine send failed'),
        );
      }
    });
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (raw: WebSocket.RawData) => this.handleMessage(raw));
    ws.on('error', (err: Error) => {
      this.log.error(`RAG Engine persistent WS error: ${err.message}`);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      this.failAll(new Error('RAG Engine persistent socket closed'));
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let envelope: RawRagEnvelope;
    try {
      envelope = JSON.parse(rawToString(raw)) as RawRagEnvelope;
    } catch {
      this.log.warn('RAG Engine emitted non-JSON stream data');
      return;
    }

    const correlationId =
      typeof envelope.correlationId === 'string' ? envelope.correlationId : '';
    if (!correlationId) return;
    const pending = this.pending.get(correlationId);
    if (!pending) return;

    if (envelope.type === 'error') {
      this.rejectPending(
        correlationId,
        new Error(envelope.error?.message ?? 'RAG Engine stream error'),
      );
      return;
    }

    const event = this.toRetrievalEvent(envelope);
    if (!event) return;

    try {
      pending.onStreamEvent?.(event);
    } catch (error) {
      this.log.warn(
        `RAG stream event handler threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (event.type === 'retrieval.completed') {
      const data = isRecord(event.data) ? event.data.retrieval : undefined;
      this.resolvePending(correlationId, this.mapRetrievedContext(data));
    } else if (event.type === 'retrieval.failed') {
      const message =
        isRecord(event.data) && typeof event.data.message === 'string'
          ? event.data.message
          : 'RAG Engine retrieval failed';
      this.rejectPending(correlationId, new RagStreamFailedError(message));
    }
  }

  private toRetrievalEvent(
    envelope: RawRagEnvelope,
  ): RetrievalStreamEvent | null {
    if (typeof envelope.type !== 'string' || !isRecord(envelope.payload)) {
      return null;
    }
    return {
      type: envelope.type,
      sequence:
        typeof envelope.payload.sequence === 'number'
          ? envelope.payload.sequence
          : 0,
      occurredAt:
        typeof envelope.payload.occurredAt === 'string'
          ? envelope.payload.occurredAt
          : new Date().toISOString(),
      data: isRecord(envelope.payload.data) ? envelope.payload.data : {},
    };
  }

  private resolvePending(correlationId: string, result: RagContext): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.cleanupPending(correlationId, pending);
    pending.resolve(result);
  }

  private rejectPending(correlationId: string, error: Error): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.cleanupPending(correlationId, pending);
    pending.reject(error);
  }

  private cleanupPending(
    correlationId: string,
    pending: PendingRagRequest,
  ): void {
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      pending.abortSignal?.removeEventListener('abort', pending.onAbort);
    }
  }

  private failAll(error: Error): void {
    for (const [correlationId, pending] of this.pending) {
      this.cleanupPending(correlationId, pending);
      pending.reject(error);
    }
  }

  private sendCancel(correlationId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'cancel', correlationId }));
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err: Error) => {
        this.log.warn(
          `RAG Engine persistent socket reconnect failed (${this.baseUrl}): ${err.message}`,
        );
        this.scheduleReconnect();
      });
    }, 1000);
  }

  private streamUrl(): string {
    return (
      this.baseUrl
        .replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:')
        .replace(/\/$/, '') + '/v5/retrieval'
    );
  }
}
