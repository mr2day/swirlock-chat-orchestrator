import { Inject, Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export type RetrievalMode =
  | 'none'
  | 'local_rag'
  | 'live_web'
  | 'local_and_live';

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

export interface RagInquiry {
  correlationId: string;
  sessionId: string;
  userText: string;
  parts: RagInputPart[];
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

@Injectable()
export class RagService {
  private readonly log = new Logger(RagService.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  async retrieve(inquiry: RagInquiry): Promise<RagContext> {
    if (!this.cfg.rag.enabled) {
      return this.emptyContext();
    }

    if (!this.cfg.rag.baseUrl) {
      this.log.warn('rag.enabled=true but rag.baseUrl is not configured');
      return this.emptyContext();
    }

    try {
      return await this.retrieveViaWebSocket(inquiry);
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

  private retrieveViaWebSocket(inquiry: RagInquiry): Promise<RagContext> {
    const ws = new WebSocket(this.streamUrl(), {
      headers: { 'x-correlation-id': inquiry.correlationId },
    });
    const request = this.buildRetrieveRequest(inquiry);

    let settled = false;

    return new Promise<RagContext>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inquiry.abortSignal?.removeEventListener('abort', onAbort);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error('RAG Engine stream timeout')));
      }, this.cfg.rag.timeoutMs);

      const onAbort = (): void => {
        settle(() => reject(new Error('aborted')));
      };
      inquiry.abortSignal?.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'retrieve_evidence',
            correlationId: inquiry.correlationId,
            request,
          }),
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let event: RetrievalStreamEvent;
        try {
          const parsed: unknown = JSON.parse(rawToString(raw));
          if (!this.isRetrievalStreamEvent(parsed)) {
            this.log.warn('RAG Engine emitted a malformed stream event');
            return;
          }
          event = parsed;
        } catch {
          this.log.warn('RAG Engine emitted non-JSON stream data');
          return;
        }

        try {
          inquiry.onStreamEvent?.(event);
        } catch (error) {
          this.log.warn(
            `RAG stream event handler threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (event.type === 'retrieval.completed') {
          const data = isRecord(event.data) ? event.data.retrieval : undefined;
          settle(() => resolve(this.mapRetrievedContext(data)));
        } else if (event.type === 'retrieval.failed') {
          const message =
            isRecord(event.data) && typeof event.data.message === 'string'
              ? event.data.message
              : 'RAG Engine retrieval failed';
          settle(() => reject(new RagStreamFailedError(message)));
        }
      });

      ws.on('error', (error: Error) => {
        settle(() => reject(error));
      });

      ws.on('close', () => {
        settle(() =>
          reject(new Error('RAG Engine closed stream before completion')),
        );
      });
    });
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
        resolvedQueryText: inquiry.userText,
        freshness: this.cfg.rag.freshness,
        allowedModes: this.cfg.rag.allowedModes,
        maxEvidenceChunks: this.cfg.rag.maxEvidenceChunks,
        synthesisMode: this.cfg.rag.synthesisMode,
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

  private isRetrievalStreamEvent(
    value: unknown,
  ): value is RetrievalStreamEvent {
    return (
      isRecord(value) &&
      typeof value.type === 'string' &&
      Number.isInteger(value.sequence) &&
      typeof value.occurredAt === 'string' &&
      isRecord(value.data)
    );
  }

  private streamUrl(): string {
    return (
      this.cfg.rag
        .baseUrl!.replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:')
        .replace(/\/$/, '') + '/v2/retrieval/evidence/stream'
    );
  }

  private emptyContext(): RagContext {
    return {
      retrievalUsed: false,
      retrievalMode: 'none',
      evidence: [],
    };
  }
}
