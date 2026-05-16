import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { PersistentModelHostSocket } from './persistent-model-host-socket';
import type {
  LlmInferOptions,
  LlmInputPart,
  LlmMessage,
  LlmStreamEvent,
  LlmStreamResult,
} from './llm-stream-types';

/**
 * Persistent client to the *utility* model host — the smaller /
 * faster / wider-context model that handles support work (classifier,
 * active-slot resolution) without tying up the main answer model.
 *
 * Mirrors LlmHostService's streamInfer surface so callers can swap
 * between hosts trivially; the difference is just which config block
 * we read (utilityLlmHost vs llmHost).
 */
@Injectable()
export class UtilityLlmHostService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(UtilityLlmHostService.name);
  private client?: PersistentModelHostSocket;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  isEnabled(): boolean {
    return this.cfg.utilityLlmHost.enabled;
  }

  shouldFallbackOnError(): boolean {
    return (
      this.cfg.utilityLlmHost.enabled &&
      this.cfg.utilityLlmHost.fallbackToMainOnError
    );
  }

  onModuleInit(): void {
    if (!this.cfg.utilityLlmHost.enabled) {
      this.log.warn(
        'UtilityLlmHostService disabled by config; classifier turns will run on main LlmHost.',
      );
      return;
    }
    void this.modelHost()
      .connect()
      .catch((err: Error) => {
        this.log.warn(
          `Utility LLM Host persistent socket unavailable at startup (${this.cfg.utilityLlmHost.baseUrl}): ${err.message}`,
        );
      });
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = undefined;
  }

  /**
   * Same shape as LlmHostService.streamInfer. The console log block
   * is tagged "UTILITY LLM PROMPT" so the running logs can be
   * filtered to show only classifier traffic.
   */
  async streamInfer(args: {
    correlationId: string;
    parts?: LlmInputPart[];
    messages?: LlmMessage[];
    options?: LlmInferOptions;
    onEvent?: (event: LlmStreamEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<LlmStreamResult> {
    if (!this.cfg.utilityLlmHost.enabled) {
      throw new Error(
        'UtilityLlmHostService is disabled; caller should fall back to main LlmHost.',
      );
    }

    console.log('===== UTILITY LLM PROMPT =====');
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
    console.log('==============================');

    const result = await this.modelHost().streamInfer({
      correlationId: args.correlationId,
      request: {
        requestContext: {
          callerService: this.cfg.utilityLlmHost.callerService,
          requestedAt: new Date().toISOString(),
        },
        input: {
          ...(args.messages ? { messages: args.messages } : {}),
          ...(args.parts ? { parts: args.parts } : {}),
        },
        ...(args.options ? { options: args.options } : {}),
      },
      timeoutMs: this.cfg.utilityLlmHost.timeoutMs,
      onEvent: args.onEvent,
      abortSignal: args.abortSignal,
    });

    return {
      finishReason: result.finishReason,
      text: result.text,
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
      this.cfg.utilityLlmHost.baseUrl.replace(/\/$/, ''),
      this.cfg.utilityLlmHost.timeoutMs,
      this.log,
      (value) => this.normalizeFinishReason(value),
      'Utility LLM Host',
    );
    return this.client;
  }
}
