import { Logger, ServiceUnavailableException } from '@nestjs/common';
import WebSocket from 'ws';
import type {
  LlmInferOptions,
  LlmInputPart,
  LlmMessage,
  LlmStreamEvent,
  QueueWaitInfo,
} from './llm-stream-types';

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ModelHostInferRequest {
  requestContext: {
    callerService: string;
    priority?: number;
    requestedAt: string;
  };
  input: { parts?: LlmInputPart[]; messages?: LlmMessage[] };
  options?: LlmInferOptions;
}

export interface PersistentInferRequest {
  correlationId: string;
  request: ModelHostInferRequest;
  timeoutMs: number;
  onEvent?: (event: LlmStreamEvent) => void;
  abortSignal?: AbortSignal;
}

export interface PersistentInferResult {
  finishReason: 'stop' | 'length' | 'error';
  text: string;
  appliedOptions?: LlmInferOptions;
}

interface PendingInferRequest {
  text: string;
  thinkingText: string;
  finishReason: 'stop' | 'length' | 'error';
  timer: NodeJS.Timeout;
  onEvent?: (event: LlmStreamEvent) => void;
  resolve: (result: PersistentInferResult) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

interface RawLlmEnvelope {
  type?: string;
  correlationId?: string;
  payload?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

/**
 * Long-lived WebSocket client to a v5 Model Host (swirlock-llm-host).
 * Multiplexes inference requests by correlationId. Reconnects on close.
 *
 * Used by both LlmHostService (main answer model) and
 * UtilityLlmHostService (smaller helper model on a separate machine).
 */
export class PersistentModelHostSocket {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;
  private readonly pending = new Map<string, PendingInferRequest>();

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs: number,
    private readonly log: Logger,
    private readonly normalizeFinishReason: (
      value: unknown,
    ) => 'stop' | 'length' | 'error',
    /** Tag used in log lines + console block headers ("LLM Host", "Utility LLM Host"). */
    private readonly logTag: string = 'LLM Host',
  ) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.closing = false;
    const wsUrl = this.streamUrl();

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
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
          reject(
            new Error(`${this.logTag} persistent socket connect timeout`),
          );
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
        settle(() =>
          reject(new Error(`${this.logTag} persistent socket closed`)),
        );
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.failAll(new Error(`${this.logTag} persistent socket closed`));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  async streamInfer(
    args: PersistentInferRequest,
  ): Promise<PersistentInferResult> {
    await this.connect();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException(
        `${this.logTag} persistent socket unavailable`,
      );
    }

    return new Promise<PersistentInferResult>((resolve, reject) => {
      if (this.pending.has(args.correlationId)) {
        reject(
          new ServiceUnavailableException(
            `${this.logTag} request ${args.correlationId} is already pending`,
          ),
        );
        return;
      }

      const timeoutMs = args.timeoutMs || this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.rejectPending(
          args.correlationId,
          new ServiceUnavailableException(`${this.logTag} stream timeout`),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        this.sendCancel(args.correlationId);
        this.rejectPending(args.correlationId, new Error('aborted'));
      };
      args.abortSignal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(args.correlationId, {
        text: '',
        thinkingText: '',
        finishReason: 'error',
        timer,
        onEvent: args.onEvent,
        resolve,
        reject,
        abortSignal: args.abortSignal,
        onAbort,
      });

      try {
        ws.send(
          JSON.stringify({
            type: 'infer',
            correlationId: args.correlationId,
            payload: { request: args.request },
          }),
        );
      } catch (error) {
        this.rejectPending(
          args.correlationId,
          error instanceof Error
            ? error
            : new Error(`${this.logTag} send failed`),
        );
      }
    });
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (raw: WebSocket.RawData) => {
      this.handleMessage(raw);
    });

    ws.on('error', (err: Error) => {
      this.log.error(`${this.logTag} persistent WS error: ${err.message}`);
    });

    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = undefined;
      }
      this.failAll(new Error(`${this.logTag} persistent socket closed`));
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let rawEvent: RawLlmEnvelope;
    try {
      rawEvent = JSON.parse(rawToString(raw)) as RawLlmEnvelope;
    } catch {
      this.log.warn(`${this.logTag} emitted non-JSON stream message`);
      return;
    }

    const correlationId =
      typeof rawEvent.correlationId === 'string' ? rawEvent.correlationId : '';
    if (!correlationId) {
      this.log.warn(`${this.logTag} emitted stream event without correlationId`);
      return;
    }

    const pending = this.pending.get(correlationId);
    if (!pending) return;
    const evt = this.normalizeEvent(rawEvent);
    if (!evt) {
      this.log.warn(`${this.logTag} emitted malformed stream event`);
      return;
    }

    try {
      pending.onEvent?.(evt);
    } catch (error) {
      this.log.warn(
        `stream event handler threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (evt.type === 'chunk' && evt.payload.text) {
      pending.text += evt.payload.text;
    } else if (evt.type === 'thinking' && evt.payload.text) {
      pending.thinkingText += evt.payload.text;
    }

    if (evt.type === 'queued' || evt.type === 'started') {
      console.log(`===== ${this.logTag.toUpperCase()} EVENT =====`);
      console.log('correlationId:', correlationId);
      console.log('type:', evt.type);
      console.log('payload:', JSON.stringify(evt.payload));
      console.log('=====================');
    } else if (evt.type === 'done') {
      console.log(`===== ${this.logTag.toUpperCase()} EVENT =====`);
      console.log('correlationId:', correlationId);
      console.log('type: done');
      console.log('payload:', JSON.stringify(evt.payload));
      if (pending.thinkingText) {
        console.log('--- thinking ---');
        console.log(pending.thinkingText);
      }
      console.log('--- text ---');
      console.log(pending.text);
      console.log('=====================');
    }

    if (evt.type === 'done') {
      this.resolvePending(correlationId, {
        finishReason: this.normalizeFinishReason(evt.payload.finishReason),
        text: pending.text,
        ...(evt.payload.appliedOptions
          ? { appliedOptions: evt.payload.appliedOptions }
          : {}),
      });
    }

    if (evt.type === 'error') {
      this.rejectPending(
        correlationId,
        new ServiceUnavailableException(
          evt.error?.message ?? `${this.logTag} stream error`,
        ),
      );
    }
  }

  private resolvePending(
    correlationId: string,
    result: PersistentInferResult,
  ): void {
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
    pending: PendingInferRequest,
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
      pending.reject(new ServiceUnavailableException(error.message));
    }
  }

  private sendCancel(correlationId: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'cancel', correlationId }));
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err: Error) => {
        this.log.warn(
          `${this.logTag} persistent socket reconnect failed (${this.baseUrl}): ${err.message}`,
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
        .replace(/\/$/, '') + '/v5/model'
    );
  }

  private normalizeEvent(raw: RawLlmEnvelope): LlmStreamEvent | null {
    if (typeof raw.type !== 'string') return null;
    const payload = isRecord(raw.payload) ? raw.payload : {};

    switch (raw.type) {
      case 'accepted':
      case 'started':
        return { type: raw.type, payload: {} };
      case 'queued':
        return { type: 'queued', payload: payload as unknown as QueueWaitInfo };
      case 'thinking':
      case 'chunk':
        return {
          type: raw.type,
          payload: {
            text: typeof payload.text === 'string' ? payload.text : '',
          },
        };
      case 'done':
        return {
          type: 'done',
          payload: {
            finishReason: this.normalizeFinishReason(payload.finishReason),
            ...(isRecord(payload.appliedOptions)
              ? {
                  appliedOptions: payload.appliedOptions,
                }
              : {}),
          },
        };
      case 'error':
        return {
          type: 'error',
          error: {
            code: raw.error?.code ?? 'upstream_unavailable',
            message: raw.error?.message ?? `${this.logTag} stream error`,
            retryable: raw.error?.retryable !== false,
          },
        };
      default:
        return null;
    }
  }
}
