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
  LlmBackendInfo,
  LlmBackendsList,
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
  LlmBackendInfo,
  LlmBackendsList,
  LlmContextWindow,
  LlmInferOptions,
  LlmInputPart,
  LlmMessage,
  LlmModelInfo,
  LlmStreamEvent,
  LlmStreamResult,
  QueueWaitInfo,
};

export type LlmBackendName = 'ollama' | 'anthropic';

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
  /**
   * Last successful model.status response, cached so per-turn callers
   * can check `thinkingSupported` etc. synchronously without paying
   * for a fresh round-trip every turn. Populated at boot via
   * onModuleInit and refreshed on each getModelInfo() call.
   */
  private cachedModelInfo: LlmModelInfo | null = null;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  /**
   * Synchronous accessor for the cached model.status response.
   * Returns null until the first successful getModelInfo() resolves.
   * Callers should treat null as "thinking not supported" / "unknown
   * model" rather than retry on every turn.
   */
  getCachedModelInfo(): LlmModelInfo | null {
    return this.cachedModelInfo;
  }

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

  async getModelId(backend?: LlmBackendName): Promise<string> {
    return (await this.getModelInfo(backend)).modelId;
  }

  /**
   * Returns the LLM model identity + capability flags reported by the
   * Vanamonde LLM Host (`model.status`). The orchestrator passes these
   * values through to client apps unchanged so the UI can render
   * model-dependent affordances (e.g. hide the "Force thinking"
   * checkbox when the configured model does not support thinking).
   * Always proxies live to the LLM Host so model swaps there are
   * visible without an orchestrator restart.
   *
   * Optionally targets a specific backend on the LLM Host (e.g.
   * 'anthropic'). When omitted, the LLM Host returns the status of
   * its configured default backend.
   */
  async getModelInfo(backend?: LlmBackendName): Promise<LlmModelInfo> {
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
        const payload = backend ? { backend } : undefined;
        ws.send(
          JSON.stringify({
            type: 'model.status',
            correlationId,
            ...(payload ? { payload } : {}),
          }),
        );
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
    this.cachedModelInfo = info;
    this.log.log(
      `LLM model resolved: ${info.modelId} (thinkingSupported=${info.thinkingSupported}` +
        (info.contextWindow
          ? `, numCtx=${info.contextWindow.numCtx}, promptBudgetTokens=${info.contextWindow.promptBudgetTokens}`
          : ', contextWindow=unknown') +
        ')',
    );
    return info;
  }

  /**
   * Returns the list of backends the LLM Host is currently configured
   * to serve. Used by the UI's model picker to render its dropdown.
   * Always queries live (no caching) so model picker reflects the
   * current host state.
   */
  async listBackends(): Promise<LlmBackendsList> {
    const baseUrl = this.cfg.llmHost.baseUrl.replace(/\/$/, '');
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/v5/model';
    const correlationId = randomUUID();
    return new Promise<LlmBackendsList>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('backends.list timeout'));
      }, this.cfg.llmHost.timeoutMs);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'backends.list', correlationId }));
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
            // Hosts on older builds (pre-multi-backend) don't know
            // this message type and reply with `validation_failed`.
            // In that case we synthesize a single-backend list from
            // the legacy model.status so the UI still renders.
            this.legacyListBackendsFallback().then(resolve, reject);
            return;
          }
          if (!isRecord(env.payload)) {
            reject(new Error('backends.list returned no payload'));
            return;
          }
          const defaultBackend = env.payload.defaultBackend;
          const backendsRaw = env.payload.backends;
          if (
            (defaultBackend !== 'ollama' && defaultBackend !== 'anthropic') ||
            !Array.isArray(backendsRaw)
          ) {
            reject(new Error('backends.list returned malformed payload'));
            return;
          }
          const backends: LlmBackendInfo[] = [];
          for (const item of backendsRaw) {
            if (!isRecord(item)) continue;
            if (item.name !== 'ollama' && item.name !== 'anthropic') continue;
            if (
              typeof item.displayName !== 'string' ||
              typeof item.modelId !== 'string'
            ) {
              continue;
            }
            const location =
              item.location === 'cloud' ? 'cloud' : 'local';
            backends.push({
              name: item.name as LlmBackendName,
              displayName: item.displayName,
              modelId: item.modelId,
              location,
            });
          }
          resolve({
            defaultBackend: defaultBackend as LlmBackendName,
            backends,
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
  }

  private async legacyListBackendsFallback(): Promise<LlmBackendsList> {
    // Pre-multi-backend hosts don't speak `backends.list`. Build a
    // single-entry list from their model.status. We don't know which
    // backend the host actually runs (the host doesn't expose that
    // field on older builds), so we report it as 'ollama' (the only
    // backend that existed before this version).
    const info = await this.getModelInfo();
    return {
      defaultBackend: 'ollama',
      backends: [
        {
          name: 'ollama',
          displayName: `Ollama — ${info.modelId} (local)`,
          modelId: info.modelId,
          location: 'local',
        },
      ],
    };
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
    /**
     * Optional per-request backend selector. When omitted, the LLM
     * Host routes to its configured default backend (preserving
     * pre-multi-backend behaviour).
     */
    backend?: LlmBackendName;
  }): Promise<LlmStreamResult> {
    console.log('===== LLM PROMPT =====');
    console.log('correlationId:', args.correlationId);
    console.log('backend:', args.backend ?? '(default)');
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
    backend?: LlmBackendName;
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
      ...(args.backend ? { backend: args.backend } : {}),
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
