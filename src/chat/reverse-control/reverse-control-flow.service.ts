import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SERVICE_CONFIG } from '../../config/config';
import type { ServiceConfig } from '../../config/config';
import { FragmenterClientService } from '../../fragmenter/fragmenter-client.service';
import type {
  LlmInputPart,
  LlmStreamEvent,
} from '../../llm-host/llm-host.service';
import { LlmHostService } from '../../llm-host/llm-host.service';
import type { RetrievalStreamEvent, UserLocation } from '../../rag/rag.service';
import { CappingService } from '../capping/capping.service';
import {
  ChatSessionService,
  extractImageParts,
  extractUserText,
} from '../chat-session.service';
import { ConversationHistoryService } from '../conversation/conversation-history.service';
import { GeocodingService } from '../location/geocoding.service';
import { PersonaIdentityService } from '../persona/persona-identity.service';
import type { PersonaIdentityCapsule } from '../persona/persona-identity.service';
import { DecisionTraceService } from '../trace/decision-trace.service';
import type { ConversationMessage } from '../conversation/conversation-history.service';
import type { SubmitTurnDto } from '../dto/submit-turn.dto';
import type { ParsedNeed } from './need-parser';
import { parseReverseControl } from './need-parser';
import { NeedFulfillerService } from './need-fulfiller.service';
import {
  buildAnswerPrompt,
  buildAssessmentPrompt,
} from './reverse-control-prompts';

const MAX_ASSESSMENT_ROUNDS = 5;
const RECENT_HISTORY_LIMIT = 12;

export type PhaseEvent =
  | { type: 'started'; phase: string; label: string }
  | { type: 'token'; phase: string; text: string }
  | { type: 'completed'; phase: string; label?: string; result?: unknown }
  | { type: 'failed'; phase: string; message: string };

export type PhaseEventEmitter = (event: PhaseEvent) => void;

export interface TurnDoneEnvelope {
  sessionId: string;
  turnId: string;
  assistantMessage: {
    messageId: string;
    content: string;
    createdAt: string;
  };
  finishReason: 'stop' | 'length' | 'error';
  citations: Array<{
    evidenceId: string;
    sourceTitle: string;
    sourceUrl?: string;
  }>;
  diagnostics?: {
    assessmentRounds: number;
    needsFulfilled: string[];
    personaId: string;
    identityVersion: number;
  };
}

export interface RunTurnInput {
  sessionId: string;
  authUserId: string;
  correlationId: string;
  dto: SubmitTurnDto;
  abortSignal: AbortSignal;
  onAccepted: () => void;
  onRetrievalEvent: (event: RetrievalStreamEvent) => void;
  onModelEvent: (event: LlmStreamEvent) => void;
  onFinalChunk: (text: string) => void;
  onPhaseEvent?: PhaseEventEmitter;
  resolveUserLocation: () => Promise<UserLocation | null>;
}

interface PreparedTurnContext {
  sessionId: string;
  correlationId: string;
  turnId: string;
  userText: string;
  identity: PersonaIdentityCapsule;
  history: ConversationMessage[];
  llmParts: LlmInputPart[];
  initialLocation: UserLocation | undefined;
  occurredAt: string;
}

interface FulfilledLine {
  kind: string;
  argSummary?: string;
  value: string;
}

/**
 * Reverse-control flow.
 *
 * Each turn runs as a small loop:
 *   1. Send the user message + the command table to the LLM and ask
 *      what it needs.
 *   2. The LLM emits `[need="..."]` markers (or `[done]`).
 *   3. The orchestrator fulfills each need (date, time, timezone,
 *      location, search, …) and accumulates the results.
 *   4. Repeat until the LLM emits `[done]` or the iteration cap is
 *      reached.
 *   5. Send a separate prompt asking the LLM to compose the final
 *      answer using the fulfilled context. That round streams to the
 *      user.
 *
 * The LLM declares its own needs; the orchestrator services them.
 * No pre-coded decision tree.
 */
@Injectable()
export class ReverseControlFlowService {
  private readonly log = new Logger(ReverseControlFlowService.name);

  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly sessions: ChatSessionService,
    private readonly history: ConversationHistoryService,
    private readonly persona: PersonaIdentityService,
    private readonly fragmenter: FragmenterClientService,
    private readonly geocoding: GeocodingService,
    private readonly llm: LlmHostService,
    private readonly trace: DecisionTraceService,
    private readonly capping: CappingService,
    private readonly fulfiller: NeedFulfillerService,
  ) {}

  async runTurn(input: RunTurnInput): Promise<TurnDoneEnvelope> {
    const ctx = await this.prepareTurnContext(input);
    const onPhase = input.onPhaseEvent;

    this.recordTrace(ctx, 'reverse_control.started', {
      summary: 'Reverse-control flow took control of the turn.',
    });

    let location = ctx.initialLocation;
    const fulfilled: FulfilledLine[] = [];
    let assessmentRounds = 0;

    try {
      // ------- assessment loop -------
      for (let round = 1; round <= MAX_ASSESSMENT_ROUNDS; round++) {
        assessmentRounds = round;
        const phase = `assessment.round${round}`;

        const messages = buildAssessmentPrompt({
          userText: ctx.userText,
          fulfilledContext: this.renderFulfilledBlock(fulfilled),
        });

        onPhase?.({
          type: 'started',
          phase,
          label: `Assessment round ${round}`,
        });

        const cap = this.capping.forUtilitarianDecision({ messages });
        const ollama: Record<string, unknown> = { temperature: 0 };
        if (cap !== undefined) ollama.num_predict = cap;

        const result = await this.llm.streamInfer({
          correlationId: ctx.correlationId,
          messages,
          options: { responseFormat: 'text', thinking: false, ollama },
          abortSignal: input.abortSignal,
          onEvent: (evt) => {
            if (evt.type === 'chunk' && evt.payload.text) {
              onPhase?.({ type: 'token', phase, text: evt.payload.text });
            }
          },
        });

        const parsed = parseReverseControl(result.text);

        onPhase?.({
          type: 'completed',
          phase,
          label: parsed.done
            ? 'Done — proceeding to answer'
            : `${parsed.needs.length} need${parsed.needs.length === 1 ? '' : 's'} declared`,
          result: parsed,
        });
        this.recordTrace(ctx, `assessment.round${round}.completed`, {
          summary: parsed.done
            ? 'LLM emitted [done]'
            : `LLM declared ${parsed.needs.length} need(s): ${parsed.needs.map((n) => n.kind).join(', ')}`,
          payload: parsed,
        });

        if (parsed.done) break;
        if (parsed.needs.length === 0) {
          this.log.warn(
            `Assessment round ${round} produced no needs and no [done]; treating as done.`,
          );
          break;
        }

        for (const need of parsed.needs) {
          const phaseId = `need.${need.kind}`;
          onPhase?.({
            type: 'started',
            phase: phaseId,
            label: this.startedLabelFor(need),
          });
          const result = await this.fulfiller.fulfill(
            need,
            {
              correlationId: ctx.correlationId,
              sessionId: ctx.sessionId,
              userText: ctx.userText,
              occurredAt: ctx.occurredAt,
              abortSignal: input.abortSignal,
              initialLocation: location,
              resolveUserLocation: input.resolveUserLocation,
              onRetrievalStreamEvent: input.onRetrievalEvent,
            },
            location,
          );
          if (result.patch?.location) {
            location = result.patch.location;
          }
          fulfilled.push({
            kind: need.kind,
            ...(need.arg
              ? { argSummary: `${need.arg.name}="${need.arg.value}"` }
              : {}),
            value: result.value,
          });
          onPhase?.({
            type: 'completed',
            phase: phaseId,
            label: this.completedLabelFor(need, result.value),
            result: { value: result.value },
          });
          this.recordTrace(ctx, `need.${need.kind}.completed`, {
            summary: this.completedLabelFor(need, result.value),
            payload: {
              ...(need.arg ? { [need.arg.name]: need.arg.value } : {}),
              value: result.value,
            },
          });
        }
      }

      // ------- answer round -------
      onPhase?.({
        type: 'started',
        phase: 'answer.streaming',
        label: 'Drafting answer',
      });
      this.recordTrace(ctx, 'answer.streaming.started', {
        summary: 'Streaming final answer.',
      });

      const answerMessages = buildAnswerPrompt({
        userText: ctx.userText,
        fulfilledContext: this.renderFulfilledBlock(fulfilled),
        recentHistoryBlock: this.renderHistoryBlock(ctx.history),
      });

      const finalCap = this.capping.forFinalAnswer({
        messages: answerMessages,
      });
      const finalOllama: Record<string, unknown> = {};
      if (finalCap !== undefined) finalOllama.num_predict = finalCap;

      const finalResult = await this.llm.streamInfer({
        correlationId: ctx.correlationId,
        messages: answerMessages,
        ...(ctx.llmParts.length > 0 ? { parts: ctx.llmParts } : {}),
        options: {
          responseFormat: 'text',
          thinking: false,
          ...(Object.keys(finalOllama).length > 0
            ? { ollama: finalOllama }
            : {}),
        },
        abortSignal: input.abortSignal,
        onEvent: (evt) => {
          if (evt.type === 'chunk') {
            input.onFinalChunk(evt.payload.text);
            return;
          }
          input.onModelEvent(evt);
        },
      });

      onPhase?.({
        type: 'completed',
        phase: 'answer.streaming',
        label: 'Answer streamed',
        result: { finishReason: finalResult.finishReason },
      });
      this.recordTrace(ctx, 'answer.streaming.completed', {
        summary: `Streaming answer completed with finishReason=${finalResult.finishReason}.`,
        payload: {
          finishReason: finalResult.finishReason,
          textLength: finalResult.text.length,
        },
      });

      if (finalResult.text.length === 0) {
        throw new ServiceUnavailableException(
          'Reverse-control flow produced an empty answer',
        );
      }

      const persisted = this.sessions.appendTurn({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        parts: input.dto.message.parts,
        userText: ctx.userText,
        occurredAt: ctx.occurredAt,
        assistantText: finalResult.text,
      });

      this.fragmenter.notifyObserved({
        sessionId: ctx.sessionId,
        lastTurnId: persisted.turnId,
        lastSeq: persisted.lastSeq,
        observedAt: persisted.createdAt,
      });

      const includeDiagnostics = input.dto.options?.includeDiagnostics === true;

      return {
        sessionId: ctx.sessionId,
        turnId: persisted.turnId,
        assistantMessage: {
          messageId: persisted.assistantMessageId,
          content: finalResult.text,
          createdAt: persisted.createdAt,
        },
        finishReason: finalResult.finishReason,
        citations: [],
        ...(includeDiagnostics
          ? {
              diagnostics: {
                assessmentRounds,
                needsFulfilled: fulfilled.map((f) => f.kind),
                personaId: ctx.identity.personaId,
                identityVersion: ctx.identity.identityVersion,
              },
            }
          : {}),
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Reverse-control flow failed',
      );
    }
  }

  // ----- helpers -----

  private async prepareTurnContext(
    input: RunTurnInput,
  ): Promise<PreparedTurnContext> {
    const session = this.sessions.loadSession(
      input.sessionId,
      input.authUserId,
    );

    const userText = extractUserText(input.dto.message.parts);
    if (!userText) {
      throw new BadRequestException(
        'message.parts must contain at least one non-empty text part',
      );
    }
    const imageParts = extractImageParts(input.dto.message.parts);

    input.onAccepted();

    const view = this.history.loadHistoryView(input.sessionId);
    const identity = this.persona.prepareCapsule({
      personaId: session.personaId,
      userId: session.userId,
      sessionId: input.sessionId,
      occurredAt: input.dto.message.occurredAt,
    });

    const llmParts: LlmInputPart[] = imageParts.map((p) => ({
      type: 'image' as const,
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
      ...(p.mimeType ? { mimeType: p.mimeType } : {}),
    }));

    const initialLocation = input.dto.userLocation
      ? await this.enrichLocation(
          this.normalizeUserLocation(input.dto.userLocation),
        )
      : undefined;

    return {
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      turnId: randomUUID(),
      userText,
      identity,
      history: view.messages,
      llmParts,
      initialLocation,
      occurredAt: input.dto.message.occurredAt,
    };
  }

  private renderFulfilledBlock(fulfilled: FulfilledLine[]): string | null {
    if (fulfilled.length === 0) return null;
    const lines: string[] = [];
    for (const f of fulfilled) {
      const head = f.argSummary ? `${f.kind} (${f.argSummary})` : f.kind;
      lines.push(`- ${head}: ${f.value}`);
    }
    return lines.join('\n');
  }

  private renderHistoryBlock(history: ConversationMessage[]): string | null {
    const recent = history.slice(-RECENT_HISTORY_LIMIT);
    if (recent.length === 0) return null;
    return recent
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');
  }

  private startedLabelFor(need: ParsedNeed): string {
    if (need.kind === 'search' && need.arg?.value) {
      return `Searching: "${need.arg.value}"`;
    }
    if (need.kind === 'location') return 'Resolving location';
    if (need.kind === 'date') return 'Looking up the date';
    if (need.kind === 'time') return 'Looking up the time';
    if (need.kind === 'timezone') return 'Looking up the timezone';
    return `Fulfilling need: ${need.kind}`;
  }

  private completedLabelFor(need: ParsedNeed, value: string): string {
    const truncated = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    return `${need.kind} → ${truncated.replace(/\s+/g, ' ')}`;
  }

  private recordTrace(
    ctx: PreparedTurnContext,
    eventType: string,
    args: { summary: string; payload?: unknown; command?: string },
  ): void {
    this.trace.recordEvent({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      correlationId: ctx.correlationId,
      eventType,
      summary: args.summary,
      ...(args.command ? { command: args.command } : {}),
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
    });
  }

  private normalizeUserLocation(value: {
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    capturedAt?: string;
  }): UserLocation {
    return {
      latitude: value.latitude,
      longitude: value.longitude,
      ...(value.accuracyMeters !== undefined
        ? { accuracyMeters: value.accuracyMeters }
        : {}),
      ...(value.capturedAt !== undefined
        ? { capturedAt: value.capturedAt }
        : {}),
    };
  }

  private async enrichLocation(loc: UserLocation): Promise<UserLocation> {
    const geo = await this.geocoding.reverseGeocode({
      latitude: loc.latitude,
      longitude: loc.longitude,
    });
    if (!geo) return loc;
    return {
      ...loc,
      ...(geo.cityName ? { cityName: geo.cityName } : {}),
      ...(geo.regionName ? { regionName: geo.regionName } : {}),
      ...(geo.countryName ? { countryName: geo.countryName } : {}),
      ...(geo.countryCode ? { countryCode: geo.countryCode } : {}),
    };
  }
}
