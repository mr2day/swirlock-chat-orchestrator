import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import WebSocket from 'ws';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import type { ApiMeta } from '../common/meta.util';

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export type LlmInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      imageUrl?: string;
      imageBase64?: string;
      mimeType?: string;
    };

export interface LlmInferOptions {
  responseFormat?: 'text' | 'json';
  thinking?: boolean;
  ollama?: Record<string, unknown>;
}

export interface LlmInferResult {
  text: string;
  finishReason: 'stop' | 'length' | 'error';
  modelId: string;
  generatedAt: string;
}

interface InferResponseBody {
  data?: {
    modelId?: string;
    output?: { text?: string };
    finishReason?: 'stop' | 'length' | 'error';
    generatedAt?: string;
  };
}

export interface QueueWaitInfo {
  position: number;
  requestsAhead: number;
  queueDepth: number;
  defaultPriority: boolean;
  priority?: number;
  averageRequestDurationMs?: number;
  estimatedWaitMs?: number;
  estimatedStartAt?: string;
}

export type LlmStreamEvent =
  | { type: 'accepted'; meta: ApiMeta }
  | { type: 'queued'; meta: ApiMeta; data: QueueWaitInfo }
  | { type: 'started'; meta: ApiMeta }
  | { type: 'thinking'; meta: ApiMeta; data: { text: string } }
  | { type: 'chunk'; meta: ApiMeta; data: { text: string } }
  | {
      type: 'done';
      meta: ApiMeta;
      data: {
        finishReason: 'stop' | 'length' | 'error';
        appliedOptions?: LlmInferOptions;
      };
    }
  | {
      type: 'error';
      meta: ApiMeta;
      error: { code: string; message: string; retryable: boolean };
    };

export interface LlmStreamResult {
  finishReason: 'stop' | 'length' | 'error';
  text: string;
}

@Injectable()
export class LlmHostService {
  private readonly log = new Logger(LlmHostService.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  async infer(args: {
    correlationId: string;
    parts: LlmInputPart[];
    options?: LlmInferOptions;
    priority?: number;
  }): Promise<LlmInferResult> {
    const url = `${this.cfg.llmHost.baseUrl.replace(/\/$/, '')}/v2/infer`;
    const body = this.buildInferRequest(args);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.llmHost.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': args.correlationId,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      this.log.error(
        `LLM Host unreachable at ${url}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException('LLM Host unreachable');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      this.log.error(`LLM Host returned ${res.status}: ${text.slice(0, 500)}`);
      throw new ServiceUnavailableException(`LLM Host error ${res.status}`);
    }
    let parsed: InferResponseBody;
    try {
      parsed = JSON.parse(text) as InferResponseBody;
    } catch {
      throw new ServiceUnavailableException('LLM Host returned non-JSON');
    }
    const data = parsed.data;
    if (
      !data?.output?.text ||
      !data.finishReason ||
      !data.modelId ||
      !data.generatedAt
    ) {
      throw new ServiceUnavailableException(
        'LLM Host returned malformed response',
      );
    }
    return {
      text: data.output.text,
      finishReason: data.finishReason,
      modelId: data.modelId,
      generatedAt: data.generatedAt,
    };
  }

  /**
   * Opens the upstream Model Host WebSocket at /v2/infer/stream, sends one
   * StreamInferMessage, and forwards every event to `onEvent` until `done`
   * or `error`. Resolves with the assembled assistant text when the upstream
   * cleanly emits `done`. Rejects on upstream `error`, transport failure,
   * timeout, or premature close.
   */
  async streamInfer(args: {
    correlationId: string;
    parts: LlmInputPart[];
    options?: LlmInferOptions;
    priority?: number;
    onEvent: (event: LlmStreamEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<LlmStreamResult> {
    const wsUrl =
      this.cfg.llmHost.baseUrl
        .replace(/^http:/i, 'ws:')
        .replace(/^https:/i, 'wss:')
        .replace(/\/$/, '') + '/v2/infer/stream';

    const ws = new WebSocket(wsUrl, {
      headers: { 'x-correlation-id': args.correlationId },
    });

    let assistantText = '';
    let finishReason: 'stop' | 'length' | 'error' = 'error';
    let settled = false;

    return new Promise<LlmStreamResult>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(new ServiceUnavailableException('LLM Host stream timeout')),
        );
      }, this.cfg.llmHost.timeoutMs);

      const onAbort = (): void => {
        settle(() => reject(new Error('aborted')));
      };
      args.abortSignal?.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        const msg = {
          type: 'infer',
          correlationId: args.correlationId,
          request: this.buildInferRequest(args),
        };
        ws.send(JSON.stringify(msg));
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let evt: LlmStreamEvent;
        try {
          evt = JSON.parse(rawToString(raw)) as LlmStreamEvent;
        } catch {
          this.log.warn('LLM Host emitted non-JSON stream message');
          return;
        }

        try {
          args.onEvent(evt);
        } catch (e) {
          this.log.warn(`stream event handler threw: ${(e as Error).message}`);
        }

        if (evt.type === 'chunk' && evt.data?.text) {
          assistantText += evt.data.text;
        }
        if (evt.type === 'done') {
          finishReason = evt.data.finishReason;
          settle(() => resolve({ finishReason, text: assistantText }));
        }
        if (evt.type === 'error') {
          settle(() =>
            reject(
              new ServiceUnavailableException(
                evt.error?.message ?? 'LLM Host stream error',
              ),
            ),
          );
        }
      });

      ws.on('error', (err: Error) => {
        this.log.error(`LLM Host WS error: ${err.message}`);
        settle(() =>
          reject(new ServiceUnavailableException('LLM Host unreachable')),
        );
      });

      ws.on('close', () => {
        settle(() =>
          reject(
            new ServiceUnavailableException(
              'LLM Host closed stream without done/error',
            ),
          ),
        );
      });
    });
  }

  private buildInferRequest(args: {
    parts: LlmInputPart[];
    options?: LlmInferOptions;
    priority?: number;
  }) {
    return {
      requestContext: {
        callerService: this.cfg.llmHost.callerService,
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        requestedAt: new Date().toISOString(),
      },
      input: { parts: args.parts },
      ...(args.options ? { options: args.options } : {}),
    };
  }
}
