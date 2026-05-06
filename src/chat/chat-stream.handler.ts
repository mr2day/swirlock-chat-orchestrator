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
import { LlmHostService } from '../llm-host/llm-host.service';
import type { RetrievalStreamEvent } from '../rag/rag.service';
import { ChatService } from './chat.service';
import type { PersistedTurn, PreparedTurn } from './chat.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SubmitTurnDto } from './dto/submit-turn.dto';

interface ConnectionContext {
  authUserId: string;
  correlationId: string;
}

interface V4Envelope {
  type: string;
  correlationId: string;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

interface SubmittedTurn {
  correlationId: string;
  sessionId: string;
  dto: SubmitTurnDto;
}

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ChatStreamHandler {
  private readonly log = new Logger(ChatStreamHandler.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly chat: ChatService,
    private readonly llm: LlmHostService,
  ) {}

  async handle(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    let inFlightTurn = false;
    let activeTurnAbort: AbortController | null = null;

    ws.on('message', (raw: WebSocket.RawData) => {
      let envelope: V4Envelope;
      try {
        envelope = this.parseEnvelope(raw);
      } catch (err) {
        this.sendError(
          ws,
          ctx.correlationId,
          400,
          err instanceof Error ? err.message : 'Invalid message',
        );
        return;
      }

      if (envelope.type === 'heartbeat') {
        this.send(ws, {
          type: 'heartbeat',
          correlationId: envelope.correlationId,
          payload: { receivedAt: new Date().toISOString() },
        });
        return;
      }

      if (envelope.type === 'cancel') {
        activeTurnAbort?.abort();
        return;
      }

      if (envelope.type === 'turn.submit') {
        if (inFlightTurn) {
          this.sendError(
            ws,
            envelope.correlationId,
            409,
            'A turn is already in progress on this chat WebSocket',
          );
          return;
        }

        let submitted: SubmittedTurn;
        try {
          submitted = this.parseSubmittedTurn(envelope);
        } catch (err) {
          this.sendError(
            ws,
            envelope.correlationId,
            400,
            err instanceof Error ? err.message : 'Invalid turn.submit payload',
          );
          return;
        }

        inFlightTurn = true;
        void this.processTurn(ws, ctx, submitted, (abort) => {
          activeTurnAbort = abort;
        })
          .catch((err: Error) => {
            this.log.error(`processTurn crashed: ${err.message}`, err.stack);
            this.sendError(ws, envelope.correlationId, 500, err.message);
          })
          .finally(() => {
            activeTurnAbort = null;
            inFlightTurn = false;
          });
        return;
      }

      void this.processControlMessage(ws, ctx, envelope).catch((err: Error) => {
        this.sendError(ws, envelope.correlationId, 500, err.message);
      });
    });

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
  }

  private async processControlMessage(
    ws: WebSocket,
    ctx: ConnectionContext,
    envelope: V4Envelope,
  ): Promise<void> {
    if (envelope.type === 'health.get') {
      this.send(ws, {
        type: 'health',
        correlationId: envelope.correlationId,
        payload: {
          status: 'ok',
          ready: true,
          checkedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (envelope.type === 'session.create') {
      const dto = plainToInstance(
        CreateSessionDto,
        this.requirePayloadRequest(envelope),
      );
      await this.validateDto(dto);
      const res = this.chat.createSession({
        dto,
        correlationId: envelope.correlationId,
        authUserId: ctx.authUserId,
      });
      this.send(ws, {
        type: 'session.created',
        correlationId: envelope.correlationId,
        payload: res.data,
      });
      return;
    }

    if (envelope.type === 'session.get') {
      const sessionId = this.requireSessionId(envelope);
      const res = this.chat.getSession({
        sessionId,
        correlationId: envelope.correlationId,
        authUserId: ctx.authUserId,
      });
      this.send(ws, {
        type: 'session.snapshot',
        correlationId: envelope.correlationId,
        payload: res.data,
      });
      return;
    }

    if (envelope.type === 'session.delete') {
      const sessionId = this.requireSessionId(envelope);
      const res = this.chat.deleteSession({
        sessionId,
        correlationId: envelope.correlationId,
        authUserId: ctx.authUserId,
      });
      this.send(ws, {
        type: 'session.deleted',
        correlationId: envelope.correlationId,
        payload: res.data,
      });
      return;
    }

    this.sendError(
      ws,
      envelope.correlationId,
      400,
      `Unsupported message type: ${envelope.type}`,
    );
  }

  private async processTurn(
    ws: WebSocket,
    ctx: ConnectionContext,
    submitted: SubmittedTurn,
    setActiveAbort: (abort: AbortController) => void,
  ): Promise<void> {
    const { correlationId, dto, sessionId } = submitted;
    const send = (type: string, payload: unknown = {}): void =>
      this.send(ws, { type, correlationId, payload });
    let cleanupAbort = (): void => undefined;
    const failTurn = (status: number, message: string): void => {
      cleanupAbort();
      this.sendError(ws, correlationId, status, message);
    };

    try {
      await this.validateDto(dto);
    } catch (err) {
      failTurn(400, err instanceof Error ? err.message : 'Invalid turn');
      return;
    }

    send('turn.accepted');
    send('turn.classifying');

    const abort = new AbortController();
    setActiveAbort(abort);
    const onClose = (): void => abort.abort();
    cleanupAbort = (): void => {
      ws.off('close', onClose);
    };
    ws.once('close', onClose);

    let prepared: PreparedTurn;
    try {
      prepared = await this.chat.prepareTurn({
        sessionId,
        dto,
        correlationId,
        authUserId: ctx.authUserId,
        abortSignal: abort.signal,
        onRagStreamEvent: (event: RetrievalStreamEvent) => {
          send('turn.retrieval', { event });
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
              send('turn.queued', evt.payload);
              break;
            case 'started':
              send('turn.started');
              break;
            case 'thinking':
              send('turn.thinking', evt.payload);
              break;
            case 'chunk':
              send('turn.chunk', evt.payload);
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
        sessionId,
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
    send('turn.done', {
      sessionId,
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
    });
  }

  private parseEnvelope(raw: WebSocket.RawData): V4Envelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(raw));
    } catch {
      throw new Error('message must be JSON');
    }
    if (!isRecord(parsed)) {
      throw new Error('message must be an object');
    }
    if (typeof parsed.type !== 'string' || !parsed.type.trim()) {
      throw new Error('message.type is required');
    }
    const correlationId =
      typeof parsed.correlationId === 'string'
        ? parsed.correlationId.trim()
        : '';
    if (!correlationId) {
      throw new Error('message.correlationId is required');
    }

    return {
      type: parsed.type.trim(),
      correlationId,
      payload: parsed.payload,
    };
  }

  private parseSubmittedTurn(envelope: V4Envelope): SubmittedTurn {
    if (!isRecord(envelope.payload)) {
      throw new Error('turn.submit payload is required');
    }

    const sessionId =
      typeof envelope.payload.sessionId === 'string'
        ? envelope.payload.sessionId.trim()
        : '';
    if (!sessionId) {
      throw new Error('turn.submit payload.sessionId is required');
    }
    if (!isRecord(envelope.payload.request)) {
      throw new Error('turn.submit payload.request is required');
    }

    return {
      correlationId: envelope.correlationId,
      sessionId,
      dto: plainToInstance(SubmitTurnDto, envelope.payload.request),
    };
  }

  private requirePayloadRequest(envelope: V4Envelope): unknown {
    if (!isRecord(envelope.payload) || !isRecord(envelope.payload.request)) {
      throw new Error(`${envelope.type} payload.request is required`);
    }
    return envelope.payload.request;
  }

  private requireSessionId(envelope: V4Envelope): string {
    if (!isRecord(envelope.payload)) {
      throw new Error(`${envelope.type} payload is required`);
    }
    const sessionId =
      typeof envelope.payload.sessionId === 'string'
        ? envelope.payload.sessionId.trim()
        : '';
    if (!sessionId) {
      throw new Error(`${envelope.type} payload.sessionId is required`);
    }
    return sessionId;
  }

  private async validateDto(dto: object): Promise<void> {
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const detail = errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('; ');
      throw new Error(`invalid request: ${detail}`);
    }
  }

  private send(ws: WebSocket, event: V4Envelope): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private sendError(
    ws: WebSocket,
    correlationId: string,
    status: number,
    message: string,
  ): void {
    this.send(ws, {
      type: 'error',
      correlationId,
      error: {
        code: this.codeFor(status),
        message,
        retryable: status >= 500 || status === 429,
      },
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
