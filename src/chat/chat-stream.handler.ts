import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import WebSocket from 'ws';
import { FragmenterClientService } from '../fragmenter/fragmenter-client.service';
import { LlmHostService } from '../llm-host/llm-host.service';
import type { UserLocation } from '../rag/rag.service';
import { ChatSessionService } from './chat-session.service';
import {
  ReverseControlFlowService,
  type TurnDoneEnvelope,
} from './reverse-control/reverse-control-flow.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SubmitTurnDto } from './dto/submit-turn.dto';

interface ConnectionContext {
  authUserId: string;
  correlationId: string;
}

interface ChatEnvelope {
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

interface PendingLocationRequest {
  resolve: (location: UserLocation | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCATION_REQUEST_TIMEOUT_MS = 60_000;

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * WebSocket endpoint handler for `/v5/chat`.
 *
 * Owns:
 * - envelope parsing and routing (one inbound JSON object per frame)
 * - the per-connection turn-in-flight lock (one user turn at a time
 *   per WS, per the contract)
 * - the per-correlation `turn.location_required` mailbox
 * - dispatch to ChatSessionService for session.* messages and to
 *   ReverseControlFlowService for turn.submit
 *
 * Does not own:
 * - any prompt construction (lives in `*-prompt-builder.service.ts`)
 * - any LLM/RAG/fragmenter call (lives in their respective services)
 * - session/message persistence (lives in ChatSessionService)
 */
@Injectable()
export class ChatStreamHandler {
  private readonly log = new Logger(ChatStreamHandler.name);

  constructor(
    private readonly sessions: ChatSessionService,
    private readonly flow: ReverseControlFlowService,
    private readonly fragmenter: FragmenterClientService,
    private readonly llm: LlmHostService,
  ) {}

  async handle(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    let inFlightTurn = false;
    let activeTurnAbort: AbortController | null = null;
    const pendingLocations = new Map<string, PendingLocationRequest>();

    ws.on('message', (raw: WebSocket.RawData) => {
      let envelope: ChatEnvelope;
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

      if (envelope.type === 'turn.location_response') {
        this.resolveLocationResponse(envelope, pendingLocations);
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
        const abort = new AbortController();
        activeTurnAbort = abort;
        const onClose = (): void => abort.abort();
        ws.once('close', onClose);

        void this.processTurn(ws, ctx, submitted, abort, pendingLocations)
          .catch((err: Error) => {
            this.log.error(`processTurn crashed: ${err.message}`, err.stack);
            this.sendError(ws, envelope.correlationId, 500, err.message);
          })
          .finally(() => {
            ws.off('close', onClose);
            activeTurnAbort = null;
            inFlightTurn = false;
            const pending = pendingLocations.get(submitted.correlationId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingLocations.delete(submitted.correlationId);
              pending.resolve(null);
            }
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
    envelope: ChatEnvelope,
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

    if (envelope.type === 'model.status') {
      try {
        const info = await this.llm.getModelInfo();
        this.send(ws, {
          type: 'model.status',
          correlationId: envelope.correlationId,
          payload: info,
        });
      } catch (err) {
        this.sendError(
          ws,
          envelope.correlationId,
          503,
          err instanceof Error ? err.message : 'model.status failed',
        );
      }
      return;
    }

    if (envelope.type === 'session.create') {
      const dto = plainToInstance(
        CreateSessionDto,
        this.requirePayloadRequest(envelope),
      );
      await this.validateDto(dto);
      const data = this.sessions.createSession({
        dto,
        authUserId: ctx.authUserId,
      });
      this.send(ws, {
        type: 'session.created',
        correlationId: envelope.correlationId,
        payload: data,
      });
      return;
    }

    if (envelope.type === 'session.list') {
      const payload = (envelope.payload ?? {}) as { personaId?: unknown };
      const personaId =
        typeof payload.personaId === 'string' && payload.personaId.trim()
          ? payload.personaId.trim()
          : null;
      const data = this.sessions.listSessions({
        authUserId: ctx.authUserId,
        personaId,
      });
      this.send(ws, {
        type: 'session.listed',
        correlationId: envelope.correlationId,
        payload: data,
      });
      return;
    }

    if (envelope.type === 'session.get') {
      const sessionId = this.requireSessionId(envelope);
      const data = this.sessions.getSession({
        sessionId,
        authUserId: ctx.authUserId,
      });
      this.send(ws, {
        type: 'session.snapshot',
        correlationId: envelope.correlationId,
        payload: data,
      });
      return;
    }

    if (envelope.type === 'session.delete') {
      const sessionId = this.requireSessionId(envelope);
      const data = this.sessions.deleteSession({
        sessionId,
        authUserId: ctx.authUserId,
      });
      this.fragmenter.notifyInvalidated({
        sessionId,
        reason: 'session.delete',
      });
      this.send(ws, {
        type: 'session.deleted',
        correlationId: envelope.correlationId,
        payload: data,
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
    abort: AbortController,
    pendingLocations: Map<string, PendingLocationRequest>,
  ): Promise<void> {
    const { correlationId, dto, sessionId } = submitted;
    const send = (type: string, payload: unknown = {}): void =>
      this.send(ws, { type, correlationId, payload });

    try {
      await this.validateDto(dto);
    } catch (err) {
      this.sendError(
        ws,
        correlationId,
        400,
        err instanceof Error ? err.message : 'Invalid turn',
      );
      return;
    }

    let emittedStarted = false;

    let result: TurnDoneEnvelope;
    try {
      result = await this.flow.runTurn({
        sessionId,
        authUserId: ctx.authUserId,
        correlationId,
        dto,
        abortSignal: abort.signal,
        onAccepted: () => send('turn.accepted'),
        onRetrievalEvent: (event) => send('turn.retrieval', { event }),
        onModelEvent: (evt) => {
          switch (evt.type) {
            case 'queued':
              send('turn.queued', evt.payload);
              break;
            case 'started':
              if (!emittedStarted) {
                send('turn.started');
                emittedStarted = true;
              }
              break;
            case 'thinking':
              send('turn.thinking', evt.payload);
              break;
            default:
              break;
          }
        },
        onFinalChunk: (text) => send('turn.chunk', { text }),
        onPhaseEvent: (event) => {
          switch (event.type) {
            case 'started':
              send('turn.phase.started', {
                phase: event.phase,
                label: event.label,
                startedAt: new Date().toISOString(),
              });
              return;
            case 'token':
              send('turn.phase.token', {
                phase: event.phase,
                text: event.text,
              });
              return;
            case 'completed':
              send('turn.phase.completed', {
                phase: event.phase,
                ...(event.label !== undefined ? { label: event.label } : {}),
                ...(event.result !== undefined ? { result: event.result } : {}),
                completedAt: new Date().toISOString(),
              });
              return;
            case 'failed':
              send('turn.phase.failed', {
                phase: event.phase,
                message: event.message,
              });
              return;
          }
        },
        resolveUserLocation: () =>
          this.requestLocationFromUi(
            ws,
            correlationId,
            pendingLocations,
            abort.signal,
          ),
      });
    } catch (err) {
      const status =
        err instanceof ServiceUnavailableException
          ? 503
          : err instanceof HttpException
            ? err.getStatus()
            : 500;
      this.sendError(ws, correlationId, status, (err as Error).message);
      return;
    }

    send('turn.done', result);
  }

  private parseEnvelope(raw: WebSocket.RawData): ChatEnvelope {
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

  private parseSubmittedTurn(envelope: ChatEnvelope): SubmittedTurn {
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

  private requirePayloadRequest(envelope: ChatEnvelope): unknown {
    if (!isRecord(envelope.payload) || !isRecord(envelope.payload.request)) {
      throw new Error(`${envelope.type} payload.request is required`);
    }
    return envelope.payload.request;
  }

  private requireSessionId(envelope: ChatEnvelope): string {
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

  private send(ws: WebSocket, event: ChatEnvelope): void {
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

  private async requestLocationFromUi(
    ws: WebSocket,
    correlationId: string,
    pendingLocations: Map<string, PendingLocationRequest>,
    abortSignal: AbortSignal,
  ): Promise<UserLocation | null> {
    if (abortSignal.aborted) return null;

    const existing = pendingLocations.get(correlationId);
    if (existing) {
      clearTimeout(existing.timer);
      pendingLocations.delete(correlationId);
      existing.resolve(null);
    }

    return new Promise<UserLocation | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingLocations.delete(correlationId);
        resolve(null);
      }, LOCATION_REQUEST_TIMEOUT_MS);

      const onAbort = (): void => {
        clearTimeout(timer);
        pendingLocations.delete(correlationId);
        abortSignal.removeEventListener('abort', onAbort);
        resolve(null);
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });

      pendingLocations.set(correlationId, {
        resolve: (location) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', onAbort);
          resolve(location);
        },
        timer,
      });

      this.send(ws, {
        type: 'turn.location_required',
        correlationId,
        payload: {
          requestedAt: new Date().toISOString(),
          timeoutMs: LOCATION_REQUEST_TIMEOUT_MS,
        },
      });
    });
  }

  private resolveLocationResponse(
    envelope: ChatEnvelope,
    pendingLocations: Map<string, PendingLocationRequest>,
  ): void {
    const pending = pendingLocations.get(envelope.correlationId);
    if (!pending) return;

    pendingLocations.delete(envelope.correlationId);

    if (!isRecord(envelope.payload)) {
      pending.resolve(null);
      return;
    }

    const available = envelope.payload.available;
    if (available !== true) {
      pending.resolve(null);
      return;
    }

    const location = isRecord(envelope.payload.location)
      ? envelope.payload.location
      : null;
    if (!location) {
      pending.resolve(null);
      return;
    }

    const latitude = location.latitude;
    const longitude = location.longitude;
    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      pending.resolve(null);
      return;
    }
    if (
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      pending.resolve(null);
      return;
    }

    const resolved: UserLocation = { latitude, longitude };
    if (
      typeof location.accuracyMeters === 'number' &&
      Number.isFinite(location.accuracyMeters) &&
      location.accuracyMeters >= 0
    ) {
      resolved.accuracyMeters = location.accuracyMeters;
    }
    if (
      typeof location.capturedAt === 'string' &&
      !Number.isNaN(Date.parse(location.capturedAt))
    ) {
      resolved.capturedAt = location.capturedAt;
    }

    pending.resolve(resolved);
  }
}
