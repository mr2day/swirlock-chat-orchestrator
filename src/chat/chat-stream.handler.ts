import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import WebSocket from 'ws';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { buildMeta } from '../common/meta.util';
import type { ApiMeta } from '../common/meta.util';
import { LlmHostService } from '../llm-host/llm-host.service';
import type { QueueWaitInfo } from '../llm-host/llm-host.service';
import type { RetrievalStreamEvent } from '../rag/rag.service';
import { ChatService } from './chat.service';
import type { PersistedTurn, PreparedTurn } from './chat.service';
import { SubmitTurnDto } from './dto/submit-turn.dto';

interface ConnectionContext {
  sessionId: string;
  authUserId: string;
  correlationId: string;
}

type ChatStreamEvent =
  | { type: 'accepted'; meta: ApiMeta }
  | { type: 'queued'; meta: ApiMeta; data: QueueWaitInfo }
  | { type: 'started'; meta: ApiMeta }
  | { type: 'retrieval'; meta: ApiMeta; data: RetrievalStreamEvent }
  | { type: 'thinking'; meta: ApiMeta; data: { text: string } }
  | { type: 'chunk'; meta: ApiMeta; data: { text: string } }
  | {
      type: 'done';
      meta: ApiMeta;
      data: {
        sessionId: string;
        turnId: string;
        assistantMessage: {
          messageId: string;
          content: string;
          createdAt: string;
        };
        finishReason: 'stop' | 'length' | 'error';
        citations?: Array<{
          evidenceId: string;
          sourceTitle: string;
          sourceUrl?: string;
        }>;
        diagnostics?: {
          retrievalUsed: boolean;
          memoryFragmentCount: number;
          retrievalMode: string;
          turnRoute: string;
          standardAnswerKey?: string;
          shouldRetrieve: boolean;
          shouldThink: boolean;
          intent: string;
          freshness: string;
          planReason: string;
        };
      };
    }
  | {
      type: 'error';
      meta: ApiMeta;
      error: { code: string; message: string; retryable: boolean };
    };

const READ_FIRST_MESSAGE_TIMEOUT_MS = 30_000;

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * Per-connection orchestration for /v2/chat/sessions/:sessionId/turns/stream.
 *
 * Wire protocol (mirrors the v2 Model Host stream shape, plus orchestrator
 * extensions):
 *
 *   client → server  (one message after connect)
 *     { type: "submit_turn", correlationId: "...", request: SubmitTurnRequest }
 *
 *   server → client  (zero or more, terminating with `done` or `error`)
 *     { type: "accepted", meta }
 *     { type: "retrieval", meta, data: RetrievalStreamEvent }
 *     { type: "queued",   meta, data: QueueWaitInfo }   // upstream passthrough
 *     { type: "started",  meta }
 *     { type: "thinking", meta, data: { text } }        // upstream passthrough
 *     { type: "chunk",    meta, data: { text } }        // upstream passthrough
 *     { type: "done",     meta, data: { sessionId, turnId, assistantMessage, finishReason } }
 *     { type: "error",    meta, error: ErrorBody }
 *
 * The orchestrator buffers `chunk` text, persists user + assistant messages
 * once upstream emits `done`, then emits its own `done` with the persisted
 * message identifiers before closing the socket.
 */
@Injectable()
export class ChatStreamHandler {
  private readonly log = new Logger(ChatStreamHandler.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly chat: ChatService,
    private readonly llm: LlmHostService,
  ) {}

  async handle(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    const send = (event: ChatStreamEvent): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };
    const meta = (): ApiMeta =>
      buildMeta(ctx.correlationId, this.cfg.apiVersion);
    const closeWithError = (status: number, message: string): void => {
      send({
        type: 'error',
        meta: meta(),
        error: {
          code: this.codeFor(status),
          message,
          retryable: status >= 500 || status === 429,
        },
      });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    try {
      this.chat.assertSessionOwnership(ctx.sessionId, ctx.authUserId);
    } catch (err) {
      if (err instanceof HttpException) {
        closeWithError(err.getStatus(), err.message);
      } else {
        closeWithError(500, (err as Error).message);
      }
      return;
    }

    let dto: SubmitTurnDto;
    try {
      dto = await this.readSubmitTurn(ws);
    } catch (err) {
      closeWithError(400, (err as Error).message);
      return;
    }

    send({ type: 'accepted', meta: meta() });

    const abort = new AbortController();
    ws.once('close', () => abort.abort());

    let prepared: PreparedTurn;
    try {
      prepared = await this.chat.prepareTurn({
        sessionId: ctx.sessionId,
        dto,
        correlationId: ctx.correlationId,
        authUserId: ctx.authUserId,
        abortSignal: abort.signal,
        onRagStreamEvent: (event) => {
          send({ type: 'retrieval', meta: meta(), data: event });
        },
      });
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      closeWithError(status, (err as Error).message);
      return;
    }

    let assistantText = '';
    let finishReason: 'stop' | 'length' | 'error' = 'stop';
    const wantThinking = this.resolveThinkingRequest(
      dto,
      prepared.turnPlan.shouldThink,
    );

    if (prepared.directAssistantText) {
      assistantText = prepared.directAssistantText;
      send({ type: 'started', meta: meta() });
      send({ type: 'chunk', meta: meta(), data: { text: assistantText } });
    } else {
      try {
        const result = await this.llm.streamInfer({
          correlationId: ctx.correlationId,
          parts: prepared.llmParts,
          options: { thinking: wantThinking },
          abortSignal: abort.signal,
          onEvent: (evt) => {
            switch (evt.type) {
              case 'queued':
                send({ type: 'queued', meta: meta(), data: evt.data });
                break;
              case 'started':
                send({ type: 'started', meta: meta() });
                break;
              case 'thinking':
                send({ type: 'thinking', meta: meta(), data: evt.data });
                break;
              case 'chunk':
                send({ type: 'chunk', meta: meta(), data: evt.data });
                break;
              // 'accepted' from upstream is dropped; the orchestrator's own
              // `accepted` already signaled to the client that we started work.
              // 'done' and 'error' are handled via the streamInfer result/throw.
              default:
                break;
            }
          },
        });
        assistantText = result.text;
        finishReason = result.finishReason;
      } catch (err) {
        const status =
          err instanceof ServiceUnavailableException
            ? 503
            : err instanceof HttpException
              ? err.getStatus()
              : 500;
        closeWithError(status, (err as Error).message);
        return;
      }
    }

    if (assistantText.length === 0) {
      closeWithError(
        503,
        'LLM Host completed without emitting any text chunks',
      );
      return;
    }

    let persisted: PersistedTurn;
    try {
      persisted = this.chat.persistTurn({
        sessionId: ctx.sessionId,
        parts: dto.message.parts,
        userText: prepared.userText,
        occurredAt: dto.message.occurredAt,
        assistantText,
      });
    } catch (err) {
      this.log.error(`persistTurn failed: ${(err as Error).message}`);
      closeWithError(500, 'Failed to persist turn');
      return;
    }

    send({
      type: 'done',
      meta: meta(),
      data: {
        sessionId: ctx.sessionId,
        turnId: persisted.turnId,
        assistantMessage: {
          messageId: persisted.assistantMessageId,
          content: assistantText,
          createdAt: persisted.createdAt,
        },
        finishReason,
        citations: prepared.ragContext.evidence.map((e) => ({
          evidenceId: e.evidenceId,
          sourceTitle: e.sourceTitle,
          ...(e.sourceUrl ? { sourceUrl: e.sourceUrl } : {}),
        })),
        ...(dto.options?.includeDiagnostics === true
          ? {
              diagnostics: {
                retrievalUsed: prepared.ragContext.retrievalUsed,
                memoryFragmentCount: prepared.memoryFragments.length,
                retrievalMode: prepared.ragContext.retrievalMode,
                turnRoute: prepared.turnPlan.route,
                ...(prepared.turnPlan.standardAnswerKey
                  ? { standardAnswerKey: prepared.turnPlan.standardAnswerKey }
                  : {}),
                shouldRetrieve: prepared.turnPlan.shouldRetrieve,
                shouldThink: prepared.turnPlan.shouldThink,
                intent: prepared.turnPlan.intent,
                freshness: prepared.turnPlan.freshness,
                planReason: prepared.turnPlan.planReason,
              },
            }
          : {}),
      },
    });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private async readSubmitTurn(ws: WebSocket): Promise<SubmitTurnDto> {
    const raw = await this.readFirstMessage(ws);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('first message must be JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== 'submit_turn' ||
      typeof (parsed as { request?: unknown }).request !== 'object' ||
      (parsed as { request?: unknown }).request === null
    ) {
      throw new Error(
        'first message must be { type: "submit_turn", correlationId, request }',
      );
    }
    const dto = plainToInstance(
      SubmitTurnDto,
      (parsed as { request: unknown }).request,
    );
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const detail = errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('; ');
      throw new Error(`invalid SubmitTurnRequest: ${detail}`);
    }
    return dto;
  }

  private readFirstMessage(ws: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('no submit_turn message received within timeout'));
      }, READ_FIRST_MESSAGE_TIMEOUT_MS);

      const onMessage = (raw: WebSocket.RawData): void => {
        cleanup();
        resolve(rawToString(raw));
      };
      const onClose = (): void => {
        cleanup();
        reject(
          new Error('client closed connection before sending submit_turn'),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };

      ws.once('message', onMessage);
      ws.once('close', onClose);
    });
  }

  private codeFor(status: number): string {
    switch (status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 422:
        return 'validation_failed';
      case 502:
      case 503:
      case 504:
        return 'upstream_unavailable';
      default:
        return status >= 500 ? 'internal_error' : 'bad_request';
    }
  }

  private resolveThinkingRequest(
    dto: SubmitTurnDto,
    plannerWantsThinking: boolean,
  ): boolean {
    if (dto.options?.forceThinking === true) return true;
    if (dto.options?.thinking === false) return false;
    return plannerWantsThinking;
  }
}
