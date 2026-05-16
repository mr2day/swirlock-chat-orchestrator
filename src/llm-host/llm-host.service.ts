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
import { PersistentModelHostSocket } from './persistent-model-host-socket';
import type {
  LlmContextWindow,
  LlmInferOptions,
  LlmInputPart,
  LlmMessage,
  LlmModelInfo,
  LlmStreamEvent,
  LlmStreamResult,
  QueueWaitInfo,
} from './llm-stream-types';

export type {
  LlmContextWindow,
  LlmInferOptions,
  LlmInputPart,
  LlmMessage,
  LlmModelInfo,
  LlmStreamEvent,
  LlmStreamResult,
  QueueWaitInfo,
};

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface RawLlmEnvelope {
  type?: string;
  correlationId?: string;
  payload?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

@Injectable()
export class LlmHostService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LlmHostService.name);
  private client?: PersistentModelHostSocket;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    void this.modelHost()
      .connect()
      .catch((err: Error) => {
        this.log.warn(
          `Vanamonde LLM Host persistent socket unavailable at startup (${this.cfg.llmHost.baseUrl}): ${err.message}`,
        );
      });
    void this.getModelInfo().catch((err: Error) => {
      this.log.warn(`Could not fetch LLM model info at startup: ${err.message}`);
    });
  }

  async getModelId(): Promise<string> {
    return (await this.getModelInfo()).modelId;
  }

  /**
   * Returns the LLM model identity + capability flags reported by the
   * Vanamonde LLM Host (`model.status`). The orchestrator passes these
   * values through to client apps unchanged so the UI can render
   * model-dependent affordances (e.g. hide the "Force thinking"
   * checkbox when the configured model does not support thinking).
   * Always proxies live to the LLM Host so model swaps there are
   * visible without an orchestrator restart.
   */
  async getModelInfo(): Promise<LlmModelInfo> {
    const baseUrl = this.cfg.llmHost.baseUrl.replace(/\/$/, '');
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/v5/model';
    const correlationId = randomUUID();
    const info = await new Promise<LlmModelInfo>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('model.status timeout'));
      }, this.cfg.llmHost.timeoutMs);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'model.status', correlationId }));
      });
      ws.on('message', (raw) => {
        try {
          const env = JSON.parse(rawToString(raw)) as RawLlmEnvelope;
          if (env.correlationId !== correlationId) return;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          if (env.type === 'error') {
            reject(new Error(env.error?.message ?? 'model.status failed'));
            return;
          }
          if (!isRecord(env.payload)) {
            reject(new Error('model.status returned no payload'));
            return;
          }
          const modelId =
            typeof env.payload.modelId === 'string' ? env.payload.modelId : '';
          if (!modelId) {
            reject(new Error('model.status returned no modelId'));
            return;
          }
          const runtime = isRecord(env.payload.runtime) ? env.payload.runtime : null;
          const thinkingSupported =
            runtime !== null && runtime.thinkingEnabled === true;
          const cwRaw = isRecord(env.payload.contextWindow)
            ? env.payload.contextWindow
            : null;
          let contextWindow: LlmContextWindow | undefined;
          if (
            cwRaw !== null &&
            typeof cwRaw.numCtx === 'number' &&
            typeof cwRaw.promptBudgetTokens === 'number' &&
            typeof cwRaw.responseReserveTokens === 'number' &&
            typeof cwRaw.promptBudgetFraction === 'number'
          ) {
            contextWindow = {
              numCtx: cwRaw.numCtx,
              promptBudgetTokens: cwRaw.promptBudgetTokens,
              responseReserveTokens: cwRaw.responseReserveTokens,
              promptBudgetFraction: cwRaw.promptBudgetFraction,
              ...(typeof cwRaw.fellBackToDefault === 'boolean'
                ? { fellBackToDefault: cwRaw.fellBackToDefault }
                : {}),
            };
          }
          resolve({
            modelId,
            thinkingSupported,
            ...(contextWindow ? { contextWindow } : {}),
          });
        } catch (err) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.log.log(
      `LLM model resolved: ${info.modelId} (thinkingSupported=${info.thinkingSupported}` +
        (info.contextWindow
          ? `, numCtx=${info.contextWindow.numCtx}, promptBudgetTokens=${info.contextWindow.promptBudgetTokens}`
          : ', contextWindow=unknown') +
        ')',
    );
    return info;
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = undefined;
  }

  /**
   * Sends one inference request over the persistent Vanamonde LLM Host
   * WebSocket at `/v5/model`. The orchestrator opens exactly one Model
   * Host socket per the v5 1:1 module-to-LLM rule; there is no per-call
   * URL override. Callers that need streaming UI updates provide
   * `onEvent`.
   */
  async streamInfer(args: {
    correlationId: string;
    parts?: LlmInputPart[];
    messages?: LlmMessage[];
    options?: LlmInferOptions;
    onEvent?: (event: LlmStreamEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<LlmStreamResult> {
    console.log('===== LLM PROMPT =====');
    console.log('correlationId:', args.correlationId);
    console.log('options:', JSON.stringify(args.options ?? {}));
    if (args.messages) {
      for (const m of args.messages) {
        console.log(`--- [${m.role}] ---`);
        console.log(m.content);
      }
    }
    if (args.parts) {
      console.log('--- parts ---');
      console.log(JSON.stringify(args.parts));
    }
    console.log('======================');

    const result = await this.modelHost().streamInfer({
      correlationId: args.correlationId,
      request: this.buildInferRequest(args),
      timeoutMs: this.cfg.llmHost.timeoutMs,
      onEvent: args.onEvent,
      abortSignal: args.abortSignal,
    });

    return {
      finishReason: result.finishReason,
      text: result.text,
    };
  }

  private buildInferRequest(args: {
    parts?: LlmInputPart[];
    messages?: LlmMessage[];
    options?: LlmInferOptions;
  }) {
    return {
      requestContext: {
        callerService: this.cfg.llmHost.callerService,
        requestedAt: new Date().toISOString(),
      },
      input: {
        ...(args.messages ? { messages: args.messages } : {}),
        ...(args.parts ? { parts: args.parts } : {}),
      },
      ...(args.options ? { options: args.options } : {}),
    };
  }

  private normalizeFinishReason(value: unknown): 'stop' | 'length' | 'error' {
    if (value === 'stop' || value === 'length' || value === 'error') {
      return value;
    }
    return 'error';
  }

  private modelHost(): PersistentModelHostSocket {
    if (this.client) return this.client;
    this.client = new PersistentModelHostSocket(
      this.cfg.llmHost.baseUrl.replace(/\/$/, ''),
      this.cfg.llmHost.timeoutMs,
      this.log,
      (value) => this.normalizeFinishReason(value),
    );
    return this.client;
  }
}
