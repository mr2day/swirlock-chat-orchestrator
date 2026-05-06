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

interface SubmittedTurn {
  correlationId: string;
  dto: SubmitTurnDto;
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

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * Per-connection orchestration for /v2/chat/sessions/:sessionId/turns/stream.
 *
 * The socket is session-scoped and persistent. Clients may send multiple
 * submit_turn messages over the same WebSocket. The orchestrator processes one
 * turn at a time, streams accepted/retrieval/queued/started/thinking/chunk
 * events for that turn, persists user + assistant messages after generation,
 * then emits done and keeps the socket open for the next turn.
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
    try {
      this.chat.assertSessionOwnership(ctx.sessionId, ctx.authUserId);
    } catch (err) {
      this.sendError(
        ws,
        err instanceof HttpException ? err.getStatus() : 500,
        err instanceof Error ? err.message : 'Session ownership check failed',
        ctx.correlationId,
        true,
      );
      return;
    }

    let inFlight = false;

    ws.on('message', (raw: WebSocket.RawData) => {
      let submitted: SubmittedTurn;
      try {
        submitted = this.parseSubmitTurn(raw);
      } catch (err) {
        this.sendError(
          ws,
          400,
          err instanceof Error ? err.message : 'Invalid submit_turn message',
          ctx.correlationId,
          false,
        );
        return;
      }

      if (inFlight) {
        this.sendError(
          ws,
          409,
          'A turn is already in progress on this session WebSocket',
          submitted.correlationId,
          false,
        );
        return;
      }

      inFlight = true;
      void this.processTurn(ws, ctx, submitted)
        .catch((err: Error) => {
          this.log.error(`processTurn crashed: ${err.message}`, err.stack);
          this.sendError(ws, 500, err.message, submitted.correlationId, false);
        })
        .finally(() => {
          inFlight = false;
        });
    });

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
  }

  private async processTurn(
    ws: WebSocket,
    ctx: ConnectionContext,
    submitted: SubmittedTurn,
  ): Promise<void> {
    const { correlationId, dto } = submitted;
    const meta = (): ApiMeta => buildMeta(correlationId, this.cfg.apiVersion);
    const send = (event: ChatStreamEvent): void => this.send(ws, event);
    let cleanupAbort = (): void => undefined;
    const failTurn = (status: number, message: string): void => {
      cleanupAbort();
      send({
        type: 'error',
        meta: meta(),
        error: {
          code: this.codeFor(status),
          message,
          retryable: status >= 500 || status === 429,
        },
      });
    };

    try {
      await this.validateSubmitTurn(dto);
    } catch (err) {
      failTurn(400, err instanceof Error ? err.message : 'Invalid turn');
      return;
    }

    send({ type: 'accepted', meta: meta() });

    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    cleanupAbort = (): void => {
      ws.off('close', onClose);
    };
    ws.once('close', onClose);

    let prepared: PreparedTurn;
    try {
      prepared = await this.chat.prepareTurn({
        sessionId: ctx.sessionId,
        dto,
        correlationId,
        authUserId: ctx.authUserId,
        abortSignal: abort.signal,
        onRagStreamEvent: (event) => {
          send({ type: 'retrieval', meta: meta(), data: event });
        },
      });
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      failTurn(status, (err as Error).message);
      return;
    }

    let assistantText = '';
    let finishReason: 'stop' | 'length' | 'error' = 'stop';
    const wantThinking = this.resolveThinkingRequest(
      dto,
      prepared.turnPlan.shouldThink,
    );

    try {
      const result = await this.llm.streamInfer({
        correlationId,
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
      failTurn(status, (err as Error).message);
      return;
    }

    if (assistantText.length === 0) {
      failTurn(503, 'LLM Host completed without emitting any text chunks');
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
      failTurn(500, 'Failed to persist turn');
      return;
    }

    cleanupAbort();
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
  }

  private parseSubmitTurn(raw: WebSocket.RawData): SubmittedTurn {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(raw));
    } catch {
      throw new Error('message must be JSON');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== 'submit_turn' ||
      typeof (parsed as { request?: unknown }).request !== 'object' ||
      (parsed as { request?: unknown }).request === null
    ) {
      throw new Error(
        'message must be { type: "submit_turn", correlationId, request }',
      );
    }

    const correlationId =
      typeof (parsed as { correlationId?: unknown }).correlationId === 'string'
        ? (parsed as { correlationId: string }).correlationId.trim()
        : '';
    if (!correlationId) {
      throw new Error('submit_turn.correlationId is required');
    }

    return {
      correlationId,
      dto: plainToInstance(
        SubmitTurnDto,
        (parsed as { request: unknown }).request,
      ),
    };
  }

  private async validateSubmitTurn(dto: SubmitTurnDto): Promise<void> {
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
  }

  private send(ws: WebSocket, event: ChatStreamEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private sendError(
    ws: WebSocket,
    status: number,
    message: string,
    correlationId: string,
    close: boolean,
  ): void {
    this.send(ws, {
      type: 'error',
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      error: {
        code: this.codeFor(status),
        message,
        retryable: status >= 500 || status === 429,
      },
    });
    if (close) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
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
      case 409:
        return 'conflict';
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
