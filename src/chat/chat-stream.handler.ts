import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { FragmenterClientService } from '../fragmenter/fragmenter-client.service';
import type { RetrievalStreamEvent } from '../rag/rag.service';
import type { UserLocation } from '../rag/rag.service';
import { AgentLoopService } from './agent-loop.service';
import { ChatService } from './chat.service';
import type { PersistedTurn, PreparedAgentTurn } from './chat.service';
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

@Injectable()
export class ChatStreamHandler {
  private readonly log = new Logger(ChatStreamHandler.name);

  constructor(
    private readonly chat: ChatService,
    private readonly agentLoop: AgentLoopService,
    private readonly fragmenter: FragmenterClientService,
  ) {}

  async handle(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    let inFlightTurn = false;
    let activeTurnAbort: AbortController | null = null;
    const pendingLocations = new Map<string, PendingLocationRequest>();

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
        void this.processTurn(
          ws,
          ctx,
          submitted,
          (abort) => {
            activeTurnAbort = abort;
          },
          pendingLocations,
        )
          .catch((err: Error) => {
            this.log.error(`processTurn crashed: ${err.message}`, err.stack);
            this.sendError(ws, envelope.correlationId, 500, err.message);
          })
          .finally(() => {
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
      const data = this.chat.createSession({
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

    if (envelope.type === 'session.get') {
      const sessionId = this.requireSessionId(envelope);
      const data = this.chat.getSession({
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
      const data = this.chat.deleteSession({
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
    setActiveAbort: (abort: AbortController) => void,
    pendingLocations: Map<string, PendingLocationRequest>,
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

    const turnId = randomUUID();
    let prepared: PreparedAgentTurn;
    try {
      prepared = this.chat.prepareAgentTurn({
        sessionId,
        dto,
        authUserId: ctx.authUserId,
      });
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      failTurn(status, (err as Error).message);
      return;
    }

    const initialUserLocation = dto.userLocation
      ? {
          latitude: dto.userLocation.latitude,
          longitude: dto.userLocation.longitude,
          ...(dto.userLocation.accuracyMeters !== undefined
            ? { accuracyMeters: dto.userLocation.accuracyMeters }
            : {}),
          ...(dto.userLocation.capturedAt !== undefined
            ? { capturedAt: dto.userLocation.capturedAt }
            : {}),
        }
      : undefined;

    let agentResult: Awaited<ReturnType<AgentLoopService['run']>>;
    let emittedStarted = false;
    try {
      agentResult = await this.agentLoop.run({
        sessionId,
        turnId,
        correlationId,
        prepared,
        occurredAt: dto.message.occurredAt,
        ...(initialUserLocation ? { initialUserLocation } : {}),
        initialThinking: this.resolveInitialThinkingRequest(dto),
        abortSignal: abort.signal,
        resolveUserLocation: () =>
          this.requestLocationFromUi(
            ws,
            correlationId,
            pendingLocations,
            abort.signal,
          ),
        onRagStreamEvent: (event: RetrievalStreamEvent) => {
          send('turn.retrieval', { event });
        },
        onFinalChunk: (text: string) => {
          send('turn.chunk', { text });
        },
        onClassifying: (info) => {
          send('turn.classifying', { step: info.step });
        },
        onAgentActivity: (event) => {
          send('turn.agent', {
            phase: event.phase,
            ...(event.command ? { command: event.command } : {}),
            summary: event.summary,
            ...(event.data !== undefined ? { data: event.data } : {}),
          });
        },
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
      });
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

    if (agentResult.assistantText.length === 0) {
      failTurn(503, 'Agent completed without producing final answer text');
      return;
    }

    let persisted: PersistedTurn;
    try {
      persisted = this.chat.persistTurn({
        sessionId,
        turnId,
        parts: dto.message.parts,
        userText: prepared.userText,
        occurredAt: dto.message.occurredAt,
        assistantText: agentResult.assistantText,
      });
    } catch (err) {
      this.log.error(`persistTurn failed: ${(err as Error).message}`);
      failTurn(500, 'Failed to persist turn');
      return;
    }

    // Fire-and-forget notification to the Context Fragmenter. The
    // user-facing turn pipeline does not wait for any reply per v5
    // contract; if the fragmenter is unavailable the notification is
    // dropped and the next turn simply finds whatever consolidation
    // was already in place (possibly none).
    this.fragmenter.notifyObserved({
      sessionId,
      lastTurnId: persisted.turnId,
      lastSeq: persisted.lastSeq,
      observedAt: persisted.createdAt,
    });

    cleanupAbort();
    send('turn.done', {
      sessionId,
      turnId: persisted.turnId,
      assistantMessage: {
        messageId: persisted.assistantMessageId,
        content: agentResult.assistantText,
        createdAt: persisted.createdAt,
      },
      finishReason: agentResult.finishReason,
      citations: agentResult.citations,
      ...(dto.options?.includeDiagnostics === true
        ? {
            diagnostics: {
              ...agentResult.diagnostics,
              personaId: prepared.identity.personaId,
              identityVersion: prepared.identity.identityVersion,
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

  private resolveInitialThinkingRequest(dto: SubmitTurnDto): boolean {
    if (dto.options?.forceThinking === true) return true;
    if (dto.options?.thinking === false) return false;
    return false;
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
    envelope: V4Envelope,
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
